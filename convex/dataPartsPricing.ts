// =============================================================================
// Data portal · Parts Pricing Engine — /data/parts-pricing (Data spec §9.2).
// The May 28 engine made visible: per-part price strip (median + MAD outlier
// rejection via part_prices.summarizePriceRows), the locked range rules
// (multi-source → 5–8% cap · single → ±8% · zero → Camry×multiplier fallback),
// the extraction-pathology queue (POISON price_types from lib/priceTypes),
// and the Estimator endpoint validation runs (Jun 18 next-step) read-only.
// =============================================================================
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { mutation, query } from "./_generated/server";
import { requireDirector, logAudit } from "./directorGate";
import { summarizePriceRows, type PriceSummary } from "./part_prices";
import { isPoisonPriceType, isNonPooledPriceType } from "./lib/priceTypes";
import { listRecentEstimates } from "./lib/estimatorEstimates";

// --- Range rule (May 28, locked) ----------------------------------------------
// multi-source: natural kept spread stands when ≤8%; wider clamps to median±4%
// (25% spreads are dead). single source: ±8%. zero sources: fallback badge.
export function computeRange(summary: PriceSummary): {
  range: { low: number; high: number } | null;
  rule: string;
} {
  if (summary.used_sample_size === 0) {
    return { range: null, rule: "zero sources → Camry × multiplier (INTERNAL FALLBACK)" };
  }
  if (summary.used_sample_size === 1) {
    const p = summary.min_kept;
    return {
      range: { low: p * 0.92, high: p * 1.08 },
      rule: "single source → ±8%",
    };
  }
  const spreadPct =
    summary.min_kept > 0 ? (summary.max_kept - summary.min_kept) / summary.min_kept : 0;
  if (spreadPct <= 0.08) {
    return {
      range: { low: summary.min_kept, high: summary.max_kept },
      rule: `multi-source → natural spread ${(spreadPct * 100).toFixed(1)}% (within the 5–8% cap)`,
    };
  }
  const m = summary.median;
  return {
    range: { low: m * 0.96, high: m * 1.04 },
    rule: `multi-source → spread ${(spreadPct * 100).toFixed(0)}% clamped to 8% around the median (25% spreads are dead — May 28)`,
  };
}

// --- Authored return types (see dataOverview.ts header) -----------------------

export type PricedPartRow = {
  part_id: string;
  oem_part_number: string;
  name: string;
  subcategory: string | null;
  latest_price: number;
  latest_source: string | null;
  refreshed_at: number | null;
};

export const pricedPartsWindow = query({
  args: { token: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (
    ctx,
    { token, paginationOpts },
  ): Promise<{ page: PricedPartRow[]; isDone: boolean; continueCursor: string }> => {
    await requireDirector(ctx, token);
    // Entry list = recently priced rows, deduped per part within the page.
    const page = await ctx.db.query("part_prices").order("desc").paginate(paginationOpts);
    const seen = new Set<string>();
    const partCache = new Map<
      string,
      { oem_part_number: string; name: string; subcategory: string | null } | null
    >();
    const rows: PricedPartRow[] = [];
    for (const r of page.page) {
      const pid = String(r.part_id);
      if (seen.has(pid)) continue;
      seen.add(pid);
      if (!partCache.has(pid)) {
        const p = await ctx.db.get(r.part_id);
        partCache.set(
          pid,
          p
            ? { oem_part_number: p.oem_part_number, name: p.name, subcategory: p.subcategory ?? null }
            : null,
        );
      }
      const part = partCache.get(pid);
      if (!part) continue;
      rows.push({
        part_id: pid,
        oem_part_number: part.oem_part_number,
        name: part.name,
        subcategory: part.subcategory,
        latest_price: r.price,
        latest_source: r.source_domain ?? null,
        refreshed_at: r.refreshed_at ?? null,
      });
    }
    return { page: rows, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

export type StripPoint = {
  row_id: string;
  price: number;
  price_type: string | null;
  source_domain: string | null;
  source_url: string | null;
  refreshed_at: number | null;
  kept: boolean;
  poison: boolean;
  non_pooled: boolean;
};
export type PriceStripResult = {
  part: { id: string; oem_part_number: string; name: string; subcategory: string | null };
  points: StripPoint[];
  summary: PriceSummary;
  range: { low: number; high: number } | null;
  range_rule: string;
} | null;

export const priceStrip = query({
  args: { token: v.string(), partId: v.id("oem_parts") },
  handler: async (ctx, { token, partId }): Promise<PriceStripResult> => {
    await requireDirector(ctx, token);
    const part = await ctx.db.get(partId);
    if (!part) return null;
    const rows = await ctx.db
      .query("part_prices")
      .withIndex("by_part", (q) => q.eq("part_id", partId))
      .collect();
    const summary = summarizePriceRows(partId, rows, { subcategory: part.subcategory ?? null });
    // kept = the row's price point survived into sources_used (multiset match
    // on price+domain — exact enough for display).
    const keptPool = summary.sources_used.map((s) => `${s.price}|${s.source_domain ?? ""}`);
    const points: StripPoint[] = rows.map((r) => {
      const key = `${r.price}|${r.source_domain ?? ""}`;
      const idx = keptPool.indexOf(key);
      const kept = idx >= 0;
      if (kept) keptPool.splice(idx, 1);
      return {
        row_id: String(r._id),
        price: r.price,
        price_type: r.price_type ?? null,
        source_domain: r.source_domain ?? null,
        source_url: r.source_url ?? null,
        refreshed_at: r.refreshed_at ?? null,
        kept,
        poison: isPoisonPriceType(r.price_type),
        non_pooled: isNonPooledPriceType(r.price_type),
      };
    });
    const { range, rule } = computeRange(summary);
    return {
      part: {
        id: String(part._id),
        oem_part_number: part.oem_part_number,
        name: part.name,
        subcategory: part.subcategory ?? null,
      },
      points,
      summary,
      range,
      range_rule: rule,
    };
  },
});

export type PathologyRow = {
  row_id: string;
  part_id: string;
  oem_part_number: string | null;
  part_name: string | null;
  price: number;
  price_type: string;
  msrp: number | null;
  discount: number | null;
  source_domain: string | null;
  source_url: string | null;
  refreshed_at: number | null;
};
export type PathologyQueueResult = { rows: PathologyRow[]; scanned: number; truncated: boolean };

export const pathologyQueue = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<PathologyQueueResult> => {
    await requireDirector(ctx, token);
    // 444 rows measured — a bounded sweep with an honest truncation flag.
    const rows = await ctx.db.query("part_prices").order("desc").take(500);
    const partCache = new Map<string, { num: string; name: string } | null>();
    const out: PathologyRow[] = [];
    for (const r of rows) {
      if (!isPoisonPriceType(r.price_type)) continue;
      const pid = String(r.part_id);
      if (!partCache.has(pid)) {
        const p = await ctx.db.get(r.part_id);
        partCache.set(pid, p ? { num: p.oem_part_number, name: p.name } : null);
      }
      const part = partCache.get(pid);
      out.push({
        row_id: String(r._id),
        part_id: pid,
        oem_part_number: part?.num ?? null,
        part_name: part?.name ?? null,
        price: r.price,
        price_type: r.price_type!,
        msrp: r.msrp ?? null,
        discount: r.discount ?? null,
        source_domain: r.source_domain ?? null,
        source_url: r.source_url ?? null,
        refreshed_at: r.refreshed_at ?? null,
      });
    }
    return { rows: out, scanned: rows.length, truncated: rows.length === 500 };
  },
});

export const resolvePathology = mutation({
  args: {
    token: v.string(),
    reason: v.string(),
    priceRowId: v.id("part_prices"),
    verdict: v.union(v.literal("pathology"), v.literal("legit")),
  },
  handler: async (ctx, { token, reason, priceRowId, verdict }): Promise<{ ok: true }> => {
    const actor = await requireDirector(ctx, token, "data.write");
    if (reason.trim().length < 4) throw new Error("A reason is required.");
    const row = await ctx.db.get(priceRowId);
    if (!row) throw new Error("That price row no longer exists.");
    const before = row.price_type ?? "(untyped)";
    if (verdict === "pathology") {
      // Confirmed bad capture: stamp unverified — stays excluded, kept for audit.
      await ctx.db.patch(priceRowId, { price_type: "unverified" });
    } else {
      // Human-verified legit: enters the pooled aggregate as a sale price.
      await ctx.db.patch(priceRowId, { price_type: "sale" });
    }
    await logAudit(ctx, actor, {
      entity_type: "part_price",
      entity_id: String(priceRowId),
      action: verdict === "pathology" ? "pathology_confirmed" : "pathology_cleared",
      detail: `price_type ${before} → ${verdict === "pathology" ? "unverified" : "sale"} ($${row.price}) — ${reason.trim()}`,
    });
    return { ok: true };
  },
});

export type ValidationRunRow = {
  id: string;
  config_key: string | null;
  service: string | null;
  labor_hours: number | null;
  labor_band: { low: number; high: number } | null;
  parts_count: number;
  match_quality: string | null;
  fetched_at: number;
};

export const endpointValidationRuns = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<ValidationRunRow[]> => {
    await requireDirector(ctx, token);
    const rows = await listRecentEstimates(ctx, 50);
    const configKey = new Map<string, string | null>();
    const serviceName = new Map<string, string | null>();
    const out: ValidationRunRow[] = [];
    for (const r of rows) {
      const cid = String(r.vehicle_config_id);
      if (!configKey.has(cid)) {
        const c = await ctx.db.get(r.vehicle_config_id);
        configKey.set(cid, c?.config_key ?? null);
      }
      const sid = String(r.service_id);
      if (!serviceName.has(sid)) {
        const s = await ctx.db.get(r.service_id);
        serviceName.set(sid, s ? ((s as { name?: string }).name ?? null) : null);
      }
      out.push({
        id: String(r._id),
        config_key: configKey.get(cid) ?? null,
        service: serviceName.get(sid) ?? null,
        labor_hours: r.labor_hours ?? null,
        labor_band:
          r.labor_low != null && r.labor_high != null
            ? { low: r.labor_low, high: r.labor_high }
            : null,
        parts_count: r.parts?.length ?? 0,
        match_quality: r.match_quality ?? null,
        fetched_at: r.fetched_at,
      });
    }
    return out;
  },
});
