/**
 * services/sourceScoring.ts — Post-enrichment source accuracy tracking.
 *
 * After an enrichment run completes, computes consensus for each field,
 * checks which sources agreed/disagreed, and updates source_registry
 * reliability scores. Auto-blocks sources below 40% accuracy after 20+ observations.
 */

import { MutationCtx } from "../_generated/server";
import { Id, Doc } from "../_generated/dataModel";
import { computeConsensus } from "./consensus";
import { normalizeFieldValue } from "./normalization";

interface SourceStats {
  agreements: number;
  disagreements: number;
}

/**
 * Runs after an enrichment completes. Evaluates source accuracy against
 * consensus and updates source_registry reliability scores.
 */
export async function updateSourceScores(
  ctx: MutationCtx,
  enrichmentRunId: Id<"enrichment_runs">,
): Promise<void> {
  // 1. Get all evidence rows for this run
  const allEvidence = await ctx.db
    .query("enrichment_evidence")
    .withIndex("by_enrichment_run", (q) => q.eq("enrichment_run_id", enrichmentRunId))
    .collect();

  if (allEvidence.length === 0) return;

  // 2. Group by field_name
  const byField: Record<string, Doc<"enrichment_evidence">[]> = {};
  for (const e of allEvidence) {
    if (!byField[e.field_name]) byField[e.field_name] = [];
    byField[e.field_name].push(e);
  }

  // 3. For each field, compute consensus and score sources
  const domainStats: Record<string, SourceStats> = {};

  for (const [fieldName, fieldEvidence] of Object.entries(byField)) {
    if (fieldEvidence.length < 2) continue; // Need 2+ observations to compare

    // Get ALL evidence for this entity+field (not just this run) for consensus
    const entityType = fieldEvidence[0].entity_type;
    const entityId = fieldEvidence[0].entity_id;
    const fullEvidence = await ctx.db
      .query("enrichment_evidence")
      .withIndex("by_entity_field", (q) =>
        q.eq("entity_type", entityType).eq("entity_id", entityId).eq("field_name", fieldName)
      )
      .collect();

    if (fullEvidence.length < 2) continue;

    let consensus;
    try {
      consensus = computeConsensus(fullEvidence);
    } catch {
      continue;
    }

    const winnerNormalized = consensus.value;

    // 4. Check each evidence row from THIS run against consensus
    for (const e of fieldEvidence) {
      const domain = e.source_domain;
      if (!domain) continue;

      if (!domainStats[domain]) {
        domainStats[domain] = { agreements: 0, disagreements: 0 };
      }

      const normalizedValue = normalizeFieldValue(fieldName, e.observed_value);
      if (normalizedValue === winnerNormalized) {
        domainStats[domain].agreements++;
      } else {
        domainStats[domain].disagreements++;
      }
    }
  }

  // 5-7. Update source_registry for each domain
  for (const [domain, stats] of Object.entries(domainStats)) {
    const totalNew = stats.agreements + stats.disagreements;
    if (totalNew === 0) continue;

    const existingSource = await ctx.db
      .query("source_registry")
      .withIndex("by_domain", (q) => q.eq("domain", domain))
      .first();

    if (existingSource) {
      const oldTotal = existingSource.total_observations ?? 0;
      // We track cumulative agreements implicitly:
      // old_agreements = old_accuracy * old_total
      const oldAccuracy = existingSource.accuracy_rate ?? 0.5;
      const oldAgreements = Math.round(oldAccuracy * oldTotal);

      const newTotalObs = oldTotal + totalNew;
      const newTotalAgreements = oldAgreements + stats.agreements;
      const newAccuracy = newTotalObs > 0 ? newTotalAgreements / newTotalObs : 0;
      const newReliability =
        newAccuracy * 0.7 + (Math.min(newTotalObs, 100) / 100) * 0.3;

      const patch: Record<string, unknown> = {
        total_observations: newTotalObs,
        accuracy_rate: newAccuracy,
        reliability_score: newReliability,
      };

      // Auto-block if accuracy below 40% after 20+ observations
      if (newAccuracy < 0.4 && newTotalObs > 20 && !existingSource.is_blocked) {
        patch.is_blocked = true;
        patch.block_reason = `Auto-blocked: accuracy ${Math.round(newAccuracy * 100)}% after ${newTotalObs} observations`;

        // Also insert into blocked_domains table
        const alreadyBlocked = await ctx.db
          .query("blocked_domains")
          .withIndex("by_domain", (q) => q.eq("domain", domain))
          .first();

        if (!alreadyBlocked) {
          await ctx.db.insert("blocked_domains", {
            domain,
            reason: `Auto-blocked: accuracy ${Math.round(newAccuracy * 100)}% after ${newTotalObs} observations`,
            blocked_at: Date.now(),
            blocked_by: "auto_accuracy",
            accuracy_at_block: newAccuracy,
            created_at: Date.now(),
          });
        }
      }

      await ctx.db.patch(existingSource._id, patch);
    } else {
      // Auto-register: domain has evidence but no source_registry entry.
      // Insert with scoring data — url_template/slug_fn_type filled in later if needed.
      const accuracy = totalNew > 0 ? stats.agreements / totalNew : 0;
      const reliability = accuracy * 0.7 + (Math.min(totalNew, 100) / 100) * 0.3;
      await ctx.db.insert("source_registry", {
        domain,
        source_type: "web_search",
        total_observations: totalNew,
        accuracy_rate: accuracy,
        reliability_score: reliability,
        is_blocked: accuracy < 0.4 && totalNew > 20,
        created_at: Date.now(),
      });
      console.log(
        `[sourceScoring] Auto-registered: ${domain} — ` +
        `${stats.agreements}/${totalNew} agreed (${Math.round(accuracy * 100)}% accuracy, reliability=${reliability.toFixed(2)})`
      );
    }
  }
}
