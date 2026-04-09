/* eslint-disable @typescript-eslint/no-explicit-any */
import { mutation, query, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import {
  addMinutesToHHMM,
  getBookingEndTime,
  overlapsBlockedSlot,
  overlapsMechanicBooking,
} from "../lib/schedule-overlap";

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

const RESERVED_PENDING_CUSTOMER_TITLE = "Reserved pending customer approval";

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

async function resolveVehicleLabel(
  ctx: any,
  vin: string
): Promise<{ full: string; short: string }> {
  const vehicle = await ctx.db
    .query("vehicles")
    .withIndex("by_vin", (q: any) => q.eq("vin", vin))
    .first();

  if (!vehicle) return { full: vin, short: vin };

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

  const full = [vehicle.year, makeName, modelName].filter(Boolean).join(" ") || vin;
  const makeAbbr = makeName ? `${makeName[0]}.` : "";
  const short = [vehicle.year, makeAbbr, modelName].filter(Boolean).join(" ") || vin;
  return { full, short };
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

function getTodayString() {
  return new Date().toISOString().slice(0, 10);
}

function getDateOffsetString(offsetDays: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function compareBookingsBySchedule(a: any, b: any) {
  const dateCompare = a.scheduled_date.localeCompare(b.scheduled_date);
  if (dateCompare !== 0) return dateCompare;
  return a.scheduled_time.localeCompare(b.scheduled_time);
}

function formatCustomerName(customer: any) {
  return (
    `${customer?.first_name ?? ""} ${customer?.last_name ?? ""}`.trim() ||
    customer?.email ||
    "Unknown"
  );
}

async function getMechanicMembershipForUser(ctx: any, userId: any, shopId: any) {
  const membership = await ctx.db
    .query("shop_users")
    .withIndex("by_user_and_shop", (q: any) =>
      q.eq("user_id", userId).eq("shop_id", shopId)
    )
    .first();

  if (!membership || !membership.is_active || !membership.mechanic_id) {
    return null;
  }

  const mechanic = await ctx.db.get(membership.mechanic_id);
  if (!mechanic || !mechanic.is_active) {
    return null;
  }

  return { membership, mechanic };
}

async function mapBookingListItem(ctx: any, booking: any) {
  const customer = await ctx.db.get(booking.user_id);
  const vehicleLabels = await resolveVehicleLabel(ctx, booking.vin);
  const serviceNames = await resolveServiceNames(ctx, booking.service_ids);
  const mechanic = booking.mechanic_id
    ? await ctx.db.get(booking.mechanic_id)
    : null;

  return {
    _id: booking._id,
    _creationTime: booking._creationTime,
    status: booking.status,
    scheduledDate: booking.scheduled_date,
    scheduledTime: booking.scheduled_time,
    customerName: formatCustomerName(customer),
    customerEmail: customer?.email ?? "",
    vehicle: vehicleLabels.full,
    vehicleShort: vehicleLabels.short,
    serviceNames,
    laborCost: booking.labor_cost,
    partsCost: booking.parts_cost,
    totalCost: booking.total_cost,
    estimatedLaborMinutes: booking.estimated_labor_minutes ?? null,
    mechanicId: booking.mechanic_id ?? null,
    mechanicName: mechanic
      ? `${mechanic.first_name} ${mechanic.last_name}`.trim()
      : null,
  };
}

async function mapMechanicDashboardJob(ctx: any, booking: any) {
  const customer = await ctx.db.get(booking.user_id);
  const vehicleLabels = await resolveVehicleLabel(ctx, booking.vin);
  const serviceNames = await resolveServiceNames(ctx, booking.service_ids);

  const customerFirstName =
    customer?.first_name?.trim() ||
    customer?.email?.split("@")[0] ||
    "Customer";
  const customerLastInitial = customer?.last_name?.trim()
    ? `${customer.last_name.trim()[0]}.`
    : "";

  return {
    _id: booking._id,
    status: booking.status,
    liveStage: booking.live_stage ?? null,
    scheduledDate: booking.scheduled_date,
    scheduledTime: booking.scheduled_time,
    customerName: formatCustomerName(customer),
    customerDisplayName: [customerFirstName, customerLastInitial]
      .filter(Boolean)
      .join(" "),
    vehicle: vehicleLabels.full,
    vehicleShort: vehicleLabels.short,
    serviceNames,
    estimatedLaborMinutes: booking.estimated_labor_minutes ?? null,
    totalCost: booking.total_cost,
  };
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
    if (existing.is_available || existing.title !== undefined || existing.note !== undefined) {
      await ctx.db.patch(existing._id, {
        is_available: false,
        note: undefined,
        title: undefined,
      });
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

async function findExactSlot(
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

  return (
    slots.find(
      (slot: any) =>
        slot.start_time === startTime &&
        slot.end_time === endTime &&
        (slot.mechanic_id ?? null) === (mechanicId ?? null)
    ) ?? null
  );
}

async function reservePendingCustomerSlot(
  ctx: any,
  shopId: any,
  mechanicId: any,
  date: string,
  startTime: string,
  durationMinutes: number,
  preferredSlotId?: any
) {
  const endTime = addMinutes(startTime, durationMinutes);
  const slot =
    (preferredSlotId ? await ctx.db.get(preferredSlotId) : null) ??
    (await findExactSlot(ctx, shopId, mechanicId, date, startTime, durationMinutes));

  if (slot) {
    await ctx.db.patch(slot._id, {
      is_available: false,
      note: undefined,
      title: RESERVED_PENDING_CUSTOMER_TITLE,
    });
    return slot._id;
  }

  return await ctx.db.insert("time_slots", {
    date,
    end_time: endTime,
    is_available: false,
    mechanic_id: mechanicId,
    note: undefined,
    shop_id: shopId,
    start_time: startTime,
    title: RESERVED_PENDING_CUSTOMER_TITLE,
  });
}

async function releaseBookingSlot(ctx: any, slotId: any) {
  const slot = await ctx.db.get(slotId);
  if (!slot) return;

  await ctx.db.patch(slotId, {
    is_available: true,
    note: undefined,
    title: undefined,
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
          vehicle: vehicleLabel.full,
          service: serviceName,
          ago,
          scheduledTime: booking.scheduled_time ? formatTime(booking.scheduled_time) : "",
          estimatedMinutes: booking.estimated_labor_minutes ?? null,
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
          vehicle: vehicleLabel.full,
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
          vehicle: vehicleLabel.full,
          service: serviceName,
          scheduledTime: formatTime(booking.scheduled_time),
          totalCost: booking.total_cost ?? 0,
        };
      })
    );
  },
});

/**
 * Returns completed-job summary for today: count + collected revenue.
 * Used by the "Completed Today" dashboard card as a complement to the
 * Executive Summary Bar (which shows scheduled/total numbers).
 */
export const getCompletedTodayByShop = query({
  args: { shopId: v.id("shops") },
  handler: async (ctx, args) => {
    const today = new Date().toISOString().split("T")[0];
    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_shop_and_date", (q) =>
        q.eq("shop_id", args.shopId).eq("scheduled_date", today)
      )
      .filter((q) => q.eq(q.field("status"), "completed"))
      .collect();
    const count = bookings.length;
    const revenue = bookings.reduce((sum, b) => sum + (b.total_cost ?? 0), 0);
    return { count, revenue };
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

    const shop: any = await ctx.db.get(primary.shopId);
    if (!shop) return null;

    const allMechanics = await ctx.db
      .query("mechanics")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shop._id))
      .collect();

    // Only include mechanics linked to an accepted shop_user with a mechanic role
    const mechanicShopUsers = await ctx.db
      .query("shop_users")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shop._id))
      .filter((q: any) =>
        q.and(
          q.eq(q.field("is_active"), true),
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

    const offered = await ctx.db
      .query("shop_services")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shop._id))
      .filter((q: any) => q.eq(q.field("is_offered"), true))
      .collect();

    const services = await Promise.all(
      offered.map(async (entry: any) => {
        const service: any = await ctx.db.get(entry.service_id);
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

    bookings.sort(compareBookingsBySchedule);

    return await Promise.all(bookings.map((booking) => mapBookingListItem(ctx, booking)));
  },
});

/** List only the signed-in mechanic's jobs/bookings for their primary shop. */
export const listForMyMechanic = query({
  args: { status: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return [];

    const primary = await getPrimaryAuthorizedShop(ctx, user._id);
    if (!primary) return [];

    const mechanicContext = await getMechanicMembershipForUser(
      ctx,
      user._id,
      primary.shopId
    );
    if (!mechanicContext) return [];

    let bookings = await ctx.db
      .query("bookings")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", primary.shopId))
      .collect();

    bookings = bookings.filter(
      (booking) => String(booking.mechanic_id ?? "") === String(mechanicContext.mechanic._id)
    );

    if (args.status) {
      bookings = bookings.filter((booking) => booking.status === args.status);
    }

    bookings.sort(compareBookingsBySchedule);

    return await Promise.all(bookings.map((booking) => mapBookingListItem(ctx, booking)));
  },
});

/** Mechanic-focused dashboard data for the signed-in mechanic's primary shop. */
export const getMyMechanicDashboard = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return null;

    const primary = await getPrimaryAuthorizedShop(ctx, user._id);
    if (!primary) return null;

    const mechanicContext = await getMechanicMembershipForUser(
      ctx,
      user._id,
      primary.shopId
    );
    if (!mechanicContext) return null;

    const shop = await ctx.db.get(primary.shopId);
    if (!shop) return null;

    const mechanicId = mechanicContext.mechanic._id;
    const today = getTodayString();
    const weekStart = getDateOffsetString(-6);
    const upcomingDates = Array.from({ length: 7 }, (_, index) =>
      getDateOffsetString(index + 1)
    );

    const todaysJobsRaw = await ctx.db
      .query("bookings")
      .withIndex("by_shop_and_date", (q: any) =>
        q.eq("shop_id", primary.shopId).eq("scheduled_date", today)
      )
      .collect();

    const todaysJobs = todaysJobsRaw
      .filter(
        (booking: any) =>
          String(booking.mechanic_id ?? "") === String(mechanicId) &&
          booking.status !== "cancelled"
      )
      .sort(compareBookingsBySchedule);

    const upcomingJobsRaw = (
      await Promise.all(
        upcomingDates.map((date) =>
          ctx.db
            .query("bookings")
            .withIndex("by_shop_and_date", (q: any) =>
              q.eq("shop_id", primary.shopId).eq("scheduled_date", date)
            )
            .collect()
        )
      )
    ).flat();

    const upcomingJobs = upcomingJobsRaw
      .filter(
        (booking: any) =>
          booking.status === "confirmed" &&
          String(booking.mechanic_id ?? "") === String(mechanicId)
      )
      .sort(compareBookingsBySchedule);

    const completedJobs = await ctx.db
      .query("bookings")
      .withIndex("by_shop_and_status", (q: any) =>
        q.eq("shop_id", primary.shopId).eq("status", "completed")
      )
      .collect();

    const myCompletedJobs = completedJobs
      .filter(
        (booking: any) => String(booking.mechanic_id ?? "") === String(mechanicId)
      )
      .sort(compareBookingsBySchedule);

    const actuals = await ctx.db
      .query("job_actuals")
      .withIndex("by_mechanic_id", (q: any) => q.eq("mechanic_id", mechanicId))
      .collect();
    const actualBookingIds = new Set(actuals.map((actual: any) => String(actual.booking_id)));

    const needsActuals = myCompletedJobs.filter(
      (booking: any) => !actualBookingIds.has(String(booking._id))
    );

    const weekCompletedCount = myCompletedJobs.filter(
      (booking: any) =>
        booking.scheduled_date >= weekStart && booking.scheduled_date <= today
    ).length;

    return {
      shopId: primary.shopId,
      shopName: shop.name,
      role: primary.role,
      mechanicId,
      mechanicName: `${mechanicContext.mechanic.first_name} ${mechanicContext.mechanic.last_name}`.trim(),
      firstName:
        user.first_name ??
        mechanicContext.mechanic.first_name ??
        mechanicContext.mechanic.last_name,
      todaysJobs: await Promise.all(
        todaysJobs.map((booking: any) => mapMechanicDashboardJob(ctx, booking))
      ),
      upcomingJobs: await Promise.all(
        upcomingJobs.map((booking: any) => mapMechanicDashboardJob(ctx, booking))
      ),
      needsActuals: await Promise.all(
        needsActuals.map((booking: any) => mapMechanicDashboardJob(ctx, booking))
      ),
      stats: {
        todayCount: todaysJobs.length,
        weekCompletedCount,
        rating: mechanicContext.mechanic.rating ?? 0,
        reviewCount: mechanicContext.mechanic.review_count ?? 0,
      },
    };
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
    const vehicleLabels = await resolveVehicleLabel(ctx, booking.vin);
    const serviceNames = await resolveServiceNames(ctx, booking.service_ids);
    const mechanic = booking.mechanic_id
      ? await ctx.db.get(booking.mechanic_id)
      : null;

    const history = await ctx.db
      .query("booking_status_history")
      .withIndex("by_booking_id", (q: any) => q.eq("booking_id", booking._id))
      .collect();

    history.sort((a: any, b: any) => b.changed_at - a.changed_at);

    // Resolve previous mechanic name if a reschedule is pending
    let previousMechanicName: string | null = null;
    if (booking.previous_mechanic_id) {
      const prevMech = await ctx.db.get(booking.previous_mechanic_id);
      if (prevMech) previousMechanicName = `${prevMech.first_name} ${prevMech.last_name}`.trim();
    }

    return {
      _id: booking._id,
      _creationTime: booking._creationTime,
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
      vehicle: vehicleLabels.full,
      vehicleShort: vehicleLabels.short,
      serviceNames,
      mechanicName: mechanic
        ? `${mechanic.first_name} ${mechanic.last_name}`.trim()
        : null,
      history,
      // Reschedule fields
      previousScheduledDate: booking.previous_scheduled_date ?? null,
      previousScheduledTime: booking.previous_scheduled_time ?? null,
      previousMechanicId: booking.previous_mechanic_id ?? null,
      previousMechanicName,
      rescheduleProposedAt: booking.reschedule_proposed_at ?? null,
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
      const durationMinutes =
        args.estimatedLaborMinutes ?? booking.estimated_labor_minutes ?? 60;

      if (newMechanic) {
        const allBookings = await ctx.db
          .query("bookings")
          .withIndex("by_shop_id", (q: any) => q.eq("shop_id", booking.shop_id))
          .collect();

        const hasBookingConflict = overlapsMechanicBooking(
          String(newMechanic),
          newDate,
          newTime,
          getBookingEndTime(newTime, durationMinutes),
          allBookings.map((b: any) => ({
            _id: String(b._id),
            scheduledDate: b.scheduled_date,
            scheduledTime: b.scheduled_time,
            estimatedMinutes: b.estimated_labor_minutes ?? 60,
            status: b.status,
            mechanicId: b.mechanic_id ?? null,
          })),
          String(args.bookingId)
        );

        if (hasBookingConflict) {
          throw new Error(
            "Cannot assign this mechanic because that time is already booked."
          );
        }

        const allSlots = await ctx.db
          .query("time_slots")
          .withIndex("by_shop_id", (q: any) => q.eq("shop_id", booking.shop_id))
          .collect();
        const bookingSlotIds = new Set(allBookings.map((b: any) => String(b.time_slot_id)));
        const blockedSlots = allSlots
          .filter((slot: any) => !slot.is_available && !bookingSlotIds.has(String(slot._id)))
          .map((slot: any) => ({
            _id: String(slot._id),
            date: slot.date,
            startTime: slot.start_time,
            endTime: slot.end_time,
            mechanicId: slot.mechanic_id ?? null,
          }));

        const hasBlockedConflict = overlapsBlockedSlot(
          String(newMechanic),
          newDate,
          newTime,
          getBookingEndTime(newTime, durationMinutes),
          blockedSlots
        );

        if (hasBlockedConflict) {
          throw new Error(
            "Cannot assign this mechanic because that time is blocked."
          );
        }
      }

      const slotId = await getOrCreateSlot(
        ctx,
        booking.shop_id,
        newMechanic,
        newDate,
        newTime,
        durationMinutes
      );
      patch.time_slot_id = slotId;
      patch.scheduled_date = newDate;
      patch.scheduled_time = newTime;

      if (String(slotId) !== String(booking.time_slot_id)) {
        await releaseBookingSlot(ctx, booking.time_slot_id);
      }
    }

    await ctx.db.patch(args.bookingId, patch);
    return args.bookingId;
  },
});

/** Job CRUD: accept pending booking — moves it to confirmed state. */
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
      status: "confirmed",
      live_stage: "confirmed",
      updated_at: Date.now(),
    });
    await logBookingStatusChange(
      ctx,
      booking._id,
      booking.status,
      "confirmed",
      user._id,
      "accepted_by_shop"
    );

    return booking._id;
  },
});

/** Job CRUD: start confirmed booking — moves it to in_progress. */
export const start = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");

    await requireShopStaff(ctx, user._id, booking.shop_id);

    if (booking.status !== "confirmed") {
      throw new Error("Only confirmed jobs can be started");
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
      "started_by_shop"
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

/**
 * Propose a reschedule — shop drags an event to a new time/mechanic.
 * Sets status to pending_customer_acceptance and stores original values for revert.
 */
export const proposeReschedule = mutation({
  args: {
    bookingId: v.id("bookings"),
    newScheduledDate: v.string(),
    newScheduledTime: v.string(),
    newMechanicId: v.optional(v.id("mechanics")),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");

    await requireShopStaff(ctx, user._id, booking.shop_id);

    const allowed = ["pending", "pending_shop_acceptance", "confirmed", "pending_customer_acceptance"];
    if (!allowed.includes(booking.status)) {
      throw new Error("Cannot reschedule a booking with status: " + booking.status);
    }

    // Check for overlap with other bookings at the target time/mechanic
    const targetMechanicId = args.newMechanicId !== undefined ? args.newMechanicId : booking.mechanic_id;
    const newEnd = getBookingEndTime(
      args.newScheduledTime,
      booking.estimated_labor_minutes
    );
    const allBookings = await ctx.db
      .query("bookings")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", booking.shop_id))
      .collect();
    const conflicting = allBookings.filter((b: any) => {
      if (String(b._id) === String(args.bookingId)) return false;
      if (b.scheduled_date !== args.newScheduledDate) return false;
      if (b.status === "cancelled" || b.status === "declined") return false;
      if (targetMechanicId && String(b.mechanic_id) !== String(targetMechanicId)) return false;
      const bEnd = getBookingEndTime(
        b.scheduled_time,
        b.estimated_labor_minutes
      );
      return b.scheduled_time < newEnd && bEnd > args.newScheduledTime;
    });
    if (conflicting.length > 0) {
      throw new Error("Cannot reschedule: the new time overlaps an existing booking");
    }

    const durationMinutes = booking.estimated_labor_minutes ?? 60;
    const originalDate =
      booking.status === "pending_customer_acceptance"
        ? (booking.previous_scheduled_date ?? booking.scheduled_date)
        : booking.scheduled_date;
    const originalTime =
      booking.status === "pending_customer_acceptance"
        ? (booking.previous_scheduled_time ?? booking.scheduled_time)
        : booking.scheduled_time;
    const originalMechanicId =
      booking.status === "pending_customer_acceptance"
        ? (booking.previous_mechanic_id ?? booking.mechanic_id)
        : booking.mechanic_id;

    const targetSlotId = await getOrCreateSlot(
      ctx,
      booking.shop_id,
      targetMechanicId ?? undefined,
      args.newScheduledDate,
      args.newScheduledTime,
      durationMinutes
    );

    const patch: any = {
      scheduled_date: args.newScheduledDate,
      scheduled_time: args.newScheduledTime,
      time_slot_id: targetSlotId,
      reschedule_proposed_at: Date.now(),
      status: "pending_customer_acceptance",
      updated_at: Date.now(),
    };

    if (args.newMechanicId !== undefined) {
      patch.mechanic_id = args.newMechanicId;
    }

    // Only save previous_* fields if this is the first reschedule proposal.
    // If already pending_customer_acceptance, keep original previous_* values
    // so revert goes back to the true original, not an intermediate proposal.
    if (booking.status !== "pending_customer_acceptance") {
      patch.previous_scheduled_date = booking.scheduled_date;
      patch.previous_scheduled_time = booking.scheduled_time;
      patch.previous_mechanic_id = booking.mechanic_id;
      patch.previous_status = booking.status;
    }

    await ctx.db.patch(booking._id, patch);

    if (booking.status === "pending_customer_acceptance") {
      if (String(booking.time_slot_id) !== String(targetSlotId)) {
        await releaseBookingSlot(ctx, booking.time_slot_id);
      }
      await reservePendingCustomerSlot(
        ctx,
        booking.shop_id,
        originalMechanicId ?? undefined,
        originalDate,
        originalTime,
        durationMinutes
      );
    } else {
      await reservePendingCustomerSlot(
        ctx,
        booking.shop_id,
        booking.mechanic_id ?? undefined,
        booking.scheduled_date,
        booking.scheduled_time,
        durationMinutes,
        booking.time_slot_id
      );
    }

    await logBookingStatusChange(
      ctx,
      booking._id,
      booking.status,
      "pending_customer_acceptance",
      user._id,
      "reschedule_proposed_by_shop"
    );

    // TODO: Trigger push notification / email to customer about the proposed reschedule.

    return booking._id;
  },
});

/** Customer approves a proposed reschedule. */
export const customerApproveReschedule = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");

    if (booking.status !== "pending_customer_acceptance") {
      throw new Error("Booking is not pending customer acceptance");
    }

    const durationMinutes = booking.estimated_labor_minutes ?? 60;
    const originalDate = booking.previous_scheduled_date ?? booking.scheduled_date;
    const originalTime = booking.previous_scheduled_time ?? booking.scheduled_time;
    const originalMechanicId = booking.previous_mechanic_id ?? booking.mechanic_id;

    await ctx.db.patch(booking._id, {
      status: "confirmed",
      previous_scheduled_date: undefined,
      previous_scheduled_time: undefined,
      previous_mechanic_id: undefined,
      previous_status: undefined,
      reschedule_proposed_at: undefined,
      updated_at: Date.now(),
    });

    const reservedOriginalSlot = await findExactSlot(
      ctx,
      booking.shop_id,
      originalMechanicId ?? undefined,
      originalDate,
      originalTime,
      durationMinutes
    );
    if (reservedOriginalSlot) {
      await releaseBookingSlot(ctx, reservedOriginalSlot._id);
    }

    await logBookingStatusChange(
      ctx,
      booking._id,
      "pending_customer_acceptance",
      "confirmed",
      booking.user_id,
      "customer_approved_reschedule"
    );

    // TODO: Notify the shop that the customer approved the reschedule.

    return booking._id;
  },
});

/** Shop cancels a proposed reschedule — reverts to original values. */
export const shopCancelReschedule = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");

    if (booking.status !== "pending_customer_acceptance") {
      throw new Error("Booking is not pending customer acceptance");
    }

    const durationMinutes = booking.estimated_labor_minutes ?? 60;
    const originalDate = booking.previous_scheduled_date ?? booking.scheduled_date;
    const originalTime = booking.previous_scheduled_time ?? booking.scheduled_time;
    const originalMechanicId = booking.previous_mechanic_id ?? booking.mechanic_id;
    const originalStatus = booking.previous_status ?? "confirmed";
    const originalSlotId = await getOrCreateSlot(
      ctx,
      booking.shop_id,
      originalMechanicId ?? undefined,
      originalDate,
      originalTime,
      durationMinutes
    );

    await ctx.db.patch(booking._id, {
      status: originalStatus,
      scheduled_date: originalDate,
      scheduled_time: originalTime,
      mechanic_id: originalMechanicId,
      time_slot_id: originalSlotId,
      previous_scheduled_date: undefined,
      previous_scheduled_time: undefined,
      previous_mechanic_id: undefined,
      previous_status: undefined,
      reschedule_proposed_at: undefined,
      updated_at: Date.now(),
    });

    if (String(booking.time_slot_id) !== String(originalSlotId)) {
      await releaseBookingSlot(ctx, booking.time_slot_id);
    }

    await logBookingStatusChange(
      ctx,
      booking._id,
      "pending_customer_acceptance",
      originalStatus,
      booking.user_id,
      "shop_cancelled_reschedule"
    );

    return booking._id;
  },
});

/** Customer declines a proposed reschedule — reverts to original values. */
export const customerDeclineReschedule = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");

    if (booking.status !== "pending_customer_acceptance") {
      throw new Error("Booking is not pending customer acceptance");
    }

    const durationMinutes = booking.estimated_labor_minutes ?? 60;
    const originalDate = booking.previous_scheduled_date ?? booking.scheduled_date;
    const originalTime = booking.previous_scheduled_time ?? booking.scheduled_time;
    const originalMechanicId = booking.previous_mechanic_id ?? booking.mechanic_id;
    const originalStatus = booking.previous_status ?? "confirmed";
    const originalSlotId = await getOrCreateSlot(
      ctx,
      booking.shop_id,
      originalMechanicId ?? undefined,
      originalDate,
      originalTime,
      durationMinutes
    );

    await ctx.db.patch(booking._id, {
      status: originalStatus,
      scheduled_date: originalDate,
      scheduled_time: originalTime,
      mechanic_id: originalMechanicId,
      time_slot_id: originalSlotId,
      previous_scheduled_date: undefined,
      previous_scheduled_time: undefined,
      previous_mechanic_id: undefined,
      previous_status: undefined,
      reschedule_proposed_at: undefined,
      updated_at: Date.now(),
    });

    if (String(booking.time_slot_id) !== String(originalSlotId)) {
      await releaseBookingSlot(ctx, booking.time_slot_id);
    }

    await logBookingStatusChange(
      ctx,
      booking._id,
      "pending_customer_acceptance",
      originalStatus,
      booking.user_id,
      "customer_declined_reschedule"
    );

    // TODO: Notify the shop that the customer declined and the booking has been reverted.

    return booking._id;
  },
});

/**
 * Internal mutation: revert expired pending_customer_acceptance bookings.
 * Called by a cron job every 15 minutes.
 */
export const revertExpiredReschedules = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;

    const expired = await ctx.db
      .query("bookings")
      .withIndex("by_status", (q) => q.eq("status", "pending_customer_acceptance"))
      .filter((q: any) =>
        q.and(
          q.neq(q.field("reschedule_proposed_at"), undefined),
          q.lte(q.field("reschedule_proposed_at"), cutoff)
        )
      )
      .collect();

    for (const booking of expired) {
      const durationMinutes = booking.estimated_labor_minutes ?? 60;
      const originalDate = booking.previous_scheduled_date ?? booking.scheduled_date;
      const originalTime = booking.previous_scheduled_time ?? booking.scheduled_time;
      const originalMechanicId = booking.previous_mechanic_id ?? booking.mechanic_id;
      const originalStatus = booking.previous_status ?? "confirmed";
      const originalSlotId = await getOrCreateSlot(
        ctx,
        booking.shop_id,
        originalMechanicId ?? undefined,
        originalDate,
        originalTime,
        durationMinutes
      );

      await ctx.db.patch(booking._id, {
        status: originalStatus,
        scheduled_date: originalDate,
        scheduled_time: originalTime,
        mechanic_id: originalMechanicId,
        time_slot_id: originalSlotId,
        previous_scheduled_date: undefined,
        previous_scheduled_time: undefined,
        previous_mechanic_id: undefined,
        previous_status: undefined,
        reschedule_proposed_at: undefined,
        updated_at: Date.now(),
      });

      if (String(booking.time_slot_id) !== String(originalSlotId)) {
        await releaseBookingSlot(ctx, booking.time_slot_id);
      }

      await logBookingStatusChange(
        ctx,
        booking._id,
        "pending_customer_acceptance",
        originalStatus,
        booking.user_id,
        "reschedule_auto_reverted_24h"
      );

      // TODO: Notify both the shop and customer that the reschedule expired.
    }

    return expired.length;
  },
});
