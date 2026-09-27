import { describe, it, expect } from "vitest";
import { makeT } from "./helpers";
import { internal } from "../convex/_generated/api";
import { buildMaintenanceItems } from "@/utils/maintenanceEnrichment";
import { buildMergedMaintenanceItems } from "@/utils/mergedMaintenance";
import { computeVehicleHealthScore } from "@/utils/healthScore";

// Bug C — Oto's get_vehicle_health score must match the Cars-page ring. It now
// computes from the SAME merged item set (optimistic no-record fallback + driver
// recs + warning item) plus the same recPenalty + hpBuffer, instead of its old
// conservative-item score. These tests prove the wiring end-to-end.
const VIN = "OTOHVIN00000000001";

async function seedBase(t: any) {
  return await t.run(async (ctx: any) => {
    const userId = await ctx.db.insert("users", {
      clerkUserId: "clerk_ohc",
      email: "ohc@test.local",
      role: "user",
      createdAt: 1,
    });
    const vehicleId = await ctx.db.insert("vehicles", {
      vin: VIN,
      metadata: { make: "Alfa Romeo" },
    } as any);
    const ownerId = await ctx.db.insert("vehicle_owners", {
      vin: VIN,
      user_id: userId,
      status: "active",
      mileage: 48000,
      knownIssues: [],
      preOnboardingComplete: true,
    } as any);
    return { userId, vehicleId, ownerId };
  });
}

function ringScore(opts: {
  driverRecommendations?: any[];
  knownIssues?: string[];
  recPenalty?: number;
  hpBuffer?: number;
  scopeId: string;
}): number {
  const userItems = buildMaintenanceItems(
    [],
    48000,
    "Alfa Romeo",
    undefined,
    undefined,
    opts.knownIssues,
    undefined,
    undefined,
  );
  const items = buildMergedMaintenanceItems({
    userItems,
    records: [],
    knownIssues: opts.knownIssues,
    vehicleYear: undefined,
    driverRecommendations: opts.driverRecommendations,
    scopeId: opts.scopeId,
    // These score-convergence cases seed no odometer/intervals, so the catalog
    // pass is explicitly opted out. Item-set parity (which DOES exercise it)
    // is covered by tests/otoRingItemParity.test.ts.
    currentOdometer: undefined,
    oemIntervals: undefined,
    classCtx: undefined,
    serviceSlugById: undefined,
  });
  return computeVehicleHealthScore({
    maintenanceItems: items,
    odometerMiles: 48000,
    knownIssues: opts.knownIssues,
    recPenalty: opts.recPenalty,
    hpBuffer: opts.hpBuffer ?? 0,
  });
}

describe("get_vehicle_health score converges with the Cars ring", () => {
  it("no-records score equals the ring's optimistic-fallback score (not Oto's old unknown score)", async () => {
    const t = makeT();
    const s = await seedBase(t);
    const res: any = await t.query(internal.oto.vehicleHealth.getVehicleHealthForUser, {
      actingUserId: s.userId,
      vehicle_id: s.vehicleId,
    });
    const expected = ringScore({ scopeId: String(s.ownerId), knownIssues: [] });
    expect(res.score).toBe(expected);
  });

  it("subtracts the open-mechanic-rec penalty (health_score_rec_penalty)", async () => {
    const t = makeT();
    const s = await seedBase(t);
    const before: any = await t.query(internal.oto.vehicleHealth.getVehicleHealthForUser, {
      actingUserId: s.userId,
      vehicle_id: s.vehicleId,
    });
    await t.run((ctx: any) => ctx.db.patch(s.ownerId, { health_score_rec_penalty: 15 }));
    const after: any = await t.query(internal.oto.vehicleHealth.getVehicleHealthForUser, {
      actingUserId: s.userId,
      vehicle_id: s.vehicleId,
    });
    expect(after.score).toBe(before.score - 15);
  });

  it("does not apply the Health-Points buffer (rewards paused — see utils/healthScore.ts HealthScoreInput.hpBuffer)", async () => {
    const t = makeT();
    const s = await seedBase(t);
    const before: any = await t.query(internal.oto.vehicleHealth.getVehicleHealthForUser, {
      actingUserId: s.userId,
      vehicle_id: s.vehicleId,
    });
    await t.run((ctx: any) =>
      ctx.db.insert("vehicle_health_points", {
        vin: VIN,
        user_id: s.userId,
        points: 30,
        last_decay_at: 1,
        updated_at: 1,
      } as any),
    );
    const after: any = await t.query(internal.oto.vehicleHealth.getVehicleHealthForUser, {
      actingUserId: s.userId,
      vehicle_id: s.vehicleId,
    });
    expect(after.score).toBe(before.score);
  });

  it("includes an open mechanic recommendation in the score only via the Open-recs penalty (Consolidated model — no double-count)", async () => {
    const t = makeT();
    const s = await seedBase(t);
    const before: any = await t.query(internal.oto.vehicleHealth.getVehicleHealthForUser, {
      actingUserId: s.userId,
      vehicle_id: s.vehicleId,
    });
    await t.run(async (ctx: any) => {
      const svcId = await ctx.db.insert("services", { name: "Tire Rotation", slug: "tire_rotation" } as any);
      const shopId = await ctx.db.insert("shops", { name: "ExpressAuto", is_active: true } as any);
      const mechId = await ctx.db.insert("mechanics", { shop_id: shopId, first_name: "John", last_name: "Stamos", is_active: true } as any);
      const bookingId = await ctx.db.insert("bookings", { vin: VIN, user_id: s.userId, service_ids: [svcId], status: "completed" } as any);
      const jaId = await ctx.db.insert("job_actuals", { booking_id: bookingId, mechanic_id: mechId, started_at: 1, created_at: 1, updated_at: 1 } as any);
      await ctx.db.insert("job_recommendations", {
        booking_id: bookingId,
        job_actual_id: jaId,
        shop_id: shopId,
        mechanic_id: mechId,
        vehicle_vin: VIN,
        recommended_service_id: svcId,
        urgency: "soon",
        visible_to_driver: true,
        status: "open",
        created_at: 1,
      } as any);
    });
    // The recommendation card itself (Consolidated model) never creates a
    // second weighted Upkeep item — only recomputeRecPenaltyForVehicle
    // ramping health_score_rec_penalty (production pipeline, bypassed by
    // this direct insert) moves the score. Simulate that ramp explicitly.
    const noPenalty: any = await t.query(internal.oto.vehicleHealth.getVehicleHealthForUser, {
      actingUserId: s.userId,
      vehicle_id: s.vehicleId,
    });
    expect(noPenalty.score).toBe(before.score);

    await t.run((ctx: any) => ctx.db.patch(s.ownerId, { health_score_rec_penalty: 5 }));
    const after: any = await t.query(internal.oto.vehicleHealth.getVehicleHealthForUser, {
      actingUserId: s.userId,
      vehicle_id: s.vehicleId,
    });
    expect(after.score).toBeLessThan(before.score);
  });
});
