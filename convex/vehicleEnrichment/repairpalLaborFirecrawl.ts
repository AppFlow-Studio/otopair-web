/**
 * vehicleEnrichment/repairpalLaborFirecrawl.ts — RepairPal labor RESOLVER.
 *
 * RepairPal publishes a labor DOLLAR range per repair ("Labor costs are
 * estimated between $X and $Y"). We recover labor HOURS by dividing the
 * dollar midpoint by a reference shop rate (RATE_MID). This is a documented
 * guesstimate, so `repairpal_labor` is a LOW-WEIGHT corroborator source in
 * the multi-source labor aggregation — never an authority.
 *
 * Two layers:
 *  - `dollarsToHours` is the pure, unit-tested core (tests/repairpalLabor.test.ts).
 *    It clamps into OLP's sane labor band so a junk extraction can't poison
 *    the aggregation.
 *  - `resolveRepairpalLaborForConfig` is the network path: it builds RepairPal
 *    estimate URLs and firecrawl-`json`-extracts the dollar range per service.
 *    This path is dev-verified via backfill — it is NOT unit-testable under the
 *    fakeDb harness (no real network / no FIRECRAWL_API_KEY), so it carries no
 *    unit test by design (see the Phase-3 labor plan).
 *
 * Resolver-action shape mirrors `resolveOlpLaborForConfig` (olpLaborScrape.ts);
 * the firecrawl `json` POST uses the shared `firecrawlJsonExtract` helper
 * (firecrawl.ts), with the schema/prompt set to a two-field dollar range.
 */
import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { OLP_HOURS_MIN, OLP_HOURS_MAX } from "./olpLabor";
import { firecrawlJsonExtract } from "./firecrawl";

/** RepairPal publishes a labor DOLLAR range; we recover hours via this reference
 *  rate. A documented guesstimate — repairpal_labor is a low-weight corroborator. */
export const RATE_MID = 130;

export function dollarsToHours(priceLow: number, priceHigh: number): number {
  const mid = (priceLow + priceHigh) / 2;
  const hours = mid / RATE_MID;
  return Math.min(OLP_HOURS_MAX, Math.max(OLP_HOURS_MIN, hours));
}

// ---------------------------------------------------------------------------
// Network resolver
// ---------------------------------------------------------------------------

const REPAIRPAL_BASE = "https://repairpal.com/estimator";

/** Slugify a make/model into RepairPal's URL path form. The repairpal_slug is
 *  already in slug form (e.g. "oil-change") — only make/model need this. */
function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Ordered RepairPal estimate URL candidates, year-specific first (mirrors the
 * old `repairpalUrlCandidates` ordering). The repairpal_slug already carries
 * the repair name in slug form; we append "-cost".
 */
function repairpalUrlCandidates(
  make: string,
  model: string,
  year: number,
  repairpalSlug: string,
): string[] {
  const makeSlug = slugify(make);
  const modelSlug = slugify(model);
  return [
    `${REPAIRPAL_BASE}/${makeSlug}/${modelSlug}/${year}/${repairpalSlug}-cost`,
    `${REPAIRPAL_BASE}/${makeSlug}/${modelSlug}/${repairpalSlug}-cost`,
  ];
}

/** Two-field RepairPal labor dollar-range schema (swapped from PRICE_JSON_SCHEMA). */
const REPAIRPAL_LABOR_SCHEMA = {
  type: "object",
  required: ["price_low", "price_high"],
  properties: {
    price_low: {
      type: ["number", "null"],
      description: "the LOW end of the LABOR cost dollar range, e.g. the X in 'Labor costs are estimated between $X and $Y'",
    },
    price_high: {
      type: ["number", "null"],
      description: "the HIGH end of the LABOR cost dollar range, e.g. the Y in 'Labor costs are estimated between $X and $Y'",
    },
  },
};

const REPAIRPAL_LABOR_PROMPT =
  "This is a RepairPal repair estimate page. Find the LABOR cost range only. " +
  "RepairPal states it as 'Labor costs are estimated between $X and $Y' — extract price_low=X and price_high=Y as plain dollar numbers. " +
  "IGNORE the parts cost, the total estimate, taxes, fees, and any nearby shop pricing. " +
  "If the page does not show a labor cost range, set both price_low and price_high to null. Never guess.";

type RepairpalDollarRange = { price_low: number | null; price_high: number | null };

/**
 * Firecrawl-`json`-extract RepairPal's labor dollar range for one URL.
 * Returns null on any non-ok / error / missing-key — never throws.
 */
async function extractRepairpalLaborFirecrawl(url: string): Promise<RepairpalDollarRange | null> {
  const j = await firecrawlJsonExtract(url, REPAIRPAL_LABOR_PROMPT, REPAIRPAL_LABOR_SCHEMA);
  if (!j) return null;
  const num = (x: any) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  return { price_low: num(j.price_low), price_high: num(j.price_high) };
}

export type RepairpalLaborResult = {
  /** True only when at least one service yielded hours (non-empty services map). */
  resolved: boolean;
  /** service-slug -> recovered labor hours (only services that resolved) */
  services: Record<string, number>;
};

/**
 * Resolve one config to RepairPal labor HOURS per mapped service.
 *
 * For each service that HAS a non-null `repairpal_slug`, we build year-specific
 * (then yearless-fallback) RepairPal estimate URLs, firecrawl-extract the labor
 * dollar range, and convert via `dollarsToHours` when BOTH ends are present.
 *
 * Per-service failure (fetch error, missing range, non-ok response, no key) is
 * SAFE-NULL: we skip that one service and continue — we never throw out of the
 * loop for a single service. `resolved` is true only when the services map is
 * non-empty (mirrors how a corroborator should report "I found something").
 */
export const resolveRepairpalLaborForConfig = internalAction({
  args: {
    make: v.string(),
    model: v.string(),
    year: v.number(),
    services: v.array(
      v.object({
        slug: v.string(),
        repairpal_slug: v.union(v.string(), v.null()),
      }),
    ),
  },
  handler: async (_ctx, args): Promise<RepairpalLaborResult> => {
    const services: Record<string, number> = {};

    for (const svc of args.services) {
      if (!svc.repairpal_slug) continue; // no RepairPal mapping → skip
      try {
        const candidates = repairpalUrlCandidates(
          args.make,
          args.model,
          args.year,
          svc.repairpal_slug,
        );
        for (const url of candidates) {
          const range = await extractRepairpalLaborFirecrawl(url);
          if (
            range &&
            range.price_low != null &&
            range.price_high != null &&
            Number.isFinite(range.price_low) &&
            Number.isFinite(range.price_high)
          ) {
            services[svc.slug] = dollarsToHours(range.price_low, range.price_high);
            break; // first URL that yields a range wins (year-specific preferred)
          }
        }
      } catch (e) {
        // Per-service safe-null: one service must never sink the whole loop.
        console.error(`RepairPal labor: service "${svc.slug}" failed:`, e);
      }
    }

    return { resolved: Object.keys(services).length > 0, services };
  },
});
