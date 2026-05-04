import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("follow_ups").collect();
  },
});

export const getById = query({
  args: { id: v.id("follow_ups") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getByUserId = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("follow_ups")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .collect();
  },
});

export const getByVin = query({
  args: { vin: v.string() },
  handler: async (ctx, args) => {
    const normalizedVin = args.vin.toUpperCase().trim();
    return await ctx.db
      .query("follow_ups")
      .withIndex("by_vin", (q) => q.eq("vin", normalizedVin))
      .collect();
  },
});

export const getPendingReminders = query({
  args: {
    beforeTimestamp: v.float64(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("follow_ups")
      .withIndex("by_status_and_scheduled", (q) =>
        q.eq("status", "pending").lte("scheduled_for", args.beforeTimestamp)
      )
      .collect();
  },
});

export const getByStatus = query({
  args: { status: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("follow_ups")
      .withIndex("by_status_and_scheduled", (q) =>
        q.eq("status", args.status)
      )
      .collect();
  },
});

export const getByBookingId = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("follow_ups")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", args.bookingId))
      .collect();
  },
});

export const create = mutation({
  args: {
    user_id: v.id("users"),
    vin: v.string(),
    booking_id: v.optional(v.id("bookings")),
    service_id: v.id("services"),
    follow_up_type: v.string(),
    scheduled_for: v.float64(),
    message: v.string(),
  },
  handler: async (ctx, args) => {
    const normalizedVin = args.vin.toUpperCase().trim();
    const followUpId = await ctx.db.insert("follow_ups", {
      ...args,
      vin: normalizedVin,
      status: "pending",
      created_at: Date.now(),
    });

    return followUpId;
  },
});

export const updateStatus = mutation({
  args: {
    id: v.id("follow_ups"),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    const updates: any = { status: args.status };
    
    if (args.status === "sent") {
      updates.sent_at = Date.now();
    }

    await ctx.db.patch(args.id, updates);
    return await ctx.db.get(args.id);
  },
});

export const dismiss = mutation({
  args: {
    id: v.id("follow_ups"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { status: "dismissed" });
    return await ctx.db.get(args.id);
  },
});
