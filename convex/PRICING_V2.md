# Pricing v2 — engineering notes

> Spec: `Otopair_Pricing_Spec_v2.pdf` (May 29 2026, Yassin → Temur). **Locked.**
> Implemented: 2026-05-31.

## Run order (one-time after deploy)

```bash
# from otopair-web/
npx convex run seeds/seedPricingV2:seedAll         # parts + labor matrices (Part 1, Part 3)
npx convex run seeds/seedServiceCategories:run     # wire services → categories
npx convex run seeds/seedCamryBaseline:run         # 2020 Camry LE FWD+AWD anchor (Part 2)
npx convex run seeds/seedTierAssignments:run       # pricing_tier from Part 5 + rules fallback
# optional:
npx convex run devOnly/validateQuoteEngine:runAll  # Part 4 examples + cross-tier table
```

All seeds are idempotent.

## Tables touched

| Table | Role |
|---|---|
| `pricing_parts_categories` | 9 rows from spec Part 1 |
| `pricing_parts_multipliers` | 63 cells (9 × 7 tiers) |
| `pricing_labor_categories` | 4 rows from spec Part 3 |
| `pricing_labor_multipliers` | 28 cells (4 × 7 tiers) — spec calls this `labor_tier_estimates` |
| `vehicle_configs.pricing_tier` | denormalized 7-tier enum, read directly by buildQuote |
| `services.parts_multiplier_category_id` | FK to parts category |
| `services.labor_multiplier_category_id` | FK to labor category |
| `service_vehicle_specs` | 2020 Camry baseline (Part 2 OEM dealer-counter ±6% band) |
| `labor_times` | Camry labor hours from Part 2 hours table |

## Locked rules

- **Anchor = OEM @ dealer parts-counter** (NOT discount online OEM). Customer should be surprised by paying *slightly less*, never more.
- **Parts band:** `low = anchor × 0.94`, `high = anchor × 1.06`.
- **Target quote spread:** ±5–8% (flag `spread_exceeded` if >10%).
- **CCB carve-out:** if `vehicle.brake_system === 'ccb_standard' | 'ccb_optional'`, route brake_pad / rotor services to `ccb_absolute_prices`. Missing brake_system = **refuse-to-quote**, never assume steel.
- **Layer-5 tier_estimate** rows must store `source='tier_estimate', confidence=0.3` and UI must render the "Initial estimate — confirmed at booking" label.

## Open items (carry to next PR)

1. **T2b spark-plug 2.0× cell** — may double-count vs `engine_access` labor multiplier. Re-derive from real OEM plug parts cost (likely 1.3–1.5×). Spec Open Items §2.
2. **AWD +10% surcharge** — not parts-grounded; AWD doesn't change oil capacity, pad cost, or coolant volume. Real cost is the separate diff/T-case service. Keep, drop, or relabel as trim proxy. Spec Open Items §3.
3. **Spark-plug $80–90 baseline** — part number `90919-01289` confirmed; supplier price needs verification before locking.
4. **Layer 4 engine-family estimator** — deferred, needs vendor labor audit data. `resolveLaborHours` currently jumps from Layer 3 (sibling) straight to Layer 5 (tier_estimate).
5. **Rotor pricing** — deferred (Yassin handling separately). `rotor_replacement` service has `parts_multiplier_category_id = null` → refuses to quote parts; labor still resolves.
6. **T4 absolute pricing** — informational per-shop field, not yet stored. Validation table treats T4 as floor-only.
7. **Borderline tier calls** to revisit: Subaru WRX (T2a vs T2b), Corvette Stingray (T3a vs T3b), Lamborghini Urus (T3b vs T4). Defaulted to spec value; flagged in `seedTierAssignments.PART5_TIERS[*].notes`.

## Booking-flow cutover (shipped 2026-06-01)

The four live call sites now run on the Yassin engine:

| Call site | What changed |
|---|---|
| `bookings.ts:assertLaborCostMatchesDuration` | Server recomputes Yassin labor cost; client `labor_cost` must land within **±8%** band. Telemetry warn between 5–8%. Throws `LABOR_COST_TIER_MISMATCH` above 8%. |
| `bookings.ts:resolveBookingLaborMinutes` | Replaced direct `service_vehicle_specs` + `labor_times` reads with `resolveLaborHours`. The `engineId` arg is dropped. Bookings now route through the quality gate. |
| `bookings.ts:getJobDetail` (mechanic UI) | Emits tier-aware `shopLaborRateCents` from `resolveLaborRate(shop, tier)`. Falls back to flat `shop.labor_rate` only when tier can't be resolved. |
| `invoices.ts:assembleInvoiceData` | Final invoice labor rate is tier-aware. `DEFAULT_LABOR_RATE` retained as deep fallback with `console.warn` so finance can audit. |

New entry point: **`quotes:previewForBooking`** (mutation) — takes `vin + service_ids + shop_id`, lazy-detects `pricing_tier` and persists it, returns the aggregated `QuoteSeries`. Mobile should call this on the Review & Pay screen.

`quotes:build` (query) stays for reactive UI streams; it computes the same answer but does NOT persist lazy-detected tiers.

### Quality-gate thresholds (Layer 1)

`isHighQualityVdb()` disqualifies a `labor_times` row from Layer 1 if any of:

- `data_quality ∈ { chassis_clone, engine_clone, training_data, default_fallback }` — inferred from siblings or generic per-service defaults; not real data for this config.
- `confidence < 0.75` — belt-and-suspenders gate regardless of data_quality.
- (Empirical only) `empirical_sample_size < 5` — raised from the prior `≥2` threshold so a couple of outlier jobs can't drag the baseline.

Disqualified rows emit a `console.warn` for prod auditability; the engine falls through to Layer 5 (Yassin tier_estimate, Camry-anchored).

### Lazy tier detection

When `vehicle_configs.pricing_tier` is null at quote time, `detectTier(ctx, cfg)` runs `matchRule(ASSIGNMENT_RULES)` on (make, model, trim, year). Mutations (`previewForBooking`, `assertLaborCostMatchesDuration` via `create`/`createBatch`) persist the result with `pricing_tier_source = 'rules_engine_lazy'`. Queries (`build`) compute the answer but do not write.

## Not in this PR (next ticket)

- **Mobile UI** — render `tier_estimate` badge + `display_label` ("Initial estimate — final price confirmed at booking") when `quotes:previewForBooking` returns `flags.includes('tier_estimate')`. Wire `booking_approvals` for the shop-revision flow when the engine returns `refuse_to_quote`.
- **Layer-5 write-back cache** — Layer 5 currently recomputes every call (one multiplier lookup, negligible). Spec calls for writing back to `labor_times` with `source='tier_estimate', confidence=0.3`. Highest-confidence-wins on writes still needs the conflict resolver.
- **Empirical correction loop** — log `spec_variances` per (tier, service) split by parts vs labor (not total) after ~20 bookings per cell.
- **Mobile rsync** — `convex/` in the mobile repo (`otopair/`) is a drift-prone mirror; refresh after merging via the project's existing sync script.

## Validation (Part 4 worked examples + quality gate)

`devOnly/validateQuoteEngine:runAll` creates per-tier test shops + test vehicles and runs `buildQuote` against:

- **Example A** Camry oil change @ T1 → exact match `$108.50–114.50`
- **Example B** BMW 330i (B48) oil change @ T2c (real labor) → exact match `$174.50–186.50`
- **Example C** Audi RS6 spark plugs @ T3a (Layer 5 fires) → exact match `$671.50–696.50`, `flags` includes `tier_estimate`
- **Cross-tier table** 8 rows asserting quote overlaps the RepairPal/dealer market range
- **Q1** BMW 540i with `data_quality='chassis_clone'` labor_times → disqualified; `labor.hours_source === 'tier_estimate'`
- **Q2** BMW 530i with `confidence=0.6` labor_times → disqualified; `labor.hours_source === 'tier_estimate'`
- **Q3** BMW 550i with `confidence=0.92, data_quality='enriched'` labor_times → accepted; `labor.hours_source === 'vdb'`
- **L1** BMW M5 with `pricing_tier=null` → `detectTier` resolves via ASSIGNMENT_RULES; quote succeeds
