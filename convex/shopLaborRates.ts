/**
 * shopLaborRates.ts — per-shop, per-vehicle-tier labor rates.
 *
 * Adapted from Yassin Wahman's `Shop Labor Rates from Yassin Wahman.ts`
 * contribution. Logic preserved (fallback chain, soft/hard rate validation,
 * self-classifying profile); auth + audit_log shape adjusted to match the
 * conventions used in the rest of the codebase.
 *
 * Tier vocabulary, bands, hard rails, resolver, and classifier live in
 * `./lib/vehicleTiers` — single source of truth for the 7-tier system.
 *
 * Notes:
 *   - Rates are stored in DOLLARS (matches legacy `shops.labor_rate`).
 *   - `audit_log.actor_id` is `v.id("director_users")` per schema, so we
 *     omit it for shop-side mutations and carry the actor identity in the
 *     `actor` string field instead.
 *   - The quote engine is NOT yet wired to use `resolveLaborRate()`; that's
 *     a follow-up PR. This file only exposes the read/write surface and the
 *     pure helper for testing.
 */

import { v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { mutation, query, QueryCtx } from "./_generated/server";
import {
  ABSOLUTE_MAX_RATE,
  ABSOLUTE_MIN_RATE,
  classifyShop,
  TIER_BANDS,
  tierValidator,
  VEHICLE_TIERS,
  VehicleTier,
} from "./lib/vehicleTiers";

// Roles allowed to edit per-tier labor rates. Mirrors OWNER_ROLES in
// shops.ts (line 14) plus "manager" per Yassin's intent.
const EDITOR_ROLES = new Set(["owner", "shop_owner", "admin", "manager"]);

// ──────────────────────────────────────────────────────────────────────────
// Auth helper — resolves the calling user and verifies they can edit a shop.
// ──────────────────────────────────────────────────────────────────────────

async function requireShopEditor(
  ctx: { auth: QueryCtx["auth"]; db: QueryCtx["db"] },
  shop: Doc<"shops">,
): Promise<{ userId: Id<"users">; actor: string; role: string }> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");

  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject))
    .unique();
  if (!user) throw new Error("User not found");

  // Path 1: row-level owner field on the shop.
  if (shop.owner_user_id === user._id) {
    return {
      userId: user._id,
      actor: identity.email ?? identity.subject,
      role: "shop_owner",
    };
  }

  // Path 2: shop_users membership (covers managers + invited co-owners).
  const membership = await ctx.db
    .query("shop_users")
    .withIndex("by_user_and_shop", (q) =>
      q.eq("user_id", user._id).eq("shop_id", shop._id),
    )
    .first();

  if (
    membership &&
    membership.is_active &&
    EDITOR_ROLES.has(membership.role)
  ) {
    return {
      userId: user._id,
      actor: identity.email ?? identity.subject,
      role: membership.role,
    };
  }

  throw new Error("Not authorized to edit this shop's rates");
}

// ──────────────────────────────────────────────────────────────────────────
// MUTATION — write the full per-tier rate map + declines in one call.
// Idempotent; last-write-wins. UI sends the complete picture each save so
// partial-update drift is impossible.
// ──────────────────────────────────────────────────────────────────────────

export const setLaborRatesByTier = mutation({
  args: {
    shop_id: v.id("shops"),
    // Only include tiers the shop is PRICING. Omit declined/unset tiers.
    rates: v.object({
      T1:  v.optional(v.number()),
      T2a: v.optional(v.number()),
      T2b: v.optional(v.number()),
      T2c: v.optional(v.number()),
      T3a: v.optional(v.number()),
      T3b: v.optional(v.number()),
      T4:  v.optional(v.number()),
    }),
    declined_tiers: v.array(tierValidator),
  },
  handler: async (ctx, args) => {
    const shop = await ctx.db.get(args.shop_id);
    if (!shop) throw new Error("Shop not found: " + args.shop_id);

    const { actor } = await requireShopEditor(ctx, shop);

    const declinedSet = new Set<VehicleTier>(args.declined_tiers);
    const cleanRates: Partial<Record<VehicleTier, number>> = {};
    const warnings: { tier: VehicleTier; kind: string; message: string }[] = [];

    for (const tier of VEHICLE_TIERS) {
      const raw = (args.rates as Record<string, number | undefined>)[tier];
      const isDeclined = declinedSet.has(tier);

      // Rule 1: a tier cannot be both priced and declined.
      if (raw !== undefined && isDeclined) {
        throw new Error(
          `Tier ${tier} is both priced and declined — send a rate OR decline it, not both.`,
        );
      }

      if (raw === undefined) continue; // unset or declined → nothing to store

      const rate = Math.round(raw);

      // Rule 2: hard rails (reject typos).
      if (rate < ABSOLUTE_MIN_RATE || rate > ABSOLUTE_MAX_RATE) {
        throw new Error(
          `Tier ${tier} rate $${rate}/hr is outside the allowed range ($${ABSOLUTE_MIN_RATE}–$${ABSOLUTE_MAX_RATE}). Check for a typo.`,
        );
      }

      // Rule 3: soft band check (warn, never block).
      const band = TIER_BANDS[tier];
      if (rate < band.lo) {
        warnings.push({
          tier,
          kind: "below_band",
          message: `${tier} ${band.label}: $${rate}/hr is below the typical NYC range ($${band.lo}–$${band.hi}). Allowed, but flagged for quality review.`,
        });
      } else if (rate > band.hi) {
        warnings.push({
          tier,
          kind: "above_band",
          message: `${tier} ${band.label}: $${rate}/hr is above the typical NYC range ($${band.lo}–$${band.hi}).`,
        });
      }

      cleanRates[tier] = rate;
    }

    const now = Date.now();

    await ctx.db.patch(args.shop_id, {
      labor_rates_by_tier: cleanRates,
      declined_tiers: args.declined_tiers,
      labor_rates_updated_at: now,
    });

    await ctx.db.insert("audit_log", {
      entity_type: "shops",
      entity_id: args.shop_id,
      action: "labor_rates_by_tier_set",
      actor,
      detail: JSON.stringify({
        priced: cleanRates,
        declined: args.declined_tiers,
        warnings: warnings.map((w) => w.kind + ":" + w.tier),
      }),
      created_at: now,
    });

    const profile = classifyShop(cleanRates, declinedSet);

    return {
      ok: true as const,
      priced_tiers: Object.keys(cleanRates) as VehicleTier[],
      declined_tiers: args.declined_tiers,
      warnings,
      profile,
    };
  },
});

// ──────────────────────────────────────────────────────────────────────────
// QUERY — full per-shop tier picture for the settings UI.
// ──────────────────────────────────────────────────────────────────────────

export const getLaborRatesByTier = query({
  args: { shop_id: v.id("shops") },
  handler: async (ctx, args) => {
    const shop = await ctx.db.get(args.shop_id);
    if (!shop) throw new Error("Shop not found");

    const rates = (shop.labor_rates_by_tier ?? {}) as Partial<
      Record<VehicleTier, number>
    >;
    const declined = new Set<string>(shop.declined_tiers ?? []);
    const legacy = shop.labor_rate ?? null;

    const tiers = VEHICLE_TIERS.map((tier) => {
      const band = TIER_BANDS[tier];
      let state: "priced" | "declined" | "unset";
      let rate: number | null = null;
      if (declined.has(tier)) {
        state = "declined";
      } else if (rates[tier] != null) {
        state = "priced";
        rate = rates[tier] as number;
      } else {
        state = "unset";
      }
      return {
        tier,
        label: band.label,
        state,
        rate,
        band,
        in_band: rate === null ? null : rate >= band.lo && rate <= band.hi,
      };
    });

    return {
      tiers,
      legacy_labor_rate: legacy,
      updated_at: shop.labor_rates_updated_at ?? null,
      profile: classifyShop(rates, declined),
    };
  },
});
