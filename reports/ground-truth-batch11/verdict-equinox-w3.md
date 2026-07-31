# Equinox wave-3 delta verdict (batch 11) — 2024 Chevrolet Equinox Premier 1.5T LYX 6AT, VIN 3GNAXNEG5RL211320

**Baseline:** wave-2 FAIL (`verdict-chevy-equinox.md`) — vPIC "LSD" identity poisoning + CVT fluid on the 6T45, plus AWD oil capacity on FWD, Group-48 battery decoy, phantom air-filter PN.
**This run:** wave-3 re-run after round-10 fixes. Artifacts: `w3-collect-equinox.json` / `w3-audit-equinox.json` (scratchpad `b11\`).

**OVERALL: STILL FAIL — but materially narrowed.** 3 of 5 wave-2 P1s are FIXED outright (oil capacity, battery, air filter — the latter two re-verified live against GM catalogs). The two survivors are the linked pair the baseline predicted: the LSD identity key (unflagged, round-10's adversarial short-code check could not refute it) and the CVT fluid on the 6AT (now double-flagged but still stored). Trap scorecard 4/7 → **6/7**; fill 88 → 91; parts 10 → 12. One new phantom-PN defect (atf_fluid 12260882) and one new false fitment kill (front rotor 13552823) keep this from a conditional pass on hygiene alone; the fluid value itself keeps it a FAIL on the damaging-recommendation bar.

## Delta scorecard

| # | Wave-2 defect | Wave-3 status | Call |
|---|---|---|---|
| P1-a | "GM CVT Fluid (green)" on 6T45 | **RECURRED, now flagged twice** — `trans_fluid_suspect:...expected=DEXRON-VI` (round-7 verifier) + `trans_fluid_spec_family_conflict` (round-10 mirror gate, flag-only) | RECURRED (downgraded: silent → flagged) |
| P1-b | Engine code LSD in config_key | **RECURRED, unflagged** — `2024_chevrolet_equinox_premier_lsd`, `engine.code: "LSD"`, zero engine flags in run_errors | RECURRED (identity gap remains) |
| P1-c | 5.3-qt AWD oil capacity on FWD | **FIXED** — `oil_capacity_qts: 4.2` = GT FWD LYX verbatim (TechLink) | FIXED |
| P1-d | Battery "48AGM" (Group 48 decoy) | **FIXED** — oem 84257919, web-verified Group 47 for Equinox 1.5L (g.oempartsonline 2024 Equinox battery page); trap 7 avoided | FIXED |
| P1-e | Phantom air filter 84588699 | **FIXED** — oem A3240C = ACDelco designation of GM **84390002** (Amazon listing verbatim "A3240C (84390002)"; partsgeek 2018–2025 Equinox; O'Reilly 2020 Equinox), prices $38.02–39.99 inside GT's $37/$65 band | FIXED |
| P2-a | 45k transmission_service as `scheduled` conf 0.9 | **RECURRED unchanged** — same row, source_count 2; still the 2025 CVT/8AT dealer line sold as universal (GT: severe-only for 3rd-gen 6T45) | RECURRED |
| P2-b | Gear oil "10-4034" on a FWD VIN | **FIXED** — gear_oil null, no differential_service row; junk PN gone | FIXED |
| P2-c | engine_oil slot filled with the oil-filter PN | **FIXED** — oem **19432331** (ACDelco dexos1 0W-20 quart — exactly the GT-suggested correct fill), priced tascaparts/parts.gmparts | FIXED |
| P3-a | Merged 30k/12mo filter_replacement | **IMPROVED** — now 22,500 mi/24 mo (= GT cabin 6b exactly, conf 0.9, sources 3); still one merged row, engine-air 45k unrepresented | PARTIAL |
| P3-b | front_brake_pad null after contested kill | **FIXED (coverage)** — 85129514 stored, web-verified genuine GM front pad kit for Equinox (partsgeek 2020–2024, tascaparts 2020–2025, gmpartsgiant), 3 dealer prices $84.97–98.08 | FIXED |

## Adjudications

**P1-a: flag-without-correction is NOT an acceptable endgame here — round-11 should authorize correction.** The stored value is a wrong-fluid-class service recommendation (frictional damage in a stepped box); flags demote confidence internally but downstream consumers still receive "GM CVT Fluid (green)". The round-6 lesson (correctors net-harmful, 0-for-2, demoted to flag-only in 38d18eb) was about *web-arbitrated overwrites* — a scraped value beating another scraped value. This case is categorically different: the round-7 verifier's `expected=DEXRON-VI` is a **deterministic family mapping** from the run's own verified structure (GM 6T-series stepped automatic → DEXRON-VI, invariant), and three independent signals align: (1) round-7 verifier positive verdict, (2) round-10 spec-family conflict gate, (3) the run's own `speeds: 6, type: Automatic`. Round-10 withheld correction "because no stepped part corroborated" — but the blocking corroborator is itself a phantom PN (see NEW-1 below), i.e. the gate was starved by corrupt input, not by genuine ambiguity. **Round-11 candidate rule:** correct (or at minimum suppress to null) when verifier-expected + family-conflict gate + internal type/speeds all agree AND the expected value is a spec-family constant rather than a scraped number. Shipping the wrong family with flags is strictly worse than shipping null. (Cosmetic: the flag names "GM 6T40" for what is a 6T45 — same Gen-1 6T family, harmless.)

**P1-b: confirmed the remaining identity gap; adversarial search is structurally unable to fix it.** config_key and engine.code still carry LSD with no flag. The round-10 short-code adversarial verification evidently searched and found *supporting* evidence — which is exactly what the web returns, because "Equinox 1.5T LSD" is TRUE for MY2025 (AMSOIL lookup, 4th-gen coverage). A code that is wrong only by model year cannot be refuted by fitment-style web search on the same nameplate; the 2025 corpus contaminates every query. This needs the deterministic **RPO × model-year validity table** (LSD first valid MY2025 → reject for 2024) with fallback to year+model+displacement inference, which resolves 2024 uniquely to LYX (sole 2024 engine). Until then every LSD-anchored search keeps pulling 4th-gen content — the root feeder of P1-a and P2-a.

**NEW-1 (P2): atf_fluid part 12260882 — phantom PN, wave-2's P1-e class recurring in a new slot.** "Transmission Fluid (ATF / CVT)", single source **shop.advanceautoparts.com** (the same domain that supplied wave-2's phantom air filter 84588699), $11.99, conf 0.85. Adversarial check: 12260882 returns **zero** hits across GM catalogs; the real GM DEXRON-VI PNs are 88865601/88865549/88865618/88864060 (parts.chevrolet.com / parts.gmparts.com). Double harm: a quote against it fails, AND it starved the round-10 mirror gate of the stepped-part corroboration that would have upgraded flag→correct (see P1-a). Existence-corroboration gate (second catalog hit before shipping a PN) is still the open fix from wave-2's P1-e writeup.

**NEW-2 (P3): `fitment_refuted:front_rotor:13552823` — FALSE KILL.** Web-verified: 13552823 is the GM Genuine coated **front** rotor for 2018–2024/25 Equinox + 2018–2024 Terrain (partsgeek both listings; g.oempartsonline "2016-2025 GM"; parts.gmc.com/parts.buick.com product pages; supersedes 13515291/13517845/13537160/13548998). The refute killed a correct, quotable part and left front_rotor null. Second front-axle false/contested kill on this vehicle (wave-2 P3-b was 42790921). Net-safe (honest null) but the refute direction keeps trading correct parts for nulls; contested-fitment → keep-with-flag remains the right tuning.

**NEW-3 (P3): brake_fluid_flush regressed 60 mo → 30,000 mi** (conf 0.7, `adversarial_corrected`, `estimated`, source_count 1). Wave-2 shipped 60 mo, matching GT row 11's GM 5-yr line; wave-3's *corrector* replaced it with a generic 30k aftermarket cadence. Non-damaging (over-service) but this is the round-6 corrector-harm signature reappearing in the intervals path: an adversarial correction made a correct value worse. Worth pulling the trace on what "corrected" it.

## Round-10 behavior notes

- **Mirror gate (`trans_fluid_spec_family_conflict`): FIRING as designed** — the exact one-directional gap named in the wave-2 headline is closed at detection level. Its correction predicate (stepped-part corroboration) was defeated by a phantom PN; see P1-a adjudication.
- **Sole-source capacity handling: WORKING, semantics evolved** — wave-2 silently withheld the lone chevyequinoxforum trans-capacity number; wave-3's flag reads "confidence capped, needs corroboration" (keep-with-cap). Correct treatment of the low-authority-forum class; capacity still absent from the shipped transmission block, so nothing damaging leaked.
- **Round-7 trans-fluid verifier: FIRING** with a correct positive expected value (DEXRON-VI) — the strongest single argument that a bounded round-11 corrector has safe inputs.
- **Round-9 interval semantics still healthy** — all four default_fallback rows `estimated` conf 0.5 source_count 0; deterministic rows `on_demand`; brake_pad_replacement `estimated` 0.75.
- **No pattern-suspect flags this run** — correct: both wave-2 junk-format PNs ("48AGM", "10-4034") are gone. Note the pattern gate is silent on 12260882 because it LOOKS like a valid 8-digit GM PN — same blind spot as wave-2's 84588699; only existence corroboration catches this class.

## Coverage & hygiene delta

12 parts (was 10): +drain_plug_gasket 12616850 (plausible GM PN, 3 prices), +front_brake_pad 85129514 (verified), +atf_fluid 12260882 (phantom — see NEW-1); engine_oil re-pointed to a real oil product; junk gear_oil dropped; battery PN replaced. Fill 91 (was 88) — and unlike wave-2, the engine_oil fill is no longer inflationary. Persisting: **every part still `sources: 1`** (zero multi-source corroboration anywhere); battery row has no prices; gm-trucks.com (forum) supplies a $17.50 price on a $5 gasket. Gone: corvetteforum and ubuy.co.it price sources.

## Verdict trajectory

Wave-2 FAIL (5 P1, silent) → wave-3 FAIL (2 P1, both flagged or root-caused). Both survivors converge on two round-11 items: (1) RPO×year validity gate on decoder engine codes (kills P1-b and the contamination feeder for P1-a/P2-a at the root), (2) bounded spec-family corrector — deterministic expected value + multi-gate agreement ⇒ correct or null, never ship the wrong family flagged. Plus: existence corroboration for single-source PNs (would have caught 12260882 and wave-2's 84588699 identically).
