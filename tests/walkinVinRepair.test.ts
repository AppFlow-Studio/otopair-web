/**
 * Pseudo-VIN → real-VIN reconciliation (Off-Catalog Work spec, §5).
 *
 * The failure mode this guards against is not "the repair didn't run" — it's
 * "the repair ran halfway". Eighteen tables key on the VIN string; moving some
 * and not others doesn't half-fix the identity fork, it CREATES one, with half
 * the car's history under the old key and half under the new. So the central
 * test seeds every table a walk-in can populate and asserts nothing is left
 * behind.
 *
 * The second thing under test is the refusal. If the target VIN is already
 * known, this is a merge of two identities that may each have owners, bookings
 * and health scores — the operation that previously produced duplicate configs
 * and orphaned rows. It must block, not improvise.
 */
import { describe, it, expect } from "vitest";
import { makeT, identityFor } from "./helpers";
import { api } from "../convex/_generated/api";
import { reconcileVin } from "../convex/walkinVinRepair";
import { mintPseudoVin, isPseudoVin, isRealVin } from "../convex/lib/vinIdentity";

const REAL_VIN = "1HGCV1F30LA012345";
const OTHER_REAL_VIN = "5YJ3E1EA7KF317654";
const DRIVER_CLERK = "clerk_vinrepair_driver";
const STAFF_CLERK = "clerk_vinrepair_staff";

/** Sanity-check the fixtures against the same helpers production uses. */
describe("fixture assumptions", () => {
  it("the test VINs are what the helpers say they are", () => {
    expect(isRealVin(REAL_VIN)).toBe(true);
    expect(isRealVin(OTHER_REAL_VIN)).toBe(true);
    expect(isPseudoVin(mintPseudoVin(1_700_000_000_000, "abc123"))).toBe(true);
  });
});

/**
 * A walk-in car on a placeholder VIN, with a row in every table the repair is
 * responsible for moving.
 */
async function seedWalkin(t: ReturnType<typeof makeT>) {
  const pseudoVin = mintPseudoVin(1_700_000_000_000, "walkin01");
  const ids = await t.run(async (ctx: any) => {
    const driverId = await ctx.db.insert("users", {
      clerkUserId: DRIVER_CLERK,
      email: "driver@test.local",
      role: "user",
      createdAt: Date.now(),
    });
    const staffId = await ctx.db.insert("users", {
      clerkUserId: STAFF_CLERK,
      email: "staff@test.local",
      role: "shop_owner",
      createdAt: Date.now(),
    });
    const shopId = await ctx.db.insert("shops", {
      name: "Brooklyn Auto",
      owner_user_id: staffId,
    } as any);
    const mechanicId = await ctx.db.insert("mechanics", {
      shop_id: shopId,
      first_name: "Mike",
      last_name: "R",
    } as any);
    const serviceId = await ctx.db.insert("services", {
      name: "Oil Change",
      slug: "oil_change",
    });

    await ctx.db.insert("vehicles", {
      vin: pseudoVin,
      year: 2019,
      metadata: { make: "Honda", model: "Civic" },
    } as any);
    await ctx.db.insert("vehicle_owners", {
      vin: pseudoVin,
      user_id: driverId,
      status: "active",
      is_primary: true,
      added_at: Date.now(),
    } as any);

    const bookingId = await ctx.db.insert("bookings", {
      vin: pseudoVin,
      user_id: driverId,
      shop_id: shopId,
      mechanic_id: mechanicId,
      service_ids: [serviceId],
      status: "completed",
      source: "mechanic_walk_in",
    } as any);
    const jobActualId = await ctx.db.insert("job_actuals", {
      booking_id: bookingId,
      mechanic_id: mechanicId,
    } as any);

    await ctx.db.insert("follow_ups", {
      user_id: driverId,
      vin: pseudoVin,
      service_id: serviceId,
      follow_up_type: "maintenance_due",
      scheduled_for: Date.now() + 1000,
      status: "pending",
    } as any);
    await ctx.db.insert("job_recommendations", {
      booking_id: bookingId,
      job_actual_id: jobActualId,
      shop_id: shopId,
      mechanic_id: mechanicId,
      vehicle_vin: pseudoVin,
      freeform_text: "Carbon cleaning",
      urgency: "soon",
      visible_to_driver: true,
      status: "open",
      created_at: Date.now(),
    } as any);
    await ctx.db.insert("custom_jobs", {
      booking_id: bookingId,
      shop_id: shopId,
      vehicle_vin: pseudoVin,
      name: "Carbon cleaning",
      normalized_name: "carbon cleaning",
      match_key: "carbon cleaning",
      source: "booking",
      status: "completed",
      created_at: Date.now(),
    } as any);
    await ctx.db.insert("vehicle_passports", { vin: pseudoVin } as any);
    await ctx.db.insert("vehicle_inspections", {
      vin: pseudoVin,
      booking_id: bookingId,
      template_version: "v1",
      zones: [],
      findings_attention: [],
      findings_monitor: [],
      created_at: Date.now(),
      updated_at: Date.now(),
    } as any);

    const partId = await ctx.db.insert("oem_parts", {
      oem_part_number: "15400-PLM-A02",
      name: "Oil filter",
    } as any);
    await ctx.db.insert("vehicle_part_preferences", {
      vin: pseudoVin,
      service_id: serviceId,
      part_id: partId,
      use_count: 1,
    } as any);

    const vehicleRow = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q: any) => q.eq("vin", pseudoVin))
      .first();
    await ctx.db.insert("part_snapshots", {
      booking_id: bookingId,
      shop_id: shopId,
      // Note: part_snapshots.mechanic_id is v.id("users"), not v.id("mechanics").
      mechanic_id: staffId,
      vehicle_id: vehicleRow._id,
      service_id: serviceId,
      vin: pseudoVin,
      part_name: "Oil filter",
      part_tier: "oem",
      supplied_by: "shop",
      quantity: 1,
      unit_cost: 12,
      total_cost: 12,
      recorded_at: Date.now(),
    } as any);

    return { driverId, staffId, shopId, bookingId, serviceId };
  });
  return { pseudoVin, ...ids };
}

/** Count rows still pointing at a VIN, across everything we care about. */
async function countByVin(t: ReturnType<typeof makeT>, vin: string) {
  return t.run(async (ctx: any) => {
    const out: Record<string, number> = {};
    const specs: Array<[string, string]> = [
      ["vehicles", "vin"],
      ["vehicle_owners", "vin"],
      ["bookings", "vin"],
      ["follow_ups", "vin"],
      ["job_recommendations", "vehicle_vin"],
      ["custom_jobs", "vehicle_vin"],
      ["vehicle_passports", "vin"],
      ["vehicle_inspections", "vin"],
      // vehicle_documents is re-keyed by the same code path but omitted from the
      // fixture: it requires a real _storage id, which this harness can't cheaply
      // mint. Covered by inspection of VIN_KEYED_TABLES, not by assertion.
      ["vehicle_part_preferences", "vin"],
      ["part_snapshots", "vin"],
    ];
    for (const [table, field] of specs) {
      const rows = await ctx.db.query(table as any).collect();
      const n = rows.filter((r: any) => r[field] === vin).length;
      if (n > 0) out[table] = n;
    }
    return out;
  });
}

describe("the re-key is all-or-nothing", () => {
  it("moves every table a walk-in can populate, leaving nothing behind", async () => {
    const t = makeT();
    const seed = await seedWalkin(t);

    const before = await countByVin(t, seed.pseudoVin);
    // Guard the test itself: if the fixture stops covering these tables, the
    // "nothing left behind" assertion below becomes vacuous.
    expect(Object.keys(before).length).toBeGreaterThanOrEqual(10);

    const result: any = await t.run(async (ctx: any) =>
      reconcileVin(ctx, {
        fromVin: seed.pseudoVin,
        toVin: REAL_VIN,
        trigger: "claim",
        now: Date.now(),
      }),
    );
    expect(result.ok).toBe(true);

    const leftBehind = await countByVin(t, seed.pseudoVin);
    expect(leftBehind).toEqual({});

    const arrived = await countByVin(t, REAL_VIN);
    expect(arrived).toEqual(before);
  });

  it("writes an auditable ledger row with per-table counts", async () => {
    const t = makeT();
    const seed = await seedWalkin(t);
    await t.run(async (ctx: any) =>
      reconcileVin(ctx, {
        fromVin: seed.pseudoVin,
        toVin: REAL_VIN,
        trigger: "claim",
        actorUserId: seed.driverId,
        now: 1_700_000_500_000,
      }),
    );

    const log = await t.run(async (ctx: any) =>
      ctx.db.query("vin_repair_log").collect(),
    );
    expect(log).toHaveLength(1);
    expect(log[0].from_vin).toBe(seed.pseudoVin);
    expect(log[0].to_vin).toBe(REAL_VIN);
    expect(log[0].trigger).toBe("claim");
    expect(log[0].moved.bookings).toBe(1);
    expect(log[0].moved.custom_jobs).toBe(1);
    // The batch handle is what a revert would key on.
    expect(log[0].batch).toContain(seed.pseudoVin);
  });

  it("preserves the driver's ownership link through the move", async () => {
    // The whole point is that the shop's work stays attached to the person. If
    // ownership didn't follow the VIN, the repair would strand the history.
    const t = makeT();
    const seed = await seedWalkin(t);
    await t.run(async (ctx: any) =>
      reconcileVin(ctx, {
        fromVin: seed.pseudoVin,
        toVin: REAL_VIN,
        trigger: "claim",
        now: Date.now(),
      }),
    );

    const owner = await t.run(async (ctx: any) =>
      ctx.db
        .query("vehicle_owners")
        .withIndex("by_vin_user", (q: any) =>
          q.eq("vin", REAL_VIN).eq("user_id", seed.driverId),
        )
        .first(),
    );
    expect(owner).not.toBeNull();
    expect((owner as any).status).toBe("active");
  });
});

describe("the refusals", () => {
  it("blocks when the target VIN is already a car we know", async () => {
    // This is a MERGE of two identities, not a re-key. Improvising it is how you
    // get duplicate configs and orphaned rows.
    const t = makeT();
    const seed = await seedWalkin(t);
    await t.run(async (ctx: any) =>
      ctx.db.insert("vehicles", { vin: REAL_VIN, year: 2019 } as any),
    );

    const result: any = await t.run(async (ctx: any) =>
      reconcileVin(ctx, {
        fromVin: seed.pseudoVin,
        toVin: REAL_VIN,
        trigger: "claim",
        now: Date.now(),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("target_known");
    expect(result.detail).toContain("vehicles");

    // And nothing moved.
    const still = await countByVin(t, seed.pseudoVin);
    expect(Object.keys(still).length).toBeGreaterThan(0);
    const log = await t.run(async (ctx: any) =>
      ctx.db.query("vin_repair_log").collect(),
    );
    expect(log).toHaveLength(0);
  });

  it("refuses to overwrite a car that already has a real VIN", async () => {
    // Replacing a placeholder is filling in a blank. Replacing a real VIN is
    // rewriting decoded truth — a different, far more dangerous operation.
    const t = makeT();
    const result: any = await t.run(async (ctx: any) =>
      reconcileVin(ctx, {
        fromVin: REAL_VIN,
        toVin: OTHER_REAL_VIN,
        trigger: "mechanic",
        now: Date.now(),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_pseudo");
  });

  it("refuses a target that isn't structurally a VIN", async () => {
    const t = makeT();
    const seed = await seedWalkin(t);
    for (const bad of ["1HGCV", "1HGCV1F30LA01234I", "not a vin at all"]) {
      const result: any = await t.run(async (ctx: any) =>
        reconcileVin(ctx, {
          fromVin: seed.pseudoVin,
          toVin: bad,
          trigger: "mechanic",
          now: Date.now(),
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("not_real");
    }
  });

  it("refuses a no-op", async () => {
    const t = makeT();
    const seed = await seedWalkin(t);
    const result: any = await t.run(async (ctx: any) =>
      reconcileVin(ctx, {
        fromVin: seed.pseudoVin,
        toVin: seed.pseudoVin,
        trigger: "mechanic",
        now: Date.now(),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("same");
  });
});

describe("who is allowed to do it", () => {
  it("the driver can repair a car they own", async () => {
    const t = makeT();
    const seed = await seedWalkin(t);
    const res: any = await t
      .withIdentity(identityFor(DRIVER_CLERK))
      .mutation(api.walkinVinRepair.submitVinForMyVehicle, {
        pseudoVin: seed.pseudoVin,
        vin: REAL_VIN,
      });
    expect(res.ok).toBe(true);
    expect(res.moved.bookings).toBe(1);
  });

  it("a driver cannot repair someone else's car", async () => {
    const t = makeT();
    const seed = await seedWalkin(t);
    await t.run(async (ctx: any) =>
      ctx.db.insert("users", {
        clerkUserId: "clerk_stranger",
        email: "stranger@test.local",
        role: "user",
        createdAt: Date.now(),
      }),
    );
    await expect(
      t
        .withIdentity(identityFor("clerk_stranger"))
        .mutation(api.walkinVinRepair.submitVinForMyVehicle, {
          pseudoVin: seed.pseudoVin,
          vin: REAL_VIN,
        }),
    ).rejects.toThrow(/Not authorized/);
  });

  it("shop staff can repair from the booking, before the customer has an account", async () => {
    // The mechanic standing next to the windscreen is the best VIN-capture
    // moment this car will ever get.
    const t = makeT();
    const seed = await seedWalkin(t);
    const res: any = await t
      .withIdentity(identityFor(STAFF_CLERK))
      .mutation(api.walkinVinRepair.submitVinForBooking, {
        bookingId: seed.bookingId,
        vin: REAL_VIN,
      });
    expect(res.ok).toBe(true);

    const leftBehind = await countByVin(t, seed.pseudoVin);
    expect(leftBehind).toEqual({});
  });

  it("a stranger cannot repair through the booking", async () => {
    const t = makeT();
    const seed = await seedWalkin(t);
    await t.run(async (ctx: any) =>
      ctx.db.insert("users", {
        clerkUserId: "clerk_stranger2",
        email: "stranger2@test.local",
        role: "user",
        createdAt: Date.now(),
      }),
    );
    await expect(
      t
        .withIdentity(identityFor("clerk_stranger2"))
        .mutation(api.walkinVinRepair.submitVinForBooking, {
          bookingId: seed.bookingId,
          vin: REAL_VIN,
        }),
    ).rejects.toThrow(/Not authorized/);
  });

  it("the blocked case reaches the caller instead of throwing", async () => {
    // "That VIN belongs to a car we already know" is something the UI has to
    // render — support, not a retry — so it must not surface as an exception.
    const t = makeT();
    const seed = await seedWalkin(t);
    await t.run(async (ctx: any) =>
      ctx.db.insert("vehicles", { vin: REAL_VIN, year: 2019 } as any),
    );
    const res: any = await t
      .withIdentity(identityFor(DRIVER_CLERK))
      .mutation(api.walkinVinRepair.submitVinForMyVehicle, {
        pseudoVin: seed.pseudoVin,
        vin: REAL_VIN,
      });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("target_known");
  });
});

describe("surfacing the prompt", () => {
  it("lists the driver's placeholder cars with enough context to recognise them", async () => {
    const t = makeT();
    const seed = await seedWalkin(t);
    const list: any = await t
      .withIdentity(identityFor(DRIVER_CLERK))
      .query(api.walkinVinRepair.myVehiclesNeedingVin, {});
    expect(list).toHaveLength(1);
    expect(list[0].vin).toBe(seed.pseudoVin);
    expect(list[0].label).toBe("2019 Honda Civic");
    expect(list[0].bookings).toBe(1);
  });

  it("stops listing the car once it's repaired", async () => {
    const t = makeT();
    const seed = await seedWalkin(t);
    const asDriver = t.withIdentity(identityFor(DRIVER_CLERK));
    await asDriver.mutation(api.walkinVinRepair.submitVinForMyVehicle, {
      pseudoVin: seed.pseudoVin,
      vin: REAL_VIN,
    });
    const list: any = await asDriver.query(
      api.walkinVinRepair.myVehiclesNeedingVin,
      {},
    );
    expect(list).toHaveLength(0);
  });

  it("preview reports the blast radius without moving anything", async () => {
    const t = makeT();
    const seed = await seedWalkin(t);
    const plan: any = await t.query(api.walkinVinRepair.previewRepair, {
      pseudoVin: seed.pseudoVin,
      vin: REAL_VIN,
    });
    expect(plan.ok).toBe(true);
    expect(plan.total).toBeGreaterThanOrEqual(10);
    expect(plan.moved.bookings).toBe(1);
    // Says out loud what it won't touch, so a reviewer isn't guessing.
    expect(plan.skipped).toContain("pending_service_submissions");

    const still = await countByVin(t, seed.pseudoVin);
    expect(Object.keys(still).length).toBeGreaterThan(0);
  });
});
