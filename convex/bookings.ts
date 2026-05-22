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
import { v, ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internal, api } from "./_generated/api";
import { isTerminal, validateTransition } from "./booking_status_history";
import { mintClaimToken } from "./walkin_claims";
import { BOOKING_STATUS_VISUALS, type BookingStatus } from "../lib/booking-status";
import {
  EARLY_PUSH_THRESHOLD_MS,
  addMinutesToHHMM,
  getBookingEndTime,
  overlapsBlockedSlot,
  overlapsMechanicBooking,
  roundDownToFiveMinutes,
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
  syncJobActualDerivedData,
} from "./lib/job_actuals";
import {
  getLateStartTimingConfig,
  isLateStartTestModeEnabled,
} from "./lib/late_start";
import {
  DEFAULT_OVERRUN_EXTENSION_FLOOR_MINUTES,
  DEFAULT_OVERRUN_EXTENSION_PERCENT,
  OVERRUN_EXTENSION_OPTIONS_MINUTES,
  getCustomerLateReminderOffsetsMs,
  getDefaultOverrunExtensionMinutes,
  normalizeAssignmentPreference,
  normalizeNoShowThresholdMinutes,
  roundUpToQuarterMinutes,
} from "../lib/scheduling-overhaul";
import {
  getMissingRequiredPassportFields,
  getPassportCompletionPercent,
  hasText,
  isTireCondition,
  mergePassportSection,
  postjobPhotoValidator,
  postjobReportValidator,
  prejobReportValidator,
  serviceRequiresParts,
  vehiclePassportUpdateValidator,
} from "./lib/vehicle_passports";
import { getBookingServiceFlags } from "../lib/vehicle-service-relevance";
import { insertSnapshotImpl } from "./part_snapshots";
import {
  closeRecForCompletedBooking,
  closeMatchingRecsForCompletedBooking,
  submitRecommendationsForBooking,
} from "./jobRecommendations";
import {
  templateForSystem,
  type DiagnosticSystem,
} from "../lib/diagnostic-checklist-templates";

function assertFlaggedItemsHaveNotes(booking: any) {
  const checklist = booking.diagnostic_checklist ?? [];
  const offenders = checklist.filter(
    (item: any) =>
      item.status === "flagged" &&
      (!item.mechanic_note || item.mechanic_note.trim().length === 0),
  );
  if (offenders.length > 0) {
    throw new Error(
      `Add a note to ${offenders.length} flagged item${offenders.length === 1 ? "" : "s"} before submitting.`,
    );
  }
}

function resolveDiagnosticSystem(
  booking: any,
  serviceNames: string[],
): DiagnosticSystem | null {
  if (booking.diagnostic_system) return booking.diagnostic_system as DiagnosticSystem;
  if (serviceNames.some((name) => /diagnost/i.test(name))) {
    return "not_sure";
  }
  return null;
}

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

const DEFAULT_SHOP_TIMEZONE = "America/New_York";
const DEFAULT_NO_SHOW_THRESHOLD_MINUTES = 30;
const MIN_NO_SHOW_THRESHOLD_MINUTES = 15;
const MAX_NO_SHOW_THRESHOLD_MINUTES = 60;
// DEFAULT_OVERRUN_EXTENSION_PERCENT and DEFAULT_OVERRUN_EXTENSION_FLOOR_MINUTES
// are imported from ../lib/scheduling-overhaul above — don't re-declare.
const CUSTOMER_LATE_PUSH_CAP_MINUTES = 10;
const CUSTOMER_LATE_SMS_CAP_MINUTES = 20;
const OVERRUN_MECHANIC_ESCALATION_MS = 3 * 60 * 1000;
const OVERRUN_DEFAULT_APPLY_MS = 6 * 60 * 1000;
const OVERRUN_EXTENSION_OPTIONS = new Set([15, 30, 45, 60]);

type AssignmentPreference = "any" | "specific_mechanic";

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function getAssignmentPreference(booking: any): AssignmentPreference {
  return booking?.assignment_preference === "specific_mechanic"
    ? "specific_mechanic"
    : "any";
}

function getNoShowThresholdMinutes(shop: any) {
  const raw = Number(shop?.no_show_threshold_minutes ?? DEFAULT_NO_SHOW_THRESHOLD_MINUTES);
  if (!Number.isFinite(raw)) return DEFAULT_NO_SHOW_THRESHOLD_MINUTES;
  return clampNumber(Math.round(raw), MIN_NO_SHOW_THRESHOLD_MINUTES, MAX_NO_SHOW_THRESHOLD_MINUTES);
}

function getOverrunExtensionSettings(shop: any) {
  const rawPercent = Number(
    shop?.overrun_default_extension_percent ?? DEFAULT_OVERRUN_EXTENSION_PERCENT
  );
  const rawFloor = Number(
    shop?.overrun_default_extension_floor_minutes ??
      DEFAULT_OVERRUN_EXTENSION_FLOOR_MINUTES
  );
  const percent = Number.isFinite(rawPercent)
    ? clampNumber(Math.round(rawPercent), 1, 100)
    : DEFAULT_OVERRUN_EXTENSION_PERCENT;
  const floorMinutes = Number.isFinite(rawFloor)
    ? Math.max(1, Math.round(rawFloor))
    : DEFAULT_OVERRUN_EXTENSION_FLOOR_MINUTES;
  return { percent, floorMinutes };
}

export function getCustomerLateReminderOffsets(thresholdMinutes: number) {
  const threshold = clampNumber(
    Math.round(thresholdMinutes),
    MIN_NO_SHOW_THRESHOLD_MINUTES,
    MAX_NO_SHOW_THRESHOLD_MINUTES
  );
  return {
    pushMinutes: Math.min(Math.floor(threshold / 3), CUSTOMER_LATE_PUSH_CAP_MINUTES),
    smsMinutes: Math.min(
      Math.floor((threshold * 2) / 3),
      CUSTOMER_LATE_SMS_CAP_MINUTES
    ),
  };
}

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
        // shop_id is optional now (quote-stage tire bookings have no shop yet).
        const shop = booking.shop_id ? await ctx.db.get(booking.shop_id) : null;
        const mechanic = booking.mechanic_id ? await ctx.db.get(booking.mechanic_id) : null;
        const shopName = shop?.name ?? "Awaiting shop quotes";
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
                    // TODO(ts-fix): make.logo is schema-typed as string but code calls db.get on it.
                    // Either schema should be Id<"_storage"> or this should read make.logo_url directly.
                    const logoAsset = await ctx.db.get(make.logo as any);
                    makeLogoUrl = (logoAsset as any)?.url;
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
            progressPercent = liveStage ? (LIVE_STAGE_PROGRESS[liveStage] ?? 25) : 25;
          }
        }

        return {
          _id: booking._id,
          _creationTime: booking._creationTime,
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
          /** Hero image of the vehicle itself (cached from VehicleDB).
           *  The card thumbnail prefers this; falls back to the brand
           *  logo (`makeLogoUrl`) when no hero image is available. */
          vehicleImageUrl: vehicle?.image_url,
          serviceNames,
          progressPercent,
          currentStage,
          delayMinutes,
          liveStage: liveStage ?? undefined,
          shopRating: shop?.rating ?? 0,
          shopIsVerified: shop?.is_verified ?? false,
          shopLat: shop?.lat,
          shopLng: shop?.lng,
          tire_specs: booking.tire_specs,
        };
      })
    );

    return results;
  },
});

/**
 * MUTATION: deleteBooking
 * Hard-deletes a booking row. Wired to the testing-only trash button on the
 * My Bookings cards so dev/staging users can clear out test data without
 * having to wait for completion or cascade through the proper lifecycle.
 * NOT intended for production user-facing flows — those should soft-delete
 * via the cancellation path.
 */
export const deleteBooking = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    // Idempotent — if the row was already deleted (e.g. duplicate fire from
    // React strict-mode double-invoke or a stale UI re-tap), silently no-op
    // instead of throwing "Delete on nonexistent document ID".
    const existing = await ctx.db.get(args.bookingId);
    if (!existing) return;
    await ctx.db.delete(args.bookingId);
  },
});

/**
 * MUTATION: cancelBooking
 * Soft-deletes a booking by flipping `status` to "cancelled". Used by the
 * "Cancel Appointment" / "Cancel Request" buttons on the My Bookings
 * cards. Cancelled bookings remain in Convex and surface in the user's
 * Booking History. Logs a status_history row for the audit trail.
 *
 * Idempotent — re-cancelling an already-cancelled booking is a no-op.
 */
export const cancelBooking = mutation({
  args: {
    bookingId: v.id("bookings"),
    /** Optional free-form reason. Defaults to "user_cancelled". */
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.bookingId);
    if (!existing) return;
    if (existing.status === "cancelled") return;
    const now = Date.now();
    const previousStatus = existing.status;
    await ctx.db.patch(args.bookingId, {
      status: "cancelled",
      updated_at: now,
    });
    await logBookingStatusChange(
      ctx,
      args.bookingId,
      previousStatus,
      "cancelled",
      existing.user_id,
      args.reason ?? "user_cancelled",
    );
    await syncBookingAssignments(ctx, [
      {
        shopId: existing.shop_id,
        mechanicId: existing.mechanic_id ?? undefined,
        date: existing.scheduled_date,
      },
    ]);
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
    bookings.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
    const seen = new Set<string>();
    const shopIds: string[] = [];
    for (const b of bookings) {
      const id = b.shop_id;
      if (id && !seen.has(id)) {
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
    bookings.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
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
 * QUERY: getShopBookingSeries
 * Daily aggregate of bookings + completed revenue for a shop over the last
 * `days` days. Powers the Payouts screen analytics charts.
 *
 * Returns an array of length `days` (oldest → newest, gaps filled with zeros)
 * shaped: { date: YYYY-MM-DD, total: number, completed: number, revenue: number }
 */
export const getShopBookingSeries = query({
  args: { shopId: v.id("shops"), days: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const days = Math.max(1, Math.min(args.days ?? 30, 180));
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setUTCDate(start.getUTCDate() - (days - 1));

    const fmt = (d: Date) =>
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    const startStr = fmt(start);
    const endStr = fmt(today);

    const rows = await ctx.db
      .query("bookings")
      .withIndex("by_shop_and_date", (q) =>
        q.eq("shop_id", args.shopId).gte("scheduled_date", startStr).lte("scheduled_date", endStr)
      )
      .collect();

    const buckets = new Map<string, { date: string; total: number; completed: number; revenue: number }>();
    for (let i = 0; i < days; i += 1) {
      const d = new Date(start);
      d.setUTCDate(start.getUTCDate() + i);
      const key = fmt(d);
      buckets.set(key, { date: key, total: 0, completed: 0, revenue: 0 });
    }

    for (const row of rows) {
      const key = row.scheduled_date;
      if (!key) continue;
      const bucket = buckets.get(key);
      if (!bucket) continue;
      bucket.total += 1;
      if (row.status === "completed") {
        bucket.completed += 1;
        bucket.revenue += row.total_cost ?? 0;
      }
    }

    return Array.from(buckets.values());
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
    source_recommendation_id: v.optional(v.id("job_recommendations")),
  },
  handler: async (ctx, args) => {
    const normalizedVin = toCanonicalVin(args.vin);

    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", normalizedVin))
      .unique();
    if (!vehicle) {
      throw new Error("We couldn't find this vehicle in our records. Double-check the VIN and try again.");
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
      assignment_preference: "any",
      created_at: now,
      updated_at: now,
      source_recommendation_id: args.source_recommendation_id,
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

    await enqueueNotificationOutbox(ctx, {
      shopId: args.shop_id,
      bookingId,
      channel: "front_desk",
      category: "new_booking",
      dedupeKey: `new-booking:${String(bookingId)}`,
      payload: { source: "customer_self_serve" },
    });

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
    source_recommendation_id: v.optional(v.id("job_recommendations")),
    customer_notes: v.optional(v.string()),
    selected_service_options: v.optional(
      v.array(
        v.object({
          service_id: v.id("services"),
          option_id: v.id("service_options"),
          option_label: v.string(),
          option_type: v.optional(v.string()),
        })
      )
    ),
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
      throw new Error("We couldn't find this vehicle in our records. Double-check the VIN and try again.");
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

    // ── Server-authoritative fee + tax derivation ─────────────────────
    // We deliberately IGNORE args.taxes_and_fees and args.platform_fee from
    // the client. The client computes those for optimistic display only;
    // the source of truth lives here so a malicious or stale client can't
    // undercharge. The same `computeBookingTax` util drives both display
    // and persisted value, so they always agree when the client is
    // honest.
    const shop = await ctx.db.get(args.shop_id);
    const { computeBookingTax: computeBookingTaxImpl } = await import(
      "../lib/tax"
    );

    const PLATFORM_FEE_RATE = 0.07;
    const PLATFORM_FEE_FLOOR = 4.99;
    const servicesSubtotal = labor_cost + parts_cost;
    const platform_fee =
      servicesSubtotal > 0
        ? Math.max(servicesSubtotal * PLATFORM_FEE_RATE, PLATFORM_FEE_FLOOR)
        : 0;
    const taxes_and_fees = computeBookingTaxImpl({
      laborDollars: labor_cost,
      partsDollars: parts_cost,
      state: shop?.state ?? null,
      zip: shop?.zip ?? null,
    }).taxDollars;

    // Optional cross-check: warn (don't reject) when client and server
    // disagree by > $0.05 — useful telemetry for shop/state misconfig.
    if (
      args.taxes_and_fees != null &&
      Math.abs(args.taxes_and_fees - taxes_and_fees) > 0.05
    ) {
      console.warn(
        `[createBatch] tax mismatch client=${args.taxes_and_fees} server=${taxes_and_fees} shop=${args.shop_id}`,
      );
    }
    if (
      args.platform_fee != null &&
      Math.abs(args.platform_fee - platform_fee) > 0.05
    ) {
      console.warn(
        `[createBatch] platform_fee mismatch client=${args.platform_fee} server=${platform_fee} shop=${args.shop_id}`,
      );
    }

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
      assignment_preference: "any",
      created_at: now,
      updated_at: now,
      source_recommendation_id: args.source_recommendation_id,
      customer_notes: args.customer_notes?.trim() ? args.customer_notes.trim() : undefined,
      selected_service_options:
        args.selected_service_options && args.selected_service_options.length > 0
          ? args.selected_service_options
          : undefined,
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

    await enqueueNotificationOutbox(ctx, {
      shopId: args.shop_id,
      bookingId,
      channel: "front_desk",
      category: "new_booking",
      dedupeKey: `new-booking:${String(bookingId)}`,
      payload: { source: "customer_self_serve" },
    });

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
    if (!booking) throw new Error("We couldn't find that booking. It may have been cancelled or removed.");
    if (args.newStatus === "no_show") {
      throw new Error("Use markPostThresholdNoShow to mark a booking no-show.");
    }

    return await applyBookingStatusTransition(ctx, {
      booking,
      newStatus: args.newStatus,
      changedBy: args.changed_by,
      reason: args.reason,
    });
  },
});

export const markVehicleAtShop = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("We couldn't find that booking. It may have been cancelled or removed.");

    await requireShopStaff(ctx, user._id, booking.shop_id);
    // Idempotent: if the booking is already at-shop, in-progress, or completed,
    // the vehicle has by definition arrived — treat as a no-op so flows that
    // skip vehicle_at_shop (e.g. straight confirmed -> in_progress when no
    // parts are needed) don't crash on a stale "mark arrived" call.
    if (
      booking.status === "vehicle_at_shop" ||
      booking.status === "in_progress" ||
      booking.status === "completed"
    ) {
      return { success: true, oldStatus: booking.status, newStatus: booking.status };
    }
    if (booking.status !== "confirmed") {
      throw new Error("Only confirmed bookings can be marked vehicle here.");
    }

    const now = Date.now();
    await ctx.db.patch(booking._id, {
      vehicle_arrived_at_ms: now,
      vehicle_arrived_by_user_id: user._id,
      updated_at: now,
    });

    return await applyBookingStatusTransition(ctx, {
      booking: {
        ...booking,
        vehicle_arrived_at_ms: now,
        vehicle_arrived_by_user_id: user._id,
      },
      newStatus: "vehicle_at_shop",
      changedBy: user._id,
      reason: "vehicle_arrived_at_shop",
    });
  },
});

/**
 * Computes the proposed early-push window for a confirmed booking when the
 * customer arrives more than EARLY_PUSH_THRESHOLD_MS before scheduled_time.
 * Returns the proposed slot plus any conflict so the dialog can preview
 * before the front desk commits.
 */
async function computeEarlyPushPreview(ctx: any, booking: any) {
  const durationMinutes = booking.estimated_labor_minutes ?? 60;
  const timezone = await getShopTimezone(ctx, booking.shop_id);
  const scheduledStartMs = toBookingDateTimeMs(
    booking.scheduled_date,
    booking.scheduled_time,
    timezone,
  );
  const now = Date.now();
  const minutesEarly = Math.max(0, Math.floor((scheduledStartMs - now) / 60_000));
  const eligible =
    booking.status === "confirmed" &&
    !!booking.mechanic_id &&
    now <= scheduledStartMs - EARLY_PUSH_THRESHOLD_MS;

  if (!eligible) {
    return {
      eligible: false as const,
      minutesEarly,
      scheduledStartMs,
      proposedScheduledDate: booking.scheduled_date,
      proposedScheduledTime: booking.scheduled_time,
      proposedEndTime: getBookingEndTime(booking.scheduled_time, durationMinutes),
      conflict: null,
      conflictingBookingId: null,
    };
  }

  const nowParts = getShopLocalDateTimeParts(timezone, new Date(now));
  const proposedScheduledTime = roundDownToFiveMinutes(nowParts.time);
  // If "now" rolled into a different calendar day than the original booking
  // (rare — customer "early" across midnight), fall back to scheduled_date
  // so the booking doesn't jump days. Same-day is the expected case.
  const proposedScheduledDate =
    nowParts.date === booking.scheduled_date ? nowParts.date : booking.scheduled_date;
  const proposedEndTime = getBookingEndTime(proposedScheduledTime, durationMinutes);

  let conflict: "booking" | "blocked" | "outside_shop_hours" | null = null;
  let conflictingBookingId: string | null = null;

  try {
    await assertBookingWithinShopHours(ctx, {
      shopId: booking.shop_id,
      date: proposedScheduledDate,
      startTime: proposedScheduledTime,
      durationMinutes,
    });
  } catch {
    conflict = "outside_shop_hours";
  }

  if (!conflict) {
    const dayBookings = await getBlockingBookingsForShopDate(
      ctx,
      booking.shop_id,
      proposedScheduledDate,
    );
    const conflictBooking = dayBookings.find((other: any) => {
      if (String(other._id) === String(booking._id)) return false;
      if (!other.mechanic_id) return false;
      if (String(other.mechanic_id) !== String(booking.mechanic_id)) return false;
      if (["cancelled", "declined", "no_show"].includes(other.status)) return false;
      const otherStart = hhmmToMinutes(other.scheduled_time);
      const otherEnd = otherStart + (other.estimated_labor_minutes ?? 60);
      const newStart = hhmmToMinutes(proposedScheduledTime);
      const newEnd = hhmmToMinutes(proposedEndTime);
      return otherStart < newEnd && otherEnd > newStart;
    });
    if (conflictBooking) {
      conflict = "booking";
      conflictingBookingId = String(conflictBooking._id);
    } else {
      const blocked = await getManualBlockedSlotsForShop(
        ctx,
        booking.shop_id,
        proposedScheduledDate,
      );
      const blockedConflict = blocked.find((slot: any) => {
        if (slot.mechanic_id && String(slot.mechanic_id) !== String(booking.mechanic_id)) {
          return false;
        }
        const sStart = hhmmToMinutes(slot.start_time);
        const sEnd = hhmmToMinutes(slot.end_time);
        const newStart = hhmmToMinutes(proposedScheduledTime);
        const newEnd = hhmmToMinutes(proposedEndTime);
        return sStart < newEnd && sEnd > newStart;
      });
      if (blockedConflict) {
        conflict = "blocked";
      }
    }
  }

  return {
    eligible: true as const,
    minutesEarly,
    scheduledStartMs,
    proposedScheduledDate,
    proposedScheduledTime,
    proposedEndTime,
    conflict,
    conflictingBookingId,
  };
}

/**
 * Returns the booking, if any, that a mechanic is currently working on
 * (status = "in_progress"). Used to enforce the "one active job per mechanic"
 * invariant: callers query first, surface a confirmation if a different
 * booking is active, then proceed to start the new one once the active job
 * has been completed.
 *
 * Excludes the optional `excludeBookingId` so the caller can ask "is anyone
 * else's job blocking THIS booking from starting" without matching itself.
 */
async function findMechanicActiveBooking(
  ctx: any,
  shopId: any,
  mechanicId: any,
  excludeBookingId?: any,
) {
  const inProgress = await ctx.db
    .query("bookings")
    .withIndex("by_shop_and_status", (q: any) =>
      q.eq("shop_id", shopId).eq("status", "in_progress"),
    )
    .collect();
  return inProgress.find(
    (b: any) =>
      b.mechanic_id &&
      String(b.mechanic_id) === String(mechanicId) &&
      (!excludeBookingId || String(b._id) !== String(excludeBookingId)),
  );
}

async function buildActiveJobSummary(
  ctx: any,
  active: any,
  mechanicId: any,
) {
  const customer = active.user_id ? await ctx.db.get(active.user_id) : null;
  const vehicle = active.vin ? await resolveVehicleLabel(ctx, active.vin) : null;
  const serviceNames = await resolveServiceNames(ctx, active.service_ids);
  const mechanic = await ctx.db.get(mechanicId);
  return {
    bookingId: active._id,
    customerName: customer ? formatCustomerName(customer) : null,
    vehicleLabel: vehicle?.full ?? vehicle?.short ?? null,
    serviceSummary: serviceNames.length > 0 ? serviceNames.join(" + ") : null,
    scheduledDate: active.scheduled_date,
    scheduledTime: active.scheduled_time,
    mechanicName: mechanic
      ? `${(mechanic as any).first_name ?? ""} ${(mechanic as any).last_name ?? ""}`.trim() ||
        "Mechanic"
      : "Mechanic",
  };
}

export const getMechanicActiveJob = query({
  args: {
    mechanicId: v.id("mechanics"),
    shopId: v.id("shops"),
    excludeBookingId: v.optional(v.id("bookings")),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    await requireShopStaff(ctx, user._id, args.shopId);

    const active = await findMechanicActiveBooking(
      ctx,
      args.shopId,
      args.mechanicId,
      args.excludeBookingId,
    );
    if (!active) return null;
    return await buildActiveJobSummary(ctx, active, args.mechanicId);
  },
});

/**
 * Role-aware: returns whatever the persistent header strip should show.
 *  - mechanic: their single in_progress booking (or null)
 *  - owner / manager / front_desk: the list of all in_progress bookings
 *    across all mechanics in their primary shop
 *  - anyone else (no shop access): null
 *
 * Cheap to subscribe to; cached by Convex. Mounted globally in the portal
 * layout so the strip shows on every page.
 */
export const getActiveJobsForHeader = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return null;

    const primary = await getPrimaryAuthorizedShop(ctx, user._id);
    if (!primary) return null;

    const mechanicContext = await getMechanicMembershipForUser(
      ctx,
      user._id,
      primary.shopId,
    );

    if (mechanicContext) {
      const active = await findMechanicActiveBooking(
        ctx,
        primary.shopId,
        mechanicContext.mechanic._id,
      );
      if (!active) return { kind: "mechanic" as const, job: null };
      const jobActual = await getLatestJobActualForBooking(ctx, active._id);
      const vehicle = active.vin ? await resolveVehicleLabel(ctx, active.vin) : null;
      const serviceNames = await resolveServiceNames(ctx, active.service_ids);
      return {
        kind: "mechanic" as const,
        job: {
          bookingId: active._id,
          vehicleLabel: vehicle?.full ?? vehicle?.short ?? "Vehicle",
          serviceSummary: serviceNames.join(" · "),
          startedAtMs: jobActual?.started_at ?? null,
        },
      };
    }

    const inProgress = await ctx.db
      .query("bookings")
      .withIndex("by_shop_and_status", (q: any) =>
        q.eq("shop_id", primary.shopId).eq("status", "in_progress"),
      )
      .collect();

    if (inProgress.length === 0) {
      return { kind: "owner" as const, count: 0, firstBookingId: null };
    }

    inProgress.sort((a: any, b: any) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
    return {
      kind: "owner" as const,
      count: inProgress.length,
      firstBookingId: inProgress[0]._id,
    };
  },
});

/**
 * Booking-centric variant: returns the active in_progress booking blocking
 * THIS booking from starting (same mechanic, different booking). Returns
 * null if the booking has no mechanic, or if the mechanic is free.
 */
export const getActiveJobConflictForBooking = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) return null;
    await requireShopStaff(ctx, user._id, booking.shop_id);
    if (!booking.mechanic_id) return null;

    const active = await findMechanicActiveBooking(
      ctx,
      booking.shop_id,
      booking.mechanic_id,
      booking._id,
    );
    if (!active) return null;
    return await buildActiveJobSummary(ctx, active, booking.mechanic_id);
  },
});

/**
 * Fallback for the MECHANIC_HAS_ACTIVE_JOB race path: builds the same
 * active-job summary directly from a known conflicting booking id, so the
 * client can render the dialog immediately instead of waiting for
 * `getActiveJobConflictForBooking` to refresh reactively.
 */
export const getActiveJobSummaryById = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) return null;
    await requireShopStaff(ctx, user._id, booking.shop_id);
    if (!booking.mechanic_id) return null;
    return await buildActiveJobSummary(ctx, booking, booking.mechanic_id);
  },
});

export const getEarlyPushPreview = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found.");
    await requireShopStaff(ctx, user._id, booking.shop_id);
    return await computeEarlyPushPreview(ctx, booking);
  },
});

export const pushBookingEarlierAndArrive = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("We couldn't find that booking. It may have been cancelled or removed.");

    await requireShopStaff(ctx, user._id, booking.shop_id);

    if (booking.status !== "confirmed") {
      throw new Error("Only confirmed bookings can be pushed earlier.");
    }
    if (!booking.mechanic_id) {
      throw new Error("Assign a mechanic before pushing this booking earlier.");
    }

    const preview = await computeEarlyPushPreview(ctx, booking);
    if (!preview.eligible) {
      throw new Error(
        "Customer isn't early enough to push the booking — must be at least 10 minutes before scheduled start.",
      );
    }
    if (preview.conflict === "outside_shop_hours") {
      throw new Error("The proposed earlier start is outside the shop's operating hours.");
    }
    if (preview.conflict === "booking") {
      throw new Error("Cannot push earlier — the mechanic has another booking in that window.");
    }
    if (preview.conflict === "blocked") {
      throw new Error("Cannot push earlier — the mechanic has a blocked slot in that window.");
    }

    const durationMinutes = booking.estimated_labor_minutes ?? 60;
    // Defense-in-depth: re-validate via the canonical helper so we get the
    // same errors any other reschedule path would surface.
    await resolveMechanicForWindow(ctx, {
      shopId: booking.shop_id,
      date: preview.proposedScheduledDate,
      startTime: preview.proposedScheduledTime,
      durationMinutes,
      preferredMechanicId: booking.mechanic_id,
      excludeBookingId: String(booking._id),
      allowAfterClose: false,
    });

    const slotId = await getOrCreateSlot(
      ctx,
      booking.shop_id,
      booking.mechanic_id,
      preview.proposedScheduledDate,
      preview.proposedScheduledTime,
      durationMinutes,
    );

    const oldSlotId = booking.time_slot_id;
    const oldScheduledDate = booking.scheduled_date;
    const now = Date.now();

    await ctx.db.patch(booking._id, {
      scheduled_date: preview.proposedScheduledDate,
      scheduled_time: preview.proposedScheduledTime,
      time_slot_id: slotId,
      vehicle_arrived_at_ms: now,
      vehicle_arrived_by_user_id: user._id,
      updated_at: now,
    });

    if (oldSlotId && String(oldSlotId) !== String(slotId)) {
      await releaseBookingSlot(ctx, oldSlotId);
    }

    const movedBooking = {
      ...booking,
      scheduled_date: preview.proposedScheduledDate,
      scheduled_time: preview.proposedScheduledTime,
      time_slot_id: slotId,
      vehicle_arrived_at_ms: now,
      vehicle_arrived_by_user_id: user._id,
    };

    const result = await applyBookingStatusTransition(ctx, {
      booking: movedBooking,
      newStatus: "vehicle_at_shop",
      changedBy: user._id,
      reason: "customer_early_push",
    });

    await syncBookingAssignments(ctx, [
      {
        shopId: booking.shop_id,
        mechanicId: booking.mechanic_id,
        date: oldScheduledDate,
      },
      {
        shopId: booking.shop_id,
        mechanicId: booking.mechanic_id,
        date: preview.proposedScheduledDate,
      },
    ]);

    await resolveCustomerLateMonitorForBooking(ctx, movedBooking, user._id);
    await upsertAppointmentReminderForBooking(ctx, movedBooking);

    return result;
  },
});

async function assertCustomerLateThresholdReached(ctx: any, booking: any) {
  if (booking.status !== "confirmed") {
    throw new Error("Only confirmed bookings can use no-show threshold actions.");
  }
  const monitor = await getCustomerLateMonitorByBookingId(ctx, booking._id);
  const thresholdDueAtMs =
    monitor?.threshold_due_at_ms ??
    (await getCustomerLateMonitorWindow(ctx, booking)).thresholdDueAtMs;
  if (Date.now() < thresholdDueAtMs) {
    throw new Error("No-show threshold has not been reached yet.");
  }
  return thresholdDueAtMs;
}

export const markPostThresholdNoShow = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("We couldn't find that booking. It may have been cancelled or removed.");

    await requireShopStaff(ctx, user._id, booking.shop_id);
    await assertCustomerLateThresholdReached(ctx, booking);

    const result = await applyBookingStatusTransition(ctx, {
      booking,
      newStatus: "no_show",
      changedBy: user._id,
      reason: "post_threshold_customer_no_show",
    });
    // Stripe void is scheduled centrally by applyBookingStatusTransition.
    return result;
  },
});

// Customer-facing "On my way" acknowledgement. Cancels the queued SMS
// reminder but leaves the no-show threshold timer running — late arrival
// still gets caught if they never actually show up.
export const acknowledgeCustomerLate = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found.");
    if ((booking as any).user_id !== user._id) {
      throw new Error("Not your booking.");
    }

    const monitor = await getCustomerLateMonitorByBookingId(ctx, booking._id);
    if (!monitor) return { acknowledged: false };

    const now = Date.now();
    await ctx.db.patch(monitor._id, {
      customer_acknowledged_at_ms: now,
      updated_at: now,
    } as any);

    // Cancel any pending SMS outbox row for this monitor.
    const pendingSms = await ctx.db
      .query("notification_outbox")
      .withIndex("by_booking_id", (q: any) =>
        q.eq("booking_id", booking._id),
      )
      .collect();
    for (const row of pendingSms) {
      if (
        (row as any).channel === "sms" &&
        (row as any).category === "customer_late_sms_reminder" &&
        (row as any).status === "pending"
      ) {
        await ctx.db.patch(row._id, {
          status: "superseded",
          processed_at: now,
          updated_at: now,
        } as any);
      }
    }

    return { acknowledged: true, monitorId: monitor._id };
  },
});

async function moveBookingDirectlyToConfirmedSlot(
  ctx: any,
  {
    booking,
    newScheduledDate,
    newScheduledTime,
    newMechanicId,
    assignmentPreference,
    allowOutsideShopHours,
    changedBy,
    reason,
  }: {
    booking: any;
    newScheduledDate: string;
    newScheduledTime: string;
    newMechanicId?: any;
    assignmentPreference?: string;
    allowOutsideShopHours?: boolean;
    changedBy?: any;
    reason: string;
  },
) {
  const currentMechanicId = await getBookingMechanicId(ctx, booking);
  const durationMinutes = booking.estimated_labor_minutes ?? 60;
  const preference =
    assignmentPreference === "specific_mechanic" || newMechanicId
      ? "specific_mechanic"
      : "any";
  const targetMechanicId = await resolveMechanicForWindow(ctx, {
    shopId: booking.shop_id,
    date: newScheduledDate,
    startTime: newScheduledTime,
    durationMinutes,
    preferredMechanicId:
      preference === "specific_mechanic"
        ? newMechanicId ?? currentMechanicId ?? undefined
        : undefined,
    excludeBookingId: String(booking._id),
    allowAfterClose: allowOutsideShopHours === true,
  });
  const slotId = await getOrCreateSlot(
    ctx,
    booking.shop_id,
    targetMechanicId,
    newScheduledDate,
    newScheduledTime,
    durationMinutes,
  );

  await ctx.db.patch(booking._id, {
    scheduled_date: newScheduledDate,
    scheduled_time: newScheduledTime,
    mechanic_id: targetMechanicId,
    time_slot_id: slotId,
    status: "confirmed",
    live_stage: "booking_confirmed",
    assignment_preference: preference,
    vehicle_arrived_at_ms: undefined,
    vehicle_arrived_by_user_id: undefined,
    previous_scheduled_date: undefined,
    previous_scheduled_time: undefined,
    previous_mechanic_id: undefined,
    previous_status: undefined,
    reschedule_proposed_at: undefined,
    schedule_change_mode: undefined,
    schedule_change_source_booking_id: undefined,
    customer_can_restore_original: undefined,
    updated_at: Date.now(),
  });

  if (booking.time_slot_id && String(booking.time_slot_id) !== String(slotId)) {
    await releaseBookingSlot(ctx, booking.time_slot_id);
  }

  await logBookingStatusChange(
    ctx,
    booking._id,
    booking.status,
    "confirmed",
    changedBy,
    reason,
  );

  await syncBookingAssignments(ctx, [
    {
      shopId: booking.shop_id,
      mechanicId: currentMechanicId,
      date: booking.scheduled_date,
    },
    {
      shopId: booking.shop_id,
      mechanicId: targetMechanicId,
      date: newScheduledDate,
    },
  ]);

  await resolveCustomerLateMonitorForBooking(ctx, booking, changedBy);
  const nextBookingForMonitors = {
    ...booking,
    scheduled_date: newScheduledDate,
    scheduled_time: newScheduledTime,
    mechanic_id: targetMechanicId,
    time_slot_id: slotId,
    status: "confirmed",
    assignment_preference: preference,
    vehicle_arrived_at_ms: undefined,
  };
  await upsertCustomerLateMonitorForBooking(ctx, nextBookingForMonitors);
  await upsertAppointmentReminderForBooking(ctx, nextBookingForMonitors);

  await enqueueNotificationOutbox(ctx, {
    shopId: booking.shop_id,
    bookingId: booking._id,
    userId: booking.user_id,
    channel: "push",
    category: "schedule_courtesy_update",
    dedupeKey: `direct-reschedule:${String(booking._id)}:${newScheduledDate}:${newScheduledTime}:${String(targetMechanicId)}`,
    payload: {
      source: "front_desk_no_show_alert",
      newDate: newScheduledDate,
      newTime: newScheduledTime,
      newMechanicId: String(targetMechanicId),
    },
  });

  return booking._id;
}

export const rescheduleFromNoShowAlert = mutation({
  args: {
    bookingId: v.id("bookings"),
    newScheduledDate: v.string(),
    newScheduledTime: v.string(),
    newMechanicId: v.optional(v.id("mechanics")),
    assignmentPreference: v.optional(
      v.union(v.literal("any"), v.literal("specific_mechanic")),
    ),
    allowOutsideShopHours: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("We couldn't find that booking. It may have been cancelled or removed.");

    await requireShopStaff(ctx, user._id, booking.shop_id);
    await assertCustomerLateThresholdReached(ctx, booking);

    return await moveBookingDirectlyToConfirmedSlot(ctx, {
      booking,
      newScheduledDate: args.newScheduledDate,
      newScheduledTime: args.newScheduledTime,
      newMechanicId: args.newMechanicId,
      assignmentPreference: args.assignmentPreference,
      allowOutsideShopHours: args.allowOutsideShopHours,
      changedBy: user._id,
      reason: "post_threshold_rescheduled_by_front_desk",
    });
  },
});

function getOverrunAnswerSource(shopUser: any): "mechanic" | "front_desk" {
  return shopUser?.role === "shop_mechanic" || shopUser?.role === "mechanic"
    ? "mechanic"
    : "front_desk";
}

// E4 — Passive no-show feed. Returns booking_status_history rows where
// new_status = "no_show" within the last `lookbackMinutes` for the user's
// shop. Front-desk header subscribes for a non-blocking banner.
export const getRecentNoShows = query({
  args: { lookbackMinutes: v.optional(v.number()) },
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    const primary = await getPrimaryAuthorizedShop(ctx, user._id);
    if (!primary?.shopId) return [];
    const shopIds = [primary.shopId];

    const lookbackMs = 30 * 60 * 1000;
    const cutoff = Date.now() - lookbackMs;

    const rows = await ctx.db
      .query("booking_status_history")
      .withIndex("by_changed_at", (q: any) => q.gte("changed_at", cutoff))
      .collect();

    const noShows = rows.filter(
      (r: any) => r.new_status === "no_show",
    );

    const results: any[] = [];
    const seenBookings = new Set<string>();
    for (const row of noShows) {
      const bid = String((row as any).booking_id);
      if (seenBookings.has(bid)) continue;
      seenBookings.add(bid);
      const booking: any = await ctx.db.get((row as any).booking_id);
      if (!booking || !shopIds.includes(booking.shop_id)) continue;
      const customer: any = booking.user_id
        ? await ctx.db.get(booking.user_id)
        : null;
      const composed = [customer?.first_name, customer?.last_name]
        .filter(Boolean)
        .join(" ");
      const customerName =
        customer?.name ||
        (composed.length > 0 ? composed : null) ||
        customer?.email ||
        "Customer";
      let vehicleLabel: string | null = null;
      if (booking.vehicle_id) {
        const vehicle: any = await ctx.db.get(booking.vehicle_id);
        if (vehicle) {
          const meta = vehicle.metadata ?? {};
          const parts = [vehicle.year ?? meta.year, meta.make, meta.model].filter(
            Boolean,
          );
          vehicleLabel =
            parts.length > 0
              ? parts.join(" ")
              : vehicle.vin
                ? `VIN …${String(vehicle.vin).slice(-6)}`
                : null;
        }
      }
      results.push({
        bookingId: booking._id,
        customerName,
        vehicleLabel,
        shortHandle: bookingDisplayHandle(booking),
        scheduledTime: booking.scheduled_time,
        scheduledDate: booking.scheduled_date,
        markedAtMs: (row as any).changed_at,
      });
    }

    return results.sort((a, b) => b.markedAtMs - a.markedAtMs).slice(0, 5);
  },
});

// E1 — Per-mechanic capacity cap. Returns existing booking count in the
// rolling-hour window around the proposed start, plus the shop's cap.
// Client uses this to surface a soft warning in create-booking-drawer.
export const checkMechanicCapacity = query({
  args: {
    shopId: v.id("shops"),
    mechanicId: v.optional(v.id("mechanics")),
    startTimeMs: v.number(),
    durationMinutes: v.number(),
  },
  handler: async (ctx, args) => {
    const shop: any = await ctx.db.get(args.shopId);
    const cap = shop?.max_bookings_per_mechanic_rolling_hour ?? 2;
    if (!args.mechanicId) {
      return { existingCount: 0, cap, exceedsCap: false };
    }

    const rangeStart = args.startTimeMs - 60 * 60 * 1000;
    const rangeEnd = args.startTimeMs + args.durationMinutes * 60 * 1000;

    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", args.shopId))
      .collect();

    let count = 0;
    for (const b of bookings) {
      if ((b as any).mechanic_id !== args.mechanicId) continue;
      const status = (b as any).status;
      if (status === "cancelled" || status === "no_show") continue;
      const date = (b as any).scheduled_date;
      const time = (b as any).scheduled_time;
      if (!date || !time) continue;
      const [y, m, d] = date.split("-").map(Number);
      const [hh, mm] = time.split(":").map(Number);
      const startMs = new Date(y, m - 1, d, hh, mm).getTime();
      if (startMs >= rangeStart && startMs <= rangeEnd) count += 1;
    }

    return {
      existingCount: count,
      cap,
      exceedsCap: count >= cap,
    };
  },
});

// Returns the active overrun check-in for a booking, or null. Mechanic
// UI subscribes to this to render the binary Yes/No card inline.
export const getActiveOverrunCheckinForBooking = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const checkin = await getOpenOverrunCheckinForBooking(ctx, args.bookingId);
    if (!checkin) return null;
    return {
      _id: checkin._id,
      status: checkin.status,
      due_at_ms: checkin.due_at_ms,
      escalation_due_at_ms: checkin.escalation_due_at_ms,
      auto_apply_at_ms: checkin.auto_apply_at_ms,
      default_extension_minutes: checkin.default_extension_minutes,
    };
  },
});

export const answerOverrunCheckIn = mutation({
  args: {
    bookingId: v.id("bookings"),
    isComplete: v.boolean(),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("We couldn't find that booking. It may have been cancelled or removed.");
    const shopUser = await requireShopStaff(ctx, user._id, booking.shop_id);

    const checkin = await getOpenOverrunCheckinForBooking(ctx, booking._id);
    if (!checkin) throw new Error("This overrun check-in has already been resolved. Refresh to see the latest status.");

    const now = Date.now();
    if (args.isComplete) {
      await ctx.db.patch(checkin._id, {
        status: "answered",
        answered_at_ms: now,
        answered_by_user_id: user._id,
        answer_source: getOverrunAnswerSource(shopUser),
        is_complete: true,
        resolved_at_ms: now,
        updated_at: now,
      });
      return checkin._id;
    }

    await ctx.db.patch(checkin._id, {
      status: "awaiting_extension",
      answered_at_ms: now,
      answered_by_user_id: user._id,
      answer_source: getOverrunAnswerSource(shopUser),
      is_complete: false,
      updated_at: now,
    });
    await scheduleOverrunCheckinProcessing(ctx, checkin.escalation_due_at_ms);
    return checkin._id;
  },
});

export const answerOverrunExtension = mutation({
  args: {
    bookingId: v.id("bookings"),
    extensionMinutes: v.number(),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("We couldn't find that booking. It may have been cancelled or removed.");
    const shopUser = await requireShopStaff(ctx, user._id, booking.shop_id);

    if (!OVERRUN_EXTENSION_OPTION_SET.has(args.extensionMinutes)) {
      throw new Error("Extension must be 15, 30, 45, or 60 minutes.");
    }

    const checkin = await getOpenOverrunCheckinForBooking(ctx, booking._id);
    if (!checkin) throw new Error("This overrun check-in has already been resolved. Refresh to see the latest status.");

    await applyOverrunExtension(ctx, {
      checkin,
      booking,
      extensionMinutes: args.extensionMinutes,
      source: getOverrunAnswerSource(shopUser),
      userId: user._id,
    });

    return checkin._id;
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
    if (!booking) throw new Error("We couldn't find that booking. It may have been cancelled or removed.");
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
type ScheduleChangeMode = "manual_reschedule" | "forced_delay";
const OPEN_LATE_START_REVIEW_STATUSES = new Set([
  "pending_staff_review",
  "blocked_manual_review",
]);
const OPEN_OVERRUN_CHECKIN_STATUSES = new Set([
  "scheduled",
  "mechanic_prompted",
  "awaiting_extension",
  "front_desk_escalated",
]);
const DOWNSTREAM_MOVABLE_STATUSES = new Set([
  "confirmed",
  "vehicle_at_shop",
  "pending_customer_acceptance",
]);
const OVERRUN_EXTENSION_OPTION_SET = new Set<number>(
  OVERRUN_EXTENSION_OPTIONS_MINUTES,
);
const lateStartManualTargetValidator = v.object({
  bookingId: v.id("bookings"),
  newScheduledDate: v.string(),
  newScheduledTime: v.string(),
  newMechanicId: v.optional(v.id("mechanics")),
  allowOutsideShopHours: v.optional(v.boolean()),
});

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

function minutesToHHMM(totalMinutes: number) {
  const safe = Math.max(0, Math.min(1439, totalMinutes));
  const hours = Math.floor(safe / 60);
  const minutes = safe % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function getTimeZoneOffsetMs(timeZone: string, date: Date) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );

  return (
    Date.UTC(
      values.year,
      (values.month ?? 1) - 1,
      values.day ?? 1,
      values.hour ?? 0,
      values.minute ?? 0,
      values.second ?? 0
    ) - date.getTime()
  );
}

function getShopLocalDateTimeParts(timeZone: string, date: Date) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${values.year}-${pad(values.month ?? 1)}-${pad(values.day ?? 1)}`,
    time: `${pad(values.hour ?? 0)}:${pad(values.minute ?? 0)}`,
  };
}

function toBookingDateTimeMs(date: string, time: string, timeZone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hours, minutes] = time.split(":").map(Number);
  const utcGuess = Date.UTC(year, month - 1, day, hours, minutes, 0, 0);

  const initialOffset = getTimeZoneOffsetMs(timeZone, new Date(utcGuess));
  const adjusted = utcGuess - initialOffset;
  const adjustedOffset = getTimeZoneOffsetMs(timeZone, new Date(adjusted));

  return adjustedOffset === initialOffset ? adjusted : utcGuess - adjustedOffset;
}

async function getShopTimezone(ctx: any, shopId: any) {
  const shop = await ctx.db.get(shopId);
  const timezone = normalizeNullableText(shop?.timezone);
  return timezone ?? DEFAULT_SHOP_TIMEZONE;
}

async function getLateStartMonitorWindow(
  ctx: any,
  booking: any,
  cycleMinutes: number
) {
  const { warningLeadMinutes } = getLateStartTimingConfig();
  const timezone = await getShopTimezone(ctx, booking.shop_id);
  const scheduledStartMs = toBookingDateTimeMs(
    booking.scheduled_date,
    booking.scheduled_time,
    timezone
  );

  return {
    warningDueAtMs:
      scheduledStartMs + Math.max(0, cycleMinutes - warningLeadMinutes) * 60 * 1000,
    autoApplyAtMs: scheduledStartMs + cycleMinutes * 60 * 1000,
  };
}

async function scheduleLateStartMonitorProcessing(
  ctx: any,
  warningDueAtMs: number
) {
  if (!ctx.scheduler?.runAfter) return;

  const delayMs = Math.max(0, warningDueAtMs - Date.now());
  await ctx.scheduler.runAfter(delayMs, internal.bookings.processLateStartMonitors, {});
}

async function getShopSchedulingSettings(ctx: any, shopId: any) {
  const shop = await ctx.db.get(shopId);
  return {
    noShowThresholdMinutes: normalizeNoShowThresholdMinutes(
      shop?.no_show_threshold_minutes,
    ),
    overrunDefaultExtensionPercent:
      typeof shop?.overrun_default_extension_percent === "number" &&
      Number.isFinite(shop.overrun_default_extension_percent)
        ? shop.overrun_default_extension_percent
        : DEFAULT_OVERRUN_EXTENSION_PERCENT,
    overrunExtensionFloorMinutes:
      typeof shop?.overrun_extension_floor_minutes === "number" &&
      Number.isFinite(shop.overrun_extension_floor_minutes)
        ? shop.overrun_extension_floor_minutes
        : DEFAULT_OVERRUN_EXTENSION_FLOOR_MINUTES,
  };
}

async function getCustomerLateMonitorWindow(ctx: any, booking: any) {
  const timezone = await getShopTimezone(ctx, booking.shop_id);
  const scheduledStartMs = toBookingDateTimeMs(
    booking.scheduled_date,
    booking.scheduled_time,
    timezone,
  );
  const settings = await getShopSchedulingSettings(ctx, booking.shop_id);
  const offsets = getCustomerLateReminderOffsetsMs(
    settings.noShowThresholdMinutes,
  );

  return {
    scheduledStartMs,
    pushDueAtMs: scheduledStartMs + offsets.pushOffsetMs,
    smsDueAtMs: scheduledStartMs + offsets.smsOffsetMs,
    thresholdDueAtMs: scheduledStartMs + offsets.thresholdOffsetMs,
    thresholdMinutes: settings.noShowThresholdMinutes,
  };
}

async function scheduleCustomerLateMonitorProcessing(ctx: any, dueAtMs: number) {
  if (!ctx.scheduler?.runAfter) return;
  await ctx.scheduler.runAfter(
    Math.max(0, dueAtMs - Date.now()),
    internal.bookings.processCustomerLateMonitors,
    {},
  );
}

async function scheduleOverrunCheckinProcessing(ctx: any, dueAtMs: number) {
  if (!ctx.scheduler?.runAfter) return;
  await ctx.scheduler.runAfter(
    Math.max(0, dueAtMs - Date.now()),
    internal.bookings.processOverrunCheckins,
    {},
  );
}

async function enqueueNotificationOutbox(
  ctx: any,
  {
    shopId,
    bookingId,
    userId,
    mechanicId,
    channel,
    category,
    dedupeKey,
    payload,
    scheduledForMs,
  }: {
    shopId?: any;
    bookingId?: any;
    userId?: any;
    mechanicId?: any;
    channel: "push" | "sms" | "front_desk" | "email";
    category: string;
    dedupeKey: string;
    payload: any;
    scheduledForMs?: number;
  },
) {
  // Dedupe only against still-actionable rows. Once a row has been
  // resolved/superseded/failed, a fresh event with the same key should
  // produce a new row.
  const existing = await ctx.db
    .query("notification_outbox")
    .withIndex("by_dedupe_key", (q: any) => q.eq("dedupe_key", dedupeKey))
    .first();
  if (
    existing &&
    ((existing as any).status === "pending" ||
      (existing as any).status === "dispatching")
  ) {
    return existing._id;
  }

  const now = Date.now();
  return await ctx.db.insert("notification_outbox", {
    shop_id: shopId,
    booking_id: bookingId,
    user_id: userId,
    mechanic_id: mechanicId,
    channel,
    category,
    status: "pending",
    dedupe_key: dedupeKey,
    payload,
    scheduled_for_ms: scheduledForMs,
    created_at: now,
    updated_at: now,
  });
}

type WalkinUpdateCategory =
  | "walkin_booking_confirmed"
  | "walkin_vehicle_at_shop"
  | "walkin_prejob_complete"
  | "walkin_completed_claim";

/**
 * Enqueues a mid-job or post-job message to a mechanic-created walk-in
 * client. Idempotent via the outbox dedupe key. Skips backfills and
 * non-walk-in sources. For the final category, mints a claim_token and
 * embeds the /claim/[token] URL in the payload (suppressed if the user
 * has already claimed).
 */
async function enqueueWalkinClientUpdate(
  ctx: any,
  booking: any,
  category: WalkinUpdateCategory,
) {
  if (!booking) return;
  if (booking.source !== "mechanic_walk_in") return;
  if (booking.backfilled_at_ms != null) return;
  if (!booking.user_id) return;

  const user = await ctx.db.get(booking.user_id);
  if (!user) return;

  const hasPhone = !!(user as any).phone;
  const hasEmail = !!(user as any).email;
  if (!hasPhone && !hasEmail) return;

  // Channel rules:
  //   • Mid-job touchpoints (booking_confirmed / vehicle_at_shop /
  //     prejob_complete) are SMS-only — they're short, time-sensitive
  //     pings and we don't want to spam inboxes. If no phone is on
  //     file, we silently skip.
  //   • The final post-job message goes to both channels when both are
  //     available so the receipt + claim link arrive in the inbox AND
  //     the claim URL is tappable from the SMS the client just got.
  const isFinal = category === "walkin_completed_claim";
  const channels: Array<"sms" | "email"> = [];
  if (isFinal) {
    if (hasPhone) channels.push("sms");
    if (hasEmail) channels.push("email");
  } else {
    if (hasPhone) channels.push("sms");
  }
  if (channels.length === 0) return;

  let shopName: string | null = null;
  if (booking.shop_id) {
    const shop = await ctx.db.get(booking.shop_id);
    shopName = (shop as any)?.name ?? null;
  }

  let primaryService: string | null = null;
  if (Array.isArray(booking.service_ids) && booking.service_ids.length > 0) {
    const svc = await ctx.db.get(booking.service_ids[0]);
    primaryService = (svc as any)?.name ?? null;
  } else if (Array.isArray(booking.custom_services) && booking.custom_services.length > 0) {
    primaryService = booking.custom_services[0]?.name ?? null;
  }

  let claimUrl: string | null = null;
  if (isFinal && !(user as any).walkInClaimedAt) {
    const token = await mintClaimToken(ctx, booking.user_id);
    if (token) {
      const base = process.env.NEXT_PUBLIC_APP_URL ?? "https://otopair.com";
      claimUrl = `${base.replace(/\/$/, "")}/claim/${token}`;
    }
  }

  // Final-category payload is a full receipt; mid-job payloads stay
  // lean since they only feed short SMS strings.
  let extras: Record<string, unknown> = {};
  if (isFinal) {
    let vehicleYear: number | null = null;
    let vehicleMake: string | null = null;
    let vehicleModel: string | null = null;
    let vehicleTrim: string | null = null;
    let vehicleImageUrl: string | null = null;
    if (booking.vin) {
      const vehicle = await ctx.db
        .query("vehicles")
        .withIndex("by_vin", (q: any) => q.eq("vin", booking.vin))
        .first();
      if (vehicle) {
        const veh: any = vehicle;
        vehicleYear = veh.year ?? null;
        vehicleMake = veh.metadata?.make ?? null;
        vehicleModel = veh.metadata?.model ?? null;
        vehicleTrim = veh.metadata?.trim ?? null;
        vehicleImageUrl = veh.image_url ?? null;
      }
    }

    let mechanicName: string | null = null;
    if (booking.mechanic_id) {
      const mech: any = await ctx.db.get(booking.mechanic_id);
      if (mech) {
        const full = `${mech.first_name ?? ""} ${mech.last_name ?? ""}`.trim();
        mechanicName = full || null;
      }
    }

    const services: Array<{ name: string }> = [];
    if (Array.isArray(booking.service_ids)) {
      for (const sid of booking.service_ids) {
        const svc: any = await ctx.db.get(sid);
        if (svc?.name) services.push({ name: svc.name });
      }
    }
    if (Array.isArray(booking.custom_services)) {
      for (const c of booking.custom_services) {
        if (c?.name) services.push({ name: c.name });
      }
    }

    const jobActual = await getLatestJobActualForBooking(ctx, booking._id);
    const partsUsed = Array.isArray(jobActual?.parts_used)
      ? jobActual.parts_used.map((p: any) => ({
          part_name: p.part_name ?? null,
          brand: p.brand ?? null,
          oem_number: p.oem_number ?? null,
          cost: typeof p.cost === "number" ? p.cost : null,
        }))
      : [];

    const partsCost =
      typeof jobActual?.actual_parts_cost === "number"
        ? jobActual.actual_parts_cost
        : (booking.parts_cost ?? null);
    const laborCost = booking.labor_cost ?? null;
    const totalCost =
      partsCost != null && laborCost != null
        ? Number(partsCost) + Number(laborCost)
        : (booking.total_cost ?? null);
    const actualDurationMinutes =
      typeof jobActual?.actual_labor_minutes === "number"
        ? jobActual.actual_labor_minutes
        : (booking.estimated_labor_minutes ?? null);
    const completedAtMs = booking.completed_at_ms ?? Date.now();

    extras = {
      vin: booking.vin ?? null,
      vehicleYear,
      vehicleMake,
      vehicleModel,
      vehicleTrim,
      vehicleImageUrl,
      mechanicName,
      services,
      partsUsed,
      laborCost,
      partsCost,
      totalCost,
      actualDurationMinutes,
      completedDate: new Date(completedAtMs).toISOString().slice(0, 10),
    };
  }

  const payload = {
    shopName,
    scheduledDate: booking.scheduled_date ?? null,
    scheduledTime: booking.scheduled_time ?? null,
    primaryService,
    totalCost: booking.total_cost ?? null,
    firstName: (user as any).first_name ?? null,
    claimUrl,
    ...extras,
  };

  const enqueuedChannels = new Set<"sms" | "email">();
  for (const channel of channels) {
    await enqueueNotificationOutbox(ctx, {
      shopId: booking.shop_id,
      bookingId: booking._id,
      userId: booking.user_id,
      channel,
      category,
      dedupeKey: `${category}:${channel}:${String(booking._id)}`,
      payload,
    });
    enqueuedChannels.add(channel);
  }

  // Kick the relevant dispatcher right now so the message goes out on
  // the status transition rather than waiting for the 1-minute cron.
  // The dispatcher claims rows by flipping pending→dispatching first,
  // so a concurrent cron tick will not double-send.
  if (enqueuedChannels.has("sms")) {
    await ctx.scheduler.runAfter(
      0,
      (internal as any).sms_dispatcher.dispatchPendingSms,
      {},
    );
  }
  if (enqueuedChannels.has("email")) {
    await ctx.scheduler.runAfter(
      0,
      (internal as any).email_dispatcher.dispatchPendingEmails,
      {},
    );
  }
}

function getScheduleChangeMode(booking: any): ScheduleChangeMode {
  return booking.schedule_change_mode === "forced_delay"
    ? "forced_delay"
    : "manual_reschedule";
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
  if (!identity) throw new Error("Your session has expired. Please sign in again.");

  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) => q.eq("clerkUserId", identity.subject))
    .unique();

  if (!user) throw new Error("We couldn't find your account. Try signing in again.");
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
): Promise<{
  full: string;
  short: string;
  spec_label: string | null;
  chassis_label: string | null;
}> {
  const vehicle = await ctx.db
    .query("vehicles")
    .withIndex("by_vin", (q: any) => q.eq("vin", vin))
    .first();

  if (!vehicle)
    return { full: vin, short: vin, spec_label: null, chassis_label: null };

  let makeName = "";
  let modelName = "";
  let trimName = "";
  let yearValue: number | undefined =
    typeof vehicle.year === "number" ? vehicle.year : undefined;
  let chassisCode = "";
  let engineIdForLookup: any = vehicle.engine_id ?? null;

  const config = vehicle.vehicle_config_id
    ? await ctx.db.get(vehicle.vehicle_config_id)
    : null;

  if (config) {
    if (typeof config.year === "number") yearValue = config.year;
    if (typeof config.trim_name === "string") trimName = config.trim_name;
    if (typeof config.chassis_code === "string")
      chassisCode = config.chassis_code.trim();
    if (!engineIdForLookup && config.engine_id) engineIdForLookup = config.engine_id;
    const [make, model] = await Promise.all([
      config.make_id ? ctx.db.get(config.make_id) : null,
      config.model_id ? ctx.db.get(config.model_id) : null,
    ]);
    if (make && typeof (make as any).name === "string") makeName = (make as any).name;
    if (model && typeof (model as any).name === "string") modelName = (model as any).name;
  }

  if ((!makeName || !modelName || !trimName) && vehicle.trim_id) {
    const trim = await ctx.db.get(vehicle.trim_id);
    if (trim) {
      if (!trimName) trimName = trim.name ?? "";
      const model = await ctx.db.get(trim.model_id);
      if (model) {
        if (!modelName) modelName = model.name;
        const make = await ctx.db.get(model.make_id);
        if (make && !makeName) makeName = make.name;
      }
    }
  }

  if (!makeName && vehicle.metadata?.make) makeName = String(vehicle.metadata.make);
  if (!modelName && vehicle.metadata?.model) modelName = String(vehicle.metadata.model);

  let engineLabel = "";
  if (engineIdForLookup) {
    const engine = await ctx.db.get(engineIdForLookup);
    if (engine) {
      const displacement =
        typeof engine.displacement_l === "number"
          ? `${engine.displacement_l}L`
          : typeof engine.displacement_liters === "number"
            ? `${engine.displacement_liters}L`
            : typeof engine.displacement_liters === "string" &&
                engine.displacement_liters.trim() !== ""
              ? `${engine.displacement_liters}L`
              : "";
      const code =
        typeof engine.engine_code === "string" && engine.engine_code.trim() !== ""
          ? engine.engine_code.trim()
          : "";
      engineLabel = [displacement, code].filter(Boolean).join(" ");
    }
  }

  const full = [yearValue, makeName, modelName].filter(Boolean).join(" ") || vin;
  const makeAbbr = makeName ? `${makeName[0]}.` : "";
  const short = [yearValue, makeAbbr, modelName].filter(Boolean).join(" ") || vin;

  const specSegments: string[] = [];
  if (engineLabel) specSegments.push(engineLabel);
  if (trimName) specSegments.push(`${trimName} trim`);
  if (chassisCode) specSegments.push(`${chassisCode} chassis`);
  const spec_label = specSegments.length > 0 ? specSegments.join(" · ") : null;
  const chassis_label = chassisCode ? `${chassisCode} chassis` : null;

  return { full, short, spec_label, chassis_label };
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

/** Appends the selected option_label (e.g. "Front and rear", "AGM") onto
 *  each service name so mechanic-facing views show the picked variant. */
async function resolveServiceLabels(
  ctx: any,
  serviceIds: Array<any> | undefined,
  selectedOptions:
    | Array<{ service_id: any; option_label?: string }>
    | undefined,
): Promise<string[]> {
  if (!serviceIds || serviceIds.length === 0) return [];
  const byServiceId = new Map<string, string>();
  for (const opt of selectedOptions ?? []) {
    if (opt.option_label) byServiceId.set(String(opt.service_id), opt.option_label);
  }
  return await Promise.all(
    serviceIds.map(async (serviceId: any) => {
      const service = await ctx.db.get(serviceId);
      const name = service?.name ?? "Unknown Service";
      const label = byServiceId.get(String(serviceId));
      return label ? `${name} — ${label}` : name;
    }),
  );
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
  quantity?: number | null;
  supplied_by?: string | null;
  part_tier?: string | null;
  service_id?: Id<"services"> | null;
}>) {
  return parts
    .map((part) => {
      const suppliedBy = part.supplied_by === "customer" ? "customer" : "shop";
      const rawCost = Number.isFinite(part.cost) ? Number(part.cost) : 0;
      // Customer-supplied parts always log $0 — the customer brought it; the
      // shop didn't charge for the part.
      const cost = suppliedBy === "customer" ? 0 : rawCost;
      const quantity =
        typeof part.quantity === "number" && Number.isFinite(part.quantity)
          ? Math.max(1, Math.round(part.quantity))
          : 1;
      return {
        part_name: part.part_name.trim(),
        brand: hasText(part.brand) ? (part.brand as string).trim() : null,
        oem_number: part.oem_number.trim(),
        cost,
        quantity,
        supplied_by: suppliedBy,
        part_tier: hasText(part.part_tier) ? (part.part_tier as string).trim() : "oem",
        service_id: part.service_id ?? undefined,
      };
    })
    .filter(
      (part) =>
        hasText(part.part_name) ||
        hasText(part.oem_number) ||
        hasText(part.brand) ||
        part.cost > 0 ||
        part.supplied_by === "customer"
    );
}

function sumPartsCost(parts: Array<{ cost: number }>) {
  return parts.reduce((sum, part) => sum + (Number.isFinite(part.cost) ? part.cost : 0), 0);
}

/**
 * Writes one part_snapshots row per normalized parts_used entry. Runs after
 * job_actuals is persisted so we can link snapshots back to the job_actual.
 * Resolves the vehicle FK chain (vehicle, vehicle_config, engine, chassis,
 * trim) once and reuses it for every part on this job.
 *
 * Phase 1: dual-write. The embedded job_actuals.parts_used array stays as
 * the source of truth for booking-detail reads; snapshots are the source of
 * truth for aggregation queries.
 *
 * Current UI surfaces all parts as supplied_by="shop" part_tier="oem" —
 * Otopair currently supplies OEM parts only. A future UI revision will let
 * the mechanic flag customer-supplied parts per-row.
 */
async function recordPartSnapshotsForBooking(
  ctx: any,
  {
    booking,
    jobActualId,
    mechanicId,
    parts,
    now,
  }: {
    booking: any;
    jobActualId: Id<"job_actuals">;
    mechanicId: Id<"users">;
    parts: Array<{
      part_name: string;
      brand: string | null;
      oem_number: string;
      cost: number;
      quantity?: number;
      supplied_by?: string;
      part_tier?: string;
      // New: per-part service attribution. Optional so legacy rows (written
      // before this field existed) keep working — caller falls back to
      // booking.service_ids[0] for those.
      service_id?: Id<"services">;
    }>;
    now: number;
  },
) {
  if (parts.length === 0) return;

  const canonicalVin = toCanonicalVin(booking.vin);
  const vehicle = await ctx.db
    .query("vehicles")
    .withIndex("by_vin", (q: any) => q.eq("vin", canonicalVin))
    .unique();
  if (!vehicle) return;

  const fallbackServiceId = booking.service_ids?.[0] as Id<"services"> | undefined;

  for (const part of parts) {
    if (!hasText(part.part_name) && !hasText(part.oem_number)) continue;

    // Per-part service_id wins; fall back to the booking's primary service
    // for legacy rows. Skip rather than throw if neither is present so a
    // missing FK doesn't take down the whole batch.
    const serviceId = part.service_id ?? fallbackServiceId;
    if (!serviceId) continue;

    await insertSnapshotImpl(ctx, {
      booking_id: booking._id,
      job_actual_id: jobActualId,
      shop_id: booking.shop_id,
      mechanic_id: mechanicId,

      vehicle_id: vehicle._id,
      vehicle_config_id: vehicle.vehicle_config_id ?? undefined,
      engine_id: vehicle.engine_id ?? undefined,
      chassis_id: vehicle.chassis_id ?? undefined,
      trim_id: vehicle.trim_id ?? undefined,

      service_id: serviceId,

      part_name: part.part_name || part.oem_number,
      oem_part_number: hasText(part.oem_number) ? part.oem_number : undefined,
      brand: hasText(part.brand) ? (part.brand as string) : undefined,
      part_tier: part.part_tier ?? "oem",

      supplied_by: part.supplied_by === "customer" ? "customer" : "shop",
      quantity: part.quantity ?? 1,
      unit_cost: part.cost,
      currency: "USD",

      recorded_at: now,
    });
  }
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
    hasText(updates.transmission_fluid_type) ||
    typeof updates.oil_capacity_qts === "number";

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
          oil_capacity_qts: updates.oil_capacity_qts ?? undefined,
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
          // Multiple trim_specs rows can exist for the same trim (enrichment
          // sometimes writes duplicates). Pick the highest-confidence row,
          // breaking ties by recency, instead of crashing on `.unique()` or
          // arbitrarily picking with `.first()`. This is the canonical
          // version from Temur's web work — supersedes the mobile `.first()`
          // workaround.
          .collect()
          .then((rows: any[]) =>
            rows.length === 0
              ? null
              : rows.reduce((best, row) => {
                  const bc = best.confidence_score ?? 0;
                  const rc = row.confidence_score ?? 0;
                  if (rc !== bc) return rc > bc ? row : best;
                  return (row.created_at ?? 0) > (best.created_at ?? 0) ? row : best;
                })
          )
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
    vehicle_spec_label: vehicleLabels.spec_label,
    chassis_label: vehicleLabels.chassis_label,
    service_name: service?.name ?? (await resolveServiceNames(ctx, booking.service_ids)).join(", "),
    service_slug: service?.slug ?? null,
    requires_parts: serviceRequiresParts(service),
    // Per-service variant for the post-job dialog so it can render one parts
    // block per service that requires parts. `requires_parts` above stays
    // as the primary-service boolean for legacy callers.
    parts_required_services: await (async () => {
      const out: Array<{ _id: Id<"services">; name: string }> = [];
      for (const sid of booking.service_ids ?? []) {
        const svc: any = await ctx.db.get(sid);
        if (!svc) continue;
        if (serviceRequiresParts(svc)) {
          out.push({ _id: sid, name: svc.name });
        }
      }
      return out;
    })(),
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
    enrichment_status: vehicleConfig?.enrichment_status ?? (vehicle?.vehicle_config_id ? null : "pending"),
    enrichment_fill_rate: vehicleConfig?.fill_rate ?? null,
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
      // Only count slots that were explicitly marked as a block. Orphaned
      // slots (from a deleted booking, or any pre-block_kind row that was
      // never tied to a booking) have no block_kind and are ignored —
      // they used to cause false-positive "time is blocked" rejections.
      slot.block_kind !== undefined &&
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
    if (
      existing.is_available ||
      existing.title !== undefined ||
      existing.note !== undefined ||
      existing.block_kind !== undefined
    ) {
      await ctx.db.patch(existing._id, {
        is_available: false,
        note: undefined,
        title: undefined,
        block_kind: undefined,
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
      block_kind: "reserved_pending",
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
    block_kind: "reserved_pending",
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

async function getLateStartMonitorByUpstreamBookingId(ctx: any, upstreamBookingId: any) {
  return await ctx.db
    .query("late_start_monitors")
    .withIndex("by_upstream_booking_id", (q: any) =>
      q.eq("upstream_booking_id", upstreamBookingId)
    )
    .first();
}

async function getOpenLateStartReviewsForUpstreamBooking(ctx: any, upstreamBookingId: any) {
  const rows = await ctx.db
    .query("late_start_reviews")
    .withIndex("by_upstream_booking_id", (q: any) =>
      q.eq("upstream_booking_id", upstreamBookingId)
    )
    .collect();

  return rows.filter((row: any) => OPEN_LATE_START_REVIEW_STATUSES.has(row.status));
}

function isLateStartMonitorEligible(booking: any) {
  return (
    booking?.status === "confirmed" &&
    booking?.shop_id &&
    booking?.mechanic_id &&
    booking?.scheduled_date &&
    booking?.scheduled_time
  );
}

async function hasBookingActuallyStarted(ctx: any, booking: any) {
  if (!booking) return false;
  if (booking.status === "in_progress" || booking.status === "completed") {
    return true;
  }
  const jobActual = await getLatestJobActualForBooking(ctx, booking._id);
  return jobActual?.started_at != null;
}

async function markLateStartReviewsResolved(
  ctx: any,
  reviews: any[],
  status: "resolved_no_longer_needed",
  resolvedByUserId?: any
) {
  const now = Date.now();
  for (const review of reviews) {
    if (!OPEN_LATE_START_REVIEW_STATUSES.has(review.status)) continue;
    await ctx.db.patch(review._id, {
      status,
      resolved_at: now,
      resolved_by_user_id: resolvedByUserId,
      updated_at: now,
    });
  }
}

export async function resolveLateStartMonitorForBooking(
  ctx: any,
  booking: any,
  resolvedByUserId?: any
) {
  if (!booking?._id) return;

  const monitor = await getLateStartMonitorByUpstreamBookingId(ctx, booking._id);
  const reviews = await getOpenLateStartReviewsForUpstreamBooking(ctx, booking._id);

  if (reviews.length > 0) {
    await markLateStartReviewsResolved(
      ctx,
      reviews,
      "resolved_no_longer_needed",
      resolvedByUserId
    );
  }

  if (!monitor || monitor.status === "resolved") return;

  await ctx.db.patch(monitor._id, {
    status: "resolved",
    updated_at: Date.now(),
  });
}

async function getCustomerLateMonitorByBookingId(ctx: any, bookingId: any) {
  return await ctx.db
    .query("customer_late_monitors")
    .withIndex("by_booking_id", (q: any) => q.eq("booking_id", bookingId))
    .first();
}

function isCustomerLateMonitorEligible(booking: any) {
  return (
    booking?.status === "confirmed" &&
    booking?.shop_id &&
    booking?.scheduled_date &&
    booking?.scheduled_time &&
    !booking?.vehicle_arrived_at_ms
  );
}

async function resolveCustomerLateMonitorForBooking(
  ctx: any,
  booking: any,
  resolvedByUserId?: any,
) {
  if (!booking?._id) return;
  const monitor = await getCustomerLateMonitorByBookingId(ctx, booking._id);
  if (!monitor || monitor.status === "resolved") return;

  await ctx.db.patch(monitor._id, {
    status: "resolved",
    resolved_at_ms: Date.now(),
    resolved_by_user_id: resolvedByUserId,
    updated_at: Date.now(),
  });
}

async function upsertCustomerLateMonitorForBooking(ctx: any, booking: any) {
  if (!booking?._id) return;

  if (!isCustomerLateMonitorEligible(booking)) {
    await resolveCustomerLateMonitorForBooking(ctx, booking);
    return;
  }

  const window = await getCustomerLateMonitorWindow(ctx, booking);
  const now = Date.now();
  const existing = await getCustomerLateMonitorByBookingId(ctx, booking._id);
  const patch = {
    shop_id: booking.shop_id,
    booking_id: booking._id,
    status: "active",
    scheduled_start_ms: window.scheduledStartMs,
    push_due_at_ms: window.pushDueAtMs,
    sms_due_at_ms: window.smsDueAtMs,
    threshold_due_at_ms: window.thresholdDueAtMs,
    updated_at: now,
  };

  if (existing) {
    await ctx.db.patch(existing._id, patch);
  } else {
    await ctx.db.insert("customer_late_monitors", {
      ...patch,
      created_at: now,
    });
  }

  await scheduleCustomerLateMonitorProcessing(ctx, window.pushDueAtMs);
}

// ---------------------------------------------------------------------------
// Pre-appointment reminder monitor — mirrors customer_late_monitors but fires
// BEFORE the appointment start (e.g. 24h prior) rather than after.
// ---------------------------------------------------------------------------

const APPOINTMENT_REMINDER_LIFECYCLE_STATUSES = [
  "confirmed",
  "pending_shop_acceptance",
  "pending_customer_acceptance",
];

function isAppointmentReminderEligible(booking: any): boolean {
  if (!booking?._id) return false;
  if (!booking.shop_id) return false;
  if (booking.backfilled_at_ms != null) return false;
  if (!booking.user_id) return false;
  if (!booking.scheduled_date || !booking.scheduled_time) return false;
  return APPOINTMENT_REMINDER_LIFECYCLE_STATUSES.includes(booking.status);
}

async function getAppointmentReminderByBookingId(ctx: any, bookingId: any) {
  return await ctx.db
    .query("appointment_reminder_monitors")
    .withIndex("by_booking_id", (q: any) => q.eq("booking_id", bookingId))
    .first();
}

async function getShopAppointmentReminderLeadMinutes(
  ctx: any,
  shopId: any,
): Promise<number> {
  if (!shopId) return 0;
  const shop = await ctx.db.get(shopId);
  const raw = (shop as any)?.appointment_reminder_lead_minutes;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw);
}

async function getAppointmentReminderWindow(
  ctx: any,
  booking: any,
  leadMinutes: number,
) {
  const timezone = await getShopTimezone(ctx, booking.shop_id);
  const scheduledStartMs = toBookingDateTimeMs(
    booking.scheduled_date,
    booking.scheduled_time,
    timezone,
  );
  return {
    scheduledStartMs,
    dueAtMs: scheduledStartMs - leadMinutes * 60_000,
  };
}

async function resolveAppointmentReminderForBooking(
  ctx: any,
  bookingId: any,
) {
  if (!bookingId) return;
  const monitor = await getAppointmentReminderByBookingId(ctx, bookingId);
  if (!monitor) return;
  if (monitor.status === "resolved" || monitor.status === "sent") return;
  const now = Date.now();
  await ctx.db.patch(monitor._id, {
    status: "resolved",
    resolved_at_ms: now,
    updated_at: now,
  });
}

async function upsertAppointmentReminderForBooking(ctx: any, booking: any) {
  if (!booking?._id) return;

  // Resolve (don't delete) if the booking is no longer eligible. Keeps
  // history queryable and avoids races with an in-flight cron tick.
  if (!isAppointmentReminderEligible(booking)) {
    await resolveAppointmentReminderForBooking(ctx, booking._id);
    return;
  }

  const leadMinutes = await getShopAppointmentReminderLeadMinutes(
    ctx,
    booking.shop_id,
  );
  if (leadMinutes <= 0) {
    await resolveAppointmentReminderForBooking(ctx, booking._id);
    return;
  }

  const { scheduledStartMs, dueAtMs } = await getAppointmentReminderWindow(
    ctx,
    booking,
    leadMinutes,
  );

  // If the reminder window has already passed (booking is in the past or
  // booked closer-in than the lead time), skip — firing immediately would
  // surprise the customer worse than sending nothing.
  if (dueAtMs <= Date.now()) {
    await resolveAppointmentReminderForBooking(ctx, booking._id);
    return;
  }

  const existing = await getAppointmentReminderByBookingId(ctx, booking._id);
  const now = Date.now();

  // If the reminder already went out, leave the row alone — rescheduling
  // after a send shouldn't trigger a duplicate ping.
  if (existing && existing.status === "sent") return;

  const patch = {
    shop_id: booking.shop_id,
    booking_id: booking._id,
    status: "active",
    scheduled_start_ms: scheduledStartMs,
    due_at_ms: dueAtMs,
    lead_minutes: leadMinutes,
    updated_at: now,
  };

  if (existing) {
    await ctx.db.patch(existing._id, patch);
  } else {
    await ctx.db.insert("appointment_reminder_monitors", {
      ...patch,
      created_at: now,
    });
  }

  if (ctx.scheduler?.runAfter) {
    await ctx.scheduler.runAfter(
      Math.max(0, dueAtMs - Date.now()),
      internal.bookings.processAppointmentReminderMonitors,
      {},
    );
  }
}

async function resolveNeverStartedBellNotificationsForBooking(ctx: any, bookingId: any) {
  const rows = await ctx.db
    .query("notification_outbox")
    .withIndex("by_booking_id", (q: any) => q.eq("booking_id", bookingId))
    .collect();
  const now = Date.now();
  await Promise.all(
    rows
      .filter(
        (r: any) =>
          r.category === "booking_never_started" &&
          (r.status === "pending" || r.status === "dispatching"),
      )
      .map((r: any) =>
        ctx.db.patch(r._id, { status: "resolved", processed_at: now, updated_at: now }),
      ),
  );
}

async function upsertLateStartMonitorForBooking(
  ctx: any,
  booking: any,
  cycleMinutes = getLateStartTimingConfig().initialCycleMinutes
) {
  if (!booking?._id) return;

  if (!isLateStartMonitorEligible(booking)) {
    await resolveLateStartMonitorForBooking(ctx, booking);
    return;
  }

  const started = await hasBookingActuallyStarted(ctx, booking);
  if (started) {
    await resolveLateStartMonitorForBooking(ctx, booking);
    return;
  }

  const reviews = await getOpenLateStartReviewsForUpstreamBooking(ctx, booking._id);
  if (reviews.length > 0) {
    await markLateStartReviewsResolved(ctx, reviews, "resolved_no_longer_needed");
  }

  const { warningDueAtMs, autoApplyAtMs } = await getLateStartMonitorWindow(
    ctx,
    booking,
    cycleMinutes
  );
  const now = Date.now();
  const existing = await getLateStartMonitorByUpstreamBookingId(ctx, booking._id);

  if (existing) {
    await ctx.db.patch(existing._id, {
      cycle_minutes: cycleMinutes,
      warning_due_at_ms: warningDueAtMs,
      auto_apply_at_ms: autoApplyAtMs,
      status: "active",
      updated_at: now,
    });
    await scheduleLateStartMonitorProcessing(ctx, warningDueAtMs);
    return;
  }

  await ctx.db.insert("late_start_monitors", {
    shop_id: booking.shop_id,
    upstream_booking_id: booking._id,
    cycle_minutes: cycleMinutes,
    warning_due_at_ms: warningDueAtMs,
    auto_apply_at_ms: autoApplyAtMs,
    status: "active",
    created_at: now,
    updated_at: now,
  });
  await scheduleLateStartMonitorProcessing(ctx, warningDueAtMs);
}

async function advanceLateStartMonitorCycle(ctx: any, monitor: any, cycleMinutes?: number) {
  const upstreamBooking = await ctx.db.get(monitor.upstream_booking_id);
  if (!upstreamBooking || !isLateStartMonitorEligible(upstreamBooking)) {
    if (upstreamBooking) {
      await resolveLateStartMonitorForBooking(ctx, upstreamBooking);
    } else if (monitor.status !== "resolved") {
      await ctx.db.patch(monitor._id, {
        status: "resolved",
        updated_at: Date.now(),
      });
    }
    return;
  }

  const { cycleIncrementMinutes } = getLateStartTimingConfig();
  const nextCycleMinutes =
    cycleMinutes ?? ((monitor.cycle_minutes ?? 0) + cycleIncrementMinutes);
  const { warningDueAtMs, autoApplyAtMs } = await getLateStartMonitorWindow(
    ctx,
    upstreamBooking,
    nextCycleMinutes
  );

  await ctx.db.patch(monitor._id, {
    cycle_minutes: nextCycleMinutes,
    warning_due_at_ms: warningDueAtMs,
    auto_apply_at_ms: autoApplyAtMs,
    status: "active",
    updated_at: Date.now(),
  });
  await scheduleLateStartMonitorProcessing(ctx, warningDueAtMs);
}

async function mechanicHasLateUnstartedUpstreamConflict(
  ctx: any,
  {
    shopId,
    mechanicId,
    date,
    targetStartTime,
    excludeBookingId,
    dayBookings,
  }: {
    shopId: any;
    mechanicId: any;
    date: string;
    targetStartTime: string;
    excludeBookingId: string;
    dayBookings: any[];
  }
) {
  const timezone = await getShopTimezone(ctx, shopId);
  const nowMs = Date.now();
  const targetStartMs = toBookingDateTimeMs(date, targetStartTime, timezone);

  const earlierMechanicBookings = dayBookings
    .filter(
      (booking: any) =>
        String(booking.mechanic_id ?? "") === String(mechanicId) &&
        String(booking._id) !== excludeBookingId &&
        booking.status === "confirmed" &&
        booking.scheduled_time < targetStartTime
    )
    .sort(compareBookingsBySchedule);

  for (const booking of earlierMechanicBookings) {
    if (await hasBookingActuallyStarted(ctx, booking)) {
      continue;
    }

    const scheduledStartMs = toBookingDateTimeMs(
      booking.scheduled_date,
      booking.scheduled_time,
      timezone
    );

    if (nowMs <= scheduledStartMs) {
      continue;
    }

    const projectedEndMs =
      nowMs + (booking.estimated_labor_minutes ?? 60) * 60 * 1000;
    if (projectedEndMs > targetStartMs) {
      return true;
    }
  }

  return false;
}

async function findBestAlternateMechanicForWindow(
  ctx: any,
  {
    shopId,
    date,
    startTime,
    durationMinutes,
    excludeMechanicId,
    excludeBookingId,
  }: {
    shopId: any;
    date: string;
    startTime: string;
    durationMinutes: number;
    excludeMechanicId: any;
    excludeBookingId: string;
  }
) {
  const activeMechanics = await getActiveMechanicsForShop(ctx, shopId);
  const dayBookings = await getBlockingBookingsForShopDate(ctx, shopId, date);
  const targetEndMinutes = hhmmToMinutes(getBookingEndTime(startTime, durationMinutes));

  const candidates: Array<{
    mechanicId: any;
    mechanicName: string;
    load: number;
    nextBookingStartMinutes: number | null;
  }> = [];

  for (const mechanic of activeMechanics) {
    if (String(mechanic._id) === String(excludeMechanicId)) continue;

    try {
      await assertMechanicWindowIsFree(ctx, {
        shopId,
        mechanicId: mechanic._id,
        date,
        startTime,
        durationMinutes,
        excludeBookingId,
      });
    } catch {
      continue;
    }

    if (
      await mechanicHasLateUnstartedUpstreamConflict(ctx, {
        shopId,
        mechanicId: mechanic._id,
        date,
        targetStartTime: startTime,
        excludeBookingId,
        dayBookings,
      })
    ) {
      continue;
    }

    const mechanicBookings = dayBookings.filter(
      (booking: any) =>
        String(booking.mechanic_id ?? "") === String(mechanic._id) &&
        String(booking._id) !== excludeBookingId
    );

    const nextBookingStartMinutes =
      mechanicBookings
        .map((booking: any) => hhmmToMinutes(booking.scheduled_time))
        .filter((minutes: number) => minutes >= targetEndMinutes)
        .sort((left: number, right: number) => left - right)[0] ?? null;

    candidates.push({
      mechanicId: mechanic._id,
      mechanicName: `${mechanic.first_name ?? ""} ${mechanic.last_name ?? ""}`.trim(),
      load: mechanicBookings.length,
      nextBookingStartMinutes,
    });
  }

  candidates.sort((left, right) => {
    if (left.load !== right.load) return left.load - right.load;

    const leftNext = left.nextBookingStartMinutes ?? Number.MAX_SAFE_INTEGER;
    const rightNext = right.nextBookingStartMinutes ?? Number.MAX_SAFE_INTEGER;
    if (leftNext !== rightNext) return leftNext - rightNext;

    return (
      left.mechanicName.localeCompare(right.mechanicName) ||
      String(left.mechanicId).localeCompare(String(right.mechanicId))
    );
  });

  return candidates[0] ?? null;
}

async function findEarliestStartOnMechanic(
  ctx: any,
  {
    shopId,
    mechanicId,
    date,
    fromMinutes,
    durationMinutes,
    excludeBookingId,
  }: {
    shopId: any;
    mechanicId: any;
    date: string;
    fromMinutes: number;
    durationMinutes: number;
    excludeBookingId: string;
  }
) {
  const hours = await getShopHoursForDate(ctx, shopId, date);
  if (!hours || hours.is_closed || !hours.open_time || !hours.close_time) {
    return null;
  }

  const openMinutes = hhmmToMinutes(hours.open_time);
  const closeMinutes = hhmmToMinutes(hours.close_time);
  const lastStartMinutes = closeMinutes - durationMinutes;
  let cursorMinutes = Math.max(openMinutes, Math.ceil(fromMinutes / 15) * 15);

  while (cursorMinutes <= lastStartMinutes) {
    const startTime = minutesToHHMM(cursorMinutes);
    try {
      await assertMechanicWindowIsFree(ctx, {
        shopId,
        mechanicId,
        date,
        startTime,
        durationMinutes,
        excludeBookingId,
      });
      return startTime;
    } catch {
      cursorMinutes += 15;
    }
  }

  return null;
}

async function buildLateStartReviewPlan(
  ctx: any,
  {
    upstreamBooking,
    cycleMinutes,
  }: {
    upstreamBooking: any;
    cycleMinutes: number;
  }
) {
  const proposals: any[] = [];
  const upstreamMechanicId = upstreamBooking.mechanic_id;
  const date = upstreamBooking.scheduled_date;
  const projectedStartTime = addMinutesToHHMM(
    upstreamBooking.scheduled_time,
    cycleMinutes
  );
  let cursorEndMinutes = hhmmToMinutes(
    getBookingEndTime(
      projectedStartTime,
      upstreamBooking.estimated_labor_minutes ?? 60
    )
  );

  const downstreamBookings = (await getBlockingBookingsForShopDate(
    ctx,
    upstreamBooking.shop_id,
    date
  ))
    .filter(
      (booking: any) =>
        String(booking._id) !== String(upstreamBooking._id) &&
        String(booking.mechanic_id ?? "") === String(upstreamMechanicId)
    )
    .sort(compareBookingsBySchedule);

  for (const downstreamBooking of downstreamBookings) {
    const bookingStartMinutes = hhmmToMinutes(downstreamBooking.scheduled_time);
    if (bookingStartMinutes >= cursorEndMinutes) {
      break;
    }

    const existingMode = getScheduleChangeMode(downstreamBooking);
    const isSameForcedDelayChain =
      existingMode === "forced_delay" &&
      String(downstreamBooking.schedule_change_source_booking_id ?? "") ===
        String(upstreamBooking._id);

    if (
      downstreamBooking.status === "pending_customer_acceptance" &&
      !isSameForcedDelayChain
    ) {
      proposals.push({
        booking_id: downstreamBooking._id,
        original_scheduled_date: downstreamBooking.scheduled_date,
        original_scheduled_time: downstreamBooking.scheduled_time,
        original_mechanic_id: downstreamBooking.mechanic_id,
        used_alternate_mechanic: false,
        blocked_reason: "This downstream booking already has a customer reschedule pending.",
      });
      return {
        proposals,
        blockingReason:
          "A downstream booking already has a different reschedule pending and needs manual review.",
      };
    }

    const durationMinutes = downstreamBooking.estimated_labor_minutes ?? 60;
    const alternateMechanic = await findBestAlternateMechanicForWindow(ctx, {
      shopId: upstreamBooking.shop_id,
      date,
      startTime: downstreamBooking.scheduled_time,
      durationMinutes,
      excludeMechanicId: upstreamMechanicId,
      excludeBookingId: String(downstreamBooking._id),
    });

    if (alternateMechanic) {
      proposals.push({
        booking_id: downstreamBooking._id,
        original_scheduled_date: downstreamBooking.scheduled_date,
        original_scheduled_time: downstreamBooking.scheduled_time,
        original_mechanic_id: downstreamBooking.mechanic_id,
        proposed_scheduled_date: downstreamBooking.scheduled_date,
        proposed_scheduled_time: downstreamBooking.scheduled_time,
        proposed_mechanic_id: alternateMechanic.mechanicId,
        used_alternate_mechanic: true,
      });
      continue;
    }

    const pushedStartTime = await findEarliestStartOnMechanic(ctx, {
      shopId: upstreamBooking.shop_id,
      mechanicId: upstreamMechanicId,
      date,
      fromMinutes: cursorEndMinutes,
      durationMinutes,
      excludeBookingId: String(downstreamBooking._id),
    });

    if (!pushedStartTime) {
      proposals.push({
        booking_id: downstreamBooking._id,
        original_scheduled_date: downstreamBooking.scheduled_date,
        original_scheduled_time: downstreamBooking.scheduled_time,
        original_mechanic_id: downstreamBooking.mechanic_id,
        used_alternate_mechanic: false,
        blocked_reason: "No automatic time remains before close on the current mechanic.",
      });
      return {
        proposals,
        blockingReason:
          "No automatic delayed slot is available before close on the current mechanic.",
      };
    }

    proposals.push({
      booking_id: downstreamBooking._id,
      original_scheduled_date: downstreamBooking.scheduled_date,
      original_scheduled_time: downstreamBooking.scheduled_time,
      original_mechanic_id: downstreamBooking.mechanic_id,
      proposed_scheduled_date: downstreamBooking.scheduled_date,
      proposed_scheduled_time: pushedStartTime,
      proposed_mechanic_id: upstreamMechanicId,
      used_alternate_mechanic: false,
    });

    cursorEndMinutes = hhmmToMinutes(
      getBookingEndTime(pushedStartTime, durationMinutes)
    );
  }

  return { proposals, blockingReason: undefined as string | undefined };
}

// Resolves any pending manual_scheduling_required alert attached to a
// booking. Called from `applyBookingStatusTransition` whenever the booking
// reaches a state that makes the manual review moot (rescheduled to a new
// confirmed slot, cancelled, declined, marked no-show, or completed).
async function resolveManualSchedulingAlertsForBooking(
  ctx: any,
  bookingId: any,
) {
  if (!bookingId) return;
  const rows = await ctx.db
    .query("notification_outbox")
    .withIndex("by_booking_id", (q: any) => q.eq("booking_id", bookingId))
    .collect();
  const now = Date.now();
  for (const row of rows) {
    if (
      (row as any).channel !== "front_desk" ||
      (row as any).category !== "manual_scheduling_required" ||
      ((row as any).status !== "pending" && (row as any).status !== "dispatching")
    ) {
      continue;
    }
    await ctx.db.patch(row._id, {
      status: "resolved",
      processed_at: now,
      updated_at: now,
    } as any);
  }
}

function formatHHMMto12h(hhmm: string | null | undefined): string {
  if (!hhmm) return "";
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  const ampm = h >= 12 ? "PM" : "AM";
  const hr = h % 12 || 12;
  return `${hr}:${String(m).padStart(2, "0")} ${ampm}`;
}

function shortBookingHandle(id: any): string {
  return `#${String(id).slice(-6).toUpperCase()}`;
}

// Display identifier for a booking — prefers the shop-assigned invoice
// number, falls back to the auto-generated last-6 booking id pill.
function bookingDisplayHandle(booking: any): string {
  const raw = (booking?.invoice_number ?? "").trim();
  if (raw) return raw.startsWith("#") ? raw : `#${raw}`;
  return shortBookingHandle(booking?._id);
}

export const setBookingInvoiceNumber = mutation({
  args: {
    bookingId: v.id("bookings"),
    invoiceNumber: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found.");
    await requireShopStaff(ctx, user._id, booking.shop_id);

    const trimmed = args.invoiceNumber.trim().slice(0, 32);
    await ctx.db.patch(args.bookingId, {
      invoice_number: trimmed.length > 0 ? trimmed : undefined,
      updated_at: Date.now(),
    } as any);
    return { invoiceNumber: trimmed.length > 0 ? trimmed : null };
  },
});

async function createManualSchedulingAlert(
  ctx: any,
  {
    shopId,
    bookingId,
    source,
    reason,
    payload,
  }: {
    shopId: any;
    bookingId: any;
    source: string;
    reason: string;
    payload?: any;
  },
) {
  await enqueueNotificationOutbox(ctx, {
    shopId,
    bookingId,
    channel: "front_desk",
    category: "manual_scheduling_required",
    // Stable dedupe per booking+source so repeated cascade-blocked attempts
    // collapse into one open alert. The front desk dismisses it explicitly.
    dedupeKey: `manual-scheduling:${String(bookingId)}:${source}`,
    payload: {
      source,
      reason,
      ...(payload ?? {}),
    },
  });
}

async function buildDownstreamMovementPlan(
  ctx: any,
  {
    upstreamBooking,
    projectedEndMinutes,
  }: {
    upstreamBooking: any;
    projectedEndMinutes: number;
  },
) {
  const proposals: Array<{
    booking: any;
    originalDate: string;
    originalTime: string;
    originalMechanicId: any;
    proposedDate: string;
    proposedTime: string;
    proposedMechanicId: any;
    usedAlternateMechanic: boolean;
  }> = [];

  const upstreamMechanicId = upstreamBooking.mechanic_id;
  const date = upstreamBooking.scheduled_date;
  let cursorEndMinutes = projectedEndMinutes;

  const downstreamBookings = (await getBlockingBookingsForShopDate(
    ctx,
    upstreamBooking.shop_id,
    date,
  ))
    .filter(
      (booking: any) =>
        String(booking._id) !== String(upstreamBooking._id) &&
        String(booking.mechanic_id ?? "") === String(upstreamMechanicId),
    )
    .sort(compareBookingsBySchedule);

  for (const downstreamBooking of downstreamBookings) {
    const bookingStartMinutes = hhmmToMinutes(downstreamBooking.scheduled_time);
    if (bookingStartMinutes >= cursorEndMinutes) break;

    if (!DOWNSTREAM_MOVABLE_STATUSES.has(downstreamBooking.status)) {
      const customer = downstreamBooking.user_id
        ? await ctx.db.get(downstreamBooking.user_id)
        : null;
      const customerName =
        `${(customer as any)?.first_name ?? ""} ${(customer as any)?.last_name ?? ""}`.trim() ||
        (customer as any)?.email ||
        "the next customer";
      const statusLabel =
        BOOKING_STATUS_VISUALS[downstreamBooking.status as BookingStatus]?.label?.toLowerCase() ??
        String(downstreamBooking.status).replace(/_/g, " ");
      const timeLabel = downstreamBooking.scheduled_time
        ? ` at ${downstreamBooking.scheduled_time}`
        : "";
      return {
        proposals,
        blockingReason: `${customerName}'s booking${timeLabel} is already ${statusLabel} and can't be moved automatically. Please reschedule it manually.`,
      };
    }

    if (downstreamBooking.status === "pending_customer_acceptance") {
      return {
        proposals,
        blockingReason:
          "A downstream booking already has a customer reschedule pending and needs manual review.",
      };
    }

    const durationMinutes = downstreamBooking.estimated_labor_minutes ?? 60;
    const preference = normalizeAssignmentPreference(
      downstreamBooking.assignment_preference,
    );

    if (preference === "any") {
      const alternateMechanic = await findBestAlternateMechanicForWindow(ctx, {
        shopId: upstreamBooking.shop_id,
        date,
        startTime: downstreamBooking.scheduled_time,
        durationMinutes,
        excludeMechanicId: upstreamMechanicId,
        excludeBookingId: String(downstreamBooking._id),
      });

      if (alternateMechanic) {
        proposals.push({
          booking: downstreamBooking,
          originalDate: downstreamBooking.scheduled_date,
          originalTime: downstreamBooking.scheduled_time,
          originalMechanicId: downstreamBooking.mechanic_id,
          proposedDate: downstreamBooking.scheduled_date,
          proposedTime: downstreamBooking.scheduled_time,
          proposedMechanicId: alternateMechanic.mechanicId,
          usedAlternateMechanic: true,
        });
        continue;
      }
    }

    const pushedStartTime = await findEarliestStartOnMechanic(ctx, {
      shopId: upstreamBooking.shop_id,
      mechanicId: upstreamMechanicId,
      date,
      fromMinutes: cursorEndMinutes,
      durationMinutes,
      excludeBookingId: String(downstreamBooking._id),
    });

    if (!pushedStartTime) {
      return {
        proposals,
        blockingReason:
          "No safe downstream slot is available before close on the current mechanic.",
      };
    }

    proposals.push({
      booking: downstreamBooking,
      originalDate: downstreamBooking.scheduled_date,
      originalTime: downstreamBooking.scheduled_time,
      originalMechanicId: downstreamBooking.mechanic_id,
      proposedDate: downstreamBooking.scheduled_date,
      proposedTime: pushedStartTime,
      proposedMechanicId: upstreamMechanicId,
      usedAlternateMechanic: false,
    });

    cursorEndMinutes = hhmmToMinutes(
      getBookingEndTime(pushedStartTime, durationMinutes),
    );
  }

  return { proposals, blockingReason: undefined as string | undefined };
}

async function applyDownstreamMovement(
  ctx: any,
  {
    upstreamBooking,
    projectedEndMinutes,
    source,
  }: {
    upstreamBooking: any;
    projectedEndMinutes: number;
    source: "customer_late" | "job_overrun";
  },
) {
  if (
    !upstreamBooking?.shop_id ||
    !upstreamBooking?.mechanic_id ||
    !upstreamBooking?.scheduled_date ||
    !upstreamBooking?.scheduled_time
  ) {
    return { moved: 0, blocked: false };
  }

  const plan = await buildDownstreamMovementPlan(ctx, {
    upstreamBooking,
    projectedEndMinutes,
  });

  if (plan.blockingReason) {
    // Prefer the actually-blocked downstream booking as the alert subject so
    // the front-desk banner identifies the booking that needs manual review.
    const blockedProposal =
      plan.proposals.find((p: any) => p.blocked_reason) ?? null;
    const subjectBookingId =
      blockedProposal?.booking?._id ?? upstreamBooking._id;
    const subjectBooking: any = blockedProposal
      ? await ctx.db.get(blockedProposal.booking._id)
      : upstreamBooking;
    const subjectTime12h = formatHHMMto12h(
      subjectBooking?.scheduled_time ?? null,
    );
    const upstreamHandle = shortBookingHandle(upstreamBooking._id);
    const subjectHandle = shortBookingHandle(subjectBookingId);
    const reasonPrefix = blockedProposal
      ? `Booking ${subjectHandle}${subjectTime12h ? ` (${subjectTime12h})` : ""} couldn't be auto-rescheduled after overrun on ${upstreamHandle}.`
      : `Cascade from ${upstreamHandle} blocked.`;
    await createManualSchedulingAlert(ctx, {
      shopId: upstreamBooking.shop_id,
      bookingId: subjectBookingId,
      source,
      reason: `${reasonPrefix} ${plan.blockingReason}`,
      payload: {
        upstreamBookingId: String(upstreamBooking._id),
        upstreamHandle,
        subjectHandle,
        subjectTime12h: subjectTime12h || null,
        affectedCount: plan.proposals.length,
      },
    });
    return { moved: 0, blocked: true };
  }

  for (const proposal of plan.proposals) {
    const durationMinutes = proposal.booking.estimated_labor_minutes ?? 60;
    const slotId = await getOrCreateSlot(
      ctx,
      proposal.booking.shop_id,
      proposal.proposedMechanicId,
      proposal.proposedDate,
      proposal.proposedTime,
      durationMinutes,
    );

    await ctx.db.patch(proposal.booking._id, {
      scheduled_date: proposal.proposedDate,
      scheduled_time: proposal.proposedTime,
      mechanic_id: proposal.proposedMechanicId,
      time_slot_id: slotId,
      updated_at: Date.now(),
    });

    if (
      proposal.booking.time_slot_id &&
      String(proposal.booking.time_slot_id) !== String(slotId)
    ) {
      await releaseBookingSlot(ctx, proposal.booking.time_slot_id);
    }

    // R1.4 — audit each pushed downstream booking so the chain back to
    // the triggering upstream job is queryable from booking history.
    const minutesShifted =
      hhmmToMinutes(proposal.proposedTime) -
      hhmmToMinutes(proposal.originalTime ?? proposal.proposedTime);
    await ctx.db.insert("booking_status_history", {
      booking_id: proposal.booking._id,
      old_status: proposal.booking.status ?? "confirmed",
      new_status: proposal.booking.status ?? "confirmed",
      changed_by: "system",
      reason: `pushed_by_upstream_${source}:${String(upstreamBooking._id)}:${minutesShifted}min`,
      changed_at: Date.now(),
    } as any);

    await enqueueNotificationOutbox(ctx, {
      shopId: proposal.booking.shop_id,
      bookingId: proposal.booking._id,
      userId: proposal.booking.user_id,
      channel: "push",
      category: "schedule_courtesy_update",
      dedupeKey: `schedule-courtesy:${String(proposal.booking._id)}:${source}:${proposal.proposedDate}:${proposal.proposedTime}:${String(proposal.proposedMechanicId)}`,
      payload: {
        source,
        originalDate: proposal.originalDate,
        originalTime: proposal.originalTime,
        originalMechanicId: String(proposal.originalMechanicId ?? ""),
        newDate: proposal.proposedDate,
        newTime: proposal.proposedTime,
        newMechanicId: String(proposal.proposedMechanicId),
        usedAlternateMechanic: proposal.usedAlternateMechanic,
      },
    });

    await syncBookingAssignments(ctx, [
      {
        shopId: proposal.booking.shop_id,
        mechanicId: proposal.originalMechanicId,
        date: proposal.originalDate,
      },
      {
        shopId: proposal.booking.shop_id,
        mechanicId: proposal.proposedMechanicId,
        date: proposal.proposedDate,
      },
    ]);
  }

  return { moved: plan.proposals.length, blocked: false };
}

async function getOpenOverrunCheckinForBooking(ctx: any, bookingId: any) {
  const rows = await ctx.db
    .query("overrun_checkins")
    .withIndex("by_booking_id", (q: any) => q.eq("booking_id", bookingId))
    .collect();
  return (
    rows
      .filter((row: any) => OPEN_OVERRUN_CHECKIN_STATUSES.has(row.status))
      .sort((a: any, b: any) => (b.created_at ?? 0) - (a.created_at ?? 0))[0] ??
    null
  );
}

async function resolveOpenOverrunCheckinsForBooking(
  ctx: any,
  bookingId: any,
  userId?: any,
) {
  const rows = await ctx.db
    .query("overrun_checkins")
    .withIndex("by_booking_id", (q: any) => q.eq("booking_id", bookingId))
    .collect();
  const now = Date.now();
  for (const row of rows) {
    if (!OPEN_OVERRUN_CHECKIN_STATUSES.has(row.status)) continue;
    await ctx.db.patch(row._id, {
      status: "resolved",
      resolved_at_ms: now,
      answered_by_user_id: userId,
      updated_at: now,
    });
  }
}

async function upsertOverrunCheckinForBooking(
  ctx: any,
  booking: any,
  startedAtMs: number,
) {
  if (
    !booking?.shop_id ||
    !booking?._id ||
    !booking?.scheduled_date ||
    !booking?.scheduled_time
  ) {
    return;
  }

  const existing = await getOpenOverrunCheckinForBooking(ctx, booking._id);
  if (existing) return existing._id;

  const estimatedMinutes = booking.estimated_labor_minutes ?? 60;
  const settings = await getShopSchedulingSettings(ctx, booking.shop_id);
  const dueAtMs = startedAtMs + estimatedMinutes * 60 * 1000 * 0.75;
  const now = Date.now();
  const checkinId = await ctx.db.insert("overrun_checkins", {
    shop_id: booking.shop_id,
    booking_id: booking._id,
    mechanic_id: booking.mechanic_id,
    status: "scheduled",
    due_at_ms: dueAtMs,
    escalation_due_at_ms: dueAtMs + 3 * 60 * 1000,
    auto_apply_at_ms: dueAtMs + 6 * 60 * 1000,
    default_extension_minutes: getDefaultOverrunExtensionMinutes({
      estimatedMinutes,
      percent: settings.overrunDefaultExtensionPercent,
      floorMinutes: settings.overrunExtensionFloorMinutes,
    }),
    created_at: now,
    updated_at: now,
  });

  await scheduleOverrunCheckinProcessing(ctx, dueAtMs);
  return checkinId;
}

async function applyOverrunExtension(
  ctx: any,
  {
    checkin,
    booking,
    extensionMinutes,
    source,
    userId,
  }: {
    checkin: any;
    booking: any;
    extensionMinutes: number;
    source: "mechanic" | "front_desk" | "system";
    userId?: any;
  },
) {
  const now = Date.now();
  const originalEstimate = booking.estimated_labor_minutes ?? 60;
  const newEstimate = originalEstimate + extensionMinutes;
  const newEndTimeHHMM = getBookingEndTime(booking.scheduled_time, newEstimate);
  const projectedEndMinutes = hhmmToMinutes(newEndTimeHHMM);

  await applyDownstreamMovement(ctx, {
    upstreamBooking: booking,
    projectedEndMinutes,
    source: "job_overrun",
  });

  // R1.1 — persist the extension on the upstream booking so future
  // re-arms, downstream re-cascades, and analytics see the new estimate.
  await ctx.db.patch(booking._id, {
    estimated_labor_minutes: newEstimate,
    updated_at: now,
  } as any);

  // R1.2 — mirror the cumulative extension into job_actuals so post-job
  // billing/reporting reflects real time consumed, not the stale quote.
  try {
    const jobActual = await ensureJobActualRecord(ctx, { booking, now });
    if (jobActual?._id) {
      await ctx.db.patch(jobActual._id, {
        actual_labor_minutes: newEstimate,
        updated_at: now,
      } as any);
    }
  } catch (_err) {
    // ensureJobActualRecord throws if mechanic_id is missing; safe to skip.
  }

  // R1.3 — audit the extension in booking_status_history so the chain
  // of overrun events is visible from the booking detail panel.
  await ctx.db.insert("booking_status_history", {
    booking_id: booking._id,
    old_status: "in_progress",
    new_status: "in_progress",
    changed_by: userId ? String(userId) : "system",
    reason: `overrun_extension_${extensionMinutes}min_${source}`,
    changed_at: now,
  } as any);

  await ctx.db.patch(checkin._id, {
    status: source === "system" ? "system_applied" : "answered",
    answered_at_ms: now,
    answered_by_user_id: userId,
    answer_source: source,
    is_complete: false,
    extension_minutes: extensionMinutes,
    resolved_at_ms: now,
    updated_at: now,
  });

  // D2 + R1.5 — customer resolution push with the new end time so the
  // mobile banner can read "finishing around 4:00 PM" instead of a
  // generic delta.
  await enqueueNotificationOutbox(ctx, {
    shopId: booking.shop_id,
    bookingId: booking._id,
    userId: booking.user_id,
    channel: "push",
    category: "overrun_customer_resolution",
    dedupeKey: `overrun-customer-resolution:${String(checkin._id)}:${now}`,
    scheduledForMs: now,
    payload: {
      extensionMinutes,
      newEstimatedLaborMinutes: newEstimate,
      newEndTime: newEndTimeHHMM,
      cascadeDepth: (checkin.cascade_depth ?? 0) + 1,
      message: `Your appointment is now estimated to finish around ${newEndTimeHHMM}. Tap reschedule if the new time doesn't work.`,
    },
  });

  // D1 — cascade re-arm. If the booking is still in_progress past the new
  // estimated end, queue another check-in. Capped at depth 4 to avoid runaway.
  const cascadeDepth = (checkin.cascade_depth ?? 0) + 1;
  const MAX_CASCADE_DEPTH = 4;
  if (cascadeDepth >= MAX_CASCADE_DEPTH) return;

  const freshBooking = await ctx.db.get(booking._id);
  if (!freshBooking || (freshBooking as any).status !== "in_progress") return;

  const nextDueAtMs = now + Math.max(
    5 * 60 * 1000,
    Math.floor(extensionMinutes * 0.75 * 60 * 1000),
  );
  await ctx.db.insert("overrun_checkins", {
    shop_id: checkin.shop_id,
    booking_id: checkin.booking_id,
    mechanic_id: checkin.mechanic_id,
    status: "scheduled",
    due_at_ms: nextDueAtMs,
    escalation_due_at_ms: nextDueAtMs + 3 * 60 * 1000,
    auto_apply_at_ms: nextDueAtMs + 6 * 60 * 1000,
    default_extension_minutes: checkin.default_extension_minutes,
    cascade_depth: cascadeDepth,
    created_at: now,
    updated_at: now,
  } as any);
  await scheduleOverrunCheckinProcessing(ctx, nextDueAtMs);
}

async function applyCustomerLateDownstreamMovementIfNeeded(
  ctx: any,
  booking: any,
  actualStartMs: number,
) {
  if (!booking?.scheduled_date || !booking?.scheduled_time) return;
  const timezone = await getShopTimezone(ctx, booking.shop_id);
  const scheduledStartMs = toBookingDateTimeMs(
    booking.scheduled_date,
    booking.scheduled_time,
    timezone,
  );
  if (actualStartMs <= scheduledStartMs) return;

  const delayMinutes = roundUpToQuarterMinutes(
    Math.ceil((actualStartMs - scheduledStartMs) / 60_000),
  );
  const projectedEndMinutes =
    hhmmToMinutes(booking.scheduled_time) +
    delayMinutes +
    (booking.estimated_labor_minutes ?? 60);

  await applyDownstreamMovement(ctx, {
    upstreamBooking: booking,
    projectedEndMinutes,
    source: "customer_late",
  });
}

async function createLateStartReview(
  ctx: any,
  {
    upstreamBooking,
    cycleMinutes,
    decisionDueAtMs,
    proposals,
    status,
    blockingReason,
  }: {
    upstreamBooking: any;
    cycleMinutes: number;
    decisionDueAtMs: number;
    proposals: any[];
    status: "pending_staff_review" | "blocked_manual_review";
    blockingReason?: string;
  }
) {
  const now = Date.now();
  return await ctx.db.insert("late_start_reviews", {
    shop_id: upstreamBooking.shop_id,
    upstream_booking_id: upstreamBooking._id,
    cycle_minutes: cycleMinutes,
    status,
    decision_due_at_ms: decisionDueAtMs,
    proposals,
    blocking_reason: blockingReason,
    created_at: now,
    updated_at: now,
  });
}

async function buildDynamicDelayPlan(
  ctx: any,
  {
    sourceBooking,
    projectedEndMinutes,
  }: {
    sourceBooking: any;
    projectedEndMinutes: number;
  }
) {
  const proposals: any[] = [];
  const sourceMechanicId = sourceBooking.mechanic_id;
  const date = sourceBooking.scheduled_date;
  let cursorEndMinutes = projectedEndMinutes;

  const downstreamBookings = (await getBlockingBookingsForShopDate(
    ctx,
    sourceBooking.shop_id,
    date
  ))
    .filter(
      (booking: any) =>
        String(booking._id) !== String(sourceBooking._id) &&
        String(booking.mechanic_id ?? "") === String(sourceMechanicId)
    )
    .sort(compareBookingsBySchedule);

  for (const downstreamBooking of downstreamBookings) {
    const bookingStartMinutes = hhmmToMinutes(downstreamBooking.scheduled_time);
    if (bookingStartMinutes >= cursorEndMinutes) break;

    const durationMinutes = downstreamBooking.estimated_labor_minutes ?? 60;
    const preference = getAssignmentPreference(downstreamBooking);

    if (
      downstreamBooking.status === "pending_customer_acceptance" &&
      String(downstreamBooking.schedule_change_source_booking_id ?? "") !==
        String(sourceBooking._id)
    ) {
      proposals.push({
        booking_id: downstreamBooking._id,
        original_scheduled_date: downstreamBooking.scheduled_date,
        original_scheduled_time: downstreamBooking.scheduled_time,
        original_mechanic_id: downstreamBooking.mechanic_id,
        used_alternate_mechanic: false,
        requires_customer_acceptance: true,
        blocked_reason: "This downstream booking already has a customer reschedule pending.",
      });
      return {
        proposals,
        blockingReason:
          "A downstream booking already has a different reschedule pending and needs manual review.",
      };
    }

    if (preference === "any") {
      const alternateMechanic = await findBestAlternateMechanicForWindow(ctx, {
        shopId: sourceBooking.shop_id,
        date,
        startTime: downstreamBooking.scheduled_time,
        durationMinutes,
        excludeMechanicId: sourceMechanicId,
        excludeBookingId: String(downstreamBooking._id),
      });

      if (alternateMechanic) {
        proposals.push({
          booking_id: downstreamBooking._id,
          original_scheduled_date: downstreamBooking.scheduled_date,
          original_scheduled_time: downstreamBooking.scheduled_time,
          original_mechanic_id: downstreamBooking.mechanic_id,
          proposed_scheduled_date: downstreamBooking.scheduled_date,
          proposed_scheduled_time: downstreamBooking.scheduled_time,
          proposed_mechanic_id: alternateMechanic.mechanicId,
          used_alternate_mechanic: true,
          requires_customer_acceptance: false,
        });
        continue;
      }
    }

    const pushedStartTime = await findEarliestStartOnMechanic(ctx, {
      shopId: sourceBooking.shop_id,
      mechanicId: sourceMechanicId,
      date,
      fromMinutes: cursorEndMinutes,
      durationMinutes,
      excludeBookingId: String(downstreamBooking._id),
    });

    if (!pushedStartTime) {
      proposals.push({
        booking_id: downstreamBooking._id,
        original_scheduled_date: downstreamBooking.scheduled_date,
        original_scheduled_time: downstreamBooking.scheduled_time,
        original_mechanic_id: downstreamBooking.mechanic_id,
        used_alternate_mechanic: false,
        requires_customer_acceptance: true,
        blocked_reason: "No automatic time remains before close on the current mechanic.",
      });
      return {
        proposals,
        blockingReason:
          "No automatic delayed slot is available before close on the current mechanic.",
      };
    }

    proposals.push({
      booking_id: downstreamBooking._id,
      original_scheduled_date: downstreamBooking.scheduled_date,
      original_scheduled_time: downstreamBooking.scheduled_time,
      original_mechanic_id: downstreamBooking.mechanic_id,
      proposed_scheduled_date: downstreamBooking.scheduled_date,
      proposed_scheduled_time: pushedStartTime,
      proposed_mechanic_id: sourceMechanicId,
      used_alternate_mechanic: false,
      requires_customer_acceptance: true,
    });

    cursorEndMinutes = hhmmToMinutes(
      getBookingEndTime(pushedStartTime, durationMinutes)
    );
  }

  return { proposals, blockingReason: undefined as string | undefined };
}

async function applySilentLateralMove(
  ctx: any,
  {
    booking,
    newMechanicId,
    sourceBookingId,
  }: {
    booking: any;
    newMechanicId: any;
    sourceBookingId: any;
  }
) {
  const durationMinutes = booking.estimated_labor_minutes ?? 60;
  const targetSlotId = await getOrCreateSlot(
    ctx,
    booking.shop_id,
    newMechanicId,
    booking.scheduled_date,
    booking.scheduled_time,
    durationMinutes
  );
  const previousMechanicId = booking.mechanic_id;

  await ctx.db.patch(booking._id, {
    mechanic_id: newMechanicId,
    time_slot_id: targetSlotId,
    schedule_change_mode: "forced_delay",
    schedule_change_source_booking_id: sourceBookingId,
    customer_can_restore_original: false,
    updated_at: Date.now(),
  });

  if (booking.time_slot_id && String(booking.time_slot_id) !== String(targetSlotId)) {
    await releaseBookingSlot(ctx, booking.time_slot_id);
  }

  await logBookingStatusChange(
    ctx,
    booking._id,
    booking.status,
    booking.status,
    undefined,
    "silent_lateral_move_by_system"
  );

  await syncBookingAssignments(ctx, [
    {
      shopId: booking.shop_id,
      mechanicId: previousMechanicId,
      date: booking.scheduled_date,
    },
    {
      shopId: booking.shop_id,
      mechanicId: newMechanicId,
      date: booking.scheduled_date,
    },
  ]);

  const mechanic = await ctx.db.get(newMechanicId);
  await enqueueNotificationOutbox(ctx, {
    shopId: booking.shop_id,
    bookingId: booking._id,
    userId: booking.user_id,
    mechanicId: newMechanicId,
    channel: "push",
    category: "silent_lateral_mechanic_change",
    dedupeKey: `silent-lateral-mechanic-change:${String(booking._id)}:${String(newMechanicId)}:${String(sourceBookingId)}`,
    payload: {
      title: "Same time, different mechanic",
      body: `Your appointment time is unchanged. The shop moved you to ${
        mechanic ? `${mechanic.first_name} ${mechanic.last_name}`.trim() : "another mechanic"
      }.`,
      sourceBookingId,
    },
  });
}

async function applyDynamicDelayPlan(
  ctx: any,
  {
    sourceBooking,
    proposals,
    changedBy,
  }: {
    sourceBooking: any;
    proposals: any[];
    changedBy?: any;
  }
) {
  for (const proposal of proposals) {
    if (proposal.blocked_reason) {
      await enqueueNotificationOutbox(ctx, {
        shopId: sourceBooking.shop_id,
        bookingId: proposal.booking_id,
        channel: "front_desk",
        category: "dynamic_delay_blocked",
        dedupeKey: `dynamic-delay-blocked:${String(proposal.booking_id)}:${String(sourceBooking._id)}`,
        payload: {
          title: "Manual schedule adjustment needed",
          body: proposal.blocked_reason,
          sourceBookingId: sourceBooking._id,
          proposal,
        },
      });
      continue;
    }

    const downstreamBooking = await ctx.db.get(proposal.booking_id);
    if (!downstreamBooking) continue;

    if (
      proposal.used_alternate_mechanic &&
      proposal.requires_customer_acceptance === false &&
      proposal.proposed_mechanic_id
    ) {
      await applySilentLateralMove(ctx, {
        booking: downstreamBooking,
        newMechanicId: proposal.proposed_mechanic_id,
        sourceBookingId: sourceBooking._id,
      });
      continue;
    }

    if (!proposal.proposed_scheduled_date || !proposal.proposed_scheduled_time) {
      continue;
    }

    await proposeRescheduleImpl(ctx, {
      booking: downstreamBooking,
      newScheduledDate: proposal.proposed_scheduled_date,
      newScheduledTime: proposal.proposed_scheduled_time,
      newMechanicId: proposal.proposed_mechanic_id,
      mode: "forced_delay",
      sourceBookingId: sourceBooking._id,
      customerCanRestoreOriginal: false,
      changedBy,
    });
  }
}

/**
 * Returns the wall-clock duration to persist as `actual_duration_minutes`
 * for an early-completed booking — or null when the booking shouldn't be
 * shrunk (insufficient timing data, or actual ≈ estimate). Rounds UP to
 * the next 5-min grid so the schedule lane snaps cleanly.
 */
function deriveActualDurationMinutes(args: {
  startedAtMs: number | null | undefined;
  endAtMs: number | null | undefined;
  estimatedMinutes: number | null | undefined;
}): number | null {
  if (!args.estimatedMinutes || args.estimatedMinutes <= 5) return null;
  if (!args.startedAtMs || !args.endAtMs) return null;
  const rawMinutes = (args.endAtMs - args.startedAtMs) / 60_000;
  if (!Number.isFinite(rawMinutes) || rawMinutes <= 0) return null;
  const actualMinutes = Math.ceil(rawMinutes / 5) * 5;
  if (actualMinutes >= args.estimatedMinutes - 4) return null;
  return actualMinutes;
}

/**
 * Persists actual wall-clock duration on the booking when a job finishes
 * meaningfully earlier than its upfront estimate. This is what the schedule
 * lane mapper reads to shrink the booking block — opening up the freed
 * window for new bookings without touching the original `estimated_labor_minutes`
 * (preserved for reporting).
 *
 * Skips when:
 *   - actual_duration_minutes is already set (backfill path computes its own)
 *   - we can't find a started_at timestamp to anchor wall-clock from
 *   - the actual time was within 5 min of the estimate (avoid micro-shrinks)
 */
async function maybePersistEarlyCompletionDuration(ctx: any, booking: any) {
  if (booking.actual_duration_minutes != null) return;

  const jobActual = await getLatestJobActualForBooking(ctx, booking._id);
  const startedAtMs =
    jobActual?.started_at ??
    booking.vehicle_arrived_at_ms ??
    null;
  const endAtMs =
    jobActual?.completed_at_ms ??
    booking.completed_at_ms ??
    Date.now();

  const actualMinutes = deriveActualDurationMinutes({
    startedAtMs,
    endAtMs,
    estimatedMinutes: booking.estimated_labor_minutes,
  });
  if (actualMinutes == null) return;

  await ctx.db.patch(booking._id, {
    actual_duration_minutes: actualMinutes,
    updated_at: Date.now(),
  });
}

/**
 * Diagnostic dump for completed bookings — used to debug schedule-lane
 * sizing. Returns the timing-relevant fields for each completed booking.
 *
 * Invoke via: npx convex run bookings:debugCompletedBookings
 */
/**
 * One-shot data migration: walks completed bookings that pre-date the
 * early-completion logic and backfills `actual_duration_minutes` from
 * existing job_actual timestamps. Idempotent — re-running is a no-op
 * because the live helper skips bookings that already have the field.
 *
 * Invoke via:
 *   npx convex run bookings:backfillEarlyCompletionDurations
 *   npx convex run bookings:backfillEarlyCompletionDurations '{"shopId":"<id>"}'
 */
export const backfillEarlyCompletionDurations = internalMutation({
  args: {
    shopId: v.optional(v.id("shops")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 500;

    const completedBookings = args.shopId
      ? await ctx.db
          .query("bookings")
          .withIndex("by_shop_and_status", (q: any) =>
            q.eq("shop_id", args.shopId).eq("status", "completed"),
          )
          .take(limit)
      : await ctx.db
          .query("bookings")
          .withIndex("by_status", (q: any) => q.eq("status", "completed"))
          .take(limit);

    let scanned = 0;
    let patched = 0;
    let skippedAlreadySet = 0;
    let skippedNoTiming = 0;
    let skippedNotEarly = 0;

    for (const booking of completedBookings) {
      scanned += 1;
      if ((booking as any).actual_duration_minutes != null) {
        skippedAlreadySet += 1;
        continue;
      }

      const jobActual = await getLatestJobActualForBooking(ctx, booking._id);
      const startedAtMs =
        jobActual?.started_at ??
        (booking as any).vehicle_arrived_at_ms ??
        null;
      const endAtMs =
        jobActual?.completed_at_ms ??
        (booking as any).completed_at_ms ??
        null;

      if (startedAtMs == null || endAtMs == null) {
        skippedNoTiming += 1;
        continue;
      }

      const actualMinutes = deriveActualDurationMinutes({
        startedAtMs,
        endAtMs,
        estimatedMinutes: (booking as any).estimated_labor_minutes,
      });
      if (actualMinutes == null) {
        skippedNotEarly += 1;
        continue;
      }

      await ctx.db.patch(booking._id, {
        actual_duration_minutes: actualMinutes,
        updated_at: Date.now(),
      });
      patched += 1;
    }

    return {
      scanned,
      patched,
      skippedAlreadySet,
      skippedNoTiming,
      skippedNotEarly,
    };
  },
});

async function runCompletionSideEffects(ctx: any, booking: any) {
  await maybePersistEarlyCompletionDuration(ctx, booking);

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

  // If the driver booked this directly from a mechanic rec card, close the
  // loop now: mark the rec completed, cancel its follow-up, refresh the
  // vehicle's score penalty. Inline (not scheduled) so it stays in the
  // same transaction.
  if (booking.source_recommendation_id) {
    await closeRecForCompletedBooking(ctx, {
      recommendationId: booking.source_recommendation_id,
      bookingId: booking._id,
    });
  }

  // Cross-shop closure: any open / acknowledged / driver-hidden rec for this
  // VIN whose service matches one delivered by this booking gets marked
  // resolved here so the VHS penalty clears even when the driver booked at
  // a different shop than the one that filed the rec.
  await closeMatchingRecsForCompletedBooking(ctx, { bookingId: booking._id });

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
    const label =
      BOOKING_STATUS_VISUALS[booking.status as BookingStatus]?.label?.toLowerCase() ??
      String(booking.status).replace(/_/g, " ");
    throw new Error(`This booking is already ${label} and can no longer be updated.`);
  }

  const patch: { status: string; updated_at: number; live_stage?: string } = {
    status: newStatus,
    updated_at: Date.now(),
  };
  if (newStatus === "confirmed" || newStatus === "vehicle_at_shop") {
    patch.live_stage = "booking_confirmed";
  } else if (newStatus === "vehicle_at_shop") {
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

  // Walk-in client status-driven updates. The helper guards source +
  // backfill, and the outbox dedupe key prevents double-send.
  const walkinCategory: WalkinUpdateCategory | null =
    newStatus === "confirmed"
      ? "walkin_booking_confirmed"
      : newStatus === "vehicle_at_shop"
        ? "walkin_vehicle_at_shop"
        : newStatus === "in_progress"
          ? "walkin_prejob_complete"
          : newStatus === "completed"
            ? "walkin_completed_claim"
            : null;
  if (walkinCategory) {
    const fresh = await ctx.db.get(booking._id);
    if (fresh) await enqueueWalkinClientUpdate(ctx, fresh, walkinCategory);
  }

  await syncBookingAssignments(ctx, [
    {
      shopId: booking.shop_id,
      mechanicId: booking.mechanic_id,
      date: booking.scheduled_date,
    },
  ]);

  const nextBooking = { ...booking, ...patch };
  if (newStatus === "confirmed") {
    await upsertCustomerLateMonitorForBooking(ctx, nextBooking);
    await upsertAppointmentReminderForBooking(ctx, nextBooking);
  } else {
    await resolveCustomerLateMonitorForBooking(ctx, nextBooking, changedBy);
    await resolveAppointmentReminderForBooking(ctx, nextBooking._id);
    await resolveLateStartMonitorForBooking(ctx, nextBooking, changedBy);
    await resolveNeverStartedBellNotificationsForBooking(ctx, booking._id);
  }

  if (["completed", "cancelled", "no_show"].includes(newStatus)) {
    await resolveOpenOverrunCheckinsForBooking(ctx, booking._id, changedBy);
  }

  // Auto-resolve manual scheduling alerts on terminal-ish transitions and on
  // a fresh `confirmed` (which is what `proposeReschedule`/`acceptReschedule`
  // lands on after a successful manual reschedule).
  if (
    ["confirmed", "cancelled", "declined", "no_show", "completed"].includes(
      newStatus,
    )
  ) {
    await resolveManualSchedulingAlertsForBooking(ctx, booking._id);
  }

  if (newStatus === "in_progress") {
    await applyCustomerLateDownstreamMovementIfNeeded(
      ctx,
      booking,
      patch.updated_at,
    );
    await upsertOverrunCheckinForBooking(ctx, nextBooking, patch.updated_at);
  }

  // ── Stripe capture / void hooks ───────────────────────────────────────
  // Capture the held authorization when the mechanic *completes* the job
  // (not on shop accept). The booking is held in `requires_capture` for
  // the full booking → service → complete lifecycle, then funds move.
  //
  // ⚠ Authorization expiry: Stripe card auths typically expire after 7
  // days. Bookings scheduled more than ~5 days out (book + service window
  // > 7 days) risk auth expiry before capture — track via a future cron
  // that re-auths or alerts near the limit.
  if (newStatus === "completed") {
    await ctx.scheduler.runAfter(
      0,
      (internal as any).payments_stripe.capturePaymentIntentForBooking,
      { bookingId: booking._id },
    );
  }
  // Void the authorization on any pre-capture terminal transition. The
  // action checks the payments row's status and skips if already captured.
  if (
    newStatus === "cancelled" ||
    newStatus === "declined" ||
    newStatus === "no_show"
  ) {
    await ctx.scheduler.runAfter(
      0,
      (internal as any).lib.stripe_void.voidBookingAuthorization,
      { bookingId: booking._id },
    );
  }

  return { success: true, oldStatus: booking.status, newStatus };
}

async function mapBookingListItem(ctx: any, booking: any) {
  const customer = await ctx.db.get(booking.user_id);
  const vehicleLabels = await resolveVehicleLabel(ctx, booking.vin);
  const serviceNames = await resolveServiceLabels(
    ctx,
    booking.service_ids,
    booking.selected_service_options,
  );
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
    assignmentPreference: normalizeAssignmentPreference(
      booking.assignment_preference,
    ),
    vehicleArrivedAtMs: booking.vehicle_arrived_at_ms ?? null,
    mechanicName: mechanic
      ? `${mechanic.first_name} ${mechanic.last_name}`.trim()
      : null,
  };
}

async function mapMechanicDashboardJob(ctx: any, booking: any) {
  const customer = await ctx.db.get(booking.user_id);
  const vehicleLabels = await resolveVehicleLabel(ctx, booking.vin);
  const serviceNames = await resolveServiceLabels(
    ctx,
    booking.service_ids,
    booking.selected_service_options,
  );
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
    vin: booking.vin,
    serviceNames,
    vehiclePassportComplete,
    estimatedLaborMinutes: booking.estimated_labor_minutes ?? null,
    totalCost: booking.total_cost,
    assignmentPreference: normalizeAssignmentPreference(
      booking.assignment_preference,
    ),
    vehicleArrivedAtMs: booking.vehicle_arrived_at_ms ?? null,
    customerNotes: booking.customer_notes ?? null,
    diagnosticSystem: resolveDiagnosticSystem(booking, serviceNames),
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
      .filter((q) =>
        q.or(
          q.eq(q.field("status"), "confirmed"),
          q.eq(q.field("status"), "vehicle_at_shop")
        )
      )
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
          scheduledTime: formatTime(booking.scheduled_time ?? ""),
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

    const hours = await ctx.db
      .query("shops_hours")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shop._id))
      .collect();
    hours.sort((a: any, b: any) => a.day_of_week - b.day_of_week);

    // Every active mechanic profile for the shop is schedulable. Portal
    // access (shop_users) is intentionally not required — see schedule.ts.
    const mechanics = (
      await ctx.db
        .query("mechanics")
        .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shop._id))
        .collect()
    ).filter((mechanic: any) => mechanic.is_active !== false);

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
      hours: hours.map((hour: any) => ({
        _id: hour._id,
        dayOfWeek: hour.day_of_week,
        openTime: hour.open_time,
        closeTime: hour.close_time,
        isClosed: hour.is_closed,
      })),
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

    // Iterate every active mechanic profile. If a shop_users row exists for
    // the mechanic, we use it to resolve the linked Clerk avatar; if not,
    // the mechanic still shows on today's schedule using just their profile.
    const shopMechanics = (
      await ctx.db
        .query("mechanics")
        .withIndex("by_shop_id", (q: any) => q.eq("shop_id", primary.shopId))
        .collect()
    ).filter((m: any) => m.is_active !== false);

    const mechanicShopUsersAll = await ctx.db
      .query("shop_users")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", primary.shopId))
      .filter((q: any) =>
        q.and(q.eq(q.field("is_active"), true), q.neq(q.field("mechanic_id"), undefined))
      )
      .collect();
    const shopUserByMechanicId = new Map<string, any>();
    for (const su of mechanicShopUsersAll) {
      if (su.mechanic_id) shopUserByMechanicId.set(String(su.mechanic_id), su);
    }

    const todaySchedule = (
      await Promise.all(
        shopMechanics.map(async (mechanic: any) => {
          const shopUser = shopUserByMechanicId.get(String(mechanic._id));
          const linkedUser = shopUser?.user_id ? await ctx.db.get(shopUser.user_id) : null;
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
            const mechanic = invite.mechanic_id ? await ctx.db.get(invite.mechanic_id as Id<"mechanics">) : null;
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

    const shop = await ctx.db.get(primary.shopId as Id<"shops">);
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
          booking.status !== "cancelled" &&
          booking.status !== "declined" &&
          booking.status !== "no_show"
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
          (booking.status === "confirmed" || booking.status === "vehicle_at_shop") &&
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

    const openOverrunCheckins = (
      await ctx.db
        .query("overrun_checkins")
        .withIndex("by_shop_id", (q: any) => q.eq("shop_id", primary.shopId))
        .collect()
    )
      .filter(
        (row: any) =>
          String(row.mechanic_id ?? "") === String(mechanicId) &&
          OPEN_OVERRUN_CHECKIN_STATUSES.has(row.status)
      )
      .map((row: any) => ({
        _id: row._id,
        bookingId: row.booking_id,
        status: row.status,
        dueAtMs: row.due_at_ms,
        escalationDueAtMs: row.escalation_due_at_ms,
        autoApplyAtMs: row.auto_apply_at_ms,
        defaultExtensionMinutes: row.default_extension_minutes,
      }));

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
      openOverrunCheckins,
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
    const lateMonitor = await getCustomerLateMonitorByBookingId(ctx, booking._id);
    const shopTimezone = await getShopTimezone(ctx, booking.shop_id);
    const scheduledStartMs = toBookingDateTimeMs(
      booking.scheduled_date ?? "",
      booking.scheduled_time ?? "",
      shopTimezone,
    );

    const inProgressPhotosResolved = jobActual?.in_progress_photos
      ? (
          await Promise.all(
            jobActual.in_progress_photos.map(async (photo: any) => ({
              storageId: photo.storage_id,
              caption: photo.caption ?? null,
              takenAt: photo.taken_at,
              url: await ctx.storage.getUrl(photo.storage_id),
            })),
          )
        ).filter((entry) => entry.url !== null)
      : [];

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
      scheduledStartMs,
      laborCost: booking.labor_cost,
      partsCost: booking.parts_cost,
      totalCost: booking.total_cost,
      estimatedLaborMinutes: booking.estimated_labor_minutes ?? null,
      vin: booking.vin,
      serviceIds: booking.service_ids ?? [],
      mechanicId: booking.mechanic_id ?? null,
      assignmentPreference: normalizeAssignmentPreference(
        booking.assignment_preference,
      ),
      vehicleArrivedAtMs: booking.vehicle_arrived_at_ms ?? null,
      vehicleArrivedByUserId: booking.vehicle_arrived_by_user_id ?? null,
      customerNotes: booking.customer_notes ?? null,
      diagnosticSystem: resolveDiagnosticSystem(booking, serviceNames),
      diagnosticChecklist: booking.diagnostic_checklist ?? null,
      diagnosticChecklistCompletedAtMs:
        booking.diagnostic_checklist_completed_at_ms ?? null,
      diagnosticFindingsNote: booking.diagnostic_findings_note ?? null,
      recommendedServiceId: booking.recommended_service_id ?? null,
      recommendedServiceName: booking.recommended_service_id
        ? ((await ctx.db.get(booking.recommended_service_id)) as any)?.name ?? null
        : null,
      recommendedServiceNote: booking.recommended_service_note ?? null,
      recommendationState: booking.recommendation_state ?? null,
      recommendationSentAtMs: booking.recommendation_sent_at_ms ?? null,
      recommendationDecidedAtMs: booking.recommendation_decided_at_ms ?? null,
      recommendedScheduledDate: booking.recommended_scheduled_date ?? null,
      recommendedScheduledTime: booking.recommended_scheduled_time ?? null,
      parentJobId: booking.parent_job_id ?? null,
      diagnosticFollowupState: booking.diagnostic_followup_state ?? null,
      awaitingInfoNote: booking.awaiting_info_note ?? null,
      awaitingInfoAtMs: booking.awaiting_info_at_ms ?? null,
      outOfScopeNote: booking.out_of_scope_note ?? null,
      outOfScopeCategory: booking.out_of_scope_category ?? null,
      customerName: formatCustomerName(customer),
      customerEmail: customer?.email ?? "",
      customerPhone: customer?.phone ?? null,
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
            inProgressNotes: jobActual.in_progress_notes ?? "",
            inProgressPhotos: inProgressPhotosResolved,
          }
        : null,
      history,
      previousScheduledDate: booking.previous_scheduled_date ?? null,
      previousScheduledTime: booking.previous_scheduled_time ?? null,
      previousMechanicId: booking.previous_mechanic_id ?? null,
      previousMechanicName,
      rescheduleProposedAt: booking.reschedule_proposed_at ?? null,
      invoiceNumber: (booking as any).invoice_number ?? null,
      customerLateMonitor: lateMonitor && lateMonitor.status === "active" ? {
        pushEnqueuedAtMs: lateMonitor.push_enqueued_at_ms ?? null,
        smsEnqueuedAtMs: lateMonitor.sms_enqueued_at_ms ?? null,
        frontdeskEnqueuedAtMs: lateMonitor.frontdesk_enqueued_at_ms ?? null,
        customerAcknowledgedAtMs: lateMonitor.customer_acknowledged_at_ms ?? null,
        thresholdDueAtMs: lateMonitor.threshold_due_at_ms,
        scheduledStartMs: lateMonitor.scheduled_start_ms,
      } : null,
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
    if (!booking) throw new Error("We couldn't find that booking. It may have been cancelled or removed.");

    await requireShopStaff(ctx, user._id, booking.shop_id);
    if (!["vehicle_at_shop", "in_progress"].includes(booking.status)) {
      throw new Error("Mark the vehicle here before starting work.");
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
    if (!booking) throw new Error("We couldn't find that booking. It may have been cancelled or removed.");

    await requireShopStaff(ctx, user._id, booking.shop_id);
    if (!["vehicle_at_shop", "in_progress"].includes(booking.status)) {
      throw new Error("Mark the vehicle as here before saving the pre-job check.");
    }

    // Enforce one-active-job-per-mechanic. If a different booking for this
    // mechanic is already in_progress, the caller must complete that one
    // first. Error code lets the client recognise the conflict and route
    // through the EndCurrentJobConfirmDialog.
    if (booking.status === "vehicle_at_shop" && booking.mechanic_id) {
      const conflict = await findMechanicActiveBooking(
        ctx,
        booking.shop_id,
        booking.mechanic_id,
        booking._id,
      );
      if (conflict) {
        throw new Error(`MECHANIC_HAS_ACTIVE_JOB:${String(conflict._id)}`);
      }
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

    {
      const resolvedSystem = resolveDiagnosticSystem(
        booking,
        await resolveServiceNames(ctx, booking.service_ids),
      );
      if (
        resolvedSystem &&
        (!booking.diagnostic_checklist || booking.diagnostic_checklist.length === 0)
      ) {
        await ctx.db.patch(booking._id, {
          diagnostic_checklist: templateForSystem(resolvedSystem),
          diagnostic_followup_state:
            booking.diagnostic_followup_state ?? "pending",
          updated_at: now,
        });
      } else if (resolvedSystem && !booking.diagnostic_followup_state) {
        await ctx.db.patch(booking._id, {
          diagnostic_followup_state: "pending",
          updated_at: now,
        });
      }
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
    if (!booking) throw new Error("We couldn't find that booking. It may have been cancelled or removed.");

    await requireShopStaff(ctx, user._id, booking.shop_id);
    if (!["vehicle_at_shop", "in_progress"].includes(booking.status)) {
      throw new Error("Mark the vehicle here before saving pre-job details.");
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
    if (!booking) throw new Error("We couldn't find that booking. It may have been cancelled or removed.");

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
      in_progress_notes: undefined,
      in_progress_photos: undefined,
    });

    await recordPartSnapshotsForBooking(ctx, {
      booking,
      jobActualId: jobActual._id,
      mechanicId: user._id,
      parts: normalizedParts,
      now,
    });

    await upsertVehiclePassportRecord(ctx, {
      vin: booking.vin,
      patch: buildPassportPatchFromPostjob(args.postjob),
      now,
      markConfirmed: true,
    });

    if (
      booking.mechanic_id &&
      args.postjob.recommendations &&
      args.postjob.recommendations.length > 0
    ) {
      await submitRecommendationsForBooking(ctx, {
        booking,
        jobActualId: jobActual._id,
        mechanicId: booking.mechanic_id,
        recommendations: args.postjob.recommendations,
        now,
      });
    }

    if (booking.status !== "completed") {
      await applyBookingStatusTransition(ctx, {
        booking,
        newStatus: "completed",
        changedBy: user._id,
        reason: "completed_by_shop",
      });
    }

    // Submitting the post-job survey IS the close-out for the mechanic —
    // there is no separate "finalize" step they're deferring. Stamp
    // finalized_at_ms directly on the row we just saved so the values from
    // the post-job form are preserved exactly (don't re-route through
    // finalizeJobActuals → saveJobActualDraft, which would re-run the
    // auto-labor compute with no actuals input and could stomp on the
    // mechanic's submitted minutes). Then run the same derived-data sync
    // finalize would have triggered.
    await ctx.db.patch(jobActual._id, {
      completed_at_ms: jobActual.completed_at_ms ?? now,
      finalized_at_ms: now,
      finalized_by_user_id: user._id,
      updated_at: now,
    });
    const finalized = await ctx.db.get(jobActual._id);
    const completedBooking = (await ctx.db.get(args.bookingId)) ?? booking;
    if (finalized) {
      await syncJobActualDerivedData(ctx, {
        booking: completedBooking,
        jobActual: finalized,
        now,
      });
    }

    return await buildVehiclePassportForBooking(ctx, booking);
  },
});

export const updateDiagnosticChecklistItem = mutation({
  args: {
    bookingId: v.id("bookings"),
    index: v.number(),
    status: v.union(
      v.literal("pending"),
      v.literal("checked"),
      v.literal("flagged"),
      v.literal("skipped"),
    ),
    mechanicNote: v.optional(v.string()),
    skipReason: v.optional(
      v.union(
        v.literal("not_applicable"),
        v.literal("no_equipment"),
        v.literal("customer_declined"),
        v.literal("out_of_time"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("We couldn't find that booking. It may have been cancelled or removed.");
    await requireShopStaff(ctx, user._id, booking.shop_id);

    let checklist = booking.diagnostic_checklist ?? [];
    if (checklist.length === 0) {
      const resolvedSystem = resolveDiagnosticSystem(
        booking,
        await resolveServiceNames(ctx, booking.service_ids),
      );
      if (resolvedSystem) {
        checklist = templateForSystem(resolvedSystem);
      }
    }
    if (args.index < 0 || args.index >= checklist.length) {
      throw new Error("That checklist item is no longer available. Refresh and try again.");
    }
    const trimmedNote = args.mechanicNote?.trim();
    const next = checklist.map((item, idx) => {
      if (idx !== args.index) return item;
      const updated: any = { ...item, status: args.status };
      if (args.status === "pending") {
        delete updated.mechanic_note;
        delete updated.skip_reason;
      } else {
        if (trimmedNote && trimmedNote.length > 0) {
          updated.mechanic_note = trimmedNote;
        } else if (args.mechanicNote !== undefined) {
          delete updated.mechanic_note;
        }
        if (args.status === "skipped") {
          if (args.skipReason) updated.skip_reason = args.skipReason;
        } else {
          delete updated.skip_reason;
        }
      }
      return updated;
    });

    await ctx.db.patch(booking._id, {
      diagnostic_checklist: next,
      updated_at: Date.now(),
    });

    return next;
  },
});

export const updateDiagnosticFindings = mutation({
  args: {
    bookingId: v.id("bookings"),
    note: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("We couldn't find that booking. It may have been cancelled or removed.");
    await requireShopStaff(ctx, user._id, booking.shop_id);
    await ctx.db.patch(booking._id, {
      diagnostic_findings_note: args.note.trim() || undefined,
      updated_at: Date.now(),
    });
    return { success: true };
  },
});

export const completeDiagnosticBooking = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("We couldn't find that booking. It may have been cancelled or removed.");
    await requireShopStaff(ctx, user._id, booking.shop_id);

    const resolvedSystem = resolveDiagnosticSystem(
      booking,
      await resolveServiceNames(ctx, booking.service_ids),
    );
    if (!resolvedSystem) {
      throw new Error("Not a diagnostic booking");
    }
    const checklist = booking.diagnostic_checklist ?? [];
    if (checklist.length === 0) {
      throw new Error("Diagnostic checklist has not been started");
    }
    const unresolved = checklist.filter((item) => item.status === "pending");
    if (unresolved.length > 0) {
      throw new Error(
        `Resolve all ${checklist.length} checklist items before completing (${unresolved.length} pending).`,
      );
    }
    assertFlaggedItemsHaveNotes(booking);

    const now = Date.now();
    await ctx.db.patch(booking._id, {
      diagnostic_checklist_completed_at_ms: now,
      diagnostic_followup_state: "resolved",
      updated_at: now,
    });

    if (booking.status !== "completed") {
      await applyBookingStatusTransition(ctx, {
        booking,
        newStatus: "completed",
        changedBy: user._id,
        reason: "diagnostic_completed_by_shop",
      });
    }

    return { success: true };
  },
});

export const parkDiagnosticForInfo = mutation({
  args: {
    bookingId: v.id("bookings"),
    note: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("We couldn't find that booking. It may have been cancelled or removed.");
    await requireShopStaff(ctx, user._id, booking.shop_id);

    const note = args.note.trim();
    if (!note) throw new Error("Add a short note about what you're waiting on.");

    const now = Date.now();
    await ctx.db.patch(booking._id, {
      diagnostic_followup_state: "awaiting_info",
      awaiting_info_note: note,
      awaiting_info_at_ms: now,
      updated_at: now,
    });
    return { success: true };
  },
});

export const resumeDiagnosticFollowUp = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("We couldn't find that booking. It may have been cancelled or removed.");
    await requireShopStaff(ctx, user._id, booking.shop_id);

    await ctx.db.patch(booking._id, {
      diagnostic_followup_state: "pending",
      awaiting_info_note: undefined,
      awaiting_info_at_ms: undefined,
      updated_at: Date.now(),
    });
    return { success: true };
  },
});

export const getDiagnosticsNeedingFollowUp = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return [];
    const primary = await getPrimaryAuthorizedShop(ctx, user._id);
    if (!primary) return [];

    const rows = await ctx.db
      .query("bookings")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", primary.shopId))
      .collect();

    const filtered = rows.filter(
      (b: any) =>
        (b.diagnostic_followup_state === "pending" ||
          b.diagnostic_followup_state === "awaiting_info") &&
        b.status !== "cancelled" &&
        b.status !== "declined",
    );

    return await Promise.all(
      filtered.map(async (booking: any) => {
        const customer: any = await ctx.db.get(booking.user_id);
        const vehicleLabels = await resolveVehicleLabel(ctx, booking.vin);
        const serviceNames = await resolveServiceNames(ctx, booking.service_ids);
        return {
          _id: booking._id,
          scheduledDate: booking.scheduled_date,
          scheduledTime: booking.scheduled_time,
          status: booking.status,
          customerName: formatCustomerName(customer),
          vehicle: vehicleLabels.full,
          serviceNames,
          diagnosticSystem: resolveDiagnosticSystem(booking, serviceNames),
          followupState: booking.diagnostic_followup_state,
          awaitingInfoNote: booking.awaiting_info_note ?? null,
          awaitingInfoAtMs: booking.awaiting_info_at_ms ?? null,
          checklistCompletedAtMs:
            booking.diagnostic_checklist_completed_at_ms ?? null,
        };
      }),
    );
  },
});

export const flagOutOfScopeFinding = mutation({
  args: {
    bookingId: v.id("bookings"),
    category: v.union(
      v.literal("bodywork"),
      v.literal("transmission"),
      v.literal("electrical_major"),
      v.literal("other"),
    ),
    note: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("We couldn't find that booking. It may have been cancelled or removed.");
    await requireShopStaff(ctx, user._id, booking.shop_id);

    const note = args.note.trim();
    if (!note) throw new Error("Describe the finding before flagging.");
    assertFlaggedItemsHaveNotes(booking);

    const now = Date.now();
    await ctx.db.patch(booking._id, {
      recommendation_state: "out_of_scope",
      out_of_scope_category: args.category,
      out_of_scope_note: note,
      recommendation_sent_at_ms: now,
      diagnostic_followup_state: "resolved",
      updated_at: now,
    });

    if (booking.status !== "completed") {
      await applyBookingStatusTransition(ctx, {
        booking,
        newStatus: "completed",
        changedBy: user._id,
        reason: "diagnostic_out_of_scope",
      });
    }

    return { success: true };
  },
});

export const attachRecommendedService = mutation({
  args: {
    bookingId: v.id("bookings"),
    serviceId: v.id("services"),
    mechanicNote: v.string(),
    scheduledDate: v.optional(v.string()),
    scheduledTime: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("We couldn't find that booking. It may have been cancelled or removed.");
    await requireShopStaff(ctx, user._id, booking.shop_id);

    const service = await ctx.db.get(args.serviceId);
    if (!service) throw new Error("Recommended service not found");

    const note = args.mechanicNote.trim();
    if (!note) throw new Error("Add a short note explaining the finding.");
    assertFlaggedItemsHaveNotes(booking);

    // Validate proposed slot against blocked time on the mechanic's lane.
    if (
      args.scheduledDate &&
      args.scheduledTime &&
      booking.mechanic_id
    ) {
      const durationMin = Math.round(
        ((service as any).default_labor_hours ?? 1) * 60,
      );
      const blocks = (
        await getManualBlockedSlotsForShop(
          ctx,
          booking.shop_id,
          args.scheduledDate,
        )
      ).filter(
        (s: any) => String(s.mechanic_id) === String(booking.mechanic_id),
      );
      const toMin = (hhmm: string) => {
        const [h, m] = hhmm.split(":").map(Number);
        return h * 60 + m;
      };
      const ps = toMin(args.scheduledTime);
      const pe = ps + durationMin;
      const blocked = (blocks as any[]).some((blk) => {
        const bs = toMin(blk.start_time);
        const be = toMin(blk.end_time);
        return bs < pe && be > ps;
      });
      if (blocked) {
        throw new Error(
          "Proposed slot overlaps blocked time on the mechanic's lane. Pick a different slot.",
        );
      }
    }

    const now = Date.now();
    await ctx.db.patch(booking._id, {
      recommended_service_id: args.serviceId,
      recommended_service_note: note,
      recommendation_state: "pending_customer",
      recommendation_sent_at_ms: now,
      recommendation_decided_at_ms: undefined,
      recommended_scheduled_date: args.scheduledDate,
      recommended_scheduled_time: args.scheduledTime,
      diagnostic_followup_state: "resolved",
      updated_at: now,
    });

    return { success: true };
  },
});

export const customerDecideRecommendation = mutation({
  args: {
    bookingId: v.id("bookings"),
    decision: v.union(v.literal("confirmed"), v.literal("declined")),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("We couldn't find that booking. It may have been cancelled or removed.");
    await requireShopStaff(ctx, user._id, booking.shop_id);

    if (booking.recommendation_state !== "pending_customer") {
      throw new Error("No recommendation is awaiting a decision.");
    }

    const now = Date.now();

    if (args.decision === "declined") {
      await ctx.db.patch(booking._id, {
        recommendation_state: "declined",
        recommendation_decided_at_ms: now,
        updated_at: now,
      });
      return { success: true, followUpBookingId: null as Id<"bookings"> | null };
    }

    if (!booking.recommended_service_id) {
      throw new Error("Recommendation has no service attached.");
    }
    const service = await ctx.db.get(booking.recommended_service_id);
    if (!service) throw new Error("Recommended service no longer exists.");

    const scheduledForLater =
      !!booking.recommended_scheduled_date &&
      !!booking.recommended_scheduled_time &&
      (booking.recommended_scheduled_date !== booking.scheduled_date ||
        booking.recommended_scheduled_time !== booking.scheduled_time);

    const followUpMinutes = Math.round(
      ((service as any).default_labor_hours ?? 1) * 60,
    );

    const followUpDate = scheduledForLater
      ? booking.recommended_scheduled_date!
      : booking.scheduled_date;

    const toMinutes = (hhmm: string) => {
      const [h, m] = hhmm.split(":").map(Number);
      return h * 60 + m;
    };

    // Fetch blocks for the follow-up's date on this mechanic's lane (skip if no
    // mechanic assigned — manual blocks always have a mechanic_id).
    const blocksForDay = booking.mechanic_id
      ? (
          await getManualBlockedSlotsForShop(
            ctx,
            booking.shop_id,
            followUpDate,
          )
        ).filter(
          (s: any) =>
            String(s.mechanic_id) === String(booking.mechanic_id),
        )
      : [];

    // Advance a candidate start past any blocked windows it would overlap.
    const advancePastBlocks = (startHHMM: string, durationMin: number) => {
      let cursor = toMinutes(startHHMM);
      let advanced = true;
      while (advanced) {
        advanced = false;
        for (const blk of blocksForDay as any[]) {
          const bs = toMinutes(blk.start_time);
          const be = toMinutes(blk.end_time);
          if (bs < cursor + durationMin && be > cursor) {
            cursor = be;
            advanced = true;
          }
        }
      }
      return addMinutesToHHMM("00:00", cursor);
    };

    const rawFollowUpStart = scheduledForLater
      ? booking.recommended_scheduled_time!
      : getBookingEndTime(
          booking.scheduled_time ?? "",
          booking.estimated_labor_minutes ?? 0,
        );

    // For schedule-for-later, hard-reject if the proposed slot overlaps a
    // mechanic break / blocked window. For right-after, silently advance past
    // any blocks so the follow-up lands on the first clear gap.
    if (scheduledForLater) {
      const proposalStart = toMinutes(rawFollowUpStart);
      const proposalEnd = proposalStart + followUpMinutes;
      const blocked = (blocksForDay as any[]).some((blk) => {
        const bs = toMinutes(blk.start_time);
        const be = toMinutes(blk.end_time);
        return bs < proposalEnd && be > proposalStart;
      });
      if (blocked) {
        throw new Error(
          "Proposed slot overlaps blocked time on the mechanic's lane. Pick a different slot.",
        );
      }
    }

    const followUpStart = scheduledForLater
      ? rawFollowUpStart
      : advancePastBlocks(rawFollowUpStart, followUpMinutes);

    const followUpId = await ctx.db.insert("bookings", {
      user_id: booking.user_id,
      shop_id: booking.shop_id,
      mechanic_id: booking.mechanic_id,
      vin: booking.vin,
      service_ids: [booking.recommended_service_id],
      scheduled_date: followUpDate,
      scheduled_time: followUpStart,
      status: scheduledForLater ? "confirmed" : "in_progress",
      assignment_preference: booking.assignment_preference,
      labor_cost: 0,
      parts_cost: 0,
      total_cost: 0,
      estimated_labor_minutes: followUpMinutes,
      parent_job_id: booking._id,
      vehicle_arrived_at_ms: scheduledForLater
        ? undefined
        : booking.vehicle_arrived_at_ms ?? now,
      created_at: now,
      updated_at: now,
    });

    // Right-after path: cascade-push later bookings on the same mechanic's lane,
    // hopping over any blocked windows / breaks.
    if (!scheduledForLater && booking.mechanic_id) {
      const shopBookings = await ctx.db
        .query("bookings")
        .withIndex("by_shop_id", (q: any) =>
          q.eq("shop_id", booking.shop_id),
        )
        .collect();
      const laneBookings = shopBookings
        .filter(
          (b: any) =>
            String(b.mechanic_id) === String(booking.mechanic_id) &&
            b.scheduled_date === followUpDate &&
            String(b._id) !== String(booking._id) &&
            String(b._id) !== String(followUpId) &&
            b.status !== "cancelled" &&
            b.status !== "declined" &&
            b.status !== "no_show" &&
            toMinutes(b.scheduled_time) >= toMinutes(followUpStart),
        )
        .sort(
          (a: any, b: any) =>
            toMinutes(a.scheduled_time) - toMinutes(b.scheduled_time),
        );

      let cursor = addMinutesToHHMM(followUpStart, followUpMinutes);
      for (const b of laneBookings) {
        const duration = b.estimated_labor_minutes ?? 60;
        const safeCursor = advancePastBlocks(cursor, duration);
        if (toMinutes(b.scheduled_time ?? "") >= toMinutes(safeCursor)) break;
        await ctx.db.patch(b._id, {
          scheduled_time: safeCursor,
          updated_at: now,
        });
        cursor = addMinutesToHHMM(safeCursor, duration);
      }
    }

    await ctx.db.patch(booking._id, {
      recommendation_state: "confirmed",
      recommendation_decided_at_ms: now,
      status: "completed",
      updated_at: now,
    });

    return { success: true, followUpBookingId: followUpId };
  },
});

export const generatePostjobPhotoUploadUrl = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("We couldn't find that booking. It may have been cancelled or removed.");
    await requireShopStaff(ctx, user._id, booking.shop_id);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Persist the mechanic's in-progress draft (notes and/or photos) captured in
 * the "Now working" overlay. Only fields provided are patched; pass an empty
 * string / empty array to clear. The post-job dialog seeds itself from these
 * on open and `completeWithPostjob` clears them once the report supersedes.
 */
export const saveInProgressDraft = mutation({
  args: {
    bookingId: v.id("bookings"),
    notes: v.optional(v.string()),
    photos: v.optional(v.array(postjobPhotoValidator)),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) {
      throw new Error(
        "We couldn't find that booking. It may have been cancelled or removed.",
      );
    }
    await requireShopStaff(ctx, user._id, booking.shop_id);

    const jobActual = await getLatestJobActualForBooking(ctx, booking._id);
    if (!jobActual) {
      throw new Error("Start the job before saving working notes.");
    }

    const patch: Record<string, unknown> = { updated_at: Date.now() };
    if (args.notes !== undefined) patch.in_progress_notes = args.notes;
    if (args.photos !== undefined) patch.in_progress_photos = args.photos;
    await ctx.db.patch(jobActual._id, patch);
    return { ok: true };
  },
});

export const getPostjobPhotoUrls = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) return [];
    const jobActual = await ctx.db
      .query("job_actuals")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", args.bookingId))
      .first();
    const photos = jobActual?.postjob_report?.postjob_photos ?? [];
    const resolved = await Promise.all(
      photos.map(async (photo) => ({
        storage_id: photo.storage_id,
        caption: photo.caption ?? null,
        taken_at: photo.taken_at,
        url: await ctx.storage.getUrl(photo.storage_id),
      }))
    );
    return resolved.filter((entry) => entry.url !== null);
  },
});

export const createByShop = mutation({
  args: {
    shopId: v.id("shops"),
    customerEmail: v.optional(v.string()),
    customerPhone: v.optional(v.string()),
    customerFirstName: v.optional(v.string()),
    customerLastName: v.optional(v.string()),
    vin: v.string(),
    vehicleYear: v.optional(v.float64()),
    vehicleMake: v.optional(v.string()),
    vehicleModel: v.optional(v.string()),
    vehicleTrim: v.optional(v.string()),
    scheduledDate: v.string(),
    scheduledTime: v.string(),
    serviceIds: v.array(v.id("services")),
    customServices: v.optional(
      v.array(
        v.object({
          name: v.string(),
          durationMinutes: v.optional(v.float64()),
        })
      )
    ),
    mechanicId: v.optional(v.id("mechanics")),
    assignmentPreference: v.optional(
      v.union(v.literal("any"), v.literal("specific_mechanic"))
    ),
    laborCost: v.float64(),
    partsCost: v.float64(),
    estimatedLaborMinutes: v.optional(v.float64()),
    status: v.optional(v.string()),
    allowOutsideShopHours: v.optional(v.boolean()),
    customerNotes: v.optional(v.string()),
    diagnosticSystem: v.optional(
      v.union(
        v.literal("brakes"),
        v.literal("tires_wheels"),
        v.literal("engine"),
        v.literal("battery_electrical"),
        v.literal("not_sure"),
      ),
    ),
    selectedServiceOptions: v.optional(
      v.array(
        v.object({
          service_id: v.id("services"),
          option_id: v.id("service_options"),
          option_label: v.string(),
          option_type: v.optional(v.string()),
        })
      )
    ),
    tireSpecs: v.optional(
      v.object({
        size: v.string(),
        type: v.string(),
        tier: v.string(),
        quantity: v.number(),
      })
    ),
    // Walk-in / external customer data capture. Defaults to "mechanic_walk_in"
    // when called from the schedule create-booking drawer.
    source: v.optional(
      v.union(
        v.literal("mechanic_walk_in"),
        v.literal("customer_self"),
        v.literal("shop_admin"),
      ),
    ),
    mechanicEstimatedMinutes: v.optional(v.float64()),
    catalogEstimatedMinutes: v.optional(v.float64()),
    mechanicQuotedPrice: v.optional(v.float64()),
    catalogQuotedPrice: v.optional(v.float64()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    await requireShopStaff(ctx, user._id, args.shopId);

    const now = Date.now();
    const canonicalVin = toCanonicalVin(args.vin);

    if (!args.customerEmail && !args.customerPhone) {
      throw new Error("Provide a customer email or phone number.");
    }

    // Guardrail: any selected service with has_options must arrive with
    // a pick, and a tire-replacement booking must arrive with tire_specs.
    // Web UI enforces this too, but server validation keeps integrity if
    // a caller bypasses the drawer.
    const servicesForOptionCheck = await Promise.all(
      args.serviceIds.map((id) => ctx.db.get(id))
    );
    const optionMap = new Map(
      (args.selectedServiceOptions ?? []).map((row: any) => [
        String(row.service_id),
        row,
      ])
    );
    for (const svc of servicesForOptionCheck) {
      if (!svc) continue;
      if (svc.slug === "tire-replacement") {
        if (!args.tireSpecs) {
          throw new Error(
            "Tire replacement requires tire_specs (size, type, tier, quantity).",
          );
        }
        continue;
      }
      // TODO(ts-fix): services schema lacks `has_options` field — verify intent (rename/add to schema)
      if ((svc as any).has_options && !optionMap.has(String(svc._id))) {
        throw new Error(
          `Service "${svc.name}" requires an option selection.`,
        );
      }
    }

    let normalizedPhone: string | undefined;
    if (args.customerPhone) {
      const digits = args.customerPhone.replace(/\D/g, "");
      if (digits.length === 10) normalizedPhone = `+1${digits}`;
      else if (digits.length === 11 && digits.startsWith("1")) normalizedPhone = `+${digits}`;
      else throw new Error("Phone number must be a valid 10-digit US number.");
    }

    let customer = args.customerEmail
      ? await ctx.db
          .query("users")
          .withIndex("by_email", (q: any) => q.eq("email", args.customerEmail))
          .first()
      : null;

    if (!customer && normalizedPhone) {
      const phoneMatches = await ctx.db.query("users").collect();
      customer =
        phoneMatches.find((u: any) => u.phone && u.phone === normalizedPhone) ?? null;
    }

    if (!customer) {
      const randomSuffix = Math.random().toString(36).slice(2, 8);
      const customerId = await ctx.db.insert("users", {
        clerkUserId: `shop-created-${now}-${randomSuffix}`,
        createdAt: now,
        onboardingCompleted: false,
        email: args.customerEmail,
        phone: normalizedPhone,
        first_name: args.customerFirstName,
        last_name: args.customerLastName,
      });
      customer = await ctx.db.get(customerId);
    }

    if (!customer) throw new Error("Could not create customer");

    let existingVehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q: any) => q.eq("vin", canonicalVin))
      .first();

    if (!existingVehicle) {
      const newVehicleId = await ctx.db.insert("vehicles", {
        vin: canonicalVin,
        year: args.vehicleYear,
        metadata: {
          make: args.vehicleMake,
          model: args.vehicleModel,
          trim: args.vehicleTrim,
        },
        created_at: now,
        updated_at: now,
      });
      existingVehicle = await ctx.db.get(newVehicleId);
    }

    // Fire-and-forget enrichment for any VIN whose vehicles row doesn't yet
    // have a resolved vehicle_config_id. Walk-in events are the freshest VIN
    // signal we get, so we always want full passport data ready by next visit.
    if (existingVehicle && !existingVehicle.vehicle_config_id) {
      await ctx.scheduler.runAfter(
        0,
        api.vehicleEnrichment.runPublic.go,
        { vin: canonicalVin },
      );
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
    const assignmentPreference =
      args.assignmentPreference ??
      (args.mechanicId ? "specific_mechanic" : "any");
    const customServicesNormalized = args.customServices
      ?.map((c: any) => ({
        name: String(c.name).trim(),
        duration_minutes: c.durationMinutes,
      }))
      .filter((c: any) => c.name.length > 0);
    const bookingSource = args.source ?? "mechanic_walk_in";
    const bookingId = await ctx.db.insert("bookings", {
      labor_cost: args.laborCost,
      parts_cost: args.partsCost,
      total_cost: args.laborCost + args.partsCost,
      estimated_labor_minutes: args.estimatedLaborMinutes,
      mechanic_id: resolvedMechanicId,
      scheduled_date: args.scheduledDate,
      scheduled_time: args.scheduledTime,
      service_ids: args.serviceIds,
      customer_notes: args.customerNotes?.trim() || undefined,
      diagnostic_system: args.diagnosticSystem,
      custom_services:
        customServicesNormalized && customServicesNormalized.length > 0
          ? customServicesNormalized
          : undefined,
      tire_specs: args.tireSpecs,
      selected_service_options:
        args.selectedServiceOptions && args.selectedServiceOptions.length > 0
          ? args.selectedServiceOptions
          : undefined,
      shop_id: args.shopId,
      status,
      assignment_preference: assignmentPreference,
      time_slot_id: timeSlotId,
      user_id: customer._id,
      vin: canonicalVin,
      created_at: now,
      updated_at: now,
      source: bookingSource,
      mechanic_estimated_minutes: args.mechanicEstimatedMinutes,
      catalog_estimated_minutes: args.catalogEstimatedMinutes,
      mechanic_quoted_price: args.mechanicQuotedPrice,
      catalog_quoted_price: args.catalogQuotedPrice,
    });

    // Per-service labor quote snapshots support analytics without joining
    // bookings through vehicles and vehicle configs on every query.
    if (existingVehicle) {
      const catalogServiceMinutes = servicesForOptionCheck.map((svc: any) =>
        svc && svc.default_labor_hours
          ? svc.default_labor_hours * 60
          : 0,
      );
      const customMinutesList = (customServicesNormalized ?? []).map(
        (c: any) => c.duration_minutes ?? 0,
      );
      const totalCatalogMinutes =
        catalogServiceMinutes.reduce((s: number, n: number) => s + n, 0) +
        customMinutesList.reduce((s: number, n: number) => s + n, 0);

      const allocate = (
        total: number | undefined,
        share: number,
      ): number | undefined => {
        if (total === undefined || total === null) return undefined;
        if (totalCatalogMinutes <= 0) {
          const denom =
            servicesForOptionCheck.length + customMinutesList.length;
          return denom > 0 ? total / denom : total;
        }
        return total * (share / totalCatalogMinutes);
      };

      const snapshotBase = {
        booking_id: bookingId,
        shop_id: args.shopId,
        mechanic_id: resolvedMechanicId ?? undefined,
        vehicle_id: existingVehicle._id,
        vehicle_config_id: existingVehicle.vehicle_config_id ?? undefined,
        engine_id: existingVehicle.engine_id ?? undefined,
        chassis_id: existingVehicle.chassis_id ?? undefined,
        trim_id: existingVehicle.trim_id ?? undefined,
        source: bookingSource,
        recorded_at: now,
      };

      for (let i = 0; i < args.serviceIds.length; i++) {
        const catMins = catalogServiceMinutes[i] ?? 0;
        await ctx.db.insert("labor_quote_snapshots", {
          ...snapshotBase,
          service_id: args.serviceIds[i],
          mechanic_estimated_minutes: allocate(
            args.mechanicEstimatedMinutes,
            catMins,
          ),
          catalog_estimated_minutes: catMins > 0 ? catMins : undefined,
          mechanic_quoted_price: allocate(args.mechanicQuotedPrice, catMins),
          catalog_quoted_price: allocate(args.catalogQuotedPrice, catMins),
        });
      }
      if (customServicesNormalized) {
        for (let i = 0; i < customServicesNormalized.length; i++) {
          const c = customServicesNormalized[i];
          const catMins = c.duration_minutes ?? 0;
          await ctx.db.insert("labor_quote_snapshots", {
            ...snapshotBase,
            custom_service_name: c.name,
            mechanic_estimated_minutes: allocate(
              args.mechanicEstimatedMinutes,
              catMins,
            ),
            catalog_estimated_minutes: catMins > 0 ? catMins : undefined,
            mechanic_quoted_price: allocate(args.mechanicQuotedPrice, catMins),
            catalog_quoted_price: allocate(args.catalogQuotedPrice, catMins),
          });
        }
      }
    }

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

    if (status === "confirmed") {
      await upsertCustomerLateMonitorForBooking(
        ctx,
        {
          _id: bookingId,
          shop_id: args.shopId,
          mechanic_id: resolvedMechanicId,
          scheduled_date: args.scheduledDate,
          scheduled_time: args.scheduledTime,
          estimated_labor_minutes: args.estimatedLaborMinutes,
          status,
          assignment_preference: assignmentPreference,
        },
      );

      // Mechanic-created walk-in confirmation → SMS/email the client. The
      // helper no-ops for non-walk-in sources and backfills.
      const freshBooking = await ctx.db.get(bookingId);
      if (freshBooking) {
        await enqueueWalkinClientUpdate(
          ctx,
          freshBooking,
          "walkin_booking_confirmed",
        );
        await upsertAppointmentReminderForBooking(ctx, freshBooking);
      }
    }

    return bookingId;
  },
});

// Look up an existing booking at roughly the same slot for the same VIN so the
// drawer can warn before logging a duplicate backfill. "Roughly" = same shop,
// same VIN, same scheduled_date, within ±30 minutes of scheduled_time.
export const findBackfillCollision = query({
  args: {
    shopId: v.id("shops"),
    vin: v.string(),
    scheduledDate: v.string(),
    scheduledTime: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    await requireShopStaff(ctx, user._id, args.shopId);
    const canonicalVin = toCanonicalVin(args.vin);
    const [h, m] = args.scheduledTime.split(":").map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    const target = h * 60 + m;

    const rows = await ctx.db
      .query("bookings")
      .withIndex("by_shop_and_date", (q: any) =>
        q.eq("shop_id", args.shopId).eq("scheduled_date", args.scheduledDate),
      )
      .collect();

    for (const row of rows) {
      // Defend against historical rows that may have non-canonical VINs —
      // re-canonicalize on the comparison side rather than trusting storage.
      if (toCanonicalVin(row.vin) !== canonicalVin) continue;
      if (row.status === "cancelled" || row.status === "declined") continue;
      const t = row.scheduled_time as string | undefined;
      if (!t) continue;
      const [rh, rm] = t.split(":").map(Number);
      if (!Number.isFinite(rh) || !Number.isFinite(rm)) continue;
      if (Math.abs(rh * 60 + rm - target) <= 30) {
        return {
          _id: row._id,
          status: row.status,
          scheduled_time: row.scheduled_time,
          backfilled: !!row.backfilled_at_ms,
        };
      }
    }
    return null;
  },
});

// Retroactively log a job that has already been completed.
// See plan: /Users/temurbeksayfutdinov/.claude/plans/handling-back-fills-before-sparkling-grove.md
// Differences from createByShop:
//  - No capacity/overlap/hours validation — the past can't conflict.
//  - No time_slot creation (would skew mechanic utilization on past dates).
//  - No labor_quote_snapshots (those track quoted-vs-actual; backfill has no quote).
//  - No customer_late_monitor (no future threshold).
//  - No staff `new_booking` notification (mechanic logged their own past work).
//  - Inserts at status="in_progress" then transitions to "completed" so
//    runCompletionSideEffects fires exactly once.
//  - Stores actual_duration_minutes / actual_price_charged on the booking row.
//  - completed_at_ms = scheduledStart + actualDuration so revenue-by-day reports
//    attribute revenue to the day the work actually happened.
export const backfillCompletedBooking = mutation({
  args: {
    shopId: v.id("shops"),
    customerEmail: v.optional(v.string()),
    customerPhone: v.optional(v.string()),
    customerFirstName: v.optional(v.string()),
    customerLastName: v.optional(v.string()),
    vin: v.string(),
    vehicleYear: v.optional(v.float64()),
    vehicleMake: v.optional(v.string()),
    vehicleModel: v.optional(v.string()),
    vehicleTrim: v.optional(v.string()),
    scheduledDate: v.string(),
    scheduledTime: v.string(),
    serviceIds: v.array(v.id("services")),
    customServices: v.optional(
      v.array(
        v.object({
          name: v.string(),
          durationMinutes: v.optional(v.float64()),
        }),
      ),
    ),
    mechanicId: v.optional(v.id("mechanics")),
    customerNotes: v.optional(v.string()),
    diagnosticSystem: v.optional(
      v.union(
        v.literal("brakes"),
        v.literal("tires_wheels"),
        v.literal("engine"),
        v.literal("battery_electrical"),
        v.literal("not_sure"),
      ),
    ),
    selectedServiceOptions: v.optional(
      v.array(
        v.object({
          service_id: v.id("services"),
          option_id: v.id("service_options"),
          option_label: v.string(),
          option_type: v.optional(v.string()),
        }),
      ),
    ),
    tireSpecs: v.optional(
      v.object({
        size: v.string(),
        type: v.string(),
        tier: v.string(),
        quantity: v.number(),
      }),
    ),
    actualDurationMinutes: v.float64(),
    actualPriceCharged: v.float64(),
    actualPartsCost: v.optional(v.float64()),
    postjob: postjobReportValidator,
    sendCustomerReceipt: v.optional(v.boolean()),
    acknowledgedDuplicate: v.optional(v.boolean()),
    source: v.optional(v.string()),
    mechanicEstimatedMinutes: v.optional(v.float64()),
    catalogEstimatedMinutes: v.optional(v.float64()),
    mechanicQuotedPrice: v.optional(v.float64()),
    catalogQuotedPrice: v.optional(v.float64()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    await requireShopStaff(ctx, user._id, args.shopId);

    const now = Date.now();
    const canonicalVin = toCanonicalVin(args.vin);
    const timezone = await getShopTimezone(ctx, args.shopId);
    const scheduledStartMs = toBookingDateTimeMs(
      args.scheduledDate,
      args.scheduledTime,
      timezone,
    );

    if (scheduledStartMs >= now) {
      throw new Error(
        "Backfill is only for jobs whose scheduled time is in the past.",
      );
    }

    if (!args.customerEmail && !args.customerPhone) {
      throw new Error("Provide a customer email or phone number.");
    }

    if (args.actualDurationMinutes <= 0) {
      throw new Error("Actual duration must be greater than zero.");
    }
    if (args.actualPriceCharged < 0) {
      throw new Error("Actual price charged cannot be negative.");
    }

    if (!args.acknowledgedDuplicate) {
      const [h, m] = args.scheduledTime.split(":").map(Number);
      const target = (h ?? 0) * 60 + (m ?? 0);
      const sameDay = await ctx.db
        .query("bookings")
        .withIndex("by_shop_and_date", (q: any) =>
          q.eq("shop_id", args.shopId).eq("scheduled_date", args.scheduledDate),
        )
        .collect();
      const collision = sameDay.find((row: any) => {
        if (toCanonicalVin(row.vin) !== canonicalVin) return false;
        if (row.status === "cancelled" || row.status === "declined") return false;
        const t = row.scheduled_time as string | undefined;
        if (!t) return false;
        const [rh, rm] = t.split(":").map(Number);
        return Math.abs((rh ?? 0) * 60 + (rm ?? 0) - target) <= 30;
      });
      if (collision) {
        throw new ConvexError({
          code: "DUPLICATE_BACKFILL",
          existingBookingId: String(collision._id),
          scheduledTime: collision.scheduled_time,
        });
      }
    }

    let normalizedPhone: string | undefined;
    if (args.customerPhone) {
      const digits = args.customerPhone.replace(/\D/g, "");
      if (digits.length === 10) normalizedPhone = `+1${digits}`;
      else if (digits.length === 11 && digits.startsWith("1"))
        normalizedPhone = `+${digits}`;
      else throw new Error("Phone number must be a valid 10-digit US number.");
    }

    let customer = args.customerEmail
      ? await ctx.db
          .query("users")
          .withIndex("by_email", (q: any) =>
            q.eq("email", args.customerEmail),
          )
          .first()
      : null;
    if (!customer && normalizedPhone) {
      const all = await ctx.db.query("users").collect();
      customer =
        all.find((u: any) => u.phone && u.phone === normalizedPhone) ?? null;
    }
    if (!customer) {
      const randomSuffix = Math.random().toString(36).slice(2, 8);
      const customerId = await ctx.db.insert("users", {
        clerkUserId: `shop-created-${now}-${randomSuffix}`,
        createdAt: now,
        onboardingCompleted: false,
        email: args.customerEmail,
        phone: normalizedPhone,
        first_name: args.customerFirstName,
        last_name: args.customerLastName,
      });
      customer = await ctx.db.get(customerId);
    }
    if (!customer) throw new Error("Could not create customer");

    let vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q: any) => q.eq("vin", canonicalVin))
      .first();
    if (!vehicle) {
      const newVehicleId = await ctx.db.insert("vehicles", {
        vin: canonicalVin,
        year: args.vehicleYear,
        metadata: {
          make: args.vehicleMake,
          model: args.vehicleModel,
          trim: args.vehicleTrim,
        },
        created_at: now,
        updated_at: now,
      });
      vehicle = await ctx.db.get(newVehicleId);
    }
    if (vehicle && !vehicle.vehicle_config_id) {
      await ctx.scheduler.runAfter(0, api.vehicleEnrichment.runPublic.go, {
        vin: canonicalVin,
      });
    }

    const ownerLink = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_vin_user", (q: any) =>
        q.eq("vin", canonicalVin).eq("user_id", customer._id),
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

    // Resolve mechanic. Order: explicit arg → caller's own mechanic row in
    // this shop → any active mechanic at the shop. Completed bookings with
    // no mechanic_id break utilization, payroll, and rewards attribution,
    // so we refuse rather than silently land an orphan.
    let mechanicId: Id<"mechanics"> | undefined = args.mechanicId;
    // TODO(ts-fix): previously tried mechanics.by_user_and_shop, but mechanics schema
    // has no user_id field and no such index. Skipping caller→mechanic lookup until
    // schema clarifies the relationship (likely needs a user_id field + index).
    if (!mechanicId) {
      const fallbackMech = await ctx.db
        .query("mechanics")
        .withIndex("by_shop_id", (q: any) => q.eq("shop_id", args.shopId))
        .first();
      mechanicId = fallbackMech?._id;
    }
    if (!mechanicId) {
      throw new Error(
        "No mechanic on this shop to attribute the backfill to. Pick a mechanic in the drawer.",
      );
    }

    const customServicesNormalized = args.customServices
      ?.map((c: any) => ({
        name: String(c.name).trim(),
        duration_minutes: c.durationMinutes,
      }))
      .filter((c: any) => c.name.length > 0);

    const completedAtMs = Math.min(
      now,
      scheduledStartMs + args.actualDurationMinutes * 60_000,
    );
    // Single source of truth for parts cost: derive from postjob.parts_used.
    // The drawer can still pass actualPartsCost as a hint, but the postjob
    // payload wins so booking.parts_cost and jobActual.actual_parts_cost
    // can never diverge.
    const normalizedPartsPreview = normalizePartsUsed(args.postjob.parts_used ?? []);
    const partsCost =
      args.postjob.actual_parts_cost ??
      args.actualPartsCost ??
      sumPartsCost(normalizedPartsPreview);
    const laborCost = Math.max(0, args.actualPriceCharged - partsCost);

    const bookingSource = args.source ?? "mechanic_backfill";

    // Insert at in_progress so the next transition is the canonical
    // in_progress → completed path, firing runCompletionSideEffects once.
    const bookingId = await ctx.db.insert("bookings", {
      labor_cost: laborCost,
      parts_cost: partsCost,
      total_cost: args.actualPriceCharged,
      estimated_labor_minutes: args.actualDurationMinutes,
      actual_duration_minutes: args.actualDurationMinutes,
      actual_price_charged: args.actualPriceCharged,
      backfilled_at_ms: now,
      mechanic_id: mechanicId,
      scheduled_date: args.scheduledDate,
      scheduled_time: args.scheduledTime,
      service_ids: args.serviceIds,
      customer_notes: args.customerNotes?.trim() || undefined,
      diagnostic_system: args.diagnosticSystem,
      custom_services:
        customServicesNormalized && customServicesNormalized.length > 0
          ? customServicesNormalized
          : undefined,
      tire_specs: args.tireSpecs,
      selected_service_options:
        args.selectedServiceOptions && args.selectedServiceOptions.length > 0
          ? args.selectedServiceOptions
          : undefined,
      shop_id: args.shopId,
      status: "in_progress",
      live_stage: "service_in_progress",
      assignment_preference: args.mechanicId ? "specific_mechanic" : "any",
      user_id: customer._id,
      vin: canonicalVin,
      created_at: now,
      updated_at: now,
      source: bookingSource,
      mechanic_estimated_minutes: args.mechanicEstimatedMinutes,
      catalog_estimated_minutes: args.catalogEstimatedMinutes,
      mechanic_quoted_price: args.mechanicQuotedPrice,
      catalog_quoted_price: args.catalogQuotedPrice,
    });

    // ── Per-service labor_quote_snapshots — denormalized aggregation rows
    //    so analytics can ask "for service X at shop Y on engine Z, what's
    //    the price/time distribution?" without joining through bookings →
    //    vehicles → vehicle_configs every query. Mirrors part_snapshots.
    //    Mechanic + catalog totals are split per service proportionally to
    //    each service's catalog weight (defaultLaborHours / labor catalog).
    if (vehicle) {
      const servicesForOptionCheck = await Promise.all(
        args.serviceIds.map((id: any) => ctx.db.get(id))
      );
      const catalogServiceMinutes = servicesForOptionCheck.map((svc: any) =>
        svc && svc.default_labor_hours
          ? svc.default_labor_hours * 60
          : 0,
      );
      const customMinutesList = (customServicesNormalized ?? []).map(
        (c: any) => c.duration_minutes ?? 0,
      );
      const totalCatalogMinutes =
        catalogServiceMinutes.reduce((s: number, n: number) => s + n, 0) +
        customMinutesList.reduce((s: number, n: number) => s + n, 0);

      const allocate = (
        total: number | undefined,
        share: number,
      ): number | undefined => {
        if (total === undefined || total === null) return undefined;
        if (totalCatalogMinutes <= 0) {
          const denom =
            servicesForOptionCheck.length + customMinutesList.length;
          return denom > 0 ? total / denom : total;
        }
        return total * (share / totalCatalogMinutes);
      };

      const snapshotBase = {
        booking_id: bookingId,
        shop_id: args.shopId,
        mechanic_id: mechanicId ?? undefined,
        vehicle_id: vehicle._id,
        vehicle_config_id: vehicle.vehicle_config_id ?? undefined,
        engine_id: vehicle.engine_id ?? undefined,
        chassis_id: vehicle.chassis_id ?? undefined,
        trim_id: vehicle.trim_id ?? undefined,
        source: bookingSource,
        recorded_at: now,
      };

      for (let i = 0; i < args.serviceIds.length; i++) {
        const catMins = catalogServiceMinutes[i] ?? 0;
        await ctx.db.insert("labor_quote_snapshots", {
          ...snapshotBase,
          service_id: args.serviceIds[i],
          mechanic_estimated_minutes: allocate(
            args.mechanicEstimatedMinutes,
            catMins,
          ),
          catalog_estimated_minutes: catMins > 0 ? catMins : undefined,
          mechanic_quoted_price: allocate(args.mechanicQuotedPrice, catMins),
          catalog_quoted_price: allocate(args.catalogQuotedPrice, catMins),
        });
      }
      if (customServicesNormalized) {
        for (let i = 0; i < customServicesNormalized.length; i++) {
          const c = customServicesNormalized[i];
          const catMins = c.duration_minutes ?? 0;
          await ctx.db.insert("labor_quote_snapshots", {
            ...snapshotBase,
            custom_service_name: c.name,
            mechanic_estimated_minutes: allocate(
              args.mechanicEstimatedMinutes,
              catMins,
            ),
            catalog_estimated_minutes: catMins > 0 ? catMins : undefined,
            mechanic_quoted_price: allocate(args.mechanicQuotedPrice, catMins),
            catalog_quoted_price: allocate(args.catalogQuotedPrice, catMins),
          });
        }
      }
    }

    await logBookingStatusChange(
      ctx,
      bookingId,
      undefined,
      "in_progress",
      user._id,
      "mechanic_backfill_created",
    );

    const booking = await ctx.db.get(bookingId);
    if (!booking) throw new Error("Backfill booking was lost during insert.");

    const normalizedParts = normalizedPartsPreview;

    const jobActual = await saveJobActualDraft(ctx, {
      booking,
      actuals: {
        actual_labor_minutes: args.actualDurationMinutes,
        actual_parts_cost: partsCost,
        difficulty_rating: args.postjob.difficulty_rating ?? null,
        technician_notes: args.postjob.technician_notes ?? "",
        parts_used: normalizedParts,
        completion_mileage: args.postjob.completion_mileage,
        vehicle_updates: args.postjob.vehicle_updates ?? undefined,
        parts_accuracy_status: args.postjob.parts_accuracy_status ?? null,
        parts_accuracy_feedback: args.postjob.parts_accuracy_feedback ?? null,
        additional_observations: args.postjob.additional_observations ?? null,
        flagged_vehicle_specs: args.postjob.flagged_vehicle_specs ?? false,
        flagged_vehicle_specs_reason:
          args.postjob.flagged_vehicle_specs_reason ?? null,
      },
      now,
      completedAtMs,
    });

    await ctx.db.patch(jobActual._id, {
      postjob_report: args.postjob,
      completed_at_ms: completedAtMs,
      finalized_at_ms: now,
      finalized_by_user_id: user._id,
      logged_at_ms: now,
      updated_at: now,
    });

    await recordPartSnapshotsForBooking(ctx, {
      booking,
      jobActualId: jobActual._id,
      mechanicId: user._id,
      parts: normalizedParts,
      now,
    });

    await upsertVehiclePassportRecord(ctx, {
      vin: canonicalVin,
      patch: buildPassportPatchFromPostjob(args.postjob),
      now,
      markConfirmed: true,
    });

    // Stamp completed_at_ms BEFORE the transition so the status-history log
    // and any side-effect read of the booking see the correct past time,
    // not now() or null.
    await ctx.db.patch(bookingId, { completed_at_ms: completedAtMs });

    // Refetch so applyBookingStatusTransition (and runCompletionSideEffects
    // it calls) operate on a current snapshot. The helper reads booking
    // fields; stale data here would silently regress future side-effects.
    const bookingForTransition = await ctx.db.get(bookingId);
    if (!bookingForTransition) {
      throw new Error("Backfill booking disappeared before completion.");
    }

    // Drive the in_progress → completed transition through the canonical
    // helper so status history, slot release (no-op here), assignment sync,
    // and runCompletionSideEffects all run the same way as a live close-out.
    await applyBookingStatusTransition(ctx, {
      booking: bookingForTransition,
      newStatus: "completed",
      changedBy: user._id,
      reason: "mechanic_backfill",
    });

    const finalized = await ctx.db.get(jobActual._id);
    const completedBooking = (await ctx.db.get(bookingId)) ?? booking;
    if (finalized) {
      await syncJobActualDerivedData(ctx, {
        booking: completedBooking,
        jobActual: finalized,
        now,
      });
    }

    return { bookingId, completedAtMs };
  },
});

export const update = mutation({
  args: {
    bookingId: v.id("bookings"),
    scheduledDate: v.optional(v.string()),
    scheduledTime: v.optional(v.string()),
    serviceIds: v.optional(v.array(v.id("services"))),
    mechanicId: v.optional(v.union(v.id("mechanics"), v.null())),
    assignmentPreference: v.optional(
      v.union(v.literal("any"), v.literal("specific_mechanic"))
    ),
    laborCost: v.optional(v.float64()),
    partsCost: v.optional(v.float64()),
    estimatedLaborMinutes: v.optional(v.float64()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("We couldn't find that booking. It may have been cancelled or removed.");

    await requireShopStaff(ctx, user._id, booking.shop_id);
    const currentMechanicId = await getBookingMechanicId(ctx, booking);

    const patch: any = { updated_at: Date.now() };
    const previousAssignment = {
      shopId: booking.shop_id,
      mechanicId: currentMechanicId,
      date: booking.scheduled_date,
    };

    if (args.serviceIds) patch.service_ids = args.serviceIds;
    if (args.assignmentPreference !== undefined) {
      patch.assignment_preference = args.assignmentPreference;
    }
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
      args.assignmentPreference !== undefined ||
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
      patch.assignment_preference =
        args.assignmentPreference ??
        (args.mechanicId === null
          ? "any"
          : args.mechanicId
            ? "specific_mechanic"
            : normalizeAssignmentPreference(booking.assignment_preference));

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

    const nextBooking = { ...booking, ...patch };
    if (nextBooking.status === "confirmed") {
      await upsertCustomerLateMonitorForBooking(ctx, nextBooking);
      await upsertAppointmentReminderForBooking(ctx, nextBooking);
    } else {
      await resolveCustomerLateMonitorForBooking(ctx, nextBooking, user._id);
      await resolveAppointmentReminderForBooking(ctx, nextBooking._id);
      await resolveLateStartMonitorForBooking(ctx, nextBooking, user._id);
    }

    return args.bookingId;
  },
});

export const accept = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("We couldn't find that booking. It may have been cancelled or removed.");

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
    if (!booking) throw new Error("We couldn't find that booking. It may have been cancelled or removed.");

    await requireShopStaff(ctx, user._id, booking.shop_id);
    if (booking.status !== "vehicle_at_shop") {
      throw new Error("Mark the vehicle here before starting work.");
    }

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
    if (!booking) throw new Error("We couldn't find that booking. It may have been cancelled or removed.");

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
    if (!booking) throw new Error("We couldn't find that booking. It may have been cancelled or removed.");

    await requireShopStaff(ctx, user._id, booking.shop_id);

    return await applyBookingStatusTransition(ctx, {
      booking,
      newStatus: "cancelled",
      changedBy: user._id,
      reason: args.reason ?? "cancelled_by_shop",
    });
  },
});

async function proposeRescheduleImpl(
  ctx: any,
  {
    booking,
    newScheduledDate,
    newScheduledTime,
    newMechanicId,
    allowOutsideShopHours,
    mode = "manual_reschedule",
    sourceBookingId,
    customerCanRestoreOriginal = mode !== "forced_delay",
    changedBy,
  }: {
    booking: any;
    newScheduledDate: string;
    newScheduledTime: string;
    newMechanicId?: any;
    allowOutsideShopHours?: boolean;
    mode?: ScheduleChangeMode;
    sourceBookingId?: any;
    customerCanRestoreOriginal?: boolean;
    changedBy?: any;
  }
) {
  const allowed = [
    "pending",
    "pending_shop_acceptance",
    "confirmed",
    "vehicle_at_shop",
    "pending_customer_acceptance",
  ];
  if (!allowed.includes(booking.status)) {
    const label =
      BOOKING_STATUS_VISUALS[booking.status as BookingStatus]?.label?.toLowerCase() ??
      String(booking.status).replace(/_/g, " ");
    throw new Error(`This booking can't be rescheduled while it's ${label}.`);
  }

  if (
    booking.status === "pending_customer_acceptance" &&
    getScheduleChangeMode(booking) === "forced_delay" &&
    mode === "manual_reschedule"
  ) {
    throw new Error(
      "This booking is in a forced-delay flow and must be adjusted from the late-start review."
    );
  }

  const currentMechanicId = await getBookingMechanicId(ctx, booking);
  const durationMinutes = booking.estimated_labor_minutes ?? 60;
  const targetMechanicId = await resolveMechanicForWindow(ctx, {
    shopId: booking.shop_id,
    date: newScheduledDate,
    startTime: newScheduledTime,
    durationMinutes,
    preferredMechanicId: newMechanicId ?? currentMechanicId ?? undefined,
    excludeBookingId: String(booking._id),
    allowAfterClose: allowOutsideShopHours === true,
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
    newScheduledDate,
    newScheduledTime,
    durationMinutes
  );

  const patch: any = {
    scheduled_date: newScheduledDate,
    scheduled_time: newScheduledTime,
    mechanic_id: targetMechanicId,
    time_slot_id: targetSlotId,
    reschedule_proposed_at: Date.now(),
    status: "pending_customer_acceptance",
    assignment_preference: newMechanicId
      ? "specific_mechanic"
      : normalizeAssignmentPreference(booking.assignment_preference),
    updated_at: Date.now(),
    live_stage: undefined,
    schedule_change_mode: mode,
    schedule_change_source_booking_id:
      mode === "forced_delay" ? sourceBookingId : undefined,
    customer_can_restore_original: customerCanRestoreOriginal,
  };

  if (booking.status !== "pending_customer_acceptance") {
    patch.previous_scheduled_date = booking.scheduled_date;
    patch.previous_scheduled_time = booking.scheduled_time;
    patch.previous_mechanic_id = booking.mechanic_id;
    patch.previous_status = booking.status;
  }

  await ctx.db.patch(booking._id, patch);

  // Front-desk has proposed a manual reschedule — the corresponding
  // manual_scheduling_required alert (if any) is now stale.
  await resolveManualSchedulingAlertsForBooking(ctx, booking._id);

  if (booking.status === "pending_customer_acceptance") {
    if (String(booking.time_slot_id) !== String(targetSlotId)) {
      await releaseBookingSlot(ctx, booking.time_slot_id);
    }

    if (customerCanRestoreOriginal && originalMechanicId) {
      await reservePendingCustomerSlot(
        ctx,
        booking.shop_id,
        originalMechanicId,
        originalDate ?? "",
        originalTime ?? "",
        durationMinutes
      );
    } else if (originalMechanicId) {
      const originalSlot = await findExactSlot(
        ctx,
        booking.shop_id,
        originalMechanicId,
        originalDate ?? "",
        originalTime ?? "",
        durationMinutes
      );
      if (originalSlot && String(originalSlot._id) !== String(targetSlotId)) {
        await releaseBookingSlot(ctx, originalSlot._id);
      }
    }
  } else if (customerCanRestoreOriginal && currentMechanicId) {
    await reservePendingCustomerSlot(
      ctx,
      booking.shop_id,
      currentMechanicId,
      booking.scheduled_date,
      booking.scheduled_time,
      durationMinutes,
      booking.time_slot_id
    );
  } else if (booking.time_slot_id && String(booking.time_slot_id) !== String(targetSlotId)) {
    await releaseBookingSlot(ctx, booking.time_slot_id);
  }

  const reason =
    mode === "forced_delay"
      ? booking.status === "pending_customer_acceptance"
        ? changedBy
          ? "forced_delay_updated_by_shop"
          : "forced_delay_updated_by_system"
        : changedBy
          ? "forced_delay_proposed_by_shop"
          : "forced_delay_proposed_by_system"
      : "reschedule_proposed_by_shop";

  await logBookingStatusChange(
    ctx,
    booking._id,
    booking.status,
    "pending_customer_acceptance",
    changedBy,
    reason
  );

  await enqueueNotificationOutbox(ctx, {
    shopId: booking.shop_id,
    bookingId: booking._id,
    userId: booking.user_id,
    channel: "push",
    category:
      mode === "forced_delay"
        ? "booking_forced_delay_proposed"
        : "booking_reschedule_proposed",
    dedupeKey:
      `booking-schedule-proposal:${String(booking._id)}:${mode}:${newScheduledDate}:${newScheduledTime}:${String(targetMechanicId ?? "none")}:${String(sourceBookingId ?? "none")}`,
    payload: {
      title:
        mode === "forced_delay"
          ? "Schedule delay proposed"
          : "Reschedule proposed",
      body:
        mode === "forced_delay"
          ? `Your booking was delayed to ${formatTime(newScheduledTime)} while the shop adjusts the schedule.`
          : `The shop proposed ${formatTime(newScheduledTime)} for this booking.`,
      mode,
      sourceBookingId,
      previousDate: originalDate,
      previousTime: originalTime,
      newScheduledDate,
      newScheduledTime,
      previousMechanicId: originalMechanicId,
      newMechanicId: targetMechanicId,
    },
  });

  await syncBookingAssignments(ctx, [
    {
      shopId: booking.shop_id,
      mechanicId: originalMechanicId,
      date: originalDate,
    },
    {
      shopId: booking.shop_id,
      mechanicId: targetMechanicId,
      date: newScheduledDate,
    },
  ]);

  await resolveCustomerLateMonitorForBooking(
    ctx,
    { ...booking, ...patch },
    changedBy
  );
  await resolveCustomerLateMonitorForBooking(
    ctx,
    { ...booking, ...patch },
    changedBy,
  );
  await upsertAppointmentReminderForBooking(ctx, { ...booking, ...patch });

  return booking._id;
}

export const proposeReschedule = mutation({
  args: {
    bookingId: v.id("bookings"),
    newScheduledDate: v.string(),
    newScheduledTime: v.string(),
    newMechanicId: v.optional(v.id("mechanics")),
    mode: v.optional(
      v.union(v.literal("manual_reschedule"), v.literal("forced_delay"))
    ),
    sourceBookingId: v.optional(v.id("bookings")),
    customerCanRestoreOriginal: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("We couldn't find that booking. It may have been cancelled or removed.");

    await requireShopStaff(ctx, user._id, booking.shop_id);

    return await proposeRescheduleImpl(ctx, {
      booking,
      newScheduledDate: args.newScheduledDate,
      newScheduledTime: args.newScheduledTime,
      newMechanicId: args.newMechanicId,
      mode: args.mode ?? "manual_reschedule",
      sourceBookingId: args.sourceBookingId,
      customerCanRestoreOriginal:
        args.customerCanRestoreOriginal ?? args.mode !== "forced_delay",
      changedBy: user._id,
    });
  },
});

export const customerApproveReschedule = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("We couldn't find that booking. It may have been cancelled or removed.");

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
      schedule_change_mode: undefined,
      schedule_change_source_booking_id: undefined,
      customer_can_restore_original: undefined,
      updated_at: Date.now(),
    });

    const reservedOriginalSlot = await findExactSlot(
      ctx,
      booking.shop_id,
      originalMechanicId,
      originalDate ?? "",
      originalTime ?? "",
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

    const confirmedBooking = {
      ...booking,
      status: "confirmed",
      live_stage: "booking_confirmed",
      previous_scheduled_date: undefined,
      previous_scheduled_time: undefined,
      previous_mechanic_id: undefined,
      previous_status: undefined,
      reschedule_proposed_at: undefined,
      schedule_change_mode: undefined,
      schedule_change_source_booking_id: undefined,
      customer_can_restore_original: undefined,
    };
    await upsertCustomerLateMonitorForBooking(ctx, confirmedBooking);
    await upsertAppointmentReminderForBooking(ctx, confirmedBooking);

    return booking._id;
  },
});

export const shopCancelReschedule = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("We couldn't find that booking. It may have been cancelled or removed.");

    if (booking.status !== "pending_customer_acceptance") {
      throw new Error("Booking is not pending customer acceptance");
    }
    if (getScheduleChangeMode(booking) === "forced_delay") {
      throw new Error(
        "Forced-delay bookings cannot be restored to the original slot from this action."
      );
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
      originalDate ?? "",
      originalTime ?? "",
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
      schedule_change_mode: undefined,
      schedule_change_source_booking_id: undefined,
      customer_can_restore_original: undefined,
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

    const restoredBooking = {
      ...booking,
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
      schedule_change_mode: undefined,
      schedule_change_source_booking_id: undefined,
      customer_can_restore_original: undefined,
    };
    if (originalStatus === "confirmed") {
      await upsertCustomerLateMonitorForBooking(ctx, restoredBooking);
    } else {
      await resolveCustomerLateMonitorForBooking(ctx, booking);
    }
    await upsertAppointmentReminderForBooking(ctx, restoredBooking);

    return booking._id;
  },
});

export const customerDeclineReschedule = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("We couldn't find that booking. It may have been cancelled or removed.");

    if (booking.status !== "pending_customer_acceptance") {
      throw new Error("Booking is not pending customer acceptance");
    }
    if (getScheduleChangeMode(booking) === "forced_delay") {
      throw new Error(
        "This booking cannot be restored to its original time. Please choose a new time or cancel the booking."
      );
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
      originalDate ?? "",
      originalTime ?? "",
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
      schedule_change_mode: undefined,
      schedule_change_source_booking_id: undefined,
      customer_can_restore_original: undefined,
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

    const restoredBooking = {
      ...booking,
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
      schedule_change_mode: undefined,
      schedule_change_source_booking_id: undefined,
      customer_can_restore_original: undefined,
    };
    if (originalStatus === "confirmed") {
      await upsertCustomerLateMonitorForBooking(ctx, restoredBooking);
    } else {
      await resolveCustomerLateMonitorForBooking(ctx, booking);
    }
    await upsertAppointmentReminderForBooking(ctx, restoredBooking);

    return booking._id;
  },
});

async function applyLateStartTargets(
  ctx: any,
  {
    upstreamBooking,
    targets,
    changedBy,
  }: {
    upstreamBooking: any;
    targets: Array<{
      bookingId: any;
      newScheduledDate: string;
      newScheduledTime: string;
      newMechanicId?: any;
      allowOutsideShopHours?: boolean;
    }>;
    changedBy?: any;
  }
) {
  for (const target of targets) {
    const downstreamBooking = await ctx.db.get(target.bookingId);
    if (!downstreamBooking) {
      throw new Error("A downstream booking could not be found.");
    }

    await proposeRescheduleImpl(ctx, {
      booking: downstreamBooking,
      newScheduledDate: target.newScheduledDate,
      newScheduledTime: target.newScheduledTime,
      newMechanicId: target.newMechanicId,
      allowOutsideShopHours: target.allowOutsideShopHours,
      mode: "forced_delay",
      sourceBookingId: upstreamBooking._id,
      customerCanRestoreOriginal: false,
      changedBy,
    });
  }
}

export const getOpenCustomerLateAlerts = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return [];
    const primary = await getPrimaryAuthorizedShop(ctx, user._id);
    if (!primary) return [];

    const now = Date.now();
    const rows = await ctx.db
      .query("customer_late_monitors")
      .withIndex("by_shop_and_status", (q: any) =>
        q.eq("shop_id", primary.shopId).eq("status", "active"),
      )
      .collect();

    const dueRows = rows
      .filter((row: any) => now >= row.threshold_due_at_ms)
      .sort((a: any, b: any) => a.threshold_due_at_ms - b.threshold_due_at_ms);

    const items = await Promise.all(
      dueRows.map(async (row: any) => {
        const booking = await ctx.db.get(row.booking_id as Id<"bookings">);
        if (!booking || !isCustomerLateMonitorEligible(booking)) return null;
        const customer = await ctx.db.get(booking.user_id);
        const mechanic = booking.mechanic_id
          ? await ctx.db.get(booking.mechanic_id)
          : null;
        const serviceNames = await resolveServiceNames(ctx, booking.service_ids);
        return {
          _id: row._id,
          bookingId: booking._id,
          customerName: formatCustomerName(customer),
          mechanicId: booking.mechanic_id ?? null,
          mechanicName: mechanic
            ? `${mechanic.first_name} ${mechanic.last_name}`.trim()
            : null,
          scheduledDate: booking.scheduled_date,
          scheduledTime: booking.scheduled_time,
          thresholdDueAtMs: row.threshold_due_at_ms,
          minutesLate: Math.max(
            0,
            Math.floor((now - row.scheduled_start_ms) / 60_000),
          ),
          vehicle: (await resolveVehicleLabel(ctx, booking.vin)).full,
          serviceSummary: serviceNames.join(", "),
        };
      }),
    );

    return items.filter(Boolean);
  },
});

export const getCustomerLateNotificationSentMonitors = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return [];
    const primary = await getPrimaryAuthorizedShop(ctx, user._id);
    if (!primary) return [];

    const now = Date.now();
    const rows = await ctx.db
      .query("customer_late_monitors")
      .withIndex("by_shop_and_status", (q: any) =>
        q.eq("shop_id", primary.shopId).eq("status", "active"),
      )
      .collect();

    const notifiedRows = rows.filter(
      (row: any) =>
        (row.push_enqueued_at_ms || row.sms_enqueued_at_ms || row.frontdesk_enqueued_at_ms) &&
        !row.customer_acknowledged_at_ms &&
        now < row.threshold_due_at_ms,
    );
    notifiedRows.sort((a: any, b: any) => a.scheduled_start_ms - b.scheduled_start_ms);

    const items = await Promise.all(
      notifiedRows.map(async (row: any) => {
        const booking = await ctx.db.get(row.booking_id as Id<"bookings">);
        if (!booking || !isCustomerLateMonitorEligible(booking)) return null;
        const customer = await ctx.db.get(booking.user_id);
        const mechanic = booking.mechanic_id ? await ctx.db.get(booking.mechanic_id) : null;
        const serviceNames = await resolveServiceNames(ctx, booking.service_ids);
        return {
          _id: row._id,
          bookingId: booking._id,
          customerName: formatCustomerName(customer),
          mechanicId: booking.mechanic_id ?? null,
          mechanicName: mechanic ? `${mechanic.first_name} ${mechanic.last_name}`.trim() : null,
          scheduledDate: booking.scheduled_date,
          scheduledTime: booking.scheduled_time,
          minutesLate: Math.max(0, Math.floor((now - row.scheduled_start_ms) / 60_000)),
          vehicle: (await resolveVehicleLabel(ctx, booking.vin)).full,
          serviceSummary: serviceNames.join(", "),
          notifiedVia: row.push_enqueued_at_ms ? "push" : row.sms_enqueued_at_ms ? "sms" : "frontdesk",
        };
      }),
    );

    return items.filter(Boolean);
  },
});

export const getCustomerOnMyWayMonitors = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return [];
    const primary = await getPrimaryAuthorizedShop(ctx, user._id);
    if (!primary) return [];

    const now = Date.now();
    const rows = await ctx.db
      .query("customer_late_monitors")
      .withIndex("by_shop_and_status", (q: any) =>
        q.eq("shop_id", primary.shopId).eq("status", "active"),
      )
      .collect();

    const onMyWayRows = rows.filter((row: any) => !!row.customer_acknowledged_at_ms);
    onMyWayRows.sort((a: any, b: any) => a.customer_acknowledged_at_ms - b.customer_acknowledged_at_ms);

    const items = await Promise.all(
      onMyWayRows.map(async (row: any) => {
        const booking = await ctx.db.get(row.booking_id as Id<"bookings">);
        if (!booking || booking.vehicle_arrived_at_ms) return null;
        const customer = await ctx.db.get(booking.user_id);
        const mechanic = booking.mechanic_id ? await ctx.db.get(booking.mechanic_id) : null;
        const serviceNames = await resolveServiceNames(ctx, booking.service_ids);
        return {
          _id: row._id,
          bookingId: booking._id,
          customerName: formatCustomerName(customer),
          mechanicId: booking.mechanic_id ?? null,
          mechanicName: mechanic ? `${mechanic.first_name} ${mechanic.last_name}`.trim() : null,
          scheduledDate: booking.scheduled_date,
          scheduledTime: booking.scheduled_time,
          minutesLate: Math.max(0, Math.floor((now - row.scheduled_start_ms) / 60_000)),
          acknowledgedAtMs: row.customer_acknowledged_at_ms,
          vehicle: (await resolveVehicleLabel(ctx, booking.vin)).full,
          serviceSummary: serviceNames.join(", "),
        };
      }),
    );

    return items.filter(Boolean);
  },
});

export const getOpenFrontDeskOverrunAlerts = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return [];
    const primary = await getPrimaryAuthorizedShop(ctx, user._id);
    if (!primary) return [];

    const rows = await ctx.db
      .query("overrun_checkins")
      .withIndex("by_shop_and_status", (q: any) =>
        q.eq("shop_id", primary.shopId).eq("status", "front_desk_escalated"),
      )
      .collect();
    rows.sort((a: any, b: any) => a.escalation_due_at_ms - b.escalation_due_at_ms);

    const items = await Promise.all(
      rows.map(async (row: any) => {
        const booking = await ctx.db.get(row.booking_id as Id<"bookings">);
        if (!booking || booking.status !== "in_progress") return null;
        const customer = await ctx.db.get(booking.user_id);
        const mechanic = booking.mechanic_id
          ? await ctx.db.get(booking.mechanic_id)
          : null;
        const serviceNames = await resolveServiceNames(ctx, booking.service_ids);
        return {
          _id: row._id,
          bookingId: booking._id,
          customerName: formatCustomerName(customer),
          mechanicName: mechanic
            ? `${mechanic.first_name} ${mechanic.last_name}`.trim()
            : null,
          serviceSummary: serviceNames.join(", "),
          defaultExtensionMinutes: row.default_extension_minutes,
          escalatedAtMs: row.frontdesk_escalated_at_ms ?? row.escalation_due_at_ms,
        };
      }),
    );

    return items.filter(Boolean);
  },
});

// One-shot cleanup: resolves all but the newest pending
// manual_scheduling_required row per booking for the current user's shop.
// Useful to clear historical dupes after the dedupe-key fix.
export const cleanupStaleManualSchedulingAlerts = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) throw new Error("Your session has expired. Please sign in again.");
    const primary = await getPrimaryAuthorizedShop(ctx, user._id);
    if (!primary) throw new Error("You're not linked to an active shop yet.");

    const rows = await ctx.db
      .query("notification_outbox")
      .withIndex("by_shop_and_status", (q: any) =>
        q.eq("shop_id", primary.shopId).eq("status", "pending"),
      )
      .collect();

    const groups = new Map<string, any[]>();
    for (const row of rows) {
      if (
        (row as any).channel !== "front_desk" ||
        (row as any).category !== "manual_scheduling_required"
      )
        continue;
      const key = (row as any).booking_id
        ? String((row as any).booking_id)
        : `nb-${String(row._id)}`;
      const list = groups.get(key) ?? [];
      list.push(row);
      groups.set(key, list);
    }

    const now = Date.now();
    let resolved = 0;
    for (const list of groups.values()) {
      if (list.length <= 1) continue;
      list.sort((a, b) => ((b as any).created_at ?? 0) - ((a as any).created_at ?? 0));
      for (const dupe of list.slice(1)) {
        await ctx.db.patch(dupe._id, {
          status: "superseded",
          processed_at: now,
          updated_at: now,
        } as any);
        resolved += 1;
      }
    }
    return { resolved };
  },
});

export const dismissManualSchedulingAlert = mutation({
  args: { alertId: v.id("notification_outbox") },
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) throw new Error("Your session has expired. Please sign in again.");
    const primary = await getPrimaryAuthorizedShop(ctx, user._id);
    if (!primary) throw new Error("You're not linked to an active shop yet.");
    const row = await ctx.db.get(args.alertId);
    if (!row || (row as any).shop_id !== primary.shopId) {
      throw new Error("Alert not found");
    }
    if ((row as any).category !== "manual_scheduling_required") {
      throw new Error("Cannot dismiss this alert");
    }
    await ctx.db.patch(args.alertId, {
      status: "resolved",
      processed_at: Date.now(),
      updated_at: Date.now(),
    } as any);
  },
});

export const getOpenManualSchedulingAlerts = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return [];
    const primary = await getPrimaryAuthorizedShop(ctx, user._id);
    if (!primary) return [];

    const rows = await ctx.db
      .query("notification_outbox")
      .withIndex("by_shop_and_status", (q: any) =>
        q.eq("shop_id", primary.shopId).eq("status", "pending"),
      )
      .collect();

    // Sort newest-first so the dedupe-by-booking step below keeps the
    // most recent row per booking.
    const filtered = rows
      .filter(
        (row: any) =>
          row.channel === "front_desk" &&
          row.category === "manual_scheduling_required",
      )
      .sort((a: any, b: any) => (b.created_at ?? 0) - (a.created_at ?? 0));

    // Defensive dedupe: collapse legacy rows that share the same booking_id
    // (older versions used a unique-per-fire dedupe key, so a single blocked
    // booking could have N rows). Read-only — the cleanup mutation
    // `cleanupStaleManualSchedulingAlerts` actually resolves the dupes.
    const seenBookings = new Set<string>();
    const deduped: any[] = [];
    for (const row of filtered) {
      const key = row.booking_id ? String(row.booking_id) : `nb-${String(row._id)}`;
      if (seenBookings.has(key)) continue;
      seenBookings.add(key);
      deduped.push(row);
    }
    deduped.sort((a: any, b: any) => (a.created_at ?? 0) - (b.created_at ?? 0));

    const enriched = await Promise.all(
      deduped.map(async (row: any) => {
        let customerName: string | null = null;
        let scheduledTime: string | null = null;
        let scheduledDate: string | null = null;
        let vehicleLabel: string | null = null;
        let booking: any = null;
        if (row.booking_id) {
          booking = await ctx.db.get(row.booking_id);
          if (booking) {
            scheduledTime = booking.scheduled_time ?? null;
            scheduledDate = booking.scheduled_date ?? null;
            if (booking.user_id) {
              const customer: any = await ctx.db.get(booking.user_id);
              const composed = [customer?.first_name, customer?.last_name]
                .filter(Boolean)
                .join(" ");
              customerName =
                customer?.name ||
                (composed.length > 0 ? composed : null) ||
                customer?.email ||
                null;
            }
            if (booking.vehicle_id) {
              const vehicle: any = await ctx.db.get(booking.vehicle_id);
              if (vehicle) {
                const meta = vehicle.metadata ?? {};
                const parts = [
                  vehicle.year ?? meta.year,
                  meta.make,
                  meta.model,
                ].filter(Boolean);
                vehicleLabel =
                  parts.length > 0
                    ? parts.join(" ")
                    : vehicle.vin
                      ? `VIN …${String(vehicle.vin).slice(-6)}`
                      : null;
              }
            }
          }
        }
        // Prefer the shop-assigned invoice number; fall back to last-6 id.
        const shortHandle = row.booking_id
          ? bookingDisplayHandle(booking ?? { _id: row.booking_id })
          : null;
        return {
          _id: row._id,
          bookingId: row.booking_id ?? null,
          createdAt: row.created_at,
          reason: row.payload?.reason ?? "Manual scheduling review required.",
          source: row.payload?.source ?? "scheduling",
          customerName,
          scheduledTime,
          scheduledDate,
          vehicleLabel,
          shortHandle,
        };
      }),
    );
    return enriched;
  },
});

export const getOpenLateStartReviews = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return [];

    const primary = await getPrimaryAuthorizedShop(ctx, user._id);
    if (!primary) return [];

    const rows = await ctx.db
      .query("late_start_reviews")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", primary.shopId))
      .collect();

    const openReviews = rows
      .filter((row: any) => OPEN_LATE_START_REVIEW_STATUSES.has(row.status))
      .sort((left: any, right: any) => left.decision_due_at_ms - right.decision_due_at_ms);

    const hydrated = await Promise.all(
      openReviews.map(async (review: any) => {
        const upstreamBooking = await ctx.db.get(review.upstream_booking_id as Id<"bookings">);
        if (
          !upstreamBooking ||
          !isLateStartMonitorEligible(upstreamBooking) ||
          (await hasBookingActuallyStarted(ctx, upstreamBooking))
        ) {
          return null;
        }
        const upstreamCustomer = upstreamBooking?.user_id
          ? await ctx.db.get(upstreamBooking.user_id)
          : null;
        const upstreamMechanic = upstreamBooking?.mechanic_id
          ? await ctx.db.get(upstreamBooking.mechanic_id)
          : null;
        const upstreamServices = upstreamBooking
          ? await resolveServiceNames(ctx, upstreamBooking.service_ids)
          : [];

        const proposals = await Promise.all(
          review.proposals.map(async (proposal: any) => {
            const booking = await ctx.db.get(proposal.booking_id as Id<"bookings">);
            const customer = booking?.user_id ? await ctx.db.get(booking.user_id) : null;
            const originalMechanic = proposal.original_mechanic_id
              ? await ctx.db.get(proposal.original_mechanic_id as Id<"mechanics">)
              : null;
            const proposedMechanic = proposal.proposed_mechanic_id
              ? await ctx.db.get(proposal.proposed_mechanic_id as Id<"mechanics">)
              : null;
            const serviceNames = booking
              ? await resolveServiceNames(ctx, booking.service_ids)
              : [];

            return {
              bookingId: proposal.booking_id,
              customerName: formatCustomerName(customer),
              serviceSummary: serviceNames.join(", "),
              estimatedMinutes: booking?.estimated_labor_minutes ?? 60,
              originalScheduledDate: proposal.original_scheduled_date,
              originalScheduledTime: proposal.original_scheduled_time,
              originalMechanicId: proposal.original_mechanic_id ?? null,
              originalMechanicName: originalMechanic
                ? `${originalMechanic.first_name} ${originalMechanic.last_name}`.trim()
                : null,
              proposedScheduledDate: proposal.proposed_scheduled_date ?? null,
              proposedScheduledTime: proposal.proposed_scheduled_time ?? null,
              proposedMechanicId: proposal.proposed_mechanic_id ?? null,
              proposedMechanicName: proposedMechanic
                ? `${proposedMechanic.first_name} ${proposedMechanic.last_name}`.trim()
                : null,
              usedAlternateMechanic: proposal.used_alternate_mechanic,
              blockedReason: proposal.blocked_reason ?? null,
            };
          })
        );

        return {
          _id: review._id,
          status: review.status,
          cycleMinutes: review.cycle_minutes,
          decisionDueAtMs: review.decision_due_at_ms,
          blockingReason: review.blocking_reason ?? null,
          upstreamBookingId: review.upstream_booking_id,
          upstreamCustomerName: formatCustomerName(upstreamCustomer),
          upstreamMechanicId: upstreamBooking?.mechanic_id ?? null,
          upstreamMechanicName: upstreamMechanic
            ? `${upstreamMechanic.first_name} ${upstreamMechanic.last_name}`.trim()
            : null,
          upstreamScheduledDate: upstreamBooking?.scheduled_date ?? null,
          upstreamScheduledTime: upstreamBooking?.scheduled_time ?? null,
          upstreamProjectedEndTime:
            upstreamBooking?.scheduled_time
              ? addMinutesToHHMM(
                  upstreamBooking.scheduled_time,
                  review.cycle_minutes + (upstreamBooking.estimated_labor_minutes ?? 60)
                )
              : null,
          upstreamServiceSummary: upstreamServices.join(", "),
          proposals,
        };
      })
    );

    return hydrated.filter(Boolean);
  },
});

export const acceptLateStartReview = mutation({
  args: { reviewId: v.id("late_start_reviews") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const review = await ctx.db.get(args.reviewId);
    if (!review) throw new Error("Late-start review not found");

    const upstreamBooking = await ctx.db.get(review.upstream_booking_id);
    if (!upstreamBooking) throw new Error("Upstream booking not found");

    await requireShopStaff(ctx, user._id, upstreamBooking.shop_id);

    if (review.status !== "pending_staff_review") {
      throw new Error("Only pending late-start reviews can be accepted.");
    }

    if (await hasBookingActuallyStarted(ctx, upstreamBooking) || !isLateStartMonitorEligible(upstreamBooking)) {
      await resolveLateStartMonitorForBooking(ctx, upstreamBooking, user._id);
      throw new Error("This late-start review is no longer needed.");
    }

    const targets = review.proposals.map((proposal: any) => {
      if (!proposal.proposed_scheduled_date || !proposal.proposed_scheduled_time) {
        throw new Error("This late-start review requires a manual schedule choice.");
      }
      return {
        bookingId: proposal.booking_id,
        newScheduledDate: proposal.proposed_scheduled_date,
        newScheduledTime: proposal.proposed_scheduled_time,
        newMechanicId: proposal.proposed_mechanic_id,
        allowOutsideShopHours: false,
      };
    });

    await applyLateStartTargets(ctx, {
      upstreamBooking,
      targets,
      changedBy: user._id,
    });

    await ctx.db.patch(review._id, {
      status: "accepted",
      resolved_at: Date.now(),
      resolved_by_user_id: user._id,
      updated_at: Date.now(),
    });

    const monitor = await getLateStartMonitorByUpstreamBookingId(ctx, upstreamBooking._id);
    if (monitor) {
      await advanceLateStartMonitorCycle(ctx, monitor);
    }

    return review._id;
  },
});

export const denyLateStartReview = mutation({
  args: { reviewId: v.id("late_start_reviews") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const review = await ctx.db.get(args.reviewId);
    if (!review) throw new Error("Late-start review not found");

    const upstreamBooking = await ctx.db.get(review.upstream_booking_id);
    if (!upstreamBooking) throw new Error("Upstream booking not found");

    await requireShopStaff(ctx, user._id, upstreamBooking.shop_id);

    if (review.status !== "pending_staff_review") {
      throw new Error("Only pending late-start reviews can be denied.");
    }

    await ctx.db.patch(review._id, {
      status: "denied_snoozed",
      resolved_at: Date.now(),
      resolved_by_user_id: user._id,
      updated_at: Date.now(),
    });

    const monitor = await getLateStartMonitorByUpstreamBookingId(ctx, upstreamBooking._id);
    if (monitor) {
      await advanceLateStartMonitorCycle(ctx, monitor);
    }

    return review._id;
  },
});

export const applyManualLateStartReview = mutation({
  args: {
    reviewId: v.id("late_start_reviews"),
    manualTargets: v.array(lateStartManualTargetValidator),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const review = await ctx.db.get(args.reviewId);
    if (!review) throw new Error("Late-start review not found");

    const upstreamBooking = await ctx.db.get(review.upstream_booking_id);
    if (!upstreamBooking) throw new Error("Upstream booking not found");

    await requireShopStaff(ctx, user._id, upstreamBooking.shop_id);

    if (!OPEN_LATE_START_REVIEW_STATUSES.has(review.status)) {
      throw new Error("This late-start review is no longer open.");
    }

    const expectedBookingIds = review.proposals
      .map((proposal: any) => String(proposal.booking_id))
      .sort();
    const providedBookingIds = args.manualTargets
      .map((target) => String(target.bookingId))
      .sort();

    if (
      expectedBookingIds.length !== providedBookingIds.length ||
      expectedBookingIds.some((bookingId: string, index: number) => bookingId !== providedBookingIds[index])
    ) {
      throw new Error("Manual late-start changes must cover every affected downstream booking.");
    }

    if (await hasBookingActuallyStarted(ctx, upstreamBooking) || !isLateStartMonitorEligible(upstreamBooking)) {
      await resolveLateStartMonitorForBooking(ctx, upstreamBooking, user._id);
      throw new Error("This late-start review is no longer needed.");
    }

    await applyLateStartTargets(ctx, {
      upstreamBooking,
      targets: args.manualTargets,
      changedBy: user._id,
    });

    await ctx.db.patch(review._id, {
      status: "manual_applied",
      resolved_at: Date.now(),
      resolved_by_user_id: user._id,
      updated_at: Date.now(),
    });

    const monitor = await getLateStartMonitorByUpstreamBookingId(ctx, upstreamBooking._id);
    if (monitor) {
      await advanceLateStartMonitorCycle(ctx, monitor);
    }

    return review._id;
  },
});

export const processCustomerLateMonitors = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const active = await ctx.db
      .query("customer_late_monitors")
      .withIndex("by_status", (q: any) => q.eq("status", "active"))
      .collect();

    let nextDueAtMs: number | null = null;
    for (const monitor of active) {
      const booking = await ctx.db.get(monitor.booking_id);
      if (!booking || !isCustomerLateMonitorEligible(booking)) {
        await ctx.db.patch(monitor._id, {
          status: "resolved",
          resolved_at_ms: now,
          updated_at: now,
        });
        continue;
      }

      if (now >= monitor.push_due_at_ms && !monitor.push_enqueued_at_ms) {
        await enqueueNotificationOutbox(ctx, {
          shopId: booking.shop_id,
          bookingId: booking._id,
          userId: booking.user_id,
          channel: "push",
          category: "customer_late_push_reminder",
          dedupeKey: `customer-late-push:${String(booking._id)}:${monitor.push_due_at_ms}`,
          scheduledForMs: monitor.push_due_at_ms,
          payload: {
            scheduledDate: booking.scheduled_date,
            scheduledTime: booking.scheduled_time,
          },
        });
        await ctx.db.patch(monitor._id, {
          push_enqueued_at_ms: now,
          updated_at: now,
        });
      }

      if (now >= monitor.sms_due_at_ms && !monitor.sms_enqueued_at_ms) {
        await enqueueNotificationOutbox(ctx, {
          shopId: booking.shop_id,
          bookingId: booking._id,
          userId: booking.user_id,
          channel: "sms",
          category: "customer_late_sms_reminder",
          dedupeKey: `customer-late-sms:${String(booking._id)}:${monitor.sms_due_at_ms}`,
          scheduledForMs: monitor.sms_due_at_ms,
          payload: {
            scheduledDate: booking.scheduled_date,
            scheduledTime: booking.scheduled_time,
          },
        });
        await ctx.db.patch(monitor._id, {
          sms_enqueued_at_ms: now,
          updated_at: now,
        });
      }

      if (
        now >= monitor.threshold_due_at_ms &&
        !monitor.frontdesk_enqueued_at_ms
      ) {
        await enqueueNotificationOutbox(ctx, {
          shopId: booking.shop_id,
          bookingId: booking._id,
          channel: "front_desk",
          category: "customer_late_front_desk_decision",
          dedupeKey: `customer-late-frontdesk:${String(booking._id)}:${monitor.threshold_due_at_ms}`,
          scheduledForMs: monitor.threshold_due_at_ms,
          payload: {
            scheduledDate: booking.scheduled_date,
            scheduledTime: booking.scheduled_time,
            thresholdDueAtMs: monitor.threshold_due_at_ms,
          },
        });
        await enqueueNotificationOutbox(ctx, {
          shopId: booking.shop_id,
          bookingId: booking._id,
          channel: "front_desk",
          category: "booking_never_started",
          dedupeKey: `booking-never-started:${String(booking._id)}:${monitor.threshold_due_at_ms}`,
          scheduledForMs: monitor.threshold_due_at_ms,
          payload: {
            scheduledDate: booking.scheduled_date,
            scheduledTime: booking.scheduled_time,
          },
        });
        await ctx.db.patch(monitor._id, {
          frontdesk_enqueued_at_ms: now,
          updated_at: now,
        });
      }

      for (const dueAtMs of [
        monitor.push_enqueued_at_ms ? null : monitor.push_due_at_ms,
        monitor.sms_enqueued_at_ms ? null : monitor.sms_due_at_ms,
        monitor.frontdesk_enqueued_at_ms ? null : monitor.threshold_due_at_ms,
      ]) {
        if (typeof dueAtMs === "number" && dueAtMs > now) {
          nextDueAtMs =
            nextDueAtMs == null ? dueAtMs : Math.min(nextDueAtMs, dueAtMs);
        }
      }
    }

    if (nextDueAtMs != null) {
      await scheduleCustomerLateMonitorProcessing(ctx, nextDueAtMs);
    }

    return { processedAt: now };
  },
});

export const processAppointmentReminderMonitors = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const active = await ctx.db
      .query("appointment_reminder_monitors")
      .withIndex("by_status", (q: any) => q.eq("status", "active"))
      .collect();

    let nextDueAtMs: number | null = null;

    for (const monitor of active) {
      if (monitor.due_at_ms > now) {
        nextDueAtMs =
          nextDueAtMs == null
            ? monitor.due_at_ms
            : Math.min(nextDueAtMs, monitor.due_at_ms);
        continue;
      }

      const booking = await ctx.db.get(monitor.booking_id);
      if (!booking || !isAppointmentReminderEligible(booking)) {
        await ctx.db.patch(monitor._id, {
          status: "resolved",
          resolved_at_ms: now,
          updated_at: now,
        });
        continue;
      }

      const user: any = await ctx.db.get((booking as any).user_id);
      const hasPhone = !!user?.phone;
      const hasEmail = !!user?.email;

      // Nothing to send through → resolve quietly. We won't be able to reach
      // this customer anyway, and leaving the monitor "active" would just
      // get re-scanned every minute forever.
      if (!hasPhone && !hasEmail) {
        await ctx.db.patch(monitor._id, {
          status: "resolved",
          resolved_at_ms: now,
          updated_at: now,
        });
        continue;
      }

      const shop: any = await ctx.db.get((booking as any).shop_id);

      let primaryService: string | null = null;
      const serviceIds = (booking as any).service_ids;
      const customServices = (booking as any).custom_services;
      if (Array.isArray(serviceIds) && serviceIds.length > 0) {
        const svc: any = await ctx.db.get(serviceIds[0]);
        primaryService = svc?.name ?? null;
      } else if (Array.isArray(customServices) && customServices.length > 0) {
        primaryService = customServices[0]?.name ?? null;
      }

      const payload = {
        shopName: shop?.name ?? "Your shop",
        scheduledDate: (booking as any).scheduled_date,
        scheduledTime: (booking as any).scheduled_time,
        firstName: user?.first_name ?? null,
        primaryService,
        bookingId: String(booking._id),
      };

      const baseDedupe = `appointment_reminder:${String(booking._id)}:${monitor._id}`;

      if (hasPhone) {
        await enqueueNotificationOutbox(ctx, {
          shopId: (booking as any).shop_id,
          bookingId: booking._id,
          userId: (booking as any).user_id,
          channel: "sms",
          category: "appointment_reminder",
          dedupeKey: `${baseDedupe}:sms`,
          payload,
        });
      }

      if (hasEmail) {
        await enqueueNotificationOutbox(ctx, {
          shopId: (booking as any).shop_id,
          bookingId: booking._id,
          userId: (booking as any).user_id,
          channel: "email",
          category: "appointment_reminder",
          dedupeKey: `${baseDedupe}:email`,
          payload,
        });
      }

      await ctx.db.patch(monitor._id, {
        status: "sent",
        enqueued_at_ms: now,
        updated_at: now,
      });
    }

    if (nextDueAtMs != null && ctx.scheduler?.runAfter) {
      await ctx.scheduler.runAfter(
        Math.max(0, nextDueAtMs - now),
        internal.bookings.processAppointmentReminderMonitors,
        {},
      );
    }

    return { processedAt: now };
  },
});

export const processOverrunCheckins = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const rows = (
      await Promise.all(
        Array.from(OPEN_OVERRUN_CHECKIN_STATUSES).map((status) =>
          ctx.db
            .query("overrun_checkins")
            .withIndex("by_status", (q: any) => q.eq("status", status))
            .collect(),
        ),
      )
    ).flat();

    let nextDueAtMs: number | null = null;
    for (const checkin of rows) {
      const booking = await ctx.db.get(checkin.booking_id);
      if (!booking || booking.status !== "in_progress") {
        await ctx.db.patch(checkin._id, {
          status: "resolved",
          resolved_at_ms: now,
          updated_at: now,
        });
        continue;
      }

      if (now >= checkin.due_at_ms && checkin.status === "scheduled") {
        await enqueueNotificationOutbox(ctx, {
          shopId: checkin.shop_id,
          bookingId: checkin.booking_id,
          mechanicId: checkin.mechanic_id,
          channel: "push",
          category: "overrun_mechanic_check_in",
          dedupeKey: `overrun-mechanic:${String(checkin._id)}:${checkin.due_at_ms}`,
          scheduledForMs: checkin.due_at_ms,
          payload: {
            defaultExtensionMinutes: checkin.default_extension_minutes,
          },
        });
        await ctx.db.patch(checkin._id, {
          status: "mechanic_prompted",
          mechanic_prompted_at_ms: now,
          updated_at: now,
        });
      }

      if (
        now >= checkin.escalation_due_at_ms &&
        (checkin.status === "mechanic_prompted" ||
          checkin.status === "awaiting_extension")
      ) {
        await enqueueNotificationOutbox(ctx, {
          shopId: checkin.shop_id,
          bookingId: checkin.booking_id,
          channel: "front_desk",
          category: "overrun_front_desk_escalation",
          dedupeKey: `overrun-frontdesk:${String(checkin._id)}:${checkin.escalation_due_at_ms}`,
          scheduledForMs: checkin.escalation_due_at_ms,
          payload: {
            defaultExtensionMinutes: checkin.default_extension_minutes,
          },
        });
        await ctx.db.patch(checkin._id, {
          status: "front_desk_escalated",
          frontdesk_escalated_at_ms: now,
          updated_at: now,
        });
      }

      if (
        now >= checkin.auto_apply_at_ms &&
        OPEN_OVERRUN_CHECKIN_STATUSES.has(checkin.status)
      ) {
        await applyOverrunExtension(ctx, {
          checkin,
          booking,
          extensionMinutes: checkin.default_extension_minutes,
          source: "system",
        });
        continue;
      }

      for (const dueAtMs of [
        checkin.status === "scheduled" ? checkin.due_at_ms : null,
        checkin.status === "mechanic_prompted" ||
        checkin.status === "awaiting_extension"
          ? checkin.escalation_due_at_ms
          : null,
        OPEN_OVERRUN_CHECKIN_STATUSES.has(checkin.status)
          ? checkin.auto_apply_at_ms
          : null,
      ]) {
        if (typeof dueAtMs === "number" && dueAtMs > now) {
          nextDueAtMs =
            nextDueAtMs == null ? dueAtMs : Math.min(nextDueAtMs, dueAtMs);
        }
      }
    }

    if (nextDueAtMs != null) {
      await scheduleOverrunCheckinProcessing(ctx, nextDueAtMs);
    }

    return { processedAt: now };
  },
});

export const processLateStartMonitors = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const active = await ctx.db
      .query("late_start_monitors")
      .withIndex("by_status", (q: any) => q.eq("status", "active"))
      .collect();
    const manualTakeover = await ctx.db
      .query("late_start_monitors")
      .withIndex("by_status", (q: any) => q.eq("status", "manual_takeover"))
      .collect();

    for (const monitor of [...active, ...manualTakeover]) {
      const upstreamBooking = await ctx.db.get(monitor.upstream_booking_id);
      if (!upstreamBooking) {
        await ctx.db.patch(monitor._id, {
          status: "resolved",
          updated_at: now,
        });
        continue;
      }

      if (
        !isLateStartMonitorEligible(upstreamBooking) ||
        (await hasBookingActuallyStarted(ctx, upstreamBooking))
      ) {
        await resolveLateStartMonitorForBooking(ctx, upstreamBooking);
        continue;
      }

      const { initialCycleMinutes } = getLateStartTimingConfig();
      let effectiveCycleMinutes = monitor.cycle_minutes;
      if (
        !(
          await getOpenLateStartReviewsForUpstreamBooking(ctx, upstreamBooking._id)
        ).some((review: any) => review.cycle_minutes === monitor.cycle_minutes)
      ) {
        effectiveCycleMinutes = initialCycleMinutes;
      }

      const { warningDueAtMs, autoApplyAtMs } = await getLateStartMonitorWindow(
        ctx,
        upstreamBooking,
        effectiveCycleMinutes
      );
      if (
        monitor.cycle_minutes !== effectiveCycleMinutes ||
        monitor.warning_due_at_ms !== warningDueAtMs ||
        monitor.auto_apply_at_ms !== autoApplyAtMs
      ) {
        await ctx.db.patch(monitor._id, {
          cycle_minutes: effectiveCycleMinutes,
          warning_due_at_ms: warningDueAtMs,
          auto_apply_at_ms: autoApplyAtMs,
          updated_at: now,
        });
      }

      if (monitor.status === "manual_takeover") {
        continue;
      }

      if (now < warningDueAtMs) {
        continue;
      }

      const openReview = (
        await getOpenLateStartReviewsForUpstreamBooking(ctx, upstreamBooking._id)
      ).find((review: any) => review.cycle_minutes === effectiveCycleMinutes);

      if (!openReview) {
        const plan = await buildLateStartReviewPlan(ctx, {
          upstreamBooking,
          cycleMinutes: effectiveCycleMinutes,
        });

        if (plan.proposals.length === 0) {
          if (now >= monitor.auto_apply_at_ms) {
            await advanceLateStartMonitorCycle(ctx, monitor);
          }
          continue;
        }

        const reviewStatus =
          plan.blockingReason ||
          plan.proposals.some(
            (proposal: any) =>
              !proposal.proposed_scheduled_date ||
              !proposal.proposed_scheduled_time ||
              !proposal.proposed_mechanic_id
          )
            ? "blocked_manual_review"
            : "pending_staff_review";

        const decisionDueAtMs =
          reviewStatus === "pending_staff_review" &&
          isLateStartTestModeEnabled() &&
          now >= autoApplyAtMs
            ? now + getLateStartTimingConfig().minVisibleReviewMs
            : autoApplyAtMs;

        await createLateStartReview(ctx, {
          upstreamBooking,
          cycleMinutes: effectiveCycleMinutes,
          decisionDueAtMs,
          proposals: plan.proposals,
          status: reviewStatus,
          blockingReason: plan.blockingReason,
        });

        if (reviewStatus === "blocked_manual_review") {
          await ctx.db.patch(monitor._id, {
            status: "manual_takeover",
            updated_at: Date.now(),
          });
          continue;
        }

        if (decisionDueAtMs !== autoApplyAtMs) {
          await ctx.db.patch(monitor._id, {
            auto_apply_at_ms: decisionDueAtMs,
            updated_at: now,
          });
        }
        await scheduleLateStartMonitorProcessing(ctx, decisionDueAtMs);
        continue;
      }

      if (
        openReview.status === "pending_staff_review" &&
        now >= autoApplyAtMs
      ) {
        const targets = openReview.proposals.map((proposal: any) => ({
          bookingId: proposal.booking_id,
          newScheduledDate: proposal.proposed_scheduled_date,
          newScheduledTime: proposal.proposed_scheduled_time,
          newMechanicId: proposal.proposed_mechanic_id,
        }));

        await applyLateStartTargets(ctx, {
          upstreamBooking,
          targets,
        });

        await ctx.db.patch(openReview._id, {
          status: "auto_applied",
          resolved_at: Date.now(),
          updated_at: Date.now(),
        });
        await advanceLateStartMonitorCycle(ctx, monitor);
      }
    }

    return { processedAt: now };
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
          q.lte(q.field("reschedule_proposed_at"), cutoff),
          q.neq(q.field("customer_can_restore_original"), false)
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
        originalDate ?? "",
        originalTime ?? "",
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
        schedule_change_mode: undefined,
        schedule_change_source_booking_id: undefined,
        customer_can_restore_original: undefined,
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

      if (originalStatus === "confirmed") {
        const restoredBooking = {
          ...booking,
          status: "confirmed",
          live_stage: "booking_confirmed",
          scheduled_date: originalDate,
          scheduled_time: originalTime,
          mechanic_id: originalMechanicId,
          time_slot_id: originalSlotId,
          previous_scheduled_date: undefined,
          previous_scheduled_time: undefined,
          previous_mechanic_id: undefined,
          previous_status: undefined,
          reschedule_proposed_at: undefined,
          schedule_change_mode: undefined,
          schedule_change_source_booking_id: undefined,
          customer_can_restore_original: undefined,
        };
        await upsertCustomerLateMonitorForBooking(ctx, restoredBooking);
        await upsertAppointmentReminderForBooking(ctx, restoredBooking);
      }
    }

    return expired.length;
  },
});

// ============================================================================
// TIRE QUOTE REQUESTS — broadcast-quote flow (Apr 23 redesign)
// ============================================================================

/**
 * MUTATION: createTireQuoteRequest
 * Creates a quote-stage booking with status "pending_quote". No shop_id is
 * assigned — shops respond via `tire_quote_responses.create`, and the user
 * picks one with `acceptTireQuote`.
 *
 * Replaces the local-only `synthesizeTireQuoteBooking` on the mobile side.
 */
export const createTireQuoteRequest = mutation({
  args: {
    user_id: v.id("users"),
    vin: v.string(),
    tire_specs: v.object({
      size: v.string(),
      type: v.string(),
      tier: v.string(),
      quantity: v.number(),
    }),
    service_ids: v.optional(v.array(v.id("services"))),
  },
  handler: async (ctx, args) => {
    const normalizedVin = args.vin.toUpperCase().trim();
    const now = Date.now();

    const bookingId = await ctx.db.insert("bookings", {
      user_id: args.user_id,
      vin: normalizedVin,
      service_ids: args.service_ids ?? [],
      status: "pending_quote",
      tire_specs: args.tire_specs,
      created_at: now,
      updated_at: now,
    });

    await logBookingStatusChange(
      ctx,
      bookingId,
      undefined,
      "pending_quote",
      args.user_id,
      "tire_quote_requested",
    );

    await ctx.db.insert("analytics_events", {
      user_id: args.user_id,
      event_type: "tire_quote_request_created",
      event_category: "booking",
      event_data: {
        booking_id: bookingId,
        tire_specs: args.tire_specs,
      },
      timestamp: now,
    });

    return bookingId;
  },
});

/**
 * MUTATION: acceptTireQuote
 * The user picks one of the shop responses for their pending tire booking.
 * Fills in shop_id, costs, and pricing onto the booking, flips status to
 * "confirmed", and supersedes the remaining responses.
 */
export const acceptTireQuote = mutation({
  args: {
    booking_id: v.id("bookings"),
    response_id: v.id("tire_quote_responses"),
  },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.booking_id);
    if (!booking) throw new Error("We couldn't find that booking. It may have been cancelled or removed.");
    if (booking.status !== "quotes_ready" && booking.status !== "pending_quote") {
      const label =
        BOOKING_STATUS_VISUALS[booking.status as BookingStatus]?.label?.toLowerCase() ??
        String(booking.status).replace(/_/g, " ");
      throw new Error(`Quotes can only be accepted while a request is awaiting a quote. This one is ${label}.`);
    }

    const response = await ctx.db.get(args.response_id);
    if (!response) throw new Error("We couldn't find that quote. It may have been withdrawn.");
    if (String(response.booking_id) !== String(args.booking_id)) {
      throw new Error("This quote doesn't belong to the selected request.");
    }
    if (response.superseded_at != null) {
      throw new Error("This quote has already been superseded.");
    }

    const now = Date.now();

    // Resolve the winning shop's "Tire Replacement" service so the
    // accepted booking carries a real `service_ids` entry — without it
    // every service-aware web surface (schedule cards, dashboard counters,
    // pre-job form) renders blank for the row. Quote-stage bookings can't
    // know the shop until acceptance, so this is the only point where
    // the right service can be picked.
    let tireService = await ctx.db
      .query("services")
      .withIndex("by_slug", (q) => q.eq("slug", "tire-replacement"))
      .first();
    if (!tireService) {
      // Legacy seed used an underscore form — fall back so older
      // deployments don't break.
      tireService = await ctx.db
        .query("services")
        .withIndex("by_slug", (q) => q.eq("slug", "tire_replacement"))
        .first();
    }

    let attachServiceId: Id<"services"> | null = null;
    if (tireService) {
      // The shop has already committed to install these tires (they
      // submitted the quote we're accepting), so auto-register the
      // shop_services row if it's missing. This avoids the cosmetic
      // regression on the schedule/dashboard for shops with incomplete
      // service-catalog onboarding.
      const offered = await ctx.db
        .query("shop_services")
        .withIndex("by_shop_and_service", (q) =>
          q.eq("shop_id", response.shop_id).eq("service_id", tireService!._id),
        )
        .first();
      if (!offered) {
        await ctx.db.insert("shop_services", {
          shop_id: response.shop_id,
          service_id: tireService._id,
          is_offered: true,
        });
      } else if (!offered.is_offered) {
        await ctx.db.patch(offered._id, { is_offered: true });
      }
      attachServiceId = tireService._id;
    } else {
      console.warn(
        "[acceptTireQuote] no Tire Replacement service found in catalog — service_ids will be empty",
      );
    }

    // Fill in the chosen shop + pricing + scheduled slot + service. The
    // shop's structured `availability` (YYYY-MM-DD + HH:MM) goes straight
    // onto the booking so it surfaces on /bookings + /schedule on the
    // web side; service_ids drives the rest of the service-aware UI.
    await ctx.db.patch(args.booking_id, {
      shop_id: response.shop_id,
      // Propagate the mechanic the shop picked at quote time so the
      // booking lands in the right column on the web schedule and the
      // "Open vehicle check" action can resolve a mechanic. Only set
      // when the quote actually carried one — older quotes without
      // mechanic_id stay "Any mechanic" until a manual reassign.
      ...(response.mechanic_id ? { mechanic_id: response.mechanic_id } : {}),
      labor_cost: response.labor_cost,
      parts_cost: response.per_tire_price * response.quantity,
      total_cost: response.total,
      scheduled_date: response.availability.date,
      scheduled_time: response.availability.time,
      ...(response.estimated_duration_minutes
        ? { estimated_labor_minutes: response.estimated_duration_minutes }
        : {}),
      status: "confirmed",
      updated_at: now,
      ...(attachServiceId ? { service_ids: [attachServiceId] } : {}),
    });

    // Supersede all other live responses for this booking.
    const siblings = await ctx.db
      .query("tire_quote_responses")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", args.booking_id))
      .collect();
    for (const sibling of siblings) {
      if (String(sibling._id) === String(args.response_id)) continue;
      if (sibling.superseded_at != null) continue;
      await ctx.db.patch(sibling._id, { superseded_at: now });
    }

    await logBookingStatusChange(
      ctx,
      args.booking_id,
      booking.status,
      "confirmed",
      booking.user_id,
      "tire_quote_accepted",
    );

    return args.booking_id;
  },
});

/**
 * QUERY: listOpenTireQuoteRequestsForShop
 * Returns quote-stage bookings the given shop has NOT yet responded to.
 * Used by the website's "Tire Quote Requests" view in the shop portal.
 *
 * Geo / proximity filtering is post-MVP; for now this returns every open
 * tire-quote-request globally so the shop can see what's out there.
 */
export const listOpenTireQuoteRequestsForShop = query({
  args: {
    shopId: v.id("shops"),
  },
  handler: async (ctx, args) => {
    const openBookings = await ctx.db
      .query("bookings")
      .withIndex("by_status", (q) => q.eq("status", "pending_quote"))
      .collect();

    const alsoQuotesReady = await ctx.db
      .query("bookings")
      .withIndex("by_status", (q) => q.eq("status", "quotes_ready"))
      .collect();

    const candidates = [...openBookings, ...alsoQuotesReady].filter(
      (b) => b.tire_specs != null,
    );

    // Filter out bookings this shop has already quoted on.
    const filtered = await Promise.all(
      candidates.map(async (booking) => {
        const existing = await ctx.db
          .query("tire_quote_responses")
          .withIndex("by_booking_and_shop", (q) =>
            q.eq("booking_id", booking._id).eq("shop_id", args.shopId),
          )
          .filter((q) => q.eq(q.field("superseded_at"), undefined))
          .first();
        return existing ? null : booking;
      }),
    );

    const open = filtered.filter((b): b is NonNullable<typeof b> => b != null);

    // Join basic vehicle context for the shop dashboard cards.
    return Promise.all(
      open.map(async (booking) => {
        const vehicle = await ctx.db
          .query("vehicles")
          .withIndex("by_vin", (q) => q.eq("vin", booking.vin))
          .first();
        const meta =
          (vehicle?.metadata as { make?: string; model?: string } | undefined) ?? undefined;
        return {
          _id: booking._id,
          _creationTime: booking._creationTime,
          status: booking.status,
          tire_specs: booking.tire_specs,
          vin: booking.vin,
          submitted_at: booking.created_at ?? booking._creationTime,
          vehicle: vehicle
            ? {
                year: vehicle.year ?? null,
                make: meta?.make ?? null,
                model: meta?.model ?? null,
              }
            : null,
        };
      }),
    );
  },
});

/**
 * Customer-side fetch for the mobile Pending Customer Acceptance overlay.
 *
 * Returns the raw `previous_*` and `schedule_change_*` fields the
 * decision UI needs to render the before/after comparison. Auth-gated
 * to the booking's owner. Joins shop name, current + previous mechanic
 * names, and service names.
 */
export const getBookingByIdForCustomer = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) return null;
    if (booking.user_id !== user._id) return null;

    const shop = booking.shop_id ? await ctx.db.get(booking.shop_id) : null;
    const currentMechanic = booking.mechanic_id
      ? await ctx.db.get(booking.mechanic_id)
      : null;
    const previousMechanic = booking.previous_mechanic_id
      ? await ctx.db.get(booking.previous_mechanic_id)
      : null;

    const serviceNames = await resolveServiceNames(ctx, booking.service_ids);

    const vehicle = booking.vin
      ? await ctx.db
          .query("vehicles")
          .withIndex("by_vin", (q: any) => q.eq("vin", booking.vin))
          .first()
      : null;
    const meta = (vehicle?.metadata as
      | { make?: string; model?: string; trim?: string }
      | undefined) ?? undefined;
    const vehicleDisplay = vehicle
      ? [vehicle.year, meta?.make, meta?.model].filter(Boolean).join(" ") || null
      : null;

    const formatMechanic = (m: any) =>
      m ? `${m.first_name ?? ""} ${m.last_name ?? ""}`.trim() : null;

    const rawHistory = await ctx.db
      .query("booking_status_history")
      .withIndex("by_booking_id", (q: any) => q.eq("booking_id", booking._id))
      .collect();
    rawHistory.sort((a: any, b: any) => a.changed_at - b.changed_at);
    const statusHistory = rawHistory.map((h: any) => ({
      status: h.new_status as string,
      changedAt: h.changed_at as number,
    }));

    const lateMonitorDoc = await getCustomerLateMonitorByBookingId(ctx, booking._id);
    const lateMonitor = lateMonitorDoc
      ? {
          pushEnqueuedAtMs: lateMonitorDoc.push_enqueued_at_ms ?? null,
          smsEnqueuedAtMs: lateMonitorDoc.sms_enqueued_at_ms ?? null,
          frontdeskEnqueuedAtMs: lateMonitorDoc.frontdesk_enqueued_at_ms ?? null,
          customerAcknowledgedAtMs: lateMonitorDoc.customer_acknowledged_at_ms ?? null,
        }
      : null;

    return {
      id: booking._id,
      status: booking.status,
      scheduledDate: booking.scheduled_date,
      scheduledTime: booking.scheduled_time,
      previousScheduledDate: booking.previous_scheduled_date ?? null,
      previousScheduledTime: booking.previous_scheduled_time ?? null,
      previousStatus: booking.previous_status ?? null,
      rescheduleProposedAt: booking.reschedule_proposed_at ?? null,
      scheduleChangeMode: booking.schedule_change_mode ?? null,
      customerCanRestoreOriginal: booking.customer_can_restore_original ?? null,
      shopId: booking.shop_id ?? null,
      shopName: (shop as any)?.name ?? null,
      mechanicId: booking.mechanic_id ?? null,
      mechanicName: formatMechanic(currentMechanic),
      previousMechanicId: booking.previous_mechanic_id ?? null,
      previousMechanicName: formatMechanic(previousMechanic),
      serviceNames,
      vehicleDisplay,
      totalCost: booking.total_cost,
      statusHistory,
      lateMonitor,
    };
  },
});
