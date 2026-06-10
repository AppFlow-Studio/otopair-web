/**
 * B-P2 (OTO_HANDOFF.md): scope T2_HASH KB lookups by vehicle.
 *
 * canonicalQuestionKey = sha256(normalize(question)) — it carries NO vehicle
 * identity, so a fact recorded for one car ("oil capacity = 7.5qt" for an
 * M550i) was served verbatim to any other car's owner asking the same
 * question. lookupFactsByCanonicalHash now filters hash hits to the current
 * vehicle (matching config OR chassis OR engine); the decision is the pure
 * factMatchesVehicleScope helper unit-tested here, with an integration check
 * through the query.
 */
import { describe, test, expect } from "vitest";
import { internal } from "../convex/_generated/api";
import { makeT } from "./helpers";
import { factMatchesVehicleScope } from "../convex/oto/vehicleFactsKB";

describe("factMatchesVehicleScope (pure)", () => {
  const fact = {
    vehicle_config_id: "cfg_a" as any,
    chassis_code: "G30",
    engine_code: "B58",
  };

  test("matches on identical config", () => {
    expect(factMatchesVehicleScope(fact, { vehicle_config_id: "cfg_a" as any })).toBe(true);
  });
  test("matches on chassis even when config differs", () => {
    expect(
      factMatchesVehicleScope(fact, { vehicle_config_id: "cfg_z" as any, chassis_code: "G30" }),
    ).toBe(true);
  });
  test("matches on engine", () => {
    expect(factMatchesVehicleScope(fact, { engine_code: "B58" })).toBe(true);
  });
  test("rejects a different car (no axis matches)", () => {
    expect(
      factMatchesVehicleScope(fact, { vehicle_config_id: "cfg_z" as any, chassis_code: "W205", engine_code: "M274" }),
    ).toBe(false);
  });
  test("an empty scope never matches (no false positives)", () => {
    expect(factMatchesVehicleScope(fact, {})).toBe(false);
  });
  test("a null fact axis is not matched by a null scope axis", () => {
    expect(factMatchesVehicleScope({}, { chassis_code: undefined })).toBe(false);
  });
});

async function seedTwoCarsSameQuestion(t: ReturnType<typeof makeT>) {
  return await t.run(async (ctx) => {
    const key = "deadbeef_oil_capacity_hash";
    // Fact for car A (engine B58 / chassis G30).
    await ctx.db.insert("vehicle_facts", {
      topic: "oil_capacity",
      topic_axis: "engine",
      engine_code: "B58",
      chassis_code: "G30",
      fact_text: "B58 takes 7.5 qt of 0W-20.",
      question_text: "oil capacity",
      canonical_question_key: key,
      source: "manufacturer",
      confidence: 0.95,
      verification_status: "verified",
      created_at: Date.now(),
    } as any);
    // Fact for car B (engine M274 / chassis W205) — same canonical key.
    await ctx.db.insert("vehicle_facts", {
      topic: "oil_capacity",
      topic_axis: "engine",
      engine_code: "M274",
      chassis_code: "W205",
      fact_text: "M274 takes 5.5 qt of 5W-40.",
      question_text: "oil capacity",
      canonical_question_key: key,
      source: "manufacturer",
      confidence: 0.95,
      verification_status: "verified",
      created_at: Date.now(),
    } as any);
    return { key };
  });
}

describe("lookupFactsByCanonicalHash vehicle scoping", () => {
  test("returns ONLY the current car's fact when a vehicle scope is given", async () => {
    const t = makeT();
    const { key } = await seedTwoCarsSameQuestion(t);

    const b58 = await t.query(internal.oto.vehicleFactsKB.lookupFactsByCanonicalHash, {
      canonical_question_key: key,
      engine_code: "B58",
    });
    expect(b58).toHaveLength(1);
    expect(b58[0].fact_text).toContain("7.5 qt");

    const m274 = await t.query(internal.oto.vehicleFactsKB.lookupFactsByCanonicalHash, {
      canonical_question_key: key,
      engine_code: "M274",
    });
    expect(m274).toHaveLength(1);
    expect(m274[0].fact_text).toContain("5.5 qt");
  });

  test("a foreign car gets nothing (no cross-car leak)", async () => {
    const t = makeT();
    const { key } = await seedTwoCarsSameQuestion(t);

    const other = await t.query(internal.oto.vehicleFactsKB.lookupFactsByCanonicalHash, {
      canonical_question_key: key,
      engine_code: "EA888",
      chassis_code: "8V",
    });
    expect(other).toHaveLength(0);
  });

  test("no vehicle scope preserves legacy unscoped behavior (both rows)", async () => {
    const t = makeT();
    const { key } = await seedTwoCarsSameQuestion(t);

    const all = await t.query(internal.oto.vehicleFactsKB.lookupFactsByCanonicalHash, {
      canonical_question_key: key,
    });
    expect(all).toHaveLength(2);
  });
});

// Honest single-axis behavior: facts are written along ONE axis
// (record_vehicle_fact scopes a write to a single axis), so the matcher's
// conservatism is intentional and worth pinning. A read that supplies the
// fact's axis hits; a read that supplies only a DIFFERENT axis conservatively
// misses (degrades to STRUCT/TEXT/web — never a cross-car leak). Closing that
// miss requires passing the active vehicle's FULL identity at read time
// (follow-up), not loosening the matcher (which would reintroduce leaks).
describe("lookupFactsByCanonicalHash single-axis facts", () => {
  async function seedEngineOnlyFact(t: ReturnType<typeof makeT>) {
    return await t.run(async (ctx) => {
      const key = "single_axis_oil_key";
      await ctx.db.insert("vehicle_facts", {
        topic: "oil_capacity",
        topic_axis: "engine",
        engine_code: "B58", // ONLY the engine axis is set (realistic write).
        fact_text: "B58 takes 7.5 qt.",
        question_text: "oil capacity",
        canonical_question_key: key,
        source: "manufacturer",
        confidence: 0.95,
        verification_status: "verified",
        created_at: Date.now(),
      } as any);
      return { key };
    });
  }

  test("a read on the fact's own axis hits (the common repeat-question case)", async () => {
    const t = makeT();
    const { key } = await seedEngineOnlyFact(t);
    const hit = await t.query(internal.oto.vehicleFactsKB.lookupFactsByCanonicalHash, {
      canonical_question_key: key,
      engine_code: "B58",
    });
    expect(hit).toHaveLength(1);
  });

  test("a read on a DIFFERENT axis conservatively misses (no leak, re-derives)", async () => {
    const t = makeT();
    const { key } = await seedEngineOnlyFact(t);
    // The engine-only fact has no chassis_code, so a chassis-axis read misses
    // it even for the same physical car (the documented conservative gap).
    const miss = await t.query(internal.oto.vehicleFactsKB.lookupFactsByCanonicalHash, {
      canonical_question_key: key,
      chassis_code: "G30",
    });
    expect(miss).toHaveLength(0);
  });
});
