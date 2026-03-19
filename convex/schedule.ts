/* eslint-disable @typescript-eslint/no-explicit-any */
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

async function getCurrentUserOrNull(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) => q.eq("clerkUserId", identity.subject))
    .unique();
  return user ?? null;
}

async function getPrimaryAuthorizedShop(ctx: any, userId: any) {
  const activeMembership = await ctx.db
    .query("shop_users")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .filter((q: any) => q.eq(q.field("is_active"), true))
    .first();

  if (activeMembership) {
    return { shopId: activeMembership.shop_id, role: activeMembership.role };
  }

  const ownedShop = await ctx.db
    .query("shops")
    .withIndex("by_owner_user_id", (q: any) => q.eq("owner_user_id", userId))
    .first();

  if (ownedShop) {
    return { shopId: ownedShop._id, role: "owner" };
  }

  return null;
}

/* ------------------------------------------------------------------ */
/*  Queries                                                             */
/* ------------------------------------------------------------------ */

/** Returns shop hours, active mechanics, and shop info for the schedule page. */
export const getScheduleContext = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return null;

    const primary = await getPrimaryAuthorizedShop(ctx, user._id);
    if (!primary) return null;

    const shop: any = await ctx.db.get(primary.shopId);
    if (!shop) return null;

    const hours = await ctx.db
      .query("shops_hours")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shop._id))
      .collect();

    // Sort by day_of_week
    hours.sort((a: any, b: any) => a.day_of_week - b.day_of_week);

    const allMechanics = await ctx.db
      .query("mechanics")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shop._id))
      .filter((q: any) => q.eq(q.field("is_active"), true))
      .collect();

    const mechanicShopUsers = await ctx.db
      .query("shop_users")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shop._id))
      .filter((q: any) =>
        q.and(
          q.neq(q.field("mechanic_id"), undefined),
          q.neq(q.field("accepted_at"), undefined),
          q.or(
            q.eq(q.field("role"), "shop_mechanic"),
            q.eq(q.field("role"), "mechanic")
          )
        )
      )
      .collect();

    const acceptedMechanicIds = new Set(
      mechanicShopUsers.map((su: any) => su.mechanic_id as string)
    );

    const mechanics = allMechanics.filter((m: any) => acceptedMechanicIds.has(m._id));

    return {
      shopId: shop._id,
      shopName: shop.name,
      hours: hours.map((h: any) => ({
        _id: h._id,
        dayOfWeek: h.day_of_week,
        dayName: h.day_name,
        openTime: h.open_time ?? "09:00",
        closeTime: h.close_time ?? "17:00",
        isClosed: h.is_closed,
      })),
      mechanics: mechanics.map((m: any) => ({
        _id: m._id,
        name: `${m.first_name} ${m.last_name}`.trim(),
        firstName: m.first_name,
        lastName: m.last_name,
        title: m.title ?? null,
      })),
    };
  },
});

/** Returns bookings within a date range for the calendar view. */
export const getBookingsForRange = query({
  args: {
    dateFrom: v.string(),
    dateTo: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return [];

    const primary = await getPrimaryAuthorizedShop(ctx, user._id);
    if (!primary) return [];

    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", primary.shopId))
      .collect();

    // Filter to date range and exclude cancelled/declined
    const filtered = bookings.filter(
      (b: any) =>
        b.scheduled_date >= args.dateFrom &&
        b.scheduled_date <= args.dateTo &&
        b.status !== "cancelled" &&
        b.status !== "declined"
    );

    return await Promise.all(
      filtered.map(async (b: any) => {
        const customer: any = await ctx.db.get(b.user_id);
        const customerName =
          `${customer?.first_name ?? ""} ${customer?.last_name ?? ""}`.trim() ||
          customer?.email ||
          "Unknown";

        const mechanic: any = b.mechanic_id
          ? await ctx.db.get(b.mechanic_id)
          : null;

        const serviceNames = await resolveServiceNames(ctx, b.service_ids);

        return {
          _id: b._id,
          scheduledDate: b.scheduled_date,
          scheduledTime: b.scheduled_time,
          estimatedMinutes: b.estimated_labor_minutes ?? 60,
          status: b.status,
          customerName,
          mechanicId: b.mechanic_id ?? null,
          mechanicName: mechanic
            ? `${mechanic.first_name} ${mechanic.last_name}`.trim()
            : null,
          serviceNames,
          totalCost: b.total_cost,
        };
      })
    );
  },
});

async function resolveServiceNames(ctx: any, serviceIds?: Array<any>) {
  if (!serviceIds || serviceIds.length === 0) return [] as string[];
  const names = await Promise.all(
    serviceIds.map(async (serviceId: any) => {
      const service = await ctx.db.get(serviceId);
      return service?.name ?? "Unknown Service";
    })
  );
  return names;
}

/** Returns blocked (unavailable) time slots for a date range. */
export const getBlockedSlots = query({
  args: {
    dateFrom: v.string(),
    dateTo: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return [];

    const primary = await getPrimaryAuthorizedShop(ctx, user._id);
    if (!primary) return [];

    const slots = await ctx.db
      .query("time_slots")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", primary.shopId))
      .collect();

    // Return only manually blocked slots (not booked ones — those come from bookings)
    return slots
      .filter(
        (s: any) =>
          s.date >= args.dateFrom &&
          s.date <= args.dateTo &&
          !s.is_available &&
          !s.booking_id // Only manual blocks, not booking-created slots
      )
      .map((s: any) => ({
        _id: s._id,
        date: s.date,
        startTime: s.start_time,
        endTime: s.end_time,
        mechanicId: s.mechanic_id ?? null,
      }));
  },
});

/* ------------------------------------------------------------------ */
/*  Mutations                                                           */
/* ------------------------------------------------------------------ */

/** Update shop operating hours for a specific day. */
export const updateShopHours = mutation({
  args: {
    hoursId: v.id("shops_hours"),
    openTime: v.optional(v.string()),
    closeTime: v.optional(v.string()),
    isClosed: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) throw new Error("Not authenticated");

    const hoursRecord = await ctx.db.get(args.hoursId);
    if (!hoursRecord) throw new Error("Hours record not found");

    const primary = await getPrimaryAuthorizedShop(ctx, user._id);
    if (!primary || String(primary.shopId) !== String(hoursRecord.shop_id)) {
      throw new Error("Not authorized");
    }

    const patch: any = {};
    if (args.openTime !== undefined) patch.open_time = args.openTime;
    if (args.closeTime !== undefined) patch.close_time = args.closeTime;
    if (args.isClosed !== undefined) patch.is_closed = args.isClosed;

    await ctx.db.patch(args.hoursId, patch);
  },
});

/** Block a specific time slot for a mechanic (manual override). */
export const blockSlot = mutation({
  args: {
    mechanicId: v.optional(v.id("mechanics")),
    date: v.string(),
    startTime: v.string(),
    endTime: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) throw new Error("Not authenticated");

    const primary = await getPrimaryAuthorizedShop(ctx, user._id);
    if (!primary) throw new Error("Not authorized");

    await ctx.db.insert("time_slots", {
      shop_id: primary.shopId,
      mechanic_id: args.mechanicId,
      date: args.date,
      start_time: args.startTime,
      end_time: args.endTime,
      is_available: false,
    });
  },
});

/** Unblock a previously blocked time slot. */
export const unblockSlot = mutation({
  args: {
    slotId: v.id("time_slots"),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) throw new Error("Not authenticated");

    const slot = await ctx.db.get(args.slotId);
    if (!slot) throw new Error("Slot not found");

    const primary = await getPrimaryAuthorizedShop(ctx, user._id);
    if (!primary || String(primary.shopId) !== String(slot.shop_id)) {
      throw new Error("Not authorized");
    }

    await ctx.db.delete(args.slotId);
  },
});

/** Block all slots for a mechanic on a given date (full day off). */
export const blockMechanicDay = mutation({
  args: {
    mechanicId: v.id("mechanics"),
    date: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) throw new Error("Not authenticated");

    const primary = await getPrimaryAuthorizedShop(ctx, user._id);
    if (!primary) throw new Error("Not authorized");

    // Get shop hours for this day of week
    const dayDate = new Date(args.date + "T00:00:00");
    const dayOfWeek = dayDate.getDay(); // 0=Sun

    const hours = await ctx.db
      .query("shops_hours")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", primary.shopId))
      .collect();

    const dayHours = hours.find((h: any) => h.day_of_week === dayOfWeek);
    if (!dayHours || dayHours.is_closed) return;

    const openTime = dayHours.open_time ?? "09:00";
    const closeTime = dayHours.close_time ?? "17:00";

    // Create a single block for the entire day
    await ctx.db.insert("time_slots", {
      shop_id: primary.shopId,
      mechanic_id: args.mechanicId,
      date: args.date,
      start_time: openTime,
      end_time: closeTime,
      is_available: false,
    });
  },
});
