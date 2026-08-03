/**
 * P2.1 determinism probe harness — the pure decision core.
 *
 * NO live enrichment: every test here runs the orchestration logic that decides
 * what the scheduler chain does next (start the next run / keep polling /
 * finalize / give up), plus the signature encode-compare-summarize path. The
 * chain itself (startProbe/pollProbe) is IO and is exercised by a human running
 * a real probe — see the header of convex/vehicleEnrichment/determinismProbe.ts.
 */
import { describe, expect, test } from "vitest";
import {
  nextProbeStep,
  classifyRunPhase,
  summarizeProbe,
  encodeSignature,
  decodeSignatures,
  isLiveRun,
  clampTargetRuns,
  SENTINEL_VINS,
  MAX_POLL_ATTEMPTS_PER_RUN,
  MIN_TARGET_RUNS,
  MAX_TARGET_RUNS,
  DEFAULT_TARGET_RUNS,
  type ProbeStepInput,
  type CurrentRun,
} from "../convex/vehicleEnrichment/determinismProbe";
import { coreSignature } from "../convex/vehicleEnrichment/determinismGate";

function probe(over: Partial<ProbeStepInput> = {}): ProbeStepInput {
  return {
    status: "running",
    target_runs: 3,
    signatures: 0,
    current_run: "none",
    attempts: 0,
    max_attempts: MAX_POLL_ATTEMPTS_PER_RUN,
    ...over,
  };
}

describe("nextProbeStep — the chain contract", () => {
  test("a fresh probe with nothing in flight starts run 1 (0-based runIndex)", () => {
    const s = nextProbeStep(probe());
    expect(s.action).toBe("start-next-run");
    expect(s.runIndex).toBe(0);
  });

  test("a run in flight keeps polling", () => {
    expect(nextProbeStep(probe({ current_run: "pending" })).action).toBe("keep-polling");
  });

  test("after harvesting run 1 of 3 it starts run 2 — sequentially, never in parallel", () => {
    const s = nextProbeStep(probe({ signatures: 1, current_run: "none" }));
    expect(s.action).toBe("start-next-run");
    expect(s.runIndex).toBe(1);
    // the ONLY state that can kick a run is "nothing in flight"
    for (const cr of ["pending", "failed"] as CurrentRun[]) {
      expect(nextProbeStep(probe({ signatures: 1, current_run: cr })).action).not.toBe("start-next-run");
    }
  });

  test("target reached → finalize", () => {
    const s = nextProbeStep(probe({ signatures: 3, current_run: "none" }));
    expect(s.action).toBe("finalize");
    expect(s.reason).toContain("target_runs_reached");
  });

  test("more signatures than target still finalizes (never loops past the target)", () => {
    expect(nextProbeStep(probe({ signatures: 4 })).action).toBe("finalize");
  });

  test("a probe with FEWER signatures than target_runs never finalizes", () => {
    for (let sigs = 0; sigs < 3; sigs++) {
      for (const cr of ["none", "pending", "failed"] as CurrentRun[]) {
        for (const attempts of [0, 1, 89, 90, 1000]) {
          const s = nextProbeStep(probe({ signatures: sigs, current_run: cr, attempts }));
          expect(s.action, `sigs=${sigs} run=${cr} attempts=${attempts}`).not.toBe("finalize");
        }
      }
    }
  });

  test("a failed run gives up — a dead run cannot be measured", () => {
    const s = nextProbeStep(probe({ signatures: 1, current_run: "failed" }));
    expect(s.action).toBe("give-up");
    expect(s.reason).toContain("run_failed");
  });

  test("the attempt cap expires a hung run instead of rescheduling forever", () => {
    expect(nextProbeStep(probe({ current_run: "pending", attempts: 89 })).action).toBe("keep-polling");
    const s = nextProbeStep(probe({ current_run: "pending", attempts: 90 }));
    expect(s.action).toBe("give-up");
    expect(s.reason).toContain("attempt_cap_exceeded:90/90");
    expect(nextProbeStep(probe({ current_run: "pending", attempts: 500 })).action).toBe("give-up");
  });

  test("the cap is ~90 minutes at a 60s cadence", () => {
    expect(MAX_POLL_ATTEMPTS_PER_RUN).toBe(90);
  });

  test("the attempt cap does NOT preempt a finalize that is already earned", () => {
    const s = nextProbeStep(probe({ signatures: 3, current_run: "none", attempts: 999 }));
    expect(s.action).toBe("finalize");
  });

  test("a run failure does NOT preempt a finalize that is already earned", () => {
    expect(nextProbeStep(probe({ signatures: 3, current_run: "failed" })).action).toBe("finalize");
  });

  test("a terminal probe stops the chain and is never rewritten", () => {
    for (const status of ["complete", "failed"]) {
      const s = nextProbeStep(probe({ status, signatures: 3 }));
      expect(s.action).toBe("give-up");
      expect(s.reason).toContain("probe_not_running");
    }
  });

  test("a nonsense target (< 2 runs) is refused — one run measures nothing", () => {
    for (const target_runs of [0, 1, NaN]) {
      const s = nextProbeStep(probe({ target_runs, signatures: 0 }));
      expect(s.action).toBe("give-up");
      expect(s.reason).toContain("invalid_target_runs");
    }
  });
});

describe("classifyRunPhase — when a run counts as harvestable", () => {
  test("no run row yet → absent", () => {
    expect(classifyRunPhase(null, null)).toBe("absent");
    expect(classifyRunPhase(undefined, "complete")).toBe("absent");
  });

  test("in-progress run statuses → in_progress", () => {
    for (const s of ["started", "scraping", "batch1", "batch2"]) {
      expect(classifyRunPhase(s, "enriching")).toBe("in_progress");
    }
  });

  test("run complete + config settled → complete", () => {
    expect(classifyRunPhase("complete", "complete")).toBe("complete");
    expect(classifyRunPhase("complete", "partial")).toBe("complete");
  });

  test("run complete but config not yet settled → keep waiting (finalize race)", () => {
    // The pipeline marks the RUN complete before it patches the config status;
    // harvesting in that window reads a half-written config.
    expect(classifyRunPhase("complete", "enriching")).toBe("in_progress");
    expect(classifyRunPhase("complete", null)).toBe("in_progress");
  });

  test("a batch-2 timeout is NOT a completed run", () => {
    // A timed-out run finalizes with batch-1 data only; diffing it against a
    // full run reports missing coverage as a determinism defect.
    expect(classifyRunPhase("timeout", "partial")).toBe("terminal_other");
  });

  test("failed / unknown terminal statuses → terminal_other", () => {
    expect(classifyRunPhase("failed", "pending")).toBe("terminal_other");
    expect(classifyRunPhase("weird_new_status", "complete")).toBe("terminal_other");
  });
});

describe("summarizeProbe — the verdict", () => {
  const runA = {
    engine: { code: "ERC", fuel: "Diesel", oil_viscosity: "5W-40", coolant_type: "OAT", spark_plug_quantity: null },
    transmission: { type: "Automatic", fluid: "Mopar ZF 8&9 ATF" },
    drivetrain: "4WD",
    parts: [{ role: "oil_filter", oem: "68507598AA" }, { role: "atf_fluid", oem: "68218057AC" }],
  };

  test("identical runs → deterministic, no varied fields", () => {
    const s = summarizeProbe([coreSignature(runA), coreSignature(runA), coreSignature(runA)]);
    expect(s.deterministic).toBe(true);
    expect(s.varied_fields).toEqual([]);
    expect(s.runs).toBe(3);
    expect(s.fields_compared).toBeGreaterThan(0);
    expect(s.headline).toContain("deterministic across 3 runs");
  });

  test("the batch-8 fluid flip (ZF-ATF → ATF+4) is reported as varied, sorted", () => {
    const runB = { ...runA, transmission: { type: "Manual", fluid: "Mopar ATF+4" } };
    const s = summarizeProbe([coreSignature(runA), coreSignature(runB)]);
    expect(s.deterministic).toBe(false);
    expect(s.varied_fields).toEqual(["trans:fluid", "trans:type"]); // sorted
    expect(s.headline).toContain("NONDETERMINISTIC");
    expect(s.headline).toContain("trans:fluid");
  });

  test("a consistently-null field is a stable gap, not a variance", () => {
    const s = summarizeProbe([coreSignature(runA), coreSignature(runA)]);
    expect(s.varied_fields).not.toContain("part:cabin_filter");
  });

  test("a part OEM that flips between runs is caught", () => {
    const runC = { ...runA, parts: [{ role: "oil_filter", oem: "68191349AC" }] };
    const s = summarizeProbe([coreSignature(runA), coreSignature(runC)]);
    expect(s.deterministic).toBe(false);
    expect(s.varied_fields).toContain("part:oil_filter");
    expect(s.varied_fields).toContain("part:atf_fluid"); // present in A, gone in C
  });

  test("a single signature is trivially deterministic (and says so honestly)", () => {
    const s = summarizeProbe([coreSignature(runA)]);
    expect(s.deterministic).toBe(true);
    expect(s.runs).toBe(1);
  });
});

describe("signature storage round-trip (determinism_probes.signatures is string[])", () => {
  const sig = coreSignature({
    engine: { code: "ERC", fuel: "Diesel" },
    transmission: { type: "Automatic", fluid: "ATF+4" },
    parts: [{ role: "oil_filter", oem: "68507598AA" }],
  });

  test("encode → decode preserves the comparison verdict", () => {
    const decoded = decodeSignatures([encodeSignature(sig), encodeSignature(sig)]);
    expect(decoded).toHaveLength(2);
    expect(summarizeProbe(decoded).deterministic).toBe(true);
  });

  test("keys are stored sorted so stored rows byte-diff meaningfully", () => {
    const keys = Object.keys(JSON.parse(encodeSignature(sig)));
    expect(keys).toEqual([...keys].sort());
  });

  test("unreadable rows are dropped, not thrown — a bad row can't void a probe", () => {
    const decoded = decodeSignatures([encodeSignature(sig), "not json", "[]", "null"]);
    expect(decoded).toHaveLength(1);
  });
});

describe("kick guards", () => {
  const now = 1_000_000_000_000;

  test("an in-progress run with recent activity is live — never kick into it", () => {
    expect(isLiveRun({ status: "batch1", _creationTime: now - 60_000, last_heartbeat_at: now - 30_000 }, now)).toBe(true);
  });

  test("an in-progress run silent past the live window is not live", () => {
    expect(isLiveRun({ status: "batch1", _creationTime: now - 60 * 60_000, last_heartbeat_at: now - 30 * 60_000 }, now)).toBe(false);
  });

  test("a terminal run is never live, and neither is a missing one", () => {
    expect(isLiveRun({ status: "complete", _creationTime: now, last_heartbeat_at: now }, now)).toBe(false);
    expect(isLiveRun(null, now)).toBe(false);
  });

  test("target_runs is clamped to a sane, affordable range", () => {
    expect(clampTargetRuns(undefined)).toBe(DEFAULT_TARGET_RUNS);
    expect(clampTargetRuns(1)).toBe(MIN_TARGET_RUNS);
    expect(clampTargetRuns(99)).toBe(MAX_TARGET_RUNS);
    expect(clampTargetRuns(3)).toBe(3);
  });
});

describe("SENTINEL_VINS", () => {
  test("documents the intended probe set with NO fabricated VINs", () => {
    expect(SENTINEL_VINS).toHaveLength(3);
    for (const s of SENTINEL_VINS) {
      expect(s.vin).toBeNull(); // a human fills these in with real vehicles
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.note.length).toBeGreaterThan(20);
    }
    const labels = SENTINEL_VINS.map((s) => s.label);
    expect(labels).toContain("wrangler-ecodiesel");
    expect(labels).toContain("badge-engineered");
    expect(labels).toContain("camry-control");
  });
});
