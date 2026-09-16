/**
 * shopServiceFixedPrices.ts — per-(shop, service, tier) price overrides.
 *
 * When a row exists for (shop_id, service_id, tier), the v2 quote engine
 * (`buildQuote()` in lib/quoteEngine.ts) short-circuits its labor+parts math
 * and returns the flat `price_cents` as both low and high. Tax and platform
 * fee are still computed on top by the booking flow.
 *
 * Mirrors the auth + audit-log pattern from `shopLaborRates.ts`. Server
 * rejects any write for a tier in shops.declined_tiers so the rate-card UI
 * and the offered-services UI can never disagree about a tier's status.
 */

import { v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { mutation, query, QueryCtx } from "./_generated/server";
import { VEHICLE_TIERS, VehicleTier } from "./lib/vehicleTiers";
import { detectTier, resolveVehicleConfigFromVin } from "./lib/quoteEngine";
import {
  MAX_SHOP_SERVICE_PRICE_CENTS,
  MIN_SHOP_SERVICE_PRICE_CENTS,
  normalizeShopServicePrice,
} from "./lib/shopServicePricing";

const EDITOR_ROLES = new Set(["owner", "shop_owner", "admin", "manager"]);

// Hard rails on the flat price: $1 — $100,000. Below $1 is almost certainly
// a unit confusion (dollars vs cents); above $100k is a typo.
const MIN_FIXED_PRICE_CENTS = MIN_SHOP_SERVICE_PRICE_CENTS;
const MAX_FIXED_PRICE_CENTS = MAX_SHOP_SERVICE_PRICE_CENTS;

const pricePairValidator = v.union(
  v.object({ low_cents: v.number(), high_cents: v.number() }),
  v.null(),
);

const tierPricePairsValidator = v.object({
  T1: v.optional(pricePairValidator),
  T2a: v.optional(pricePairValidator),
  T2b: v.optional(pricePairValidator),
  T2c: v.optional(pricePairValidator),
  T3a: v.optional(pricePairValidator),
  T3b: v.optional(pricePairValidator),
  T4: v.optional(pricePairValidator),
});

async function requireShopEditor(
  ctx: { auth: QueryCtx["auth"]; db: QueryCtx["db"] },
  shop: Doc<"shops">,
): Promise<{ userId: Id<"users">; actor: string }> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");

  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject))
    .unique();
  if (!user) throw new Error("User not found");

  if (shop.owner_user_id === user._id) {
    return { userId: user._id, actor: identity.email ?? identity.subject };
  }

  const membership = await ctx.db
    .query("shop_users")
    .withIndex("by_user_and_shop", (q) =>
      q.eq("user_id", user._id).eq("shop_id", shop._id),
    )
    .first();

  if (membership && membership.is_active && EDITOR_ROLES.has(membership.role)) {
    return { userId: user._id, actor: identity.email ?? identity.subject };
  }

  throw new Error("Not authorized to edit this shop's pricing");
}

// ──────────────────────────────────────────────────────────────────────────
// QUERY — full per-shop map for the Offered Services UI and engine lookup.
// Returns: { [service_id]: { T1?: cents, T2a?: cents, ... } }
// ──────────────────────────────────────────────────────────────────────────

export const listForShop = query({
  args: { shop_id: v.id("shops") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("shop_service_fixed_prices")
      .withIndex("by_shop", (q) => q.eq("shop_id", args.shop_id))
      .collect();

    const byService: Record<string, Partial<Record<VehicleTier, number>>> = {};
    for (const row of rows) {
      const key = String(row.service_id);
      if (!byService[key]) byService[key] = {};
      const price = normalizeShopServicePrice(row);
      if (price?.isFixed) {
        byService[key][row.tier as VehicleTier] = price.lowCents;
      }
    }
    return byService;
  },
});

/** Full normalized pricing for the Offered Services settings editor. */
export const listPricingForShop = query({
  args: { shop_id: v.id("shops") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("shop_service_fixed_prices")
      .withIndex("by_shop", (q) => q.eq("shop_id", args.shop_id))
      .collect();

    const byService: Record<
      string,
      {
        mode: "fixed" | "range";
        prices: Partial<
          Record<VehicleTier, { low_cents: number; high_cents: number }>
        >;
      }
    > = {};

    for (const row of rows) {
      const price = normalizeShopServicePrice(row);
      if (!price) continue;
      const key = String(row.service_id);
      const isRangeRow =
        row.price_low_cents !== undefined && row.price_high_cents !== undefined;
      if (!byService[key]) {
        byService[key] = { mode: isRangeRow ? "range" : "fixed", prices: {} };
      } else if (isRangeRow) {
        byService[key].mode = "range";
      }
      byService[key].prices[row.tier as VehicleTier] = {
        low_cents: price.lowCents,
        high_cents: price.highCents,
      };
    }

    return byService;
  },
});

// ──────────────────────────────────────────────────────────────────────────
// MUTATION — set/clear flat prices for one service across the 7 tiers.
// `prices` is the full picture for that service: tier → cents, or null to
// clear. Tiers omitted from the map are left untouched (so the caller can
// patch just the cells they changed without overwriting siblings).
// ──────────────────────────────────────────────────────────────────────────

export const setFixedPricesForService = mutation({
  args: {
    shop_id: v.id("shops"),
    service_id: v.id("services"),
    prices: v.object({
      T1:  v.optional(v.union(v.number(), v.null())),
      T2a: v.optional(v.union(v.number(), v.null())),
      T2b: v.optional(v.union(v.number(), v.null())),
      T2c: v.optional(v.union(v.number(), v.null())),
      T3a: v.optional(v.union(v.number(), v.null())),
      T3b: v.optional(v.union(v.number(), v.null())),
      T4:  v.optional(v.union(v.number(), v.null())),
    }),
  },
  handler: async (ctx, args) => {
    const shop = await ctx.db.get(args.shop_id);
    if (!shop) throw new Error("Shop not found: " + args.shop_id);

    const { userId, actor } = await requireShopEditor(ctx, shop);

    const service = await ctx.db.get(args.service_id);
    if (!service) throw new Error("Service not found: " + args.service_id);

    const declined = new Set<string>(shop.declined_tiers ?? []);
    const now = Date.now();
    const applied: { tier: VehicleTier; price_cents: number | null }[] = [];

    for (const tier of VEHICLE_TIERS) {
      const raw = (args.prices as Record<string, number | null | undefined>)[tier];
      if (raw === undefined) continue; // not in patch — leave existing row alone

      if (raw !== null && declined.has(tier)) {
        throw new Error(
          `Tier ${tier} is declined on this shop's rate card — restore it before setting a fixed price.`,
        );
      }

      const existing = await ctx.db
        .query("shop_service_fixed_prices")
        .withIndex("by_shop_service_tier", (q) =>
          q
            .eq("shop_id", args.shop_id)
            .eq("service_id", args.service_id)
            .eq("tier", tier),
        )
        .unique();

      if (raw === null) {
        // Clear the cell.
        if (existing) await ctx.db.delete(existing._id);
        applied.push({ tier, price_cents: null });
        continue;
      }

      const cents = Math.round(raw);
      if (cents < MIN_FIXED_PRICE_CENTS || cents > MAX_FIXED_PRICE_CENTS) {
        throw new Error(
          `Tier ${tier} fixed price $${(cents / 100).toFixed(2)} is outside the allowed range ($${MIN_FIXED_PRICE_CENTS / 100}–$${MAX_FIXED_PRICE_CENTS / 100}). Check for a typo.`,
        );
      }

      if (existing) {
        await ctx.db.patch(existing._id, {
          price_cents: cents,
          price_low_cents: undefined,
          price_high_cents: undefined,
          updated_at: now,
          updated_by_user_id: userId,
        });
      } else {
        await ctx.db.insert("shop_service_fixed_prices", {
          shop_id: args.shop_id,
          service_id: args.service_id,
          tier,
          price_cents: cents,
          updated_at: now,
          updated_by_user_id: userId,
        });
      }
      applied.push({ tier, price_cents: cents });
    }

    if (applied.length > 0) {
      await ctx.db.insert("audit_log", {
        entity_type: "shops",
        entity_id: args.shop_id,
        action: "shop_service_fixed_prices_set",
        actor,
        detail: JSON.stringify({
          service_id: args.service_id,
          service_slug: service.slug ?? null,
          applied,
        }),
        created_at: now,
      });
    }

    return { ok: true as const, applied };
  },
});

/**
 * Replaces one service's complete pricing snapshot. Saving a mode clears the
 * inactive persisted fields; unsaved client drafts remain a UI concern.
 */
export const replacePricingForService = mutation({
  args: {
    shop_id: v.id("shops"),
    service_id: v.id("services"),
    mode: v.union(v.literal("fixed"), v.literal("range")),
    prices: tierPricePairsValidator,
  },
  handler: async (ctx, args) => {
    const shop = await ctx.db.get(args.shop_id);
    if (!shop) throw new Error("Shop not found: " + args.shop_id);
    const { userId, actor } = await requireShopEditor(ctx, shop);

    const service = await ctx.db.get(args.service_id);
    if (!service) throw new Error("Service not found: " + args.service_id);

    const declined = new Set<string>(shop.declined_tiers ?? []);
    const normalized: {
      tier: VehicleTier;
      low_cents: number;
      high_cents: number;
    }[] = [];

    for (const tier of VEHICLE_TIERS) {
      const pair = (
        args.prices as Record<
          string,
          { low_cents: number; high_cents: number } | null | undefined
        >
      )[tier];
      if (pair == null) continue;
      if (declined.has(tier)) {
        throw new Error(
          `Tier ${tier} is declined on this shop's rate card — restore it before setting a price.`,
        );
      }

      const low = Math.round(pair.low_cents);
      const high = Math.round(pair.high_cents);
      if (
        low < MIN_FIXED_PRICE_CENTS ||
        high > MAX_FIXED_PRICE_CENTS ||
        low > high
      ) {
        throw new Error(
          `Tier ${tier} requires prices from $${MIN_FIXED_PRICE_CENTS / 100} to $${MAX_FIXED_PRICE_CENTS / 100}, with minimum no greater than maximum.`,
        );
      }
      if (args.mode === "fixed" && low !== high) {
        throw new Error(`Tier ${tier} fixed pricing requires one price.`);
      }
      normalized.push({ tier, low_cents: low, high_cents: high });
    }

    const existing = await ctx.db
      .query("shop_service_fixed_prices")
      .withIndex("by_shop_service", (q) =>
        q.eq("shop_id", args.shop_id).eq("service_id", args.service_id),
      )
      .collect();
    for (const row of existing) await ctx.db.delete(row._id);

    const now = Date.now();
    for (const price of normalized) {
      await ctx.db.insert("shop_service_fixed_prices", {
        shop_id: args.shop_id,
        service_id: args.service_id,
        tier: price.tier,
        ...(args.mode === "fixed"
          ? { price_cents: price.low_cents }
          : {
              price_low_cents: price.low_cents,
              price_high_cents: price.high_cents,
            }),
        updated_at: now,
        updated_by_user_id: userId,
      });
    }

    await ctx.db.insert("audit_log", {
      entity_type: "shops",
      entity_id: args.shop_id,
      action: "shop_service_pricing_replaced",
      actor,
      detail: JSON.stringify({
        service_id: args.service_id,
        service_slug: service.slug ?? null,
        mode: args.mode,
        prices: normalized,
      }),
      created_at: now,
    });

    return { ok: true as const, mode: args.mode, prices: normalized };
  },
});

// ──────────────────────────────────────────────────────────────────────────
// QUERY — booking-flow lookup. Resolves the vehicle's tier server-side via
// vehicle_owner → vin → vehicles → vehicle_configs, then returns flat prices
// for the requested services. Mirrors the tier-resolution step inside
// computeDisclosedRange (booking_quotes.ts) so the customer sees the same
// override the booking-create call will honor.
//
// Returns: { [service_id]: price_cents } — hits only. Misses are absent so
// callers can use `serviceIds.filter(id => id in result)` as the truth set.
// ──────────────────────────────────────────────────────────────────────────

export const getForBooking = query({
  args: {
    shop_id: v.id("shops"),
    vehicle_owner_id: v.id("vehicle_owners"),
    service_ids: v.array(v.id("services")),
  },
  handler: async (ctx, args) => {
    const owner = await ctx.db.get(args.vehicle_owner_id);
    if (!owner) return {} as Record<string, number>;

    const cfg = await resolveVehicleConfigFromVin(ctx, owner.vin);
    if (!cfg) return {} as Record<string, number>;

    const tier =
      (cfg.pricing_tier as VehicleTier | undefined) ??
      (await detectTier(ctx, cfg));
    if (!tier) return {} as Record<string, number>;

    const result: Record<string, number> = {};
    for (const service_id of args.service_ids) {
      const row = await ctx.db
        .query("shop_service_fixed_prices")
        .withIndex("by_shop_service_tier", (q) =>
          q
            .eq("shop_id", args.shop_id)
            .eq("service_id", service_id)
            .eq("tier", tier),
        )
        .unique();
      const price = normalizeShopServicePrice(row);
      if (price?.isFixed) result[String(service_id)] = price.lowCents;
    }
    return result;
  },
});

/** Normalized booking lookup used by range-aware clients. */
export const getPricingForBooking = query({
  args: {
    shop_id: v.id("shops"),
    vehicle_owner_id: v.id("vehicle_owners"),
    service_ids: v.array(v.id("services")),
  },
  handler: async (ctx, args) => {
    const owner = await ctx.db.get(args.vehicle_owner_id);
    if (!owner) return {};

    const cfg = await resolveVehicleConfigFromVin(ctx, owner.vin);
    if (!cfg) return {};
    const tier =
      (cfg.pricing_tier as VehicleTier | undefined) ??
      (await detectTier(ctx, cfg));
    if (!tier) return {};

    const result: Record<
      string,
      { low_cents: number; high_cents: number; is_fixed: boolean }
    > = {};
    for (const service_id of args.service_ids) {
      const row = await ctx.db
        .query("shop_service_fixed_prices")
        .withIndex("by_shop_service_tier", (q) =>
          q
            .eq("shop_id", args.shop_id)
            .eq("service_id", service_id)
            .eq("tier", tier),
        )
        .unique();
      const price = normalizeShopServicePrice(row);
      if (price) {
        result[String(service_id)] = {
          low_cents: price.lowCents,
          high_cents: price.highCents,
          is_fixed: price.isFixed,
        };
      }
    }
    return result;
  },
});
