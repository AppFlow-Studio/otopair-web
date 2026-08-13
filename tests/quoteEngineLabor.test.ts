/**
 * Labor quote-gate tests — quoteEngine.resolveLaborHours + labor_aggregation
 * recompute stamping, against a minimal in-memory db fake.
 *
 * Pins the four gate holes found in the 2026-06-09 enrichment review
 * (docs/superpowers/reviews/2026-06-09-enrichment-pipeline-review.md, item 11):
 *  1. legacy LLM-guess rows (source training_data/web_search, blank
 *     data_quality) must NOT pass Layer 1,
 *  2. recompute must stamp data_quality 'aggregated' so stale clone stamps
 *     can't disqualify good aggregated values,
 *  3. the Layer-3 sibling fallback must apply the same quality gate,
 *  4. aggregated rows must be labeled 'aggregated' (not 'vdb') in results.
 */
import { describe, it, expect } from "vitest";

import { resolveLaborHours } from "../convex/lib/quoteEngine";
import { recomputeLaborForConfigService } from "../convex/lib/labor_aggregation";

type Row = Record<string, any>;

function fakeDb(tables: Record<string, Row[]>) {
  const matches = (row: Row, eqs: [string, any][]) =>
    eqs.every(([f, v]) => row[f] === v);
  const db = {
    patches: [] as { id: any; patch: Row }[],
    inserts: [] as { table: string; doc: Row }[],
    query(table: string) {
      const builder = (eqs: [string, any][]) => ({
        collect: async () => (tables[table] ?? []).filter((r) => matches(r, eqs)),
        first: async () =>
          (tables[table] ?? []).filter((r) => matches(r, eqs))[0] ?? null,
        unique: async () =>
          (tables[table] ?? []).filter((r) => matches(r, eqs))[0] ?? null,
      });
      return {
        withIndex(_name: string, fn?: (q: any) => any) {
          const eqs: [string, any][] = [];
          if (fn) {
            const q = {
              eq(field: string, value: any) {
                eqs.push([field, value]);
                return q;
              },
            };
            fn(q);
          }
          return builder(eqs);
        },
        ...builder([]),
      };
    },
    async get(id: any) {
      for (const rows of Object.values(tables)) {
        const hit = rows.find((r) => r._id === id);
        if (hit) return hit;
      }
      return null;
    },
    async patch(id: any, patch: Row) {
      db.patches.push({ id, patch });
    },
    async insert(table: string, doc: Row) {
      db.inserts.push({ table, doc });
    },
  };
  return db;
}

const CFG = "cfg1";
const SVC = "svc1";
const SIB = "cfg2";

/** services row with no labor_multiplier_category_id → Layer 5 refuses, so a
 *  test reaching Layer 5 deterministically gets ok:false. */
const SERVICE_NO_TIER = { _id: SVC, slug: "spark_plug_replacement" };

function laborArgs() {
  return {
    vehicle_config_id: CFG as any,
    service_id: SVC as any,
    vehicle_tier: "T2c" as any,
  };
}

describe("resolveLaborHours Layer-1 quality gate", () => {
  it("rejects legacy training_data rows with blank data_quality (falls through)", async () => {
    const db = fakeDb({
      vehicle_configs: [{ _id: CFG }],
      services: [SERVICE_NO_TIER],
      labor_times: [
        {
          _id: "lt1",
          vehicle_config_id: CFG,
          service_id: SVC,
          book_hours: 2.5,
          source: "training_data",
          confidence: 0.75,
        },
      ],
    });
    const res = await resolveLaborHours({ db } as any, laborArgs());
    expect(res.ok).toBe(false);
  });

  it("rejects legacy web_search rows with blank data_quality", async () => {
    const db = fakeDb({
      vehicle_configs: [{ _id: CFG }],
      services: [SERVICE_NO_TIER],
      labor_times: [
        {
          _id: "lt1",
          vehicle_config_id: CFG,
          service_id: SVC,
          book_hours: 1.8,
          source: "web_search",
          confidence: 0.85,
        },
      ],
    });
    const res = await resolveLaborHours({ db } as any, laborArgs());
    expect(res.ok).toBe(false);
  });

  it("accepts aggregated rows and labels them source 'aggregated'", async () => {
    const db = fakeDb({
      vehicle_configs: [{ _id: CFG }],
      services: [SERVICE_NO_TIER],
      labor_times: [
        {
          _id: "lt1",
          vehicle_config_id: CFG,
          service_id: SVC,
          book_hours: 3.3,
          source: "aggregated",
          confidence: 0.8,
        },
      ],
    });
    const res = await resolveLaborHours({ db } as any, laborArgs());
    expect(res).toMatchObject({
      ok: true,
      hours: 3.3,
      source: "aggregated",
      confidence: 0.8,
    });
  });

  it("still accepts plain vdb rows as source 'vdb' (regression)", async () => {
    const db = fakeDb({
      vehicle_configs: [{ _id: CFG }],
      services: [SERVICE_NO_TIER],
      labor_times: [
        {
          _id: "lt1",
          vehicle_config_id: CFG,
          service_id: SVC,
          book_hours: 1.2,
          source: "vdb",
          confidence: 0.9,
        },
      ],
    });
    const res = await resolveLaborHours({ db } as any, laborArgs());
    expect(res).toMatchObject({ ok: true, hours: 1.2, source: "vdb" });
  });

  it("still rejects chassis_clone data_quality (regression)", async () => {
    const db = fakeDb({
      vehicle_configs: [{ _id: CFG }],
      services: [SERVICE_NO_TIER],
      labor_times: [
        {
          _id: "lt1",
          vehicle_config_id: CFG,
          service_id: SVC,
          book_hours: 2.0,
          source: "vdb",
          confidence: 0.9,
          data_quality: "chassis_clone",
        },
      ],
    });
    const res = await resolveLaborHours({ db } as any, laborArgs());
    expect(res.ok).toBe(false);
  });
});

describe("resolveLaborHours Layer-3 sibling gate", () => {
  const tablesWithSibling = (sibLaborRow: Row) => ({
    vehicle_configs: [
      { _id: CFG, chassis_code: "G30" },
      { _id: SIB, chassis_code: "G30" },
    ],
    services: [SERVICE_NO_TIER],
    labor_times: [{ ...sibLaborRow, vehicle_config_id: SIB, service_id: SVC }],
  });

  it("does NOT accept a chassis_clone sibling row", async () => {
    const db = fakeDb(
      tablesWithSibling({
        _id: "lt_sib",
        book_hours: 2.0,
        source: "vdb",
        confidence: 0.9,
        data_quality: "chassis_clone",
      }),
    );
    const res = await resolveLaborHours({ db } as any, laborArgs());
    expect(res.ok).toBe(false);
  });

  it("does NOT accept a low-confidence training_data sibling row", async () => {
    const db = fakeDb(
      tablesWithSibling({
        _id: "lt_sib",
        book_hours: 2.0,
        source: "training_data",
        confidence: 0.45,
      }),
    );
    const res = await resolveLaborHours({ db } as any, laborArgs());
    expect(res.ok).toBe(false);
  });

  it("accepts a high-quality sibling row at confidence 0.7", async () => {
    const db = fakeDb(
      tablesWithSibling({
        _id: "lt_sib",
        book_hours: 2.1,
        source: "aggregated",
        confidence: 0.8,
      }),
    );
    const res = await resolveLaborHours({ db } as any, laborArgs());
    expect(res).toMatchObject({
      ok: true,
      hours: 2.1,
      source: "sibling",
      confidence: 0.7,
    });
  });
});

describe("recomputeLaborForConfigService data_quality stamping", () => {
  const estimatorObs = {
    _id: "obs1",
    vehicle_config_id: CFG,
    service_id: SVC,
    tier: "catalog",
    hours: 3.2,
    weight: 0.8,
    source: "olp_labor",
  };

  it("patch path clears a stale clone stamp to data_quality 'aggregated'", async () => {
    const db = fakeDb({
      labor_observations: [estimatorObs],
      labor_times: [
        {
          _id: "lt1",
          vehicle_config_id: CFG,
          service_id: SVC,
          book_hours: 5,
          source: "chassis_clone",
          data_quality: "chassis_clone",
        },
      ],
    });
    await recomputeLaborForConfigService(
      { db } as any,
      { vehicleConfigId: CFG, serviceId: SVC, now: 1000, bookOnly: true },
    );
    expect(db.patches).toHaveLength(1);
    expect(db.patches[0].patch).toMatchObject({
      book_hours: 3.2,
      source: "aggregated",
      data_quality: "aggregated",
      confidence: 0.8,
    });
  });

  it("insert path stamps data_quality 'aggregated'", async () => {
    const db = fakeDb({
      labor_observations: [estimatorObs],
      labor_times: [],
    });
    await recomputeLaborForConfigService(
      { db } as any,
      { vehicleConfigId: CFG, serviceId: SVC, now: 1000, bookOnly: true },
    );
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0].doc).toMatchObject({
      book_hours: 3.2,
      source: "aggregated",
      data_quality: "aggregated",
    });
  });

  it("leaves data_quality untouched when no catalog observations drive the value", async () => {
    const db = fakeDb({
      labor_observations: [],
      labor_times: [
        {
          _id: "lt1",
          vehicle_config_id: CFG,
          service_id: SVC,
          book_hours: 5,
          source: "chassis_clone",
          data_quality: "chassis_clone",
        },
      ],
    });
    await recomputeLaborForConfigService(
      { db } as any,
      { vehicleConfigId: CFG, serviceId: SVC, now: 1000, bookOnly: true },
    );
    expect(db.patches).toHaveLength(0);
    expect(db.inserts).toHaveLength(0);
  });
});

// ─── Guardrail-aware tier floor (Task 1: floor decision) ────────────────────
// Floor = Camry book_hours × multiplier = 1.5 × 1.0 = 1.5 h.
// raw 1.4h → 6 min below floor → within 15 min guardrail → keep raw, no floor.
// raw 0.9h → 36 min below floor → exceeds guardrail → substitute floor.

const CAMRY_ID = "camry1";
const CAT_ID = "cat1";
const TIER = "T2c";

function floorTables(rawHours: number) {
  return {
    vehicle_configs: [
      { _id: CFG },
      { _id: CAMRY_ID, config_key: "2020_toyota_camry_le_fwd_a25a-fks" },
    ],
    services: [{ _id: SVC, labor_multiplier_category_id: CAT_ID }],
    pricing_labor_multipliers: [
      { _id: "plm1", labor_category_id: CAT_ID, tier: TIER, multiplier: 1.0 },
    ],
    labor_times: [
      // Camry baseline — provides the floor anchor (1.5 h)
      {
        _id: "lt_camry",
        vehicle_config_id: CAMRY_ID,
        service_id: SVC,
        book_hours: 1.5,
        source: "aggregated",
        confidence: 0.8,
      },
      // Actual vehicle row with raw hours
      {
        _id: "lt_real",
        vehicle_config_id: CFG,
        service_id: SVC,
        book_hours: rawHours,
        source: "aggregated",
        confidence: 0.8,
      },
    ],
  };
}

describe("resolveLaborHours guardrail-aware tier floor", () => {
  it("keeps raw hours when raw is within 15 min of floor (6 min below → no substitution)", async () => {
    const db = fakeDb(floorTables(1.4));
    const res = await resolveLaborHours({ db } as any, {
      vehicle_config_id: CFG as any,
      service_id: SVC as any,
      vehicle_tier: TIER as any,
    });
    expect(res).toMatchObject({
      ok: true,
      hours: 1.4,
      tier_floor_applied: false,
    });
  });

  it("substitutes floor when raw is more than 15 min below it (36 min below → floor applied)", async () => {
    const db = fakeDb(floorTables(0.9));
    const res = await resolveLaborHours({ db } as any, {
      vehicle_config_id: CFG as any,
      service_id: SVC as any,
      vehicle_tier: TIER as any,
    });
    expect(res).toMatchObject({
      ok: true,
      hours: 1.5,
      tier_floor_applied: true,
    });
  });

  it("does NOT floor empirical data — real post-job actuals bypass the floor", async () => {
    // empirical 1.2h is 18 min below the 1.5h floor (beyond the 15-min guardrail),
    // but empirical (5+ jobs) is the source of truth and must never be inflated.
    const t = floorTables(1.4);
    t.labor_times[1] = {
      _id: "lt_real",
      vehicle_config_id: CFG,
      service_id: SVC,
      book_hours: 1.4,
      source: "aggregated",
      confidence: 0.8,
      empirical_hours: 1.2,
      empirical_sample_size: 5,
    } as any;
    const db = fakeDb(t);
    const res = await resolveLaborHours({ db } as any, {
      vehicle_config_id: CFG as any,
      service_id: SVC as any,
      vehicle_tier: TIER as any,
    });
    expect(res).toMatchObject({ ok: true, source: "empirical", hours: 1.2 });
  });
});

// ─── Empirical-first (Task 5) ────────────────────────────────────────────────
// A row with BOTH a high-quality aggregated book_hours (conf ≥ 0.75) AND
// empirical_hours with sample_size ≥ 5 must return source "empirical" —
// empirical overrides book, matching the UI resolver (laborTimes.ts) and spec §5.

describe("resolveRawLaborLayers empirical-first priority", () => {
  it("empirical overrides high-quality book when sample_size >= 5", async () => {
    const db = fakeDb({
      vehicle_configs: [{ _id: CFG }],
      services: [SERVICE_NO_TIER],
      labor_times: [
        {
          _id: "lt_both",
          vehicle_config_id: CFG,
          service_id: SVC,
          // High-quality aggregated book — would normally pass isHighQualityVdb
          book_hours: 3.0,
          source: "aggregated",
          data_quality: "aggregated",
          confidence: 0.8,
          // Empirical with sufficient samples — must win
          empirical_hours: 2.7,
          empirical_sample_size: 5,
        },
      ],
    });
    const res = await resolveLaborHours({ db } as any, laborArgs());
    expect(res).toMatchObject({ ok: true, source: "empirical", hours: 2.7 });
  });

  it("empirical does NOT override book when sample_size < 5 (falls to book)", async () => {
    const db = fakeDb({
      vehicle_configs: [{ _id: CFG }],
      services: [SERVICE_NO_TIER],
      labor_times: [
        {
          _id: "lt_both",
          vehicle_config_id: CFG,
          service_id: SVC,
          book_hours: 3.0,
          source: "aggregated",
          data_quality: "aggregated",
          confidence: 0.8,
          empirical_hours: 2.7,
          empirical_sample_size: 4, // below threshold
        },
      ],
    });
    const res = await resolveLaborHours({ db } as any, laborArgs());
    expect(res).toMatchObject({ ok: true, source: "aggregated" });
  });
});

describe("labor_aggregation anchor = olp_labor", () => {
  it("a lone olp_labor observation unlocks confidence 0.8", async () => {
    const db = fakeDb({
      labor_observations: [
        { _id: "oa1", vehicle_config_id: CFG, service_id: SVC, tier: "catalog", hours: 1.2, weight: 0.8, source: "olp_labor" },
      ],
      labor_times: [],
    });
    await recomputeLaborForConfigService(
      { db } as any,
      { vehicleConfigId: CFG, serviceId: SVC, now: 1000, bookOnly: true },
    );
    expect(db.inserts[0].doc).toMatchObject({ book_hours: 1.2, source: "aggregated", confidence: 0.8 });
  });

  it("a lone estimator_book observation is no longer an anchor (confidence 0.4)", async () => {
    const db = fakeDb({
      labor_observations: [
        { _id: "oa2", vehicle_config_id: CFG, service_id: SVC, tier: "catalog", hours: 1.2, weight: 0.8, source: "estimator_book" },
      ],
      labor_times: [],
    });
    await recomputeLaborForConfigService(
      { db } as any,
      { vehicleConfigId: CFG, serviceId: SVC, now: 1000, bookOnly: true },
    );
    expect(db.inserts[0].doc).toMatchObject({ confidence: 0.4 });
  });
});
