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
import type { TraceEntry } from "./partSelector";

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

export type ComputeDisclosedRangeResult = {
  low_cents: number;
  high_cents: number;
  breakdown: DisclosedRangeBreakdown;
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

  for (const svc of args.services) {
    const band = await resolvePartsBandForService(ctx, {
      service_id: svc.service_id,
      option_id: svc.option_id,
      engine_id: args.engine_id ?? null,
      fallback_midpoint_dollars: svc.parts_cost,
    });
    parts_low_dollars += band.low;
    parts_high_dollars += band.high;
  }

  const labor_dollars = args.labor_cost_dollars;

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

  return { low_cents, high_cents, breakdown };
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
 * By construction `total_cents ≤ disclosed_range_high_cents`, so confirming
 * without edits takes the existing in-range / auto-capture branch in
 * booking_approvals.ts.
 */
export function computeQuotedSetPrice(args: {
  disclosedBreakdown: DisclosedRangeBreakdown;
  pricedPartsSnapshot: PricedPartSnapshotRow[];
}): ComputeQuotedSetPriceResult {
  const { disclosedBreakdown: d, pricedPartsSnapshot } = args;

  const parts_cents = pricedPartsSnapshot.reduce(
    (sum, row) => sum + row.line_total_cents,
    0,
  );
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
  },
): Promise<PricedPartsSnapshotResult> {
  if (!args.vehicleConfigId) {
    return { rows: [], trace: [], low_confidence: false };
  }
  const rows: PricedPartSnapshotRow[] = [];
  const trace: PartSelectionTraceRow[] = [];
  let low_confidence = false;

  for (const serviceId of args.serviceIds) {
    const svc = await ctx.db.get(serviceId);
    if (!svc?.slug) continue;

    const resolution = await resolveWinningPartForService(ctx, {
      vin: args.vin,
      serviceId,
      serviceSlug: svc.slug,
      vehicleConfigId: args.vehicleConfigId,
      confirmedPackages: args.confirmedPackages,
    });

    trace.push({
      service_id: serviceId,
      winner_part_id: resolution.winner?.part._id,
      source: resolution.source,
      trace: resolution.trace?.map(traceEntryToRow),
      eliminated_by_gate_part_ids: resolution.eliminatedByGatePartIds,
    });

    if (resolution.lowConfidence) low_confidence = true;
    if (!resolution.winner) continue;

    const { fitment: f, part, priceSummary } = resolution.winner;
    // Use the outlier-rejected mean (`average`) — same field the customer-
    // facing breakdown reads. Median is naïve to per-pack listings mixing
    // with per-unit listings for the same OEM (spark plugs, brake pads).
    const unit_price_dollars = priceSummary.average;
    const quantity = Math.max(1, f.quantity_needed ?? 1);
    const line_total_dollars =
      Math.round(quantity * unit_price_dollars * 100) / 100;
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
    });
  }

  return { rows, trace, low_confidence };
}
