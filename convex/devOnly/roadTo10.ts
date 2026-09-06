/**
 * devOnly/roadTo10 — READ-ONLY fleet census for the Road-to-1.0 gap analysis.
 *
 * Per config: gate status, latest quotability snapshot (pct + per-service
 * missing core roles), fill, and the fitment-audit stamp. Paginated so the
 * caller aggregates across pages (fleet is a few hundred configs).
 *
 *   npx convex run devOnly/roadTo10:census '{"cursor":null}'
 */
import { v } from "convex/values";
import { internalQuery } from "../_generated/server";

const SYNTHETIC_KEY_RE = /_(unknownl_unknowncyl|unknownl_[0-9]+cyl|[0-9_]+l_(unknown|[0-9]+)cyl)$/;

/** Cohort-3 repair inventory: every synthetic-suffix config with its attached
 *  VINs (real vs SHOP synthetic), fitment/run counts, and any proper-key
 *  sibling (same base key, non-synthetic suffix) it could merge into. */
export const identityCohort = internalQuery({
  args: {},
  handler: async (ctx) => {
    const configs = await ctx.db.query("vehicle_configs").take(1000);
    const synthetic = (configs as any[]).filter((c) =>
      SYNTHETIC_KEY_RE.test(String(c.config_key ?? "")),
    );
    // Base-key → non-synthetic siblings, for merge-target lookup.
    const byBase = new Map<string, any[]>();
    for (const c of configs as any[]) {
      const key = String(c.config_key ?? "");
      if (!key || SYNTHETIC_KEY_RE.test(key)) continue;
      const base = key.replace(/_[a-z0-9]+$/, "");
      const arr = byBase.get(base) ?? [];
      arr.push(c);
      byBase.set(base, arr);
    }
    const out: any[] = [];
    for (const c of synthetic) {
      const key = String(c.config_key);
      const base = key.replace(SYNTHETIC_KEY_RE, "");
      const vehicles = await ctx.db
        .query("vehicles")
        .withIndex("by_vehicle_config", (q: any) => q.eq("vehicle_config_id", c._id))
        .take(10)
        .catch(() => [] as any[]);
      const fitments = await ctx.db
        .query("part_fitments")
        .withIndex("by_vehicle_config", (q: any) => q.eq("vehicle_config_id", c._id))
        .take(200);
      const vins = (vehicles as any[]).map((x) => String(x.vin ?? ""));
      out.push({
        config_key: key,
        status: c.enrichment_status ?? null,
        vehicles: vins.length,
        real_vins: vins.filter((x) => x && !x.startsWith("SHOP")).length,
        sample_vin: vins[0] ?? null,
        fitments: fitments.length,
        siblings: (byBase.get(base) ?? []).map((s) => ({
          key: s.config_key,
          status: s.enrichment_status ?? null,
        })),
      });
    }
    return { count: out.length, rows: out.sort((a, b) => a.config_key.localeCompare(b.config_key)) };
  },
});

/** Config id + fluid-spec anchors for a config_key — feeds targeted rung runs. */
export const configIdForKey = internalQuery({
  args: { configKey: v.string() },
  handler: async (ctx, args) => {
    const cfg: any = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_config_key", (q: any) => q.eq("config_key", args.configKey))
      .first();
    if (!cfg) return { error: "config_not_found" };
    const trans: any = cfg.transmission_id ? await ctx.db.get(cfg.transmission_id) : null;
    const eng: any = cfg.engine_id ? await ctx.db.get(cfg.engine_id) : null;
    return {
      configId: String(cfg._id),
      year: cfg.year ?? null,
      trans_fluid_type: trans?.fluid_type ?? null,
      coolant_type: eng?.coolant_type ?? null,
    };
  },
});

/** Configs whose transmission fluid_type matches a substring — rung targeting. */
export const configsWithAtfSpec = internalQuery({
  args: { match: v.string() },
  handler: async (ctx, args) => {
    const needle = args.match.toLowerCase();
    const transRows = (await ctx.db.query("transmissions").take(2000)).filter((t: any) =>
      String(t.fluid_type ?? "").toLowerCase().includes(needle),
    );
    const transIds = new Set(transRows.map((t: any) => String(t._id)));
    const configs = await ctx.db.query("vehicle_configs").take(1000);
    const out: any[] = [];
    for (const c of configs as any[]) {
      if (!c.transmission_id || !transIds.has(String(c.transmission_id))) continue;
      const fit = await ctx.db
        .query("part_fitments")
        .withIndex("by_vehicle_config", (q: any) => q.eq("vehicle_config_id", c._id))
        .take(200);
      let hasAtf = false;
      for (const f of fit as any[]) {
        const p: any = await ctx.db.get(f.part_id);
        if (p?.subcategory === "atf_fluid") { hasAtf = true; break; }
      }
      const trans: any = await ctx.db.get(c.transmission_id);
      out.push({
        configId: String(c._id),
        config_key: c.config_key,
        fluid_type: trans?.fluid_type ?? null,
        has_atf_fitment: hasAtf,
      });
    }
    return out;
  },
});

/** Run ids for a config_key, newest first — feeds auditRunFlow:stepTraceForRun. */
export const runsForConfigKey = internalQuery({
  args: { configKey: v.string() },
  handler: async (ctx, args) => {
    const cfg = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_config_key", (q: any) => q.eq("config_key", args.configKey))
      .first();
    if (!cfg) return { error: "config_not_found" };
    const runs = await ctx.db
      .query("enrichment_runs")
      .withIndex("by_vehicle_config", (q: any) => q.eq("vehicle_config_id", cfg._id))
      .order("desc")
      .take(8);
    return runs.map((r: any) => ({
      runId: r._id,
      created: new Date(r._creationTime).toISOString(),
      status: r.status,
      errors: (r.errors ?? []).slice(0, 4),
    }));
  },
});

/** Last N runs, newest first — liveness + error check for the report. */
export const recentRuns = internalQuery({
  args: {},
  handler: async (ctx) => {
    const runs = await ctx.db.query("enrichment_runs").order("desc").take(15);
    const out: any[] = [];
    for (const r of runs as any[]) {
      const cfg: any = r.vehicle_config_id ? await ctx.db.get(r.vehicle_config_id) : null;
      out.push({
        created: new Date(r.created_at ?? r._creationTime).toISOString(),
        status: r.status ?? null,
        config_key: cfg?.config_key ?? null,
        fill: r.applicable_fill_rate ?? r.fill_rate ?? null,
        q: r.quotability?.pct ?? null,
        errors: (r.errors ?? []).slice(0, 2),
      });
    }
    return out;
  },
});

export const census = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("vehicle_configs")
      .paginate({ cursor: args.cursor ?? null, numItems: 50 });

    const rows: any[] = [];
    for (const c of page.page as any[]) {
      const [mk, md] = await Promise.all([
        c.make_id ? ctx.db.get(c.make_id) : null,
        c.model_id ? ctx.db.get(c.model_id) : null,
      ]);
      // Latest run carrying a quotability snapshot (finalize-time or healed).
      const runs = await ctx.db
        .query("enrichment_runs")
        .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", c._id))
        .order("desc")
        .take(12);
      const withQ: any = runs.find((r: any) => r.quotability?.pct != null);
      const gaps = (withQ?.quotability?.services ?? [])
        .filter((s: any) => (s.missing_roles?.length ?? 0) > 0 || s.core_with_price < s.core_total)
        .map((s: any) => ({
          slug: s.slug,
          missing_roles: s.missing_roles ?? [],
          unpriced: Math.max(0, (s.core_with_fitment ?? 0) - (s.core_with_price ?? 0)),
        }));
      rows.push({
        config_key: c.config_key ?? null,
        vehicle: `${c.year ?? "?"} ${(mk as any)?.name ?? "?"} ${(md as any)?.name ?? "?"} ${c.trim_name ?? ""}`.trim(),
        status: c.enrichment_status ?? null,
        q: withQ?.quotability?.pct ?? null,
        fill: withQ?.applicable_fill_rate ?? withQ?.fill_rate ?? c.fill_rate ?? null,
        audited: c.fitment_audited_at != null,
        gaps,
      });
    }
    return { rows, continueCursor: page.continueCursor, isDone: page.isDone };
  },
});
