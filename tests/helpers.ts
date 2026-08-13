import { convexTest } from "convex-test";
import schema from "../convex/schema";

// convex-test needs an explicit module map for non-Vite test runners.
// `import.meta.glob` is provided by Vitest's Vite-based runner.
export const modules = import.meta.glob("../convex/**/*.*s");

export function makeT() {
  return convexTest(schema, modules);
}

type TestCtx = ReturnType<typeof convexTest>;

export type SeedResult = {
  ownerId: any;
  ownerClerkId: string;
  customerId: any;
  customerClerkId: string;
  shopId: any;
  mechanicId: any;
  bookingId: any;
};

const SERVICE_DEFAULTS = {
  name: "Test service",
  duration_minutes: 60,
  base_price: 100,
};

/**
 * Seed a confirmed booking with: a shop owned by `owner`, a customer, one
 * service, and a booking already in `confirmed` status. Returns the ids you
 * need plus the Clerk subject strings so callers can `withIdentity`.
 *
 * Options:
 *   - scheduledDate / scheduledTime — override the booking slot
 *   - status — override booking status (e.g. "in_progress" for active-job tests)
 *   - estimatedLaborMinutes — override duration
 */
export async function seedConfirmedBooking(
  t: TestCtx,
  opts: {
    scheduledDate?: string;
    scheduledTime?: string;
    status?: string;
    estimatedLaborMinutes?: number;
    /**
     * When true, seed wide-open shop_hours rows for all 7 days so reschedule /
     * scheduling-validation flows don't trip "shop is closed". Off by default
     * to preserve existing customer_late.test.ts seeds.
     */
    seedWideOpenHours?: boolean;
  } = {},
): Promise<SeedResult> {
  const result = await t.run(async (ctx) => {
    const now = Date.now();

    const ownerClerkId = `clerk_owner_${now}_${Math.random().toString(36).slice(2)}`;
    const customerClerkId = `clerk_customer_${now}_${Math.random().toString(36).slice(2)}`;

    const ownerId = await ctx.db.insert("users", {
      clerkUserId: ownerClerkId,
      email: "owner@test.local",
      first_name: "Owner",
      role: "shop_owner",
      createdAt: now,
    });

    const customerId = await ctx.db.insert("users", {
      clerkUserId: customerClerkId,
      email: "customer@test.local",
      first_name: "Cust",
      phone: "+15555550100",
      role: "user",
      createdAt: now,
    });

    const shopId = await ctx.db.insert("shops", {
      name: "Brooklyn Auto",
      owner_user_id: ownerId,
      is_active: true,
      timezone: "America/New_York",
      no_show_threshold_minutes: 30,
      overrun_default_extension_percent: 25,
      overrun_extension_floor_minutes: 5,
      max_bookings_per_mechanic_rolling_hour: 2,
      entity_label_mode: "mechanic",
    });

    const mechanicId = await ctx.db.insert("mechanics", {
      shop_id: shopId,
      first_name: "Alice",
      last_name: "Mechanic",
      is_active: true,
    });

    const serviceId = await ctx.db.insert("services", {
      name: SERVICE_DEFAULTS.name,
      default_labor_hours: SERVICE_DEFAULTS.duration_minutes / 60,
      created_at: now,
    } as any);

    // VIN field is required on bookings (v.string()).
    const bookingId = await ctx.db.insert("bookings", {
      user_id: customerId,
      shop_id: shopId,
      mechanic_id: mechanicId,
      vin: "1HGCM82633A004352",
      service_ids: [serviceId],
      scheduled_date: opts.scheduledDate ?? "2026-05-17",
      scheduled_time: opts.scheduledTime ?? "14:00",
      status: opts.status ?? "confirmed",
      estimated_labor_minutes: opts.estimatedLaborMinutes ?? 30,
      created_at: now,
      updated_at: now,
    } as any);

    return {
      ownerId,
      ownerClerkId,
      customerId,
      customerClerkId,
      shopId,
      mechanicId,
      bookingId,
    };
  });

  if (opts.seedWideOpenHours) {
    await t.run(async (ctx) => {
      const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      for (let day = 0; day < 7; day++) {
        await ctx.db.insert("shops_hours", {
          shop_id: result.shopId,
          day_of_week: day,
          day_name: dayNames[day],
          open_time: "08:00",
          close_time: "20:00",
          is_closed: false,
        } as any);
      }
    });
  }

  return result;
}

/**
 * Like `seedConfirmedBooking` but the booking is already in `in_progress`
 * with a paired job_actuals row (started_at = now by default). Use for
 * active-job-flow tests where the booking must already be running.
 */
export async function seedInProgressBooking(
  t: TestCtx,
  opts: {
    scheduledDate?: string;
    scheduledTime?: string;
    startedAtMs?: number;
  } = {},
): Promise<SeedResult> {
  const seed = await seedConfirmedBooking(t, {
    scheduledDate: opts.scheduledDate,
    scheduledTime: opts.scheduledTime,
    status: "in_progress",
  });
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("job_actuals", {
      booking_id: seed.bookingId,
      mechanic_id: seed.mechanicId,
      started_at: opts.startedAtMs ?? now,
      created_at: now,
      updated_at: now,
    } as any);
  });
  return seed;
}

/** Convenience: build an identity object accepted by t.withIdentity. */
export function identityFor(clerkSubject: string) {
  return { subject: clerkSubject, tokenIdentifier: clerkSubject };
}

export type OverrunFixture = {
  ownerId: any;
  ownerClerkId: string;
  shopId: any;
  alice: any;
  bob: any;
  upstreamCustomerId: any;
  downstreamCustomerId: any;
  upstreamBookingId: any;
  downstreamBookingId: any;
  scheduledDate: string;
};

const WIDE_OPEN_HOURS = {
  open_time: "08:00",
  close_time: "20:00",
};

const TIGHT_CLOSE_HOURS = {
  open_time: "08:00",
  close_time: "16:30",
};

async function seedShopHours(
  t: TestCtx,
  shopId: any,
  hours: { open_time: string; close_time: string },
) {
  await t.run(async (ctx) => {
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    for (let day = 0; day < 7; day++) {
      await ctx.db.insert("shops_hours", {
        shop_id: shopId,
        day_of_week: day,
        day_name: dayNames[day],
        open_time: hours.open_time,
        close_time: hours.close_time,
        is_closed: false,
      });
    }
  });
}

/**
 * Seed a 2-mechanic shop with an upstream booking already `in_progress` and a
 * downstream booking `confirmed` at the colliding time. Both bookings are on
 * Alice; Bob is free by default so lateral swap can find a slot.
 *
 * Tunables:
 *   - downstreamPreference: "any" (lateral swap allowed) | "specific_mechanic"
 *   - tightClose: shop closes 16:30 so a 16:00 30-min booking can't push to 16:15
 *   - upstreamMinutes / downstreamMinutes: durations
 *   - upstreamTime / downstreamTime: HH:MM start times
 *   - bobBusyAt: optional HH:MM where Bob is busy with a same-day blocker
 */
export async function seedOverrunFixture(
  t: TestCtx,
  opts: {
    downstreamPreference?: "any" | "specific_mechanic";
    upstreamTime?: string;
    downstreamTime?: string;
    upstreamMinutes?: number;
    downstreamMinutes?: number;
    tightClose?: boolean;
    bobBusyAt?: string;
    bobBusyMinutes?: number;
  } = {},
): Promise<OverrunFixture> {
  const date = "2026-05-18"; // a Monday — has shop_hours rows
  const upstreamTime = opts.upstreamTime ?? "15:30";
  const downstreamTime = opts.downstreamTime ?? "15:45";
  const upstreamMinutes = opts.upstreamMinutes ?? 10;
  const downstreamMinutes = opts.downstreamMinutes ?? 30;
  const downstreamPreference = opts.downstreamPreference ?? "any";

  const created = await t.run(async (ctx) => {
    const now = Date.now();
    const ownerClerkId = `clerk_owner_${now}_${Math.random()}`;

    const ownerId = await ctx.db.insert("users", {
      clerkUserId: ownerClerkId,
      email: "owner@test.local",
      first_name: "Owner",
      role: "shop_owner",
      createdAt: now,
    });

    const upstreamCustomerId = await ctx.db.insert("users", {
      clerkUserId: `clerk_cust_up_${now}`,
      email: "up@test.local",
      first_name: "Upstream",
      phone: "+15555550101",
      role: "user",
    });

    const downstreamCustomerId = await ctx.db.insert("users", {
      clerkUserId: `clerk_cust_dn_${now}`,
      email: "dn@test.local",
      first_name: "Downstream",
      phone: "+15555550102",
      role: "user",
    });

    const shopId = await ctx.db.insert("shops", {
      name: "Brooklyn Auto",
      owner_user_id: ownerId,
      is_active: true,
      timezone: "America/New_York",
      no_show_threshold_minutes: 30,
      overrun_default_extension_percent: 25,
      overrun_extension_floor_minutes: 5,
      max_bookings_per_mechanic_rolling_hour: 2,
      entity_label_mode: "mechanic",
    });

    const alice = await ctx.db.insert("mechanics", {
      shop_id: shopId,
      first_name: "Alice",
      last_name: "A",
      is_active: true,
    });
    const bob = await ctx.db.insert("mechanics", {
      shop_id: shopId,
      first_name: "Bob",
      last_name: "B",
      is_active: true,
    });

    const serviceId = await ctx.db.insert("services", {
      name: "Test service",
      default_labor_hours: 0.5,
      created_at: now,
    } as any);

    const upstreamBookingId = await ctx.db.insert("bookings", {
      user_id: upstreamCustomerId,
      shop_id: shopId,
      mechanic_id: alice,
      vin: "1HGCM82633A111111",
      service_ids: [serviceId],
      scheduled_date: date,
      scheduled_time: upstreamTime,
      status: "in_progress",
      live_stage: "service_in_progress",
      estimated_labor_minutes: upstreamMinutes,
      assignment_preference: "specific_mechanic",
      created_at: now,
      updated_at: now,
    } as any);

    // Pre-seed a job_actuals row so applyOverrunExtension's R1.2 patch hits.
    await ctx.db.insert("job_actuals", {
      booking_id: upstreamBookingId,
      mechanic_id: alice,
      started_at: now,
      created_at: now,
      updated_at: now,
    } as any);

    const downstreamBookingId = await ctx.db.insert("bookings", {
      user_id: downstreamCustomerId,
      shop_id: shopId,
      mechanic_id: alice,
      vin: "1HGCM82633A222222",
      service_ids: [serviceId],
      scheduled_date: date,
      scheduled_time: downstreamTime,
      status: "confirmed",
      estimated_labor_minutes: downstreamMinutes,
      assignment_preference: downstreamPreference,
      created_at: now,
      updated_at: now,
    } as any);

    if (opts.bobBusyAt) {
      await ctx.db.insert("bookings", {
        user_id: upstreamCustomerId,
        shop_id: shopId,
        mechanic_id: bob,
        vin: "1HGCM82633A333333",
        service_ids: [serviceId],
        scheduled_date: date,
        scheduled_time: opts.bobBusyAt,
        status: "confirmed",
        estimated_labor_minutes: opts.bobBusyMinutes ?? 30,
        assignment_preference: "specific_mechanic",
        created_at: now,
        updated_at: now,
      } as any);
    }

    return {
      ownerId,
      ownerClerkId,
      shopId,
      alice,
      bob,
      upstreamCustomerId,
      downstreamCustomerId,
      upstreamBookingId,
      downstreamBookingId,
    };
  });

  await seedShopHours(
    t,
    created.shopId,
    opts.tightClose ? TIGHT_CLOSE_HOURS : WIDE_OPEN_HOURS,
  );

  return {
    ...created,
    scheduledDate: date,
  };
}

