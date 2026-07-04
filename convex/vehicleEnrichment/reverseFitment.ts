/**
 * vehicleEnrichment/reverseFitment.ts — flag-gated (PARTS_REVERSE_FITMENT=on)
 * corroboration of part fitments from the part's OWN product page.
 *
 * Forward extraction asks "what parts fit this vehicle?" and trusts the LLM's
 * self-reported confidence. This module asks the opposite question: the part's
 * registry product page lists which vehicles the part fits — scrape THAT table
 * (Firecrawl json format, cached via maxAge) and check the target vehicle is
 * on it.
 *
 *   confirmed    → fitment source_count+1, source_domains += page domain,
 *                  data_quality "reverse_fitment_confirmed" (counts as
 *                  corroboration for the 2-source rule in serviceParts).
 *   contradicted → confidence forced below the selector gate (0.7) and
 *                  data_quality "reverse_fitment_contradicted" — the part
 *                  stops winning unless nothing else exists, and the booking
 *                  is flagged low-confidence.
 *   unknown      → page shows no usable fitment info; nothing changes.
 *
 * Cost: ≤1 Firecrawl json extraction per part (URLs come from part_prices —
 * pages we already scraped for pricing, so maxAge often makes this a cache
 * hit). OFF by default.
 */

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { firecrawlJsonExtract } from "./firecrawl";

const FITMENT_SCHEMA = {
  type: "object",
  properties: {
    has_fitment_info: {
      type: ["boolean", "null"],
      description: "true if the page shows which vehicles this part fits",
    },
    fits_makes: {
      type: ["array", "null"],
      items: { type: "string" },
      description: "vehicle makes the part is listed as fitting",
    },
    fits_models: {
      type: ["array", "null"],
      items: { type: "string" },
      description: "vehicle models the part is listed as fitting",
    },
    year_min: { type: ["number", "null"], description: "earliest model year listed" },
    year_max: { type: ["number", "null"], description: "latest model year listed" },
  },
};

export type ReverseFitmentVerdict = "confirmed" | "contradicted" | "unknown";

/** Pure comparison so it's unit-testable. Contradiction requires AFFIRMATIVE
 *  mismatch (the page names other vehicles and ours isn't among them);
 *  missing/partial info is "unknown", never a demotion. */
export function judgeReverseFitment(
  extracted: {
    has_fitment_info?: boolean | null;
    fits_makes?: string[] | null;
    fits_models?: string[] | null;
    year_min?: number | null;
    year_max?: number | null;
  } | null,
  target: { year: number; make: string; model: string },
): ReverseFitmentVerdict {
  if (!extracted || extracted.has_fitment_info === false) return "unknown";
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const makes = (extracted.fits_makes ?? []).map(norm).filter(Boolean);
  const models = (extracted.fits_models ?? []).map(norm).filter(Boolean);
  const tMake = norm(target.make);
  const tModel = norm(target.model);

  const makeListed = makes.length > 0;
  const modelListed = models.length > 0;
  const makeOk = makes.some((m) => m.includes(tMake) || tMake.includes(m));
  const modelOk = models.some((m) => m.includes(tModel) || tModel.includes(m));
  const yearKnown = extracted.year_min != null || extracted.year_max != null;
  const yearOk =
    (extracted.year_min == null || target.year >= extracted.year_min) &&
    (extracted.year_max == null || target.year <= extracted.year_max);

  if (makeListed && !makeOk) return "contradicted";
  if (makeOk && modelListed && !modelOk) return "contradicted";
  if (makeOk && modelOk && yearKnown && !yearOk) return "contradicted";
  if (makeOk && modelOk && yearOk) return "confirmed";
  // Make matches but model/year unstated — not enough to confirm.
  return "unknown";
}

/** All fitments for a config with each part's best-known product-page URL. */
export const fitmentsWithSourceUrls = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicleConfigId))
      .collect();
    const out: Array<{
      fitment_id: string;
      part_id: string;
      oem_part_number: string;
      url: string;
    }> = [];
    for (const f of fitments) {
      // Contradicted/confirmed rows don't need a re-check this run.
      if (f.data_quality === "reverse_fitment_confirmed" || f.data_quality === "reverse_fitment_contradicted") continue;
      const part = await ctx.db.get(f.part_id);
      if (!part) continue;
      const priceRows = await ctx.db
        .query("part_prices")
        .withIndex("by_part", (q) => q.eq("part_id", f.part_id))
        .collect();
      const url = priceRows.map((r) => r.source_url).find((u): u is string => !!u);
      if (!url) continue;
      out.push({
        fitment_id: String(f._id),
        part_id: String(f.part_id),
        oem_part_number: part.oem_part_number,
        url,
      });
    }
    return out;
  },
});

export const applyReverseFitment = internalMutation({
  args: {
    fitment_id: v.id("part_fitments"),
    verdict: v.union(v.literal("confirmed"), v.literal("contradicted")),
    domain: v.string(),
  },
  handler: async (ctx, args) => {
    const f = await ctx.db.get(args.fitment_id);
    if (!f) return;
    if (args.verdict === "confirmed") {
      const domains = f.source_domains ?? [];
      await ctx.db.patch(args.fitment_id, {
        source_count: (f.source_count ?? 0) + 1,
        data_quality: "reverse_fitment_confirmed",
        ...(domains.includes(args.domain) ? {} : { source_domains: [...domains, args.domain] }),
        last_confirmed_at: Date.now(),
      });
    } else {
      // Mechanic word beats a scraped fitment table.
      if (f.mechanic_verified === true) return;
      await ctx.db.patch(args.fitment_id, {
        // Below the selector gate (PART_CONFIDENCE_GATE_THRESHOLD 0.7) — the
        // part only wins when no gated candidate exists, and then flagged.
        confidence: Math.min(f.confidence ?? 0, 0.4),
        data_quality: "reverse_fitment_contradicted",
      });
    }
  },
});

/** Driver — scheduled from the enrichment pipeline when PARTS_REVERSE_FITMENT=on. */
export const verifyConfigFitments = internalAction({
  args: {
    vehicleConfigId: v.id("vehicle_configs"),
    year: v.float64(),
    make: v.string(),
    model: v.string(),
    // Bound Firecrawl spend per run.
    cap: v.optional(v.float64()),
  },
  handler: async (ctx, args) => {
    if (process.env.PARTS_REVERSE_FITMENT !== "on") {
      return { checked: 0, confirmed: 0, contradicted: 0, skipped: true };
    }
    const cap = args.cap ?? 15;
    const targets: Array<{ fitment_id: string; part_id: string; oem_part_number: string; url: string }> =
      await ctx.runQuery(internal.vehicleEnrichment.reverseFitment.fitmentsWithSourceUrls, {
        vehicleConfigId: args.vehicleConfigId,
      });

    // One extraction per PART (multiple fitments can share a part+page).
    const byUrlPart = new Map<string, typeof targets>();
    for (const t of targets) {
      const k = `${t.part_id}|${t.url}`;
      const arr = byUrlPart.get(k) ?? [];
      arr.push(t);
      byUrlPart.set(k, arr);
    }

    let checked = 0, confirmed = 0, contradicted = 0;
    for (const [, group] of byUrlPart) {
      if (checked >= cap) break;
      const t = group[0];
      checked++;
      const prompt =
        `This is an auto-part product page for OEM part number "${t.oem_part_number}". ` +
        `Read its fitment/compatibility section: which vehicle makes, models, and model years does this part fit? ` +
        `Report only what the page states — if no fitment information is shown, set has_fitment_info false.`;
      const extracted = await firecrawlJsonExtract(t.url, prompt, FITMENT_SCHEMA);
      const verdict = judgeReverseFitment(extracted as any, {
        year: args.year,
        make: args.make,
        model: args.model,
      });
      if (verdict === "unknown") continue;
      const domain = (() => {
        try { return new URL(t.url).hostname.replace(/^www\./, ""); } catch { return "unknown"; }
      })();
      for (const g of group) {
        await ctx.runMutation(internal.vehicleEnrichment.reverseFitment.applyReverseFitment, {
          fitment_id: g.fitment_id as any,
          verdict,
          domain,
        });
      }
      if (verdict === "confirmed") confirmed++;
      else {
        contradicted++;
        console.warn(`[reverse-fitment] CONTRADICTED: ${t.oem_part_number} on ${args.year} ${args.make} ${args.model} per ${domain}`);
      }
    }

    console.log(`[reverse-fitment] config ${args.vehicleConfigId}: ${checked} checked, ${confirmed} confirmed, ${contradicted} contradicted`);
    return { checked, confirmed, contradicted, skipped: false };
  },
});
