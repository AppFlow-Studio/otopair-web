import { internalQuery } from "../_generated/server";
import { v } from "convex/values";

export const getEvidenceReport = internalQuery({
  args: { entityId: v.string(), entityType: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const entityType = args.entityType ?? "vehicle_config";
    const allEvidence = await ctx.db
      .query("enrichment_evidence")
      .withIndex("by_entity", (q) => q.eq("entity_type", entityType).eq("entity_id", args.entityId))
      .collect();

    // Group by field_name
    const byField: Record<string, Array<{
      value: string;
      domain: string | undefined;
      source_type: string;
      confidence: number;
    }>> = {};

    for (const e of allEvidence) {
      if (!byField[e.field_name]) byField[e.field_name] = [];
      byField[e.field_name].push({
        value: e.observed_value,
        domain: e.source_domain ?? undefined,
        source_type: e.source_type ?? "",
        confidence: e.confidence ?? 0,
      });
    }

    // Fields with 2+ sources
    const multiSource = Object.entries(byField)
      .filter(([, rows]) => {
        const domains = new Set(rows.map(r => r.domain).filter(Boolean));
        return domains.size >= 2;
      })
      .map(([field, rows]) => {
        const domains = [...new Set(rows.map(r => r.domain).filter(Boolean))];
        const values = [...new Set(rows.map(r => r.value))];
        return {
          field_name: field,
          evidence_count: rows.length,
          unique_sources: domains.length,
          values_agree: values.length === 1,
          values: values.slice(0, 3),
          sources: domains.slice(0, 5),
        };
      })
      .sort((a, b) => b.unique_sources - a.unique_sources);

    // Find the 9 most recent evidence rows (Tier 2 additions)
    const sorted = [...allEvidence].sort((a, b) => b._creationTime - a._creationTime);
    const newest9 = sorted.slice(0, 9).map(e => ({
      field_name: e.field_name,
      observed_value: e.observed_value,
      source_domain: e.source_domain,
      confidence: e.confidence,
    }));

    return {
      total_evidence: allEvidence.length,
      fields_with_evidence: Object.keys(byField).length,
      multi_source_fields: multiSource,
      newest_9_rows: newest9,
    };
  },
});
