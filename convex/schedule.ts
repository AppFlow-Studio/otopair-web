import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getLateStartTimingConfig } from "./lib/late_start";
import {
  getBookingEndTime,
  overlapsBlockedSlot,
  overlapsMechanicBooking,
} from "./lib/schedule_overlap";
import {
  getActiveMechanicsForShop,
  syncMechanicDayAvailability,
  syncShopAvailabilityWindow,
} from "./lib/timeSlotAvailability";

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

async function resolveMechanicPhotoUrl(ctx: any, photo?: string | null) {
  if (!photo) return null;

  try {
    const asset = await ctx.db.get(photo as any);
    if (asset?.url) return asset.url as string;
  } catch {
    // New mechanic uploads store Convex storage ids directly.
  }

  try {
    return await ctx.storage.getUrl(photo);
  } catch {
    return null;
  }
}

async function getShopBookings(ctx: any, shopId: any) {
  return await ctx.db
    .query("bookings")
    .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shopId))
    .collect();
}

async function getManualBlockedSlotsForShop(ctx: any, shopId: any) {
  const slots = await ctx.db
    .query("time_slots")
    .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shopId))
    .collect();
  const bookings = await getShopBookings(ctx, shopId);
  const bookingSlotIds = new Set(
    bookings.filter((booking: any) => booking.time_slot_id).map((booking: any) => String(booking.time_slot_id))
  );
  return slots.filter(
    (slot: any) => !slot.is_available && !bookingSlotIds.has(String(slot._id))
  );
}

async function getMechanicIdsForBlock(ctx: any, shopId: any, mechanicId?: any) {
  if (mechanicId) return [mechanicId];
  const activeMechanics = await getActiveMechanicsForShop(ctx, shopId);
  return activeMechanics.map((mechanic: any) => mechanic._id);
}

async function assertNoWindowConflicts(
  ctx: any,
  {
    shopId,
    mechanicId,
    date,
    startTime,
    endTime,
    excludeSlotId,
    excludeBookingId,
  }: {
    shopId: any;
    mechanicId: any;
    date: string;
    startTime: string;
    endTime: string;
    excludeSlotId?: string;
    excludeBookingId?: string;
  }
) {
  const bookings = await getShopBookings(ctx, shopId);
  const manualBlockedSlots = await getManualBlockedSlotsForShop(ctx, shopId);

  const bookingConflict = overlapsMechanicBooking(
    String(mechanicId),
    date,
    startTime,
    endTime,
    bookings.map((booking: any) => ({
      _id: String(booking._id),
      scheduledDate: booking.scheduled_date,
      scheduledTime: booking.scheduled_time,
      estimatedMinutes: booking.estimated_labor_minutes ?? 60,
      status: booking.status,
      mechanicId: booking.mechanic_id ? String(booking.mechanic_id) : null,
    })),
    excludeBookingId
  );
  if (bookingConflict) {
    throw new Error("Cannot block a slot that overlaps an existing booking");
  }

  const blockedConflict = overlapsBlockedSlot(
    String(mechanicId),
    date,
    startTime,
    endTime,
    manualBlockedSlots.map((slot: any) => ({
      _id: String(slot._id),
      date: slot.date,
      startTime: slot.start_time,
      endTime: slot.end_time,
      mechanicId: slot.mechanic_id ? String(slot.mechanic_id) : null,
    })),
    excludeSlotId
  );
  if (blockedConflict) {
    throw new Error("Cannot add blocked time onto a time already blocked");
  }
}

export const getScheduleContext = query({
  args: {},
  handler: async (ctx) => {
    const lateStartTiming = getLateStartTimingConfig();
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
          q.eq(q.field("is_active"), true),
          q.or(
            q.eq(q.field("role"), "shop_mechanic"),
            q.eq(q.field("role"), "mechanic")
          )
        )
      )
      .collect();

    const acceptedMechanicIds = new Set(
      mechanicShopUsers.map((shopUser: any) => String(shopUser.mechanic_id))
    );

    const mechanics = allMechanics.filter((mechanic: any) =>
      acceptedMechanicIds.has(String(mechanic._id))
    );

    return {
      shopId: shop._id,
      shopName: shop.name,
      lateStartTestMode: lateStartTiming.testMode,
      lateStartTiming: {
        warningLeadMinutes: lateStartTiming.warningLeadMinutes,
        initialCycleMinutes: lateStartTiming.initialCycleMinutes,
        cycleIncrementMinutes: lateStartTiming.cycleIncrementMinutes,
      },
      hours: hours.map((hour: any) => ({
        _id: hour._id,
        dayOfWeek: hour.day_of_week,
        dayName: hour.day_name,
        openTime: hour.open_time ?? "09:00",
        closeTime: hour.close_time ?? "17:00",
        isClosed: hour.is_closed ?? false,
      })),
      mechanics: await Promise.all(
        mechanics.map(async (mechanic: any) => {
          const imageUrl = await resolveMechanicPhotoUrl(ctx, mechanic.photo);
          return {
            _id: mechanic._id,
            name: `${mechanic.first_name} ${mechanic.last_name}`.trim(),
            firstName: mechanic.first_name,
            lastName: mechanic.last_name,
            title: mechanic.title ?? null,
            imageUrl,
          };
        })
      ),
    };
  },
});

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

    const bookings = await getShopBookings(ctx, primary.shopId);
    const filtered = bookings.filter(
      (booking: any) =>
        booking.scheduled_date >= args.dateFrom &&
        booking.scheduled_date <= args.dateTo &&
        booking.status !== "cancelled" &&
        booking.status !== "declined"
    );

    return await Promise.all(
      filtered.map(async (booking: any) => {
        const customer: any = await ctx.db.get(booking.user_id);
        const mechanic: any = booking.mechanic_id
          ? await ctx.db.get(booking.mechanic_id)
          : null;

        return {
          _id: booking._id,
          scheduledDate: booking.scheduled_date,
          scheduledTime: booking.scheduled_time,
          estimatedMinutes: booking.estimated_labor_minutes ?? 60,
          status: booking.status,
          customerName:
            `${customer?.first_name ?? ""} ${customer?.last_name ?? ""}`.trim() ||
            customer?.email ||
            "Unknown",
          mechanicId: booking.mechanic_id ?? null,
          mechanicName: mechanic
            ? `${mechanic.first_name} ${mechanic.last_name}`.trim()
            : null,
          serviceNames: await resolveServiceNames(ctx, booking.service_ids),
          totalCost: booking.total_cost,
          scheduleChangeMode: booking.schedule_change_mode ?? "manual_reschedule",
          customerCanRestoreOriginal: booking.customer_can_restore_original !== false,
          scheduleChangeSourceBookingId:
            booking.schedule_change_source_booking_id ?? null,
        };
      })
    );
  },
});

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

    return types.map((type: any) => ({ _id: type._id, title: type.title }));
  },
});

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

export const saveBlockTimeType = mutation({
  args: { title: v.string() },
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) throw new Error("Not authenticated");

    const primary = await getPrimaryAuthorizedShop(ctx, user._id);
    if (!primary) throw new Error("Not authorized");

    const existing = await ctx.db
      .query("block_time_types")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", primary.shopId))
      .collect();
    const duplicate = existing.find(
      (type: any) => type.title.toLowerCase() === args.title.toLowerCase()
    );
    if (duplicate) return duplicate._id;

    return await ctx.db.insert("block_time_types", {
      shop_id: primary.shopId,
      title: args.title,
    });
  },
});

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

    const slots = await getManualBlockedSlotsForShop(ctx, primary.shopId);

    return slots
      .filter((slot: any) => slot.date >= args.dateFrom && slot.date <= args.dateTo)
      .map((slot: any) => ({
        _id: slot._id,
        date: slot.date,
        startTime: slot.start_time,
        endTime: slot.end_time,
        mechanicId: slot.mechanic_id,
        title: slot.title ?? null,
        note: slot.note ?? null,
      }));
  },
});

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
    await syncShopAvailabilityWindow(ctx, { shopId: primary.shopId });
  },
});

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

    const mechanicIds = await getMechanicIdsForBlock(ctx, primary.shopId, args.mechanicId);
    if (mechanicIds.length === 0) {
      throw new Error("No active mechanics available for this shop");
    }

    for (const mechanicId of mechanicIds) {
      await assertNoWindowConflicts(ctx, {
        shopId: primary.shopId,
        mechanicId,
        date: args.date,
        startTime: args.startTime,
        endTime: args.endTime,
      });

      await ctx.db.insert("time_slots", {
        shop_id: primary.shopId,
        mechanic_id: mechanicId,
        date: args.date,
        start_time: args.startTime,
        end_time: args.endTime,
        is_available: false,
        ...(args.title ? { title: args.title } : {}),
        ...(args.note ? { note: args.note } : {}),
      });

      await syncMechanicDayAvailability(ctx, {
        shopId: primary.shopId,
        mechanicId,
        date: args.date,
      });
    }
  },
});

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

    const nextMechanicId = args.mechanicId ?? slot.mechanic_id;
    await assertNoWindowConflicts(ctx, {
      shopId: primary.shopId,
      mechanicId: nextMechanicId,
      date: args.date,
      startTime: args.startTime,
      endTime: args.endTime,
      excludeSlotId: String(args.slotId),
    });

    const previousMechanicId = slot.mechanic_id;
    const previousDate = slot.date;

    await ctx.db.patch(args.slotId, {
      mechanic_id: nextMechanicId,
      date: args.date,
      start_time: args.startTime,
      end_time: args.endTime,
      title: args.title ?? undefined,
      note: args.note ?? undefined,
    });

    await syncMechanicDayAvailability(ctx, {
      shopId: primary.shopId,
      mechanicId: nextMechanicId,
      date: args.date,
    });

    if (
      String(previousMechanicId) !== String(nextMechanicId) ||
      previousDate !== args.date
    ) {
      await syncMechanicDayAvailability(ctx, {
        shopId: primary.shopId,
        mechanicId: previousMechanicId,
        date: previousDate,
      });
    }
  },
});

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

    const mechanicId = slot.mechanic_id;
    const date = slot.date;
    await ctx.db.delete(args.slotId);
    await syncMechanicDayAvailability(ctx, {
      shopId: primary.shopId,
      mechanicId,
      date,
    });
  },
});

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

    const dayDate = new Date(`${args.date}T00:00:00`);
    const dayOfWeek = dayDate.getDay();

    const hours = await ctx.db
      .query("shops_hours")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", primary.shopId))
      .collect();
    const dayHours = hours.find((hour: any) => hour.day_of_week === dayOfWeek);
    if (dayHours?.is_closed) throw new Error("Shop is closed on this day");

    const openTime = dayHours?.open_time ?? "00:00";
    const closeTime = dayHours?.close_time ?? "24:00";

    const allBookings = await getShopBookings(ctx, primary.shopId);
    const mechanicBookings = allBookings
      .filter(
        (booking: any) =>
          booking.scheduled_date === args.date &&
          booking.mechanic_id &&
          String(booking.mechanic_id) === String(args.mechanicId) &&
          booking.status !== "cancelled" &&
          booking.status !== "declined"
      )
      .sort((a: any, b: any) =>
        a.scheduled_time.localeCompare(b.scheduled_time)
      );

    if (mechanicBookings.length > 0 && !args.force) {
      throw new Error("This mechanic already has bookings on that day");
    }

    const existingManualBlocks = await getManualBlockedSlotsForShop(ctx, primary.shopId);
    for (const slot of existingManualBlocks) {
      if (
        slot.date === args.date &&
        String(slot.mechanic_id) === String(args.mechanicId)
      ) {
        await ctx.db.delete(slot._id);
      }
    }

    if (mechanicBookings.length === 0) {
      await ctx.db.insert("time_slots", {
        shop_id: primary.shopId,
        mechanic_id: args.mechanicId,
        date: args.date,
        start_time: openTime,
        end_time: closeTime,
        is_available: false,
      });
    } else {
      const bookedIntervals = mechanicBookings.map((booking: any) => ({
        start: booking.scheduled_time,
        end: getBookingEndTime(
          booking.scheduled_time,
          booking.estimated_labor_minutes
        ),
      }));

      const gaps: Array<{ start: string; end: string }> = [];
      let cursor = openTime;
      for (const interval of bookedIntervals) {
        if (cursor < interval.start) {
          gaps.push({ start: cursor, end: interval.start });
        }
        if (interval.end > cursor) {
          cursor = interval.end;
        }
      }
      if (cursor < closeTime) {
        gaps.push({ start: cursor, end: closeTime });
      }

      for (const gap of gaps) {
        if (gap.start >= gap.end) continue;
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

    await syncMechanicDayAvailability(ctx, {
      shopId: primary.shopId,
      mechanicId: args.mechanicId,
      date: args.date,
    });
  },
});

export const copyBlockedSlotsToNextWeek = mutation({
  args: {
    weekStartDate: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) throw new Error("Not authenticated");

    const primary = await getPrimaryAuthorizedShop(ctx, user._id);
    if (!primary) throw new Error("Not authorized");

    const start = new Date(`${args.weekStartDate}T00:00:00`);
    const endDate = new Date(start);
    endDate.setDate(endDate.getDate() + 6);
    const dateFrom = args.weekStartDate;
    const dateTo = endDate.toISOString().split("T")[0];

    const blockedSlots = (await getManualBlockedSlotsForShop(ctx, primary.shopId)).filter(
      (slot: any) => slot.date >= dateFrom && slot.date <= dateTo
    );

    const nextStart = new Date(start);
    nextStart.setDate(nextStart.getDate() + 7);
    const nextEnd = new Date(nextStart);
    nextEnd.setDate(nextEnd.getDate() + 6);
    const nextDateFrom = nextStart.toISOString().split("T")[0];
    const nextDateTo = nextEnd.toISOString().split("T")[0];

    const nextWeekSlots = (await getManualBlockedSlotsForShop(ctx, primary.shopId)).filter(
      (slot: any) => slot.date >= nextDateFrom && slot.date <= nextDateTo
    );

    let copied = 0;
    const affected = new Set<string>();
    for (const slot of blockedSlots) {
      const slotDate = new Date(`${slot.date}T00:00:00`);
      slotDate.setDate(slotDate.getDate() + 7);
      const newDate = slotDate.toISOString().split("T")[0];

      const isDuplicate = nextWeekSlots.some(
        (nextSlot: any) =>
          nextSlot.date === newDate &&
          nextSlot.start_time === slot.start_time &&
          nextSlot.end_time === slot.end_time &&
          String(nextSlot.mechanic_id) === String(slot.mechanic_id)
      );
      if (isDuplicate) continue;

      await ctx.db.insert("time_slots", {
        shop_id: primary.shopId,
        mechanic_id: slot.mechanic_id,
        date: newDate,
        start_time: slot.start_time,
        end_time: slot.end_time,
        is_available: false,
        title: slot.title ?? undefined,
        note: slot.note ?? undefined,
      });
      copied += 1;
      affected.add(`${String(slot.mechanic_id)}:${newDate}`);
    }

    for (const item of affected) {
      const [mechanicId, date] = item.split(":");
      await syncMechanicDayAvailability(ctx, {
        shopId: primary.shopId,
        mechanicId,
        date,
      });
    }

    return { copied };
  },
});

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

    let serviceIds: string[];
    if (offered.length > 0) {
      serviceIds = offered.map((entry: any) => entry.service_id as string);
    } else {
      const allServices = await ctx.db.query("services").collect();
      serviceIds = allServices.map((service: any) => service._id as string);
    }

    const rows = (
      await Promise.all(
        serviceIds.map(async (serviceId) => {
          const service: any = await ctx.db.get(serviceId as any);
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
      _id: string;
      name: string;
      defaultLaborHours: number;
      displayOrder: number;
      categoryId: string;
      categoryName: string;
      categoryDisplayOrder: number;
    }>;

    const categoryMap = new Map<
      string,
      {
        id: string;
        name: string;
        displayOrder: number;
        services: typeof rows;
      }
    >();

    for (const service of rows) {
      if (!categoryMap.has(service.categoryId)) {
        categoryMap.set(service.categoryId, {
          id: service.categoryId,
          name: service.categoryName,
          displayOrder: service.categoryDisplayOrder,
          services: [],
        });
      }
      categoryMap.get(service.categoryId)!.services.push(service);
    }

    const categories = Array.from(categoryMap.values())
      .sort((a, b) => a.displayOrder - b.displayOrder)
      .map((category) => ({
        ...category,
        services: category.services.sort((a, b) => a.displayOrder - b.displayOrder),
      }));

    return { shopId: primary.shopId as string, categories };
  },
});
