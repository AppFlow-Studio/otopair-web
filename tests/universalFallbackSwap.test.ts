/**
 * Universal-fallback swap tests — fix for the Jun-10 live finding (750i):
 *
 * A junk/unpriceable enriched fitment BLOCKED the universal consumable
 * fallback: synthesis only fired when NO fitment group existed for the role,
 * so the 750i's gear_oil fitment (junk OEM, zero price rows) billed $0 while
 * a perfectly good $22 seeded fallback sat unused. When every candidate in a
 * declared CORE role group is unpriced and the role has a priced universal
 * seed, the resolver must swap to the seed.
 */
import { describe, expect, it } from "vitest";
import { resolveWinningPartForService } from "../convex/serviceParts";

type Row = Record<string, any>;

function fakeDb(tables: Record<string, Row[]>) {
  const evalExpr = (row: Row, expr: any): any => {
    if (expr && expr.__field) return row[expr.__field];
    return expr;
  };
  const matches = (row: Row, eqs: [string, any][]) =>
    eqs.every(([f, v]) => row[f] === v);
  const makeQ = () => {
    const eqs: [string, any][] = [];
    const q: any = {
      eq(a: any, b: any) {
        if (typeof a === "string") {
          eqs.push([a, b]);
          return q;
        }
        return { __pred: (row: Row) => evalExpr(row, a) === evalExpr(row, b) };
      },
      field(name: string) {
        return { __field: name };
      },
    };
    return { q, eqs };
  };
  const db = {
    query(table: string) {
      const state = { eqs: [] as [string, any][], preds: [] as ((r: Row) => boolean)[] };
      const rows = () =>
        (tables[table] ?? []).filter(
          (r) => matches(r, state.eqs) && state.preds.every((p) => p(r)),
        );
      const api: any = {
        withIndex(_n: string, fn?: (q: any) => any) {
          if (fn) {
            const { q, eqs } = makeQ();
            fn(q);
            state.eqs.push(...eqs);
          }
          return api;
        },
        filter(fn: (q: any) => any) {
          const { q } = makeQ();
          const pred = fn(q);
          if (pred && pred.__pred) state.preds.push(pred.__pred);
          return api;
        },
        collect: async () => rows(),
        first: async () => rows()[0] ?? null,
        unique: async () => rows()[0] ?? null,
      };
      return api;
    },
    async get(id: any) {
      for (const rows of Object.values(tables)) {
        const hit = rows.find((r) => r._id === id);
        if (hit) return hit;
      }
      return null;
    },
  };
  return db;
}

const CFG = "cfg1" as any;

const TABLES = () => ({
  vehicle_configs: [{ _id: CFG }],
  part_fitments: [
    {
      _id: "f_junk",
      vehicle_config_id: CFG,
      service_type: "differential_service",
      part_id: "p_junk",
      confidence: 0.9,
    },
  ],
  oem_parts: [
    {
      _id: "p_junk",
      oem_part_number: "7512293972",
      name: "Gear Oil (GL-5 hypoid)",
      subcategory: "gear_oil",
      category: "fluids",
    },
    {
      _id: "p_seed",
      oem_part_number: "UNIV-GEAR-OIL",
      name: "GL-5 75W-90 gear oil (qt)",
      subcategory: "gear_oil",
      category: "consumable",
    },
  ],
  part_prices: [
    { _id: "pr1", part_id: "p_seed", price: 22, price_type: "manual_seed" },
  ],
  vehicle_part_preferences: [],
});

const ARGS = {
  vin: "",
  serviceId: "svc_diff" as any,
  serviceSlug: "differential_service",
  vehicleConfigId: CFG,
  confirmedPackages: new Set<string>(),
};

describe("universal-fallback swap for all-unpriced core roles", () => {
  it("swaps an all-unpriced gear_oil group to the priced universal seed", async () => {
    const res = await resolveWinningPartForService({ db: fakeDb(TABLES()) } as any, ARGS);
    const gearOil = res.roleWinners.find((rw) => rw.roleKey === "gear_oil");
    expect(gearOil).toBeDefined();
    expect(String(gearOil!.candidate.part._id)).toBe("p_seed");
    expect(gearOil!.candidate.priceSummary.sample_size).toBeGreaterThan(0);
    expect(gearOil!.source).toBe("universal_fallback");
  });

  it("keeps the real enriched part when it HAS a trustworthy price", async () => {
    const tables = TABLES();
    tables.part_prices.push({
      _id: "pr2",
      part_id: "p_junk",
      price: 18.5,
      price_type: "sale",
    });
    const res = await resolveWinningPartForService({ db: fakeDb(tables) } as any, ARGS);
    const gearOil = res.roleWinners.find((rw) => rw.roleKey === "gear_oil");
    expect(String(gearOil!.candidate.part._id)).toBe("p_junk");
  });

  it("keeps the unpriced real part when no priced seed exists (price_unknown handles it)", async () => {
    const tables = TABLES();
    tables.part_prices = []; // seed exists but unpriced
    const res = await resolveWinningPartForService({ db: fakeDb(tables) } as any, ARGS);
    const gearOil = res.roleWinners.find((rw) => rw.roleKey === "gear_oil");
    expect(String(gearOil!.candidate.part._id)).toBe("p_junk");
    expect(gearOil!.candidate.priceSummary.sample_size).toBe(0);
  });

  it("swaps when the winner's price is implausible vs the reference anchor (the $49 crush washer)", async () => {
    // gear_oil anchor is $22; a $200 'sale' price (>6x anchor) is a captured
    // MSRP/multi-pack/garbage figure — the seeded fallback must win instead.
    const tables = TABLES();
    tables.part_prices.push({
      _id: "pr_absurd",
      part_id: "p_junk",
      price: 200,
      price_type: "sale",
    });
    const res = await resolveWinningPartForService({ db: fakeDb(tables) } as any, ARGS);
    const gearOil = res.roleWinners.find((rw) => rw.roleKey === "gear_oil");
    expect(String(gearOil!.candidate.part._id)).toBe("p_seed");
    expect(gearOil!.source).toBe("universal_fallback");
  });
});
