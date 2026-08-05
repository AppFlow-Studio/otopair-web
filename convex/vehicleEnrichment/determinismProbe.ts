/**
 * vehicleEnrichment/determinismProbe.ts — P2.1 determinism probe harness.
 *
 * WHY: the variant-identification program (reports/variant_identification_scope_
 * 2026-07-21.md) exists because the SAME VIN produced DIFFERENT enrichment on
 * different runs — the Wrangler's transmission fluid came back ZF-ATF on one run
 * and ATF+4 on the next. Every gate since then (variant fingerprint, prompt
 * anchoring, role identity, refute quarantine) has been a patch against that
 * instability, and NONE of them measured it. determinismGate.ts already reduces
 * an enriched config to a normalized `coreSignature` and diffs N of them
 * (`compareSignatures`); what was missing was the thing that actually RUNS one
 * VIN N times and collects those signatures. This file is that orchestration.
 *
 * WHY IT IS A SCHEDULER CHAIN, NOT A LOOP: a Convex action is capped at 600s and
 * one enrichment takes 15-20 MINUTES. A blocking `for (run of runs)` loop cannot
 * exist here. Instead:
 *
 *     startProbe ──► kick run #1 ──► pollProbe ──┐
 *                                       ▲        │ (every 60s, self-rescheduled)
 *                                       └────────┘
 *                       run complete ──► harvest coreSignature
 *                                    ──► kick run #k+1  (STRICTLY SEQUENTIAL)
 *                       last run     ──► compareSignatures ──► finalize
 *
 * Runs are never parallel: two concurrent runs on one vehicle_config race the
 * poll-chain write fence (runFence.shouldAbortChain) and one of them gets
 * aborted mid-write — which would corrupt the very measurement we are taking.
 *
 * COST: each run is a full enrichment (real LLM + web-search spend, ~20 min).
 * A 3-run probe is ~1 hour of wall clock. Nothing here starts automatically —
 * there is no cron, no trigger; a human runs startProbe by hand.
 *
 * HOW TO RUN (human, deliberately):
 *   npx convex run vehicleEnrichment/determinismProbe:startProbe \
 *     '{"vin":"<REAL_VIN>","runs":3,"label":"wrangler-ecodiesel"}'
 *   npx convex run vehicleEnrichment/determinismProbe:report '{"vin":"<REAL_VIN>"}'
 *
 * SENTINEL VINS: see SENTINEL_VINS below — the intended probe set is documented,
 * the VINs are deliberately left NULL for a human to fill in with real vehicles.
 * Fake VINs would decode to garbage and burn a run proving nothing.
 *
 * Ownership note: the pure decision core (nextProbeStep / classifyRunPhase /
 * summarizeProbe) is exported and unit-tested in tests/determinismProbe.test.ts —
 * no live enrichment is needed to test the orchestration logic.
 */

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  coreSignature,
  compareSignatures,
  type CoreSignature,
} from "./determinismGate";
import {
  RUN_IN_PROGRESS_STATUSES,
  LIVE_WINDOW_MS,
  lastActivityMs,
} from "./runFence";

// ═══════════════════════════════════════════════════════════════════
// PURE DECISION CORE (no IO — unit-tested)
// ═══════════════════════════════════════════════════════════════════

/** Poll cadence of the self-rescheduling chain. */
export const POLL_INTERVAL_MS = 60_000;
/** Delay before the first poll of a freshly-kicked run. */
export const FIRST_POLL_DELAY_MS = 60_000;
/** Hard cap per run: 90 polls x 60s = 90 minutes. A run that hangs past this
 *  kills the probe instead of rescheduling forever (an enrichment that has not
 *  reached a terminal status in 90 min is dead — the reaper's REAP_MS is 30). */
export const MAX_POLL_ATTEMPTS_PER_RUN = 90;

export const DEFAULT_TARGET_RUNS = 3;
export const MIN_TARGET_RUNS = 2; // 1 run measures nothing
export const MAX_TARGET_RUNS = 5; // 5 x 20 min x full LLM spend is already a lot

/** Config statuses that mean the finalize pass has settled. The pipeline marks
 *  the RUN "complete" BEFORE it patches the config's terminal status, so a
 *  harvest in that window can read a half-written config. */
export const CONFIG_SETTLED_STATUSES: readonly string[] = ["complete", "partial"];

/** What the enrichment run we are waiting on is doing.
 *  - absent:         no run row for this probe's run yet (kick not landed)
 *  - in_progress:    running, or complete-but-config-not-settled
 *  - complete:       terminal success, data settled — harvest now
 *  - terminal_other: failed / timeout / anything else terminal */
export type RunPhase = "absent" | "in_progress" | "complete" | "terminal_other";

/**
 * Classify the run we are waiting on.
 *
 * "timeout" is deliberately NOT treated as a completed run: a batch-2 timeout
 * finalizes with batch-1 data only, so its signature is missing whole fields.
 * Diffing that against a full run reports a "variance" that is really a
 * coverage gap — a present-but-wrong determinism defect, which is exactly the
 * class of error this program is not allowed to introduce. A degraded run
 * fails the probe instead; the human re-runs it.
 */
export function classifyRunPhase(
  runStatus: string | null | undefined,
  configStatus: string | null | undefined,
): RunPhase {
  if (!runStatus) return "absent";
  if (RUN_IN_PROGRESS_STATUSES.includes(runStatus)) return "in_progress";
  if (runStatus === "complete") {
    return CONFIG_SETTLED_STATUSES.includes(configStatus ?? "") ? "complete" : "in_progress";
  }
  return "terminal_other";
}

/** The run-side state the step function reasons over. "none" means nothing is
 *  in flight — either the probe has not kicked yet, or the run that just
 *  finished has ALREADY been harvested into `signatures`. */
export type CurrentRun = "none" | "pending" | "failed";

export interface ProbeStepInput {
  /** determinism_probes.status — "running" | "complete" | "failed". */
  status: string;
  /** determinism_probes.target_runs. */
  target_runs: number;
  /** How many signatures have been harvested so far (signatures.length). */
  signatures: number;
  /** State of the run currently being waited on. */
  current_run: CurrentRun;
  /** Poll attempts spent on the CURRENT run (resets when a run is kicked). */
  attempts: number;
  /** Hard cap for `attempts`. */
  max_attempts: number;
}

export type ProbeAction = "start-next-run" | "keep-polling" | "finalize" | "give-up";

export interface ProbeStep {
  action: ProbeAction;
  /** Machine-readable justification — written into determinism_probes.notes. */
  reason: string;
  /** 0-based index of the run to start (start-next-run only). */
  runIndex?: number;
}

/**
 * The whole orchestration contract, in one pure function.
 *
 * Order matters:
 *  1. a probe that is no longer "running" stops the chain (never rewrites a
 *     terminal probe — a second chain tick must not clobber a finished result);
 *  2. target reached ⇒ finalize, and this outranks BOTH the failure and the
 *     attempt-cap checks so a probe that harvested its last signature on the
 *     final allowed tick still finalizes;
 *  3. a dead/degraded run ⇒ give up (the measurement is unusable);
 *  4. the attempt cap ⇒ give up (a hung run can't loop forever);
 *  5. nothing in flight ⇒ start the next run (strictly sequential — this is the
 *     ONLY place a run is kicked, and it can only fire when current_run is
 *     "none", so two runs can never overlap);
 *  6. otherwise keep polling.
 */
export function nextProbeStep(probe: ProbeStepInput): ProbeStep {
  if (probe.status !== "running") {
    return { action: "give-up", reason: `probe_not_running:${probe.status}` };
  }
  if (!Number.isFinite(probe.target_runs) || probe.target_runs < MIN_TARGET_RUNS) {
    return { action: "give-up", reason: `invalid_target_runs:${probe.target_runs}` };
  }
  if (probe.signatures >= probe.target_runs) {
    return { action: "finalize", reason: `target_runs_reached:${probe.signatures}/${probe.target_runs}` };
  }
  if (probe.current_run === "failed") {
    return { action: "give-up", reason: `run_failed:after_${probe.signatures}_runs` };
  }
  if (probe.attempts >= probe.max_attempts) {
    return { action: "give-up", reason: `attempt_cap_exceeded:${probe.attempts}/${probe.max_attempts}` };
  }
  if (probe.current_run === "none") {
    return {
      action: "start-next-run",
      reason: `start_run_${probe.signatures + 1}_of_${probe.target_runs}`,
      runIndex: probe.signatures,
    };
  }
  return { action: "keep-polling", reason: `waiting_run_${probe.signatures + 1}:attempt_${probe.attempts}` };
}

export interface ProbeSummary {
  deterministic: boolean;
  /** Sorted for stable storage/diffing — compareSignatures iterates a Set. */
  varied_fields: string[];
  runs: number;
  fields_compared: number;
  /** Human line for determinism_probes.notes. */
  headline: string;
}

/** Reduce N harvested signatures to the stored verdict. Wraps the P5 gate so
 *  the probe never re-implements comparison semantics. */
export function summarizeProbe(signatures: CoreSignature[]): ProbeSummary {
  const report = compareSignatures(signatures);
  const varied_fields = report.varied.map((x) => x.field).sort();
  return {
    deterministic: report.deterministic,
    varied_fields,
    runs: report.runs,
    fields_compared: report.fieldsCompared,
    headline: report.deterministic
      ? `deterministic across ${report.runs} runs (${report.fieldsCompared} fields compared)`
      : `NONDETERMINISTIC across ${report.runs} runs — ${varied_fields.length} varied field(s): ${varied_fields.join(", ")}`,
  };
}

/** determinism_probes.signatures is an array of STRINGS (schema) — a signature
 *  is stored as canonical JSON with sorted keys so a byte-diff of the stored
 *  rows is meaningful on its own. */
export function encodeSignature(sig: CoreSignature): string {
  const sorted: CoreSignature = {};
  for (const k of Object.keys(sig).sort()) sorted[k] = sig[k];
  return JSON.stringify(sorted);
}

/** Tolerant decode: an unparseable row is dropped (and the count difference is
 *  surfaced in notes) rather than throwing away the whole probe. */
export function decodeSignatures(raw: readonly string[]): CoreSignature[] {
  const out: CoreSignature[] = [];
  for (const s of raw) {
    try {
      const parsed = JSON.parse(s);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) out.push(parsed as CoreSignature);
    } catch {
      /* dropped — reported by the caller */
    }
  }
  return out;
}

/** Mirror of the runPublic:purgeAndRerun live-chain guard: a run that is still
 *  in an in-progress status AND has recent activity owns the config right now.
 *  Kicking into that would race the write fence. */
export function isLiveRun(
  run: { status: string; _creationTime: number; started_at?: number | null; last_heartbeat_at?: number | null } | null | undefined,
  nowMs: number,
): boolean {
  if (!run) return false;
  if (!RUN_IN_PROGRESS_STATUSES.includes(run.status)) return false;
  return nowMs - lastActivityMs(run) < LIVE_WINDOW_MS;
}

export function clampTargetRuns(runs: number | undefined): number {
  const n = Math.round(runs ?? DEFAULT_TARGET_RUNS);
  if (!Number.isFinite(n)) return DEFAULT_TARGET_RUNS;
  return Math.min(MAX_TARGET_RUNS, Math.max(MIN_TARGET_RUNS, n));
}

// ═══════════════════════════════════════════════════════════════════
// SENTINEL PROBE SET
// ═══════════════════════════════════════════════════════════════════

export interface SentinelVin {
  label: string;
  /** DELIBERATELY NULL. Fill with a REAL VIN before probing — a fabricated VIN
   *  decodes to garbage and burns a 20-minute run proving nothing. */
  vin: string | null;
  note: string;
}

/**
 * The three vehicles this harness was built to measure. Chosen so that a green
 * result means something: two known-unstable classes plus a control that should
 * never vary. VINs are left null on purpose — a human fills them in.
 */
export const SENTINEL_VINS: readonly SentinelVin[] = [
  {
    label: "wrangler-ecodiesel",
    vin: null,
    note:
      "Diesel-in-a-gas-nameplate. The original defect: the same VIN returned " +
      "ZF-ATF on one run and ATF+4 on the next, and diesel/gas confusion drove " +
      "phantom spark plugs. Watch trans:fluid, engine:fuel, engine:spark_plug_qty.",
  },
  {
    label: "badge-engineered",
    vin: null,
    note:
      "A vehicle built by a different manufacturer than its badge (e.g. the " +
      "Yaris built by Mazda). Extraction flipped between the badge make's parts " +
      "and the builder's. Watch engine:code and every part:* role.",
  },
  {
    label: "camry-control",
    vin: null,
    note:
      "Plain, high-volume, abundantly documented — the control. If THIS varies, " +
      "the nondeterminism is in the pipeline itself, not in thin source coverage.",
  },
];

// ═══════════════════════════════════════════════════════════════════
// STORAGE (determinism_probes) — internal to this module
// ═══════════════════════════════════════════════════════════════════

export const _getProbe = internalQuery({
  args: { probeId: v.id("determinism_probes") },
  handler: async (ctx, args) => await ctx.db.get(args.probeId),
});

export const _runningProbeForVin = internalQuery({
  args: { vin: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("determinism_probes")
      .withIndex("by_vin", (q) => q.eq("vin", args.vin))
      .collect();
    return rows.find((r) => r.status === "running") ?? null;
  },
});

export const _probesForVin = internalQuery({
  args: { vin: v.string() },
  handler: async (ctx, args) =>
    await ctx.db
      .query("determinism_probes")
      .withIndex("by_vin", (q) => q.eq("vin", args.vin))
      .collect(),
});

export const _insertProbe = internalMutation({
  args: {
    vin: v.string(),
    label: v.optional(v.string()),
    target_runs: v.number(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"determinism_probes">> =>
    await ctx.db.insert("determinism_probes", {
      vin: args.vin,
      label: args.label,
      target_runs: args.target_runs,
      signatures: [],
      run_ids: [],
      status: "running",
      started_at: Date.now(),
      notes: args.notes,
    }),
});

/** Keep notes bounded — this is an append-only human log, not a data channel. */
const MAX_NOTE_LINES = 40;
function appendNote(existing: string | undefined, line: string): string {
  const lines = (existing ? existing.split("\n") : []).concat(
    `${new Date().toISOString()} ${line}`,
  );
  return lines.slice(-MAX_NOTE_LINES).join("\n");
}

export const _appendRunResult = internalMutation({
  args: {
    probeId: v.id("determinism_probes"),
    signature: v.string(),
    runId: v.string(),
    note: v.string(),
  },
  handler: async (ctx, args): Promise<string[]> => {
    const probe = await ctx.db.get(args.probeId);
    if (!probe) throw new Error(`determinism probe ${args.probeId} is gone`);
    const signatures = [...probe.signatures, args.signature];
    await ctx.db.patch(args.probeId, {
      signatures,
      run_ids: [...(probe.run_ids ?? []), args.runId],
      notes: appendNote(probe.notes, args.note),
    });
    return signatures;
  },
});

export const _noteProbe = internalMutation({
  args: { probeId: v.id("determinism_probes"), note: v.string() },
  handler: async (ctx, args) => {
    const probe = await ctx.db.get(args.probeId);
    if (!probe) return;
    await ctx.db.patch(args.probeId, { notes: appendNote(probe.notes, args.note) });
  },
});

export const _finalizeProbe = internalMutation({
  args: {
    probeId: v.id("determinism_probes"),
    deterministic: v.boolean(),
    varied_fields: v.array(v.string()),
    note: v.string(),
  },
  handler: async (ctx, args) => {
    const probe = await ctx.db.get(args.probeId);
    if (!probe) return;
    // Never rewrite a probe that already reached a terminal state — a duplicate
    // chain tick must not flip a recorded verdict.
    if (probe.status !== "running") return;
    await ctx.db.patch(args.probeId, {
      status: "complete",
      deterministic: args.deterministic,
      varied_fields: args.varied_fields,
      completed_at: Date.now(),
      notes: appendNote(probe.notes, args.note),
    });
  },
});

export const _failProbe = internalMutation({
  args: { probeId: v.id("determinism_probes"), reason: v.string() },
  handler: async (ctx, args) => {
    const probe = await ctx.db.get(args.probeId);
    if (!probe) return;
    if (probe.status !== "running") return;
    await ctx.db.patch(args.probeId, {
      status: "failed",
      completed_at: Date.now(),
      notes: appendNote(probe.notes, `FAILED: ${args.reason}`),
    });
  },
});

// ═══════════════════════════════════════════════════════════════════
// HELPERS (IO)
// ═══════════════════════════════════════════════════════════════════

/** Resolve the vehicle_config this VIN's enrichment writes to. Re-resolved on
 *  every tick: purgeAndRerun keeps the config row (it only resets its status),
 *  but a first-ever `go` creates the vehicle and config mid-probe. */
async function resolveConfigId(ctx: any, vin: string): Promise<Id<"vehicle_configs"> | null> {
  const vehicle: any = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getVehicleByVin, { vin });
  return (vehicle?.vehicle_config_id as Id<"vehicle_configs"> | undefined) ?? null;
}

/**
 * Kick ONE enrichment run for this VIN, fire-and-forget.
 *
 * Entry points (both are the EXISTING admin ones — the probe adds no new way to
 * trigger enrichment):
 *  - config exists  → runPublic:purgeAndRerun, so every run starts from a wiped
 *    config instead of measuring a cache hit. It also carries the live-run
 *    refusal we want.
 *  - no config yet  → runPublic:go (purgeAndRerun falls through to `go` anyway;
 *    calling it directly skips a redundant decode).
 *
 * Scheduled, never awaited: `go` polls internally for up to 20 minutes and will
 * be killed at the action cap. That is harmless and EXPECTED — `go` schedules
 * enrichVehicleBatchV3 before it starts polling, and that scheduled job is
 * independent of the caller. Expect a killed/failed `go` in the Convex logs
 * roughly 10 minutes after each kick; the enrichment itself carries on.
 */
async function kickRun(ctx: any, vin: string, hasConfig: boolean): Promise<string> {
  if (hasConfig) {
    await ctx.scheduler.runAfter(0, internal.vehicleEnrichment.runPublic.purgeAndRerun, { vin });
    return "purgeAndRerun";
  }
  await ctx.scheduler.runAfter(0, internal.vehicleEnrichment.runPublic.go, { vin });
  return "go";
}

/**
 * Harvest the enriched state as a core signature.
 *
 * runPublic:b8collect is the existing non-polling harvester and already
 * assembles exactly the shape determinismGate expects (including the
 * refute_flagged carry that lets coreSignature prefer an unflagged rival). The
 * signature is recomputed here from those raw pieces rather than trusting
 * b8collect's own `core_signature`, so this file's measurement is explicitly
 * `coreSignature(...)` of the harvested data.
 */
async function harvestSignature(ctx: any, vin: string): Promise<CoreSignature | null> {
  const collected: any = await ctx.runAction(internal.vehicleEnrichment.runPublic.b8collect, { vin });
  if (!collected || collected.status === "no_vehicle" || collected.status === "no_config") return null;
  if (collected.engine == null && collected.transmission == null && !(collected.parts?.length)) {
    return (collected.core_signature as CoreSignature) ?? null;
  }
  return coreSignature({
    engine: collected.engine ?? null,
    transmission: collected.transmission ?? null,
    drivetrain: collected.drivetrain ?? null,
    parts: collected.parts ?? [],
  });
}

/**
 * Route a nondeterministic probe into the manual review queue.
 *
 * NOTE ON THE TABLE: the `manual_review_queue` TABLE is deprecated (see the
 * header of convex/schema.ts and convex/manual_review_queue.ts) — the queue is
 * now a VIEW over enrichment_runs: `manual_review_queue.list` surfaces any run
 * carrying a non-"info" structured sanity_flag. So "insert a review row" here
 * means: append a structured flag to the probe's LAST enrichment run, via the
 * same existing writer the finalize gates use (v3mutations:updateEnrichmentRun).
 * `stage` is deliberately omitted — that taxonomy belongs to the late finalize
 * gates in utils/lateSanityFlags.ts and this is not one of them.
 */
async function flagVarianceForReview(
  ctx: any,
  probeId: Id<"determinism_probes">,
  vin: string,
  runIds: readonly string[],
  variedFields: readonly string[],
): Promise<boolean> {
  const runId = runIds[runIds.length - 1];
  if (!runId) return false;
  let run: any = null;
  try {
    run = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getEnrichmentRunById, {
      runId: runId as Id<"enrichment_runs">,
    });
  } catch {
    return false;
  }
  if (!run) return false;
  const shown = variedFields.slice(0, 12);
  const suffix = variedFields.length > shown.length ? `,+${variedFields.length - shown.length}_more` : "";
  try {
    await ctx.runMutation(internal.vehicleEnrichment.v3mutations.updateEnrichmentRun, {
      run_id: runId as Id<"enrichment_runs">,
      sanity_flags: [
        ...(run.sanity_flags ?? []),
        {
          field: "__determinism_probe",
          severity: "flag",
          reason: `determinism_varied:${shown.join(",")}${suffix}`,
          value: `${vin} probe:${probeId}`,
        },
      ],
    });
    return true;
  } catch (e) {
    console.error(`[probe] review-queue flag failed for run ${runId}:`, e);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// ACTIONS — the scheduler chain
// ═══════════════════════════════════════════════════════════════════

/**
 * Start a determinism probe. Inserts the probe row, kicks run #1, and hands the
 * rest to the self-rescheduling poller.
 *
 * COSTS REAL MONEY: `runs` full enrichments, ~20 min each.
 *   npx convex run vehicleEnrichment/determinismProbe:startProbe \
 *     '{"vin":"1C4HJXFG1LW000000","runs":3,"label":"wrangler-ecodiesel"}'
 */
export const startProbe = internalAction({
  args: {
    vin: v.string(),
    runs: v.optional(v.number()),
    label: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    const vin = args.vin.toUpperCase().trim();
    const targetRuns = clampTargetRuns(args.runs);

    // One probe per VIN at a time — two probes would interleave purges on the
    // same config and both measurements would be garbage.
    const running: any = await ctx.runQuery(
      internal.vehicleEnrichment.determinismProbe._runningProbeForVin,
      { vin },
    );
    if (running) {
      console.warn(`[probe] REFUSED: probe ${running._id} already running for ${vin}`);
      return { status: "refused_probe_running", probeId: running._id, vin };
    }

    // Same guard runPublic:purgeAndRerun applies — never kick into a live chain.
    const configId = await resolveConfigId(ctx, vin);
    let lastSeenRunId: string | undefined;
    if (configId) {
      const latest: any = await ctx.runQuery(
        internal.vehicleEnrichment.v3queries.getLatestRunForConfig,
        { vehicleConfigId: configId },
      );
      if (isLiveRun(latest, Date.now())) {
        console.warn(`[probe] REFUSED: live run ${latest._id} (${latest.status}) on ${vin}`);
        return { status: "refused_live_run", runId: latest._id, vin };
      }
      lastSeenRunId = latest?._id;
    }

    const probeId: Id<"determinism_probes"> = await ctx.runMutation(
      internal.vehicleEnrichment.determinismProbe._insertProbe,
      {
        vin,
        label: args.label,
        target_runs: targetRuns,
        notes: `probe start: ${targetRuns} runs of ${vin}`,
      },
    );

    const entryPoint = await kickRun(ctx, vin, configId != null);
    await ctx.runMutation(internal.vehicleEnrichment.determinismProbe._noteProbe, {
      probeId,
      note: `run 1/${targetRuns} kicked via ${entryPoint}`,
    });

    await ctx.scheduler.runAfter(
      FIRST_POLL_DELAY_MS,
      internal.vehicleEnrichment.determinismProbe.pollProbe,
      { probeId, attempt: 0, lastSeenRunId },
    );

    console.log(`[probe] ${probeId} started — ${targetRuns} runs of ${vin} via ${entryPoint}`);
    return {
      status: "started",
      probeId,
      vin,
      label: args.label ?? null,
      target_runs: targetRuns,
      entry_point: entryPoint,
      poll_interval_s: POLL_INTERVAL_MS / 1000,
      max_minutes_per_run: (MAX_POLL_ATTEMPTS_PER_RUN * POLL_INTERVAL_MS) / 60_000,
      note: "each run is a full enrichment (~20 min, real LLM spend); runs are strictly sequential",
    };
  },
});

/**
 * The chain tick. Reads the run we are waiting on, harvests a signature when it
 * lands, then does exactly what nextProbeStep says: start the next run, keep
 * polling, finalize, or give up.
 *
 * `attempt`/`currentRunId`/`lastSeenRunId` are carried in the scheduler args —
 * the probe ROW holds durable results only, so a restart can't lose chain state.
 * Callable by hand as pollProbe({probeId}) to force a tick.
 */
export const pollProbe = internalAction({
  args: {
    probeId: v.id("determinism_probes"),
    /** Polls already spent on the current run. */
    attempt: v.optional(v.number()),
    /** The enrichment_run this tick is waiting on, once identified. */
    currentRunId: v.optional(v.string()),
    /** The run that existed BEFORE the current kick — seeing it again means our
     *  run has not started yet (e.g. purgeAndRerun refused). Never harvested. */
    lastSeenRunId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    const attempt = args.attempt ?? 0;
    const probe: any = await ctx.runQuery(
      internal.vehicleEnrichment.determinismProbe._getProbe,
      { probeId: args.probeId },
    );
    if (!probe) {
      console.warn(`[probe] ${args.probeId} is gone — chain stops`);
      return;
    }
    if (probe.status !== "running") {
      console.log(`[probe] ${args.probeId} is ${probe.status} — chain stops`);
      return;
    }

    const vin: string = probe.vin;
    let currentRunId = args.currentRunId;
    let lastSeenRunId = args.lastSeenRunId;

    // ── observe the run ────────────────────────────────────────────
    let phase: RunPhase = "absent";
    let runStatus: string | null = null;
    const configId = await resolveConfigId(ctx, vin);
    if (configId) {
      let run: any = null;
      if (currentRunId) {
        try {
          run = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getEnrichmentRunById, {
            runId: currentRunId as Id<"enrichment_runs">,
          });
        } catch {
          run = null;
        }
        if (!run) {
          // Our run row was purged out from under us — someone else is driving
          // this config. The measurement is void.
          phase = "terminal_other";
          runStatus = "run_missing";
        }
      } else {
        const latest: any = await ctx.runQuery(
          internal.vehicleEnrichment.v3queries.getLatestRunForConfig,
          { vehicleConfigId: configId },
        );
        if (latest && latest._id !== lastSeenRunId) {
          run = latest;
          currentRunId = latest._id;
        }
      }
      if (run) {
        const config: any = await ctx.runQuery(
          internal.vehicleEnrichment.v3queries.getVehicleConfigById,
          { vehicleConfigId: configId },
        );
        runStatus = run.status;
        phase = classifyRunPhase(run.status, config?.enrichment_status);
      }
    }

    // ── harvest a completed run BEFORE deciding ────────────────────
    let signatureCount: number = probe.signatures.length;
    let signatures: string[] = probe.signatures;
    let runIds: string[] = [...(probe.run_ids ?? [])];
    let currentRun: CurrentRun = "pending";
    if (phase === "complete" && currentRunId && runIds.includes(currentRunId)) {
      // Already harvested — a duplicate tick (someone ran pollProbe by hand
      // alongside the live chain) must not append the same run twice.
      lastSeenRunId = currentRunId;
      currentRunId = undefined;
      currentRun = "none";
    } else if (phase === "complete" && currentRunId) {
      const sig = await harvestSignature(ctx, vin);
      if (!sig) {
        await ctx.runMutation(internal.vehicleEnrichment.determinismProbe._failProbe, {
          probeId: args.probeId,
          reason: `harvest_failed_run_${signatureCount + 1}`,
        });
        console.error(`[probe] ${args.probeId} harvest failed for ${vin}`);
        return;
      }
      signatures = await ctx.runMutation(
        internal.vehicleEnrichment.determinismProbe._appendRunResult,
        {
          probeId: args.probeId,
          signature: encodeSignature(sig),
          runId: currentRunId,
          note: `run ${signatureCount + 1}/${probe.target_runs} harvested (run=${currentRunId})`,
        },
      );
      signatureCount = signatures.length;
      runIds = [...runIds, currentRunId];
      lastSeenRunId = currentRunId;
      currentRunId = undefined;
      currentRun = "none";
    } else if (phase === "terminal_other") {
      currentRun = "failed";
    }

    const step = nextProbeStep({
      status: probe.status,
      target_runs: probe.target_runs,
      signatures: signatureCount,
      current_run: currentRun,
      attempts: attempt,
      max_attempts: MAX_POLL_ATTEMPTS_PER_RUN,
    });

    switch (step.action) {
      case "finalize": {
        const decoded = decodeSignatures(signatures);
        const summary = summarizeProbe(decoded);
        const dropped = signatures.length - decoded.length;
        const note =
          `${summary.headline}${dropped > 0 ? ` (${dropped} unreadable signature row(s) dropped)` : ""}`;
        await ctx.runMutation(internal.vehicleEnrichment.determinismProbe._finalizeProbe, {
          probeId: args.probeId,
          deterministic: summary.deterministic,
          varied_fields: summary.varied_fields,
          note,
        });
        console.log(`[probe] ${args.probeId} ${vin}: ${summary.headline}`);
        if (summary.varied_fields.length > 0) {
          const flagged = await flagVarianceForReview(
            ctx,
            args.probeId,
            vin,
            runIds,
            summary.varied_fields,
          );
          await ctx.runMutation(internal.vehicleEnrichment.determinismProbe._noteProbe, {
            probeId: args.probeId,
            note: flagged
              ? "routed to manual review queue (sanity_flag on final run)"
              : "manual review queue NOT flagged — final run row unavailable",
          });
        }
        return;
      }
      case "start-next-run": {
        const runNumber = (step.runIndex ?? 0) + 1;
        // Re-check liveness: never kick a second run into a live chain.
        if (configId) {
          const latest: any = await ctx.runQuery(
            internal.vehicleEnrichment.v3queries.getLatestRunForConfig,
            { vehicleConfigId: configId },
          );
          if (isLiveRun(latest, Date.now())) {
            await ctx.runMutation(internal.vehicleEnrichment.determinismProbe._noteProbe, {
              probeId: args.probeId,
              note: `run ${runNumber} kick deferred — live run ${latest._id} (${latest.status})`,
            });
            await ctx.scheduler.runAfter(
              POLL_INTERVAL_MS,
              internal.vehicleEnrichment.determinismProbe.pollProbe,
              { probeId: args.probeId, attempt: attempt + 1, lastSeenRunId },
            );
            return;
          }
          lastSeenRunId = latest?._id ?? lastSeenRunId;
        }
        const entryPoint = await kickRun(ctx, vin, configId != null);
        await ctx.runMutation(internal.vehicleEnrichment.determinismProbe._noteProbe, {
          probeId: args.probeId,
          note: `run ${runNumber}/${probe.target_runs} kicked via ${entryPoint} (${step.reason})`,
        });
        // attempt resets: the cap is PER RUN.
        await ctx.scheduler.runAfter(
          FIRST_POLL_DELAY_MS,
          internal.vehicleEnrichment.determinismProbe.pollProbe,
          { probeId: args.probeId, attempt: 0, lastSeenRunId },
        );
        return;
      }
      case "keep-polling": {
        await ctx.scheduler.runAfter(
          POLL_INTERVAL_MS,
          internal.vehicleEnrichment.determinismProbe.pollProbe,
          { probeId: args.probeId, attempt: attempt + 1, currentRunId, lastSeenRunId },
        );
        return;
      }
      case "give-up": {
        const detail = runStatus ? `${step.reason} (run_status=${runStatus})` : step.reason;
        await ctx.runMutation(internal.vehicleEnrichment.determinismProbe._failProbe, {
          probeId: args.probeId,
          reason: detail,
        });
        console.error(`[probe] ${args.probeId} ${vin} gave up: ${detail}`);
        return;
      }
    }
  },
});

/**
 * Read a probe's result without touching enrichment.
 *   npx convex run vehicleEnrichment/determinismProbe:report '{"vin":"..."}'
 */
export const report = internalAction({
  args: { vin: v.string() },
  handler: async (ctx, args): Promise<any> => {
    const vin = args.vin.toUpperCase().trim();
    const probes: any[] = await ctx.runQuery(
      internal.vehicleEnrichment.determinismProbe._probesForVin,
      { vin },
    );
    if (probes.length === 0) return { vin, status: "no_probes" };
    const latest = probes.sort((a, b) => b.started_at - a.started_at)[0];
    const summary =
      latest.signatures.length > 1 ? summarizeProbe(decodeSignatures(latest.signatures)) : null;
    return {
      vin,
      probeId: latest._id,
      label: latest.label ?? null,
      status: latest.status,
      runs_done: latest.signatures.length,
      target_runs: latest.target_runs,
      deterministic: latest.deterministic ?? null,
      varied_fields: latest.varied_fields ?? [],
      run_ids: latest.run_ids ?? [],
      headline: summary?.headline ?? null,
      started_at: latest.started_at,
      completed_at: latest.completed_at ?? null,
      notes: latest.notes ?? null,
    };
  },
});

// ═══════════════════════════════════════════════════════════════════
// Wave 4 (Aug 2026): SCHEDULED SENTINEL ROTATION
// ═══════════════════════════════════════════════════════════════════

/**
 * Weekly cron driver. The probe set stays operator-supplied — a fabricated
 * VIN burns a 20-minute run proving nothing (the SENTINEL_VINS law above) —
 * so VINs come from the deployment env, never from code:
 *
 *   DETERMINISM_SENTINEL_VINS="label:VIN,label:VIN,VIN"
 *
 * Unset/empty → census-only no-op (dark by default, like every spending
 * cron). One VIN per firing, rotated by ISO week, at the cheapest
 * meaningful depth (DETERMINISM_PROBE_RUNS, default 2 = MIN_TARGET_RUNS).
 * Cost when lit: runs × one full enrichment per week. startProbe's own
 * guards handle overlap (refuses a running probe / a live chain), and
 * variance still lands in the review queue via flagVarianceForReview.
 */
export const runScheduledProbe = internalAction({
  args: {},
  handler: async (ctx): Promise<any> => {
    const raw = (process.env.DETERMINISM_SENTINEL_VINS ?? "").trim();
    if (!raw) {
      console.log(
        "[probe-cron] DETERMINISM_SENTINEL_VINS unset — skipping (set 'label:VIN,…' to enable)",
      );
      return { status: "skipped", reason: "no_sentinel_vins" };
    }
    const sentinels = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((entry) => {
        const i = entry.indexOf(":");
        return i > 0
          ? { label: entry.slice(0, i).trim(), vin: entry.slice(i + 1).trim() }
          : { label: entry, vin: entry };
      })
      .filter((s) => s.vin.length >= 11);
    if (sentinels.length === 0) {
      return { status: "skipped", reason: "no_valid_vins" };
    }
    const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    const pick = sentinels[Math.floor(Date.now() / WEEK_MS) % sentinels.length];
    const runs = Math.max(
      MIN_TARGET_RUNS,
      Math.min(MAX_TARGET_RUNS, Number(process.env.DETERMINISM_PROBE_RUNS ?? "2")),
    );
    console.log(
      `[probe-cron] rotating sentinel this week: ${pick.label} (${runs} runs)`,
    );
    // Scheduled, not awaited — the probe is a self-rescheduling chain that
    // outlives any single action budget.
    await ctx.scheduler.runAfter(
      0,
      internal.vehicleEnrichment.determinismProbe.startProbe,
      { vin: pick.vin, runs, label: `cron:${pick.label}` },
    );
    return { status: "scheduled", sentinel: pick.label, runs };
  },
});
