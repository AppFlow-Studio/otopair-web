/**
 * vehicleEnrichment/evidenceConsensus.ts — Task 29: Evidence Consensus Scoring
 *
 * Batch action that scans all enrichment evidence across all configs and:
 *   1. Groups evidence by entity+field
 *   2. Computes consensus per field (using existing consensus engine)
 *   3. Flags conflicts where sources disagree
 *   4. Writes consensus summary per config for dashboarding
 *   5. Updates source_registry reliability based on cross-config accuracy
 *
 * This is the "global truth" pass — unlike tier2's per-config consensus,
 * this runs across the entire dataset to catch cross-config patterns.
 *
 * Pure compute + DB reads/writes. No LLM cost.
 */

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { computeConsensus, ConsensusResult } from "../services/consensus";
import { Doc } from "../_generated/dataModel";

// ─── Types ──────────────────────────────────────────────────────

interface FieldConsensus {
  entity_id: string;
  entity_type: string;
  field_name: string;
  consensus_value: string;
  confidence: number;
  source_count: number;
  has_conflict: boolean;
  needs_review: boolean;
  is_verified: boolean;
}

interface ConsensusSummary {
  config_id: string;
  config_key: string;
  total_fields: number;
  multi_source_fields: number;
  agreements: number;
  conflicts: number;
  verified_fields: number;
  avg_confidence: number;
  needs_review_count: number;
}

// ─── Queries ────────────────────────────────────────────────────

/**
 * Gather all evidence and config info for batch consensus.
 */
export const gatherConsensusData = internalQuery({
  args: {},
  handler: async (ctx) => {
    const configs = await ctx.db.query("vehicle_configs").collect();
    const evidence = await ctx.db.query("enrichment_evidence").collect();
    return { configs, evidence };
  },
});

/**
 * Get make name for a config (needed for normalization).
 */
export const getMakeNameForConfig = internalQuery({
  args: { make_id: v.optional(v.id("makes")) },
  handler: async (ctx, args) => {
    if (!args.make_id) return null;
    const make = await ctx.db.get(args.make_id);
    return make?.name ?? null;
  },
});

// ─── Write Results ──────────────────────────────────────────────

/**
 * Store consensus summary results.
 */
export const writeConsensusSummaries = internalMutation({
  args: {
    summaries: v.array(v.object({
      config_id: v.string(),
      config_key: v.string(),
      total_fields: v.float64(),
      multi_source_fields: v.float64(),
      agreements: v.float64(),
      conflicts: v.float64(),
      verified_fields: v.float64(),
      avg_confidence: v.float64(),
      needs_review_count: v.float64(),
    })),
    conflicts: v.array(v.object({
      entity_id: v.string(),
      entity_type: v.string(),
      field_name: v.string(),
      consensus_value: v.string(),
      confidence: v.float64(),
      source_count: v.float64(),
    })),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // Clear previous consensus evidence flags
    const existing = await ctx.db.query("enrichment_evidence")
      .filter((q) => q.eq(q.field("source_type"), "consensus_review"))
      .collect();
    for (const doc of existing) {
      await ctx.db.delete(doc._id);
    }

    // Write conflict flags as evidence for review
    for (const conflict of args.conflicts) {
      await ctx.db.insert("enrichment_evidence", {
        entity_type: conflict.entity_type,
        entity_id: conflict.entity_id,
        field_name: `conflict:${conflict.field_name}`,
        observed_value: conflict.consensus_value,
        observed_type: "consensus",
        source_type: "consensus_review",
        confidence: conflict.confidence,
        source_url: `${conflict.source_count} sources disagree`,
        observed_at: now,
        is_latest: true,
        created_at: now,
      });
    }

    console.log(
      `[consensus] Wrote ${args.conflicts.length} conflict flags, ` +
      `${args.summaries.length} config summaries`
    );
  },
});

/**
 * Update source reliability scores based on cross-config consensus.
 */
export const updateSourceReliability = internalMutation({
  args: {
    domain_stats: v.array(v.object({
      domain: v.string(),
      agreements: v.float64(),
      disagreements: v.float64(),
    })),
  },
  handler: async (ctx, args) => {
    let updated = 0;
    let blocked = 0;

    for (const stats of args.domain_stats) {
      const total = stats.agreements + stats.disagreements;
      if (total === 0) continue;

      const source = await ctx.db.query("source_registry")
        .withIndex("by_domain", (q) => q.eq("domain", stats.domain))
        .first();

      if (!source) continue;

      const accuracy = stats.agreements / total;
      const reliability = accuracy * 0.7 + (Math.min(total, 100) / 100) * 0.3;

      const patch: Record<string, unknown> = {
        total_observations: total,
        accuracy_rate: accuracy,
        reliability_score: reliability,
      };

      // Auto-block if accuracy below 40% after 20+ observations
      if (accuracy < 0.4 && total > 20 && !source.is_blocked) {
        patch.is_blocked = true;
        patch.block_reason = `Auto-blocked: accuracy ${Math.round(accuracy * 100)}% after ${total} observations (batch consensus)`;

        const alreadyBlocked = await ctx.db.query("blocked_domains")
          .withIndex("by_domain", (q) => q.eq("domain", stats.domain))
          .first();

        if (!alreadyBlocked) {
          await ctx.db.insert("blocked_domains", {
            domain: stats.domain,
            reason: `Auto-blocked: accuracy ${Math.round(accuracy * 100)}% after ${total} observations`,
            blocked_at: Date.now(),
            blocked_by: "batch_consensus",
            accuracy_at_block: accuracy,
            created_at: Date.now(),
          });
        }
        blocked++;
      }

      await ctx.db.patch(source._id, patch);
      updated++;
    }

    console.log(`[consensus] Updated ${updated} source scores, blocked ${blocked}`);
  },
});

// ─── Main Action ────────────────────────────────────────────────

/**
 * Batch evidence consensus scoring. Scans all evidence across all configs,
 * computes consensus per field, flags conflicts, updates source reliability.
 */
export const runBatchConsensus = internalAction({
  args: {},
  handler: async (ctx) => {
    const data = await ctx.runQuery(
      internal.vehicleEnrichment.evidenceConsensus.gatherConsensusData, {}
    );
    const { configs, evidence } = data as {
      configs: any[];
      evidence: Doc<"enrichment_evidence">[];
    };

    if (evidence.length === 0) {
      console.log("[consensus] No evidence to process");
      return { status: "no_evidence" };
    }

    // Build config lookup
    const configMap = new Map<string, any>(
      configs.map((c: any) => [String(c._id), c])
    );

    // Cache make names
    const makeNameCache = new Map<string, string | null>();

    // 1. Group evidence by entity_id + field_name
    const evidenceByEntityField = new Map<string, Doc<"enrichment_evidence">[]>();
    for (const e of evidence) {
      // Skip anomaly/consensus meta-evidence
      if (e.source_type === "anomaly_detection" || e.source_type === "consensus_review") continue;

      const key = `${e.entity_id}::${e.field_name}`;
      if (!evidenceByEntityField.has(key)) evidenceByEntityField.set(key, []);
      evidenceByEntityField.get(key)!.push(e);
    }

    console.log(
      `[consensus] Processing ${evidenceByEntityField.size} entity-field groups ` +
      `from ${evidence.length} evidence rows across ${configs.length} configs`
    );

    // 2. Compute consensus per field
    const fieldResults: FieldConsensus[] = [];
    const domainStats = new Map<string, { agreements: number; disagreements: number }>();

    for (const [key, fieldEvidence] of evidenceByEntityField) {
      const [entityId] = key.split("::");

      // Resolve make name for normalization
      const config = configMap.get(entityId);
      let makeName: string | null = null;
      if (config?.make_id) {
        const makeIdStr = String(config.make_id);
        if (!makeNameCache.has(makeIdStr)) {
          const name = await ctx.runQuery(
            internal.vehicleEnrichment.evidenceConsensus.getMakeNameForConfig,
            { make_id: config.make_id }
          );
          makeNameCache.set(makeIdStr, name as string | null);
        }
        makeName = makeNameCache.get(makeIdStr) ?? null;
      }

      // Need at least 1 latest observation
      const latestCount = fieldEvidence.filter(e => e.is_latest).length;
      if (latestCount === 0) continue;

      let result: ConsensusResult;
      try {
        result = computeConsensus(fieldEvidence, makeName ?? undefined);
      } catch {
        continue; // Skip fields that can't compute consensus
      }

      const fc: FieldConsensus = {
        entity_id: entityId,
        entity_type: fieldEvidence[0].entity_type,
        field_name: fieldEvidence[0].field_name,
        consensus_value: result.value,
        confidence: result.confidence,
        source_count: result.source_count,
        has_conflict: result.has_conflict,
        needs_review: result.needs_review,
        is_verified: result.is_verified,
      };
      fieldResults.push(fc);

      // Track domain accuracy against consensus
      if (fieldEvidence.length >= 2) {
        for (const e of fieldEvidence) {
          if (!e.source_domain || !e.is_latest) continue;
          const domain = e.source_domain;
          if (!domainStats.has(domain)) {
            domainStats.set(domain, { agreements: 0, disagreements: 0 });
          }
          const stats = domainStats.get(domain)!;
          // Compare normalized value
          const normalizedObs = e.observed_value.toLowerCase().trim();
          const normalizedConsensus = result.value.toLowerCase().trim();
          if (normalizedObs === normalizedConsensus) {
            stats.agreements++;
          } else {
            stats.disagreements++;
          }
        }
      }
    }

    // 3. Aggregate per-config summaries
    const configSummaries = new Map<string, ConsensusSummary>();

    for (const fc of fieldResults) {
      if (!configSummaries.has(fc.entity_id)) {
        const config = configMap.get(fc.entity_id);
        configSummaries.set(fc.entity_id, {
          config_id: fc.entity_id,
          config_key: config?.config_key ?? "unknown",
          total_fields: 0,
          multi_source_fields: 0,
          agreements: 0,
          conflicts: 0,
          verified_fields: 0,
          avg_confidence: 0,
          needs_review_count: 0,
        });
      }

      const summary = configSummaries.get(fc.entity_id)!;
      summary.total_fields++;
      if (fc.source_count >= 2) summary.multi_source_fields++;
      if (fc.has_conflict) summary.conflicts++;
      else if (fc.source_count >= 2) summary.agreements++;
      if (fc.is_verified) summary.verified_fields++;
      if (fc.needs_review) summary.needs_review_count++;
      summary.avg_confidence += fc.confidence;
    }

    // Finalize averages
    for (const summary of configSummaries.values()) {
      if (summary.total_fields > 0) {
        summary.avg_confidence = Math.round((summary.avg_confidence / summary.total_fields) * 100) / 100;
      }
    }

    // 4. Collect conflicts for flagging
    const conflicts = fieldResults
      .filter(fc => fc.has_conflict)
      .map(fc => ({
        entity_id: fc.entity_id,
        entity_type: fc.entity_type,
        field_name: fc.field_name,
        consensus_value: fc.consensus_value,
        confidence: fc.confidence,
        source_count: fc.source_count,
      }));

    // 5. Write results
    const summaryArr = Array.from(configSummaries.values());
    await ctx.runMutation(
      internal.vehicleEnrichment.evidenceConsensus.writeConsensusSummaries,
      { summaries: summaryArr, conflicts }
    );

    // 6. Update source reliability
    const domainStatsArr = Array.from(domainStats.entries()).map(([domain, stats]) => ({
      domain,
      agreements: stats.agreements,
      disagreements: stats.disagreements,
    }));

    if (domainStatsArr.length > 0) {
      await ctx.runMutation(
        internal.vehicleEnrichment.evidenceConsensus.updateSourceReliability,
        { domain_stats: domainStatsArr }
      );
    }

    // 7. Summary stats
    const totalConflicts = conflicts.length;
    const totalMultiSource = fieldResults.filter(fc => fc.source_count >= 2).length;
    const totalAgreements = fieldResults.filter(fc => fc.source_count >= 2 && !fc.has_conflict).length;
    const totalVerified = fieldResults.filter(fc => fc.is_verified).length;
    const avgConfidence = fieldResults.length > 0
      ? Math.round((fieldResults.reduce((s, fc) => s + fc.confidence, 0) / fieldResults.length) * 100) / 100
      : 0;

    console.log(
      `[consensus] Batch complete: ${fieldResults.length} fields scored, ` +
      `${totalMultiSource} multi-source, ${totalAgreements} agreements, ` +
      `${totalConflicts} conflicts, ${totalVerified} verified, ` +
      `avg confidence ${avgConfidence}, ${domainStatsArr.length} domains scored`
    );

    return {
      status: "ok",
      fields_scored: fieldResults.length,
      multi_source_fields: totalMultiSource,
      agreements: totalAgreements,
      conflicts: totalConflicts,
      verified_fields: totalVerified,
      avg_confidence: avgConfidence,
      domains_scored: domainStatsArr.length,
      configs_with_evidence: configSummaries.size,
      top_conflicts: conflicts.slice(0, 20),
    };
  },
});
