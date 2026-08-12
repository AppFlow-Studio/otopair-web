# F-150 re-run verdict (batch 11)

**VIN** 1FTPW14556FB15661 — 2006 Ford F-150 5.4L 3V SuperCrew (GT trim: Lariat 4x4)
**Stack** round-9 (d31e0a7), purge + re-enrich. `run_status: complete`, `status: partial`, fill 94, 20 parts.
**Checklist** `reports/batch11_plan_2026-07-25.md` criteria #6–#9, #13, #15. GT: `reports/ground-truth-batch10/gt-ford-f150.md`; prior verdict: `verdict-f150.md`.
**Evidence** scratchpad `b11/collect-f150.json`, `b11/audit-f150.json`.

## Scorecard — 4/6

| # | Criterion | Verdict | Evidence |
|---|-----------|---------|----------|
| 6 | Wrong-variant parts absent or honest-null | **PASS** | All four batch-10 P2 survivors gone. Belt `5L3Z-8620-BA` and intake gasket `4L3Z-9461-AA`: `fitment_refuted:*` in run_errors, absent from parts → honest nulls. Rear rotor now `6L3Z-2C026-A` (2C026 = rear-rotor family, not the front `1125` part). Thermostat now `7L3Z-8575-E` (8575 family, sourced oemfordpart.com + 3 dealer prices), not Duratec `RT-1194`. No confidently-wrong survivors. Caveat: replacements differ from GT-preferred numbers (see P3-3). |
| 7 | MERCON V, no LV-expecting suspect error | **PASS** | `transmission.fluid = "Motorcraft MERCON V ATF"`, speeds 4, and run_errors contains NO `trans_fluid_suspect` entry. Round-8 verifier-KB fix (4R75E ≠ MERCON LV) holding. |
| 8 | Trim = Lariat (`..._lariat_...` config_key) | **FAIL** | `config_key = 2006_ford_f_150_fx4_supercrew_995`, `trim = "FX4 SuperCrew"`. Batch-10 P2-7 defect RECURRING after the round-8 trim guard explicitly targeted it — no evidence of a normalizer-trim rejection firing. Engine-code passthrough `995` (batch-10 P3) also persists in the key. |
| 9 | Coolant 20.9 qt, ≤1 informational band flag | **FAIL** | Capacity is now null: run_errors `sanity:coolant_capacity_qts:... — dropped: sole source is a low-authority forum/community page (f150forum.com)`. GT confirms 20.9 qt (Owner's Guide p.313) — the exactly-correct value was destroyed, a regression vs batch-10 where it was stored with a false-positive flag. Also note the message is internally inconsistent: 20.9 is INSIDE the stated 4–22 band it claims was violated. |
| 13 | Fallback rows carry `status:"estimated"` | **PASS** | All 4 `default_fallback` rows (fuel_system_cleaning, battery_replacement, rotor_replacement, tire_replacement) + all 6 `enriched` rows = `status:"estimated"`; zero "scheduled". vdb rows `active`, deterministic rows `on_demand`. Batch-10 systemic 5/5 defect fixed on this config. |
| 15 | No-regression spot-checks | **PASS** | Oil 5W-20 / 7.0 qt ✅; plugs SP-546 ×8 (current PZK14F chain) ✅; air filter FA-1754 (FA-1883 trap avoided) ✅; cabin filter null (correct — not equipped) ✅; fluids 5/5: MERCON V ✅, Premium Gold WSS-M97B51-A1 ✅, rear 75W-140 `XY-75W140-QL` + `XL-3` modifier ✅, PS `XT-5-QMC` (MERCON V service fill, GT-acceptable) ✅, brake PM-1-C ✅. Engine code still `995` — unchanged from batch-10 (persisting P3, not a regression). Bonus improvement: coolant part `VC-7-B` now KEPT (batch-10 had refuted it — GAP closed). FT-105, DG-511, BR-1083/BR-1012, BXT-65-750 all retained. |

## DEFECTS

### P1
1. **Trim guard ineffective — FX4 recurrence.** `config_key = 2006_ford_f_150_fx4_supercrew_995` despite VDB/NHTSA decoding Lariat and the round-8 fix ("trim guard (Lariat)") shipping specifically for this VIN. Escalated from batch-10 P2 because a targeted, deployed fix failed to hold on its own validation vehicle. Decode log shows no normalizer-trim rejection.

### P2
1. **Coolant capacity over-suppression.** The single-source sanity gate dropped the exactly-correct 20.9 qt (sole source f150forum.com) instead of storing it with an informational flag. Round-9-adjacent regression: batch-10 kept the value (with a confirmed false-positive band flag); round 9 now destroys it. Honest null, not confidently-wrong — but a correct-value loss, and the error text ("outside typical range 4–22") contradicts itself since 20.9 is in-band. Gate should treat authority and band as separate signals, not compound a low-authority source into a drop of an in-band value.

### P3
1. **Engine code `995` order-code passthrough** persists (batch-10 P3); pollutes config_key.
2. **Air-filter interval 15k mi** vs OEM 30k (SMG) — over-service carry-over from batch-10.
3. **Replacement rotor/thermostat numbers unverified vs GT.** Rear rotor `6L3Z-2C026-A` (confidence 0.7, `source_domains: null`, no prices) vs GT-verified `4L3Z-2C026-AB`; thermostat `7L3Z-8575-E` vs GT `3L3Z-8575-AC`. Both are role- and platform-consistent (likely supersessions) so #6 passes, but neither matches the researched numbers — spot-verify before trusting. Front rotor `6L3Z-1125-A` also `source_domains: null`.
4. **Duplicate ps_fluid rows / mis-bucket**: `XT-5-QMC` appears twice, once under `service_type: transmission_service` — wrong bucket.
5. **Coolant-flush months 72 vs 100k/60mo** GT first interval (miles exact, months slightly long; informational).

## Round-9 behavior

- **Fitment refutes working as designed**: both known wrong-engine parts (4.2L belt, 4.6L intake gasket) were extracted, refuted with logged `fitment_refuted:*` errors, and excluded — the exact honest-null path criterion #6 asks for. The other two P2 slots were re-filled with same-platform, role-correct numbers rather than nulled.
- **Estimated-status fix validated** on this config: all fallback/enriched intervals `estimated`, none `scheduled`.
- **MERCON V trap silent**: the round-8 KB correction survived the purge/re-run; no LV suspect fired.
- **New over-suppression mode**: the source-authority-aware coolant sanity gate converts "in-band value from one weak source" into a hard drop. On this vehicle it deleted the only exactly-correct capacity in the batch-10 set. Recommend: low-authority sole source + in-band value → keep with `low_authority_single_source` flag; drop only when out-of-band AND unsupported.
- **Trim guard did not fire** (or fired and lost): the highest-priority follow-up, since it was round 8's headline F-150 fix.
- Quotability 0.75; status `partial` consistent with the null coolant capacity and null belt/gasket/cabin slots.
