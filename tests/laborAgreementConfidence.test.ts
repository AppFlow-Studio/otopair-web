// tests/laborAgreementConfidence.test.ts
import { describe, it, expect } from "vitest";
import { fakeDb } from "./helpers/fakeLaborDb";
import { recomputeLaborForConfigService } from "../convex/lib/labor_aggregation";
import { CAMRY_FWD_CONFIG_KEY } from "../convex/lib/laborFallback";

const CFG = "cfg1", SVC = "svc1", CAT = "cat1", CAMRY = "camry";

/** Seed a config (tier T2c) + a Camry fallback of 0.5 × 1.2 = 0.6h for SVC. */
function base(extraObs: any[]) {
  return fakeDb({
    vehicle_configs: [
      { _id: CFG, pricing_tier: "T2c" },
      { _id: CAMRY, config_key: CAMRY_FWD_CONFIG_KEY },
    ],
    services: [{ _id: SVC, slug: "oil_change", labor_multiplier_category_id: CAT }],
    pricing_labor_multipliers: [{ _id: "m", labor_category_id: CAT, tier: "T2c", multiplier: 1.2 }],
    labor_times: [{ _id: "camry_lt", vehicle_config_id: CAMRY, service_id: SVC, book_hours: 0.5 }],
    labor_observations: extraObs,
  });
}
const obs = (source: string, hours: number, weight = 0.7) => ({
  _id: `${source}_${hours}`, vehicle_config_id: CFG, service_id: SVC,
  tier: "catalog", hours, weight, source,
});

describe("agreement + fallback-guardrail confidence", () => {
  it("two strong sources that agree → 0.9, no flags", async () => {
    const db = base([obs("olp_labor", 0.6), obs("repairpal_labor", 0.65)]);
    await recomputeLaborForConfigService({ db } as any,
      { vehicleConfigId: CFG, serviceId: SVC, now: 1, bookOnly: true });
    expect(db.inserts[0].doc).toMatchObject({
      confidence: 0.9, labor_sources_disagree: false, labor_outside_fallback_band: false,
    });
  });

  it("one strong source within 15 min of the fallback → 0.8", async () => {
    // obs 0.7 (no clampRound surprise) vs fallback 0.6 = 6 min gap → within guardrail
    const db = base([obs("olp_labor", 0.7)]);
    await recomputeLaborForConfigService({ db } as any,
      { vehicleConfigId: CFG, serviceId: SVC, now: 1, bookOnly: true });
    expect(db.inserts[0].doc).toMatchObject({
      confidence: 0.8, labor_outside_fallback_band: false,
    });
  });

  it("one strong source >15 min from the fallback → 0.6 + outside-band flag", async () => {
    // book 1.5 vs fallback 0.6 = 54 min gap → outside guardrail
    const db = base([obs("olp_labor", 1.5)]);
    await recomputeLaborForConfigService({ db } as any,
      { vehicleConfigId: CFG, serviceId: SVC, now: 1, bookOnly: true });
    expect(db.inserts[0].doc).toMatchObject({
      confidence: 0.6, labor_outside_fallback_band: true, fallback_gap_minutes: 54,
    });
  });

  it("two strong sources that disagree → flagged + capped below 0.9", async () => {
    // 0.6 vs 1.2: agreement band = max(15min, 10%·1.2h=7.2min)=15min; 36min apart → disagree
    const db = base([obs("olp_labor", 0.6), obs("repairpal_labor", 1.2)]);
    await recomputeLaborForConfigService({ db } as any,
      { vehicleConfigId: CFG, serviceId: SVC, now: 1, bookOnly: true });
    // median (0.6) coincides with the fallback, so it lands at the single-source
    // 0.8 tier — disagreement is flagged for review but not yet read by the quote
    // gate (a Phase-3 concern, since >1 strong source can't occur in prod until
    // RepairPal/web sources are added).
    expect(db.inserts[0].doc.confidence).toBe(0.8);
    expect(db.inserts[0].doc).toMatchObject({
      labor_sources_disagree: true, labor_outside_fallback_band: false,
    });
  });

  it("a strong source MAD-dropped as an outlier does not lend its 0.8 to a weaker-source median", async () => {
    // 4 obs so weightedMedian's internal MAD engages; olp 7.5 is the outlier and
    // is dropped, so book_hours is LLM/VDB-driven and confidence must be the
    // LLM-consensus 0.6, NOT the strong-source 0.8.
    const db = base([
      obs("olp_labor", 7.5, 0.8),
      obs("llm_web", 1.0, 0.5),
      obs("llm_training", 1.1, 0.3),
      obs("vdb_repair_estimates", 1.05, 0.05),
    ]);
    await recomputeLaborForConfigService({ db } as any,
      { vehicleConfigId: CFG, serviceId: SVC, now: 1, bookOnly: true });
    expect(db.inserts[0].doc.confidence).toBe(0.6);
  });
});
