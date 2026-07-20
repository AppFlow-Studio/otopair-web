// =============================================================================
// Data portal · shared vehicle-config resolution — VIN / YMMT / config_key.
// Nobody outside the team knows config_keys (the /v0 API learned this first —
// see dataApi.resolveByYmmt); every portal surface that needs a config now
// resolves through this module via the shared <ConfigPicker> component:
//   - vin:    vehicles.by_vin → vehicle_config_id (with honest miss notes)
//   - ymmt:   year/make/model[/trim] → config_key prefix range (same
//             normalization as dataApi — the two can never drift apart)
//   - search: raw config_key substring window (the expert path, kept)
// =============================================================================
import { v } from "convex/values";
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { requireDirector } from "./directorGate";

// --- Authored return types (see dataOverview.ts header) -----------------------

export type ConfigMatch = {
  id: string;
  config_key: string;
  year: number;
  trim_name: string | null;
  engine_label: string | null;
  pricing_tier: string | null;
  enrichment_status: string | null;
};
export type ResolveResult = {
  resolved_via: "vin" | "ymmt" | "search";
  matches: ConfigMatch[];
  truncated: boolean;
  // VIN mode: what happened when no config matched.
  note: string | null;
};

const slug = (s: string) =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

async function toMatch(
  ctx: QueryCtx,
  c: Doc<"vehicle_configs">,
  engineCache: Map<string, string | null>,
): Promise<ConfigMatch> {
  let engineLabel: string | null = null;
  if (c.engine_id) {
    const eid = String(c.engine_id);
    if (!engineCache.has(eid)) {
      const e = await ctx.db.get(c.engine_id);
      const eo = e as { engine_code?: string; name?: string } | null;
      engineCache.set(eid, eo?.engine_code ?? eo?.name ?? null);
    }
    engineLabel = engineCache.get(eid) ?? null;
  }
  return {
    id: String(c._id),
    config_key: c.config_key,
    year: c.year,
    trim_name: c.trim_name ?? null,
    engine_label: engineLabel,
    pricing_tier: c.pricing_tier ?? null,
    enrichment_status: c.enrichment_status ?? null,
  };
}

export const resolve = query({
  args: {
    token: v.string(),
    vin: v.optional(v.string()),
    year: v.optional(v.number()),
    make: v.optional(v.string()),
    model: v.optional(v.string()),
    trim: v.optional(v.string()),
    search: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ResolveResult> => {
    await requireDirector(ctx, args.token);
    const engineCache = new Map<string, string | null>();

    // ── VIN ──
    if (args.vin && args.vin.trim()) {
      const vin = args.vin.trim().toUpperCase();
      const vehicle = await ctx.db
        .query("vehicles")
        .withIndex("by_vin", (q) => q.eq("vin", vin))
        .first();
      if (!vehicle) {
        const queued = await ctx.db
          .query("vin_queue")
          .withIndex("by_vin", (q) => q.eq("vin", vin))
          .first();
        return {
          resolved_via: "vin",
          matches: [],
          truncated: false,
          note: queued
            ? `VIN is in the enrichment queue (status: ${queued.status}) — no decoded vehicle yet.`
            : "VIN not on the platform — queue it via the Control Room re-enrich trigger.",
        };
      }
      if (!vehicle.vehicle_config_id) {
        return {
          resolved_via: "vin",
          matches: [],
          truncated: false,
          note: "VIN decoded but not linked to a vehicle config (decode gap — see VIN Explorer).",
        };
      }
      const config = await ctx.db.get(vehicle.vehicle_config_id);
      return {
        resolved_via: "vin",
        matches: config ? [await toMatch(ctx, config, engineCache)] : [],
        truncated: false,
        note: config ? null : "Linked config no longer exists.",
      };
    }

    // ── YMMT (config_key prefix range — same normalization as the /v0 API) ──
    if (args.year != null && args.make && args.model) {
      const prefix = `${args.year}_${slug(args.make)}_${slug(args.model)}`;
      const rows = await ctx.db
        .query("vehicle_configs")
        .withIndex("by_config_key", (q) =>
          q.gte("config_key", prefix).lt("config_key", prefix + "￿"),
        )
        .take(50);
      const trimSlug = args.trim ? slug(args.trim) : null;
      const filtered = trimSlug ? rows.filter((r) => r.config_key.includes(trimSlug)) : rows;
      const pool = filtered.length > 0 ? filtered : rows;
      const matches: ConfigMatch[] = [];
      for (const c of pool.slice(0, 25)) matches.push(await toMatch(ctx, c, engineCache));
      return {
        resolved_via: "ymmt",
        matches,
        truncated: pool.length > 25 || rows.length === 50,
        note:
          matches.length === 0
            ? "No configs match that year/make/model on this deployment."
            : trimSlug && filtered.length === 0
              ? "No config matches that trim — showing all trims for the year/make/model."
              : null,
      };
    }

    // ── config_key substring (expert path) ──
    const term = (args.search ?? "").trim().toLowerCase();
    const window = await ctx.db.query("vehicle_configs").take(400);
    const hits = term
      ? window.filter((c) => c.config_key.toLowerCase().includes(term))
      : window;
    const matches: ConfigMatch[] = [];
    for (const c of hits.slice(0, 25)) matches.push(await toMatch(ctx, c, engineCache));
    return {
      resolved_via: "search",
      matches,
      truncated: hits.length > 25 || window.length === 400,
      note: matches.length === 0 ? "No config_key contains that text (window: 400)." : null,
    };
  },
});

export type FacetsResult = { years: number[]; makes: string[] };

/** Distinct years + make names across configs — powers the YMMT inputs'
 *  suggestions. 384 configs live; bounded window with the usual honesty. */
export const facets = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<FacetsResult> => {
    await requireDirector(ctx, token);
    const configs = await ctx.db.query("vehicle_configs").take(500);
    const years = [...new Set(configs.map((c) => c.year))].sort((a, b) => b - a);
    const seen = new Set<string>();
    const makes: string[] = [];
    for (const c of configs) {
      const mid = String(c.make_id);
      if (seen.has(mid)) continue;
      seen.add(mid);
      const m = await ctx.db.get(c.make_id);
      const name = m ? ((m as { name?: string }).name ?? null) : null;
      if (name) makes.push(name);
    }
    return { years, makes: makes.sort() };
  },
});
