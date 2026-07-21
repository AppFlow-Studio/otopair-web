/**
 * vehicleEnrichment/variantFingerprint.ts — P0 of the variant-identification
 * plan (reports/variant_identification_scope_2026-07-21.md).
 *
 * WHY: rounds 4–7 built the CONSUMERS of a variant fingerprint (duty-class
 * bands, engine-maker fluid rules, diesel-plug suppression, transmission
 * reconcile, fluid-brand flag) before the fingerprint existed — so they're
 * post-hoc per-facet patches, and the extraction they wrap drifts to
 * sibling-variant parts/fluids and is non-deterministic run-to-run (batch-8:
 * same VIN → Wrangler fluid ZF-ATF→ATF+4, Yaris specs Mazda→Toyota).
 *
 * THIS FILE (P0) is the behavior-neutral scaffold: a pure assembler that
 * CONSOLIDATES the signals that ALREADY exist (decode + reconcilers + duty
 * class + fuel-type classification) into one confidence-scored record. No new
 * LLM calls, no pipeline rewiring — later phases add the 3 adversarial facet
 * resolvers (fuel-type disambiguation, badge-source, transmission unit code)
 * and anchor the extraction prompts to this record (P5).
 *
 * DESIGN PRINCIPLE (non-negotiable, learned in batches 6/8): FAIL OPEN. Every
 * facet is `null` unless positively supported — a null facet leaves today's
 * searchable / blocked-on-identity behavior intact. A confident WRONG facet has
 * a bigger blast radius than a gap because it will anchor the whole run.
 *
 * Pure module — no IO. Exported for tests.
 */

import { deriveDutyClass, type DutyClass } from "./validation/sanityChecks";
import { makesSameFamily } from "./contentSanitization";

/** A single resolved facet: its value, how confident we are, and where it came
 *  from. `value: null` means "not established" (fail-open) — never a guess. */
export interface Facet<T> {
  value: T | null;
  /** 0..1. Only meaningful when value != null. */
  confidence: number;
  /** Provenance: "nhtsa" | "vdb" | "reconciled" | "derived" | "verified" | "none". */
  source: string;
}

function facet<T>(value: T | null, confidence: number, source: string): Facet<T> {
  return value == null
    ? { value: null, confidence: 0, source: "none" }
    : { value, confidence, source };
}

/** Normalized fuel class — the authoritative signal that drives spark-vs-glow,
 *  diesel consumables, and EV applicability. `null` when unclassifiable. */
export type FuelClass =
  | "gasoline"
  | "diesel"
  | "hybrid"
  | "phev"
  | "bev"
  | "flex"
  | "other";

export type TransmissionFamily = "automatic" | "cvt" | "dct" | "manual";

export interface VariantFingerprintV1 {
  // ── Powertrain ──
  engine_code: Facet<string>;
  fuel_class: Facet<FuelClass>;
  aspiration: Facet<"na" | "turbo" | "supercharged">;
  displacement_l: Facet<number>;
  cylinders: Facet<number>;
  engine_manufacturer: Facet<string>;

  // ── Transmission ──
  transmission_family: Facet<TransmissionFamily>;
  /** NEW facets, resolved in later phases — present here as fail-open nulls so
   *  consumers can already read the shape. */
  transmission_unit_code: Facet<string>;
  speeds: Facet<number>;

  // ── Chassis / build source ──
  drivetrain: Facet<"FWD" | "RWD" | "AWD" | "4WD">;
  duty_class: Facet<DutyClass>;
  /** The manufacturer that actually built the powertrain — differs from `make`
   *  on badge-engineered cars (Yaris→Mazda). Resolved in P2; here it is seeded
   *  from engine_manufacturer when that already differs from the make. */
  build_source_make: Facet<string>;

  // ── Identity ──
  make: string | null;
  model: string | null;
  model_year: number | null;
  /** Mean confidence across the established facets — a quick health signal. */
  overall_identity_confidence: number;
}

/**
 * Classify a raw fuel-type descriptor (NHTSA FuelTypePrimary, VDB fuelType) to
 * a normalized FuelClass. Deterministic, high-precision, fail-open to null.
 *
 * NHTSA quirks handled: a hybrid's FuelTypePrimary is often just "Gasoline"
 * (the electric side is Secondary) — so a bare "Gasoline" cannot be assumed
 * non-hybrid, but we only UPGRADE to hybrid when the string itself names it.
 * The point of this classifier is the high-consequence split: diesel and BEV
 * (which have no spark plugs) vs everything with a spark-ignition ICE.
 */
export function classifyFuelClass(raw: string | null | undefined): FuelClass | null {
  if (!raw) return null;
  const s = raw.toLowerCase();

  // Diesel is unambiguous and the highest-consequence class.
  if (s.includes("diesel")) return "diesel";

  const hasElectric = s.includes("electric") || s.includes("bev") || s.includes("ev");
  const hasGas = s.includes("gasol") || s.includes("petrol") || s.includes("flex") || s.includes("e85");
  const isPlugIn = s.includes("plug-in") || s.includes("plugin") || s.includes("phev");

  if (isPlugIn) return "phev";
  if (s.includes("hybrid")) return "hybrid";
  // A combined "gasoline/electric" string is a hybrid even without the word.
  if (hasElectric && hasGas) return "hybrid";
  // Pure electric — no ICE, no plugs.
  if (hasElectric) return "bev";

  if (s.includes("flex") || s.includes("ffv") || s.includes("e85")) return "flex";
  if (s.includes("gasol") || s.includes("petrol")) return "gasoline";

  // CNG/LPG/propane/hydrogen/fuel-cell etc. — real but not our split; classify
  // as "other" so consumers don't mistake them for gasoline-spark vehicles.
  if (
    s.includes("cng") || s.includes("lpg") || s.includes("propane") ||
    s.includes("natural gas") || s.includes("hydrogen") || s.includes("fuel cell")
  ) {
    return "other";
  }
  return null;
}

/** True when the fuel class definitively has NO spark-ignition system (diesel =
 *  glow plugs, BEV = none). The authoritative signal behind round-7's plug
 *  suppression. `null`/unknown → false (fail open: keep plugs searchable). */
export function fuelClassHasNoSparkIgnition(fc: FuelClass | null | undefined): boolean {
  return fc === "diesel" || fc === "bev";
}

/** Inputs the assembler consolidates. All already produced upstream today — the
 *  assembler adds no new signal, it just unifies them into one record. */
export interface FingerprintInputs {
  make: string | null;
  model: string | null;
  model_year: number | null;
  /** Resolved engine code (post engineCodeLookup); a raw NHTSA descriptor or a
   *  synthetic should be passed as null so the facet fails open. */
  engine_code: string | null;
  /** True when the engine_code was adversarially verified (engineCodeLookup
   *  source:"verified") — raises the facet confidence + source. */
  engine_code_verified?: boolean;
  raw_fuel_type: string | null;
  aspiration: "na" | "turbo" | "supercharged" | null;
  displacement_l: number | null;
  cylinders: number | null;
  engine_manufacturer: string | null;
  /** Canonical transmission family, ALREADY reconciled (round-7). */
  transmission_family: TransmissionFamily | null;
  speeds: number | null;
  /** Drivetrain, ALREADY reconciled against NHTSA axle (drivetrainReconcile). */
  drivetrain: "FWD" | "RWD" | "AWD" | "4WD" | null;
  gvwr_lbs: number | null;
  /** Optional pre-resolved fuel class from fuelTypeResolver (P1). When present,
   *  it OVERRIDES the naive classifyFuelClass(raw_fuel_type) for the fuel facet,
   *  carrying the resolver's confidence + source. When absent, the assembler
   *  falls back to classifying raw_fuel_type (P0 behavior). */
  resolved_fuel?: { fuel_class: FuelClass | null; confidence: number; source: string } | null;
  /** Optional pre-resolved build source from buildSourceResolver (P2). When
   *  present, it OVERRIDES the inline engine_manufacturer seed for the
   *  build_source_make facet. When absent, the assembler falls back to the P0
   *  seed (kept for behavior-compat + tests). */
  resolved_build_source?: { build_source_make: string | null; confidence: number; source: string } | null;
}

/**
 * Assemble the fingerprint from existing, already-resolved signals. Pure and
 * fail-open. Confidence/source are heuristic by provenance (P0) — later phases
 * that add adversarial resolution will set these directly on the facets they
 * own. NEW facets (transmission_unit_code, build_source_make via badge lookup)
 * are left null here and filled by P2/P3.
 */
export function assembleVariantFingerprint(
  input: FingerprintInputs,
): VariantFingerprintV1 {
  // Prefer the P1 resolver's authoritative fuel class (with its confidence +
  // source); fall back to naive classification of the raw decode string (P0).
  const resolved = input.resolved_fuel;
  const fuelClass = resolved ? resolved.fuel_class : classifyFuelClass(input.raw_fuel_type);
  const fuelConfidence = resolved ? resolved.confidence : fuelClass ? 0.85 : 0;
  const fuelSource = resolved ? resolved.source : "derived";
  const dutyClass = input.gvwr_lbs != null ? deriveDutyClass(input.gvwr_lbs) : null;

  // build_source_make seed (P2 will replace with a real badge/plant resolver):
  // fire only when engine_manufacturer is present and belongs to a DIFFERENT
  // corporate family than the make (Mazda-built Toyota Yaris → "Mazda"). Uses
  // makesSameFamily so a brand-name parent (Chrysler on a Jeep, Lexus on a
  // Toyota) is correctly suppressed. KNOWN P2 GAP: NHTSA sometimes returns a
  // corporate-parent STRING ("FCA US LLC", "General Motors") that
  // makesSameFamily doesn't map to a marque family, so those still seed a
  // false source — harmless while this facet is observe-only; P2 normalizes
  // those strings.
  const emfr = input.engine_manufacturer?.trim() ?? "";
  const mk = input.make?.trim() ?? "";
  const el = emfr.toLowerCase();
  const ml = mk.toLowerCase();
  // Suppress when same corporate family (Lexus↔Toyota) OR one string contains
  // the other ("Toyota Motor Manufacturing" ⊇ "Toyota") — the latter catches
  // NHTSA's "<Make> Motor ..." forms that makesSameFamily's exact-key match misses.
  const buildSourceDiffers =
    emfr !== "" && mk !== "" &&
    !makesSameFamily(emfr, mk) &&
    !el.includes(ml) && !ml.includes(el);

  const fp: VariantFingerprintV1 = {
    engine_code: facet(
      input.engine_code,
      input.engine_code_verified ? 0.95 : 0.7,
      input.engine_code_verified ? "verified" : "nhtsa",
    ),
    fuel_class: facet(fuelClass, fuelConfidence, fuelSource),
    aspiration: facet(input.aspiration, input.aspiration ? 0.75 : 0, "nhtsa"),
    displacement_l: facet(input.displacement_l, input.displacement_l ? 0.8 : 0, "nhtsa"),
    cylinders: facet(input.cylinders, input.cylinders ? 0.8 : 0, "nhtsa"),
    engine_manufacturer: facet(
      input.engine_manufacturer,
      input.engine_manufacturer ? 0.8 : 0,
      "nhtsa",
    ),

    transmission_family: facet(
      input.transmission_family,
      input.transmission_family ? 0.85 : 0,
      "reconciled",
    ),
    // Filled by P3 (adversarial unit-code resolver). Fail-open null for now.
    transmission_unit_code: facet<string>(null, 0, "none"),
    speeds: facet(input.speeds, input.speeds ? 0.65 : 0, "nhtsa"),

    drivetrain: facet(input.drivetrain, input.drivetrain ? 0.9 : 0, "reconciled"),
    duty_class: facet(dutyClass, dutyClass ? 0.9 : 0, "derived"),
    // P2 resolver (buildSourceResolver) when wired; else the P0 inline seed.
    build_source_make: input.resolved_build_source
      ? facet(
          input.resolved_build_source.build_source_make,
          input.resolved_build_source.confidence,
          input.resolved_build_source.source,
        )
      : buildSourceDiffers
        ? facet(input.engine_manufacturer, 0.5, "seed_engine_mfr")
        : facet<string>(null, 0, "none"),

    make: input.make,
    model: input.model,
    model_year: input.model_year,
    overall_identity_confidence: 0,
  };

  fp.overall_identity_confidence = meanFacetConfidence(fp);
  return fp;
}

function cap(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * Render the fingerprint's high-consequence facets as an AUTHORITATIVE
 * constraints block for the extraction prompt (P5). Only CONFIDENT facets emit a
 * line (fail-open — a null/low-confidence facet constrains nothing), and the
 * block is GUIDANCE that the applicability rules + fitment verifier still net.
 * Deliberately does NOT constrain transmission (its family is the raw,
 * unreconciled decode value at prompt-build time). Returns "" when nothing is
 * confident enough to assert.
 */
export function renderVariantConstraints(fp: VariantFingerprintV1): string {
  const lines: string[] = [];

  const engBits = [
    fp.engine_code.value ? `engine code ${fp.engine_code.value}` : null,
    fp.displacement_l.value ? `${fp.displacement_l.value}L` : null,
    fp.cylinders.value ? `${fp.cylinders.value}-cyl` : null,
    fp.aspiration.value && fp.aspiration.value !== "na" ? fp.aspiration.value : null,
  ].filter(Boolean);
  if (engBits.length) {
    lines.push(
      `- Engine: ${engBits.join(", ")}. Return ONLY parts that fit THIS exact engine — never a different engine, displacement, or model generation of ${fp.make ?? "this model"} that the scraped catalog may also list.`,
    );
  }

  const fc = fp.fuel_class.value;
  if (fc === "diesel" && fp.fuel_class.confidence >= 0.7) {
    lines.push(
      `- Fuel: DIESEL (compression-ignition). This engine has NO spark plugs and NO ignition coils — set spark_plug_oem, spark_plug_quantity, spark_plug_gap and ignition_coil_oem to null. The oil filter, air filter and other consumables are the DIESEL engine's parts, NOT a gasoline sibling of the same nameplate.`,
    );
  } else if (fc === "bev" && fp.fuel_class.confidence >= 0.7) {
    lines.push(
      `- Fuel: BATTERY-ELECTRIC. There is no combustion engine — set spark_plug_oem, spark_plug_quantity, spark_plug_gap, ignition_coil_oem, oil_filter_oem, engine_oil and fuel-system parts to null.`,
    );
  }

  const bs = fp.build_source_make.value;
  const makeDiffers = fp.make == null || bs == null || bs.toLowerCase() !== fp.make.toLowerCase();
  if (bs && fp.build_source_make.confidence >= 0.7 && makeDiffers) {
    lines.push(
      `- Built by ${cap(bs)} (badge-engineered): this vehicle's OEM parts and fluids follow ${cap(bs)}'s specifications and part-number format, NOT ${fp.make ?? "the badge brand"}'s. Prefer genuine ${cap(bs)} OEM part numbers and ${cap(bs)} fluid specs (transmission fluid, coolant, filters).`,
    );
  }

  if (lines.length === 0) return "";
  const veh = [fp.model_year, fp.make, fp.model].filter(Boolean).join(" ");
  return `=== AUTHORITATIVE VARIANT CONSTRAINTS (highest priority — override any conflicting catalog/scraped value) ===
This vehicle is EXACTLY a ${veh}. Established facts about THIS specific variant:
${lines.join("\n")}
When the scraped parts catalog mixes multiple variants of this nameplate, choose ONLY the entries matching the constraints above; leave a field null rather than return a part from a different variant.
`;
}

/** Mean confidence across the established (value != null) facets. */
function meanFacetConfidence(fp: VariantFingerprintV1): number {
  const facets: Facet<unknown>[] = [
    fp.engine_code, fp.fuel_class, fp.aspiration, fp.displacement_l, fp.cylinders,
    fp.engine_manufacturer, fp.transmission_family, fp.transmission_unit_code,
    fp.speeds, fp.drivetrain, fp.duty_class, fp.build_source_make,
  ];
  const live = facets.filter((f) => f.value != null);
  if (live.length === 0) return 0;
  return live.reduce((a, f) => a + f.confidence, 0) / live.length;
}
