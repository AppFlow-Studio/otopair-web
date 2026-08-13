/**
 * devOnly/laborValidation:report — the read-only "data-good" labor grading
 * (Notion: Labor-time validation + data-good signal, freeze Jun 10).
 *
 * Grades every OLP-MAPPED service per config with the SAME gate the
 * quote engine uses (isHighQualityVdb): a config is labor_data_good only when
 * every mapped service has a quote-grade labor_times row backed by at least
 * one olp_labor observation. Unmapped services fall to tier_estimate by
 * design and don't count against the rollup.
 */
import { describe, test, expect } from "vitest";
import { internal } from "../convex/_generated/api";
import { makeT } from "./helpers";
import { OLP_JOB_MAP } from "../convex/vehicleEnrichment/olpLabor";

const MAPPED_SLUGS = Object.keys(OLP_JOB_MAP);

async function seedConfigWithLabor(
  t: ReturnType<typeof makeT>,
  opts: { allGood: boolean; timingSystem?: string; skipSlugs?: string[] },
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const makeId = await ctx.db.insert("makes", { name: "Testmake" });
    const modelId = await ctx.db.insert("models", {
      make_id: makeId,
      name: "Testmodel",
    });
    const engineId = await ctx.db.insert("engines", {
      engine_code: "TESTENG",
      ...(opts.timingSystem ? { timing_system: opts.timingSystem } : {}),
    });
    const configId = await ctx.db.insert("vehicle_configs", {
      config_key: "2020_testmake_testmodel_base_x1",
      year: 2020,
      make_id: makeId,
      model_id: modelId,
      engine_id: engineId,
      enrichment_status: "complete",
    });
    for (const [i, slug] of MAPPED_SLUGS.entries()) {
      if (opts.skipSlugs?.includes(slug)) {
        // services row still exists — only the labor data is absent.
        await ctx.db.insert("services", {
          name: slug,
          slug,
          default_labor_hours: 1,
          created_at: now,
        } as any);
        continue;
      }
      const serviceId = await ctx.db.insert("services", {
        name: slug,
        slug,
        default_labor_hours: 1,
        created_at: now,
      } as any);
      // First service is the weak link when allGood=false: a clone row that
      // the quote gate refuses.
      const weak = !opts.allGood && i === 0;
      await ctx.db.insert("labor_times", {
        vehicle_config_id: configId,
        service_id: serviceId,
        book_hours: 1.5,
        source: weak ? "chassis_clone" : "aggregated",
        data_quality: weak ? "chassis_clone" : "aggregated",
        confidence: weak ? 0.7 : 0.9,
      } as any);
      if (!weak) {
        await ctx.db.insert("labor_observations", {
          vehicle_config_id: configId,
          service_id: serviceId,
          hours: 1.5,
          source: "olp_labor",
          weight: 0.8,
          tier: "catalog",
          observed_at: now,
        } as any);
      }
    }
    return { configId };
  });
}

describe("devOnly/laborValidation report", () => {
  test("all mapped services quote-grade + olp-backed → labor_data_good", async () => {
    const t = makeT();
    await seedConfigWithLabor(t, { allGood: true });

    const report = await t.query(internal.devOnly.laborValidation.report, {});
    expect(report).toHaveLength(1);
    expect(report[0].labor_data_good).toBe(true);
    expect(report[0].mapped_quote_grade).toBe(MAPPED_SLUGS.length);
    expect(report[0].mapped_total).toBe(MAPPED_SLUGS.length);
  });

  test("one clone-sourced service breaks the data-good rollup", async () => {
    const t = makeT();
    await seedConfigWithLabor(t, { allGood: false });

    const report = await t.query(internal.devOnly.laborValidation.report, {});
    expect(report[0].labor_data_good).toBe(false);
    expect(report[0].mapped_quote_grade).toBe(MAPPED_SLUGS.length - 1);
    const weak = report[0].services.find((s: any) => !s.quote_grade);
    expect(weak).toBeDefined();
    expect(weak.reason).toContain("clone");
  });

  test("timing_belt missing on a CHAIN engine doesn't count against data-good", async () => {
    const t = makeT();
    // Chain car: no timing_belt labor anywhere (OLP correctly has no belt job
    // for a chain engine) — the service is not applicable, so the rollup skips it.
    await seedConfigWithLabor(t, {
      allGood: true,
      timingSystem: "chain",
      skipSlugs: ["timing_belt"],
    });

    const report = await t.query(internal.devOnly.laborValidation.report, {});
    expect(report[0].mapped_total).toBe(MAPPED_SLUGS.length - 1);
    expect(report[0].labor_data_good).toBe(true);
    const tb = report[0].services.find((s: any) => s.slug === "timing_belt");
    expect(tb.reason).toContain("not applicable");
  });
});
