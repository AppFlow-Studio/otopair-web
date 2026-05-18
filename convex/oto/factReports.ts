// =============================================================================
// Oto AI — fact-reports re-export alias for the eval harness
// =============================================================================
//
// Sprint 1 Day 4 (2026-05-16). Owner: Memory Systems Engineer.
//
// The canonical mutation is `reportVehicleFact` exported from
// `convex/oto/vehicleFactsEditing.ts` — the single sanctioned helper for
// every mutation against vehicle_facts (see file header there).
//
// The QA Lead's Day 3 harness referenced the mutation as
// `api.oto.factReports.report` (see scripts/eval/wave_1_4_v3_harness.ts
// "Day 4 prerequisites" #3 and scripts/eval/README.md §"Day 4
// prerequisites"). Rather than rewrite the harness every time the helper's
// filename moves, this stub decouples the eval-facing API surface from the
// helper's filename. If `vehicleFactsEditing.ts` ever moves or splits, only
// this file updates.
//
// IMPORTANT — this file MUST NOT contain its own mutation logic. It is a
// pure re-export. Adding logic here would double the surface area the
// vehicle_facts CI grep needs to police (rules 1-3 enforce that
// vehicleFactsEditing.ts is the SOLE write path). Keeping this as a
// re-export keeps the invariant local.
// =============================================================================

export { reportVehicleFact as report } from "./vehicleFactsEditing";
