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
    const db = base([obs("olp_labor", 0.6), obs("web_labor", 0.65)]);
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

  it("two strong sources that disagree → quotable 0.75 + review flag", async () => {
    // ≥2 strong sources disagree beyond the band → contested-but-quotable 0.75 + review flag.
    // Band math: 0.6 vs 1.2 → gap = 0.6h = 36 min;
    // agreement band = max(15 min, 10%·1.2h = 7.2 min) = 15 min → gap > band → disagree.
    const db = base([obs("olp_labor", 0.6), obs("web_labor", 1.2)]);
    await recomputeLaborForConfigService({ db } as any,
      { vehicleConfigId: CFG, serviceId: SVC, now: 1, bookOnly: true });
    expect(db.inserts[0].doc.confidence).toBe(0.75);
    expect(db.inserts[0].doc).toMatchObject({
      labor_sources_disagree: true, labor_outside_fallback_band: false,
    });
  });

  it("MAD drops one of two disagreeing strong sources — disagreement still flagged at 0.75", async () => {
    // 4 obs so weightedMedian's internal MAD (nonOutlierIndices) engages (n≥4).
    // olp_labor(0.6) and web_labor(5.0) are BOTH strong and disagree badly:
    //   agreement band = max(0.25h, 0.1·5.0h=0.5h) = 0.5h; gap = 4.4h >> 0.5h → disagree.
    // MAD on values [0.6, 5.0, 0.65, 0.7]:
    //   median = (0.65+0.7)/2 = 0.675; absDev = [0.075, 4.325, 0.025, 0.025];
    //   MAD = (0.025+0.075)/2 = 0.05; modified-z for 5.0 = 0.6745·(5.0-0.675)/0.05 ≈ 58.3 >> 3.5
    //   → web_labor(5.0) dropped post-MAD; post-MAD strong = [olp_labor(0.6)] (length 1).
    // But strongRaw (pre-MAD) still has both → sourcesDisagree = true → 0.75 branch fires.
    // weightedMedian of kept obs ([0.6,w=0.8], [0.65,w=0.5], [0.7,w=0.3]): cumulative weight
    //   reaches total/2 = 0.8 at the first entry → book_hours = 0.6.
    // Fallback = 0.5h × 1.2 (T2c multiplier) = 0.6h; gap = 0 min → within guardrail.
    const db = base([
      obs("olp_labor", 0.6, 0.8),
      obs("web_labor", 5.0, 0.6),
      obs("llm_web", 0.65, 0.5),
      obs("llm_training", 0.7, 0.3),
    ]);
    await recomputeLaborForConfigService({ db } as any,
      { vehicleConfigId: CFG, serviceId: SVC, now: 1, bookOnly: true });
    expect(db.inserts[0].doc).toMatchObject({
      confidence: 0.75,
      labor_sources_disagree: true,
      labor_outside_fallback_band: false,
    });
  });

  it("a strong source OUTVOTED on the weighted-median frontier does not lend its 0.8 to a weaker-source median", async () => {
    // web_labor (strong) sits at 2.0 but is outvoted: median lands on the LLM 1.2,
    // so the strong source did NOT drive book_hours → must NOT earn 0.8 (drops to
    // the 0.6 LLM-consensus tier, below the 0.75 quote gate).
    const db = base([
      obs("web_labor", 2.0, 0.6),
      obs("repairpal_labor", 1.0, 0.4),
      obs("llm_training", 1.2, 0.3),
    ]);
    await recomputeLaborForConfigService({ db } as any,
      { vehicleConfigId: CFG, serviceId: SVC, now: 1, bookOnly: true });
    expect(db.inserts[0].doc.book_hours).toBe(1.2);
    expect(db.inserts[0].doc.confidence).toBe(0.6);
  });

  it("an OUTVOTED strong source is denied 0.8 even when the fallback corroborates the weaker median", async () => {
    // Isolates the outvote bug from the fallback-guardrail flag. web_labor (strong,
    // 1.2) is outvoted: the two non-strong 0.6 corroborators carry the weighted
    // median to book_hours=0.6, which the Camry fallback (0.5 × 1.2 = 0.6h) happens
    // to corroborate (gap 0 → within guardrail). Pre-fix the single-strong branch
    // fired and the in-band fallback minted 0.8 on a value the strong source did NOT
    // produce (1.2 is 0.6h from 0.6, outside the 0.25h agreement band). The fix gates
    // that branch on a strong source DRIVING book_hours, so this drops to the
    // 0.6 LLM-consensus tier instead of the strong-source 0.8.
    const db = base([
      obs("web_labor", 1.2, 0.3),
      obs("repairpal_labor", 0.6, 0.4),
      obs("llm_training", 0.6, 0.5),
    ]);
    await recomputeLaborForConfigService({ db } as any,
      { vehicleConfigId: CFG, serviceId: SVC, now: 1, bookOnly: true });
    expect(db.inserts[0].doc.book_hours).toBe(0.6);
    expect(db.inserts[0].doc.labor_outside_fallback_band).toBe(false);
    expect(db.inserts[0].doc.confidence).toBe(0.6);
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
