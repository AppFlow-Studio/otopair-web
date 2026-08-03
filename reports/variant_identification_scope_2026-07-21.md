# P1: Variant Identification — Scope & Plan

_Date: 2026-07-21 · Branch: feat/3-portals · Author: enrichment hardening loop (batches 5–8)_

## 1. Problem

Across batches 5–8 the enrichment fundamentals are strong, but the **dominant residual
defect class is the same every time**: the pipeline does not reliably pin the *exact
variant* of a VIN, so the LLM extraction drifts and pulls parts/fluids/specs from a
sibling variant of the same nameplate. Evidence:

| Batch | Vehicle | Variant not pinned | Damage |
|---|---|---|---|
| 8 | Jeep Wrangler **EcoDiesel** | gas-vs-diesel (shares "Wrangler" with the 3.6 Pentastar) | got gas spark plugs `SP149125AF` + coil + qty 6, gas oil filter `68191349AC` |
| 8 | Jeep Wrangler | vPIC mis-decoded trans as "6-spd manual" | poisoned the fluid gate (ZF-8HP is automatic) |
| 8 | Toyota Yaris | **badge-engineered** (rebadged Mazda2) | Toyota fluid PNs where Mazda specs are required |
| 7 | Nissan Rogue | T32 vs the older "Rogue Select" (same year) | wrong CVT fluid (NS-2 vs NS-3) |
| 7 | Ford Focus | DPS6 **dry** DCT variant | wet-auto fluid in a dry clutch |
| 5 | RAM 2500 | gas 6.4 HEMI vs Cummins diesel | wrong plug count, wrong parts |

**And the smoking gun (batch-8 re-run):** the *same VIN* produced **different answers on
different runs** — the Wrangler fluid went ZF-ATF → ATF+4; the Yaris specs went Mazda →
Toyota. Extraction is **non-deterministic** because the identity anchor it extracts against
is too weak to constrain it.

## 2. Root diagnosis — why per-facet patching plateaued

The identity handling today is a pile of **independent, post-hoc, per-facet patches**:

- `utils/engineCodeLookup.ts` — adversarial Haiku+web resolver for the engine *code* only.
- `drivetrainReconcile.ts` — fixes a wrong drivetrain decode.
- `transmissionTypeReconcile.ts` (round-7) — fixes a wrong auto/manual decode via the fluid.
- `validation/sanityChecks.ts deriveDutyClass` — GVWR → duty class.
- `applicabilityRules.ts` — round-7 diesel/BEV plug suppression; FWD/RWD/CVT gating.
- `fluidBrandConsistency.ts` (round-7) — flags a foreign-marque fluid spec.

Each patch fixes one symptom of one facet, *after* the fact, and several of them
(diesel-plug suppression, fluid-brand flag, trans reconcile) are compensating for the
**same underlying miss**: the variant was never authoritatively established. There is **no
single, confidence-scored "this is exactly what this VIN is" record** that (a) is resolved
*before* extraction and (b) *anchors* the extraction so it can't drift. The batch-1/1b
prompts are even instructed to *echo* the raw NHTSA decode, so a bad decode propagates
unchecked.

The result: extraction guesses the variant per-run, and the gates play whack-a-mole with
the guesses.

## 3. The proposal — a Variant Fingerprint resolved up front

Introduce a **Variant Resolution stage** that runs **after decode, before Batch-1
extraction**, and produces one canonical, confidence-scored record — the **Variant
Fingerprint** — that everything downstream consumes.

### 3.1 The fingerprint (what it pins)

```
VariantFingerprintV1 {
  // Powertrain (the highest-consequence facet)
  engine_code            + confidence + source   // reuse engineCodeLookup
  fuel_type: gas|diesel|hybrid|phev|bev + conf   // AUTHORITATIVE — drives plug/glow/DEF
  aspiration: na|turbo|supercharged   + conf
  displacement_l, cylinders           + conf
  engine_manufacturer                 + conf     // already decoded; now load-bearing

  // Transmission
  transmission_type: auto|cvt|dct|manual + conf  // round-7 reconcile feeds this
  transmission_unit_code                 + conf  // NEW: JF017E/10L80/DPS6/8HP75
  speeds                                 + conf

  // Chassis / build source
  drivetrain                          + conf     // drivetrainReconcile feeds this
  duty_class                          + conf     // deriveDutyClass feeds this
  build_source_make                   + conf     // NEW: badge-engineering (Yaris→Mazda)
  platform_code                       + conf     // optional, where known

  // Sub-variant within the nameplate (only where it changes parts)
  sub_variant                         + conf     // Rubicon vs Sport; T32 vs Select

  overall_identity_confidence
}
```

### 3.2 Design principles (non-negotiable, learned the hard way)

1. **Fail open, never guess.** Every facet is `null` unless positively resolved — exactly
   like `engineCodeLookup` only persists `source:"verified"`. A null facet leaves the
   existing searchable/blocked-on-identity behavior intact. (Batch-6/8 lesson: a confident
   wrong value is worse than a gap.)
2. **Blast-radius awareness.** The fingerprint anchors *everything*, so a wrong facet is
   higher-consequence than a wrong per-field extraction. Therefore facets must be
   **confidence-gated** and cross-checked before they’re allowed to constrain extraction.
3. **Deterministic where possible, adversarial where not.** Consolidate the deterministic
   signals first (decode + reconcilers + trim tokens); only spend an LLM+web call on the
   genuinely ambiguous facets, and make those adversarial (try to *refute* the candidate),
   mirroring `engineCodeLookup`/`partFitmentVerifier`.
4. **Cross-facet consistency is a first-class check.** diesel ⇒ no spark ignition; an
   automatic ATF ⇒ not a 3-pedal manual; badge-source ≠ make ⇒ powertrain-brand fluids;
   duty-class ⇒ sanity bands. These already exist as scattered gates — the fingerprint
   makes them one coherent consistency pass.
5. **Anchor, don’t just inform.** The batch-1/1b prompts must be *constrained* by the
   fingerprint ("this is the EXACT variant — a 3.0 EcoDiesel built on the JL, ZF-8HP75
   automatic; DO NOT return 3.6 Pentastar parts"), not merely handed the raw decode to echo.

## 4. Current state — what’s reusable (not a rewrite)

| Piece | Reuse as |
|---|---|
| `vehicle_pipeline.ts processVin` | signal source: NHTSA vPIC + VDB merge already captures fuelType, transStyle, EngineManufacturer, GVWR, series/trim2, bodyClass |
| `utils/engineCodeLookup.ts` | the **template** for a facet resolver (Haiku+web, verified-only persists) and the engine_code facet itself |
| `drivetrainReconcile.ts`, `transmissionTypeReconcile.ts` | drivetrain + transmission_type facet resolvers (already built) |
| `sanityChecks.ts deriveDutyClass / parseGvwrUpperLbs` | duty_class facet |
| `identityResolution.ts` | deterministic trim-token derivation (body/drivetrain/trans) |
| `contentSanitization.ts makesSameFamily` + brand regexes | build_source vs make comparison; part-brand routing |
| `VehicleIdentity` (types.ts) | superset of the fingerprint fields already exists; formalize + add confidences + the 3 NEW facets |
| `buildEngineKey` (types.ts) | the config key **is** a coarse variant id today — a wrong fingerprint = wrong key; align them |

~70% of the signals already exist. The work is **consolidation + 3 new facet resolvers +
anchoring the prompts**, not a green-field build.

## 5. Work breakdown (phased tickets)

Ordered by value-per-effort. Each phase is independently shippable and validated against the
batch that exposed it.

### Phase 0 — Fingerprint schema + assembly scaffold  ·  _S, low risk_
- Define `VariantFingerprintV1` (new `variantFingerprint.ts`) + per-facet `{value, confidence, source}`.
- Add an assembler that consolidates the EXISTING deterministic signals (decode + reconcilers
  + trim tokens + duty class) into a fingerprint — **no new LLM calls yet**.
- Persist it on the config (or thread through the batch args). Pure refactor; behavior-neutral.
- **Validation:** fingerprint matches today’s decoded values on the batch-5–8 fixtures.

### Phase 1 — Fuel-type authority + gas/diesel disambiguation  ·  _S, HIGH value_
- Make `fuel_type` an authoritative facet: NHTSA `FuelTypePrimary` + VDB, cross-checked; when
  a nameplate has both gas and diesel in the same year, resolve which THIS VIN is (VIN engine
  digit / engine code / adversarial check).
- Consumers: extends round-7’s diesel plug suppression to **all** fuel-variant contamination
  (oil filter, fuel filter, DEF) by anchoring the extraction, not just nulling plugs.
- **Kills:** batch-8 Wrangler gas-part contamination; batch-5 RAM gas-vs-Cummins.
- **Validation:** re-run Wrangler EcoDiesel + RAM; assert diesel-correct filters, no gas parts,
  determinism across 3 runs.

### Phase 2 — Build-source / badge-engineering resolution  ·  _M, HIGH value_
- Resolve `build_source_make` from `engine_manufacturer` + plant + known badge map
  (Yaris→Mazda, 86/BRZ→Subaru, Vibe→Toyota, etc.); when source ≠ make, the fingerprint says
  "powertrain is Mazda".
- Consumers: extraction anchored to source-brand parts/fluids; `fluidBrandConsistency`
  upgrades from flag-only to a positive "expect Mazda PNs" constraint.
- **Kills:** batch-8 Yaris Toyota-PN-on-Mazda; the field/part brand split.
- **Validation:** re-run Yaris; assert Mazda ATF FZ / FL22 / Mazda part numbers, determinism.

### Phase 3 — Transmission unit-code resolution  ·  _M, HIGH value_
- Resolve `transmission_unit_code` (JF017E, 10L80, DPS6, 8HP75, 62TE…) for the exact
  year+model+engine+sub-variant via an adversarial resolver (engineCodeLookup pattern).
- Consumers: the round-6 trans-fluid gate graduates from flag-only to a **verified** correct
  fluid when the unit is positively pinned + agrees with the atf part; same-year variant
  disambiguation (T32 vs Select).
- **Kills:** batch-7 Rogue/Focus/Tahoe wrong trans fluids at the root.
- **Validation:** re-run batch-7 VINs; assert correct fluid family per unit.

### Phase 4 — Sub-variant within nameplate  ·  _M, medium value_
- Resolve `sub_variant` where it changes parts (Rubicon HD brakes vs Sport; trim-driven brake
  package). Only where part-affecting — do not over-model.
- **Kills:** batch-7 Rogue front-pad, trim-driven brake mismatches.

### Phase 5 — Anchor the extraction + determinism  ·  _M, HIGH value (the multiplier)_
- Rewrite the batch-1/1b prompt preamble to **constrain** extraction to the fingerprint
  (drop the "echo NHTSA as-is" instruction that let bad decodes through); inject the resolved
  variant as hard constraints ("engine is X, transmission unit is Y, built by Z; reject parts
  that fit a different engine/generation").
- Verify temperature/seed settings; add a determinism check (same VIN × N runs → same core
  parts/fluids).
- **This is the phase that converts the fingerprint into extraction stability** — the others
  build the anchor; this one ties the boat to it.

### Phase 6 — Consolidate the bolt-on gates onto the fingerprint  ·  _S, cleanup_
- Point round-4…7 gates (duty-class bands, engine-mfr fluid, diesel-plug suppression, trans
  reconcile, fluid-brand) at the fingerprint as their single input instead of re-deriving.
  Retire duplicated derivation. Lowers future maintenance and prevents drift between gates.

## 6. Validation & determinism plan

- **Regression fixtures:** the batch-5–8 VINs are the acceptance suite; each phase must fix
  its target VIN without regressing the others (the `b8collect` harvester + GT sheets already
  exist for this).
- **Determinism gate (new, important):** run each fixture VIN **3×** and assert the core
  fingerprint + core parts/fluids are identical. Non-determinism is now a tracked defect, not
  invisible noise. This is the single best signal that the anchor is working.
- **Confidence audit:** every fingerprint facet ships with a confidence + source; spot-check
  that low-confidence facets fail open (stay null) rather than guess.

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| A wrong fingerprint poisons the whole run (bigger blast radius) | Fail-open + confidence gating + cross-facet consistency before a facet is allowed to constrain extraction; adversarial (refute-first) resolvers |
| Added up-front LLM cost/latency | Deterministic-first (most facets need no LLM); reuse the single engineCodeLookup-style call; cache per config_key (variants are stable) |
| Over-modeling sub-variants | Only resolve facets that demonstrably change parts; null otherwise |
| Prompt-anchoring reduces recall (model refuses legit parts) | Anchor as constraints + reasons, not hard bans; keep the fitment verifier as the safety net |
| External `convex dev` clobber during deploys | Known; `convex dev --once` immediately before validation (see three-portals memory) |

## 8. Recommended sequencing

**MVP slice (highest value, ~1–2 rounds):** Phase 0 → Phase 1 (fuel-type) → Phase 2
(badge-source) → Phase 5 (anchor + determinism). That directly kills every batch-8 defect and
converts the non-determinism finding into a tracked, closing gap.

**Then:** Phase 3 (trans unit) closes batch-7 at the root; Phase 4 + Phase 6 are cleanup/long-tail.

Net: this is the root the last four rounds have circled. Rounds 4–7 built the *consumers* of a
variant fingerprint before the fingerprint existed; this plan builds the fingerprint and lets
those gates graduate from guesswork-patches to consumers of a resolved fact.
