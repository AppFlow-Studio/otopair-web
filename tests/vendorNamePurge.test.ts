/**
 * tests/vendorNamePurge.test.ts — covers the dual-read window and the one-shot
 * migration that renames the estimator provider's persisted values.
 *
 * The risk this guards: a deployment that has deployed the renamed CODE but has
 * not yet run the MIGRATION must behave identically to a fully-migrated one.
 * Every assertion below writes ONLY legacy values and expects current-name
 * behaviour out the other side.
 */
import { describe, it, expect } from "vitest";
import { makeT } from "./helpers";
import { internal } from "../convex/_generated/api";
import {
  ESTIMATOR_ENDPOINT_SOURCE,
  ESTIMATOR_BOOK_SOURCE,
  ESTIMATOR_LABOR_SOURCE,
  canonicalizeSourceName,
  isEstimatorEndpointSource,
  isEstimatorBookSource,
  isEstimatorRetiredSource,
} from "../convex/lib/sourceNames";
import { STRONG_LABOR_SOURCES } from "../convex/lib/laborBands";
import { resolveBookHours } from "../convex/lib/labor_aggregation";
import { isNonPooledPriceType } from "../convex/lib/priceTypes";
import {
  listEstimates,
  listEstimatesByConfig,
  collectEstimates,
  findEstimate,
} from "../convex/lib/estimatorEstimates";

const LEGACY_ENDPOINT = "repairpal_endpoint";
const LEGACY_BOOK = "repairpal_motor";
const LEGACY_LABOR = "repairpal_labor";

describe("source-name vocabulary", () => {
  it("canonicalizes every legacy value and passes others through", () => {
    expect(canonicalizeSourceName(LEGACY_ENDPOINT)).toBe(ESTIMATOR_ENDPOINT_SOURCE);
    expect(canonicalizeSourceName(LEGACY_BOOK)).toBe(ESTIMATOR_BOOK_SOURCE);
    expect(canonicalizeSourceName(LEGACY_LABOR)).toBe(ESTIMATOR_LABOR_SOURCE);
    // Unrelated sources must survive untouched — the migration applies this
    // blanket-wise, so a greedy rewrite here would corrupt other sources.
    expect(canonicalizeSourceName("olp_labor")).toBe("olp_labor");
    expect(canonicalizeSourceName("vdb_repair_estimates")).toBe("vdb_repair_estimates");
  });

  it("recognizes legacy AND current names", () => {
    expect(isEstimatorEndpointSource(LEGACY_ENDPOINT)).toBe(true);
    expect(isEstimatorEndpointSource(ESTIMATOR_ENDPOINT_SOURCE)).toBe(true);
    expect(isEstimatorEndpointSource("olp_labor")).toBe(false);
    expect(isEstimatorEndpointSource(null)).toBe(false);

    expect(isEstimatorBookSource(LEGACY_BOOK)).toBe(true);
    expect(isEstimatorBookSource(ESTIMATOR_BOOK_SOURCE)).toBe(true);

    expect(isEstimatorRetiredSource(LEGACY_BOOK)).toBe(true);
    expect(isEstimatorRetiredSource(LEGACY_LABOR)).toBe(true);
    expect(isEstimatorRetiredSource(ESTIMATOR_ENDPOINT_SOURCE)).toBe(false);
  });
});

describe("dual-read: labor precedence is unchanged pre-migration", () => {
  it("a LEGACY-named endpoint observation still drives book_hours outright", () => {
    // 2.4h endpoint value must win over a cluster of agreeing weaker sources.
    const hours = resolveBookHours([
      { hours: 2.4, weight: 0.9, source: LEGACY_ENDPOINT },
      { hours: 1.1, weight: 0.7, source: "olp_labor" },
      { hours: 1.0, weight: 0.5, source: "llm_web" },
    ]);
    expect(hours).toBe(2.4);
  });

  it("current-named endpoint observation behaves identically", () => {
    const hours = resolveBookHours([
      { hours: 2.4, weight: 0.9, source: ESTIMATOR_ENDPOINT_SOURCE },
      { hours: 1.1, weight: 0.7, source: "olp_labor" },
      { hours: 1.0, weight: 0.5, source: "llm_web" },
    ]);
    expect(hours).toBe(2.4);
  });

  it("classifies the legacy endpoint source as STRONG", () => {
    // If this regressed, un-migrated rows would silently lose anchor status and
    // drag every confidence score down a tier.
    expect(STRONG_LABOR_SOURCES.has(LEGACY_ENDPOINT)).toBe(true);
    expect(STRONG_LABOR_SOURCES.has(ESTIMATOR_ENDPOINT_SOURCE)).toBe(true);
    expect(STRONG_LABOR_SOURCES.has(LEGACY_BOOK)).toBe(false);
  });

  it("holds the legacy price_type out of the pooled SKU aggregate", () => {
    expect(isNonPooledPriceType(LEGACY_ENDPOINT)).toBe(true);
    expect(isNonPooledPriceType(ESTIMATOR_ENDPOINT_SOURCE)).toBe(true);
    expect(isNonPooledPriceType("sale")).toBe(false);
  });
});

/** Insert one estimate row into either table, with the ids it needs. */
async function seedEstimate(
  ctx: any,
  table: "estimator_estimates" | "repairpal_endpoint_estimates",
  opts: { configId: any; serviceId: any; minutes: number },
) {
  return ctx.db.insert(table, {
    vehicle_config_id: opts.configId,
    service_id: opts.serviceId,
    base_vehicle_id: 78290,
    labor_minutes: opts.minutes,
    labor_hours: opts.minutes / 60,
    fetched_at: 1,
  } as any);
}

async function seedIds(ctx: any, key: string) {
  const makeId = await ctx.db.insert("makes", { name: "Honda" });
  const modelId = await ctx.db.insert("models", { make_id: makeId, name: "Civic" });
  const configId = await ctx.db.insert("vehicle_configs", {
    config_key: key, year: 2021, make_id: makeId, model_id: modelId,
  } as any);
  const serviceId = await ctx.db.insert("services", {
    name: "Oil Change", slug: "oil_change",
  } as any);
  return { configId, serviceId };
}

describe("dual-read: the estimate table union", () => {
  it("surfaces rows that still live only in the legacy table", async () => {
    const t = makeT();
    const { rows, byConfig, all } = await t.run(async (ctx) => {
      const { configId, serviceId } = await seedIds(ctx, "legacy_only");
      await seedEstimate(ctx, "repairpal_endpoint_estimates", { configId, serviceId, minutes: 42 });
      return {
        rows: await listEstimates(ctx, 100),
        byConfig: await listEstimatesByConfig(ctx, configId),
        all: await collectEstimates(ctx),
      };
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].labor_minutes).toBe(42);
    expect(byConfig).toHaveLength(1);
    expect(all).toHaveLength(1);
  });

  it("de-duplicates a copied row, preferring the current table", async () => {
    const t = makeT();
    const rows = await t.run(async (ctx) => {
      const { configId, serviceId } = await seedIds(ctx, "both_tables");
      // Same (config, service) in both tables — the migrated copy plus a fresher
      // re-fetch. Must count ONCE, and the current table's value must win.
      await seedEstimate(ctx, "repairpal_endpoint_estimates", { configId, serviceId, minutes: 42 });
      await seedEstimate(ctx, "estimator_estimates", { configId, serviceId, minutes: 55 });
      return collectEstimates(ctx);
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].labor_minutes).toBe(55);
  });

  it("findEstimate prefers the current table but falls back to legacy", async () => {
    const t = makeT();
    const { migrated, unmigrated } = await t.run(async (ctx) => {
      const a = await seedIds(ctx, "cfg_migrated");
      await seedEstimate(ctx, "estimator_estimates", { ...a, configId: a.configId, serviceId: a.serviceId, minutes: 10 });
      const b = await seedIds(ctx, "cfg_unmigrated");
      await seedEstimate(ctx, "repairpal_endpoint_estimates", { ...b, configId: b.configId, serviceId: b.serviceId, minutes: 20 });
      return {
        migrated: await findEstimate(ctx, a.configId, a.serviceId),
        unmigrated: await findEstimate(ctx, b.configId, b.serviceId),
      };
    });
    expect(migrated?.labor_minutes).toBe(10);
    expect(unmigrated?.labor_minutes).toBe(20);
  });
});

describe("purgeVendorNames migration", () => {
  it("copies legacy estimates and is idempotent on re-run", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const { configId, serviceId } = await seedIds(ctx, "to_migrate");
      await seedEstimate(ctx, "repairpal_endpoint_estimates", { configId, serviceId, minutes: 42 });
    });

    const first = await t.mutation(internal.migrations.purgeVendorNames.migrateEstimates, {});
    expect(first).toEqual({ migrated: 1, remaining: 0 });

    // Re-running must not duplicate the row.
    const second = await t.mutation(internal.migrations.purgeVendorNames.migrateEstimates, {});
    expect(second).toEqual({ migrated: 0, remaining: 0 });

    const copied = await t.run((ctx) => ctx.db.query("estimator_estimates").collect());
    expect(copied).toHaveLength(1);
    expect(copied[0].labor_minutes).toBe(42);
  });

  it("rewrites every legacy observation source and leaves others alone", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const { configId, serviceId } = await seedIds(ctx, "obs");
      const base = { vehicle_config_id: configId, service_id: serviceId, tier: "catalog", observed_at: 1 };
      await ctx.db.insert("labor_observations", { ...base, hours: 2.4, weight: 0.9, source: LEGACY_ENDPOINT } as any);
      await ctx.db.insert("labor_observations", { ...base, hours: 1.0, weight: 0.4, source: LEGACY_BOOK } as any);
      await ctx.db.insert("labor_observations", { ...base, hours: 1.2, weight: 0.4, source: LEGACY_LABOR } as any);
      await ctx.db.insert("labor_observations", { ...base, hours: 1.1, weight: 0.7, source: "olp_labor" } as any);
    });

    const res = await t.mutation(internal.migrations.purgeVendorNames.migrateObservations, {});
    expect(res).toEqual({ migrated: 3, remaining: 0 });

    const sources = (await t.run((ctx) => ctx.db.query("labor_observations").collect()))
      .map((o) => o.source)
      .sort();
    expect(sources).toEqual([
      ESTIMATOR_BOOK_SOURCE,
      ESTIMATOR_ENDPOINT_SOURCE,
      ESTIMATOR_LABOR_SOURCE,
      "olp_labor",
    ].sort());
  });

  it("rewrites part_prices values and strips the provider host from source_url", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const partId = await ctx.db.insert("oem_parts", {
        oem_part_number: "P1", name: "Spark Plug", subcategory: "spark_plug",
      } as any);
      await ctx.db.insert("part_prices", {
        part_id: partId, price: 12, price_type: LEGACY_ENDPOINT,
        source_domain: LEGACY_ENDPOINT, source_url: "https://repairpal.com/estimator",
        refreshed_at: 1,
      } as any);
      // An unrelated row must be untouched.
      await ctx.db.insert("part_prices", {
        part_id: partId, price: 9, price_type: "sale",
        source_domain: "rockauto.com", source_url: "https://rockauto.com/x", refreshed_at: 1,
      } as any);
    });

    const res = await t.mutation(internal.migrations.purgeVendorNames.migratePartPrices, {});
    expect(res).toEqual({ migrated: 1, remaining: 0 });

    const rows = await t.run((ctx) => ctx.db.query("part_prices").collect());
    const migrated = rows.find((r) => r.price === 12)!;
    const untouched = rows.find((r) => r.price === 9)!;

    expect(migrated.price_type).toBe(ESTIMATOR_ENDPOINT_SOURCE);
    expect(migrated.source_domain).toBe(ESTIMATOR_ENDPOINT_SOURCE);
    expect(migrated.source_url).not.toMatch(/repairpal/i);
    expect(untouched.price_type).toBe("sale");
    expect(untouched.source_url).toBe("https://rockauto.com/x");
  });

  it("copies the service slug without clobbering an existing new-name value", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      await ctx.db.insert("services", {
        name: "Oil Change", slug: "oil_change", repairpal_slug: "oil-change",
      } as any);
      // Already migrated — must NOT be overwritten.
      await ctx.db.insert("services", {
        name: "Spark Plugs", slug: "spark_plugs",
        repairpal_slug: "stale-value", estimator_slug: "spark-plug-replacement",
      } as any);
    });

    const res = await t.mutation(internal.migrations.purgeVendorNames.migrateServiceSlugs, {});
    expect(res).toEqual({ migrated: 1, remaining: 0 });

    const services = await t.run((ctx) => ctx.db.query("services").collect());
    const oil = services.find((s: any) => s.slug === "oil_change")! as any;
    const plugs = services.find((s: any) => s.slug === "spark_plugs")! as any;
    expect(oil.estimator_slug).toBe("oil-change");
    expect(plugs.estimator_slug).toBe("spark-plug-replacement");
  });

  it("status reports clean only once every step has drained", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const { configId, serviceId } = await seedIds(ctx, "status_check");
      await ctx.db.insert("labor_observations", {
        vehicle_config_id: configId, service_id: serviceId,
        hours: 2.4, weight: 0.9, source: LEGACY_ENDPOINT, tier: "catalog", observed_at: 1,
      } as any);
    });

    const before = await t.query(internal.migrations.purgeVendorNames.status, {});
    expect(before.clean).toBe(false);
    expect(before.observations.remaining).toBe(1);
    expect(before.observations.bySource[LEGACY_ENDPOINT]).toBe(1);

    await t.mutation(internal.migrations.purgeVendorNames.migrateObservations, {});

    const after = await t.query(internal.migrations.purgeVendorNames.status, {});
    expect(after.clean).toBe(true);
    expect(after.observations.remaining).toBe(0);
  });

  it("refuses the destructive cleanup without explicit confirmation", async () => {
    const t = makeT();
    await expect(
      t.mutation(internal.migrations.purgeVendorNames.deleteLegacyEstimates, { confirm: false }),
    ).rejects.toThrow(/destructive/i);
  });

  it("deletes only legacy rows that have a confirmed twin", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const a = await seedIds(ctx, "has_twin");
      await seedEstimate(ctx, "repairpal_endpoint_estimates", { ...a, minutes: 42 });
      await seedEstimate(ctx, "estimator_estimates", { ...a, minutes: 42 });
      const b = await seedIds(ctx, "orphan");
      await seedEstimate(ctx, "repairpal_endpoint_estimates", { ...b, minutes: 99 });
    });

    const res = await t.mutation(internal.migrations.purgeVendorNames.deleteLegacyEstimates, {
      confirm: true,
    });
    expect(res.deleted).toBe(1);
    expect(res.orphans).toBe(1);

    // The un-copied row must survive — deleting it would lose data outright.
    const left = await t.run((ctx) => ctx.db.query("repairpal_endpoint_estimates").collect());
    expect(left).toHaveLength(1);
    expect(left[0].labor_minutes).toBe(99);
  });
});
