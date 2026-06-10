/**
 * devOnly/laborValidation — READ-ONLY labor "data-good" grading
 * (Notion: Labor-time validation + data-good signal, freeze Jun 10).
 *
 * Grades every RepairPal-MAPPED service (LABOR_SERVICE_CONFIG) on every
 * non-fixture vehicle_config with the SAME gate the quote engine uses
 * (isHighQualityVdb, lib/quoteEngine.ts) so this report and real quotes can
 * never disagree. A config is `labor_data_good` only when EVERY mapped
 * service has a quote-grade labor_times row backed by >= 1 repairpal_motor
 * observation (multi-source provenance, not an LLM echo).
 *
 * Services without a RepairPal mapping fall to tier_estimate at quote time by
 * design (flag-off-style 0.6 confidence) and are reported but never counted
 * against the rollup.
 *
 *   npx convex run devOnly/laborValidation:report
 */
import { internalQuery } from "../_generated/server";
import { LABOR_SERVICE_CONFIG } from "../services/laborDeterminant";
import { isHighQualityVdb } from "../lib/quoteEngine";

export const report = internalQuery({
  args: {},
  handler: async (ctx) => {
    const configs = (await ctx.db.query("vehicle_configs").collect()) as any[];
    const services = (await ctx.db.query("services").collect()) as any[];
    const serviceBySlug = new Map(services.filter((s) => s.slug).map((s) => [s.slug, s]));

    const out: any[] = [];
    for (const cfg of configs) {
      // Skip fixtures / never-enriched rows — the signal is about enriched cars.
      if (!["complete", "verified", "partial"].includes(cfg.enrichment_status ?? "")) continue;
      if (String(cfg.config_key ?? "").includes("evaltest")) continue;

      // Applicability basis: timing_belt on a chain engine is NOT a labor gap
      // (RepairPal correctly has no page) — mirror the coverage inspector.
      const engine = cfg.engine_id ? ((await ctx.db.get(cfg.engine_id)) as any) : null;
      const timingSystem = engine?.timing_system ?? null;

      const rows: any[] = [];
      let mappedQuoteGrade = 0;
      let mappedTotal = 0;
      for (const [slug, sc] of Object.entries(LABOR_SERVICE_CONFIG)) {
        const svc = serviceBySlug.get(slug);
        if (!svc) continue;
        if (slug === "timing_belt" && timingSystem != null && timingSystem !== "belt") {
          rows.push({
            slug,
            mapped: !!sc.repairpal_slug,
            hours: null,
            source: null,
            confidence: null,
            observations: 0,
            repairpal_observations: 0,
            quote_grade: false,
            reason: `not applicable (timing_system=${timingSystem})`,
          });
          continue; // excluded from mapped_total — can't count against data-good
        }
        const lt = await ctx.db
          .query("labor_times")
          .withIndex("by_vehicle_config_and_service", (q: any) =>
            q.eq("vehicle_config_id", cfg._id).eq("service_id", svc._id),
          )
          .first();
        const obs = await ctx.db
          .query("labor_observations")
          .withIndex("by_config_service", (q: any) =>
            q.eq("vehicle_config_id", cfg._id).eq("service_id", svc._id),
          )
          .collect();
        const rpObs = obs.filter((o: any) => o.source === "repairpal_motor").length;

        const gateOk = lt ? isHighQualityVdb(lt as any) : false;
        const mapped = !!sc.repairpal_slug;
        const quoteGrade = gateOk && (!mapped || rpObs > 0);
        const reason = !lt
          ? "no labor_times row"
          : !gateOk
            ? `gate refused (source=${(lt as any).source ?? "?"}, data_quality=${(lt as any).data_quality ?? "?"}, conf=${(lt as any).confidence ?? "?"})`
            : mapped && rpObs === 0
              ? "no repairpal_motor observation backing the aggregate"
              : "ok";

        if (mapped) {
          mappedTotal++;
          if (quoteGrade) mappedQuoteGrade++;
        }
        rows.push({
          slug,
          mapped,
          hours: (lt as any)?.book_hours ?? null,
          source: (lt as any)?.source ?? null,
          confidence: (lt as any)?.confidence ?? null,
          observations: obs.length,
          repairpal_observations: rpObs,
          quote_grade: quoteGrade,
          reason,
        });
      }

      out.push({
        config_key: cfg.config_key,
        enrichment_status: cfg.enrichment_status,
        timing_system: timingSystem,
        mapped_quote_grade: mappedQuoteGrade,
        mapped_total: mappedTotal,
        labor_data_good: mappedTotal > 0 && mappedQuoteGrade === mappedTotal,
        services: rows,
      });
    }
    return out;
  },
});
