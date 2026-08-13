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

/**
 * Make/model/trim read from vehicles.metadata — the blob where MANUALLY-INPUT
 * vehicles store year/make/model (they have no resolved trim_id, so the
 * trim_id → trims → models → makes walk yields nothing and the display
 * collapses to year-only). Tolerates the `Make`/`make` casing seen across
 * writers (see convex/invoices.ts) and a non-object/absent metadata value.
 * The single source of the fallback so every YMM builder can share it.
 */
export function metaMakeModel(metadata: unknown): {
  make: string;
  model: string;
  trim: string;
} {
  const m =
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>)
      : {};
  const s = (x: unknown): string => (typeof x === "string" ? x : "");
  return {
    make: s(m.make ?? m.Make),
    model: s(m.model ?? m.Model),
    trim: s(m.trim ?? m.Trim),
  };
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
  // Manually-input vehicles carry make/model on metadata, not a trim_id chain.
  if (!make || !model) {
    const meta = metaMakeModel(veh.metadata);
    if (!make) make = meta.make;
    if (!model) model = meta.model;
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
  // Manually-input vehicles carry make/model on metadata, not a trim_id chain.
  if (!make || !model) {
    const meta = metaMakeModel(veh.metadata);
    if (!make) make = meta.make;
    if (!model) model = meta.model;
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

/** A review row enriched with the "who / which car / which service" context
 *  every review surface (mechanic detail, network reviews, shop insights) needs.
 *  Shape is identical across those callers so the UI can share a renderer. */
export type EnrichedReview = {
  id: string;
  rating: number;
  comment: string | null;
  reviewer: string | null;
  reviewer_id: string;
  mechanic: string | null;
  mechanic_id: string | null;
  booking_id: string;
  vehicle: { ymm: string | null; imageUrl: string | null };
  service_names: string[];
  hidden: boolean;
  hidden_reason: string | null;
  hidden_by: string | null;
  at: number;
};

/**
 * Batch-enrich a set of review docs. Dedupes user_id, mechanic_id, booking_id,
 * VIN, and service_ids across the whole set so a page of N reviews issues one
 * lookup per DISTINCT entity, not N sequential joins (see the cost note above).
 * The single hot path is /shops/reviews (9 shops × ≤200 rows).
 */
export async function enrichReviews(
  ctx: QueryCtx,
  reviews: ReadonlyArray<Doc<"reviews">>,
): Promise<EnrichedReview[]> {
  // 1. Distinct ids across the set.
  const userIds = new Set(reviews.map((r) => String(r.user_id)));
  const mechIds = new Set(
    reviews.filter((r) => r.mechanic_id).map((r) => String(r.mechanic_id)),
  );
  const bookingIds = new Set(reviews.map((r) => String(r.booking_id)));

  // 2. Resolve users + mechanics once each.
  const userName = new Map<string, string>();
  const mechName = new Map<string, string | null>();
  const bookingInfo = new Map<
    string,
    { vin: string | null; serviceIds: Id<"services">[] }
  >();
  await Promise.all([
    ...[...userIds].map(async (id) => {
      userName.set(id, userDisplayName(await ctx.db.get(id as Id<"users">)));
    }),
    ...[...mechIds].map(async (id) => {
      const m = (await ctx.db.get(id as Id<"mechanics">)) as {
        first_name?: string;
        last_name?: string;
      } | null;
      mechName.set(
        id,
        m ? [m.first_name, m.last_name].filter(Boolean).join(" ") || null : null,
      );
    }),
    ...[...bookingIds].map(async (id) => {
      const b = await ctx.db.get(id as Id<"bookings">);
      bookingInfo.set(id, {
        vin: b?.vin ?? null,
        serviceIds: b?.service_ids ?? [],
      });
    }),
  ]);

  // 3. From the resolved bookings, resolve each DISTINCT vin + service once.
  const vins = new Set<string>();
  const svcIds = new Set<string>();
  for (const info of bookingInfo.values()) {
    if (info.vin) vins.add(info.vin);
    for (const s of info.serviceIds) svcIds.add(String(s));
  }
  const vehByVin = new Map<string, VehicleDisplay>();
  const svcNameById = new Map<string, string>();
  await Promise.all([
    ...[...vins].map(async (vin) => {
      vehByVin.set(vin, await resolveVehicleDisplay(ctx, vin));
    }),
    ...[...svcIds].map(async (sid) => {
      const s = await ctx.db.get(sid as Id<"services">);
      svcNameById.set(sid, s?.name ?? "—");
    }),
  ]);

  // 4. Assemble — pure map lookups, no further db reads.
  return reviews.map((r) => {
    const info = bookingInfo.get(String(r.booking_id));
    const veh = info?.vin ? vehByVin.get(info.vin) : undefined;
    return {
      id: String(r._id),
      rating: r.rating,
      comment: r.comment ?? null,
      reviewer: userName.get(String(r.user_id)) ?? null,
      reviewer_id: String(r.user_id),
      mechanic: r.mechanic_id ? (mechName.get(String(r.mechanic_id)) ?? null) : null,
      mechanic_id: r.mechanic_id ? String(r.mechanic_id) : null,
      booking_id: String(r.booking_id),
      vehicle: { ymm: veh?.ymm ?? null, imageUrl: veh?.imageUrl ?? null },
      service_names: info?.serviceIds.map((s) => svcNameById.get(String(s)) ?? "—") ?? [],
      hidden: r.hidden_at != null,
      hidden_reason: r.hidden_reason ?? null,
      hidden_by: r.hidden_by ?? null,
      at: r.created_at ?? r._creationTime,
    };
  });
}
