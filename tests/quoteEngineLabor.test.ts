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
  const repairpalObs = {
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
      labor_observations: [repairpalObs],
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
      labor_observations: [repairpalObs],
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

  it("a lone repairpal_motor observation is no longer an anchor (confidence 0.4)", async () => {
    const db = fakeDb({
      labor_observations: [
        { _id: "oa2", vehicle_config_id: CFG, service_id: SVC, tier: "catalog", hours: 1.2, weight: 0.8, source: "repairpal_motor" },
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
