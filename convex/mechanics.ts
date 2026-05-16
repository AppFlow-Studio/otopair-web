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

const OWNER_ROLES = new Set(["owner", "shop_owner", "admin"]);
const MECHANIC_ROLES = new Set(["shop_mechanic", "mechanic"]);
const TERMINAL_BOOKING_STATUSES = new Set(["completed", "cancelled", "no_show"]);

async function requireShopOwner(ctx: any, shopId: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");

  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) => q.eq("clerkUserId", identity.subject))
    .unique();
  if (!user) throw new Error("User not found");

  const membership = await ctx.db
    .query("shop_users")
    .withIndex("by_user_and_shop", (q: any) => q.eq("user_id", user._id).eq("shop_id", shopId))
    .filter((q: any) => q.eq(q.field("is_active"), true))
    .first();

  const shop = await ctx.db.get(shopId);
  const isOwner = OWNER_ROLES.has(membership?.role) || String(shop?.owner_user_id ?? "") === String(user._id);
  if (!isOwner) throw new Error("Not authorized");

  return { user, shop };
}

async function getMechanicForOwner(ctx: any, mechanicId: any) {
  const mechanic = await ctx.db.get(mechanicId);
  if (!mechanic) throw new Error("Mechanic not found.");
  await requireShopOwner(ctx, mechanic.shop_id);
  return mechanic;
}

async function resolveMechanicPhotoUrl(ctx: any, photo?: string | null) {
  if (!photo) return null;

  try {
    const asset = await ctx.db.get(photo as any);
    if (asset?.url) return asset.url as string;
  } catch {
    // New mechanic uploads store Convex storage ids directly.
  }

  try {
    return await ctx.storage.getUrl(photo);
  } catch {
    return null;
  }
}

async function getBlockingBookings(ctx: any, mechanicId: any, shopId: any) {
  const bookings = await ctx.db
    .query("bookings")
    .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shopId))
    .collect();

  return bookings
    .filter(
      (booking: any) =>
        String(booking.mechanic_id ?? "") === String(mechanicId) &&
        !TERMINAL_BOOKING_STATUSES.has(booking.status)
    )
    .map((booking: any) => ({
      _id: String(booking._id),
      status: booking.status as string,
      scheduledDate: booking.scheduled_date ?? null,
      scheduledTime: booking.scheduled_time ?? null,
    }));
}

function getPortalStatus(args: {
  activeShopUser: any;
  latestInvitation: any;
  now: number;
}) {
  if (args.activeShopUser) return "active";
  if (!args.latestInvitation) return "not_invited";
  if (
    args.latestInvitation.status === "pending" &&
    args.latestInvitation.expires_at &&
    args.latestInvitation.expires_at <= args.now
  ) {
    return "invite_expired";
  }
  if (args.latestInvitation.status === "pending") return "invite_sent";
  if (args.latestInvitation.status === "expired") return "invite_expired";
  if (args.latestInvitation.status === "revoked") return "invite_revoked";
  if (args.latestInvitation.status === "accepted") return "active";
  return "not_invited";
}

async function buildManagedMechanicRows(ctx: any, shopId: any) {
  await requireShopOwner(ctx, shopId);
  const now = Date.now();

  const mechanics = await ctx.db
    .query("mechanics")
    .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shopId))
    .filter((q: any) => q.neq(q.field("is_active"), false))
    .collect();

  const shopUsers = await ctx.db
    .query("shop_users")
    .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shopId))
    .collect();
  const invitations = await ctx.db
    .query("shop_invitations")
    .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shopId))
    .collect();

  return await Promise.all(
    mechanics.map(async (mechanic: any) => {
      const activeShopUser = shopUsers.find(
        (row: any) =>
          row.is_active &&
          row.mechanic_id &&
          String(row.mechanic_id) === String(mechanic._id)
      );
      const mechanicInvitations = invitations
        .filter(
          (row: any) =>
            row.mechanic_id &&
            String(row.mechanic_id) === String(mechanic._id) &&
            MECHANIC_ROLES.has(row.role)
        )
        .sort((a: any, b: any) => (b.created_at ?? 0) - (a.created_at ?? 0));
      const latestInvitation = mechanicInvitations[0] ?? null;
      const pendingInvitation = mechanicInvitations.find((row: any) => row.status === "pending");
      const blockers = await getBlockingBookings(ctx, mechanic._id, shopId);

      return {
        _id: String(mechanic._id),
        firstName: mechanic.first_name as string,
        lastName: mechanic.last_name as string,
        title: (mechanic.title ?? "") as string,
        email: (mechanic.email ?? latestInvitation?.email ?? "") as string,
        isActive: mechanic.is_active !== false,
        rating: mechanic.rating ?? 0,
        reviewCount: mechanic.review_count ?? 0,
        photoUrl: await resolveMechanicPhotoUrl(ctx, mechanic.photo),
        shopUserId: activeShopUser ? String(activeShopUser._id) : null,
        invitationId: latestInvitation ? String(latestInvitation._id) : null,
        pendingInvitationId: pendingInvitation ? String(pendingInvitation._id) : null,
        invitationStatus: latestInvitation?.status ?? null,
        invitationEmail: latestInvitation?.email ?? null,
        invitationExpiresAt: latestInvitation?.expires_at ?? null,
        portalStatus: getPortalStatus({ activeShopUser, latestInvitation, now }),
        blockingBookings: blockers.slice(0, 5),
        blockingBookingCount: blockers.length,
      };
    })
  );
}

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
        const photoUrl = await resolveMechanicPhotoUrl(ctx, mechanic.photo);
        // Surface the parent shop's aggregate rating/review-count on
        // each mechanic row so the booking sheet's per-shop grouping
        // (MechanicSelectionContent → groupMechanicsByShop) can read
        // the actual shop rating instead of deriving it from the max
        // mechanic rating in the group.
        return {
          ...mechanic,
          shop,
          photoUrl,
          shopRating: shop?.rating ?? 0,
          shopReviewCount: shop?.review_count ?? 0,
        };
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
    const photoUrl = await resolveMechanicPhotoUrl(ctx, mechanic.photo);
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
        const photoUrl = await resolveMechanicPhotoUrl(ctx, mechanic.photo);
        return { ...mechanic, photoUrl };
      }),
    );
  },
});

export const getManagedByShop = query({
  args: { shopId: v.id("shops") },
  handler: async (ctx, args) => {
    return await buildManagedMechanicRows(ctx, args.shopId);
  },
});

function getBookingTimestamp(booking: {
  scheduled_date?: string;
  scheduled_time?: string;
  created_at?: number;
}) {
  if (booking.scheduled_date) {
    const time = booking.scheduled_time ?? "00:00";
    const parsed = new Date(`${booking.scheduled_date}T${time}`).getTime();
    if (!Number.isNaN(parsed)) return parsed;
  }
  return booking.created_at ?? 0;
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
  const photoUrl = await resolveMechanicPhotoUrl(ctx, mechanic.photo);
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
    email: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const mechanicId = await ctx.db.insert("mechanics", {
      shop_id: args.shopId,
      first_name: args.firstName,
      last_name: args.lastName,
      title: args.title,
      email: args.email?.trim().toLowerCase() || undefined,
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

export const createManaged = mutation({
  args: {
    shopId: v.id("shops"),
    firstName: v.string(),
    lastName: v.string(),
    title: v.optional(v.string()),
    email: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireShopOwner(ctx, args.shopId);
    const firstName = args.firstName.trim();
    const lastName = args.lastName.trim();
    if (!firstName || !lastName) throw new Error("Enter both a first and last name.");

    const mechanicId = await ctx.db.insert("mechanics", {
      shop_id: args.shopId,
      first_name: firstName,
      last_name: lastName,
      title: args.title?.trim() || undefined,
      email: args.email?.trim().toLowerCase() || undefined,
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

export const updateManaged = mutation({
  args: {
    mechanicId: v.id("mechanics"),
    firstName: v.string(),
    lastName: v.string(),
    title: v.optional(v.string()),
    email: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const mechanic = await getMechanicForOwner(ctx, args.mechanicId);
    const firstName = args.firstName.trim();
    const lastName = args.lastName.trim();
    if (!firstName || !lastName) throw new Error("Enter both a first and last name.");

    await ctx.db.patch(args.mechanicId, {
      first_name: firstName,
      last_name: lastName,
      title: args.title?.trim() || undefined,
      email: args.email?.trim().toLowerCase() || undefined,
    });

    await syncMechanicAvailabilityWindow(ctx, {
      shopId: mechanic.shop_id,
      mechanicId: args.mechanicId,
    });

    return args.mechanicId;
  },
});

export const updateManagedPhoto = mutation({
  args: {
    mechanicId: v.id("mechanics"),
    profilePhotoStorageId: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    await getMechanicForOwner(ctx, args.mechanicId);
    await ctx.db.patch(args.mechanicId, {
      photo: args.profilePhotoStorageId ?? undefined,
    });
    return {
      mechanicId: args.mechanicId,
      photoUrl: args.profilePhotoStorageId
        ? await resolveMechanicPhotoUrl(ctx, args.profilePhotoStorageId)
        : null,
    };
  },
});

export const getRemovalBlockers = query({
  args: { mechanicId: v.id("mechanics") },
  handler: async (ctx, args) => {
    const mechanic = await getMechanicForOwner(ctx, args.mechanicId);
    return await getBlockingBookings(ctx, args.mechanicId, mechanic.shop_id);
  },
});

export const deactivateManaged = mutation({
  args: { mechanicId: v.id("mechanics") },
  handler: async (ctx, args) => {
    const mechanic = await getMechanicForOwner(ctx, args.mechanicId);
    const blockers = await getBlockingBookings(ctx, args.mechanicId, mechanic.shop_id);
    if (blockers.length > 0) {
      throw new Error("This mechanic has active bookings or jobs that must be completed or reassigned first.");
    }

    await ctx.db.patch(args.mechanicId, { is_active: false });
    await syncMechanicAvailabilityWindow(ctx, {
      shopId: mechanic.shop_id,
      mechanicId: args.mechanicId,
    });
    return args.mechanicId;
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
