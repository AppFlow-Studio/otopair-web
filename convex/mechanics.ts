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
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import {
  QUOTE_HOLD_BOOKING_STATUSES,
  syncMechanicAvailabilityWindow,
} from "./lib/timeSlotAvailability";
import { getBookableShopIds } from "../lib/bookableShop";
import {
  getActiveBookingsByMechanic,
  reassignActiveBookingsAwayFromMechanic,
  type MechanicRemovalSubject,
} from "./bookings";
import { throwBookingError } from "./lib/bookingErrors";

const OWNER_ROLES = new Set(["owner", "shop_owner", "admin"]);
const MECHANIC_ROLES = new Set(["shop_mechanic", "mechanic"]);

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

/** Local copy of shops.ts's resolver — same convention this file already uses
 *  for `resolveMechanicPhotoUrl`: small ctx-helpers are duplicated rather than
 *  exported across modules. */
async function resolveShopLogoUrl(ctx: any, shop: any): Promise<string | null> {
  if (!shop?.logo_storage_id) return null;
  return await ctx.storage.getUrl(shop.logo_storage_id);
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

/**
 * The bookings removing this mechanic would move, in the shape the Team page
 * lists them. `activeByMechanic` is getActiveBookingsByMechanic's map — the
 * same set reassignActiveBookingsAwayFromMechanic moves.
 */
function toBlockingBookings(
  activeByMechanic: Map<string, Doc<"bookings">[]>,
  mechanicId: Id<"mechanics">,
) {
  return (activeByMechanic.get(String(mechanicId)) ?? []).map((booking) => ({
    _id: String(booking._id),
    status: booking.status as string,
    scheduledDate: booking.scheduled_date ?? null,
    scheduledTime: booking.scheduled_time ?? null,
  }));
}

type MechanicNameFields = Pick<Doc<"mechanics">, "first_name" | "last_name" | "entity_type">;

/** Refusal copy subject for a shop removing someone else's row. */
export function removalSubjectFor(mechanic: MechanicNameFields): {
  name: string;
  kind: "mechanic" | "bay";
} {
  const kind = mechanic.entity_type === "bay" ? "bay" : "mechanic";
  const name = [mechanic.first_name, mechanic.last_name]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join(" ");
  return { name: name || (kind === "bay" ? "This bay" : "This mechanic"), kind };
}

/**
 * Refuse a removal the caller didn't consent to move bookings for. Old portal
 * builds never send `reassignBookings`, so for them this keeps today's
 * behaviour — only now as a typed error that names the count (bug #397).
 */
export async function assertNoActiveBookingsForRemoval(
  ctx: QueryCtx,
  { shopId, mechanic }: { shopId: Id<"shops">; mechanic: Doc<"mechanics"> },
) {
  const active = (await getActiveBookingsByMechanic(ctx, shopId)).get(String(mechanic._id)) ?? [];
  if (active.length === 0) return;
  const subject = removalSubjectFor(mechanic);
  const count = active.length;
  throwBookingError(
    "MECHANIC_HAS_ACTIVE_JOB",
    `${subject.name} has ${count} active booking${count === 1 ? "" : "s"} or job${count === 1 ? "" : "s"}. Complete or reassign ${count === 1 ? "it" : "them"} before removing this ${subject.kind}.`,
    {
      reason: "active_bookings",
      mechanicId: String(mechanic._id),
      activeBookingCount: count,
      attemptedAction: "remove_mechanic",
    },
  );
}

/**
 * Take a mechanic (or bay) off the team — the one routine behind "Remove
 * mechanic" on the Team page, the setup wizard, and an owner removing their
 * own row (bug #397). All in the caller's mutation, so a refusal rolls
 * everything back:
 *   1. Move every active booking to someone free at the same time, or unassign
 *      it (reassignActiveBookingsAwayFromMechanic — refuses on a job in
 *      progress or when nobody is free for an upcoming booking).
 *   2. Deactivate the profile and unlink every shop_users row pointing at it,
 *      deactivating a mechanic-role login outright (never the shop owner's),
 *      and revoke any pending invite for it.
 *   3. Drop what still pins the mechanic: checkout slot holds (their consume
 *      would fail), the mechanic on open tire/rotor quotes (accepting would
 *      fail with "Requested mechanic is unavailable"), and the mechanic on the
 *      moved bookings' message tickets (so replies reach the new mechanic).
 */
export async function retireMechanic(
  ctx: MutationCtx,
  {
    shopId,
    mechanicId,
    subject,
  }: { shopId: Id<"shops">; mechanicId: Id<"mechanics">; subject?: MechanicRemovalSubject },
): Promise<{ reassigned: number; unassigned: number }> {
  const { reassigned, unassigned, moves } = await reassignActiveBookingsAwayFromMechanic(ctx, {
    shopId,
    mechanicId,
    subject,
  });
  const now = Date.now();

  await ctx.db.patch(mechanicId, { is_active: false });

  // A mechanic-role login loses its membership here, in the same commit: left
  // active with no mechanic_id it would read as shop-wide (see
  // getCurrentNotificationScope) until the client's separate login removal
  // ran — and that call can fail. Owner / admin / front-desk logins, and the
  // shop owner's own row, only lose the link: they keep running the shop.
  const shop = await ctx.db.get(shopId);
  const shopUsers = await ctx.db
    .query("shop_users")
    .withIndex("by_shop_id", (q) => q.eq("shop_id", shopId))
    .collect();
  for (const row of shopUsers) {
    if (row.mechanic_id !== mechanicId) continue;
    const retireLogin =
      MECHANIC_ROLES.has(row.role) &&
      String(row.user_id) !== String(shop?.owner_user_id ?? "");
    await ctx.db.patch(row._id, {
      mechanic_id: undefined,
      ...(retireLogin ? { is_active: false } : {}),
      updated_at: now,
    });
  }

  // A pending invite for this profile is revoked in the same commit too: the
  // retired row drops off every Team / setup list, so nobody could revoke it
  // later, and acceptIfInvited would still let the invitee in. The client's
  // /api/revoke-invite call still revokes the Clerk side (idempotent here).
  const invitations = await ctx.db
    .query("shop_invitations")
    .withIndex("by_shop_id", (q) => q.eq("shop_id", shopId))
    .collect();
  for (const invitation of invitations) {
    if (invitation.mechanic_id === mechanicId && invitation.status === "pending") {
      await ctx.db.patch(invitation._id, { status: "revoked" });
    }
  }

  await syncMechanicAvailabilityWindow(ctx, { shopId, mechanicId });

  const slotHolds = await ctx.db
    .query("slot_holds")
    .withIndex("by_shop_and_date", (q) => q.eq("shop_id", shopId))
    .collect();
  for (const hold of slotHolds) {
    if (hold.mechanic_id === mechanicId) {
      await ctx.db.delete(hold._id);
    }
  }

  // An open quote: not withdrawn, not superseded, and its request still
  // awaiting a quote. The accepted response is never superseded (only its
  // siblings are), so the request's status is what sets it apart — its
  // mechanic is history the Schedule and notifications still read.
  const requestAwaitingQuote = new Map<string, boolean>();
  const isOpenQuotePinnedHere = async (response: {
    booking_id: Id<"bookings">;
    mechanic_id?: Id<"mechanics">;
    cancelled_at?: number;
    superseded_at?: number;
  }) => {
    if (
      response.mechanic_id !== mechanicId ||
      response.cancelled_at != null ||
      response.superseded_at != null
    ) {
      return false;
    }
    const key = String(response.booking_id);
    let awaiting = requestAwaitingQuote.get(key);
    if (awaiting === undefined) {
      const request = await ctx.db.get(response.booking_id);
      awaiting = !!request && QUOTE_HOLD_BOOKING_STATUSES.has(request.status);
      requestAwaitingQuote.set(key, awaiting);
    }
    return awaiting;
  };
  const tireQuotes = await ctx.db
    .query("tire_quote_responses")
    .withIndex("by_shop_id", (q) => q.eq("shop_id", shopId))
    .collect();
  for (const response of tireQuotes) {
    if (await isOpenQuotePinnedHere(response)) {
      await ctx.db.patch(response._id, { mechanic_id: undefined });
    }
  }
  const rotorQuotes = await ctx.db
    .query("rotor_quote_responses")
    .withIndex("by_shop_id", (q) => q.eq("shop_id", shopId))
    .collect();
  for (const response of rotorQuotes) {
    if (await isOpenQuotePinnedHere(response)) {
      await ctx.db.patch(response._id, { mechanic_id: undefined });
    }
  }

  for (const move of moves) {
    const tickets = await ctx.db
      .query("shop_tickets")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", move.bookingId))
      .collect();
    for (const ticket of tickets) {
      if (ticket.mechanic_id === mechanicId) {
        await ctx.db.patch(ticket._id, { mechanic_id: move.mechanicId });
      }
    }
  }

  return { reassigned, unassigned };
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
  // An accepted invite only means a login while its shop_users row is active.
  // Once portal access is removed the row must say so and offer a re-invite
  // (bug #397). An owner closing out the invite on their behalf never created
  // a login, and keeps its old reading.
  if (args.latestInvitation.status === "accepted") {
    return args.latestInvitation.accepted_by_admin ? "active" : "not_invited";
  }
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
  const activeByMechanic = await getActiveBookingsByMechanic(ctx, shopId);

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
      const blockers = toBlockingBookings(activeByMechanic, mechanic._id);

      return {
        _id: String(mechanic._id),
        firstName: mechanic.first_name as string,
        lastName: mechanic.last_name as string,
        title: (mechanic.title ?? "") as string,
        email: (mechanic.email ?? latestInvitation?.email ?? "") as string,
        entityType: (mechanic.entity_type === "bay" ? "bay" : "mechanic") as "bay" | "mechanic",
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
    const shops = await ctx.db.query("shops").collect();
    const bookableShopIds = await getBookableShopIds(ctx, shops);
    const mechanics = (await ctx.db.query("mechanics").collect()).filter(
      (mechanic) => mechanic.is_active !== false,
    );
    const rows = await Promise.all(
      mechanics.map(async (mechanic) => {
        if (!bookableShopIds.has(mechanic.shop_id)) return null;
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
    return rows.filter((row) => row != null);
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
  const mechanicName = `${mechanic.first_name} ${mechanic.last_name}`.trim();

  // The card's TITLE is the shop name when there is a shop, so the avatar has
  // to be the shop's too. It used to pair the shop name with the mechanic's
  // photo and initials, which read as a mismatch — "JB" next to "Chelala
  // Service Center" (Ahmad, 2026-09-24). Shop logo, shop initials; the
  // mechanic's own photo/initials only when this card is falling back to
  // naming the mechanic.
  const showingShop = Boolean(shop?.name);
  const displayName = shop?.name ?? (mechanicName.length > 0 ? mechanicName : "Mechanic");

  const image = showingShop
    ? await resolveShopLogoUrl(ctx, shop)
    : await resolveMechanicPhotoUrl(ctx, mechanic.photo);

  // Initials from whatever name is on the card: "Chelala Service Center" → CS,
  // "James Bond" → JB. Two words max so a long shop name doesn't overflow.
  const initialsSource = showingShop ? String(shop.name) : mechanicName;
  const initials = initialsSource
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word: string) => word[0] ?? "")
    .join("")
    .toUpperCase();

  return {
    id: mechanic._id as string,
    name: displayName,
    image,
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
    entityType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireShopOwner(ctx, args.shopId);
    const entityType = args.entityType === "bay" ? "bay" : "mechanic";
    const firstName = args.firstName.trim();
    const lastName = args.lastName.trim();
    if (!firstName) throw new Error(entityType === "bay" ? "Enter a bay name." : "Enter a first name.");

    const mechanicId = await ctx.db.insert("mechanics", {
      shop_id: args.shopId,
      first_name: firstName,
      last_name: lastName,
      title: args.title?.trim() || undefined,
      email: args.email?.trim().toLowerCase() || undefined,
      is_active: true,
      rating: 0,
      review_count: 0,
      entity_type: entityType,
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
    entityType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const mechanic = await getMechanicForOwner(ctx, args.mechanicId);
    const entityType =
      args.entityType === "bay" || args.entityType === "mechanic"
        ? args.entityType
        : mechanic.entity_type === "bay"
          ? "bay"
          : "mechanic";
    const firstName = args.firstName.trim();
    const lastName = args.lastName.trim();
    if (!firstName) throw new Error(entityType === "bay" ? "Enter a bay name." : "Enter a first name.");

    await ctx.db.patch(args.mechanicId, {
      first_name: firstName,
      last_name: lastName,
      title: args.title?.trim() || undefined,
      email: args.email?.trim().toLowerCase() || undefined,
      entity_type: entityType,
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
    return toBlockingBookings(
      await getActiveBookingsByMechanic(ctx, mechanic.shop_id),
      args.mechanicId,
    );
  },
});

/**
 * MUTATION: deactivateManaged
 * "Remove mechanic" / "Remove bay" on the Team page. With `reassignBookings`
 * (the owner confirmed "Reassign & remove"), their active bookings move to
 * whoever is free at the same time before the profile is retired; without it
 * the removal is refused while any are left (typed MECHANIC_HAS_ACTIVE_JOB).
 */
export const deactivateManaged = mutation({
  args: {
    mechanicId: v.id("mechanics"),
    // Optional so portal builds that predate it keep the refusal.
    reassignBookings: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const mechanic = await getMechanicForOwner(ctx, args.mechanicId);
    if (!args.reassignBookings) {
      await assertNoActiveBookingsForRemoval(ctx, { shopId: mechanic.shop_id, mechanic });
    }

    const { reassigned, unassigned } = await retireMechanic(ctx, {
      shopId: mechanic.shop_id,
      mechanicId: args.mechanicId,
      subject: removalSubjectFor(mechanic),
    });
    return { mechanicId: args.mechanicId, reassigned, unassigned };
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

/**
 * MUTATION: enableSelfAsMechanic
 * Lets a shop owner opt into being a schedulable mechanic. Creates (or
 * reactivates) a mechanics row tied to their own user record and links their
 * shop_users membership to it via mechanic_id, so they show up as a lane on the
 * Schedule and can be assigned bookings like any other mechanic.
 */
export const enableSelfAsMechanic = mutation({
  args: { shopId: v.id("shops") },
  handler: async (ctx, args) => {
    const { user } = await requireShopOwner(ctx, args.shopId);
    const now = Date.now();

    const firstName =
      (user.first_name ?? "").trim() ||
      (user.email ? String(user.email).split("@")[0] : "") ||
      "Owner";
    const lastName = (user.last_name ?? "").trim();
    const email = user.email ? String(user.email).trim().toLowerCase() : undefined;

    const membership = await ctx.db
      .query("shop_users")
      .withIndex("by_user_and_shop", (q: any) =>
        q.eq("user_id", user._id).eq("shop_id", args.shopId),
      )
      .first();

    // Resolve which mechanics row to (re)use, in priority order, so repeated
    // opt-in/opt-out never accumulates duplicate profiles:
    //   1. an existing self-mechanic tied to this user
    //   2. a mechanic the owner's membership already points at (e.g. one they
    //      set up manually via "Add mechanic" then deactivated) — adopt it
    //   3. otherwise create a fresh profile
    let mechanic = await ctx.db
      .query("mechanics")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", user._id))
      .filter((q: any) => q.eq(q.field("shop_id"), args.shopId))
      .first();

    if (!mechanic && membership?.mechanic_id) {
      const linked = await ctx.db.get(membership.mechanic_id);
      if (
        linked &&
        String(linked.shop_id) === String(args.shopId) &&
        linked.entity_type !== "bay"
      ) {
        mechanic = linked;
      }
    }

    let mechanicId;
    if (mechanic) {
      await ctx.db.patch(mechanic._id, {
        is_active: true,
        user_id: user._id,
        first_name: firstName,
        last_name: lastName,
        email: email ?? mechanic.email,
        entity_type: "mechanic",
      });
      mechanicId = mechanic._id;
    } else {
      mechanicId = await ctx.db.insert("mechanics", {
        shop_id: args.shopId,
        user_id: user._id,
        first_name: firstName,
        last_name: lastName,
        title: "Owner",
        email,
        is_active: true,
        rating: 0,
        review_count: 0,
        entity_type: "mechanic",
      });
    }

    // Link (or create) the owner's shop membership so getMyPortalAccess resolves
    // their own swim lane and the Schedule can highlight/default to it.
    if (membership) {
      await ctx.db.patch(membership._id, {
        mechanic_id: mechanicId,
        is_active: true,
        updated_at: now,
      });
    } else {
      await ctx.db.insert("shop_users", {
        shop_id: args.shopId,
        user_id: user._id,
        role: "shop_owner",
        mechanic_id: mechanicId,
        is_active: true,
        invited_at: now,
        accepted_at: now,
        created_at: now,
        updated_at: now,
      });
    }

    await syncMechanicAvailabilityWindow(ctx, {
      shopId: args.shopId,
      mechanicId,
    });

    return mechanicId;
  },
});

/**
 * MUTATION: disableSelfAsMechanic
 * Reverses enableSelfAsMechanic: deactivates the owner's mechanic profile and
 * unlinks it from their membership so they drop off the Schedule. Refuses while
 * they still have active bookings/jobs assigned to avoid orphaning live work.
 */
export const disableSelfAsMechanic = mutation({
  args: { shopId: v.id("shops") },
  handler: async (ctx, args) => {
    const { user } = await requireShopOwner(ctx, args.shopId);
    const now = Date.now();

    const membership = await ctx.db
      .query("shop_users")
      .withIndex("by_user_and_shop", (q: any) =>
        q.eq("user_id", user._id).eq("shop_id", args.shopId),
      )
      .first();

    // Resolve the mechanic to retire: prefer the one tied to this user, else
    // whatever the owner's membership currently points at (covers profiles set
    // up before user_id existed). Mirror of enableSelfAsMechanic's resolution.
    let mechanic = await ctx.db
      .query("mechanics")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", user._id))
      .filter((q: any) =>
        q.and(q.eq(q.field("shop_id"), args.shopId), q.neq(q.field("is_active"), false)),
      )
      .first();

    if (!mechanic && membership?.mechanic_id) {
      const linked = await ctx.db.get(membership.mechanic_id);
      if (linked && String(linked.shop_id) === String(args.shopId) && linked.is_active !== false) {
        mechanic = linked;
      }
    }

    // No active self-mechanic — just make sure no stale pointer lingers.
    if (!mechanic) {
      if (membership?.mechanic_id) {
        await ctx.db.patch(membership._id, { mechanic_id: undefined, updated_at: now });
      }
      return { ok: true };
    }

    // Clear this row before retiring it: auto-reassign every booking to another
    // available mechanic at the same time, refusing if a job is in progress or
    // no one is free. Convex mutation atomicity means any refusal here rolls back
    // before the mechanic is deactivated, so we never strand bookings.
    const { reassigned, unassigned } = await retireMechanic(ctx, {
      shopId: args.shopId,
      mechanicId: mechanic._id,
      subject: { self: true },
    });

    // retireMechanic unlinks rows pointing at this profile; the owner's own
    // membership may point at another (stale) one — clear it either way.
    if (membership?.mechanic_id) {
      await ctx.db.patch(membership._id, { mechanic_id: undefined, updated_at: now });
    }

    return { ok: true, reassigned, unassigned };
  },
});
