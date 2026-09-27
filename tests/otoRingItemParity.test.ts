import { describe, it, expect } from "vitest";
import { makeT } from "./helpers";
import { internal } from "../convex/_generated/api";
import { buildMaintenanceItems } from "@/utils/maintenanceEnrichment";
import { buildMergedMaintenanceItems } from "@/utils/mergedMaintenance";
import { resolveFallbackProfile } from "../convex/service_intervals_queries";

// 1:1 PARITY GATE.
//
// Oto's get_vehicle_health must report the SAME item set the Cars ring renders
// — not just the same score. Before this gate, Oto omitted currentOdometer /
// oemIntervals / classCtx / serviceSlugById from the shared merge, so the
// from-odometer catalog pass never ran server-side and Oto silently knew about
// fewer services than the Cars page showed (e.g. an overdue coolant flush).
//
// If a future change adds a signal to the ring's merge inputs and not to Oto's,
// this test fails.
const VIN = "OTOPARITY000000001";
const ODO = 171000;

async function seed(t: any) {
  return await t.run(async (ctx: any) => {
    const userId = await ctx.db.insert("users", {
      clerkUserId: "clerk_parity", email: "parity@test.local",
      role: "user", createdAt: 1,
    });
    const makeId = await ctx.db.insert("makes", { name: "Alfa Romeo" });
    const modelId = await ctx.db.insert("models", { make_id: makeId, name: "Giulia" });
    const configId = await ctx.db.insert("vehicle_configs", {
      config_key: "2020_alfa-romeo_giulia_base_x", year: 2020,
      make_id: makeId, model_id: modelId,
    } as any);
    // Catalog services whose slugs the merge's coverage pass recognises.
    const svc: Record<string, any> = {};
    for (const slug of ["coolant_flush", "transmission_service", "spark_plugs"]) {
      svc[slug] = await ctx.db.insert("services", { name: slug, slug });
    }
    const intervals: Record<string, number> = {
      coolant_flush: 100000, transmission_service: 50000, spark_plugs: 60000,
    };
    for (const [slug, miles] of Object.entries(intervals)) {
      await ctx.db.insert("service_intervals", {
        vehicle_config_id: configId, service_id: svc[slug],
        interval_miles: miles, confidence: 0.85,
      } as any);
    }
    const vehicleId = await ctx.db.insert("vehicles", {
      vin: VIN, metadata: { make: "Alfa Romeo" }, vehicle_config_id: configId,
    } as any);
    const ownerId = await ctx.db.insert("vehicle_owners", {
      vin: VIN, user_id: userId, status: "active", mileage: ODO,
      knownIssues: [], preOnboardingComplete: true,
    } as any);
    return { userId, vehicleId, ownerId, intervals, configId };
  });
}

function ringItems(ownerId: string, oemIntervals: any, classCtx: any) {
  const userItems = buildMaintenanceItems(
    [], ODO, "Alfa Romeo", undefined, undefined, [], 2020, oemIntervals,
  );
  return buildMergedMaintenanceItems({
    userItems, records: [], knownIssues: [], vehicleYear: 2020,
    driverRecommendations: [], scopeId: ownerId,
    currentOdometer: ODO, oemIntervals, classCtx,
  } as any);
}

describe("Oto reports the SAME item set as the Cars ring (1:1 parity)", () => {
  it("includes the from-odometer catalog items the ring shows", async () => {
    const t = makeT();
    const s = await seed(t);
    const res: any = await t.query(internal.oto.vehicleHealth.getVehicleHealthForUser, {
      actingUserId: s.userId, vehicle_id: s.vehicleId,
    });

    const oemIntervals: any = {};
    for (const [slug, miles] of Object.entries(s.intervals)) {
      oemIntervals[slug] = { interval_miles: miles, interval_months: null };
    }
    // Derive classCtx from the SAME server helper Oto uses, with the ring's
    // BEV guard — otherwise the fixture silently under-reports and the gate
    // would pass for the wrong reason.
    const profile: any = await t.run((ctx: any) =>
      resolveFallbackProfile(ctx, s.configId),
    );
    const classCtx =
      !profile || profile.fuelClass === "bev"
        ? undefined
        : {
            vehicleClass: profile.vehicleClass,
            drivetrain: profile.drivetrain,
            hasDifferential: profile.hasDifferential,
            turbo: profile.turbo,
          };
    const ring = ringItems(String(s.ownerId), oemIntervals, classCtx);

    const otoIds = (res.items ?? []).map((i: any) => i.id).sort();
    const ringIds = ring.map((i: any) => i.id).sort();
    expect(otoIds).toEqual(ringIds);

    // The catalog pass must have actually produced rows, or this proves nothing.
    expect(ringIds.some((id: string) => id.startsWith("catalog-"))).toBe(true);
  });
});
