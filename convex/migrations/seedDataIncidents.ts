// Seed the two historical data incidents (Data spec §10.4/§13) so the
// Provenance & Incidents page opens with institutional memory, not an empty
// state. Idempotent: keyed on slug, re-running inserts zero rows.
//
//   npx convex run migrations/seedDataIncidents:seed
import { internalMutation } from "../_generated/server";

type SeedIncident = {
  number: number;
  slug: string;
  title: string;
  severity: "sev1" | "sev2" | "sev3";
  status: "open" | "monitoring" | "resolved";
  summary: string;
  root_cause?: string;
  scope_note?: string;
  affected_entity_type?: string;
  affected_count?: number;
  declared_at: number;
};

const SEEDS: SeedIncident[] = [
  {
    number: 1,
    slug: "ford-on-alfa",
    title: "Ford-on-Alfa cross-make contamination",
    severity: "sev1",
    status: "resolved",
    summary:
      "38 vehicle configs carried Ford donor values on Alfa Romeo (and other) " +
      "configs after a deployment clone injected rows across makes. Detected " +
      "via spec review; the incident that made layer badges a design law — " +
      "layers trusted each other implicitly.",
    root_cause:
      "Clone-injection: the dev→dev deployment clone re-pointed evidence and " +
      "spec rows onto mismatched configs.",
    scope_note:
      "Deployment-scoped: production holds only ~30 configs total, so backfill " +
      "scope must be re-measured per deployment (spec §10.4).",
    affected_entity_type: "vehicle_config",
    affected_count: 38,
    declared_at: Date.UTC(2026, 3, 20), // Apr 2026 (approximate — pre-portal)
  },
  {
    number: 2,
    slug: "vd-labor-under-read",
    title: "Vehicle Databases labor times read systematically low",
    severity: "sev2",
    status: "monitoring",
    summary:
      "VD labor values under-read real job times: CRV oil change 18–25 min vs " +
      "~45 real; BMW battery 30 min vs 75–90 incl. mandatory post-diagnostic " +
      "(May 29). VD rows carry a permanent known-low badge in the Labor " +
      "Command Center; Estimator / Book Rate promoted to high-confidence source " +
      "(Jun 18).",
    root_cause: undefined, // pending Saad's dev — tracked here, not in chat scrollback
    declared_at: Date.UTC(2026, 4, 29), // May 29, 2026
  },
];

export const seed = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ inserted: number; skipped: number }> => {
    let inserted = 0;
    let skipped = 0;
    for (const s of SEEDS) {
      const existing = await ctx.db
        .query("data_incidents")
        .withIndex("by_slug", (q) => q.eq("slug", s.slug))
        .first();
      if (existing) {
        skipped++;
        continue;
      }
      await ctx.db.insert("data_incidents", {
        number: s.number,
        slug: s.slug,
        title: s.title,
        severity: s.severity,
        status: s.status,
        summary: s.summary,
        root_cause: s.root_cause,
        scope_note: s.scope_note,
        affected_entity_type: s.affected_entity_type,
        affected_count: s.affected_count,
        declared_by: "seed (historical record)",
        declared_at: s.declared_at,
        resolved_by: s.status === "resolved" ? "seed (historical record)" : undefined,
        resolved_at: s.status === "resolved" ? s.declared_at : undefined,
        resolution_note:
          s.slug === "ford-on-alfa"
            ? "Contaminated configs re-enriched; layer-badge doctrine adopted portal-wide."
            : undefined,
        created_at: Date.now(),
      });
      inserted++;
    }
    return { inserted, skipped };
  },
});
