/**
 * vehicleEnrichment/olpLaborScrape.ts — OLP labor RESOLVER (network).
 * Resolves one vehicle_config to its OLP page and returns scope-correct labor
 * HOURS per mapped service. Shared by the enrichment pipeline (v3pipeline),
 * the fleet backfill (olpRelabor), and the probe (devOnly/olpProbe). READ-ONLY:
 * returns data, writes nothing. Pure mapping/parsing lives in olpLabor.ts.
 * Spec: docs/superpowers/specs/2026-06-13-olp-replaces-repairpal-design.md
 */
import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import {
  OLP_BASE, olpSlugify, extractBuildId, parseJsonLoose,
  olpModelCandidates, pickOlpVehicle, matchJobs, OLP_JOB_MAP,
  type OlpVehicleRow, type OlpLaborJob,
} from "./olpLabor";

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function fetchOlpHtml(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": CHROME_UA } });
    if (r.ok) return await r.text();
  } catch {}
  return null;
}

async function fetchOlpJson(url: string): Promise<any | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": CHROME_UA, Accept: "application/json" } });
    if (r.ok) return await r.json();
  } catch {}
  // Fallback path: some hosts wrap JSON; tolerate it.
  const html = await fetchOlpHtml(url);
  if (html) {
    const parsed = parseJsonLoose(html);
    if (parsed && typeof parsed === "object") return parsed;
  }
  return null;
}

/** Discover the current Next.js buildId (changes when OLP redeploys). */
export const resolveBuildId = internalAction({
  args: {},
  handler: async (): Promise<{ buildId: string | null }> => {
    const html = await fetchOlpHtml(OLP_BASE);
    return { buildId: html ? extractBuildId(html) : null };
  },
});

export type OlpLaborResult = {
  resolved: boolean;
  olp_url?: string;
  engine_slug?: string;
  /** service-slug -> scope-correct OLP labor hours (only resolved services) */
  services: Record<string, number>;
  error?: string;
};

/**
 * Resolve one config to OLP and return labor hours per mapped service.
 * Inputs come from the caller (pipeline/backfill already have them) so this
 * action stays self-contained and does no DB reads.
 */
export const resolveOlpLaborForConfig = internalAction({
  args: {
    buildId: v.string(),
    make: v.string(),
    model: v.string(),
    trim: v.optional(v.string()),
    year: v.number(),
    displacementL: v.optional(v.union(v.number(), v.null())),
    cylinders: v.optional(v.union(v.number(), v.null())),
    turbo: v.optional(v.union(v.boolean(), v.null())),
  },
  handler: async (_ctx, args): Promise<OlpLaborResult> => {
    const makeSlug = olpSlugify(args.make);
    const empty: OlpLaborResult = { resolved: false, services: {} };

    let vehicles: OlpVehicleRow[] | null = null;
    let modelSlug: string | null = null;
    for (const cand of olpModelCandidates(args.model, args.trim ?? "")) {
      const url =
        `${OLP_BASE}/_next/data/${args.buildId}/labor-times/${makeSlug}/${cand}.json` +
        `?make=${makeSlug}&model=${cand}`;
      const json = await fetchOlpJson(url);
      const rows = json?.pageProps?.data?.vehicles;
      if (Array.isArray(rows) && rows.length > 0) { vehicles = rows; modelSlug = cand; break; }
    }
    if (!vehicles || !modelSlug) return { ...empty, error: "model not found on OLP" };

    const row = pickOlpVehicle(vehicles, args.year, {
      displacementL: args.displacementL ?? null,
      cylinders: args.cylinders ?? null,
      turbo: args.turbo ?? null,
    });
    if (!row) return { ...empty, error: "year/engine not found on OLP" };

    const baseParams = `make=${makeSlug}&model=${modelSlug}&year=${args.year}&engine=${row.engineSlug}`;
    let portal = await fetchOlpJson(
      `${OLP_BASE}/_next/data/${args.buildId}/portal/${makeSlug}/${modelSlug}/${args.year}/${row.engineSlug}.json?${baseParams}`,
    );
    const redirect = portal?.pageProps?.__N_REDIRECT as string | undefined;
    if (redirect && !redirect.startsWith("/")) {
      return { ...empty, error: "unexpected non-relative __N_REDIRECT" };
    }
    if (redirect) {
      const path = redirect.replace(/\/$/, "");
      const dt = path.split("/").pop();
      portal = await fetchOlpJson(`${OLP_BASE}/_next/data/${args.buildId}${path}.json?${baseParams}&drivetrain=${dt}`);
    }
    const laborJobs = portal?.pageProps?.laborJobs as OlpLaborJob[] | undefined;
    if (!Array.isArray(laborJobs) || laborJobs.length === 0) {
      return { ...empty, error: "portal JSON missing laborJobs" };
    }

    const services: Record<string, number> = {};
    for (const m of matchJobs(laborJobs, OLP_JOB_MAP, { cylinders: args.cylinders ?? null })) {
      if (m.olp_hours != null) services[m.service] = m.olp_hours;
    }
    return {
      resolved: true,
      olp_url: `${OLP_BASE}/portal/${makeSlug}/${modelSlug}/${args.year}/${row.engineSlug}/`,
      engine_slug: row.engineSlug,
      services,
    };
  },
});
