// =============================================================================
// convex/vehicleEnrichment/utils/rotorSpecResource.ts
//
// Per-axle rotor minimum-thickness resolution — DERIVED, not searched.
//
// Policy (operator decision, Aug 2026, validated in mechanic interviews):
// the pipeline sources the NOMINAL (new/original OEM) thickness only, and the
// replace-at minimum is computed as a 15% wear threshold off that original —
// past ~15% loss of original thickness, thermal dissipation degrades and
// braking goes spongy (Abdul confirmed both the method and the physics).
//
//   minimum = nominal × 0.85, rounded to 0.1 mm
//
// This replaces the old min-hunting ladder (markdown discard parse → manual /
// catalogue claims → gated 1.5 mm allowance). That ladder was measured near
// useless — the dedicated research rung found 0 published minimums across ~30
// vehicles, and retail pages print `330x22mm` nominals, essentially never a
// discard limit. The one number the web reliably publishes IS the nominal, so
// that is the only number enrichment asks for now.
//
//   already_present     an existing value stands (a human's always wins, and
//                       previously stored minimums — human, manual-sourced, or
//                       derived — are never churned)
//   derived_15pct       minimum computed from a known nominal (the standard)
//   nominal_only        kill-switch path only: derivation disabled, nominal
//                       known, no minimum stored
//   nominal_missing     no nominal from any source — THE gap this module can
//                       report now; closing it means finding the nominal
//   not_applicable      drum axle (na_role_keys) / no rotor fitment
//
// Pure module: no ctx, no network. Shared by the pipeline finalize and the
// backfill action so the two can never drift.
// =============================================================================

import { parseRotorThickness, pickRotorThickness } from "../rotorThickness";

export type RotorAxle = "front" | "rear";

export type RotorMinOutcome =
  | "already_present"
  | "derived_15pct"
  | "nominal_only"
  | "nominal_missing"
  | "not_applicable";

/**
 * Wear threshold from mechanic interviews (Aug 2026): once a rotor has lost
 * ~15% of its original thickness, thermal dissipation degrades and braking
 * goes spongy. The stored minimum is therefore 85% of the OEM original.
 */
export const ROTOR_WEAR_LIMIT_FRACTION = 0.15;

/** vehicle_configs.rotor_*_min_quality for a derived minimum. The inspection
 *  grades against it exactly like a spec (classify() compares measured vs ref);
 *  the passport source tag still reports it as computed, never as the
 *  manufacturer's printed figure. */
export const DERIVED_15PCT_QUALITY = "derived_15pct_wear";

/** min = nominal × (1 − 15%), to 0.1 mm. Exported so the validator and any
 *  display code share one arithmetic. */
export function deriveRotorMinMm(nominalMm: number): number {
  return Math.round(nominalMm * (1 - ROTOR_WEAR_LIMIT_FRACTION) * 10) / 10;
}

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
 * Axles that actually carry a rotor fitment, from any row set that exposes the
 * part subcategory. Shared by the pipeline finalize and the director backfill —
 * the two call sites disagreed before this existed (the finalize assumed both
 * axles fitted and reported spurious rear gaps on drum-rear cars).
 */
export function computeAxlesWithFitment(
  rows: readonly { subcategory?: string | null }[],
): RotorAxle[] {
  const subcats = new Set(rows.map((r) => r.subcategory).filter(Boolean));
  return (["front", "rear"] as const).filter((a) =>
    subcats.has(ROTOR_ROLE_KEY[a]),
  );
}

/**
 * Derivation is the STANDARD — on unless explicitly killed
 * (`npx convex env set ENRICHMENT_ROTOR_MIN_DERIVE off`). The flag survives
 * only as the pipeline-reversibility kill switch.
 */
export function rotorMinDeriveEnabled(): boolean {
  return (
    String(process.env.ENRICHMENT_ROTOR_MIN_DERIVE ?? "on").toLowerCase() !==
    "off"
  );
}

/** Nominal figures reconciled from the claim ledger, per axle. The minMm
 *  field survives for compatibility with older claim rows but is no longer
 *  consulted — minimums are derived, never sourced. */
export type CatalogRotorClaim = {
  minMm?: number | null;
  nominalMm?: number | null;
  /** Verbatim label the value was read under. */
  observedLabel?: string | null;
  sourceUrl?: string | null;
  provenance?: "manual" | "catalog";
};

export type ResolveRotorInput = {
  /** Cached parts-page markdown for this vehicle, if any — read for NOMINAL
   *  figures (`330x22mm` retail size strings). */
  markdown?: string | null;
  existing: Partial<Record<RotorAxle, ExistingRotorSpec>>;
  /** vehicle_configs.na_role_keys — a drum axle is not a gap. */
  naRoleKeys?: readonly string[];
  /** Axles that actually carry a rotor fitment. Omitted ⇒ assume both. */
  axlesWithFitment?: readonly RotorAxle[];
  /** Claim-ledger figures per axle — consulted for their NOMINAL only. */
  catalogClaims?: Partial<Record<RotorAxle, CatalogRotorClaim>>;
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
    // Any stored minimum stands — humans, pre-policy sourced specs, and prior
    // derivations alike. Stability over churn; a fleet re-derive is a
    // deliberate backfill run, not a side effect of every finalize.
    if (curMin != null) return still("already_present");

    // Nominal from any source: stored column, cached page markdown, or the
    // claim ledger (manual / catalogue rows read for capacities anyway).
    const nominal =
      curNominal ?? parsed.nominalMm ?? num(input.catalogClaims?.[axle]?.nominalMm);

    if (nominal == null) return still("nominal_missing");

    if (!rotorMinDeriveEnabled()) {
      // Kill-switch path: know the nominal, store no minimum.
      return still("nominal_only", { nominalMm: nominal, changed: curNominal == null });
    }

    const derived = deriveRotorMinMm(nominal);
    if (derived <= 0) return still("nominal_missing");
    return {
      axle,
      outcome: "derived_15pct",
      minMm: derived,
      nominalMm: nominal,
      quality: DERIVED_15PCT_QUALITY,
      observedLabel: null,
      // The minimum is our arithmetic, not a page's text — no source URL.
      sourceUrl: null,
      changed: true,
    };
  });
}

/** enrichment_runs.field_gaps reason for an unresolved axle, or null. */
export function rotorGapReason(outcome: RotorMinOutcome): string | null {
  switch (outcome) {
    case "nominal_only":
      return "rotor_min_nominal_only";
    case "nominal_missing":
      return "rotor_nominal_never_found";
    case "not_applicable":
      return "rotor_min_not_applicable";
    default:
      return null;
  }
}

/**
 * enrichment_runs.errors entry, or null when there is nothing to report.
 * First token is what directorEnrichment.tallyFlags buckets on.
 * `derived_15pct` deliberately returns null: it is the standard resolution,
 * not an anomaly — an error tally full of normal outcomes hides real ones.
 */
export function rotorErrorTag(r: RotorAxleResolution): string | null {
  switch (r.outcome) {
    case "nominal_only":
      return `rotor_min:nominal_only:${r.axle}:${r.nominalMm ?? "?"}`;
    case "nominal_missing":
      return `rotor_min:missing_nominal:${r.axle}`;
    default:
      return null;
  }
}

/** completionGate rotorMinGaps input — axles with a fitment but no minimum.
 *  With derivation standard, a gap here means the NOMINAL is missing. */
export function rotorMinGaps(
  resolutions: readonly RotorAxleResolution[],
): string[] {
  return resolutions
    .filter((r) => r.minMm == null && r.outcome !== "not_applicable")
    .map((r) => r.axle);
}
