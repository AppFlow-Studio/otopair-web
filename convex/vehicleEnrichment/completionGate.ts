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
}

export type EnrichmentTerminalStatus = "complete" | "partial";

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function computeEnrichmentStatus(
  input: CompletionGateInput,
): EnrichmentTerminalStatus {
  const fillMin = envNumber("ENRICHMENT_COMPLETE_FILL_MIN", 70);
  const quotabilityMin = envNumber("ENRICHMENT_COMPLETE_QUOTABILITY_MIN", 0.8);

  if (input.fillRate < fillMin) return "partial";

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
  return legs.join(", ");
}
