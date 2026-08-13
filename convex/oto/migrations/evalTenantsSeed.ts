// =============================================================================
// Oto AI — eval-tenant fixture seed + teardown
// =============================================================================
//
// Sprint 1 Day 4 (2026-05-16). Owner: Memory Systems Engineer.
//
// CRITICAL EXCEPTION DOCUMENTATION
// --------------------------------
// These two internalMutations are the ONE sanctioned exception to the rule
// that the enrichment-owned tables (`makes`, `models`, `trims`, `engines`,
// `chassis_specs`, `vehicle_configs`, `trim_specs`, ...) are pipeline-only.
// The exception is safe and bounded because:
//
//   1. SENTINEL NAMESPACE — every row this file writes is stamped
//      `make = "EvalTest"` (or attached transitively to a row that traces
//      back to a make named "EvalTest"). `"EvalTest"` is a reserved name
//      that the real enrichment pipeline never produces and that chat tools
//      MUST filter out at read time (see filter-wiring note at the bottom
//      of this file; flagged for Day 5+ wiring).
//
//   2. NO PRODUCTION DATA TOUCH — neither seed nor teardown reads or
//      mutates any row not in the "EvalTest" namespace. Lookups happen by
//      stable composite key (e.g., `make.name === "EvalTest" && model.name
//      === "CrossTenantFixture" && year === 9999`); no full-table scans.
//
//   3. NO vehicle_facts WRITES — this file does NOT write to the v3
//      `vehicle_facts` table or its audit/report siblings. Web-search facts
//      attached to the synthetic config are seeded later (Day 5+) via the
//      standard `recordVehicleFact` helper, which already enforces all the
//      v3 invariants. The CI grep rules (1-5 in scripts/ci/vehicle-facts-grep.sh)
//      remain clean: rule 4 (no embedding writes) does not match this file;
//      rules 1-3 + 5 (vehicle_facts / audit / vehicle_searched_facts) do not
//      apply because we write to none of those tables.
//
//   4. IDEMPOTENT — re-running `seedEvalTenants` looks up by composite key
//      and reuses existing rows. Re-running `teardownEvalTenants` skips
//      missing rows. Both operations are safe to call any number of times.
//
//   5. INTERNAL ONLY — both mutations are `internalMutation`, so they can
//      only be invoked from `internalAction`s or from the
//      `scripts/eval/lib/multiTenantSetup.ts` HTTP-API wrapper (which
//      requires the eval principal's bearer token).
//
// USAGE
// -----
// The TypeScript wrapper in `scripts/eval/lib/multiTenantSetup.ts`
// dispatches these mutations via the standard Convex HTTP action endpoint.
// Do not call from chat code paths, from production tools, or from any
// runtime code that could ever serve a real user.
//
// FILTER WIRING (Sprint 1 Day 5 — landed 2026-05-16)
// ---------------------------------------------------
// Done. Chat-tool read paths in `convex/oto/` now filter EvalTest rows via
// `convex/oto/evalTestFilter.ts` (helpers: isEvalTestMake / isEvalTestMakeName /
// excludeEvalTestVehicleConfig / isEvalTestConfigId). Files patched:
//   * convex/oto/lookupVehicleSpec.ts  — strips EvalTest from `makes` scan
//   * convex/oto/vehicleFacts.ts       — rejects EvalTest after FK walk
//   * convex/oto/vehicleHealth.ts      — rejects EvalTest after FK walk
//   * convex/oto/chat.ts               — guards retrieve_vehicle_facts on
//                                        vehicle_config_id input
// CI grep Rule 6 in scripts/ci/vehicle-facts-grep.sh enforces that any NEW
// moat-table read in convex/oto/ (outside the bypass list) goes through the
// filter helper. Exempt: evalHarness.ts (Wave 1.4 v3 case (d)),
// migrations/, evalTestFilter.ts itself, convex/admin/, vehicleEnrichment/.
// =============================================================================

import { v } from "convex/values";
import { internalMutation } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { getOrCreateMake } from "../../lib/makeKey";

// -----------------------------------------------------------------------------
// Stable composite keys — the synthetic fixture is uniquely addressable by
// these constants alone. Changing them is a breaking change for the eval
// harness; bump them only with QA Lead sign-off.
// -----------------------------------------------------------------------------

const EVAL_SENTINEL_MAKE = "EvalTest";
const EVAL_FIXTURE_MODEL = "CrossTenantFixture";
const EVAL_FIXTURE_YEAR = 9999;
const EVAL_FIXTURE_TRIM_NAME = "Base";
const EVAL_FIXTURE_ENGINE_CODE = "EVAL-I4-1.5T";
const EVAL_FIXTURE_CHASSIS_CODE = "EVAL-CHASSIS-A";
const EVAL_FIXTURE_CONFIG_KEY = `${EVAL_FIXTURE_YEAR}_${EVAL_SENTINEL_MAKE.toLowerCase()}_${EVAL_FIXTURE_MODEL.toLowerCase()}_${EVAL_FIXTURE_TRIM_NAME.toLowerCase()}_1.5l_4cyl_gasoline`;

const TEST_USER_A_EMAIL = "eval-user-a@oto-eval.local";
const TEST_USER_B_EMAIL = "eval-user-b@oto-eval.local";

// Clerk-synthetic ids — these never collide with real Clerk ids (Clerk uses
// `user_<base32>` while we stamp `oto_eval_<role>` here).
const TEST_USER_A_CLERK_ID = "oto_eval_user_a";
const TEST_USER_B_CLERK_ID = "oto_eval_user_b";

// -----------------------------------------------------------------------------
// seedEvalTenants — idempotent fixture seeding.
//
// Returns the SeededTenants shape the TypeScript wrapper expects. Re-running
// looks up existing rows by stable composite key and reuses them.
// -----------------------------------------------------------------------------

export const seedEvalTenants = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    // -- 1. Test users (by email). --------------------------------------------
    const userA = await upsertEvalUser(ctx, {
      email: TEST_USER_A_EMAIL,
      clerkUserId: TEST_USER_A_CLERK_ID,
      first_name: "EvalUser",
      last_name: "A",
      now,
    });
    const userB = await upsertEvalUser(ctx, {
      email: TEST_USER_B_EMAIL,
      clerkUserId: TEST_USER_B_CLERK_ID,
      first_name: "EvalUser",
      last_name: "B",
      now,
    });

    // -- 2. Sentinel `makes` row (key-normalized get-or-create). --------------
    const makeId: Id<"makes"> = await getOrCreateMake(ctx.db, EVAL_SENTINEL_MAKE, {
      slug: "evaltest",
      country: "Synthetic",
      created_at: now,
    });

    // -- 3. Sentinel `models` row (model_id + name). --------------------------
    const existingModel = await ctx.db
      .query("models")
      .withIndex("by_make_id", (q) => q.eq("make_id", makeId))
      .collect();
    const model = existingModel.find((m) => m.name === EVAL_FIXTURE_MODEL);
    const modelId: Id<"models"> =
      model?._id ??
      (await ctx.db.insert("models", {
        make_id: makeId,
        name: EVAL_FIXTURE_MODEL,
        slug: "crosstenantfixture",
        category: "sedan",
        created_at: now,
      }));

    // -- 4. Sentinel `trims` row. ---------------------------------------------
    const existingTrims = await ctx.db
      .query("trims")
      .withIndex("by_model_id", (q) => q.eq("model_id", modelId))
      .collect();
    const trim = existingTrims.find(
      (t) =>
        t.name === EVAL_FIXTURE_TRIM_NAME &&
        t.year_start === EVAL_FIXTURE_YEAR &&
        t.year_end === EVAL_FIXTURE_YEAR,
    );
    const trimId: Id<"trims"> =
      trim?._id ??
      (await ctx.db.insert("trims", {
        model_id: modelId,
        name: EVAL_FIXTURE_TRIM_NAME,
        year_start: EVAL_FIXTURE_YEAR,
        year_end: EVAL_FIXTURE_YEAR,
        steering_type: "electric",
      }));

    // -- 5. Sentinel `engines` row (inline-4 1.5L turbo, realistic shape). ----
    const existingEngines = await ctx.db
      .query("engines")
      .withIndex("by_engine_code", (q) =>
        q.eq("engine_code", EVAL_FIXTURE_ENGINE_CODE),
      )
      .collect();
    const engine = existingEngines[0];
    const engineId: Id<"engines"> =
      engine?._id ??
      (await ctx.db.insert("engines", {
        trim_id: trimId,
        make_id: makeId,
        engine_code: EVAL_FIXTURE_ENGINE_CODE,
        engine_family: "EVAL-FAMILY",
        cylinders: 4,
        configuration: "inline-4",
        displacement_l: 1.5,
        displacement_liters: 1.5,
        aspiration: "turbocharged",
        fuel_type: "gasoline",
        fuel_injection: "direct",
        timing_type: "chain",
        timing_system: "DOHC",
        has_serpentine_belt: true,
        oil_viscosity: "0W-20",
        oil_spec_standard: "API SP",
        oil_capacity_qts: 4.4,
        coolant_type: "OAT",
        coolant_capacity_qts: 6.0,
        spark_plug_quantity: 4,
        spark_plug_gap_mm: 0.7,
        timing_idler_count: 1,
        water_pump_timing_driven: false,
        data_quality: "synthetic_eval",
        last_enriched_at: now,
        created_at: now,
      }));

    // -- 6. Sentinel `chassis_specs` row. -------------------------------------
    const existingChassis = await ctx.db
      .query("chassis_specs")
      .withIndex("by_chassis_code", (q) =>
        q.eq("chassis_code", EVAL_FIXTURE_CHASSIS_CODE),
      )
      .first();
    if (!existingChassis) {
      await ctx.db.insert("chassis_specs", {
        chassis_code: EVAL_FIXTURE_CHASSIS_CODE,
        make_id: makeId,
        brake_fluid_type: "DOT 4",
        brake_fluid_capacity_oz: 32.0,
        ps_fluid_type: "electric",
        ps_fluid_capacity_oz: 0,
        lug_nut_torque_ft_lbs: 89,
        wiper_blade_driver_size_in: 26,
        wiper_blade_passenger_size_in: 18,
        battery_group: "H6",
        battery_location: "engine_bay",
        battery_type: "AGM",
        has_brake_pad_sensor: true,
        steering_type: "electric",
        parking_brake_type: "electronic",
        has_rear_wiper: false,
        cabin_filter_access: "glove_box",
        data_quality: "synthetic_eval",
        confidence_score: 1.0,
        last_enriched_at: now,
        source_url: "https://oto-eval.local/synthetic",
        created_at: now,
      });
    }

    // -- 7. Sentinel `vehicle_configs` row (the join key). --------------------
    const existingConfig = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_config_key", (q) =>
        q.eq("config_key", EVAL_FIXTURE_CONFIG_KEY),
      )
      .first();
    const vehicleConfigId: Id<"vehicle_configs"> =
      existingConfig?._id ??
      (await ctx.db.insert("vehicle_configs", {
        config_key: EVAL_FIXTURE_CONFIG_KEY,
        nhtsa_vin_key: `${EVAL_FIXTURE_YEAR}_${EVAL_SENTINEL_MAKE.toLowerCase()}_${EVAL_FIXTURE_MODEL.toLowerCase()}_${EVAL_FIXTURE_TRIM_NAME.toLowerCase()}_1.5l_4cyl_gasoline`,
        year: EVAL_FIXTURE_YEAR,
        make_id: makeId,
        model_id: modelId,
        trim_name: EVAL_FIXTURE_TRIM_NAME,
        trim_slug: "base",
        engine_id: engineId,
        drivetrain: "FWD",
        has_brake_pad_sensor: true,
        brake_fluid_type: "DOT 4",
        brake_fluid_capacity_oz: 32.0,
        ps_fluid_type: "electric",
        ps_fluid_capacity_oz: 0,
        chassis_code: EVAL_FIXTURE_CHASSIS_CODE,
        enrichment_status: "complete",
        fill_rate: 1.0,
        confidence_avg: 1.0,
        last_enriched_at: now,
        last_verified_at: now,
        enrichment_version: "eval-v3",
        verification_count: 1,
        created_at: now,
      }));

    // -- 8. Sentinel `trim_specs` row tied to the config. ---------------------
    const existingTrimSpec = await ctx.db
      .query("trim_specs")
      .withIndex("by_vehicle_config", (q) =>
        q.eq("vehicle_config_id", vehicleConfigId),
      )
      .first();
    if (!existingTrimSpec) {
      await ctx.db.insert("trim_specs", {
        trim_id: trimId,
        vehicle_config_id: vehicleConfigId,
        tire_size_front: "P205/55R16",
        tire_size_rear: "P205/55R16",
        recommended_tire_pressure_front_psi: 32,
        recommended_tire_pressure_rear_psi: 32,
        is_staggered: false,
        tire_directional: false,
        is_run_flat: false,
        alignment_type: "standard",
        battery_cca: 550,
        has_brake_pad_sensor: true,
        parking_brake_type: "electronic",
        confidence_score: 1.0,
        data_quality: "synthetic_eval",
        created_at: now,
      });
    }

    return {
      user_a_id: userA,
      user_b_id: userB,
      vehicle_config_id: vehicleConfigId,
      make: EVAL_SENTINEL_MAKE,
      model: EVAL_FIXTURE_MODEL,
      year_min: EVAL_FIXTURE_YEAR,
      year_max: EVAL_FIXTURE_YEAR,
      chassis_code: EVAL_FIXTURE_CHASSIS_CODE,
      engine_code: EVAL_FIXTURE_ENGINE_CODE,
    };
  },
});

// -----------------------------------------------------------------------------
// upsertEvalUser — local helper. NOT exported. Idempotent on email.
// -----------------------------------------------------------------------------

async function upsertEvalUser(
  ctx: { db: import("../../_generated/server").MutationCtx["db"] },
  args: {
    email: string;
    clerkUserId: string;
    first_name: string;
    last_name: string;
    now: number;
  },
): Promise<Id<"users">> {
  const existing = await ctx.db
    .query("users")
    .withIndex("by_email", (q) => q.eq("email", args.email))
    .first();
  if (existing) return existing._id;

  return await ctx.db.insert("users", {
    clerkUserId: args.clerkUserId,
    email: args.email,
    emailConfirmed: true,
    first_name: args.first_name,
    last_name: args.last_name,
    auth_provider: "synthetic_eval",
    onboardingCompleted: true,
    tellUsAboutCompleted: true,
    language: "en",
    units: "imperial",
    role: "eval_synthetic",
    createdAt: args.now,
    lastUpdated: args.now,
  });
}

// -----------------------------------------------------------------------------
// teardownEvalTenants — idempotent removal.
//
// Deletes rows by stable composite key in reverse-FK order:
//   trim_specs -> vehicle_configs -> chassis_specs -> engines -> trims ->
//   models -> make -> users
//
// Missing rows are silently skipped.
//
// Note: we never delete a row that did not match our composite key, so even
// if a developer pollutes the EvalTest namespace by hand, this teardown
// removes only the specific synthetic fixture this seed creates.
// -----------------------------------------------------------------------------

export const teardownEvalTenants = internalMutation({
  args: {},
  handler: async (ctx) => {
    // 1. Find the sentinel make.
    const make = await ctx.db
      .query("makes")
      .withIndex("by_name", (q) => q.eq("name", EVAL_SENTINEL_MAKE))
      .first();

    // If no make, there is nothing to clean up.
    if (!make) {
      await deleteEvalUsersIfPresent(ctx);
      return { deleted: 0 };
    }

    let deleted = 0;

    // 2. Find the fixture model.
    const models = await ctx.db
      .query("models")
      .withIndex("by_make_id", (q) => q.eq("make_id", make._id))
      .collect();
    const model = models.find((m) => m.name === EVAL_FIXTURE_MODEL);

    // 3. Walk down from the model if it exists.
    if (model) {
      // 3a. Find vehicle_configs by composite key (year + make_id + model_id).
      const configs = await ctx.db
        .query("vehicle_configs")
        .withIndex("by_make_model_year", (q) =>
          q.eq("make_id", make._id).eq("model_id", model._id).eq("year", EVAL_FIXTURE_YEAR),
        )
        .collect();

      for (const cfg of configs) {
        // 3a-i. Delete trim_specs FK'd to this config.
        const trimSpecs = await ctx.db
          .query("trim_specs")
          .withIndex("by_vehicle_config", (q) =>
            q.eq("vehicle_config_id", cfg._id),
          )
          .collect();
        for (const ts of trimSpecs) {
          await ctx.db.delete(ts._id);
          deleted += 1;
        }
        // 3a-ii. Delete the vehicle_config itself.
        await ctx.db.delete(cfg._id);
        deleted += 1;
      }

      // 3b. Delete trims for the fixture model.
      const trims = await ctx.db
        .query("trims")
        .withIndex("by_model_id", (q) => q.eq("model_id", model._id))
        .collect();
      for (const t of trims) {
        if (
          t.name === EVAL_FIXTURE_TRIM_NAME &&
          t.year_start === EVAL_FIXTURE_YEAR
        ) {
          await ctx.db.delete(t._id);
          deleted += 1;
        }
      }

      // 3c. Delete the model.
      await ctx.db.delete(model._id);
      deleted += 1;
    }

    // 4. Delete engines by sentinel engine_code (FK'd to make).
    const engines = await ctx.db
      .query("engines")
      .withIndex("by_engine_code", (q) =>
        q.eq("engine_code", EVAL_FIXTURE_ENGINE_CODE),
      )
      .collect();
    for (const e of engines) {
      await ctx.db.delete(e._id);
      deleted += 1;
    }

    // 5. Delete chassis_specs by sentinel chassis_code.
    const chassis = await ctx.db
      .query("chassis_specs")
      .withIndex("by_chassis_code", (q) =>
        q.eq("chassis_code", EVAL_FIXTURE_CHASSIS_CODE),
      )
      .collect();
    for (const c of chassis) {
      await ctx.db.delete(c._id);
      deleted += 1;
    }

    // 6. Delete the make.
    await ctx.db.delete(make._id);
    deleted += 1;

    // 7. Delete the eval users.
    deleted += await deleteEvalUsersIfPresent(ctx);

    return { deleted };
  },
});

async function deleteEvalUsersIfPresent(ctx: {
  db: import("../../_generated/server").MutationCtx["db"];
}): Promise<number> {
  let removed = 0;
  for (const email of [TEST_USER_A_EMAIL, TEST_USER_B_EMAIL]) {
    const u = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();
    if (u) {
      await ctx.db.delete(u._id);
      removed += 1;
    }
  }
  return removed;
}
