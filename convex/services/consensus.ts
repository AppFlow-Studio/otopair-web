import { QueryCtx } from "../_generated/server";
import { Doc } from "../_generated/dataModel";
import { normalizeFieldValue } from "./normalization";

export interface ConsensusResult {
  value: string;
  confidence: number;
  source_count: number;
  is_verified: boolean;
  has_conflict: boolean;
  needs_review: boolean;
}

interface Candidate {
  value: string;
  score: number;
  sourceCount: number;
  hasMechanicVerification: boolean;
}

/**
 * Computes consensus from multiple enrichment evidence observations.
 * Normalizes observed values before grouping so that "11 42 7 583 220"
 * and "11427583220" end up in the same group.
 */
export function computeConsensus(
  evidence: Doc<"enrichment_evidence">[],
  make?: string,
): ConsensusResult {
  if (evidence.length === 0) {
    throw new Error("Cannot compute consensus from empty evidence array");
  }

  // Step 1: Filter to latest observations only
  const latest = evidence.filter((e) => e.is_latest === true);
  if (latest.length === 0) {
    throw new Error("No is_latest=true observations in evidence array");
  }

  // Normalize observed values before grouping
  const fieldName = latest[0].field_name;
  const normalized = latest.map((e) => ({
    ...e,
    observed_value: normalizeFieldValue(fieldName, e.observed_value, make),
  }));

  // Single observation fast path
  if (normalized.length === 1) {
    const obs = normalized[0];
    const isMechanic = obs.source_type === "mechanic";
    return {
      value: obs.observed_value,
      confidence: obs.confidence,
      source_count: 1,
      is_verified: isMechanic,
      has_conflict: false,
      needs_review: !isMechanic && obs.confidence < 0.8,
    };
  }

  // Step 2: Group by normalized observed_value
  const groups: Record<string, typeof normalized> = {};
  for (const obs of normalized) {
    const key = obs.observed_value;
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(obs);
  }

  const totalObservations = normalized.length;

  // Step 3: Score each candidate
  const candidates: Candidate[] = Object.entries(groups).map(
    ([value, observations]) => {
      const sourceCount = observations.length;
      const confidences = observations.map((o) => o.confidence);
      const avgConfidence =
        confidences.reduce((sum, c) => sum + c, 0) / confidences.length;
      const maxConfidence = Math.max(...confidences);
      const hasMechanicVerification = observations.some(
        (o) => o.source_type === "mechanic"
      );

      // When no mechanic has verified, source diversity matters more.
      // Two sources agreeing at 0.85 should beat one source at 0.90.
      // When a mechanic HAS verified, their high confidence should
      // carry more weight regardless of source count.
      let score: number;
      if (hasMechanicVerification) {
        score =
          avgConfidence * 0.4 +
          (sourceCount / totalObservations) * 0.3 +
          maxConfidence * 0.3;
        score = Math.min(score * 1.2, 1.0);
      } else {
        score =
          avgConfidence * 0.3 +
          (sourceCount / totalObservations) * 0.4 +
          maxConfidence * 0.3;
      }

      return { value, score, sourceCount, hasMechanicVerification };
    }
  );

  // Step 4: Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  const winner = candidates[0];

  // Step 5: Determine conflict
  const hasConflict =
    candidates.length > 1 && candidates[1].score > 0.5;

  // Step 6: Determine review need
  const needsReview = hasConflict && !winner.hasMechanicVerification;

  return {
    value: winner.value,
    confidence: winner.score,
    source_count: winner.sourceCount,
    is_verified: winner.hasMechanicVerification,
    has_conflict: hasConflict,
    needs_review: needsReview,
  };
}

/**
 * Queries enrichment evidence for a specific entity field and computes consensus.
 * Returns null if no evidence exists for the given entity/field combination.
 */
export async function getConsensusForField(
  ctx: QueryCtx,
  entityType: string,
  entityId: string,
  fieldName: string,
  make?: string,
): Promise<ConsensusResult | null> {
  const evidence = await ctx.db
    .query("enrichment_evidence")
    .withIndex("by_entity", (q) =>
      q
        .eq("entity_type", entityType)
        .eq("entity_id", entityId)
        .eq("field_name", fieldName)
    )
    .collect();

  if (evidence.length === 0) {
    return null;
  }

  return computeConsensus(evidence, make);
}
