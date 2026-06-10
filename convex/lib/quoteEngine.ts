/**
 * quoteEngine.ts — Pricing v2 (spec May 29 2026) quote-engine resolvers.
 *
 * Three resolvers + the top-level buildQuote, all read-only. Designed to run
 * inside a Convex query (reactive). The Layer-5 write-back cache from the
 * spec is deferred — Layer 5 recomputes each call (single multiplier lookup,
 * negligible cost; ensures highest-confidence-wins without ordering subtleties).
 *
 * Formula (locked):
 *   final_quote_low  = labor_hours × shop.rate_for_tier + oem_parts_low  × parts_mult
 *   final_quote_high = labor_hours × shop.rate_for_tier + oem_parts_high × parts_mult
 *   parts_low  = anchor × 0.94   parts_high = anchor × 1.06   (built into the seed)
 */

import { Doc, Id } from "../_generated/dataModel";
import { QueryCtx } from "../_generated/server";
import { resolveLaborRate, VehicleTier } from "./vehicleTiers";
import { ASSIGNMENT_RULES, matchRule } from "../seeds/seedPricing";
import { resolveServiceUnitCount, unitScale } from "./serviceUnits";

// Anchor — the 2020 Camry LE FWD vehicle_config (seeded by seedCamryBaseline).
export const CAMRY_FWD_CONFIG_KEY = "2020_toyota_camry_le_fwd_a25a-fks";

// ─── vdb quality gate ───────────────────────────────────────────────────────
// Lived experience: vdb-seeded labor_times "wrong often" — chassis/engine
// clones and training-data fallbacks pollute Layer 1 ahead of the more
// accurate Yassin tier_estimate (Camry-anchored). Disqualify them.

const DISQUALIFIED_DATA_QUALITY: ReadonlySet<string> = new Set([
  "chassis_clone",
  "engine_clone",
  "training_data",
  "default_fallback",
]);
// Legacy rows (pre-aggregation pipeline) wrote their junk label into `source`
// with data_quality UNSET — e.g. source='training_data' confidence=0.75 — so a
// data_quality-only gate let LLM guesses through as "vdb". Mirror the set on
// source. Plain 'vdb' stays eligible (its bad rows carry clone stamps).
const DISQUALIFIED_SOURCE: ReadonlySet<string> = new Set([
  "training_data",
  "web_search",
  "chassis_clone",
  "engine_clone",
  "default_fallback",
]);
const MIN_VDB_CONFIDENCE = 0.75;
const MIN_EMPIRICAL_SAMPLES = 5;

/**
 * Drivetrains with a separately serviceable differential: AWD/4WD (front +
 * rear + transfer case) and RWD (rear diff). FWD transaxles integrate the
 * final drive into the gearbox; unknown returns false (fail-safe).
 */
export function hasServiceableDifferential(
  drivetrain: string | null | undefined,
): boolean {
  const d = (drivetrain ?? "").toUpperCase();
  return d === "AWD" || d === "4WD" || d === "RWD" || d === "4X4";
}

// Exported: laborTimes.ts (the booking-time UI resolver) applies the SAME
// gate so the UI and the quote engine never tell different labor stories
// (Jun-9 review: "the two labor resolvers disagree").
export function isHighQualityVdb(row: Doc<"labor_times">): boolean {
  if (row.book_hours == null || row.book_hours <= 0) return false;
  if (row.source === "tier_estimate") return false;
  if (DISQUALIFIED_SOURCE.has(row.source ?? "")) return false;
  if (DISQUALIFIED_DATA_QUALITY.has(row.data_quality ?? "")) return false;
  if ((row.confidence ?? 0) < MIN_VDB_CONFIDENCE) return false;
  return true;
}

// ─── resolveLaborHours — 6-layer fallback per spec Part 3 ─────────────────

export type LaborHoursSource =
  | "vdb"
  | "aggregated"
  | "vdb_camry_baseline"
  | "empirical"
  | "sibling"
  | "engine_family"
  | "tier_estimate";

export type LaborHoursResult =
  | {
      ok: true;
      hours: number;
      source: LaborHoursSource;
      confidence: number;
      /** Raw hours from layers 1-3 before the tier-floor adjustment. Equal
       *  to `hours` when neither floor nor above-flag applied. */
      raw_hours?: number;
      /** True when a real layer (vdb/empirical/sibling) returned hours below
       *  the Camry × tier multiplier floor and we substituted the floor. */
      tier_floor_applied?: boolean;
      /** True when a real layer returned hours strictly above the Camry ×
       *  tier multiplier floor — informational only, no substitution. */
      above_tier_floor?: boolean;
    }
  | { ok: false; reason: string };

type RawLaborResult = {
  hours: number;
  source: Exclude<LaborHoursSource, "tier_estimate" | "engine_family">;
  confidence: number;
};

/** Resolve direct VDB, empirical, and sibling-chassis labor in priority order.
 *  Returns null when all real layers refuse — caller falls back to the tier
 *  floor (Layer 5) or refuses. */
async function resolveRawLaborLayers(
  ctx: QueryCtx,
  args: {
    vehicle_config_id: Id<"vehicle_configs">;
    service_id: Id<"services">;
  },
): Promise<RawLaborResult | null> {
  // Layer 1: direct labor_times row, real flat-rate data (not tier_estimate)
  const direct = await ctx.db
    .query("labor_times")
    .withIndex("by_vehicle_config_and_service", (q) =>
      q
        .eq("vehicle_config_id", args.vehicle_config_id)
        .eq("service_id", args.service_id),
    )
    .collect();

  for (const row of direct) {
    if (row.source === "vdb_camry_baseline" && row.book_hours != null && row.book_hours > 0) {
      return {
        hours: row.book_hours,
        source: "vdb_camry_baseline",
        confidence: row.confidence ?? 0.9,
      };
    }
    if (isHighQualityVdb(row)) {
      return {
        hours: row.book_hours!,
        // Report real provenance: RepairPal/MOTOR-driven medians are stamped
        // source='aggregated' by labor_aggregation — don't relabel them "vdb".
        source: row.source === "aggregated" ? "aggregated" : "vdb",
        confidence: row.confidence ?? 0.9,
      };
    }
    if (
      row.source !== "tier_estimate" &&
      row.book_hours != null &&
      row.book_hours > 0
    ) {
      console.warn(
        `[quoteEngine] disqualified vdb labor_times row: ` +
          `vehicle_config=${args.vehicle_config_id} service=${args.service_id} ` +
          `data_quality=${row.data_quality ?? "?"} confidence=${row.confidence ?? "?"}`,
      );
    }
  }

  // Layer 2: empirical (≥MIN_EMPIRICAL_SAMPLES completed jobs)
  for (const row of direct) {
    if (
      row.empirical_hours != null &&
      row.empirical_hours > 0 &&
      (row.empirical_sample_size ?? 0) >= MIN_EMPIRICAL_SAMPLES
    ) {
      return {
        hours: row.empirical_hours,
        source: "empirical",
        confidence: row.confidence ?? 0.85,
      };
    }
  }

  // Layer 3: sibling config (same chassis_code, same make, quality-gated)
  const cfg = await ctx.db.get(args.vehicle_config_id);
  if (cfg?.chassis_code) {
    const siblings = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_chassis_code", (q) =>
        q.eq("chassis_code", cfg.chassis_code),
      )
      .collect();
    for (const sib of siblings) {
      if (sib._id === args.vehicle_config_id) continue;
      // Same-chassis-code rows span multiple makes when enrichment
      // hallucinates a generic placeholder (e.g. "THE" on a Stelvio, Ford
      // Ranger, Audi Q5, and Malibu). Require same make to count.
      if (sib.make_id !== cfg.make_id) continue;
      const sibLabor = await ctx.db
        .query("labor_times")
        .withIndex("by_vehicle_config_and_service", (q) =>
          q.eq("vehicle_config_id", sib._id).eq("service_id", args.service_id),
        )
        .first();
      if (!sibLabor) continue;
      // Fast-path: drop tier_estimate seeds and null/zero hours before the
      // shared quality gate so the early-continue intent stays visible.
      if (
        sibLabor.book_hours == null ||
        sibLabor.book_hours <= 0 ||
        sibLabor.source === "tier_estimate"
      ) {
        continue;
      }
      // Same quality definition as Layer 1 (isHighQualityVdb covers
      // DISQUALIFIED_SOURCE / DISQUALIFIED_DATA_QUALITY / MIN_VDB_CONFIDENCE).
      // Without this gate, the rows Layer 1 rejects (chassis clones,
      // training-data guesses) walked back in through the sibling door at
      // a fabricated 0.7 confidence.
      if (!isHighQualityVdb(sibLabor)) continue;
      return {
        hours: sibLabor.book_hours,
        source: "sibling",
        confidence: 0.7,
      };
    }
  }

  // Layer 4: engine-family estimator — DEFERRED per spec Open Items.

  return null;
}

/** Compute the tier-multiplier floor (Camry book_hours × labor multiplier).
 *  Returns null when the service has no multiplier category, no multiplier
 *  row for the tier, no Camry seed, or no Camry hours for this service. */
async function computeTierFloor(
  ctx: QueryCtx,
  args: {
    service_id: Id<"services">;
    vehicle_tier: VehicleTier;
  },
): Promise<{ hours: number } | null> {
  const service = await ctx.db.get(args.service_id);
  if (!service?.labor_multiplier_category_id) return null;
  const laborMultRow = await ctx.db
    .query("pricing_labor_multipliers")
    .withIndex("by_category_tier", (q) =>
      q
        .eq("labor_category_id", service.labor_multiplier_category_id!)
        .eq("tier", args.vehicle_tier),
    )
    .first();
  if (!laborMultRow) return null;
  const camry = await getCamryFwdConfig(ctx);
  if (!camry) return null;
  const camryHours = await ctx.db
    .query("labor_times")
    .withIndex("by_vehicle_config_and_service", (q) =>
      q.eq("vehicle_config_id", camry._id).eq("service_id", args.service_id),
    )
    .first();
  if (!camryHours?.book_hours) return null;
  return { hours: camryHours.book_hours * laborMultRow.multiplier };
}

export async function resolveLaborHours(
  ctx: QueryCtx,
  args: {
    vehicle_config_id: Id<"vehicle_configs">;
    service_id: Id<"services">;
    vehicle_tier: VehicleTier;
  },
): Promise<LaborHoursResult> {
  // Pass 1: try the real per-vehicle layers (direct VDB, empirical, sibling).
  const raw = await resolveRawLaborLayers(ctx, {
    vehicle_config_id: args.vehicle_config_id,
    service_id: args.service_id,
  });

  // Pass 2: always compute the tier floor — Round 6 policy treats Camry ×
  // tier multiplier as the minimum realistic time, regardless of which
  // upstream layer produced the raw value. Below-floor raw gets bumped up
  // and flagged; above-floor raw keeps its value and gets an informational
  // flag for director audit.
  const floor = await computeTierFloor(ctx, {
    service_id: args.service_id,
    vehicle_tier: args.vehicle_tier,
  });

  if (raw == null && floor == null) {
    // Refuse — no real data and no Camry-anchored floor either. Surface the
    // most actionable missing-data reason so callers can guide seeding.
    const service = await ctx.db.get(args.service_id);
    if (!service?.labor_multiplier_category_id) {
      return { ok: false, reason: "service has no labor_multiplier_category" };
    }
    const camry = await getCamryFwdConfig(ctx);
    if (!camry) {
      return {
        ok: false,
        reason: "Camry baseline config not seeded — run seedCamryBaseline:run",
      };
    }
    return {
      ok: false,
      reason: `no labor multiplier for tier ${args.vehicle_tier} (and no Camry hours)`,
    };
  }

  if (raw == null && floor != null) {
    // Engine refused every real layer — return the tier estimate as before.
    return {
      ok: true,
      hours: floor.hours,
      source: "tier_estimate",
      confidence: 0.3,
    };
  }

  if (raw != null && floor == null) {
    // Legacy services without a multiplier row: trust the raw value as-is.
    return {
      ok: true,
      hours: raw.hours,
      source: raw.source,
      confidence: raw.confidence,
    };
  }

  // Both raw and floor present — reconcile per Round 6 policy.
  const r = raw!;
  const f = floor!;
  if (r.hours < f.hours) {
    return {
      ok: true,
      hours: f.hours,
      source: r.source,
      confidence: r.confidence,
      raw_hours: r.hours,
      tier_floor_applied: true,
    };
  }
  return {
    ok: true,
    hours: r.hours,
    source: r.source,
    confidence: r.confidence,
    raw_hours: r.hours,
    above_tier_floor: r.hours > f.hours,
  };
}

// ─── resolvePartsCost — Camry anchor × tier multiplier, w/ CCB + AWD rules ─

export type PartsCostResult =
  | { ok: true; low: number; high: number; source: string; flags: string[] }
  | { ok: false; reason: string };

export async function resolvePartsCost(
  ctx: QueryCtx,
  args: {
    vehicle_config_id: Id<"vehicle_configs">;
    service_id: Id<"services">;
    vehicle_tier: VehicleTier;
  },
): Promise<PartsCostResult> {
  const cfg = await ctx.db.get(args.vehicle_config_id);
  if (!cfg) return { ok: false, reason: "vehicle config not found" };

  const service = await ctx.db.get(args.service_id);
  if (!service) return { ok: false, reason: "service not found" };

  // CCB carve-out — brake_system lives on pricing_vehicle_assignments.
  const pva = await ctx.db
    .query("pricing_vehicle_assignments")
    .withIndex("by_vehicle_config", (q) =>
      q.eq("vehicle_config_id", args.vehicle_config_id),
    )
    .first();
  const brakeSystem = pva?.brake_system;

  const slug = service.slug ?? "";
  const isBrakeService =
    slug === "brake_pad_replacement" || slug === "rotor_replacement";

  if (isBrakeService) {
    // Spec rule: missing brake_system = refuse-to-quote (never assume steel).
    if (brakeSystem === undefined) {
      return {
        ok: false,
        reason:
          "brake_system not classified — refuse-to-quote per spec (never assume steel)",
      };
    }
    if (brakeSystem === "ccb_standard" || brakeSystem === "ccb_optional") {
      const ccb = await ctx.db
        .query("ccb_absolute_prices")
        .withIndex("by_service", (q) => q.eq("service_id", args.service_id))
        .first();
      if (!ccb) {
        return {
          ok: false,
          reason: "CCB pricing not configured for service",
        };
      }
      return {
        ok: true,
        low: ccb.price_low_cents / 100,
        high: ccb.price_high_cents / 100,
        source: "ccb_absolute",
        flags: ["ccb_absolute_pricing"],
      };
    }
  }

  if (!service.parts_multiplier_category_id) {
    return {
      ok: false,
      reason: "service has no parts_multiplier_category (e.g. diagnostics, tires)",
    };
  }

  const camry = await getCamryFwdConfig(ctx);
  if (!camry?.engine_id) {
    return {
      ok: false,
      reason: "Camry baseline engine not seeded — run seedCamryBaseline:run",
    };
  }
  const spec = await ctx.db
    .query("service_vehicle_specs")
    .withIndex("by_engine_and_service", (q) =>
      q.eq("engine_id", camry.engine_id!).eq("service_id", args.service_id),
    )
    .first();
  if (spec?.parts_cost_low == null || spec.parts_cost_high == null) {
    return {
      ok: false,
      reason: `no Camry baseline parts cost for service slug=${slug}`,
    };
  }

  const partsMultRow = await ctx.db
    .query("pricing_parts_multipliers")
    .withIndex("by_category_tier", (q) =>
      q
        .eq("parts_category_id", service.parts_multiplier_category_id!)
        .eq("tier", args.vehicle_tier),
    )
    .first();
  if (!partsMultRow) {
    return {
      ok: false,
      reason: `no parts multiplier for tier ${args.vehicle_tier}`,
    };
  }

  let mult = partsMultRow.multiplier;
  const flags: string[] = [];

  // AWD surcharge per spec Part 1 Modifier rules (open-item flagged):
  // +10% on parts mult for oil+filter, coolant, brake pads only.
  const partsCategoryDoc = await ctx.db.get(
    service.parts_multiplier_category_id!,
  );
  const partsCategoryCode = partsCategoryDoc?.code;
  const isAwd = (cfg.drivetrain ?? "").toUpperCase() === "AWD";
  if (
    isAwd &&
    (partsCategoryCode === "oil_filter" ||
      partsCategoryCode === "coolant" ||
      partsCategoryCode === "brake_pads")
  ) {
    mult *= 1.1;
    flags.push("awd_surcharge_applied");
  }

  // Differential service: every drivetrain with a separately serviceable
  // diff qualifies (Jun-9 review — the old `!isAwd` check refused RWD/4WD,
  // which have differentials). FWD transaxles don't; unknown stays refused
  // (fail-safe — never bill a service the car might not have).
  if (slug === "differential_service" && !hasServiceableDifferential(cfg.drivetrain)) {
    return {
      ok: false,
      reason: `differential service not applicable to drivetrain=${cfg.drivetrain ?? "unknown"}`,
    };
  }

  return {
    ok: true,
    low: spec.parts_cost_low * mult,
    high: spec.parts_cost_high * mult,
    source: `multiplier:${partsCategoryCode ?? "?"}:${args.vehicle_tier}`,
    flags,
  };
}

// ─── buildQuote — assembles the full quote object ──────────────────────────

export type Quote =
  | {
      ok: true;
      low: number;
      high: number;
      spread_pct: number;
      tier: VehicleTier;
      labor: {
        hours: number;
        rate: number;
        cost: number;
        hours_source: string;
        hours_confidence: number;
        rate_source: string;
        /** Raw hours from VDB/empirical/sibling before tier-floor bump.
         *  Equal to `hours` when neither floor nor above-flag fired. */
        raw_hours?: number;
        /** True when raw labor was below Camry × tier multiplier and we
         *  substituted the floor. Emits `labor_below_tier_floor` flag. */
        tier_floor_applied?: boolean;
        /** True when raw labor exceeded the Camry × tier floor.
         *  Informational only. Emits `labor_above_tier_expected` flag. */
        above_tier_floor?: boolean;
      };
      parts: {
        /** Service total parts band (per-unit × unit_count). Drives the
         *  customer-facing line total + Stripe hold. */
        low: number;
        high: number;
        source: string;
        /** Per-unit band — display the SAME number on each per-OEM-part
         *  row when unit_count > 1 (e.g. front + rear axles, 8 plugs,
         *  N quarts of oil). */
        per_unit_low: number;
        per_unit_high: number;
        /** How many of `unit_label` this vehicle consumes for this service.
         *  For per_axle: 1 or 2 (booking position). For per_cylinder: 4/6/8.
         *  For per_unit_spec: engines.{capacity}. For per_wheel: 4. For
         *  fixed_kit: 1. */
        unit_count: number;
        /** How many units the Camry-anchored band represents. Caller scales
         *  by (unit_count / baseline_count). */
        baseline_count: number;
        /** Display label: "axle" | "cyl" | "qt" | "wheel" | "kit". */
        unit_label: string | null;
        /** True when we couldn't resolve a per-vehicle count and fell back
         *  to the baseline (e.g. unenriched engine, missing capacity). */
        unit_count_estimated: boolean;
      };
      flags: string[];
      display_label?: string;
    }
  | {
      ok: false;
      refuse_to_quote: true;
      reason: string;
      route_to: "booking_approvals";
    };

export async function buildQuote(
  ctx: QueryCtx,
  args: {
    vehicle_config_id: Id<"vehicle_configs">;
    service_id: Id<"services">;
    shop_id: Id<"shops">;
    /** Booking position for per_axle services ("front" | "rear" | "both").
     *  Ignored for other parts_kind values. Defaults to 1 axle when null. */
    booking_position?: "front" | "rear" | "both" | null;
  },
): Promise<Quote> {
  const cfg = await ctx.db.get(args.vehicle_config_id);
  if (!cfg) return refuse("vehicle config not found");
  let tier = cfg.pricing_tier as VehicleTier | undefined;
  if (!tier) {
    // Lazy detect via ASSIGNMENT_RULES — read-only here. The persisting write
    // happens in quotes:previewForBooking (a mutation) so queries stay pure.
    const detected = await detectTier(ctx, cfg);
    if (!detected) {
      return refuse(
        "vehicle make/model not in pricing rules — route to booking_approvals",
      );
    }
    tier = detected;
  }

  const shop = await ctx.db.get(args.shop_id);
  if (!shop) return refuse("shop not found");

  // Per-(shop, service, tier) flat-price override. When set, the shop has
  // declared a single advertised price (e.g. $89.99 oil change) — bypass the
  // labor + parts math entirely. Tax + platform fee are still added on top by
  // the booking flow.
  const fixed = await ctx.db
    .query("shop_service_fixed_prices")
    .withIndex("by_shop_service_tier", (q) =>
      q
        .eq("shop_id", args.shop_id)
        .eq("service_id", args.service_id)
        .eq("tier", tier),
    )
    .unique();
  if (fixed) {
    const price = round2(fixed.price_cents / 100);
    return {
      ok: true,
      low: price,
      high: price,
      spread_pct: 0,
      tier,
      labor: {
        hours: 0,
        rate: 0,
        cost: 0,
        hours_source: "fixed_override",
        hours_confidence: 1,
        rate_source: "fixed_override",
      },
      parts: {
        low: price,
        high: price,
        source: "fixed_override",
        per_unit_low: price,
        per_unit_high: price,
        unit_count: 1,
        baseline_count: 1,
        unit_label: "kit",
        unit_count_estimated: false,
      },
      flags: ["fixed_price_override"],
      display_label: "Fixed price",
    };
  }

  const rateRes = resolveLaborRate(shop, tier);
  if (!rateRes.serviceable || rateRes.rate == null) {
    return refuse(`shop labor rate unavailable: ${rateRes.source}`);
  }

  const hoursRes = await resolveLaborHours(ctx, {
    vehicle_config_id: args.vehicle_config_id,
    service_id: args.service_id,
    vehicle_tier: tier,
  });
  if (!hoursRes.ok) return refuse(hoursRes.reason);

  const partsRes = await resolvePartsCost(ctx, {
    vehicle_config_id: args.vehicle_config_id,
    service_id: args.service_id,
    vehicle_tier: tier,
  });
  if (!partsRes.ok) return refuse(partsRes.reason);

  // Resolve the per-vehicle unit count via the service's parts_kind:
  // per_axle uses booking_position, per_cylinder reads engines.cylinders,
  // per_unit_spec reads the engine capacity field, per_wheel = 4, etc.
  // The service total parts band = per-unit band × (unit_count / baseline).
  const service = await ctx.db.get(args.service_id);
  const camry = await getCamryFwdConfig(ctx);
  const camrySpec =
    camry?.engine_id && service
      ? await ctx.db
          .query("service_vehicle_specs")
          .withIndex("by_engine_and_service", (q) =>
            q
              .eq("engine_id", camry.engine_id!)
              .eq("service_id", args.service_id),
          )
          .first()
      : null;
  let engineRow: Doc<"engines"> | null = null;
  if (cfg.engine_id) {
    engineRow = (await ctx.db.get(cfg.engine_id)) ?? null;
  }

  // Director-editable rule lookup: when qty_override is set, it wins over
  // the per-vehicle resolver (intended for services that don't fit any of
  // the six standard kinds). Loaded once here so we don't pay an extra DB
  // round-trip on the hot path when no override exists.
  const partsRule = service
    ? await ctx.db
        .query("service_parts_rules")
        .withIndex("by_service", (q) =>
          q.eq("service_id", args.service_id),
        )
        .first()
    : null;
  const qtyOverride = partsRule?.qty_override ?? null;

  const baselineFromSpec = camrySpec?.parts_baseline_unit_count ?? null;
  const unitRes = service
    ? qtyOverride != null
      ? {
          count: qtyOverride,
          label: service.parts_unit_label ?? null,
          baseline: baselineFromSpec ?? 1,
          is_estimate: false,
        }
      : resolveServiceUnitCount({
          service,
          engine: engineRow,
          bookingPosition: args.booking_position ?? null,
          baselineFromSpec,
        })
    : {
        count: 1,
        label: null,
        baseline: 1,
        is_estimate: true,
      };

  // CCB absolute pricing is a flat per-axle price already, so don't scale
  // it again — treat as unit_count=1 baseline=1.
  const isCcbAbsolute = partsRes.source === "ccb_absolute";
  const scale = isCcbAbsolute ? 1 : unitScale(unitRes);
  const scaledPartsLow = partsRes.low * scale;
  const scaledPartsHigh = partsRes.high * scale;

  const laborCost = hoursRes.hours * rateRes.rate;
  const low = laborCost + scaledPartsLow;
  const high = laborCost + scaledPartsHigh;
  const spreadPct = low > 0 ? ((high - low) / low) * 100 : 0;

  const flags: string[] = [...partsRes.flags];
  let display_label: string | undefined;
  if (hoursRes.source === "tier_estimate") {
    flags.push("tier_estimate");
    display_label = "Initial estimate — final price confirmed at booking";
  }
  if (hoursRes.tier_floor_applied) flags.push("labor_below_tier_floor");
  if (hoursRes.above_tier_floor) flags.push("labor_above_tier_expected");
  if (unitRes.is_estimate && !isCcbAbsolute) {
    flags.push("unit_count_estimated");
  }
  if (spreadPct > 10) flags.push("spread_exceeded");

  return {
    ok: true,
    low: round2(low),
    high: round2(high),
    spread_pct: Math.round(spreadPct * 10) / 10,
    tier,
    labor: {
      hours: hoursRes.hours,
      rate: rateRes.rate,
      cost: round2(laborCost),
      hours_source: hoursRes.source,
      hours_confidence: hoursRes.confidence,
      rate_source: rateRes.source,
      raw_hours: hoursRes.raw_hours,
      tier_floor_applied: hoursRes.tier_floor_applied,
      above_tier_floor: hoursRes.above_tier_floor,
    },
    parts: {
      low: round2(scaledPartsLow),
      high: round2(scaledPartsHigh),
      source: partsRes.source,
      per_unit_low: round2(partsRes.low),
      per_unit_high: round2(partsRes.high),
      unit_count: isCcbAbsolute ? 1 : unitRes.count,
      baseline_count: isCcbAbsolute ? 1 : unitRes.baseline,
      unit_label: isCcbAbsolute ? "axle" : unitRes.label,
      unit_count_estimated: isCcbAbsolute ? false : unitRes.is_estimate,
    },
    flags,
    display_label,
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function refuse(reason: string): Quote {
  return {
    ok: false,
    refuse_to_quote: true,
    reason,
    route_to: "booking_approvals",
  };
}

async function getCamryFwdConfig(
  ctx: QueryCtx,
): Promise<Doc<"vehicle_configs"> | null> {
  return await ctx.db
    .query("vehicle_configs")
    .withIndex("by_config_key", (q) =>
      q.eq("config_key", CAMRY_FWD_CONFIG_KEY),
    )
    .first();
}

// ─── detectTier — read-only ASSIGNMENT_RULES walk ───────────────────────────
// Used when vehicle_configs.pricing_tier is null. Pure: returns the tier or
// null without writing. The persisting write happens in quotes:previewForBooking.

export async function detectTier(
  ctx: QueryCtx,
  cfg: Doc<"vehicle_configs">,
): Promise<VehicleTier | null> {
  if (cfg.pricing_tier) return cfg.pricing_tier as VehicleTier;
  const [make, model] = await Promise.all([
    ctx.db.get(cfg.make_id),
    ctx.db.get(cfg.model_id),
  ]);
  if (!make || !model) return null;
  const matchCtx = {
    make: make.name,
    model: (model as any).name ?? "",
    trim: cfg.trim_name ?? "",
    year: cfg.year,
  };
  for (const rule of ASSIGNMENT_RULES) {
    if (matchRule(rule, matchCtx)) return rule.tier;
  }
  return null;
}

// ─── resolveVehicleConfigFromVin ────────────────────────────────────────────
// Bookings carry `vin`, not `vehicle_config_id`. Shared helper for the booking
// + invoice rewires.

export async function resolveVehicleConfigFromVin(
  ctx: QueryCtx,
  vin: string,
): Promise<Doc<"vehicle_configs"> | null> {
  const vehicle = await ctx.db
    .query("vehicles")
    .withIndex("by_vin", (q) => q.eq("vin", vin))
    .first();
  const cfgId = (vehicle as { vehicle_config_id?: Id<"vehicle_configs"> } | null)
    ?.vehicle_config_id;
  if (!cfgId) return null;
  return await ctx.db.get(cfgId);
}

// ─── resolveQuoteSeries — multi-service aggregator ──────────────────────────
// Used by createBatch + the previewForBooking mutation. Loops buildQuote over
// each service and aggregates labor_minutes + low/high totals so the caller
// can validate against a single number.

export type QuoteSeries = {
  quotes: Quote[];
  total_low: number;
  total_high: number;
  labor_minutes_total: number;
  labor_cost_total: number;
};

export async function resolveQuoteSeries(
  ctx: QueryCtx,
  args: {
    vehicle_config_id: Id<"vehicle_configs">;
    service_ids: Id<"services">[];
    shop_id: Id<"shops">;
    /** Optional per-service booking positions for per_axle services.
     *  Map: service_id (stringified) → "front" | "rear" | "both". When a
     *  service id is absent, defaults to 1 axle. */
    service_positions?: Record<string, "front" | "rear" | "both">;
  },
): Promise<QuoteSeries> {
  const quotes: Quote[] = [];
  let total_low = 0;
  let total_high = 0;
  let labor_minutes_total = 0;
  let labor_cost_total = 0;

  for (const service_id of args.service_ids) {
    const q = await buildQuote(ctx, {
      vehicle_config_id: args.vehicle_config_id,
      service_id,
      shop_id: args.shop_id,
      booking_position:
        args.service_positions?.[String(service_id)] ?? null,
    });
    quotes.push(q);
    if (q.ok) {
      total_low += q.low;
      total_high += q.high;
      labor_minutes_total += q.labor.hours * 60;
      labor_cost_total += q.labor.cost;
    }
  }
  return {
    quotes,
    total_low: round2(total_low),
    total_high: round2(total_high),
    labor_minutes_total: Math.round(labor_minutes_total),
    labor_cost_total: round2(labor_cost_total),
  };
}
