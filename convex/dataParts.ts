// =============================================================================
// Data portal · Parts — /data/parts (Data spec §4B).
// List with hygiene filters (Unnamed / Unfitted orphans) · detail with the
// reverse-fitment blast-radius view ("correction touches N configs"), price
// summary (reuses part_prices.summarizePartPrices — the May 28 engine), and
// the job_actuals usage panel (Layer D price signal, honest window).
// =============================================================================
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { query } from "./_generated/server";
import { requireDirector } from "./directorGate";
import { summarizePartPrices, type PriceSummary } from "./part_prices";

// --- Authored return types (see dataOverview.ts header) -----------------------

export type PartListRow = {
  id: string;
  oem_part_number: string;
  name: string;
  category: string | null;
  subcategory: string | null;
  fitment_count: number;
  fitment_count_capped: boolean;
  unnamed: boolean;
  unfitted: boolean;
};

export const listParts = query({
  args: {
    token: v.string(),
    paginationOpts: paginationOptsValidator,
    category: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { token, paginationOpts, category },
  ): Promise<{ page: PartListRow[]; isDone: boolean; continueCursor: string }> => {
    await requireDirector(ctx, token);
    const page = category
      ? await ctx.db
          .query("oem_parts")
          .withIndex("by_category", (q) => q.eq("category", category))
          .paginate(paginationOpts)
      : await ctx.db.query("oem_parts").order("desc").paginate(paginationOpts);

    const rows: PartListRow[] = [];
    for (const p of page.page) {
      const fitments = await ctx.db
        .query("part_fitments")
        .withIndex("by_part", (q) => q.eq("part_id", p._id))
        .take(101);
      const unnamed =
        p.name.trim() === "" ||
        p.name.trim().toUpperCase() === p.oem_part_number.trim().toUpperCase();
      rows.push({
        id: String(p._id),
        oem_part_number: p.oem_part_number,
        name: p.name,
        category: p.category ?? null,
        subcategory: p.subcategory ?? null,
        fitment_count: Math.min(fitments.length, 100),
        fitment_count_capped: fitments.length > 100,
        unnamed,
        unfitted: fitments.length === 0,
      });
    }
    return { page: rows, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

export type OemLookupResult = { id: string; oem_part_number: string; name: string } | null;

export const oemLookup = query({
  args: { token: v.string(), oem: v.string() },
  handler: async (ctx, { token, oem }): Promise<OemLookupResult> => {
    await requireDirector(ctx, token);
    const normalized = oem.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!normalized) return null;
    const hit = await ctx.db
      .query("oem_parts")
      .withIndex("by_part_number_normalized", (q) =>
        q.eq("oem_part_number_normalized", normalized),
      )
      .first();
    const fallback =
      hit ??
      (await ctx.db
        .query("oem_parts")
        .withIndex("by_part_number", (q) => q.eq("oem_part_number", oem.trim()))
        .first());
    return fallback
      ? { id: String(fallback._id), oem_part_number: fallback.oem_part_number, name: fallback.name }
      : null;
  },
});

export type FitmentGroup = {
  make: string;
  configs: { id: string; config_key: string; service_type: string | null; quantity: number | null }[];
};
export type UsageBucket = { label: string; count: number };
export type PartDetailResult = {
  id: string;
  oem_part_number: string;
  name: string;
  brand: string | null;
  category: string | null;
  subcategory: string | null;
  part_tier: string | null;
  data_quality: string | null;
  supersedes: { number: string; id: string | null } | null;
  superseded_by: { number: string; id: string | null } | null;
  fitment_groups: FitmentGroup[];
  fitment_total: number;
  fitment_truncated: boolean;
  price_summary: PriceSummary;
  price_rows: {
    price: number;
    price_type: string | null;
    source_domain: string | null;
    refreshed_at: number | null;
  }[];
  usage: { jobs_matched: number; window: number; cost_histogram: UsageBucket[] };
} | null;

export const partDetail = query({
  args: { token: v.string(), partId: v.id("oem_parts") },
  handler: async (ctx, { token, partId }): Promise<PartDetailResult> => {
    await requireDirector(ctx, token);
    const part = await ctx.db.get(partId);
    if (!part) return null;

    // Supersession chain (numbers stored as strings; resolve to rows if present)
    const chainLookup = async (num: string | undefined) => {
      if (!num) return null;
      const row = await ctx.db
        .query("oem_parts")
        .withIndex("by_part_number", (q) => q.eq("oem_part_number", num))
        .first();
      return { number: num, id: row ? String(row._id) : null };
    };
    const supersedes = await chainLookup(part.supersedes);
    const supersededBy = await chainLookup(part.superseded_by);

    // Reverse fitments — the blast-radius view. Bounded at 300, grouped by make.
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_part", (q) => q.eq("part_id", partId))
      .take(300);
    const makeName = new Map<string, string>();
    const groups = new Map<string, FitmentGroup>();
    for (const f of fitments) {
      const config = await ctx.db.get(f.vehicle_config_id);
      if (!config) continue;
      const mid = String(config.make_id);
      if (!makeName.has(mid)) {
        const m = await ctx.db.get(config.make_id);
        makeName.set(mid, m ? ((m as { name?: string }).name ?? "Unknown make") : "Unknown make");
      }
      const make = makeName.get(mid)!;
      const g = groups.get(make) ?? { make, configs: [] };
      g.configs.push({
        id: String(config._id),
        config_key: config.config_key,
        service_type: f.service_type ?? null,
        quantity: f.quantity_needed ?? null,
      });
      groups.set(make, g);
    }

    // Price summary — the May 28 engine, reused verbatim.
    const priceSummary = await summarizePartPrices(ctx, partId);
    const priceRows = await ctx.db
      .query("part_prices")
      .withIndex("by_part", (q) => q.eq("part_id", partId))
      .collect();

    // Usage panel: job_actuals whose parts_used mention this OEM number —
    // last 200 jobs (no per-part job index; labeled window). Cost histogram
    // from matched entries (Layer D price signal).
    const WINDOW = 200;
    const jobs = await ctx.db
      .query("job_actuals")
      .withIndex("by_created_at")
      .order("desc")
      .take(WINDOW);
    const costs: number[] = [];
    let matched = 0;
    const target = part.oem_part_number.toUpperCase().replace(/[^A-Z0-9]/g, "");
    for (const j of jobs) {
      const partsUsed = (j as { parts_used?: unknown }).parts_used;
      if (!Array.isArray(partsUsed)) continue;
      let hit = false;
      for (const entry of partsUsed) {
        if (!entry || typeof entry !== "object") continue;
        const e = entry as { oem_part_number?: string; part_number?: string; cost?: number; price?: number };
        const num = (e.oem_part_number ?? e.part_number ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (num && num === target) {
          hit = true;
          const c = e.cost ?? e.price;
          if (typeof c === "number" && c > 0) costs.push(c);
        }
      }
      if (hit) matched++;
    }
    // 5-bucket histogram over matched costs.
    const histogram: UsageBucket[] = [];
    if (costs.length > 0) {
      const lo = Math.min(...costs);
      const hi = Math.max(...costs);
      const step = (hi - lo) / 5 || 1;
      for (let b = 0; b < 5; b++) {
        const from = lo + b * step;
        const to = b === 4 ? hi : lo + (b + 1) * step;
        histogram.push({
          label: `$${from.toFixed(0)}–$${to.toFixed(0)}`,
          count: costs.filter((c) => c >= from && (b === 4 ? c <= to : c < to)).length,
        });
      }
    }

    return {
      id: String(part._id),
      oem_part_number: part.oem_part_number,
      name: part.name,
      brand: part.brand ?? null,
      category: part.category ?? null,
      subcategory: part.subcategory ?? null,
      part_tier: part.part_tier ?? null,
      data_quality: part.data_quality ?? null,
      supersedes,
      superseded_by: supersededBy,
      fitment_groups: [...groups.values()].sort((a, b) => b.configs.length - a.configs.length),
      fitment_total: fitments.length,
      fitment_truncated: fitments.length === 300,
      price_summary: priceSummary,
      price_rows: priceRows.map((r) => ({
        price: r.price,
        price_type: r.price_type ?? null,
        source_domain: r.source_domain ?? null,
        refreshed_at: r.refreshed_at ?? null,
      })),
      usage: { jobs_matched: matched, window: WINDOW, cost_histogram: histogram },
    };
  },
});
