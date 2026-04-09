/* eslint-disable @typescript-eslint/no-explicit-any */
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getBookingEndTime } from "../lib/schedule-overlap";

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
      mechanics: await Promise.all(
        mechanics.map(async (m: any) => {
          let imageUrl: string | null = null;
          if (m.photo) {
            const asset: any = await ctx.db.get(m.photo);
            if (asset?.url) imageUrl = asset.url;
          }
          return {
            _id: m._id,
            name: `${m.first_name} ${m.last_name}`.trim(),
            firstName: m.first_name,
            lastName: m.last_name,
            title: m.title ?? null,
            imageUrl,
          };
        })
      ),
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

/** Returns custom block time types for the shop. */
export const getBlockTimeTypes = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return [];

    const primary = await getPrimaryAuthorizedShop(ctx, user._id);
    if (!primary) return [];

    const types = await ctx.db
      .query("block_time_types")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", primary.shopId))
      .collect();

    return types.map((t: any) => ({ _id: t._id, title: t.title }));
  },
});

/** Delete a custom block time type. */
export const deleteBlockTimeType = mutation({
  args: { typeId: v.id("block_time_types") },
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) throw new Error("Not authenticated");

    const record = await ctx.db.get(args.typeId);
    if (!record) throw new Error("Block time type not found");

    const primary = await getPrimaryAuthorizedShop(ctx, user._id);
    if (!primary || String(primary.shopId) !== String(record.shop_id)) {
      throw new Error("Not authorized");
    }

    await ctx.db.delete(args.typeId);
  },
});

/** Save a custom block time type for the shop. */
export const saveBlockTimeType = mutation({
  args: { title: v.string() },
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) throw new Error("Not authenticated");

    const primary = await getPrimaryAuthorizedShop(ctx, user._id);
    if (!primary) throw new Error("Not authorized");

    // Avoid duplicates
    const existing = await ctx.db
      .query("block_time_types")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", primary.shopId))
      .collect();
    const duplicate = existing.find(
      (t: any) => t.title.toLowerCase() === args.title.toLowerCase()
    );
    if (duplicate) return duplicate._id;

    return await ctx.db.insert("block_time_types", {
      shop_id: primary.shopId,
      title: args.title,
    });
  },
});

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

    // Collect all time_slot_ids referenced by bookings — these are booking-created slots
    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", primary.shopId))
      .collect();
    const bookingSlotIds = new Set(bookings.map((b: any) => String(b.time_slot_id)));

    // Return only manually blocked slots (not booking-created ones)
    return slots
      .filter(
        (s: any) =>
          s.date >= args.dateFrom &&
          s.date <= args.dateTo &&
          !s.is_available &&
          !bookingSlotIds.has(String(s._id))
      )
      .map((s: any) => ({
        _id: s._id,
        date: s.date,
        startTime: s.start_time,
        endTime: s.end_time,
        mechanicId: s.mechanic_id ?? null,
        title: s.title ?? null,
        note: s.note ?? null,
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
    title: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) throw new Error("Not authenticated");

    const primary = await getPrimaryAuthorizedShop(ctx, user._id);
    if (!primary) throw new Error("Not authorized");

    // Check for overlapping bookings on this date/mechanic
    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", primary.shopId))
      .collect();
    const overlapping = bookings.filter((b: any) => {
      if (b.scheduled_date !== args.date) return false;
      if (b.status === "cancelled" || b.status === "declined") return false;
      // When blocking for a specific mechanic, only check that mechanic's bookings
      if (args.mechanicId && String(b.mechanic_id ?? "") !== String(args.mechanicId)) return false;
      // Check time overlap
      const bEnd = getBookingEndTime(
        b.scheduled_time,
        b.estimated_labor_minutes
      );
      return b.scheduled_time < args.endTime && bEnd > args.startTime;
    });
    if (overlapping.length > 0) {
      throw new Error("Cannot block a slot that overlaps an existing booking");
    }

    // Reject if any existing manually-blocked slot overlaps the new range
    const bookingSlotIds = new Set(bookings.map((b: any) => String(b.time_slot_id)));
    const existingSlots = await ctx.db
      .query("time_slots")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", primary.shopId))
      .collect();
    const overlappingBlock = existingSlots.find((s: any) => {
      if (s.date !== args.date) return false;
      if (s.is_available) return false;
      if (bookingSlotIds.has(String(s._id))) return false;
      if (args.mechanicId && (!s.mechanic_id || String(s.mechanic_id) !== String(args.mechanicId))) return false;
      if (!args.mechanicId && s.mechanic_id) return false;
      return s.start_time < args.endTime && s.end_time > args.startTime;
    });
    if (overlappingBlock) {
      throw new Error("Cannot add blocked time onto a time already blocked");
    }

    await ctx.db.insert("time_slots", {
      shop_id: primary.shopId,
      mechanic_id: args.mechanicId,
      date: args.date,
      start_time: args.startTime,
      end_time: args.endTime,
      is_available: false,
      ...(args.title ? { title: args.title } : {}),
      ...(args.note ? { note: args.note } : {}),
    });
  },
});

/** Update an existing manually-blocked time slot. */
export const updateBlockedSlot = mutation({
  args: {
    slotId: v.id("time_slots"),
    mechanicId: v.optional(v.id("mechanics")),
    date: v.string(),
    startTime: v.string(),
    endTime: v.string(),
    title: v.optional(v.string()),
    note: v.optional(v.string()),
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

    // Check for overlapping bookings (excluding the slot itself)
    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", primary.shopId))
      .collect();
    const overlapping = bookings.filter((b: any) => {
      if (b.scheduled_date !== args.date) return false;
      if (b.status === "cancelled" || b.status === "declined") return false;
      if (args.mechanicId && String(b.mechanic_id ?? "") !== String(args.mechanicId)) return false;
      const bEnd = getBookingEndTime(
        b.scheduled_time,
        b.estimated_labor_minutes
      );
      return b.scheduled_time < args.endTime && bEnd > args.startTime;
    });
    if (overlapping.length > 0) {
      throw new Error("Cannot block a slot that overlaps an existing booking");
    }

    // Check for overlapping blocked slots (excluding self)
    const bookingSlotIds = new Set(bookings.map((b: any) => String(b.time_slot_id)));
    const existingSlots = await ctx.db
      .query("time_slots")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", primary.shopId))
      .collect();
    const overlappingBlock = existingSlots.find((s: any) => {
      if (String(s._id) === String(args.slotId)) return false; // exclude self
      if (s.date !== args.date) return false;
      if (s.is_available) return false;
      if (bookingSlotIds.has(String(s._id))) return false;
      if (args.mechanicId && (!s.mechanic_id || String(s.mechanic_id) !== String(args.mechanicId))) return false;
      if (!args.mechanicId && s.mechanic_id) return false;
      return s.start_time < args.endTime && s.end_time > args.startTime;
    });
    if (overlappingBlock) {
      throw new Error("Cannot add blocked time onto a time already blocked");
    }

    await ctx.db.patch(args.slotId, {
      mechanic_id: args.mechanicId,
      date: args.date,
      start_time: args.startTime,
      end_time: args.endTime,
      title: args.title ?? undefined,
      note: args.note ?? undefined,
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

/** Block all slots for a mechanic on a given date (full day off).
 *  When `force` is true and the mechanic has bookings, blocks all gaps
 *  around those bookings rather than throwing. */
export const blockMechanicDay = mutation({
  args: {
    mechanicId: v.id("mechanics"),
    date: v.string(),
    force: v.optional(v.boolean()),
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
    if (dayHours?.is_closed) throw new Error("Shop is closed on this day");

    // Fall back to full day when no hours are configured (matches the schedule grid fallback)
    const openTime = dayHours?.open_time ?? "00:00";
    const closeTime = dayHours?.close_time ?? "24:00";

    // Fetch bookings for this mechanic on this date
    const allBookings = await ctx.db
      .query("bookings")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", primary.shopId))
      .collect();
    const mechanicBookings = allBookings.filter(
      (b: any) =>
        b.scheduled_date === args.date &&
        b.mechanic_id &&
        String(b.mechanic_id) === String(args.mechanicId) &&
        b.status !== "cancelled" &&
        b.status !== "declined"
    );

    // force=true means the frontend already confirmed with the user; proceed around bookings

    // Remove any existing manually-blocked slots for this mechanic on this date
    const bookingSlotIds = new Set(allBookings.map((b: any) => String(b.time_slot_id)));
    const existingSlots = await ctx.db
      .query("time_slots")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", primary.shopId))
      .collect();
    const toDelete = existingSlots.filter((s: any) =>
      s.date === args.date &&
      !s.is_available &&
      !bookingSlotIds.has(String(s._id)) &&
      s.mechanic_id &&
      String(s.mechanic_id) === String(args.mechanicId)
    );
    for (const slot of toDelete) {
      await ctx.db.delete(slot._id);
    }

    if (mechanicBookings.length === 0) {
      // No bookings — block the entire day as a single slot
      await ctx.db.insert("time_slots", {
        shop_id: primary.shopId,
        mechanic_id: args.mechanicId,
        date: args.date,
        start_time: openTime,
        end_time: closeTime,
        is_available: false,
      });
    } else {
      // Block gaps around existing bookings
      // Sort bookings by start time
      const sorted = mechanicBookings.sort((a: any, b: any) =>
        a.scheduled_time < b.scheduled_time ? -1 : 1
      );

      // Build list of booked intervals
      const booked: Array<{ start: string; end: string }> = sorted.map((b: any) => ({
        start: b.scheduled_time,
        end: getBookingEndTime(
          b.scheduled_time,
          b.estimated_labor_minutes
        ),
      }));

      // Collect gaps: [openTime, first booking), (between bookings), (last booking, closeTime]
      const gaps: Array<{ start: string; end: string }> = [];
      let cursor = openTime;
      for (const interval of booked) {
        if (cursor < interval.start) {
          gaps.push({ start: cursor, end: interval.start });
        }
        // Advance cursor past this booking (take the later of cursor and booking end)
        if (interval.end > cursor) cursor = interval.end;
      }
      if (cursor < closeTime) {
        gaps.push({ start: cursor, end: closeTime });
      }

      for (const gap of gaps) {
        await ctx.db.insert("time_slots", {
          shop_id: primary.shopId,
          mechanic_id: args.mechanicId,
          date: args.date,
          start_time: gap.start,
          end_time: gap.end,
          is_available: false,
        });
      }
    }
  },
});

/** Copy all blocked slots from the given week to the following week. */
export const copyBlockedSlotsToNextWeek = mutation({
  args: {
    weekStartDate: v.string(), // YYYY-MM-DD of current week's Sunday
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) throw new Error("Not authenticated");

    const primary = await getPrimaryAuthorizedShop(ctx, user._id);
    if (!primary) throw new Error("Not authorized");

    // Compute date range for the current week (Sun–Sat)
    const start = new Date(args.weekStartDate + "T00:00:00");
    const endDate = new Date(start);
    endDate.setDate(endDate.getDate() + 6);
    const dateFrom = args.weekStartDate;
    const dateTo = endDate.toISOString().split("T")[0];

    // Get all time slots in this week
    const slots = await ctx.db
      .query("time_slots")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", primary.shopId))
      .collect();

    // Collect booking slot IDs to exclude them
    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", primary.shopId))
      .collect();
    const bookingSlotIds = new Set(bookings.map((b: any) => String(b.time_slot_id)));

    const blockedSlots = slots.filter(
      (s: any) =>
        s.date >= dateFrom &&
        s.date <= dateTo &&
        !s.is_available &&
        !bookingSlotIds.has(String(s._id))
    );

    // Get existing blocked slots for next week to avoid duplicates
    const nextStart = new Date(start);
    nextStart.setDate(nextStart.getDate() + 7);
    const nextEnd = new Date(nextStart);
    nextEnd.setDate(nextEnd.getDate() + 6);
    const nextDateFrom = nextStart.toISOString().split("T")[0];
    const nextDateTo = nextEnd.toISOString().split("T")[0];

    const nextWeekSlots = slots.filter(
      (s: any) =>
        s.date >= nextDateFrom &&
        s.date <= nextDateTo &&
        !s.is_available &&
        !bookingSlotIds.has(String(s._id))
    );

    let copied = 0;
    for (const slot of blockedSlots) {
      // Shift date by 7 days
      const slotDate = new Date(slot.date + "T00:00:00");
      slotDate.setDate(slotDate.getDate() + 7);
      const newDate = slotDate.toISOString().split("T")[0];

      // Check for duplicate (same mechanic, date, start_time, end_time)
      const isDuplicate = nextWeekSlots.some(
        (ns: any) =>
          ns.date === newDate &&
          ns.start_time === slot.start_time &&
          ns.end_time === slot.end_time &&
          String(ns.mechanic_id ?? "") === String(slot.mechanic_id ?? "")
      );
      if (isDuplicate) continue;

      await ctx.db.insert("time_slots", {
        shop_id: primary.shopId,
        ...(slot.mechanic_id ? { mechanic_id: slot.mechanic_id } : {}),
        date: newDate,
        start_time: slot.start_time,
        end_time: slot.end_time,
        is_available: false,
      });
      copied++;
    }

    return { copied };
  },
});

/** Returns service categories with their services for the shop.
 *  Uses shop_services (is_offered) when rows exist; falls back to all platform services otherwise. */
export const getShopServicesWithCategories = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return null;
    const primary = await getPrimaryAuthorizedShop(ctx, user._id);
    if (!primary) return null;

    const offered = await ctx.db
      .query("shop_services")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", primary.shopId))
      .filter((q: any) => q.eq(q.field("is_offered"), true))
      .collect();

    // Fall back to all platform services if this shop has no shop_services rows yet
    let serviceIds: string[];
    if (offered.length > 0) {
      serviceIds = offered.map((e: any) => e.service_id as string);
    } else {
      const all = await ctx.db.query("services").collect();
      serviceIds = all.map((s: any) => s._id as string);
    }

    const rows = (
      await Promise.all(
        serviceIds.map(async (sid) => {
          const service: any = await ctx.db.get(sid as any);
          if (!service) return null;
          const category: any = await ctx.db.get(service.service_category_id);
          return {
            _id: service._id as string,
            name: service.name as string,
            defaultLaborHours: (service.default_labor_hours ?? 1) as number,
            displayOrder: (service.display_order ?? 0) as number,
            categoryId: service.service_category_id as string,
            categoryName: (category?.name ?? "Other") as string,
            categoryDisplayOrder: (category?.display_order ?? 99) as number,
          };
        })
      )
    ).filter(Boolean) as Array<{
      _id: string; name: string; defaultLaborHours: number; displayOrder: number;
      categoryId: string; categoryName: string; categoryDisplayOrder: number;
    }>;

    const catMap = new Map<string, { id: string; name: string; displayOrder: number; services: typeof rows }>();
    for (const s of rows) {
      if (!catMap.has(s.categoryId)) {
        catMap.set(s.categoryId, { id: s.categoryId, name: s.categoryName, displayOrder: s.categoryDisplayOrder, services: [] });
      }
      catMap.get(s.categoryId)!.services.push(s);
    }

    const categories = Array.from(catMap.values())
      .sort((a, b) => a.displayOrder - b.displayOrder)
      .map((c) => ({ ...c, services: c.services.sort((a, b) => a.displayOrder - b.displayOrder) }));

    return { shopId: primary.shopId as string, categories };
  },
});
