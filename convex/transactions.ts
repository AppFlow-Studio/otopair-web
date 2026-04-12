import { query, mutation, internalMutation } from "./_generated/server";
import { v } from "convex/values";

const transactionTypeValidator = v.union(
  v.literal("charge"),
  v.literal("credit"),
  v.literal("refund")
);

const statusValidator = v.union(
  v.literal("completed"),
  v.literal("pending"),
  v.literal("refunded")
);

/**
 * List transactions for a user, newest first.
 * Optional filter by transaction_type (charge | credit | refund).
 */
export const listForUser = query({
  args: {
    userId: v.id("users"),
    transactionType: v.optional(transactionTypeValidator), // "charge" | "credit" | "refund"; omit for all
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;
    if (args.transactionType) {
      return await ctx.db
        .query("transactions")
        .withIndex("by_user_id_type_created_at", (q) =>
          q.eq("user_id", args.userId).eq("transaction_type", args.transactionType!)
        )
        .order("desc")
        .take(limit);
    }
    return await ctx.db
      .query("transactions")
      .withIndex("by_user_id_created_at", (q) => q.eq("user_id", args.userId))
      .order("desc")
      .take(limit);
  },
});

export const getById = query({
  args: { id: v.id("transactions") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

/**
 * Create a transaction (charge, credit, or refund).
 * Use when recording a payment, referral credit, subscription charge, etc.
 */
export const create = mutation({
  args: {
    user_id: v.id("users"),
    description: v.string(),
    sub_description: v.optional(v.string()),
    amount: v.float64(),
    currency: v.optional(v.string()),
    status: statusValidator,
    transaction_type: transactionTypeValidator,
    shop_id: v.optional(v.id("shops")),
    booking_id: v.optional(v.id("bookings")),
    payment_id: v.optional(v.id("payments")),
    icon_type: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("transactions", {
      user_id: args.user_id,
      created_at: now,
      description: args.description,
      sub_description: args.sub_description,
      amount: args.amount,
      currency: args.currency ?? "USD",
      status: args.status,
      transaction_type: args.transaction_type,
      shop_id: args.shop_id,
      booking_id: args.booking_id,
      payment_id: args.payment_id,
      icon_type: args.icon_type,
    });
  },
});

/**
 * Internal: create a transaction when a payment is completed.
 * Idempotent (skips if a transaction for this payment_id already exists).
 */
export const createFromPayment = internalMutation({
  args: { payment_id: v.id("payments") },
  handler: async (ctx, args) => {
    const payment = await ctx.db.get(args.payment_id);
    if (!payment || payment.status !== "completed") return null;

    const existing = await ctx.db
      .query("transactions")
      .withIndex("by_payment_id", (q) => q.eq("payment_id", args.payment_id))
      .first();
    if (existing) return existing._id;

    const shop = payment.shop_id ? await ctx.db.get(payment.shop_id) : null;
    const description = shop?.name ?? "Payment";

    return await ctx.db.insert("transactions", {
      user_id: payment.user_id,
      created_at: payment.created_at,
      description,
      sub_description: undefined,
      amount: -payment.amount,
      currency: "USD",
      status: "completed",
      transaction_type: "charge",
      shop_id: payment.shop_id,
      booking_id: payment.booking_id,
      payment_id: payment._id,
      icon_type: "wrench",
    });
  },
});
