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
  // If true, skip persisting pricing_tier on this fixture so the engine has
  // to lazy-detect via ASSIGNMENT_RULES. The `tier` field above is still the
  // expected detected value (used to pick the test shop).
  lazy_tier_detect?: boolean;
  // If set, write a labor_times row for this service slug. The default
  // overrides (source='vdb', confidence=0.9, data_quality='validation_fixture')
  // can be replaced individually to probe the quality gate.
  real_labor?: {
    service_slug: string;
    book_hours: number;
    source?: string;
    confidence?: number;
    data_quality?: string;
  };
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

  // ── Quality gate fixtures (Q1/Q2/Q3) ─────────────────────────────────────
  // Each writes a labor_times row with a specific quality signature, then
  // expects the engine to either accept it (Q3) or disqualify and fall to
  // tier_estimate (Q1, Q2).
  {
    config_key: "spec_v2_validation_q1_chassis_clone",
    make: "BMW", model: "5 Series", trim: "540i", year: 2022,
    tier: "T2c",
    real_labor: {
      service_slug: "oil_change",
      book_hours: 0.99,                  // distinct from Camry 0.5 — easy to spot if gate fails
      source: "vdb",
      confidence: 0.82,
      data_quality: "chassis_clone",     // DISQUALIFIED
    },
  },
  {
    config_key: "spec_v2_validation_q2_low_confidence",
    make: "BMW", model: "5 Series", trim: "530i", year: 2022,
    tier: "T2c",
    real_labor: {
      service_slug: "oil_change",
      book_hours: 0.88,                  // distinct from Camry 0.5
      source: "vdb",
      confidence: 0.60,                  // DISQUALIFIED (< 0.75)
      data_quality: "enriched",
    },
  },
  {
    config_key: "spec_v2_validation_q3_high_quality_vdb",
    make: "BMW", model: "5 Series", trim: "550i", year: 2022,
    tier: "T2c",
    real_labor: {
      service_slug: "oil_change",
      book_hours: 0.55,                  // ACCEPTED — passes gate
      source: "vdb",
      confidence: 0.92,
      data_quality: "enriched",
    },
  },

  // ── Lazy tier detection (L1) ─────────────────────────────────────────────
  // Vehicle config with pricing_tier=null but model matches ASSIGNMENT_RULES
  // (BMW M5 → T3b). detectTier should resolve it at quote time.
  {
    config_key: "spec_v2_validation_l1_lazy_detect",
    make: "BMW", model: "M5", trim: "Competition", year: 2022,
    tier: "T3b",
    lazy_tier_detect: true,
  },

  // ── Regression: 2024 Alfa Romeo Stelvio brake pads (R1) ──────────────────
  // Field-observed AI enrichment incorrectly priced rear brake pads at
  // $11.87–$25 for this exact vehicle. Yassin bypasses the bad per-engine
  // enrichment row entirely (resolvePartsCost reads ONLY the Camry engine's
  // service_vehicle_specs, then multiplies by tier). Expected at T2c:
  // Camry $55–62 × 2.7 = $148.50–$167.40.
  {
    config_key: "spec_v2_validation_r1_alfa_stelvio",
    make: "Alfa Romeo", model: "Stelvio", trim: "Ti", year: 2024,
    tier: "T2c",
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
  // Assert that quote.labor.hours_source equals this exact string. Used by
  // the quality-gate cases (Q1/Q2 → tier_estimate, Q3 → vdb).
  must_source?: string;
  expect_refuse?: boolean;
};

const EXPECTATIONS: ReadonlyArray<Expected> = [
  // ── Worked Examples (exact match) ────────────────────────────────────────
  {
    example: "A — Camry oil change @ T1 (real labor)",
    vehicle_config_key: CAMRY_FWD_CONFIG_KEY,
    service_slug: "oil_change",
    tier: "T1",
    // Anchor: 0.5hr × $135 + Camry filter-only parts $12–18 × T1 mult 1.0.
    // Engine oil is shop-stock (not billed) — see seedServiceParts (2026-06-09).
    expected_low: 79.5,
    expected_high: 85.5,
  },
  {
    example: "B — BMW 330i (B48) oil @ T2c (real labor, parts multiplier)",
    vehicle_config_key: "spec_v2_validation_bmw_330i",
    service_slug: "oil_change",
    tier: "T2c",
    // 0.5hr × $185 + Camry filter-only $12–18 × T2c mult 2.0.
    expected_low: 116.5,
    expected_high: 128.5,
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
  // NOTE: 2026-06-09 — oil_change reclassified to filter-only (shops supply
  // engine oil from stock). Our customer-facing quote is intentionally
  // BELOW the market_low these fixtures were calibrated against, because
  // competitor shops bill oil while we don't. market_low is dropped on
  // oil_change rows; market_high stays as an upper-bound sanity check.
  {
    example: "Honda Civic oil @ T1 → market top $145 (no floor, oil not billed)",
    vehicle_config_key: "spec_v2_validation_honda_civic",
    service_slug: "oil_change",
    tier: "T1",
    market_high: 145,
  },
  {
    example: "Subaru Outback AWD oil @ T2a → market top $160",
    vehicle_config_key: "spec_v2_validation_subaru_outback",
    service_slug: "oil_change",
    tier: "T2a",
    market_high: 160,
  },
  {
    example: "VW GTI oil @ T2b → market top $199",
    vehicle_config_key: "spec_v2_validation_vw_gti",
    service_slug: "oil_change",
    tier: "T2b",
    market_high: 199,
  },
  {
    example: "BMW 330i oil @ T2c (Layer 5) → market top $196",
    vehicle_config_key: "spec_v2_validation_bmw_330i",
    service_slug: "oil_change",
    tier: "T2c",
    market_high: 196,
  },
  {
    example: "BMW M340i oil @ T3a → NYC indie top $380",
    vehicle_config_key: "spec_v2_validation_bmw_m340i",
    service_slug: "oil_change",
    tier: "T3a",
    market_high: 380,
  },
  {
    example: "Porsche 911 oil @ T3b → NYC dealer top $600",
    vehicle_config_key: "spec_v2_validation_porsche_911",
    service_slug: "oil_change",
    tier: "T3b",
    market_high: 600,
  },
  {
    example: "Ferrari 488 oil @ T4 → dealer top $900",
    vehicle_config_key: "spec_v2_validation_ferrari_488",
    service_slug: "oil_change",
    tier: "T4",
    market_high: 900,
  },
  {
    example: "BMW 330i battery (parts-heavy) @ T2c → dealer $300–435",
    vehicle_config_key: "spec_v2_validation_bmw_330i",
    service_slug: "battery_replacement",
    tier: "T2c",
    market_low: 300, market_high: 435,
  },

  // ── Quality-gate assertions ──────────────────────────────────────────────
  {
    example: "Q1 — chassis_clone vdb disqualified → tier_estimate fires",
    vehicle_config_key: "spec_v2_validation_q1_chassis_clone",
    service_slug: "oil_change",
    tier: "T2c",
    must_source: "tier_estimate",
    must_flag: "tier_estimate",
  },
  {
    example: "Q2 — vdb confidence<0.75 disqualified → tier_estimate fires",
    vehicle_config_key: "spec_v2_validation_q2_low_confidence",
    service_slug: "oil_change",
    tier: "T2c",
    must_source: "tier_estimate",
    must_flag: "tier_estimate",
  },
  {
    example: "Q3 — high-quality vdb accepted (Layer 1)",
    vehicle_config_key: "spec_v2_validation_q3_high_quality_vdb",
    service_slug: "oil_change",
    tier: "T2c",
    must_source: "vdb",
  },

  // ── Lazy tier detection ──────────────────────────────────────────────────
  {
    example: "L1 — BMW M5 with null pricing_tier → detectTier resolves T3b/T4",
    vehicle_config_key: "spec_v2_validation_l1_lazy_detect",
    service_slug: "oil_change",
    tier: "T3b",   // shop tier (run against T3b shop); detection may map M5 → T3b or T4 per rules
    market_low: 1, market_high: 100000,  // accept any successful quote — we only care detection worked
  },

  // ── Field-observed regression: Alfa Stelvio brake pad parts ──────────────
  // Real booking (2026-06-01) shipped with AI-enriched rear brake pads at
  // $11.87–$25 — an order-of-magnitude underprice. Yassin bypasses the bad
  // per-engine enrichment entirely (resolvePartsCost reads the Camry engine
  // row × T2c multiplier = 2.7×, so parts come out at $148.50–$167.40).
  // Combined with Layer 5 labor (Camry 1.4hr × T2c brakes 1.2 = 1.68hr at
  // $185/hr = $310.80), the full quote total lands ~$459–$478.
  //
  // Range gate is intentionally loose: we only care that Yassin lands
  // WELL ABOVE the broken $25 ceiling. AWD trims may push parts +10%
  // (up to $184) and edge labor closer to $326 — both still inside range.
  {
    example: "R1 — 2024 Alfa Stelvio brake pads @ T2c (regression: bypasses bad AI enrichment)",
    vehicle_config_key: "spec_v2_validation_r1_alfa_stelvio",
    service_slug: "brake_pad_replacement",
    tier: "T2c",
    market_low: 300, market_high: 700,
    must_source: "tier_estimate", // confirms Layer 5 fires (no labor_times for this fixture)
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
      const tierPatch = f.lazy_tier_detect
        ? {
            pricing_tier: undefined,
            pricing_tier_source: undefined,
            pricing_tier_set_at: undefined,
          }
        : {
            pricing_tier: f.tier,
            pricing_tier_source: "validation_fixture",
            pricing_tier_set_at: now,
          };
      if (cfg) {
        await ctx.db.patch(cfg._id, {
          year: f.year,
          make_id: makeId,
          model_id: modelId,
          trim_name: f.trim,
          drivetrain: f.drivetrain,
          chassis_code: f.chassis_code,
          ...tierPatch,
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
          ...tierPatch,
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
      const rowSource = f.real_labor.source ?? "vdb";
      const rowConfidence = f.real_labor.confidence ?? 0.9;
      const rowDataQuality = f.real_labor.data_quality ?? "validation_fixture";
      if (existing) {
        await ctx.db.patch(existing._id, {
          book_hours: f.real_labor.book_hours,
          source: rowSource,
          confidence: rowConfidence,
          data_quality: rowDataQuality,
        });
      } else {
        await ctx.db.insert("labor_times", {
          vehicle_config_id: cfgId,
          service_id: svc._id,
          book_hours: f.real_labor.book_hours,
          source: rowSource,
          confidence: rowConfidence,
          data_quality: rowDataQuality,
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
      if (exp.must_source && quote.labor.hours_source !== exp.must_source) {
        pass = false;
        issues.push(
          `expected labor.hours_source='${exp.must_source}', got '${quote.labor.hours_source}'`,
        );
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

    // ── 7. Fixed-price override check ────────────────────────────────────
    // Seed a (shop, service, tier) flat price on a dedicated T1 shop and
    // assert buildQuote short-circuits to that exact dollar amount with the
    // `fixed_price_override` flag set. Also confirms that a sibling tier
    // (T2c, untouched) still produces the dynamic range — i.e. fixed prices
    // are opt-in per cell.
    const FIXED_PRICE_SHOP_SLUG = `${SHOP_SLUG_PREFIX}fixed_price`;
    const FIXED_PRICE_CENTS = 8999; // $89.99
    let fixedShop = await ctx.db
      .query("shops")
      .withIndex("by_slug", (q) => q.eq("slug", FIXED_PRICE_SHOP_SLUG))
      .first();
    if (fixedShop) {
      await ctx.db.patch(fixedShop._id, {
        labor_rate: TIER_RATES.T1,
        labor_rates_by_tier: { T1: TIER_RATES.T1, T2c: TIER_RATES.T2c } as any,
        declined_tiers: [],
        labor_rates_updated_at: now,
      });
    } else {
      const id = await ctx.db.insert("shops", {
        name: "Spec V2 Validation Shop (fixed-price)",
        slug: FIXED_PRICE_SHOP_SLUG,
        labor_rate: TIER_RATES.T1,
        labor_rates_by_tier: { T1: TIER_RATES.T1, T2c: TIER_RATES.T2c } as any,
        declined_tiers: [],
        labor_rates_updated_at: now,
      } as any);
      fixedShop = (await ctx.db.get(id))!;
    }
    const oilSvc = serviceBySlug.get("oil_change");
    if (oilSvc) {
      const existing = await ctx.db
        .query("shop_service_fixed_prices")
        .withIndex("by_shop_service_tier", (q) =>
          q
            .eq("shop_id", fixedShop!._id)
            .eq("service_id", oilSvc._id)
            .eq("tier", "T1"),
        )
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, {
          price_cents: FIXED_PRICE_CENTS,
          updated_at: now,
        });
      } else {
        await ctx.db.insert("shop_service_fixed_prices", {
          shop_id: fixedShop._id,
          service_id: oilSvc._id,
          tier: "T1",
          price_cents: FIXED_PRICE_CENTS,
          updated_at: now,
        });
      }

      const camryId = configIdByKey.get(CAMRY_FWD_CONFIG_KEY)!;
      const overrideQuote = await buildQuote(ctx, {
        vehicle_config_id: camryId,
        service_id: oilSvc._id,
        shop_id: fixedShop._id,
      });
      const expectedPrice = FIXED_PRICE_CENTS / 100;
      const overridePass =
        overrideQuote.ok &&
        Math.abs(overrideQuote.low - expectedPrice) < 0.005 &&
        Math.abs(overrideQuote.high - expectedPrice) < 0.005 &&
        overrideQuote.flags.includes("fixed_price_override") &&
        overrideQuote.labor.hours_source === "fixed_override";
      results.push({
        example: "F1 — fixed-price override on Camry T1 oil → flat $89.99",
        tier: "T1",
        quote: overrideQuote,
        pass: overridePass,
        detail: overridePass
          ? `flat=$${overrideQuote.ok ? overrideQuote.low : "?"} flags=[${overrideQuote.ok ? overrideQuote.flags.join(",") : "refuse"}]`
          : `expected low===high===${expectedPrice} with fixed_price_override flag; got ${JSON.stringify(overrideQuote)}`,
      });

      // Sibling tier sanity: BMW 330i (T2c) on the same shop has no fixed
      // price set for T2c — engine should fall through to the standard
      // multiplier range.
      const bmwId = configIdByKey.get("spec_v2_validation_bmw_330i");
      if (bmwId) {
        const fallbackQuote = await buildQuote(ctx, {
          vehicle_config_id: bmwId,
          service_id: oilSvc._id,
          shop_id: fixedShop._id,
        });
        const fallbackPass =
          fallbackQuote.ok &&
          !fallbackQuote.flags.includes("fixed_price_override") &&
          fallbackQuote.labor.hours_source !== "fixed_override" &&
          fallbackQuote.high > fallbackQuote.low;
        results.push({
          example:
            "F2 — sibling tier (T2c) on same shop falls back to range",
          tier: "T2c",
          quote: fallbackQuote,
          pass: fallbackPass,
          detail: fallbackPass
            ? `range=$${fallbackQuote.ok ? fallbackQuote.low : "?"}-${fallbackQuote.ok ? fallbackQuote.high : "?"}`
            : `expected dynamic range without fixed_price_override; got ${JSON.stringify(fallbackQuote)}`,
        });
      }
    }

    const passed = results.filter((r) => r.pass).length;
    const failed = results.length - passed;

    return {
      summary: `${passed}/${results.length} passed, ${failed} failed`,
      results,
    };
  },
});
