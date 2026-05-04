import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("analytics_events").collect();
  },
});

export const getById = query({
  args: { id: v.id("analytics_events") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getByUserId = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("analytics_events")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .collect();
  },
});

export const getByEventType = query({
  args: { eventType: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("analytics_events")
      .withIndex("by_event_type", (q) => q.eq("event_type", args.eventType))
      .collect();
  },
});

export const track = mutation({
  args: {
    user_id: v.optional(v.id("users")),
    event_type: v.string(),
    event_category: v.string(),
    event_data: v.optional(
      v.object({
        booking_id: v.optional(v.id("bookings")),
        shop_id: v.optional(v.id("shops")),
        service_id: v.optional(v.id("services")),
        screen_name: v.optional(v.string()),
        custom_properties: v.optional(v.any()),
      })
    ),
    session_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const eventId = await ctx.db.insert("analytics_events", {
      ...args,
      timestamp: Date.now(),
    });

    return eventId;
  },
});
