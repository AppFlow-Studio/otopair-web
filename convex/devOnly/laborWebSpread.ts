/**
 * devOnly/laborWebSpread.ts — THROWAWAY diagnostic probe (design spike, NOT a feature).
 *
 * For one car + a list of services, runs the open-web labor search and returns
 * EVERY per-source hours reading (not the median the real resolver collapses to),
 * so we can see the actual spread across distinct websites BEFORE designing the
 * 3-source-agreement labor model. Read-only — writes nothing. Reuses the exact
 * search + firecrawl-json extraction the real web_labor resolver uses.
 */
import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { searchAndFetch, firecrawlJsonExtract } from "../vehicleEnrichment/firecrawl";
import { acceptWebLabor } from "../vehicleEnrichment/laborWebSearch";

const SCHEMA = {
  type: "object",
  required: ["labor_hours"],
  properties: {
    labor_hours: {
      type: ["number", "null"],
      description:
        "flat-rate/book LABOR TIME in HOURS for this service on this vehicle — NOT dollars, NOT total job time including parts, NOT a labor rate",
    },
    service_match: { type: ["boolean", "null"], description: "is this page about THIS service?" },
    vehicle_match: {
      type: ["boolean", "null"],
      description: "is this page about THIS vehicle (year/make/model)?",
    },
    source_label: { type: ["string", "null"], description: "the exact text the hours were read from" },
  },
};

function hostnameOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
}

export const probe = internalAction({
  args: {
    year: v.number(),
    make: v.string(),
    model: v.string(),
    engine: v.optional(v.string()),
    services: v.array(v.object({ slug: v.string(), name: v.string() })),
    maxUrls: v.optional(v.number()),
  },
  handler: async (_ctx, args): Promise<any> => {
    const maxUrls = args.maxUrls ?? 6;
    const out: any[] = [];
    for (const svc of args.services) {
      const query = `${args.year} ${args.make} ${args.model} ${args.engine ?? ""} ${svc.name} labor time flat rate hours`
        .replace(/\s+/g, " ")
        .trim();
      const vehicleLabel = `${args.year} ${args.make} ${args.model} ${args.engine ?? ""}`
        .replace(/\s+/g, " ")
        .trim();
      const prompt =
        `Extract the flat-rate/book LABOR TIME in HOURS for "${svc.name}" on a ${vehicleLabel}. ` +
        `HOURS only (e.g. 1.2) — NOT dollars, NOT total job time including parts, NOT a labor rate. ` +
        `Set service_match/vehicle_match true/false/null. labor_hours null if not found. Never guess.`;

      let urls: string[] = [];
      try {
        const results = await searchAndFetch(query, 8);
        urls = results.map((r: any) => r.url).filter(Boolean).slice(0, maxUrls);
      } catch {
        urls = [];
      }

      const readings: any[] = [];
      for (const url of urls) {
        try {
          const j: any = await firecrawlJsonExtract(url, prompt, SCHEMA);
          if (!j) {
            readings.push({ domain: hostnameOf(url), hours: null, note: "no-extract" });
            continue;
          }
          const ex = {
            labor_hours: typeof j.labor_hours === "number" ? j.labor_hours : null,
            service_match: typeof j.service_match === "boolean" ? j.service_match : null,
            vehicle_match: typeof j.vehicle_match === "boolean" ? j.vehicle_match : null,
            source_label: typeof j.source_label === "string" ? j.source_label : null,
          };
          readings.push({
            domain: hostnameOf(url),
            hours: ex.labor_hours,
            service_match: ex.service_match,
            vehicle_match: ex.vehicle_match,
            accepted: acceptWebLabor(ex as any),
            label: ex.source_label,
          });
        } catch {
          readings.push({ domain: hostnameOf(url), hours: null, note: "error" });
        }
      }

      const acceptedHours = readings.filter((r) => r.accepted && typeof r.hours === "number").map((r) => r.hours);
      const distinctDomains = new Set(readings.filter((r) => r.accepted).map((r) => r.domain)).size;
      out.push({
        service: svc.slug,
        name: svc.name,
        query,
        accepted_count: acceptedHours.length,
        distinct_domains_accepted: distinctDomains,
        accepted_hours_sorted: [...acceptedHours].sort((a, b) => a - b),
        readings,
      });
    }
    return out;
  },
});
