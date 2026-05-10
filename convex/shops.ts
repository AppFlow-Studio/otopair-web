import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import {
  syncMechanicAvailabilityWindow,
  syncShopAvailabilityWindow,
} from "./lib/timeSlotAvailability";

const OWNER_ROLES = new Set(["owner", "shop_owner", "admin"]);
const MECHANIC_ROLES = new Set(["shop_mechanic", "mechanic"]);
const TERMINAL_BOOKING_STATUSES = new Set(["completed", "cancelled", "no_show"]);

type StripeConnectShopFields = {
  stripe_charges_enabled?: boolean;
  stripe_payouts_enabled?: boolean;
  stripe_requirements_currently_due?: string[];
  stripe_onboarding_completed_at?: number;
};

async function getCurrentUser(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return { identity: null, user: null };

  const user = await getUserByClerkUserId(ctx, identity.subject);

  return { identity, user };
}

async function getUserByClerkUserId(ctx: any, clerkUserId: string) {
  return await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) => q.eq("clerkUserId", clerkUserId))
    .unique();
}

async function getPrimaryShopForUser(ctx: any, userId: any) {
  const activeMembership = await ctx.db
    .query("shop_users")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .filter((q: any) => q.eq(q.field("is_active"), true))
    .first();

  if (activeMembership) {
    const shop = await ctx.db.get(activeMembership.shop_id);
    return shop
      ? { shop, membershipRole: activeMembership.role, membership: activeMembership }
      : null;
  }

  const ownedShop = await ctx.db
    .query("shops")
    .withIndex("by_owner_user_id", (q: any) => q.eq("owner_user_id", userId))
    .first();

  if (!ownedShop) return null;
  return { shop: ownedShop, membershipRole: "shop_owner", membership: null };
}

async function getOrCreateCurrentShopOwner(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");

  let user = await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) => q.eq("clerkUserId", identity.subject))
    .unique();

  if (!user) {
    const now = Date.now();
    const userId = await ctx.db.insert("users", {
      clerkUserId: identity.subject,
      email: identity.email ?? "",
      first_name: identity.givenName ?? undefined,
      last_name: identity.familyName ?? undefined,
      profile_photo_url: identity.pictureUrl ?? undefined,
      role: "shop_owner",
      onboardingCompleted: false,
      createdAt: now,
    });
    user = await ctx.db.get(userId);
  } else if (user.role !== "shop_owner" && user.role !== "owner") {
    await ctx.db.patch(user._id, { role: "shop_owner", lastUpdated: Date.now() });
    user = { ...user, role: "shop_owner" };
  }

  if (!user) throw new Error("User not found");
  return user;
}

async function getOwnerShopContextByClerkUserId(ctx: any, clerkUserId: string) {
  const user = await getUserByClerkUserId(ctx, clerkUserId);
  if (!user) return null;

  const primary = await getPrimaryShopForUser(ctx, user._id);
  if (!primary?.shop) return null;
  if (!OWNER_ROLES.has(primary.membershipRole)) {
    throw new Error("Not authorized");
  }

  return { user, primary };
}

function getStripeRequirements(
  shop: StripeConnectShopFields | null | undefined
): string[] {
  return Array.isArray(shop?.stripe_requirements_currently_due)
    ? shop.stripe_requirements_currently_due
    : [];
}

function isStripeConnectReadyForShop(
  shop: StripeConnectShopFields | null | undefined
): boolean {
  return (
    shop?.stripe_charges_enabled === true &&
    shop?.stripe_payouts_enabled === true &&
    getStripeRequirements(shop).length === 0
  );
}

async function resolveMechanicPhotoUrl(ctx: any, photo?: string | null) {
  if (!photo) return null;

  try {
    const asset = await ctx.db.get(photo as any);
    if (asset?.url) return asset.url as string;
  } catch {
    // New uploads store Convex storage ids directly on mechanics.photo.
  }

  try {
    return await ctx.storage.getUrl(photo);
  } catch {
    return null;
  }
}

async function getBlockingBookingsForMechanic(ctx: any, shopId: any, mechanicId: any) {
  const bookings = await ctx.db
    .query("bookings")
    .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shopId))
    .collect();

  return bookings.filter(
    (booking: any) =>
      String(booking.mechanic_id ?? "") === String(mechanicId) &&
      !TERMINAL_BOOKING_STATUSES.has(booking.status)
  );
}

function getMechanicPortalStatus(args: { activeShopUser: any; latestInvitation: any; now: number }) {
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


function getStripeStatusPatch(args: {
  shop: StripeConnectShopFields;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  requirementsCurrentlyDue: string[];
}) {
  const isReady =
    args.chargesEnabled &&
    args.payoutsEnabled &&
    args.requirementsCurrentlyDue.length === 0;

  return {
    stripe_charges_enabled: args.chargesEnabled,
    stripe_payouts_enabled: args.payoutsEnabled,
    stripe_requirements_currently_due: args.requirementsCurrentlyDue,
    stripe_onboarding_completed_at: isReady
      ? args.shop.stripe_onboarding_completed_at ?? Date.now()
      : args.shop.stripe_onboarding_completed_at,
  };
}

async function assertOnboardingCanBeCompleted(ctx: any, shopId: any) {
  const shop = await ctx.db.get(shopId);
  if (!shop) throw new Error("Shop not found.");
  if (!shop.stripe_connect_account_id) {
    throw new Error("Complete Stripe Connect onboarding before finishing setup.");
  }
  if (!isStripeConnectReadyForShop(shop)) {
    throw new Error(
      "Stripe still needs more information before payouts can be enabled. Reopen Stripe onboarding and complete every required step."
    );
  }

  const hours = await ctx.db
    .query("shops_hours")
    .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shopId))
    .collect();
  if (hours.length < 7) {
    throw new Error("Complete your operating hours before finishing setup.");
  }

  const mechanics = await ctx.db
    .query("mechanics")
    .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shopId))
    .filter((q: any) => q.eq(q.field("is_active"), true))
    .collect();
  if (mechanics.length === 0) {
    throw new Error("Add at least one mechanic before finishing setup.");
  }
}

async function finalizeOnboarding(ctx: any, args: { shopId: any; userId: any }) {
  await ctx.db.patch(args.shopId, { onboarding_complete: true });
  await ctx.db.patch(args.userId, {
    onboardingCompleted: true,
    lastUpdated: Date.now(),
  });
  await syncShopAvailabilityWindow(ctx, { shopId: args.shopId });

  return args.shopId;
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("shops").collect();
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    slug: v.string(),
    description: v.optional(v.string()),
    address: v.string(),
    city: v.string(),
    state: v.string(),
    zipCode: v.string(),
    phone: v.string(),
    email: v.optional(v.string()),
    website: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await getOrCreateCurrentShopOwner(ctx);

    const existing = await ctx.db
      .query("shops")
      .withIndex("by_slug", (q: any) => q.eq("slug", args.slug))
      .first();
    if (existing) {
      throw new Error("This slug is already taken. Please choose another.");
    }

    const now = Date.now();
    const shopId = await ctx.db.insert("shops", {
      name: args.name,
      slug: args.slug,
      description: args.description,
      address: args.address,
      city: args.city,
      state: args.state,
      zip: args.zipCode,
      phone: args.phone,
      email: args.email,
      website: args.website,
      is_active: true,
      owner_user_id: user._id,
      onboarding_complete: false,
    });

    await ctx.db.insert("shop_users", {
      shop_id: shopId,
      user_id: user._id,
      role: "shop_owner",
      is_active: true,
      invited_at: now,
      accepted_at: now,
      created_at: now,
      updated_at: now,
    });

    return shopId;
  },
});

export const getByOwner = query({
  args: {},
  handler: async (ctx) => {
    const { user } = await getCurrentUser(ctx);
    if (!user) return [];

    return await ctx.db
      .query("shops")
      .withIndex("by_owner_user_id", (q: any) => q.eq("owner_user_id", user._id))
      .collect();
  },
});

export const getById = query({
  args: { id: v.id("shops") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("shops")
      .withIndex("by_slug", (q: any) => q.eq("slug", args.slug))
      .first();
  },
});

export const getMyShops = query({
  args: {},
  handler: async (ctx) => {
    const { user } = await getCurrentUser(ctx);
    if (!user) return [];

    const shopUsers = await ctx.db
      .query("shop_users")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", user._id))
      .filter((q: any) => q.eq(q.field("is_active"), true))
      .collect();

    const shops = await Promise.all(
      shopUsers.map(async (su: any) => {
        const shop = await ctx.db.get(su.shop_id);
        return shop ? { ...shop, memberRole: su.role } : null;
      })
    );

    return shops.filter(Boolean);
  },
});

export const getMyPortalAccess = query({
  args: {},
  handler: async (ctx) => {
    const { user } = await getCurrentUser(ctx);
    if (!user) return null;

    const allMemberships = await ctx.db
      .query("shop_users")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", user._id))
      .collect();

    const activeMembership = allMemberships.find((membership: any) => membership.is_active);
    const inactiveMembership = allMemberships.find((membership: any) => !membership.is_active);

    if (activeMembership) {
      const shop = await ctx.db.get(activeMembership.shop_id);
      return {
        status: "active" as const,
        role: activeMembership.role,
        shopId: activeMembership.shop_id,
        onboardingComplete: shop?.onboarding_complete === true,
      };
    }

    if (inactiveMembership) {
      return { status: "deactivated" as const };
    }

    return { status: "no_shop" as const, userRole: user.role };
  },
});

export const getStripeOnboardingContext = internalQuery({
  args: {
    clerkUserId: v.string(),
  },
  handler: async (ctx, args) => {
    const context = await getOwnerShopContextByClerkUserId(ctx, args.clerkUserId);
    if (!context) return null;

    return {
      shopId: context.primary.shop._id,
      shopName: context.primary.shop.name,
      ownerEmail: context.user.email ?? null,
      shopEmail: context.primary.shop.email ?? null,
      stripeConnectAccountId: context.primary.shop.stripe_connect_account_id ?? null,
    };
  },
});

export const saveStripeConnectAccountId = mutation({
  args: {
    stripeConnectAccountId: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await getOrCreateCurrentShopOwner(ctx);
    const primary = await getPrimaryShopForUser(ctx, user._id);
    if (!primary?.shop) throw new Error("Shop not found.");
    if (!OWNER_ROLES.has(primary.membershipRole)) {
      throw new Error("Not authorized");
    }

    const existing = primary.shop.stripe_connect_account_id;
    if (existing && existing !== args.stripeConnectAccountId) {
      throw new Error("This shop is already linked to a different Stripe account.");
    }

    await ctx.db.patch(primary.shop._id, {
      stripe_connect_account_id: args.stripeConnectAccountId,
      stripe_charges_enabled: primary.shop.stripe_charges_enabled ?? false,
      stripe_payouts_enabled: primary.shop.stripe_payouts_enabled ?? false,
      stripe_requirements_currently_due:
        primary.shop.stripe_requirements_currently_due ?? [],
      onboarding_complete: false,
    });

    return primary.shop._id;
  },
});

export const syncMyStripeConnectStatus = mutation({
  args: {
    stripeConnectAccountId: v.string(),
    stripeChargesEnabled: v.boolean(),
    stripePayoutsEnabled: v.boolean(),
    stripeRequirementsCurrentlyDue: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await getOrCreateCurrentShopOwner(ctx);
    const primary = await getPrimaryShopForUser(ctx, user._id);
    if (!primary?.shop) throw new Error("Shop not found.");
    if (!OWNER_ROLES.has(primary.membershipRole)) {
      throw new Error("Not authorized");
    }
    if (primary.shop.stripe_connect_account_id !== args.stripeConnectAccountId) {
      throw new Error("Stripe account does not match this shop.");
    }

    await ctx.db.patch(
      primary.shop._id,
      getStripeStatusPatch({
        shop: primary.shop,
        chargesEnabled: args.stripeChargesEnabled,
        payoutsEnabled: args.stripePayoutsEnabled,
        requirementsCurrentlyDue: args.stripeRequirementsCurrentlyDue,
      })
    );

    return primary.shop._id;
  },
});

export const getMyOnboardingData = query({
  args: {},
  handler: async (ctx) => {
    const { user } = await getCurrentUser(ctx);
    if (!user) return null;

    const primary = await getPrimaryShopForUser(ctx, user._id);
    const shop = primary?.shop ?? null;

    const allServices = await ctx.db.query("services").collect();
    const categories = await ctx.db.query("service_categories").collect();
    const offeredRows = shop
      ? await ctx.db
          .query("shop_services")
          .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shop._id))
          .collect()
      : [];
    const offeredIds = new Set(
      offeredRows
        .filter((row: any) => row.is_offered)
        .map((row: any) => String(row.service_id))
    );

    const categoryMap = new Map(
      categories.map((category: any) => [
        String(category._id),
        {
          id: String(category._id),
          name: category.name as string,
          displayOrder: (category.display_order ?? 99) as number,
          services: [] as Array<{
            _id: string;
            name: string;
            description?: string;
            defaultLaborHours: number;
            displayOrder: number;
            isOffered: boolean;
          }>,
        },
      ])
    );

    for (const service of allServices) {
      const categoryId = String(service.service_category_id);
      if (!categoryMap.has(categoryId)) continue;
      categoryMap.get(categoryId)!.services.push({
        _id: String(service._id),
        name: service.name as string,
        description: service.description as string | undefined,
        defaultLaborHours: (service.default_labor_hours ?? 1) as number,
        displayOrder: (service.display_order ?? 0) as number,
        isOffered: offeredIds.has(String(service._id)),
      });
    }

    const serviceCategories = Array.from(categoryMap.values())
      .sort((a, b) => a.displayOrder - b.displayOrder)
      .map((category) => ({
        id: category.id,
        name: category.name,
        services: category.services.sort((a, b) => a.displayOrder - b.displayOrder),
      }));

    const hours = shop
      ? await ctx.db
          .query("shops_hours")
          .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shop._id))
          .collect()
      : [];

    const mechanics = shop
      ? await ctx.db
          .query("mechanics")
          .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shop._id))
          .filter((q: any) => q.eq(q.field("is_active"), true))
          .collect()
      : [];

    const shopUsers = shop
      ? await ctx.db
          .query("shop_users")
          .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shop._id))
          .filter((q: any) => q.eq(q.field("is_active"), true))
          .collect()
      : [];

    const invitations = shop
      ? await ctx.db
          .query("shop_invitations")
          .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shop._id))
          .collect()
      : [];

    const mechanicRoleShopUsers = shopUsers.filter(
      (row: any) =>
        row.mechanic_id &&
        (row.role === "shop_mechanic" || row.role === "mechanic")
    );
    const mechanicRoleInvitations = invitations.filter(
      (row: any) =>
        row.mechanic_id &&
        MECHANIC_ROLES.has(row.role)
    );

    const shopUserByMechanicId = new Map(
      mechanicRoleShopUsers.map((row: any) => [String(row.mechanic_id), String(row._id)])
    );
    const shopUserRecordByMechanicId = new Map(
      mechanicRoleShopUsers.map((row: any) => [String(row.mechanic_id), row])
    );
    const invitationsByMechanicId = new Map<string, any[]>();
    for (const invitation of mechanicRoleInvitations) {
      const key = String(invitation.mechanic_id);
      const current = invitationsByMechanicId.get(key) ?? [];
      current.push(invitation);
      invitationsByMechanicId.set(key, current);
    }

    return {
      userRole: user.role ?? null,
      ownerEmail: user.email ?? null,
      shop: shop
        ? {
            _id: shop._id,
            name: shop.name,
            slug: shop.slug,
            address: shop.address,
            city: shop.city,
            state: shop.state,
            zipCode: shop.zip,
            phone: shop.phone,
            laborRate: shop.labor_rate ?? 150,
            lat: shop.lat ?? null,
            lng: shop.lng ?? null,
            email: shop.email ?? null,
            website: shop.website ?? null,
            stripeConnectAccountId: shop.stripe_connect_account_id ?? null,
            stripeChargesEnabled: shop.stripe_charges_enabled === true,
            stripePayoutsEnabled: shop.stripe_payouts_enabled === true,
            stripeRequirementsCurrentlyDue: getStripeRequirements(shop),
            stripeOnboardingCompletedAt: shop.stripe_onboarding_completed_at ?? null,
            stripeConnectReady: isStripeConnectReadyForShop(shop),
            onboardingComplete: shop.onboarding_complete === true,
          }
        : null,
      hours: hours
        .sort((a: any, b: any) => a.day_of_week - b.day_of_week)
        .map((row: any) => ({
          _id: String(row._id),
          dayOfWeek: row.day_of_week as number,
          dayName: row.day_name as string,
          isClosed: (row.is_closed ?? false) as boolean,
          openTime: (row.open_time ?? "09:00") as string,
          closeTime: (row.close_time ?? "17:00") as string,
        })),
      serviceCategories,
      mechanics: await Promise.all(
        mechanics
          .map(async (mechanic: any) => {
            const shopUser = shopUserRecordByMechanicId.get(String(mechanic._id));
            const linkedUser: any = shopUser?.user_id ? await ctx.db.get(shopUser.user_id) : null;
            const mechanicInvitations = (invitationsByMechanicId.get(String(mechanic._id)) ?? [])
              .sort((a: any, b: any) => (b.created_at ?? 0) - (a.created_at ?? 0));
            const latestInvitation = mechanicInvitations[0] ?? null;
            const pendingInvitation = mechanicInvitations.find((row: any) => row.status === "pending");
            const mechanicPhotoUrl = await resolveMechanicPhotoUrl(ctx, mechanic.photo);
            const linkedUserPhotoUrl = linkedUser?.profile_photo_storage_id
              ? await ctx.storage.getUrl(linkedUser.profile_photo_storage_id)
              : (linkedUser?.profile_photo_url ?? null);
            const activeShopUser = shopUser ?? null;
            const blockingBookings = shop
              ? await getBlockingBookingsForMechanic(ctx, shop._id, mechanic._id)
              : [];

            return {
              _id: String(mechanic._id),
              firstName: mechanic.first_name as string,
              lastName: mechanic.last_name as string,
              title: (mechanic.title ?? "") as string,
              email: (mechanic.email ?? latestInvitation?.email ?? "") as string,
              rating: mechanic.rating ?? 0,
              reviewCount: mechanic.review_count ?? 0,
              shopUserId: shopUserByMechanicId.get(String(mechanic._id)) ?? null,
              invitationId: latestInvitation ? String(latestInvitation._id) : null,
              pendingInvitationId: pendingInvitation ? String(pendingInvitation._id) : null,
              invitationStatus: latestInvitation?.status ?? null,
              invitationExpiresAt: latestInvitation?.expires_at ?? null,
              portalStatus: getMechanicPortalStatus({
                activeShopUser,
                latestInvitation,
                now: Date.now(),
              }),
              blockingBookingCount: blockingBookings.length,
              photoUrl: mechanicPhotoUrl ?? linkedUserPhotoUrl,
            };
          })
      ),
    };
  },
});

export const upsertOnboardingShopDetails = mutation({
  args: {
    name: v.string(),
    slug: v.string(),
    address: v.string(),
    city: v.string(),
    state: v.string(),
    zipCode: v.string(),
    phone: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await getOrCreateCurrentShopOwner(ctx);

    const existingSlug = await ctx.db
      .query("shops")
      .withIndex("by_slug", (q: any) => q.eq("slug", args.slug))
      .first();

    const primary = await getPrimaryShopForUser(ctx, user._id);
    const currentShop = primary?.shop ?? null;

    if (existingSlug && (!currentShop || String(existingSlug._id) !== String(currentShop._id))) {
      throw new Error("This slug is already taken. Please choose another.");
    }

    if (currentShop) {
      await ctx.db.patch(currentShop._id, {
        name: args.name,
        slug: args.slug,
        address: args.address,
        city: args.city,
        state: args.state,
        zip: args.zipCode,
        phone: args.phone,
        onboarding_complete: false,
      });
      return currentShop._id;
    }

    const now = Date.now();
    const shopId = await ctx.db.insert("shops", {
      name: args.name,
      slug: args.slug,
      address: args.address,
      city: args.city,
      state: args.state,
      zip: args.zipCode,
      phone: args.phone,
      is_active: true,
      owner_user_id: user._id,
      labor_rate: 150,
      onboarding_complete: false,
    });

    await ctx.db.insert("shop_users", {
      shop_id: shopId,
      user_id: user._id,
      role: "shop_owner",
      is_active: true,
      invited_at: now,
      accepted_at: now,
      created_at: now,
      updated_at: now,
    });

    return shopId;
  },
});

export const saveOnboardingHours = mutation({
  args: {
    hours: v.array(
      v.object({
        dayOfWeek: v.float64(),
        dayName: v.string(),
        isClosed: v.boolean(),
        openTime: v.string(),
        closeTime: v.string(),
      })
    ),
  },
  handler: async (ctx, args) => {
    const user = await getOrCreateCurrentShopOwner(ctx);
    const primary = await getPrimaryShopForUser(ctx, user._id);
    if (!primary?.shop) throw new Error("Set up your shop details first.");
    if (!OWNER_ROLES.has(primary.membershipRole)) {
      throw new Error("Not authorized");
    }

    const existing = await ctx.db
      .query("shops_hours")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", primary.shop._id))
      .collect();
    const byDay = new Map(existing.map((row: any) => [row.day_of_week as number, row]));

    for (const hour of args.hours) {
      const patch = {
        day_name: hour.dayName,
        day_of_week: hour.dayOfWeek,
        is_closed: hour.isClosed,
        open_time: hour.isClosed ? undefined : hour.openTime,
        close_time: hour.isClosed ? undefined : hour.closeTime,
        shop_id: primary.shop._id,
      };

      const current = byDay.get(hour.dayOfWeek);
      if (current) {
        await ctx.db.patch(current._id, patch);
      } else {
        await ctx.db.insert("shops_hours", patch);
      }
    }

    await ctx.db.patch(primary.shop._id, { onboarding_complete: false });
    await syncShopAvailabilityWindow(ctx, { shopId: primary.shop._id });
    return primary.shop._id;
  },
});

export const saveOnboardingLaborAndServices = mutation({
  args: {
    laborRate: v.float64(),
    serviceIds: v.array(v.id("services")),
  },
  handler: async (ctx, args) => {
    const user = await getOrCreateCurrentShopOwner(ctx);
    const primary = await getPrimaryShopForUser(ctx, user._id);
    if (!primary?.shop) throw new Error("Set up your shop details first.");
    if (!OWNER_ROLES.has(primary.membershipRole)) {
      throw new Error("Not authorized");
    }

    await ctx.db.patch(primary.shop._id, {
      labor_rate: args.laborRate,
      onboarding_complete: false,
    });

    const existing = await ctx.db
      .query("shop_services")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", primary.shop._id))
      .collect();
    const byServiceId = new Map(existing.map((row: any) => [String(row.service_id), row]));
    const selectedIds = new Set(args.serviceIds.map((id) => String(id)));

    for (const row of existing) {
      const shouldOffer = selectedIds.has(String(row.service_id));
      if (row.is_offered !== shouldOffer) {
        await ctx.db.patch(row._id, { is_offered: shouldOffer });
      }
    }

    for (const serviceId of args.serviceIds) {
      if (!byServiceId.has(String(serviceId))) {
        await ctx.db.insert("shop_services", {
          shop_id: primary.shop._id,
          service_id: serviceId,
          is_offered: true,
        });
      }
    }

    return primary.shop._id;
  },
});

export const addOnboardingMechanic = mutation({
  args: {
    firstName: v.string(),
    lastName: v.string(),
    title: v.optional(v.string()),
    email: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await getOrCreateCurrentShopOwner(ctx);
    const primary = await getPrimaryShopForUser(ctx, user._id);
    if (!primary?.shop) throw new Error("Set up your shop details first.");
    if (!OWNER_ROLES.has(primary.membershipRole)) {
      throw new Error("Not authorized");
    }

    const mechanicId = await ctx.db.insert("mechanics", {
      shop_id: primary.shop._id,
      first_name: args.firstName.trim(),
      last_name: args.lastName.trim(),
      title: args.title?.trim() || undefined,
      email: args.email?.trim().toLowerCase() || undefined,
      is_active: true,
      rating: 0,
      review_count: 0,
    });

    await syncMechanicAvailabilityWindow(ctx, {
      shopId: primary.shop._id,
      mechanicId,
    });

    return mechanicId;
  },
});

export const removeOnboardingMechanic = mutation({
  args: {
    mechanicId: v.id("mechanics"),
  },
  handler: async (ctx, args) => {
    const user = await getOrCreateCurrentShopOwner(ctx);
    const primary = await getPrimaryShopForUser(ctx, user._id);
    if (!primary?.shop) throw new Error("Shop not found.");
    if (!OWNER_ROLES.has(primary.membershipRole)) {
      throw new Error("Not authorized");
    }

    const mechanic = await ctx.db.get(args.mechanicId);
    if (!mechanic || String(mechanic.shop_id) !== String(primary.shop._id)) {
      throw new Error("Mechanic not found.");
    }

    const blockers = await getBlockingBookingsForMechanic(ctx, primary.shop._id, args.mechanicId);
    if (blockers.length > 0) {
      throw new Error("This mechanic has active bookings or jobs that must be completed or reassigned first.");
    }

    await ctx.db.patch(args.mechanicId, { is_active: false });
    await syncMechanicAvailabilityWindow(ctx, {
      shopId: primary.shop._id,
      mechanicId: args.mechanicId,
    });
    return args.mechanicId;
  },
});

export const updateOnboardingMechanicProfilePhoto = mutation({
  args: {
    mechanicId: v.id("mechanics"),
    profilePhotoStorageId: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const user = await getOrCreateCurrentShopOwner(ctx);
    const primary = await getPrimaryShopForUser(ctx, user._id);
    if (!primary?.shop) throw new Error("Shop not found.");
    if (!OWNER_ROLES.has(primary.membershipRole)) {
      throw new Error("Not authorized");
    }

    const mechanic = await ctx.db.get(args.mechanicId);
    if (!mechanic || String(mechanic.shop_id) !== String(primary.shop._id)) {
      throw new Error("Mechanic not found.");
    }

    await ctx.db.patch(args.mechanicId, {
      photo: args.profilePhotoStorageId ?? undefined,
    });

    const photoUrl = args.profilePhotoStorageId
      ? await resolveMechanicPhotoUrl(ctx, args.profilePhotoStorageId)
      : null;
    return { mechanicId: args.mechanicId, photoUrl };
  },
});

export const saveStripeConnectAccountForClerkUser = internalMutation({
  args: {
    clerkUserId: v.string(),
    stripeConnectAccountId: v.string(),
  },
  handler: async (ctx, args) => {
    const context = await getOwnerShopContextByClerkUserId(ctx, args.clerkUserId);
    if (!context) throw new Error("Shop not found.");

    const existing = context.primary.shop.stripe_connect_account_id;
    if (existing && existing !== args.stripeConnectAccountId) {
      throw new Error("This shop is already linked to a different Stripe account.");
    }

    await ctx.db.patch(context.primary.shop._id, {
      stripe_connect_account_id: args.stripeConnectAccountId,
      stripe_charges_enabled: context.primary.shop.stripe_charges_enabled ?? false,
      stripe_payouts_enabled: context.primary.shop.stripe_payouts_enabled ?? false,
      stripe_requirements_currently_due:
        context.primary.shop.stripe_requirements_currently_due ?? [],
      onboarding_complete: false,
    });

    return context.primary.shop._id;
  },
});

export const syncStripeConnectStatusByAccountId = internalMutation({
  args: {
    stripeConnectAccountId: v.string(),
    stripeChargesEnabled: v.boolean(),
    stripePayoutsEnabled: v.boolean(),
    stripeRequirementsCurrentlyDue: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const shop = await ctx.db
      .query("shops")
      .withIndex("by_stripe_connect_account_id", (q: any) =>
        q.eq("stripe_connect_account_id", args.stripeConnectAccountId)
      )
      .first();

    if (!shop) {
      return { shopId: null, ready: false };
    }

    const ready =
      args.stripeChargesEnabled &&
      args.stripePayoutsEnabled &&
      args.stripeRequirementsCurrentlyDue.length === 0;

    await ctx.db.patch(
      shop._id,
      getStripeStatusPatch({
        shop,
        chargesEnabled: args.stripeChargesEnabled,
        payoutsEnabled: args.stripePayoutsEnabled,
        requirementsCurrentlyDue: args.stripeRequirementsCurrentlyDue,
      })
    );

    return { shopId: shop._id, ready };
  },
});

export const completeOnboardingForClerkUser = internalMutation({
  args: {
    clerkUserId: v.string(),
  },
  handler: async (ctx, args) => {
    const context = await getOwnerShopContextByClerkUserId(ctx, args.clerkUserId);
    if (!context) throw new Error("Shop not found.");

    await assertOnboardingCanBeCompleted(ctx, context.primary.shop._id);
    return await finalizeOnboarding(ctx, {
      shopId: context.primary.shop._id,
      userId: context.user._id,
    });
  },
});

export const completeOnboarding = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await getOrCreateCurrentShopOwner(ctx);
    const primary = await getPrimaryShopForUser(ctx, user._id);
    if (!primary?.shop) throw new Error("Shop not found.");
    if (!OWNER_ROLES.has(primary.membershipRole)) {
      throw new Error("Not authorized");
    }

    await assertOnboardingCanBeCompleted(ctx, primary.shop._id);
    return await finalizeOnboarding(ctx, {
      shopId: primary.shop._id,
      userId: user._id,
    });
  },
});

export const deactivateMyAccount = mutation({
  args: {},
  handler: async (ctx) => {
    const { user } = await getCurrentUser(ctx);
    if (!user) throw new Error("Not authenticated");

    const activeMembership = await ctx.db
      .query("shop_users")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", user._id))
      .filter((q: any) => q.eq(q.field("is_active"), true))
      .first();

    if (!activeMembership) throw new Error("No active membership found");

    await ctx.db.patch(activeMembership._id, {
      is_active: false,
      updated_at: Date.now(),
    });
  },
});
