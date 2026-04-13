import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import {
  syncMechanicAvailabilityWindow,
  syncShopAvailabilityWindow,
} from "./lib/timeSlotAvailability";

const OWNER_ROLES = new Set(["owner", "shop_owner", "admin"]);

async function getCurrentUser(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return { identity: null, user: null };

  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) => q.eq("clerkUserId", identity.subject))
    .unique();

  return { identity, user };
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

    const pendingInvitations = shop
      ? await ctx.db
          .query("shop_invitations")
          .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shop._id))
          .filter((q: any) => q.eq(q.field("status"), "pending"))
          .collect()
      : [];

    const mechanicRoleShopUsers = shopUsers.filter(
      (row: any) =>
        row.mechanic_id &&
        (row.role === "shop_mechanic" || row.role === "mechanic")
    );
    const mechanicRolePendingInvitations = pendingInvitations.filter(
      (row: any) =>
        row.mechanic_id &&
        (row.role === "shop_mechanic" || row.role === "mechanic")
    );

    const shopUserByMechanicId = new Map(
      mechanicRoleShopUsers.map((row: any) => [String(row.mechanic_id), String(row._id)])
    );
    const shopUserRecordByMechanicId = new Map(
      mechanicRoleShopUsers.map((row: any) => [String(row.mechanic_id), row])
    );
    const pendingInvitationByMechanicId = new Map(
      mechanicRolePendingInvitations.map((row: any) => [
        String(row.mechanic_id),
        String(row._id),
      ])
    );

    return {
      userRole: user.role ?? null,
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
            stripeConnectAccountId: shop.stripe_connect_account_id ?? null,
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
          .filter(
            (mechanic: any) =>
              shopUserByMechanicId.has(String(mechanic._id)) ||
              pendingInvitationByMechanicId.has(String(mechanic._id))
          )
          .map(async (mechanic: any) => {
            const shopUser = shopUserRecordByMechanicId.get(String(mechanic._id));
            const linkedUser = shopUser?.user_id ? await ctx.db.get(shopUser.user_id) : null;
            const photoUrl =
              linkedUser?.profile_photo_storage_id
                ? await ctx.storage.getUrl(linkedUser.profile_photo_storage_id)
                : (linkedUser?.profile_photo_url ?? null);

            return {
              _id: String(mechanic._id),
              firstName: mechanic.first_name as string,
              lastName: mechanic.last_name as string,
              title: (mechanic.title ?? "") as string,
              shopUserId: shopUserByMechanicId.get(String(mechanic._id)) ?? null,
              pendingInvitationId:
                pendingInvitationByMechanicId.get(String(mechanic._id)) ?? null,
              photoUrl,
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

    const shopUser = await ctx.db
      .query("shop_users")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", primary.shop._id))
      .filter((q: any) =>
        q.and(
          q.eq(q.field("is_active"), true),
          q.eq(q.field("mechanic_id"), args.mechanicId),
          q.or(
            q.eq(q.field("role"), "shop_mechanic"),
            q.eq(q.field("role"), "mechanic")
          )
        )
      )
      .first();

    if (!shopUser?.user_id) {
      throw new Error("Profile photo can be added after the mechanic accepts the invitation.");
    }

    await ctx.db.patch(shopUser.user_id, {
      profile_photo_storage_id: args.profilePhotoStorageId ?? undefined,
      profile_photo_url: undefined,
      lastUpdated: Date.now(),
    });

    const photoUrl = args.profilePhotoStorageId
      ? await ctx.storage.getUrl(args.profilePhotoStorageId)
      : null;
    return { userId: shopUser.user_id, photoUrl };
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

    const hours = await ctx.db
      .query("shops_hours")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", primary.shop._id))
      .collect();
    if (hours.length < 7) {
      throw new Error("Complete your operating hours before finishing setup.");
    }

    const mechanics = await ctx.db
      .query("mechanics")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", primary.shop._id))
      .filter((q: any) => q.eq(q.field("is_active"), true))
      .collect();
    if (mechanics.length === 0) {
      throw new Error("Add at least one mechanic before finishing setup.");
    }

    await ctx.db.patch(primary.shop._id, { onboarding_complete: true });
    await ctx.db.patch(user._id, {
      onboardingCompleted: true,
      lastUpdated: Date.now(),
    });
    await syncShopAvailabilityWindow(ctx, { shopId: primary.shop._id });

    return primary.shop._id;
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
