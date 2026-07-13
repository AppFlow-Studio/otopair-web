/**
 * warningLightVocab — the single, format- and vocabulary-agnostic reader for
 * `vehicle_owners.knownIssues`.
 *
 * WHY THIS EXISTS
 * ---------------
 * `knownIssues` is written in two incompatible SHAPES depending on which path
 * last touched it:
 *   • LEGACY sentinel-prefixed — `[status, ...lights]` where `status` is one of
 *     `no_all_clear | check_engine | other | not_sure | different_light`.
 *     Written by the onboarding stepper (convex/vehicles.ts) +
 *     autoCompleteNewVehicleOnboarding.
 *   • FLAT code-set — a bare list of light-id codes, no sentinel. Written by the
 *     quarterly check-in (convex/checkin.ts) and by Oto (convex/vehicleTruth.ts
 *     applyVehicleTruth, which raw-appends).
 *
 * It also mixes two VOCABULARIES:
 *   • CANONICAL dashboard light ids the client health/tracker readers key on:
 *     `oil_pressure | battery_charging | temperature | abs | tpms | airbag_srs |
 *      transmission | check_engine | not_sure_which`.
 *   • SYMPTOM codes written by the pipeline / serviceSymptoms.ts / check-in:
 *     `brake_warning | battery | battery_hesitate | battery_no_start |
 *      tire_issue | TPMS | soft_slow | alignment | ...`. Crucially
 *     `brake_warning != abs` and `battery != battery_charging`.
 *
 * Readers that assumed `knownIssues[0]` was a sentinel (health-score penalty,
 * the consolidated warning-light card) silently dropped lights written in the
 * flat shape; readers that hard-coded a canonical `.includes()` missed lights
 * written in the symptom vocabulary. This module collapses BOTH axes: scan the
 * WHOLE array, map any recognised alias to its canonical light id, drop
 * everything that isn't a dashboard light. Every warning-light reader should go
 * through `canonicalWarningLights` so a light logged via ANY writer surfaces
 * consistently on the Cars tracker, the Home Now-tier, and the health score.
 *
 * Pure module: zero React Native / Convex / `@/` value imports, so it is safe to
 * import from client hooks, `utils/`, and Convex server code alike.
 */

/** Canonical dashboard warning-light ids — the vocabulary the client
 *  health-score + maintenance-tracker readers key on. */
export const CANONICAL_WARNING_LIGHTS = [
  "oil_pressure",
  "battery_charging",
  "temperature",
  "abs",
  "tpms",
  "airbag_srs",
  "transmission",
  "check_engine",
  "not_sure_which",
] as const;

export type CanonicalWarningLight = (typeof CANONICAL_WARNING_LIGHTS)[number];

const CANONICAL_SET: ReadonlySet<string> = new Set(CANONICAL_WARNING_LIGHTS);

/** The four lights that escalate a matching maintenance tile to the Now tier
 *  (handled by the paired-tile path in useMaintenanceData / vehicleHealth), so
 *  the consolidated "warning lights active" card excludes them to avoid a
 *  double prompt for one root cause. */
export const PAIRED_WARNING_LIGHTS: ReadonlySet<string> = new Set([
  "oil_pressure",
  "battery_charging",
  "abs",
  "tpms",
]);

/**
 * Symptom-code / stepper-sentinel vocabulary → canonical light id. Keys are the
 * exact tokens that appear in stored `knownIssues` arrays. Anything not a
 * dashboard light (bare sentinels `no_all_clear` / `other` / `different_light`,
 * pure symptom codes `soft_slow` / `alignment` / `diagnostic_noise`) is
 * intentionally absent — it maps to nothing.
 */
const ALIAS_TO_CANONICAL: Readonly<Record<string, string>> = {
  brake_warning: "abs",
  battery: "battery_charging",
  battery_hesitate: "battery_charging",
  battery_no_start: "battery_charging",
  tire_issue: "tpms",
  TPMS: "tpms",
  tire_pressure: "tpms",
  oil: "oil_pressure",
  not_sure: "not_sure_which",
};

/**
 * Map one raw `knownIssues` code to its canonical dashboard-light id, or `null`
 * if the code is not a warning light (a sentinel, a non-light symptom code, or
 * unrecognised). Exact-match first, then a lowercase retry so a stray
 * upper/mixed-case id ("TPMS", "Oil_Pressure") still resolves.
 */
export function toCanonicalLight(code: string): CanonicalWarningLight | null {
  if (!code) return null;
  if (CANONICAL_SET.has(code)) return code as CanonicalWarningLight;
  if (code in ALIAS_TO_CANONICAL) return ALIAS_TO_CANONICAL[code] as CanonicalWarningLight;
  const lower = code.toLowerCase();
  if (lower !== code) {
    if (CANONICAL_SET.has(lower)) return lower as CanonicalWarningLight;
    if (lower in ALIAS_TO_CANONICAL) return ALIAS_TO_CANONICAL[lower] as CanonicalWarningLight;
  }
  return null;
}

/**
 * The canonical dashboard warning-light ids present in a `knownIssues` array,
 * deduped and in first-seen order. Format-agnostic (scans the whole array, so
 * the sentinel-prefixed legacy shape and the flat code-set shape both work) and
 * vocabulary-agnostic (symptom aliases fold onto their canonical light).
 */
export function canonicalWarningLights(
  knownIssues?: readonly string[] | null,
): CanonicalWarningLight[] {
  if (!knownIssues || knownIssues.length === 0) return [];
  const out: CanonicalWarningLight[] = [];
  for (const code of knownIssues) {
    const canonical = toCanonicalLight(code);
    if (canonical && !out.includes(canonical)) out.push(canonical);
  }
  return out;
}

/**
 * Canonicalise a single fault-light id as emitted by Oto's render_vehicle_update
 * before it is written to `knownIssues`, so the stored value matches the reader
 * vocabulary. Recognised aliases (e.g. the wrong `tire_pressure` the tool schema
 * example used) fold to canonical; anything unrecognised passes through
 * unchanged so we never silently drop a user-reported light.
 */
export function normalizeFaultLight(raw: string): string {
  const trimmed = raw.trim();
  return toCanonicalLight(trimmed) ?? trimmed;
}
