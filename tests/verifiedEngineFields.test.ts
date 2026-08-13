/**
 * Human-verified engine fields must survive (and steer) re-enrichment.
 *
 * Found live Jun 10: the Jetta EA211's timing_system was corrected
 * chain→belt, then a pinned re-enrich OVERWROTE it back to "chain" (Batch-1
 * repeats the LLM misclassification) — and because applicability nulls are
 * final and the chain rule keys off Batch-1's own extraction, a misclassified
 * belt car can NEVER get its belt parts by re-enriching.
 *
 * Contract:
 *  1. engines.verified_fields lists human-corrected field names.
 *  2. The PIPELINE writer (updateEngineSpecs) skips those keys.
 *  3. applyVerifiedEngineFields overrides the freshly-extracted batch fields
 *     with the verified values BEFORE applicability runs, so the run itself
 *     behaves as if the LLM had extracted the corrected value.
 *  4. Human writers (fixEngineFields, director updateEngineFields) stamp the
 *     fields they set.
 */
import { describe, test, expect } from "vitest";
import { internal, api } from "../convex/_generated/api";
import { makeT } from "./helpers";
import { applyVerifiedEngineFields } from "../convex/vehicleEnrichment/applicabilityRules";

describe("applyVerifiedEngineFields (pure)", () => {
  test("overrides the extracted field with the verified engine value", () => {
    const fields: any = {
      timing_system: { value: "chain", source_type: "training_data", confidence: 0.8 },
    };
    applyVerifiedEngineFields(fields, {
      timing_system: "belt",
      verified_fields: ["timing_system"],
    } as any);
    expect(fields.timing_system.value).toBe("belt");
    expect(fields.timing_system.source_type).toBe("director_verified");
    expect(fields.timing_system.confidence).toBe(1.0);
  });

  test("no-op without verified_fields or without a stored value", () => {
    const fields: any = {
      timing_system: { value: "chain", source_type: "training_data", confidence: 0.8 },
    };
    applyVerifiedEngineFields(fields, { timing_system: "belt" } as any);
    expect(fields.timing_system.value).toBe("chain");
    applyVerifiedEngineFields(fields, {
      verified_fields: ["timing_system"],
    } as any);
    expect(fields.timing_system.value).toBe("chain");
  });
});

describe("updateEngineSpecs (pipeline writer)", () => {
  test("skips human-verified fields, writes the rest", async () => {
    const t = makeT();
    const engineId = await t.run(async (ctx) =>
      ctx.db.insert("engines", {
        engine_code: "EA211",
        timing_system: "belt",
        oil_viscosity: "0W-20",
        verified_fields: ["timing_system"],
      }),
    );

    await t.mutation(internal.vehicleEnrichment.v3mutations.updateEngineSpecs, {
      engine_id: engineId,
      timing_system: "chain", // the LLM's repeat misclassification
      oil_viscosity: "5W-30", // legit enrichment update
    });

    const engine = await t.run(async (ctx) => ctx.db.get(engineId));
    expect(engine!.timing_system).toBe("belt"); // protected
    expect(engine!.oil_viscosity).toBe("5W-30"); // updated
  });
});

describe("human writers stamp verified_fields", () => {
  test("fixEngineFields stamps the fields it changes", async () => {
    const t = makeT();
    const engineId = await t.run(async (ctx) =>
      ctx.db.insert("engines", { engine_code: "EA211", timing_system: "chain" }),
    );

    await t.mutation(internal.devOnly.dataFixes.fixEngineFields, {
      engine_id: engineId,
      timing_system: "belt",
      reason: "EA211 is belt-driven",
    });

    const engine = await t.run(async (ctx) => ctx.db.get(engineId));
    expect(engine!.timing_system).toBe("belt");
    expect(engine!.verified_fields).toEqual(["timing_system"]);
  });

  test("director updateEngineFields stamps too (and dedups)", async () => {
    const t = makeT();
    const now = Date.now();
    const { engineId, token } = await t.run(async (ctx) => {
      const directorId = await ctx.db.insert("director_users", {
        name: "Real Director",
        role: "super_admin",
        totp_secret: "JBSWY3DPEHPK3PXP",
        created_at: now,
      });
      await ctx.db.insert("director_sessions", {
        user_id: directorId,
        token: "tok_verified_fields",
        created_at: now,
        expires_at: now + 3600_000,
      });
      const engineId = await ctx.db.insert("engines", {
        engine_code: "EA211",
        timing_system: "chain",
        verified_fields: ["timing_system"],
      });
      return { engineId, token: "tok_verified_fields" };
    });

    await t.mutation(api.directorConfigActions.updateEngineFields, {
      id: engineId,
      timing_system: "belt",
      cylinders: 4,
      token,
    } as any);

    const engine = await t.run(async (ctx) => ctx.db.get(engineId));
    expect(engine!.timing_system).toBe("belt");
    expect([...(engine!.verified_fields ?? [])].sort()).toEqual([
      "cylinders",
      "timing_system",
    ]);
  });
});
