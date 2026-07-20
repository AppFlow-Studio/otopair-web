# RepairPal `minutes` Spread Spike — Findings & Verdict

**Date run:** 2026-06-15 · **Branch:** `waleed-fix` · **Probe:** `convex/devOnly/repairpalMinutesSpread.ts`
**Run:** `npx convex run devOnly/repairpalMinutesSpread:probe '{"asOf":"2026-06-15T00:00:00Z"}'` (dev deployment, ZIP 10001, curated 7 vehicles × 7 services)
**Spec:** [`../specs/2026-06-15-repairpal-minutes-spread-spike-design.md`](../specs/2026-06-15-repairpal-minutes-spread-spike-design.md) · **Plan:** [`../plans/2026-06-15-repairpal-minutes-spread-spike.md`](../plans/2026-06-15-repairpal-minutes-spread-spike.md)

---

## Headline verdict

**The `minutes` data is genuinely trustworthy and exact — but coverage and variant/model matching are the real obstacles to using RepairPal as a broad labor source.** RepairPal-via-`minutes` is viable as a **strong, exact corroborator for the (mostly engine-determined) services it actually covers**, not as a comprehensive primary source. And **firecrawl is not needed for access** — the direct GET works headless from the deployment.

This resolves the strategic question from the labor handoff §5: the dead end was *RepairPal-via-rounded-dollars*; *RepairPal-via-`minutes`* is real data, but its value is bounded by coverage, not by data quality.

---

## Evidence (this run)

| Signal | Result | Reading |
| --- | --- | --- |
| **Per-vehicle implied-$/hr CV** | **0.0000** on every multi-variant row (Civic, Camry, F-150, Porsche, all services) | `minutes` is the genuine labor-time driver, not noise. The strongest possible positive signal. |
| Blended cross-vehicle CV | low_cv 0.114, high_cv 0.114 | ~11% — expected and benign: it's the brand-rate spread (Porsche ≈ $193/hr vs Honda ≈ $143/hr), not within-vehicle noise. |
| **Access path** | 41/41 **direct**, 0 firecrawl, 0 failed | Deployment IP is **not blocked**. Firecrawl is an unused fallback at this volume, not a requirement. |
| Anchor — Civic LX brake | minutes 54 → $143/hr low, $210/hr high | Matches the field-spec worked proof exactly. |
| Anchor — Porsche 911 spark | engine_base [366, 156, 366], CV 0 | Constant $193/$283 per hr across 6.1h and 2.6h jobs — confirms the rate band is independent-vs-dealer, not noise. |
| **Coverage** | **10 of 49 pairs (~20%)** produced `minutes` | The binding constraint. Breakdown below. |
| **Variant spread** | 5 high-spread pairs; Civic brake returned **15 variants** | Variant→config matching is the crux; spark-plug spreads up to 156→366 min make mis-matching costly. |

### Coverage breakdown (49 pairs)

- **10 pairs with data:** `oil_change` (Civic, Camry, F-150, Porsche), `spark_plugs` (same 4), `brake_pad_replacement` (Civic only), `battery_replacement` (F-150 only).
- **7 make-absent gaps — Tesla.** RepairPal's makes list excludes Tesla entirely (deliberate probe; confirmed).
- **7 base-vehicle gaps — BMW "3 Series".** Diagnostic: RepairPal models 2019 BMW by **trim-as-model** (`330i`, `330i xDrive`, `M340i`, `340i GT xDrive`, …) — there is no "3 Series" entry. Model-name matching must reach trim granularity for some makes.
- **5 service-id gaps — `rotor_replacement`.** No standalone RepairPal rotor service (composite-only, `4453439`, behind `includeComposite`). Known.
- **20 empty estimates** (resolved baseVehicleId + valid serviceId, but no variants returned):
  - `timing_belt` — empty for **all** probed vehicles (Civic, Camry, F-150, Porsche): they are **timing-chain** engines, so RepairPal correctly has no belt estimate. (Applicability working as intended.)
  - `wheel_alignment` — empty for all.
  - `brake_pad_replacement` — present for Civic, **empty for Camry / F-150 / Porsche**.
  - `battery_replacement` — present for F-150, **empty for Civic / Camry / Porsche**.
  - **Subaru Outback — all 6 empty** despite a resolved baseVehicleId.

**Interpretation of the empties:** RepairPal's service catalog is **per-vehicle filtered** (established during design). A globally-valid `serviceId` (e.g. brake = 30) returns an empty estimate when *that vehicle's* estimator doesn't offer the service — so the static global serviceId map is necessary but not sufficient; production would need to confirm each service is offered for each vehicle (or accept these as genuine RepairPal data gaps). The engine-determined services (`oil_change`, `spark_plugs`) are the reliably-covered ones.

---

## What this means for the production decision (spec §13)

| Criterion | Result |
| --- | --- |
| Implied-$/hr CV low? | **Yes** — ~0 within every vehicle. Data is exact and genuine. |
| Coverage adequate? | **No / partial** — reliable only for engine-determined services on RepairPal-covered makes. Whole makes (Tesla), trim-as-model makes (BMW), and several chassis services are missing or empty. |
| Variant spread manageable? | **Challenging** — large spreads (esp. spark plugs) and up to 15 variants per pair make variant→config matching the central engineering risk. |

### Recommendation

1. **Promote RepairPal-via-`minutes` to a real, strong corroborator — scoped to the services it covers** (start with `oil_change`, `spark_plugs`; add `brake_pad`/`battery` per-vehicle where offered). Do **not** treat it as a comprehensive primary source.
2. **Drop the dollar→hours reverse-engineering** (`dollarsToHours` in `repairpalLaborFirecrawl.ts`) in favor of the JSON `minutes` reader — exact, not a guesstimate.
3. **Solve two matching problems before flipping any flag:**
   - **Model granularity:** map our model (e.g. "3 Series") to RepairPal's trim-as-model entries for makes that split that way (BMW, etc.).
   - **Variant→config selection:** choose the right `submodel`/`engine_base` (and `position_count`) variant for our specific config; the high spread makes this load-bearing.
4. **Skip firecrawl for access** — direct GET works headless from the deployment. Keep it only as a documented proxy fallback if RepairPal ever rate-limits at fleet volume.
5. **Treat empty estimates as per-vehicle service-availability**, not failure — confirm each (vehicle, service) is offered rather than assuming the global serviceId applies.
6. **The mandated shadow-diff gate** (spec/handoff) remains required before flipping `LABOR_SOURCE_REPAIRPAL` — and should now be scoped to the covered services only.

---

## Probe lifecycle

`convex/devOnly/repairpalMinutesSpread.ts` is a **throwaway diagnostic** (like `laborWebSpread.ts`). Keep it until the production RepairPal-`minutes` integration is designed (it can re-pull the spread for any fleet slice via the `vehicles`/`services`/`includeComposite` args), then delete. Raw report from this run was captured and reviewed; no data was written to any table (read-only probe).
