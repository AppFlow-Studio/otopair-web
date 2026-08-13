# MDX re-run verdict (batch 11, round-9 stack d31e0a7)

VIN 5FRYD4H2XEB028867 — 2014 Acura MDX Advance/Entertainment SH-AWD J35Y5. Purge + re-enrich 2026-07-27. Status `partial`, fill 90, 20 parts, quotability 0.67. Ground truth: `reports/ground-truth-batch10/gt-acura-mdx.md` + `verdict-mdx.md` (reused per batch-11 plan). Data: scratchpad `b11/collect-mdx.json` + `b11/audit-mdx.json`.

## Checklist scorecard (batch11_plan criteria #13, #14, #15)

| # | Criterion | Verdict | Evidence |
|---|-----------|---------|----------|
| 14 | Oil part: 08798-9032 (5W-20 blend) refuted/absent; 0W-20-grade part or honest null | **PASS** | 08798-9032 is gone. Stored engine_oil = **08798-9063 = Genuine Honda 0W-20 Full Synthetic** (the SKU that replaced the discontinued 0W-20 blend; bernardiparts/hondapartsdirect/partlimit listings), conf 0.88, source acura.bernardiparts.com. Grade-correct for the 0W-20 J35Y5 — equivalent in kind to the plan's suggested 08798-9163. Batch-10 P1 fixed; round-8 viscosity-grade gate validated on this VIN. |
| 13 | Fallback interval rows `status:"estimated"` | **PASS** | All 5 `default_fallback` rows (fuel_system_cleaning 60k/60mo, battery_replacement 60k, rotor_replacement 70k, tire_replacement 50k, timing_belt 90k/84mo) carry `status:"estimated"`, conf 0.5, source_count 0; low-conf enriched brake_pad_replacement 50k (conf 0.75) is also `estimated`. No default_fallback row is `scheduled` (batch-10 had 4/4 `scheduled`). Semantics coherent: vdb_schedule→`active`, evidence-backed enriched→`scheduled`, deterministic→`on_demand`. |
| 15 | No-regression spot checks (MDX slice) | **PASS** (6/6 named; one regression outside the named set, see P2-3) | DW-1 kept (`trans:fluid = "Acura ATF DW-1"`, 6AT automatic). Engine J35Y5. Plugs 12290-R9P-A01 (= NGK DILZKR7B11G, the GT trap), qty 6 — not DILKAR7G11GS. Oil 5.7 qt (not 4.5/4.7) + 0W-20. **Cabin filter 80292-SDA-407 KEPT** — conf 0.95, 6 price rows (~$20 dealer cluster), survived despite `part_pattern_suspect:Acura:5`; the batch-10 false-positive lesson held (no refute). Rear diff semantics intact: differential_service 30k active (3 sources), no DPF-II mislabel anywhere; DPSF part fitment still absent (carryover P2-2, not a regression). EPS clean: ps_fluid null, no PS-flush row (GT automatic-FAIL trap avoided). Coolant Type 2 Blue P-HOAT; air filter 17220-5J6-A00 and oil filter 15400-PLM-A02 exact GT matches. |

**Score: 3/3 PASS** (#13, #14, #15).

## Adjudication: `fitment_refuted:thermostat:19410-5J6-A00`

**CORRECT KILL (true positive — component-type rule, not fitment).** 19410-5J6-A00 is the **2014-2015 MDX "Thermostat Housing" / "Passage, Water"** (acura.oempartsonline, oemacuraparts, acurapartsworld all list it under exactly that name). It *does* fit this vehicle — a pure fitment check would have passed it — but it is not a thermostat; the actual J35-era thermostat is 19301-R70-A05. The round-9 component-type rule killed a water-passage-housing offered as a thermostat, leaving an honest null instead of a wrong-component quote. Ideal outcome would be recovering 19301-R70-A05; the null is acceptable, not a defect.

## `part_pattern_suspect:Acura:5` — suspect audit

The 5 suspects are not enumerated in collect output, but the candidates (parts whose center code doesn't match the TZ5/5J6/R9P 2014-MDX era) were checked individually: cabin filter 80292-**SDA**-407 (verified OEM supersession — must keep, kept ✅), serpentine belt 31110-**5G0**-A01 (**catalog-correct**, 2014-2016 MDX per oempartsonline/Bando), ignition coil 30520-**5G0**-A01 (**catalog-correct**, 2014-2025 MDX), trans filter 25450-**P4V**-013 (**catalog-correct**, 2003-2026 MDX side-mounted ATF filter), oil filter 15400-**PLM**-A02 (GT-exact). The flag stayed flag-only and refuted nothing — correct round-8 downgrade behavior. The one genuinely off-era part it plausibly covers, timing belt 14400-**RCA**-A01, also survived (see P2-3).

## Batch-10 P2 re-checks

- **P2-a (ATF interval):** transmission_service = **60,000 mi**, vdb_schedule, 1 source, `active` — **unchanged**, still 1.5-3x late vs MM code 3 band 20k-40k. The plan's "unchanged-check" is satisfied (no drift), but the underlying defect remains open (P2-1).
- **P2-b (DPSF part gap):** still **no** DPSF 08200-9007A part fitment (`part:gear_oil` null, no diff part in audit parts). Differential Service (30k interval present) remains parts-unquotable despite correct interval. Open (P2-2).

## Prices vs GT bands

| Part | Stored | GT band | Verdict |
|---|---|---|---|
| Oil filter 15400-PLM-A02 | $6.81 / $7.51 / $13.99 | $6.79 (MSRP $9.70) | ✅ (AutoZone $13.99 = retail, fine) |
| Air filter 17220-5J6-A00 | $25.20 | $22.85 (MSRP $31.87) | ✅ — batch-10 P3 (no price rows) FIXED |
| Spark plug 12290-R9P-A01 | $40.65 | $40.65 ea | ✅ exact — batch-10 P3 FIXED |
| Cabin filter 80292-SDA-407 | $19.96-23.10 + $9.995 "unverified" | n/a | ✅ dealer cluster; $9.99 Advance Auto row is a probable aftermarket-equivalent scrape, correctly typed `unverified` (P3 note) |
| Pads/rotors/coil/belt/etc. | $73-132 rotors/pads, $61 coil, $46 serp belt | n/a | plausible dealer pricing |
| Engine oil, battery | no price rows | — | P3 gap (oil part price row missing on the newly-fixed part) |

## DEFECTS

**No new P1.**

**P2-1 (carryover, open) — ATF interval 60k vs MM code 3 band 20k-40k.** vdb_schedule row untouched by rounds 8-9 (as expected — no fix was shipped for it). Still the largest interval error on this config for a DW-1 6AT.

**P2-2 (carryover, open) — DPSF 08200-9007A still has no part fitment.** Differential Service interval exists (30k) but is parts-unquotable. Note batch-10 stored diff interval as 30k/**18mo**; the months component is now absent — minor additional erosion. Related: `part:atf_fluid` is also null (DW-1 named as trans fluid but no fluid part fitment), so Transmission Service quotes filter-only.

**P2-3 (NEW) — timing-belt slot regressed to previous-generation catalog part + double-belt quote scope.** Primary `timing_belt` part changed from batch-10's verified-correct **14400-R9P-A01** (OEM catalog belt for 2014-2026 MDX) to **14400-RCA-A01** — the 2003-2013 J-series belt (acurapartswarehouse source, $91.96, conf 0.95). Mitigations: multiple cross-references call the two belts physically interchangeable (same teeth/width), so this is unlikely-wrong-in-the-bay, but it is the wrong catalog part for the year and the same trusted-dealer-domain off-era class as the batch-10 P0s. Compounding: R9P-A01 is still present but still mislabeled **"Timing Kit (tensioner, idlers, seals)"** (batch-10 P3 never fixed) — a timing_belt service quote now contains **two belts and zero tensioner/idlers**, i.e. double-charged on the belt and under-scoped on the job.

**P3:**
- Timing-belt interval regressed from enriched 105k/84mo (batch-10 PASS, = MM code 4) to default_fallback **90k/84mo `estimated`** — honestly labeled but lost a previously-correct value.
- Coolant flush months changed 120mo → **60mo** (miles 105k unchanged, inside GT 75k-105k band) — over-service direction on a batch-10 PASS field.
- Brake fluid part 08798-9008A absent (honest null; GT-known part, DOT 3 / 36mo interval itself is correct).
- `sanity:transfer_case_fluid_capacity_qts` false alarm persists — 0.45 qt HGO-1 is verified-exact (batch-10) but the 0.5-3 qt band floor still trips on it.
- `sanity:brake_fluid_capacity_oz` flags a single acurazine **2G-RDX** forum thread as the capacity source — good flag (see Round-9 behavior), but note the source is the wrong *vehicle's* forum section.
- Cabin filter $9.995 `unverified` price row (advanceautoparts) — probable aftermarket-equivalent scrape on an OEM part row.
- No price rows on engine oil (the fixed part) and battery.
- Suspect flag still surfaced only via `run_errors` (`part_pattern_suspect:Acura:5`) with no per-part marker visible in audit parts — batch-10 P3 downstream-visibility gap unchanged, and it prevents enumerating which 5 parts are suspect.

## Round-9 behavior

- **Working:** round-8 oil-viscosity-grade gate (the criterion this VIN was scheduled to validate) — 5W-20 blend refuted, genuine 0W-20 in its place with a dealer source. Component-type rule — thermostat *housing* correctly refuted as not-a-thermostat even though it fits the vehicle (the sharpest positive signal of the rule working as designed). Estimated-status semantics 5/5 on fallback rows. `part_pattern_suspect` stayed flag-only: zero false-positive refutes; SDA-407 (the must-keep) retained with full price coverage, and the 5G0-family suspects it likely covers are all catalog-correct 2014+ MDX parts. Single-mid-tier-source capacity sanity flag fired instead of silent storage. All five GT adversarial traps avoided (DILZKR7B11G, no DPF-II, no PS fluid, 5.7 qt, 0W-20).
- **Not working:** off-era pattern suspicion doesn't distinguish the one genuinely off-catalog suspect (RCA-A01 belt) from correct consolidations — it flagged the class but the wrong-generation part still displaced a batch-10-verified correct part in the primary slot (part-slot churn across runs, the MDX cousin of the SRX refute-nondeterminism finding). Timing "Kit" mislabel survives a third look. ATF-interval band and DPSF part gap untouched (no fix shipped — expected, still open).
- Net vs batch-10: **P1 fixed and validated, zero new P1s, both named must-keep checks held.** Cleanest of the batch-11 re-runs so far; residual risk concentrated in the timing-belt service quote scope and the two known P2 carryovers.
