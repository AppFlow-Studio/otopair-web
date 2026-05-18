import { query } from "./_generated/server";
import { v } from "convex/values";

function sortSlotsBySchedule<T extends { date: string; start_time: string }>(slots: T[]) {
  return [...slots].sort((a, b) => {
    const dateCompare = a.date.localeCompare(b.date);
    if (dateCompare !== 0) return dateCompare;
    return a.start_time.localeCompare(b.start_time);
  });
}


export const list = query({
  args: {},
  handler: async (ctx) => {
    return sortSlotsBySchedule(await ctx.db.query("time_slots").collect());
  },
});

export const getById = query({
  args: { id: v.id("time_slots") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getByShopAndDate = query({
  args: {
    shopId: v.id("shops"),
    date: v.string(),
    mechanicId: v.optional(v.id("mechanics")),
  },
  handler: async (ctx, args) => {
    const slots = await ctx.db
      .query("time_slots")
      .withIndex("by_shop_and_date", (q) =>
        q.eq("shop_id", args.shopId).eq("date", args.date)
      )
      .collect();

    const filtered = slots.filter((slot) => {
      if (!slot.is_available) return false;
      if (args.mechanicId !== undefined) {
        return slot.mechanic_id === args.mechanicId;
      }
      return true;
    });

    return sortSlotsBySchedule(filtered);
  },
});

export const getAvailableByShopId = query({
  args: { shopId: v.id("shops") },
  handler: async (ctx, args) => {
    const slots = await ctx.db
      .query("time_slots")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
      .collect();
    return sortSlotsBySchedule(slots.filter((slot) => slot.is_available));
  },
});

export const getAvailableByShopAndDateTime = query({
  args: { shopId: v.id("shops"), date: v.string(), startTime: v.string() },
  handler: async (ctx, args) => {
    const slots = await ctx.db
      .query("time_slots")
      .withIndex("by_shop_and_date", (q) =>
        q.eq("shop_id", args.shopId).eq("date", args.date)
      )
      .collect();

    return sortSlotsBySchedule(
      slots.filter(
        (slot) => slot.is_available && slot.start_time === args.startTime
      )
    );
  },
});

/**
 * Next N available slots for a shop, optionally filtered by mechanic.
 * When mechanicId is omitted ("Any"), returns earliest N distinct date+time slots (one per time).
 * When mechanicId is set, returns that mechanic's slots.
 */
export const getNextAvailableByShop = query({
  args: {
    shopId: v.id("shops"),
    limit: v.optional(v.number()),
    mechanicId: v.optional(v.id("mechanics")),
    // Client-supplied "now" in the user's local timezone. The server runs
    // in UTC, so deriving today/minBookableTime here would drift around
    // midnight (e.g., 11 PM Hawaii looks like tomorrow in UTC and we'd
    // skip the whole day). When omitted we fall back to UTC for back-compat
    // with older app builds.
    cutoffDate: v.optional(v.string()),
    cutoffTime: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 12;
    const cutoffDate = args.cutoffDate ?? new Date().toISOString().slice(0, 10);
    const cutoffTime = args.cutoffTime ?? "00:00";

    const slots = await ctx.db
      .query("time_slots")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
      .collect();

    const filtered = sortSlotsBySchedule(
      slots.filter((slot) => {
        if (!slot.is_available) return false;
        if (slot.date < cutoffDate) return false;
        // Within today, drop slots that already started — otherwise a
        // shop with long hours returns morning slots first and small
        // limits leave the customer with nothing bookable after the
        // client's past-time filter runs.
        if (slot.date === cutoffDate && slot.start_time < cutoffTime) return false;
        if (args.mechanicId !== undefined) {
          return slot.mechanic_id === args.mechanicId;
        }
        return true;
      })
    );

    if (args.mechanicId !== undefined) {
      return filtered.slice(0, limit);
    }

    const seen = new Set<string>();
    const distinct: typeof filtered = [];
    for (const slot of filtered) {
      const key = `${slot.date}-${slot.start_time}`;
      if (seen.has(key)) continue;
      seen.add(key);
      distinct.push(slot);
      if (distinct.length >= limit) break;
    }
    return distinct;
  },
});

/**
 * Next N available slots per mechanic for a shop.
 * Returns one list of slots per mechanic so each mechanic card can show their own time slots.
 */
export const getNextAvailableByShopPerMechanic = query({
  args: {
    shopId: v.id("shops"),
    limitPerMechanic: v.optional(v.number()),
    // See `getNextAvailableByShop` for why these are passed from the
    // client — same drift problem, same fix.
    cutoffDate: v.optional(v.string()),
    cutoffTime: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const limitPerMechanic = args.limitPerMechanic ?? 12;
    const cutoffDate = args.cutoffDate ?? new Date().toISOString().slice(0, 10);
    const cutoffTime = args.cutoffTime ?? "00:00";

    const mechanics = await ctx.db
      .query("mechanics")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
      .filter((q) => q.eq(q.field("is_active"), true))
      .collect();

    const slots = await ctx.db
      .query("time_slots")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
      .collect();

    return mechanics.map((mechanic) => ({
      mechanicId: mechanic._id,
      slots: sortSlotsBySchedule(
        slots.filter((slot) => {
          if (!slot.is_available) return false;
          if (slot.date < cutoffDate) return false;
          if (slot.date === cutoffDate && slot.start_time < cutoffTime) return false;
          return slot.mechanic_id === mechanic._id;
        })
      ).slice(0, limitPerMechanic),
    }));
  },
});

/**
 * Calendar availability for a shop (and optional mechanic) for a given month.
 * Returns which dates have at least one available slot vs which have slots but all booked.
 */
export const getAvailabilityByShopAndMonth = query({
  args: {
    shopId: v.id("shops"),
    year: v.number(),
    month: v.number(),
    mechanicId: v.optional(v.id("mechanics")),
  },
  handler: async (ctx, args) => {
    const start = new Date(args.year, args.month, 1);
    const end = new Date(args.year, args.month + 1, 0);
    const startStr = start.toISOString().slice(0, 10);
    const endStr = end.toISOString().slice(0, 10);
    const slots = await ctx.db
      .query("time_slots")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
      .collect();

    const inRange = slots.filter((slot) => {
      if (slot.date < startStr || slot.date > endStr) return false;
      if (args.mechanicId !== undefined) {
        return slot.mechanic_id === args.mechanicId;
      }
      return true;
    });

    const availableDates = new Set<string>();
    const bookedDates = new Set<string>();

    for (const slot of inRange) {
      if (slot.is_available) {
        availableDates.add(slot.date);
      } else {
        bookedDates.add(slot.date);
      }
    }

    // A date is only "booked" if it has no available slots at all
    for (const date of availableDates) {
      bookedDates.delete(date);
    }

    return {
      availableDates: [...availableDates],
      bookedDates: [...bookedDates],
    };
  },
});
