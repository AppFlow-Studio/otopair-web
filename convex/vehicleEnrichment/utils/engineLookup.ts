/**
 * vehicleEnrichment/utils/engineLookup.ts — Haiku engine code + family lookup
 *
 * Called during enrichment (after VIN decode) to resolve:
 *   - engine_code: the full OEM variant code (e.g. "B48B20M1", "M276DE35AL", "2GR-FE")
 *   - engine_family: the base engine family (e.g. "B48", "M276", "2GR")
 *
 * When to call:
 *   1. engine_code is synthetic (e.g. "2.0l_4cyl") — VIN decode couldn't find it
 *   2. engine_family is null — never populated, even if code is known
 *
 * Cost: ~$0.002 per call (Haiku + one web search). Always cheaper than re-enriching.
 *
 * Pattern mirrors chassisLookup.ts.
 */

import Anthropic from "@anthropic-ai/sdk";
import { MODEL_HAIKU } from "./batchClient";

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

/** Returns true if the engine code is a synthetic fallback, not a real OEM code. */
/**
 * Marketing terms and brand names that are NOT real OEM engine codes.
 * Shared classifier — vehicle_pipeline.ts, capacityResolver.ts, and
 * fleetEval.ts all import isSyntheticEngineCode from here.
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

// ─── Deterministic engine-code ↔ decoded-engine cross-check ───────────────────
//
// Round-3 (Aug 9 2026), 2022 Porsche Macan WP1AA2A59NLB00450: vPIC decoded
// DisplacementL 2.0 / EngineCylinders 4 / 261 hp — the EA888 four. The config
// stored **EA839**, the 2.9L V6 biturbo of the Macan S/GTS/Turbo (VDB decoded
// the trim as "S"). Every existing guard passed it: EA839 is a real Porsche
// code in real code FORMAT, so isSyntheticEngineCode cannot see it, and the
// adversarial web verifier cannot reliably refute a code that genuinely exists
// on the same nameplate in the same model year.
//
// A code's displacement and cylinder count are static public facts, so this is
// a table, not a model call — the same reasoning as generationGate.ts. It is a
// CONTRADICTION detector, not a whitelist: a code the table doesn't know, or a
// decode with no displacement/cylinders, passes through untouched. Only a
// positive, factual disagreement rejects.

/** Displacement agreement slack, in litres: "equal at one decimal place".
 *  vPIC reports one decimal and the tables store one decimal, so 0.05 absorbs
 *  rounding and badge-vs-actual drift ("2.9 TFSI" measures 2894cc) while still
 *  separating engines that differ by a single tenth. That separation is the
 *  point — a 2.4 and a 2.5 are different engines with different parts, and a
 *  wider slack (the 0.15 used for trim-embedded displacement strings in
 *  vehicle_pipeline.ts) silently equates them. */
const DISPLACEMENT_TOLERANCE_L = 0.05;

interface EngineSpecFacts {
  /** Inclusive displacement span of the family, in litres. */
  minL: number;
  maxL: number;
  /** Omitted when the family genuinely spans cylinder counts (VW EA211 ships
   *  as both a 1.0 three and a 1.5 four) — absence means "no claim", never
   *  "any value is fine to assert". */
  cylinders?: number;
  note: string;
}

/**
 * Engine family prefix (normalized: A-Z0-9 only) → its physical facts.
 *
 * Keyed by FAMILY prefix so full variant codes match without an entry each:
 * "B48B20M1" → B48, "2GR-FE" → 2GR, "PR25DD" → PR25, "M256E30DEHLG" → M256.
 *
 * Extending: only add a prefix that CANNOT be a prefix of a different maker's
 * code. Toyota's M20A-FKS and BMW's M20 collide under prefix matching, so the
 * key here is the unambiguous "M20A" and BMW's M20 is deliberately absent —
 * a missing entry costs nothing (fail-open), a colliding one produces false
 * rejections of correct codes.
 */
const ENGINE_SPEC_TABLE: Record<string, EngineSpecFacts> = {
  // ── VW / Audi / Porsche (VAG) ──
  EA888: { minL: 1.8, maxL: 2.0, cylinders: 4, note: "VAG 1.8/2.0 TFSI I4" },
  // VAG also stamps a per-application letter code (Motorkennbuchstabe) that
  // never mentions its EA family. DMTD is the 95B Macan's 2.0 TFSI (1984cc,
  // 195 kW) — the engine EA839 was wrongly stored over. Confirmed against
  // AMSOIL's catalog entry "2022 Porsche MACAN (2.0L 4-cyl Engine Code DMTD)".
  DMTD: { minL: 2.0, maxL: 2.0, cylinders: 4, note: "VAG/Porsche 2.0 TFSI I4 (95B Macan)" },
  EA839: { minL: 2.9, maxL: 3.0, cylinders: 6, note: "VAG 2.9/3.0 TFSI V6" },
  EA825: { minL: 4.0, maxL: 4.0, cylinders: 8, note: "VAG 4.0 TFSI V8" },
  EA288: { minL: 2.0, maxL: 2.0, cylinders: 4, note: "VAG 2.0 TDI I4" },
  EA211: { minL: 1.0, maxL: 1.6, note: "VAG 1.0-1.6 TSI/MPI (3- and 4-cyl)" },
  // ── BMW ──
  B38: { minL: 1.5, maxL: 1.5, cylinders: 3, note: "BMW 1.5 I3" },
  B46: { minL: 2.0, maxL: 2.0, cylinders: 4, note: "BMW 2.0 I4" },
  B48: { minL: 2.0, maxL: 2.0, cylinders: 4, note: "BMW 2.0 I4" },
  B58: { minL: 3.0, maxL: 3.0, cylinders: 6, note: "BMW 3.0 I6" },
  N20: { minL: 2.0, maxL: 2.0, cylinders: 4, note: "BMW 2.0 I4" },
  N26: { minL: 2.0, maxL: 2.0, cylinders: 4, note: "BMW 2.0 I4 (SULEV)" },
  N54: { minL: 3.0, maxL: 3.0, cylinders: 6, note: "BMW 3.0 I6 twin-turbo" },
  N55: { minL: 3.0, maxL: 3.0, cylinders: 6, note: "BMW 3.0 I6" },
  N63: { minL: 4.4, maxL: 4.4, cylinders: 8, note: "BMW 4.4 V8" },
  S55: { minL: 3.0, maxL: 3.0, cylinders: 6, note: "BMW M 3.0 I6" },
  S58: { minL: 3.0, maxL: 3.0, cylinders: 6, note: "BMW M 3.0 I6" },
  S63: { minL: 4.4, maxL: 4.4, cylinders: 8, note: "BMW M 4.4 V8" },
  // ── Mercedes-Benz ──
  M133: { minL: 2.0, maxL: 2.0, cylinders: 4, note: "MB AMG 2.0 I4" },
  M139: { minL: 2.0, maxL: 2.0, cylinders: 4, note: "MB AMG 2.0 I4" },
  M254: { minL: 2.0, maxL: 2.0, cylinders: 4, note: "MB 2.0 I4" },
  M256: { minL: 3.0, maxL: 3.0, cylinders: 6, note: "MB 3.0 I6" },
  M264: { minL: 2.0, maxL: 2.0, cylinders: 4, note: "MB 2.0 I4" },
  M274: { minL: 1.6, maxL: 2.0, cylinders: 4, note: "MB 1.6/2.0 I4" },
  M276: { minL: 3.0, maxL: 3.5, cylinders: 6, note: "MB 3.0/3.5 V6" },
  M278: { minL: 4.6, maxL: 4.7, cylinders: 8, note: "MB 4.6/4.7 V8" },
  M177: { minL: 4.0, maxL: 4.0, cylinders: 8, note: "MB AMG 4.0 V8" },
  M178: { minL: 4.0, maxL: 4.0, cylinders: 8, note: "MB AMG 4.0 V8" },
  // ── Toyota / Lexus ──
  A25A: { minL: 2.5, maxL: 2.5, cylinders: 4, note: "Toyota 2.5 I4 (Dynamic Force)" },
  M20A: { minL: 2.0, maxL: 2.0, cylinders: 4, note: "Toyota 2.0 I4 (Dynamic Force)" },
  "2AR": { minL: 2.5, maxL: 2.5, cylinders: 4, note: "Toyota 2.5 I4" },
  "2ZR": { minL: 1.8, maxL: 1.8, cylinders: 4, note: "Toyota 1.8 I4" },
  "1GR": { minL: 4.0, maxL: 4.0, cylinders: 6, note: "Toyota 4.0 V6" },
  "2GR": { minL: 3.5, maxL: 3.5, cylinders: 6, note: "Toyota 3.5 V6" },
  "2UR": { minL: 5.0, maxL: 5.0, cylinders: 8, note: "Toyota/Lexus 5.0 V8" },
  "3UR": { minL: 5.7, maxL: 5.7, cylinders: 8, note: "Toyota 5.7 V8" },
  // ── Honda / Acura ──
  K20: { minL: 2.0, maxL: 2.0, cylinders: 4, note: "Honda 2.0 I4" },
  K24: { minL: 2.4, maxL: 2.4, cylinders: 4, note: "Honda 2.4 I4" },
  L15: { minL: 1.5, maxL: 1.5, cylinders: 4, note: "Honda 1.5 I4" },
  R18: { minL: 1.8, maxL: 1.8, cylinders: 4, note: "Honda 1.8 I4" },
  J30: { minL: 3.0, maxL: 3.0, cylinders: 6, note: "Honda 3.0 V6" },
  J35: { minL: 3.5, maxL: 3.5, cylinders: 6, note: "Honda 3.5 V6" },
  // ── Nissan / Infiniti (and Mitsubishi via the alliance) ──
  HR16: { minL: 1.6, maxL: 1.6, cylinders: 4, note: "Nissan 1.6 I4" },
  MR20: { minL: 2.0, maxL: 2.0, cylinders: 4, note: "Nissan 2.0 I4" },
  QR25: { minL: 2.5, maxL: 2.5, cylinders: 4, note: "Nissan 2.5 I4 (pre-2019)" },
  PR25: { minL: 2.5, maxL: 2.5, cylinders: 4, note: "Nissan/Mitsubishi 2.5 I4 (2019+)" },
  KR15: { minL: 1.5, maxL: 1.5, cylinders: 3, note: "Nissan 1.5 VC-Turbo I3" },
  VQ35: { minL: 3.5, maxL: 3.5, cylinders: 6, note: "Nissan 3.5 V6" },
  VR30: { minL: 3.0, maxL: 3.0, cylinders: 6, note: "Nissan 3.0 V6 twin-turbo" },
  // ── Subaru ──
  FA20: { minL: 2.0, maxL: 2.0, cylinders: 4, note: "Subaru 2.0 H4" },
  FA24: { minL: 2.4, maxL: 2.4, cylinders: 4, note: "Subaru 2.4 H4" },
  FB20: { minL: 2.0, maxL: 2.0, cylinders: 4, note: "Subaru 2.0 H4" },
  FB25: { minL: 2.5, maxL: 2.5, cylinders: 4, note: "Subaru 2.5 H4" },
  EJ20: { minL: 2.0, maxL: 2.0, cylinders: 4, note: "Subaru 2.0 H4" },
  EJ25: { minL: 2.5, maxL: 2.5, cylinders: 4, note: "Subaru 2.5 H4" },
  // ── Mitsubishi ──
  "4B11": { minL: 2.0, maxL: 2.0, cylinders: 4, note: "Mitsubishi 2.0 I4" },
  "4B12": { minL: 2.4, maxL: 2.4, cylinders: 4, note: "Mitsubishi 2.4 I4" },
  "4J11": { minL: 2.0, maxL: 2.0, cylinders: 4, note: "Mitsubishi 2.0 I4" },
  "4J12": { minL: 2.4, maxL: 2.4, cylinders: 4, note: "Mitsubishi 2.4 I4" },
  // ── Mazda ──
  PYVPS: { minL: 2.5, maxL: 2.5, cylinders: 4, note: "Mazda Skyactiv-G 2.5 I4" },
  PEVPS: { minL: 2.0, maxL: 2.0, cylinders: 4, note: "Mazda Skyactiv-G 2.0 I4" },
  // ── GM (RPO codes; the model-year half lives in generationGate.ts) ──
  LSD: { minL: 1.5, maxL: 1.5, cylinders: 4, note: "GM 1.5T I4" },
  LYX: { minL: 1.5, maxL: 1.5, cylinders: 4, note: "GM 1.5T I4" },
  LTG: { minL: 2.0, maxL: 2.0, cylinders: 4, note: "GM 2.0T I4" },
  LFX: { minL: 3.6, maxL: 3.6, cylinders: 6, note: "GM 3.6 V6" },
  LGX: { minL: 3.6, maxL: 3.6, cylinders: 6, note: "GM 3.6 V6" },
  L84: { minL: 5.3, maxL: 5.3, cylinders: 8, note: "GM 5.3 V8" },
  L87: { minL: 6.2, maxL: 6.2, cylinders: 8, note: "GM 6.2 V8" },
};

/** Longest table key that prefixes the normalized code. 3-char floor keeps a
 *  short key from swallowing an unrelated maker's code. */
const MIN_PREFIX_LEN = 3;

const normCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

function findEngineSpecFacts(
  code: string | null | undefined,
): { prefix: string; facts: EngineSpecFacts } | null {
  if (!code) return null;
  const norm = normCode(code);
  if (norm.length < MIN_PREFIX_LEN) return null;
  let best: { prefix: string; facts: EngineSpecFacts } | null = null;
  for (const [prefix, facts] of Object.entries(ENGINE_SPEC_TABLE)) {
    if (prefix.length < MIN_PREFIX_LEN) continue;
    if (!norm.startsWith(prefix)) continue;
    if (!best || prefix.length > best.prefix.length) best = { prefix, facts };
  }
  return best;
}

/** Coerce a decoded displacement/cylinder value to a positive number, or null.
 *  Empty strings, zeroes and unparseable junk all mean "not decoded". */
function positiveNumber(raw: number | string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : parseFloat(String(raw));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export type EngineSpecVerdict =
  /** Code not in the table, or the decode makes no claim — no opinion. */
  | { known: false }
  | { known: true; contradicts: false }
  | { known: true; contradicts: true; reason: string };

/**
 * Cross-check an engine code against the vehicle's DECODED displacement and
 * cylinder count.
 *
 * FAIL-OPEN by construction, in both directions: an unknown code returns
 * `{known:false}`, and so does a decode with neither displacement nor
 * cylinders. `contradicts:true` is returned only when the table's facts and
 * the decode positively disagree — never on absence.
 */
export function contradictsDecodedEngine(
  code: string | null | undefined,
  decoded: {
    displacementL?: number | string | null;
    cylinders?: number | string | null;
  },
): EngineSpecVerdict {
  const hit = findEngineSpecFacts(code);
  if (!hit) return { known: false };

  const disp = positiveNumber(decoded.displacementL);
  const cyl = positiveNumber(decoded.cylinders);
  if (disp === null && cyl === null) return { known: false };

  const { facts } = hit;

  if (
    disp !== null &&
    (disp < facts.minL - DISPLACEMENT_TOLERANCE_L ||
      disp > facts.maxL + DISPLACEMENT_TOLERANCE_L)
  ) {
    const span = facts.minL === facts.maxL ? `${facts.minL}L` : `${facts.minL}-${facts.maxL}L`;
    return {
      known: true,
      contradicts: true,
      reason: `engine code "${code}" is the ${facts.note} (${span}); the VIN decodes ${disp}L`,
    };
  }

  // Cylinder counts are integers; compare as such so a decoded 4.0 (the
  // historical displacement-in-cylinders corruption) doesn't read as 4.
  if (cyl !== null && facts.cylinders !== undefined && Math.round(cyl) !== facts.cylinders) {
    return {
      known: true,
      contradicts: true,
      reason: `engine code "${code}" is the ${facts.note} (${facts.cylinders}-cyl); the VIN decodes ${Math.round(cyl)} cylinders`,
    };
  }

  return { known: true, contradicts: false };
}

// ─── Year-pinned engine code by vehicle (deterministic forward fallback) ──────
//
// The generation-aware engine-code guidance used to live only inside the
// search+Haiku PROMPT ("the 2019+ Altima 2.5 is PR25DD, not QR25DE") — advice
// to a model, not a fact the pipeline could apply. Round-3: the 2022
// Mitsubishi Outlander resolved NO code at all and fell back to the descriptor
// "2.5l_4cyl", even though its engine is the PR25DD — the same Nissan-shared
// unit the Altima guidance already names (the 4th-gen Outlander is built on
// Nissan's CMF-C/D platform).
//
// Same shape as the tables above: matched on make+model+year AND corroborated
// by the decoded displacement/cylinders, so a row can only fire on the exact
// vehicle it describes. No match → null → the existing search path runs.

interface KnownEngineRow {
  from: number;
  to: number;
  displacementL: number;
  cylinders?: number;
  code: string;
  note: string;
}

const KNOWN_ENGINE_BY_VEHICLE: Record<string, KnownEngineRow[]> = {
  "mitsubishi|outlander": [
    {
      from: 2022, to: 2027, displacementL: 2.5, cylinders: 4, code: "PR25DD",
      note: "4th-gen Outlander shares Nissan's PR25DD (CMF-C/D platform)",
    },
  ],
  // Distinct nameplate from the Outlander — the RVR-based compact. Listed so a
  // real Outlander Sport resolves too; its 2.0/2.4 never matches an Outlander's
  // decoded 2.5, which is exactly the separation the model gate protects.
  "mitsubishi|outlandersport": [
    { from: 2011, to: 2024, displacementL: 2.0, cylinders: 4, code: "4B11", note: "Outlander Sport 2.0" },
    { from: 2011, to: 2024, displacementL: 2.4, cylinders: 4, code: "4B12", note: "Outlander Sport 2.4" },
  ],
  "nissan|altima": [
    { from: 2019, to: 2026, displacementL: 2.5, cylinders: 4, code: "PR25DD", note: "6th-gen Altima 2.5" },
    { from: 2007, to: 2018, displacementL: 2.5, cylinders: 4, code: "QR25DE", note: "pre-2019 Altima 2.5" },
  ],
  "nissan|rogue": [
    { from: 2014, to: 2020, displacementL: 2.5, cylinders: 4, code: "QR25DE", note: "T32 Rogue 2.5" },
  ],
};

/**
 * Deterministic engine code for a vehicle whose make+model+year+engine the
 * table positively knows. Returns null on any mismatch — including a
 * displacement the row doesn't describe — so it can never override or invent.
 */
export function lookupKnownEngineCode(
  make: string | null | undefined,
  model: string | null | undefined,
  year: number | null | undefined,
  decoded: {
    displacementL?: number | string | null;
    cylinders?: number | string | null;
  },
): { code: string; note: string } | null {
  if (!make || !model || !year) return null;
  const key = `${normCode(make)}|${normCode(model)}`.toLowerCase();
  const rows = KNOWN_ENGINE_BY_VEHICLE[key];
  if (!rows) return null;

  const disp = positiveNumber(decoded.displacementL);
  if (disp === null) return null; // no engine evidence → no claim
  const cyl = positiveNumber(decoded.cylinders);

  for (const row of rows) {
    if (year < row.from || year > row.to) continue;
    if (Math.abs(disp - row.displacementL) > DISPLACEMENT_TOLERANCE_L) continue;
    if (cyl !== null && row.cylinders !== undefined && Math.round(cyl) !== row.cylinders) continue;
    return { code: row.code, note: row.note };
  }
  return null;
}

const ENGINE_SYSTEM = `You are a vehicle engineering expert. Identify the OEM engine code and engine family for a vehicle.

Definitions:
- engine_code: the full manufacturer-specific variant code. Include the complete suffix — displacement, cam/valve variants, market designation.
  Examples: "B48B20M1" (BMW 2.0L mild hybrid), "N63B44O2" (BMW 4.4L V8), "M276DE35AL" (Mercedes AMG 3.5L V6), "2GR-FE" (Toyota 3.5L V6 NA), "K24Z7" (Honda 2.4L), "EJ257" (Subaru 2.5L turbo), "LS3" (GM 6.2L V8)
- engine_family: the base family name shared across variants. Strip displacement digits, market suffixes, and variant letters.
  Examples: "B48" (from B48B20M1), "N63" (from N63B44O2), "M276" (from M276DE35AL), "2GR" (from 2GR-FE), "K24" (from K24Z7), "EJ25" (from EJ257), "LS" (from LS3)

Rules:
- Return ONLY valid JSON: {"engine_code": "...", "engine_family": "..."}
- No explanation, no markdown, no extra text.
- engine_code must be the full variant code, not just the family.
- engine_family must be the base name, shorter than or equal to engine_code.
- If you cannot determine engine_code with confidence, use null. Same for engine_family.
- Never guess. Only return values you can confirm from search results.
- {"engine_code": null, "engine_family": null} is a valid response if unknown.`;

export type EngineLookupResult = {
  engineCode: string | null;
  engineFamily: string | null;
  tokensIn: number;
  tokensOut: number;
};

/**
 * Ask Haiku to resolve engine_code and engine_family for a vehicle.
 *
 * @param existingCode - Pass the current engine_code from DB (may be synthetic or real).
 *                       If real, Haiku only needs to derive the family.
 *                       If synthetic/null, Haiku looks up both.
 * @param decoded      - The VIN's decoded displacement/cylinders, when known.
 *                       Passing them enables the deterministic cross-check
 *                       below: a code whose family physically contradicts the
 *                       decode is dropped instead of returned. Omitting them
 *                       preserves the previous behaviour exactly.
 */
export async function lookupEngineCodeAndFamily(
  year: number,
  make: string,
  model: string,
  trim: string,
  existingCode: string | null,
  decoded?: {
    displacementL?: number | string | null;
    cylinders?: number | string | null;
  },
): Promise<EngineLookupResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log("[engine-lookup] No API key, skipping");
    return { engineCode: null, engineFamily: null, tokensIn: 0, tokensOut: 0 };
  }

  const client = getClient();
  const vehicleStr = `${year} ${make} ${model} ${trim}`.trim();

  // If we already have a real engine code, only ask Haiku to derive the family.
  // This avoids overwriting a correct code with a hallucination — UNLESS the
  // code physically contradicts the decode, in which case "real-looking" is
  // exactly the trap (Macan/EA839) and we must look the code up afresh.
  const existingContradicts =
    existingCode && decoded
      ? contradictsDecodedEngine(existingCode, decoded)
      : ({ known: false } as EngineSpecVerdict);
  if (existingContradicts.known && existingContradicts.contradicts) {
    console.warn(
      `[engine-lookup] ENGINE SPEC GATE — ${existingContradicts.reason}; ignoring it and resolving fresh`,
    );
  }
  const codeIsKnown =
    existingCode &&
    !isSyntheticEngineCode(existingCode) &&
    !(existingContradicts.known && existingContradicts.contradicts);

  const userMessage = codeIsKnown
    ? `What is the engine family for a ${vehicleStr} with engine code "${existingCode}"? Search the web to confirm. Return JSON only: {"engine_code": "${existingCode}", "engine_family": "..."}`
    : `What is the full OEM engine code and engine family for a ${vehicleStr}? Search the web to confirm. Return JSON only: {"engine_code": "...", "engine_family": "..."}`;

  try {
    console.log(
      `[engine-lookup] ${vehicleStr}${codeIsKnown ? ` (code known: ${existingCode}, looking up family)` : " (looking up code + family)"}`,
    );

    const message = await client.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 100,
      temperature: 0,
      system: ENGINE_SYSTEM,
      messages: [{ role: "user", content: userMessage }],
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 1,
        } as any,
      ],
    });

    const tokensIn = (message as any).usage?.input_tokens ?? 0;
    const tokensOut = (message as any).usage?.output_tokens ?? 0;

    // Extract text from response
    let rawText = "";
    for (const block of message.content ?? []) {
      if (block.type === "text") rawText += block.text;
    }

    const raw = rawText.trim();
    console.log(`[engine-lookup] Raw response: "${raw.substring(0, 200)}"`);

    // Parse JSON
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log(`[engine-lookup] No JSON found in response`);
      return { engineCode: null, engineFamily: null, tokensIn, tokensOut };
    }

    let parsed: { engine_code?: string | null; engine_family?: string | null };
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      console.log(`[engine-lookup] JSON parse failed: ${jsonMatch[0]}`);
      return { engineCode: null, engineFamily: null, tokensIn, tokensOut };
    }

    let engineCode = validateEngineCode(parsed.engine_code ?? null);
    let engineFamily = validateEngineFamily(parsed.engine_family ?? null);

    // Same gate on the way out: a hallucinated sibling-engine code arrives in
    // perfect format, so format validation can't see it — physical facts can.
    if (engineCode && decoded) {
      const verdict = contradictsDecodedEngine(engineCode, decoded);
      if (verdict.known && verdict.contradicts) {
        console.warn(
          `[engine-lookup] ENGINE SPEC GATE — ${verdict.reason}; dropping the resolved code`,
        );
        engineCode = null;
        engineFamily = null; // family derived from a rejected code is unusable
      }
    }

    // If code was already known, don't replace it with what Haiku returned —
    // we passed it in, so it just echoed it back. Trust the existing code.
    const finalCode = codeIsKnown ? existingCode : engineCode;

    console.log(
      `[engine-lookup] Result for ${vehicleStr}: code="${finalCode}" family="${engineFamily}"`,
    );

    return { engineCode: finalCode, engineFamily, tokensIn, tokensOut };
  } catch (err) {
    console.error(`[engine-lookup] Failed:`, err);
    return { engineCode: null, engineFamily: null, tokensIn: 0, tokensOut: 0 };
  }
}

// ─── Validation helpers ───────────────────────────────────────────────────────

/**
 * Validate a returned engine code string.
 * Rejects nulls, empty strings, obvious non-codes, and overly long values.
 */
function validateEngineCode(raw: string | null): string | null {
  if (!raw || typeof raw !== "string") return null;
  const code = raw.trim();
  if (code.length < 2 || code.length > 24) return null;
  if (code.toLowerCase() === "null" || code.toLowerCase() === "unknown") return null;
  // Must contain at least one letter
  if (!/[a-zA-Z]/.test(code)) return null;
  return code;
}

/**
 * Validate a returned engine family string.
 * Family should be shorter than or equal to the code, and free of long phrases.
 */
function validateEngineFamily(raw: string | null): string | null {
  if (!raw || typeof raw !== "string") return null;
  const fam = raw.trim();
  if (fam.length < 1 || fam.length > 12) return null;
  if (fam.toLowerCase() === "null" || fam.toLowerCase() === "unknown") return null;
  if (!/[a-zA-Z]/.test(fam)) return null;
  return fam;
}
