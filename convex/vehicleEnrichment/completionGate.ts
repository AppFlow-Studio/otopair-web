/**
 * vehicleEnrichment/completionGate.ts — terminal enrichment_status decision.
 *
 * Before this gate, "complete" was `fillRate >= 70` alone: the 2001 BMW 740iA
 * finalized at quotability 0.42 (12 unpriced parts, battery service
 * unbookable) yet read "complete" and would have notified the owner.
 * Quotability was only appended to the errors string array.
 *
 * Complete now requires BOTH legs:
 *   fill        — fillRate >= ENRICHMENT_COMPLETE_FILL_MIN        (default 70)
 *   quotability — quotabilityPct >= ENRICHMENT_COMPLETE_QUOTABILITY_MIN (default 0.8)
 *
 * Undefined quotability (compute failed / not run on this path): the leg
 * fails only when the run has price gaps — otherwise a config with no
 * parts-bearing services would be permanently stuck "partial".
 *
 * Thresholds are env-tunable (`npx convex env set`) so the gate can be staged
 * without a deploy. Pure module — exported for tests.
 */

export interface CompletionGateInput {
  /** Fill-rate percent (0-100) — whatever fill metric the call site already uses. */
  fillRate: number;
  /** Quotability fraction (0-1) from computeQuotability, if available. */
  quotabilityPct: number | null | undefined;
  /** Whether the run ledgered any part_price:* gaps (undefined-quotability policy). */
  hasPriceGaps?: boolean;
  /** Round 12: "<service>:<roleKey>" for every binding core role with no
   *  fitment (missingCoreRoles). Gated by ENRICHMENT_CORE_ROLE_GATE. */
  missingCoreRoles?: readonly string[];
  /** Round 12: "<service>:<missingRole>" for every front/rear pair with
   *  exactly one side filled (axlePairGaps — the half-a-brake-job invariant;
   *  the Crosstrek shipped rear-only brake data at quotability 0.82).
   *  Gated by ENRICHMENT_AXLE_GATE. */
  axlePairGaps?: readonly string[];
  /** "front" / "rear" for each disc axle carrying a rotor fitment but no OEM
   *  minimum thickness on file. Surfaced by ENRICHMENT_ROTOR_MIN_GATE
   *  (off | log) — reported only, NEVER enforced. See explainGateDecision. */
  rotorMinGaps?: readonly string[];
  /** Service slugs whose interval rests on nothing better than the industry
   *  default table — `data_quality: "default_fallback"`, or a real miles value
   *  whose MONTHS came only from the default top-up
   *  (`interval_months_source: "default_fallback"`).
   *
   *  The canary carried 11 of 27. An invented cadence is not neutral: it reads
   *  as a schedule to the owner and it is what a buyer of this data would be
   *  paying for, so the floor exists to make the proportion visible.
   *
   *  Gated by ENRICHMENT_INTERVAL_PROVENANCE_GATE (off | log | enforce),
   *  DEFAULT LOG — see the note on RoleGateStage below. Enforcing this at
   *  finalize would fail essentially every fresh config by construction: the
   *  only source of a high-provenance interval is the manual extraction, which
   *  is a scheduled follow-up arriving minutes later and cannot fit inside the
   *  600s finalize action. Census the fleet in log mode first; if it is ever
   *  enforced it should be from a post-manual re-evaluation, not from here. */
  intervalProvenanceGaps?: readonly string[];
}

export type EnrichmentTerminalStatus = "complete" | "partial";

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Round-12 gates are STAGED because bookings.ts only books parts services on
 *  status exactly "complete": `enforce` before the fleet is repaired would
 *  silently un-book real configs. Default "log" = compute + surface in
 *  explainGateDecision without touching status; flip via
 *  `npx convex env set ENRICHMENT_AXLE_GATE enforce` (then CORE_ROLE). */
export type RoleGateStage = "off" | "log" | "enforce";

function envStage(name: string): RoleGateStage {
  const raw = String(process.env[name] ?? "").toLowerCase();
  return raw === "enforce" || raw === "off" ? raw : "log";
}

export function computeEnrichmentStatus(
  input: CompletionGateInput,
): EnrichmentTerminalStatus {
  const fillMin = envNumber("ENRICHMENT_COMPLETE_FILL_MIN", 70);
  const quotabilityMin = envNumber("ENRICHMENT_COMPLETE_QUOTABILITY_MIN", 0.8);

  if (input.fillRate < fillMin) return "partial";

  if (
    envStage("ENRICHMENT_AXLE_GATE") === "enforce" &&
    (input.axlePairGaps?.length ?? 0) > 0
  ) {
    return "partial";
  }
  if (
    envStage("ENRICHMENT_CORE_ROLE_GATE") === "enforce" &&
    (input.missingCoreRoles?.length ?? 0) > 0
  ) {
    return "partial";
  }
  // Interval provenance floor. Defaults to "off" rather than "log" at the
  // STATUS layer — envStage's own default is "log", which for the other gates
  // means "compute and report but do not enforce", and that is exactly what
  // happens here too: this branch only ever fires on an explicit "enforce".
  if (
    envStage("ENRICHMENT_INTERVAL_PROVENANCE_GATE") === "enforce" &&
    (input.intervalProvenanceGaps?.length ?? 0) >
      envNumber("ENRICHMENT_INTERVAL_PROVENANCE_MAX", 0)
  ) {
    return "partial";
  }

  if (input.quotabilityPct == null) {
    // No quotability computed on this path — fail the leg only when we KNOW
    // parts went unpriced; otherwise don't hold hostage configs whose
    // services carry no parts.
    return input.hasPriceGaps ? "partial" : "complete";
  }
  return input.quotabilityPct >= quotabilityMin ? "complete" : "partial";
}

/** One-line explanation of which gate leg failed — for run logs. */
export function explainGateDecision(input: CompletionGateInput): string {
  const fillMin = envNumber("ENRICHMENT_COMPLETE_FILL_MIN", 70);
  const quotabilityMin = envNumber("ENRICHMENT_COMPLETE_QUOTABILITY_MIN", 0.8);
  const legs: string[] = [];
  legs.push(
    `fill=${input.fillRate}% (min ${fillMin}) ${input.fillRate >= fillMin ? "PASS" : "FAIL"}`,
  );
  if (input.quotabilityPct == null) {
    legs.push(
      `quotability=undefined priceGaps=${!!input.hasPriceGaps} ${input.hasPriceGaps ? "FAIL" : "PASS"}`,
    );
  } else {
    legs.push(
      `quotability=${input.quotabilityPct} (min ${quotabilityMin}) ${input.quotabilityPct >= quotabilityMin ? "PASS" : "FAIL"}`,
    );
  }
  for (const [envName, entries, label] of [
    ["ENRICHMENT_AXLE_GATE", input.axlePairGaps, "axle_gaps"],
    ["ENRICHMENT_CORE_ROLE_GATE", input.missingCoreRoles, "core_roles_missing"],
    [
      "ENRICHMENT_INTERVAL_PROVENANCE_GATE",
      input.intervalProvenanceGaps,
      "interval_provenance_gaps",
    ],
  ] as const) {
    const stage = envStage(envName);
    if (stage === "off") continue;
    const n = entries?.length ?? 0;
    const allowed =
      envName === "ENRICHMENT_INTERVAL_PROVENANCE_GATE"
        ? envNumber("ENRICHMENT_INTERVAL_PROVENANCE_MAX", 0)
        : 0;
    const outcome = n <= allowed ? "PASS" : stage === "enforce" ? "FAIL" : "LOG-ONLY";
    legs.push(
      `${label}=${n}${n > 0 ? ` [${(entries ?? []).slice(0, 6).join(", ")}${n > 6 ? ", …" : ""}]` : ""} (stage ${stage}) ${outcome}`,
    );
  }
  // Rotor minimums are REPORTED but never gate completion, so this leg has no
  // enforce stage and computeEnrichmentStatus does not consult it. bookings.ts
  // books parts services only on status exactly "complete", so enforcing a
  // brand-new field would silently un-book working configs — and the failure is
  // benign either way: a missing rotor PART NUMBER makes a quote impossible,
  // while a missing MINIMUM only makes the inspection honestly ungraded, which
  // the mechanic can resolve in the bay by reading the number off the casting.
  if (envStage("ENRICHMENT_ROTOR_MIN_GATE") !== "off") {
    const n = input.rotorMinGaps?.length ?? 0;
    legs.push(
      `rotor_min_gaps=${n}${n > 0 ? ` [${(input.rotorMinGaps ?? []).join(", ")}]` : ""} LOG-ONLY`,
    );
  }
  return legs.join(", ");
}
