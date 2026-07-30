/**
 * runFence — pure run-lifecycle predicates behind the poll-chain write fence
 * (v3pipeline), the zombie reaper (v3mutations.reapStaleRuns), and the
 * finalize verified_fields filter (upsertVehicleConfig).
 */
import { describe, expect, test } from "vitest";
import {
  shouldAbortChain,
  isRunStale,
  stripVerifiedFields,
  lastActivityMs,
  REAP_MS,
} from "../convex/vehicleEnrichment/runFence";

const OWN = "run_own";
const run = (status: string) => ({ _id: OWN, status });

describe("shouldAbortChain — normal chain", () => {
  test("aborts on missing run (purged out from under the chain)", () => {
    expect(shouldAbortChain(null, null, OWN, false)).toEqual({
      abort: true,
      reason: "run_missing",
    });
    expect(shouldAbortChain(undefined, OWN, OWN, false).abort).toBe(true);
  });

  test("aborts on terminal run (reaped/force-unstuck/completed elsewhere)", () => {
    for (const status of ["failed", "complete", "timeout"]) {
      const verdict = shouldAbortChain(run(status), OWN, OWN, false);
      expect(verdict.abort).toBe(true);
      expect(verdict.reason).toBe(`run_terminal:${status}`);
    }
  });

  test("aborts when a newer run exists for the config", () => {
    expect(shouldAbortChain(run("batch2"), "run_newer", OWN, false)).toEqual({
      abort: true,
      reason: "newer_run",
    });
  });

  test("passes a healthy in-progress chain that is still the latest run", () => {
    for (const status of ["started", "scraping", "batch1", "batch2"]) {
      expect(shouldAbortChain(run(status), OWN, OWN, false).abort).toBe(false);
    }
  });

  test("missing latest-run info alone never aborts (fail-open on the read)", () => {
    expect(shouldAbortChain(run("batch1"), null, OWN, false).abort).toBe(false);
  });
});

describe("shouldAbortChain — lateCollect chain", () => {
  test("allows the legitimately-terminal 'timeout' own run", () => {
    expect(shouldAbortChain(run("timeout"), OWN, OWN, true).abort).toBe(false);
  });

  test("aborts when the run was marked failed (reaped or superseded)", () => {
    expect(shouldAbortChain(run("failed"), OWN, OWN, true)).toEqual({
      abort: true,
      reason: "late_collect_fenced:run_failed",
    });
  });

  test("aborts when a newer run exists — the late gap-fill must not land on a successor's config", () => {
    expect(shouldAbortChain(run("timeout"), "run_newer", OWN, true)).toEqual({
      abort: true,
      reason: "late_collect_fenced:newer_run",
    });
  });

  test("aborts on missing run (purge kills late collectors too)", () => {
    expect(shouldAbortChain(null, null, OWN, true)).toEqual({
      abort: true,
      reason: "late_collect_fenced:run_missing",
    });
  });
});

describe("isRunStale", () => {
  const NOW = 1_800_000_000_000;
  const MIN = 60 * 1000;

  test("fresh heartbeat is not stale", () => {
    const r = { _creationTime: NOW - 60 * MIN, started_at: NOW - 60 * MIN, last_heartbeat_at: NOW - 1 * MIN };
    expect(isRunStale(r, NOW)).toBe(false);
  });

  test("slow-poll 10-min heartbeat gap is not stale (20h batch-1 slow poll is healthy)", () => {
    const r = { _creationTime: NOW - 20 * 60 * MIN, started_at: NOW - 20 * 60 * MIN, last_heartbeat_at: NOW - 10 * MIN };
    expect(isRunStale(r, NOW)).toBe(false);
  });

  test("31 minutes of silence is stale (> REAP_MS)", () => {
    const r = { _creationTime: NOW - 5 * 60 * MIN, started_at: NOW - 5 * 60 * MIN, last_heartbeat_at: NOW - 31 * MIN };
    expect(isRunStale(r, NOW)).toBe(true);
  });

  test("no heartbeat yet — activity falls back to started_at", () => {
    expect(isRunStale({ _creationTime: NOW - 40 * MIN, started_at: NOW - 5 * MIN }, NOW)).toBe(false);
    expect(isRunStale({ _creationTime: NOW - 40 * MIN, started_at: NOW - 31 * MIN }, NOW)).toBe(true);
  });

  test("no started_at either — _creationTime is the floor", () => {
    expect(isRunStale({ _creationTime: NOW - 29 * MIN }, NOW)).toBe(false);
    expect(isRunStale({ _creationTime: NOW - (REAP_MS + MIN) }, NOW)).toBe(true);
  });

  test("lastActivityMs takes the max of start and heartbeat", () => {
    expect(
      lastActivityMs({ _creationTime: 100, started_at: 200, last_heartbeat_at: 150 }),
    ).toBe(200);
    expect(
      lastActivityMs({ _creationTime: 100, started_at: 200, last_heartbeat_at: 500 }),
    ).toBe(500);
  });
});

describe("stripVerifiedFields", () => {
  test("removes verified data keys, keeps unverified ones", () => {
    const patch = { drivetrain: "AWD", trim_name: "Sport", year: 2020 };
    const out = stripVerifiedFields(patch, ["drivetrain"]);
    expect(out).toEqual({ trim_name: "Sport", year: 2020 });
  });

  test("operational keys are never filtered, even when listed verified", () => {
    const patch = {
      drivetrain: "AWD",
      enrichment_status: "complete",
      fill_rate: 0.93,
      last_enriched_at: 123,
      confidence_avg: 0.8,
      enrichment_version: "v8",
    };
    const out = stripVerifiedFields(patch, [
      "drivetrain",
      "enrichment_status",
      "fill_rate",
      "last_enriched_at",
      "confidence_avg",
      "enrichment_version",
    ]);
    expect(out).toEqual({
      enrichment_status: "complete",
      fill_rate: 0.93,
      last_enriched_at: 123,
      confidence_avg: 0.8,
      enrichment_version: "v8",
    });
  });

  test("null/empty verified list is a no-op copy; input is never mutated", () => {
    const patch = { drivetrain: "FWD" };
    expect(stripVerifiedFields(patch, null)).toEqual(patch);
    expect(stripVerifiedFields(patch, [])).toEqual(patch);
    const out = stripVerifiedFields(patch, ["drivetrain"]);
    expect(out).toEqual({});
    expect(patch).toEqual({ drivetrain: "FWD" }); // untouched
  });

  test("preserves explicit undefined-valued clear keys (patchVehicleConfig clears)", () => {
    const patch: Record<string, unknown> = { rotor_front_min_thickness_mm: undefined };
    const out = stripVerifiedFields(patch, ["drivetrain"]);
    expect("rotor_front_min_thickness_mm" in out).toBe(true);
  });
});
