# BMW 745Li verdict (batch 10)

Overall: strongest Euro result to date. 25+ parts web-verified, ZERO wrong parts, all 5 adversarial traps avoided (BKR6 plug, air filter, ZF Lifeguard 6 ATF+pan, CHF 11S PS fluid, CBS regime). Fill 95, run_errors [].

PASS highlights: N62B44; 8.5qt; coolant part 82141467704 + capacity 14.0L; plugs 12120037607 ×8; PS fluid 83290429576 (current BMW CHF 11S P/N); gear oil 07512293972 (SAF-XO 75W-90 open diff); coil 12138616153; thermostat 11537586885; belt 11287544786; pads/rotors all E65/E66-correct; brake fluid 81220142156 DOT4 LV; intervals oil 10k/12mo, plugs 60k, trans 60k (ZF band), diff 50k.

DEFECTS:
1. P1 — brake fluid interval 12 mo (stored 30k/12mo) vs BMW documented 2 years. Conservative direction but contradicts HIGH-conf GT.
2. P2 — trim/chassis identity: stored "745i"/E65; VIN = 745Li/E66. nhtsa_vin_key had it right (745li); config_key/trim_name/chassis_code lost the L. No parts fallout (shared components); wheelbase-sensitive fields would inherit. Batch-9 Subaru defect class.
3. P2 — 4 default_fallback rows (fuel system clean 60k, battery 60k, rotors 70k, tires 50k) have status "scheduled" (conf 0.5, sources 0) — invented cadences for wear/on-condition items indistinguishable in status from real schedules. SYSTEMIC (check other configs).
4. P3 — oil_viscosity 0W-30 vs attached oil part 5W-30 (both LL-01-legal; record self-inconsistent).
5. P3 — price channel bias: oil filter $28-34 & plug $27.78 from genuine-BMW dealer channel only, 1.5-3x street price of identical Mann/NGK. Real but overstates Euro quotes. SYSTEMIC candidate.
6. P3 — displacement_liters ""; "G11" label (chemistry right, wrong nomenclature); no tire_rotation row (check rotatable gate intent).
Also: Filter Replacement combined service takes air-filter cadence (60k/72mo) → under-services cabin microfilter (1-2yr norm). Semantics note.
