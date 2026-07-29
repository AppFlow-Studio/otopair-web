// =============================================================================
// convex/vehicleEnrichment/utils/rotorSpecResource.ts
//
// Tiered resolution of the OEM rotor DISCARD minimum, per axle.
//
//   already_present     an existing value stands (a human's always wins)
//   sourced_markdown    deterministic parse of the cached parts-page markdown
//   derived_from_nominal ESTIMATE from the nominal — env-gated OFF by default
//   nominal_only        nominal found, no minimum: honest gap, not an estimate
//   not_applicable      drum axle (na_role_keys) — never alarm on it
//   never_found         nothing at all
//
// Deliberately NOT a research tier. roleResource.ts's Haiku web-search loop
// exists because a missing part number makes a service unquotable; a missing
// rotor minimum only makes the inspection honestly ungraded, and the number is
// cast on the rotor hat where the mechanic is already standing. A human with a
// source link — or a mechanic with a flashlight — is both cheaper and more
// trustworthy than a second model call for a number that decides whether we
// tell a customer their brakes need replacing.
//
// Pure module: no ctx, no network. Shared by the pipeline finalize and the
// backfill action so the two can never drift.
// =============================================================================

import { parseRotorThickness, pickRotorThickness } from "../rotorThickness";

export type RotorAxle = "front" | "rear";

export type RotorMinOutcome =
  | "already_present"
  | "sourced_markdown"
  | "derived_from_nominal"
  | "nominal_only"
  | "not_applicable"
  | "never_found";

/** Values a human supplied. The pipeline must never overwrite these. */
const HUMAN_QUALITIES: ReadonlySet<string> = new Set([
  "mechanic_read",
  "director_verified",
]);

export type ExistingRotorSpec = {
  minMm?: number | null;
  nominalMm?: number | null;
  quality?: string | null;
  observedLabel?: string | null;
  sourceUrl?: string | null;
};

export type RotorAxleResolution = {
  axle: RotorAxle;
  outcome: RotorMinOutcome;
  minMm: number | null;
  nominalMm: number | null;
  /** vehicle_configs.rotor_*_min_quality. Null when there is no minimum. */
  quality: string | null;
  observedLabel: string | null;
  sourceUrl: string | null;
  /** True when the resolution changes what is already stored. */
  changed: boolean;
};

/** roleKey per axle — matches oem_parts.subcategory and na_role_keys. */
export const ROTOR_ROLE_KEY: Record<RotorAxle, string> = {
  front: "front_rotor",
  rear: "rear_rotor",
};

/**
 * Derivation is OFF unless explicitly enabled
 * (`npx convex env set ENRICHMENT_ROTOR_MIN_DERIVE on`).
 *
 * The nominal-to-minimum allowance is NOT a universal constant — real specs run
 * roughly 1.0-3.0 mm and vary by manufacturer and by vented-vs-solid
 * construction — so any fleet-wide number is wrong on a meaningful share of
 * vehicles. Enable only once telemetry shows how often nominal fills and the
 * minimum doesn't.
 */
export function rotorMinDeriveEnabled(): boolean {
  return (
    String(process.env.ENRICHMENT_ROTOR_MIN_DERIVE ?? "").toLowerCase() === "on"
  );
}

/**
 * Conservative on purpose. A LARGER allowance produces a LOWER minimum, which
 * passes worn rotors — a safety failure. A smaller allowance produces a higher
 * minimum, which over-flags — but a derived minimum is warn-capped in
 * classify() and can never auto-suggest replacement, so that direction is
 * already contained. When only one error is survivable, take the contained one.
 */
export const DERIVE_ALLOWANCE_MM = 1.5;

export type ResolveRotorInput = {
  /** Cached parts-page markdown for this vehicle, if any. */
  markdown?: string | null;
  existing: Partial<Record<RotorAxle, ExistingRotorSpec>>;
  /** vehicle_configs.na_role_keys — a drum axle is not a gap. */
  naRoleKeys?: readonly string[];
  /** Axles that actually carry a rotor fitment. Omitted ⇒ assume both. */
  axlesWithFitment?: readonly RotorAxle[];
};

function num(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function resolveRotorMinimums(
  input: ResolveRotorInput,
): RotorAxleResolution[] {
  const na = new Set(input.naRoleKeys ?? []);
  const fitted = input.axlesWithFitment
    ? new Set(input.axlesWithFitment)
    : new Set<RotorAxle>(["front", "rear"]);

  // The markdown is not axle-labelled, so a parse of it can only supply a
  // figure when the page covers one axle. Both axles read the same page; the
  // label cross-check already happened inside parseRotorThickness.
  const parsed = pickRotorThickness(parseRotorThickness(input.markdown));

  return (["front", "rear"] as const).map((axle): RotorAxleResolution => {
    const cur = input.existing[axle] ?? {};
    const curMin = num(cur.minMm);
    const curNominal = num(cur.nominalMm);
    const still = (
      outcome: RotorMinOutcome,
      over: Partial<RotorAxleResolution> = {},
    ): RotorAxleResolution => ({
      axle,
      outcome,
      minMm: curMin,
      nominalMm: curNominal,
      quality: cur.quality ?? null,
      observedLabel: cur.observedLabel ?? null,
      sourceUrl: cur.sourceUrl ?? null,
      changed: false,
      ...over,
    });

    // A human's reading always stands.
    if (cur.quality && HUMAN_QUALITIES.has(cur.quality)) {
      return still("already_present");
    }
    if (na.has(ROTOR_ROLE_KEY[axle]) || !fitted.has(axle)) {
      return still("not_applicable");
    }
    if (curMin != null) return still("already_present");

    const nominal = curNominal ?? parsed.nominalMm;

    if (parsed.discardMinMm != null) {
      return {
        axle,
        outcome: "sourced_markdown",
        minMm: parsed.discardMinMm,
        nominalMm: nominal,
        quality: "oem_spec",
        observedLabel: parsed.observedLabel,
        sourceUrl: cur.sourceUrl ?? null,
        changed: true,
      };
    }

    if (nominal != null) {
      if (!rotorMinDeriveEnabled()) {
        // Honest gap: we know the new thickness and NOT the minimum. Saying so
        // beats inventing a number that looks sourced.
        return still("nominal_only", { nominalMm: nominal, changed: curNominal == null });
      }
      const derived = Math.round((nominal - DERIVE_ALLOWANCE_MM) * 100) / 100;
      if (derived > 0) {
        return {
          axle,
          outcome: "derived_from_nominal",
          minMm: derived,
          nominalMm: nominal,
          quality: "derived_from_nominal",
          observedLabel: null,
          sourceUrl: null,
          changed: true,
        };
      }
    }

    return still("never_found");
  });
}

/** enrichment_runs.field_gaps reason for an unresolved axle, or null. */
export function rotorGapReason(outcome: RotorMinOutcome): string | null {
  switch (outcome) {
    case "nominal_only":
      return "rotor_min_nominal_only";
    case "never_found":
      return "rotor_min_never_found";
    case "not_applicable":
      return "rotor_min_not_applicable";
    default:
      return null;
  }
}

/**
 * enrichment_runs.errors entry, or null when there is nothing to report.
 * First token is what directorEnrichment.tallyFlags buckets on.
 */
export function rotorErrorTag(r: RotorAxleResolution): string | null {
  switch (r.outcome) {
    case "nominal_only":
      return `rotor_min:nominal_only:${r.axle}:${r.nominalMm ?? "?"}`;
    case "never_found":
      return `rotor_min:missing:${r.axle}`;
    case "derived_from_nominal":
      return `rotor_min:estimated:${r.axle}:${r.minMm ?? "?"}`;
    default:
      return null;
  }
}

/** completionGate rotorMinGaps input — axles with a fitment but no minimum. */
export function rotorMinGaps(
  resolutions: readonly RotorAxleResolution[],
): string[] {
  return resolutions
    .filter((r) => r.minMm == null && r.outcome !== "not_applicable")
    .map((r) => r.axle);
}
