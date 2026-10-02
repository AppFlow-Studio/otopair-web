/**
 * lib/engineCodeShape.ts — is an engine_code a real OEM code, or a stand-in?
 *
 * Dependency-free so queries and portal components can use it. It used to live
 * in vehicleEnrichment/utils/engineLookup.ts, which pulls in the Anthropic SDK;
 * that file re-exports it, so existing imports are unchanged.
 *
 * Why display code needs it: when no source names the engine, the decode stores
 * a synthetic key like "2l_4cyl" (vehicle_pipeline.ts LAST RESORT). It must stay
 * on the engine row — the config_key is built from it — but it is not a name.
 * Bug #351: the shop's completion survey printed "2L 2l_4cyl · X trim".
 */

/**
 * Marketing terms and brand names that are NOT real OEM engine codes.
 * Shared classifier — vehicle_pipeline.ts, capacityResolver.ts, and
 * fleetEval.ts all import isSyntheticEngineCode (via engineLookup.ts).
 */
const MARKETING_TERMS = new Set([
  "tsi", "tfsi", "tdi", "fsi", "ecoboost", "coyote", "powerboost",
  "vtec", "ivtec", "earth dreams", "skyactiv-g", "skyactiv-d",
  "ecotec", "duramax", "vortec", "hemi", "pentastar", "hurricane",
  "boxer", "fa", "fb", "gdi", "mpi", "t-gdi", "nu mpi", "nu",
  "smartstream", "theta", "theta ii", "lambda", "lambda ii", "sigma",
  "kappa", "gamma", "delta", "epsilon", "zeta",
  "hr", "mr", "vr", "sr", "qr", "hybrid", "phev", "bev", "ev",
]);

/**
 * Engine-tech descriptor vocabulary that is never an OEM engine code on its
 * own. Fresh-VIN test (Aug 2026): NHTSA's EngineModel "PY Cylinder
 * Decativation" (sic — NHTSA's own typo) led with a plausible code fragment,
 * so the marketing-term prefix check missed it and the string was stored
 * verbatim, keying a config as ..._py_cylinder_decativation. The real code
 * (PY-VPS) is a compact single token — like every real OEM code.
 */
const DESCRIPTOR_WORDS = new Set([
  "cylinder", "cylinders", "deactivation", "decativation", "displacement",
  "turbo", "turbocharged", "biturbo", "supercharged", "aspirated", "na",
  "dohc", "sohc", "ohv", "ohc", "valve", "valves", "vvt", "cvvt",
  "injection", "injected", "diesel", "gasoline", "flex", "electric",
  "engine", "motor", "liter", "litre", "skyactiv",
  "i3", "i4", "i5", "i6", "v6", "v8", "v10", "v12", "h4", "h6",
]);

/** Returns true if the engine code is a synthetic fallback, not a real OEM code. */
export function isSyntheticEngineCode(code: string): boolean {
  if (!code) return true;
  const lower = code.trim().toLowerCase();
  // Synthetic numeric format: "2.0l_4cyl", "unknown_unknowncyl", "3.5l_6cyl"
  if (/^[\d.]+l_\d+cyl$/i.test(code) || /^unknown/i.test(code)) return true;
  // Marketing terms (not real OEM codes)
  if (MARKETING_TERMS.has(lower)) return true;
  // Starts with a known marketing term (e.g. "Nu MPI 2.0" → starts with "nu mpi")
  if ([...MARKETING_TERMS].some((term) => lower.startsWith(term + " ") || lower.startsWith(term + "_"))) return true;
  // Real OEM codes are compact single tokens ("B48B20M1", "2GR-FE", "PY-VPS")
  // — whitespace means a descriptor phrase, whatever word it leads with.
  if (/\s/.test(lower)) return true;
  // Real OEM codes never use underscores; "_" is the synthetic-key separator.
  // Also covers decimal-cylinder synthetics ("3.6l_3.6cyl") that slip the
  // \d+cyl pattern above.
  if (lower.includes("_")) return true;
  // ...and never run long. Longest real designations ("M256E30DEHLG",
  // "OM651DE22LA") stay ≤ 13 chars; the 14 ceiling matches isNhtsaDescriptor
  // (utils/engineCodeLookup.ts) so the two classifiers agree.
  if (lower.length > 14) return true;
  // Single-token descriptor words ("Turbo", "DOHC", "Decativation")
  if (DESCRIPTOR_WORDS.has(lower)) return true;
  return false;
}

/** The engine code worth showing a person, or null when it's a stand-in. */
export function displayEngineCode(code: string | null | undefined): string | null {
  const c = typeof code === "string" ? code.trim() : "";
  return c && !isSyntheticEngineCode(c) ? c : null;
}

/**
 * Displacement as people write it: 2 → "2.0L", 3.6 → "3.6L". The decode stores
 * whatever vPIC sent, and vPIC sends "2" for a 2.0-litre engine.
 */
export function formatDisplacementL(value: number | string | null | undefined): string | null {
  const n = typeof value === "number" ? value : parseFloat(String(value ?? ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return `${Number.isInteger(n) ? n.toFixed(1) : String(n)}L`;
}
