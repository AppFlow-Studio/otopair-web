/**
 * vehicleEnrichment/manualSpecs.ts — SECOND EXTRACTION PASS OVER A RESOLVED MANUAL
 *
 * WHY THIS EXISTS
 * ---------------
 * manualLibrary.ts resolves a manual PDF, uploads it to the Anthropic Files API,
 * and then asks it exactly ONE question: the maintenance schedule. The same
 * document also carries the Specifications chapter — capacities, viscosities,
 * fluid specs, tire pressures, lug-nut torque, wiper sizes — which the rest of
 * the pipeline currently hunts for through web-search rungs that cost more and
 * corroborate worse.
 *
 * The marginal cost of asking a SECOND question is close to zero: the `file_id`
 * is already on the row (180-day refresh), so there is no re-discovery, no
 * re-download, and no re-upload. Only the extraction call is new, and the
 * document block carries `cache_control` so a specs pass scheduled soon after
 * the interval pass reads the cached document at roughly a tenth of the price.
 *
 * ============================================================================
 * WHY CLAIMS, NOT DIRECT WRITES
 * ============================================================================
 * `extractIntervalsFromManual` writes `service_intervals` directly, because an
 * interval has a natural home row and a precedence rule to guard it. Specs do
 * NOT get that treatment here. They are emitted into `field_claims` as
 * evidence, and `reconcileClaims` decides truth.
 *
 * Three reasons this is the right seam:
 *
 *   1. `source_family: "owners_manual"` has been defined and weighted 3 — tied
 *      with `gov` for the highest non-human weight — since the ledger was
 *      built, and NOTHING has ever emitted it. The corroboration math was
 *      written for exactly this source and has been running without it.
 *   2. The overlap is real, not theoretical. sourceAdapters/amsoil.ts already
 *      claims `oil_viscosity`, `oil_capacity_qts`, and `coolant_capacity_qts`
 *      as family `aggregator` (weight 2). One manual claim turns a
 *      single-family 0.6 into a two-family 0.85, which is the first time those
 *      fields clear the 0.75 quote-grade gate on evidence rather than on a
 *      lone model assertion.
 *   3. Emitting evidence is unconditionally safe. A claim cannot downgrade a
 *      stored value, cannot overwrite a mechanic-verified field, and cannot
 *      launder a wrong reading into the product — the reconciler weighs it
 *      against every rival. A direct writer would need all of that logic
 *      rebuilt; the ledger already has it.
 *
 * ============================================================================
 * THE MIRROR RULE (provenance discipline, inherited from manualLibrary)
 * ============================================================================
 * A manual pulled from a third-party mirror is still the manufacturer's text,
 * but manualLibrary's law is that a mirror "never gets to claim OEM
 * provenance". That law is honored here at the FAMILY level: a manual on the
 * manufacturer's own host emits `owners_manual` (weight 3); the identical
 * document from a mirror emits `aggregator` (weight 2). The claim is still
 * made — a mirror is often the only reachable copy, and for Mercedes/BMW/VW/
 * Audi it is the ONLY copy — it just does not get to vote with OEM authority.
 *
 * ============================================================================
 * PIPELINE LAW
 * ============================================================================
 * FAIL OPEN: every path returns a diagnostic and never throws.
 * PRESENT-BUT-WRONG IS FORBIDDEN:
 *   - the extractor must affirmatively confirm the document is THIS vehicle
 *     (`document_matches_vehicle`) or nothing is emitted. The 2019 Forester
 *     resolved a real Subaru PDF that turned out to be the BRZ Quick Guide;
 *     the interval pass caught it only because `schedule_found` was false. A
 *     specs pass has no such natural tell — a spec table from the wrong model
 *     reads as a perfectly good answer — so the guard has to be explicit.
 *   - a value without a verbatim `quoted_text` is dropped. An `owners_manual`
 *     claim at weight 3 that cannot be pointed at a line in the document is
 *     exactly the kind of confident-and-unfalsifiable evidence this ledger
 *     exists to keep out.
 *   - an engine-qualified spec whose qualifier does not match the config's
 *     engine is dropped, never guessed. Multi-engine spec tables are the norm
 *     (the 2.5L and 3.5L Camry take different oil volumes), so an unmatched
 *     qualifier means we are reading the wrong row of the right table.
 *
 * Wire-in points:
 *   - internal.vehicleEnrichment.manualSpecs.extractSpecsFromManual
 *   - internal.vehicleEnrichment.manualSpecs.backfillManualSpecs (sweep)
 */

import { v } from "convex/values";
import { internalAction, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { resolveExtractionModel } from "./utils/enrichmentFlags";
import { isFilesApiSizeLimit, isOemDomain, normalizeMakeKey } from "./manualLibrary";
import {
  parseRotorThickness,
  ROTOR_MIN_BANDS,
  ROTOR_THICKNESS_VALID_MM,
  type RotorThicknessKind,
} from "./rotorThickness";

/** Codegen has not seen this module yet — same selfApi() idiom manualLibrary
 *  and nhtsaOdi use. Tighten after `npx convex dev` regenerates the API. */
const selfApi = () => (internal as any).vehicleEnrichment.manualSpecs;
const claimApi = () => (internal as any).vehicleEnrichment.claimGathering;

// ─── Tunables ────────────────────────────────────────────────────

const ANTHROPIC_API_BASE = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";
const FILES_API_BETA = "files-api-2025-04-14";

const EXTRACTION_TIMEOUT_MS = 180_000;

/** Adapter id stamped on every claim this module writes. Chosen so
 *  `purgeClaims({ adapter })` can retract an entire bad batch in one call —
 *  the ledger is durable and cumulative, so a retraction path is mandatory
 *  for any new claim producer. */
export const MANUAL_SPECS_ADAPTER = "manual_specs";

/**
 * Adapter id for specs read by the Reducto oversize route.
 *
 * Deliberately distinct from MANUAL_SPECS_ADAPTER. The two extractors read the
 * same document but are different instruments with different failure modes, and
 * the ledger is a provenance record — an audit should be able to see which one
 * produced a value, and `purgeClaims({ adapter })` should be able to retract
 * one extractor's output without destroying the other's.
 */
export const SPECS_ADAPTER_REDUCTO = "manual_specs_reducto";

/** Both ids, for callers that ask "has this config been spec-extracted at all?" */
export const SPECS_ADAPTERS: readonly string[] = [MANUAL_SPECS_ADAPTER, SPECS_ADAPTER_REDUCTO];

/** Gap between scheduled per-config jobs in the sweep. Each is one
 *  large-context model call against a multi-MB PDF. */
const BACKFILL_STAGGER_MS = 60_000;

/** Configs per sweep invocation. Deliberately small, same posture as
 *  manualLibrary's DEFAULT_BACKFILL_LIMIT. Override with
 *  MANUAL_SPECS_DAILY_LIMIT (0 disables). */
export const DEFAULT_SPECS_LIMIT = 3;

const EXTRACTION_TOOL_NAME = "record_vehicle_specifications";

// ============================================================================
// Field contract
// ============================================================================

export type SpecUnit = "qts" | "oz" | "psi" | "ft_lbs" | "text" | "inches" | "count" | "mm";

export type SpecFieldDef = {
  /** V4_FIELD_KEYS name — the ledger keys on this. */
  key: string;
  unit: SpecUnit;
  /** What to look for, in the manual's own vocabulary. Goes in the prompt. */
  hint: string;
  /** True when the spec differs per engine and an unmatched qualifier is fatal. */
  engineSensitive: boolean;
  /**
   * Set on the rotor-thickness fields ONLY.
   *
   * Presence routes the value through `rotorClaimSurvives`, which re-reads the
   * model's own quote with the deterministic parser and refuses the claim
   * unless the quoted LABEL supports this exact kind. The model is allowed to
   * find the number; it is not allowed to say what the number means.
   *
   * That asymmetry is the whole guard. "Thickness" and "Minimum Machining
   * Thickness" and "Discard Thickness" are three different numbers printed
   * within centimetres of each other, and a confident model that returns the
   * first under the third's field key produces a minimum that is 1-3 mm too
   * HIGH or too LOW. Too low is the dangerous direction: it passes worn rotors.
   */
  rotorKind?: RotorThicknessKind;
  /** Axle for the plausibility band. Set with `rotorKind`. */
  rotorAxle?: "front" | "rear";
};

/**
 * The fields this pass asks for.
 *
 * Chosen against two filters: the key must exist in V4_FIELD_KEYS (so
 * something downstream actually reads it), and the value must RELIABLY appear
 * in an owner's manual rather than only in a service manual. Drain-plug
 * torque, belt routing, and oil-filter part numbers are all deliberately
 * absent — they live in the service manual and the parts catalog, and asking
 * for them here would invite the model to supply them from general knowledge.
 *
 * The three marked `engineSensitive` are the ones a multi-engine spec table
 * splits; everything else is per-vehicle.
 */
export const SPEC_FIELDS: readonly SpecFieldDef[] = [
  {
    key: "oil_capacity_qts",
    unit: "qts",
    hint: "engine oil capacity for a DRAIN AND REFILL WITH FILTER CHANGE (not dry fill, not without-filter)",
    engineSensitive: true,
  },
  {
    key: "oil_viscosity",
    unit: "text",
    hint: "recommended engine oil viscosity grade, e.g. 0W-20",
    engineSensitive: true,
  },
  {
    key: "coolant_capacity_qts",
    unit: "qts",
    hint: "engine coolant total system capacity",
    engineSensitive: true,
  },
  {
    key: "coolant_type",
    unit: "text",
    hint: "required coolant type or specification, e.g. Toyota Super Long Life Coolant, MB 325.0, G13",
    engineSensitive: false,
  },
  {
    key: "brake_fluid_type",
    unit: "text",
    hint: "brake fluid specification, e.g. DOT 3, DOT 4",
    engineSensitive: false,
  },
  {
    key: "trans_fluid_type",
    unit: "text",
    hint: "automatic/manual transmission fluid specification or OEM fluid name",
    engineSensitive: false,
  },
  {
    key: "transmission_fluid_capacity_qts",
    unit: "qts",
    hint: "transmission fluid DRAIN AND FILL capacity (the service fill, not the total/dry capacity)",
    engineSensitive: false,
  },
  {
    key: "diff_fluid_type",
    unit: "text",
    hint: "differential gear oil specification, e.g. SAE 75W-85 GL-5",
    engineSensitive: false,
  },
  {
    key: "diff_fluid_capacity_qts",
    unit: "qts",
    hint: "differential fluid capacity",
    engineSensitive: false,
  },
  {
    key: "transfer_case_fluid_type",
    unit: "text",
    hint: "transfer case fluid specification (only if the vehicle has a transfer case)",
    engineSensitive: false,
  },
  {
    key: "transfer_case_fluid_capacity_qts",
    unit: "qts",
    hint: "transfer case fluid capacity",
    engineSensitive: false,
  },
  {
    key: "tire_pressure_front_psi",
    unit: "psi",
    hint: "recommended COLD front tire inflation pressure for the standard tire size",
    engineSensitive: false,
  },
  {
    key: "tire_pressure_rear_psi",
    unit: "psi",
    hint: "recommended COLD rear tire inflation pressure for the standard tire size",
    engineSensitive: false,
  },
  {
    key: "lug_nut_torque_ft_lbs",
    unit: "ft_lbs",
    hint: "wheel lug nut / wheel bolt tightening torque, in ft-lbs",
    engineSensitive: false,
  },
  {
    key: "spark_plug_gap",
    unit: "text",
    hint: "spark plug gap as printed, e.g. 0.043 in or 1.1 mm",
    engineSensitive: true,
  },
  {
    // Added Aug 17 2026. The gap was asked for and the COUNT was not, so a
    // 2022 Maverick came back with spark_plug_gap_mm = 1.27 and
    // spark_plug_quantity = null — "how did we find the gap but not the qty"
    // has a boring answer: nobody asked. The count is what the booking bills
    // (spark_plugs is a per_cylinder service), so it is the more valuable of
    // the two, and the manual is the authoritative source for it: it settles
    // twin-plug engines, which a cylinder-count derivation can only guess at.
    key: "spark_plug_quantity",
    unit: "count",
    hint:
      "total number of spark plugs the engine takes (NOT the cylinder count — " +
      "twin-plug engines such as the HEMI take two per cylinder)",
    engineSensitive: true,
  },
  {
    key: "front_wiper_size",
    unit: "inches",
    hint: "front wiper blade length(s) in inches; if driver and passenger differ, report the DRIVER side",
    engineSensitive: false,
  },
  {
    key: "rear_wiper_size",
    unit: "inches",
    hint: "rear wiper blade length in inches (only if the vehicle has a rear wiper)",
    engineSensitive: false,
  },
  {
    key: "battery_group",
    unit: "text",
    hint: "battery group size / type designation, e.g. 35, H6, 24F",
    engineSensitive: false,
  },

  // ── Rotor thickness ────────────────────────────────────────────
  //
  // NOMINAL only (Aug 2026 policy): the discard minimum is no longer asked of
  // any source — it is DERIVED as a 15% wear threshold off the nominal
  // (rotorSpecResource.deriveRotorMinMm). The nominal questions stay because
  // the nominal is now the load-bearing figure the threshold is computed
  // from. Consumer is utils/rotorSpecResource.ts via the claim ledger under
  // exactly these keys — the same keys sourceAdapters/brembo.ts and
  // summitCentric.ts emit, so a manual claim and a catalogue claim land in
  // one cluster and reconcileClaims weighs them instead of racing.
  //
  // `engineSensitive: false` on purpose: rotor sizing splits by BRAKE
  // PACKAGE and axle, never by engine. The axle is carried by the field key.
  {
    key: "rotor_front_nominal_thickness_mm",
    unit: "mm",
    hint:
      "FRONT brake disc/rotor NEW (nominal/standard) thickness as manufactured — " +
      "the thickness of an unworn disc",
    engineSensitive: false,
    rotorKind: "nominal",
    rotorAxle: "front",
  },
  {
    key: "rotor_rear_nominal_thickness_mm",
    unit: "mm",
    hint:
      "REAR brake disc/rotor NEW (nominal/standard) thickness as manufactured",
    engineSensitive: false,
    rotorKind: "nominal",
    rotorAxle: "rear",
  },
];

const SPEC_FIELD_BY_KEY: ReadonlyMap<string, SpecFieldDef> = new Map(
  SPEC_FIELDS.map((f) => [f.key, f]),
);

export const SPEC_FIELD_KEYS: readonly string[] = SPEC_FIELDS.map((f) => f.key);

// ============================================================================
// Normalization — MUST match the other adapters byte for byte
// ============================================================================

/**
 * Canonical number-as-string: "4.80" → "4.8".
 *
 * This is a deliberate, load-bearing duplicate of `numStr` in
 * sourceAdapters/amsoil.ts. reconcileClaims clusters on EXACT string equality
 * of `value`, so if this module emitted "4.80" where AMSOIL emits "4.8", the
 * two sources would land in different clusters and the corroboration this
 * whole module exists to produce would silently not happen — two agreeing
 * families would be recorded as a conflict. Any change here is a change to
 * both.
 */
export function numStr(raw: unknown): string | null {
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number(raw.replace(/[,\s]/g, ""))
        : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return String(n);
}

/** Text specs: uppercase, collapse whitespace, strip trailing punctuation.
 *  "0w-20" and "0W-20 " both become "0W-20". */
export function textStr(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toUpperCase().replace(/\s+/g, " ").replace(/[.,;]+$/, "");
  return s.length > 0 && s.length <= 120 ? s : null;
}

/** Normalize one extracted value for its field's unit. Returns null when the
 *  value is unusable — the caller drops the claim rather than storing a guess. */
export function normalizeSpecValue(fieldKey: string, raw: unknown): string | null {
  const def = SPEC_FIELD_BY_KEY.get(fieldKey);
  if (!def) return null;
  switch (def.unit) {
    case "qts":
    case "oz":
    case "psi":
    case "ft_lbs":
    case "inches":
    case "count":
    case "mm":
      return numStr(raw);
    case "text":
      return textStr(raw);
    default:
      return null;
  }
}

/**
 * Does an extracted engine qualifier match this config's engine?
 *
 * Matching is deliberately loose on FORM and strict on ABSENCE: manuals write
 * "2.5L (A25A-FKS)", "A25A-FKS", or "2.5 L 4-cylinder" for the same engine, so
 * a containment test on alphanumerics catches the real variants. But when the
 * extractor supplies a qualifier and we cannot confirm it, the answer is NO —
 * an unmatched qualifier means we are reading some other engine's row.
 *
 * A null/absent qualifier means the manual stated the spec once for the whole
 * vehicle, which is the common case and is accepted.
 */
export function engineQualifierMatches(
  qualifier: string | null | undefined,
  engine: { code?: string | null; displacement_l?: number | null } | null,
): boolean {
  if (qualifier == null) return true;
  const q = qualifier.trim();
  if (q.length === 0) return true;

  const alnum = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const hay = alnum(q);
  if (hay.length === 0) return true;

  if (!engine) return false;

  const code = engine.code ? alnum(engine.code) : "";
  if (code.length >= 3 && hay.includes(code)) return true;

  // "2.5L" in the qualifier vs 2.5 on the config. Compare at one decimal so
  // "2.50" and "2.5" agree; anything that does not parse is not a match.
  if (typeof engine.displacement_l === "number" && Number.isFinite(engine.displacement_l)) {
    const disp = engine.displacement_l.toFixed(1);
    const dispAlnum = alnum(disp); // "2.5" → "25"
    if (dispAlnum.length > 0 && hay.includes(dispAlnum)) return true;
  }

  return false;
}

/**
 * How far the model's reported number may sit from the one the deterministic
 * parser reads out of its own quote, in mm.
 *
 * Not a fudge factor for disagreement — a unit-conversion allowance. A manual
 * that prints "0.945 in (24.0 mm)" gives the parser 24.003 and 24.0 from one
 * line, and a model reporting either is right. Anything beyond this is the
 * model and its own quote disagreeing about the value, which is not a rounding
 * problem.
 */
export const ROTOR_QUOTE_TOLERANCE_MM = 0.25;

/**
 * The one instruction the rotor fields cannot work without, shared verbatim by
 * both prompt builders (Anthropic here, Reducto in manualReducto.ts).
 *
 * `rotorClaimSurvives` classifies the number by reading the LABEL out of the
 * model's quote. A quote of just "24.0 mm" carries no label, so the parser
 * refuses it and a perfectly correct extraction is dropped. The quote has to
 * start at the row heading. This is stated once, in one place, because the two
 * prompts drifting apart would silently disable the guard on one extractor.
 */
export const ROTOR_QUOTE_RULE =
  "For the rotor thickness fields, `quoted_text` MUST include the row's LABEL as " +
  "well as the number — quote \"Minimum thickness ... 24.0 mm\", never just " +
  "\"24.0 mm\". The label is what distinguishes a discard minimum from a new " +
  "thickness from a machining limit, and a value quoted without it is discarded. " +
  "Report rotor thicknesses in MILLIMETRES; if the manual prints only inches, " +
  "quote the inch text verbatim and give the mm value.";

export type RotorClaimVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Decide whether a rotor thickness claim may be filed.
 *
 * TWO INDEPENDENT GATES, both of which must pass:
 *
 *   1. PLAUSIBILITY. The value has to be a thickness a rotor could actually
 *      have, and — for a minimum — inside the axle's band. A rear discard
 *      minimum of 26 mm is a front figure read off the wrong row.
 *
 *   2. THE QUOTE MUST SAY SO. `parseRotorThickness` re-reads the model's own
 *      `quoted_text` and must independently produce a reading of the SAME kind
 *      at the SAME value. This is the load-bearing gate. The model chooses
 *      where to look; the deterministic label classifier decides what it
 *      found. A model that quotes "Thickness ... 24.0 mm" and files it as a
 *      discard minimum is refused, because the parser classifies that label as
 *      `nominal` — and a nominal filed as a minimum condemns every healthy
 *      rotor on the vehicle.
 *
 * A rejection names what the parser DID see, so the drop is diagnosable from
 * the log line without re-opening the PDF.
 */
export function rotorClaimSurvives(
  def: SpecFieldDef,
  valueMm: number,
  quotedText: string,
): RotorClaimVerdict {
  const kind = def.rotorKind;
  const axle = def.rotorAxle;
  if (!kind || !axle) return { ok: true }; // not a rotor field — nothing to check

  if (!Number.isFinite(valueMm)) return { ok: false, reason: "rotor_value_not_finite" };
  if (valueMm < ROTOR_THICKNESS_VALID_MM.min || valueMm > ROTOR_THICKNESS_VALID_MM.max) {
    return { ok: false, reason: `rotor_out_of_physical_range:${valueMm}` };
  }
  if (kind === "discard_min") {
    const band = ROTOR_MIN_BANDS[axle];
    if (valueMm < band.validLow || valueMm > band.validHigh) {
      return {
        ok: false,
        reason: `rotor_min_out_of_${axle}_band:${valueMm}∉[${band.validLow},${band.validHigh}]`,
      };
    }
  }

  const readings = parseRotorThickness(quotedText);
  if (readings.length === 0) {
    return { ok: false, reason: "rotor_quote_unparseable" };
  }
  const supporting = readings.find(
    (r) => r.kind === kind && Math.abs(r.valueMm - valueMm) <= ROTOR_QUOTE_TOLERANCE_MM,
  );
  if (!supporting) {
    const saw = readings
      .map((r) => `${r.kind}=${r.valueMm}("${r.observedLabel}")`)
      .join(", ")
      .slice(0, 200);
    return { ok: false, reason: `rotor_quote_does_not_support_${kind}:saw[${saw}]` };
  }
  return { ok: true };
}

// ============================================================================
// Extraction schema (batchSchemas.ts style — anyOf-nullable, explicit required)
// ============================================================================

export type JsonSchema = Record<string, any>;

export function nullable(...types: string[]): JsonSchema {
  return { anyOf: [...types.map((t) => ({ type: t })), { type: "null" }] };
}

export function specEntrySchema(fieldKeys: readonly string[]): JsonSchema {
  return {
    type: "object",
    properties: {
      field_key: { type: "string", enum: [...fieldKeys] },
      /** Number for numeric units, string for text units — validated on parse. */
      value: nullable("number", "string"),
      /** Verbatim units the document printed, for audit ("US qts", "psi"). */
      unit_as_printed: nullable("string"),
      /** Engine this row applies to, verbatim, when the table is split. */
      engine_qualifier: nullable("string"),
      quoted_text: nullable("string"),
      page_number: nullable("number"),
    },
    required: [
      "field_key",
      "value",
      "unit_as_printed",
      "engine_qualifier",
      "quoted_text",
      "page_number",
    ],
    additionalProperties: false,
  };
}

export function buildSpecExtractionSchema(
  fieldKeys: readonly string[] = SPEC_FIELD_KEYS,
): JsonSchema {
  return {
    type: "object",
    properties: {
      /** The identity guard. See PIPELINE LAW in the header. */
      document_matches_vehicle: { type: "boolean" },
      /** What the document says it covers, verbatim from its cover/title page. */
      document_vehicle_text: nullable("string"),
      specs: { type: "array", items: specEntrySchema(fieldKeys) },
      notes: nullable("string"),
    },
    required: ["document_matches_vehicle", "document_vehicle_text", "specs", "notes"],
    additionalProperties: false,
  };
}

export function buildSpecExtractionPrompt(vehicle: {
  year: number;
  make: string;
  model: string;
  engine_label?: string | null;
}): string {
  const lines = SPEC_FIELDS.map((f) => `- ${f.key} (${f.unit}): ${f.hint}`);
  return [
    `The attached PDF is manufacturer documentation. The vehicle we are asking about is the ${vehicle.year} ${vehicle.make} ${vehicle.model}` +
      (vehicle.engine_label ? ` with the ${vehicle.engine_label} engine.` : "."),
    "",
    "STEP 1 — Confirm the document. Find the cover, title page, or header and read what vehicle and model year this document actually covers. Copy that text verbatim into `document_vehicle_text`. Set `document_matches_vehicle` true ONLY if the document covers the vehicle named above. If it covers a different model or a different model year, set it false and return an empty `specs` array — do not extract anything.",
    "",
    "STEP 2 — Find the SPECIFICATIONS section (often 'Specifications', 'Vehicle Data', 'Technical Data', 'Capacities and Specifications', or 'Maintenance Data') and report the values below.",
    "",
    ...lines,
    "",
    "Rules — these override any instinct to be helpful:",
    "1. Report ONLY values printed in THIS document. Never infer, convert from a similar model, average, or fill from general knowledge. A missing value is simply omitted from the array.",
    "2. `quoted_text` must be a VERBATIM span copied from the document that states the value. If you cannot quote it, do not report it.",
    "3. UNITS MATTER. Capacities marked (qts) must be reported in US QUARTS — if the document prints liters, use the US quart figure it prints alongside; if it prints ONLY liters, convert and say so in `unit_as_printed`. Pressures are psi, torque is ft-lbs, wiper lengths are inches. Report the number only, without the unit, in `value`.",
    "4. For engine oil capacity report the DRAIN AND REFILL WITH FILTER CHANGE figure — not the dry-fill/total figure, and not the without-filter figure. Same principle for transmission fluid: the drain-and-fill service quantity, not the total.",
    "5. If a spec is split by engine, trim, or drivetrain, report the row for the engine named above and copy that row's label verbatim into `engine_qualifier`. If you cannot tell which row applies, omit the field entirely.",
    "6. Omit anything the vehicle does not have (no rear wiper, no transfer case). An absent field is a correct answer; a zero is not.",
    `7. ${ROTOR_QUOTE_RULE}`,
    "",
    `Call the ${EXTRACTION_TOOL_NAME} tool exactly once with your findings.`,
  ].join("\n");
}

// ============================================================================
// Response parsing — fails closed on every axis
// ============================================================================

export type ParsedSpec = {
  field_key: string;
  value: string;
  value_raw: string;
  engine_qualifier: string | null;
  quoted_text: string;
  page_number: number | null;
};

export type ParseSpecsOutcome = {
  specs: ParsedSpec[];
  /** Why nothing was emitted, when that is the case — surfaced to logs. */
  rejected: string | null;
  dropped: Array<{ field_key: string; reason: string }>;
};

/**
 * Turn a tool payload into storable claims.
 *
 * Drops, in order: a document that failed the identity guard (everything), an
 * unknown field_key, a value that will not normalize, a missing quote, and an
 * engine qualifier that does not match the config's engine.
 */
export function parseSpecPayload(
  payload: unknown,
  engine: { code?: string | null; displacement_l?: number | null } | null,
): ParseSpecsOutcome {
  const dropped: Array<{ field_key: string; reason: string }> = [];
  const p = payload as any;

  if (p?.document_matches_vehicle !== true) {
    const saw = typeof p?.document_vehicle_text === "string" ? p.document_vehicle_text.slice(0, 160) : "";
    return {
      specs: [],
      rejected: `document_vehicle_mismatch${saw ? `: ${saw}` : ""}`,
      dropped,
    };
  }

  const rows = p?.specs;
  if (!Array.isArray(rows)) return { specs: [], rejected: "no_specs_array", dropped };

  const out: ParsedSpec[] = [];
  const seen = new Set<string>();

  for (const raw of rows) {
    const key = typeof raw?.field_key === "string" ? raw.field_key.trim() : "";
    if (!SPEC_FIELD_BY_KEY.has(key)) {
      if (key) dropped.push({ field_key: key, reason: "unknown_field" });
      continue;
    }
    // One claim per field per document. A model that lists a field twice is
    // ambiguous about which row it meant, and picking either is a guess.
    if (seen.has(key)) {
      dropped.push({ field_key: key, reason: "duplicate_in_payload" });
      continue;
    }

    const value = normalizeSpecValue(key, raw?.value);
    if (value == null) {
      dropped.push({ field_key: key, reason: "unnormalizable_value" });
      continue;
    }

    const quoted =
      typeof raw?.quoted_text === "string" && raw.quoted_text.trim().length > 0
        ? raw.quoted_text.trim().slice(0, 600)
        : null;
    if (!quoted) {
      dropped.push({ field_key: key, reason: "no_quote" });
      continue;
    }

    const qualifier =
      typeof raw?.engine_qualifier === "string" && raw.engine_qualifier.trim().length > 0
        ? raw.engine_qualifier.trim().slice(0, 120)
        : null;
    const def = SPEC_FIELD_BY_KEY.get(key)!;
    if (def.engineSensitive && !engineQualifierMatches(qualifier, engine)) {
      dropped.push({ field_key: key, reason: `engine_mismatch:${qualifier ?? ""}` });
      continue;
    }

    // Rotor fields only: the deterministic parser re-reads the model's own
    // quote and decides what the number is. See rotorClaimSurvives.
    if (def.rotorKind) {
      const verdict = rotorClaimSurvives(def, Number(value), quoted);
      if (!verdict.ok) {
        dropped.push({ field_key: key, reason: verdict.reason });
        continue;
      }
    }

    const printed =
      typeof raw?.unit_as_printed === "string" ? raw.unit_as_printed.trim().slice(0, 40) : "";
    const rawValue = typeof raw?.value === "number" || typeof raw?.value === "string"
      ? String(raw.value)
      : value;

    const page =
      typeof raw?.page_number === "number" && Number.isFinite(raw.page_number) && raw.page_number > 0
        ? Math.round(raw.page_number)
        : null;

    seen.add(key);
    out.push({
      field_key: key,
      value,
      value_raw: printed ? `${rawValue} ${printed}`.trim() : rawValue,
      engine_qualifier: qualifier,
      quoted_text: quoted,
      page_number: page,
    });
  }

  return { specs: out, rejected: null, dropped };
}

/** Pull the forced-tool payload out of a Messages response. */
export function extractToolPayload(body: unknown, toolName: string): Record<string, any> | null {
  const content = (body as any)?.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block?.type === "tool_use" && block?.name === toolName && block?.input && typeof block.input === "object") {
      return block.input as Record<string, any>;
    }
  }
  return null;
}

/**
 * Which family may this document's claims vote as?
 *
 * See THE MIRROR RULE in the header: the manufacturer's own host votes as
 * `owners_manual` (weight 3); a mirror carrying the same document votes as
 * `aggregator` (weight 2) — heard, but never with OEM authority.
 */
export function familyForManual(sourceUrl: string, make: string): "owners_manual" | "aggregator" {
  return isOemDomain(sourceUrl, make) ? "owners_manual" : "aggregator";
}

// ============================================================================
// Convex data layer
// ============================================================================

/**
 * Everything the extraction needs in one read: the config's identity, its
 * engine (for qualifier matching), and the resolved manual row.
 */
export const getSpecExtractionContext = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.vehicleConfigId);
    if (!config) return null;
    const cfg = config as any;

    const [makeDoc, modelDoc, engineDoc] = await Promise.all([
      cfg.make_id ? ctx.db.get(cfg.make_id) : null,
      cfg.model_id ? ctx.db.get(cfg.model_id) : null,
      cfg.engine_id ? ctx.db.get(cfg.engine_id) : null,
    ]);
    const make = (makeDoc as any)?.name ?? null;
    const model = (modelDoc as any)?.name ?? null;
    if (!make || !model || typeof cfg.year !== "number") return null;

    const eng = engineDoc as any;
    // NOTE: engines.cylinders is known-corrupted on this deployment (it holds
    // displacement on some rows), so it is deliberately NOT read here. Only
    // the engine code and displacement participate in qualifier matching.
    //
    // Displacement lives in two columns: `displacement_l` (number) and the
    // older `displacement_liters` (string OR number). Rows populated by the
    // older path carry only the latter, so both are consulted — a config whose
    // displacement we cannot read would fail every engine-qualified spec.
    const displacement = ((): number | null => {
      if (typeof eng?.displacement_l === "number" && Number.isFinite(eng.displacement_l)) {
        return eng.displacement_l;
      }
      const legacy = eng?.displacement_liters;
      const n = typeof legacy === "number" ? legacy : typeof legacy === "string" ? Number(legacy) : NaN;
      return Number.isFinite(n) && n > 0 ? n : null;
    })();

    const engine = eng
      ? { code: (eng.engine_code ?? null) as string | null, displacement_l: displacement }
      : null;

    const manual = await ctx.db
      .query("vehicle_manuals")
      .withIndex("by_ymm", (q) =>
        q.eq("make", normalizeMakeKey(make)).eq("model", normalizeMakeKey(model)).eq("year", cfg.year),
      )
      .first();

    return {
      year: cfg.year as number,
      make: make as string,
      model: model as string,
      engine,
      engine_label: engine?.code ?? (engine?.displacement_l ? `${engine.displacement_l}L` : null),
      manual: manual
        ? {
            file_id: manual.file_id ?? null,
            source_url: manual.source_url,
            source_domain: manual.source_domain,
            is_oem_domain: manual.is_oem_domain,
            doc_kind: manual.doc_kind,
            /** Drive the cheap-refresh and oversize branches in the action. */
            storage_id: (manual as any).storage_id ?? null,
            // Cost figure, not metadata: Reducto bills per page, so the
            // oversize route gates on this before spending.
            page_count: (manual as any).page_count ?? null,
            /** Page ranges worth billing for — see manualPageIndex. */
            page_index: (manual as any).page_index ?? null,
            extractor: (manual as any).extractor ?? null,
            /**
             * Signed URL for the stored bytes, minted per call.
             *
             * Lives here rather than in a second query so BOTH extractors —
             * the Anthropic one below and the Reducto oversize route — resolve
             * identity and engine through exactly this code path. Two copies of
             * engine resolution would be two places for the qualifier-matching
             * rule to drift.
             */
            url: (manual as any).storage_id
              ? await ctx.storage.getUrl((manual as any).storage_id)
              : null,
          }
        : null,
    };
  },
});

/**
 * Configs that have a usable manual on file but no manual-sourced spec claims
 * yet. Ordered by the manual table so we only ever consider vehicles whose
 * expensive half (discovery + upload) is already paid for.
 */
export const specsBackfillPage = internalQuery({
  args: { limit: v.float64(), scanPages: v.optional(v.float64()) },
  handler: async (ctx, args) => {
    const matches: Array<{
      vehicle_config_id: Id<"vehicle_configs">;
      year: number;
      make: string;
      model: string;
    }> = [];

    const maxPages = Math.max(1, Math.trunc(args.scanPages ?? 3));
    let cursor: string | null = null;
    let scanned = 0;

    for (let page = 0; page < maxPages && matches.length < args.limit; page++) {
      const result = await ctx.db
        .query("vehicle_configs")
        .paginate({ numItems: 200, cursor });
      cursor = result.continueCursor;

      for (const config of result.page) {
        scanned++;
        if (matches.length >= args.limit) break;
        const cfg = config as any;
        if (typeof cfg.year !== "number" || !cfg.make_id || !cfg.model_id) continue;

        // Already has manual-sourced claims → skip without touching the model.
        const existing = await ctx.db
          .query("field_claims")
          .withIndex("by_config", (q) => q.eq("vehicle_config_id", config._id))
          .collect();
        // Either extractor counts as done. Matching only the Anthropic id
        // would re-pick every oversize config on every sweep and pay for the
        // same Reducto extraction forever.
        if (existing.some((c) => c.adapter && SPECS_ADAPTERS.includes(c.adapter))) continue;

        const [makeDoc, modelDoc] = await Promise.all([
          ctx.db.get(cfg.make_id),
          ctx.db.get(cfg.model_id),
        ]);
        const make = (makeDoc as any)?.name;
        const model = (modelDoc as any)?.name;
        if (!make || !model) continue;

        const manual = await ctx.db
          .query("vehicle_manuals")
          .withIndex("by_ymm", (q) =>
            q.eq("make", normalizeMakeKey(make)).eq("model", normalizeMakeKey(model)).eq("year", cfg.year),
          )
          .first();
        // Only vehicles whose manual is already resolved and uploaded.
        // A resolved manual is one we can READ, by EITHER extractor: a live
        // Files API id, or our own stored bytes (re-uploaded on demand when
        // they fit, handed to Reducto when they do not). Gating on file_id
        // alone would permanently skip both populations storing bytes was
        // meant to rescue — expired uploads and oversize documents.
        const readable = Boolean(manual?.file_id) || Boolean((manual as any)?.storage_id);
        if (!readable) continue;

        matches.push({ vehicle_config_id: config._id, year: cfg.year, make, model });
      }

      if (result.isDone) break;
    }

    return { matches, scanned };
  },
});

// ============================================================================
// Actions
// ============================================================================

/**
 * Extract the specifications table from this config's already-resolved manual
 * and file the results as claims.
 *
 * Never throws. Emits nothing at all when the identity guard fails.
 */
export const extractSpecsFromManual = internalAction({
  args: {
    vehicleConfigId: v.id("vehicle_configs"),
    runId: v.optional(v.id("enrichment_runs")),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    status: "ok" | "skipped" | "failed";
    claims: number;
    dropped: number;
    reason: string;
  }> => {
    const none = (status: "skipped" | "failed", reason: string) => ({
      status,
      claims: 0,
      dropped: 0,
      reason,
    });

    try {
      const context = await ctx.runQuery(selfApi().getSpecExtractionContext, {
        vehicleConfigId: args.vehicleConfigId,
      });
      if (!context) return none("skipped", "config_not_resolvable");

      const label = `${context.year} ${context.make} ${context.model}`;
      let fileId = context.manual?.file_id ?? null;

      // ── Route: oversize documents go to Reducto ───────────────
      // A manual over the Messages API's 32 MB / 600-page cap has no file_id
      // by design. It is also, disproportionately, the kind of document whose
      // specification chapter is worth reading — so this delegates rather than
      // returning a gap. Same field contract, same parser, same claim ledger.
      if (!fileId && context.manual?.extractor === "reducto") {
        console.log(`[manual-specs] ${label}: oversize — delegating to Reducto`);
        return await ctx.runAction(
          (internal as any).vehicleEnrichment.manualReducto.extractSpecsViaReducto,
          { vehicleConfigId: args.vehicleConfigId, runId: args.runId },
        );
      }

      // Recover the Files API id from our own stored bytes rather than
      // skipping. This pass is scheduled after the interval pass, which also
      // re-uploads — but relying on that ordering would make this silently
      // dependent on another action's timing, and the sweep can run this pass
      // on its own.
      if (!fileId && context.manual?.storage_id) {
        try {
          const re = await ctx.runAction(
            (internal as any).vehicleEnrichment.manualLibrary.reuploadManualFromStorage,
            { make: context.make, model: context.model, year: context.year },
          );
          fileId = re?.file_id ?? null;
        } catch (e) {
          console.warn(`[manual-specs] ${label}: re-upload failed (non-fatal):`, e);
        }
      }

      // Oversize was handled above; anything still without a file_id here has
      // no readable document at all.
      if (!fileId) return none("skipped", "no_manual_file");

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return none("failed", "no_anthropic_api_key");

      const model = resolveExtractionModel(process.env as Record<string, string | undefined>);
      const body = {
        model,
        max_tokens: 8000,
        tools: [
          {
            name: EXTRACTION_TOOL_NAME,
            description:
              "Record vehicle specifications exactly as printed in the attached manual. Every reported value must be quotable from the document.",
            input_schema: buildSpecExtractionSchema(),
          },
        ],
        tool_choice: { type: "tool", name: EXTRACTION_TOOL_NAME },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: { type: "file", file_id: fileId },
                title: `${label} ${context.manual?.doc_kind ?? "manual"}`,
                citations: { enabled: true },
                // The interval pass reads the same document minutes earlier;
                // caching turns this second read into a ~10% cache hit rather
                // than a second full-price ingest of a multi-hundred-page PDF.
                cache_control: { type: "ephemeral" },
              },
              { type: "text", text: buildSpecExtractionPrompt(context) },
            ],
          },
        ],
      };

      let json: any;
      try {
        const res = await fetch(`${ANTHROPIC_API_BASE}/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
            "anthropic-beta": FILES_API_BETA,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(EXTRACTION_TIMEOUT_MS),
        });
        if (!res.ok) {
          const detail = (await res.text().catch(() => "")).slice(0, 300);
          // Files-API hard limits — >600 PDF pages or >1M prompt tokens — are a
          // ROUTING verdict, not a failure. The document is real and readable,
          // just not by this extractor.
          //
          // The oversize route above only fires when the row was PRE-LABELLED
          // `reducto`, which extractorForBytes decides from byte count alone.
          // A manual can sit under the byte cap and still blow the PAGE cap:
          // all four of the Aug-14 proxied manuals did (the GMC Acadia is
          // 6.4 MB across 395 pages). Those landed here, returned a raw
          // `messages_400`, and lost all 18 spec fields with no second attempt
          // — while the interval pass, which has this same catch, at least
          // reached Reducto. Same limit, same document, two different
          // behaviours depending on which pass hit it first. Mirrored.
          if (isFilesApiSizeLimit(res.status, detail)) {
            console.log(
              `[manual-specs] ${label}: Files-API size limit (${detail.slice(0, 240)}…) — falling back to Reducto`,
            );
            try {
              return await ctx.runAction(
                (internal as any).vehicleEnrichment.manualReducto.extractSpecsViaReducto,
                { vehicleConfigId: args.vehicleConfigId, runId: args.runId },
              );
            } catch (e) {
              return none("failed", `reducto_fallback_error:${String(e).slice(0, 160)}`);
            }
          }
          return none("failed", `messages_${res.status}:${detail}`);
        }
        json = await res.json();
      } catch (e) {
        return none("failed", `messages_error:${String(e).slice(0, 200)}`);
      }

      if (json?.stop_reason === "refusal") return none("failed", "refusal");

      const payload = extractToolPayload(json, EXTRACTION_TOOL_NAME);
      if (!payload) return none("failed", "no_tool_payload");

      const parsed = parseSpecPayload(payload, context.engine);
      if (parsed.rejected) {
        // The extractor read the document and told us it is not this vehicle.
        // manualLibrary owns the rejection/retry loop for that condition, so
        // this pass only records the finding and declines to emit evidence.
        console.warn(`[manual-specs] ${label}: ${parsed.rejected}`);
        return none("skipped", parsed.rejected);
      }
      if (parsed.specs.length === 0) {
        console.log(
          `[manual-specs] ${label}: no storable specs (dropped ${parsed.dropped.length})`,
        );
        return none("skipped", "no_specs_extracted");
      }

      const family = familyForManual(context.manual!.source_url, context.make);
      const observedAt = Date.now();
      const claims = parsed.specs.map((s) => ({
        field_key: s.field_key,
        value: s.value,
        value_raw: s.value_raw,
        source_family: family,
        source_domain: context.manual!.source_domain,
        source_url: context.manual!.source_url,
        method: "llm_extraction",
        adapter: MANUAL_SPECS_ADAPTER,
        // The verbatim manual line, plus the page when the model gave one.
        // This is what makes a weight-3 claim auditable.
        observed_label: s.page_number
          ? `p.${s.page_number}: ${s.quoted_text}`.slice(0, 600)
          : s.quoted_text,
        observed_at: observedAt,
      }));

      const result = await ctx.runMutation(claimApi()._writeClaims, {
        vehicleConfigId: args.vehicleConfigId,
        runId: args.runId,
        claims,
      });

      console.log(
        `[manual-specs] ${label}: filed ${result.written} claim(s) as ${family} ` +
          `from ${context.manual!.source_domain} ` +
          `(${parsed.specs.map((s) => s.field_key).join(", ")})` +
          (parsed.dropped.length > 0
            ? ` — dropped ${parsed.dropped.map((d) => `${d.field_key}:${d.reason}`).join(", ")}`
            : ""),
      );

      return {
        status: "ok",
        claims: result.written,
        dropped: parsed.dropped.length,
        reason: "ok",
      };
    } catch (e) {
      console.warn("[manual-specs] extractSpecsFromManual failed:", e);
      return none("failed", `unexpected:${String(e).slice(0, 200)}`);
    }
  },
});

/**
 * Sweep: file spec claims for configs whose manual is already on file.
 *
 * `dryRun` reports what would run without spending anything.
 */
export const backfillManualSpecs = internalAction({
  args: {
    limit: v.optional(v.float64()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ matched: number; scheduled: number; dryRun: boolean; sample: string[] }> => {
    try {
      const envLimit = Number(process.env.MANUAL_SPECS_DAILY_LIMIT ?? "");
      const configured = Number.isFinite(envLimit) && envLimit >= 0 ? envLimit : DEFAULT_SPECS_LIMIT;
      const limit = Math.max(0, Math.trunc(args.limit ?? configured));
      const dryRun = args.dryRun === true;

      if (limit === 0) {
        console.log("[manual-specs] backfill disabled (limit 0)");
        return { matched: 0, scheduled: 0, dryRun, sample: [] };
      }

      const page = await ctx.runQuery(selfApi().specsBackfillPage, { limit });
      const sample = page.matches.map((m: any) => `${m.year} ${m.make} ${m.model}`);

      if (dryRun) {
        console.log(
          `[manual-specs] DRY RUN: ${page.matches.length} config(s) would run (scanned ${page.scanned}) — ${sample.join(" | ")}`,
        );
        return { matched: page.matches.length, scheduled: 0, dryRun: true, sample };
      }

      let scheduled = 0;
      for (let i = 0; i < page.matches.length; i++) {
        await ctx.scheduler.runAfter(i * BACKFILL_STAGGER_MS, selfApi().extractSpecsFromManual, {
          vehicleConfigId: page.matches[i].vehicle_config_id,
        });
        scheduled++;
      }

      console.log(
        `[manual-specs] scheduled ${scheduled} config(s) (scanned ${page.scanned})`,
      );
      return { matched: page.matches.length, scheduled, dryRun: false, sample };
    } catch (e) {
      console.warn("[manual-specs] backfillManualSpecs failed:", e);
      return { matched: 0, scheduled: 0, dryRun: args.dryRun === true, sample: [] };
    }
  },
});
