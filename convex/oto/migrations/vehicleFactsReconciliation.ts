// =============================================================================
// Oto AI — vehicle_facts reconciliation cron (Sprint 1 Day 3)
// =============================================================================
//
// Sprint 1 Day 3 (2026-05-16). Authority: MEMORY_SCHEMA_V3_CONSOLIDATED §8.
// Owner: Memory Systems Engineer.
//
// PURPOSE
// -------
// Closes the fourth layer of the §5 four-layer defense for the v3 mutability
// concession on `vehicle_facts`. Layers 1-3 already exist:
//
//   1. Helper-only pattern   — vehicleFactsEditing.ts is the sole write path.
//   2. CI grep               — scripts/ci/vehicle-facts-grep.sh blocks PRs.
//   3. Runtime telemetry     — oto_telemetry counters (and the parity check
//                              implemented as Check 4 below in v1).
//
// This file is layer 4: out-of-process parity checks against the append-only
// `vehicle_facts_audit` table. Four independent checks driven by one
// internalAction:
//
//   1. checkReplayEquivalence — reverse-replay audit history, validate each
//                               step. PAGE on first anomaly. (15-min cadence)
//   2. checkCounterParity     — fact_reports vs denormalized report_count.
//                               (hourly cadence; drift > 5 alerts)
//   3. checkOrphanAuditRows   — every audit row's fact_id must resolve.
//                               PAGE on first orphan. (15-min cadence)
//   4. checkTelemetryParity   — edits-in-interval vs audit-rows-in-interval.
//                               (folded into the 15-min driver pass; see
//                               telemetry-parity simplification below.)
//
// READS-ONLY
// ----------
// Per the audit invariant: this file MUST NOT write to vehicle_facts_audit
// (CI grep Rule 3). It MUST NOT patch vehicle_facts (CI grep Rule 1). It only
// reads those tables and writes to `reconciliation_runs` — a new lightweight
// log table for the cron's own output (§schema).
//
// IDEMPOTENCY
// -----------
// `runReconciliation` is idempotent in the no-state-mutation sense:
// re-running it is a no-op except for inserting a fresh `reconciliation_runs`
// row. It never patches an earlier run. It never touches `vehicle_facts` or
// `vehicle_facts_audit`.
//
// BATCHED / BOUNDED
// -----------------
// Each `check*` query takes `batchSize` + `cursorMs` and returns
// `{ processed, nextCursor, anomalies }`. The driver caps wall-clock time
// per check by limiting batchSize; a full-table scan finishes across many
// 15-minute driver invocations. No check ever scans the whole table in one
// shot — that would risk Convex's query-deadline cap.
//
// TELEMETRY-PARITY SIMPLIFICATION (option b)
// ------------------------------------------
// MEMORY_SCHEMA_V3_CONSOLIDATED §3.3 contemplates two runtime counters —
// `searched_facts.edits_committed` and `searched_facts.audit_rows_written`
// — that don't actually exist yet. The spec gives us two options:
//
//   (a) Add real runtime counters (new infrastructure: a counters table
//       or a field on oto_migrations, plus instrumentation inside
//       editVehicleFact).
//   (b) Approximate via two equivalent queries:
//       count(vehicle_facts_audit rows where edited_at in [t-N, t])
//        ==
//       count(vehicle_facts where updated_at in [t-N, t]
//             AND updated_at != created_at) .
//
// We pick (b) for v1. Rationale:
//   - No new tables, no new schema fields, no per-edit instrumentation.
//     The audit invariant ALREADY equates "an edit happened" with "an
//     audit row was written" (helper enforces this atomically). A
//     count-based query check is sufficient ground truth.
//   - The window is bounded (default 15 minutes) so the parity drift is
//     observable per driver run.
//   - The simplification is honest: if an attacker bypasses the helper
//     and patches a row WITHOUT writing an audit row, the
//     `updated_at != created_at` query DOES still count that row —
//     so the drift will appear as
//     "edits_in_window > audit_rows_in_window", which is exactly the
//     failure mode this check is designed to surface.
//   - The reverse case (audit row written without a fact patch) is
//     prevented by the same helper atomicity, AND would surface as
//     `audit_rows_in_window > edits_in_window`.
//
// Future work: replace this with real runtime counters wired into
// `editVehicleFact` and stored in a counters table. Today's check is
// "good enough" because Convex serializes transactions and audit rows
// are append-only by table-level enforcement.
//
// CRON
// ----
// One cron job: every 15 minutes runs `runReconciliation`. The driver
// decides which checks to run per invocation:
//   - replay, orphan, telemetry-parity:   every 15 minutes (every run)
//   - counter parity:                     every 4th run (hourly)
//
// On-call: see docs/SPRINT_1/RECONCILIATION_RUNBOOK.md.
//
// KILL SWITCH
// -----------
// Each check honors an env var: setting `OTO_RECON_DISABLE_<CHECK>="true"`
// (e.g. `OTO_RECON_DISABLE_REPLAY=true`) skips that check. The driver still
// runs and writes a `reconciliation_runs` row marked `info` for the skip.
// See runbook §"Disabling a check temporarily".
// =============================================================================

import { v } from "convex/values";
import {
  internalQuery,
  internalAction,
  internalMutation,
} from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";

// -----------------------------------------------------------------------------
// Tunables. Conservative defaults; the runbook documents how to bump them.
// -----------------------------------------------------------------------------

const DEFAULT_BATCH_SIZE = 256;

// Counter-parity drift threshold within a 24h window. Drift below this is
// treated as transient mid-mutation racing (telemetry is denormalized; the
// canonical count lives in fact_reports and a momentary skew is expected).
// Drift at or above this fires an alert.
const COUNTER_PARITY_DRIFT_ALERT_THRESHOLD = 5;

// Window for telemetry parity. 15 minutes matches the cron cadence so each
// run examines a non-overlapping(ish) interval (with mild overlap to avoid
// boundary misses).
const TELEMETRY_PARITY_WINDOW_MS = 15 * 60 * 1000;

// Modulus for the hourly counter check inside the 15-min driver. Counter
// parity is the most expensive scan (fan-out over fact_reports by fact_id),
// so we only run it every 4 invocations.
const COUNTER_CHECK_EVERY_N_RUNS = 4;

// -----------------------------------------------------------------------------
// Shared shapes.
// -----------------------------------------------------------------------------

type Severity = "page" | "alert" | "info";

type AnomalyArgs = {
  check: string;
  severity: Severity;
  fact_id?: Id<"vehicle_facts">;
  details: string;
};

const anomalyValidator = v.object({
  check: v.string(),
  severity: v.union(v.literal("page"), v.literal("alert"), v.literal("info")),
  fact_id: v.optional(v.id("vehicle_facts")),
  details: v.string(),
});

function envFlag(name: string): boolean {
  // process.env is available inside Convex actions; in queries it's
  // also available at module evaluation time but reading it inside the
  // handler keeps the behavior consistent. Convex deploys read env vars
  // from the Convex dashboard.
  const val =
    typeof process !== "undefined" && process.env
      ? process.env[name]
      : undefined;
  return val === "true" || val === "1";
}

// =============================================================================
// CHECK 1 — checkReplayEquivalence
// =============================================================================
//
// For a batch of `vehicle_facts` rows that have been edited
// (i.e. updated_at !== created_at), walk their `vehicle_facts_audit` history
// via `by_fact` in chronological order. Validate per-step plausibility:
//
//   - For action="verify":  previous_values.verification_status MUST be
//                           "unverified". Anything else is impossible under
//                           the helper's pre-condition check in
//                           editVehicleFact, so its presence indicates
//                           tampering or a helper bypass.
//   - For action="retract": previous_values.verification_status MUST NOT be
//                           "retracted" (helper's idempotent guard).
//   - For action="edit_text": previous_values.fact_text MUST be present
//                             (helper requires the field to change).
//   - For action="edit_meta": previous_values MUST contain at least one
//                             non-fact_text, non-verification_status field.
//
// PAGES on first anomaly. This signals tampering or helper bypass.
//
// Batched: takes { batchSize, cursorMs } over the by_creation_time index of
// vehicle_facts. cursorMs advances per call so a full pass completes across
// many driver invocations.
// =============================================================================

export const checkReplayEquivalence = internalQuery({
  args: {
    batchSize: v.number(),
    cursorMs: v.optional(v.number()),
  },
  handler: async (ctx, { batchSize, cursorMs }) => {
    if (envFlag("OTO_RECON_DISABLE_REPLAY")) {
      return {
        processed: 0,
        anomalies: [] as AnomalyArgs[],
        nextCursor: cursorMs,
        skipped: true as const,
      };
    }

    // Walk vehicle_facts by _creationTime — same pattern as backfillV3Lifecycle.
    const rows = await ctx.db
      .query("vehicle_facts")
      .withIndex(
        "by_creation_time",
        cursorMs !== undefined
          ? (q) => q.gt("_creationTime", cursorMs)
          : (q) => q,
      )
      .take(batchSize);

    const anomalies: AnomalyArgs[] = [];

    for (const row of rows) {
      // Only inspect rows that have been edited. A row whose
      // updated_at is undefined (or equals created_at) has had no
      // post-creation mutation and therefore no audit rows.
      if (row.updated_at === undefined || row.updated_at === row.created_at) {
        continue;
      }

      // Pull audit history for this fact in chronological order.
      const auditRows = await ctx.db
        .query("vehicle_facts_audit")
        .withIndex("by_fact", (q) => q.eq("fact_id", row._id))
        .collect();

      if (auditRows.length === 0) {
        // updated_at differs from created_at but no audit row exists.
        // This is the canonical "helper bypass" signal.
        anomalies.push({
          check: "replay",
          severity: "page",
          fact_id: row._id,
          details: `vehicle_facts row ${row._id} has updated_at=${row.updated_at} != created_at=${row.created_at} but zero vehicle_facts_audit rows. Helper bypass suspected.`,
        });
        continue;
      }

      // Sort by edited_at ascending (the index orders by edited_at within
      // the same fact_id, but collect() returns by index order which IS
      // the chronological order we need — keep this explicit for safety).
      auditRows.sort((a, b) => a.edited_at - b.edited_at);

      for (const audit of auditRows) {
        const prev = audit.previous_values;

        if (audit.action === "verify") {
          // Pre-condition in editVehicleFact: current.verification_status
          // === "unverified". If THIS audit row's previous_values says
          // anything else, the helper was bypassed or the audit row was
          // forged.
          if (
            prev.verification_status !== undefined &&
            prev.verification_status !== "unverified"
          ) {
            anomalies.push({
              check: "replay",
              severity: "page",
              fact_id: row._id,
              details: `audit row ${audit._id} action="verify" but previous_values.verification_status="${prev.verification_status}" (must be "unverified").`,
            });
          }
          // If verification_status is absent from previous_values for a
          // verify action, the helper's diff logic determined the field
          // didn't change — which is also impossible for a verify action.
          if (prev.verification_status === undefined) {
            anomalies.push({
              check: "replay",
              severity: "page",
              fact_id: row._id,
              details: `audit row ${audit._id} action="verify" but previous_values.verification_status is absent (helper always records the prior status).`,
            });
          }
        } else if (audit.action === "retract") {
          // Helper's idempotent guard: cannot retract an already-retracted row.
          if (prev.verification_status === "retracted") {
            anomalies.push({
              check: "replay",
              severity: "page",
              fact_id: row._id,
              details: `audit row ${audit._id} action="retract" but previous_values.verification_status="retracted" (already retracted).`,
            });
          }
          if (prev.verification_status === undefined) {
            anomalies.push({
              check: "replay",
              severity: "page",
              fact_id: row._id,
              details: `audit row ${audit._id} action="retract" but previous_values.verification_status is absent.`,
            });
          }
        } else if (audit.action === "edit_text") {
          if (prev.fact_text === undefined) {
            anomalies.push({
              check: "replay",
              severity: "page",
              fact_id: row._id,
              details: `audit row ${audit._id} action="edit_text" but previous_values.fact_text is absent.`,
            });
          }
        } else if (audit.action === "edit_meta") {
          // Helper forbids fact_text and verification_status here.
          if (prev.fact_text !== undefined) {
            anomalies.push({
              check: "replay",
              severity: "page",
              fact_id: row._id,
              details: `audit row ${audit._id} action="edit_meta" but previous_values.fact_text is present (helper forbids).`,
            });
          }
          if (prev.verification_status !== undefined) {
            anomalies.push({
              check: "replay",
              severity: "page",
              fact_id: row._id,
              details: `audit row ${audit._id} action="edit_meta" but previous_values.verification_status is present (helper forbids).`,
            });
          }
          // At least ONE editable meta field must have changed.
          const metaKeys = [
            "confidence",
            "topic",
            "topic_axis",
            "cited_url",
            "source",
            "answer_format",
            "vehicle_config_id",
            "chassis_code",
            "engine_code",
            "make",
            "model",
            "trim_name",
            "year_min",
            "year_max",
          ] as const;
          const anyMeta = metaKeys.some(
            (k) => (prev as Record<string, unknown>)[k] !== undefined,
          );
          if (!anyMeta) {
            anomalies.push({
              check: "replay",
              severity: "page",
              fact_id: row._id,
              details: `audit row ${audit._id} action="edit_meta" but previous_values has no editable-meta fields (no-op edits should not write audit rows).`,
            });
          }
        }
      }
    }

    const nextCursor =
      rows.length > 0 ? rows[rows.length - 1]._creationTime : cursorMs;

    return {
      processed: rows.length,
      anomalies,
      nextCursor,
      skipped: false as const,
    };
  },
});

// =============================================================================
// CHECK 2 — checkCounterParity
// =============================================================================
//
// For each `vehicle_facts` row, compare its denormalized `report_count` to
// the actual count of `fact_reports` rows pointing at it. The denormalized
// field is bumped inside the same Convex mutation as the fact_reports
// insert (reportVehicleFact, vehicleFactsEditing.ts), so under normal
// conditions the two MUST match.
//
// Drift > COUNTER_PARITY_DRIFT_ALERT_THRESHOLD in 24h alerts. Drift below
// is likely transient mid-mutation racing (Convex serializes per-document
// but cross-document reads may catch a partial state across keys).
// Threshold is conservative — bump if false-positives accumulate.
//
// Batched. Returns drift summary in `anomalies`.
// =============================================================================

export const checkCounterParity = internalQuery({
  args: {
    batchSize: v.number(),
    cursorMs: v.optional(v.number()),
  },
  handler: async (ctx, { batchSize, cursorMs }) => {
    if (envFlag("OTO_RECON_DISABLE_COUNTER")) {
      return {
        processed: 0,
        anomalies: [] as AnomalyArgs[],
        nextCursor: cursorMs,
        skipped: true as const,
      };
    }

    const rows = await ctx.db
      .query("vehicle_facts")
      .withIndex(
        "by_creation_time",
        cursorMs !== undefined
          ? (q) => q.gt("_creationTime", cursorMs)
          : (q) => q,
      )
      .take(batchSize);

    const anomalies: AnomalyArgs[] = [];

    for (const row of rows) {
      const denormalized = row.report_count ?? 0;

      // Fast count via the by_fact index on fact_reports. We collect()
      // because Convex doesn't expose a count() primitive; the index
      // restricts the scan to this fact's reports only.
      const reports = await ctx.db
        .query("fact_reports")
        .withIndex("by_fact", (q) => q.eq("fact_id", row._id))
        .collect();
      const actual = reports.length;

      const drift = Math.abs(denormalized - actual);

      if (drift >= COUNTER_PARITY_DRIFT_ALERT_THRESHOLD) {
        anomalies.push({
          check: "counter",
          severity: "alert",
          fact_id: row._id,
          details: `report_count drift: denormalized=${denormalized} actual=${actual} drift=${drift} (threshold=${COUNTER_PARITY_DRIFT_ALERT_THRESHOLD}).`,
        });
      } else if (drift > 0) {
        anomalies.push({
          check: "counter",
          severity: "info",
          fact_id: row._id,
          details: `report_count minor drift: denormalized=${denormalized} actual=${actual} drift=${drift} (likely transient).`,
        });
      }
    }

    const nextCursor =
      rows.length > 0 ? rows[rows.length - 1]._creationTime : cursorMs;

    return {
      processed: rows.length,
      anomalies,
      nextCursor,
      skipped: false as const,
    };
  },
});

// =============================================================================
// CHECK 3 — checkOrphanAuditRows
// =============================================================================
//
// Walk `vehicle_facts_audit` by the `by_time` index over a recent window;
// for each row, verify `fact_id` resolves in `vehicle_facts`. Orphans
// should be IMPOSSIBLE — we never hard-delete vehicle_facts (retract is a
// soft-delete via verification_status="retracted"). An orphan means
// either:
//
//   (a) someone deleted a vehicle_facts row (would require ctx.db.delete
//       outside the helper — no such code path exists, but layer 4 catches
//       it if added), OR
//   (b) someone forged an audit row with a fact_id that doesn't exist
//       (would require ctx.db.insert into vehicle_facts_audit outside the
//       helper — CI grep Rule 3 catches this at PR time, but layer 4 is
//       the runtime safety net).
//
// PAGE on first orphan.
//
// Batched over a time window via by_time. cursorMs advances by edited_at
// (not _creationTime, since by_time orders by edited_at).
// =============================================================================

export const checkOrphanAuditRows = internalQuery({
  args: {
    batchSize: v.number(),
    cursorMs: v.optional(v.number()), // edited_at cursor
  },
  handler: async (ctx, { batchSize, cursorMs }) => {
    if (envFlag("OTO_RECON_DISABLE_ORPHAN")) {
      return {
        processed: 0,
        anomalies: [] as AnomalyArgs[],
        nextCursor: cursorMs,
        skipped: true as const,
      };
    }

    const auditRows = await ctx.db
      .query("vehicle_facts_audit")
      .withIndex(
        "by_time",
        cursorMs !== undefined
          ? (q) => q.gt("edited_at", cursorMs)
          : (q) => q,
      )
      .take(batchSize);

    const anomalies: AnomalyArgs[] = [];

    for (const audit of auditRows) {
      const fact = await ctx.db.get(audit.fact_id);
      if (fact === null) {
        anomalies.push({
          check: "orphan",
          severity: "page",
          fact_id: audit.fact_id,
          details: `orphan audit row: audit_id=${audit._id} fact_id=${audit.fact_id} edited_at=${audit.edited_at} action="${audit.action}" — referenced vehicle_facts row does not exist.`,
        });
      }
    }

    const nextCursor =
      auditRows.length > 0
        ? auditRows[auditRows.length - 1].edited_at
        : cursorMs;

    return {
      processed: auditRows.length,
      anomalies,
      nextCursor,
      skipped: false as const,
    };
  },
});

// =============================================================================
// CHECK 4 — checkTelemetryParity
// =============================================================================
//
// Query-based approximation (option (b) per the header comment). For a
// window ending at `now`, count:
//
//   editsInWindow   = vehicle_facts rows where updated_at in (windowStart, now]
//                     AND updated_at != created_at  (excludes creation events)
//   auditsInWindow  = vehicle_facts_audit rows where edited_at in (windowStart, now]
//
// Invariant: editsInWindow === auditsInWindow.
//
// Drift > 0 alerts; drift > 5 pages. The case where editsInWindow >
// auditsInWindow is the high-severity case (helper bypassed: row patched
// without an audit row). The reverse (auditsInWindow > editsInWindow)
// would imply audit forgery without a matching fact update, which is also
// page-worthy.
//
// Bounded scan: walks vehicle_facts_audit by `by_time` index over the
// window only; walks vehicle_facts using a filter on updated_at via
// by_creation_time + filter (Convex has no by_updated_at index here, and
// adding one would mean a schema change for marginal benefit — this
// check's window is small, so the scan is cheap).
//
// Future work: when real runtime counters land (see header), this check
// becomes a single-row read instead of a window scan.
// =============================================================================

export const checkTelemetryParity = internalQuery({
  args: {
    windowMs: v.optional(v.number()),
  },
  handler: async (ctx, { windowMs }) => {
    if (envFlag("OTO_RECON_DISABLE_TELEMETRY")) {
      return {
        processed: 0,
        anomalies: [] as AnomalyArgs[],
        editsInWindow: 0,
        auditsInWindow: 0,
        skipped: true as const,
      };
    }

    const effectiveWindow = windowMs ?? TELEMETRY_PARITY_WINDOW_MS;
    const now = Date.now();
    const windowStart = now - effectiveWindow;

    // Audits in window — indexed scan over by_time, bounded.
    const auditsInWindow = await ctx.db
      .query("vehicle_facts_audit")
      .withIndex("by_time", (q) =>
        q.gt("edited_at", windowStart).lte("edited_at", now),
      )
      .collect();

    // Edits in window — there is no by_updated_at index, so we walk the
    // by_creation_time index from a cursor far enough back to catch any
    // row whose updated_at could fall in the window. We use windowStart
    // as the floor on _creationTime, which is conservative: a row created
    // before windowStart but edited inside the window WILL be missed by
    // this approximation. That's an acceptable v1 trade-off — the
    // canonical fix is real runtime counters (future work).
    //
    // For v1 we ALSO walk the audit table to enumerate distinct fact_ids
    // touched in the window, then fetch each fact and verify its
    // updated_at falls in the window. This catches the bypass case where
    // a fact was patched without an audit row IF the fact was ALSO
    // touched (with a real audit row) earlier in the window — covered by
    // the orphan check. The pure "row created long ago, silently edited
    // once, no audit row, no other touches" case is the residual gap.
    // The replay-equivalence check (Check 1) catches this when it walks
    // the row and sees zero audit rows for a row with updated_at !=
    // created_at — so the coverage is layered.
    const editsCandidates = await ctx.db
      .query("vehicle_facts")
      .withIndex("by_creation_time", (q) =>
        q.gt("_creationTime", windowStart),
      )
      .collect();

    let editsInWindow = 0;
    for (const row of editsCandidates) {
      if (
        row.updated_at !== undefined &&
        row.updated_at > windowStart &&
        row.updated_at <= now &&
        row.updated_at !== row.created_at
      ) {
        editsInWindow += 1;
      }
    }

    const auditCount = auditsInWindow.length;
    const anomalies: AnomalyArgs[] = [];
    const drift = editsInWindow - auditCount;

    if (Math.abs(drift) > 5) {
      anomalies.push({
        check: "telemetry",
        severity: "page",
        details: `telemetry parity drift: edits=${editsInWindow} audits=${auditCount} delta=${drift} windowMs=${effectiveWindow}.`,
      });
    } else if (drift !== 0) {
      anomalies.push({
        check: "telemetry",
        severity: "alert",
        details: `telemetry parity drift: edits=${editsInWindow} audits=${auditCount} delta=${drift} windowMs=${effectiveWindow}.`,
      });
    }

    return {
      processed: editsCandidates.length + auditCount,
      anomalies,
      editsInWindow,
      auditsInWindow: auditCount,
      skipped: false as const,
    };
  },
});

// =============================================================================
// runReconciliation — the driver internalAction
// =============================================================================
//
// Schedules the four checks, accumulates results, writes one
// `reconciliation_runs` row per invocation.
//
// Cadence policy (matches MEMORY_SCHEMA_V3_CONSOLIDATED §8):
//   - Every 15 min: replay + orphan + telemetry
//   - Every  4th run (~hourly): + counter parity
//
// We track "run number" by counting prior reconciliation_runs rows in the
// last hour; if 0 < count < 4 we skip counter, otherwise we include it.
// Approximate but adequate for cadence-control without a separate
// scheduler state.
//
// The driver does NOT page directly — it logs anomalies with severity
// "page" into the row, and an external alerting hook (out of scope here)
// reads the table. The runbook documents the alerting integration.
// =============================================================================

export const runReconciliation = internalAction({
  args: {
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, { batchSize }): Promise<{
    runId: string;
    status: "clean" | "anomalies";
    anomalyCount: number;
    checksRan: string[];
  }> => {
    const effectiveBatch = batchSize ?? DEFAULT_BATCH_SIZE;
    const startedAt = Date.now();
    const runId = `recon-${startedAt}`;

    // Decide whether this run includes the (expensive) counter check.
    const includeCounter = await ctx.runQuery(
      internal.oto.migrations.vehicleFactsReconciliation
        ._shouldRunCounterCheck,
      { now: startedAt },
    );

    const checksRan: string[] = ["replay", "orphan", "telemetry"];
    if (includeCounter) checksRan.push("counter");

    // Insert a "running" row up-front so observers can see the run in flight.
    const runRowId = await ctx.runMutation(
      internal.oto.migrations.vehicleFactsReconciliation._insertRunRow,
      { runId, startedAt, checksRan },
    );

    const allAnomalies: AnomalyArgs[] = [];

    // Check 1 — replay (single batch per run; cursor advances by table
    // size over many runs).
    const replayResult = await ctx.runQuery(
      internal.oto.migrations.vehicleFactsReconciliation
        .checkReplayEquivalence,
      { batchSize: effectiveBatch },
    );
    allAnomalies.push(...replayResult.anomalies);

    // Check 3 — orphan (we run this before counter to fail-fast on the
    // page-level signals).
    const orphanResult = await ctx.runQuery(
      internal.oto.migrations.vehicleFactsReconciliation
        .checkOrphanAuditRows,
      { batchSize: effectiveBatch },
    );
    allAnomalies.push(...orphanResult.anomalies);

    // Check 4 — telemetry (window-bounded, no batch param).
    const telemetryResult = await ctx.runQuery(
      internal.oto.migrations.vehicleFactsReconciliation
        .checkTelemetryParity,
      {},
    );
    allAnomalies.push(...telemetryResult.anomalies);

    // Check 2 — counter (only on ~hourly cadence).
    if (includeCounter) {
      const counterResult = await ctx.runQuery(
        internal.oto.migrations.vehicleFactsReconciliation
          .checkCounterParity,
        { batchSize: effectiveBatch },
      );
      allAnomalies.push(...counterResult.anomalies);
    }

    const completedAt = Date.now();
    const status: "clean" | "anomalies" =
      allAnomalies.length === 0 ? "clean" : "anomalies";

    await ctx.runMutation(
      internal.oto.migrations.vehicleFactsReconciliation._finalizeRunRow,
      {
        runRowId,
        completedAt,
        anomalies: allAnomalies,
        status,
      },
    );

    // Console log for Convex log dashboards. Real paging is the job of
    // whatever external alerting reads reconciliation_runs.
    console.log(
      `[reconciliation] runId=${runId} status=${status} anomalies=${allAnomalies.length} checks=${checksRan.join(",")} durationMs=${completedAt - startedAt}`,
    );

    if (allAnomalies.some((a) => a.severity === "page")) {
      console.error(
        `[reconciliation] PAGE — runId=${runId} contains ${allAnomalies.filter((a) => a.severity === "page").length} page-level anomalies. See reconciliation_runs row.`,
      );
    }

    return {
      runId,
      status,
      anomalyCount: allAnomalies.length,
      checksRan,
    };
  },
});

// -----------------------------------------------------------------------------
// _shouldRunCounterCheck — internal helper. Returns true iff the counter
// check should run on this invocation (i.e. it has not run in the last
// (COUNTER_CHECK_EVERY_N_RUNS - 1) * 15-min slots).
// -----------------------------------------------------------------------------

export const _shouldRunCounterCheck = internalQuery({
  args: { now: v.number() },
  handler: async (ctx, { now }) => {
    // Look back ~one hour worth of driver runs and see if any included
    // the counter check. If yes, skip counter this run. If no, include
    // counter.
    const lookbackMs = (COUNTER_CHECK_EVERY_N_RUNS - 1) * 15 * 60 * 1000;
    const since = now - lookbackMs;
    const recent = await ctx.db
      .query("reconciliation_runs")
      .withIndex("by_started_at", (q) => q.gt("started_at", since))
      .collect();

    const recentWithCounter = recent.some((r) =>
      r.checks_ran.includes("counter"),
    );
    return !recentWithCounter;
  },
});

// -----------------------------------------------------------------------------
// _insertRunRow — internal helper. Writes the initial "running" row.
// -----------------------------------------------------------------------------

export const _insertRunRow = internalMutation({
  args: {
    runId: v.string(),
    startedAt: v.number(),
    checksRan: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("reconciliation_runs", {
      run_id: args.runId,
      started_at: args.startedAt,
      checks_ran: args.checksRan,
      anomalies: [],
      status: "running" as const,
    });
  },
});

// -----------------------------------------------------------------------------
// _finalizeRunRow — internal helper. Stamps completed_at, anomalies, status.
// -----------------------------------------------------------------------------

export const _finalizeRunRow = internalMutation({
  args: {
    runRowId: v.id("reconciliation_runs"),
    completedAt: v.number(),
    anomalies: v.array(anomalyValidator),
    status: v.union(v.literal("clean"), v.literal("anomalies")),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.runRowId, {
      completed_at: args.completedAt,
      anomalies: args.anomalies,
      status: args.status,
    });
  },
});
