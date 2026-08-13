/**
 * vehicleEnrichment/laborWebSearch.ts — open-web labor-hours RESOLVER (`web_labor`).
 *
 * `web_labor` is a STRONG open-web labor-hours source: for a given vehicle +
 * service it searches the open web, firecrawl-`json`-extracts the flat-rate/book
 * labor TIME IN HOURS from each of the top result pages, and returns the MEDIAN
 * of the accepted extractions per service. This source reads published labor
 * HOURS directly, so it carries full weight in the multi-source labor aggregation.
 *
 * Two layers:
 *  - `acceptWebLabor` is the pure, unit-tested acceptance gate
 *    (tests/laborWebSearch.test.ts). It admits an extraction only when the hours
 *    are in OLP's sane labor band AND neither service_match nor vehicle_match is
 *    an explicit `false` (true OR null/unknown both pass) — so a junk or
 *    off-topic page can't poison the median.
 *  - `resolveWebLaborForConfig` is the network path: it builds a web-search
 *    query per service, takes the top ≤3 result URLs, firecrawl-extracts each,
 *    keeps the accepted hours, and reports their median. This path is dev-verified
 *    via backfill — it is NOT unit-testable under the fakeDb harness (no real
 *    network / no FIRECRAWL_API_KEY), so it carries no unit test by design.
 *
 * Resolver-action shape + observability use the EXPORTED `firecrawlJsonExtract`
 * helper from firecrawl.ts for the `json` POST (which warns + safe-skips on a
 * missing key), with per-item try/catch and console.error on a real fetch error.
 * The web search itself reuses the EXPORTED `searchAndFetch` from firecrawl.ts.
 */
import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { OLP_HOURS_MIN, OLP_HOURS_MAX } from "./olpLabor";
import { searchAndFetch, firecrawlJsonExtract } from "./firecrawl";
import { median } from "../lib/robustStats";

export type WebLaborExtract = {
  labor_hours: number | null;
  service_match: boolean | null;
  vehicle_match: boolean | null;
  source_label?: string | null;
  confidence?: number | null;
};

export function acceptWebLabor(x: WebLaborExtract): boolean {
  return (
    x.labor_hours != null &&
    x.labor_hours >= OLP_HOURS_MIN &&
    x.labor_hours <= OLP_HOURS_MAX &&
    x.service_match !== false &&
    x.vehicle_match !== false
  );
}

// ---------------------------------------------------------------------------
// Network resolver
// ---------------------------------------------------------------------------

/** Firecrawl `json` extraction schema for one labor-hours read. */
const WEB_LABOR_SCHEMA = {
  type: "object",
  required: ["labor_hours"],
  properties: {
    labor_hours: {
      type: ["number", "null"],
      description:
        "the flat-rate / book LABOR TIME IN HOURS for the specified service on the specified vehicle (e.g. 1.2). NOT dollars, NOT total job time including parts. null if the page does not state it.",
    },
    service_match: {
      type: ["boolean", "null"],
      description:
        "true if this page is actually about THIS service, false if it is about a different service, null if unknown",
    },
    vehicle_match: {
      type: ["boolean", "null"],
      description:
        "true if this page is actually about THIS vehicle (year/make/model/engine), false if a different vehicle, null if unknown",
    },
    source_label: {
      type: ["string", "null"],
      description: "the exact text the labor hours were read from",
    },
    confidence: {
      type: ["number", "null"],
      description: "0..1 self-rating of the extraction",
    },
  },
};

/**
 * Firecrawl-`json`-extract a single page's labor-hours read for one service +
 * vehicle. Returns null on any non-ok / error / missing-key — never throws.
 */
async function extractWebLaborFirecrawl(
  url: string,
  vehicleLabel: string,
  serviceName: string,
): Promise<WebLaborExtract | null> {
  const prompt =
    `Extract the flat-rate / book LABOR TIME IN HOURS for the service "${serviceName}" on the vehicle "${vehicleLabel}". ` +
    `Return labor_hours as a plain number of HOURS only (e.g. 1.2) — NOT dollars, NOT the total job time including parts, NOT a labor rate. ` +
    `Set service_match to whether this page is actually about THIS service (true / false / null if unknown). ` +
    `Set vehicle_match to whether this page is actually about THIS vehicle (true / false / null if unknown). ` +
    `Copy the exact text you read the hours from into source_label. ` +
    `If the page does not state the labor hours, set labor_hours to null. Never guess.`;
  const j = await firecrawlJsonExtract(url, prompt, WEB_LABOR_SCHEMA);
  if (!j) return null;
  const num = (x: any) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const bool = (x: any) => (typeof x === "boolean" ? x : null);
  const str = (x: any) => (typeof x === "string" ? x : null);
  return {
    labor_hours: num(j.labor_hours),
    service_match: bool(j.service_match),
    vehicle_match: bool(j.vehicle_match),
    source_label: str(j.source_label),
    confidence: num(j.confidence),
  };
}

/** Hostname of a URL, guarded — falls back to the raw url, then "". */
function hostnameOf(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return u || "";
  }
}

export type WebLaborResult = {
  /** True only when at least one service yielded a value (non-empty services map). */
  resolved: boolean;
  /** service-slug -> { median accepted hours, hostname of a producing URL } */
  services: Record<string, { hours: number; source_domain: string }>;
};

/**
 * Resolve one config to open-web labor HOURS per service.
 *
 * For each service: build a web-search query, take the top ≤3 result URLs (cap
 * at 3 URLs per service), firecrawl-`json`-extract each, keep only extractions
 * that pass `acceptWebLabor`, and — if at least one survives — record the MEDIAN
 * of the accepted hours plus the hostname of the first URL that produced an
 * accepted value.
 *
 * Per-URL failure (fetch error, non-ok, parse fail) is SAFE-NULL: we skip that
 * URL and continue — one bad URL never aborts the service or the loop. `resolved`
 * is true only when the services map is non-empty (mirrors how a source should
 * report "I found something").
 */
export const resolveWebLaborForConfig = internalAction({
  args: {
    year: v.number(),
    make: v.string(),
    model: v.string(),
    // engine string may be empty/null
    engine: v.optional(v.union(v.string(), v.null())),
    services: v.array(v.object({ slug: v.string(), name: v.string() })),
  },
  handler: async (_ctx, args): Promise<WebLaborResult> => {
    if (!process.env.FIRECRAWL_API_KEY) {
      console.warn("resolveWebLaborForConfig: FIRECRAWL_API_KEY not set; skipping web_labor");
      return { resolved: false, services: {} };
    }

    const services: Record<string, { hours: number; source_domain: string }> = {};
    const engine = args.engine ?? "";
    const vehicleLabel = `${args.year} ${args.make} ${args.model} ${engine}`
      .replace(/\s+/g, " ")
      .trim();

    for (const svc of args.services) {
      try {
        // Collapse any double spaces left by an empty engine.
        const query = `${args.year} ${args.make} ${args.model} ${engine} ${svc.name} labor time flat rate hours`
          .replace(/\s+/g, " ")
          .trim();

        const results = await searchAndFetch(query, 5);
        // Cap at 3 URLs per service.
        const urls = results
          .map((r) => r.url)
          .filter((u) => !!u)
          .slice(0, 3);

        const accepted: number[] = [];
        let sourceDomain = "";
        for (const url of urls) {
          try {
            const extract = await extractWebLaborFirecrawl(url, vehicleLabel, svc.name);
            if (extract && acceptWebLabor(extract) && extract.labor_hours != null) {
              accepted.push(extract.labor_hours);
              // hostname of the FIRST URL that produced an accepted value.
              if (!sourceDomain) sourceDomain = hostnameOf(url);
            }
          } catch (e) {
            // Per-URL safe-null: one bad URL must never sink the service or loop.
            console.error(`web_labor: url "${url}" failed:`, e);
          }
        }

        if (accepted.length > 0) {
          services[svc.slug] = { hours: median(accepted), source_domain: sourceDomain };
        }
      } catch (e) {
        // Per-service safe-null: one service must never sink the whole loop.
        console.error(`web_labor: service "${svc.slug}" failed:`, e);
      }
    }

    return { resolved: Object.keys(services).length > 0, services };
  },
});
