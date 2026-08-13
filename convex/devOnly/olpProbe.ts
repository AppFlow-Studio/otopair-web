/**
 * devOnly/olpProbe.ts — Open Labor Project probe. READ-ONLY: fetches OLP's
 * Next.js data-route JSON for each enriched config and compares OLP labor
 * hours against our labor_times / Estimator observations. Writes NOTHING.
 * Driven by scripts/olp-probe.mjs which assembles proof/olp/SUMMARY.md.
 * Spec: docs/superpowers/specs/2026-06-12-olp-labor-probe-design.md
 */
import { internalAction, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import {
  OLP_BASE,
  olpSlugify,
  parseJsonLoose,
  olpModelCandidates,
  pickOlpVehicle,
  matchJobs,
  OLP_JOB_MAP,
  type OlpVehicleRow,
  type OlpLaborJob,
} from "../vehicleEnrichment/olpLabor";
import { LABOR_SERVICE_CONFIG } from "../services/laborDeterminant";
import { fetchUrlWithHtml } from "../vehicleEnrichment/firecrawl";
import { isEstimatorBookSource } from "../lib/sourceNames";
export { resolveBuildId } from "../vehicleEnrichment/olpLaborScrape";

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Firecrawl first (shared infra, FIRECRAWL_API_KEY), browser-UA fetch as
 * fallback — OLP's bot wall is UA-based (403 for non-browser UAs). */
async function fetchOlpJson(url: string): Promise<any | null> {
  try {
    const page = await fetchUrlWithHtml(url);
    for (const body of [page?.html, page?.markdown]) {
      if (!body) continue;
      const parsed = parseJsonLoose(body);
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch (err) {
    // Visible diagnostic (e.g. FIRECRAWL_API_KEY unset in a local run) —
    // we still degrade to the direct fetch below.
    console.warn(`[olpProbe] firecrawl fetch failed for ${url}: ${err instanceof Error ? err.message : err}`);
  }
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": CHROME_UA, Accept: "application/json" },
    });
    if (r.ok) return await r.json();
  } catch {}
  return null;
}

async function fetchOlpHtml(url: string): Promise<string | null> {
  try {
    const page = await fetchUrlWithHtml(url);
    if (page?.html) return page.html;
  } catch {}
  try {
    const r = await fetch(url, { headers: { "User-Agent": CHROME_UA } });
    if (r.ok) return await r.text();
  } catch {}
  return null;
}

/** Enriched configs for the driver loop. */
export const _listEnrichedConfigs = internalQuery({
  args: {},
  handler: async (ctx) => {
    const configs = await ctx.db.query("vehicle_configs").collect();
    return configs
      .filter((c: any) => c.enrichment_status === "complete")
      .map((c: any) => ({ id: c._id, config_key: c.config_key }));
  },
});

/** Everything probeConfig needs from OUR side, in one query. */
export const _configLaborSnapshot = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    const cfg: any = await ctx.db.get(args.vehicleConfigId);
    if (!cfg) return null;
    const [make, model, engine] = await Promise.all([
      cfg.make_id ? ctx.db.get(cfg.make_id) : null,
      cfg.model_id ? ctx.db.get(cfg.model_id) : null,
      cfg.engine_id ? ctx.db.get(cfg.engine_id) : null,
    ]);

    const allServices = await ctx.db.query("services").collect();
    const laborSlugs = new Set(Object.keys(LABOR_SERVICE_CONFIG));
    const services: any[] = [];
    for (const svc of allServices as any[]) {
      if (!laborSlugs.has(svc.slug)) continue;
      const lt: any = await ctx.db
        .query("labor_times")
        .withIndex("by_vehicle_config_and_service", (q: any) =>
          q.eq("vehicle_config_id", cfg._id).eq("service_id", svc._id),
        )
        .first();
      const obs = await ctx.db
        .query("labor_observations")
        .withIndex("by_config_service", (q: any) =>
          q.eq("vehicle_config_id", cfg._id).eq("service_id", svc._id),
        )
        .collect();
      const rp = (obs as any[]).find((o) => isEstimatorBookSource(o.source));
      services.push({
        slug: svc.slug,
        our_hours: lt?.book_hours ?? null,
        our_source: lt?.source ?? null,
        our_confidence: lt?.confidence ?? null,
        estimator_hours: rp?.hours ?? null,
      });
    }

    const rawDisp =
      (engine as any)?.displacement_l ??
      (engine as any)?.displacement_liters ??
      null;
    return {
      config_key: cfg.config_key,
      year: cfg.year as number,
      make: (make as any)?.name ?? "",
      model: (model as any)?.name ?? "",
      trim: (cfg.trim_name as string) ?? "",
      engine_hints: {
        displacementL: rawDisp == null ? null : Number(rawDisp) || null,
        cylinders: ((engine as any)?.cylinders as number) ?? null,
        turbo:
          (engine as any)?.aspiration != null
            ? /turbo|supercharg/i.test((engine as any).aspiration)
            : null,
      },
      services,
    };
  },
});

/** Probe one config against OLP. Returns the comparison object; no writes. */
export const probeConfig = internalAction({
  args: { vehicleConfigId: v.id("vehicle_configs"), buildId: v.string() },
  handler: async (ctx, args): Promise<any> => {
    const snap: any = await ctx.runQuery(
      internal.devOnly.olpProbe._configLaborSnapshot,
      { vehicleConfigId: args.vehicleConfigId },
    );
    if (!snap) return { resolved: false, error: "config not found" };

    const makeSlug = olpSlugify(snap.make);
    const fail = (error: string, extra: object = {}) => ({
      config_key: snap.config_key,
      year: snap.year,
      make: snap.make,
      model: snap.model,
      trim: snap.trim,
      resolved: false,
      error,
      ...extra,
    });

    // (1) model browse JSON — first slug candidate that resolves wins
    let vehicles: OlpVehicleRow[] | null = null;
    let modelSlug: string | null = null;
    for (const cand of olpModelCandidates(snap.model, snap.trim)) {
      const url =
        `${OLP_BASE}/_next/data/${args.buildId}/labor-times/${makeSlug}/${cand}.json` +
        `?make=${makeSlug}&model=${cand}`;
      const json = await fetchOlpJson(url);
      const rows = json?.pageProps?.data?.vehicles;
      if (Array.isArray(rows) && rows.length > 0) {
        vehicles = rows;
        modelSlug = cand;
        break;
      }
    }
    if (!vehicles || !modelSlug) return fail("model not found on OLP");

    // (2) pick year+engine row
    const row = pickOlpVehicle(vehicles, snap.year, snap.engine_hints);
    if (!row) return fail("year/engine not found on OLP", { model_slug: modelSlug });

    // (3) portal JSON (follow the __N_REDIRECT that appends the drivetrain)
    const baseParams =
      `make=${makeSlug}&model=${modelSlug}&year=${snap.year}&engine=${row.engineSlug}`;
    let portal = await fetchOlpJson(
      `${OLP_BASE}/_next/data/${args.buildId}/portal/${makeSlug}/${modelSlug}/${snap.year}/${row.engineSlug}.json?${baseParams}`,
    );
    const redirect = portal?.pageProps?.__N_REDIRECT as string | undefined;
    if (redirect && !redirect.startsWith("/")) {
      // Next.js normally redirects to a relative path; anything else means
      // the data-route contract drifted — surface it instead of building a
      // garbage URL that would mislead triage as "missing laborJobs".
      return fail("unexpected non-relative __N_REDIRECT", { redirect });
    }
    if (redirect) {
      const path = redirect.replace(/\/$/, "");
      const dt = path.split("/").pop();
      portal = await fetchOlpJson(
        `${OLP_BASE}/_next/data/${args.buildId}${path}.json?${baseParams}&drivetrain=${dt}`,
      );
    }
    const laborJobs = portal?.pageProps?.laborJobs as OlpLaborJob[] | undefined;
    if (!Array.isArray(laborJobs) || laborJobs.length === 0) {
      return fail("portal JSON missing laborJobs", {
        model_slug: modelSlug,
        engine_slug: row.engineSlug,
      });
    }

    // (4) match our services and join with our data
    // Pass the engine cylinder count so the probe picks the same cylinder-specific
    // spark-plug row (v6/v8) the production resolver does — otherwise the audit
    // output would show the generic row and hide the fix it drove.
    const matches = matchJobs(laborJobs, OLP_JOB_MAP, {
      cylinders: snap.engine_hints?.cylinders ?? null,
    });
    const byService = new Map(matches.map((m) => [m.service, m]));
    const services = snap.services.map((s: any) => {
      const m = byService.get(s.slug);
      const olp_hours = m?.olp_hours ?? null;
      const delta_pct =
        olp_hours != null && s.our_hours != null && s.our_hours > 0
          ? Math.round(((olp_hours - s.our_hours) / s.our_hours) * 100)
          : null;
      const status =
        olp_hours != null && s.our_hours != null
          ? "matched"
          : olp_hours != null
            ? "no_our_data"
            : s.our_hours != null
              ? "no_olp_job"
              : "both_missing";
      return { ...s, olp_hours, olp_jobs: m?.olp_jobs ?? [], delta_pct, status };
    });

    return {
      config_key: snap.config_key,
      year: snap.year,
      make: snap.make,
      model: snap.model,
      trim: snap.trim,
      resolved: true,
      olp_url: `${OLP_BASE}/portal/${makeSlug}/${modelSlug}/${snap.year}/${row.engineSlug}/`,
      olp_vehicle: row,
      olp_labor_count: laborJobs.length,
      services,
    };
  },
});
