/**
 * quotePrefillProbe.ts — DEV ONLY, not part of any product surface.
 *
 * Read-only. Inspects recent tire/rotor bookings and reports exactly what
 * getPrefillData's quote-prefill blocks read: the booking's service slugs, its
 * tire/rotor specs, and the accepted (non-superseded) *_quote_responses row.
 * `tirePrefillWouldFire` / `rotorPrefillWouldFire` mirror the guards in
 * job_actuals.getPrefillData, so a `false` tells us precisely what to backfill
 * for the parts step to auto-fill from the quote.
 *
 * Usage:
 *   npx convex run devOnly/quotePrefillProbe:report '{"limit":10}'
 *   npx convex run devOnly/quotePrefillProbe:report '{"bookingId":"..."}'
 */
import { v } from "convex/values";
import { query } from "../_generated/server";
import { quotePrefillLinesForService } from "../job_actuals";

const TIRE_SLUGS = new Set(["tire-replacement", "tire_replacement"]);
const ROTOR_SLUGS = new Set(["rotor-replacement", "rotor_replacement"]);

async function describe(ctx: any, b: any) {
  const slugs: string[] = [];
  // The EXACT lines getPrefillData would seed for this booking, computed by the
  // same shared helper the query uses — this is the real prefill output.
  const prefillLines: any[] = [];
  for (const sid of b.service_ids ?? []) {
    const svc = await ctx.db.get(sid);
    if (svc?.slug) slugs.push(svc.slug);
    if (svc?.slug) {
      const lines = await quotePrefillLinesForService(ctx, b, svc.slug, sid);
      prefillLines.push(...lines);
    }
  }
  const hasTireSvc = slugs.some((s) => TIRE_SLUGS.has(s));
  const hasRotorSvc = slugs.some((s) => ROTOR_SLUGS.has(s));

  const acceptedTire =
    b.tire_specs != null || hasTireSvc
      ? await ctx.db
          .query("tire_quote_responses")
          .withIndex("by_booking_id", (q: any) => q.eq("booking_id", b._id))
          .filter((q: any) => q.eq(q.field("superseded_at"), undefined))
          .first()
      : null;
  const acceptedRotor =
    b.rotor_specs != null || hasRotorSvc
      ? await ctx.db
          .query("rotor_quote_responses")
          .withIndex("by_booking_id", (q: any) => q.eq("booking_id", b._id))
          .filter((q: any) => q.eq(q.field("superseded_at"), undefined))
          .first()
      : null;

  return {
    bookingId: String(b._id),
    status: b.status,
    created_at: b.created_at ?? b._creationTime,
    vin: b.vin ?? null,
    service_slugs: slugs,
    hasTireSvc,
    hasRotorSvc,
    tire_specs: b.tire_specs ?? null,
    rotor_specs: b.rotor_specs ?? null,
    priced_parts_snapshot_len: (b.priced_parts_snapshot ?? []).length,
    custom_services: (b.custom_services ?? []).map((c: any) => c.name),
    acceptedTireQuote: acceptedTire
      ? {
          brand: acceptedTire.tire_brand,
          model: acceptedTire.tire_model ?? null,
          per_tire_price: acceptedTire.per_tire_price,
          quantity: acceptedTire.quantity,
        }
      : null,
    acceptedRotorQuote: acceptedRotor
      ? {
          brand: acceptedRotor.rotor_brand,
          model: acceptedRotor.rotor_model ?? null,
          per_rotor_price: acceptedRotor.per_rotor_price,
          quantity: acceptedRotor.quantity,
          pad_brand: acceptedRotor.pad_brand ?? null,
          pad_price: acceptedRotor.pad_price ?? null,
          pad_quantity: acceptedRotor.pad_quantity ?? null,
        }
      : null,
    // The actual prefill the parts step now receives (empty = still blank).
    prefill_lines: prefillLines.map((l: any) => ({
      part_name: l.part_name,
      cost: l.cost,
      quantity: l.quantity,
      tire_position: l.tire_position ?? null,
      from_quote: l.from_quote ?? false,
    })),
    prefillFires: prefillLines.length > 0,
  };
}

export const report = query({
  args: { limit: v.optional(v.number()), bookingId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (args.bookingId) {
      const id = ctx.db.normalizeId("bookings", args.bookingId);
      if (!id) return { error: `not a bookings id: ${args.bookingId}` };
      const b = await ctx.db.get(id);
      if (!b) return { error: "booking not found" };
      return await describe(ctx, b);
    }
    const limit = args.limit ?? 10;
    const recent = await ctx.db.query("bookings").order("desc").take(300);
    const out: any[] = [];
    for (const b of recent) {
      const isQuoteish =
        b.tire_specs != null ||
        b.rotor_specs != null ||
        (b.service_ids ?? []).length > 0;
      if (!isQuoteish) continue;
      const row = await describe(ctx, b);
      if (!row.hasTireSvc && !row.hasRotorSvc && row.tire_specs == null && row.rotor_specs == null) {
        continue;
      }
      out.push(row);
      if (out.length >= limit) break;
    }
    return out;
  },
});
