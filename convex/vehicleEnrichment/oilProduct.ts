// =============================================================================
// vehicleEnrichment/oilProduct.ts — the engine-oil PRODUCT rung (Aug 2026).
//
// An oil change quote was riding on two real parts (filter + drain-plug
// gasket) and an $11/qt SYNTHETIC for the oil itself — the universal fallback
// exists because OEM oil-bottle SKUs were the most hallucination-prone
// extraction in the pipeline (stress fleet 2026-07-11: 5 of 8 fabricated).
// The fix is not to trust extraction harder; it is to anchor the fetch on the
// one fact we already hold with high confidence: the vehicle's REQUIRED
// VISCOSITY (engines.oil_viscosity, e.g. "0W-40").
//
// The rung fetches the make's own oil PRODUCT pages (storefront SERP first,
// open web second), and a candidate must clear ALL of:
//   1. the title names the exact required viscosity (the "per type" gate —
//      a 5W-40 bottle can never fill an 0W-40 slot);
//   2. the title is engine oil, not a filter/additive/gear oil (lexicon +
//      explicit blocks);
//   3. the bottle is per-quart/per-liter (multi-quart jugs are EXCLUDED —
//      their price would corrupt the per-quart × ceil(capacity) job math);
//   4. the make's part-number format gate (sanitizePartNumber);
//   5. the fitment verifier, whose oil rule refutes wrong-grade products.
// Only then does it write the fitment + the per-quart price. Quoting needs no
// further change: resolveRoleQuantity's fluid branch already bills
// ceil(oil_capacity_qts / 1qt) × per-quart price, and the reference's
// universalFallback stops applying the moment a real priced SKU exists.
//
// Wired into resourceRoles.healAfterRun after the category rung. Kill switch:
// PARTS_OIL_PRODUCT_FETCH=off.
// =============================================================================

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { getSourceConfig, isMarketplaceDomain, domainOfUrl } from "./sourceRegistry";
import { searchAndFetch } from "./firecrawl";
import { extractPageProducts, type PageProduct } from "./categoryHarvest";
import { normalizeOemNumber } from "./priceParser";
import { checkRoleIdentity } from "./roleIdentity";
import { sanitizePartNumber } from "./contentSanitization";
import { verifyPartFitments } from "./utils/partFitmentVerifier";
import { PART_FIELD_MAP } from "./v3pipeline";

// ─── Pure helpers (unit-tested in tests/oilProduct.test.ts) ─────────────────

/** "0W-40" (any of 0w40 / 0 W-40 / 0w–40 in a title) as a matcher. Returns
 *  null for an unusable viscosity string — the rung refuses to run rather
 *  than fetch un-anchored. */
export function viscosityMatcher(viscosity: string | null | undefined): RegExp | null {
  const m = /(\d{1,2})\s*[wW]\s*[-–—]?\s*(\d{2})/.exec(String(viscosity ?? ""));
  if (!m) return null;
  return new RegExp(`\\b${m[1]}\\s*[wW]\\s*[-–—]?\\s*${m[2]}\\b`);
}

/** Titles that are oil-ADJACENT but never the engine oil itself. */
const OIL_TITLE_BLOCKS =
  /filter|additive|treatment|stabilizer|stop\s*leak|flush|gear\s*oil|transmission|hydraulic|compressor|power\s*steering|2[\s-]?stroke|bar\s*(&|and)\s*chain|assembly\s*lube|grease/i;

/** Multi-quart jugs and drums — their price corrupts per-quart job math. */
const MULTI_PACK = /\b([2-9]|\d{2,})\s*(qt|quart|liter|litre|l)\b|\bgallon\b|\bcase\b|\bpack\s*of\b/i;
/** Explicit per-quart/per-liter bottle. */
const SINGLE_BOTTLE = /\b1\s*(qt|quart|liter|litre|l)\b/i;

export interface OilCandidate {
  oem: string;
  title: string;
  price: number | null;
  sourceUrl: string;
  /** 2 = explicit 1qt/1L, 1 = size unstated (OEM bottles default 1L). */
  sizeRank: 1 | 2;
  /** Mined from prose rather than a product page — the weakest provenance
   *  this rung accepts. Text candidates write ONLY on a positive verifier
   *  confirmation (see the write loop). */
  fromText?: boolean;
}

/** Filter + rank a page's products down to writable oil candidates. */
export function pickOilCandidates(
  products: readonly PageProduct[],
  input: { make: string; viscosity: string; cap?: number },
): OilCandidate[] {
  const visc = viscosityMatcher(input.viscosity);
  if (!visc) return [];
  const cap = input.cap ?? 4;
  const out: OilCandidate[] = [];
  const seen = new Set<string>();
  for (const p of products) {
    const title = (p.title ?? "").trim();
    if (!title) continue;
    if (!visc.test(title)) continue;
    if (OIL_TITLE_BLOCKS.test(title)) continue;
    // Engine-oil identity: the role lexicon where it speaks, plus a hard
    // requirement that the title actually says oil.
    if (!/\boil\b/i.test(title)) continue;
    const lex = checkRoleIdentity("engine_oil", title);
    if (lex.verdict === "reject") continue;
    if (MULTI_PACK.test(title)) continue;
    const sanitized = sanitizePartNumber(p.oem, input.make);
    if (!sanitized) continue;
    const norm = normalizeOemNumber(sanitized);
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push({
      oem: sanitized,
      title,
      price: p.price != null && p.price > 0 ? p.price : null,
      sourceUrl: p.sourceUrl,
      sizeRank: SINGLE_BOTTLE.test(title) ? 2 : 1,
    });
  }
  return out
    .sort((a, b) => b.sizeRank - a.sizeRank || Number(b.price != null) - Number(a.price != null))
    .slice(0, cap);
}

/** SKU candidates from free TEXT (SERP result markdown). Genuine oil part
 *  numbers circulate in prose ("MB 229.5 0W-40, part A 000 989 79 02 11")
 *  even when no parseable PRODUCT page ranks — observed live: every MB 0W-40
 *  query returned marketplaces, spec sheets and blogs, zero JSON-LD tiles.
 *  A line yields candidates only when it names the exact viscosity AND says
 *  oil AND is not an oil-adjacent product; numbers still face the make
 *  format gate here and the fitment verifier after. Price deliberately
 *  absent — the targeted price backfill prices bare SKUs by URL discovery. */
export function candidatesFromText(
  markdown: string | null | undefined,
  input: { make: string; viscosity: string; sourceUrl: string; cap?: number },
): OilCandidate[] {
  if (!markdown) return [];
  const visc = viscosityMatcher(input.viscosity);
  if (!visc) return [];
  const cap = input.cap ?? 3;
  const out: OilCandidate[] = [];
  const seen = new Set<string>();
  for (const rawLine of markdown.split(/\n+/)) {
    if (out.length >= cap) break;
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (line.length < 10 || line.length > 400) continue;
    if (!visc.test(line) || !/\boil\b/i.test(line)) continue;
    if (OIL_TITLE_BLOCKS.test(line)) continue;
    const tokenRe = /\b[A-Z]?[\d][\d\s-]{7,15}[\d]\b|\b[A-Z]\d{9,12}\b/gi;
    for (const m of line.matchAll(tokenRe)) {
      if (out.length >= cap) break;
      const sanitized = sanitizePartNumber(m[0].trim(), input.make);
      if (!sanitized) continue;
      const norm = normalizeOemNumber(sanitized);
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push({
        oem: sanitized,
        title: line.slice(0, 160),
        price: null,
        sourceUrl: input.sourceUrl,
        sizeRank: 1,
        fromText: true,
      });
    }
  }
  return out;
}

// ─── The rung ───────────────────────────────────────────────────────────────

export const fetchEngineOilProduct = internalAction({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    if (process.env.PARTS_OIL_PRODUCT_FETCH === "off") return { status: "disabled" as const };

    const resolved: any = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.resolveConfigForBackfill,
      { vehicleConfigId: args.vehicleConfigId },
    );
    if (!resolved || !resolved.makeId) return { status: "no_config" as const };
    const engine: any = resolved.engineId
      ? await ctx.runQuery(internal.vehicleEnrichment.v3queries.getEngine, {
          engineId: resolved.engineId,
        })
      : null;
    const viscosity: string | null = engine?.oil_viscosity ?? null;
    const capacityQts: number | null = engine?.oil_capacity_qts ?? null;
    if (!viscosityMatcher(viscosity)) {
      // No trusted viscosity → no anchor → refuse rather than guess. The
      // spec fields come from batch-1b/capacity-resolver; a config without
      // them needs enrichment, not an un-anchored oil write.
      return { status: "no_viscosity" as const };
    }

    // Already have a REAL priced oil product? Done — never churn a good row.
    const fitments: any[] = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getFitmentsWithPriceFlag,
      { vehicleConfigId: args.vehicleConfigId },
    );
    const existing = fitments.find((f) => f.subcategory === "engine_oil");
    if (existing?.has_trusted_price) return { status: "already_priced" as const };

    // Source ladder: the make's storefront product pages first, open web
    // second (marketplaces excluded — their listings can't anchor a price to
    // a SKU). Every result page runs through the same product extractor as
    // the category rung.
    const config = getSourceConfig(resolved.make);
    const queries: string[] = [];
    if (config) {
      const host = new URL(config.parts.storeBaseUrl).hostname.replace(/^www\./, "");
      queries.push(`site:${host} ${viscosity} engine oil`);
    }
    // Open-web shapes: OEM bottle listings live on the dealer-catalog family
    // (…parts giant/discount stores) whose JSON-LD the extractor already
    // reads. "genuine" + the make + the grade + a bottle word is what ranks
    // PRODUCT pages over blog/spec pages.
    queries.push(`${resolved.make} genuine engine oil ${viscosity} 1 quart OEM part number price`);
    // Genuine-OEM retailers with structured product data — oil SERPs are
    // otherwise wall-to-wall marketplaces (excluded), spec sheets and blogs
    // (no product tiles). These carry JSON-LD price + a title naming both
    // GENUINE and the grade, which is exactly what the gates want.
    queries.push(`site:fcpeuro.com ${resolved.make} genuine ${viscosity} engine oil`);
    queries.push(`"${resolved.make}" "${viscosity}" genuine engine oil 1 liter part`);
    queries.push(`${resolved.make} OEM ${viscosity} motor oil bottle part number`);

    // Pool products across ALL query shapes before picking — breaking on the
    // first query with ANY candidate let a single bad number starve the
    // better queries (observed live: one refuted retailer SKU from query 2
    // meant queries 3-4, which carry the real OEM bottle listings, never ran).
    const pooled: PageProduct[] = [];
    const textCandidates: OilCandidate[] = [];
    for (const q of queries) {
      const results = await searchAndFetch(q, 4, true);
      for (const r of results) {
        if (isMarketplaceDomain(domainOfUrl(r.url))) continue;
        pooled.push(
          ...extractPageProducts({ html: r.html ?? null, markdown: r.markdown ?? null, url: r.url }),
        );
        textCandidates.push(
          ...candidatesFromText(r.markdown ?? null, {
            make: resolved.make,
            viscosity: viscosity!,
            sourceUrl: r.url,
          }),
        );
      }
    }
    // Product-page candidates first (they carry prices); text-mined SKUs
    // behind them (the price backfill prices those after the write).
    const fromProducts = pickOilCandidates(pooled, {
      make: resolved.make,
      viscosity: viscosity!,
      cap: 6,
    });
    const have = new Set(fromProducts.map((c) => normalizeOemNumber(c.oem)));
    const candidates = [
      ...fromProducts,
      ...textCandidates.filter((c) => !have.has(normalizeOemNumber(c.oem))).slice(0, 4),
    ];
    if (candidates.length === 0) {
      return { status: "no_candidates" as const, viscosity, capacityQts };
    }

    // The verifier's oil-grade rule is the last gate: a real product whose
    // actual grade differs from the requirement gets refuted by name.
    const verdicts = await verifyPartFitments(
      {
        year: resolved.year,
        make: resolved.make,
        model: resolved.model,
        trim: resolved.trim ?? "",
        engineCode: resolved.engineCode ?? undefined,
        displacement: resolved.displacement ?? undefined,
        oilViscosity: viscosity,
      },
      candidates.map((c) => ({
        roleKey: "engine_oil",
        oem: c.oem,
        name: "Engine Oil",
        quantity: null,
        observedTitle: c.title,
      })),
    );

    const meta = (PART_FIELD_MAP as any).engine_oil_oem;
    const outcomes: string[] = [];
    let written: string | null = null;
    for (const c of candidates) {
      const vd = verdicts.find((x) => normalizeOemNumber(x.oem) === normalizeOemNumber(c.oem));
      const verdict = vd?.verdict ?? "uncertain";
      outcomes.push(`${c.oem}:${verdict}`);
      // Product-page candidates carry catalog attestation: write unless the
      // verifier POSITIVELY refutes (same bar as the category rung).
      // TEXT-MINED numbers have only a prose sentence behind them and write
      // ONLY on positive confirmation — Aug 5 incident: a lubrication-
      // HARDWARE-group number (271-180-05-09; genuine MB FLUIDS carry the
      // 989 middle group) sat on a line reading "Engine Oil 0W-40", cleared
      // the refute-only bar as "uncertain", and a wrong part reached the
      // GLC-43 with prices attached before removeRefutedFitments pulled it.
      if (written) continue;
      if (c.fromText ? verdict !== "confirmed" : verdict === "refuted") continue;
      const sourceDomain = domainOfUrl(c.sourceUrl) ?? undefined;
      const res: any = await ctx.runMutation(
        internal.vehicleEnrichment.v3mutations.upsertPartAndFitment,
        {
          oem_part_number: c.oem,
          name: `${meta.name} ${viscosity}`,
          category: meta.category,
          subcategory: meta.subcategory,
          make_id: resolved.makeId,
          vehicle_config_id: args.vehicleConfigId,
          service_type: meta.serviceSlug ?? meta.subcategory,
          // Per-quart bottle. Job quantity is NOT stored here — the quote
          // path's fluid branch bills ceil(oil_capacity_qts / 1qt) and
          // deliberately ignores fitment quantity.
          quantity_needed: 1,
          position: meta.position,
          service_role: meta.serviceRole,
          confidence: 0.75,
          source_domain: sourceDomain,
          observed_title: c.title,
        },
      );
      if (!res?.part_id || res?.rejected) {
        outcomes.push(`${c.oem}:write_rejected_${res?.rejected ?? "unknown"}`);
        continue;
      }
      if (c.price != null && sourceDomain) {
        try {
          await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertPartPrice, {
            part_id: res.part_id,
            price: c.price,
            price_type: "sale",
            source_url: c.sourceUrl,
            source_domain: sourceDomain,
          });
        } catch (e) {
          console.warn(`[oil-product] price write failed for ${c.oem} (non-fatal):`, e);
        }
      }
      written = c.oem;
    }

    const summary = {
      status: "done" as const,
      viscosity,
      capacityQts,
      jobQuarts: capacityQts != null ? Math.ceil(capacityQts) : null,
      candidates: candidates.length,
      outcomes,
      written,
    };
    console.log("[oil-product]", JSON.stringify(summary));
    return summary;
  },
});
