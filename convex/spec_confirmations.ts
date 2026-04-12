import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("spec_confirmations").collect();
  },
});

export const getById = query({
  args: { id: v.id("spec_confirmations") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getByEngineId = query({
  args: { engineId: v.id("engines") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("spec_confirmations")
      .withIndex("by_engine_id", (q) => q.eq("engine_id", args.engineId))
      .collect();
  },
});

export const getByUserId = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("spec_confirmations")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .collect();
  },
});

export const getByBookingId = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("spec_confirmations")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", args.bookingId))
      .unique();
  },
});

export const create = mutation({
  args: {
    user_id: v.id("users"),
    engine_id: v.id("engines"),
    service_id: v.id("services"),
    booking_id: v.id("bookings"),
    confirmed_accurate: v.boolean(),
    feedback: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const confirmationId = await ctx.db.insert("spec_confirmations", {
      ...args,
      confirmed_at: Date.now(),
    });

    return confirmationId;
  },
});
