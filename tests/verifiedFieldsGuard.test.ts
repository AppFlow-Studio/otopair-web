/**
 * vehicle_configs.verified_fields — the anti-clobber guard.
 *
 * Before this, patchVehicleConfig blind-patched every key it was given, so a
 * director's correction survived only until the next finalize. That was a live
 * bug for drivetrain / brake_fluid_capacity_oz / ps_fluid_capacity_oz, and it
 * would have made "manually input with a source link" useless for the rotor
 * minimum: the value would vanish on the next re-enrich.
 */
import { describe, expect, test } from "vitest";
import { makeT } from "./helpers";
import { internal } from "../convex/_generated/api";

const patchConfig = internal.vehicleEnrichment.v3mutations.patchVehicleConfig;

async function seedConfig(
  t: ReturnType<typeof makeT>,
  extra: Record<string, unknown> = {},
) {
  return t.run(async (ctx) => {
    const makeId = await ctx.db.insert("makes", { name: "Subaru" } as any);
    const modelId = await ctx.db.insert("models", {
      make_id: makeId,
      name: "Crosstrek",
    } as any);
    return ctx.db.insert("vehicle_configs", {
      config_key: `2019_subaru_crosstrek_${Math.random()}`,
      year: 2019,
      make_id: makeId,
      model_id: modelId,
      ...extra,
    } as any);
  });
}

const read = (t: ReturnType<typeof makeT>, id: any) =>
  t.run(async (ctx) => (await ctx.db.get(id)) as any);

describe("patchVehicleConfig honours verified_fields", () => {
  test("a director-verified rotor minimum survives a pipeline write", async () => {
    const t = makeT();
    const id = await seedConfig(t, {
      rotor_front_min_thickness_mm: 24,
      rotor_front_min_quality: "director_verified",
      verified_fields: ["rotor_front_min_thickness_mm", "rotor_front_min_quality"],
    });

    await t.mutation(patchConfig, {
      vehicle_config_id: id,
      rotor_front_min_thickness_mm: 22,
      rotor_front_min_quality: "oem_spec",
    });

    const cfg = await read(t, id);
    expect(cfg.rotor_front_min_thickness_mm).toBe(24);
    expect(cfg.rotor_front_min_quality).toBe("director_verified");
  });

  test("unverified columns are still written in the same call", async () => {
    const t = makeT();
    const id = await seedConfig(t, {
      rotor_front_min_thickness_mm: 24,
      verified_fields: ["rotor_front_min_thickness_mm"],
    });

    await t.mutation(patchConfig, {
      vehicle_config_id: id,
      rotor_front_min_thickness_mm: 22,
      rotor_rear_min_thickness_mm: 9,
      rotor_front_nominal_thickness_mm: 26,
    });

    const cfg = await read(t, id);
    expect(cfg.rotor_front_min_thickness_mm).toBe(24); // protected
    expect(cfg.rotor_rear_min_thickness_mm).toBe(9); // free
    expect(cfg.rotor_front_nominal_thickness_mm).toBe(26); // free
  });

  test("also protects the fields that were being clobbered before this existed", async () => {
    const t = makeT();
    const id = await seedConfig(t, {
      drivetrain: "AWD",
      brake_fluid_capacity_oz: 32,
      ps_fluid_capacity_oz: 24,
      verified_fields: ["drivetrain", "brake_fluid_capacity_oz"],
    });

    await t.mutation(patchConfig, {
      vehicle_config_id: id,
      drivetrain: "FWD",
      brake_fluid_capacity_oz: 16,
      ps_fluid_capacity_oz: 20,
    });

    const cfg = await read(t, id);
    expect(cfg.drivetrain).toBe("AWD");
    expect(cfg.brake_fluid_capacity_oz).toBe(32);
    expect(cfg.ps_fluid_capacity_oz).toBe(20); // not verified, so it moves
  });

  test("with no verified_fields the pipeline writes freely", async () => {
    const t = makeT();
    const id = await seedConfig(t, { rotor_front_min_thickness_mm: 24 });

    await t.mutation(patchConfig, {
      vehicle_config_id: id,
      rotor_front_min_thickness_mm: 22,
    });

    expect((await read(t, id)).rotor_front_min_thickness_mm).toBe(22);
  });

  test("rotor columns round-trip through the pipeline writer", async () => {
    const t = makeT();
    const id = await seedConfig(t);

    await t.mutation(patchConfig, {
      vehicle_config_id: id,
      rotor_front_min_thickness_mm: 24,
      rotor_rear_min_thickness_mm: 9,
      rotor_front_nominal_thickness_mm: 26,
      rotor_rear_nominal_thickness_mm: 10.5,
      rotor_front_min_quality: "oem_spec",
      rotor_rear_min_quality: "oem_spec",
      rotor_min_source_url: "https://subaru.oempartsonline.com/x",
      rotor_min_observed_label: "Minimum Thickness",
    });

    const cfg = await read(t, id);
    expect(cfg.rotor_front_min_thickness_mm).toBe(24);
    expect(cfg.rotor_rear_nominal_thickness_mm).toBe(10.5);
    expect(cfg.rotor_min_observed_label).toBe("Minimum Thickness");
  });
});
