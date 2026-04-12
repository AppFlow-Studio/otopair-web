import { mutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Seed user-facing transactions for a specific user.
 *
 * Why this exists:
 * - Keeps transaction seeding isolated from the large demo seed.ts flow.
 * - Lets you seed data for any account by passing userId directly.
 *
 * Usage:
 * npx convex run seed_transactions:seedTransactionsForUser '{"userId":"<users_id>","clearExisting":true}'
 */
export const seedTransactionsForUser = mutation({
  args: {
    userId: v.id("users"),
    clearExisting: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) {
      throw new Error("User not found");
    }

    if (args.clearExisting) {
      const existing = await ctx.db
        .query("transactions")
        .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
        .collect();

      for (const row of existing) {
        await ctx.db.delete(row._id);
      }
    }

    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;

    await ctx.db.insert("transactions", {
      user_id: args.userId,
      created_at: now - oneDay,
      description: "Hawk Precision Auto",
      sub_description: "Oil Change",
      amount: -89.99,
      currency: "USD",
      status: "completed",
      transaction_type: "charge",
      icon_type: "wrench",
    });

    await ctx.db.insert("transactions", {
      user_id: args.userId,
      created_at: now - 2 * oneDay,
      description: "Ownership credits",
      sub_description: "Referral reward",
      amount: 25,
      currency: "USD",
      status: "completed",
      transaction_type: "credit",
      icon_type: "leaf",
    });

    await ctx.db.insert("transactions", {
      user_id: args.userId,
      created_at: now - 3 * oneDay,
      description: "Shell Station",
      sub_description: "Fuel",
      amount: -42.5,
      currency: "USD",
      status: "completed",
      transaction_type: "charge",
      icon_type: "fuel",
    });

    await ctx.db.insert("transactions", {
      user_id: args.userId,
      created_at: now - 4 * oneDay,
      description: "Otopair Premium",
      sub_description: "Monthly Subscription",
      amount: -12.99,
      currency: "USD",
      status: "completed",
      transaction_type: "charge",
      icon_type: "card",
    });

    await ctx.db.insert("transactions", {
      user_id: args.userId,
      created_at: now - 5 * oneDay,
      description: "Brake service adjustment",
      sub_description: "Pricing correction",
      amount: 18.75,
      currency: "USD",
      status: "completed",
      transaction_type: "refund",
      icon_type: "car",
    });

    return { success: true, seededForUserId: args.userId, rowsInserted: 5 };
  },
});
