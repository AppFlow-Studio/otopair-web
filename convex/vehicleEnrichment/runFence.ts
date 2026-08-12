/**
 * vehicleEnrichment/runFence.ts — pure run-lifecycle predicates
 *
 * Shared by the poll-chain write fence (v3pipeline), the zombie reaper
 * (v3mutations.reapStaleRuns), and the purgeAndRerun live-chain guard
 * (runPublic). Pure module — no Convex imports — so the abort/staleness
 * semantics are unit-testable without loading the 5,500-line pipeline.
 */

/** Run statuses that mean a poll chain may still be doing work. Mirrors the
 *  LIVE_RUN_STATUSES set in v3pipeline STEP 0 and the in-progress statuses
 *  the reaper scans. (Config-side in-progress statuses additionally include
 *  "enriching" — see CONFIG_IN_PROGRESS_STATUSES in v3mutations.) */
export const RUN_IN_PROGRESS_STATUSES: readonly string[] = [
  "started",
  "scraping",
  "batch1",
  "batch2",
];
const RUN_IN_PROGRESS_SET: ReadonlySet<string> = new Set(RUN_IN_PROGRESS_STATUSES);

/** A run with no activity inside this window is not a live chain. Matches the
 *  STEP 0 force-unstick window: > the 10-min action cap + poll gap. */
export const LIVE_WINDOW_MS = 15 * 60 * 1000;

/** Reap threshold — 2x LIVE_WINDOW_MS. Healthy chains stamp last_heartbeat_at
 *  every ~60s (fast poll) or every 10 min (slow poll), so 30 min of silence
 *  means the chain is dead, not slow. Never reap on age alone: a 20h batch-1
 *  slow poll is healthy and keeps heartbeating. */
export const REAP_MS = 30 * 60 * 1000;

type ActivityRun = {
  _creationTime: number;
  started_at?: number | null;
  last_heartbeat_at?: number | null;
};

/** Latest sign of life: start time (or row creation) vs last poll heartbeat. */
export function lastActivityMs(run: ActivityRun): number {
  return Math.max(run.started_at ?? run._creationTime, run.last_heartbeat_at ?? 0);
}

/** True when an in-progress run's chain has been silent past REAP_MS. Status
 *  filtering is the caller's job (the reaper only feeds in-progress runs). */
export function isRunStale(run: ActivityRun, nowMs: number): boolean {
  return nowMs - lastActivityMs(run) > REAP_MS;
}

export type FenceVerdict = { abort: boolean; reason: string | null };

/**
 * Poll-chain write fence. An orphaned chain — superseded by force-unstick or
 * the stuck bypass, reaped by the cron, or purged out from under itself —
 * must self-abort BEFORE writing: its finalize/failEnrichmentRun would
 * otherwise clobber the successor run's config status.
 *
 * Normal chain: own run must still exist, still be in-progress, and still be
 * the LATEST run for its config.
 *
 * lateCollect chain: the run legitimately finalized "timeout" at the 3h
 * cutoff — terminal status alone is not an abort. Abort only when the run is
 * gone (purged), was marked failed (reaped/superseded), or a newer run exists.
 */
export function shouldAbortChain(
  run: { _id: string; status: string } | null | undefined,
  latestRunIdForConfig: string | null | undefined,
  ownRunId: string,
  lateCollect: boolean,
): FenceVerdict {
  if (lateCollect) {
    if (!run) return { abort: true, reason: "late_collect_fenced:run_missing" };
    if (run.status === "failed") return { abort: true, reason: "late_collect_fenced:run_failed" };
    if (latestRunIdForConfig && latestRunIdForConfig !== ownRunId) {
      return { abort: true, reason: "late_collect_fenced:newer_run" };
    }
    return { abort: false, reason: null };
  }
  if (!run) return { abort: true, reason: "run_missing" };
  if (!RUN_IN_PROGRESS_SET.has(run.status)) {
    return { abort: true, reason: `run_terminal:${run.status}` };
  }
  if (latestRunIdForConfig && latestRunIdForConfig !== ownRunId) {
    return { abort: true, reason: "newer_run" };
  }
  return { abort: false, reason: null };
}

// ─── verified_fields write policy ──────────────────────────────────
// Same law as the fence, applied to fields instead of chains: the pipeline
// never overwrites human truth. Extracted from patchVehicleConfig so
// upsertVehicleConfig's finalize patch enforces it too (F31).

/** Run-bookkeeping columns that must ALWAYS write — filtering these would
 *  freeze a config's lifecycle (stuck enrichment_status) the moment someone
 *  verified any field. Data fields never belong here. */
export const OPERATIONAL_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "enrichment_status",
  "fill_rate",
  "last_enriched_at",
  "confidence_avg",
  "enrichment_version",
]);

/** Returns a copy of `patch` with director-verified data fields removed.
 *  Operational keys are hard-exempt. Pure — never mutates the input. */
export function stripVerifiedFields(
  patch: Record<string, unknown>,
  verified: readonly string[] | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...patch };
  for (const key of verified ?? []) {
    if (OPERATIONAL_CONFIG_KEYS.has(key)) continue;
    delete out[key];
  }
  return out;
}
