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
  ] as const) {
    const stage = envStage(envName);
    if (stage === "off") continue;
    const n = entries?.length ?? 0;
    const outcome = n === 0 ? "PASS" : stage === "enforce" ? "FAIL" : "LOG-ONLY";
    legs.push(
      `${label}=${n}${n > 0 ? ` [${(entries ?? []).slice(0, 6).join(", ")}${n > 6 ? ", …" : ""}]` : ""} (stage ${stage}) ${outcome}`,
    );
  }
  return legs.join(", ");
}
