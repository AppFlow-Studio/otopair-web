# Oto Vehicle-Truth Capture — verification

**Date:** 2026-06-23 · **Branch:** `waleed-fix` · **Spec:** `docs/superpowers/specs/2026-06-18-oto-vehicle-truth-capture-design.md` · **Plan:** `docs/superpowers/plans/2026-06-23-oto-vehicle-truth-capture.md`

## What was built (commits)

| Commit | Piece |
|---|---|
| `2c409cd` | **B1** mileage guard (`computeMaxDelta`, `validateMileageUpdate`) — pure, 7 unit tests |
| `2475c0e` | **B2** `vehicle_owners.mileage_source` + `mileage_updated_at` |
| `1d33fcf` + `576bc41` | **B3** `vehicleTruth.applyVehicleTruth` mutation (guarded mileage + knownIssues writes + pipeline re-run), corrected to the real mechanism |
| `3f1e20a` | **B4** `render_vehicle_update` render tool (tools/chat/dispatcher) |
| `84c6545` | **B5** prompt rules — P1 truth-precedence, P3 intent split, P4 hallucination guard, tool doc |
| `1a9eb53` | **B6** `runPipeline` `triggeredBy:"oto_chat"` (intervals-only) |

## Key correctness fix (B3)

The spec said "set `vehicle_service_states.quick_read_flag` directly." That is **wrong**: `maintenance_pipeline.ts:564` derives the quick-read overrides FROM `owner.knownIssues` (`warning_light_oil = knownIssues.includes("oil_pressure")`, …) and **writes** `quick_read_flag` as its OUTPUT (line 744). A direct write is clobbered by the `runPipeline` the mutation triggers. **Fix:** `applyVehicleTruth` adds the warning-light code to `knownIssues` (via `lib/serviceSymptoms`), and the pipeline flags the service. `maintenance.upsertRecord` **clears** the code when the service is recorded done. Round-trip covered for **oil / brakes / battery / engine-diagnostics** (the unambiguous warning-light categories); other services have no quick-read override input (v1 limitation).

## Verified automatically (14 tests green + drift-guard + compile)

- Mileage guard: plausible-forward accepted; first-reading accepted; backward / absurd-forward / implausible rejected.
- `applyVehicleTruth`: plausible mileage → `mileage` + `mileage_source="chat_self_reported"` + `mileage_updated_at`; backward → `needsReconfirm` with NO write; `service_claims` → warning-light code in `knownIssues`; `fault_lights` → appended to `knownIssues`.
- `upsertRecord` clears the matching code from `knownIssues` on a recorded service (and leaves unrelated codes).
- `serviceSymptoms` slug/type → code maps.
- Tool drift-guard (`chat.ts:226-244`) passes: `render_vehicle_update` is in `TOOL_NAMES_V1`, referenced in the prompt, dispatched. `npx convex dev --once` compiles clean.

## Acceptance criteria — LIVE eval (Oto Sim `#otoSim`, pending)

Replay the transcript on a vehicle whose `inferred` projection says "oil not due for ~7 weeks":
> User: "The oil-change light is on, I'm at 46,796 miles."

Expected:
1. Oto does **not** argue the 7-weeks projection (P1).
2. Oto acknowledges + fires `render_vehicle_update` with `{ mileage: 46796, service_claims: [{ service_slug: "oil_change", kind: "light_on" }] }` (P3).
3. On confirm → `applyVehicleTruth`: `mileage=46796` (+ provenance), `"oil_pressure"` added to `knownIssues`; `runPipeline(triggeredBy:"oto_chat")` recomputes → the oil service surfaces as due via the quick-read override.
4. Later, when the oil change is recorded (`upsertRecord type:"oil"`), `"oil_pressure"` is cleared → the service stops being flagged.
5. Oto never cites a warning light absent from `knownIssues`/the user's turn (P4).

**Status:** code complete + unit/integration-test green; the live Haiku-behavior eval (steps 1–2 — does the model fire the tool and not argue) is the one piece that needs a runtime session in the Oto Sim.
