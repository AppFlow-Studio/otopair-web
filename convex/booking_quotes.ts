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
import type { MutationCtx } from "./_generated/server";
import { computeBookingTax } from "../lib/tax";
import { computePlatformFeeDollars } from "../lib/platformFee";

/** Fallback band width when service_vehicle_specs has no engine-specific
 *  row for a service. ±25% around the client-supplied per-service parts
 *  cost (which the booking-create mutation already received). */
const FALLBACK_BAND_RATIO = 0.25;

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
