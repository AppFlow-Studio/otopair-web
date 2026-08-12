# Round-3 Enrichment Hardening — Validation Record

Code: commit `b3a9787` (`fix(enrichment): round-3 hardening from batch-3 validation audit`).
This document records the live validation of those fixes (batch-4, 5 VINs).

## What round-3 changed (recap)

Round-3 addressed the highest-value defects the batch-3 audit found in the batch-2 fixes:

1. **Fitment gate — engine/transmission-FAMILY awareness (P0).** `utils/partFitmentVerifier.ts`:
   the adversarial verifier prompt now demands aspiration (turbo/SC/NA) and transmission-family
   checks, not just displacement/generation; the call site passes `aspiration` + `transmissionType`;
   front/rear rotor + trans_filter added to the priority-role set; cap 14→16.
2. **Drivetrain reconcile (P1).** New `drivetrainReconcile.ts`: NHTSA VIN-decoded axle count
   (`4x2`→2WD, previously dropped by `mapNhtsaDriveType`) is authoritative; the LLM only refines
   within an axle class. Wired into `vehicle_pipeline.ts` decode, the Batch-1B resolution, and finalize.
3. **Sanity fixes (P2).** `validation/sanityChecks.ts`: `coolant_flush_months` reject now fires only
   `<19` or `>240` (a correct 132-month long-life interval is kept + flagged, not rejected); 4-cyl
   coolant `typicalMax` 11→13 (hybrid dual-loop 11.4 qt no longer false-flagged).

Tests: `tests/drivetrainReconcile.test.ts`, `tests/sanityChecks_batch3.test.ts` (+19), full suite 1000 passing.

## Live validation (batch-4)

VINs: 2017 Mustang EcoBoost (1FA6P8TH4HW570765), 2020 Mustang EcoBoost (1FA6P8TH7LF647864),
2020 Camry [intentionally malformed VIN] (4T1BF1FK9LU628105), 2022 Subaru Ascent (4S4WMACD0NH985696),
2020 Nissan Altima (1N4BL4BV5LC604166). Deployment: `dev:third-bird-914`.

> Operational note: the enrichment pipeline's Anthropic API key (Convex env `ANTHROPIC_API_KEY`,
> separate from Claude Code billing) ran out of credits mid-batch, so the first pass finalized on
> Batch-1 only (Batch-2 = where the fitment gate runs = `400 credit balance too low`). After the
> account was topped up, all 4 enrichable VINs were force-re-run to full completion.

### Fitment gate (P0) — ✅ working
Refuted real wrong parts and re-sourced correct replacements, including the exact traps that slipped
through earlier batches:
- 2020 Mustang: refuted `spark_plug:CYFS-12Y-RT3` → **SP-537** — this is the gen-2 plug that the gate
  MISSED on the batch-3 F-150; round-3 now catches it. Also refuted wrong oil filter (`KU2Z-6731-A` →
  FL-910S) and air filter (`NB3Z-9601-A` → FR3Z-9601-A).
- Ascent: refuted `air_filter:16546AA12A` (same wrong filter as the batch-3 Crosstrek) and
  `front_brake_pad:26296SC011` (the WRX-generation pad — recurring batch-2/3 trap).
- Both Mustangs: refuted wrong rear-rotor numbers (rotor role added to priority in round-3).
- Altima: refuted wrong cabin filter (`27277-3JC1C` → 27277-6CA0A) and wrong battery
  (`999M1-NB34C` → correct Group-H5 999M1-NBH5A).
- Correctly did NOT refute the family-correct hard cases: Ascent turbo plug **22401AA92A** and
  high-torque TR690 CVT fluid **SOA748V0300** were kept.

Adversarial re-verification of the ambiguous items cleared the gate of any confirmed false-positive:
- **2020 Mustang coolant (VC-3DIL-B → VC-13-G): the refute was CORRECT.** Ford completed the factory
  Orange→Yellow coolant switch at the 2020 MY, so a 2020 ships Yellow (VC-13-G / WSS-M97B57-A2); the
  gate correctly replaced the now-obsolete Orange OAT. On the 2017 Mustang, VC-13-G is an approved
  service substitute (factory-original is Orange VC-3DIL-B) — mildly over-eager but not wrong.
  Follow-up: model-year-gate the Orange→Yellow cutover (~2020) to report factory fill on pre-2020 cars.
- **Altima plug `22401-6LD1C` and oil filter `15208-65F1B`: both CORRECT** (current supersessions of
  22401-6CA1C / the older 9E01A). These were false alarms from stale numbers in the audit's ground-truth
  reference, not pipeline errors — no wrong part persisted on the Altima.

Remaining open gap (not a regression):
- Refute-but-don't-replace: the Ascent front pad was left missing after correctly refuting 26296SC011
  (WRX-platform part); it should have been re-sourced to **26296XC00D** (2019-2024 Ascent front).

### Drivetrain reconcile (P1) — ✅ validated
- Altima (clean `4x2`): **FWD**, `differential_service` + `power_steering_flush` both not-applicable —
  no phantom rear-diff (the exact batch-3 Sienna/F-150 failure, fixed).
- Both Mustangs: **RWD** — diff service correctly applies, PS not-applicable (EPAS).
- Ascent: **AWD** — rear diff applies. Zero phantom or missing drivetrain services.

### Sanity (P2) — ✅ validated
- Ascent `coolant_flush_months` FLAGGED (not rejected) — the long-life fix working (pre-round-3 this
  was a false-reject). No coolant-capacity false-flag. Sub-15K brake-pad interval correctly rejected.

### Bonus — malformed VIN handling — ✅
The Camry VIN (`4T1BF1FK`, a 2012-2017 descriptor with a 2020 year digit) failed NHTSA VDS validation;
the pipeline logged `decode_failed` and created no vehicle/config — it refused to hallucinate a spec.

## Verdict
Every round-3 target behavior is demonstrably working live, with no regressions and **no confirmed
false-positive refutations**. The fitment gate refuted wrong-engine/generation/rotor parts (including
the exact CYFS-12Y-RT3 plug and 26296SC011 pad that slipped through in batches 2-3) while keeping the
family-correct turbo plug + high-torque CVT. Drivetrain reconcile and the sanity fixes are confirmed.

Open items for a future round (none are regressions):
- **Refute-but-don't-replace** — the gate removes a wrong core part but does not always re-source the
  correct one (Ascent front pad left missing; should be 26296XC00D).
- **Model-year coolant cutover** — VC-13-G (Yellow) is applied to pre-2020 Fords whose factory fill was
  Orange (VC-3DIL-B); approved-but-not-original.
- **Minor value errors** — e.g. 2017 Mustang oil viscosity 5W-20 vs correct 5W-30 (V8-spec leak on a
  non-part field the fitment gate doesn't cover).
- **Audit hygiene** — the batch-4 ground-truth reference had a few stale OEM numbers (Altima plug/oil
  filter); the pipeline's current-supersession values were actually correct.
