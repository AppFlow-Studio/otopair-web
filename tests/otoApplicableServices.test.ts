/**
 * Oto list_services_for_vehicle applicability filter (Jun-9 review, HIGH 18):
 * the tool returned the whole 23-service catalog unfiltered, so Oto could
 * offer a PS flush on an EPS car or an oil change on an EV (the May-26 bug
 * through a different door).
 *
 * Contract: filter through the SAME isServiceApplicable rules as the booking
 * surface when the vehicle resolves to an enriched config; fail OPEN to the
 * unfiltered catalog when resolution isn't possible (no config / no engine /
 * unowned vehicle) — the tool never throws and the catalog itself is not
 * user data.
 */
import { describe, test, expect } from "vitest";
import { internal } from "../convex/_generated/api";
import { makeT } from "./helpers";

async function seedOtoWorld(
  t: ReturnType<typeof makeT>,
  opts: { fuelType?: string; withConfig?: boolean; ownedByActing?: boolean } = {},
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const actingUserId = await ctx.db.insert("users", {
      clerkUserId: `clerk_acting_${now}`,
      email: "acting@test.local",
      role: "user",
      createdAt: now,
    });
    const otherUserId = await ctx.db.insert("users", {
      clerkUserId: `clerk_other_${now}`,
      email: "other@test.local",
      role: "user",
      createdAt: now,
    });
    const makeId = await ctx.db.insert("makes", { name: "Testmake" });
    const modelId = await ctx.db.insert("models", { make_id: makeId, name: "Testmodel" });
    const engineId = await ctx.db.insert("engines", {
      engine_code: "TESTENG",
      fuel_type: opts.fuelType ?? "Gasoline",
    });
    const configId = await ctx.db.insert("vehicle_configs", {
      config_key: "2022_testmake_testmodel_base_testeng",
      year: 2022,
      make_id: makeId,
      model_id: modelId,
      engine_id: engineId,
      enrichment_status: "complete",
    });
    const vin = "WBA7U2C08LGM27817";
    const vehicleId = await ctx.db.insert("vehicles", {
      vin,
      engine_id: engineId,
      ...(opts.withConfig !== false ? { vehicle_config_id: configId } : {}),
    });
    await ctx.db.insert("vehicle_owners", {
      vin,
      user_id: opts.ownedByActing === false ? otherUserId : actingUserId,
      status: "active",
    });
    const oilChangeId = await ctx.db.insert("services", {
      name: "Oil change",
      slug: "oil_change",
      default_labor_hours: 0.5,
      requires_ice_engine: true,
      created_at: now,
    } as any);
    const wiperId = await ctx.db.insert("services", {
      name: "Wiper blades",
      slug: "wiper_blade_replacement",
      default_labor_hours: 0.2,
      created_at: now,
    } as any);
    return { actingUserId, vehicleId, configId, oilChangeId, wiperId };
  });
}

describe("oto listServicesForUserVehicle", () => {
  test("EV: ICE-only services filtered out, universal services kept", async () => {
    const t = makeT();
    const { actingUserId, vehicleId } = await seedOtoWorld(t, { fuelType: "Electric" });

    const out = await t.query(
      internal.oto.applicableServices.listServicesForUserVehicle,
      { actingUserId, vehicle_id: vehicleId },
    );
    const slugs = out.map((s: any) => s.slug);
    expect(slugs).toContain("wiper_blade_replacement");
    expect(slugs).not.toContain("oil_change");
  });

  test("gas car: full catalog (both services applicable)", async () => {
    const t = makeT();
    const { actingUserId, vehicleId } = await seedOtoWorld(t, { fuelType: "Gasoline" });

    const out = await t.query(
      internal.oto.applicableServices.listServicesForUserVehicle,
      { actingUserId, vehicle_id: vehicleId },
    );
    expect(out.map((s: any) => s.slug).sort()).toEqual([
      "oil_change",
      "wiper_blade_replacement",
    ]);
  });

  test("no vehicle_config on the vehicle → fail open to the unfiltered catalog", async () => {
    const t = makeT();
    const { actingUserId, vehicleId } = await seedOtoWorld(t, {
      fuelType: "Electric",
      withConfig: false,
    });

    const out = await t.query(
      internal.oto.applicableServices.listServicesForUserVehicle,
      { actingUserId, vehicle_id: vehicleId },
    );
    expect(out).toHaveLength(2); // unfiltered — no config to filter against
  });

  test("vehicle not owned by the acting user → fail open, never throw", async () => {
    const t = makeT();
    const { actingUserId, vehicleId } = await seedOtoWorld(t, {
      fuelType: "Electric",
      ownedByActing: false,
    });

    const out = await t.query(
      internal.oto.applicableServices.listServicesForUserVehicle,
      { actingUserId, vehicle_id: vehicleId },
    );
    expect(out).toHaveLength(2); // catalog is not user data; filter just doesn't apply
  });
});
