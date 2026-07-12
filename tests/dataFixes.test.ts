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

describe("devOnly/dataFixes.deleteMarketplacePrices", () => {
  test("dry_run reports matches without deleting; real run deletes + audits", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const part = await ctx.db.insert("oem_parts", { oem_part_number: "19386946", name: "Rear Brake Pads" });
      await ctx.db.insert("part_prices", {
        part_id: part, price: 31.78, price_type: "sale",
        source_domain: "amazon.com",
        source_url: "https://www.amazon.com/Genuine-Front-Brake/dp/B0DJ93X4GR",
      });
      await ctx.db.insert("part_prices", {
        part_id: part, price: 20, price_type: "sale",
        source_domain: "ebay.com", source_url: "https://www.ebay.com/itm/1",
      });
      // URL betrays a mislabeled domain — must still match.
      await ctx.db.insert("part_prices", {
        part_id: part, price: 15, price_type: "llm_estimate",
        source_domain: "enrichment", source_url: "https://www.walmart.com/ip/1",
      });
      // Clean OEM-store row — must survive.
      await ctx.db.insert("part_prices", {
        part_id: part, price: 147.95, price_type: "sale",
        source_domain: "gmpartsdirect.com",
        source_url: "https://www.gmpartsdirect.com/oem-parts/gm-brake-pads-19386946",
      });
    });

    const dry = await t.mutation(internal.devOnly.dataFixes.deleteMarketplacePrices, {
      dry_run: true, reason: "audit",
    });
    expect(dry.dry_run).toBe(true);
    expect(dry.matched).toBe(3);
    expect(dry.by_domain).toEqual({ "amazon.com": 1, "ebay.com": 1, enrichment: 1 });
    // Dry run deleted nothing.
    expect(await t.run(async (ctx) => (await ctx.db.query("part_prices").collect()).length)).toBe(4);

    const real = await t.mutation(internal.devOnly.dataFixes.deleteMarketplacePrices, {
      reason: "marketplace prices are wrong-product listings",
    });
    expect(real.deleted).toBe(3);

    const { rows, audit } = await t.run(async (ctx) => ({
      rows: await ctx.db.query("part_prices").collect(),
      audit: await ctx.db.query("audit_log").collect(),
    }));
    expect(rows).toHaveLength(1);
    expect(rows[0].source_domain).toBe("gmpartsdirect.com");
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("data_fix");
    expect(audit[0].detail).toContain("Deleted 3 marketplace-sourced part_prices rows");

    // Second dry run finds nothing left.
    const after = await t.mutation(internal.devOnly.dataFixes.deleteMarketplacePrices, {
      dry_run: true, reason: "verify",
    });
    expect(after.matched).toBe(0);
  });
});
