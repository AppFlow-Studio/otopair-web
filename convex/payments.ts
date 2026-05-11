import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("payments").collect();
  },
});

export const getById = query({
  args: { id: v.id("payments") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getByBookingId = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("payments")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", args.bookingId))
      .unique();
  },
});

export const getByUserId = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("payments")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .collect();
  },
});

export const create = mutation({
  args: {
    booking_id: v.id("bookings"),
    user_id: v.id("users"),
    shop_id: v.id("shops"),
    amount: v.float64(),
    payment_method: v.string(),
    status: v.string(),
    transaction_id: v.optional(v.string()),
    stripe_payment_intent_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const paymentId = await ctx.db.insert("payments", {
      ...args,
      created_at: now,
      updated_at: now,
    });

    return paymentId;
  },
});

export const updateStatus = mutation({
  args: {
    id: v.id("payments"),
    status: v.string(),
    error_code: v.optional(v.string()),
    error_message: v.optional(v.string()),
    transaction_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Get current payment
    const payment = await ctx.db.get(args.id);
    if (!payment) throw new Error("Payment not found");

    // Validate status transition using FSM
    const { validateTransition, isTerminal } = await import("./payment_status_history");
    const error = validateTransition(payment.status, args.status);
    if (error) throw new Error(error);

    // Prevent transitions from terminal states
    if (isTerminal(payment.status)) {
      const readable = String(payment.status).replace(/_/g, " ");
      throw new Error(`This payment is already ${readable} and can no longer change.`);
    }

    // Patch payment with new status
    const now = Date.now();
    const { id, status, error_code, error_message, transaction_id } = args;
    await ctx.db.patch(id, {
      status,
      transaction_id: transaction_id ?? undefined,
      updated_at: now,
    });

    // Log status change to history (async, non-blocking)
    await ctx.scheduler.runAfter(0, internal.payment_status_history.log, {
      payment_id: id,
      old_status: payment.status,
      new_status: status,
      error_code,
      error_message,
    });

    // Create user-facing transaction when payment completes
    if (status === "completed") {
      await ctx.scheduler.runAfter(0, internal.transactions.createFromPayment, {
        payment_id: id,
      });
    }

    return await ctx.db.get(id);
  },
});
