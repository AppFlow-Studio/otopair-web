/* eslint-disable @typescript-eslint/no-explicit-any */
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/** Format "HH:MM" -> "10:00 AM" */
function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, "0")} ${ampm}`;
}

function toCanonicalVin(vin: string): string {
  return vin.trim().toUpperCase();
}

function addMinutes(hhmm: string, minutesToAdd: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const total = h * 60 + m + minutesToAdd;
  const hours = Math.floor(total / 60) % 24;
  const minutes = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

async function getCurrentUser(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");

  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) => q.eq("clerkUserId", identity.subject))
    .unique();

  if (!user) throw new Error("User not found");
  return user;
}

/** Non-throwing variant for queries that should return null when auth is not ready. */
async function getCurrentUserOrNull(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;

  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) => q.eq("clerkUserId", identity.subject))
    .unique();

  return user ?? null;
}

async function requireShopStaff(ctx: any, userId: any, shopId: any) {
  const shopUser = await ctx.db
    .query("shop_users")
    .withIndex("by_user_and_shop", (q: any) =>
      q.eq("user_id", userId).eq("shop_id", shopId)
    )
    .first();

  if (shopUser && shopUser.is_active) {
    return shopUser;
  }

  // Fallback: legacy owners may exist on shops.owner_user_id without a shop_users row.
  const ownedShop = await ctx.db
    .query("shops")
    .withIndex("by_owner_user_id", (q: any) => q.eq("owner_user_id", userId))
    .filter((q: any) => q.eq(q.field("_id"), shopId))
    .first();

  if (ownedShop) {
    return {
      user_id: userId,
      shop_id: shopId,
      role: "owner",
      is_active: true,
    };
  }

  throw new Error("Not authorized for this shop");
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

async function resolveVehicleLabel(ctx: any, vin: string): Promise<string> {
  const vehicle = await ctx.db
    .query("vehicles")
    .withIndex("by_vin", (q: any) => q.eq("vin", vin))
    .first();

  if (!vehicle) return vin;

  let makeName = "";
  let modelName = "";

  if (vehicle.trim_id) {
    const trim = await ctx.db.get(vehicle.trim_id);
    if (trim) {
      const model = await ctx.db.get(trim.model_id);
      if (model) {
        modelName = model.name;
        const make = await ctx.db.get(model.make_id);
        if (make) makeName = make.name;
      }
    }
  }

  if (!makeName && vehicle.metadata?.make) makeName = String(vehicle.metadata.make);
  if (!modelName && vehicle.metadata?.model) modelName = String(vehicle.metadata.model);

  return [vehicle.year, makeName, modelName].filter(Boolean).join(" ") || vin;
}

async function resolveServiceNames(ctx: any, serviceIds?: Array<any>) {
  if (!serviceIds || serviceIds.length === 0) return [] as string[];
  const names = await Promise.all(
    serviceIds.map(async (serviceId) => {
      const service = await ctx.db.get(serviceId);
      return service?.name ?? "Unknown Service";
    })
  );
  return names;
}

async function getOrCreateSlot(
  ctx: any,
  shopId: any,
  mechanicId: any,
  date: string,
  startTime: string,
  durationMinutes: number
) {
  const endTime = addMinutes(startTime, durationMinutes);
  const slots = await ctx.db
    .query("time_slots")
    .withIndex("by_shop_and_date", (q: any) => q.eq("shop_id", shopId).eq("date", date))
    .collect();

  const existing = slots.find(
    (slot: any) =>
      slot.start_time === startTime &&
      slot.end_time === endTime &&
      (slot.mechanic_id ?? null) === (mechanicId ?? null)
  );

  if (existing) {
    if (existing.is_available) {
      await ctx.db.patch(existing._id, { is_available: false });
    }
    return existing._id;
  }

  return await ctx.db.insert("time_slots", {
    date,
    end_time: endTime,
    is_available: false,
    mechanic_id: mechanicId,
    shop_id: shopId,
    start_time: startTime,
  });
}

async function logBookingStatusChange(
  ctx: any,
  bookingId: any,
  oldStatus: string | undefined,
  newStatus: string,
  changedBy: any,
  reason?: string
) {
  await ctx.db.insert("booking_status_history", {
    booking_id: bookingId,
    old_status: oldStatus,
    new_status: newStatus,
    changed_by: changedBy,
    reason,
    changed_at: Date.now(),
  });
}

/**
 * Returns all pending bookings for a shop (status "pending" or
 * "pending_shop_acceptance") for the Pending dashboard card.
 */
export const getPendingJobsByShop = query({
  args: { shopId: v.id("shops") },
  handler: async (ctx, args) => {
    const allPending = await Promise.all([
      ctx.db
        .query("bookings")
        .withIndex("by_shop_and_status", (q) =>
          q.eq("shop_id", args.shopId).eq("status", "pending")
        )
        .order("desc")
        .collect(),
      ctx.db
        .query("bookings")
        .withIndex("by_shop_and_status", (q) =>
          q.eq("shop_id", args.shopId).eq("status", "pending_shop_acceptance")
        )
        .order("desc")
        .collect(),
    ]);

    const bookings = [...allPending[0], ...allPending[1]].sort(
      (a, b) => b.created_at - a.created_at
    );

    return await Promise.all(
      bookings.map(async (booking) => {
        const user = await ctx.db.get(booking.user_id);
        const firstName = user?.first_name ?? "";
        const lastName = user?.last_name ?? "";
        const customerName =
          `${firstName} ${lastName}`.trim() || user?.email || "Unknown";

        const vehicleLabel = await resolveVehicleLabel(ctx, booking.vin);

        let serviceName = "";
        if (booking.service_ids && booking.service_ids.length > 0) {
          const svc = await ctx.db.get(booking.service_ids[0]);
          if (svc) serviceName = svc.name;
          if (booking.service_ids.length > 1)
            serviceName += ` +${booking.service_ids.length - 1}`;
        }

        const createdAt = booking.created_at;
        const seconds = Math.floor((Date.now() - createdAt) / 1000);
        let ago = "just now";
        if (seconds >= 86400) ago = `${Math.floor(seconds / 86400)}d ago`;
        else if (seconds >= 3600) ago = `${Math.floor(seconds / 3600)}h ago`;
        else if (seconds >= 60) ago = `${Math.floor(seconds / 60)}m ago`;

        return {
          _id: booking._id,
          customerName,
          vehicle: vehicleLabel,
          service: serviceName,
          ago,
          scheduledTime: booking.scheduled_time ?? "",
        };
      })
    );
  },
});

/**
 * Returns a map of mechanic_id → active job count for the Team Status card.
 * Used to show real "On a Job" / "Available" status per team member.
 */
export const getMechanicStatuses = query({
  args: { shopId: v.id("shops") },
  handler: async (ctx, args) => {
    const active = await ctx.db
      .query("bookings")
      .withIndex("by_shop_and_status", (q) =>
        q.eq("shop_id", args.shopId).eq("status", "in_progress")
      )
      .collect();
    const counts: Record<string, number> = {};
    for (const b of active) {
      if (b.mechanic_id) {
        counts[b.mechanic_id] = (counts[b.mechanic_id] ?? 0) + 1;
      }
    }
    return counts;
  },
});

/**
 * Returns all in_progress bookings for a shop, with joined customer, vehicle,
 * service, and mechanic data for the Active Jobs dashboard card.
 */
export const getActiveJobsByShop = query({
  args: { shopId: v.id("shops") },
  handler: async (ctx, args) => {
    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_shop_and_status", (q) =>
        q.eq("shop_id", args.shopId).eq("status", "in_progress")
      )
      .order("desc")
      .collect();

    return await Promise.all(
      bookings.map(async (booking) => {
        const user = await ctx.db.get(booking.user_id);
        const firstName = user?.first_name ?? "";
        const lastName = user?.last_name ?? "";
        const customerName =
          `${firstName} ${lastName}`.trim() || user?.email || "Unknown";

        const vehicleLabel = await resolveVehicleLabel(ctx, booking.vin);

        let serviceName = "";
        if (booking.service_ids && booking.service_ids.length > 0) {
          const svc = await ctx.db.get(booking.service_ids[0]);
          if (svc) serviceName = svc.name;
          if (booking.service_ids.length > 1)
            serviceName += ` +${booking.service_ids.length - 1}`;
        }

        let mechanicName: string | null = null;
        if (booking.mechanic_id) {
          const mech = await ctx.db.get(booking.mechanic_id);
          if (mech) mechanicName = `${mech.first_name} ${mech.last_name[0]}.`.trim();
        }

        return {
          _id: booking._id,
          customerName,
          vehicle: vehicleLabel,
          service: serviceName,
          liveStage: booking.live_stage ?? null,
          mechanicName,
        };
      })
    );
  },
});

/**
 * Returns all confirmed bookings scheduled for today for a shop, with joined
 * customer, vehicle, and service data for the Today's Bookings dashboard card.
 */
export const getTodaysBookingsByShop = query({
  args: { shopId: v.id("shops") },
  handler: async (ctx, args) => {
    const today = new Date().toISOString().split("T")[0];

    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_shop_and_date", (q) =>
        q.eq("shop_id", args.shopId).eq("scheduled_date", today)
      )
      .filter((q) => q.eq(q.field("status"), "confirmed"))
      .collect();

    bookings.sort((a, b) => a.scheduled_time.localeCompare(b.scheduled_time));

    return await Promise.all(
      bookings.map(async (booking) => {
        const user = await ctx.db.get(booking.user_id);
        const firstName = user?.first_name ?? "";
        const lastName = user?.last_name ?? "";
        const fullName =
          `${firstName} ${lastName}`.trim() || user?.email || "Unknown";
        const initials =
          `${firstName[0] ?? ""}${lastName[0] ?? ""}`.toUpperCase() || "?";

        const vehicleLabel = await resolveVehicleLabel(ctx, booking.vin);

        let serviceName = "";
        if (booking.service_ids && booking.service_ids.length > 0) {
          const svc = await ctx.db.get(booking.service_ids[0]);
          if (svc) serviceName = svc.name;
          if (booking.service_ids.length > 1)
            serviceName += ` +${booking.service_ids.length - 1}`;
        }

        return {
          _id: booking._id,
          customerName: fullName,
          initials,
          vehicle: vehicleLabel,
          service: serviceName,
          scheduledTime: formatTime(booking.scheduled_time),
        };
      })
    );
  },
});

/** Convenience query for shop staff creating and managing jobs. */
export const getMyShopJobContext = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return null;

    const primary = await getPrimaryAuthorizedShop(ctx, user._id);
    if (!primary) return null;

    const shop = await ctx.db.get(primary.shopId);
    if (!shop) return null;

    const mechanics = await ctx.db
      .query("mechanics")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shop._id))
      .collect();

    const offered = await ctx.db
      .query("shop_services")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shop._id))
      .filter((q: any) => q.eq(q.field("is_offered"), true))
      .collect();

    const services = await Promise.all(
      offered.map(async (entry: any) => {
        const service = await ctx.db.get(entry.service_id);
        return service
          ? {
              _id: service._id,
              name: service.name,
              isLaborOnly: service.is_labor_only,
              defaultLaborHours: service.default_labor_hours,
            }
          : null;
      })
    );

    return {
      shopId: shop._id,
      shopName: shop.name,
      userRole: primary.role,
      mechanics: mechanics.map((m: any) => ({
        _id: m._id,
        name: `${m.first_name} ${m.last_name}`.trim(),
        isActive: m.is_active,
      })),
      services: services.filter(Boolean),
    };
  },
});

/** List jobs/bookings for the signed-in staff user's primary shop. */
export const listForMyShop = query({
  args: { status: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return [];

    const primary = await getPrimaryAuthorizedShop(ctx, user._id);
    if (!primary) return [];
    const shopId = primary.shopId;

    let bookings = await ctx.db
      .query("bookings")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", shopId))
      .collect();

    if (args.status) {
      bookings = bookings.filter((b) => b.status === args.status);
    }

    bookings.sort((a, b) => {
      const dateCompare = a.scheduled_date.localeCompare(b.scheduled_date);
      if (dateCompare !== 0) return dateCompare;
      return a.scheduled_time.localeCompare(b.scheduled_time);
    });

    return await Promise.all(
      bookings.map(async (booking) => {
        const customer = await ctx.db.get(booking.user_id);
        const customerName =
          `${customer?.first_name ?? ""} ${customer?.last_name ?? ""}`.trim() ||
          customer?.email ||
          "Unknown";

        const vehicle = await resolveVehicleLabel(ctx, booking.vin);
        const serviceNames = await resolveServiceNames(ctx, booking.service_ids);
        const mechanic = booking.mechanic_id
          ? await ctx.db.get(booking.mechanic_id)
          : null;

        return {
          _id: booking._id,
          status: booking.status,
          scheduledDate: booking.scheduled_date,
          scheduledTime: booking.scheduled_time,
          customerName,
          customerEmail: customer?.email ?? "",
          vehicle,
          serviceNames,
          laborCost: booking.labor_cost,
          partsCost: booking.parts_cost,
          totalCost: booking.total_cost,
          estimatedLaborMinutes: booking.estimated_labor_minutes ?? null,
          mechanicName: mechanic
            ? `${mechanic.first_name} ${mechanic.last_name}`.trim()
            : null,
        };
      })
    );
  },
});

/** Detailed booking view for status transitions + assignment. */
export const getJobDetail = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) return null;

    await requireShopStaff(ctx, user._id, booking.shop_id);

    const customer = await ctx.db.get(booking.user_id);
    const vehicle = await resolveVehicleLabel(ctx, booking.vin);
    const serviceNames = await resolveServiceNames(ctx, booking.service_ids);
    const mechanic = booking.mechanic_id
      ? await ctx.db.get(booking.mechanic_id)
      : null;

    const history = await ctx.db
      .query("booking_status_history")
      .withIndex("by_booking_id", (q: any) => q.eq("booking_id", booking._id))
      .collect();

    history.sort((a: any, b: any) => b.changed_at - a.changed_at);

    return {
      _id: booking._id,
      shopId: booking.shop_id,
      status: booking.status,
      liveStage: booking.live_stage ?? null,
      scheduledDate: booking.scheduled_date,
      scheduledTime: booking.scheduled_time,
      laborCost: booking.labor_cost,
      partsCost: booking.parts_cost,
      totalCost: booking.total_cost,
      estimatedLaborMinutes: booking.estimated_labor_minutes ?? null,
      vin: booking.vin,
      serviceIds: booking.service_ids ?? [],
      mechanicId: booking.mechanic_id ?? null,
      customerName:
        `${customer?.first_name ?? ""} ${customer?.last_name ?? ""}`.trim() ||
        customer?.email ||
        "Unknown",
      customerEmail: customer?.email ?? "",
      vehicle,
      serviceNames,
      mechanicName: mechanic
        ? `${mechanic.first_name} ${mechanic.last_name}`.trim()
        : null,
      history,
    };
  },
});

/** Job CRUD: create (shop-initiated). */
export const create = mutation({
  args: {
    shopId: v.id("shops"),
    customerEmail: v.string(),
    customerFirstName: v.optional(v.string()),
    customerLastName: v.optional(v.string()),
    vin: v.string(),
    vehicleYear: v.optional(v.float64()),
    vehicleMake: v.optional(v.string()),
    vehicleModel: v.optional(v.string()),
    scheduledDate: v.string(),
    scheduledTime: v.string(),
    serviceIds: v.array(v.id("services")),
    mechanicId: v.optional(v.id("mechanics")),
    laborCost: v.float64(),
    partsCost: v.float64(),
    estimatedLaborMinutes: v.optional(v.float64()),
    status: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    await requireShopStaff(ctx, user._id, args.shopId);

    const now = Date.now();
    const canonicalVin = toCanonicalVin(args.vin);

    let customer = await ctx.db
      .query("users")
      .withIndex("by_email", (q: any) => q.eq("email", args.customerEmail))
      .first();

    if (!customer) {
      const randomSuffix = Math.random().toString(36).slice(2, 8);
      const customerId = await ctx.db.insert("users", {
        clerkUserId: `shop-created-${now}-${randomSuffix}`,
        createdAt: now,
        onboardingCompleted: false,
        email: args.customerEmail,
        first_name: args.customerFirstName,
        last_name: args.customerLastName,
      });
      customer = await ctx.db.get(customerId);
    }

    if (!customer) throw new Error("Could not create customer");

    const existingVehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q: any) => q.eq("vin", canonicalVin))
      .first();

    if (!existingVehicle) {
      await ctx.db.insert("vehicles", {
        vin: canonicalVin,
        year: args.vehicleYear,
        metadata: {
          make: args.vehicleMake,
          model: args.vehicleModel,
        },
        created_at: now,
        updated_at: now,
      });
    }

    const ownerLink = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_vin_user", (q: any) =>
        q.eq("vin", canonicalVin).eq("user_id", customer!._id)
      )
      .first();

    if (!ownerLink) {
      await ctx.db.insert("vehicle_owners", {
        vin: canonicalVin,
        user_id: customer._id,
        status: "active",
        is_primary: true,
        added_at: now,
      });
    }

    const estimatedMinutes = args.estimatedLaborMinutes ?? 60;
    const timeSlotId = await getOrCreateSlot(
      ctx,
      args.shopId,
      args.mechanicId ?? undefined,
      args.scheduledDate,
      args.scheduledTime,
      estimatedMinutes
    );

    const status = args.status ?? "pending_shop_acceptance";
    const totalCost = args.laborCost + args.partsCost;

    const bookingId = await ctx.db.insert("bookings", {
      labor_cost: args.laborCost,
      parts_cost: args.partsCost,
      total_cost: totalCost,
      estimated_labor_minutes: args.estimatedLaborMinutes,
      mechanic_id: args.mechanicId,
      scheduled_date: args.scheduledDate,
      scheduled_time: args.scheduledTime,
      service_ids: args.serviceIds,
      shop_id: args.shopId,
      status,
      time_slot_id: timeSlotId,
      user_id: customer._id,
      vin: canonicalVin,
      created_at: now,
      updated_at: now,
    });

    await logBookingStatusChange(
      ctx,
      bookingId,
      undefined,
      status,
      user._id,
      "job_created_by_shop"
    );

    return bookingId;
  },
});

/** Job CRUD: update details (including mechanic assignment). */
export const update = mutation({
  args: {
    bookingId: v.id("bookings"),
    scheduledDate: v.optional(v.string()),
    scheduledTime: v.optional(v.string()),
    serviceIds: v.optional(v.array(v.id("services"))),
    mechanicId: v.optional(v.union(v.id("mechanics"), v.null())),
    laborCost: v.optional(v.float64()),
    partsCost: v.optional(v.float64()),
    estimatedLaborMinutes: v.optional(v.float64()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");

    await requireShopStaff(ctx, user._id, booking.shop_id);

    const patch: any = { updated_at: Date.now() };

    if (args.serviceIds) patch.service_ids = args.serviceIds;
    if (args.mechanicId !== undefined) {
      patch.mechanic_id = args.mechanicId === null ? undefined : args.mechanicId;
    }
    if (args.estimatedLaborMinutes !== undefined)
      patch.estimated_labor_minutes = args.estimatedLaborMinutes;

    const laborCost = args.laborCost ?? booking.labor_cost;
    const partsCost = args.partsCost ?? booking.parts_cost;
    if (args.laborCost !== undefined) patch.labor_cost = args.laborCost;
    if (args.partsCost !== undefined) patch.parts_cost = args.partsCost;
    if (args.laborCost !== undefined || args.partsCost !== undefined) {
      patch.total_cost = laborCost + partsCost;
    }

    if (args.scheduledDate || args.scheduledTime || args.mechanicId !== undefined) {
      const newDate = args.scheduledDate ?? booking.scheduled_date;
      const newTime = args.scheduledTime ?? booking.scheduled_time;
      const newMechanic =
        args.mechanicId === undefined
          ? booking.mechanic_id
          : args.mechanicId === null
            ? undefined
            : args.mechanicId;

      const slotId = await getOrCreateSlot(
        ctx,
        booking.shop_id,
        newMechanic,
        newDate,
        newTime,
        args.estimatedLaborMinutes ?? booking.estimated_labor_minutes ?? 60
      );
      patch.time_slot_id = slotId;
      patch.scheduled_date = newDate;
      patch.scheduled_time = newTime;
    }

    await ctx.db.patch(args.bookingId, patch);
    return args.bookingId;
  },
});

/** Job CRUD: accept pending booking — moves it directly into active/in_progress state. */
export const accept = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");

    await requireShopStaff(ctx, user._id, booking.shop_id);

    const pendingStates = ["pending", "pending_shop_acceptance"];
    if (!pendingStates.includes(booking.status)) {
      throw new Error("Only pending jobs can be accepted");
    }

    await ctx.db.patch(booking._id, {
      status: "in_progress",
      live_stage: "service_in_progress",
      updated_at: Date.now(),
    });
    await logBookingStatusChange(
      ctx,
      booking._id,
      booking.status,
      "in_progress",
      user._id,
      "accepted_by_shop"
    );

    return booking._id;
  },
});

/** Job CRUD: mark booking completed. */
export const complete = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");

    await requireShopStaff(ctx, user._id, booking.shop_id);

    await ctx.db.patch(booking._id, {
      status: "completed",
      live_stage: "vehicle_ready",
      updated_at: Date.now(),
    });
    await logBookingStatusChange(
      ctx,
      booking._id,
      booking.status,
      "completed",
      user._id,
      "completed_by_shop"
    );

    return booking._id;
  },
});

/** Job CRUD: cancel booking (owner-side cancellation/decline path). */
export const cancel = mutation({
  args: {
    bookingId: v.id("bookings"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");

    await requireShopStaff(ctx, user._id, booking.shop_id);

    await ctx.db.patch(booking._id, {
      status: "cancelled",
      updated_at: Date.now(),
    });
    await logBookingStatusChange(
      ctx,
      booking._id,
      booking.status,
      "cancelled",
      user._id,
      args.reason ?? "cancelled_by_shop"
    );

    return booking._id;
  },
});
