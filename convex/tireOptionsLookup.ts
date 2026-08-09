/**
 * tireOptionsLookup.ts
 *
 * On-demand fill for a vehicle's OEM tire fitments. The enrichment pipeline
 * already writes `trim_specs.tire_options[]` (sourced from wheel-size.com) for
 * enriched vehicles, and the inspection dialog reads that list to populate the
 * tire-size dropdown. This module is the fallback for vehicles that were never
 * enriched (or whose enrichment returned no tire data): when the inspection
 * dialog opens and finds no saved options, it calls `ensureVehicleTireOptions`,
 * which fetches once from wheel-size.com and persists the result so every
 * future booking for that vehicle reuses it — no re-fetch unless the saved
 * value is cleared/re-enriched.
 *
 * Non-fatal throughout: any miss returns a status string and the dropdown
 * falls back to the generic size list.
 */

import { action, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { scrapeWheelSizeOptions } from "./vehicleEnrichment/utils/wheelSizeScraper";

function toCanonicalVin(vin: string): string {
  return vin.trim().toUpperCase();
}

type BookingTireContext = {
  configId: Id<"vehicle_configs"> | null;
  hasOptions: boolean;
};

/**
 * Resolve a booking to its vehicle_config and report whether OEM tire options
 * are already saved. Authorizes the caller as staff of the booking's shop —
 * the wheel-size API is quota-limited, so we don't let arbitrary callers spend
 * it. Runs as an internalQuery invoked from the action; the caller's identity
 * propagates from the action's auth context.
 */
export const resolveBookingTireContext = internalQuery({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, { bookingId }): Promise<BookingTireContext | null> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject))
      .unique();
    if (!user) throw new Error("User not found");

    const booking = await ctx.db.get(bookingId);
    if (!booking || !booking.shop_id) return null;
    const shopId = booking.shop_id;

    // Staff-of-shop gate (active membership OR owner), mirroring the passport query.
    const shopUser = await ctx.db
      .query("shop_users")
      .withIndex("by_user_and_shop", (q) =>
        q.eq("user_id", user._id).eq("shop_id", shopId),
      )
      .first();
    let authorized = !!(shopUser && shopUser.is_active);
    if (!authorized) {
      const ownedShop = await ctx.db
        .query("shops")
        .withIndex("by_owner_user_id", (q) => q.eq("owner_user_id", user._id))
        .filter((q) => q.eq(q.field("_id"), shopId))
        .first();
      authorized = !!ownedShop;
    }
    if (!authorized) throw new Error("Not authorized for this shop");

    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", toCanonicalVin(booking.vin)))
      .unique();
    const configId = vehicle?.vehicle_config_id ?? null;
    if (!configId) return { configId: null, hasOptions: false };

    const spec = await ctx.db
      .query("trim_specs")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", configId))
      .first();
    const hasOptions =
      Array.isArray(spec?.tire_options) && spec!.tire_options!.length > 0;

    return { configId, hasOptions };
  },
});

type EnsureResult = {
  status: "cached" | "fetched" | "no_config" | "no_data";
  count?: number;
};

/**
 * Ensure the vehicle behind `bookingId` has OEM tire options saved. If already
 * present, returns `cached` without touching the API. Otherwise fetches from
 * wheel-size.com and persists to `trim_specs.tire_options` so future bookings
 * reuse it. Safe to call on every dialog open — it self-skips when data exists.
 */
export const ensureVehicleTireOptions = action({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, { bookingId }): Promise<EnsureResult> => {
    const context = await ctx.runQuery(
      internal.tireOptionsLookup.resolveBookingTireContext,
      { bookingId },
    );
    if (!context || !context.configId) return { status: "no_config" };
    if (context.hasOptions) return { status: "cached" };

    const labels = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getVehicleLabels,
      { vehicleConfigId: context.configId },
    );
    if (!labels?.year || !labels?.make || !labels?.model) {
      return { status: "no_data" };
    }

    const wheelResult = await scrapeWheelSizeOptions(
      labels.year,
      labels.make,
      labels.model,
      labels.trim || undefined,
      labels.displacement_l,
    ).catch(() => null);

    if (!wheelResult || wheelResult.tireOptions.length === 0) {
      return { status: "no_data" };
    }

    await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertTrimSpecs, {
      vehicle_config_id: context.configId,
      tire_options: wheelResult.tireOptions,
      tire_options_source: wheelResult.sourceUrl,
    });

    return { status: "fetched", count: wheelResult.tireOptions.length };
  },
});
