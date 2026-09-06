/**
 * lib/vdbCompareTypes.ts — shared types + scorer for the DEV-ONLY VDB provider
 * comparison harness (see devOnly/vdbCompare.ts).
 *
 * We are evaluating MarketCheck and CarAPI as candidate replacements for the
 * paid Vehicle Databases (VDB) VIN-decode source. Each provider's raw response
 * is normalized onto ONE canonical shape so we can score coverage + agreement
 * side-by-side. This file has NO Convex/network deps so the client normalizers
 * (carApi.ts, marketCheck.ts) and the scorer can all import it without cycles.
 *
 * The canonical shape is anchored to what `extractVDBFields()`
 * (lib/vehicleDatabases.ts) already returns, plus the four HIGH-VALUE targets
 * the product cares about most: engine code, chassis code, trim, packages.
 */

export type CompareProvider = "vdb" | "nhtsa" | "marketcheck" | "carapi";

/** One decoded vehicle, every provider maps onto this. Nullable throughout so
 *  "absent" is representable and scored honestly. */
export interface CanonicalVehicleSpec {
  // ── Identity ──
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null; // HIGH-VALUE
  bodyType: string | null;
  doors: number | null;

  // ── High-value targets ──
  engineCode: string | null; // HIGH-VALUE — OEM engine code (L84, B58B30M, M274…)
  chassisCode: string | null; // HIGH-VALUE — chassis/platform (W205, A90, MQB…)
  /** [] = provider was probed and returned none; null = not probed / no signal. */
  packages: string[] | null; // HIGH-VALUE — trim packages / installed options

  // ── Engine deep specs ──
  engineDescription: string | null;
  cylinders: number | null;
  displacement: number | null; // liters
  cylindersConfiguration: string | null; // "I-6", "V-8"
  blockType: string | null;
  camType: string | null;
  drivetrain: string | null;
  horsepower: number | null;

  // ── Fuel / economy ──
  fuelType: string | null;
  mpgCity: number | null;
  mpgHighway: number | null;
  mpgCombined: number | null;

  // ── Transmission deep specs ──
  transType: string | null;
  transSpeeds: number | null;
  transDescription: string | null;

  // ── Tires deep specs ──
  frontTireSize: string | null;
  rearTireSize: string | null;
  frontTirePressure: number | null;
  rearTirePressure: number | null;
  wheelTorque: number | null;

  // ── Battery / brakes deep specs ──
  cca: number | null; // battery cold-cranking amps
  frontRotorDia: number | null;
  rearRotorDia: number | null;
  brakeType: string | null;
  brakeSystemType: "standard" | "sport" | "carbon_ceramic" | undefined;
  steeringType: "electric" | "hydraulic" | "electro-hydraulic" | null;

  // ── Provenance ──
  _provider: CompareProvider;
  _sourceEndpoint: string; // which URL produced this row (audit trail)
}

export type FieldTier = "identity" | "highValue" | "deepSpec" | "other";

export interface CanonicalFieldMeta {
  key: keyof CanonicalVehicleSpec;
  label: string;
  tier: FieldTier;
}

/**
 * Field catalogue — drives scoring buckets and scorecard column order.
 * `highValue` = the 4 the product asked for. `deepSpec` = the specs the paid
 * VDB source uniquely gives today (the "can a candidate really replace it?"
 * question). `_provider`/`_sourceEndpoint` are provenance, not scored.
 */
export const CANONICAL_FIELDS: CanonicalFieldMeta[] = [
  // identity
  { key: "year", label: "Year", tier: "identity" },
  { key: "make", label: "Make", tier: "identity" },
  { key: "model", label: "Model", tier: "identity" },
  { key: "doors", label: "Doors", tier: "identity" },
  // high-value
  { key: "trim", label: "Trim", tier: "highValue" },
  { key: "engineCode", label: "Engine code", tier: "highValue" },
  { key: "chassisCode", label: "Chassis code", tier: "highValue" },
  { key: "packages", label: "Packages/options", tier: "highValue" },
  // deep specs (what paid VDB uniquely covers)
  { key: "cylinders", label: "Cylinders", tier: "deepSpec" },
  { key: "displacement", label: "Displacement (L)", tier: "deepSpec" },
  { key: "cylindersConfiguration", label: "Cyl config", tier: "deepSpec" },
  { key: "drivetrain", label: "Drivetrain", tier: "deepSpec" },
  { key: "horsepower", label: "Horsepower", tier: "deepSpec" },
  { key: "fuelType", label: "Fuel type", tier: "deepSpec" },
  { key: "bodyType", label: "Body type", tier: "deepSpec" },
  { key: "transType", label: "Trans type", tier: "deepSpec" },
  { key: "transSpeeds", label: "Trans speeds", tier: "deepSpec" },
  { key: "frontTireSize", label: "Front tire", tier: "deepSpec" },
  { key: "rearTireSize", label: "Rear tire", tier: "deepSpec" },
  { key: "frontTirePressure", label: "Front PSI", tier: "deepSpec" },
  { key: "rearTirePressure", label: "Rear PSI", tier: "deepSpec" },
  { key: "cca", label: "Battery CCA", tier: "deepSpec" },
  { key: "frontRotorDia", label: "Front rotor Ø", tier: "deepSpec" },
  { key: "rearRotorDia", label: "Rear rotor Ø", tier: "deepSpec" },
  { key: "brakeType", label: "Brake type", tier: "deepSpec" },
  { key: "brakeSystemType", label: "Brake tier", tier: "deepSpec" },
  { key: "steeringType", label: "Steering", tier: "deepSpec" },
  // other (collected, not weighted into the headline buckets)
  { key: "engineDescription", label: "Engine desc", tier: "other" },
  { key: "blockType", label: "Block type", tier: "other" },
  { key: "camType", label: "Cam type", tier: "other" },
  { key: "mpgCity", label: "MPG city", tier: "other" },
  { key: "mpgHighway", label: "MPG hwy", tier: "other" },
  { key: "mpgCombined", label: "MPG combined", tier: "other" },
  { key: "transDescription", label: "Trans desc", tier: "other" },
  { key: "wheelTorque", label: "Lug torque", tier: "other" },
];

export const HIGH_VALUE_KEYS = CANONICAL_FIELDS.filter((f) => f.tier === "highValue").map((f) => f.key);
export const DEEP_SPEC_KEYS = CANONICAL_FIELDS.filter((f) => f.tier === "deepSpec").map((f) => f.key);

/** CarAPI's FREE dataset only covers model years 2015–2020. Out-of-range
 *  vehicles must be marked n/a, never counted as a CarAPI coverage failure. */
export function carApiYearInFreeRange(year: number | null | undefined): boolean {
  return year != null && year >= 2015 && year <= 2020;
}

/** A value counts as "present" when it carries real signal. */
export function fieldPresent(value: unknown): boolean {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return !Number.isNaN(value);
  return true;
}

/** FLEET-compatible engine-code normalizer (mirrors fleetEval.ts). */
export function normEngineCode(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Ground-truth subset the scorer consumes from a FLEET vehicle's expectation. */
export interface CompareExpectation {
  engine_code_one_of?: string[];
}

export type EngineCodeVerdict = "match" | "mismatch" | "absent" | "no_ground_truth";

export interface ProviderScore {
  ok: boolean;
  /** null when the provider was skipped as out-of-range (CarAPI < 2015 / > 2020). */
  applicable: boolean;
  reason?: string;
  highValue: { present: number; total: number; pct: number };
  deepSpec: { present: number; total: number; pct: number };
  full: { present: number; total: number; pct: number };
  engineCode: EngineCodeVerdict;
  /** field key → present/absent, for the per-vehicle grids. */
  fields: Record<string, "present" | "absent">;
}

export interface VinScore {
  vin: string;
  label: string;
  year: number | null;
  inFleet: boolean;
  perProvider: Partial<Record<CompareProvider, ProviderScore>>;
  /** fields where a provider disagrees with the modal value across providers. */
  disagreements: { field: string; values: Partial<Record<CompareProvider, string>> }[];
}

interface DecodedProvider {
  ok: boolean;
  applicable?: boolean; // default true; false = skipped (out-of-range)
  reason?: string;
  canonical: CanonicalVehicleSpec | null;
}

function scoreBucket(
  spec: CanonicalVehicleSpec | null,
  keys: (keyof CanonicalVehicleSpec)[],
): { present: number; total: number; pct: number } {
  const total = keys.length;
  if (!spec) return { present: 0, total, pct: 0 };
  let present = 0;
  for (const k of keys) if (fieldPresent(spec[k])) present++;
  return { present, total, pct: total ? Math.round((present / total) * 100) : 0 };
}

function verdictEngineCode(
  code: string | null,
  expected: CompareExpectation | undefined,
): EngineCodeVerdict {
  if (!expected?.engine_code_one_of?.length) return "no_ground_truth";
  if (!fieldPresent(code)) return "absent";
  const c = normEngineCode(code as string);
  const hit = expected.engine_code_one_of.some((e) => {
    const ne = normEngineCode(e);
    return c === ne || c.startsWith(ne);
  });
  return hit ? "match" : "mismatch";
}

const ALL_SCORED_KEYS = CANONICAL_FIELDS.map((f) => f.key);

/**
 * Score one vehicle across all providers. `expected` is the FLEET ground truth
 * (only engine_code_one_of is consumed here). Pure — no I/O.
 */
export function scoreCanonical(
  byProvider: Partial<Record<CompareProvider, DecodedProvider>>,
  expected?: CompareExpectation,
): {
  perProvider: Partial<Record<CompareProvider, ProviderScore>>;
  disagreements: VinScore["disagreements"];
} {
  const perProvider: Partial<Record<CompareProvider, ProviderScore>> = {};

  for (const [prov, decoded] of Object.entries(byProvider) as [CompareProvider, DecodedProvider][]) {
    const applicable = decoded.applicable !== false;
    const spec = decoded.canonical;
    const fields: Record<string, "present" | "absent"> = {};
    for (const k of ALL_SCORED_KEYS) {
      fields[k as string] = spec && fieldPresent(spec[k]) ? "present" : "absent";
    }
    perProvider[prov] = {
      ok: decoded.ok,
      applicable,
      reason: decoded.reason,
      highValue: scoreBucket(spec, HIGH_VALUE_KEYS),
      deepSpec: scoreBucket(spec, DEEP_SPEC_KEYS),
      full: scoreBucket(spec, ALL_SCORED_KEYS),
      engineCode: applicable ? verdictEngineCode(spec?.engineCode ?? null, expected) : "no_ground_truth",
      fields,
    };
  }

  // Cross-provider disagreement: for each field, the modal non-null string wins;
  // providers with a differing non-null value are flagged. Accuracy proxy where
  // there's no ground truth.
  const disagreements: VinScore["disagreements"] = [];
  const provs = (Object.keys(byProvider) as CompareProvider[]).filter(
    (p) => byProvider[p]?.applicable !== false && byProvider[p]?.canonical,
  );
  for (const meta of CANONICAL_FIELDS) {
    if (meta.tier === "other" || meta.key === "packages") continue;
    const values: Partial<Record<CompareProvider, string>> = {};
    const counts = new Map<string, number>();
    for (const p of provs) {
      const raw = byProvider[p]!.canonical![meta.key];
      if (!fieldPresent(raw)) continue;
      const norm = String(raw).trim().toLowerCase();
      values[p] = String(raw);
      counts.set(norm, (counts.get(norm) ?? 0) + 1);
    }
    if (counts.size <= 1) continue; // all agree (or ≤1 reported)
    let modal = "";
    let best = -1;
    for (const [val, n] of counts) if (n > best) { best = n; modal = val; }
    const outliers: Partial<Record<CompareProvider, string>> = {};
    for (const p of provs) {
      const v = values[p];
      if (v != null && v.trim().toLowerCase() !== modal) outliers[p] = v;
    }
    if (Object.keys(outliers).length) disagreements.push({ field: meta.key as string, values });
  }

  return { perProvider, disagreements };
}
