/**
 * bookings.ts - Service Booking Management
 *
 * DESCRIPTION:
 * Central booking management API for the platform.
 * Handles creating, querying, and managing confirmed service bookings.
 * Bookings link users, vehicles, shops, mechanics, and services together.
 *
 * TABLE: bookings
 *   - Stores service appointment requests and confirmed appointments
 *   - One record per booking (user + vehicle + shop + services + time)
 *   - Status progresses: pending (user submitted) -> confirmed (shop accepts) -> completed/cancelled
 *   - VIN normalized to uppercase for consistency
 *   - Time slot becomes unavailable when user confirms appointment (pending); shop can then accept or cancel
 *
 * KEY ENTITIES:
 *   - bookings: Main booking records
 *   - vehicles: Vehicle catalog (by canonical VIN)
 *   - vehicle_owners: User-vehicle ownership relationships
 *   - time_slots: Available appointment slots
 *   - booking_status_history: Audit log of status changes
 *   - analytics_events: Booking event tracking
 *   - conversion_funnels: User funnel completion
 *
 * RELATIONSHIPS:
 *   - Requires active vehicle ownership (status="active")
 *   - Reserves time slot (marks unavailable)
 *   - Creates analytics event on creation
 *   - Completes conversion funnel if provided
 *
 * OWNER: Booking Team
 */

import { query, mutation, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { isTerminal, validateTransition } from "./booking_status_history";
import {
  addMinutesToHHMM,
  getBookingEndTime,
  overlapsBlockedSlot,
  overlapsMechanicBooking,
} from "./lib/schedule_overlap";
import {
  getActiveMechanicsForShop,
  syncMechanicDayAvailability,
  syncShopDateAvailability,
} from "./lib/timeSlotAvailability";
import {
  ensureJobActualRecord,
  finalizeJobActuals,
  getLatestJobActualForBooking,
  jobActualInputValidator,
  saveJobActualDraft,
} from "./lib/job_actuals";
import {
  getMissingRequiredPassportFields,
  getPassportCompletionPercent,
  hasText,
  isTireCondition,
  mergePassportSection,
  postjobReportValidator,
  prejobReportValidator,
  serviceRequiresParts,
  vehiclePassportUpdateValidator,
} from "./lib/vehicle_passports";
import { getBookingServiceFlags } from "../lib/vehicle-service-relevance";

function normalizeNullableText(value: string | null | undefined) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

function hhmmToMinutes(hhmm: string) {
  const [hours, minutes] = hhmm.split(":").map(Number);
  return hours * 60 + minutes;
}

function getSlotDurationMinutes(slot: {
  start_time?: string;
  end_time?: string;
}) {
  if (!slot.start_time || !slot.end_time) return 60;
  return Math.max(0, hhmmToMinutes(slot.end_time) - hhmmToMinutes(slot.start_time));
}

async function getShopHoursForDate(ctx: any, shopId: any, date: string) {
  const dayOfWeek = new Date(`${date}T00:00:00`).getDay();
  const rows = await ctx.db
    .query("shops_hours")
    .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shopId))
    .collect();
  return rows.find((row: any) => row.day_of_week === dayOfWeek) ?? null;
}

async function assertBookingWithinShopHours(
  ctx: any,
  {
    shopId,
    date,
    startTime,
    durationMinutes,
    allowAfterClose,
  }: {
    shopId: any;
    date: string;
    startTime: string;
    durationMinutes: number;
    allowAfterClose?: boolean;
  }
) {
  const hours = await getShopHoursForDate(ctx, shopId, date);
  if (!hours || hours.is_closed || !hours.open_time || !hours.close_time) {
    throw new Error("The shop is closed on the requested day.");
  }

  const startMinutes = hhmmToMinutes(startTime);
  const endTime = getBookingEndTime(startTime, durationMinutes);
  const endMinutes = hhmmToMinutes(endTime);
  const openMinutes = hhmmToMinutes(hours.open_time);
  const closeMinutes = hhmmToMinutes(hours.close_time);

  if (startMinutes < openMinutes || startMinutes >= closeMinutes) {
    throw new Error("The requested start time is outside the shop's operating hours.");
  }
  if (endMinutes > closeMinutes && !allowAfterClose) {
    throw new Error("This booking would end after the shop closes.");
  }

  return endTime;
}

function formatPassportFieldLabel(field: string) {
  switch (field) {
    case "mileage":
      return "mileage";
    case "tires.brand":
      return "tire brand";
    case "tires.model":
      return "tire model";
    case "tires.overall_condition":
      return "tire condition";
    default:
      return field;
  }
}

/** Live Tracker stage slugs stored on bookings when status is in_progress */
export const LIVE_STAGE_SLUGS = ["booking_confirmed", "service_in_progress", "vehicle_ready"] as const;
export type LiveStageSlug = (typeof LIVE_STAGE_SLUGS)[number];

/** Display title for each live stage (for currentStage in UI) */
export const LIVE_STAGE_TITLES: Record<string, string> = {
  booking_confirmed: "Booking Confirmed",
  service_in_progress: "Service in Progress",
  vehicle_ready: "Your vehicle is ready",
};

/** Progress percent when no job_actuals elapsed time (stage-based fallback) */
const LIVE_STAGE_PROGRESS: Record<string, number> = {
  booking_confirmed: 25,
  service_in_progress: 50,
  vehicle_ready: 90,
};

/**
 * QUERY: list
 * Returns all bookings in the system.
 * Use with caution - consider filtering in production.
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("bookings").collect();
  },
});

/**
 * QUERY: getById
 * Fetch a specific booking by ID.
 *
 * ARGS:
 *   - id: Booking ID
 *
 * RETURNS: Booking record or null if not found
 */
export const getById = query({
  args: { id: v.id("bookings") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

/**
 * QUERY: getByUserId
 * Get all bookings for a specific user.
 * Used to show user's booking history.
 *
 * ARGS:
 *   - userId: User ID
 *
 * RETURNS: Array of bookings
 */
export const getByUserId = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("bookings")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .collect();
  },
});

/**
 * QUERY: getByUserIdWithDetails
 * Get all bookings for a user with shop, mechanic, vehicle, and service names resolved.
 * Used by My Bookings screen for Live Tracker, Upcoming, and History.
 *
 * ARGS:
 *   - userId: User ID
 *
 * RETURNS: Array of booking rows with display fields (shopName, shopPhone, mechanicName, vehicleDisplay, licensePlate, serviceNames, progressPercent?, currentStage?, delayMinutes?)
 */
export const getByUserIdWithDetails = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .collect();

    const results = await Promise.all(
      bookings.map(async (booking) => {
        const shop = await ctx.db.get(booking.shop_id);
        const mechanic = booking.mechanic_id ? await ctx.db.get(booking.mechanic_id) : null;
        const shopName = shop?.name ?? "Unknown Shop";
        const shopPhone = shop?.phone ?? "";
        const mechanicName = mechanic ? `${mechanic.first_name} ${mechanic.last_name}` : shopName;
        const mechanicImageUrl = (await resolveMechanicPhotoUrl(ctx, mechanic)) ?? undefined;

        const serviceIds = booking.service_ids ?? [];
        const serviceNames = await Promise.all(
          serviceIds.map(async (id) => {
            const svc = await ctx.db.get(id);
            return svc?.name ?? "";
          })
        ).then((a) => a.filter(Boolean));

        const vehicle = await ctx.db
          .query("vehicles")
          .withIndex("by_vin", (q) => q.eq("vin", booking.vin))
          .unique();
        let vehicleDisplay = "Unknown Vehicle";
        let licensePlate = booking.vin.slice(-4);
        let makeLogoUrl: string | undefined;
        if (vehicle) {
          const parts: string[] = [];
          if (vehicle.trim_id) {
            const trim = await ctx.db.get(vehicle.trim_id);
            if (trim) {
              const model = await ctx.db.get(trim.model_id);
              if (model) {
                const make = await ctx.db.get(model.make_id);
                if (make) {
                  parts.push(make.name);
                  if (make.logo) {
                    const logoAsset = await ctx.db.get(make.logo);
                    makeLogoUrl = logoAsset?.url;
                  }
                }
                parts.push(model.name);
              }
              parts.push(trim.name);
            }
          }
          if (vehicle.year != null) parts.push(String(vehicle.year));
          if (parts.length > 0) vehicleDisplay = parts.join(" ");
        }

        let progressPercent: number | undefined;
        let currentStage: string | undefined;
        let delayMinutes: number | undefined;
        const liveStage = booking.live_stage;
        if (booking.status === "in_progress") {
          const jobActual = await getLatestJobActualForBooking(ctx, booking._id);
          const estimatedMinutes = booking.estimated_labor_minutes ?? 60;
          // Use stored live_stage for currentStage when set; else infer from job_actual
          if (liveStage && LIVE_STAGE_TITLES[liveStage]) {
            currentStage = LIVE_STAGE_TITLES[liveStage];
          } else if (jobActual) {
            currentStage = "Service in Progress";
          } else {
            currentStage = "Car checked in";
          }
          // Progress: from job_actuals elapsed when available, else from live_stage
          if (jobActual?.started_at != null) {
            const elapsedMs = Date.now() - jobActual.started_at;
            const totalMs = estimatedMinutes * 60 * 1000;
            progressPercent = Math.min(100, Math.round((elapsedMs / totalMs) * 100));
            const scheduledStartMs = new Date(`${booking.scheduled_date}T${booking.scheduled_time}`).getTime();
            const lateMs = Date.now() - scheduledStartMs;
            if (lateMs > 0) delayMinutes = Math.round(lateMs / 60000);
          } else {
            progressPercent = (liveStage && LIVE_STAGE_PROGRESS[liveStage]) ?? 25;
          }
        }

        return {
          _id: booking._id,
          status: booking.status,
          scheduled_date: booking.scheduled_date,
          scheduled_time: booking.scheduled_time,
          total_cost: booking.total_cost,
          shop_id: booking.shop_id,
          mechanic_id: booking.mechanic_id,
          vin: booking.vin,
          shopName,
          shopPhone,
          mechanicName,
          mechanicImageUrl,
          vehicleDisplay,
          licensePlate,
          makeLogoUrl,
          serviceNames,
          progressPercent,
          currentStage,
          delayMinutes,
          liveStage: liveStage ?? undefined,
          shopRating: shop?.rating ?? 0,
          shopIsVerified: shop?.is_verified ?? false,
          shopLat: shop?.lat,
          shopLng: shop?.lng,
        };
      })
    );

    return results;
  },
});

/**
 * QUERY: getRecentlyBookedShopIdsByUserId
 * Get unique shop IDs the user has booked at, ordered by most recent booking first.
 * Used to show "Recently booked" in booking flow search.
 *
 * ARGS:
 *   - userId: User ID
 *   - limit: Max number of shop IDs to return (default 5)
 *
 * RETURNS: Array of shop IDs (most recently booked first)
 */
export const getRecentlyBookedShopIdsByUserId = query({
  args: {
    userId: v.id("users"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 5;
    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .collect();
    // Sort by most recent booking first
    bookings.sort((a, b) => b.created_at - a.created_at);
    const seen = new Set<string>();
    const shopIds: string[] = [];
    for (const b of bookings) {
      const id = b.shop_id;
      if (!seen.has(id)) {
        seen.add(id);
        shopIds.push(id);
        if (shopIds.length >= limit) break;
      }
    }
    return shopIds;
  },
});

/**
 * QUERY: getRecentlyBookedMechanicIdsByUserId
 * Get unique mechanic IDs the user has booked with, ordered by most recent booking first.
 * Only includes bookings that have mechanic_id set.
 *
 * ARGS:
 *   - userId: User ID
 *   - limit: Max number of mechanic IDs to return (default 5)
 *
 * RETURNS: Array of mechanic IDs (most recently booked first)
 */
export const getRecentlyBookedMechanicIdsByUserId = query({
  args: {
    userId: v.id("users"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 5;
    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .collect();
    bookings.sort((a, b) => b.created_at - a.created_at);
    const seen = new Set<string>();
    const mechanicIds: string[] = [];
    for (const b of bookings) {
      const mid = b.mechanic_id;
      if (mid && !seen.has(mid)) {
        seen.add(mid);
        mechanicIds.push(mid);
        if (mechanicIds.length >= limit) break;
      }
    }
    return mechanicIds;
  },
});

/**
 * QUERY: getByShopId
 * Get all bookings for a specific shop.
 * Used by shops to view their upcoming appointments.
 *
 * ARGS:
 *   - shopId: Shop ID
 *
 * RETURNS: Array of bookings at shop
 */
export const getByShopId = query({
  args: { shopId: v.id("shops") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("bookings")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
      .collect();
  },
});

/**
 * MUTATION: create
 * Create a new service booking.
 *
 * VALIDATION:
 *   1. Vehicle with given VIN must exist
 *   2. User must own vehicle (active ownership)
 *   3. Time slot must be available
 *
 * SIDE EFFECTS:
 *   1. Marks time slot as unavailable
 *   2. Creates booking record
 *   3. Tracks analytics event
 *   4. Completes conversion funnel (if provided)
 *
 * ARGS:
 *   - user_id: User making booking
 *   - vin: Vehicle VIN (normalized to uppercase)
 *   - shop_id: Shop providing service
 *   - mechanic_id: (optional) Specific mechanic assigned
 *   - service_id: Service being booked
 *   - time_slot_id: Chosen time slot
 *   - scheduled_date: Date in YYYY-MM-DD format
 *   - scheduled_time: Time in HH:MM format
 *   - labor_cost: Estimated labor cost ($)
 *   - parts_cost: Estimated parts cost ($)
 *   - total_cost: Sum of labor + parts
 *   - session_id: (optional) Client session for analytics
 *   - funnel_id: (optional) Conversion funnel to complete
 *
 * RETURNS: Booking ID
 *
 * THROWS:
 *   - "Vehicle not found": VIN doesn't exist
 *   - "User does not own this vehicle": User lacks active ownership
 *   - "This time slot is no longer available": Slot is reserved
 */
export const create = mutation({
  args: {
    user_id: v.id("users"),
    vin: v.string(),
    shop_id: v.id("shops"),
    mechanic_id: v.optional(v.id("mechanics")),
    service_id: v.id("services"),
    time_slot_id: v.id("time_slots"),
    scheduled_date: v.string(),
    scheduled_time: v.string(),
    labor_cost: v.float64(),
    parts_cost: v.float64(),
    total_cost: v.float64(),
    session_id: v.optional(v.string()),
    funnel_id: v.optional(v.id("conversion_funnels")),
  },
  handler: async (ctx, args) => {
    const normalizedVin = toCanonicalVin(args.vin);

    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", normalizedVin))
      .unique();
    if (!vehicle) {
      throw new Error(`Vehicle not found: ${args.vin}`);
    }

    // Validate user owns this vehicle (active ownership)
    const ownership = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_vin_user", (q) => q.eq("vin", normalizedVin).eq("user_id", args.user_id))
      .unique();
    if (!ownership || ownership.status !== "active") {
      throw new Error("User does not own this vehicle");
    }

    await syncShopDateAvailability(ctx, {
      shopId: args.shop_id,
      date: args.scheduled_date,
    });

    const slot = await ctx.db.get(args.time_slot_id);
    if (!slot || !slot.is_available) {
      throw new Error("This time slot is no longer available.");
    }

    await assertBookingWithinShopHours(ctx, {
      shopId: args.shop_id,
      date: args.scheduled_date,
      startTime: args.scheduled_time,
      durationMinutes: getSlotDurationMinutes(slot),
    });

    await ctx.db.patch(args.time_slot_id, { is_available: false });

    const now = Date.now();
    const mechanicId = args.mechanic_id ?? slot.mechanic_id;
    const bookingId = await ctx.db.insert("bookings", {
      user_id: args.user_id,
      vin: normalizedVin,
      shop_id: args.shop_id,
      mechanic_id: mechanicId,
      service_ids: [args.service_id],
      time_slot_id: args.time_slot_id,
      scheduled_date: args.scheduled_date,
      scheduled_time: args.scheduled_time,
      labor_cost: args.labor_cost,
      parts_cost: args.parts_cost,
      total_cost: args.total_cost,
      status: "pending",
      created_at: now,
      updated_at: now,
    });

    await logBookingStatusChange(
      ctx,
      bookingId,
      undefined,
      "pending",
      args.user_id,
      "booking_created"
    );

    await ctx.db.insert("analytics_events", {
      user_id: args.user_id,
      event_type: "booking_created",
      event_category: "booking",
      event_data: {
        booking_id: bookingId,
        shop_id: args.shop_id,
        service_id: args.service_id,
      },
      timestamp: Date.now(),
      session_id: args.session_id,
    });

    if (args.funnel_id) {
      await ctx.db.patch(args.funnel_id, {
        completed: true,
        exited_at: Date.now(),
        booking_id: bookingId,
        stage: "completed",
      });
    }

    await syncBookingAssignments(ctx, [
      { shopId: args.shop_id, mechanicId, date: args.scheduled_date },
    ]);

    return bookingId;
  },
});

/**
 * MUTATION: createBatch
 * Create one booking for an appointment (one time slot) with multiple services.
 * Total cost and estimated time are aggregated; one row per appointment.
 *
 * ARGS:
 *   - user_id, vin, shop_id, mechanic_id?, time_slot_id, scheduled_date, scheduled_time
 *   - services: Array of { service_id, labor_cost, parts_cost, labor_hours? }
 *   - taxes_and_fees: (optional) Taxes & fees to include in total_cost
 *   - platform_fee: (optional) Platform fee to include in total_cost
 *   - session_id, funnel_id: optional
 *
 * RETURNS: Single-element array [bookingId]
 */
export const createBatch = mutation({
  args: {
    user_id: v.id("users"),
    vin: v.string(),
    shop_id: v.id("shops"),
    mechanic_id: v.optional(v.id("mechanics")),
    time_slot_id: v.id("time_slots"),
    scheduled_date: v.string(),
    scheduled_time: v.string(),
    services: v.array(
      v.object({
        service_id: v.id("services"),
        labor_cost: v.float64(),
        parts_cost: v.float64(),
        labor_hours: v.optional(v.float64()),
      })
    ),
    taxes_and_fees: v.optional(v.float64()),
    platform_fee: v.optional(v.float64()),
    session_id: v.optional(v.string()),
    funnel_id: v.optional(v.id("conversion_funnels")),
  },
  handler: async (ctx, args) => {
    if (args.services.length === 0) {
      throw new Error("At least one service is required");
    }

    const normalizedVin = toCanonicalVin(args.vin);

    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", normalizedVin))
      .unique();
    if (!vehicle) {
      throw new Error(`Vehicle not found: ${args.vin}`);
    }

    // Validate user owns this vehicle
    const ownership = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_vin_user", (q) => q.eq("vin", normalizedVin).eq("user_id", args.user_id))
      .unique();
    if (!ownership || ownership.status !== "active") {
      throw new Error("User does not own this vehicle");
    }

    await syncShopDateAvailability(ctx, {
      shopId: args.shop_id,
      date: args.scheduled_date,
    });

    const slot = await ctx.db.get(args.time_slot_id);
    if (!slot || !slot.is_available) {
      throw new Error("This time slot is no longer available.");
    }

    const labor_cost = args.services.reduce((sum, s) => sum + s.labor_cost, 0);
    const parts_cost = args.services.reduce((sum, s) => sum + s.parts_cost, 0);
    const taxes_and_fees = args.taxes_and_fees ?? 0;
    const platform_fee = args.platform_fee ?? 0;
    const total_cost = labor_cost + parts_cost + taxes_and_fees + platform_fee;
    const estimated_labor_minutes = args.services.reduce((sum, s) => sum + (s.labor_hours ?? 0) * 60, 0);

    await assertBookingWithinShopHours(ctx, {
      shopId: args.shop_id,
      date: args.scheduled_date,
      startTime: args.scheduled_time,
      durationMinutes:
        estimated_labor_minutes > 0 ? estimated_labor_minutes : getSlotDurationMinutes(slot),
    });

    await ctx.db.patch(args.time_slot_id, { is_available: false });

    const now = Date.now();
    const firstServiceId = args.services[0].service_id;
    const mechanicId = args.mechanic_id ?? slot.mechanic_id;

    const bookingId = await ctx.db.insert("bookings", {
      user_id: args.user_id,
      vin: normalizedVin,
      shop_id: args.shop_id,
      mechanic_id: mechanicId,
      service_ids: args.services.map((s) => s.service_id),
      time_slot_id: args.time_slot_id,
      scheduled_date: args.scheduled_date,
      scheduled_time: args.scheduled_time,
      labor_cost,
      parts_cost,
      total_cost,
      estimated_labor_minutes: estimated_labor_minutes > 0 ? estimated_labor_minutes : undefined,
      status: "pending",
      created_at: now,
      updated_at: now,
    });

    await logBookingStatusChange(
      ctx,
      bookingId,
      undefined,
      "pending",
      args.user_id,
      "booking_created"
    );

    await ctx.db.insert("analytics_events", {
      user_id: args.user_id,
      event_type: "booking_created",
      event_category: "booking",
      event_data: {
        booking_id: bookingId,
        shop_id: args.shop_id,
        service_id: firstServiceId,
      },
      timestamp: Date.now(),
      session_id: args.session_id,
    });

    if (args.funnel_id) {
      await ctx.db.patch(args.funnel_id, {
        completed: true,
        exited_at: Date.now(),
        booking_id: bookingId,
        stage: "completed",
      });
    }

    await syncBookingAssignments(ctx, [
      { shopId: args.shop_id, mechanicId, date: args.scheduled_date },
    ]);

    return [bookingId];
  },
});

/**
 * MUTATION: updateStatus
 * Update booking status with FSM validation.
 *
 * VALIDATION:
 *   1. Booking must exist
 *   2. Status transition must be valid (FSM rules)
 *   3. Cannot transition from terminal states
 *
 * SIDE EFFECTS:
 *   1. Updates booking status
 *   2. If new status is cancelled | no_show | completed, sets the booking's time_slot is_available = true (releases slot for mechanics)
 *   3. Logs change to booking_status_history (async)
 *
 * ARGS:
 *   - bookingId: Booking to update
 *   - newStatus: New status to transition to
 *   - changed_by: (optional) User ID who initiated change
 *   - reason: (optional) Reason for status change
 *
 * RETURNS:
 *   {
 *     success: true,
 *     oldStatus: string,
 *     newStatus: string
 *   }
 *
 * THROWS:
 *   - "Booking not found": Invalid booking ID
 *   - Invalid status transition error from FSM
 *   - "Cannot transition from terminal state": From completed/cancelled
 */
export const updateStatus = mutation({
  args: {
    bookingId: v.id("bookings"),
    newStatus: v.string(),
    changed_by: v.optional(v.id("users")),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");

    return await applyBookingStatusTransition(ctx, {
      booking,
      newStatus: args.newStatus,
      changedBy: args.changed_by,
      reason: args.reason,
    });
  },
});

/**
 * MUTATION: updateLiveStage
 * Update the Live Tracker stage for an in_progress booking.
 * Used when mechanic/shop advances the stage (e.g. "vehicle_ready").
 *
 * ARGS:
 *   - bookingId: Booking to update
 *   - liveStage: "booking_confirmed" | "service_in_progress" | "vehicle_ready"
 *
 * THROWS: "Booking not found" | "Booking is not in progress" | "Invalid live stage"
 */
export const updateLiveStage = mutation({
  args: {
    bookingId: v.id("bookings"),
    liveStage: v.union(v.literal("booking_confirmed"), v.literal("service_in_progress"), v.literal("vehicle_ready")),
  },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");
    if (booking.status !== "in_progress") {
      throw new Error("Booking is not in progress");
    }
    await ctx.db.patch(args.bookingId, {
      live_stage: args.liveStage,
      updated_at: Date.now(),
    });
    return { success: true, liveStage: args.liveStage };
  },
});

const TERMINAL_BOOKING_STATUSES = new Set([
  "cancelled",
  "completed",
  "no_show",
  "declined",
]);
const RESERVED_PENDING_CUSTOMER_TITLE = "Reserved pending customer approval";

function formatTime(hhmm: string) {
  const [hours, minutes] = hhmm.split(":").map(Number);
  const ampm = hours >= 12 ? "PM" : "AM";
  const hour = hours % 12 || 12;
  return `${hour}:${String(minutes).padStart(2, "0")} ${ampm}`;
}

function toCanonicalVin(vin: string) {
  return vin.trim().toUpperCase();
}

function getTodayString() {
  return new Date().toISOString().slice(0, 10);
}

function getDateOffsetString(offsetDays: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function getStartOfCurrentWeekUtcMs() {
  const now = new Date();
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const diffToMonday = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - diffToMonday);
  start.setUTCHours(0, 0, 0, 0);
  return start.getTime();
}

function compareBookingsBySchedule(a: any, b: any) {
  const leftDate = a.scheduled_date ?? "";
  const rightDate = b.scheduled_date ?? "";
  const dateCompare = leftDate.localeCompare(rightDate);
  if (dateCompare !== 0) return dateCompare;
  return (a.scheduled_time ?? "").localeCompare(b.scheduled_time ?? "");
}

function formatCustomerName(customer: any) {
  return (
    `${customer?.first_name ?? ""} ${customer?.last_name ?? ""}`.trim() ||
    customer?.email ||
    "Unknown"
  );
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

function firstDefinedNumber(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function firstDefinedString(...values: unknown[]) {
  for (const value of values) {
    if (hasText(value)) {
      return value.trim();
    }
  }
  return null;
}

function firstDefinedBoolean(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value;
    }
  }
  return null;
}

function formatShortDateLabel(dateString?: string | null, fallbackMs?: number | null) {
  if (hasText(dateString)) {
    return new Date(`${dateString}T00:00:00`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  }
  if (typeof fallbackMs === "number" && Number.isFinite(fallbackMs)) {
    return new Date(fallbackMs).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  }
  return "";
}

function coerceNumberOrNull(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function normalizePartsUsed(parts: Array<{
  part_name: string;
  brand?: string | null;
  oem_number: string;
  cost: number;
}>) {
  return parts
    .map((part) => ({
      part_name: part.part_name.trim(),
      brand: hasText(part.brand) ? part.brand.trim() : null,
      oem_number: part.oem_number.trim(),
      cost: Number.isFinite(part.cost) ? Number(part.cost) : 0,
    }))
    .filter(
      (part) =>
        hasText(part.part_name) ||
        hasText(part.oem_number) ||
        hasText(part.brand) ||
        part.cost > 0
    );
}

function sumPartsCost(parts: Array<{ cost: number }>) {
  return parts.reduce((sum, part) => sum + (Number.isFinite(part.cost) ? part.cost : 0), 0);
}

function pickPreferredOwner(owners: any[]) {
  return (
    owners.find((owner) => owner.status === "active" && owner.is_primary) ??
    owners.find((owner) => owner.status === "active") ??
    owners[0] ??
    null
  );
}

function determineOwnershipLabel(owner: any) {
  if (!owner) return null;
  if (hasText(owner.ownershipType)) return owner.ownershipType.trim();
  if (owner.ownedSinceNew === true) return "Owned since new";
  if (owner.status === "active") return "Owned";
  return null;
}

function buildSourceTag(
  verifiedValue: unknown,
  fallbackValue: unknown,
  fallbackTag: "oem_default" | "user_reported"
) {
  if (
    typeof verifiedValue === "number" ||
    typeof verifiedValue === "boolean" ||
    hasText(verifiedValue)
  ) {
    return "verified";
  }
  if (
    typeof fallbackValue === "number" ||
    typeof fallbackValue === "boolean" ||
    hasText(fallbackValue)
  ) {
    return fallbackTag;
  }
  return "empty";
}

function buildPassportPatchFromPrejob(prejob: any, existingPassport: any) {
  const frontCondition = prejob.front_tire_condition ?? undefined;
  const rearCondition = prejob.rear_tire_condition ?? undefined;
  const fluidOverrides = prejob.fluid_overrides ?? undefined;
  const hasFluidOverride =
    fluidOverrides &&
    Object.values(fluidOverrides).some(
      (value) =>
        typeof value === "number" ||
        typeof value === "boolean" ||
        hasText(value)
    );

  return {
    mileage:
      typeof prejob.mileage === "number" && Number.isFinite(prejob.mileage)
        ? prejob.mileage
        : undefined,
    tires: {
      brand: prejob.tire_brand ?? undefined,
      size_front: prejob.tire_size_front ?? undefined,
      size_rear: prejob.tire_size_rear ?? undefined,
      front_condition: frontCondition,
      rear_condition: rearCondition,
      overall_condition:
        frontCondition && frontCondition === rearCondition
          ? frontCondition
          : existingPassport?.tires?.overall_condition ?? frontCondition ?? rearCondition,
    },
    brakes: prejob.brakes,
    fluids:
      prejob.fluids_match_oem || hasFluidOverride
        ? {
            ...(fluidOverrides ?? {}),
            confirmation_status: hasFluidOverride ? "updated" : "oem_confirmed",
          }
        : undefined,
    inspection: prejob.inspection,
    modifications: prejob.modifications,
  };
}

function buildPassportPatchFromPostjob(postjob: any) {
  const updates = postjob.vehicle_updates ?? {};
  const hasFluidUpdate =
    hasText(updates.oil_viscosity) ||
    hasText(updates.oil_type) ||
    hasText(updates.coolant_type) ||
    hasText(updates.brake_fluid_type) ||
    hasText(updates.transmission_fluid_type);

  return {
    mileage: postjob.completion_mileage,
    tires: {
      brand: updates.tire_brand ?? undefined,
      model: updates.tire_model ?? undefined,
      size_front: updates.tire_size_front ?? undefined,
      size_rear: updates.tire_size_rear ?? undefined,
      run_flat: updates.run_flat ?? undefined,
      overall_condition: updates.tire_overall_condition ?? undefined,
    },
    fluids: hasFluidUpdate
      ? {
          oil_viscosity: updates.oil_viscosity ?? undefined,
          oil_type: updates.oil_type ?? undefined,
          coolant_type: updates.coolant_type ?? undefined,
          brake_fluid_type: updates.brake_fluid_type ?? undefined,
          transmission_fluid_type: updates.transmission_fluid_type ?? undefined,
          confirmation_status: "updated",
        }
      : undefined,
    brakes: {
      pad_brand: updates.pad_brand ?? undefined,
    },
  };
}

async function updateOwnerMileageForVin(ctx: any, vin: string, mileage: number, now: number) {
  const owners = await ctx.db
    .query("vehicle_owners")
    .withIndex("by_vin", (q: any) => q.eq("vin", vin))
    .collect();

  for (const owner of owners) {
    if (owner.status !== "active") continue;
    await ctx.db.patch(owner._id, {
      mileage,
      last_checkin_at: now,
    });
  }
}

async function upsertVehiclePassportRecord(
  ctx: any,
  {
    vin,
    patch,
    now,
    markConfirmed = false,
  }: {
    vin: string;
    patch: any;
    now: number;
    markConfirmed?: boolean;
  }
) {
  const canonicalVin = toCanonicalVin(vin);
  const existing = await ctx.db
    .query("vehicle_passports")
    .withIndex("by_vin", (q: any) => q.eq("vin", canonicalVin))
    .unique();

  const currentMileage = existing?.mileage;
  const currentReportedAt = existing?.last_reported_at;
  const nextMileage =
    typeof patch?.mileage === "number" && Number.isFinite(patch.mileage)
      ? patch.mileage
      : currentMileage;

  let nextVelocity = existing?.mileage_velocity;
  if (
    typeof nextMileage === "number" &&
    typeof currentMileage === "number" &&
    typeof currentReportedAt === "number" &&
    now > currentReportedAt &&
    nextMileage >= currentMileage
  ) {
    const elapsedMonths = (now - currentReportedAt) / (1000 * 60 * 60 * 24 * 30.4375);
    if (elapsedMonths > 0.05) {
      nextVelocity = Math.round((nextMileage - currentMileage) / elapsedMonths);
    }
  }

  const mergedTires = mergePassportSection(existing?.tires, patch?.tires
    ? {
        ...patch.tires,
        last_verified_at: now,
      }
    : undefined);
  const mergedFluids = mergePassportSection(existing?.fluids, patch?.fluids);
  const mergedBrakes = mergePassportSection(existing?.brakes, patch?.brakes);
  const mergedInspection = mergePassportSection(existing?.inspection, patch?.inspection);
  const mergedModifications = mergePassportSection(
    existing?.modifications,
    patch?.modifications
  );

  const nextRecord = {
    vin: canonicalVin,
    mileage: nextMileage ?? undefined,
    last_reported_at:
      typeof nextMileage === "number" ? now : existing?.last_reported_at ?? undefined,
    mileage_velocity: nextVelocity ?? undefined,
    tires: mergedTires,
    fluids: mergedFluids,
    brakes: mergedBrakes,
    inspection: mergedInspection,
    modifications: mergedModifications,
    created_at: existing?.created_at ?? now,
    updated_at: now,
    first_shop_confirmed_at:
      existing?.first_shop_confirmed_at ?? (markConfirmed ? now : undefined),
    last_shop_confirmed_at:
      markConfirmed ? now : existing?.last_shop_confirmed_at ?? undefined,
  };

  if (existing) {
    await ctx.db.patch(existing._id, nextRecord);
    const updated = await ctx.db.get(existing._id);
    if (typeof nextMileage === "number") {
      await updateOwnerMileageForVin(ctx, canonicalVin, nextMileage, now);
    }
    return updated;
  }

  const insertedId = await ctx.db.insert("vehicle_passports", nextRecord);
  if (typeof nextMileage === "number") {
    await updateOwnerMileageForVin(ctx, canonicalVin, nextMileage, now);
  }
  return await ctx.db.get(insertedId);
}

async function buildVehiclePassportForBooking(ctx: any, booking: any) {
  const canonicalVin = toCanonicalVin(booking.vin);
  const serviceId = booking.service_ids?.[0];

  const [vehicle, passportRecord, vehicleLabels, owners, allBookings, allActuals, service] =
    await Promise.all([
      ctx.db
        .query("vehicles")
        .withIndex("by_vin", (q: any) => q.eq("vin", canonicalVin))
        .unique(),
      ctx.db
        .query("vehicle_passports")
        .withIndex("by_vin", (q: any) => q.eq("vin", canonicalVin))
        .unique(),
      resolveVehicleLabel(ctx, canonicalVin),
      ctx.db
        .query("vehicle_owners")
        .withIndex("by_vin", (q: any) => q.eq("vin", canonicalVin))
        .collect(),
      ctx.db.query("bookings").collect(),
      ctx.db.query("job_actuals").collect(),
      serviceId ? ctx.db.get(serviceId) : null,
    ]);

  const [trimSpec, engine, transmission, vehicleConfig] = await Promise.all([
    vehicle?.trim_id
      ? ctx.db
          .query("trim_specs")
          .withIndex("by_trim", (q: any) => q.eq("trim_id", vehicle.trim_id))
          .unique()
      : null,
    vehicle?.engine_id ? ctx.db.get(vehicle.engine_id) : null,
    vehicle?.transmission_id ? ctx.db.get(vehicle.transmission_id) : null,
    vehicle?.vehicle_config_id ? ctx.db.get(vehicle.vehicle_config_id) : null,
  ]);

  const preferredOwner = pickPreferredOwner(owners);
  const ownerDrivingType = firstDefinedString(
    preferredOwner?.usagePattern,
    preferredOwner?.usage_pattern,
    preferredOwner?.avgMonthlyDriving
  );
  const ownerOwnership = determineOwnershipLabel(preferredOwner);

  const mileage = firstDefinedNumber(passportRecord?.mileage, preferredOwner?.mileage);
  const mileageVelocity = firstDefinedNumber(
    passportRecord?.mileage_velocity,
    typeof preferredOwner?.annual_mileage_rate === "number"
      ? Math.round(preferredOwner.annual_mileage_rate / 12)
      : null
  );

  const passport = {
    mileage,
    last_reported_at: firstDefinedNumber(
      passportRecord?.last_reported_at,
      preferredOwner?.last_checkin_at
    ),
    mileage_velocity: mileageVelocity,
    tires: {
      brand: firstDefinedString(passportRecord?.tires?.brand),
      model: firstDefinedString(passportRecord?.tires?.model),
      size_front: firstDefinedString(
        passportRecord?.tires?.size_front,
        trimSpec?.tire_size_front
      ),
      size_rear: firstDefinedString(
        passportRecord?.tires?.size_rear,
        trimSpec?.tire_size_rear,
        trimSpec?.tire_size_front
      ),
      run_flat: firstDefinedBoolean(passportRecord?.tires?.run_flat, trimSpec?.is_run_flat),
      overall_condition: passportRecord?.tires?.overall_condition ?? null,
      front_condition: passportRecord?.tires?.front_condition ?? null,
      rear_condition: passportRecord?.tires?.rear_condition ?? null,
      last_verified_at: firstDefinedNumber(
        passportRecord?.tires?.last_verified_at,
        passportRecord?.last_shop_confirmed_at
      ),
    },
    fluids: {
      oil_viscosity: firstDefinedString(
        passportRecord?.fluids?.oil_viscosity,
        engine?.oil_viscosity
      ),
      oil_capacity_qts: firstDefinedNumber(
        passportRecord?.fluids?.oil_capacity_qts,
        engine?.oil_capacity_qts
      ),
      oil_type: firstDefinedString(
        passportRecord?.fluids?.oil_type,
        engine?.oil_spec_standard
      ),
      coolant_type: firstDefinedString(
        passportRecord?.fluids?.coolant_type,
        engine?.coolant_type
      ),
      brake_fluid_type: firstDefinedString(
        passportRecord?.fluids?.brake_fluid_type,
        vehicleConfig?.brake_fluid_type
      ),
      transmission_fluid_type: firstDefinedString(
        passportRecord?.fluids?.transmission_fluid_type,
        transmission?.fluid_type
      ),
      confirmation_status: firstDefinedString(passportRecord?.fluids?.confirmation_status),
    },
    brakes: {
      pad_brand: firstDefinedString(passportRecord?.brakes?.pad_brand),
      front_pad_mm: coerceNumberOrNull(passportRecord?.brakes?.front_pad_mm),
      rear_pad_mm: coerceNumberOrNull(passportRecord?.brakes?.rear_pad_mm),
      rotor_condition: passportRecord?.brakes?.rotor_condition ?? null,
    },
    inspection: {
      looks_current: firstDefinedBoolean(passportRecord?.inspection?.looks_current),
      expires_at: firstDefinedString(passportRecord?.inspection?.expires_at),
      status: passportRecord?.inspection?.status ?? null,
    },
    modifications: {
      status: passportRecord?.modifications?.status ?? null,
      notes: firstDefinedString(passportRecord?.modifications?.notes),
    },
  };

  const sources = {
    mileage: buildSourceTag(passportRecord?.mileage, preferredOwner?.mileage, "user_reported"),
    "tires.brand": buildSourceTag(passportRecord?.tires?.brand, null, "oem_default"),
    "tires.model": buildSourceTag(passportRecord?.tires?.model, null, "oem_default"),
    "tires.size_front": buildSourceTag(
      passportRecord?.tires?.size_front,
      trimSpec?.tire_size_front,
      "oem_default"
    ),
    "tires.size_rear": buildSourceTag(
      passportRecord?.tires?.size_rear,
      trimSpec?.tire_size_rear ?? trimSpec?.tire_size_front,
      "oem_default"
    ),
    "tires.run_flat": buildSourceTag(
      passportRecord?.tires?.run_flat,
      trimSpec?.is_run_flat,
      "oem_default"
    ),
    "tires.overall_condition": buildSourceTag(
      passportRecord?.tires?.overall_condition,
      null,
      "oem_default"
    ),
    "fluids.oil_viscosity": buildSourceTag(
      passportRecord?.fluids?.oil_viscosity,
      engine?.oil_viscosity,
      "oem_default"
    ),
    "fluids.oil_capacity_qts": buildSourceTag(
      passportRecord?.fluids?.oil_capacity_qts,
      engine?.oil_capacity_qts,
      "oem_default"
    ),
    "fluids.oil_type": buildSourceTag(
      passportRecord?.fluids?.oil_type,
      engine?.oil_spec_standard,
      "oem_default"
    ),
    "fluids.coolant_type": buildSourceTag(
      passportRecord?.fluids?.coolant_type,
      engine?.coolant_type,
      "oem_default"
    ),
    "fluids.brake_fluid_type": buildSourceTag(
      passportRecord?.fluids?.brake_fluid_type,
      vehicleConfig?.brake_fluid_type,
      "oem_default"
    ),
    "fluids.transmission_fluid_type": buildSourceTag(
      passportRecord?.fluids?.transmission_fluid_type,
      transmission?.fluid_type,
      "oem_default"
    ),
  };

  const bookingMap = new Map<string, any>();
  for (const existingBooking of allBookings) {
    bookingMap.set(String(existingBooking._id), existingBooking);
  }

  const completedVehicleBookings = allBookings
    .filter(
      (row: any) =>
        toCanonicalVin(row.vin) === canonicalVin && row.status === "completed"
    )
    .sort((left: any, right: any) => {
      const leftTime = left.updated_at ?? left._creationTime ?? 0;
      const rightTime = right.updated_at ?? right._creationTime ?? 0;
      return rightTime - leftTime;
    })
    .slice(0, 3);

  const recent_services = await Promise.all(
    completedVehicleBookings.map(async (row: any) => {
      const service_names = await resolveServiceNames(ctx, row.service_ids);
      return {
        date_label: formatShortDateLabel(row.scheduled_date, row.updated_at),
        service_name: service_names.join(", "),
        service_names,
        sort_ms: row.updated_at ?? row._creationTime ?? null,
      };
    })
  );

  const mechanicNameCache = new Map<string, string>();
  const mechanic_notes = [];
  for (const actual of allActuals) {
    if (!hasText(actual.technician_notes)) continue;
    const sourceBooking = bookingMap.get(String(actual.booking_id));
    if (!sourceBooking || toCanonicalVin(sourceBooking.vin) !== canonicalVin) continue;

    const mechanicKey = String(actual.mechanic_id ?? "");
    let author = mechanicNameCache.get(mechanicKey);
    if (author === undefined) {
      const mechanic = actual.mechanic_id ? await ctx.db.get(actual.mechanic_id) : null;
      author = mechanic
        ? `${mechanic.first_name} ${mechanic.last_name}`.trim()
        : "Shop staff";
      mechanicNameCache.set(mechanicKey, author);
    }

    mechanic_notes.push({
      note: actual.technician_notes.trim(),
      author,
      date_label: formatShortDateLabel(
        sourceBooking.scheduled_date,
        actual.completed_at_ms ?? actual.updated_at ?? actual.logged_at_ms
      ),
      sort_ms:
        actual.completed_at_ms ??
        actual.updated_at ??
        actual.logged_at_ms ??
        sourceBooking.updated_at ??
        0,
    });
  }
  mechanic_notes.sort((left, right) => right.sort_ms - left.sort_ms);

  const missing_fields = getMissingRequiredPassportFields(passport);

  return {
    vin: canonicalVin,
    vehicle_label: vehicleLabels.full,
    vehicle_short_label: vehicleLabels.short,
    service_name: service?.name ?? (await resolveServiceNames(ctx, booking.service_ids)).join(", "),
    service_slug: service?.slug ?? null,
    requires_parts: serviceRequiresParts(service),
    is_complete: missing_fields.length === 0,
    completion_percent: getPassportCompletionPercent(passport),
    missing_fields,
    passport,
    usage: {
      driving_type: ownerDrivingType,
      ownership: ownerOwnership,
    },
    recent_services,
    mechanic_notes: mechanic_notes.slice(0, 3).map((entry) => ({
      note: entry.note,
      author: entry.author,
      date_label: entry.date_label,
    })),
    sources,
  };
}

function validatePrejobReport(
  prejob: any,
  baselineMileage: number | null,
  serviceFlags: ReturnType<typeof getBookingServiceFlags>
) {
  if (typeof prejob.mileage !== "number" || !Number.isFinite(prejob.mileage)) {
    throw new Error("Mileage is required before starting this booking.");
  }
  if (!hasText(prejob.tire_brand)) {
    throw new Error("Tire brand is required before starting this booking.");
  }
  if (!hasText(prejob.tire_size_front)) {
    throw new Error("Front tire size is required before starting this booking.");
  }
  if (!hasText(prejob.tire_size_rear)) {
    throw new Error("Rear tire size is required before starting this booking.");
  }
  if (!hasText(prejob.front_tire_condition)) {
    throw new Error("Front tire condition is required before starting this booking.");
  }
  if (!hasText(prejob.rear_tire_condition)) {
    throw new Error("Rear tire condition is required before starting this booking.");
  }
  if (
    typeof baselineMileage === "number" &&
    prejob.mileage < baselineMileage
  ) {
    throw new Error(
      `Mileage cannot move backward. Stored mileage is ${baselineMileage.toLocaleString()}.`
    );
  }
  if (serviceFlags.hasBrakeWork) {
    if (
      typeof prejob.brakes?.front_pad_mm !== "number" ||
      !Number.isFinite(prejob.brakes.front_pad_mm)
    ) {
      throw new Error("Front pad thickness is required for brake-related work.");
    }
    if (
      typeof prejob.brakes?.rear_pad_mm !== "number" ||
      !Number.isFinite(prejob.brakes.rear_pad_mm)
    ) {
      throw new Error("Rear pad thickness is required for brake-related work.");
    }
    if (!hasText(prejob.brakes?.rotor_condition)) {
      throw new Error("Rotor condition is required for brake-related work.");
    }
  }
  if (serviceFlags.hasOilChange) {
    if (!hasText(prejob.fluid_overrides?.oil_viscosity)) {
      throw new Error("Oil viscosity is required for an oil change.");
    }
    if (!hasText(prejob.fluid_overrides?.oil_type)) {
      throw new Error("Oil type is required for an oil change.");
    }
  }
}

async function persistPrejobSurvey(
  ctx: any,
  {
    booking,
    passportView,
    prejob,
    now,
    startedAtMs,
  }: {
    booking: any;
    passportView: any;
    prejob: any;
    now: number;
    startedAtMs?: number;
  }
) {
  const jobActual = await ensureJobActualRecord(ctx, {
    booking,
    now,
    startedAtMs,
  });

  const jobActualPatch: Record<string, any> = {
    prejob_report: prejob,
    updated_at: now,
    logged_at_ms: now,
  };
  if (startedAtMs != null) {
    jobActualPatch.started_at = jobActual.started_at ?? startedAtMs;
  }

  await ctx.db.patch(jobActual._id, jobActualPatch);

  await upsertVehiclePassportRecord(ctx, {
    vin: booking.vin,
    patch: buildPassportPatchFromPrejob(prejob, passportView.passport),
    now,
    markConfirmed: true,
  });
}

function validatePostjobReport(postjob: any, baselineMileage: number | null, requiresParts: boolean) {
  if (
    typeof postjob.completion_mileage !== "number" ||
    !Number.isFinite(postjob.completion_mileage)
  ) {
    throw new Error("Completion mileage is required to close this job.");
  }
  if (
    typeof baselineMileage === "number" &&
    postjob.completion_mileage < baselineMileage
  ) {
    throw new Error(
      `Completion mileage cannot be lower than the stored mileage of ${baselineMileage.toLocaleString()}.`
    );
  }

  const normalizedParts = normalizePartsUsed(postjob.parts_used ?? []);
  if (requiresParts && normalizedParts.length === 0) {
    throw new Error("Parts used are required for this service before closing the job.");
  }
  if (
    postjob.flagged_vehicle_specs === true &&
    !hasText(postjob.flagged_vehicle_specs_reason)
  ) {
    throw new Error("Please explain why the vehicle specs should be reviewed.");
  }
  if (
    postjob.parts_accuracy_status === "different_parts" &&
    !hasText(postjob.parts_accuracy_feedback)
  ) {
    throw new Error("Please note which parts were different.");
  }
}

async function hasCompleteVehiclePassportForBooking(ctx: any, booking: any) {
  const canonicalVin = toCanonicalVin(booking.vin);
  const [passportRecord, owners] = await Promise.all([
    ctx.db
      .query("vehicle_passports")
      .withIndex("by_vin", (q: any) => q.eq("vin", canonicalVin))
      .unique(),
    ctx.db
      .query("vehicle_owners")
      .withIndex("by_vin", (q: any) => q.eq("vin", canonicalVin))
      .collect(),
  ]);

  const preferredOwner = pickPreferredOwner(owners);
  return (
    getMissingRequiredPassportFields({
      mileage: passportRecord?.mileage ?? preferredOwner?.mileage,
      tires: {
        brand: passportRecord?.tires?.brand,
        model: passportRecord?.tires?.model,
        overall_condition: passportRecord?.tires?.overall_condition,
      },
    }).length === 0
  );
}

async function resolveUserPhotoUrl(ctx: any, user: any) {
  if (!user) return null;
  if (user.profile_photo_storage_id) {
    const url = await ctx.storage.getUrl(user.profile_photo_storage_id);
    if (url) return url;
  }
  return user.profile_photo_url ?? null;
}

async function resolveMechanicPhotoUrl(ctx: any, mechanic: any) {
  if (!mechanic?.photo) return null;

  try {
    const asset = await ctx.db.get(mechanic.photo as any);
    if (asset?.url) return asset.url as string;
  } catch {
    // New mechanic uploads store Convex storage ids directly.
  }

  try {
    return await ctx.storage.getUrl(mechanic.photo);
  } catch {
    return null;
  }
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

async function getBookingMechanicId(ctx: any, booking: any) {
  if (booking.mechanic_id) return booking.mechanic_id;
  if (!booking.time_slot_id) return null;
  const slot = await ctx.db.get(booking.time_slot_id);
  return slot?.mechanic_id ?? null;
}

async function getManualBlockedSlotsForShop(ctx: any, shopId: any, date?: string) {
  const slots = await ctx.db
    .query("time_slots")
    .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shopId))
    .collect();

  const bookings = await ctx.db
    .query("bookings")
    .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shopId))
    .collect();
  const bookingSlotIds = new Set(
    bookings
      .filter((booking: any) => booking.time_slot_id)
      .map((booking: any) => String(booking.time_slot_id))
  );

  return slots.filter(
    (slot: any) =>
      !slot.is_available &&
      !bookingSlotIds.has(String(slot._id)) &&
      (date ? slot.date === date : true)
  );
}

async function getBlockingBookingsForShopDate(ctx: any, shopId: any, date: string) {
  const bookings = await ctx.db
    .query("bookings")
    .withIndex("by_shop_and_date", (q: any) =>
      q.eq("shop_id", shopId).eq("scheduled_date", date)
    )
    .collect();

  return bookings.filter((booking: any) => !TERMINAL_BOOKING_STATUSES.has(booking.status));
}

async function findExactSlot(
  ctx: any,
  shopId: any,
  mechanicId: any,
  date: string,
  startTime: string,
  durationMinutes: number
) {
  const endTime = addMinutesToHHMM(startTime, durationMinutes);
  const slots = await ctx.db
    .query("time_slots")
    .withIndex("by_shop_and_date", (q: any) => q.eq("shop_id", shopId).eq("date", date))
    .collect();

  return (
    slots.find(
      (slot: any) =>
        slot.start_time === startTime &&
        slot.end_time === endTime &&
        String(slot.mechanic_id) === String(mechanicId)
    ) ?? null
  );
}

async function getOrCreateSlot(
  ctx: any,
  shopId: any,
  mechanicId: any,
  date: string,
  startTime: string,
  durationMinutes: number
) {
  const endTime = addMinutesToHHMM(startTime, durationMinutes);
  const existing = await findExactSlot(
    ctx,
    shopId,
    mechanicId,
    date,
    startTime,
    durationMinutes
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

async function reservePendingCustomerSlot(
  ctx: any,
  shopId: any,
  mechanicId: any,
  date: string,
  startTime: string,
  durationMinutes: number,
  preferredSlotId?: any
) {
  const endTime = addMinutesToHHMM(startTime, durationMinutes);
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
    changed_by: changedBy ? String(changedBy) : undefined,
    reason,
    changed_at: Date.now(),
  });
}

async function assertMechanicWindowIsFree(
  ctx: any,
  {
    shopId,
    mechanicId,
    date,
    startTime,
    durationMinutes,
    excludeBookingId,
    allowAfterClose,
  }: {
    shopId: any;
    mechanicId: any;
    date: string;
    startTime: string;
    durationMinutes: number;
    excludeBookingId?: string;
    allowAfterClose?: boolean;
  }
) {
  const endTime = await assertBookingWithinShopHours(ctx, {
    shopId,
    date,
    startTime,
    durationMinutes,
    allowAfterClose,
  });
  const bookings = await getBlockingBookingsForShopDate(ctx, shopId, date);
  const blockedSlots = await getManualBlockedSlotsForShop(ctx, shopId, date);

  const hasBookingConflict = overlapsMechanicBooking(
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
  if (hasBookingConflict) {
    throw new Error("Cannot assign this mechanic because that time is already booked.");
  }

  const hasBlockedConflict = overlapsBlockedSlot(
    String(mechanicId),
    date,
    startTime,
    endTime,
    blockedSlots.map((slot: any) => ({
      _id: String(slot._id),
      date: slot.date,
      startTime: slot.start_time,
      endTime: slot.end_time,
      mechanicId: slot.mechanic_id ? String(slot.mechanic_id) : null,
    }))
  );
  if (hasBlockedConflict) {
    throw new Error("Cannot assign this mechanic because that time is blocked.");
  }
}

async function resolveMechanicForWindow(
  ctx: any,
  {
    shopId,
    date,
    startTime,
    durationMinutes,
    preferredMechanicId,
    excludeBookingId,
    allowAfterClose,
  }: {
    shopId: any;
    date: string;
    startTime: string;
    durationMinutes: number;
    preferredMechanicId?: any;
    excludeBookingId?: string;
    allowAfterClose?: boolean;
  }
) {
  await syncShopDateAvailability(ctx, { shopId, date });
  const activeMechanics = await getActiveMechanicsForShop(ctx, shopId);

  if (preferredMechanicId) {
    const preferredMechanic = activeMechanics.find(
      (mechanic: any) => String(mechanic._id) === String(preferredMechanicId)
    );
    if (!preferredMechanic) {
      throw new Error("Requested mechanic is unavailable.");
    }

    await assertMechanicWindowIsFree(ctx, {
      shopId,
      mechanicId: preferredMechanicId,
      date,
      startTime,
      durationMinutes,
      excludeBookingId,
      allowAfterClose,
    });

    return preferredMechanicId;
  }

  for (const mechanic of activeMechanics) {
    try {
      await assertMechanicWindowIsFree(ctx, {
        shopId,
        mechanicId: mechanic._id,
        date,
        startTime,
        durationMinutes,
        excludeBookingId,
        allowAfterClose,
      });
      return mechanic._id;
    } catch {
      continue;
    }
  }

  throw new Error("No mechanic is available for the requested time.");
}

async function syncBookingAssignments(
  ctx: any,
  assignments: Array<{ shopId: any; mechanicId?: any; date?: string }>
) {
  const seen = new Set<string>();

  for (const assignment of assignments) {
    if (!assignment.date) continue;

    const key = `${String(assignment.shopId)}:${String(assignment.mechanicId ?? "shop")}:${assignment.date}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (assignment.mechanicId) {
      await syncMechanicDayAvailability(ctx, {
        shopId: assignment.shopId,
        mechanicId: assignment.mechanicId,
        date: assignment.date,
      });
    } else {
      await syncShopDateAvailability(ctx, {
        shopId: assignment.shopId,
        date: assignment.date,
      });
    }
  }
}

async function runCompletionSideEffects(ctx: any, booking: any) {
  if (booking.vin) {
    const vehicleOwner = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_vin_user", (q: any) =>
        q.eq("vin", booking.vin).eq("user_id", booking.user_id)
      )
      .first();
    if (vehicleOwner?.preOnboardingComplete) {
      const SLUG_TO_TYPE: Record<string, string> = {
        "oil-change": "oil",
        "brake-pads": "brakes",
        "brake-rotors": "brakes",
        "tire-replacement": "tires",
        "tire-rotation": "tires",
        "tire-balance": "tires",
        "wheel-alignment": "tires",
        "battery-replacement": "battery",
        "battery-test": "battery",
        "brake-fluid-flush": "fluids",
        "coolant-flush": "fluids",
        "transmission-fluid": "fluids",
        "power-steering-flush": "fluids",
        "engine-air-filter": "filters",
        "cabin-air-filter": "filters",
        "wiper-blades": "wipers",
        "spark-plugs": "engine_parts",
        "serpentine-belt": "engine_parts",
        "check-engine-diagnostic": "diagnostics",
        "general-diagnostic": "diagnostics",
        "state-inspection": "inspection",
        "emissions-test": "inspection",
      };

      const serviceIds = booking.service_ids as string[] | undefined;
      if (serviceIds?.length) {
        const typesUpdated = new Set<string>();
        for (const serviceId of serviceIds) {
          const service = await ctx.db.get(serviceId as any);
          if (!service) continue;
          const recordType = SLUG_TO_TYPE[(service as any).slug];
          if (!recordType || typesUpdated.has(recordType)) continue;
          typesUpdated.add(recordType);

          const existing = await ctx.db
            .query("maintenance_records")
            .withIndex("by_vehicle_and_type", (q: any) =>
              q.eq("vehicleOwnerId", vehicleOwner._id).eq("type", recordType)
            )
            .unique();

          const now = Date.now();
          const data = {
            lastServiceDate: now,
            lastServiceMileage: vehicleOwner.mileage as number | undefined,
            serviceSource: "otopair" as const,
            confidence: "verified" as const,
            updatedAt: now,
          };

          if (existing) {
            await ctx.db.patch(existing._id, data);
          } else {
            await ctx.db.insert("maintenance_records", {
              vehicleOwnerId: vehicleOwner._id,
              type: recordType,
              ...data,
              createdAt: now,
            });
          }
        }
      }

      await ctx.scheduler.runAfter(0, internal.maintenance_pipeline.runPipeline, {
        vehicleOwnerId: vehicleOwner._id,
        triggeredBy: "booking_completed",
      });
    }
  }

  await ctx.scheduler.runAfter(0, internal.rewards.addCreditForCompletedBooking, {
    bookingId: booking._id,
  });
}

export async function applyBookingStatusTransition(
  ctx: any,
  {
    booking,
    newStatus,
    changedBy,
    reason,
  }: {
    booking: any;
    newStatus: string;
    changedBy?: any;
    reason?: string;
  }
) {
  const error = validateTransition(booking.status, newStatus);
  if (error) throw new Error(error);

  if (isTerminal(booking.status)) {
    throw new Error(`Cannot transition from terminal state: ${booking.status}`);
  }

  const patch: { status: string; updated_at: number; live_stage?: string } = {
    status: newStatus,
    updated_at: Date.now(),
  };
  if (newStatus === "confirmed") {
    patch.live_stage = "booking_confirmed";
  } else if (newStatus === "in_progress") {
    patch.live_stage = "service_in_progress";
  } else if (
    ["cancelled", "no_show", "completed", "pending_customer_acceptance"].includes(
      newStatus
    )
  ) {
    patch.live_stage = undefined;
  }

  await ctx.db.patch(booking._id, patch);

  if (
    ["cancelled", "no_show", "completed"].includes(newStatus) &&
    booking.time_slot_id
  ) {
    await releaseBookingSlot(ctx, booking.time_slot_id);
  }

  await logBookingStatusChange(
    ctx,
    booking._id,
    booking.status,
    newStatus,
    changedBy,
    reason
  );

  if (newStatus === "completed") {
    await runCompletionSideEffects(ctx, booking);
  }

  await syncBookingAssignments(ctx, [
    {
      shopId: booking.shop_id,
      mechanicId: booking.mechanic_id,
      date: booking.scheduled_date,
    },
  ]);

  return { success: true, oldStatus: booking.status, newStatus };
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
  const vehiclePassportComplete = await hasCompleteVehiclePassportForBooking(
    ctx,
    booking
  );

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
    vehiclePassportComplete,
    estimatedLaborMinutes: booking.estimated_labor_minutes ?? null,
    totalCost: booking.total_cost,
  };
}

export const getPendingJobsByShop = query({
  args: { shopId: v.id("shops") },
  handler: async (ctx, args) => {
    const pending = await Promise.all([
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

    const bookings = [...pending[0], ...pending[1]].sort(
      (a, b) => (b.created_at ?? 0) - (a.created_at ?? 0)
    );

    return await Promise.all(
      bookings.map(async (booking) => {
        const user = await ctx.db.get(booking.user_id);
        const vehicleLabel = await resolveVehicleLabel(ctx, booking.vin);

        let serviceName = "";
        if (booking.service_ids?.length) {
          const service = await ctx.db.get(booking.service_ids[0]);
          if (service) serviceName = service.name;
          if (booking.service_ids.length > 1) {
            serviceName += ` +${booking.service_ids.length - 1}`;
          }
        }

        const createdAt = booking.created_at ?? 0;
        const seconds = Math.floor((Date.now() - createdAt) / 1000);
        let ago = "just now";
        if (seconds >= 86400) ago = `${Math.floor(seconds / 86400)}d ago`;
        else if (seconds >= 3600) ago = `${Math.floor(seconds / 3600)}h ago`;
        else if (seconds >= 60) ago = `${Math.floor(seconds / 60)}m ago`;

        return {
          _id: booking._id,
          customerName: formatCustomerName(user),
          vehicle: vehicleLabel.full,
          service: serviceName,
          ago,
          scheduledTime: booking.scheduled_time
            ? formatTime(booking.scheduled_time)
            : "",
          estimatedMinutes: booking.estimated_labor_minutes ?? null,
        };
      })
    );
  },
});

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
    for (const booking of active) {
      if (booking.mechanic_id) {
        const key = String(booking.mechanic_id);
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
    return counts;
  },
});

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
        const vehicleLabel = await resolveVehicleLabel(ctx, booking.vin);
        const mechanic = booking.mechanic_id
          ? await ctx.db.get(booking.mechanic_id)
          : null;

        let serviceName = "";
        if (booking.service_ids?.length) {
          const service = await ctx.db.get(booking.service_ids[0]);
          if (service) serviceName = service.name;
          if (booking.service_ids.length > 1) {
            serviceName += ` +${booking.service_ids.length - 1}`;
          }
        }

        return {
          _id: booking._id,
          customerName: formatCustomerName(user),
          vehicle: vehicleLabel.full,
          service: serviceName,
          liveStage: booking.live_stage ?? null,
          mechanicName: mechanic
            ? `${mechanic.first_name} ${mechanic.last_name[0]}.`.trim()
            : null,
        };
      })
    );
  },
});

export const getTodaysBookingsByShop = query({
  args: { shopId: v.id("shops") },
  handler: async (ctx, args) => {
    const today = getTodayString();

    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_shop_and_date", (q) =>
        q.eq("shop_id", args.shopId).eq("scheduled_date", today)
      )
      .filter((q) => q.eq(q.field("status"), "confirmed"))
      .collect();

    bookings.sort((a, b) => (a.scheduled_time ?? "").localeCompare(b.scheduled_time ?? ""));

    return await Promise.all(
      bookings.map(async (booking) => {
        const user = await ctx.db.get(booking.user_id);
        const firstName = user?.first_name ?? "";
        const lastName = user?.last_name ?? "";
        const fullName = `${firstName} ${lastName}`.trim() || user?.email || "Unknown";
        const initials =
          `${firstName[0] ?? ""}${lastName[0] ?? ""}`.toUpperCase() || "?";

        const vehicleLabel = await resolveVehicleLabel(ctx, booking.vin);

        let serviceName = "";
        if (booking.service_ids?.length) {
          const service = await ctx.db.get(booking.service_ids[0]);
          if (service) serviceName = service.name;
          if (booking.service_ids.length > 1) {
            serviceName += ` +${booking.service_ids.length - 1}`;
          }
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

export const getCompletedTodayByShop = query({
  args: { shopId: v.id("shops") },
  handler: async (ctx, args) => {
    const today = getTodayString();
    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_shop_and_date", (q) =>
        q.eq("shop_id", args.shopId).eq("scheduled_date", today)
      )
      .filter((q) => q.eq(q.field("status"), "completed"))
      .collect();

    return {
      count: bookings.length,
      revenue: bookings.reduce((sum, booking) => sum + (booking.total_cost ?? 0), 0),
    };
  },
});

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
      mechanicShopUsers.map((shopUser: any) => String(shopUser.mechanic_id))
    );

    const mechanics = allMechanics.filter((mechanic: any) =>
      acceptedMechanicIds.has(String(mechanic._id))
    );

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
      mechanics: mechanics.map((mechanic: any) => ({
        _id: mechanic._id,
        name: `${mechanic.first_name} ${mechanic.last_name}`.trim(),
        isActive: mechanic.is_active,
      })),
      services: services.filter(Boolean),
    };
  },
});

export const getMyOwnerDashboard = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return null;

    const primary = await getPrimaryAuthorizedShop(ctx, user._id);
    if (!primary) return null;

    const shop: any = await ctx.db.get(primary.shopId);
    if (!shop) return null;

    const today = getTodayString();
    const startOfWeekMs = getStartOfCurrentWeekUtcMs();

    const todayBookingsRaw = await ctx.db
      .query("bookings")
      .withIndex("by_shop_and_date", (q: any) =>
        q.eq("shop_id", primary.shopId).eq("scheduled_date", today)
      )
      .collect();

    const todayBookings = todayBookingsRaw
      .filter(
        (booking: any) =>
          booking.status !== "cancelled" &&
          booking.status !== "declined" &&
          booking.status !== "no_show"
      )
      .sort(compareBookingsBySchedule);

    const pendingApprovals = (
      await Promise.all([
        ctx.db
          .query("bookings")
          .withIndex("by_shop_and_status", (q: any) =>
            q.eq("shop_id", primary.shopId).eq("status", "pending")
          )
          .collect(),
        ctx.db
          .query("bookings")
          .withIndex("by_shop_and_status", (q: any) =>
            q.eq("shop_id", primary.shopId).eq("status", "pending_shop_acceptance")
          )
          .collect(),
      ])
    )
      .flat()
      .sort((a: any, b: any) => (b.created_at ?? 0) - (a.created_at ?? 0));

    const acceptedMechanicShopUsers = await ctx.db
      .query("shop_users")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", primary.shopId))
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

    const todaySchedule = (
      await Promise.all(
        acceptedMechanicShopUsers.map(async (shopUser: any) => {
          const mechanic = shopUser.mechanic_id
            ? await ctx.db.get(shopUser.mechanic_id)
            : null;
          if (!mechanic || mechanic.is_active === false) return null;

          const linkedUser = shopUser.user_id ? await ctx.db.get(shopUser.user_id) : null;
          const photoUrl =
            (await resolveMechanicPhotoUrl(ctx, mechanic)) ??
            (await resolveUserPhotoUrl(ctx, linkedUser));

          const bookings = await Promise.all(
            todayBookings
              .filter(
                (booking: any) =>
                  String(booking.mechanic_id ?? "") === String(mechanic._id)
              )
              .map(async (booking: any) => {
                const mapped = await mapMechanicDashboardJob(ctx, booking);
                return {
                  ...mapped,
                  scheduledTimeLabel: booking.scheduled_time
                    ? formatTime(booking.scheduled_time)
                    : "",
                  serviceSummary: mapped.serviceNames.join(", "),
                };
              })
          );

          return {
            mechanicId: mechanic._id,
            mechanicName: `${mechanic.first_name} ${mechanic.last_name}`.trim(),
            firstName: mechanic.first_name,
            lastName: mechanic.last_name,
            photoUrl,
            jobsCount: bookings.length,
            bookings,
          };
        })
      )
    )
      .filter(Boolean)
      .sort((a: any, b: any) => a.mechanicName.localeCompare(b.mechanicName));

    const completedBookings = await ctx.db
      .query("bookings")
      .withIndex("by_shop_and_status", (q: any) =>
        q.eq("shop_id", primary.shopId).eq("status", "completed")
      )
      .collect();

    const jobActuals = await ctx.db.query("job_actuals").collect();
    const actualsByBookingId = new Map<string, any[]>();
    for (const actual of jobActuals) {
      const key = String(actual.booking_id);
      const existing = actualsByBookingId.get(key) ?? [];
      existing.push(actual);
      actualsByBookingId.set(key, existing);
    }

    const actualsNeededBookings = completedBookings
      .filter((booking: any) => {
        const rows = actualsByBookingId.get(String(booking._id)) ?? [];
        if (rows.length === 0) return true;
        return !rows.some((row: any) => row.finalized_at_ms != null);
      })
      .sort((a: any, b: any) => compareBookingsBySchedule(b, a));

    const pendingInvitations = (
      await ctx.db
        .query("shop_invitations")
        .withIndex("by_shop_id", (q: any) => q.eq("shop_id", primary.shopId))
        .filter((q: any) => q.eq(q.field("status"), "pending"))
        .collect()
    ).sort((a: any, b: any) => (b.created_at ?? 0) - (a.created_at ?? 0));

    const completedPayments = await ctx.db
      .query("payments")
      .withIndex("by_status", (q: any) => q.eq("status", "completed"))
      .collect();

    const weekRevenue = completedPayments.reduce((sum: number, payment: any) => {
      if (String(payment.shop_id ?? "") !== String(primary.shopId)) return sum;
      if ((payment.created_at ?? 0) < startOfWeekMs) return sum;
      return sum + (payment.amount ?? 0);
    }, 0);

    return {
      shop: {
        _id: shop._id,
        name: shop.name,
        logoUrl: shop.logo ?? null,
        rating: shop.rating ?? 0,
        reviewCount: shop.review_count ?? 0,
      },
      role: primary.role,
      stats: {
        todaysBookingsCount: todayBookings.length,
        pendingAcceptanceCount: pendingApprovals.length,
        weekRevenue,
        rating: shop.rating ?? 0,
        reviewCount: shop.review_count ?? 0,
      },
      todaySchedule,
      pendingActions: {
        jobsToAcceptCount: pendingApprovals.length,
        jobsToAccept: await Promise.all(
          pendingApprovals.map(async (booking: any) => {
            const item = await mapBookingListItem(ctx, booking);
            return {
              _id: item._id,
              customerName: item.customerName,
              vehicle: item.vehicle,
              serviceSummary: item.serviceNames.join(", "),
              scheduledDate: item.scheduledDate,
              scheduledTimeLabel: item.scheduledTime
                ? formatTime(item.scheduledTime)
                : "Time TBD",
            };
          })
        ),
        actualsNeededCount: actualsNeededBookings.length,
        actualsNeeded: await Promise.all(
          actualsNeededBookings.map(async (booking: any) => {
            const item = await mapBookingListItem(ctx, booking);
            return {
              _id: item._id,
              customerName: item.customerName,
              vehicle: item.vehicle,
              serviceSummary: item.serviceNames.join(", "),
              scheduledDate: item.scheduledDate,
              scheduledTimeLabel: item.scheduledTime
                ? formatTime(item.scheduledTime)
                : "Time TBD",
            };
          })
        ),
        invitesPendingCount: pendingInvitations.length,
        invitesPending: await Promise.all(
          pendingInvitations.map(async (invite: any) => {
            const mechanic = invite.mechanic_id ? await ctx.db.get(invite.mechanic_id) : null;
            return {
              _id: invite._id,
              email: invite.email,
              role: invite.role,
              createdAt: invite.created_at ?? 0,
              mechanicName: mechanic
                ? `${mechanic.first_name} ${mechanic.last_name}`.trim()
                : null,
            };
          })
        ),
      },
    };
  },
});

export const listForMyShop = query({
  args: { status: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return [];

    const primary = await getPrimaryAuthorizedShop(ctx, user._id);
    if (!primary) return [];

    let bookings = await ctx.db
      .query("bookings")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", primary.shopId))
      .collect();

    if (args.status) {
      bookings = bookings.filter((booking) => booking.status === args.status);
    }

    bookings.sort(compareBookingsBySchedule);
    return await Promise.all(bookings.map((booking) => mapBookingListItem(ctx, booking)));
  },
});

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
      (booking) =>
        String(booking.mechanic_id ?? "") === String(mechanicContext.mechanic._id)
    );

    if (args.status) {
      bookings = bookings.filter((booking) => booking.status === args.status);
    }

    bookings.sort(compareBookingsBySchedule);
    return await Promise.all(bookings.map((booking) => mapBookingListItem(ctx, booking)));
  },
});

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
    const actualsByBookingId = new Map<string, any[]>();
    for (const actual of actuals) {
      const key = String(actual.booking_id);
      const existing = actualsByBookingId.get(key) ?? [];
      existing.push(actual);
      actualsByBookingId.set(key, existing);
    }

    const needsActuals = myCompletedJobs.filter(
      (booking: any) => {
        const rows = actualsByBookingId.get(String(booking._id)) ?? [];
        if (rows.length === 0) return true;
        return !rows.some((row: any) => row.finalized_at_ms != null);
      }
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
    const jobActual = await getLatestJobActualForBooking(ctx, booking._id);

    const history = await ctx.db
      .query("booking_status_history")
      .withIndex("by_booking_id", (q: any) => q.eq("booking_id", booking._id))
      .collect();
    history.sort((a: any, b: any) => b.changed_at - a.changed_at);

    let previousMechanicName: string | null = null;
    if (booking.previous_mechanic_id) {
      const previousMechanic = await ctx.db.get(booking.previous_mechanic_id);
      if (previousMechanic) {
        previousMechanicName = `${previousMechanic.first_name} ${previousMechanic.last_name}`.trim();
      }
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
      customerName: formatCustomerName(customer),
      customerEmail: customer?.email ?? "",
      vehicle: vehicleLabels.full,
      vehicleShort: vehicleLabels.short,
      serviceNames,
      mechanicName: mechanic
        ? `${mechanic.first_name} ${mechanic.last_name}`.trim()
        : null,
      jobActuals: jobActual
        ? {
            _id: jobActual._id,
            status: jobActual.finalized_at_ms ? "finalized" : "draft",
            startedAt: jobActual.started_at ?? null,
            completedAtMs: jobActual.completed_at_ms ?? null,
            loggedAtMs: jobActual.logged_at_ms ?? null,
            finalizedAtMs: jobActual.finalized_at_ms ?? null,
            actualLaborMinutes: jobActual.actual_labor_minutes ?? null,
            actualPartsCost: jobActual.actual_parts_cost ?? null,
            difficultyRating: jobActual.difficulty_rating ?? null,
            technicianNotes: jobActual.technician_notes ?? "",
            prejobReport: jobActual.prejob_report ?? null,
            partsUsed: jobActual.parts_used ?? [],
          }
        : null,
      history,
      previousScheduledDate: booking.previous_scheduled_date ?? null,
      previousScheduledTime: booking.previous_scheduled_time ?? null,
      previousMechanicId: booking.previous_mechanic_id ?? null,
      previousMechanicName,
      rescheduleProposedAt: booking.reschedule_proposed_at ?? null,
    };
  },
});

export const getVehiclePassportForBooking = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) return null;

    await requireShopStaff(ctx, user._id, booking.shop_id);
    return await buildVehiclePassportForBooking(ctx, booking);
  },
});

// TODO: Remove confirmVehiclePassport - passport editing now happens exclusively via the pre-job survey. This mutation is no longer called from the frontend.
export const confirmVehiclePassport = mutation({
  args: {
    bookingId: v.id("bookings"),
    passport: vehiclePassportUpdateValidator,
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");

    await requireShopStaff(ctx, user._id, booking.shop_id);
    if (!["confirmed", "in_progress"].includes(booking.status)) {
      throw new Error("Only confirmed bookings can be started.");
    }

    const passportView = await buildVehiclePassportForBooking(ctx, booking);
    const normalizedPassport = {
      ...args.passport,
      mileage:
        typeof args.passport.mileage === "number" &&
        Number.isFinite(args.passport.mileage) &&
        args.passport.mileage >= 0
          ? args.passport.mileage
          : null,
      tires: args.passport.tires
        ? {
            ...args.passport.tires,
            brand: normalizeNullableText(args.passport.tires.brand),
            model: normalizeNullableText(args.passport.tires.model),
            overall_condition: isTireCondition(args.passport.tires.overall_condition)
              ? args.passport.tires.overall_condition
              : null,
          }
        : undefined,
    };
    const mergedPassport = {
      ...passportView.passport,
      mileage: normalizedPassport.mileage ?? passportView.passport.mileage,
      tires: {
        ...passportView.passport.tires,
        ...(normalizedPassport.tires ?? {}),
      },
    };
    const missingFields = getMissingRequiredPassportFields(mergedPassport);
    if (missingFields.length > 0) {
      throw new Error(
        `Missing required fields: ${missingFields
          .map(formatPassportFieldLabel)
          .join(", ")}.`
      );
    }

    await upsertVehiclePassportRecord(ctx, {
      vin: booking.vin,
      patch: normalizedPassport,
      now: Date.now(),
      markConfirmed: true,
    });

    return await buildVehiclePassportForBooking(ctx, booking);
  },
});

export const startWithPrejob = mutation({
  args: {
    bookingId: v.id("bookings"),
    prejob: prejobReportValidator,
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");

    await requireShopStaff(ctx, user._id, booking.shop_id);
    if (!["confirmed", "in_progress"].includes(booking.status)) {
      throw new Error("Only confirmed bookings can be started.");
    }

    const passportView = await buildVehiclePassportForBooking(ctx, booking);
    const serviceFlags = getBookingServiceFlags(
      await resolveServiceNames(ctx, booking.service_ids)
    );
    validatePrejobReport(
      args.prejob,
      passportView.passport.mileage ?? null,
      serviceFlags
    );

    const now = Date.now();
    await persistPrejobSurvey(ctx, {
      booking,
      passportView,
      prejob: args.prejob,
      now,
      startedAtMs: now,
    });

    if (booking.status !== "in_progress") {
      await applyBookingStatusTransition(ctx, {
        booking,
        newStatus: "in_progress",
        changedBy: user._id,
        reason: "started_by_shop",
      });
    }

    return await buildVehiclePassportForBooking(ctx, booking);
  },
});

export const savePrejob = mutation({
  args: {
    bookingId: v.id("bookings"),
    prejob: prejobReportValidator,
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");

    await requireShopStaff(ctx, user._id, booking.shop_id);
    if (!["confirmed", "in_progress"].includes(booking.status)) {
      throw new Error("Only confirmed or active bookings can save pre-job details.");
    }

    const passportView = await buildVehiclePassportForBooking(ctx, booking);
    const now = Date.now();

    await persistPrejobSurvey(ctx, {
      booking,
      passportView,
      prejob: args.prejob,
      now,
    });

    return await buildVehiclePassportForBooking(ctx, booking);
  },
});

export const completeWithPostjob = mutation({
  args: {
    bookingId: v.id("bookings"),
    postjob: postjobReportValidator,
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");

    await requireShopStaff(ctx, user._id, booking.shop_id);

    const passportView = await buildVehiclePassportForBooking(ctx, booking);
    validatePostjobReport(
      args.postjob,
      passportView.passport.mileage ?? null,
      passportView.requires_parts
    );

    const normalizedParts = normalizePartsUsed(args.postjob.parts_used ?? []);
    const now = Date.now();

    const jobActual = await saveJobActualDraft(ctx, {
      booking,
      actuals: {
        actual_labor_minutes:
          args.postjob.skip_optional_survey === true
            ? undefined
            : args.postjob.actual_labor_minutes ?? null,
        actual_parts_cost:
          args.postjob.skip_optional_survey === true
            ? sumPartsCost(normalizedParts)
            : args.postjob.actual_parts_cost ?? sumPartsCost(normalizedParts),
        difficulty_rating:
          args.postjob.skip_optional_survey === true
            ? undefined
            : args.postjob.difficulty_rating ?? null,
        technician_notes: args.postjob.technician_notes ?? "",
        parts_used: normalizedParts,
        completion_mileage: args.postjob.completion_mileage,
        vehicle_updates: args.postjob.vehicle_updates ?? undefined,
        parts_accuracy_status:
          args.postjob.skip_optional_survey === true
            ? undefined
            : args.postjob.parts_accuracy_status ?? null,
        parts_accuracy_feedback:
          args.postjob.skip_optional_survey === true
            ? undefined
            : args.postjob.parts_accuracy_feedback ?? null,
        additional_observations:
          args.postjob.skip_optional_survey === true
            ? undefined
            : args.postjob.additional_observations ?? null,
        flagged_vehicle_specs: args.postjob.flagged_vehicle_specs ?? false,
        flagged_vehicle_specs_reason:
          args.postjob.flagged_vehicle_specs_reason ?? null,
      },
      now,
      completedAtMs: now,
      preferAutoLaborMinutes: args.postjob.skip_optional_survey === true,
    });

    await ctx.db.patch(jobActual._id, {
      postjob_report: args.postjob,
      updated_at: now,
      logged_at_ms: now,
    });

    await upsertVehiclePassportRecord(ctx, {
      vin: booking.vin,
      patch: buildPassportPatchFromPostjob(args.postjob),
      now,
      markConfirmed: true,
    });

    if (booking.status !== "completed") {
      await applyBookingStatusTransition(ctx, {
        booking,
        newStatus: "completed",
        changedBy: user._id,
        reason: "completed_by_shop",
      });
    }

    return await buildVehiclePassportForBooking(ctx, booking);
  },
});

export const createByShop = mutation({
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
    allowOutsideShopHours: v.optional(v.boolean()),
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
        q.eq("vin", canonicalVin).eq("user_id", customer._id)
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
    const resolvedMechanicId = await resolveMechanicForWindow(ctx, {
      shopId: args.shopId,
      date: args.scheduledDate,
      startTime: args.scheduledTime,
      durationMinutes: estimatedMinutes,
      preferredMechanicId: args.mechanicId,
      allowAfterClose: args.allowOutsideShopHours === true,
    });

    const timeSlotId = await getOrCreateSlot(
      ctx,
      args.shopId,
      resolvedMechanicId,
      args.scheduledDate,
      args.scheduledTime,
      estimatedMinutes
    );

    const status = args.status ?? "pending_shop_acceptance";
    const bookingId = await ctx.db.insert("bookings", {
      labor_cost: args.laborCost,
      parts_cost: args.partsCost,
      total_cost: args.laborCost + args.partsCost,
      estimated_labor_minutes: args.estimatedLaborMinutes,
      mechanic_id: resolvedMechanicId,
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

    await syncBookingAssignments(ctx, [
      { shopId: args.shopId, mechanicId: resolvedMechanicId, date: args.scheduledDate },
    ]);

    return bookingId;
  },
});

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
    const currentMechanicId = await getBookingMechanicId(ctx, booking);

    const patch: any = { updated_at: Date.now() };
    const previousAssignment = {
      shopId: booking.shop_id,
      mechanicId: currentMechanicId,
      date: booking.scheduled_date,
    };

    if (args.serviceIds) patch.service_ids = args.serviceIds;
    if (args.estimatedLaborMinutes !== undefined) {
      patch.estimated_labor_minutes = args.estimatedLaborMinutes;
    }

    const laborCost = args.laborCost ?? booking.labor_cost ?? 0;
    const partsCost = args.partsCost ?? booking.parts_cost ?? 0;
    if (args.laborCost !== undefined) patch.labor_cost = args.laborCost;
    if (args.partsCost !== undefined) patch.parts_cost = args.partsCost;
    if (args.laborCost !== undefined || args.partsCost !== undefined) {
      patch.total_cost = laborCost + partsCost;
    }

    const schedulingChanged =
      args.scheduledDate !== undefined ||
      args.scheduledTime !== undefined ||
      args.mechanicId !== undefined ||
      args.estimatedLaborMinutes !== undefined;

    if (schedulingChanged) {
      const nextDate = args.scheduledDate ?? booking.scheduled_date;
      const nextTime = args.scheduledTime ?? booking.scheduled_time;
      const durationMinutes =
        args.estimatedLaborMinutes ?? booking.estimated_labor_minutes ?? 60;

      if (!nextDate || !nextTime) {
        throw new Error("Bookings must keep a scheduled date and time");
      }

      const requestedMechanicId =
        args.mechanicId === undefined
          ? currentMechanicId
          : args.mechanicId === null
            ? undefined
            : args.mechanicId;

      const resolvedMechanicId = await resolveMechanicForWindow(ctx, {
        shopId: booking.shop_id,
        date: nextDate,
        startTime: nextTime,
        durationMinutes,
        preferredMechanicId: requestedMechanicId,
        excludeBookingId: String(args.bookingId),
      });

      const slotId = await getOrCreateSlot(
        ctx,
        booking.shop_id,
        resolvedMechanicId,
        nextDate,
        nextTime,
        durationMinutes
      );

      patch.mechanic_id = resolvedMechanicId;
      patch.time_slot_id = slotId;
      patch.scheduled_date = nextDate;
      patch.scheduled_time = nextTime;

      if (booking.time_slot_id && String(slotId) !== String(booking.time_slot_id)) {
        await releaseBookingSlot(ctx, booking.time_slot_id);
      }
    }

    await ctx.db.patch(args.bookingId, patch);

    await syncBookingAssignments(ctx, [
      previousAssignment,
      {
        shopId: booking.shop_id,
        mechanicId: patch.mechanic_id ?? currentMechanicId,
        date: patch.scheduled_date ?? booking.scheduled_date,
      },
    ]);

    return args.bookingId;
  },
});

export const accept = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");

    await requireShopStaff(ctx, user._id, booking.shop_id);

    if (!["pending", "pending_shop_acceptance"].includes(booking.status)) {
      throw new Error("Only pending bookings can be accepted");
    }

    return await applyBookingStatusTransition(ctx, {
      booking,
      newStatus: "confirmed",
      changedBy: user._id,
      reason: "accepted_by_shop",
    });
  },
});

// TODO: Remove this legacy start mutation once every caller has migrated to startWithPrejob.
export const start = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");

    await requireShopStaff(ctx, user._id, booking.shop_id);

    const now = Date.now();
    await ensureJobActualRecord(ctx, {
      booking,
      now,
      startedAtMs: now,
    });

    return await applyBookingStatusTransition(ctx, {
      booking,
      newStatus: "in_progress",
      changedBy: user._id,
      reason: "started_by_shop",
    });
  },
});

// TODO: Remove this legacy complete mutation once every caller has migrated to completeWithPostjob.
export const complete = mutation({
  args: {
    bookingId: v.id("bookings"),
    finalizeActuals: v.optional(v.boolean()),
    actuals: v.optional(jobActualInputValidator),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");

    await requireShopStaff(ctx, user._id, booking.shop_id);

    const now = Date.now();

    await saveJobActualDraft(ctx, {
      booking,
      actuals: args.actuals,
      now,
      completedAtMs: now,
      preferAutoLaborMinutes: true,
    });

    const result = await applyBookingStatusTransition(ctx, {
      booking,
      newStatus: "completed",
      changedBy: user._id,
      reason: "completed_by_shop",
    });

    if (args.finalizeActuals) {
      const completedBooking = await ctx.db.get(args.bookingId);
      if (completedBooking) {
        await finalizeJobActuals(ctx, {
          booking: completedBooking,
          userId: user._id,
          actuals: args.actuals,
          now,
        });
      }
    }

    return result;
  },
});

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

    return await applyBookingStatusTransition(ctx, {
      booking,
      newStatus: "cancelled",
      changedBy: user._id,
      reason: args.reason ?? "cancelled_by_shop",
    });
  },
});

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

    const allowed = [
      "pending",
      "pending_shop_acceptance",
      "confirmed",
      "pending_customer_acceptance",
    ];
    if (!allowed.includes(booking.status)) {
      throw new Error(`Cannot reschedule a booking with status: ${booking.status}`);
    }

    const currentMechanicId = await getBookingMechanicId(ctx, booking);
    const durationMinutes = booking.estimated_labor_minutes ?? 60;
    const targetMechanicId = await resolveMechanicForWindow(ctx, {
      shopId: booking.shop_id,
      date: args.newScheduledDate,
      startTime: args.newScheduledTime,
      durationMinutes,
      preferredMechanicId: args.newMechanicId ?? currentMechanicId ?? undefined,
      excludeBookingId: String(args.bookingId),
    });

    const originalDate =
      booking.status === "pending_customer_acceptance"
        ? booking.previous_scheduled_date ?? booking.scheduled_date
        : booking.scheduled_date;
    const originalTime =
      booking.status === "pending_customer_acceptance"
        ? booking.previous_scheduled_time ?? booking.scheduled_time
        : booking.scheduled_time;
    const originalMechanicId =
      booking.status === "pending_customer_acceptance"
        ? booking.previous_mechanic_id ?? currentMechanicId
        : currentMechanicId;

    const targetSlotId = await getOrCreateSlot(
      ctx,
      booking.shop_id,
      targetMechanicId,
      args.newScheduledDate,
      args.newScheduledTime,
      durationMinutes
    );

    const patch: any = {
      scheduled_date: args.newScheduledDate,
      scheduled_time: args.newScheduledTime,
      mechanic_id: targetMechanicId,
      time_slot_id: targetSlotId,
      reschedule_proposed_at: Date.now(),
      status: "pending_customer_acceptance",
      updated_at: Date.now(),
      live_stage: undefined,
    };

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
        originalMechanicId,
        originalDate,
        originalTime,
        durationMinutes
      );
    } else {
      await reservePendingCustomerSlot(
        ctx,
        booking.shop_id,
        currentMechanicId,
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

    await syncBookingAssignments(ctx, [
      {
        shopId: booking.shop_id,
        mechanicId: originalMechanicId,
        date: originalDate,
      },
      {
        shopId: booking.shop_id,
        mechanicId: targetMechanicId,
        date: args.newScheduledDate,
      },
    ]);

    return booking._id;
  },
});

export const customerApproveReschedule = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");

    if (booking.status !== "pending_customer_acceptance") {
      throw new Error("Booking is not pending customer acceptance");
    }

    const currentMechanicId = await getBookingMechanicId(ctx, booking);
    const durationMinutes = booking.estimated_labor_minutes ?? 60;
    const originalDate = booking.previous_scheduled_date ?? booking.scheduled_date;
    const originalTime = booking.previous_scheduled_time ?? booking.scheduled_time;
    const originalMechanicId = booking.previous_mechanic_id ?? currentMechanicId;

    await ctx.db.patch(booking._id, {
      status: "confirmed",
      live_stage: "booking_confirmed",
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
      originalMechanicId,
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

    await syncBookingAssignments(ctx, [
      {
        shopId: booking.shop_id,
        mechanicId: originalMechanicId,
        date: originalDate,
      },
      {
        shopId: booking.shop_id,
        mechanicId: currentMechanicId,
        date: booking.scheduled_date,
      },
    ]);

    return booking._id;
  },
});

export const shopCancelReschedule = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");

    if (booking.status !== "pending_customer_acceptance") {
      throw new Error("Booking is not pending customer acceptance");
    }

    const currentMechanicId = await getBookingMechanicId(ctx, booking);
    const durationMinutes = booking.estimated_labor_minutes ?? 60;
    const originalDate = booking.previous_scheduled_date ?? booking.scheduled_date;
    const originalTime = booking.previous_scheduled_time ?? booking.scheduled_time;
    const originalMechanicId = booking.previous_mechanic_id ?? currentMechanicId;
    const originalStatus = booking.previous_status ?? "confirmed";
    const originalSlotId = await getOrCreateSlot(
      ctx,
      booking.shop_id,
      originalMechanicId,
      originalDate,
      originalTime,
      durationMinutes
    );

    await ctx.db.patch(booking._id, {
      status: originalStatus,
      live_stage: originalStatus === "confirmed" ? "booking_confirmed" : undefined,
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

    await syncBookingAssignments(ctx, [
      {
        shopId: booking.shop_id,
        mechanicId: currentMechanicId,
        date: booking.scheduled_date,
      },
      {
        shopId: booking.shop_id,
        mechanicId: originalMechanicId,
        date: originalDate,
      },
    ]);

    return booking._id;
  },
});

export const customerDeclineReschedule = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");

    if (booking.status !== "pending_customer_acceptance") {
      throw new Error("Booking is not pending customer acceptance");
    }

    const currentMechanicId = await getBookingMechanicId(ctx, booking);
    const durationMinutes = booking.estimated_labor_minutes ?? 60;
    const originalDate = booking.previous_scheduled_date ?? booking.scheduled_date;
    const originalTime = booking.previous_scheduled_time ?? booking.scheduled_time;
    const originalMechanicId = booking.previous_mechanic_id ?? currentMechanicId;
    const originalStatus = booking.previous_status ?? "confirmed";
    const originalSlotId = await getOrCreateSlot(
      ctx,
      booking.shop_id,
      originalMechanicId,
      originalDate,
      originalTime,
      durationMinutes
    );

    await ctx.db.patch(booking._id, {
      status: originalStatus,
      live_stage: originalStatus === "confirmed" ? "booking_confirmed" : undefined,
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

    await syncBookingAssignments(ctx, [
      {
        shopId: booking.shop_id,
        mechanicId: currentMechanicId,
        date: booking.scheduled_date,
      },
      {
        shopId: booking.shop_id,
        mechanicId: originalMechanicId,
        date: originalDate,
      },
    ]);

    return booking._id;
  },
});

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
      const currentMechanicId = await getBookingMechanicId(ctx, booking);
      const durationMinutes = booking.estimated_labor_minutes ?? 60;
      const originalDate = booking.previous_scheduled_date ?? booking.scheduled_date;
      const originalTime = booking.previous_scheduled_time ?? booking.scheduled_time;
      const originalMechanicId = booking.previous_mechanic_id ?? currentMechanicId;
      const originalStatus = booking.previous_status ?? "confirmed";
      const originalSlotId = await getOrCreateSlot(
        ctx,
        booking.shop_id,
        originalMechanicId,
        originalDate,
        originalTime,
        durationMinutes
      );

      await ctx.db.patch(booking._id, {
        status: originalStatus,
        live_stage: originalStatus === "confirmed" ? "booking_confirmed" : undefined,
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

      await syncBookingAssignments(ctx, [
        {
          shopId: booking.shop_id,
          mechanicId: currentMechanicId,
          date: booking.scheduled_date,
        },
        {
          shopId: booking.shop_id,
          mechanicId: originalMechanicId,
          date: originalDate,
        },
      ]);
    }

    return expired.length;
  },
});
