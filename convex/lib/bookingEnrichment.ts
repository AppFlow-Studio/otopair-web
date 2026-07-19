// =============================================================================
// Shared booking-reference enrichment — resolves the "which car / which service
// / which shop / which customer" context that ops surfaces (activity feed,
// bookings board, reviews, payments, transactions, oto-ai) all need.
//
// The VIN→make/model/year join is lifted verbatim from opsBookings.detail
// (convex/opsBookings.ts) and bookings.getByUserIdWithDetails so the resolution
// lives in exactly one place. Read-only: takes a QueryCtx and only reads.
//
// Cost note: callers that enrich MANY rows should prefer resolveVehicleDisplay /
// resolveServiceNames directly and batch/dedupe VINs + service ids themselves;
// enrichBookingRefs is the convenience one-shot for a single booking.
// =============================================================================
import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

export type VehicleDisplay = {
  vin: string | null;
  /** "2021 Toyota Camry" — falls back to the VIN, then null. */
  ymm: string | null;
  imageUrl: string | null;
};

export type BookingRefs = {
  userId: Id<"users">;
  userName: string;
  shopId: Id<"shops"> | null;
  shopName: string | null;
  vehicle: VehicleDisplay;
  serviceNames: string[];
};

/** Human display name for a user doc, matching the ops convention. */
export function userDisplayName(user: Doc<"users"> | null): string {
  if (!user) return "Unknown";
  return (
    `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim() ||
    user.email ||
    "Unknown"
  );
}

/** Resolve a VIN to a year/make/model string + image. Null vin → empty display. */
export async function resolveVehicleDisplay(
  ctx: QueryCtx,
  vin: string | null | undefined,
): Promise<VehicleDisplay> {
  if (!vin) return { vin: null, ymm: null, imageUrl: null };
  const veh = await ctx.db
    .query("vehicles")
    .withIndex("by_vin", (q) => q.eq("vin", vin))
    .first();
  if (!veh) return { vin, ymm: null, imageUrl: null };

  let make = "";
  let model = "";
  if (veh.trim_id) {
    const trim = await ctx.db.get(veh.trim_id);
    if (trim) {
      const m = await ctx.db.get(trim.model_id);
      if (m) {
        model = m.name ?? "";
        const mk = await ctx.db.get(m.make_id);
        if (mk) make = mk.name ?? "";
      }
    }
  }
  const ymm = [veh.year, make, model].filter(Boolean).join(" ") || veh.vin;
  return { vin, ymm, imageUrl: veh.image_url ?? null };
}

/** Resolve a vehicles doc id (not a VIN) to a year/make/model display. Used
 *  where the FK is a vehicle id — e.g. ai_conversations.vehicle_id. */
export async function resolveVehicleDisplayById(
  ctx: QueryCtx,
  vehicleId: Id<"vehicles"> | null | undefined,
): Promise<VehicleDisplay> {
  if (!vehicleId) return { vin: null, ymm: null, imageUrl: null };
  const veh = await ctx.db.get(vehicleId);
  if (!veh) return { vin: null, ymm: null, imageUrl: null };
  let make = "";
  let model = "";
  if (veh.trim_id) {
    const trim = await ctx.db.get(veh.trim_id);
    if (trim) {
      const m = await ctx.db.get(trim.model_id);
      if (m) {
        model = m.name ?? "";
        const mk = await ctx.db.get(m.make_id);
        if (mk) make = mk.name ?? "";
      }
    }
  }
  const ymm = [veh.year, make, model].filter(Boolean).join(" ") || veh.vin;
  return { vin: veh.vin ?? null, ymm, imageUrl: veh.image_url ?? null };
}

/** Resolve booking.service_ids to display names (missing → "—"). */
export async function resolveServiceNames(
  ctx: QueryCtx,
  serviceIds: ReadonlyArray<Id<"services">>,
): Promise<string[]> {
  return Promise.all(
    serviceIds.map(async (sid) => {
      const s = await ctx.db.get(sid);
      return s?.name ?? "—";
    }),
  );
}

/**
 * One-shot enrichment for a single booking: customer, shop, vehicle (YMM +
 * image), and service names. Use for feed items / single cards. For large row
 * sets, resolve pieces directly and batch to avoid N sequential joins.
 */
export async function enrichBookingRefs(
  ctx: QueryCtx,
  booking: Doc<"bookings">,
): Promise<BookingRefs> {
  const [user, shop, vehicle, serviceNames] = await Promise.all([
    ctx.db.get(booking.user_id),
    booking.shop_id ? ctx.db.get(booking.shop_id) : null,
    resolveVehicleDisplay(ctx, booking.vin),
    resolveServiceNames(ctx, booking.service_ids),
  ]);
  return {
    userId: booking.user_id,
    userName: userDisplayName(user),
    shopId: booking.shop_id ?? null,
    shopName: shop?.name ?? null,
    vehicle,
    serviceNames,
  };
}
