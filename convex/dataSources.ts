// =============================================================================
// Data portal · Sources & Cache — /data/sources (Data spec §7).
// Registry (reliability formula rendered, not hidden) · blocked domains
// (manual override = ceremony) · URL-pattern registry · scrape cache health.
// The auto-block law itself lives in services/sourceScoring.ts (accuracy <40%
// after 20+ observations); this module only reads its outcomes and provides
// the manual block/unblock override.
// =============================================================================
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireDirector, logAudit } from "./directorGate";

const DAY = 24 * 60 * 60 * 1000;

// Reliability formula (V8): accuracy·0.7 + min(obs,100)/100·0.3 — recomputed
// here when the stored score is null so the column is never blank.
export const RELIABILITY_FORMULA = "accuracy × 0.7 + min(observations, 100)/100 × 0.3";

function reliability(accuracy: number | null, obs: number): number | null {
  if (accuracy == null) return null;
  return accuracy * 0.7 + (Math.min(obs, 100) / 100) * 0.3;
}

// --- Authored return types ---------------------------------------------------
// Explicit handler return types are load-bearing (see dataOverview.ts header).

export type RegistryRow = {
  id: string;
  domain: string;
  source_type: string;
  make: string | null;
  url_template: string | null;
  slug_count: number;
  total_observations: number;
  accuracy_rate: number | null;
  reliability_score: number | null;
  is_blocked: boolean;
  block_reason: string | null;
  last_scraped_at: number | null;
  last_scrape_success: boolean | null;
};
export type RegistryResult = {
  rows: RegistryRow[];
  truncated: boolean;
  formula: string;
};

export const listRegistry = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<RegistryResult> => {
    await requireDirector(ctx, token);
    // 158 rows measured; window leaves generous headroom.
    const rows = await ctx.db.query("source_registry").take(500);
    const makeName = new Map<string, string | null>();
    const out: RegistryRow[] = [];
    for (const r of rows) {
      let make: string | null = null;
      if (r.make_id) {
        const key = String(r.make_id);
        if (!makeName.has(key)) {
          const doc = await ctx.db.get(r.make_id);
          makeName.set(key, doc ? ((doc as { name?: string }).name ?? null) : null);
        }
        make = makeName.get(key) ?? null;
      }
      const obs = r.total_observations ?? 0;
      const slugMap = r.part_slug_map as Record<string, unknown> | null | undefined;
      out.push({
        id: String(r._id),
        domain: r.domain,
        source_type: r.source_type,
        make,
        url_template: r.url_template ?? null,
        slug_count: slugMap ? Object.keys(slugMap).length : 0,
        total_observations: obs,
        accuracy_rate: r.accuracy_rate ?? null,
        reliability_score: r.reliability_score ?? reliability(r.accuracy_rate ?? null, obs),
        is_blocked: r.is_blocked === true,
        block_reason: r.block_reason ?? null,
        last_scraped_at: r.last_scraped_at ?? null,
        last_scrape_success: r.last_scrape_success ?? null,
      });
    }
    out.sort((a, b) => a.domain.localeCompare(b.domain));
    return { rows: out, truncated: rows.length === 500, formula: RELIABILITY_FORMULA };
  },
});

export type BlockedRow = {
  id: string;
  domain: string;
  reason: string | null;
  blocked_by: string;
  accuracy_at_block: number | null;
  blocked_at: number | null;
};

export const listBlocked = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<BlockedRow[]> => {
    await requireDirector(ctx, token);
    const rows = await ctx.db.query("blocked_domains").take(100);
    return rows
      .map((r) => ({
        id: String(r._id),
        domain: r.domain,
        reason: r.reason ?? null,
        blocked_by: r.blocked_by ?? "unknown",
        accuracy_at_block: r.accuracy_at_block ?? null,
        blocked_at: r.blocked_at ?? r.created_at ?? null,
      }))
      .sort((a, b) => (b.blocked_at ?? 0) - (a.blocked_at ?? 0));
  },
});

export type CacheGroup = {
  source_type: string;
  count: number;
  ttl_days: number | null;
  newest_scraped_at: number | null;
  success_count: number;
};
export type CacheDomainStat = { domain: string; count: number; success: number };
export type ExpiringRow = {
  cache_key: string;
  domain: string | null;
  source_type: string | null;
  expires_at: number;
};
export type CacheOverviewResult = {
  groups: CacheGroup[];
  by_domain: CacheDomainStat[];
  expiring_soon: ExpiringRow[];
  total: number;
  computed_at: number | null;
};

export const cacheOverview = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<CacheOverviewResult> => {
    await requireDirector(ctx, token);
    // scrape_cache docs carry the full scraped page markdown — reading even a
    // few hundred live blew the 16MB execution read limit (Jul 14). The
    // rollup is materialized by the daily portalStats sweep ("cache" phase,
    // 100 docs/link); this query reads ONLY the thin stat row.
    const stat = await ctx.db
      .query("portal_stats")
      .withIndex("by_key", (q) => q.eq("key", "data.cache.summary"))
      .first();
    if (!stat) {
      return { groups: [], by_domain: [], expiring_soon: [], total: 0, computed_at: null };
    }
    const meta = (stat.meta ?? {}) as {
      groups?: { source_type: string; n: number; ttl_days: number | null; newest: number; success: number }[];
      by_domain?: { domain: string; n: number; success: number }[];
      expiring_soon?: ExpiringRow[];
    };
    return {
      groups: (meta.groups ?? []).map((g) => ({
        source_type: g.source_type,
        count: g.n,
        ttl_days: g.ttl_days,
        newest_scraped_at: g.newest > 0 ? g.newest : null,
        success_count: g.success,
      })),
      by_domain: (meta.by_domain ?? []).map((d) => ({
        domain: d.domain,
        count: d.n,
        success: d.success,
      })),
      expiring_soon: meta.expiring_soon ?? [],
      total: stat.value,
      computed_at: stat.computed_at,
    };
  },
});

export type CacheHitRateResult = { rate: number | null; samples: number; window_days: number };

export const cacheHitRate30d = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<CacheHitRateResult> => {
    await requireDirector(ctx, token);
    const runs = await ctx.db
      .query("enrichment_runs")
      .withIndex("by_created_at", (q) => q.gte("created_at", Date.now() - 30 * DAY))
      .take(500);
    const withFlag = runs.filter(
      (r) => (r as { scrape_cache_hit?: boolean }).scrape_cache_hit !== undefined,
    );
    const hits = withFlag.filter(
      (r) => (r as { scrape_cache_hit?: boolean }).scrape_cache_hit === true,
    ).length;
    return {
      rate: withFlag.length > 0 ? hits / withFlag.length : null,
      samples: withFlag.length,
      window_days: 30,
    };
  },
});

// --- Writes (ceremony: {token, reason} + audit row, atomic) -------------------

export const blockDomain = mutation({
  args: { token: v.string(), reason: v.string(), domain: v.string() },
  handler: async (ctx, { token, reason, domain }): Promise<{ ok: true }> => {
    const actor = await requireDirector(ctx, token, "data.write");
    if (reason.trim().length < 4) throw new Error("A reason is required.");
    const normalized = domain.trim().toLowerCase();
    if (!normalized) throw new Error("Domain is required.");
    const existing = await ctx.db
      .query("blocked_domains")
      .withIndex("by_domain", (q) => q.eq("domain", normalized))
      .first();
    if (existing) throw new Error(`${normalized} is already blocked.`);
    const reg = await ctx.db
      .query("source_registry")
      .withIndex("by_domain", (q) => q.eq("domain", normalized))
      .first();
    await ctx.db.insert("blocked_domains", {
      domain: normalized,
      reason: reason.trim(),
      blocked_at: Date.now(),
      blocked_by: "manual",
      accuracy_at_block: reg?.accuracy_rate ?? undefined,
      created_at: Date.now(),
    });
    if (reg) await ctx.db.patch(reg._id, { is_blocked: true, block_reason: reason.trim() });
    await logAudit(ctx, actor, {
      entity_type: "source_registry",
      entity_id: normalized,
      action: "domain_blocked",
      detail: `manual block — ${reason.trim()}`,
    });
    return { ok: true };
  },
});

export const unblockDomain = mutation({
  args: { token: v.string(), reason: v.string(), id: v.id("blocked_domains") },
  handler: async (ctx, { token, reason, id }): Promise<{ ok: true }> => {
    const actor = await requireDirector(ctx, token, "data.write");
    if (reason.trim().length < 4) throw new Error("A reason is required.");
    const row = await ctx.db.get(id);
    if (!row) throw new Error("That block row no longer exists.");
    await ctx.db.delete(id);
    const reg = await ctx.db
      .query("source_registry")
      .withIndex("by_domain", (q) => q.eq("domain", row.domain))
      .first();
    if (reg) await ctx.db.patch(reg._id, { is_blocked: false, block_reason: undefined });
    await logAudit(ctx, actor, {
      entity_type: "source_registry",
      entity_id: row.domain,
      action: "domain_unblocked",
      detail: `manual override (was blocked_by=${row.blocked_by ?? "?"}) — ${reason.trim()}`,
    });
    return { ok: true };
  },
});

export const clearVehicleCache = mutation({
  args: { token: v.string(), reason: v.string(), configId: v.id("vehicle_configs") },
  handler: async (
    ctx,
    { token, reason, configId },
  ): Promise<{ ok: true; deleted: number }> => {
    const actor = await requireDirector(ctx, token, "data.trigger");
    if (reason.trim().length < 4) throw new Error("A reason is required.");
    const config = await ctx.db.get(configId);
    if (!config) throw new Error("That vehicle config no longer exists.");
    // Cache rows are keyed by make/year (+ model). Bounded tightly: these
    // docs carry full page markdown (megabytes each) and one vehicle's cache
    // is a handful of rows across source types.
    const candidates = config.make_id
      ? await ctx.db
          .query("scrape_cache")
          .withIndex("by_make_year", (q) =>
            q.eq("make_id", config.make_id).eq("year", config.year),
          )
          .take(15)
      : [];
    let deleted = 0;
    for (const row of candidates) {
      if (row.model_id == null || String(row.model_id) === String(config.model_id)) {
        await ctx.db.delete(row._id);
        deleted++;
      }
    }
    await logAudit(ctx, actor, {
      entity_type: "vehicle_config",
      entity_id: String(configId),
      action: "cache_cleared",
      detail: `${deleted} scrape_cache rows deleted (re-scrapes cost real money) — ${reason.trim()}`,
    });
    return { ok: true, deleted };
  },
});
