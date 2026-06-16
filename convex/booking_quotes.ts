/**
 * booking_quotes.ts — Disclosed range computation for the Pre-Job Approval
 * Booking Flow.
 *
 * The customer never sees a single price during booking — they see a range
 * sourced from service_vehicle_specs.parts_cost_low/high (or
 * service_options.parts_cost_low/high when an option is selected). The
 * range itself is the approval: as long as the mechanic's confirmed set
 * price lands inside the band, no further consent is needed.
 *
 * This module computes that range at booking-create time and returns the
 * full breakdown that gets snapshotted onto bookings.disclosed_breakdown
 * (so subsequent catalog/pricing edits don't shift the customer's
 * contract).
 */

import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { computeBookingTax } from "../lib/tax";
import { computePlatformFeeDollars } from "../lib/platformFee";
import { resolveWinningPartForService } from "./serviceParts";
import { quoteUnitPrice } from "./part_prices";
import type { TraceEntry } from "./partSelector";
import { detectTier, resolveQuoteSeries } from "./lib/quoteEngine";
import type { VehicleTier } from "./lib/vehicleTiers";

/** Fallback band width when service_vehicle_specs has no engine-specific
 *  row for a service. ±8% around the client-supplied per-service parts
 *  cost — was ±25% during early development, but real source variance
 *  (after MAD outlier rejection) sits in the 5–8% range, so a tighter cap
 *  keeps the disclosed band honest. */
const FALLBACK_BAND_RATIO = 0.08;

export type ComputeDisclosedRangeService = {
  service_id: Id<"services">;
  /** Client-supplied per-service parts cost (dollars). Used as the midpoint
   *  when no service_vehicle_specs row exists for the engine. */
  parts_cost: number;
  /** Per-service labor cost (dollars). Used to zero-out the labor contribution
   *  on services that resolve to a flat fixed price (which already bundles
   *  labor + parts). Optional for backward compat: when omitted, the labor
   *  reduction step is skipped and total `labor_cost_dollars` is used as-is. */
  labor_cost?: number;
  /** Optional option_id when has_options. Triggers service_options lookup
   *  instead of service_vehicle_specs. */
  option_id?: Id<"service_options">;
};

export type ComputeDisclosedRangeArgs = {
  services: ComputeDisclosedRangeService[];
  /** Sum of per-service labor_cost from the booking-create call. */
  labor_cost_dollars: number;
  /** Optional — when null, falls back to default state (no zip override). */
  engine_id?: Id<"engines"> | null;
  shop_state?: string | null;
  shop_zip?: string | null;
  /** Optional — when both shop_id and vehicle_config_id are provided, each
   *  service is checked against shop_service_fixed_prices for the vehicle's
   *  tier. A hit replaces that service's parts band with the flat price and
   *  zeroes its labor contribution. */
  shop_id?: Id<"shops"> | null;
  vehicle_config_id?: Id<"vehicle_configs"> | null;
};

export type DisclosedRangeBreakdown = {
  parts_low_cents: number;
  parts_high_cents: number;
  labor_cents: number;
  tax_low_cents: number;
  tax_high_cents: number;
  service_fee_low_cents: number;
  service_fee_high_cents: number;
};

/** Per-line flat-price hit captured during disclosed-range computation.
 *  Forwarded into `computeQuotedSetPrice` so the quoted parts total reflects
 *  the locked-in flat amount instead of the raw OEM unit price in
 *  `priced_parts_snapshot`. Without this the mechanic surface would render
 *  "Parts $8.10" for an oil change the customer agreed to at $60 flat. */
export type FixedPriceLine = {
  service_id: Id<"services">;
  price_cents: number;
};

/** Per-service projection of the quote-engine result for the booking.
 *  One row per service id in the booking, in the same order as
 *  `args.services`. Lets `createBatch` compare per-line costs against the
 *  engine's per-service band and stamp `fallback_catch` on the service
 *  rows that diverge (the case where AI-enriched parts prices were wrong
 *  and the multiplier engine corrected them). Persisted on the booking
 *  row as `service_quote_flags` so the director panel can render a
 *  per-line "Fallback catch" pill. */
export type PerServiceQuoteFlags = {
  service_id: Id<"services">;
  /** Engine flags for this service, possibly augmented with 'fallback_catch'
   *  in createBatch when the per-line cost falls outside the engine band.
   *  When the engine refused this service, contains ['fallback_only']. */
  flags: string[];
  engine_parts_low: number | null;
  engine_parts_high: number | null;
  engine_labor_hours: number | null;
  engine_labor_source: string | null;
  parts_source: string | null;
};

export type ComputeDisclosedRangeResult = {
  low_cents: number;
  high_cents: number;
  breakdown: DisclosedRangeBreakdown;
  /** True when at least one service line resolved to a per-(shop, service,
   *  tier) flat-price override. Persisted on the booking row as
   *  `is_fixed_price` so the mechanic-facing UI can render a "Fixed price"
   *  badge without exposing the customer's disclosed ceiling. */
  is_fixed_price: boolean;
  /** Per-service flat-price hits. Empty when no service resolved to a
   *  shop_service_fixed_prices row. Threaded into `computeQuotedSetPrice`. */
  fixed_price_lines: FixedPriceLine[];
  /** Pricing v2 flags raised during disclosed-range computation. Possible
   *  values: per-quote engine flags (tier_estimate, awd_surcharge_applied,
   *  ccb_absolute_pricing, fixed_price_override, spread_exceeded), plus
   *  'fallback_only' when the engine refused at least one service and the
   *  band fell back to service_vehicle_specs / fallback midpoint logic.
   *  The mobile UI surfaces these as an "Estimate" pill. Empty when the
   *  engine signed off on every service cleanly. */
  quote_flags: string[];
  /** Pricing v2 engine band for the labor+parts portion (dollars). Null when
   *  the engine refused at least one service. Persisted alongside the
   *  disclosed range so finance can audit how far the customer's contracted
   *  band sits from the engine's confidence-weighted fallback. */
  quote_fallback_low_dollars: number | null;
  quote_fallback_high_dollars: number | null;
  /** Per-service engine projection in the same order as `args.services`.
   *  Empty when the caller didn't supply shop_id + vehicle_config_id.
   *  Consumed by createBatch to detect per-line `fallback_catch` and by
   *  director.bookingDetail to surface per-service flags. */
  service_quote_flags: PerServiceQuoteFlags[];
};

const dollarsToCents = (d: number) => Math.round(d * 100);

/**
 * Compute the disclosed price range for a booking. Reads
 * service_vehicle_specs / service_options for parts bands; recomputes tax
 * and platform fee at both endpoints (so tax brackets and the platform-fee
 * floor are correctly reflected on each end of the range).
 */
export async function computeDisclosedRange(
  ctx: MutationCtx,
  args: ComputeDisclosedRangeArgs,
): Promise<ComputeDisclosedRangeResult> {
  let parts_low_dollars = 0;
  let parts_high_dollars = 0;
  let labor_reduction_dollars = 0;
  let is_fixed_price = false;
  const fixed_price_lines: FixedPriceLine[] = [];

  // Resolve the vehicle's tier once for the whole booking — used to look up
  // per-(shop, service, tier) flat-price overrides. Skip silently if either
  // shop_id or vehicle_config_id wasn't supplied; this keeps the helper
  // backward-compatible for callers that don't yet thread them through.
  let tier: VehicleTier | null = null;
  if (args.shop_id && args.vehicle_config_id) {
    const cfg = await ctx.db.get(args.vehicle_config_id);
    if (cfg) {
      tier =
        (cfg.pricing_tier as VehicleTier | undefined) ??
        (await detectTier(ctx, cfg));
    }
  }

  for (const svc of args.services) {
    if (tier && args.shop_id) {
      const fixed = await ctx.db
        .query("shop_service_fixed_prices")
        .withIndex("by_shop_service_tier", (q) =>
          q
            .eq("shop_id", args.shop_id!)
            .eq("service_id", svc.service_id)
            .eq("tier", tier!),
        )
        .unique();
      if (fixed) {
        const price = fixed.price_cents / 100;
        parts_low_dollars += price;
        parts_high_dollars += price;
        labor_reduction_dollars += svc.labor_cost ?? 0;
        is_fixed_price = true;
        fixed_price_lines.push({
          service_id: svc.service_id,
          price_cents: fixed.price_cents,
        });
        continue;
      }
    }
    const band = await resolvePartsBandForService(ctx, {
      service_id: svc.service_id,
      option_id: svc.option_id,
      engine_id: args.engine_id ?? null,
      fallback_midpoint_dollars: svc.parts_cost,
    });
    parts_low_dollars += band.low;
    parts_high_dollars += band.high;
  }

  const labor_dollars = Math.max(
    0,
    args.labor_cost_dollars - labor_reduction_dollars,
  );

  const tax_low_dollars = computeBookingTax({
    laborDollars: labor_dollars,
    partsDollars: parts_low_dollars,
    state: args.shop_state ?? null,
    zip: args.shop_zip ?? null,
  }).taxDollars;
  const tax_high_dollars = computeBookingTax({
    laborDollars: labor_dollars,
    partsDollars: parts_high_dollars,
    state: args.shop_state ?? null,
    zip: args.shop_zip ?? null,
  }).taxDollars;

  const fee_low_dollars = computePlatformFeeDollars(
    labor_dollars + parts_low_dollars,
  );
  const fee_high_dollars = computePlatformFeeDollars(
    labor_dollars + parts_high_dollars,
  );

  const breakdown: DisclosedRangeBreakdown = {
    parts_low_cents: dollarsToCents(parts_low_dollars),
    parts_high_cents: dollarsToCents(parts_high_dollars),
    labor_cents: dollarsToCents(labor_dollars),
    tax_low_cents: dollarsToCents(tax_low_dollars),
    tax_high_cents: dollarsToCents(tax_high_dollars),
    service_fee_low_cents: dollarsToCents(fee_low_dollars),
    service_fee_high_cents: dollarsToCents(fee_high_dollars),
  };

  const low_cents =
    breakdown.labor_cents +
    breakdown.parts_low_cents +
    breakdown.tax_low_cents +
    breakdown.service_fee_low_cents;
  const high_cents =
    breakdown.labor_cents +
    breakdown.parts_high_cents +
    breakdown.tax_high_cents +
    breakdown.service_fee_high_cents;

  // Pricing v2 sanity sidecar. Call the quote engine over the same service
  // list and roll its per-quote flags up onto the disclosed range. When any
  // service refuses (e.g. CCB without absolute pricing, no pricing_tier
  // match), the customer's band is still the source of truth — we just mark
  // it `fallback_only` so the UI can render an "Estimate" pill. Skipped
  // when the caller hasn't threaded shop_id + vehicle_config_id.
  const quote_flags_set = new Set<string>();
  let quote_fallback_low_dollars: number | null = null;
  let quote_fallback_high_dollars: number | null = null;
  const service_quote_flags: PerServiceQuoteFlags[] = [];
  if (args.shop_id && args.vehicle_config_id) {
    const series = await resolveQuoteSeries(ctx, {
      vehicle_config_id: args.vehicle_config_id,
      service_ids: args.services.map((s) => s.service_id),
      shop_id: args.shop_id,
    });
    const anyRefused = series.quotes.some((q) => !q.ok);
    if (anyRefused) {
      quote_flags_set.add("fallback_only");
      quote_flags_set.add("tier_estimate");
    } else {
      quote_fallback_low_dollars = series.total_low;
      quote_fallback_high_dollars = series.total_high;
    }
    // Build the per-service projection regardless of whether any service
    // refused — directors still want to see which lines the engine refused
    // and which it cleared. Order matches args.services (same as the input
    // service_ids passed to resolveQuoteSeries).
    for (let i = 0; i < args.services.length; i++) {
      const svc = args.services[i];
      const q = series.quotes[i];
      if (q && q.ok) {
        for (const f of q.flags) quote_flags_set.add(f);
        service_quote_flags.push({
          service_id: svc.service_id,
          flags: [...q.flags],
          engine_parts_low: q.parts.low,
          engine_parts_high: q.parts.high,
          engine_labor_hours: q.labor.hours,
          engine_labor_source: q.labor.hours_source,
          parts_source: q.parts.source,
        });
      } else {
        service_quote_flags.push({
          service_id: svc.service_id,
          flags: ["fallback_only"],
          engine_parts_low: null,
          engine_parts_high: null,
          engine_labor_hours: null,
          engine_labor_source: null,
          parts_source: null,
        });
      }
    }
  }

  return {
    low_cents,
    high_cents,
    breakdown,
    is_fixed_price,
    fixed_price_lines,
    quote_flags: Array.from(quote_flags_set),
    quote_fallback_low_dollars,
    quote_fallback_high_dollars,
    service_quote_flags,
  };
}

async function resolvePartsBandForService(
  ctx: MutationCtx,
  args: {
    service_id: Id<"services">;
    option_id?: Id<"service_options"> | null;
    engine_id?: Id<"engines"> | null;
    fallback_midpoint_dollars: number;
  },
): Promise<{ low: number; high: number }> {
  // A spec/option row counts as a real band only when low and high actually
  // differ. When they're equal we'd persist a collapsed "$X – $X" range that
  // contradicts the ±25% band the customer just agreed to at checkout, so
  // we fall through to the fallback in that case.
  const isRealBand = (low: number, high: number) => high > low;

  // 1. Option-level band wins when an option is selected.
  if (args.option_id) {
    const opt = await ctx.db.get(args.option_id);
    if (
      opt?.parts_cost_low != null &&
      opt?.parts_cost_high != null &&
      isRealBand(opt.parts_cost_low, opt.parts_cost_high)
    ) {
      return { low: opt.parts_cost_low, high: opt.parts_cost_high };
    }
  }

  // 2. Engine-specific row in service_vehicle_specs.
  if (args.engine_id) {
    const spec = await ctx.db
      .query("service_vehicle_specs")
      .withIndex("by_engine_and_service", (q) =>
        q.eq("engine_id", args.engine_id!).eq("service_id", args.service_id),
      )
      .first();
    if (
      spec?.parts_cost_low != null &&
      spec?.parts_cost_high != null &&
      isRealBand(spec.parts_cost_low, spec.parts_cost_high)
    ) {
      return { low: spec.parts_cost_low, high: spec.parts_cost_high };
    }
  }

  // 3. Fallback: ±25% around the client-supplied per-service parts cost
  //    (or around the spec midpoint when the spec collapsed in step 2).
  //    For labor-only services parts_cost is 0 → band is (0, 0), which is
  //    correct (labor variance is small enough that we don't band it).
  const mid = Math.max(0, args.fallback_midpoint_dollars);
  if (mid === 0) return { low: 0, high: 0 };
  return {
    low: mid * (1 - FALLBACK_BAND_RATIO),
    high: mid * (1 + FALLBACK_BAND_RATIO),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Priced-parts snapshot
//
// Captures the same per-unit prices and quantities the customer saw on the
// Review & Pay screen (which renders from `getPricedPartsForServices`).
// Stored on the booking row so the mechanic's post-job dialog hydrates
// from frozen data, not from a re-query of `part_prices` that may have
// drifted since the booking was placed.
// ─────────────────────────────────────────────────────────────────────────

export type PricedPartSnapshotRow = {
  service_id: Id<"services">;
  part_id?: Id<"oem_parts">;
  oem_number: string;
  part_name: string;
  brand?: string;
  part_tier?: string;
  quantity: number;
  unit_price_cents: number;
  line_total_cents: number;
  /** Service Parts Reference role fields (2026-06). One snapshot row per
   *  ROLE winner (oil + filter + washer…). Only core / default-kit roles are
   *  snapshotted — as_needed stays out of the locked contract. */
  service_role?: string;
  role_key?: string;
  quantity_basis?: string;
  /** TRUE when the winning part had NO trustworthy price rows (every row was
   *  poison/unverified → empty summary). The row bills 0 in the locked quote
   *  — this marker makes that an explicit "price to be confirmed post-job"
   *  instead of a silent claim that the part costs $0 (Jun-9 review, item 10).
   *  Also flips the result's low_confidence → bookings.low_confidence_parts. */
  price_unknown?: boolean;
};

// ─────────────────────────────────────────────────────────────────────────
// Quoted set price (singular, mechanic-facing)
// ─────────────────────────────────────────────────────────────────────────

export type QuotedBreakdown = {
  parts_cents: number;
  labor_cents: number;
  tax_cents: number;
  service_fee_cents: number;
};

export type ComputeQuotedSetPriceResult = {
  total_cents: number;
  breakdown: QuotedBreakdown;
};

/**
 * Collapse the disclosed range + itemized parts snapshot into the single
 * "quoted set price" the mechanic confirms against. Parts use the same
 * outlier-rejected mean per OEM the customer saw line-itemized on Review &
 * Pay; tax and service fee use the midpoint of their disclosed bands; labor
 * is already a single value in the disclosed breakdown.
 *
 * For services that resolved to a per-(shop, service, tier) flat price,
 * the locked-in `price_cents` replaces the snapshot rows' line totals.
 * The snapshot rows themselves are retained for the mechanic's post-job
 * dialog (which seeds `suggestedParts` from them — see job_actuals.ts) but
 * they no longer drive the quoted total, since the customer agreed to the
 * flat amount, not the raw OEM unit price.
 *
 * By construction `total_cents ≤ disclosed_range_high_cents`, so confirming
 * without edits takes the existing in-range / auto-capture branch in
 * booking_approvals.ts.
 */
export function computeQuotedSetPrice(args: {
  disclosedBreakdown: DisclosedRangeBreakdown;
  pricedPartsSnapshot: PricedPartSnapshotRow[];
  fixedPriceLines?: FixedPriceLine[];
}): ComputeQuotedSetPriceResult {
  const { disclosedBreakdown: d, pricedPartsSnapshot, fixedPriceLines } = args;

  const fixedServiceIds = new Set(
    (fixedPriceLines ?? []).map((l) => String(l.service_id)),
  );
  const variablePartsCents = pricedPartsSnapshot.reduce(
    (sum, row) =>
      fixedServiceIds.has(String(row.service_id))
        ? sum
        : sum + row.line_total_cents,
    0,
  );
  const fixedPartsCents = (fixedPriceLines ?? []).reduce(
    (sum, l) => sum + l.price_cents,
    0,
  );
  const parts_cents = variablePartsCents + fixedPartsCents;
  const labor_cents = d.labor_cents;
  const tax_cents = Math.round((d.tax_low_cents + d.tax_high_cents) / 2);
  const service_fee_cents = Math.round(
    (d.service_fee_low_cents + d.service_fee_high_cents) / 2,
  );

  const breakdown: QuotedBreakdown = {
    parts_cents,
    labor_cents,
    tax_cents,
    service_fee_cents,
  };
  return {
    total_cents: parts_cents + labor_cents + tax_cents + service_fee_cents,
    breakdown,
  };
}

/**
 * Enforce the documented invariant `quoted_set_price_cents ≤
 * disclosed_range_high_cents` now that the snapshot is itemized per ROLE with
 * capacity-multiplied fluid quantities. The disclosed band's
 * `service_vehicle_specs.parts_cost_low/high` rows were priced on a bundled
 * dealer basis (e.g. Camry oil change $50–56 covers "4.8qt + cartridge +
 * gasket"), while the quote now sums per-SKU lines (5×1qt bottles + filter +
 * washer) — the two bases can legitimately diverge upward. When they do, the
 * customer's contracted ceiling must cover what the mechanic will confirm:
 * raise `parts_high_cents` (and therefore `high_cents`) by exactly the
 * shortfall. The customer already saw the same itemized lines on Review &
 * Pay (getPricedPartsForServices runs the identical resolver), so the raised
 * ceiling reflects what was displayed, never a hidden increase.
 *
 * Returns a new object; never mutates the input. No-op when the invariant
 * already holds.
 */
export function reconcileDisclosedCeilingWithQuote(
  disclosed: ComputeDisclosedRangeResult,
  quotedTotalCents: number,
): ComputeDisclosedRangeResult {
  if (quotedTotalCents <= disclosed.high_cents) return disclosed;
  const delta = quotedTotalCents - disclosed.high_cents;
  return {
    ...disclosed,
    high_cents: disclosed.high_cents + delta,
    breakdown: {
      ...disclosed.breakdown,
      parts_high_cents: disclosed.breakdown.parts_high_cents + delta,
    },
  };
}

export type PartSelectionTraceRow = {
  service_id: Id<"services">;
  winner_part_id?: Id<"oem_parts">;
  source: "vin_sticky" | "scored" | "no_candidates";
  trace?: Array<{
    layer: number | "gate";
    name: string;
    decisive: boolean;
    reason: string;
    survivor_part_ids: Id<"oem_parts">[];
    eliminated_part_ids?: Id<"oem_parts">[];
  }>;
  eliminated_by_gate_part_ids?: Id<"oem_parts">[];
  /** Which role group within the service this entry scored — selection runs
   *  per role since the Service Parts Reference work. Absent on legacy rows. */
  role_key?: string;
};

export type PricedPartsSnapshotResult = {
  rows: PricedPartSnapshotRow[];
  trace: PartSelectionTraceRow[];
  low_confidence: boolean;
};

function traceEntryToRow(entry: TraceEntry) {
  return {
    layer: entry.layer,
    name: entry.name,
    decisive: entry.decisive,
    reason: entry.reason,
    survivor_part_ids: entry.survivor_part_ids,
    eliminated_part_ids: entry.eliminated_part_ids,
  };
}

/**
 * Pure mapper: one service's part resolution → locked snapshot rows + trace.
 *
 * One snapshot row per LOCKED role winner (core + default-kit roles), one
 * trace row per scored role group; as_needed roles are deliberately excluded
 * from rows — they're the discovery range, not the locked contract, and
 * computeQuotedSetPrice sums every row it's given.
 *
 * price_unknown contract (Jun-9 review, item 10): a locked winner whose price
 * summary is EMPTY (sample_size 0 — every price row was poison/unverified)
 * used to be snapshotted as a bare `unit_price_cents: 0`, silently billing $0
 * in the locked quote. Such rows are now marked `price_unknown: true` and the
 * result's low_confidence flips (persisted as bookings.low_confidence_parts),
 * so the mechanic's post-job confirmation — which hydrates from this snapshot
 * (job_actuals.ts) — can demand a real price for the line.
 */
export function snapshotRowsForResolution(
  serviceId: Id<"services">,
  resolution: Awaited<ReturnType<typeof resolveWinningPartForService>>,
): {
  rows: PricedPartSnapshotRow[];
  trace: PartSelectionTraceRow[];
  low_confidence: boolean;
} {
  const rows: PricedPartSnapshotRow[] = [];
  const trace: PartSelectionTraceRow[] = [];
  let low_confidence = resolution.lowConfidence === true;

  if (resolution.roleWinners.length === 0) {
    trace.push({
      service_id: serviceId,
      winner_part_id: undefined,
      source: "no_candidates",
    });
    return { rows, trace, low_confidence };
  }

  for (const rw of resolution.roleWinners) {
    const { part, priceSummary } = rw.candidate;
    trace.push({
      service_id: serviceId,
      winner_part_id: part._id,
      // Snapshot trace keeps the legacy source vocabulary; universal
      // fallbacks are deliberate single-candidate picks.
      source: rw.source === "universal_fallback" ? "scored" : rw.source,
      trace: rw.trace?.map(traceEntryToRow),
      eliminated_by_gate_part_ids: rw.eliminatedByGatePartIds,
      role_key: rw.roleKey,
    });

    if (!rw.includeInLockedQuote) continue;

    // PARTS_PRICE_SOURCE flag (shared selector): median across sources once
    // flipped (gated at >=3 sources so per-pack vs per-unit listings can't
    // swing it), else the outlier-rejected mean. Default is average.
    const unit_price_dollars = quoteUnitPrice(priceSummary);
    const quantity = Math.max(1, rw.quantity);
    const line_total_dollars =
      Math.round(quantity * unit_price_dollars * 100) / 100;
    const price_unknown = priceSummary.sample_size === 0 ? true : undefined;
    if (price_unknown) low_confidence = true;
    rows.push({
      service_id: serviceId,
      part_id: part._id,
      oem_number: part.oem_part_number,
      part_name: part.name,
      brand: part.brand ?? undefined,
      part_tier: part.part_tier ?? undefined,
      quantity,
      unit_price_cents: Math.round(unit_price_dollars * 100),
      line_total_cents: Math.round(line_total_dollars * 100),
      service_role: rw.serviceRole,
      role_key: rw.roleKey,
      quantity_basis: rw.quantityBasis,
      price_unknown,
    });
  }
  return { rows, trace, low_confidence };
}

export async function computePricedPartsSnapshot(
  ctx: MutationCtx | QueryCtx,
  args: {
    serviceIds: Id<"services">[];
    vehicleConfigId: Id<"vehicle_configs"> | null | undefined;
    /** Canonical VIN — needed for the VIN-sticky preference lookup that decides
     *  whether to skip the 7-layer scorer for a previously installed part. */
    vin: string;
    /** From vehicle_owner_specs.confirmed_packages — gate package-conditional
     *  fitments to those the customer has actually confirmed. */
    confirmedPackages: Set<string>;
    /** Optional per-service axle/position choice (mirrors
     *  `getPricedPartsForServices.serviceVariants`). Drives positional
     *  filtering inside the resolver so the snapshot freezes the same part
     *  the customer saw on Review & Pay. "both" → two snapshot rows for
     *  the service (front + rear). */
    serviceVariants?: Array<{
      serviceId: Id<"services">;
      position: string;
    }>;
  },
): Promise<PricedPartsSnapshotResult> {
  if (!args.vehicleConfigId) {
    return { rows: [], trace: [], low_confidence: false };
  }
  const rows: PricedPartSnapshotRow[] = [];
  const trace: PartSelectionTraceRow[] = [];
  let low_confidence = false;

  const positionByServiceId = new Map<string, string>();
  for (const v of args.serviceVariants ?? []) {
    positionByServiceId.set(String(v.serviceId), v.position.toLowerCase());
  }

  // Row/trace construction lives in the pure, unit-tested
  // snapshotRowsForResolution (see its doc for the price_unknown contract).
  const appendResolution = (
    serviceId: Id<"services">,
    resolution: Awaited<ReturnType<typeof resolveWinningPartForService>>,
  ) => {
    const r = snapshotRowsForResolution(serviceId, resolution);
    rows.push(...r.rows);
    trace.push(...r.trace);
    if (r.low_confidence) low_confidence = true;
  };

  for (const serviceId of args.serviceIds) {
    const svc = await ctx.db.get(serviceId);
    if (!svc?.slug) continue;

    const position = positionByServiceId.get(String(serviceId));

    if (position === "both") {
      const frontRes = await resolveWinningPartForService(ctx, {
        vin: args.vin,
        serviceId,
        serviceSlug: svc.slug,
        vehicleConfigId: args.vehicleConfigId,
        confirmedPackages: args.confirmedPackages,
        positionFilter: "front",
      });
      const rearRes = await resolveWinningPartForService(ctx, {
        vin: args.vin,
        serviceId,
        serviceSlug: svc.slug,
        vehicleConfigId: args.vehicleConfigId,
        confirmedPackages: args.confirmedPackages,
        positionFilter: "rear",
        // Shared, positionless roles (caliper grease) and universal
        // fallbacks bill once — the front pass already carries them.
        suppressSharedRoles: true,
      });
      appendResolution(serviceId, frontRes);
      appendResolution(serviceId, rearRes);
      continue;
    }

    const resolution = await resolveWinningPartForService(ctx, {
      vin: args.vin,
      serviceId,
      serviceSlug: svc.slug,
      vehicleConfigId: args.vehicleConfigId,
      confirmedPackages: args.confirmedPackages,
      positionFilter: position,
    });
    appendResolution(serviceId, resolution);
  }

  return { rows, trace, low_confidence };
}
