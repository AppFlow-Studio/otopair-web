/**
 * mechanics.ts - Mechanic/Technician Management
 *
 * DESCRIPTION:
 * Manages mechanic/technician staff at service shops.
 * Tracks individual mechanics and their qualifications, ratings, and availability.
 *
 * TABLE: mechanics
 *   - Stores mechanic profiles and performance data
 *   - Belongs to one shop (shop_id)
 *   - Can be assigned to time slots and bookings
 *   - Has aggregated ratings from customer reviews
 *
 * KEY RELATIONSHIPS:
 *   - Belongs-to: shop (via shop_id)
 *   - Has-many: bookings (via mechanic_id)
 *   - Has-many: job_actuals (via mechanic_id)
 *   - Has-many: time_slots (via mechanic_id)
 *   - Has-many: reviews (via mechanic_id)
 *
 * USE CASES:
 *   1. Display available mechanics at a shop
 *   2. Show mechanic ratings and reviews
 *   3. Assign mechanics to bookings
 *   4. Filter by active/inactive status
 *   5. Track mechanic performance metrics
 *
 * OWNER: Shop Management Team
 */

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { syncMechanicAvailabilityWindow } from "./lib/timeSlotAvailability";

/**
 * QUERY: list
 * Returns all mechanics with related shop data.
 * Use with caution - consider filtering by shop in production.
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const mechanics = await ctx.db.query("mechanics").collect();
    return await Promise.all(
      mechanics.map(async (mechanic) => {
        const shop = await ctx.db.get(mechanic.shop_id);
        const photoUrl = mechanic.photo ? (await ctx.db.get(mechanic.photo))?.url : undefined;
        return { ...mechanic, shop, photoUrl };
      }),
    );
  },
});

/**
 * QUERY: getById
 * Fetch a specific mechanic by ID with shop info.
 *
 * ARGS:
 *   - id: Mechanic ID
 *
 * RETURNS:
 *   {
 *     _id: mechanic id,
 *     first_name: string,
 *     last_name: string,
 *     shop_id: id,
 *     is_active: boolean,
 *     rating: number (0-5),
 *     review_count: number,
 *     shop: { name, address, ... }
 *   }
 */
export const getById = query({
  args: { id: v.id("mechanics") },
  handler: async (ctx, args) => {
    const mechanic = await ctx.db.get(args.id);
    if (!mechanic) {
      return null;
    }
    const shop = await ctx.db.get(mechanic.shop_id);
    const photoUrl = mechanic.photo ? (await ctx.db.get(mechanic.photo))?.url : undefined;
    return { ...mechanic, shop, photoUrl };
  },
});

/**
 * QUERY: getByShopId
 * Get all active mechanics at a specific shop.
 * Returns only active mechanics (is_active=true).
 *
 * ARGS:
 *   - shopId: Shop ID
 *
 * RETURNS: Array of active mechanics at shop
 *
 * EXAMPLE:
 *   Get mechanics available for booking at shop
 */
export const getByShopId = query({
  args: { shopId: v.id("shops") },
  handler: async (ctx, args) => {
    const mechanics = await ctx.db
      .query("mechanics")
      .filter((q) => q.and(q.eq(q.field("shop_id"), args.shopId), q.eq(q.field("is_active"), true)))
      .collect();
    return await Promise.all(
      mechanics.map(async (mechanic) => {
        const photoUrl = mechanic.photo ? (await ctx.db.get(mechanic.photo))?.url : undefined;
        return { ...mechanic, photoUrl };
      }),
    );
  },
});

function getBookingTimestamp(booking: { scheduled_date?: string; scheduled_time?: string; created_at: number }) {
  if (booking.scheduled_date) {
    const time = booking.scheduled_time ?? "00:00";
    const parsed = new Date(`${booking.scheduled_date}T${time}`).getTime();
    if (!Number.isNaN(parsed)) return parsed;
  }
  return booking.created_at;
}

function formatVisitLabel(bookingTs: number): string {
  if (bookingTs > Date.now()) return "Upcoming";
  const diffMs = Date.now() - bookingTs;
  const days = Math.max(0, Math.floor(diffMs / (24 * 60 * 60 * 1000)));
  if (days < 7) return "this week";
  if (days < 14) return "1 week ago";
  if (days < 21) return "2 weeks ago";
  if (days < 30) return "3 weeks ago";
  const months = Math.max(1, Math.round(days / 30));
  return months === 1 ? "1 month ago" : `${months} months ago`;
}

function normalizeName(name: string) {
  return name.trim().toLowerCase();
}

function dedupeByName<T extends { name: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = normalizeName(item.name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function buildMechanicCard(
  ctx: any,
  mechanicId: string,
  lastVisitLabel: string | undefined,
  isPreferred: boolean,
) {
  const mechanic = await ctx.db.get(mechanicId as any);
  if (!mechanic) return null;
  const shop = await ctx.db.get(mechanic.shop_id);
  const photoUrl = mechanic.photo ? (await ctx.db.get(mechanic.photo))?.url : undefined;
  const mechanicName = `${mechanic.first_name} ${mechanic.last_name}`.trim();
  const initials = `${mechanic.first_name?.[0] ?? ""}${mechanic.last_name?.[0] ?? ""}`.toUpperCase();
  const displayName = shop?.name ?? (mechanicName.length > 0 ? mechanicName : "Mechanic");
  return {
    id: mechanic._id as string,
    name: displayName,
    image: photoUrl,
    initials: initials.length > 0 ? initials : "M",
    lastVisit: lastVisitLabel,
    isPreferred,
  };
}

/**
 * QUERY: getMyMechanicsForUser
 * Returns data for My Mechanics screen:
 *   - favorites (preferences source)
 *   - recentlyBooked (bookings history source)
 *   - hidden (preferences source)
 */
export const getMyMechanicsForUser = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const prefs = await ctx.db
      .query("user_mechanic_preferences")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .collect();

    const favoriteIds = new Set(
      prefs.filter((p) => p.is_favorite).map((p) => p.mechanic_id as string),
    );
    const hiddenIds = new Set(
      prefs.filter((p) => p.is_hidden).map((p) => p.mechanic_id as string),
    );

    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .collect();

    const eligible = bookings
      .filter(
        (b) =>
          b.mechanic_id != null &&
          !["cancelled", "no_show"].includes(b.status),
      )
      .sort((a, b) => getBookingTimestamp(b) - getBookingTimestamp(a));

    // mechanic_id -> latest booking metadata
    const latestByMechanic = new Map<string, { timestamp: number; label: string }>();
    for (const booking of eligible) {
      const mechanicId = booking.mechanic_id as string;
      if (!latestByMechanic.has(mechanicId)) {
        const bookingTs = getBookingTimestamp(booking);
        latestByMechanic.set(mechanicId, {
          timestamp: bookingTs,
          label: formatVisitLabel(bookingTs),
        });
      }
    }

    const recentIds = [...latestByMechanic.keys()];

    // Include all IDs needed across sections so hidden/favorites can render even without booking history.
    const allMechanicIds = new Set<string>([
      ...recentIds,
      ...favoriteIds,
      ...hiddenIds,
    ]);

    const cardsById = new Map<string, any>();
    for (const mechanicId of allMechanicIds) {
      const card = await buildMechanicCard(
        ctx as any,
        mechanicId,
        latestByMechanic.get(mechanicId)?.label,
        favoriteIds.has(mechanicId),
      );
      if (card) cardsById.set(mechanicId, card);
    }

    const favoriteIdsOrdered = [...favoriteIds].sort(
      (a, b) =>
        (latestByMechanic.get(b)?.timestamp ?? 0) -
        (latestByMechanic.get(a)?.timestamp ?? 0),
    );

    const favorites = dedupeByName(
      favoriteIdsOrdered
      .filter((id) => !hiddenIds.has(id))
      .map((id) => cardsById.get(id))
      .filter(Boolean),
    );

    const favoriteNames = new Set(favorites.map((m) => normalizeName(m.name)));

    const recentlyBooked = dedupeByName(
      recentIds
      .filter((id) => !hiddenIds.has(id) && !favoriteIds.has(id))
      .map((id) => cardsById.get(id))
      .filter((m) => Boolean(m) && !favoriteNames.has(normalizeName(m.name))),
    );

    const hidden = dedupeByName(
      [...hiddenIds]
      .map((id) => cardsById.get(id))
      .filter(Boolean),
    );

    return {
      favorites,
      recentlyBooked,
      hidden,
    };
  },
});

/**
 * MUTATION: setFavoriteForUser
 * Upserts favorite preference for one user+mechanic.
 */
export const setFavoriteForUser = mutation({
  args: {
    userId: v.id("users"),
    mechanicId: v.id("mechanics"),
    isFavorite: v.boolean(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("user_mechanic_preferences")
      .withIndex("by_user_mechanic", (q) =>
        q.eq("user_id", args.userId).eq("mechanic_id", args.mechanicId),
      )
      .unique();

    const now = Date.now();
    if (!existing) {
      await ctx.db.insert("user_mechanic_preferences", {
        user_id: args.userId,
        mechanic_id: args.mechanicId,
        is_favorite: args.isFavorite,
        is_hidden: false,
        updated_at: now,
      });
      return { success: true };
    }

    await ctx.db.patch(existing._id, {
      is_favorite: args.isFavorite,
      // Favoriting and hiding are mutually exclusive states.
      is_hidden: args.isFavorite ? false : existing.is_hidden,
      updated_at: now,
    });
    return { success: true };
  },
});

/**
 * MUTATION: setHiddenForUser
 * Upserts hidden preference for one user+mechanic.
 */
export const setHiddenForUser = mutation({
  args: {
    userId: v.id("users"),
    mechanicId: v.id("mechanics"),
    isHidden: v.boolean(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("user_mechanic_preferences")
      .withIndex("by_user_mechanic", (q) =>
        q.eq("user_id", args.userId).eq("mechanic_id", args.mechanicId),
      )
      .unique();

    const now = Date.now();
    if (!existing) {
      await ctx.db.insert("user_mechanic_preferences", {
        user_id: args.userId,
        mechanic_id: args.mechanicId,
        is_favorite: false,
        is_hidden: args.isHidden,
        updated_at: now,
      });
      return { success: true };
    }

    await ctx.db.patch(existing._id, {
      is_hidden: args.isHidden,
      // Favoriting and hiding are mutually exclusive states.
      is_favorite: args.isHidden ? false : existing.is_favorite,
      updated_at: now,
    });
    return { success: true };
  },
});

export const create = mutation({
  args: {
    shopId: v.id("shops"),
    firstName: v.string(),
    lastName: v.string(),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const mechanicId = await ctx.db.insert("mechanics", {
      shop_id: args.shopId,
      first_name: args.firstName,
      last_name: args.lastName,
      title: args.title,
      is_active: true,
      rating: 0,
      review_count: 0,
    });

    await syncMechanicAvailabilityWindow(ctx, {
      shopId: args.shopId,
      mechanicId,
    });

    return mechanicId;
  },
});

export const getByShop = query({
  args: { shopId: v.id("shops") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("mechanics")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
      .collect();
  },
});
