// =============================================================================
// DEPRECATED — see convex/oto/vehicleFactsEditing.ts
// =============================================================================
//
// Sprint 1 Day 1 correction (2026-05-16). The original Sprint 1 Day 1 created
// this file as the mutation helper for a parallel `vehicle_searched_facts`
// table. Waleed ruled the parallel table was wrong — it was the same thing
// as `vehicle_facts` (which already had `source: "web_search"` as an enum
// value). Consolidation v3 collapsed the tables and renamed the helper.
//
// This file is a deprecation stub. It re-exports from the consolidated
// helper so any in-flight import (there shouldn't be any — Sprint 1 Day 1
// landed nothing that called it) doesn't break.
//
// New code MUST import from `convex/oto/vehicleFactsEditing.ts` directly.
//
// CI grep rule 5 (scripts/ci/vehicle-facts-grep.sh) catches any new code
// that references this file path or the `vehicle_searched_facts` table name.
// =============================================================================

export {
  recordVehicleFact,
  editVehicleFact,
  reportVehicleFact,
  resolveFactReport,
} from "./vehicleFactsEditing";
