/**
 * validateQuoteEngine.ts — Pricing v2 (spec May 29 2026) Part 4 validation.
 *
 * Reproduces the spec's three worked examples + 8-row cross-tier validation
 * table by running buildQuote() against test fixtures. Not part of prod;
 * run manually after seeding to confirm the engine produces exactly the
 * locked numbers.
 *
 * Test fixtures use config_key prefix "spec_v2_validation_*" and shop slug
 * prefix "spec_v2_validation_shop_*" so they're easy to identify and clean up.
 * Idempotent — re-runs upsert fixtures and recompute quotes.
 *
 * Run:
 *   npx convex run devOnly/validateQuoteEngine:runAll
 */

import { internalMutation } from "../_generated/server";
import { Id } from "../_generated/dataModel";
import { buildQuote, CAMRY_FWD_CONFIG_KEY } from "../lib/quoteEngine";
import { VehicleTier } from "../lib/vehicleTiers";

// Spec Tier ladder — labor rates locked (NYC, Part 1 Tier ladder)
const TIER_RATES: Record<VehicleTier, number> = {
  T1: 135,
  T2a: 145,
  T2b: 170,
  T2c: 185,
  T3a: 205,
  T3b: 265,
  T4: 250, // floor of $250–400+
};

type Fixture = {
  config_key: string;
  make: string;
  model: string;
  trim: string;
  year: number;
  tier: VehicleTier;
  drivetrain?: string;
  chassis_code?: string;
  // If set, write a labor_times row for this service slug so Layer 1 fires.
  real_labor?: { service_slug: string; book_hours: number };
};

const FIXTURES: ReadonlyArray<Fixture> = [
  // Example A — uses the existing Camry FWD seeded by seedCamryBaseline.
  // No fixture needed; we look it up by CAMRY_FWD_CONFIG_KEY.

  // Example B — BMW 330i (B48) @ T2c, real labor 0.5hr for oil
  {
    config_key: "spec_v2_validation_bmw_330i",
    make: "BMW",
    model: "3 Series",
    trim: "330i",
    year: 2022,
    tier: "T2c",
    chassis_code: "G20",
    real_labor: { service_slug: "oil_change", book_hours: 0.5 },
  },

  // Example C — Audi RS6 @ T3a, NO labor data → Layer 5 fires
  {
    config_key: "spec_v2_validation_audi_rs6",
    make: "Audi",
    model: "RS6",
    trim: "Avant",
    year: 2022,
    tier: "T3a",
  },

  // Cross-tier validation (each row hits Layer 5 — no real labor data)
  {
    config_key: "spec_v2_validation_honda_civic",
    make: "Honda", model: "Civic", trim: "EX", year: 2022,
    tier: "T1",
  },
  {
    config_key: "spec_v2_validation_subaru_outback",
    make: "Subaru", model: "Outback", trim: "Premium", year: 2022,
    tier: "T2a", drivetrain: "AWD",
  },
  {
    config_key: "spec_v2_validation_vw_gti",
    make: "Volkswagen", model: "GTI", trim: "S", year: 2022,
    tier: "T2b",
  },
  {
    config_key: "spec_v2_validation_bmw_m340i",
    make: "BMW", model: "M340i", trim: "Base", year: 2022,
    tier: "T3a",
  },
  {
    config_key: "spec_v2_validation_porsche_911",
    make: "Porsche", model: "911 Carrera", trim: "Base", year: 2022,
    tier: "T3b",
  },
  {
    config_key: "spec_v2_validation_ferrari_488",
    make: "Ferrari", model: "F8", trim: "Tributo", year: 2022,
    tier: "T4",
  },
];

type Expected = {
  example: string;
  vehicle_config_key: string;
  service_slug: string;
  tier: VehicleTier;
  // null bounds = skip assertion on that side; range_in_market means we just
  // check that the quote overlaps with the [low, high] given.
  expected_low?: number;
  expected_high?: number;
  market_low?: number;
  market_high?: number;
  must_flag?: string;
  expect_refuse?: boolean;
};

const EXPECTATIONS: ReadonlyArray<Expected> = [
  // ── Worked Examples (exact match) ────────────────────────────────────────
  {
    example: "A — Camry oil change @ T1 (real labor)",
    vehicle_config_key: CAMRY_FWD_CONFIG_KEY,
    service_slug: "oil_change",
    tier: "T1",
    expected_low: 108.5,
    expected_high: 114.5,
  },
  {
    example: "B — BMW 330i (B48) oil @ T2c (real labor, parts multiplier)",
    vehicle_config_key: "spec_v2_validation_bmw_330i",
    service_slug: "oil_change",
    tier: "T2c",
    expected_low: 174.5,
    expected_high: 186.5,
  },
  {
    example: "C — Audi RS6 spark plugs @ T3a (full fallback fires)",
    vehicle_config_key: "spec_v2_validation_audi_rs6",
    service_slug: "spark_plugs",
    tier: "T3a",
    expected_low: 671.5,
    expected_high: 696.5,
    must_flag: "tier_estimate",
  },

  // ── Cross-tier validation table (in-range vs RepairPal market) ───────────
  {
    example: "Honda Civic oil @ T1 → market $118–145",
    vehicle_config_key: "spec_v2_validation_honda_civic",
    service_slug: "oil_change",
    tier: "T1",
    market_low: 118, market_high: 145,
  },
  {
    example: "Subaru Outback AWD oil @ T2a → market ~$110–160",
    vehicle_config_key: "spec_v2_validation_subaru_outback",
    service_slug: "oil_change",
    tier: "T2a",
    market_low: 110, market_high: 160,
  },
  {
    example: "VW GTI oil @ T2b → market $157–199",
    vehicle_config_key: "spec_v2_validation_vw_gti",
    service_slug: "oil_change",
    tier: "T2b",
    market_low: 157, market_high: 199,
  },
  {
    example: "BMW 330i oil @ T2c (Layer 5) → market $163–196",
    vehicle_config_key: "spec_v2_validation_bmw_330i",
    service_slug: "oil_change",
    tier: "T2c",
    // Note: Example B uses real labor (0.5h); Layer 1 fires; same quote.
    market_low: 163, market_high: 196,
  },
  {
    example: "BMW M340i oil @ T3a → market $259–287",
    vehicle_config_key: "spec_v2_validation_bmw_m340i",
    service_slug: "oil_change",
    tier: "T3a",
    market_low: 259, market_high: 287,
  },
  {
    example: "Porsche 911 oil @ T3b → dealer $375–475",
    vehicle_config_key: "spec_v2_validation_porsche_911",
    service_slug: "oil_change",
    tier: "T3b",
    market_low: 375, market_high: 475,
  },
  {
    example: "Ferrari 488 oil @ T4 → dealer $500–900 (floor only)",
    vehicle_config_key: "spec_v2_validation_ferrari_488",
    service_slug: "oil_change",
    tier: "T4",
    market_low: 500, market_high: 900,
  },
  {
    example: "BMW 330i battery (parts-heavy) @ T2c → dealer $300–435",
    vehicle_config_key: "spec_v2_validation_bmw_330i",
    service_slug: "battery_replacement",
    tier: "T2c",
    market_low: 300, market_high: 435,
  },
];

const SHOP_SLUG_PREFIX = "spec_v2_validation_shop_";

export const runAll = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    // ── 1. Ensure makes + models exist for each fixture ──────────────────
    const makeIdByName = new Map<string, Id<"makes">>();
    const modelIdByMakeAndName = new Map<string, Id<"models">>();

    for (const f of FIXTURES) {
      let makeRow = await ctx.db
        .query("makes")
        .withIndex("by_name", (q) => q.eq("name", f.make))
        .first();
      if (!makeRow) {
        const id = await ctx.db.insert("makes", {
          name: f.make,
          created_at: now,
        });
        makeRow = (await ctx.db.get(id))!;
      }
      makeIdByName.set(f.make.toLowerCase(), makeRow._id);

      const modelKey = `${makeRow._id}::${f.model.toLowerCase()}`;
      if (!modelIdByMakeAndName.has(modelKey)) {
        const allModels = await ctx.db.query("models").collect();
        let modelRow = allModels.find(
          (m: any) => m.make_id === makeRow!._id && m.name === f.model,
        );
        if (!modelRow) {
          const id = await ctx.db.insert("models", {
            make_id: makeRow._id,
            name: f.model,
          } as any);
          modelRow = (await ctx.db.get(id))!;
        }
        modelIdByMakeAndName.set(modelKey, modelRow._id);
      }
    }

    // ── 2. Ensure each vehicle_config fixture exists with correct tier ───
    const configIdByKey = new Map<string, Id<"vehicle_configs">>();
    for (const f of FIXTURES) {
      const makeId = makeIdByName.get(f.make.toLowerCase())!;
      const modelId = modelIdByMakeAndName.get(`${makeId}::${f.model.toLowerCase()}`)!;
      let cfg = await ctx.db
        .query("vehicle_configs")
        .withIndex("by_config_key", (q) => q.eq("config_key", f.config_key))
        .first();
      if (cfg) {
        await ctx.db.patch(cfg._id, {
          year: f.year,
          make_id: makeId,
          model_id: modelId,
          trim_name: f.trim,
          drivetrain: f.drivetrain,
          chassis_code: f.chassis_code,
          pricing_tier: f.tier,
          pricing_tier_source: "validation_fixture",
          pricing_tier_set_at: now,
        });
      } else {
        const id = await ctx.db.insert("vehicle_configs", {
          config_key: f.config_key,
          year: f.year,
          make_id: makeId,
          model_id: modelId,
          trim_name: f.trim,
          drivetrain: f.drivetrain,
          chassis_code: f.chassis_code,
          pricing_tier: f.tier,
          pricing_tier_source: "validation_fixture",
          pricing_tier_set_at: now,
          enrichment_status: "validation_fixture",
          created_at: now,
        });
        cfg = (await ctx.db.get(id))!;
      }
      configIdByKey.set(f.config_key, cfg._id);
    }

    // ── 3. Look up Camry baseline ────────────────────────────────────────
    const camry = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_config_key", (q) => q.eq("config_key", CAMRY_FWD_CONFIG_KEY))
      .first();
    if (!camry) {
      return {
        error: "Camry baseline not seeded. Run seeds/seedCamryBaseline:run first.",
      };
    }
    configIdByKey.set(CAMRY_FWD_CONFIG_KEY, camry._id);

    // ── 4. Insert real_labor rows where the fixture defines them ──────────
    const allServices = await ctx.db.query("services").collect();
    const serviceBySlug = new Map<string, any>();
    for (const s of allServices) {
      if (s.slug) serviceBySlug.set(s.slug, s);
    }
    for (const f of FIXTURES) {
      if (!f.real_labor) continue;
      const svc = serviceBySlug.get(f.real_labor.service_slug);
      if (!svc) continue;
      const cfgId = configIdByKey.get(f.config_key)!;
      const existing = await ctx.db
        .query("labor_times")
        .withIndex("by_vehicle_config_and_service", (q) =>
          q.eq("vehicle_config_id", cfgId).eq("service_id", svc._id),
        )
        .first();
      if (existing) {
        await ctx.db.patch(existing._id, {
          book_hours: f.real_labor.book_hours,
          source: "vdb",
          confidence: 0.9,
        });
      } else {
        await ctx.db.insert("labor_times", {
          vehicle_config_id: cfgId,
          service_id: svc._id,
          book_hours: f.real_labor.book_hours,
          source: "vdb",
          confidence: 0.9,
          data_quality: "validation_fixture",
          created_at: now,
        });
      }
    }

    // ── 5. Ensure test shops exist with the spec's locked tier rates ─────
    // One shop per tier, fully rated. Each fixture quote is run against the
    // shop matching its tier.
    const shopIdByTier = new Map<VehicleTier, Id<"shops">>();
    for (const tier of Object.keys(TIER_RATES) as VehicleTier[]) {
      const slug = `${SHOP_SLUG_PREFIX}${tier.toLowerCase()}`;
      let shop = await ctx.db
        .query("shops")
        .withIndex("by_slug", (q) => q.eq("slug", slug))
        .first();
      const labor_rates_by_tier = { [tier]: TIER_RATES[tier] } as any;
      if (shop) {
        await ctx.db.patch(shop._id, {
          labor_rates_by_tier,
          declined_tiers: [],
          labor_rates_updated_at: now,
          labor_rate: TIER_RATES[tier],
        });
      } else {
        const id = await ctx.db.insert("shops", {
          name: `Spec V2 Validation Shop (${tier})`,
          slug,
          labor_rate: TIER_RATES[tier],
          labor_rates_by_tier,
          declined_tiers: [],
          labor_rates_updated_at: now,
        } as any);
        shop = (await ctx.db.get(id))!;
      }
      shopIdByTier.set(tier, shop._id);
    }

    // ── 6. Run each expectation through buildQuote and record result ─────
    const results: Array<{
      example: string;
      tier: VehicleTier;
      quote?: any;
      pass: boolean;
      detail: string;
    }> = [];

    for (const exp of EXPECTATIONS) {
      const cfgId = configIdByKey.get(exp.vehicle_config_key);
      const svc = serviceBySlug.get(exp.service_slug);
      const shopId = shopIdByTier.get(exp.tier);
      if (!cfgId || !svc || !shopId) {
        results.push({
          example: exp.example,
          tier: exp.tier,
          pass: false,
          detail: `missing fixture: config=${cfgId}, service=${svc?._id}, shop=${shopId}`,
        });
        continue;
      }
      const quote = await buildQuote(ctx, {
        vehicle_config_id: cfgId,
        service_id: svc._id,
        shop_id: shopId,
      });

      if (exp.expect_refuse) {
        const pass = quote.ok === false;
        results.push({
          example: exp.example,
          tier: exp.tier,
          quote,
          pass,
          detail: pass ? "refused as expected" : "expected refuse, got quote",
        });
        continue;
      }

      if (quote.ok === false) {
        results.push({
          example: exp.example,
          tier: exp.tier,
          quote,
          pass: false,
          detail: `refused: ${quote.reason}`,
        });
        continue;
      }

      let pass = true;
      const issues: string[] = [];

      if (exp.expected_low != null && Math.abs(quote.low - exp.expected_low) > 0.05) {
        pass = false;
        issues.push(`low=${quote.low} expected=${exp.expected_low}`);
      }
      if (exp.expected_high != null && Math.abs(quote.high - exp.expected_high) > 0.05) {
        pass = false;
        issues.push(`high=${quote.high} expected=${exp.expected_high}`);
      }
      if (exp.market_low != null && quote.high < exp.market_low) {
        pass = false;
        issues.push(`quote high=${quote.high} below market low=${exp.market_low}`);
      }
      if (exp.market_high != null && quote.low > exp.market_high) {
        pass = false;
        issues.push(`quote low=${quote.low} above market high=${exp.market_high}`);
      }
      if (exp.must_flag && !quote.flags.includes(exp.must_flag)) {
        pass = false;
        issues.push(`missing flag '${exp.must_flag}', got [${quote.flags.join(",")}]`);
      }

      results.push({
        example: exp.example,
        tier: exp.tier,
        quote,
        pass,
        detail: pass
          ? `quote=$${quote.low}-${quote.high} flags=[${quote.flags.join(",")}]`
          : issues.join("; "),
      });
    }

    const passed = results.filter((r) => r.pass).length;
    const failed = results.length - passed;

    return {
      summary: `${passed}/${results.length} passed, ${failed} failed`,
      results,
    };
  },
});
