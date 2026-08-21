/**
 * vehicleEnrichment/identityResolution.ts — fill identity gaps from data we
 * already have, so the applicability rules stop failing open.
 *
 * Live finding (2001 BMW 740iA, Jul 11 2026): getIdentity returned null
 * drivetrain/transmission_type/body_class (old VIN, sparse decode rows), so
 * applyApplicabilityRules fired NO rules — transfer_case_*, cvt_*_filter and
 * rear_wiper_size stayed searchable on a RWD sedan with a conventional
 * automatic, ended the run as llm_null gaps, wasted Batch-2/3 budget, and
 * dragged fill to 72%. Yet the trim string literally said "4dr Sedan
 * Automatic".
 *
 * All derivation here is deterministic token matching — high-precision tokens
 * only, null over a guess. No LLM calls (deliberate: this runs in the main
 * action's hot path and identity mistakes poison applicability finality).
 */

import type { VehicleIdentity } from "./types";

/** Trim-derivable subset of VehicleIdentity. */
export interface TrimDerivedIdentity {
  body_class: string | null;
  transmission_type: string | null;
  drivetrain: string | null;
}

/** Tokenize a trim/style string: lowercase, split on non-alphanumerics. */
function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}

// High-precision body tokens only. Deliberately NOT matched: trim-level words
// that collide with body styles ("Touring" is a Honda trim level, "Sport" says
// nothing). Compound tokens like "4dr" alone don't identify a body either.
const BODY_TOKENS: Array<[string, string]> = [
  ["sedan", "sedan"],
  ["coupe", "coupe"],
  ["convertible", "convertible"],
  ["cabriolet", "convertible"],
  ["roadster", "convertible"],
  ["wagon", "wagon"],
  ["hatchback", "hatchback"],
  ["suv", "suv"],
  ["minivan", "minivan"],
  ["van", "van"],
  ["pickup", "pickup"],
];

// Explicit drivetrain tokens only — brand AWD marks included, ambiguous marks
// excluded (BMW "sDrive" is RWD on Z4 but FWD on X1/X2 — never derive from it).
const DRIVETRAIN_TOKENS: Array<[string, string]> = [
  ["awd", "AWD"],
  ["4wd", "4WD"],
  ["4x4", "4WD"],
  ["xdrive", "AWD"],
  ["quattro", "AWD"],
  ["4matic", "AWD"],
  ["4motion", "AWD"],
  ["rwd", "RWD"],
  ["fwd", "FWD"],
];

// Canonical transmission vocabulary only — marketing names (Tiptronic,
// Steptronic, DSG...) are the Haiku canonicalizer's job, not ours.
const TRANSMISSION_TOKENS: Array<[string, string]> = [
  ["automatic", "automatic"],
  ["manual", "manual"],
  ["cvt", "CVT"],
  ["dct", "DCT"],
];

function firstMatch(
  toks: Set<string>,
  table: Array<[string, string]>,
): string | null {
  for (const [token, value] of table) {
    if (toks.has(token)) return value;
  }
  return null;
}

/**
 * Derive identity facts from the trim/style string ("iA 4dr Sedan Automatic").
 * Returns null for anything the tokens don't state explicitly.
 */
export function deriveIdentityFromTrim(
  trim: string | null | undefined,
): TrimDerivedIdentity {
  if (!trim) {
    return { body_class: null, transmission_type: null, drivetrain: null };
  }
  const toks = tokens(trim);
  return {
    body_class: firstMatch(toks, BODY_TOKENS),
    transmission_type: firstMatch(toks, TRANSMISSION_TOKENS),
    drivetrain: firstMatch(toks, DRIVETRAIN_TOKENS),
  };
}

/**
 * Guard the decode-time LLM trim normalizer (round 8, batch-10).
 *
 * The normalizer's trim was applied unconditionally over the merged VDB/NHTSA
 * trim (`if (normalized.trim) finalTrim = normalized.trim`). Batch-10 shipped
 * two identity slips this way: a Lariat F-150 stored as "FX4 SuperCrew" and a
 * 745Li stored as "745i" — trim names the decoders never produced. The
 * normalizer's job is CLEANING decode output (casing, model-in-trim-field,
 * series noise), not inventing a different trim, so a normalized trim is
 * accepted only when it shares at least one token with the decode evidence
 * (merged trim / trim2 / series). No overlap = invention → keep the decode's
 * trim. Pure; exported for tests.
 */
export function acceptNormalizedTrim(
  normalizedTrim: string | null | undefined,
  decodeEvidence: Array<string | null | undefined>,
): boolean {
  if (!normalizedTrim || !normalizedTrim.trim()) return false;
  const tokens = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 2),
    );
  const evidence = new Set<string>();
  for (const e of decodeEvidence) {
    if (e) for (const t of tokens(e)) evidence.add(t);
  }
  // Nothing decoded to contradict — the normalizer is the only trim source.
  if (evidence.size === 0) return true;
  for (const t of tokens(normalizedTrim)) {
    if (evidence.has(t)) return true;
  }
  return false;
}

/**
 * Guard the decode-time LLM model normalizer (round 3, Aug 2026).
 *
 * Round 8 gated the normalizer's TRIM (above) but left its MODEL applied
 * unconditionally — `if (normalized.model) finalModel = normalized.model`.
 * VIN JA4J4UA85NZ067758 is a 2022 Mitsubishi Outlander: vPIC decoded model
 * "Outlander", VDB decoded model "Outlander", and the config stored
 * **"Outlander Sport"** — the RVR-based compact, a different vehicle with a
 * different engine, platform and parts. Neither decoder ever produced the word
 * "Sport"; the normalizer appended it, and the corrupt nameplate then keyed the
 * config and every downstream lookup (the manual page built for "2022
 * mitsubishi outlander sport" redirected to a Nissan X-Trail category).
 *
 * The rule is the trim gate's philosophy applied to the nameplate, narrowed to
 * the one move that changes WHICH VEHICLE this is:
 *
 *   Restructuring is the normalizer's job and is left alone. Turning NHTSA's
 *   model "M550i" into model "5 Series" + trim "M550i" REPLACES the nameplate
 *   and is exactly what the normalizer exists for.
 *
 *   EXTENDING is not. Keeping the decoded nameplate and appending a token no
 *   decoder mentioned ("Outlander" → "Outlander Sport", "Q5" → "Q5 Sportback")
 *   silently swaps in a sibling product. Decoders drop tokens; they don't
 *   invent them — so an appended token absent from every decode field is an
 *   invention, and we keep what the decoders actually said.
 *
 * Evidence-based and fail-open: an appended token the decode DOES corroborate
 * is accepted (NHTSA model "Silverado" + series "1500" → "Silverado 1500"), and
 * so is any model that isn't a strict extension. Pure; exported for tests.
 */
export function acceptNormalizedModel(
  normalizedModel: string | null | undefined,
  decodedModel: string | null | undefined,
  decodeEvidence: Array<string | null | undefined>,
): boolean {
  if (!normalizedModel || !normalizedModel.trim()) return false;
  // No decoded nameplate to extend — the normalizer is the only model source.
  if (!decodedModel || !decodedModel.trim()) return true;

  // Single-character tokens are kept here (unlike the trim gate): "Grand
  // Cherokee" → "Grand Cherokee L" and "Model 3" → "Model 3 Performance" turn
  // on exactly one short token, and a rejection only ever falls back to the
  // decoders' own nameplate.
  const toks = (s: string): string[] =>
    s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  const normTokens = toks(normalizedModel);
  const decodedTokens = toks(decodedModel);
  if (normTokens.length === 0 || decodedTokens.length === 0) return true;

  // Not a strict extension of the decoded nameplate → a replacement, which is
  // the normalizer's legitimate restructuring job. Leave it alone.
  const normSet = new Set(normTokens);
  const keepsDecodedNameplate = decodedTokens.every((t) => normSet.has(t));
  const addsTokens = normTokens.some((t) => !decodedTokens.includes(t));
  if (!keepsDecodedNameplate || !addsTokens) return true;

  // Structural nameplate words are canonicalization artifacts, not product
  // distinctions — "3" → "3 Series", "C" → "C-Class". Never treated as
  // invented tokens.
  const STRUCTURAL = new Set(["series", "class", "klasse", "line"]);

  // Callers must pass NAMEPLATE evidence (model/series/trim), never body-class
  // text: vPIC's body class for this very VIN is "Sport Utility Vehicle
  // [SUV]/Multipurpose Vehicle [MPV]", whose "sport" token would corroborate
  // "Outlander Sport" on essentially every SUV and reopen the exact hole this
  // gate closes. Stripped defensively here so a future caller adding body
  // class to the evidence list cannot silently disarm the gate.
  const evidence = new Set<string>();
  for (const e of decodeEvidence) {
    if (!e) continue;
    const cleaned = e.replace(/sport\s*utility/gi, " ");
    for (const t of toks(cleaned)) evidence.add(t);
  }

  for (const t of normTokens) {
    if (decodedTokens.includes(t)) continue; // came from the decoded nameplate
    if (STRUCTURAL.has(t)) continue;
    if (!evidence.has(t)) return false; // invented nameplate token
  }
  return true;
}

/** VDB decode subset relevant here (extractVDBFields output). */
export interface VdbIdentitySubset {
  bodyType?: string | null;
  drivetrain?: string | null;
  transType?: string | null;
}

/** Normalize VDB drivetrain strings ("All Wheel Drive", "RWD", "4WD") to the
 *  uppercase codes the applicability rules key on. Null when unrecognized. */
function normalizeDrivetrain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const l = raw.trim().toLowerCase();
  if (l === "fwd" || l.includes("front")) return "FWD";
  if (l === "rwd" || l.includes("rear")) return "RWD";
  if (l === "awd" || l.includes("all wheel") || l.includes("all-wheel")) return "AWD";
  if (l === "4wd" || l === "4x4" || l.includes("four wheel") || l.includes("four-wheel")) return "4WD";
  return null;
}

/**
 * Fill null identity fields from lower-priority sources.
 * Priority: DB decode (base) > VDB advanced decode > trim tokens.
 * Mutates nothing — returns a new VehicleIdentity (base fields preserved).
 * A null base builds a fresh identity so downstream rules still get inputs.
 */
export function mergeIdentity(
  base: VehicleIdentity | null,
  vdb: VdbIdentitySubset | null,
  trimDerived: TrimDerivedIdentity,
): VehicleIdentity {
  const empty: VehicleIdentity = {
    drivetrain: null,
    turbo: null,
    transmission_type: null,
    fuel_injection_type: null,
    timing_system: null,
    cylinders: null,
    displacement_l: null,
    fuel_type: null,
    gvwr_lbs: null,
    engine_manufacturer: null,
    body_class: null,
    engine_config: null,
    make: null,
    model: null,
    model_year: null,
    plant_city: null,
    plant_country: null,
  };
  const merged: VehicleIdentity = { ...(base ?? empty) };

  merged.drivetrain =
    merged.drivetrain ??
    normalizeDrivetrain(vdb?.drivetrain) ??
    trimDerived.drivetrain;
  merged.transmission_type =
    merged.transmission_type ?? vdb?.transType ?? trimDerived.transmission_type;
  merged.body_class =
    merged.body_class ?? vdb?.bodyType ?? trimDerived.body_class;

  return merged;
}
