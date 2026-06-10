/**
 * Stuck-'enriching' failure handler (Jun-9 review items 3 + 6).
 *
 * Contract under test:
 *  - `failEnrichmentRun` marks the enrichment_run terminal AND restores the
 *    vehicle_config to a terminal status in one transaction ('pending' when
 *    batch-1 data was never written this run, 'partial' after) — without
 *    clobbering a config some other path already finalized.
 *  - STEP 0 force-unstick: a director force re-enrich may take over a config
 *    stuck 'enriching' when its latest run shows no liveness (no poll
 *    heartbeat within the live window) — previously unrecoverable for 4h.
 *    A run with a fresh heartbeat stays protected.
 */
import { describe, test, expect } from "vitest";
import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { makeT } from "./helpers";
import { buildEngineKey } from "../convex/vehicleEnrichment/types";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// The action args use a make/model that is NOT seeded in `makes` — so a run
// that gets past the STEP 0 guard exits deterministically at STEP 2 with
// `make_not_found`, proving the guard was bypassed without running the
// scrape/batch machinery.
const PHANTOM = {
  year: 2020,
  make: "Phantommake",
  model: "Phantommodel",
  trim: "Base",
  engineCode: "N63B44O2", // real OEM-style code → STEP 1b resolution skipped
  displacement: "4.4",
};

type SeedOpts = {
  configStatus?: string;
  lastEnrichedAgoMs?: number;
  run?: {
    status: string;
    startedAgoMs: number;
    heartbeatAgoMs?: number;
  } | null;
};

async function seedConfig(t: ReturnType<typeof makeT>, opts: SeedOpts = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const makeId = await ctx.db.insert("makes", { name: "Testmake" });
    const modelId = await ctx.db.insert("models", {
      make_id: makeId,
      name: "Testmodel",
    });
    const engineId = await ctx.db.insert("engines", {
      engine_code: PHANTOM.engineCode,
      make_id: makeId,
    });
    const vehicleId = await ctx.db.insert("vehicles", {
      vin: "WBA7U2C08LGM27817",
      engine_id: engineId,
    });
    const configKey = buildEngineKey({
      vehicleId,
      ...PHANTOM,
    } as any);
    const configId = await ctx.db.insert("vehicle_configs", {
      config_key: configKey,
      year: PHANTOM.year,
      make_id: makeId,
      model_id: modelId,
      engine_id: engineId,
      drivetrain: "AWD",
      trim_name: PHANTOM.trim,
      trim_slug: "base",
      enrichment_status: opts.configStatus ?? "enriching",
      fill_rate: 0,
      last_enriched_at: now - (opts.lastEnrichedAgoMs ?? 30 * MIN),
    });
    let runId: Id<"enrichment_runs"> | null = null;
    if (opts.run) {
      runId = await ctx.db.insert("enrichment_runs", {
        vehicle_config_id: configId,
        status: opts.run.status,
        started_at: now - opts.run.startedAgoMs,
        created_at: now - opts.run.startedAgoMs,
        ...(opts.run.heartbeatAgoMs != null
          ? { last_heartbeat_at: now - opts.run.heartbeatAgoMs }
          : {}),
      });
    }
    return { makeId, modelId, engineId, vehicleId, configId, configKey, runId };
  });
}

describe("failEnrichmentRun", () => {
  test("marks the run failed and restores a stuck config to 'pending'", async () => {
    const t = makeT();
    const { configId, runId } = await seedConfig(t, {
      run: { status: "batch1", startedAgoMs: 30 * MIN },
    });

    await t.mutation(internal.vehicleEnrichment.v3mutations.failEnrichmentRun, {
      run_id: runId!,
      vehicle_config_id: configId,
      run_status: "failed",
      errors: ["batch1_timeout"],
      config_status: "pending",
    });

    const { run, config } = await t.run(async (ctx) => ({
      run: await ctx.db.get(runId!),
      config: await ctx.db.get(configId),
    }));
    expect(run!.status).toBe("failed");
    expect(run!.errors).toEqual(["batch1_timeout"]);
    expect(run!.completed_at).toBeTypeOf("number");
    expect(config!.enrichment_status).toBe("pending");
  });

  test("restores to 'partial' when batch-1 data was already written", async () => {
    const t = makeT();
    const { configId, runId } = await seedConfig(t, {
      run: { status: "batch2", startedAgoMs: 30 * MIN },
    });

    await t.mutation(internal.vehicleEnrichment.v3mutations.failEnrichmentRun, {
      run_id: runId!,
      vehicle_config_id: configId,
      run_status: "failed",
      errors: ["batch2_submission_failed: boom"],
      config_status: "partial",
    });

    const config = await t.run(async (ctx) => ctx.db.get(configId));
    expect(config!.enrichment_status).toBe("partial");
  });

  test("never clobbers a config another path already finalized", async () => {
    const t = makeT();
    const { configId, runId } = await seedConfig(t, {
      configStatus: "complete",
      run: { status: "batch2", startedAgoMs: 30 * MIN },
    });

    await t.mutation(internal.vehicleEnrichment.v3mutations.failEnrichmentRun, {
      run_id: runId!,
      vehicle_config_id: configId,
      run_status: "failed",
      errors: ["batch2_unexpected: boom"],
      config_status: "partial",
    });

    const { run, config } = await t.run(async (ctx) => ({
      run: await ctx.db.get(runId!),
      config: await ctx.db.get(configId),
    }));
    expect(run!.status).toBe("failed"); // run still recorded
    expect(config!.enrichment_status).toBe("complete"); // config untouched
  });
});

describe("STEP 0 force-unstick", () => {
  test("force takes over a stuck config whose latest run is dead (no heartbeat)", async () => {
    const t = makeT();
    // Stuck 30min — well under the 4h stale valve, so pre-fix this was
    // unrecoverable. Latest run looks in-flight ('batch1') but has no
    // heartbeat and started 30min ago → dead chain.
    const { vehicleId, configId, runId } = await seedConfig(t, {
      run: { status: "batch1", startedAgoMs: 30 * MIN },
    });

    const result = await t.action(
      internal.vehicleEnrichment.v3pipeline.enrichVehicleBatchV3,
      { vehicleId, ...PHANTOM, force: true },
    );

    // Got PAST the in-progress guard (and exited at the phantom-make probe).
    expect(result).toEqual({ status: "error", reason: "make_not_found" });

    // The dead run is marked failed so it can never read as live again.
    const run = await t.run(async (ctx) => ctx.db.get(runId!));
    expect(run!.status).toBe("failed");
    expect(run!.errors).toEqual(["superseded_by_force_unstick"]);
  });

  test("force does NOT take over a live run (fresh heartbeat)", async () => {
    const t = makeT();
    const { vehicleId, configId } = await seedConfig(t, {
      run: { status: "batch1", startedAgoMs: 30 * MIN, heartbeatAgoMs: 1 * MIN },
    });

    const result = await t.action(
      internal.vehicleEnrichment.v3pipeline.enrichVehicleBatchV3,
      { vehicleId, ...PHANTOM, force: true },
    );

    expect(result).toEqual({
      status: "already_enriching",
      configId,
    });
  });

  test("non-force signup path still defers to an in-progress config", async () => {
    const t = makeT();
    const { vehicleId, configId } = await seedConfig(t, {
      run: { status: "batch1", startedAgoMs: 30 * MIN },
    });

    const result = await t.action(
      internal.vehicleEnrichment.v3pipeline.enrichVehicleBatchV3,
      { vehicleId, ...PHANTOM },
    );

    expect(result).toEqual({
      status: "already_enriching",
      configId,
    });
  });

  test("the 4h stale valve still fires without force", async () => {
    const t = makeT();
    const { vehicleId } = await seedConfig(t, {
      lastEnrichedAgoMs: 5 * HOUR,
      run: { status: "batch1", startedAgoMs: 5 * HOUR },
    });

    const result = await t.action(
      internal.vehicleEnrichment.v3pipeline.enrichVehicleBatchV3,
      { vehicleId, ...PHANTOM },
    );

    expect(result).toEqual({ status: "error", reason: "make_not_found" });
  });
});
