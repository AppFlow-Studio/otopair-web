/**
 * B-P3 (OTO_HANDOFF.md): the VIN-vs-id tool-schema lie.
 *
 * The vehicle-scoped read tools (get_vehicle_health, get_due_services,
 * get_vehicle_facts, list_services_for_vehicle) historically did
 * ctx.db.get(vehicle_id as Id), but their tool descriptions disagree — some
 * say "VIN", some say "vehicles._id" — and Haiku passes whichever. A VIN
 * reaching ctx.db.get is not a valid Convex id, so it threw; for
 * list_services_for_vehicle that throw was caught and the handler SILENTLY
 * FELL OPEN to the full unfiltered catalog (offering inapplicable services).
 *
 * Fix: a shared resolveVehicleByIdOrVin accepts either form. This pins the
 * resolver and the end-to-end fail-open fix.
 */
import { describe, test, expect } from "vitest";
import { internal } from "../convex/_generated/api";
import { makeT } from "./helpers";
import { isVinShaped } from "../convex/oto/resolveVehicle";

describe("isVinShaped", () => {
  test("accepts a real 17-char VIN", () => {
    expect(isVinShaped("1HGCM82633A004352")).toBe(true);
    expect(isVinShaped("WBA7E2C50JG000001")).toBe(true);
  });
  test("rejects a Convex-id-shaped string (32 base32 chars)", () => {
    expect(isVinShaped("k5709abcxyz1234567890abcdef01234")).toBe(false);
  });
  test("rejects VINs with the forbidden letters I/O/Q", () => {
    expect(isVinShaped("IOQCM82633A004352")).toBe(false);
  });
  test("rejects wrong lengths", () => {
    expect(isVinShaped("1HGCM82633A00435")).toBe(false); // 16
    expect(isVinShaped("1HGCM82633A0043521")).toBe(false); // 18
  });
});

async function seedOwnedVehicle(t: ReturnType<typeof makeT>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", {
      clerkUserId: `clerk_vinres_${now}`,
      email: "vinres@test.local",
      first_name: "Vin",
      role: "user",
      createdAt: now,
    });
    const makeId = await ctx.db.insert("makes", { name: "Tesla" });
    const modelId = await ctx.db.insert("models", { make_id: makeId, name: "Model 3" });
    const engineId = await ctx.db.insert("engines", {
      engine_code: "TESLA_EM",
      make_id: makeId,
      fuel_type: "Electric",
    } as any);
    const configId = await ctx.db.insert("vehicle_configs", {
      config_key: "2022_tesla_model3",
      year: 2022,
      make_id: makeId,
      model_id: modelId,
      engine_id: engineId,
      trim_name: "RWD",
      enrichment_status: "complete",
      fill_rate: 90,
    });
    const vin = "5YJ3E1EA7JF000001";
    const vehicleId = await ctx.db.insert("vehicles", {
      vin,
      year: 2022,
      vehicle_config_id: configId,
    } as any);
    await ctx.db.insert("vehicle_owners", {
      vin,
      user_id: userId,
      status: "active",
    } as any);
    // An EV-inapplicable service (oil change) + a universal one.
    await ctx.db.insert("services", {
      name: "Oil Change",
      slug: "oil_change",
      created_at: now,
      requires_ice_engine: true,
    } as any);
    await ctx.db.insert("services", {
      name: "Tire Rotation",
      slug: "tire_rotation",
      created_at: now,
    } as any);
    return { userId, vehicleId, vin, configId };
  });
}

describe("resolveVehicleByIdOrVin (via list_services fail-open fix)", () => {
  test("a VIN now resolves + filters — no longer silently the full catalog", async () => {
    const t = makeT();
    const seed = await seedOwnedVehicle(t);

    // Passing the VIN (what the tool description tells Haiku to send) must now
    // resolve the vehicle and apply applicability filtering, not fall open.
    const byVin = await t.query(
      internal.oto.applicableServices.listServicesForUserVehicle,
      { actingUserId: seed.userId, vehicle_id: seed.vin },
    );
    // Resolution succeeded: the result is the applicability-filtered set, not
    // the raw 2-row catalog (oil_change is filtered out for an EV).
    const slugs = byVin.map((s: any) => s.slug).sort();
    expect(slugs).not.toContain("oil_change");
    expect(slugs).toContain("tire_rotation");
  });

  test("the Convex _id form still resolves identically", async () => {
    const t = makeT();
    const seed = await seedOwnedVehicle(t);

    const byId = await t.query(
      internal.oto.applicableServices.listServicesForUserVehicle,
      { actingUserId: seed.userId, vehicle_id: seed.vehicleId },
    );
    const slugs = byId.map((s: any) => s.slug).sort();
    expect(slugs).not.toContain("oil_change");
    expect(slugs).toContain("tire_rotation");
  });

  test("an unknown VIN falls open (degrade, not crash)", async () => {
    const t = makeT();
    const seed = await seedOwnedVehicle(t);

    const unknown = await t.query(
      internal.oto.applicableServices.listServicesForUserVehicle,
      { actingUserId: seed.userId, vehicle_id: "11111111111111111" },
    );
    // No such vehicle → unfiltered catalog (both services).
    expect(unknown).toHaveLength(2);
  });
});
