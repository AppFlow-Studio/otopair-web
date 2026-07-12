/**
 * Clear-on-reject semantics for updateEngineSpecs. A capacity value that sanity
 * checks / the resolver REJECTED must be erased from the engine row (not merely
 * left stale) — otherwise a poisoned value like coolant 16.9 qt survives every
 * re-enrich. Human-verified fields must never be erased.
 */
import { describe, expect, test } from "vitest";
import { makeT } from "./helpers";
import { internal } from "../convex/_generated/api";

const update = internal.vehicleEnrichment.v3mutations.updateEngineSpecs;

async function seedEngine(t: ReturnType<typeof makeT>, extra: Record<string, unknown> = {}) {
  return t.run(async (ctx) =>
    ctx.db.insert("engines", {
      engine_code: "L84",
      cylinders: 8,
      coolant_capacity_qts: 16.9, // the poison
      oil_capacity_qts: 8,
      ...extra,
    } as any),
  );
}

describe("updateEngineSpecs clear_fields", () => {
  test("erases a rejected capacity field (poison removed)", async () => {
    const t = makeT();
    const engineId = await seedEngine(t);

    await t.mutation(update, {
      engine_id: engineId,
      clear_fields: ["coolant_capacity_qts"],
    });

    const row = await t.run((ctx) => ctx.db.get(engineId));
    expect((row as any).coolant_capacity_qts).toBeUndefined(); // deleted
    expect((row as any).oil_capacity_qts).toBe(8);             // untouched
  });

  test("a new value takes precedence over a clear of the same field", async () => {
    const t = makeT();
    const engineId = await seedEngine(t);

    await t.mutation(update, {
      engine_id: engineId,
      coolant_capacity_qts: 13.8,
      clear_fields: ["coolant_capacity_qts"],
    });

    const row = await t.run((ctx) => ctx.db.get(engineId));
    expect((row as any).coolant_capacity_qts).toBe(13.8);
  });

  test("never erases a human-verified field", async () => {
    const t = makeT();
    const engineId = await seedEngine(t, { verified_fields: ["coolant_capacity_qts"] });

    await t.mutation(update, {
      engine_id: engineId,
      clear_fields: ["coolant_capacity_qts"],
    });

    const row = await t.run((ctx) => ctx.db.get(engineId));
    expect((row as any).coolant_capacity_qts).toBe(16.9); // preserved
  });

  test("no clear_fields → existing behavior unchanged", async () => {
    const t = makeT();
    const engineId = await seedEngine(t);

    await t.mutation(update, { engine_id: engineId, oil_capacity_qts: 9 });

    const row = await t.run((ctx) => ctx.db.get(engineId));
    expect((row as any).oil_capacity_qts).toBe(9);
    expect((row as any).coolant_capacity_qts).toBe(16.9); // untouched
  });
});
