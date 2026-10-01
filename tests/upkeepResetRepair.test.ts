import { describe, it, expect } from "vitest";
import { makeT } from "./helpers";
import { internal } from "../convex/_generated/api";

// #413 / #428 data repair: "tires" records that a rotation reset as if the
// tires had been replaced, written before the completion fix.
const DAY = 24 * 60 * 60 * 1000;

const shopFields = (ownerUserId: any) => ({
  name: "Test Shop",
  owner_user_id: ownerUserId,
  is_active: true,
  timezone: "America/New_York",
  no_show_threshold_minutes: 30,
  overrun_default_extension_percent: 25,
  overrun_extension_floor_minutes: 5,
  max_bookings_per_mechanic_rolling_hour: 2,
  entity_label_mode: "mechanic",
});

async function seed(
  t: ReturnType<typeof makeT>,
  opts: { slug: string; recordDateOffset?: number },
) {
  return t.run(async (ctx: any) => {
    const userId = await ctx.db.insert("users", {
      clerkUserId: `c_${opts.slug}`,
      email: `${opts.slug}@test.local`,
      role: "customer",
      createdAt: Date.now(),
    });
    const ownerId = await ctx.db.insert("vehicle_owners", {
      vin: "VINREPAIR",
      user_id: userId,
      status: "active",
      mileage: 22001,
    });
    const shopId = await ctx.db.insert("shops", shopFields(userId));
    const serviceId = await ctx.db.insert("services", { name: opts.slug, slug: opts.slug });
    const completedAt = Date.now() - 3 * DAY;
    const bookingId = await ctx.db.insert("bookings", {
      vin: "VINREPAIR",
      user_id: userId,
      shop_id: shopId,
      service_ids: [serviceId],
      status: "completed",
      completed_at_ms: completedAt,
    });
    // Exactly what the old completion wrote: a fresh "tires" row, stamped.
    const stamped = completedAt + (opts.recordDateOffset ?? 0);
    const recordId = await ctx.db.insert("maintenance_records", {
      vehicleOwnerId: ownerId,
      type: "tires",
      lastServiceDate: stamped,
      lastServiceMileage: 22001,
      serviceSource: "otopair",
      confidence: "verified",
      lastServiceBookingId: bookingId,
      resolutionAckedAt: stamped + 1000,
      customInputs: { tireReplaced: "dont_know" },
      createdAt: stamped,
    });
    return { ownerId, bookingId, recordId, stamped };
  });
}

async function rows(t: ReturnType<typeof makeT>, ownerId: any) {
  const all = await t.run(async (ctx: any) =>
    ctx.db
      .query("maintenance_records")
      .withIndex("by_vehicle_owner", (q: any) => q.eq("vehicleOwnerId", ownerId))
      .collect(),
  );
  return new Map<string, any>(all.map((r: any) => [r.type, r]));
}

describe("migrations/upkeepResetRepair", () => {
  it("dry run reports a rotation-reset tires record and writes nothing", async () => {
    const t = makeT();
    const { ownerId, recordId } = await seed(t, { slug: "tire_rotation" });

    const report = await t.mutation(internal.migrations.upkeepResetRepair.repair, {});
    expect(report.dryRun).toBe(true);
    expect(report.repairCount).toBe(1);
    expect(String(report.repaired[0].recordId)).toBe(String(recordId));
    expect(report.repaired[0].upkeepSlugs).toEqual(["tire_rotation"]);
    expect(report.repaired[0].hadPriorRecord).toBe(false);

    const after = await rows(t, ownerId);
    expect(typeof after.get("tires").lastServiceDate).toBe("number");
    expect(after.has("service_tire_rotation")).toBe(false);
  });

  it("apply moves the stamp to the rotation's own anchor and clears tread life", async () => {
    const t = makeT();
    const { ownerId, bookingId, stamped } = await seed(t, { slug: "tire_rotation" });

    await t.mutation(internal.migrations.upkeepResetRepair.repair, { dryRun: false });

    const after = await rows(t, ownerId);
    const tires = after.get("tires");
    expect(tires.lastServiceDate).toBeUndefined();
    expect(tires.lastServiceMileage).toBeUndefined();
    expect(tires.lastServiceBookingId).toBeUndefined();
    expect(tires.customInputs).toEqual({ tireReplaced: "dont_know" });

    const rotation = after.get("service_tire_rotation");
    expect(rotation.lastServiceDate).toBe(stamped);
    expect(rotation.lastServiceMileage).toBe(22001);
    expect(String(rotation.lastServiceBookingId)).toBe(String(bookingId));
    // Already-seen resolved card stays seen.
    expect(rotation.resolutionAckedAt).toBe(stamped + 1000);

    // Idempotent: a second run finds nothing left to repair.
    const again = await t.mutation(internal.migrations.upkeepResetRepair.repair, {
      dryRun: false,
    });
    expect(again.repairCount).toBe(0);
  });

  it("leaves a record stamped by a real tire replacement alone", async () => {
    const t = makeT();
    await seed(t, { slug: "tire_replacement" });
    const report = await t.mutation(internal.migrations.upkeepResetRepair.repair, {});
    expect(report.repairCount).toBe(0);
  });

  it("leaves a record the driver re-dated after the visit alone", async () => {
    const t = makeT();
    await seed(t, { slug: "tire_rotation", recordDateOffset: -200 * DAY });
    const report = await t.mutation(internal.migrations.upkeepResetRepair.repair, {});
    expect(report.repairCount).toBe(0);
  });
});
