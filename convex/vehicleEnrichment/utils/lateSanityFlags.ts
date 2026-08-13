/**
 * Late sanity flags — structured provenance for the finalize gates that run
 * AFTER writeNormalizedData (W1.5, audit findings G32/G33).
 *
 * The structured `sanity_flags` array on enrichment_runs used to be
 * snapshotted from runSanityChecks/validateAllOemParts BEFORE the late
 * finalize gates (trans-fluid verify, fluid-brand consistency, fitment
 * refute, role-identity rejects, rotor resolver, completion gate) mutated
 * `allFields` — so those outcomes survived only as free strings in errors[].
 * Every late gate now pushes a structured entry built here ALONGSIDE its
 * existing errors[] string (dual-channel during transition; the strings are
 * kept for back-compat) and the accumulator is merged into the ONE existing
 * updateEnrichmentRun finalize call — no second write, no race.
 *
 * Severity semantics:
 *  - "reject": the gate removed/blocked a value (fitment hard-delete,
 *    role-identity rejection, rotor resolver rejection).
 *  - "flag":   the gate kept the value but capped/flagged it for review, or
 *    corrected it under multi-gate evidence.
 *  - "info":   observability record, NOT a review signal (rotor resolver
 *    persisted-keys note, the completion-gate decision string). Review-queue
 *    consumers must ignore info-severity entries.
 */

/** Which finalize gate emitted the entry. Mirrors the additive
 *  `stage: v.optional(v.string())` on enrichment_runs.sanity_flags. */
export const LATE_SANITY_STAGES = [
  "trans_fluid",
  "fluid_brand",
  "fitment_refute",
  "role_identity",
  "rotor_resolver",
  "completion_gate",
  // P2.4: one "info" record per field filled from a sibling engine. Info, not
  // flag — an inherited value is audited, not queued for review (the review
  // list admits any non-info entry, so "flag" would drown it). The value's
  // weakness is carried where it bites: confidence capped at 0.7 and
  // source_type "sibling_engine".
  "sibling_inherit",
  // Rival source adapters reconciled through the claim ledger. "info" for a
  // reached consensus (the audit record of WHICH families agreed), "flag" for
  // a cross-family conflict_tie — a tie yields no value at all, and a gap a
  // human can close beats a coin-flip that quotes a wrong part.
  "claim_ledger",
  // The interval-provenance floor: how many of this config's intervals rest on
  // nothing better than the industry default table. Reported, staged off by
  // default — see ENRICHMENT_INTERVAL_PROVENANCE_GATE.
  "interval_provenance",
] as const;
export type LateSanityStage = (typeof LATE_SANITY_STAGES)[number];

/** Allowed severities. The early sanity/OEM flags only use "reject" | "flag";
 *  "info" is late-gate-only (observability records). */
export const LATE_SANITY_SEVERITIES = ["flag", "info", "reject"] as const;
export type LateSanitySeverity = (typeof LATE_SANITY_SEVERITIES)[number];

export type LateSanityFlag = {
  field: string;
  severity: LateSanitySeverity;
  reason: string;
  value?: string;
  stage: LateSanityStage;
};

/** Build one structured late-gate entry. Pure; `value` is OMITTED (not
 *  undefined) when absent so the object round-trips Convex validators without
 *  an explicit-undefined field. */
export function buildLateSanityFlag(
  stage: LateSanityStage,
  field: string,
  severity: LateSanitySeverity,
  reason: string,
  value?: string,
): LateSanityFlag {
  return {
    field,
    severity,
    reason,
    stage,
    ...(value != null ? { value } : {}),
  };
}
