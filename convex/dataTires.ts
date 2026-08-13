// =============================================================================
// Data portal · Tire Intelligence — /data/tires (Data spec §10.1).
// Brands (tier pills, Goodyear-Eagle-F1 caveat pinned) · Models & Pricing
// (fill % vs the 94% benchmark; prices are ceiling references) · Sizes
// (per-trim OEM sizes, staggered F/R, rim diameter only) · Quote Guardrails
// (ceiling breaches). NOTE: schema tier vocabulary is elite/select/standard/
// unlisted — the spec's "Mid-range" maps to `select`.
// Existing tireBrands.getAll / updateTier are ungated legacy — this module is
// the gated portal surface (legacy left untouched; flagged for hardening).
// =============================================================================
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireDirector, logAudit } from "./directorGate";

const DAY = 24 * 60 * 60 * 1000;

// --- Authored return types (see dataOverview.ts header) -----------------------

export type TireBrandRow = {
  id: string;
  brand: string;
  tier: "elite" | "select" | "standard" | "unlisted";
  parent_company: string | null;
  is_sub_brand: boolean;
  appearance_count: number | null;
  review_flagged: boolean;
};
export type BrandsResult = { rows: TireBrandRow[]; truncated: boolean };

export const listBrands = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<BrandsResult> => {
    await requireDirector(ctx, token);
    // 45 live production / 272 full set — 400 covers both.
    const rows = await ctx.db.query("tire_brands").take(400);
    return {
      rows: rows
        .map((r) => ({
          id: String(r._id),
          brand: r.brand,
          tier: r.tier,
          parent_company: r.parent_company ?? null,
          is_sub_brand: r.is_sub_brand === true,
          appearance_count: r.appearance_count ?? null,
          review_flagged: r.review_flagged === true,
        }))
        .sort((a, b) => a.brand.localeCompare(b.brand)),
      truncated: rows.length === 400,
    };
  },
});

export const updateBrandTier = mutation({
  args: {
    token: v.string(),
    reason: v.string(),
    brandId: v.id("tire_brands"),
    tier: v.union(
      v.literal("elite"),
      v.literal("select"),
      v.literal("standard"),
      v.literal("unlisted"),
    ),
  },
  handler: async (ctx, { token, reason, brandId, tier }): Promise<{ ok: true }> => {
    const actor = await requireDirector(ctx, token, "data.write");
    if (reason.trim().length < 4) throw new Error("A reason is required.");
    const brand = await ctx.db.get(brandId);
    if (!brand) throw new Error("That brand no longer exists.");
    if (brand.tier === tier) throw new Error(`${brand.brand} is already ${tier}.`);
    await ctx.db.patch(brandId, { tier });
    await logAudit(ctx, actor, {
      entity_type: "tire_brand",
      entity_id: String(brandId),
      action: "tier_changed",
      detail: `${brand.brand}: ${brand.tier} → ${tier} — ${reason.trim()}`,
    });
    return { ok: true };
  },
});

export type TireModelRow = {
  id: string;
  brand: string;
  model: string;
  size: string;
  tier: string | null;
  tire_type: string | null;
  prices: { source: string; price_per_tire: number; scraped_at: number; fresh: boolean }[];
};
export type ModelsResult = { rows: TireModelRow[]; truncated: boolean };

export const modelsBySizeOrBrand = query({
  args: { token: v.string(), size: v.optional(v.string()), brand: v.optional(v.string()) },
  handler: async (ctx, { token, size, brand }): Promise<ModelsResult> => {
    await requireDirector(ctx, token);
    const models = size
      ? await ctx.db
          .query("tire_models")
          .withIndex("by_size", (q) => q.eq("size", size.trim()))
          .take(100)
      : brand
        ? await ctx.db
            .query("tire_models")
            .withIndex("by_brand", (q) => q.eq("brand", brand.trim()))
            .take(100)
        : await ctx.db.query("tire_models").take(100);
    const now = Date.now();
    const rows: TireModelRow[] = [];
    for (const m of models) {
      const prices = await ctx.db
        .query("tire_pricing")
        .withIndex("by_tire_model", (q) => q.eq("tire_model_id", m._id))
        .take(10);
      rows.push({
        id: String(m._id),
        brand: m.brand,
        model: m.model,
        size: m.size,
        tier: m.tier ?? null,
        tire_type: m.tire_type ?? null,
        prices: prices.map((p) => ({
          source: p.source,
          price_per_tire: p.price_per_tire,
          scraped_at: p.scraped_at,
          fresh: now - p.scraped_at < 7 * DAY, // pricing TTL 7d
        })),
      });
    }
    return { rows, truncated: models.length === 100 };
  },
});

export type TrimSizeRow = {
  id: string;
  trim: string | null;
  config_key: string | null;
  size_front: string | null;
  size_rear: string | null;
  staggered: boolean;
  rim_diameter_in: number | null;
  options: number;
  source: string | null;
};
export type SizesHealthResult = {
  trims: TrimSizeRow[];
  trims_truncated: boolean;
  size_cache: { size: string; scraped_at: number; total_count: number }[];
};

export const sizesHealth = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<SizesHealthResult> => {
    await requireDirector(ctx, token);
    const specs = await ctx.db.query("trim_specs").take(500);
    const trimName = new Map<string, string | null>();
    const configKey = new Map<string, string | null>();
    const trims: TrimSizeRow[] = [];
    for (const s of specs) {
      const hasTireData =
        s.tire_size_front != null || (s.tire_options != null && s.tire_options.length > 0);
      if (!hasTireData) continue;
      let trim: string | null = null;
      if (s.trim_id) {
        const tid = String(s.trim_id);
        if (!trimName.has(tid)) {
          const t = await ctx.db.get(s.trim_id);
          trimName.set(tid, t ? ((t as { name?: string }).name ?? null) : null);
        }
        trim = trimName.get(tid) ?? null;
      }
      let cfg: string | null = null;
      if (s.vehicle_config_id) {
        const cid = String(s.vehicle_config_id);
        if (!configKey.has(cid)) {
          const c = await ctx.db.get(s.vehicle_config_id);
          configKey.set(cid, c?.config_key ?? null);
        }
        cfg = configKey.get(cid) ?? null;
      }
      const primaryOption = s.tire_options?.find((o) => o.is_oem_standard !== false) ?? s.tire_options?.[0];
      trims.push({
        id: String(s._id),
        trim,
        config_key: cfg,
        size_front: s.tire_size_front ?? primaryOption?.size_front ?? null,
        size_rear: s.tire_size_rear ?? primaryOption?.size_rear ?? null,
        staggered:
          s.is_staggered === true ||
          (primaryOption?.size_rear != null && primaryOption.size_rear !== primaryOption.size_front),
        rim_diameter_in: primaryOption?.rim_diameter_in ?? null,
        options: s.tire_options?.length ?? 0,
        source: s.tire_options_source ?? null,
      });
    }
    const cache = await ctx.db.query("tire_size_cache").take(200);
    return {
      trims,
      trims_truncated: specs.length === 500,
      size_cache: cache.map((c) => ({
        size: c.size,
        scraped_at: c.scraped_at,
        total_count: c.total_count,
      })),
    };
  },
});

export type GuardrailRow = {
  quote_id: string;
  booking_id: string;
  shop_id: string;
  tire_brand: string;
  tire_model: string | null;
  per_tire_price: number;
  quantity: number;
  size: string | null;
  ceiling: number | null;
  breach: boolean;
  at: number;
};
export type GuardrailsResult = { rows: GuardrailRow[]; window: number };

export const quoteGuardrails = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<GuardrailsResult> => {
    await requireDirector(ctx, token);
    // Recent 50 tire quotes; each resolves booking → vin → trim size →
    // scraped-market ceiling (max price over models in that size).
    const quotes = await ctx.db.query("tire_quote_responses").order("desc").take(50);
    const rows: GuardrailRow[] = [];
    for (const q of quotes) {
      let size: string | null = null;
      let ceiling: number | null = null;
      const booking = await ctx.db.get(q.booking_id);
      if (booking?.vin) {
        const veh = await ctx.db
          .query("vehicles")
          .withIndex("by_vin", (qq) => qq.eq("vin", booking.vin))
          .first();
        if (veh?.trim_id) {
          const spec = await ctx.db
            .query("trim_specs")
            .withIndex("by_trim", (qq) => qq.eq("trim_id", veh.trim_id))
            .first();
          size =
            spec?.tire_size_front ??
            spec?.tire_options?.find((o) => o.is_oem_standard !== false)?.size_front ??
            null;
        }
      }
      if (size) {
        const models = await ctx.db
          .query("tire_models")
          .withIndex("by_size", (qq) => qq.eq("size", size!))
          .take(50);
        for (const m of models) {
          const prices = await ctx.db
            .query("tire_pricing")
            .withIndex("by_tire_model", (qq) => qq.eq("tire_model_id", m._id))
            .take(10);
          for (const p of prices) ceiling = Math.max(ceiling ?? 0, p.price_per_tire);
        }
      }
      rows.push({
        quote_id: String(q._id),
        booking_id: String(q.booking_id),
        shop_id: String(q.shop_id),
        tire_brand: q.tire_brand,
        tire_model: q.tire_model ?? null,
        per_tire_price: q.per_tire_price,
        quantity: q.quantity,
        size,
        ceiling,
        breach: ceiling != null && q.per_tire_price > ceiling,
        at: q.created_at,
      });
    }
    return { rows, window: 50 };
  },
});
