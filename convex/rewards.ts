/**
 * rewards.ts - OTOPAIR Rewards Program
 *
 * PURPOSE: Ownership Credit balance, deals, redemptions, contribution claims.
 * Per OTOPAIR Rewards Framework V2: credits are dollar-based, per-user.
 *
 * USAGE:
 *   - api.rewards.getWallet(userId)
 *   - api.rewards.getSuggestedDeals()
 *   - api.rewards.getAllDeals()
 *   - api.rewards.updateRedemptionPreference({ userId, autoApply })
 *   - api.rewards.redeemSelected({ userId, option })
 *   - api.rewards.getCreditHistory(userId)
 */

import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";

// ============================================================================
// QUERIES
// ============================================================================

/**
 * Get wallet for user (balance + auto_apply setting).
 * Creates wallet if missing.
 */
export const getWallet = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const wallet = await ctx.db
      .query("user_reward_wallets")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .unique();

    return wallet;
  },
});

/**
 * Get suggested deals (first 5 by display_order).
 */
export const getSuggestedDeals = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 5;
    return await ctx.db.query("reward_deals").withIndex("by_display_order").order("asc").take(limit);
  },
});

/**
 * Get all deals (for "View all" page).
 */
export const getAllDeals = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("reward_deals").withIndex("by_display_order").order("asc").collect();
  },
});

/**
 * Get credit transaction history for user.
 */
export const getCreditHistory = query({
  args: {
    userId: v.id("users"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;
    return await ctx.db
      .query("ownership_credit_transactions")
      .withIndex("by_user_id_created_at", (q) => q.eq("user_id", args.userId))
      .order("desc")
      .take(limit);
  },
});

/**
 * Get user stats for membership page (miles safe, services, shops).
 * miles_safe = current odometer − initial odometer at registration (from user_reward_wallets); services/shops from bookings.
 */
export const getMembershipStats = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const wallet = await ctx.db
      .query("user_reward_wallets")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .unique();

    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .collect();

    const completed = bookings.filter((b) => b.status === "completed");
    const uniqueShops = new Set(completed.map((b) => b.shop_id.toString()));
    const servicesCount = completed.length;

    return {
      milesSafe: wallet?.miles_safe ?? 0,
      services: servicesCount,
      shops: uniqueShops.size,
    };
  },
});

/**
 * Get per-vehicle stats for membership page (individual view).
 * Credit earned = sum of earn_service transactions from bookings for this vin.
 * Services = count of completed bookings for this vin.
 * Shops = unique shops from those bookings.
 * Miles safe = pooled miles_safe split proportionally by services ratio (MVP).
 */
export const getMembershipStatsByVehicle = query({
  args: { userId: v.id("users"), vin: v.string() },
  handler: async (ctx, args) => {
    const completedBookings = await ctx.db
      .query("bookings")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .filter((q) => q.and(q.eq(q.field("vin"), args.vin), q.eq(q.field("status"), "completed")))
      .collect();

    const servicesCount = completedBookings.length;
    const uniqueShops = new Set(completedBookings.map((b) => b.shop_id.toString()));
    const bookingIds = new Set(completedBookings.map((b) => b._id.toString()));

    let creditEarned = 0;
    const transactions = await ctx.db
      .query("ownership_credit_transactions")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .filter((q) => q.eq(q.field("type"), "earn_service"))
      .collect();
    for (const tx of transactions) {
      if (tx.reference_id && tx.amount > 0 && bookingIds.has(tx.reference_id)) {
        creditEarned += tx.amount;
      }
    }

    const wallet = await ctx.db
      .query("user_reward_wallets")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .unique();
    const pooledMilesSafe = wallet?.miles_safe ?? 0;
    const totalServices = await ctx.db
      .query("bookings")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .filter((q) => q.eq(q.field("status"), "completed"))
      .collect();
    const totalCount = totalServices.length;
    const milesSafe = totalCount > 0 ? Math.round((pooledMilesSafe * servicesCount) / totalCount) : 0;

    return {
      creditEarned,
      milesSafe,
      services: servicesCount,
      shops: uniqueShops.size,
    };
  },
});

/**
 * Get tier for each vehicle owned by user (for My Garage / car selection with status badges).
 */
export const getVehicleTiersByUser = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const ownerships = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_user_status", (q) => q.eq("user_id", args.userId).eq("status", "active"))
      .collect();

    const result: { vin: string; tier: "driver" | "preferred" | "elite" }[] = [];
    for (const o of ownerships) {
      const vt = await ctx.db
        .query("vehicle_tiers")
        .withIndex("by_vin_user", (q) => q.eq("vin", o.vin).eq("user_id", args.userId))
        .unique();
      result.push({
        vin: o.vin,
        tier: (vt?.tier ?? "driver") as "driver" | "preferred" | "elite",
      });
    }
    return result;
  },
});

/**
 * Get primary vehicle tier for user (for "ELITE MEMBER" badge, etc.).
 */
export const getPrimaryVehicleTier = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const primary = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_user_status", (q) => q.eq("user_id", args.userId).eq("status", "active"))
      .filter((q) => q.eq(q.field("is_primary"), true))
      .first();

    if (!primary) return { tier: "driver" as const };

    const vt = await ctx.db
      .query("vehicle_tiers")
      .withIndex("by_vin_user", (q) => q.eq("vin", primary.vin).eq("user_id", args.userId))
      .unique();

    return { tier: (vt?.tier ?? "driver") as "driver" | "preferred" | "elite" };
  },
});

/**
 * Check if user has claimed a contribution reward (review/upload/referral).
 */
export const hasClaimedContribution = query({
  args: {
    userId: v.id("users"),
    actionType: v.string(),
    referenceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.referenceId) {
      const claim = await ctx.db
        .query("user_contribution_claims")
        .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
        .filter((q) =>
          q.and(q.eq(q.field("action_type"), args.actionType), q.eq(q.field("reference_id"), args.referenceId))
        )
        .first();
      return !!claim;
    }

    // For referral: cap of 5
    const claims = await ctx.db
      .query("user_contribution_claims")
      .withIndex("by_user_action", (q) => q.eq("user_id", args.userId).eq("action_type", args.actionType))
      .collect();

    return claims.length >= 5;
  },
});

// ============================================================================
// MUTATIONS
// ============================================================================

/**
 * Internal: Award ownership credit when a booking is completed.
 * Called from bookings.updateStatus and job_actuals when booking reaches "completed".
 * Idempotent: skips if this booking was already credited.
 */
export const addCreditForCompletedBooking = internalMutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (!booking || booking.status !== "completed") return null;

    const userId = booking.user_id;
    const totalCost = booking.total_cost;
    if (totalCost <= 0) return null;

    // Idempotent: skip if already credited
    const existing = await ctx.db
      .query("ownership_credit_transactions")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .filter((q) =>
        q.and(q.eq(q.field("type"), "earn_service"), q.eq(q.field("reference_id"), args.bookingId.toString()))
      )
      .first();
    if (existing) return null;

    // Get tier for this vehicle (per-vehicle tier per OTOPAIR PDF)
    const vt = await ctx.db
      .query("vehicle_tiers")
      .withIndex("by_vin_user", (q) => q.eq("vin", booking.vin).eq("user_id", userId))
      .unique();
    const tier = (vt?.tier ?? "driver") as "driver" | "preferred" | "elite";

    const earnRates: Record<string, number> = {
      driver: 0.01,
      preferred: 0.015,
      elite: 0.02,
    };
    const rate = earnRates[tier] ?? 0.01;
    const creditAmount = Math.round(totalCost * rate * 100) / 100;
    if (creditAmount <= 0) return null;

    const now = Date.now();

    // Ensure wallet exists
    let wallet = await ctx.db
      .query("user_reward_wallets")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .unique();
    if (!wallet) {
      await ctx.db.insert("user_reward_wallets", {
        user_id: userId,
        balance: creditAmount,
        auto_apply_to_booking: true,
        created_at: now,
        updated_at: now,
      });
    } else {
      await ctx.db.patch(wallet._id, {
        balance: wallet.balance + creditAmount,
        updated_at: now,
      });
    }

    await ctx.db.insert("ownership_credit_transactions", {
      user_id: userId,
      amount: creditAmount,
      type: "earn_service",
      description: "Maintenance rewards",
      reference_id: args.bookingId.toString(),
      // Elite credits never expire; Driver/Preferred expire in 6 months
      ...(tier === "elite" ? {} : { expires_at: now + 180 * 24 * 60 * 60 * 1000 }),
      created_at: now,
    });

    await ctx.db.insert("transactions", {
      user_id: userId,
      created_at: now,
      description: "Ownership credits",
      sub_description: "Maintenance rewards",
      amount: creditAmount,
      currency: "USD",
      status: "completed",
      transaction_type: "credit",
      icon_type: "leaf",
    });

    // --- Spend thresholds: update vehicle tier based on 12-month spend ---
    const twelveMonthsAgo = now - 365 * 24 * 60 * 60 * 1000;
    const completedBookings = await ctx.db
      .query("bookings")
      .withIndex("by_user_and_status", (q) => q.eq("user_id", userId).eq("status", "completed"))
      .filter((q) => q.and(q.eq(q.field("vin"), booking.vin), q.gte(q.field("updated_at"), twelveMonthsAgo)))
      .collect();

    const spend12mo = completedBookings.reduce((sum, b) => sum + b.total_cost, 0);

    const thresholds = { preferred: 750, elite: 1500 };
    const newTier: "driver" | "preferred" | "elite" =
      spend12mo >= thresholds.elite ? "elite" : spend12mo >= thresholds.preferred ? "preferred" : "driver";

    if (vt) {
      await ctx.db.patch(vt._id, {
        tier: newTier,
        spend_12mo: spend12mo,
        updated_at: now,
      });
    } else {
      await ctx.db.insert("vehicle_tiers", {
        vin: booking.vin,
        user_id: userId,
        tier: newTier,
        spend_12mo: spend12mo,
        created_at: now,
        updated_at: now,
      });
    }

    return { credited: creditAmount, tier: newTier, spend12mo };
  },
});

/**
 * Ensure wallet exists for user. Call from getOrCreateMe or on first wallet access.
 */
export const ensureWallet = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("user_reward_wallets")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .unique();

    if (existing) return existing._id;

    const now = Date.now();
    return await ctx.db.insert("user_reward_wallets", {
      user_id: args.userId,
      balance: 0,
      auto_apply_to_booking: true,
      created_at: now,
      updated_at: now,
    });
  },
});

/**
 * Update redemption preference (auto apply to next booking).
 */
export const updateRedemptionPreference = mutation({
  args: {
    userId: v.id("users"),
    autoApplyToBooking: v.boolean(),
  },
  handler: async (ctx, args) => {
    const wallet = await ctx.db
      .query("user_reward_wallets")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .unique();

    if (!wallet) {
      const now = Date.now();
      return await ctx.db.insert("user_reward_wallets", {
        user_id: args.userId,
        balance: 0,
        auto_apply_to_booking: args.autoApplyToBooking,
        created_at: now,
        updated_at: now,
      });
    }

    const now = Date.now();
    await ctx.db.patch(wallet._id, {
      auto_apply_to_booking: args.autoApplyToBooking,
      updated_at: now,
    });
    return wallet._id;
  },
});

/**
 * Update miles_safe. Call when computed: current odometer − initial odometer at registration.
 */
export const updateMilesSafe = mutation({
  args: {
    userId: v.id("users"),
    milesSafe: v.float64(),
  },
  handler: async (ctx, args) => {
    const wallet = await ctx.db
      .query("user_reward_wallets")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .unique();

    const now = Date.now();
    if (!wallet) {
      return await ctx.db.insert("user_reward_wallets", {
        user_id: args.userId,
        balance: 0,
        auto_apply_to_booking: true,
        miles_safe: args.milesSafe,
        created_at: now,
        updated_at: now,
      });
    }

    await ctx.db.patch(wallet._id, {
      miles_safe: args.milesSafe,
      updated_at: now,
    });
    return wallet._id;
  },
});

/**
 * Redeem credits: save preference and optionally process gift card.
 * For "auto apply" we just save the preference; actual deduction happens at checkout.
 * For "gift card" we deduct now and create a redemption transaction.
 */
export const redeemSelected = mutation({
  args: {
    userId: v.id("users"),
    option: v.union(v.literal("booking"), v.literal("giftcard")),
  },
  handler: async (ctx, args) => {
    const wallet = await ctx.db
      .query("user_reward_wallets")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .unique();

    const now = Date.now();

    if (!wallet) {
      const id = await ctx.db.insert("user_reward_wallets", {
        user_id: args.userId,
        balance: 0,
        auto_apply_to_booking: args.option === "booking",
        created_at: now,
        updated_at: now,
      });
      return id;
    }

    if (args.option === "booking") {
      await ctx.db.patch(wallet._id, {
        auto_apply_to_booking: true,
        updated_at: now,
      });
      return wallet._id;
    }

    // Gift card: deduct full balance
    if (wallet.balance <= 0) {
      throw new Error("You don't have any rewards balance to redeem yet.");
    }

    const amount = wallet.balance;
    await ctx.db.patch(wallet._id, {
      balance: 0,
      updated_at: now,
    });

    await ctx.db.insert("ownership_credit_transactions", {
      user_id: args.userId,
      amount: -amount,
      type: "redeem_giftcard",
      description: "Converted to gift card",
      created_at: now,
    });

    // Also create a transaction for the Transactions screen (negative = value going out)
    await ctx.db.insert("transactions", {
      user_id: args.userId,
      created_at: now,
      description: "Ownership credits",
      sub_description: "Gift card redemption",
      amount: -amount,
      currency: "USD",
      status: "completed",
      transaction_type: "charge",
      icon_type: "card",
    });

    return wallet._id;
  },
});

/**
 * Claim contribution reward (review $3, upload $5, referral $15).
 * Call when user completes the action.
 */
export const claimContributionReward = mutation({
  args: {
    userId: v.id("users"),
    actionType: v.union(v.literal("review"), v.literal("upload"), v.literal("referral")),
    referenceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const amounts: Record<string, number> = {
      review: 3,
      upload: 5,
      referral: 15,
    };
    const amount = amounts[args.actionType];

    // Check if already claimed (for review/upload with referenceId)
    if (args.referenceId) {
      const existing = await ctx.db
        .query("user_contribution_claims")
        .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
        .filter((q) =>
          q.and(q.eq(q.field("action_type"), args.actionType), q.eq(q.field("reference_id"), args.referenceId))
        )
        .first();
      if (existing) throw new Error("This reward has already been claimed.");
    }

    // Referral cap: 5 max
    if (args.actionType === "referral") {
      const referrals = await ctx.db
        .query("user_contribution_claims")
        .withIndex("by_user_action", (q) => q.eq("user_id", args.userId).eq("action_type", "referral"))
        .collect();
      if (referrals.length >= 5) throw new Error("You've reached the maximum of 5 referral credits.");
    }

    const now = Date.now();

    // Ensure wallet
    let wallet = await ctx.db
      .query("user_reward_wallets")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .unique();

    if (!wallet) {
      await ctx.db.insert("user_reward_wallets", {
        user_id: args.userId,
        balance: amount,
        auto_apply_to_booking: true,
        created_at: now,
        updated_at: now,
      });
    } else {
      await ctx.db.patch(wallet._id, {
        balance: wallet.balance + amount,
        updated_at: now,
      });
    }

    await ctx.db.insert("user_contribution_claims", {
      user_id: args.userId,
      action_type: args.actionType,
      reference_id: args.referenceId,
      created_at: now,
    });

    const desc =
      args.actionType === "review"
        ? "Verified review"
        : args.actionType === "upload"
          ? "Service records upload"
          : "Referral reward";

    await ctx.db.insert("ownership_credit_transactions", {
      user_id: args.userId,
      amount,
      type: `earn_${args.actionType}`,
      description: desc,
      reference_id: args.referenceId,
      // Contribution credits expire in 6 months for all tiers
      // (Elite non-expiring applies to earn_service credits in addCreditForCompletedBooking)
      expires_at: now + 180 * 24 * 60 * 60 * 1000,
      created_at: now,
    });

    await ctx.db.insert("transactions", {
      user_id: args.userId,
      created_at: now,
      description: "Ownership credits",
      sub_description: desc,
      amount,
      currency: "USD",
      status: "completed",
      transaction_type: "credit",
      icon_type: "leaf",
    });

    return { success: true, amount };
  },
});
