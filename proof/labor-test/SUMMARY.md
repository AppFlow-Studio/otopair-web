# New labor-system test — 4 VINs

Enriched fresh on flippant-mink (`vehicleEnrichment/runPublic:go {vin}`) — runs the new RepairPal labor pipeline (exact-nameplate → engine/chassis-sibling fallback → source-weighted median → quote gate). All 4 decoded and reached `enrichment_status: complete`.

| VIN | Decoded | Resolution | Graded | Verdict |
|---|---|---|---|---|
| WP0AD2A99JS156240 | 2018 Porsche 911 Turbo S (MA1.76 flat-6) | **exact "911"** | 6/5 | ✅ pass |
| YV4A22PKXL1620464 | 2020 Volvo XC90 T6 Momentum (B4204TS) | exact "xc90" + spark via **XC40** engine-sibling | 6/5 | ✅ pass |
| 2HGFC2F89LH556366 | 2020 Honda Civic Sport (K20C2) | **exact "civic"** | 6/5 | ✅ pass |
| 55SWF8HB1JU241919 | 2018 Mercedes-AMG C63 S (M177 V8) | oil+spark via **engine-family `M177 ← e43-amg`**; rest gated out | 6/2 | ⚠️ pass w/ flag |

## Per-car RepairPal-sourced hours (weight 0.8)

**Porsche 911 Turbo S** — exact "911" nameplate:
`oil 0.47h · spark 3.01h · brake 1.16h · wheel_alignment 2.32h · battery 1.16h` — all quote-graded (conf 0.8–0.9).

**Volvo XC90 T6** — exact "xc90", except spark from the XC40 sibling (shares B4204 engine):
`oil 0.58h · spark 1.04h (← xc40) · brake 1.27h · wheel_alignment 1.39h · battery 0.93h · timing_belt 4.17h`. Timing belt correctly applicable (Volvo Drive-E wet belt); gated to N/A on the chain engines.

**Honda Civic Sport (K20C2)** — exact "civic":
`oil 0.58h · spark 1.27h · brake 1.04h · wheel_alignment 1.27h · battery 0.58h`. Same engine as the Civic LX already in the catalog — clean exact match.

**Mercedes-AMG C63 S (M177 V8)** — only oil + spark got RepairPal data:
`oil 0.58h · spark 4.63h (← e43-amg)`. Brake/battery/alignment found **no** RepairPal match, so the **gate held them at conf 0.4 (grade=false)** rather than fabricating — correct, honest behavior for an ultra-niche AMG.

## What the test proves
- **Pipeline works on niche cars.** A Porsche 911 Turbo S and a Volvo XC90 both got full RepairPal-gated labor; the gate didn't fall over.
- **Sibling resolution fires when there's no exact match** — Volvo spark ← XC40 (same B4204 engine) is a correct engine-family hop.
- **The quote gate is doing its job** — on the C63 it refused to grade the services it had no validated source for, instead of passing off guesses at high confidence. mapped 6/2 is the honest count.
- **Hours scale with the engine** (sanity): spark plugs — Civic/Volvo 4-cyl ~1.0–1.3h < Porsche flat-6 TT 3.0h < AMG V8 4.6h.

## 🐛 Confirmed bug — sibling router trusts the LLM's self-reported engine family
The C63 S (engine **M177**, 4.0 V8 biturbo) sourced its engine-determined labor from **`e43-amg`** — but the AMG E43 is a **3.0 V6 (M276)**, not M177. Root cause, traced in `convex/vehicleEnrichment/laborSibling.ts`:

- `resolveLaborSibling` (l.244) keeps candidates that pass `siblingMatches(determinant, target, candidate)`.
- For an engine-determined service, `siblingMatches` (l.49-51) only checks **string equality**: `target.engine_family === candidate.engine_family`.
- The candidate's `engine_family` comes **straight from the LLM** — `llmSiblingCandidates` (l.168-189) asks Claude to "list other models sharing engine family M177 … return its engine family" and stores the LLM's answer verbatim. No ground-truth check.
- So the check is **circular**: the LLM claimed `{model:"E43 AMG", engine_family:"M177"}` (a hallucination — E43 is M276), and `siblingMatches` compared the LLM's "M177" to the target's "M177" → trivially true. The calibration probe (l.253) only confirms a RepairPal spark-plug page *exists* for the E43, not that the engine matches.
- The trustworthy `catalogSiblingCandidates` path (engine_family derived from real engine codes) found **no** M177 sibling — our catalog has no E63/S63/GT — so it fell through to the unverified LLM candidate.

**Impact:** `spark_plugs 4.63h` (engine-determined) came from a V6 sibling for a V8 car. `oil_change 0.58h` is engine-independent → unaffected. All other C63 services were correctly gated out (conf 0.4).

**Fix options:** (1) re-derive/verify a candidate's engine family from ground truth (catalog or an engine table) before `siblingMatches` accepts it — never trust the LLM's self-reported family; (2) sanity-check cylinder count in the calibration probe; (3) seed the catalog with real M177 siblings (E63/S63/AMG GT) so the trustworthy path wins.

## Commands
```bash
npx convex run vehicleEnrichment/runPublic:go '{"vin":"WP0AD2A99JS156240"}'   # + the other 3
npx convex run devOnly/laborValidation:report '{}'
npx convex run devOnly/verifyLabor:labor '{"trimContains":"C 63"}'             # shows match_key / sibling_slug
```
(`runPublic:go` returns an "Error" — its 20-min poller exceeds Convex's action limit; enrichment completes async, verified via `enrichmentLockState`.)
