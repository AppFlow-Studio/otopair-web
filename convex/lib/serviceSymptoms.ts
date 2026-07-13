/**
 * serviceSymptoms.ts — pure map between otopair services and the knownIssues
 * warning-light vocabulary the maintenance pipeline reads
 * (maintenance_pipeline.ts:564-575 derives QuickReadFlags from owner.knownIssues).
 * ADD a code when a user reports a service due/light-on (vehicleTruth), CLEAR it
 * when the service is recorded done (maintenance.upsertRecord / vehicleTruth /
 * bookings completion). The clear-paths fold each code to its CANONICAL light id
 * (lib/warningLightVocab: brake_warning→abs, battery→battery_charging) and remove
 * either form, so a light logged canonically via Oto still clears here.
 *
 * COVERAGE — every dashboard warning light that has a corresponding service maps
 * to it, so completing that service clears the light:
 *   oil_pressure   ← oil_change
 *   abs            ← brake_pad_replacement / rotor_replacement / brake_fluid_flush
 *   battery(_charging) ← battery_replacement / battery_test
 *   temperature    ← coolant_flush
 *   transmission   ← transmission_service
 *   tpms           ← tire_rotation / tire_balance / wheel_alignment
 *   check_engine   ← check_engine_diagnosis
 * (airbag_srs / not_sure_which have no single routine service — they clear via a
 * specific diagnostic/repair Oto scopes case-by-case, not a catalog service.)
 *
 * Values keep the established symptom vocab where one exists (brake_warning,
 * battery) so the pipeline QuickReadFlags + existing tests stay stable; lights
 * with no separate symptom code use their canonical id (temperature, transmission,
 * tpms). All are understood by both the pipeline reader and canonicalWarningLights.
 */
export const SYMPTOM_BY_SERVICE_SLUG: Record<string, string> = {
  oil_change: "oil_pressure",
  brake_pad_replacement: "brake_warning",
  rotor_replacement: "brake_warning",
  brake_fluid_flush: "brake_warning",
  battery_replacement: "battery",
  battery_test: "battery",
  coolant_flush: "temperature",
  transmission_service: "transmission",
  tire_rotation: "tpms",
  tire_balance: "tpms",
  wheel_alignment: "tpms",
  check_engine_diagnosis: "check_engine",
};

export const SYMPTOM_BY_RECORD_TYPE: Record<string, string> = {
  oil: "oil_pressure",
  brakes: "brake_warning",
  tires: "tpms",
  battery: "battery",
  diagnostics: "check_engine",
};

export function symptomForServiceSlug(slug: string): string | null {
  return SYMPTOM_BY_SERVICE_SLUG[slug] ?? null;
}
export function symptomForRecordType(type: string): string | null {
  return SYMPTOM_BY_RECORD_TYPE[type] ?? null;
}
