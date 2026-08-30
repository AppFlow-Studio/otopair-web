import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import {
  DEFAULT_AVAILABILITY_DAYS,
  listAvailableWindowsForShopDate,
  listNextAvailableWindowsForShop,
  syncMechanicDayAvailability,
  syncShopAvailabilityWindow,
  syncShopDateAvailability,
} from "./lib/timeSlotAvailability";
import {
  quoteHoldContextValidator,
  resolveOwnedQuoteHoldExclusion,
} from "./lib/quoteHoldOwnership";

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

/**
 * Compatibility cleanup for old generated free slots. Availability is now
 * inferred from shop hours, active mechanics, bookings, and negative blocks.
 */
export const refreshShopAvailability = mutation({
  args: {
    shopId: v.id("shops"),
    startDate: v.optional(v.string()),
    days: v.optional(v.number()),
    date: v.optional(v.string()),
    mechanicId: v.optional(v.id("mechanics")),
  },
  handler: async (ctx, args) => {
    if (args.date && args.mechanicId) {
      return await syncMechanicDayAvailability(ctx, {
        shopId: args.shopId,
        mechanicId: args.mechanicId,
        date: args.date,
      });
    }

    if (args.date) {
      return await syncShopDateAvailability(ctx, {
        shopId: args.shopId,
        date: args.date,
      });
    }

    return await syncShopAvailabilityWindow(ctx, {
      shopId: args.shopId,
      startDate: args.startDate,
      days: args.days,
    });
  },
});

export const getByShopAndDate = query({
  args: {
    shopId: v.id("shops"),
    date: v.string(),
    mechanicId: v.optional(v.id("mechanics")),
    durationMinutes: v.optional(v.number()),
    quote_context: v.optional(quoteHoldContextValidator),
  },
  handler: async (ctx, args) => {
    const quoteExclusion = await resolveOwnedQuoteHoldExclusion(
      ctx,
      args.quote_context,
      { throwOnUnavailable: false },
    );
    return sortSlotsBySchedule(
      await listAvailableWindowsForShopDate(ctx, {
        shopId: args.shopId,
        date: args.date,
        mechanicId: args.mechanicId,
        durationMinutes: args.durationMinutes,
        ...quoteExclusion,
      })
    );
  },
});

export const getAvailableByShopId = query({
  args: {
    shopId: v.id("shops"),
    limit: v.optional(v.number()),
    durationMinutes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return sortSlotsBySchedule(
      await listNextAvailableWindowsForShop(ctx, {
        shopId: args.shopId,
        days: DEFAULT_AVAILABILITY_DAYS,
        limit: args.limit ?? 200,
        durationMinutes: args.durationMinutes,
      })
    );
  },
});

export const getAvailableByShopAndDateTime = query({
  args: {
    shopId: v.id("shops"),
    date: v.string(),
    startTime: v.string(),
    durationMinutes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return sortSlotsBySchedule(
      (
        await listAvailableWindowsForShopDate(ctx, {
          shopId: args.shopId,
          date: args.date,
          durationMinutes: args.durationMinutes,
        })
      ).filter((slot) => slot.start_time === args.startTime)
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
    durationMinutes: v.optional(v.number()),
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

    return sortSlotsBySchedule(
      await listNextAvailableWindowsForShop(ctx, {
        shopId: args.shopId,
        limit,
        mechanicId: args.mechanicId,
        cutoffDate,
        cutoffTime,
        startDate: cutoffDate,
        durationMinutes: args.durationMinutes,
        distinctTimes: args.mechanicId === undefined,
      })
    );
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
    durationMinutes: v.optional(v.number()),
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

    return await Promise.all(
      mechanics.map(async (mechanic) => ({
        mechanicId: mechanic._id,
        slots: sortSlotsBySchedule(
          await listNextAvailableWindowsForShop(ctx, {
            shopId: args.shopId,
            limit: limitPerMechanic,
            mechanicId: mechanic._id,
            cutoffDate,
            cutoffTime,
            startDate: cutoffDate,
            durationMinutes: args.durationMinutes,
          })
        ),
      }))
    );
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
    durationMinutes: v.optional(v.number()),
    cutoffDate: v.optional(v.string()),
    cutoffTime: v.optional(v.string()),
    quote_context: v.optional(quoteHoldContextValidator),
  },
  handler: async (ctx, args) => {
    const quoteExclusion = await resolveOwnedQuoteHoldExclusion(
      ctx,
      args.quote_context,
      { throwOnUnavailable: false },
    );
    // `month` arrives 1-based from the client (1 = January). JS Date months are
    // 0-based, so subtract 1 for the first-of-month and use `month` as the
    // exclusive-next-month sentinel (day 0 = last day of the requested month).
    // Without this the whole scan runs one month ahead, painting the NEXT
    // month's open/closed pattern onto this month's date chips.
    const start = new Date(args.year, args.month - 1, 1);
    const end = new Date(args.year, args.month, 0);
    const startStr = start.toISOString().slice(0, 10);
    const endStr = end.toISOString().slice(0, 10);
    const availableDates = new Set<string>();
    const bookedDates = new Set<string>();
    for (
      let cursor = new Date(start.getTime());
      cursor <= end;
      cursor.setDate(cursor.getDate() + 1)
    ) {
      const date = cursor.toISOString().slice(0, 10);
      const slots = await listAvailableWindowsForShopDate(ctx, {
        shopId: args.shopId,
        date,
        mechanicId: args.mechanicId,
        durationMinutes: args.durationMinutes,
        cutoffTime: args.cutoffDate === date ? args.cutoffTime : undefined,
        limit: 1,
        ...quoteExclusion,
      });
      if (slots.length > 0) {
        availableDates.add(date);
      } else if (date >= startStr && date <= endStr) {
        bookedDates.add(date);
      }
    }

    return {
      availableDates: [...availableDates],
      bookedDates: [...bookedDates],
    };
  },
});
