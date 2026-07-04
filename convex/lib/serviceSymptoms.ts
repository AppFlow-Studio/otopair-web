/**
 * serviceSymptoms.ts — pure map between otopair services and the knownIssues
 * warning-light vocabulary the maintenance pipeline reads
 * (maintenance_pipeline.ts:564-575 derives QuickReadFlags from owner.knownIssues).
 * ADD a code when a user reports a service due/light-on (vehicleTruth), CLEAR it
 * when the service is recorded done (maintenance.upsertRecord). Scoped to the
 * unambiguous warning-light categories the pipeline overrides on; other services
 * have no code (v1 limitation — they can't be auto-flagged/cleared from chat).
 */
export const SYMPTOM_BY_SERVICE_SLUG: Record<string, string> = {
  oil_change: "oil_pressure",
  brake_pad_replacement: "brake_warning",
  rotor_replacement: "brake_warning",
  battery_replacement: "battery",
  battery_test: "battery",
  check_engine_diagnosis: "check_engine",
};

export const SYMPTOM_BY_RECORD_TYPE: Record<string, string> = {
  oil: "oil_pressure",
  brakes: "brake_warning",
  battery: "battery",
  diagnostics: "check_engine",
};

export function symptomForServiceSlug(slug: string): string | null {
  return SYMPTOM_BY_SERVICE_SLUG[slug] ?? null;
}
export function symptomForRecordType(type: string): string | null {
  return SYMPTOM_BY_RECORD_TYPE[type] ?? null;
}
