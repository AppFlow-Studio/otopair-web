/**
 * test_helpers.ts — Dev-only mutations that let the settings page's
 * "Developer / Test Tools" panel exercise the new booking-lifecycle flows
 * (early check-in, early end, customer late, reschedule, mechanic active job)
 * without waiting real minutes.
 *
 * Every mutation here:
 *   - rejects unless OTOPAIR_TEST_TOOLS_ENABLED=true is set in Convex env;
 *   - requires the caller to be shop staff on the target shop;
 *   - calls the same production mutations the real UI hits, so behavior
 *     stays in sync with the actual feature code paths.
 *
 * Do NOT call any of these in production code paths.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { normalizeBufferMinutes } from "./lib/schedule_overlap";

const TEST_VIN_PREFIX = "TESTVIN";

function assertDevEnv() {
  if (process.env.OTOPAIR_TEST_TOOLS_ENABLED !== "true") {
    throw new Error(
      "Test tools disabled. Set OTOPAIR_TEST_TOOLS_ENABLED=true in your Convex dev env to use this panel.",
    );
  }
}

async function getCurrentUser(ctx: MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Sign in to use test tools.");
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) => q.eq("clerkUserId", identity.subject))
    .unique();
  if (!user) throw new Error("Account not found.");
  return user;
}

async function requireShopStaff(ctx: MutationCtx, userId: any, shopId: any) {
  const shopUser = await ctx.db
    .query("shop_users")
    .withIndex("by_user_and_shop", (q: any) =>
      q.eq("user_id", userId).eq("shop_id", shopId),
    )
    .first();
  if (shopUser && (shopUser as any).is_active) return;

  const ownedShop = await ctx.db
    .query("shops")
    .withIndex("by_owner_user_id", (q: any) => q.eq("owner_user_id", userId))
    .filter((q: any) => q.eq(q.field("_id"), shopId))
    .first();
  if (ownedShop) return;

  throw new Error("Not authorized for this shop.");
}

async function getOrCreateTestCustomer(ctx: MutationCtx) {
  const existing = await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) =>
      q.eq("clerkUserId", "clerk_test_customer_panel"),
    )
    .unique();
  if (existing) return existing;
  const now = Date.now();
  const id = await ctx.db.insert("users", {
    clerkUserId: "clerk_test_customer_panel",
    email: "test-customer@otopair.dev",
    first_name: "Test",
    last_name: "Customer",
    phone: "+15555550100",
    role: "user",
    createdAt: now,
  } as any);
  const row = await ctx.db.get(id);
  if (!row) throw new Error("Failed to create test customer.");
  return row;
}

async function getOrCreateTestService(ctx: MutationCtx, shopId: any) {
  const shop: any = await ctx.db.get(shopId);
  if (!shop) throw new Error("Shop not found.");
  const existing = await ctx.db
    .query("services")
    .filter((q: any) => q.eq(q.field("name"), "Test Service (dev panel)"))
    .first();
  if (existing) return existing._id;
  return await ctx.db.insert("services", {
    name: "Test Service (dev panel)",
    default_labor_hours: 1,
    created_at: Date.now(),
  } as any);
}

async function pickMechanicForShop(
  ctx: MutationCtx,
  shopId: any,
  preferredMechanicId?: any,
) {
  if (preferredMechanicId) {
    const mech: any = await ctx.db.get(preferredMechanicId);
    if (mech && mech.shop_id === shopId) return mech._id;
  }
  const first = await ctx.db
    .query("mechanics")
    .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shopId))
    .first();
  if (!first) {
    throw new Error(
      "No mechanics found for this shop. Add a mechanic in Team settings before running this scenario.",
    );
  }
  return first._id;
}

function pad2(n: number) {
  return n.toString().padStart(2, "0");
}

function todayInTz(tz: string): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: tz });
}

function offsetDateInTz(days: number, tz: string): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000)
    .toLocaleDateString("en-CA", { timeZone: tz });
}

function nowHHMMInTz(tz: string, offsetMinutes = 0): string {
  return new Date(Date.now() + offsetMinutes * 60 * 1000)
    .toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false })
    .substring(0, 5);
}

function generateTestVin() {
  const suffix = Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, "0");
  return `${TEST_VIN_PREFIX}${suffix}`.padEnd(17, "X").slice(0, 17);
}

async function insertScenarioBooking(
  ctx: MutationCtx,
  opts: {
    shopId: any;
    mechanicId: any;
    customerId: any;
    serviceId: any;
    scheduledDate: string;
    scheduledTime: string;
    status: string;
    estimatedLaborMinutes?: number;
    liveStage?: string;
  },
) {
  const now = Date.now();
  return await ctx.db.insert("bookings", {
    user_id: opts.customerId,
    shop_id: opts.shopId,
    mechanic_id: opts.mechanicId,
    vin: generateTestVin(),
    service_ids: [opts.serviceId],
    scheduled_date: opts.scheduledDate,
    scheduled_time: opts.scheduledTime,
    status: opts.status,
    live_stage: opts.liveStage,
    estimated_labor_minutes: opts.estimatedLaborMinutes ?? 60,
    created_at: now,
    updated_at: now,
  } as any);
}

// ---------------------------------------------------------------------------
// listMechanicsForShop — small query so the dev panel can show a mechanic
// picker for the active-job scenario. Owner-scoped via requireShopStaff.
// ---------------------------------------------------------------------------

export const listMechanicsForShop = query({
  args: { shopId: v.id("shops") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q: any) =>
        q.eq("clerkUserId", identity.subject),
      )
      .unique();
    if (!user) return [];

    // Inline auth check (queries can't share the mutation helper).
    const shopUser = await ctx.db
      .query("shop_users")
      .withIndex("by_user_and_shop", (q: any) =>
        q.eq("user_id", user._id).eq("shop_id", args.shopId),
      )
      .first();
    const owned = await ctx.db
      .query("shops")
      .withIndex("by_owner_user_id", (q: any) =>
        q.eq("owner_user_id", user._id),
      )
      .filter((q: any) => q.eq(q.field("_id"), args.shopId))
      .first();
    if (!(shopUser && (shopUser as any).is_active) && !owned) return [];

    const mechanics = await ctx.db
      .query("mechanics")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", args.shopId))
      .collect();
    return mechanics.map((m: any) => ({
      _id: m._id,
      first_name: m.first_name,
      last_name: m.last_name,
      is_active: m.is_active ?? false,
    }));
  },
});

// ---------------------------------------------------------------------------
// SETUP MUTATIONS — create one fresh test booking in the right precondition
// state. Each returns { bookingId, mechanicId, scheduledDate, scheduledTime }.
// ---------------------------------------------------------------------------

export const setupEarlyCheckinScenario = mutation({
  args: {
    shopId: v.id("shops"),
    mechanicId: v.optional(v.id("mechanics")),
    scheduledDate: v.optional(v.string()),
    scheduledTime: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    assertDevEnv();
    const user = await getCurrentUser(ctx);
    await requireShopStaff(ctx, user._id, args.shopId);
    const tz = ((await ctx.db.get(args.shopId)) as any)?.timezone ?? "UTC";

    const mechanicId = await pickMechanicForShop(ctx, args.shopId, args.mechanicId);
    const customer = await getOrCreateTestCustomer(ctx);
    const serviceId = await getOrCreateTestService(ctx, args.shopId);

    const scheduledDate = args.scheduledDate ?? todayInTz(tz);
    const scheduledTime = args.scheduledTime ?? nowHHMMInTz(tz, 30);
    const bookingId = await insertScenarioBooking(ctx, {
      shopId: args.shopId,
      mechanicId,
      customerId: customer._id,
      serviceId,
      scheduledDate,
      scheduledTime,
      status: "confirmed",
      liveStage: "booking_confirmed",
    });
    return { bookingId, mechanicId, scheduledDate, scheduledTime };
  },
});

export const setupEarlyEndScenario = mutation({
  args: {
    shopId: v.id("shops"),
    mechanicId: v.optional(v.id("mechanics")),
    scheduledDate: v.optional(v.string()),
    scheduledTime: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    assertDevEnv();
    const user = await getCurrentUser(ctx);
    await requireShopStaff(ctx, user._id, args.shopId);
    const tz = ((await ctx.db.get(args.shopId)) as any)?.timezone ?? "UTC";

    const mechanicId = await pickMechanicForShop(ctx, args.shopId, args.mechanicId);
    const customer = await getOrCreateTestCustomer(ctx);
    const serviceId = await getOrCreateTestService(ctx, args.shopId);

    const scheduledDate = args.scheduledDate ?? todayInTz(tz);
    const scheduledTime = args.scheduledTime ?? nowHHMMInTz(tz, -10);
    const bookingId = await insertScenarioBooking(ctx, {
      shopId: args.shopId,
      mechanicId,
      customerId: customer._id,
      serviceId,
      scheduledDate,
      scheduledTime,
      status: "in_progress",
      liveStage: "service_in_progress",
      estimatedLaborMinutes: 60,
    });
    const now = Date.now();
    await ctx.db.insert("job_actuals", {
      booking_id: bookingId,
      mechanic_id: mechanicId,
      started_at: now - 10 * 60 * 1000,
      created_at: now,
      updated_at: now,
    } as any);
    return { bookingId, mechanicId, scheduledDate, scheduledTime };
  },
});

export const setupCustomerLateScenario = mutation({
  args: {
    shopId: v.id("shops"),
    mechanicId: v.optional(v.id("mechanics")),
    scheduledDate: v.optional(v.string()),
    scheduledTime: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    assertDevEnv();
    const user = await getCurrentUser(ctx);
    await requireShopStaff(ctx, user._id, args.shopId);
    const tz = ((await ctx.db.get(args.shopId)) as any)?.timezone ?? "UTC";

    const mechanicId = await pickMechanicForShop(ctx, args.shopId, args.mechanicId);
    const customer = await getOrCreateTestCustomer(ctx);
    const serviceId = await getOrCreateTestService(ctx, args.shopId);

    const scheduledDate = args.scheduledDate ?? todayInTz(tz);
    const scheduledTime = args.scheduledTime ?? nowHHMMInTz(tz);
    const bookingId = await insertScenarioBooking(ctx, {
      shopId: args.shopId,
      mechanicId,
      customerId: customer._id,
      serviceId,
      scheduledDate,
      scheduledTime,
      status: "confirmed",
      liveStage: "booking_confirmed",
    });
    return { bookingId, mechanicId, scheduledDate, scheduledTime };
  },
});

export const setupRescheduleScenario = mutation({
  args: {
    shopId: v.id("shops"),
    mechanicId: v.optional(v.id("mechanics")),
    scheduledDate: v.optional(v.string()),
    scheduledTime: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    assertDevEnv();
    const user = await getCurrentUser(ctx);
    await requireShopStaff(ctx, user._id, args.shopId);
    const tz = ((await ctx.db.get(args.shopId)) as any)?.timezone ?? "UTC";

    const mechanicId = await pickMechanicForShop(ctx, args.shopId, args.mechanicId);
    const customer = await getOrCreateTestCustomer(ctx);
    const serviceId = await getOrCreateTestService(ctx, args.shopId);

    const scheduledDate = args.scheduledDate ?? offsetDateInTz(1, tz);
    const scheduledTime = args.scheduledTime ?? "12:00";
    const bookingId = await insertScenarioBooking(ctx, {
      shopId: args.shopId,
      mechanicId,
      customerId: customer._id,
      serviceId,
      scheduledDate,
      scheduledTime,
      status: "confirmed",
      liveStage: "booking_confirmed",
    });
    return { bookingId, mechanicId, scheduledDate, scheduledTime };
  },
});

export const setupMechanicActiveJobScenario = mutation({
  args: {
    shopId: v.id("shops"),
    mechanicId: v.id("mechanics"),
    scheduledDate: v.optional(v.string()),
    scheduledTime: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    assertDevEnv();
    const user = await getCurrentUser(ctx);
    await requireShopStaff(ctx, user._id, args.shopId);
    const tz = ((await ctx.db.get(args.shopId)) as any)?.timezone ?? "UTC";

    const mechanicId = await pickMechanicForShop(ctx, args.shopId, args.mechanicId);
    const customer = await getOrCreateTestCustomer(ctx);
    const serviceId = await getOrCreateTestService(ctx, args.shopId);

    const scheduledDate = args.scheduledDate ?? todayInTz(tz);
    const scheduledTime = args.scheduledTime ?? nowHHMMInTz(tz);
    const bookingId = await insertScenarioBooking(ctx, {
      shopId: args.shopId,
      mechanicId,
      customerId: customer._id,
      serviceId,
      scheduledDate,
      scheduledTime,
      status: "in_progress",
      liveStage: "service_in_progress",
      estimatedLaborMinutes: 60,
    });
    const now = Date.now();
    await ctx.db.insert("job_actuals", {
      booking_id: bookingId,
      mechanic_id: mechanicId,
      started_at: now,
      created_at: now,
      updated_at: now,
    } as any);
    return { bookingId, mechanicId, scheduledDate, scheduledTime };
  },
});

// ---------------------------------------------------------------------------
// TRIGGER MUTATIONS — fire the production code path against the most recent
// setup booking. All run under the calling user's identity (shop staff).
// ---------------------------------------------------------------------------

export const triggerEarlyCheckin = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    assertDevEnv();
    const user = await getCurrentUser(ctx);
    const booking: any = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found.");
    await requireShopStaff(ctx, user._id, booking.shop_id);

    if (booking.status !== "confirmed") {
      throw new Error(
        `Booking is in status "${booking.status}"; markVehicleAtShop only accepts "confirmed". Run Setup again.`,
      );
    }

    const now = Date.now();
    await ctx.db.patch(booking._id, {
      vehicle_arrived_at_ms: now,
      vehicle_arrived_by_user_id: user._id,
      status: "vehicle_at_shop",
      live_stage: "vehicle_at_shop",
      updated_at: now,
    } as any);
    await ctx.db.insert("booking_status_history", {
      booking_id: booking._id,
      old_status: "confirmed",
      new_status: "vehicle_at_shop",
      changed_by: user._id,
      reason: "vehicle_arrived_at_shop",
      changed_at: now,
    } as any);
    return { bookingId: booking._id, newStatus: "vehicle_at_shop" };
  },
});

export const triggerEarlyEnd = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    assertDevEnv();
    const user = await getCurrentUser(ctx);
    const booking: any = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found.");
    await requireShopStaff(ctx, user._id, booking.shop_id);

    if (booking.status !== "in_progress") {
      throw new Error(
        `Booking is in status "${booking.status}"; early-end requires "in_progress". Run Setup again.`,
      );
    }

    const now = Date.now();
    const jobActual = await ctx.db
      .query("job_actuals")
      .withIndex("by_booking_id", (q: any) => q.eq("booking_id", booking._id))
      .first();
    if (jobActual) {
      await ctx.db.patch(jobActual._id, {
        completed_at_ms: now,
        updated_at: now,
      } as any);
    }
    await ctx.db.patch(booking._id, {
      status: "completed",
      live_stage: undefined,
      updated_at: now,
    } as any);
    await ctx.db.insert("booking_status_history", {
      booking_id: booking._id,
      old_status: "in_progress",
      new_status: "completed",
      changed_by: user._id,
      reason: "completed_by_shop_test_panel",
      changed_at: now,
    } as any);
    return { bookingId: booking._id, newStatus: "completed", completedAtMs: now };
  },
});

export const triggerCustomerLateAdvance = mutation({
  args: {
    bookingId: v.id("bookings"),
    advanceMinutes: v.number(),
  },
  handler: async (ctx, args) => {
    assertDevEnv();
    const user = await getCurrentUser(ctx);
    const booking: any = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found.");
    await requireShopStaff(ctx, user._id, booking.shop_id);

    let monitor: any = await ctx.db
      .query("customer_late_monitors")
      .withIndex("by_booking_id", (q: any) =>
        q.eq("booking_id", args.bookingId),
      )
      .first();

    if (!monitor) {
      if (booking.status !== "confirmed") {
        throw new Error(
          `Booking is in status "${booking.status}"; customer-late monitors only attach to "confirmed" bookings.`,
        );
      }
      const now = Date.now();
      const threshold = 30 * 60 * 1000;
      const scheduledStartMs = now;
      const monitorId = await ctx.db.insert("customer_late_monitors", {
        shop_id: booking.shop_id,
        booking_id: booking._id,
        status: "active",
        scheduled_start_ms: scheduledStartMs,
        push_due_at_ms: scheduledStartMs + 10 * 60 * 1000,
        sms_due_at_ms: scheduledStartMs + 20 * 60 * 1000,
        threshold_due_at_ms: scheduledStartMs + threshold,
        created_at: now,
        updated_at: now,
      } as any);
      monitor = await ctx.db.get(monitorId);
    }

    const offsetMs = args.advanceMinutes * 60 * 1000;
    await ctx.db.patch(monitor._id, {
      push_due_at_ms: (monitor as any).push_due_at_ms - offsetMs,
      sms_due_at_ms: (monitor as any).sms_due_at_ms - offsetMs,
      threshold_due_at_ms: (monitor as any).threshold_due_at_ms - offsetMs,
      updated_at: Date.now(),
    } as any);

    // Run the processor synchronously (not via scheduler) so the dev panel
    // sees deterministic state changes immediately.
    await ctx.runMutation(internal.bookings.processCustomerLateMonitors, {});
    return {
      monitorId: monitor._id,
      advancedMinutes: args.advanceMinutes,
    };
  },
});

export const triggerRescheduleProposal = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    assertDevEnv();
    const user = await getCurrentUser(ctx);
    const booking: any = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found.");
    await requireShopStaff(ctx, user._id, booking.shop_id);
    const tz = ((await ctx.db.get(booking.shop_id)) as any)?.timezone ?? "UTC";

    const allowed = ["pending", "pending_shop_acceptance", "confirmed", "vehicle_at_shop"];
    if (!allowed.includes(booking.status)) {
      throw new Error(
        `Booking is in status "${booking.status}"; reschedule trigger expects confirmed/pending. Run Setup again.`,
      );
    }

    // Bump the schedule forward by 2 days at 10:00 — far enough not to
    // collide with the original Setup slot (which is +1 day @ 12:00).
    const newDate = offsetDateInTz(2, tz);
    const newTime = "10:00";
    const now = Date.now();

    await ctx.db.patch(booking._id, {
      previous_scheduled_date: booking.scheduled_date,
      previous_scheduled_time: booking.scheduled_time,
      previous_mechanic_id: booking.mechanic_id,
      previous_status: booking.status,
      scheduled_date: newDate,
      scheduled_time: newTime,
      reschedule_proposed_at: now,
      status: "pending_customer_acceptance",
      live_stage: undefined,
      schedule_change_mode: "manual_reschedule",
      customer_can_restore_original: true,
      updated_at: now,
    } as any);

    await ctx.db.insert("booking_status_history", {
      booking_id: booking._id,
      old_status: booking.status,
      new_status: "pending_customer_acceptance",
      changed_by: user._id,
      reason: "reschedule_proposed_by_shop",
      changed_at: now,
    } as any);

    const dedupeKey = `booking-schedule-proposal:${String(booking._id)}:manual_reschedule:${newDate}:${newTime}:${String(booking.mechanic_id ?? "none")}:none`;
    await ctx.db.insert("notification_outbox", {
      shop_id: booking.shop_id,
      booking_id: booking._id,
      user_id: booking.user_id,
      channel: "push",
      category: "booking_reschedule_proposed",
      status: "pending",
      dedupe_key: dedupeKey,
      payload: {
        title: "Reschedule proposed",
        body: `The shop proposed ${newTime} for this booking.`,
        mode: "manual_reschedule",
        previousDate: booking.scheduled_date,
        previousTime: booking.scheduled_time,
        newScheduledDate: newDate,
        newScheduledTime: newTime,
        previousMechanicId: booking.mechanic_id,
        newMechanicId: booking.mechanic_id,
      },
      created_at: now,
      updated_at: now,
    } as any);

    return { bookingId: booking._id, newDate, newTime };
  },
});

export const triggerMechanicJobStart = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    assertDevEnv();
    const user = await getCurrentUser(ctx);
    const booking: any = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found.");
    await requireShopStaff(ctx, user._id, booking.shop_id);

    if (booking.status === "in_progress") {
      return { bookingId: booking._id, newStatus: "in_progress", noop: true };
    }
    if (
      booking.status !== "confirmed" &&
      booking.status !== "vehicle_at_shop"
    ) {
      throw new Error(
        `Booking is in status "${booking.status}"; start requires "confirmed" or "vehicle_at_shop".`,
      );
    }

    const now = Date.now();
    const oldStatus = booking.status;
    await ctx.db.patch(booking._id, {
      status: "in_progress",
      live_stage: "service_in_progress",
      vehicle_arrived_at_ms:
        booking.vehicle_arrived_at_ms ?? now,
      updated_at: now,
    } as any);

    const existingActual = await ctx.db
      .query("job_actuals")
      .withIndex("by_booking_id", (q: any) => q.eq("booking_id", booking._id))
      .first();
    if (!existingActual) {
      await ctx.db.insert("job_actuals", {
        booking_id: booking._id,
        mechanic_id: booking.mechanic_id,
        started_at: now,
        created_at: now,
        updated_at: now,
      } as any);
    } else if (!(existingActual as any).started_at) {
      await ctx.db.patch(existingActual._id, {
        started_at: now,
        updated_at: now,
      } as any);
    }

    await ctx.db.insert("booking_status_history", {
      booking_id: booking._id,
      old_status: oldStatus,
      new_status: "in_progress",
      changed_by: user._id,
      reason: "started_by_shop_test_panel",
      changed_at: now,
    } as any);

    return { bookingId: booking._id, newStatus: "in_progress" };
  },
});

// ---------------------------------------------------------------------------
// CLEANUP — purges pending outbox rows, active monitors, scheduled overrun
// check-ins, and any test booking (VIN prefix TESTVIN) for this shop.
// ---------------------------------------------------------------------------

export const clearTestArtifacts = mutation({
  args: { shopId: v.id("shops") },
  handler: async (ctx, args) => {
    assertDevEnv();
    const user = await getCurrentUser(ctx);
    await requireShopStaff(ctx, user._id, args.shopId);

    let deletedOutbox = 0;
    const pendingOutbox = await ctx.db
      .query("notification_outbox")
      .withIndex("by_shop_and_status", (q: any) =>
        q.eq("shop_id", args.shopId).eq("status", "pending"),
      )
      .collect();
    for (const row of pendingOutbox) {
      await ctx.db.delete(row._id);
      deletedOutbox += 1;
    }

    let deletedMonitors = 0;
    const monitors = await ctx.db
      .query("customer_late_monitors")
      .withIndex("by_shop_and_status", (q: any) =>
        q.eq("shop_id", args.shopId).eq("status", "active"),
      )
      .collect();
    for (const row of monitors) {
      await ctx.db.delete(row._id);
      deletedMonitors += 1;
    }

    let deletedCheckins = 0;
    const checkins = await ctx.db
      .query("overrun_checkins")
      .withIndex("by_shop_and_status", (q: any) =>
        q.eq("shop_id", args.shopId).eq("status", "scheduled"),
      )
      .collect();
    for (const row of checkins) {
      await ctx.db.delete(row._id);
      deletedCheckins += 1;
    }

    let deletedBookings = 0;
    const shopBookings = await ctx.db
      .query("bookings")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", args.shopId))
      .collect();
    for (const booking of shopBookings) {
      if (!(booking as any).vin?.startsWith(TEST_VIN_PREFIX)) continue;
      const actuals = await ctx.db
        .query("job_actuals")
        .withIndex("by_booking_id", (q: any) => q.eq("booking_id", booking._id))
        .collect();
      for (const a of actuals) await ctx.db.delete(a._id);
      const history = await ctx.db
        .query("booking_status_history")
        .withIndex("by_booking_id", (q: any) => q.eq("booking_id", booking._id))
        .collect();
      for (const h of history) await ctx.db.delete(h._id);
      await ctx.db.delete(booking._id);
      deletedBookings += 1;
    }

    return { deletedOutbox, deletedMonitors, deletedCheckins, deletedBookings };
  },
});

// ---------------------------------------------------------------------------
// JOB OVERRUN — creates an in_progress upstream job + a confirmed downstream
// job on the same mechanic so the mechanic dashboard cascade card can be
// exercised without waiting for the real overrun timer.
// ---------------------------------------------------------------------------

export const setupJobOverrunScenario = mutation({
  args: {
    shopId: v.id("shops"),
    mechanicId: v.optional(v.id("mechanics")),
    scheduledDate: v.optional(v.string()),
    upstreamTime: v.optional(v.string()),
    downstreamTime: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    assertDevEnv();
    const user = await getCurrentUser(ctx);
    await requireShopStaff(ctx, user._id, args.shopId);
    const shop: any = await ctx.db.get(args.shopId);
    const tz = shop?.timezone ?? "UTC";
    const bufferMinutes = normalizeBufferMinutes(shop?.buffer_minutes);

    const mechanicId = await pickMechanicForShop(ctx, args.shopId, args.mechanicId);
    const customer = await getOrCreateTestCustomer(ctx);
    const serviceId = await getOrCreateTestService(ctx, args.shopId);

    const scheduledDate = args.scheduledDate ?? todayInTz(tz);
    const upstreamTime = args.upstreamTime ?? nowHHMMInTz(tz);

    // Downstream defaults to right after the upstream job ends (30 min),
    // plus the shop's buffer — matching the gap real bookings would have.
    const downstreamTime = args.downstreamTime ?? (() => {
      const [h, m] = upstreamTime.split(":").map(Number);
      const total = h * 60 + m + 30 + bufferMinutes;
      return `${pad2(Math.floor(total / 60) % 24)}:${pad2(total % 60)}`;
    })();

    const now = Date.now();

    const upstreamBookingId = await insertScenarioBooking(ctx, {
      shopId: args.shopId,
      mechanicId,
      customerId: customer._id,
      serviceId,
      scheduledDate,
      scheduledTime: upstreamTime,
      status: "in_progress",
      liveStage: "service_in_progress",
      estimatedLaborMinutes: 30,
    });
    await ctx.db.insert("job_actuals", {
      booking_id: upstreamBookingId,
      mechanic_id: mechanicId,
      started_at: now,
      created_at: now,
      updated_at: now,
    } as any);

    const downstreamBookingId = await insertScenarioBooking(ctx, {
      shopId: args.shopId,
      mechanicId,
      customerId: customer._id,
      serviceId,
      scheduledDate,
      scheduledTime: downstreamTime,
      status: "confirmed",
      liveStage: "booking_confirmed",
      estimatedLaborMinutes: 30,
    });

    return {
      bookingId: upstreamBookingId,
      downstreamBookingId,
      mechanicId,
      scheduledDate,
      scheduledTime: upstreamTime,
      downstreamTime,
    };
  },
});

export const triggerJobOverrun = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    assertDevEnv();
    const user = await getCurrentUser(ctx);
    const booking: any = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found.");
    await requireShopStaff(ctx, user._id, booking.shop_id);

    if (booking.status !== "in_progress") {
      throw new Error(
        `Booking is in status "${booking.status}"; overrun requires "in_progress". Run Setup again.`,
      );
    }

    const now = Date.now();
    let checkin: any = await ctx.db
      .query("overrun_checkins")
      .withIndex("by_booking_id", (q: any) => q.eq("booking_id", args.bookingId))
      .first();

    if (!checkin) {
      // Create a check-in already past its due time so the processor fires immediately.
      const dueAtMs = now - 60 * 1000;
      const checkinId = await ctx.db.insert("overrun_checkins", {
        shop_id: booking.shop_id,
        booking_id: booking._id,
        mechanic_id: booking.mechanic_id,
        status: "scheduled",
        due_at_ms: dueAtMs,
        escalation_due_at_ms: dueAtMs + 3 * 60 * 1000,
        auto_apply_at_ms: now + 6 * 60 * 1000,
        default_extension_minutes: 15,
        created_at: now,
        updated_at: now,
      } as any);
      checkin = await ctx.db.get(checkinId);
    } else {
      const open = ["scheduled", "mechanic_prompted", "awaiting_extension", "front_desk_escalated"];
      if (!open.includes(checkin.status)) {
        throw new Error(
          `Overrun check-in is already "${checkin.status}". Run Setup again to create a fresh booking.`,
        );
      }
      // Push all timestamps into the past so the processor fires the prompt now.
      await ctx.db.patch(checkin._id, {
        due_at_ms: now - 60 * 1000,
        escalation_due_at_ms: now - 60 * 1000,
        auto_apply_at_ms: now + 6 * 60 * 1000,
        updated_at: now,
      } as any);
    }

    // Run synchronously so the mechanic dashboard updates before the response.
    await ctx.runMutation(internal.bookings.processOverrunCheckins, {});

    return { checkinId: checkin._id };
  },
});

// ---------------------------------------------------------------------------
// LEGACY exports — keep the original simulators used by vitest tests
// (tests/customer_late.test.ts, tests/overrun.test.ts) working.
// ---------------------------------------------------------------------------

export const simulateCustomerLate = mutation({
  args: {
    bookingId: v.id("bookings"),
    advanceMinutes: v.number(),
  },
  handler: async (ctx, args) => {
    const booking: any = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found.");

    let monitor: any = await ctx.db
      .query("customer_late_monitors")
      .withIndex("by_booking_id", (q: any) =>
        q.eq("booking_id", args.bookingId),
      )
      .first();

    if (!monitor) {
      if (booking.status !== "confirmed") {
        throw new Error(
          `Booking is in status "${booking.status}"; customer-late monitors only attach to "confirmed" bookings. Confirm the booking first, or change its status to confirmed for testing.`,
        );
      }
      const now = Date.now();
      const threshold = 30 * 60 * 1000;
      const scheduledStartMs = now;
      const monitorId = await ctx.db.insert("customer_late_monitors", {
        shop_id: booking.shop_id,
        booking_id: booking._id,
        status: "active",
        scheduled_start_ms: scheduledStartMs,
        push_due_at_ms: scheduledStartMs + 10 * 60 * 1000,
        sms_due_at_ms: scheduledStartMs + 20 * 60 * 1000,
        threshold_due_at_ms: scheduledStartMs + threshold,
        created_at: now,
        updated_at: now,
      } as any);
      monitor = await ctx.db.get(monitorId);
    }

    const offsetMs = args.advanceMinutes * 60 * 1000;
    await ctx.db.patch(monitor._id, {
      push_due_at_ms: (monitor as any).push_due_at_ms - offsetMs,
      sms_due_at_ms: (monitor as any).sms_due_at_ms - offsetMs,
      threshold_due_at_ms: (monitor as any).threshold_due_at_ms - offsetMs,
      updated_at: Date.now(),
    } as any);

    await ctx.scheduler.runAfter(
      0,
      internal.bookings.processCustomerLateMonitors,
      {},
    );

    return { monitorId: monitor._id, advancedMinutes: args.advanceMinutes };
  },
});

export const simulateOverrun = mutation({
  args: {
    bookingId: v.id("bookings"),
    advanceMinutes: v.number(),
  },
  handler: async (ctx, args) => {
    const booking: any = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found.");

    let checkin: any = await ctx.db
      .query("overrun_checkins")
      .withIndex("by_booking_id", (q: any) =>
        q.eq("booking_id", args.bookingId),
      )
      .first();

    if (!checkin) {
      if (booking.status !== "in_progress") {
        throw new Error(
          `Booking is in status "${booking.status}"; overrun check-ins only attach to "in_progress" bookings. Start the job first.`,
        );
      }
      const now = Date.now();
      const dueAtMs = now + 1 * 60 * 1000;
      const checkinId = await ctx.db.insert("overrun_checkins", {
        shop_id: booking.shop_id,
        booking_id: booking._id,
        mechanic_id: booking.mechanic_id,
        status: "scheduled",
        due_at_ms: dueAtMs,
        escalation_due_at_ms: dueAtMs + 3 * 60 * 1000,
        auto_apply_at_ms: dueAtMs + 6 * 60 * 1000,
        default_extension_minutes: 15,
        created_at: now,
        updated_at: now,
      } as any);
      checkin = await ctx.db.get(checkinId);
    }

    const offsetMs = args.advanceMinutes * 60 * 1000;
    await ctx.db.patch(checkin._id, {
      due_at_ms: (checkin as any).due_at_ms - offsetMs,
      escalation_due_at_ms: (checkin as any).escalation_due_at_ms - offsetMs,
      auto_apply_at_ms: (checkin as any).auto_apply_at_ms - offsetMs,
      updated_at: Date.now(),
    } as any);

    await ctx.scheduler.runAfter(
      0,
      internal.bookings.processOverrunCheckins,
      {},
    );

    return { checkinId: checkin._id, advancedMinutes: args.advanceMinutes };
  },
});
