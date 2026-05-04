import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("conversion_funnels").collect();
  },
});

export const getById = query({
  args: { id: v.id("conversion_funnels") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getByUserId = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("conversion_funnels")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .collect();
  },
});

export const getByBookingId = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("conversion_funnels")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", args.bookingId))
      .collect();
  },
});

export const startFunnel = mutation({
  args: {
    user_id: v.id("users"),
    funnel_type: v.string(),
    stage: v.string(),
    booking_id: v.optional(v.id("bookings")),
  },
  handler: async (ctx, args) => {
    const funnelId = await ctx.db.insert("conversion_funnels", {
      ...args,
      entered_at: Date.now(),
      completed: false,
    });

    return funnelId;
  },
});

export const updateStage = mutation({
  args: {
    id: v.id("conversion_funnels"),
    stage: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      stage: args.stage,
    });

    return await ctx.db.get(args.id);
  },
});

export const completeFunnel = mutation({
  args: {
    id: v.id("conversion_funnels"),
    booking_id: v.optional(v.id("bookings")),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      completed: true,
      exited_at: Date.now(),
      booking_id: args.booking_id,
    });

    return await ctx.db.get(args.id);
  },
});

export const abandonFunnel = mutation({
  args: {
    id: v.id("conversion_funnels"),
    drop_off_reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      exited_at: Date.now(),
      drop_off_reason: args.drop_off_reason,
    });

    return await ctx.db.get(args.id);
  },
});
