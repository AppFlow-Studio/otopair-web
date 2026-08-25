/**
 * quotes.ts — Convex query + mutation surface for the Pricing v2 quote engine.
 *
 * `build` is the read-only query — used for reactive quote streams where the
 * client just wants the latest number and won't persist anything. Falls back
 * to read-only detectTier when pricing_tier is null (matched tier returned,
 * but NOT written back).
 *
 * `previewForBooking` is the mutation invoked by the booking flow + the
 * mobile preview screen. It persists lazy-detected tiers back to
 * vehicle_configs (so subsequent quotes hit the fast path) and returns a
 * QuoteSeries aggregated over the booking's full service list.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  buildQuote,
  detectTier,
  resolveQuoteSeries,
  resolveVehicleConfigFromVin,
} from "./lib/quoteEngine";
import { computePricedPartsSnapshot } from "./booking_quotes";
import { deriveServiceVariantsFromOptions } from "./lib/brakeScope";

export const build = query({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
    service_id: v.id("services"),
    shop_id: v.id("shops"),
  },
  handler: async (ctx, args) => {
    return await buildQuote(ctx, args);
  },
});

/**
 * Reactive variant of `previewForBooking`. Resolves the VIN to a
 * vehicle_config + tier in-memory (no persistence) and returns the same
 * QuoteSeries shape so the mobile Review & Pay sheet can subscribe and
 * surface the engine band + per-quote flags. Returns `ok: false` with a
 * refuse_to_quote reason when the vehicle isn't enrolled or its tier
 * can't be resolved — mirrors the mutation's contract so callers can
 * share branching logic.
 */
export const previewForBookingQuery = query({
  args: {
    vehicle_owner_id: v.id("vehicle_owners"),
    service_ids: v.array(v.id("services")),
    shop_id: v.id("shops"),
    /** Per-service booking positions for per_axle services. Map keys are
     *  stringified service ids; values are 'front' | 'rear' | 'both'.
     *  Optional — services not present default to 1 axle. */
    service_positions: v.optional(
      v.record(
        v.string(),
        v.union(v.literal("front"), v.literal("rear"), v.literal("both")),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const empty = {
      ok: true as const,
      quotes: [],
      total_low: 0,
      total_high: 0,
      labor_minutes_total: 0,
      labor_cost_total: 0,
    };
    if (args.service_ids.length === 0) return empty;

    const owner = await ctx.db.get(args.vehicle_owner_id);
    if (!owner) {
      return {
        ok: false as const,
        refuse_to_quote: true as const,
        reason: "vehicle owner not found",
        route_to: "booking_approvals" as const,
      };
    }
    const cfg = await resolveVehicleConfigFromVin(ctx, owner.vin);
    if (!cfg) {
      return {
        ok: false as const,
        refuse_to_quote: true as const,
        reason: "vehicle not enrolled — no vehicle_config for vin",
        route_to: "booking_approvals" as const,
      };
    }
    if (!cfg.pricing_tier) {
      const detected = await detectTier(ctx, cfg);
      if (!detected) {
        return {
          ok: false as const,
          refuse_to_quote: true as const,
          reason:
            "vehicle make/model not in pricing rules — route to booking_approvals",
          route_to: "booking_approvals" as const,
        };
      }
    }
    const series = await resolveQuoteSeries(ctx, {
      vehicle_config_id: cfg._id,
      service_ids: args.service_ids,
      shop_id: args.shop_id,
      service_positions: args.service_positions,
    });
    return { ok: true as const, ...series };
  },
});

export const previewForBooking = mutation({
  args: {
    vin: v.string(),
    service_ids: v.array(v.id("services")),
    shop_id: v.id("shops"),
    /** Per-service booking positions for per_axle services (brakes). Same
     *  shape as previewForBookingQuery — a both-axle brake job quotes ~2×
     *  labor when the per_axle_labor flag is on. Absent → 1 axle. */
    service_positions: v.optional(
      v.record(
        v.string(),
        v.union(v.literal("front"), v.literal("rear"), v.literal("both")),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const cfg = await resolveVehicleConfigFromVin(ctx, args.vin);
    if (!cfg) {
      return {
        ok: false as const,
        refuse_to_quote: true as const,
        reason: "vehicle not enrolled — no vehicle_config for vin",
        route_to: "booking_approvals" as const,
      };
    }

    // Persist lazy-detected tier so subsequent quotes hit the fast path.
    if (!cfg.pricing_tier) {
      const detected = await detectTier(ctx, cfg);
      if (!detected) {
        return {
          ok: false as const,
          refuse_to_quote: true as const,
          reason:
            "vehicle make/model not in pricing rules — route to booking_approvals",
          route_to: "booking_approvals" as const,
        };
      }
      await ctx.db.patch(cfg._id, {
        pricing_tier: detected,
        pricing_tier_source: "rules_engine_lazy",
        pricing_tier_set_at: Date.now(),
      });
    }

    const series = await resolveQuoteSeries(ctx, {
      vehicle_config_id: cfg._id,
      service_ids: args.service_ids,
      shop_id: args.shop_id,
      service_positions: args.service_positions,
    });
    return { ok: true as const, ...series };
  },
});

/**
 * previewCatalogPartsByVin — VIN-keyed parts preview for the shop "Create
 * booking" drawer's optional catalog-parts data-gathering section.
 *
 * The VIN-keyed twin of `serviceParts.getPricedPartsForServices` (which is
 * keyed by vehicle_owner_id, unusable from the drawer — the drawer only holds
 * a VIN string). Resolves the vehicle_config from the VIN and returns the same
 * parts/price/quantity rows the customer-facing app would have shown for the
 * chosen services + options, grouped by service. Read-only and reactive so the
 * drawer re-derives the prefill as the mechanic toggles services/options.
 *
 * Returns `{ hasConfig: false, services: [] }` for VINs with no resolvable
 * vehicle_config (unenrolled walk-ins) so the drawer can fall back to blank
 * editable rows. Parts-only by design — labor is captured by
 * labor_quote_snapshots, so we skip the heavier resolveQuoteSeries here.
 */
export const previewCatalogPartsByVin = query({
  args: {
    vin: v.string(),
    serviceIds: v.array(v.id("services")),
    selectedServiceOptions: v.optional(
      v.array(
        v.object({
          service_id: v.id("services"),
          option_label: v.optional(v.string()),
          option_type: v.optional(v.string()),
        }),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const empty = { hasConfig: false as const, services: [] };
    if (args.serviceIds.length === 0) return empty;

    const canonicalVin = args.vin.trim().toUpperCase();
    if (!canonicalVin) return empty;

    const config = await resolveVehicleConfigFromVin(ctx, canonicalVin);
    if (!config) return empty;

    // Confirmed packages gate package-conditional fitments. Best-effort: an
    // active owner's specs when one exists, else empty (walk-in for a vehicle
    // no customer has enrolled). Mirrors getPricedPartsForServices but starts
    // from the VIN instead of a vehicle_owner id.
    const ownerships = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_vin", (q) => q.eq("vin", canonicalVin))
      .collect();
    const activeOwner = ownerships.find((o) => o.status === "active") ?? null;
    let confirmedPackages = new Set<string>();
    if (activeOwner) {
      const specs = await ctx.db
        .query("vehicle_owner_specs")
        .withIndex("by_vehicle_owner", (q) =>
          q.eq("vehicle_owner_id", activeOwner._id),
        )
        .first();
      confirmedPackages = new Set(specs?.confirmed_packages ?? []);
    }

    const snap = await computePricedPartsSnapshot(ctx, {
      serviceIds: args.serviceIds,
      vehicleConfigId: config._id,
      vin: canonicalVin,
      confirmedPackages,
      serviceVariants: deriveServiceVariantsFromOptions(
        args.selectedServiceOptions,
      ),
    });

    // Group the flat snapshot rows by service, preserving the caller's order.
    const rowsByService = new Map<string, typeof snap.rows>();
    for (const row of snap.rows) {
      const key = String(row.service_id);
      const list = rowsByService.get(key);
      if (list) list.push(row);
      else rowsByService.set(key, [row]);
    }

    const services = [];
    for (const serviceId of args.serviceIds) {
      const rows = rowsByService.get(String(serviceId));
      if (!rows || rows.length === 0) continue;
      const svc = await ctx.db.get(serviceId);
      services.push({
        service_id: serviceId,
        service_name: svc?.name ?? "Service",
        service_slug: svc?.slug ?? null,
        rows,
        catalog_parts_total_cents: rows.reduce(
          (sum, r) => sum + r.line_total_cents,
          0,
        ),
        low_confidence: rows.some((r) => r.price_unknown === true),
        // Any line priced from data older than PARTS_PRICE_MAX_AGE_DAYS —
        // client renders the per-line/service "estimate" treatment.
        has_stale_prices: rows.some((r) => r.price_stale === true),
      });
    }

    return { hasConfig: true as const, services };
  },
});
