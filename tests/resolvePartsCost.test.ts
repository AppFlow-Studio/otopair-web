import { describe, it, expect, afterEach } from "vitest";
import { makeT } from "./helpers";
import { resolvePartsCost, buildQuote } from "../convex/lib/quoteEngine";
import { REPAIRPAL_ENDPOINT_PRICE_TYPE } from "../convex/lib/priceTypes";
import { CAMRY_FWD_CONFIG_KEY } from "../convex/lib/laborFallback";

afterEach(() => {
  delete process.env.PARTS_SOURCE_REAL_PRIMARY;
});

/** Seed a spark_plugs config: 1 core fitment (spark_plug, 6 cyl), SKU prices,
 *  + optional endpoint per-unit point. Returns ids. */
async function seedSparkPlugs(
  t: ReturnType<typeof makeT>,
  opts: { sku: number[]; endpoint?: number },
) {
  return await t.run(async (ctx: any) => {
    const makeId = await ctx.db.insert("makes", { name: "Toyota" });
    const modelId = await ctx.db.insert("models", { make_id: makeId, name: "Camry" });
    const partId = await ctx.db.insert("oem_parts", {
      oem_part_number: "SP",
      name: "Spark Plug",
      subcategory: "spark_plug",
    });
    const engineId = await ctx.db.insert("engines", {
      cylinders: 6,
      spark_plug_quantity: 6,
    });
    const configId = await ctx.db.insert("vehicle_configs", {
      config_key: "sp_cfg",
      year: 2021,
      make_id: makeId,
      model_id: modelId,
      engine_id: engineId,
      pricing_tier: "T2a",
    });
    const serviceId = await ctx.db.insert("services", {
      name: "Spark Plugs",
      slug: "spark_plugs",
      parts_kind: "per_cylinder",
    });
    await ctx.db.insert("part_fitments", {
      part_id: partId,
      vehicle_config_id: configId,
      service_type: "spark_plugs",
      quantity_needed: 6,
      service_role: "core",
    });
    for (const price of opts.sku) {
      await ctx.db.insert("part_prices", {
        part_id: partId,
        price,
        price_type: "sale",
        source_domain: "rockauto.com",
      });
    }
    if (opts.endpoint != null) {
      await ctx.db.insert("part_prices", {
        part_id: partId,
        price: opts.endpoint,
        price_type: REPAIRPAL_ENDPOINT_PRICE_TYPE,
        source_domain: "repairpal_endpoint",
      });
    }
    return { configId, serviceId };
  });
}

describe("resolvePartsCost — real band primary (gated)", () => {
  it("flag OFF: ignores real data (no real_parts source)", async () => {
    const t = makeT();
    const { configId, serviceId } = await seedSparkPlugs(t, { sku: [8, 10] });
    const res: any = await t.run((ctx: any) =>
      resolvePartsCost(ctx, {
        vehicle_config_id: configId,
        service_id: serviceId,
        vehicle_tier: "T2a",
      }),
    );
    expect(res.source).not.toBe("real_parts");
    // Flag-off byte-identical contract: the real-primary fallback tag is never added.
    expect(res.flags ?? []).not.toContain("parts_fallback_multiplier");
  });

  it("flag ON: pools the SKU prices WITH the endpoint point × quantity as real_parts", async () => {
    process.env.PARTS_SOURCE_REAL_PRIMARY = "on";
    const t = makeT();
    const { configId, serviceId } = await seedSparkPlugs(t, {
      sku: [8, 10],
      endpoint: 12,
    });
    const res: any = await t.run((ctx: any) =>
      resolvePartsCost(ctx, {
        vehicle_config_id: configId,
        service_id: serviceId,
        vehicle_tier: "T2a",
      }),
    );
    // pooled [8,10,12] × 6 → low=8×6=48, high=12×6=72
    expect(res).toMatchObject({ ok: true, source: "real_parts", low: 48, high: 72 });
  });

  it("flag ON, no SKU: falls back to the endpoint per-unit point × quantity", async () => {
    process.env.PARTS_SOURCE_REAL_PRIMARY = "on";
    const t = makeT();
    const { configId, serviceId } = await seedSparkPlugs(t, { sku: [], endpoint: 9 });
    const res: any = await t.run((ctx: any) =>
      resolvePartsCost(ctx, {
        vehicle_config_id: configId,
        service_id: serviceId,
        vehicle_tier: "T2a",
      }),
    );
    // endpoint only: 9×6 = 54
    expect(res).toMatchObject({ ok: true, source: "real_parts", low: 54, high: 54 });
  });

  it("flag ON, no real evidence: multiplier fallback with parts_fallback_multiplier flag", async () => {
    process.env.PARTS_SOURCE_REAL_PRIMARY = "on";
    const t = makeT();

    // getCamryFwdConfig looks up vehicle_configs by
    // config_key === "2020_toyota_camry_le_fwd_a25a-fks" (CAMRY_FWD_CONFIG_KEY)
    // and requires camry.engine_id to be set. resolvePartsCost then queries
    // service_vehicle_specs by_engine_and_service (camry.engine_id, service_id).
    const { configId, serviceId } = await t.run(async (ctx: any) => {
      // Shared make+model for all vehicle_configs rows
      const makeId = await ctx.db.insert("makes", { name: "Toyota" });
      const modelId = await ctx.db.insert("models", { make_id: makeId, name: "Camry" });

      // Camry engine (A25A-FKS, 4-cyl inline) — the anchor engine
      const camryEngineId = await ctx.db.insert("engines", {
        cylinders: 4,
        spark_plug_quantity: 4,
      });

      // The Camry FWD anchor config — getCamryFwdConfig returns this row
      const camryConfigId = await ctx.db.insert("vehicle_configs", {
        config_key: CAMRY_FWD_CONFIG_KEY,
        year: 2020,
        make_id: makeId,
        model_id: modelId,
        engine_id: camryEngineId,
        pricing_tier: "T1",
      });

      // Parts category for "ignition" (spark plugs/plugs service)
      const partsCatId = await ctx.db.insert("pricing_parts_categories", {
        code: "ignition",
        name: "Ignition",
        display_order: 1,
      });

      // The service — has a parts_multiplier_category_id so multiplier path runs
      const serviceId = await ctx.db.insert("services", {
        name: "Spark Plugs",
        slug: "spark_plugs",
        parts_kind: "per_cylinder",
        parts_multiplier_category_id: partsCatId,
      });

      // Camry baseline parts cost — looked up by (camryEngineId, serviceId)
      // parts_cost_low/high are the anchor values; multiplier scales them
      await ctx.db.insert("service_vehicle_specs", {
        engine_id: camryEngineId,
        service_id: serviceId,
        parts_cost_low: 50,
        parts_cost_high: 56,
      });

      // Parts multiplier for tier T2a
      await ctx.db.insert("pricing_parts_multipliers", {
        parts_category_id: partsCatId,
        tier: "T2a",
        multiplier: 1.2,
        source: "spec_v2_locked",
        updated_at: Date.now(),
      });

      // Test vehicle engine (6-cyl) — the config under test
      const testEngineId = await ctx.db.insert("engines", {
        cylinders: 6,
        spark_plug_quantity: 6,
      });

      // Test vehicle config (tier T2a)
      const configId = await ctx.db.insert("vehicle_configs", {
        config_key: "test_spark_plugs_no_prices",
        year: 2021,
        make_id: makeId,
        model_id: modelId,
        engine_id: testEngineId,
        pricing_tier: "T2a",
      });

      // A core fitment with NO part_prices → real band unreliable → falls through
      const partId = await ctx.db.insert("oem_parts", {
        oem_part_number: "SP6",
        name: "Spark Plug",
        subcategory: "spark_plug",
      });
      await ctx.db.insert("part_fitments", {
        part_id: partId,
        vehicle_config_id: configId,
        service_type: "spark_plugs",
        quantity_needed: 6,
        service_role: "core",
      });
      // Intentionally NO part_prices rows for partId

      return { configId, serviceId, camryConfigId };
    });

    const res: any = await t.run((ctx: any) =>
      resolvePartsCost(ctx, {
        vehicle_config_id: configId,
        service_id: serviceId,
        vehicle_tier: "T2a",
      }),
    );

    expect(res.ok).toBe(true);
    expect(String(res.source)).toContain("multiplier");
    expect(res.flags).toContain("parts_fallback_multiplier");
  });

  it("flag ON: a core-eligible fitment whose catalog part is missing forces fallback (no silent drop)", async () => {
    process.env.PARTS_SOURCE_REAL_PRIMARY = "on";
    const t = makeT();
    // One priced core spark_plug role — on its own this yields a real_parts band.
    const { configId, serviceId } = await seedSparkPlugs(t, { sku: [8, 10] });
    // Add a SECOND, unclassifiable fitment: its catalog part is deleted and it
    // carries no service_role. The OLD code silently skipped it (band stayed
    // reliable → under-pricing); it must now block the band → fallback.
    await t.run(async (ctx: any) => {
      const ghostPartId = await ctx.db.insert("oem_parts", {
        oem_part_number: "GHOST",
        name: "Ghost",
        subcategory: "ignition_coil",
      });
      await ctx.db.delete(ghostPartId);
      await ctx.db.insert("part_fitments", {
        part_id: ghostPartId,
        vehicle_config_id: configId,
        service_type: "spark_plugs",
        quantity_needed: 6,
      });
    });
    const res: any = await t.run((ctx: any) =>
      resolvePartsCost(ctx, {
        vehicle_config_id: configId,
        service_id: serviceId,
        vehicle_tier: "T2a",
      }),
    );
    expect(res.source).not.toBe("real_parts");
  });
});

describe("resolvePartsCost — forceRealPrimary override", () => {
  it("forceRealPrimary:true computes the real band even when the env flag is OFF", async () => {
    // env intentionally NOT set
    const t = makeT();
    const { configId, serviceId } = await seedSparkPlugs(t, { sku: [8, 10], endpoint: 12 });
    const res: any = await t.run((ctx: any) =>
      resolvePartsCost(ctx, { vehicle_config_id: configId, service_id: serviceId, vehicle_tier: "T2a" }, { forceRealPrimary: true }));
    expect(res).toMatchObject({ ok: true, source: "real_parts", low: 48, high: 72 });
  });
  it("forceRealPrimary:false ignores the real band even when the env flag is ON", async () => {
    process.env.PARTS_SOURCE_REAL_PRIMARY = "on";
    const t = makeT();
    const { configId, serviceId } = await seedSparkPlugs(t, { sku: [8, 10], endpoint: 12 });
    const res: any = await t.run((ctx: any) =>
      resolvePartsCost(ctx, { vehicle_config_id: configId, service_id: serviceId, vehicle_tier: "T2a" }, { forceRealPrimary: false }));
    expect(res.source).not.toBe("real_parts");
  });
});

describe("buildQuote — real_parts band is not re-scaled by unit count", () => {
  it("uses the per-config band as-is (no unitScale double-count)", async () => {
    process.env.PARTS_SOURCE_REAL_PRIMARY = "on";
    const t = makeT();

    // seedSparkPlugs: 6-cyl config, sku=[8,10], endpoint=12
    // → resolvePartsCost pools [8,10,12] × 6 → low=48, high=72 (already per-config total)
    const { configId, serviceId } = await seedSparkPlugs(t, {
      sku: [8, 10],
      endpoint: 12,
    });

    // Seed a shop with a per-tier labor rate for T2a (the config's pricing_tier).
    // resolveLaborRate reads shop.labor_rates_by_tier[tier].
    const shopId = await t.run(async (ctx: any) => {
      const ownerId = await ctx.db.insert("users", {
        clerkUserId: "clerk_bq_test_owner",
        email: "bqowner@test.local",
        first_name: "Owner",
        role: "shop_owner",
        createdAt: Date.now(),
      });
      return ctx.db.insert("shops", {
        name: "Test Shop",
        owner_user_id: ownerId,
        is_active: true,
        timezone: "America/New_York",
        no_show_threshold_minutes: 30,
        overrun_default_extension_percent: 25,
        overrun_extension_floor_minutes: 5,
        max_bookings_per_mechanic_rolling_hour: 2,
        entity_label_mode: "mechanic",
        labor_rates_by_tier: { T2a: 100 },
      });
    });

    // Seed a labor_times row with empirical data (Layer 1 empirical — bypasses
    // computeTierFloor entirely, no Camry anchor needed).
    // empirical_sample_size >= LABOR_EMPIRICAL_QUOTE_MIN_SAMPLES (5) is required.
    await t.run(async (ctx: any) => {
      await ctx.db.insert("labor_times", {
        vehicle_config_id: configId,
        service_id: serviceId,
        empirical_hours: 1.0,
        empirical_sample_size: 5,
        source: "empirical",
        confidence: 0.9,
      });
    });

    const quote: any = await t.run((ctx: any) =>
      buildQuote(ctx, {
        vehicle_config_id: configId,
        service_id: serviceId,
        shop_id: shopId,
      }),
    );

    expect(quote.ok).toBe(true);
    // real_parts band [48,72] must NOT be re-scaled by unitScale(6/1)=6.
    // Before fix: parts.low = 48 * 6 = 288 (double-count bug).
    // After fix:  parts.low = 48 (the pre-totaled per-config band).
    expect(quote.parts.low).toBe(48);
    expect(quote.parts.high).toBe(72);
    // real_parts band is pre-totaled → unit_label is null (not "axle"), and the
    // count metadata is the bypass sentinel 1/1.
    expect(quote.parts.unit_label).toBeNull();
    expect(quote.parts.unit_count).toBe(1);
  });
});
