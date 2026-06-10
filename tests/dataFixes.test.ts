/**
 * devOnly/dataFixes — audited one-off engine data corrections (CLI only).
 * First use: the Jetta EA211's timing_system was stored "chain" (LLM
 * misclassification — the EA211 1.5 TSI is belt-driven) and cylinders held
 * the displacement (1.5 instead of 4).
 */
import { describe, test, expect } from "vitest";
import { internal } from "../convex/_generated/api";
import { makeT } from "./helpers";

describe("devOnly/dataFixes.fixEngineFields", () => {
  test("patches the given fields and writes an audited data_fix row", async () => {
    const t = makeT();
    const engineId = await t.run(async (ctx) =>
      ctx.db.insert("engines", {
        engine_code: "EA211",
        timing_system: "chain",
        cylinders: 1.5,
      }),
    );

    const res = await t.mutation(internal.devOnly.dataFixes.fixEngineFields, {
      engine_id: engineId,
      timing_system: "belt",
      cylinders: 4,
      reason: "EA211 1.5 TSI is belt-driven; cylinders held displacement",
    });
    expect(res).toEqual({ ok: true, changes: 2 });

    const { engine, audit } = await t.run(async (ctx) => ({
      engine: await ctx.db.get(engineId),
      audit: await ctx.db.query("audit_log").collect(),
    }));
    expect(engine!.timing_system).toBe("belt");
    expect(engine!.cylinders).toBe(4);
    expect(audit).toHaveLength(1);
    expect(audit[0].entity_type).toBe("engine");
    expect(audit[0].action).toBe("data_fix");
    expect(audit[0].detail).toContain("timing_system: chain → belt");
    expect(audit[0].detail).toContain("EA211 1.5 TSI is belt-driven");
  });

  test("matching values: no audit row, but the field is still stamped verified", async () => {
    const t = makeT();
    const engineId = await t.run(async (ctx) =>
      ctx.db.insert("engines", { engine_code: "EA211", timing_system: "belt" }),
    );

    const res = await t.mutation(internal.devOnly.dataFixes.fixEngineFields, {
      engine_id: engineId,
      timing_system: "belt",
      reason: "already correct — stamping verified",
    });
    expect(res).toEqual({ ok: true, changes: 0 });

    const { audit, engine } = await t.run(async (ctx) => ({
      audit: await ctx.db.query("audit_log").collect(),
      engine: await ctx.db.get(engineId),
    }));
    expect(audit).toHaveLength(0); // nothing changed → nothing to audit
    // ...but the confirmation is recorded so the pipeline can't clobber it.
    expect(engine!.verified_fields).toEqual(["timing_system"]);
  });
});
