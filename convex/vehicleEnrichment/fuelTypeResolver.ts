/**
 * vehicleEnrichment/fuelTypeResolver.ts — P1 of variant identification:
 * authoritative fuel-class resolution with gas-vs-diesel disambiguation.
 *
 * WHY: fuel_class is the highest-consequence identity facet — it decides
 * spark-plugs-vs-glow-plugs and diesel-specific consumables. Batch-8's Wrangler
 * EcoDiesel decoded fuel=Diesel correctly, but a nameplate shared with a gas
 * sibling still leaked gas parts because the fuel signal wasn't treated as
 * authoritative and cross-checked. This resolver consolidates the decode
 * signals (NHTSA FuelTypePrimary + VDB) AND cross-checks them against the
 * ENGINE (a Cummins / EcoDiesel / TDI engine is diesel no matter what the fuel
 * field says) — so a nameplate's gas/diesel split is resolved from the actual
 * powertrain, not a single possibly-stale field.
 *
 * Deterministic-first (design principle): unambiguous engine markers +
 * source agreement resolve the vast majority. `needs_adversarial` is set for the
 * genuinely-ambiguous remainder (conflicting sources, no engine signal) so a
 * later web-search leg can be added without this module ever GUESSING.
 *
 * Pure module — no IO. Exported for tests.
 */

import { classifyFuelClass, type FuelClass } from "./variantFingerprint";

export interface FuelResolutionInputs {
  /** NHTSA FuelTypePrimary. */
  nhtsa_fuel_type: string | null;
  /** VDB fuelType (if the advanced decode ran). */
  vdb_fuel_type?: string | null;
  /** Resolved/raw engine code. */
  engine_code?: string | null;
  /** NHTSA EngineManufacturer (e.g. "Cummins", "VM Motori"). */
  engine_manufacturer?: string | null;
  /** VDB engine description (e.g. "3.0L V6 EcoDiesel"). */
  engine_description?: string | null;
}

export interface FuelResolution {
  fuel_class: FuelClass | null;
  /** 0..1; 0 when unresolved. */
  confidence: number;
  source: string;
  /** True when the decode sources / engine signal disagreed. */
  conflict: boolean;
  /** True when the case is ambiguous and would benefit from a web-search leg
   *  (not yet implemented — this module never guesses in the meantime). */
  needs_adversarial: boolean;
  reason: string;
}

// Unambiguous DIESEL markers, split by match strategy. Kept conservative on
// purpose — a false "diesel" would wrongly strip a gas car's spark plugs.
//
// LONG markers are descriptive enough to substring-match safely.
const DIESEL_LONG_MARKERS: readonly string[] = [
  "diesel",
  "ecodiesel", "eco diesel",
  "cummins", "duramax", "power stroke", "powerstroke", "power-stroke",
  "vm motori", "detroit diesel", "maxxforce", "navistar",
  "bluetec", "blue tec", "turbodiesel", "turbo diesel", "multijet",
  "skyactiv-d", "d-4d",
];
// SHORT acronyms (tdi, hdi, isb…) — matched at a word start and NOT followed by
// another letter, so "ISB6.7" / "2.0 TDI" match but "isbell"/"prisboxer" don't.
const DIESEL_SHORT_ACRONYMS: readonly string[] = [
  "tdi", "cdti", "crdi", "cdi", "hdi", "dci", "d4d",
  "isb", "isx", "isl", "isc", // Cummins B/X/L/C series codes
];

/** True when the engine identity unambiguously indicates a diesel. Checks the
 *  engine code, manufacturer, and description. Short acronyms are matched with a
 *  leading word boundary + a "not followed by a letter" guard so a code like
 *  "ISB6.7" (acronym + digits) matches while unrelated words do not. */
export function engineIndicatesDiesel(
  engineCode?: string | null,
  engineManufacturer?: string | null,
  engineDescription?: string | null,
): boolean {
  const hay = `${engineCode ?? ""} ${engineManufacturer ?? ""} ${engineDescription ?? ""}`
    .toLowerCase();
  if (!hay.trim()) return false;
  if (DIESEL_LONG_MARKERS.some((m) => hay.includes(m))) return true;
  for (const m of DIESEL_SHORT_ACRONYMS) {
    // \b<acronym>(?![a-z]) — starts on a boundary, not part of a longer word.
    if (new RegExp(`\\b${m}(?![a-z])`, "i").test(hay)) return true;
  }
  return false;
}

/**
 * Resolve the authoritative fuel class from the decode sources + the engine.
 *
 * Priority of truth:
 *  1. An unambiguous DIESEL engine marker (Cummins/EcoDiesel/TDI…) — engine
 *     hardware beats a fuel field. If the decode said gasoline, that's a decode
 *     error; override to diesel and flag the conflict.
 *  2. Agreement between NHTSA and the engine signal → high confidence.
 *  3. NHTSA alone (VDB agreeing raises confidence; disagreeing lowers it).
 *  4. Nothing usable → null (fail open), needs_adversarial when ambiguous.
 */
export function resolveFuelClass(input: FuelResolutionInputs): FuelResolution {
  const nhtsa = classifyFuelClass(input.nhtsa_fuel_type);
  const vdb = classifyFuelClass(input.vdb_fuel_type);
  const engineDiesel = engineIndicatesDiesel(
    input.engine_code, input.engine_manufacturer, input.engine_description,
  );

  const decodeConflict = nhtsa != null && vdb != null && nhtsa !== vdb;

  // 1. Engine hardware is the strongest signal for the diesel split.
  if (engineDiesel) {
    if (nhtsa === "diesel" || vdb === "diesel") {
      return {
        fuel_class: "diesel", confidence: 0.97, source: "nhtsa+engine_agree",
        conflict: false, needs_adversarial: false,
        reason: "engine markers and decode agree on diesel",
      };
    }
    if (nhtsa == null && vdb == null) {
      return {
        fuel_class: "diesel", confidence: 0.9, source: "engine_signal",
        conflict: false, needs_adversarial: false,
        reason: "diesel engine marker; decode fuel type absent",
      };
    }
    // Decode said something non-diesel but the engine is unambiguously diesel.
    return {
      fuel_class: "diesel", confidence: 0.85, source: "engine_override",
      conflict: true, needs_adversarial: false,
      reason: `engine is diesel but decode said "${nhtsa ?? vdb}" — trusting engine hardware`,
    };
  }

  // 2/3. No diesel engine signal — go with the decode sources.
  const decodeClass = nhtsa ?? vdb;
  if (decodeClass == null) {
    return {
      fuel_class: null, confidence: 0, source: "none",
      conflict: false, needs_adversarial: true,
      reason: "no usable fuel signal from decode or engine",
    };
  }
  if (decodeConflict) {
    // NHTSA and VDB disagree and no engine tiebreak — keep NHTSA (the VIN-
    // authoritative source) but low-confidence + flag for a later web leg.
    return {
      fuel_class: nhtsa, confidence: 0.6, source: "nhtsa_over_vdb_conflict",
      conflict: true, needs_adversarial: true,
      reason: `NHTSA "${nhtsa}" vs VDB "${vdb}" — kept NHTSA, needs corroboration`,
    };
  }
  // Sources agree (or only one present).
  const bothAgree = nhtsa != null && vdb != null && nhtsa === vdb;
  return {
    fuel_class: decodeClass,
    confidence: bothAgree ? 0.92 : nhtsa != null ? 0.85 : 0.78,
    source: bothAgree ? "nhtsa+vdb_agree" : nhtsa != null ? "nhtsa" : "vdb",
    conflict: false, needs_adversarial: false,
    reason: bothAgree ? "NHTSA and VDB agree" : "single decode source",
  };
}
