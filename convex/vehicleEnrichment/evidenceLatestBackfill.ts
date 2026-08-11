/**
 * vehicleEnrichment/evidenceLatestBackfill.ts — one-shot repair for the
 * is_latest no-op (June-audit I7 / KU-A, resolved Aug 2026 as "regression").
 *
 * Every evidence writer stamped is_latest:true and nothing ever set it
 * false, so the consensus filter ("weigh only the latest observations")
 * silently weighed ALL history — a stale spec value could keep out-voting a
 * fresh re-enrichment forever. addEvidenceBatch now retires priors on
 * write; this sweep heals the historical rows: for every (entity_id,
 * field_name) group, only the newest row keeps is_latest — except mechanic
 * rows, which are never retired by this sweep (human observations manage
 * their own supersession in the accept path).
 *
 * Dry run first (counts only, writes nothing):
 *   npx convex run vehicleEnrichment/evidenceLatestBackfill:retireStaleEvidence '{"dryRun":true}'
 * Live: BACKFILL_EVIDENCE_LATEST=on and {"dryRun":false}.
 */
import { v } from "convex/values";
import { internalAction, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";

function newnessKey(row: any): number {
  return (row.observed_at ?? 0) || (row.created_at ?? 0) || row._creationTime || 0;
}

export const retireStaleEvidencePage = internalMutation({
  args: {
    cursor: v.union(v.string(), v.null()),
    pageSize: v.number(),
    dryRun: v.boolean(),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("enrichment_evidence")
      .paginate({ cursor: args.cursor, numItems: args.pageSize });

    let stale = 0;
    let kept = 0;
    for (const row of page.page) {
      if (!row.is_latest) continue;
      if (row.source_type === "mechanic") { kept++; continue; }
      const group = await ctx.db
        .query("enrichment_evidence")
        .withIndex("by_entity_field", (q) =>
          q
            .eq("entity_type", row.entity_type)
            .eq("entity_id", row.entity_id)
            .eq("field_name", row.field_name)
        )
        .collect();
      // The newest NON-mechanic row keeps the flag; mechanic rows are their
      // own class and never compete here.
      const rivals = group.filter((g) => g.source_type !== "mechanic");
      const newest = rivals.reduce((a, b) => (newnessKey(b) > newnessKey(a) ? b : a), rivals[0]);
      if (newest && String(newest._id) !== String(row._id)) {
        stale++;
        if (!args.dryRun) await ctx.db.patch(row._id, { is_latest: false });
      } else {
        kept++;
      }
    }
    return {
      continueCursor: page.isDone ? null : page.continueCursor,
      scanned: page.page.length,
      stale,
      kept,
    };
  },
});

export const retireStaleEvidence = internalAction({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    if (!dryRun && process.env.BACKFILL_EVIDENCE_LATEST !== "on") {
      return { status: "refused", reason: "set BACKFILL_EVIDENCE_LATEST=on for a live run" };
    }
    let cursor: string | null = null;
    let scanned = 0;
    let stale = 0;
    let kept = 0;
    let pages = 0;
    do {
      const r: any = await ctx.runMutation(
        internal.vehicleEnrichment.evidenceLatestBackfill.retireStaleEvidencePage,
        { cursor, pageSize: 200, dryRun },
      );
      cursor = r.continueCursor;
      scanned += r.scanned;
      stale += r.stale;
      kept += r.kept;
      pages++;
    } while (cursor != null && pages < 500);
    const summary = { status: dryRun ? "dry_run" : "done", scanned, retired: stale, keptLatest: kept, pages };
    console.log("[evidence-latest-backfill]", JSON.stringify(summary));
    return summary;
  },
});
