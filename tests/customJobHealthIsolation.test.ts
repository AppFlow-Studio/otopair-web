/**
 * CUSTOM JOB INVARIANT (Off-Catalog Work spec, §1).
 *
 *   A custom job is real work, real money, and real data.
 *   It is never evidence about maintenance state.
 *
 * Today this holds by construction rather than by a flag: runCompletionSideEffects
 * iterates `service_ids` and never looks at `custom_services`, and the recommendation
 * penalty short-circuits on any rec without a `recommended_service_id`. That's the
 * right behaviour arrived at incidentally — which means the next person to make
 * either loop "more complete" breaks it silently, and nothing fails.
 *
 * These tests are that failure. They are the reason the two enforcement sites carry
 * CUSTOM JOB INVARIANT comments pointing here.
 */
import { describe, it, expect } from "vitest";
import { makeT } from "./helpers";
import { runCompletionSideEffects } from "../convex/bookings";
import { recomputeRecPenaltyForVehicle } from "../convex/jobRecommendations";

describe("custom_services is storable at all", () => {
  // Regression: the schema validator declared `durationMinutes` while every
  // writer and reader in bookings.ts used `duration_minutes`. Convex strips
  // undefined before validating, so a custom service with no duration stored
  // fine and one WITH a duration threw "Unexpected field `duration_minutes`",
  // failing the entire booking insert. Adding minutes to a walk-in was the
  // thing that broke it, which is why it survived so long.
  it("accepts a custom service that carries a duration", async () => {
    const t = makeT();
    await expect(
      t.run(async (ctx: any) => {
        const userId = await ctx.db.insert("users", {
          clerkUserId: "c_dur",
          email: "dur@test.local",
          role: "customer",
          createdAt: Date.now(),
        });
        return ctx.db.insert("bookings", {
          vin: "VINDUR001",
          user_id: userId,
          service_ids: [],
          custom_services: [{ name: "Roll fenders", duration_minutes: 90 }],
          status: "completed",
        } as any);
      }),
    ).resolves.toBeDefined();
  });

  it("still accepts one without a duration", async () => {
    const t = makeT();
    await expect(
      t.run(async (ctx: any) => {
        const userId = await ctx.db.insert("users", {
          clerkUserId: "c_nodur",
          email: "nodur@test.local",
          role: "customer",
          createdAt: Date.now(),
        });
        return ctx.db.insert("bookings", {
          vin: "VINDUR002",
          user_id: userId,
          service_ids: [],
          custom_services: [{ name: "Roll fenders" }],
          status: "completed",
        } as any);
      }),
    ).resolves.toBeDefined();
  });
});

describe("custom jobs never write a maintenance anchor", () => {
  it("a custom-only completed booking writes no maintenance_records row", async () => {
    const t = makeT();

    const { ownerId, bookingId } = await t.run(async (ctx: any) => {
      const userId = await ctx.db.insert("users", {
        clerkUserId: "c_custom_only",
        email: "customonly@test.local",
        role: "customer",
        createdAt: Date.now(),
      });
      const ownerId = await ctx.db.insert("vehicle_owners", {
        vin: "VINCUSTOM1",
        user_id: userId,
        status: "active",
        preOnboardingComplete: true,
        mileage: 61000,
        knownIssues: ["brake_warning"],
      });
      const bookingId = await ctx.db.insert("bookings", {
        vin: "VINCUSTOM1",
        user_id: userId,
        // No canonical services at all — the whole visit was off-catalog.
        service_ids: [],
        custom_services: [
          { name: "Carbon cleaning (walnut blast)", duration_minutes: 180 },
        ],
        status: "completed",
        actual_duration_minutes: 180,
      } as any);
      return { ownerId, bookingId };
    });

    await t.run(async (ctx: any) => {
      const booking = await ctx.db.get(bookingId);
      await runCompletionSideEffects(ctx, booking);
    });

    const { records, owner } = await t.run(async (ctx: any) => {
      const records = await ctx.db.query("maintenance_records").collect();
      const owner = await ctx.db.get(ownerId);
      return { records, owner };
    });

    expect(records).toHaveLength(0);
    // And no warning code was cleared on the strength of unidentifiable work.
    expect((owner as any).knownIssues).toEqual(["brake_warning"]);
  });

  it("a mixed booking anchors the canonical service and ignores the custom one", async () => {
    // The realistic case: an oil change plus something we don't model. The oil
    // change must still credit; the custom line must contribute nothing.
    const t = makeT();

    const { ownerId, bookingId } = await t.run(async (ctx: any) => {
      const userId = await ctx.db.insert("users", {
        clerkUserId: "c_mixed",
        email: "mixed@test.local",
        role: "customer",
        createdAt: Date.now(),
      });
      const ownerId = await ctx.db.insert("vehicle_owners", {
        vin: "VINMIXED1",
        user_id: userId,
        status: "active",
        preOnboardingComplete: true,
        mileage: 72000,
      });
      const serviceId = await ctx.db.insert("services", {
        name: "Oil Change",
        slug: "oil_change",
      });
      const bookingId = await ctx.db.insert("bookings", {
        vin: "VINMIXED1",
        user_id: userId,
        service_ids: [serviceId],
        custom_services: [{ name: "Roll rear fenders", duration_minutes: 90 }],
        status: "completed",
        actual_duration_minutes: 150,
      } as any);
      return { ownerId, bookingId };
    });

    await t.run(async (ctx: any) => {
      const booking = await ctx.db.get(bookingId);
      await runCompletionSideEffects(ctx, booking);
    });

    const records = await t.run(async (ctx: any) =>
      ctx.db.query("maintenance_records").collect(),
    );

    // Exactly one anchor, from the oil change. The custom line adds nothing —
    // if this ever reads 2, the completion loop has been widened.
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe("oil");
    expect(records[0].vehicleOwnerId).toBe(ownerId);
  });
});

describe("advisory recommendations never move the health score", () => {
  it("a freeform rec accrues no penalty, however old or urgent", async () => {
    const t = makeT();

    const ownerId = await t.run(async (ctx: any) => {
      const userId = await ctx.db.insert("users", {
        clerkUserId: "c_advisory",
        email: "advisory@test.local",
        role: "customer",
        createdAt: Date.now(),
      });
      const ownerId = await ctx.db.insert("vehicle_owners", {
        vin: "VINADVIS1",
        user_id: userId,
        status: "active",
        preOnboardingComplete: true,
      });
      const shopId = await ctx.db.insert("shops", { name: "Brooklyn Auto" } as any);
      const mechanicId = await ctx.db.insert("mechanics", {
        shop_id: shopId,
        first_name: "Mike",
        last_name: "R",
      } as any);
      const bookingId = await ctx.db.insert("bookings", {
        vin: "VINADVIS1",
        user_id: userId,
        service_ids: [],
        status: "completed",
      } as any);
      const jobActualId = await ctx.db.insert("job_actuals", {
        booking_id: bookingId,
        mechanic_id: mechanicId,
      } as any);

      // Worst case for the invariant: highest-urgency tier, visible to the
      // driver, and old enough that the 30-day penalty ramp is fully wound up.
      await ctx.db.insert("job_recommendations", {
        booking_id: bookingId,
        job_actual_id: jobActualId,
        shop_id: shopId,
        mechanic_id: mechanicId,
        vehicle_vin: "VINADVIS1",
        freeform_text: "Carbon cleaning (walnut blast)",
        urgency: "next_visit",
        visible_to_driver: true,
        status: "open",
        source: "post_job",
        created_at: Date.now() - 200 * 24 * 60 * 60 * 1000,
      } as any);

      return ownerId;
    });

    await t.run(async (ctx: any) => {
      await recomputeRecPenaltyForVehicle(ctx, {
        vin: "VINADVIS1",
        now: Date.now(),
      });
    });

    const owner = await t.run(async (ctx: any) => ctx.db.get(ownerId));
    expect((owner as any).health_score_rec_penalty).toBe(0);
  });

  it("a canonical rec alongside it still penalises normally", async () => {
    // Proves the zero above comes from the invariant and not from the penalty
    // path being broken outright.
    const t = makeT();

    const ownerId = await t.run(async (ctx: any) => {
      const userId = await ctx.db.insert("users", {
        clerkUserId: "c_both",
        email: "both@test.local",
        role: "customer",
        createdAt: Date.now(),
      });
      const ownerId = await ctx.db.insert("vehicle_owners", {
        vin: "VINBOTH1",
        user_id: userId,
        status: "active",
        preOnboardingComplete: true,
      });
      const shopId = await ctx.db.insert("shops", { name: "Brooklyn Auto" } as any);
      const mechanicId = await ctx.db.insert("mechanics", {
        shop_id: shopId,
        first_name: "Mike",
        last_name: "R",
      } as any);
      const serviceId = await ctx.db.insert("services", {
        name: "Brake Pad Replacement",
        slug: "brake_pad_replacement",
      });
      const bookingId = await ctx.db.insert("bookings", {
        vin: "VINBOTH1",
        user_id: userId,
        service_ids: [],
        status: "completed",
      } as any);
      const jobActualId = await ctx.db.insert("job_actuals", {
        booking_id: bookingId,
        mechanic_id: mechanicId,
      } as any);

      const old = Date.now() - 200 * 24 * 60 * 60 * 1000;
      await ctx.db.insert("job_recommendations", {
        booking_id: bookingId,
        job_actual_id: jobActualId,
        shop_id: shopId,
        mechanic_id: mechanicId,
        vehicle_vin: "VINBOTH1",
        freeform_text: "Ceramic coating",
        urgency: "next_visit",
        visible_to_driver: true,
        status: "open",
        created_at: old,
      } as any);
      await ctx.db.insert("job_recommendations", {
        booking_id: bookingId,
        job_actual_id: jobActualId,
        shop_id: shopId,
        mechanic_id: mechanicId,
        vehicle_vin: "VINBOTH1",
        recommended_service_id: serviceId,
        urgency: "next_visit",
        visible_to_driver: true,
        status: "open",
        created_at: old,
      } as any);

      return ownerId;
    });

    await t.run(async (ctx: any) => {
      await recomputeRecPenaltyForVehicle(ctx, {
        vin: "VINBOTH1",
        now: Date.now(),
      });
    });

    const owner = await t.run(async (ctx: any) => ctx.db.get(ownerId));
    // next_visit is worth 5 at a fully-ramped 200 days — from the canonical rec
    // only. If the freeform one were counted this would read 10.
    expect((owner as any).health_score_rec_penalty).toBe(5);
  });
});
