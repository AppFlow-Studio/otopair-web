import { mutation } from "./_generated/server";
import { v } from "convex/values";

/** Clamp minutes-since-midnight to 0–1439 and format as "HH:MM". */
function minutesToTime(minutes: number): string {
  const c = Math.max(0, Math.min(1439, Math.round(minutes)));
  const h = Math.floor(c / 60);
  const m = c % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Add minutes to "HH:MM" and return "HH:MM" (clamped to same day). */
function addMinutesToTime(hhmm: string, deltaMinutes: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const total = h * 60 + m + deltaMinutes;
  return minutesToTime(total);
}

/**
 * Seeds the bookings table with realistic dashboard demo data for a given shop.
 * All times are derived from the current UTC time when the seed runs, so you get
 * completed bookings from earlier today, in-progress jobs, and confirmed bookings
 * later today regardless of when you run it.
 *
 * Usage:
 *   npx convex run seed:seedDashboardBookings '{"shopId":"<shops_id>"}'
 *   npx convex run seed:seedDashboardBookings '{"shopId":"<shops_id>","clearExisting":true}'
 *
 * Produces (relative to current time):
 *   - 2 completed bookings (earlier today)
 *   - 3 confirmed bookings scheduled later today
 *   - 4 pending bookings (status: "pending") — awaiting shop acceptance
 *
 * Prerequisites: the shop must already exist. Mechanics are re-used from the shop
 * if any exist; otherwise a placeholder mechanic is created. Demo users, vehicles,
 * time slots, and services are created as needed and cleaned up on clear.
 */
export const seedDashboardBookings = mutation({
  args: {
    shopId: v.id("shops"),
    clearExisting: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const shop = await ctx.db.get(args.shopId);
    if (!shop) throw new Error(`Shop ${args.shopId} not found.`);

    const now = Date.now();
    const today = new Date(now).toISOString().split("T")[0]; // "YYYY-MM-DD"

    // ── Optional clear ────────────────────────────────────────────────────────
    if (args.clearExisting ?? false) {
      const existing = await ctx.db
        .query("bookings")
        .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
        .collect();
      for (const b of existing) {
        // Clean up the time slot we created for it
        const slot = await ctx.db.get(b.time_slot_id);
        if (slot && slot.date === today) {
          await ctx.db.delete(b.time_slot_id);
        }
        await ctx.db.delete(b._id);
      }
      // Clear all manually-blocked time slots for this shop
      const blockedSlots = await ctx.db
        .query("time_slots")
        .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
        .collect();
      for (const s of blockedSlots) {
        await ctx.db.delete(s._id);
      }
      // Clear custom block time types
      const blockTimeTypes = await ctx.db
        .query("block_time_types")
        .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
        .collect();
      for (const t of blockTimeTypes) {
        await ctx.db.delete(t._id);
      }
      // Clean up demo users and vehicles created by a previous seed run
      const seedUsers = await ctx.db
        .query("users")
        .collect();
      for (const u of seedUsers) {
        if (u.clerkUserId.startsWith("seed-dashboard-")) {
          // Remove vehicle owners
          const owners = await ctx.db
            .query("vehicle_owners")
            .withIndex("by_user_id", (q) => q.eq("user_id", u._id))
            .collect();
          for (const o of owners) await ctx.db.delete(o._id);
          await ctx.db.delete(u._id);
        }
      }
      // Clean up demo mechanics created by a previous seed run
      const DEMO_MECHANIC_NAMES = [
        { first: "Mike", last: "Turner" },
        { first: "Sarah", last: "Jenkins" },
      ];
      const allMechanics = await ctx.db
        .query("mechanics")
        .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
        .collect();
      for (const m of allMechanics) {
        if (DEMO_MECHANIC_NAMES.some((n) => n.first === m.first_name && n.last === m.last_name)) {
          await ctx.db.delete(m._id);
        }
      }
    }

    // ── Demo services ─────────────────────────────────────────────────────────
    // Re-use existing services if present, otherwise create lightweight stubs.
    const ensureService = async (
      slug: string,
      name: string,
      categoryName: string,
    ) => {
      const services = await ctx.db.query("services").collect();
      const existing = services.find((s) => s.slug === slug);
      let serviceId: any;

      if (existing) {
        serviceId = existing._id;
      } else {
        let catId: any;
        const cats = await ctx.db.query("service_categories").collect();
        const existingCat = cats.find((c) => c.name === categoryName);
        if (existingCat) {
          catId = existingCat._id;
        } else {
          catId = await ctx.db.insert("service_categories", {
            name: categoryName,
            icon_name: "wrench",
            display_order: 99,
          });
        }
        serviceId = await ctx.db.insert("services", {
          name,
          slug,
          description: name,
          service_category_id: catId,
          default_labor_hours: 1,
          is_labor_only: false,
          has_options: false,
          display_order: 99,
        });
      }

      // Ensure shop_services row exists for this shop
      const existing_ss = await ctx.db
        .query("shop_services")
        .withIndex("by_shop_and_service", (q: any) =>
          q.eq("shop_id", args.shopId).eq("service_id", serviceId)
        )
        .first();
      if (!existing_ss) {
        await ctx.db.insert("shop_services", {
          shop_id: args.shopId,
          service_id: serviceId,
          is_offered: true,
        });
      }

      return serviceId;
    };

    const oilChangeId    = await ensureService("oil-change",        "Oil Change",           "Maintenance");
    const brakePadsId    = await ensureService("brake-pads",        "Brake Pad Replacement","Brakes");
    const tireRotationId = await ensureService("tire-rotation",     "Tire Rotation",        "Maintenance");
    const alignmentId    = await ensureService("wheel-alignment",   "Wheel Alignment",      "Maintenance");
    const acServiceId    = await ensureService("ac-service",        "AC System Service",    "Maintenance");

    // ── Mechanics ─────────────────────────────────────────────────────────────
    // Only use mechanics with an active shop_users record (mirrors the Jobs page dropdown logic).
    // Removing a team member sets is_active=false on shop_users, not on the mechanics record.
    const activeShopUsers = await ctx.db
      .query("shop_users")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
      .filter((q) =>
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
    const activeMechanicIds = new Set(activeShopUsers.map((su) => su.mechanic_id as string));
    const shopMechanics = (await ctx.db
      .query("mechanics")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
      .collect()
    ).filter((m) => activeMechanicIds.has(m._id));

    const mech0 = shopMechanics[0] as (typeof shopMechanics)[0] | undefined;
    const mech1 = (shopMechanics[1] ?? shopMechanics[0]) as (typeof shopMechanics)[0] | undefined;

    // ── Demo users + vehicles ─────────────────────────────────────────────────
    const demoVehicles = [
      { clerkId: "seed-dashboard-user-1", firstName: "James",  lastName: "Sullivan",  vin: "SEED1VIN000001", year: 2018, make: "Ford",   model: "F-150" },
      { clerkId: "seed-dashboard-user-2", firstName: "Maria",  lastName: "Rodriguez", vin: "SEED1VIN000002", year: 2021, make: "Toyota", model: "RAV4" },
      { clerkId: "seed-dashboard-user-3", firstName: "Alex",   lastName: "Lee",       vin: "SEED1VIN000003", year: 2015, make: "Honda",  model: "Civic" },
      { clerkId: "seed-dashboard-user-4", firstName: "Jordan", lastName: "Park",      vin: "SEED1VIN000004", year: 2020, make: "Chevy",  model: "Silverado" },
      { clerkId: "seed-dashboard-user-5", firstName: "Casey",  lastName: "Morgan",    vin: "SEED1VIN000005", year: 2019, make: "Subaru", model: "Outback" },
      { clerkId: "seed-dashboard-user-6", firstName: "Taylor", lastName: "Brooks",    vin: "SEED1VIN000006", year: 2022, make: "Jeep",   model: "Wrangler" },
      { clerkId: "seed-dashboard-user-7", firstName: "Riley",  lastName: "Quinn",     vin: "SEED1VIN000007", year: 2017, make: "BMW",    model: "X5" },
    ];

    // Upsert each demo user + vehicle
    const userIds: any[] = [];
    for (const dv of demoVehicles) {
      const existing = await ctx.db
        .query("users")
        .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", dv.clerkId))
        .first();
      let userId: any;
      if (existing) {
        userId = existing._id;
      } else {
        userId = await ctx.db.insert("users", {
          clerkUserId: dv.clerkId,
          onboardingCompleted: true,
          createdAt: now,
          email: `${dv.firstName.toLowerCase()}.${dv.lastName.toLowerCase()}@demo.otopair.com`,
          first_name: dv.firstName,
          last_name: dv.lastName,
        });
      }
      userIds.push(userId);

      // Ensure vehicle exists in vehicles table
      const vehicleRows = await ctx.db
        .query("vehicles")
        .withIndex("by_vin", (q) => q.eq("vin", dv.vin))
        .collect();
      if (vehicleRows.length === 0) {
        await ctx.db.insert("vehicles", {
          vin: dv.vin,
          year: dv.year,
          created_at: now,
          updated_at: now,
          metadata: { make: dv.make, model: dv.model },
        });
      }
      // Ensure ownership
      const ownerRows = await ctx.db
        .query("vehicle_owners")
        .withIndex("by_vin_user", (q) => q.eq("vin", dv.vin).eq("user_id", userId))
        .collect();
      if (ownerRows.length === 0) {
        await ctx.db.insert("vehicle_owners", {
          vin: dv.vin,
          user_id: userId,
          status: "active",
          is_primary: true,
          added_at: now,
        });
      }
    }

    // ── Helper: create a time slot + booking ──────────────────────────────────
    const createBooking = async ({
      userIdx,
      vinIdx,
      serviceId,
      mechanicId,
      scheduledTime,
      status,
      liveStage,
      laborCost,
      partsCost,
      estimatedMinutes,
      key,
    }: {
      userIdx: number;
      vinIdx: number;
      serviceId: any;
      mechanicId?: any;
      scheduledTime: string;   // "HH:MM"
      status: string;
      liveStage?: string;
      laborCost: number;
      partsCost: number;
      estimatedMinutes?: number;
      key: string;
    }) => {
      const endTime = addMinutesToTime(scheduledTime, estimatedMinutes ?? 60);

      const timeSlotId = await ctx.db.insert("time_slots", {
        shop_id: args.shopId,
        ...(mechanicId !== undefined ? { mechanic_id: mechanicId } : {}),
        date: today,
        start_time: scheduledTime,
        end_time: endTime,
        is_available: false,
      });

      const totalCost = laborCost + partsCost;
      const bookingId = await ctx.db.insert("bookings", {
        user_id: userIds[userIdx],
        vin: demoVehicles[vinIdx].vin,
        shop_id: args.shopId,
        ...(mechanicId !== undefined ? { mechanic_id: mechanicId } : {}),
        service_ids: [serviceId],
        time_slot_id: timeSlotId,
        scheduled_date: today,
        scheduled_time: scheduledTime,
        labor_cost: laborCost,
        parts_cost: partsCost,
        total_cost: totalCost,
        ...(estimatedMinutes !== undefined ? { estimated_labor_minutes: estimatedMinutes } : {}),
        status,
        ...(liveStage ? { live_stage: liveStage } : {}),
        created_at: now,
        updated_at: now,
      });

      await ctx.db.insert("booking_status_history", {
        booking_id: bookingId,
        old_status: "confirmed",
        new_status: status,
        reason: `seed_dashboard_${key}`,
        changed_at: now,
      });

      return bookingId;
    };

    // Fixed booking times — laid out sequentially so no two bookings
    // assigned to the same mechanic ever overlap, regardless of shop size.
    // Sequential chain (n=1 worst case):
    //   08:00+45m=08:45 | 09:00+30m=09:30 | 09:30+90m=11:00 | 11:00+60m=12:00
    //   12:00+45m=12:45 | 13:00+90m=14:30 | 14:30+30m=15:00
    //   15:00+90m=16:30 | 16:30+120m=18:30
    const timeCompleted1 = "08:00";
    const timeCompleted2 = "09:00";
    const timeActive1    = "09:30";
    const timeActive2    = "11:00";
    const timeLater1     = "12:00";
    const timeLater2     = "13:00";
    const timeLater3     = "14:30";
    const timePending1   = "15:00";
    const timePending2   = "16:30";

    // ── Completed earlier today ───────────────────────────────────────────────
    await createBooking({
      userIdx: 0,
      vinIdx: 0,
      serviceId: oilChangeId,
      mechanicId: mech0?._id,
      scheduledTime: timeCompleted1,
      status: "completed",
      laborCost: 47.5,
      partsCost: 45,
      estimatedMinutes: 45,
      key: "completed_1",
    });

    await createBooking({
      userIdx: 1,
      vinIdx: 1,
      serviceId: tireRotationId,
      mechanicId: mech1?._id,
      scheduledTime: timeCompleted2,
      status: "completed",
      laborCost: 30,
      partsCost: 0,
      estimatedMinutes: 30,
      key: "completed_2",
    });

    // ── Pending — awaiting shop acceptance ────────────────────────────────────
    await createBooking({
      userIdx: 3,
      vinIdx: 3,
      serviceId: brakePadsId,
      mechanicId: shopMechanics.length > 0 ? shopMechanics[1 % shopMechanics.length]._id : undefined,
      scheduledTime: timeActive1,
      status: "pending",
      laborCost: 95,
      partsCost: 60,
      estimatedMinutes: 90,
      key: "active_1",
    });

    await createBooking({
      userIdx: 6,
      vinIdx: 6,
      serviceId: alignmentId,
      mechanicId: shopMechanics.length > 0 ? shopMechanics[2 % shopMechanics.length]._id : undefined,
      scheduledTime: timeActive2,
      status: "pending",
      laborCost: 89,
      partsCost: 0,
      estimatedMinutes: 60,
      key: "active_2",
    });

    // ── Today's Confirmed Bookings — later today ──────────────────────────────
    await createBooking({
      userIdx: 0,
      vinIdx: 0,
      serviceId: oilChangeId,
      mechanicId: mech0?._id,
      scheduledTime: timeLater1,
      status: "confirmed",
      laborCost: 47.5,
      partsCost: 45,
      estimatedMinutes: 45,
      key: "today_1",
    });

    await createBooking({
      userIdx: 1,
      vinIdx: 1,
      serviceId: brakePadsId,
      mechanicId: mech1?._id,
      scheduledTime: timeLater2,
      status: "confirmed",
      laborCost: 95,
      partsCost: 70,
      estimatedMinutes: 90,
      key: "today_2",
    });

    await createBooking({
      userIdx: 2,
      vinIdx: 2,
      serviceId: tireRotationId,
      mechanicId: mech0?._id,
      scheduledTime: timeLater3,
      status: "confirmed",
      laborCost: 30,
      partsCost: 0,
      estimatedMinutes: 30,
      key: "today_3",
    });

    // ── Pending Jobs ─────────────────────────────────────────────────────────
    await createBooking({
      userIdx: 4,
      vinIdx: 4,
      serviceId: brakePadsId,
      mechanicId: shopMechanics.length > 0 ? shopMechanics[3 % shopMechanics.length]._id : undefined,
      scheduledTime: timePending1,
      status: "pending",
      laborCost: 95,
      partsCost: 65,
      estimatedMinutes: 90,
      key: "pending_1",
    });

    await createBooking({
      userIdx: 5,
      vinIdx: 5,
      serviceId: acServiceId,
      mechanicId: shopMechanics.length > 0 ? shopMechanics[4 % shopMechanics.length]._id : undefined,
      scheduledTime: timePending2,
      status: "pending",
      laborCost: 95,
      partsCost: 35,
      estimatedMinutes: 120,
      key: "pending_2",
    });

    return {
      success: true,
      shopId: args.shopId,
      date: today,
      created: {
        completed: 2,
        activeJobs: 0,
        todayBookings: 3,
        pendingJobs: 4,
      },
    };
  },
});
