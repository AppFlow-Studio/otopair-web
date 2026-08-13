/**
 * devOnly/auditCoreRoles.ts — READ-ONLY fleet audit: which "complete" configs
 * are missing binding core roles or have half-covered axle pairs? (round 12)
 *
 * The audit-before-enforce step of the completeness rollout: the round-12
 * completion gates (ENRICHMENT_AXLE_GATE / ENRICHMENT_CORE_ROLE_GATE) must not
 * be flipped to enforce blind — bookings.ts only books parts services on
 * status exactly "complete", so this counts the blast radius first, and the
 * flagged configs get repairMissingRolesBatch before enforcement.
 *
 * Cheap by construction: no part_prices reads (missing/axle detection only
 * needs fitment EXISTENCE, not pricing). Paginated — run in slices:
 *   npx convex run devOnly/auditCoreRoles:audit '{"limit":25}'
 *   npx convex run devOnly/auditCoreRoles:audit '{"limit":25,"cursor":"<from prior page>"}'
 */

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import {
  axlePairGaps,
  missingCoreRoles,
  type QuotabilityFitmentInput,
} from "../vehicleEnrichment/quotability";
import { PART_FIELD_MAP } from "../vehicleEnrichment/v3pipeline";

export const audit = internalQuery({
  args: {
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
    /** Audit a different status bucket ("partial") — default "complete". */
    status: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_enrichment_status", (q) =>
        q.eq("enrichment_status", args.status ?? "complete"),
      )
      .paginate({ numItems: Math.min(args.limit ?? 25, 50), cursor: args.cursor ?? null });

    let scanned = 0;
    let skippedNoRunQuotability = 0;
    let configsWithMissing = 0;
    let configsWithAxleGaps = 0;
    const byRole: Record<string, number> = {};
    const samples: Array<{
      configKey: string | null;
      missing: string[];
      axleGaps: string[];
    }> = [];

    for (const cfg of page.page) {
      scanned++;
      const run = await ctx.db
        .query("enrichment_runs")
        .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", cfg._id))
        .order("desc")
        .first();
      const applicableSlugs: string[] = (((run as any)?.quotability?.services ?? []) as any[]).map(
        (s: any) => s.slug,
      );
      if (applicableSlugs.length === 0) {
        skippedNoRunQuotability++;
        continue;
      }
      const naKeys = new Set<string>([
        ...((((run as any)?.field_gaps ?? []) as Array<{ field: string; reason: string }>)
          .filter((g) => g.reason === "not_applicable" && (PART_FIELD_MAP as any)[g.field])
          .map((g) => (PART_FIELD_MAP as any)[g.field].subcategory) as string[]),
        ...(((cfg as any).na_role_keys ?? []) as string[]),
      ]);

      const fitments = await ctx.db
        .query("part_fitments")
        .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", cfg._id))
        .collect();
      const inputs: QuotabilityFitmentInput[] = [];
      for (const f of fitments) {
        if ((f as any).package_code != null) continue;
        const part = await ctx.db.get(f.part_id);
        inputs.push({
          service_type: (f as any).service_type ?? "",
          subcategory: (part as any)?.subcategory ?? null,
          has_trusted_price: false, // pricing is irrelevant to existence checks
        });
      }

      const missing = missingCoreRoles(inputs, applicableSlugs, naKeys);
      const gaps = axlePairGaps(inputs, applicableSlugs, naKeys);
      if (missing.length > 0) configsWithMissing++;
      if (gaps.length > 0) configsWithAxleGaps++;
      for (const m of missing) byRole[m.roleKey] = (byRole[m.roleKey] ?? 0) + 1;
      if ((missing.length > 0 || gaps.length > 0) && samples.length < 15) {
        samples.push({
          configKey: (cfg as any).config_key ?? null,
          missing: missing.map((m) => `${m.serviceSlug}:${m.roleKey}`),
          axleGaps: gaps.map((g) => `${g.serviceSlug}:${g.missingRole}`),
        });
      }
    }

    return {
      scanned,
      skippedNoRunQuotability,
      configsWithMissing,
      configsWithAxleGaps,
      byRole,
      samples,
      cursor: page.isDone ? null : page.continueCursor,
      isDone: page.isDone,
    };
  },
});
