import { action, internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import { findMakeByName, getOrCreateMake } from "./lib/makeKey";
import {
  rebuildAllAvailability,
  syncShopAvailabilityWindow,
} from "./lib/timeSlotAvailability";

/**
 * Seed creates a demo user with clerkUserId "seed-demo-user-2". When you sign in with the
 * Clerk account from .env.local (EXPO_PUBLIC_GUEST_EMAIL / EXPO_PUBLIC_GUEST_PASSWORD),
 * claimSeedDataForCurrentUser runs and reassigns that seed user's data to your account.
 */
const SEED_DEMO_CLERK_USER_ID = "seed-demo-user-2";

const TABLES_TO_CLEAR = [
  "booking_status_history",
  "payment_status_history",
  "job_actuals",
  "reviews",
  "transactions",
  "payments",
  "follow_ups",
  "bookings",
  "ai_messages",
  "ai_conversations",
  "analytics_events",
  "conversion_funnels",
  "spec_variances",
  "spec_confirmations",
  "shop_portfolio",
  "shop_services",
  "time_slots",
  "shops_hours",
  "mechanics",
  "shops",
  "cdn_assets",
  "service_vehicle_specs",
  "service_options",
  "services",
  "service_categories",
  "part_fitments",
  "trim_specs",
  "oem_parts",
  "chassis_variants",
  "transmissions",
  "engines",
  "trims",
  "models",
  "makes",
  "vehicle_owners",
  "user_mechanic_preferences",
  "vehicles",
  "onboarding_questions_answers",
  "users",
];

const clearTables = async (ctx: any, preserveUserId?: any) => {
  for (const table of TABLES_TO_CLEAR) {
    const rows = await ctx.db.query(table).collect();
    for (const r of rows) {
      if (table === "users" && preserveUserId && r._id === preserveUserId) {
        continue;
      }
      await ctx.db.delete(r._id);
    }
  }
};

const clearUserScopedSeedData = async (ctx: any, userId: any) => {
  const vehicleOwners = await ctx.db
    .query("vehicle_owners")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  const ownedVins = new Set(vehicleOwners.map((o: any) => o.vin));
  for (const owner of vehicleOwners) {
    await ctx.db.delete(owner._id);
  }

  const bookingRows = await ctx.db
    .query("bookings")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  const bookingIds = new Set(bookingRows.map((b: any) => b._id));
  const timeSlotIds = bookingRows
    .map((b: any) => b.time_slot_id)
    .filter(Boolean);

  const bookingStatusHistoryRows = await ctx.db.query("booking_status_history").collect();
  for (const row of bookingStatusHistoryRows) {
    if (bookingIds.has(row.booking_id)) await ctx.db.delete(row._id);
  }

  const jobActualRows = await ctx.db.query("job_actuals").collect();
  for (const row of jobActualRows) {
    if (bookingIds.has(row.booking_id)) await ctx.db.delete(row._id);
  }

  const specConfirmations = await ctx.db
    .query("spec_confirmations")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  for (const row of specConfirmations) {
    await ctx.db.delete(row._id);
  }

  const reviewRows = await ctx.db
    .query("reviews")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  for (const row of reviewRows) {
    await ctx.db.delete(row._id);
  }

  const paymentRows = await ctx.db
    .query("payments")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  const paymentIds = new Set(paymentRows.map((p: any) => p._id));
  for (const row of paymentRows) {
    await ctx.db.delete(row._id);
  }

  const paymentStatusRows = await ctx.db.query("payment_status_history").collect();
  for (const row of paymentStatusRows) {
    if (paymentIds.has(row.payment_id)) await ctx.db.delete(row._id);
  }

  const transactionRows = await ctx.db
    .query("transactions")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  for (const row of transactionRows) {
    await ctx.db.delete(row._id);
  }

  const followUps = await ctx.db
    .query("follow_ups")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  for (const row of followUps) {
    await ctx.db.delete(row._id);
  }

  const analytics = await ctx.db
    .query("analytics_events")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  for (const row of analytics) {
    await ctx.db.delete(row._id);
  }

  const funnels = await ctx.db
    .query("conversion_funnels")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  for (const row of funnels) {
    await ctx.db.delete(row._id);
  }

  const conversations = await ctx.db
    .query("ai_conversations")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  const conversationIds = new Set(conversations.map((c: any) => c._id));
  for (const row of conversations) {
    await ctx.db.delete(row._id);
  }

  const messages = await ctx.db.query("ai_messages").collect();
  for (const row of messages) {
    if (conversationIds.has(row.conversation_id)) await ctx.db.delete(row._id);
  }

  const onboardingRows = await ctx.db
    .query("onboarding_questions_answers")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  for (const row of onboardingRows) {
    await ctx.db.delete(row._id);
  }

  const prefs = await ctx.db
    .query("user_mechanic_preferences")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  for (const row of prefs) {
    await ctx.db.delete(row._id);
  }

  const wallets = await ctx.db
    .query("user_reward_wallets")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  for (const row of wallets) {
    await ctx.db.delete(row._id);
  }

  const creditTxns = await ctx.db
    .query("ownership_credit_transactions")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  for (const row of creditTxns) {
    await ctx.db.delete(row._id);
  }

  const claims = await ctx.db
    .query("user_contribution_claims")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  for (const row of claims) {
    await ctx.db.delete(row._id);
  }

  const tiers = await ctx.db
    .query("vehicle_tiers")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  for (const row of tiers) {
    await ctx.db.delete(row._id);
  }

  for (const booking of bookingRows) {
    await ctx.db.delete(booking._id);
  }

  for (const slotId of timeSlotIds) {
    const slot = await ctx.db.get(slotId);
    if (slot) await ctx.db.delete(slotId);
  }

  for (const vin of ownedVins) {
    const remainingOwners = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_vin", (q: any) => q.eq("vin", vin))
      .collect();
    if (remainingOwners.length === 0) {
      const vehicles = await ctx.db
        .query("vehicles")
        .withIndex("by_vin", (q: any) => q.eq("vin", vin))
        .collect();
      for (const vehicle of vehicles) {
        await ctx.db.delete(vehicle._id);
      }
    }
  }
};

export const seedUserAndVehicle = mutation({
  args: {},
  handler: async (ctx) => {
    // Clean existing user + vehicle ownership data
    const existingOwners = await ctx.db.query("vehicle_owners").collect();
    for (const o of existingOwners) await ctx.db.delete(o._id);
    const existingVehicles = await ctx.db.query("vehicles").collect();
    for (const v of existingVehicles) await ctx.db.delete(v._id);
    const existingUsers = await ctx.db.query("users").collect();
    for (const u of existingUsers) await ctx.db.delete(u._id);

    // Look up the A25A-FKS engine
    const engines = await ctx.db.query("engines").collect();
    const engine = engines.find((e) => e.engine_code === "A25A-FKS");
    if (!engine) throw new Error("Engine A25A-FKS not found. Seed vehicle data first.");

    // Demo user (claimSeedDataForCurrentUser reassigns to signed-in guest account)
    const userId = await ctx.db.insert("users", {
      clerkUserId: SEED_DEMO_CLERK_USER_ID,
      onboardingCompleted: true,
      createdAt: Date.now(),
      lastUpdated: Date.now(),
      email: "demo@otopair.com",
      phone: "(512) 555-9999",
      first_name: "Alex",
      last_name: "Rivera",
    });

    // 2018 Toyota Camry LE
    const now = Date.now();
    const vin = "4T1B11HK5JU123456";
    await ctx.db.insert("vehicles", {
      vin,
      engine_id: engine._id,
      year: 2018,
      created_at: now,
      updated_at: now,
    });

    await ctx.db.insert("vehicle_owners", {
      vin,
      user_id: userId,
      status: "active",
      nickname: "My Camry",
      is_primary: true,
      mileage: 72000,
      added_at: now,
    });

    return { success: true };
  },
});

/**
 * Reassigns all seed demo user data to the currently signed-in user (e.g. guest account from
 * .env.local). Run seed first, then sign in with EXPO_PUBLIC_GUEST_EMAIL / EXPO_PUBLIC_GUEST_PASSWORD;
 * this mutation is called on sign-in so the guest account gets vehicles, bookings, etc.
 * Idempotent: if current user already has data or no seed user exists, no-op.
 */
export const claimSeedDataForCurrentUser = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return { claimed: false, reason: "not_authenticated" as const };

    const clerkUserId = identity.subject;
    const currentUser = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", clerkUserId))
      .unique();
    if (!currentUser) return { claimed: false, reason: "current_user_not_found" as const };

    const myOwners = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_user_id", (q) => q.eq("user_id", currentUser._id))
      .collect();
    if (myOwners.length > 0) return { claimed: false, reason: "already_has_data" as const };

    const seedUser = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", SEED_DEMO_CLERK_USER_ID))
      .unique();
    if (!seedUser) return { claimed: false, reason: "no_seed_user" as const };

    const seedId = seedUser._id;
    const currentId = currentUser._id;

    const reassign = async (
      table:
        | "vehicle_owners"
        | "bookings"
        | "payments"
        | "reviews"
        | "onboarding_questions_answers"
        | "follow_ups"
        | "ai_conversations"
        | "conversion_funnels"
        | "spec_confirmations"
        | "user_reward_wallets"
        | "ownership_credit_transactions"
        | "user_contribution_claims"
        | "vehicle_tiers"
    ) => {
      const rows = await ctx.db.query(table).collect();
      for (const row of rows) {
        if (row.user_id === seedId) await ctx.db.patch(row._id, { user_id: currentId });
      }
    };
    await reassign("vehicle_owners");
    await reassign("bookings");
    await reassign("payments");
    await reassign("reviews");
    await reassign("onboarding_questions_answers");
    await reassign("follow_ups");
    await reassign("ai_conversations");
    await reassign("conversion_funnels");
    await reassign("spec_confirmations");
    await reassign("user_reward_wallets");
    await reassign("ownership_credit_transactions");
    await reassign("user_contribution_claims");
    await reassign("vehicle_tiers");

    // Give claimed user a reward wallet with demo balance if none exists
    const wallet = await ctx.db
      .query("user_reward_wallets")
      .withIndex("by_user_id", (q) => q.eq("user_id", currentId))
      .unique();
    if (!wallet) {
      const now = Date.now();
      await ctx.db.insert("user_reward_wallets", {
        user_id: currentId,
        balance: 32.75,
        auto_apply_to_booking: true,
        created_at: now,
        updated_at: now,
      });
      await ctx.db.insert("ownership_credit_transactions", {
        user_id: currentId,
        amount: 32.75,
        type: "earn_service",
        description: "Maintenance rewards",
        created_at: now,
      });
    }

    const analyticsRows = await ctx.db.query("analytics_events").collect();
    for (const row of analyticsRows) {
      if (row.user_id === seedId) await ctx.db.patch(row._id, { user_id: currentId });
    }

    const statusHistoryRows = await ctx.db.query("booking_status_history").collect();
    for (const row of statusHistoryRows) {
      if (row.changed_by === seedId) await ctx.db.patch(row._id, { changed_by: currentId });
    }

    // ai_enrichment_logs and manual_review_queue are deprecated — now enrichment_runs
    // enrichment_runs has no user-assignable fields, so no patching needed here

    await ctx.db.delete(seedId);
    return { claimed: true };
  },
});

/**
 * Clean generated free time slots for ONE shop. Availability is inferred, so
 * this only removes legacy positive availability rows.
 *
 * Usage:
 *   npx convex run seed:seedTimeSlotsForShop '{"shopId":"...","days":14}'
 *
 * Args:
 *   shopId — Id<"shops"> to clean
 *   days   — number of days from today (default 14, smaller = fewer reads)
 */
export const seedTimeSlotsForShop = mutation({
  args: {
    shopId: v.id("shops"),
    days: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const result = await syncShopAvailabilityWindow(ctx, {
      shopId: args.shopId,
      days: args.days ?? 14,
    });
    return {
      success: true,
      shopId: args.shopId,
      slotsCreated: result.created,
      slotsDeleted: result.deleted,
    };
  },
});

/**
 * Lists shop ids (with names) so a developer can iterate
 * `seedTimeSlotsForShop` over each one. Read-only.
 *
 * Usage: npx convex run seed:listSeedShopIds
 */
export const listSeedShopIds = query({
  args: {},
  handler: async (ctx) => {
    const shops = await ctx.db.query("shops").collect();
    return shops.map((s) => ({ id: s._id, name: s.name }));
  },
});

export const seedTimeSlots = mutation({
  args: {},
  handler: async (ctx) => {
    const result = await rebuildAllAvailability(ctx, { days: 35 });
    return {
      success: true,
      slotsCreated: result.created,
      slotsDeleted: result.deleted,
    };
    /*

    // 1. Delete all existing time_slots
    const existingSlots = await ctx.db.query("time_slots").collect();
    for (const slot of existingSlots) {
      await ctx.db.delete(slot._id);
    }

    // 2. Load all active mechanics and all shop_hours
    const allMechanics = await ctx.db.query("mechanics").collect();
    const activeMechanics = allMechanics.filter((m) => m.is_active);
    const allShopHours = await ctx.db.query("shops_hours").collect();

    // 3. Build lookup: shopId → dbDayOfWeek → { open_time, close_time, is_closed }
    const hoursMap: Record<
      string,
      Record<number, { open_time?: string; close_time?: string; is_closed: boolean }>
    > = {};
    for (const h of allShopHours) {
      const shopKey = h.shop_id as string;
      if (!hoursMap[shopKey]) hoursMap[shopKey] = {};
      hoursMap[shopKey][h.day_of_week] = {
        open_time: h.open_time,
        close_time: h.close_time,
        is_closed: h.is_closed,
      };
    }

    // 4. For each mechanic → next 7 days → generate 1-hour slots
    const today = new Date();
    let totalCreated = 0;

    for (const mechanic of activeMechanics) {
      const shopKey = mechanic.shop_id as string;
      const shopHours = hoursMap[shopKey];
      if (!shopHours) continue;

      for (let dayOffset = 1; dayOffset <= 7; dayOffset++) {
        const date = new Date(today);
        date.setDate(date.getDate() + dayOffset);
        const dateStr = date.toISOString().split("T")[0];

        // Schema: 0=Sunday, 1=Monday, ... 6=Saturday (same as JS getDay())
        const dbDay = date.getDay();

        const dayHours = shopHours[dbDay];
        if (!dayHours || dayHours.is_closed) continue;

        const openTime = dayHours.open_time;
        const closeTime = dayHours.close_time;
        if (!openTime || !closeTime) continue;

        // Parse hours
        const [openH, openM] = openTime.split(":").map(Number);
        const [closeH] = closeTime.split(":").map(Number);

        // Round up to nearest hour if minutes > 0
        const firstSlotHour = openM > 0 ? openH + 1 : openH;

        for (let hour = firstSlotHour; hour < closeH; hour++) {
          const startTime = `${hour.toString().padStart(2, "0")}:00`;
          const endTime = `${(hour + 1).toString().padStart(2, "0")}:00`;

          // legacy positive slot insert removed
            shop_id: mechanic.shop_id,
            mechanic_id: mechanic._id,
            date: dateStr,
            start_time: startTime,
            end_time: endTime,
            is_available: false,
          });
          totalCreated++;
        }
      }
    }

    return { success: true, slotsCreated: totalCreated };
    */
  },
});

/**
 * One-command seed: runs base seed, vehicle intelligence (OEM parts, fitments, specs),
 * then regenerates time slots.
 * Use:
 * npx convex run seed:seedAll '{"userId":"<users_id>"}'
 */
export const seedAll = action({
  args: {
    userId: v.id("users"),
    clearExisting: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await ctx.runMutation(api.seed.seed, {
      userId: args.userId,
      clearExisting: args.clearExisting ?? false,
    });
    await ctx.runMutation(internal.seed.seedVehicleIntelligenceDemoData);
    await ctx.runMutation(api.seed.seedTimeSlots);
    await ctx.runMutation(api.seed.seedRewardDeals);
    return {
      success: true,
      seededForUserId: args.userId,
      clearExisting: args.clearExisting ?? false,
    };
  },
});

/**
 * Seeds reward_deals for OTOPAIR Rewards Program. Idempotent - skips if deals exist.
 */
export const seedRewardDeals = mutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db.query("reward_deals").first();
    if (existing) return { skipped: true };

    const now = Date.now();
    const deals = [
      {
        title: "Synthetic Oil Change",
        description: "Full synthetic + Filter + Fluids",
        credit_amount: 15,
        price: 69,
        is_special: true,
        display_order: 0,
      },
      {
        title: "Tire Rotation",
        description: "Rotate all 4 tires + Inspection",
        credit_amount: 10,
        price: 29,
        is_special: false,
        display_order: 1,
      },
      {
        title: "Brake Inspection",
        description: "Full brake system check",
        credit_amount: 12,
        price: 49,
        is_special: true,
        display_order: 2,
      },
      {
        title: "AC System Service",
        description: "Recharge + Leak check + Filter",
        credit_amount: 20,
        price: 89,
        is_special: false,
        display_order: 3,
      },
      {
        title: "Full Detail Package",
        description: "Interior + Exterior + Engine bay",
        credit_amount: 25,
        price: 149,
        is_special: true,
        display_order: 4,
      },
    ];
    for (const d of deals) {
      await ctx.db.insert("reward_deals", { ...d, created_at: now });
    }
    return { skipped: false, count: deals.length };
  },
});

export const seed = mutation({
  args: {
    userId: v.optional(v.id("users")),
    clearExisting: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    if (args.userId) {
      const existingUser = await ctx.db.get(args.userId);
      if (!existingUser) {
        throw new Error("User not found for provided userId.");
      }
    }

    if (args.userId && (args.clearExisting ?? false)) {
      await clearUserScopedSeedData(ctx, args.userId);
    } else if (!args.userId && (args.clearExisting ?? false)) {
      await clearTables(ctx);
    }

    const now = Date.now();

    // --- Makes (logo stored in cdn_assets, makes reference by id) ---
    // Get-or-create through lib/makeKey: a demo seed run on a DB that already
    // has Toyota/Honda must reuse those rows, not mint blind duplicates.
    const toyotaLogoId = await ctx.db.insert("cdn_assets", {
      url: "https://upload.wikimedia.org/wikipedia/commons/9/9d/Toyota_carridge_logo.svg",
    });
    const toyotaId = await getOrCreateMake(ctx.db, "Toyota", {
      logo: toyotaLogoId,
    });

    const hondaLogoId = await ctx.db.insert("cdn_assets", {
      url: "https://upload.wikimedia.org/wikipedia/commons/7/7b/Honda-logo.svg",
    });
    const hondaId = await getOrCreateMake(ctx.db, "Honda", {
      logo: hondaLogoId,
    });

    // --- Models ---
    const camryId = await ctx.db.insert("models", {
      make_id: toyotaId,
      name: "Camry",
    });

    const accordId = await ctx.db.insert("models", {
      make_id: hondaId,
      name: "Accord",
    });

    // --- Trims ---
    const leId = await ctx.db.insert("trims", {
      model_id: camryId,
      name: "LE",
      year_start: 2018,
      year_end: 2024,
    });

    const seId = await ctx.db.insert("trims", {
      model_id: camryId,
      name: "SE",
      year_start: 2018,
      year_end: 2024,
    });

    const sportId = await ctx.db.insert("trims", {
      model_id: accordId,
      name: "Sport",
      year_start: 2019,
      year_end: 2024,
    });

    // --- Engines ---
    const engineLeId = await ctx.db.insert("engines", {
      trim_id: leId,
      engine_code: "A25A-FKS",
      displacement_liters: "2.5",
      cylinders: 4,
      fuel_type: "Gasoline",
    });

    const engineSeId = await ctx.db.insert("engines", {
      trim_id: seId,
      engine_code: "A25A-FKS",
      displacement_liters: "2.5",
      cylinders: 4,
      fuel_type: "Gasoline",
    });

    const engineAccordId = await ctx.db.insert("engines", {
      trim_id: sportId,
      engine_code: "L15BE",
      displacement_liters: "1.5",
      cylinders: 4,
      fuel_type: "Gasoline",
    });

    // --- Engine Specs (patched directly onto engines table) ---
    await ctx.db.patch(engineLeId, {
      oil_viscosity: "0W-20",
      oil_capacity_qts: 4.8,
      coolant_type: "Toyota Super Long Life",
      coolant_capacity_qts: 9.2,
      data_quality: "high",
    });

    await ctx.db.patch(engineSeId, {
      oil_viscosity: "0W-20",
      oil_capacity_qts: 4.8,
      coolant_type: "Toyota Super Long Life",
      coolant_capacity_qts: 9.2,
      data_quality: "high",
    });

    await ctx.db.patch(engineAccordId, {
      oil_viscosity: "0W-20",
      oil_capacity_qts: 3.7,
      coolant_type: "Honda Type 2",
      data_quality: "high",
    });

    // --- Vehicle Specs (OEM part numbers for job_actuals suggested parts) ---
    // These now go into service_vehicle_specs keyed by engine_id + service_id.
    // For seed purposes we insert a generic spec row per engine.
    // (The full OEM part data is managed via oem_parts + part_fitments in the enrichment pipeline.)

    // --- Service Categories ---
    const maintenanceId = await ctx.db.insert("service_categories", {
      name: "Routine Maintenance",
      icon_name: "wrench",
      display_order: 1,
    });

    const tiresWheelsId = await ctx.db.insert("service_categories", {
      name: "Tires & Wheels",
      icon_name: "circle",
      display_order: 2,
    });

    const brakesId = await ctx.db.insert("service_categories", {
      name: "Brakes",
      icon_name: "octagon",
      display_order: 3,
    });

    const diagnosticsId = await ctx.db.insert("service_categories", {
      name: "Diagnostics & Electrical",
      icon_name: "zap",
      display_order: 4,
    });

    const complianceId = await ctx.db.insert("service_categories", {
      name: "Compliance",
      icon_name: "clipboard",
      display_order: 5,
    });

    // --- Services: Routine Maintenance ---
    const oilChangeId = await ctx.db.insert("services", {
      name: "Oil Change",
      slug: "oil-change",
      description: "Engine oil and filter replacement",
      service_category_id: maintenanceId,
      default_labor_hours: 0.4,
      is_labor_only: false,
      has_options: false,
      display_order: 1,
    });

    const filterReplacementId = await ctx.db.insert("services", {
      name: "Filter Replacement",
      slug: "filter-replacement",
      description: "Engine and/or cabin air filter replacement",
      service_category_id: maintenanceId,
      default_labor_hours: 0.25,
      is_labor_only: false,
      has_options: true,
      display_order: 2,
    });

    const wiperBladeId = await ctx.db.insert("services", {
      name: "Wiper Blade Replacement",
      slug: "wiper-blade-replacement",
      description: "Windshield wiper blade replacement",
      service_category_id: maintenanceId,
      default_labor_hours: 0.15,
      is_labor_only: false,
      has_options: false,
      display_order: 3,
    });

    const sparkPlugId = await ctx.db.insert("services", {
      name: "Spark Plug Replacement",
      slug: "spark-plug-replacement",
      description: "Spark plug replacement",
      service_category_id: maintenanceId,
      default_labor_hours: 0.8,
      is_labor_only: false,
      has_options: false,
      display_order: 5,
    });

    const serpentineBeltId = await ctx.db.insert("services", {
      name: "Serpentine Belt Replacement",
      slug: "serpentine-belt-replacement",
      description: "Serpentine drive belt replacement",
      service_category_id: maintenanceId,
      default_labor_hours: 0.5,
      is_labor_only: false,
      has_options: false,
      display_order: 6,
    });

    const batteryReplacementId = await ctx.db.insert("services", {
      name: "Battery Replacement",
      slug: "battery-replacement",
      description: "Replace battery with OEM battery",
      service_category_id: maintenanceId,
      default_labor_hours: 0.3,
      is_labor_only: false,
      has_options: false,
      display_order: 1,
    });

    const batteryTestId = await ctx.db.insert("services", {
      name: "Battery Test",
      slug: "battery-test",
      description: "Load test battery and charging system",
      service_category_id: maintenanceId,
      default_labor_hours: 0.2,
      is_labor_only: true,
      has_options: false,
      display_order: 2,
    });

    const coolantFlushId = await ctx.db.insert("services", {
      name: "Coolant Flush",
      slug: "coolant-flush",
      description: "Flush and replace engine coolant",
      service_category_id: maintenanceId,
      default_labor_hours: 0.8,
      is_labor_only: false,
      has_options: false,
      display_order: 1,
    });

    const transmissionFluidId = await ctx.db.insert("services", {
      name: "Transmission Fluid Service",
      slug: "transmission-fluid-service",
      description: "Replace transmission fluid",
      service_category_id: maintenanceId,
      default_labor_hours: 1,
      is_labor_only: false,
      has_options: false,
      display_order: 2,
    });

    // --- Services: Tires & Wheels ---
    const tireRotationId = await ctx.db.insert("services", {
      name: "Tire Rotation",
      slug: "tire-rotation",
      description: "Rotate tires for even wear",
      service_category_id: tiresWheelsId,
      default_labor_hours: 0.3,
      is_labor_only: true,
      has_options: false,
      display_order: 1,
    });

    const wheelBalancingId = await ctx.db.insert("services", {
      name: "Wheel Balancing",
      slug: "wheel-balancing",
      description: "Balance wheels to eliminate vibration",
      service_category_id: tiresWheelsId,
      default_labor_hours: 0.6,
      is_labor_only: false,
      has_options: true,
      display_order: 2,
    });

    const wheelAlignmentId = await ctx.db.insert("services", {
      name: "Wheel Alignment",
      slug: "wheel-alignment",
      description: "Adjust wheel angles for proper alignment",
      service_category_id: tiresWheelsId,
      default_labor_hours: 1,
      is_labor_only: true,
      has_options: false,
      display_order: 3,
    });

    const tireReplacementId = await ctx.db.insert("services", {
      name: "Tire Replacement",
      slug: "tire-replacement",
      description: "Replace tires with new OEM tires",
      service_category_id: tiresWheelsId,
      default_labor_hours: 1.2,
      is_labor_only: false,
      has_options: true,
      display_order: 4,
    });

    const tireInstallationId = await ctx.db.insert("services", {
      name: "Tire Installation",
      slug: "tire-installation",
      description: "Mount and balance customer-provided tires",
      service_category_id: tiresWheelsId,
      default_labor_hours: 1,
      is_labor_only: false,
      has_options: false,
      display_order: 5,
    });

    const tpmsSensorId = await ctx.db.insert("services", {
      name: "TPMS Sensor Calibration",
      slug: "tpms-sensor-calibration",
      description: "Reset and calibrate tire pressure monitoring sensors",
      service_category_id: tiresWheelsId,
      default_labor_hours: 0.2,
      is_labor_only: true,
      has_options: false,
      display_order: 6,
    });

    // --- Services: Brakes ---
    const brakePadsId = await ctx.db.insert("services", {
      name: "Brake Pad Replacement",
      slug: "brake-pad-replacement",
      description: "Replace brake pads with OEM parts",
      service_category_id: brakesId,
      default_labor_hours: 0.8,
      is_labor_only: false,
      has_options: true,
      display_order: 1,
    });

    const brakeRotorId = await ctx.db.insert("services", {
      name: "Brake Rotor Replacement",
      slug: "brake-rotor-replacement",
      description: "Replace brake rotors and pads with OEM parts",
      service_category_id: brakesId,
      default_labor_hours: 1.2,
      is_labor_only: false,
      has_options: true,
      display_order: 2,
    });

    const brakeFluidId = await ctx.db.insert("services", {
      name: "Brake Fluid Flush",
      slug: "brake-fluid-flush",
      description: "Flush and replace brake fluid",
      service_category_id: brakesId,
      default_labor_hours: 0.5,
      is_labor_only: false,
      has_options: false,
      display_order: 3,
    });

    // --- Services: Diagnostics & Electrical ---
    const generalDiagnosticId = await ctx.db.insert("services", {
      name: "General Diagnostic",
      slug: "general-diagnostic",
      description: "Diagnose unusual vehicle behavior or symptoms",
      service_category_id: diagnosticsId,
      default_labor_hours: 0.5,
      is_labor_only: true,
      has_options: false,
      display_order: 1,
    });

    const checkEngineLightId = await ctx.db.insert("services", {
      name: "Check Engine Light",
      slug: "check-engine-light",
      description: "Diagnose check engine light codes and causes",
      service_category_id: diagnosticsId,
      default_labor_hours: 0.5,
      is_labor_only: true,
      has_options: false,
      display_order: 2,
    });

    const brakeInspectionId = await ctx.db.insert("services", {
      name: "Brake System Inspection",
      slug: "brake-system-inspection",
      description: "Inspect brake pads, rotors, and brake system",
      service_category_id: diagnosticsId,
      default_labor_hours: 0.3,
      is_labor_only: true,
      has_options: false,
      display_order: 3,
    });

    // --- Services: Compliance ---
    const nyInspectionId = await ctx.db.insert("services", {
      name: "NY State Inspection",
      slug: "ny-state-inspection",
      description: "New York State vehicle safety and emissions inspection",
      service_category_id: complianceId,
      default_labor_hours: 0.5,
      is_labor_only: true,
      has_options: true,
      display_order: 1,
    });

    // --- Service Options: Brake Pad Replacement (axle_position) ---
    await ctx.db.insert("service_options", {
      service_id: brakePadsId,
      option_type: "axle_position",
      option_label: "Front only",
      parts_cost_low: 75,
      parts_cost_high: 95,
      labor_hours: 0.8,
      display_order: 1,
    });

    await ctx.db.insert("service_options", {
      service_id: brakePadsId,
      option_type: "axle_position",
      option_label: "Rear only",
      parts_cost_low: 55,
      parts_cost_high: 75,
      labor_hours: 0.8,
      display_order: 2,
    });

    await ctx.db.insert("service_options", {
      service_id: brakePadsId,
      option_type: "axle_position",
      option_label: "Both (front + rear)",
      parts_cost_low: 130,
      parts_cost_high: 170,
      labor_hours: 1.5,
      display_order: 3,
    });

    // --- Service Options: Brake Rotor Replacement (axle_position) ---
    await ctx.db.insert("service_options", {
      service_id: brakeRotorId,
      option_type: "axle_position",
      option_label: "Front only",
      parts_cost_low: 200,
      parts_cost_high: 260,
      labor_hours: 1.2,
      display_order: 1,
    });

    await ctx.db.insert("service_options", {
      service_id: brakeRotorId,
      option_type: "axle_position",
      option_label: "Rear only",
      parts_cost_low: 170,
      parts_cost_high: 220,
      labor_hours: 1.2,
      display_order: 2,
    });

    await ctx.db.insert("service_options", {
      service_id: brakeRotorId,
      option_type: "axle_position",
      option_label: "Both",
      parts_cost_low: 370,
      parts_cost_high: 480,
      labor_hours: 2.2,
      display_order: 3,
    });

    // --- Service Options: Filter Replacement (filter_type) ---
    await ctx.db.insert("service_options", {
      service_id: filterReplacementId,
      option_type: "filter_type",
      option_label: "Engine air filter only",
      parts_cost_low: 15,
      parts_cost_high: 30,
      labor_hours: 0.15,
      display_order: 1,
    });

    await ctx.db.insert("service_options", {
      service_id: filterReplacementId,
      option_type: "filter_type",
      option_label: "Cabin air filter only",
      parts_cost_low: 15,
      parts_cost_high: 25,
      labor_hours: 0.25,
      display_order: 2,
    });

    await ctx.db.insert("service_options", {
      service_id: filterReplacementId,
      option_type: "filter_type",
      option_label: "Both",
      parts_cost_low: 25,
      parts_cost_high: 50,
      labor_hours: 0.35,
      display_order: 3,
    });

    // --- Service Options: Tire Replacement (quantity) ---
    await ctx.db.insert("service_options", {
      service_id: tireReplacementId,
      option_type: "quantity",
      option_label: "Single tire",
      parts_cost_low: 120,
      parts_cost_high: 200,
      labor_hours: 0.3,
      display_order: 1,
    });

    await ctx.db.insert("service_options", {
      service_id: tireReplacementId,
      option_type: "quantity",
      option_label: "Pair (2 tires)",
      parts_cost_low: 240,
      parts_cost_high: 400,
      labor_hours: 0.6,
      display_order: 2,
    });

    await ctx.db.insert("service_options", {
      service_id: tireReplacementId,
      option_type: "quantity",
      option_label: "Full set (4 tires)",
      parts_cost_low: 480,
      parts_cost_high: 800,
      labor_hours: 1.2,
      display_order: 3,
    });

    // --- Service Options: Wheel Balancing (quantity) ---
    await ctx.db.insert("service_options", {
      service_id: wheelBalancingId,
      option_type: "quantity",
      option_label: "Single wheel",
      parts_cost_low: 2,
      parts_cost_high: 4,
      labor_hours: 0.15,
      display_order: 1,
    });

    await ctx.db.insert("service_options", {
      service_id: wheelBalancingId,
      option_type: "quantity",
      option_label: "Pair (2 wheels)",
      parts_cost_low: 4,
      parts_cost_high: 6,
      labor_hours: 0.3,
      display_order: 2,
    });

    await ctx.db.insert("service_options", {
      service_id: wheelBalancingId,
      option_type: "quantity",
      option_label: "Full set (4 wheels)",
      parts_cost_low: 8,
      parts_cost_high: 12,
      labor_hours: 0.6,
      display_order: 3,
    });

    // --- Service Options: NY State Inspection (inspection_scope) ---
    await ctx.db.insert("service_options", {
      service_id: nyInspectionId,
      option_type: "inspection_scope",
      option_label: "Safety + Emissions",
      parts_cost_low: 0,
      parts_cost_high: 0,
      labor_hours: 0.5,
      state_fee: 37,
      display_order: 1,
    });

    await ctx.db.insert("service_options", {
      service_id: nyInspectionId,
      option_type: "inspection_scope",
      option_label: "Safety only",
      parts_cost_low: 0,
      parts_cost_high: 0,
      labor_hours: 0.3,
      display_order: 2,
    });


    // --- Service Vehicle Specs ---
    await ctx.db.insert("service_vehicle_specs", {
      service_id: oilChangeId,
      engine_id: engineLeId,
      labor_hours: 0.5,
      parts_cost_low: 35,
      parts_cost_high: 55,
      tech_notes: "Uses 0W-20 full synthetic. Drain plug torque: 27 ft-lb.",
      confidence_score: 0.95,
    });

    await ctx.db.insert("service_vehicle_specs", {
      service_id: brakePadsId,
      engine_id: engineLeId,
      labor_hours: 1.5,
      parts_cost_low: 40,
      parts_cost_high: 80,
      tech_notes: "OEM pad part: 04465-06200. Rotor min thickness: 25mm.",
      confidence_score: 0.9,
    });

    await ctx.db.insert("service_vehicle_specs", {
      service_id: tireRotationId,
      engine_id: engineAccordId,
      labor_hours: 0.5,
      parts_cost_low: 0,
      parts_cost_high: 0,
      tech_notes: "Rotate tires in cross pattern. Check lug torque 80 ft-lb.",
      confidence_score: 0.85,
    });

    const acServiceId = await ctx.db.insert("services", {
      name: "AC System Service",
      slug: "ac-service",
      description: "AC recharge, leak check, and cabin filter replacement",
      service_category_id: maintenanceId,
      default_labor_hours: 1.0,
      is_labor_only: false,
      has_options: false,
      display_order: 4,
    });

    await ctx.db.insert("service_vehicle_specs", {
      service_id: acServiceId,
      engine_id: engineLeId,
      labor_hours: 1.0,
      parts_cost_low: 20,
      parts_cost_high: 45,
      tech_notes: "R-134a refrigerant. Recharge to 24 oz. Check cabin filter.",
      confidence_score: 0.88,
    });

    await ctx.db.insert("service_vehicle_specs", {
      service_id: batteryReplacementId,
      engine_id: engineLeId,
      labor_hours: 0.5,
      parts_cost_low: 80,
      parts_cost_high: 140,
      tech_notes: "Group 35 battery. Min 550 CCA. Reset TPMS after swap.",
      confidence_score: 0.9,
    });

    await ctx.db.insert("service_vehicle_specs", {
      service_id: wheelAlignmentId,
      engine_id: engineLeId,
      labor_hours: 1.0,
      parts_cost_low: 0,
      parts_cost_high: 0,
      tech_notes: "Four-wheel alignment. Spec: 0° camber, 0.04° toe-in.",
      confidence_score: 0.87,
    });

    // --- Shops ---
    const shop1Id = await ctx.db.insert("shops", {
      name: "AutoPro Service Center",
      slug: "autopro-service-center",
      address: "1234 Main St",
      city: "Austin",
      state: "TX",
      zip: "78701",
      lat: 30.2672,
      lng: -97.7431,
      phone: "(512) 555-0100",
      rating: 4.8,
      review_count: 142,
      labor_rate: 95,
      is_active: true,
      is_verified: true,
    });

    const shop2Id = await ctx.db.insert("shops", {
      name: "QuickFix Auto",
      slug: "quickfix-auto",
      address: "5678 Congress Ave",
      city: "Austin",
      state: "TX",
      zip: "78704",
      lat: 30.25,
      lng: -97.75,
      phone: "(512) 555-0200",
      rating: 4.5,
      review_count: 89,
      labor_rate: 85,
      is_active: true,
      is_verified: true,
    });

    const shop3Id = await ctx.db.insert("shops", {
      name: "Precision Auto Works",
      slug: "precision-auto-works",
      address: "910 Lamar Blvd",
      city: "Austin",
      state: "TX",
      zip: "78703",
      lat: 30.2785,
      lng: -97.7562,
      phone: "(512) 555-0310",
      rating: 4.9,
      review_count: 210,
      labor_rate: 105,
      is_active: true,
      is_verified: true,
    });

    const shop4Id = await ctx.db.insert("shops", {
      name: "Sunset Auto Repair",
      slug: "sunset-auto-repair",
      address: "3300 Bee Cave Rd",
      city: "Austin",
      state: "TX",
      zip: "78746",
      lat: 30.2562,
      lng: -97.8019,
      phone: "(512) 555-0420",
      rating: 4.4,
      review_count: 76,
      labor_rate: 80,
      is_active: true,
      is_verified: true,
    });

    const shop5Id = await ctx.db.insert("shops", {
      name: "Capital City Auto",
      slug: "capital-city-auto",
      address: "1801 E 51st St",
      city: "Austin",
      state: "TX",
      zip: "78723",
      lat: 30.3055,
      lng: -97.7083,
      phone: "(512) 555-0530",
      rating: 4.6,
      review_count: 118,
      labor_rate: 90,
      is_active: true,
      is_verified: true,
    });

    // --- Shop Hours (Mon-Sat for all shops; schema: 0=Sunday, 1=Monday, ... 6=Saturday) ---
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    for (const shopId of [shop1Id, shop2Id, shop3Id, shop4Id, shop5Id]) {
      for (let d = 0; d < 7; d++) {
        const isSunday = d === 0;
        await ctx.db.insert("shops_hours", {
          shop_id: shopId,
          day_of_week: d,
          day_name: dayNames[d],
          is_closed: isSunday,
          open_time: isSunday ? undefined : "08:00",
          close_time: isSunday ? undefined : "18:00",
        });
      }
    }

    // --- Shop Services (all shops offer all services) ---
    for (const shopId of [shop1Id, shop2Id, shop3Id, shop4Id, shop5Id]) {
      await ctx.db.insert("shop_services", { shop_id: shopId, service_id: oilChangeId, is_offered: true });
      await ctx.db.insert("shop_services", { shop_id: shopId, service_id: brakePadsId, is_offered: true });
      await ctx.db.insert("shop_services", { shop_id: shopId, service_id: tireRotationId, is_offered: true });
      await ctx.db.insert("shop_services", { shop_id: shopId, service_id: acServiceId, is_offered: true });
      await ctx.db.insert("shop_services", { shop_id: shopId, service_id: batteryReplacementId, is_offered: true });
      await ctx.db.insert("shop_services", { shop_id: shopId, service_id: wheelAlignmentId, is_offered: true });
    }

    // --- CDN assets (portfolio images) ---
    const asset1Id = await ctx.db.insert("cdn_assets", {
      url: "https://images.unsplash.com/photo-1486754735734-325b5831c3ad?w=800&h=600&fit=crop",
      type: "image",
      caption: "Shop bay",
    });
    const asset2Id = await ctx.db.insert("cdn_assets", {
      url: "https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?w=800&h=600&fit=crop",
      type: "image",
      caption: "Service area",
    });
    const asset3Id = await ctx.db.insert("cdn_assets", {
      url: "https://images.unsplash.com/photo-1493238792000-8113da705763?w=800&h=600&fit=crop",
      type: "image",
      caption: "Waiting area",
    });

    // --- Shop portfolio (link shops to cdn_assets) ---
    for (const [order, assetId] of [asset1Id, asset2Id, asset3Id].entries()) {
      for (const shopId of [shop1Id, shop2Id, shop3Id, shop4Id, shop5Id]) {
        await ctx.db.insert("shop_portfolio", { shop_id: shopId, content_id: assetId, display_order: order });
      }
    }

    // --- Mechanics ---
    const mech1Id = await ctx.db.insert("mechanics", {
      shop_id: shop1Id,
      first_name: "Mike",
      last_name: "Johnson",
      is_active: true,
      rating: 4.9,
      review_count: 87,
    });

    const mech2Id = await ctx.db.insert("mechanics", {
      shop_id: shop1Id,
      first_name: "Sarah",
      last_name: "Chen",
      title: "Master Mechanic",
      is_active: true,
      rating: 4.7,
      review_count: 64,
    });

    const mech3Id = await ctx.db.insert("mechanics", {
      shop_id: shop2Id,
      first_name: "James",
      last_name: "Rodriguez",
      is_active: true,
      rating: 4.6,
      review_count: 51,
    });

    const mech4Id = await ctx.db.insert("mechanics", {
      shop_id: shop3Id,
      first_name: "David",
      last_name: "Park",
      is_active: true,
      rating: 4.8,
      review_count: 73,
    });

    const mech5Id = await ctx.db.insert("mechanics", {
      shop_id: shop3Id,
      first_name: "Lisa",
      last_name: "Thompson",
      title: "Senior Technician",
      is_active: true,
      rating: 4.7,
      review_count: 58,
    });

    const mech6Id = await ctx.db.insert("mechanics", {
      shop_id: shop4Id,
      first_name: "Carlos",
      last_name: "Martinez",
      is_active: true,
      rating: 4.5,
      review_count: 42,
    });

    const mech7Id = await ctx.db.insert("mechanics", {
      shop_id: shop4Id,
      first_name: "Emma",
      last_name: "Wilson",
      title: "Lead Mechanic",
      is_active: true,
      rating: 4.9,
      review_count: 96,
    });

    const mech8Id = await ctx.db.insert("mechanics", {
      shop_id: shop5Id,
      first_name: "Robert",
      last_name: "Kim",
      is_active: true,
      rating: 4.6,
      review_count: 37,
    });

    // Availability is inferred at read/write time; seed data does not
    // materialize free time_slots.

    // --- Users (main seeded user is provided userId when present) ---
    let userId: any;
    if (args.userId) {
      const existingUser = await ctx.db.get(args.userId);
      if (!existingUser) {
        throw new Error("User not found for provided userId.");
      }

      await ctx.db.patch(args.userId, {
        onboardingCompleted: true,
        lastUpdated: Date.now(),
        email: existingUser.email ?? "demo@otopair.com",
        phone: existingUser.phone ?? "(512) 555-9999",
        first_name: existingUser.first_name ?? "Alex",
        last_name: existingUser.last_name ?? "Demo",
      });
      userId = args.userId;
    } else {
      userId = await ctx.db.insert("users", {
        clerkUserId: SEED_DEMO_CLERK_USER_ID,
        onboardingCompleted: true,
        createdAt: Date.now(),
        lastUpdated: Date.now(),
        email: "demo@otopair.com",
        phone: "(512) 555-9999",
        first_name: "Alex",
        last_name: "Demo",
      });
    }

    const user2Id = await ctx.db.insert("users", {
      clerkUserId: "seed-demo-user-3",
      onboardingCompleted: true,
      createdAt: Date.now(),
      lastUpdated: Date.now(),
      email: "jordan@otopair.com",
      phone: "(512) 555-1111",
      first_name: "Jordan",
      last_name: "Lee",
    });

    // --- Vehicles (canonical VINs) ---
    const vinCamry = "4T1B11HK5JU123456";
    const vinAccord = "1HGCV1F39KA123456";

    const ensureSeedVehicle = async (
      vin: string,
      fields: {
        trim_id: any;
        engine_id: any;
        year: number;
        metadata: { color: string; body_style: string };
      },
    ) => {
      const rows = await ctx.db
        .query("vehicles")
        .withIndex("by_vin", (q) => q.eq("vin", vin))
        .collect();
      const existing = rows[0];
      if (existing) {
        // Keep first row, remove duplicates for this VIN.
        for (let i = 1; i < rows.length; i++) {
          await ctx.db.delete(rows[i]._id);
        }
        await ctx.db.patch(existing._id, {
          ...fields,
          updated_at: now,
        });
        return existing._id;
      }
      return await ctx.db.insert("vehicles", {
        vin,
        ...fields,
        created_at: now,
        updated_at: now,
      });
    };

    await ensureSeedVehicle(vinCamry, {
      trim_id: leId,
      engine_id: engineLeId,
      year: 2022,
      metadata: { color: "Silver", body_style: "Sedan" },
    });

    await ensureSeedVehicle(vinAccord, {
      trim_id: sportId,
      engine_id: engineAccordId,
      year: 2021,
      metadata: { color: "Black", body_style: "Sedan" },
    });

    // --- Vehicle Owners (multi-owner demo) ---
    await ctx.db.insert("vehicle_owners", {
      vin: vinCamry,
      user_id: userId,
      status: "active",
      nickname: "My Camry",
      is_primary: true,
      mileage: 35000,
      added_at: now,
    });

    await ctx.db.insert("vehicle_owners", {
      vin: vinCamry,
      user_id: user2Id,
      status: "active",
      nickname: "Shared Camry",
      is_primary: false,
      mileage: 35200,
      added_at: now,
    });

    await ctx.db.insert("vehicle_owners", {
      vin: vinAccord,
      user_id: user2Id,
      status: "active",
      nickname: "My Accord",
      is_primary: true,
      mileage: 22000,
      added_at: now,
    });

    // --- Onboarding Q&A (unified table) ---
    await ctx.db.insert("onboarding_questions_answers", {
      user_id: userId,
      questions_and_answers: [{ question: "How often do you service your car?", answer: "Every 3 months" }],
      last_updated: now,
    });

    // --- Bookings + Payments + Transactions (coherent user history) ---
    const createSeedBookingWithPaymentTransaction = async ({
      vin,
      shopId,
      mechanicId,
      serviceId,
      serviceName,
      laborCost,
      partsCost,
      dateOffsetDays,
      scheduledTime,
      status,
      liveStage,
      key,
    }: {
      vin: string;
      shopId: any;
      mechanicId: any;
      serviceId: any;
      serviceName: string;
      laborCost: number;
      partsCost: number;
      dateOffsetDays: number;
      scheduledTime: string;
      status: "confirmed" | "completed" | "in_progress";
      liveStage?: string;
      key: string;
    }) => {
      const when = new Date(now);
      when.setDate(when.getDate() + dateOffsetDays);
      const scheduledDate = when.toISOString().split("T")[0];
      const createdAt = now + dateOffsetDays * 24 * 60 * 60 * 1000;
      const totalCost = laborCost + partsCost;
      const bookingId = await ctx.db.insert("bookings", {
        user_id: userId,
        vin,
        shop_id: shopId,
        mechanic_id: mechanicId,
        service_ids: [serviceId],
        scheduled_date: scheduledDate,
        scheduled_time: scheduledTime,
        labor_cost: laborCost,
        parts_cost: partsCost,
        total_cost: totalCost,
        status,
        ...(status === "in_progress" && { live_stage: liveStage ?? "service_in_progress" }),
        created_at: createdAt,
        updated_at: createdAt,
      });

      await ctx.db.insert("booking_status_history", {
        booking_id: bookingId,
        old_status: undefined,
        new_status: "confirmed",
        changed_by: userId,
        reason: `seeded_${key}`,
        changed_at: createdAt,
      });

      if (status === "completed") {
        await ctx.db.insert("booking_status_history", {
          booking_id: bookingId,
          old_status: "confirmed",
          new_status: "completed",
          changed_by: userId,
          reason: `seeded_${key}`,
          changed_at: createdAt + 45 * 60 * 1000,
        });
      } else if (status === "in_progress") {
        await ctx.db.insert("booking_status_history", {
          booking_id: bookingId,
          old_status: "confirmed",
          new_status: "in_progress",
          changed_by: userId,
          reason: `seeded_${key}`,
          changed_at: createdAt + 5 * 60 * 1000,
        });
      }

      const paymentId = await ctx.db.insert("payments", {
        booking_id: bookingId,
        user_id: userId,
        shop_id: shopId,
        amount: totalCost,
        payment_method: "card",
        status: "completed",
        transaction_id: `txn_seed_${key}`,
        stripe_payment_intent_id: `pi_seed_${key}`,
        idempotency_key: `seed_${key}`,
        created_at: createdAt,
        updated_at: createdAt,
      });

      await ctx.db.insert("payment_status_history", {
        payment_id: paymentId,
        old_status: "processing",
        new_status: "completed",
        error_code: undefined,
        error_message: undefined,
        changed_at: createdAt,
      });

      const shop = (await ctx.db.get(shopId)) as any;
      await ctx.db.insert("transactions", {
        user_id: userId,
        created_at: createdAt,
        description: shop?.name ?? "Otopair Service",
        sub_description: serviceName,
        amount: -totalCost,
        currency: "USD",
        status: "completed",
        transaction_type: "charge",
        shop_id: shopId,
        booking_id: bookingId,
        payment_id: paymentId,
        icon_type: "wrench",
      });

      return { bookingId, paymentId, createdAt };
    };

    const completedHistoryPrimary = await createSeedBookingWithPaymentTransaction({
      vin: vinCamry,
      shopId: shop1Id,
      mechanicId: mech2Id,
      serviceId: oilChangeId,
      serviceName: "Oil Change",
      laborCost: 47.5,
      partsCost: 45,
      dateOffsetDays: -14,
      scheduledTime: "10:00",
      status: "completed",
      key: "history_1",
    });

    await createSeedBookingWithPaymentTransaction({
      vin: vinCamry,
      shopId: shop2Id,
      mechanicId: mech3Id,
      serviceId: brakePadsId,
      serviceName: "Brake Pads Replacement",
      laborCost: 95,
      partsCost: 60,
      dateOffsetDays: -45,
      scheduledTime: "11:00",
      status: "completed",
      key: "history_2",
    });

    await createSeedBookingWithPaymentTransaction({
      vin: vinCamry,
      shopId: shop1Id,
      mechanicId: mech1Id,
      serviceId: tireRotationId,
      serviceName: "Tire Rotation",
      laborCost: 30,
      partsCost: 10,
      dateOffsetDays: 3,
      scheduledTime: "09:00",
      status: "confirmed",
      key: "upcoming_1",
    });

    // --- Live Tracker (in_progress today) ---
    await createSeedBookingWithPaymentTransaction({
      vin: vinCamry,
      shopId: shop2Id,
      mechanicId: mech3Id,
      serviceId: oilChangeId,
      serviceName: "Oil Change",
      laborCost: 47.5,
      partsCost: 42,
      dateOffsetDays: 0,
      scheduledTime: "09:00",
      status: "in_progress",
      liveStage: "service_in_progress",
      key: "live_1",
    });

    // --- More upcoming ---
    await createSeedBookingWithPaymentTransaction({
      vin: vinCamry,
      shopId: shop3Id,
      mechanicId: mech4Id,
      serviceId: acServiceId,
      serviceName: "AC System Service",
      laborCost: 95,
      partsCost: 35,
      dateOffsetDays: 7,
      scheduledTime: "10:00",
      status: "confirmed",
      key: "upcoming_2",
    });

    await createSeedBookingWithPaymentTransaction({
      vin: vinCamry,
      shopId: shop5Id,
      mechanicId: mech8Id,
      serviceId: wheelAlignmentId,
      serviceName: "Wheel Alignment",
      laborCost: 89,
      partsCost: 0,
      dateOffsetDays: 12,
      scheduledTime: "13:00",
      status: "confirmed",
      key: "upcoming_3",
    });

    // --- More completed history ---
    await createSeedBookingWithPaymentTransaction({
      vin: vinCamry,
      shopId: shop3Id,
      mechanicId: mech4Id,
      serviceId: oilChangeId,
      serviceName: "Oil Change",
      laborCost: 47.5,
      partsCost: 45,
      dateOffsetDays: -7,
      scheduledTime: "11:00",
      status: "completed",
      key: "history_3",
    });

    await createSeedBookingWithPaymentTransaction({
      vin: vinCamry,
      shopId: shop4Id,
      mechanicId: mech6Id,
      serviceId: wheelAlignmentId,
      serviceName: "Wheel Alignment",
      laborCost: 89,
      partsCost: 0,
      dateOffsetDays: -30,
      scheduledTime: "14:00",
      status: "completed",
      key: "history_4",
    });

    await createSeedBookingWithPaymentTransaction({
      vin: vinCamry,
      shopId: shop3Id,
      mechanicId: mech5Id,
      serviceId: acServiceId,
      serviceName: "AC System Service",
      laborCost: 95,
      partsCost: 32,
      dateOffsetDays: -42,
      scheduledTime: "09:00",
      status: "completed",
      key: "history_5",
    });

    await createSeedBookingWithPaymentTransaction({
      vin: vinCamry,
      shopId: shop4Id,
      mechanicId: mech7Id,
      serviceId: batteryReplacementId,
      serviceName: "Battery Replacement",
      laborCost: 45,
      partsCost: 115,
      dateOffsetDays: -68,
      scheduledTime: "10:00",
      status: "completed",
      key: "history_6",
    });

    await createSeedBookingWithPaymentTransaction({
      vin: vinCamry,
      shopId: shop5Id,
      mechanicId: mech8Id,
      serviceId: oilChangeId,
      serviceName: "Oil Change",
      laborCost: 47.5,
      partsCost: 45,
      dateOffsetDays: -95,
      scheduledTime: "11:00",
      status: "completed",
      key: "history_7",
    });

    await createSeedBookingWithPaymentTransaction({
      vin: vinCamry,
      shopId: shop1Id,
      mechanicId: mech1Id,
      serviceId: brakePadsId,
      serviceName: "Brake Pad Replacement",
      laborCost: 95,
      partsCost: 70,
      dateOffsetDays: -115,
      scheduledTime: "08:00",
      status: "completed",
      key: "history_8",
    });

    const bookingId = completedHistoryPrimary.bookingId;

    // --- Job Actuals ---
    const jobActualId = await ctx.db.insert("job_actuals", {
      booking_id: bookingId,
      mechanic_id: mech2Id,
      actual_labor_minutes: 30,
      actual_parts_cost: 42,
      started_at: completedHistoryPrimary.createdAt,
      completed_at_ms: completedHistoryPrimary.createdAt + 25 * 60 * 1000,
      logged_at_ms: completedHistoryPrimary.createdAt + 30 * 60 * 1000,
      created_at: completedHistoryPrimary.createdAt + 30 * 60 * 1000,
      updated_at: completedHistoryPrimary.createdAt + 30 * 60 * 1000,
      difficulty_rating: 2,
      parts_used: [{ part_name: "Oil Filter", oem_number: "90915-YZZD4", cost: 12 }],
      technician_notes: "Standard oil change completed.",
      finalized_at_ms: completedHistoryPrimary.createdAt + 30 * 60 * 1000,
    });

    // --- Review ---
    await ctx.db.insert("reviews", {
      booking_id: bookingId,
      shop_id: shop1Id,
      user_id: userId,
      mechanic_id: mech2Id,
      rating: 5,
      comment: "Great service!",
      created_at: completedHistoryPrimary.createdAt + 2 * 60 * 60 * 1000,
    });

    // --- Follow-up ---
    await ctx.db.insert("follow_ups", {
      user_id: userId,
      vin: vinCamry,
      booking_id: bookingId,
      service_id: oilChangeId,
      follow_up_type: "maintenance_due",
      scheduled_for: completedHistoryPrimary.createdAt + 90 * 24 * 60 * 60 * 1000,
      status: "pending",
      message: "Time to schedule your next oil change",
      created_at: completedHistoryPrimary.createdAt + 2 * 60 * 60 * 1000,
    });

    // --- AI Conversations + Messages ---
    const convoId = await ctx.db.insert("ai_conversations", {
      user_id: userId,
      started_at: completedHistoryPrimary.createdAt - 10 * 60 * 1000,
      ended_at: completedHistoryPrimary.createdAt - 5 * 60 * 1000,
      scenario_detected: "price_check",
      led_to_booking: true,
      booking_id: bookingId,
      message_count: 2,
      session_id: "seed-session-001",
    });

    await ctx.db.insert("ai_messages", {
      conversation_id: convoId,
      role: "user",
      content: "How much is an oil change?",
      timestamp: completedHistoryPrimary.createdAt - 9 * 60 * 1000,
    });

    await ctx.db.insert("ai_messages", {
      conversation_id: convoId,
      role: "assistant",
      content: "Most oil changes range from $70-$110 for synthetic.",
      timestamp: completedHistoryPrimary.createdAt - 8 * 60 * 1000,
      confidence_score: 0.88,
    });

    // --- Analytics Events ---
    await ctx.db.insert("analytics_events", {
      user_id: userId,
      event_type: "booking_created",
      event_category: "booking",
      event_data: {
        booking_id: bookingId,
        shop_id: shop1Id,
        service_id: oilChangeId,
        screen_name: "BookingConfirmation",
      },
      timestamp: completedHistoryPrimary.createdAt,
      session_id: "seed-session-001",
    });

    // --- Conversion Funnel ---
    await ctx.db.insert("conversion_funnels", {
      user_id: userId,
      funnel_type: "booking_flow",
      stage: "completed",
      booking_id: bookingId,
      entered_at: completedHistoryPrimary.createdAt - 30 * 60 * 1000,
      exited_at: completedHistoryPrimary.createdAt - 25 * 60 * 1000,
      completed: true,
      drop_off_reason: undefined,
    });

    // --- Labor Times (replaces deprecated service_insights) ---
    // Find or create vehicle_config for this engine
    const configsForLabor = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_engine", (q) => q.eq("engine_id", engineLeId))
      .collect();
    const laborConfigId = configsForLabor[0]?._id;
    if (laborConfigId) {
      await ctx.db.insert("labor_times", {
        vehicle_config_id: laborConfigId,
        service_id: oilChangeId,
        book_hours: 0.5,
        empirical_hours: 0.5,
        empirical_sample_size: 10,
        source: "seed",
        confidence: 0.9,
        data_quality: "high",
        created_at: now,
      });
    }

    // --- Enrichment Runs (replaces deprecated ai_enrichment_logs + manual_review_queue) ---
    if (laborConfigId) {
      await ctx.db.insert("enrichment_runs", {
        vehicle_config_id: laborConfigId,
        version: "1.0",
        trigger: "seed",
        status: "pending",
        total_tokens_in: 0,
        total_tokens_out: 0,
        fill_rate: 0.65,
        created_at: now,
      });
    }

    // --- Spec Variances ---
    await ctx.db.insert("spec_variances", {
      engine_id: engineLeId,
      service_id: oilChangeId,
      job_actual_id: jobActualId,
      predicted_labor_hours: 0.5,
      actual_labor_hours: 0.5,
      predicted_parts_cost: 45,
      actual_parts_cost: 42,
      variance_percentage: -6.7,
      flagged_for_review: false,
      reviewed_at: undefined,
      notes: undefined,
      created_at: now,
    });

    // --- Spec Confirmations ---
    await ctx.db.insert("spec_confirmations", {
      user_id: userId,
      engine_id: engineLeId,
      service_id: oilChangeId,
      booking_id: bookingId,
      confirmed_accurate: true,
      feedback: "Specs matched my vehicle.",
      confirmed_at: now,
    });

    return { success: true };
  },
});

export const seedLearningPipelineDemo = mutation({
  args: {},
  handler: async (ctx) => {
    // 1. Clean existing demo bookings (confirmed/in_progress) + their job_actuals + service_insights
    const allBookings = await ctx.db.query("bookings").collect();
    const demoBookings = allBookings.filter((b) => b.status === "confirmed" || b.status === "in_progress");
    for (const b of demoBookings) {
      const allActuals = await ctx.db.query("job_actuals").collect();
      const related = allActuals.filter((ja) => ja.booking_id === b._id);
      for (const ja of related) {
        await ctx.db.delete(ja._id);
      }
      await ctx.db.delete(b._id);
    }

    // Clean labor_times so each demo run starts fresh (replaces deprecated service_insights)
    const allLaborTimes = await ctx.db.query("labor_times").collect();
    for (const lt of allLaborTimes) {
      await ctx.db.delete(lt._id);
    }

    // 2. Look up existing entities
    const users = await ctx.db.query("users").collect();
    const user = users.find((u) => u.email === "demo@otopair.com");
    if (!user) throw new Error("Demo user not found. Run seed first.");

    const owners = await ctx.db.query("vehicle_owners").collect();
    const owner = owners.find((o) => o.user_id === user._id && o.status === "active");
    if (!owner) throw new Error("Demo vehicle owner not found. Run seed first.");

    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", owner.vin))
      .unique();
    if (!vehicle) throw new Error("Demo vehicle not found. Run seed first.");

    const services = await ctx.db.query("services").collect();
    const oilChange = services.find((s) => s.slug === "oil-change");
    if (!oilChange) throw new Error("Oil Change service not found. Run seed first.");

    const shops = await ctx.db.query("shops").collect();
    const activeShops = shops.filter((s) => s.is_active);
    if (activeShops.length === 0) throw new Error("No active shop found. Run seed first.");

    const mechanics = await ctx.db.query("mechanics").collect();

    // Find a shop that has an active mechanic
    let shop = activeShops[0];
    let mechanic = mechanics.find((m) => m.shop_id === shop._id && m.is_active);

    for (const s of activeShops) {
      const m = mechanics.find((m) => m.shop_id === s._id && m.is_active);
      if (m) {
        shop = s;
        mechanic = m;
        break;
      }
    }
    if (!mechanic) throw new Error("No active mechanic found at any shop.");

    // 3. Pick a demo schedule time. Availability is inferred, not stored.
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const scheduledDate = tomorrow.toISOString().split("T")[0];
    const scheduledTime = "10:00";

    // 4. Insert a confirmed booking
    const laborHours = oilChange.default_labor_hours ?? 0;
    const laborCost = laborHours * (shop.labor_rate ?? 0);
    const partsCost = 47;
    const totalCost = laborCost + partsCost;

    const bookingId = await ctx.db.insert("bookings", {
      user_id: user._id,
      vin: vehicle.vin,
      shop_id: shop._id,
      mechanic_id: mechanic._id,
      service_ids: [oilChange._id],
      scheduled_date: scheduledDate,
      scheduled_time: scheduledTime,
      labor_cost: laborCost,
      parts_cost: partsCost,
      total_cost: totalCost,
      status: "confirmed",
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    const engine = vehicle.engine_id ? await ctx.db.get(vehicle.engine_id) : null;

    return {
      success: true,
      bookingId,
      engineId: vehicle.engine_id,
      mechanicId: mechanic._id,
      summary: `Booking created: Oil Change for ${engine?.engine_code ?? "unknown"} at ${shop.name} with ${mechanic.first_name} ${mechanic.last_name}`,
    };
  },
});

/**
 * Internal demo seed for vehicle intelligence tables (specs + fitments).
 *
 * Idempotently seeds a Camry LE powertrain with specs, fitments, and a demo VIN.
 */
export const seedVehicleIntelligenceDemoData = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    const ensureMake = async (name: string, logoUrl: string) => {
      // Key-normalized lookup — the old exact-name find was case-sensitive
      // and re-created "MERCEDES-BENZ"-style twins of existing makes.
      const existing = await findMakeByName(ctx.db, name);
      if (existing) return existing;
      const logoId = await ctx.db.insert("cdn_assets", { url: logoUrl });
      const id = await getOrCreateMake(ctx.db, name, { logo: logoId });
      return (await ctx.db.get(id))!;
    };

    const ensureModel = async (make_id: any, name: string) => {
      const existing = (await ctx.db.query("models").collect()).find((m) => m.make_id === make_id && m.name === name);
      if (existing) return existing;
      const id = await ctx.db.insert("models", { make_id, name });
      return (await ctx.db.get(id))!;
    };

    const ensureTrim = async (model_id: any, name: string, year_start: number, year_end: number) => {
      const existing = (await ctx.db.query("trims").collect()).find((t) => t.model_id === model_id && t.name === name);
      if (existing) return existing;
      const id = await ctx.db.insert("trims", { model_id, name, year_start, year_end });
      return (await ctx.db.get(id))!;
    };

    const ensureEngine = async (trim_id: any) => {
      const existing = (await ctx.db.query("engines").collect()).find(
        (e) => e.trim_id === trim_id && e.engine_code === "A25A-FKS"
      );
      if (existing) return existing;
      const id = await ctx.db.insert("engines", {
        trim_id,
        engine_code: "A25A-FKS",
        displacement_liters: "2.5",
        cylinders: 4,
        fuel_type: "Gasoline",
      });
      return (await ctx.db.get(id))!;
    };

    const ensureTransmission = async (trim_id: any) => {
      const existing = await ctx.db
        .query("transmissions")
        .withIndex("by_trim_type", (q) => q.eq("trim_id", trim_id).eq("transmission_type", "automatic"))
        .unique();
      if (existing) {
        const updates: Record<string, any> = {};
        if (!existing.code) updates.code = "UA80E";
        if (!existing.notes) updates.notes = "8-speed automatic";
        if (existing.confidence_score === undefined) updates.confidence_score = 0.9;
        if (Object.keys(updates).length > 0) {
          await ctx.db.patch(existing._id, updates);
        }
        return (await ctx.db.get(existing._id))!;
      }
      const id = await ctx.db.insert("transmissions", {
        trim_id,
        transmission_type: "automatic",
        code: "UA80E",
        notes: "8-speed automatic",
        confidence_score: 0.9,
        created_at: now,
      });
      return (await ctx.db.get(id))!;
    };

    const ensureChassisVariant = async (trim_id: any) => {
      const existing = await ctx.db
        .query("chassis_variants")
        .withIndex("by_trim_drivetrain", (q) => q.eq("trim_id", trim_id).eq("drivetrain_type", "fwd"))
        .unique();
      if (existing) {
        const updates: Record<string, any> = {};
        if (!existing.notes) updates.notes = "Front-wheel drive platform";
        if (existing.confidence_score === undefined) updates.confidence_score = 0.88;
        if (Object.keys(updates).length > 0) {
          await ctx.db.patch(existing._id, updates);
        }
        return (await ctx.db.get(existing._id))!;
      }
      const id = await ctx.db.insert("chassis_variants", {
        trim_id,
        drivetrain_type: "fwd",
        notes: "Front-wheel drive platform",
        confidence_score: 0.88,
        created_at: now,
      });
      return (await ctx.db.get(id))!;
    };

    const ensurePart = async (oem_part_number: string, name: string, category?: string, notes?: string) => {
      const existing = await ctx.db
        .query("oem_parts")
        .withIndex("by_part_number", (q) => q.eq("oem_part_number", oem_part_number))
        .unique();
      if (existing) return existing;
      const id = await ctx.db.insert("oem_parts", {
        oem_part_number,
        name,
        category,
        notes,
        created_at: now,
      });
      return (await ctx.db.get(id))!;
    };

    const ensureEngineSpecs = async (engine_id: any) => {
      // Patch spec fields directly onto engines table (engine_specs deprecated)
      await ctx.db.patch(engine_id, {
        oil_viscosity: "0W-20",
        oil_capacity_qts: 4.8,
        coolant_type: "Toyota Super Long Life",
        coolant_capacity_qts: 9.2,
        spark_plug_quantity: 4,
        spark_plug_gap_mm: 1.1,
        data_quality: "high",
      });
      return (await ctx.db.get(engine_id))!;
    };

    const ensureTransmissionSpecs = async (transmission_id: any) => {
      // Patch spec fields directly onto transmissions table (transmission_specs deprecated)
      await ctx.db.patch(transmission_id, {
        fluid_type: "Toyota WS ATF",
        fluid_capacity_drain_fill_qts: 7.6,
        confidence_score: 0.9,
        data_quality: "high",
      });
      return (await ctx.db.get(transmission_id))!;
    };

    const ensureTrimSpecs = async (trim_id: any) => {
      const existing = await ctx.db
        .query("trim_specs")
        .withIndex("by_trim", (q) => q.eq("trim_id", trim_id))
        .unique();
      const payload = {
        tire_size_front: "205/65R16",
        tire_size_rear: "205/65R16",
        recommended_tire_pressure_front_psi: 35,
        recommended_tire_pressure_rear_psi: 35,
        lug_nut_torque_ft_lbs: 76,
        wiper_blade_driver_size_in: 26,
        wiper_blade_passenger_size_in: 18,
        parking_brake_type: "drum-in-hat",
        confidence_score: 0.9,
      };
      if (existing) {
        await ctx.db.patch(existing._id, payload);
        return (await ctx.db.get(existing._id))!;
      }
      const id = await ctx.db.insert("trim_specs", {
        ...payload,
        trim_id,
        created_at: now,
      });
      return (await ctx.db.get(id))!;
    };

    // Unified fitment function — all fitments go into part_fitments keyed by vehicle_config_id
    const ensurePartFitment = async (
      vehicleConfigId: any,
      serviceType: string,
      partId: any,
      extras: { quantity_needed?: number; confidence?: number; position?: string }
    ) => {
      const existing = await ctx.db
        .query("part_fitments")
        .withIndex("by_config_service", (q) =>
          q.eq("vehicle_config_id", vehicleConfigId).eq("service_type", serviceType)
        )
        .first();
      const payload = {
        part_id: partId,
        service_type: serviceType,
        quantity_needed: extras.quantity_needed ?? 1,
        confidence: extras.confidence ?? 0.9,
        position: extras.position,
        data_quality: "high" as const,
        created_at: existing ? existing.created_at : now,
      };
      if (existing) {
        await ctx.db.patch(existing._id, payload);
        return (await ctx.db.get(existing._id))!;
      }
      const id = await ctx.db.insert("part_fitments", {
        vehicle_config_id: vehicleConfigId,
        ...payload,
      });
      return (await ctx.db.get(id))!;
    };

    const ensureVehicle = async (
      vin: string,
      fields: { trim_id: any; engine_id: any; transmission_id: any; chassis_id: any; year: number; vehicle_config_id?: any }
    ) => {
      const normalized = vin.toUpperCase().trim();
      const rows = await ctx.db
        .query("vehicles")
        .withIndex("by_vin", (q) => q.eq("vin", normalized))
        .collect();
      const existing = rows[0];
      if (existing) {
        // Keep first row, remove duplicates for this VIN so future unique-like lookups are safe.
        for (let i = 1; i < rows.length; i++) {
          await ctx.db.delete(rows[i]._id);
        }
        await ctx.db.patch(existing._id, {
          ...fields,
          updated_at: now,
        });
        return (await ctx.db.get(existing._id))!;
      }
      const id = await ctx.db.insert("vehicles", {
        vin: normalized,
        ...fields,
        created_at: now,
        updated_at: now,
      });
      return (await ctx.db.get(id))!;
    };

    // --- Hierarchy ---
    const make = await ensureMake(
      "Toyota",
      "https://upload.wikimedia.org/wikipedia/commons/9/9d/Toyota_carridge_logo.svg"
    );
    const model = await ensureModel(make._id, "Camry");
    const trim = await ensureTrim(model._id, "LE", 2018, 2024);
    const engine = await ensureEngine(trim._id);
    const transmission = await ensureTransmission(trim._id);
    const chassis = await ensureChassisVariant(trim._id);

    // --- Parts ---
    const oilFilter = await ensurePart("90915-YZZN1", "Engine Oil Filter", "filter", "Toyota OEM");
    const engineAirFilter = await ensurePart("17801-0H050", "Engine Air Filter", "filter");
    const cabinAirFilter = await ensurePart("87139-07010", "Cabin Air Filter", "filter");
    const atfFilter = await ensurePart("35330-33050", "ATF Filter Kit", "transmission");
    const battery = await ensurePart("35-AGM", "Group 35 AGM Battery", "battery");

    // --- Specs ---
    await ensureEngineSpecs(engine._id);
    await ensureTransmissionSpecs(transmission._id);
    await ensureTrimSpecs(trim._id);

    // --- Vehicle Config (needed for part_fitments) ---
    const configKey = `Toyota_Camry_LE_2018_${engine.engine_code ?? "2AR-FE"}`;
    let vehicleConfig = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_config_key", (q) => q.eq("config_key", configKey))
      .unique();
    if (!vehicleConfig) {
      const vcId = await ctx.db.insert("vehicle_configs", {
        config_key: configKey,
        year: 2018,
        make_id: make._id,
        model_id: model._id,
        trim_name: "LE",
        engine_id: engine._id,
        transmission_id: transmission._id,
        enrichment_status: "seeded",
        fill_rate: 1.0,
        created_at: now,
      });
      vehicleConfig = (await ctx.db.get(vcId))!;
    }

    // --- Fitments (unified part_fitments table) ---
    await ensurePartFitment(vehicleConfig._id, "oil_filter", oilFilter._id, {
      quantity_needed: 1,
      confidence: 0.92,
    });
    await ensurePartFitment(vehicleConfig._id, "engine_air_filter", engineAirFilter._id, {
      quantity_needed: 1,
      confidence: 0.9,
    });
    await ensurePartFitment(vehicleConfig._id, "cabin_air_filter", cabinAirFilter._id, {
      quantity_needed: 1,
      confidence: 0.9,
    });
    await ensurePartFitment(vehicleConfig._id, "transmission_filter", atfFilter._id, {
      quantity_needed: 1,
      confidence: 0.9,
    });
    await ensurePartFitment(vehicleConfig._id, "battery", battery._id, {
      quantity_needed: 1,
      confidence: 0.9,
    });

    // --- Demo vehicle with VIN ---
    const vin = "4T1B11HK5JU123456";
    const vehicle = await ensureVehicle(vin, {
      trim_id: trim._id,
      engine_id: engine._id,
      transmission_id: transmission._id,
      chassis_id: chassis._id,
      vehicle_config_id: vehicleConfig._id,
      year: 2018,
    });

    return {
      vin: vehicle.vin,
      trim_id: trim._id,
      engine_id: engine._id,
      transmission_id: transmission._id,
      chassis_id: chassis._id,
      parts_seeded: [oilFilter._id, engineAirFilter._id, cabinAirFilter._id, atfFilter._id, battery._id],
    };
  },
});

/** John Doe account: clerkUserId user_38uSI8ArZJ0HMY9AwvQLOZiIo53 */
const JOHN_DOE_CLERK_USER_ID = "user_38uSI8ArZJ0HMY9AwvQLOZiIo53";

const SEED_CAR_CLERK_USER_ID = "user_39FwQkrjpFYGOQ0gkPIk1DEf0FW";

/**
 * Seeds car data for user_39FwQkrjpFYGOQ0gkPIk1DEf0FW.
 * User must already exist (sign in first). Adds 2 vehicles, vehicle_owners, vehicle_tiers, user_reward_wallets.
 * Run: npx convex run seed:seedCarsForUser39FwQkrjp
 */
export const seedCarsForUser39FwQkrjp = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", SEED_CAR_CLERK_USER_ID))
      .unique();
    if (!user) throw new Error(`User ${SEED_CAR_CLERK_USER_ID} not found. Sign in first to create the user.`);

    const owners = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_user_id", (q) => q.eq("user_id", user!._id))
      .collect();
    if (owners.length > 0) {
      const now = Date.now();
      const wallet = await ctx.db
        .query("user_reward_wallets")
        .withIndex("by_user_id", (q) => q.eq("user_id", user!._id))
        .unique();
      if (wallet) {
        await ctx.db.patch(wallet._id, { balance: 47.5, updated_at: now });
      } else {
        await ctx.db.insert("user_reward_wallets", {
          user_id: user!._id,
          balance: 47.5,
          auto_apply_to_booking: true,
          created_at: now,
          updated_at: now,
        });
      }
      return { success: true, message: "User already has vehicles", vehicleCount: owners.length };
    }

    const engines = await ctx.db.query("engines").collect();
    const engine = engines.find((e) => e.engine_code === "A25A-FKS");
    if (!engine) throw new Error("Engine A25A-FKS not found. Seed vehicle data first (run full seed).");

    const now = Date.now();

    // 2018 Toyota Camry LE
    const vin1 = "4T1B11HK5JU123457";
    const existingV1 = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", vin1))
      .unique();
    if (!existingV1) {
      await ctx.db.insert("vehicles", {
        vin: vin1,
        engine_id: engine._id,
        year: 2018,
        created_at: now,
        updated_at: now,
      });
    }
    await ctx.db.insert("vehicle_owners", {
      vin: vin1,
      user_id: user!._id,
      status: "active",
      nickname: "My Camry",
      is_primary: true,
      mileage: 72000,
      added_at: now,
    });

    // 2020 Honda Accord (use same engine for simplicity - in prod would look up Honda engine)
    const vin2 = "1HGCV1F15LA012345";
    const existingV2 = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", vin2))
      .unique();
    if (!existingV2) {
      await ctx.db.insert("vehicles", {
        vin: vin2,
        engine_id: engine._id,
        year: 2020,
        created_at: now,
        updated_at: now,
      });
    }
    await ctx.db.insert("vehicle_owners", {
      vin: vin2,
      user_id: user!._id,
      status: "active",
      nickname: "Honda Accord",
      is_primary: false,
      mileage: 45000,
      added_at: now,
    });

    // vehicle_tiers for rewards (Driver default)
    for (const vin of [vin1, vin2]) {
      const existing = await ctx.db
        .query("vehicle_tiers")
        .withIndex("by_vin_user", (q) => q.eq("vin", vin).eq("user_id", user!._id))
        .unique();
      if (!existing) {
        await ctx.db.insert("vehicle_tiers", {
          vin,
          user_id: user!._id,
          tier: vin === vin1 ? "preferred" : "driver",
          spend_12mo: vin === vin1 ? 850 : 0,
          created_at: now,
          updated_at: now,
        });
      }
    }

    // user_reward_wallets for membership balance ($47.50)
    const wallet = await ctx.db
      .query("user_reward_wallets")
      .withIndex("by_user_id", (q) => q.eq("user_id", user!._id))
      .unique();
    if (!wallet) {
      await ctx.db.insert("user_reward_wallets", {
        user_id: user!._id,
        balance: 47.5,
        auto_apply_to_booking: true,
        created_at: now,
        updated_at: now,
      });
    } else {
      await ctx.db.patch(wallet._id, { balance: 47.5, updated_at: now });
    }

    return { success: true, vehicleCount: 2, userId: user!._id };
  },
});

/**
 * Seeds ALL data for user_39FwQkrjpFYGOQ0gkPIk1DEf0FW.
 * User must already exist (sign in first). Does NOT create the user.
 * Seeds: vehicles, vehicle_owners, vehicle_tiers, completed bookings for BOTH cars,
 * ownership_credit_transactions, user_reward_wallets.
 * Requires: seed:seed first (engines, shops, services, mechanics).
 * Run: npx convex run seed:seedAllDataForUser39FwQkrjp
 */
export const seedAllDataForUser39FwQkrjp = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", SEED_CAR_CLERK_USER_ID))
      .unique();
    if (!user) throw new Error(`User ${SEED_CAR_CLERK_USER_ID} not found. Sign in first to create the user.`);

    const engines = await ctx.db.query("engines").collect();
    const engine = engines.find((e) => e.engine_code === "A25A-FKS");
    if (!engine) throw new Error("Engines missing. Run seed:seed first.");

    const shops = await ctx.db.query("shops").collect();
    const services = await ctx.db.query("services").collect();
    const mechanics = await ctx.db.query("mechanics").collect();
    const oilChange = services.find((s) => s.slug === "oil-change");
    const brakePads = services.find((s) => s.slug === "brake-pads");
    const tireRotation = services.find((s) => s.slug === "tire-rotation");
    if (!shops.length || !mechanics.length || !oilChange)
      throw new Error("Shops, services, or mechanics missing. Run seed:seed first.");

    const shop1 = shops[0];
    const shop2 = shops[1] ?? shop1;
    const mech1 = mechanics.find((m) => m.shop_id === shop1._id) ?? mechanics[0];
    const mech2 = mechanics.find((m) => m.shop_id === shop2._id) ?? mech1;

    const now = Date.now();
    const vin1 = "4T1B11HK5JU123457";
    const vin2 = "1HGCV1F15LA012345";

    const existingOwners = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
      .collect();

    if (existingOwners.length === 0) {
      for (const v of [vin1, vin2]) {
        const existingV = await ctx.db
          .query("vehicles")
          .withIndex("by_vin", (q) => q.eq("vin", v))
          .unique();
        if (!existingV) {
          await ctx.db.insert("vehicles", {
            vin: v,
            engine_id: engine._id,
            year: v === vin1 ? 2018 : 2020,
            created_at: now,
            updated_at: now,
          });
        }
      }
      await ctx.db.insert("vehicle_owners", {
        vin: vin1,
        user_id: user._id,
        status: "active",
        nickname: "My Camry",
        is_primary: true,
        mileage: 72000,
        added_at: now,
      });
      await ctx.db.insert("vehicle_owners", {
        vin: vin2,
        user_id: user._id,
        status: "active",
        nickname: "Honda Accord",
        is_primary: false,
        mileage: 45000,
        added_at: now,
      });
      for (const vin of [vin1, vin2]) {
        const existing = await ctx.db
          .query("vehicle_tiers")
          .withIndex("by_vin_user", (q) => q.eq("vin", vin).eq("user_id", user._id))
          .unique();
        if (!existing) {
          await ctx.db.insert("vehicle_tiers", {
            vin,
            user_id: user._id,
            tier: vin === vin1 ? "preferred" : "driver",
            spend_12mo: vin === vin1 ? 850 : 0,
            created_at: now,
            updated_at: now,
          });
        }
      }
    }

    const owners = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
      .collect();
    const primaryVin = owners.find((o) => o.is_primary)?.vin ?? owners[0].vin;

    const earnRates: Record<string, number> = { driver: 0.015, preferred: 0.03, elite: 0.05 };
    let totalCredit = 0;
    let created = 0;

    const svcBrake = brakePads ?? oilChange;
    const svcTire = tireRotation ?? oilChange;
    const bookingsToCreate: {
      vin: string;
      daysAgo: number;
      service: typeof oilChange;
      shop: typeof shop1;
      mechanic: typeof mech1;
      labor: number;
      parts: number;
    }[] = [
      { vin: vin1, daysAgo: 14, service: oilChange, shop: shop1, mechanic: mech1, labor: 47.5, parts: 45 },
      { vin: vin1, daysAgo: 30, service: svcBrake, shop: shop1, mechanic: mech2, labor: 95, parts: 60 },
      { vin: vin1, daysAgo: 60, service: oilChange, shop: shop2, mechanic: mech2, labor: 42.5, parts: 40 },
      { vin: vin2, daysAgo: 45, service: svcTire, shop: shop1, mechanic: mech1, labor: 47.5, parts: 0 },
      { vin: vin2, daysAgo: 75, service: oilChange, shop: shop2, mechanic: mech2, labor: 42.5, parts: 40 },
    ];

    for (const { vin, daysAgo, service, shop, mechanic, labor, parts } of bookingsToCreate) {
      const date = new Date(now);
      date.setDate(date.getDate() - daysAgo);
      const dateStr = date.toISOString().split("T")[0];
      const createdAt = now - daysAgo * 24 * 60 * 60 * 1000;
      const totalCost = labor + parts;

      const bookingId = await ctx.db.insert("bookings", {
        user_id: user._id,
        vin,
        shop_id: shop._id,
        mechanic_id: mechanic._id,
        service_ids: [service._id],
        scheduled_date: dateStr,
        scheduled_time: "10:00",
        labor_cost: labor,
        parts_cost: parts,
        total_cost: totalCost,
        status: "completed",
        created_at: createdAt,
        updated_at: createdAt,
      });

      await ctx.db.insert("booking_status_history", {
        booking_id: bookingId,
        old_status: "confirmed",
        new_status: "completed",
        changed_by: user._id,
        reason: "seeded_past",
        changed_at: createdAt,
      });

      const paymentId = await ctx.db.insert("payments", {
        booking_id: bookingId,
        user_id: user._id,
        shop_id: shop._id,
        amount: totalCost,
        payment_method: "card",
        status: "completed",
        transaction_id: `txn_u39_all_${created}`,
        stripe_payment_intent_id: `pi_u39_all_${created}`,
        idempotency_key: `u39_all_${created}`,
        created_at: createdAt,
        updated_at: createdAt,
      });

      await ctx.db.insert("payment_status_history", {
        payment_id: paymentId,
        old_status: "processing",
        new_status: "completed",
        error_code: undefined,
        error_message: undefined,
        changed_at: createdAt,
      });

      await ctx.db.insert("transactions", {
        user_id: user._id,
        created_at: createdAt,
        description: shop.name,
        sub_description: `${service.name}`,
        amount: -totalCost,
        currency: "USD",
        status: "completed",
        transaction_type: "charge",
        shop_id: shop._id,
        booking_id: bookingId,
        payment_id: paymentId,
        icon_type: "wrench",
      });

      const completedAt = createdAt + 45 * 60 * 1000;
      await ctx.db.insert("job_actuals", {
        booking_id: bookingId,
        mechanic_id: mechanic._id,
        actual_labor_minutes: 45,
        actual_parts_cost: parts,
        started_at: createdAt,
        completed_at_ms: completedAt,
        logged_at_ms: completedAt,
        created_at: completedAt,
        updated_at: completedAt,
        difficulty_rating: 2,
        parts_used: [{ part_name: "Service parts", oem_number: "N/A", cost: parts }],
        technician_notes: "Completed as requested.",
        finalized_at_ms: completedAt,
      });

      await ctx.db.insert("reviews", {
        booking_id: bookingId,
        shop_id: shop._id,
        user_id: user._id,
        mechanic_id: mechanic._id,
        rating: 5,
        comment: "Great service, would book again.",
        created_at: completedAt,
      });

      const vt = await ctx.db
        .query("vehicle_tiers")
        .withIndex("by_vin_user", (q) => q.eq("vin", vin).eq("user_id", user._id))
        .unique();
      const tier = (vt?.tier ?? "driver") as "driver" | "preferred" | "elite";
      const rate = earnRates[tier] ?? 0.015;
      const creditAmount = Math.round(totalCost * rate * 100) / 100;
      const existingTx = await ctx.db
        .query("ownership_credit_transactions")
        .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
        .filter((q) =>
          q.and(q.eq(q.field("type"), "earn_service"), q.eq(q.field("reference_id"), bookingId.toString()))
        )
        .first();
      if (!existingTx && creditAmount > 0) {
        await ctx.db.insert("ownership_credit_transactions", {
          user_id: user._id,
          amount: creditAmount,
          type: "earn_service",
          description: "Maintenance rewards",
          reference_id: bookingId.toString(),
          expires_at: completedAt + 180 * 24 * 60 * 60 * 1000,
          created_at: completedAt,
        });
        totalCredit += creditAmount;
      }
      created++;
    }

    const MILES_SAFE = 23000;
    const wallet = await ctx.db
      .query("user_reward_wallets")
      .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
      .unique();
    const transactions = await ctx.db
      .query("ownership_credit_transactions")
      .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
      .filter((q) => q.eq(q.field("type"), "earn_service"))
      .collect();
    const computedBalance = transactions.reduce((sum, t) => sum + (t.amount > 0 ? t.amount : 0), 0);

    if (wallet) {
      await ctx.db.patch(wallet._id, {
        balance: computedBalance,
        miles_safe: MILES_SAFE,
        updated_at: now,
      });
    } else {
      await ctx.db.insert("user_reward_wallets", {
        user_id: user._id,
        balance: computedBalance,
        auto_apply_to_booking: true,
        miles_safe: MILES_SAFE,
        created_at: now,
        updated_at: now,
      });
    }

    return {
      success: true,
      bookingsCreated: created,
      balance: computedBalance,
      milesSafe: MILES_SAFE,
      vehicleCount: 2,
    };
  },
});

/**
 * Seeds services (completed bookings), shops, and miles_safe for user_39FwQkrjpFYGOQ0gkPIk1DEf0FW.
 * Creates 4 past completed bookings so membership shows: 4 services, 2 shops, 23k miles safe.
 * Requires: shops, services, mechanics from full seed. Run: npx convex run seed:seed first if needed.
 * User must already exist.
 * Run: npx convex run seed:seedServicesShopsMilesSafeForUser39FwQkrjp
 */
export const seedServicesShopsMilesSafeForUser39FwQkrjp = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", SEED_CAR_CLERK_USER_ID))
      .unique();
    if (!user) throw new Error(`User ${SEED_CAR_CLERK_USER_ID} not found. Sign in first to create the user.`);

    const owners = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
      .collect();
    const vin = owners.length > 0 ? (owners.find((o) => o.is_primary)?.vin ?? owners[0].vin) : null;
    if (!vin) throw new Error("User has no vehicles. Run seed:seedCarsForUser39FwQkrjp first.");

    const shops = await ctx.db.query("shops").collect();
    const mechanics = await ctx.db.query("mechanics").collect();
    const services = await ctx.db.query("services").collect();
    const oilChange = services.find((s) => s.slug === "oil-change");
    const brakePads = services.find((s) => s.slug === "brake-pads");
    const tireRotation = services.find((s) => s.slug === "tire-rotation");
    if (!shops.length || !mechanics.length || !oilChange)
      throw new Error("Shops, mechanics, or Oil Change service missing. Run seed:seed first.");

    const shop1 = shops[0];
    const shop2 = shops[1] ?? shop1;
    const mech1 = mechanics.find((m) => m.shop_id === shop1._id) ?? mechanics[0];
    const mech2 = mechanics.find((m) => m.shop_id === shop2._id) ?? mech1;

    const pastBookings = [
      { daysAgo: 14, service: oilChange, shop: shop1, mechanic: mech1, labor: 47.5, parts: 45 },
      { daysAgo: 30, service: brakePads, shop: shop1, mechanic: mech2, labor: 95, parts: 60 },
      { daysAgo: 60, service: oilChange, shop: shop2, mechanic: mech2, labor: 42.5, parts: 40 },
      { daysAgo: 90, service: tireRotation, shop: shop1, mechanic: mech1, labor: 47.5, parts: 0 },
    ];

    const now = Date.now();
    let created = 0;

    for (const { daysAgo, service, shop, mechanic, labor, parts } of pastBookings) {
      if (!service) continue;
      const date = new Date(now);
      date.setDate(date.getDate() - daysAgo);
      const dateStr = date.toISOString().split("T")[0];
      const createdAt = now - daysAgo * 24 * 60 * 60 * 1000;
      const totalCost = labor + parts;

      const bookingId = await ctx.db.insert("bookings", {
        user_id: user._id,
        vin,
        shop_id: shop._id,
        mechanic_id: mechanic._id,
        service_ids: [service._id],
        scheduled_date: dateStr,
        scheduled_time: "10:00",
        labor_cost: labor,
        parts_cost: parts,
        total_cost: totalCost,
        status: "completed",
        created_at: createdAt,
        updated_at: createdAt,
      });

      await ctx.db.insert("booking_status_history", {
        booking_id: bookingId,
        old_status: "confirmed",
        new_status: "completed",
        changed_by: user._id,
        reason: "seeded_past",
        changed_at: createdAt,
      });

      const paymentId = await ctx.db.insert("payments", {
        booking_id: bookingId,
        user_id: user._id,
        shop_id: shop._id,
        amount: totalCost,
        payment_method: "card",
        status: "completed",
        transaction_id: `txn_u39_past_${created}`,
        stripe_payment_intent_id: `pi_u39_past_${created}`,
        idempotency_key: `u39_past_${created}`,
        created_at: createdAt,
        updated_at: createdAt,
      });

      await ctx.db.insert("payment_status_history", {
        payment_id: paymentId,
        old_status: "processing",
        new_status: "completed",
        error_code: undefined,
        error_message: undefined,
        changed_at: createdAt,
      });

      await ctx.db.insert("transactions", {
        user_id: user._id,
        created_at: createdAt,
        description: shop.name,
        sub_description: `${service.name}`,
        amount: -totalCost,
        currency: "USD",
        status: "completed",
        transaction_type: "charge",
        shop_id: shop._id,
        booking_id: bookingId,
        payment_id: paymentId,
        icon_type: "wrench",
      });

      const completedAt = createdAt + 45 * 60 * 1000;
      await ctx.db.insert("job_actuals", {
        booking_id: bookingId,
        mechanic_id: mechanic._id,
        actual_labor_minutes: 45,
        actual_parts_cost: parts,
        started_at: createdAt,
        completed_at_ms: completedAt,
        logged_at_ms: completedAt,
        created_at: completedAt,
        updated_at: completedAt,
        difficulty_rating: 2,
        parts_used: [{ part_name: "Service parts", oem_number: "N/A", cost: parts }],
        technician_notes: "Completed as requested.",
        finalized_at_ms: completedAt,
      });

      await ctx.db.insert("reviews", {
        booking_id: bookingId,
        shop_id: shop._id,
        user_id: user._id,
        mechanic_id: mechanic._id,
        rating: 5,
        comment: "Great service, would book again.",
        created_at: completedAt,
      });

      const vt = await ctx.db
        .query("vehicle_tiers")
        .withIndex("by_vin_user", (q) => q.eq("vin", vin).eq("user_id", user._id))
        .unique();
      const tier = (vt?.tier ?? "driver") as "driver" | "preferred" | "elite";
      const earnRates: Record<string, number> = {
        driver: 0.015,
        preferred: 0.03,
        elite: 0.05,
      };
      const rate = earnRates[tier] ?? 0.015;
      const creditAmount = Math.round(totalCost * rate * 100) / 100;
      const existingTx = await ctx.db
        .query("ownership_credit_transactions")
        .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
        .filter((q) =>
          q.and(q.eq(q.field("type"), "earn_service"), q.eq(q.field("reference_id"), bookingId.toString()))
        )
        .first();
      if (!existingTx && creditAmount > 0) {
        await ctx.db.insert("ownership_credit_transactions", {
          user_id: user._id,
          amount: creditAmount,
          type: "earn_service",
          description: "Maintenance rewards",
          reference_id: bookingId.toString(),
          expires_at: completedAt + 180 * 24 * 60 * 60 * 1000,
          created_at: completedAt,
        });
      }

      created++;
    }

    const MILES_SAFE = 23000;
    const wallet = await ctx.db
      .query("user_reward_wallets")
      .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
      .unique();
    if (wallet) {
      await ctx.db.patch(wallet._id, { miles_safe: MILES_SAFE, updated_at: now });
    } else {
      await ctx.db.insert("user_reward_wallets", {
        user_id: user._id,
        balance: 47.5,
        auto_apply_to_booking: true,
        miles_safe: MILES_SAFE,
        created_at: now,
        updated_at: now,
      });
    }

    return {
      success: true,
      pastBookingsCreated: created,
      milesSafe: MILES_SAFE,
      services: created,
      shops: Math.min(2, shops.length),
    };
  },
});

/**
 * Backfills ownership_credit_transactions for completed bookings so per-vehicle credit shows.
 * Run after seedServicesShopsMilesSafeForUser39FwQkrjp if individual view shows $0 credit.
 * Run: npx convex run seed:backfillCreditTransactionsForUser39FwQkrjp
 */
export const backfillCreditTransactionsForUser39FwQkrjp = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", SEED_CAR_CLERK_USER_ID))
      .unique();
    if (!user) throw new Error("User not found.");

    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
      .filter((q) => q.eq(q.field("status"), "completed"))
      .collect();
    const earnRates: Record<string, number> = { driver: 0.015, preferred: 0.03, elite: 0.05 };
    let inserted = 0;
    let walletCredit = 0;
    for (const b of bookings) {
      const existing = await ctx.db
        .query("ownership_credit_transactions")
        .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
        .filter((q) => q.and(q.eq(q.field("type"), "earn_service"), q.eq(q.field("reference_id"), b._id.toString())))
        .first();
      if (existing) continue;
      const vt = await ctx.db
        .query("vehicle_tiers")
        .withIndex("by_vin_user", (q) => q.eq("vin", b.vin).eq("user_id", user._id))
        .unique();
      const tier = (vt?.tier ?? "driver") as "driver" | "preferred" | "elite";
      const rate = earnRates[tier] ?? 0.015;
      const creditAmount = Math.round((b.total_cost ?? 0) * rate * 100) / 100;
      if (creditAmount <= 0) continue;
      const bUpdatedAt = b.updated_at ?? Date.now();
      await ctx.db.insert("ownership_credit_transactions", {
        user_id: user._id,
        amount: creditAmount,
        type: "earn_service",
        description: "Maintenance rewards",
        reference_id: b._id.toString(),
        expires_at: bUpdatedAt + 180 * 24 * 60 * 60 * 1000,
        created_at: bUpdatedAt,
      });
      walletCredit += creditAmount;
      inserted++;
    }
    if (inserted > 0) {
      const wallet = await ctx.db
        .query("user_reward_wallets")
        .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
        .unique();
      if (wallet) {
        await ctx.db.patch(wallet._id, {
          balance: wallet.balance + walletCredit,
          updated_at: Date.now(),
        });
      }
    }
    return { inserted, walletCreditAdded: walletCredit };
  },
});

/**
 * Sets credit balance to $47.50 for user_39FwQkrjpFYGOQ0gkPIk1DEf0FW.
 * Use when balance shows $0 (e.g. ensureWallet ran before seed).
 * Run: npx convex run seed:setBalance47ForUser39FwQkrjp
 */
export const setBalance47ForUser39FwQkrjp = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", SEED_CAR_CLERK_USER_ID))
      .unique();
    if (!user) throw new Error(`User ${SEED_CAR_CLERK_USER_ID} not found. Run seed:seedCarsForUser39FwQkrjp first.`);

    const now = Date.now();
    const wallet = await ctx.db
      .query("user_reward_wallets")
      .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
      .unique();
    if (!wallet) {
      await ctx.db.insert("user_reward_wallets", {
        user_id: user._id,
        balance: 47.5,
        auto_apply_to_booking: true,
        created_at: now,
        updated_at: now,
      });
      return { success: true, action: "created", balance: 47.5 };
    }
    await ctx.db.patch(wallet._id, { balance: 47.5, updated_at: now });
    return { success: true, action: "updated", balance: 47.5 };
  },
});

/**
 * Seeds past (completed) bookings for the John Doe account so the History tab
 * shows data. Run: npx convex run seed:seedPastBookingsForJohnDoe
 */
export const seedPastBookingsForJohnDoe = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", JOHN_DOE_CLERK_USER_ID))
      .unique();
    if (!user) {
      throw new Error(
        `User with clerkUserId ${JOHN_DOE_CLERK_USER_ID} (John Doe) not found. Ensure the account exists.`
      );
    }

    const owners = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
      .collect();
    let vin: string;
    if (owners.length > 0) {
      vin = owners[0].vin;
    } else {
      const vehicles = await ctx.db.query("vehicles").collect();
      if (vehicles.length === 0) throw new Error("No vehicles in DB. Run full seed first.");
      vin = vehicles[0].vin;
      await ctx.db.insert("vehicle_owners", {
        vin,
        user_id: user._id,
        status: "active",
        nickname: "My Car",
        is_primary: true,
        mileage: 40000,
        added_at: Date.now(),
      });
    }

    const shops = await ctx.db.query("shops").collect();
    const mechanics = await ctx.db.query("mechanics").collect();
    const services = await ctx.db.query("services").collect();
    const oilChange = services.find((s) => s.slug === "oil-change");
    const brakePads = services.find((s) => s.slug === "brake-pads");
    const tireRotation = services.find((s) => s.slug === "tire-rotation");
    if (!shops.length || !mechanics.length || !oilChange) {
      throw new Error("Shops, mechanics, or Oil Change service missing. Run full seed first.");
    }

    const shop1 = shops[0];
    const shop2 = shops[1] ?? shop1;
    const mech1 = mechanics.find((m) => m.shop_id === shop1._id) ?? mechanics[0];
    const mech2 = mechanics.find((m) => m.shop_id === shop2._id) ?? mech1;
    const oilChangeService = oilChange!;
    const brakePadsService = brakePads ?? oilChangeService;
    const tireRotationService = tireRotation ?? oilChangeService;

    const pastBookings = [
      { daysAgo: 14, service: oilChangeService, shop: shop1, mechanic: mech1, labor: 47.5, parts: 45 },
      { daysAgo: 30, service: brakePadsService, shop: shop1, mechanic: mech2, labor: 95, parts: 60 },
      { daysAgo: 60, service: oilChangeService, shop: shop2, mechanic: mech2, labor: 42.5, parts: 40 },
      { daysAgo: 90, service: tireRotationService, shop: shop1, mechanic: mech1, labor: 47.5, parts: 0 },
    ];

    const now = Date.now();
    let created = 0;

    for (const { daysAgo, service, shop, mechanic, labor, parts } of pastBookings) {
      if (!service) continue;
      const date = new Date(now);
      date.setDate(date.getDate() - daysAgo);
      const dateStr = date.toISOString().split("T")[0];
      const createdAt = now - daysAgo * 24 * 60 * 60 * 1000;
      const totalCost = labor + parts;

      const bookingId = await ctx.db.insert("bookings", {
        user_id: user._id,
        vin,
        shop_id: shop._id,
        mechanic_id: mechanic._id,
        service_ids: [service._id],
        scheduled_date: dateStr,
        scheduled_time: "10:00",
        labor_cost: labor,
        parts_cost: parts,
        total_cost: totalCost,
        status: "completed",
        created_at: createdAt,
        updated_at: createdAt,
      });

      await ctx.db.insert("booking_status_history", {
        booking_id: bookingId,
        old_status: "confirmed",
        new_status: "completed",
        changed_by: user._id,
        reason: "seeded_past",
        changed_at: createdAt,
      });

      const paymentId = await ctx.db.insert("payments", {
        booking_id: bookingId,
        user_id: user._id,
        shop_id: shop._id,
        amount: totalCost,
        payment_method: "card",
        status: "completed",
        transaction_id: `txn_johndoe_past_${created}`,
        stripe_payment_intent_id: `pi_johndoe_past_${created}`,
        idempotency_key: `johndoe_past_${created}`,
        created_at: createdAt,
        updated_at: createdAt,
      });

      await ctx.db.insert("payment_status_history", {
        payment_id: paymentId,
        old_status: "processing",
        new_status: "completed",
        error_code: undefined,
        error_message: undefined,
        changed_at: createdAt,
      });

      await ctx.db.insert("transactions", {
        user_id: user._id,
        created_at: createdAt,
        description: shop.name,
        sub_description: `${service.name}`,
        amount: -totalCost,
        currency: "USD",
        status: "completed",
        transaction_type: "charge",
        shop_id: shop._id,
        booking_id: bookingId,
        payment_id: paymentId,
        icon_type: "wrench",
      });

      const completedAt = createdAt + 45 * 60 * 1000;
      await ctx.db.insert("job_actuals", {
        booking_id: bookingId,
        mechanic_id: mechanic._id,
        actual_labor_minutes: 45,
        actual_parts_cost: parts,
        started_at: createdAt,
        completed_at_ms: completedAt,
        logged_at_ms: completedAt,
        created_at: completedAt,
        updated_at: completedAt,
        difficulty_rating: 2,
        parts_used: [{ part_name: "Service parts", oem_number: "N/A", cost: parts }],
        technician_notes: "Completed as requested.",
        finalized_at_ms: completedAt,
      });

      await ctx.db.insert("reviews", {
        booking_id: bookingId,
        shop_id: shop._id,
        user_id: user._id,
        mechanic_id: mechanic._id,
        rating: 5,
        comment: "Great service, would book again.",
        created_at: completedAt,
      });

      created++;
    }

    return { success: true, pastBookingsCreated: created };
  },
});

/**
 * Seeds one live (in_progress) booking for the John Doe account so the Live Tracker
 * tab shows data. Run: npx convex run seed:seedLiveBookingForJohnDoe
 */
export const seedLiveBookingForJohnDoe = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", JOHN_DOE_CLERK_USER_ID))
      .unique();
    if (!user) {
      throw new Error(
        `User with clerkUserId ${JOHN_DOE_CLERK_USER_ID} (John Doe) not found. Ensure the account exists.`
      );
    }

    const owners = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
      .collect();
    let vin: string;
    if (owners.length > 0) {
      vin = owners[0].vin;
    } else {
      const vehicles = await ctx.db.query("vehicles").collect();
      if (vehicles.length === 0) throw new Error("No vehicles in DB. Run full seed first.");
      vin = vehicles[0].vin;
      await ctx.db.insert("vehicle_owners", {
        vin,
        user_id: user._id,
        status: "active",
        nickname: "My Car",
        is_primary: true,
        mileage: 40000,
        added_at: Date.now(),
      });
    }

    const shops = await ctx.db.query("shops").collect();
    const mechanics = await ctx.db.query("mechanics").collect();
    const services = await ctx.db.query("services").collect();
    const oilChange = services.find((s) => s.slug === "oil-change");
    if (!shops.length || !mechanics.length || !oilChange) {
      throw new Error("Shops, mechanics, or Oil Change service missing. Run full seed first.");
    }

    const shop = shops[0];
    const mechanic = mechanics.find((m) => m.shop_id === shop._id) ?? mechanics[0];
    const now = Date.now();
    const today = new Date(now).toISOString().split("T")[0];
    const labor = 47.5;
    const parts = 45;
    const totalCost = labor + parts;
    const estimatedMinutes = 45;
    const startedAtMs = now - 10 * 60 * 1000;

    const bookingId = await ctx.db.insert("bookings", {
      user_id: user._id,
      vin,
      shop_id: shop._id,
      mechanic_id: mechanic._id,
      service_ids: [oilChange._id],
      scheduled_date: today,
      scheduled_time: "10:00",
      labor_cost: labor,
      parts_cost: parts,
      total_cost: totalCost,
      status: "in_progress",
      live_stage: "service_in_progress",
      estimated_labor_minutes: estimatedMinutes,
      created_at: now,
      updated_at: now,
    });

    await ctx.db.insert("booking_status_history", {
      booking_id: bookingId,
      old_status: "confirmed",
      new_status: "in_progress",
      changed_by: user._id,
      reason: "seeded_live",
      changed_at: now,
    });

    await ctx.db.insert("job_actuals", {
      booking_id: bookingId,
      mechanic_id: mechanic._id,
      actual_labor_minutes: estimatedMinutes,
      actual_parts_cost: parts,
      started_at: startedAtMs,
      completed_at_ms: undefined,
      logged_at_ms: undefined,
      created_at: now,
      updated_at: now,
      difficulty_rating: 2,
      parts_used: [],
      technician_notes: "Service in progress.",
    });

    const paymentId = await ctx.db.insert("payments", {
      booking_id: bookingId,
      user_id: user._id,
      shop_id: shop._id,
      amount: totalCost,
      payment_method: "card",
      status: "completed",
      transaction_id: "txn_johndoe_live",
      stripe_payment_intent_id: "pi_johndoe_live",
      idempotency_key: "johndoe_live",
      created_at: now,
      updated_at: now,
    });

    await ctx.db.insert("transactions", {
      user_id: user._id,
      created_at: now,
      description: shop.name,
      sub_description: oilChange.name,
      amount: -totalCost,
      currency: "USD",
      status: "completed",
      transaction_type: "charge",
      shop_id: shop._id,
      booking_id: bookingId,
      payment_id: paymentId,
      icon_type: "wrench",
    });

    return { success: true, bookingId };
  },
});

/**
 * Seeds extra transactions for John Doe (credits, subscription, fuel) so the
 * Transactions screen shows variety. Run after seedPastBookingsForJohnDoe.
 * npx convex run seed:seedTransactionsForJohnDoe
 */
export const seedTransactionsForJohnDoe = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", JOHN_DOE_CLERK_USER_ID))
      .unique();
    if (!user) {
      throw new Error(
        `User with clerkUserId ${JOHN_DOE_CLERK_USER_ID} (John Doe) not found. Ensure the account exists.`
      );
    }

    const now = Date.now();
    const yesterday = now - 24 * 60 * 60 * 1000;
    const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;

    await ctx.db.insert("transactions", {
      user_id: user._id,
      created_at: yesterday,
      description: "Ownership credits",
      sub_description: "Referral reward",
      amount: 100,
      currency: "USD",
      status: "completed",
      transaction_type: "credit",
      icon_type: "leaf",
    });

    await ctx.db.insert("transactions", {
      user_id: user._id,
      created_at: twoDaysAgo,
      description: "Shell Station",
      sub_description: "Fuel",
      amount: -45,
      currency: "USD",
      status: "completed",
      transaction_type: "charge",
      icon_type: "fuel",
    });

    await ctx.db.insert("transactions", {
      user_id: user._id,
      created_at: twoDaysAgo - 60 * 60 * 1000,
      description: "Otopair Premium",
      sub_description: "Monthly Subscription",
      amount: -12.99,
      currency: "USD",
      status: "completed",
      transaction_type: "charge",
      icon_type: "card",
    });

    return { success: true, transactionsCreated: 3 };
  },
});

/**
 * seedVehiclesForUser — Add 10 unique vehicles to any user by Clerk ID.
 */
export const seedVehiclesForUser = mutation({
  args: { clerkUserId: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", args.clerkUserId))
      .unique();
    if (!user) throw new Error(`User not found for clerkUserId: ${args.clerkUserId}`);

    const VEHICLES = [
      { vin: "1HGCV1F34LA012345", year: 2020, make: "Honda", model: "Accord", mileage: 34200, nickname: "2020 Honda Accord" },
      { vin: "5YJSA1E26MF123456", year: 2021, make: "Tesla", model: "Model 3", mileage: 18700, nickname: "2021 Tesla Model 3" },
      { vin: "WBA8E9C50JA789012", year: 2018, make: "BMW", model: "330i", mileage: 56800, nickname: "2018 BMW 330i" },
      { vin: "1G1YY22G965234567", year: 2022, make: "Chevrolet", model: "Corvette", mileage: 8300, nickname: "2022 Chevrolet Corvette" },
      { vin: "WVWZZZ3CZWE345678", year: 2023, make: "Volkswagen", model: "Tiguan", mileage: 12100, nickname: "2023 Volkswagen Tiguan" },
      { vin: "JN1TBNT30Z0456789", year: 2019, make: "Nissan", model: "Altima", mileage: 47600, nickname: "2019 Nissan Altima" },
      { vin: "2T1BURHE5JC567890", year: 2024, make: "Toyota", model: "Corolla", mileage: 3200, nickname: "2024 Toyota Corolla" },
      { vin: "3FA6P0H76HR678901", year: 2017, make: "Ford", model: "Fusion", mileage: 82400, nickname: "2017 Ford Fusion" },
      { vin: "KNAE35L14N5789012", year: 2022, make: "Kia", model: "EV6", mileage: 15800, nickname: "2022 Kia EV6" },
      { vin: "19UUB2F34LA890123", year: 2020, make: "Acura", model: "TLX", mileage: 29500, nickname: "2020 Acura TLX" },
    ];

    const now = Date.now();
    let created = 0;

    for (const v of VEHICLES) {
      const existing = await ctx.db
        .query("vehicles")
        .withIndex("by_vin", (q) => q.eq("vin", v.vin))
        .unique();

      if (!existing) {
        await ctx.db.insert("vehicles", {
          vin: v.vin,
          year: v.year,
          metadata: { make: v.make, model: v.model },
          created_at: now,
          updated_at: now,
        });
      }

      const ownershipExists = await ctx.db
        .query("vehicle_owners")
        .withIndex("by_vin_user", (q) => q.eq("vin", v.vin).eq("user_id", user._id))
        .unique();

      if (!ownershipExists) {
        await ctx.db.insert("vehicle_owners", {
          vin: v.vin,
          user_id: user._id,
          status: "active",
          nickname: v.nickname,
          is_primary: false,
          mileage: v.mileage,
          added_at: now,
        });
        created++;
      }
    }

    return { success: true, vehiclesCreated: created, userId: user._id };
  },
});

function dashboardMinutesToTime(minutes: number): string {
  const clamped = Math.max(0, Math.min(1439, Math.round(minutes)));
  const hours = Math.floor(clamped / 60);
  const mins = clamped % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

function dashboardAddMinutesToTime(hhmm: string, deltaMinutes: number): string {
  const [hours, mins] = hhmm.split(":").map(Number);
  return dashboardMinutesToTime(hours * 60 + mins + deltaMinutes);
}

function dashboardTimeToMinutes(hhmm: string): number {
  const [hours, mins] = hhmm.split(":").map(Number);
  return hours * 60 + mins;
}

function dashboardIsoDateAtOffset(baseIsoDate: string, offsetDays: number): string {
  const date = new Date(`${baseIsoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().split("T")[0];
}

function dashboardSeedRatio(seed: string): number {
  let hash = 2166136261;
  for (let idx = 0; idx < seed.length; idx++) {
    hash ^= seed.charCodeAt(idx);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function dashboardPickSeedValue<T>(values: readonly T[], seed: string): T {
  return values[Math.floor(dashboardSeedRatio(seed) * values.length) % values.length];
}

export const seedDashboardBookings = mutation({
  args: {
    shopId: v.id("shops"),
    clearExisting: v.optional(v.boolean()),
    seedDemo: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const shop = await ctx.db.get(args.shopId);
    if (!shop) throw new Error(`Shop ${args.shopId} not found.`);

    const now = Date.now();
    const today = new Date(now).toISOString().split("T")[0];

    if (args.clearExisting ?? false) {
      const existingBookings = await ctx.db
        .query("bookings")
        .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
        .collect();
      const bookingIds = new Set(existingBookings.map((booking) => String(booking._id)));

      const history = await ctx.db.query("booking_status_history").collect();
      for (const row of history) {
        if (bookingIds.has(String(row.booking_id))) {
          await ctx.db.delete(row._id);
        }
      }

      const jobActuals = await ctx.db.query("job_actuals").collect();
      for (const row of jobActuals) {
        if (bookingIds.has(String(row.booking_id))) {
          await ctx.db.delete(row._id);
        }
      }

      for (const booking of existingBookings) {
        await ctx.db.delete(booking._id);
      }

      const existingSlots = await ctx.db
        .query("time_slots")
        .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
        .collect();
      for (const slot of existingSlots) {
        await ctx.db.delete(slot._id);
      }

      const blockTypes = await ctx.db
        .query("block_time_types")
        .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
        .collect();
      for (const type of blockTypes) {
        await ctx.db.delete(type._id);
      }
    }

    if ((args.seedDemo ?? true) === false) {
      return { clearedOnly: true };
    }

    const ensureService = async (slug: string, name: string, categoryName: string) => {
      const services = await ctx.db.query("services").collect();
      const existingService = services.find((service) => service.slug === slug);
      let serviceId: any;

      if (existingService) {
        serviceId = existingService._id;
      } else {
        const categories = await ctx.db.query("service_categories").collect();
        const existingCategory = categories.find((category) => category.name === categoryName);
        const categoryId =
          existingCategory?._id ??
          (await ctx.db.insert("service_categories", {
            name: categoryName,
            icon_name: "wrench",
            display_order: 99,
          }));

        serviceId = await ctx.db.insert("services", {
          name,
          slug,
          description: name,
          service_category_id: categoryId,
          default_labor_hours: 1,
          is_labor_only: false,
          has_options: false,
          display_order: 99,
        });
      }

      const existingShopService = await ctx.db
        .query("shop_services")
        .withIndex("by_shop_and_service", (q: any) =>
          q.eq("shop_id", args.shopId).eq("service_id", serviceId)
        )
        .first();
      if (!existingShopService) {
        await ctx.db.insert("shop_services", {
          shop_id: args.shopId,
          service_id: serviceId,
          is_offered: true,
        });
      }

      return serviceId;
    };

    const oilChangeId = await ensureService("oil-change", "Oil Change", "Maintenance");
    const brakePadsId = await ensureService(
      "brake-pads",
      "Brake Pad Replacement",
      "Brakes"
    );
    const tireRotationId = await ensureService(
      "tire-rotation",
      "Tire Rotation",
      "Maintenance"
    );
    const alignmentId = await ensureService(
      "wheel-alignment",
      "Wheel Alignment",
      "Maintenance"
    );
    const acServiceId = await ensureService(
      "ac-service",
      "AC System Service",
      "Maintenance"
    );

    const allMechanics = await ctx.db
      .query("mechanics")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
      .filter((q) => q.eq(q.field("is_active"), true))
      .collect();
    const mechanicShopUsers = await ctx.db
      .query("shop_users")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
      .filter((q) =>
        q.and(
          q.eq(q.field("is_active"), true),
          q.neq(q.field("mechanic_id"), undefined),
          q.neq(q.field("accepted_at"), undefined),
          q.or(
            q.eq(q.field("role"), "shop_mechanic"),
            q.eq(q.field("role"), "mechanic")
          )
        )
      )
      .collect();
    const acceptedMechanicIds = new Set(
      mechanicShopUsers.map((shopUser) => String(shopUser.mechanic_id))
    );
    let mechanics = allMechanics.filter((mechanic) =>
      acceptedMechanicIds.has(String(mechanic._id))
    );

    if (mechanics.length === 0) {
      const fallbackMechanicId = await ctx.db.insert("mechanics", {
        shop_id: args.shopId,
        first_name: "Demo",
        last_name: "Technician",
        title: "Lead Tech",
        is_active: true,
        rating: 0,
        review_count: 0,
      });
      mechanics = [
        {
          _id: fallbackMechanicId,
          _creationTime: Date.now(),
          shop_id: args.shopId,
          first_name: "Demo",
          last_name: "Technician",
          title: "Lead Tech",
          is_active: true,
          rating: 0,
          review_count: 0,
        },
      ];
    }

    const demoVehicles = [
      {
        clerkId: "seed-dashboard-user-1",
        firstName: "James",
        lastName: "Sullivan",
        vin: "SEED1VIN000001",
        year: 2018,
        make: "Ford",
        model: "F-150",
      },
      {
        clerkId: "seed-dashboard-user-2",
        firstName: "Maria",
        lastName: "Rodriguez",
        vin: "SEED1VIN000002",
        year: 2021,
        make: "Toyota",
        model: "RAV4",
      },
      {
        clerkId: "seed-dashboard-user-3",
        firstName: "Alex",
        lastName: "Lee",
        vin: "SEED1VIN000003",
        year: 2015,
        make: "Honda",
        model: "Civic",
      },
      {
        clerkId: "seed-dashboard-user-4",
        firstName: "Jordan",
        lastName: "Park",
        vin: "SEED1VIN000004",
        year: 2020,
        make: "Chevy",
        model: "Silverado",
      },
      {
        clerkId: "seed-dashboard-user-5",
        firstName: "Casey",
        lastName: "Morgan",
        vin: "SEED1VIN000005",
        year: 2019,
        make: "Subaru",
        model: "Outback",
      },
      {
        clerkId: "seed-dashboard-user-6",
        firstName: "Taylor",
        lastName: "Brooks",
        vin: "SEED1VIN000006",
        year: 2022,
        make: "Jeep",
        model: "Wrangler",
      },
      {
        clerkId: "seed-dashboard-user-7",
        firstName: "Riley",
        lastName: "Quinn",
        vin: "SEED1VIN000007",
        year: 2017,
        make: "BMW",
        model: "X5",
      },
    ];

    const passportVehicleIndexes = new Set(
      demoVehicles
        .map((vehicle, index) => ({
          index,
          ratio: dashboardSeedRatio(`${today}:${vehicle.vin}:passport`),
        }))
        .filter((entry) => entry.ratio >= 0.35)
        .map((entry) => entry.index)
    );
    if (passportVehicleIndexes.size === 0) {
      passportVehicleIndexes.add(0);
    }
    if (passportVehicleIndexes.size === demoVehicles.length) {
      passportVehicleIndexes.delete(demoVehicles.length - 1);
    }

    for (let vehicleIdx = 0; vehicleIdx < demoVehicles.length; vehicleIdx++) {
      if (passportVehicleIndexes.has(vehicleIdx) && !(args.clearExisting ?? false)) {
        continue;
      }
      const existingPassports = await ctx.db
        .query("vehicle_passports")
        .withIndex("by_vin", (q) => q.eq("vin", demoVehicles[vehicleIdx].vin))
        .collect();
      for (const passport of existingPassports) {
        await ctx.db.delete(passport._id);
      }
    }

    const userIds: any[] = [];
    for (const vehicle of demoVehicles) {
      const existingUser = await ctx.db
        .query("users")
        .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", vehicle.clerkId))
        .first();

      const userId =
        existingUser?._id ??
        (await ctx.db.insert("users", {
          clerkUserId: vehicle.clerkId,
          onboardingCompleted: true,
          createdAt: now,
          email: `${vehicle.firstName.toLowerCase()}.${vehicle.lastName.toLowerCase()}@demo.otopair.com`,
          first_name: vehicle.firstName,
          last_name: vehicle.lastName,
        }));

      userIds.push(userId);

      const existingVehicle = await ctx.db
        .query("vehicles")
        .withIndex("by_vin", (q) => q.eq("vin", vehicle.vin))
        .unique();
      if (!existingVehicle) {
        await ctx.db.insert("vehicles", {
          vin: vehicle.vin,
          year: vehicle.year,
          created_at: now,
          updated_at: now,
          metadata: { make: vehicle.make, model: vehicle.model },
        });
      }

      const ownership = await ctx.db
        .query("vehicle_owners")
        .withIndex("by_vin_user", (q) => q.eq("vin", vehicle.vin).eq("user_id", userId))
        .first();
      if (!ownership) {
        await ctx.db.insert("vehicle_owners", {
          vin: vehicle.vin,
          user_id: userId,
          status: "active",
          is_primary: true,
          added_at: now,
        });
      }
    }

    const createBooking = async ({
      userIdx,
      vinIdx,
      serviceId,
      mechanicId,
      scheduledDate,
      scheduledTime,
      status,
      laborCost,
      partsCost,
      estimatedMinutes,
      liveStage,
      key,
    }: {
      userIdx: number;
      vinIdx: number;
      serviceId: any;
      mechanicId: any;
      scheduledDate: string;
      scheduledTime: string;
      status: string;
      laborCost: number;
      partsCost: number;
      estimatedMinutes?: number;
      liveStage?: string;
      key: string;
    }) => {
      const bookingId = await ctx.db.insert("bookings", {
        user_id: userIds[userIdx],
        vin: demoVehicles[vinIdx].vin,
        shop_id: args.shopId,
        mechanic_id: mechanicId,
        service_ids: [serviceId],
        scheduled_date: scheduledDate,
        scheduled_time: scheduledTime,
        labor_cost: laborCost,
        parts_cost: partsCost,
        total_cost: laborCost + partsCost,
        estimated_labor_minutes: estimatedMinutes,
        status,
        ...(liveStage ? { live_stage: liveStage } : {}),
        created_at: now,
        updated_at: now,
      });

      await ctx.db.insert("booking_status_history", {
        booking_id: bookingId,
        old_status: undefined,
        new_status: status,
        reason: `seed_dashboard_${key}`,
        changed_at: now,
      });

      return bookingId;
    };

    const shopHours = await ctx.db
      .query("shops_hours")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
      .collect();
    const hoursByDay = new Map(
      shopHours.map((hours) => [hours.day_of_week, hours] as const)
    );

    const openDates: { date: string; hours: (typeof shopHours)[number] }[] = [];
    for (let offset = 0; offset <= 21 && openDates.length < 5; offset++) {
      const date = dashboardIsoDateAtOffset(today, offset);
      const dayOfWeek = new Date(`${date}T00:00:00.000Z`).getUTCDay();
      const hours = hoursByDay.get(dayOfWeek);
      if (!hours || hours.is_closed || !hours.open_time || !hours.close_time) continue;
      openDates.push({ date, hours });
    }

    if (openDates.length === 0) {
      throw new Error(`Shop ${args.shopId} has no operating hours to seed bookings against.`);
    }

    const serviceOptions = [
      {
        id: oilChangeId,
        name: "Oil Change",
        laborCost: 47.5,
        partsCost: 45,
        estimatedMinutes: 45,
      },
      {
        id: brakePadsId,
        name: "Brake Pad Replacement",
        laborCost: 95,
        partsCost: 70,
        estimatedMinutes: 90,
      },
      {
        id: tireRotationId,
        name: "Tire Rotation",
        laborCost: 30,
        partsCost: 0,
        estimatedMinutes: 30,
      },
      {
        id: alignmentId,
        name: "Wheel Alignment",
        laborCost: 89,
        partsCost: 0,
        estimatedMinutes: 60,
      },
      {
        id: acServiceId,
        name: "AC System Service",
        laborCost: 95,
        partsCost: 35,
        estimatedMinutes: 120,
      },
    ];

    const tireBrands = ["Michelin", "Continental", "Bridgestone", "Goodyear", "Pirelli"];
    const tireModels = ["Defender 2", "TrueContact Tour", "Alenza AS Ultra", "Assurance MaxLife", "Scorpion AS Plus"];
    const tireSizes = ["225/65R17", "235/55R18", "245/70R17", "265/70R17", "275/45R20"];
    const oilViscosities = ["0W-20", "5W-20", "5W-30", "0W-16"];
    const coolantTypes = ["Toyota Super Long Life", "Motorcraft Yellow", "Honda Type 2", "Dex-Cool", "Subaru Super Coolant"];
    const brakePadBrands = ["Akebono", "Brembo", "Wagner", "Bosch", "Raybestos"];
    const historicalNotes = [
      "Tires wearing evenly; no abnormal vibration noted.",
      "Customer mentioned occasional cold-start noise; unable to duplicate during visit.",
      "Front pads still healthy, rear pads should be checked again next service.",
      "Fluid levels topped off and no active leaks found.",
      "Aftermarket accessories observed, no interference with service work.",
    ];

    for (let vehicleIdx = 0; vehicleIdx < demoVehicles.length; vehicleIdx++) {
      if (!passportVehicleIndexes.has(vehicleIdx)) continue;

      const vehicle = demoVehicles[vehicleIdx];
      const mileage = 28000 + Math.round(dashboardSeedRatio(`${vehicle.vin}:mileage`) * 92000);
      const reportedAt = now - (7 + vehicleIdx * 3) * 24 * 60 * 60 * 1000;
      const tireBrand = dashboardPickSeedValue(tireBrands, `${vehicle.vin}:tire-brand`);
      const tireModel = dashboardPickSeedValue(tireModels, `${vehicle.vin}:tire-model`);
      const tireSize = dashboardPickSeedValue(tireSizes, `${vehicle.vin}:tire-size`);
      const condition = dashboardPickSeedValue(
        ["good", "fair", "replace_soon"] as const,
        `${vehicle.vin}:condition`
      );
      const hasMods = dashboardSeedRatio(`${vehicle.vin}:mods`) > 0.72;
      const passportRecord = {
        vin: vehicle.vin,
        mileage,
        last_reported_at: reportedAt,
        mileage_velocity: 800 + Math.round(dashboardSeedRatio(`${vehicle.vin}:velocity`) * 850),
        tires: {
          brand: tireBrand,
          model: tireModel,
          size_front: tireSize,
          size_rear: tireSize,
          run_flat: dashboardSeedRatio(`${vehicle.vin}:run-flat`) > 0.7,
          overall_condition: condition,
          front_condition: condition,
          rear_condition: dashboardPickSeedValue(
            ["good", "fair", "replace_soon"] as const,
            `${vehicle.vin}:rear-condition`
          ),
          last_verified_at: reportedAt,
        },
        fluids: {
          oil_viscosity: dashboardPickSeedValue(oilViscosities, `${vehicle.vin}:oil`),
          oil_type: "Full synthetic",
          coolant_type: dashboardPickSeedValue(coolantTypes, `${vehicle.vin}:coolant`),
          brake_fluid_type: "DOT 4",
          transmission_fluid_type: "ATF",
          confirmation_status: "shop_verified",
        },
        brakes: {
          pad_brand: dashboardPickSeedValue(brakePadBrands, `${vehicle.vin}:pads`),
          front_pad_mm: 5 + Math.round(dashboardSeedRatio(`${vehicle.vin}:front-pad`) * 5),
          rear_pad_mm: 4 + Math.round(dashboardSeedRatio(`${vehicle.vin}:rear-pad`) * 5),
          rotor_condition: dashboardPickSeedValue(
            ["good", "scored", "needs_attention"] as const,
            `${vehicle.vin}:rotors`
          ),
        },
        inspection: {
          looks_current: dashboardSeedRatio(`${vehicle.vin}:inspection-current`) > 0.2,
          expires_at: dashboardIsoDateAtOffset(today, 120 + vehicleIdx * 18),
          status: dashboardPickSeedValue(
            ["current", "current", "not_visible"] as const,
            `${vehicle.vin}:inspection`
          ),
        },
        modifications: {
          has_mods: hasMods,
          notes: hasMods ? "Aftermarket wheels and lowering springs noted during prior visit." : null,
          affected_systems: hasMods
            ? ["wheels_tires" as const, "suspension_ride_height" as const]
            : [],
        },
        created_at: reportedAt - 35 * 24 * 60 * 60 * 1000,
        updated_at: reportedAt,
        first_shop_confirmed_at: reportedAt - 35 * 24 * 60 * 60 * 1000,
        last_shop_confirmed_at: reportedAt,
      };

      const existingPassport = await ctx.db
        .query("vehicle_passports")
        .withIndex("by_vin", (q) => q.eq("vin", vehicle.vin))
        .unique();
      if (existingPassport) {
        await ctx.db.patch(existingPassport._id, passportRecord);
      } else {
        await ctx.db.insert("vehicle_passports", passportRecord);
      }

      const owner = await ctx.db
        .query("vehicle_owners")
        .withIndex("by_vin_user", (q) => q.eq("vin", vehicle.vin).eq("user_id", userIds[vehicleIdx]))
        .first();
      if (owner) {
        await ctx.db.patch(owner._id, {
          mileage,
          last_checkin_at: reportedAt,
          annual_mileage_rate: passportRecord.mileage_velocity * 12,
          usagePattern: dashboardPickSeedValue(
            ["Daily commuter", "Weekend errands", "Mixed city/highway"],
            `${vehicle.vin}:usage`
          ),
        });
      }

      const historicalVisitCount = 1 + Math.floor(dashboardSeedRatio(`${vehicle.vin}:visits`) * 3);
      for (let visitIdx = 0; visitIdx < historicalVisitCount; visitIdx++) {
        const service = serviceOptions[(vehicleIdx + visitIdx) % serviceOptions.length];
        const mechanic = mechanics[(vehicleIdx + visitIdx) % mechanics.length];
        const visitDate = dashboardIsoDateAtOffset(today, -21 - vehicleIdx * 4 - visitIdx * 38);
        const visitTime = dashboardMinutesToTime(9 * 60 + ((vehicleIdx + visitIdx) % 5) * 60);
        const visitEndTime = dashboardAddMinutesToTime(visitTime, service.estimatedMinutes);
        const visitCompletedAt = new Date(`${visitDate}T${visitEndTime}:00.000Z`).getTime();
        const historicalBookingId = await ctx.db.insert("bookings", {
          user_id: userIds[vehicleIdx],
          vin: vehicle.vin,
          shop_id: args.shopId,
          mechanic_id: mechanic._id,
          service_ids: [service.id],
          scheduled_date: visitDate,
          scheduled_time: visitTime,
          labor_cost: service.laborCost,
          parts_cost: service.partsCost,
          total_cost: service.laborCost + service.partsCost,
          estimated_labor_minutes: service.estimatedMinutes,
          status: "completed",
          created_at: visitCompletedAt - 2 * 24 * 60 * 60 * 1000,
          updated_at: visitCompletedAt,
        });
        await ctx.db.insert("booking_status_history", {
          booking_id: historicalBookingId,
          old_status: undefined,
          new_status: "completed",
          reason: `seed_dashboard_passport_history_${vehicleIdx}_${visitIdx}`,
          changed_at: visitCompletedAt,
        });
        await ctx.db.insert("job_actuals", {
          booking_id: historicalBookingId,
          mechanic_id: mechanic._id,
          actual_labor_minutes: service.estimatedMinutes,
          actual_parts_cost: service.partsCost,
          started_at: visitCompletedAt - service.estimatedMinutes * 60 * 1000,
          completed_at_ms: visitCompletedAt,
          logged_at_ms: visitCompletedAt,
          created_at: visitCompletedAt,
          updated_at: visitCompletedAt,
          difficulty_rating: 2 + Math.floor(dashboardSeedRatio(`${vehicle.vin}:difficulty:${visitIdx}`) * 3),
          parts_used:
            service.partsCost > 0
              ? [
                  {
                    part_name: service.name,
                    brand: dashboardPickSeedValue(
                      ["OEM", "Denso", "Bosch", "Wagner"],
                      `${vehicle.vin}:part-brand:${visitIdx}`
                    ),
                    oem_number: "SEED-HISTORY",
                    cost: service.partsCost,
                  },
                ]
              : [],
          technician_notes: dashboardPickSeedValue(
            historicalNotes,
            `${vehicle.vin}:note:${visitIdx}`
          ),
          finalized_at_ms: visitCompletedAt,
        });
      }
    }

    const bookingsPerMechanicTarget = 5;
    const minimumBookingsPerOpenDay = 5;
    const totalBookingTarget = Math.max(
      openDates.length * minimumBookingsPerOpenDay,
      mechanics.length * bookingsPerMechanicTarget
    );
    const dayTargets = openDates.map(() => minimumBookingsPerOpenDay);
    for (
      let extra = totalBookingTarget - openDates.length * minimumBookingsPerOpenDay, idx = 0;
      extra > 0;
      extra--, idx++
    ) {
      dayTargets[idx % dayTargets.length] += 1;
    }

    const remainingBookingsByMechanic = new Map(
      mechanics.map((mechanic) => [String(mechanic._id), bookingsPerMechanicTarget])
    );
    const bookingStatusCounts: Record<string, number> = {};
    const mechanicDayBookingCounts = new Map<string, number>();
    let bookingSequence = 0;

    for (let dayIdx = 0; dayIdx < openDates.length; dayIdx++) {
      const { date, hours } = openDates[dayIdx];
      const openMinutes = dashboardTimeToMinutes(hours.open_time!);
      const closeMinutes = dashboardTimeToMinutes(hours.close_time!);
      const openWindowMinutes = Math.max(0, closeMinutes - openMinutes);
      const dailyTarget = dayTargets[dayIdx];

      for (let dayBookingIdx = 0; dayBookingIdx < dailyTarget; dayBookingIdx++) {
        const mechanicOrder = [...mechanics].sort((a, b) => {
          const remainingA = remainingBookingsByMechanic.get(String(a._id)) ?? 0;
          const remainingB = remainingBookingsByMechanic.get(String(b._id)) ?? 0;
          if (remainingA !== remainingB) return remainingB - remainingA;
          return String(a._id).localeCompare(String(b._id));
        });
        const mechanic = mechanicOrder[(dayBookingIdx + dayIdx) % mechanicOrder.length];
        const mechanicKey = String(mechanic._id);
        const fittingServices = serviceOptions.filter(
          (serviceOption) => serviceOption.estimatedMinutes <= openWindowMinutes
        );
        const availableServices = fittingServices.length > 0 ? fittingServices : [serviceOptions[0]];
        const service = availableServices[(bookingSequence + dayIdx) % availableServices.length];

        const mechanicDayKey = `${date}:${mechanicKey}`;
        const mechanicBookingIndexForDay = mechanicDayBookingCounts.get(mechanicDayKey) ?? 0;
        mechanicDayBookingCounts.set(mechanicDayKey, mechanicBookingIndexForDay + 1);

        const relativeDayOffset = Math.round(
          (new Date(`${date}T00:00:00.000Z`).getTime() -
            new Date(`${today}T00:00:00.000Z`).getTime()) /
            86400000
        );

        const statusCycle =
          relativeDayOffset === 0
            ? ["in_progress", "confirmed", "pending", "confirmed", "completed"]
            : relativeDayOffset === 1
              ? ["confirmed", "pending", "confirmed", "pending"]
              : ["pending", "confirmed", "pending", "confirmed"];
        const userIdx = bookingSequence % userIds.length;
        const vinIdx = (bookingSequence + dayIdx) % demoVehicles.length;
        let status =
          statusCycle[(bookingSequence + mechanicBookingIndexForDay) % statusCycle.length];
        if (status === "completed" && !passportVehicleIndexes.has(vinIdx)) {
          status = "confirmed";
        }

        const latestStartMinutes = closeMinutes - service.estimatedMinutes;
        const validStartMinutes: number[] = [];
        for (let minute = openMinutes; minute <= latestStartMinutes; minute += 30) {
          validStartMinutes.push(minute);
        }
        if (validStartMinutes.length === 0) {
          continue;
        }
        const startMinutes =
          validStartMinutes[
            (mechanicBookingIndexForDay + dayBookingIdx + bookingSequence) % validStartMinutes.length
          ];
        const adjustedEstimatedMinutes = Math.min(service.estimatedMinutes, closeMinutes - startMinutes);
        if (adjustedEstimatedMinutes <= 0) {
          continue;
        }
        if (startMinutes < openMinutes || startMinutes + adjustedEstimatedMinutes > closeMinutes) {
          throw new Error(
            `Seeded booking fell outside operating hours for ${date}: ${dashboardMinutesToTime(
              startMinutes
            )}-${dashboardMinutesToTime(startMinutes + adjustedEstimatedMinutes)} vs ${
              hours.open_time
            }-${hours.close_time}`
          );
        }

        const bookingId = await createBooking({
          userIdx,
          vinIdx,
          serviceId: service.id,
          mechanicId: mechanic._id,
          scheduledDate: date,
          scheduledTime: dashboardMinutesToTime(startMinutes),
          status,
          laborCost: service.laborCost,
          partsCost: service.partsCost,
          estimatedMinutes: adjustedEstimatedMinutes,
          liveStage: status === "in_progress" ? "service_in_progress" : undefined,
          key: `${date}_${mechanicKey}_${bookingSequence}`,
        });

        if (status === "in_progress") {
          const startedAt = now - Math.min(adjustedEstimatedMinutes, 45) * 60 * 1000;
          await ctx.db.insert("job_actuals", {
            booking_id: bookingId,
            mechanic_id: mechanic._id,
            started_at: startedAt,
            created_at: now,
            updated_at: now,
            technician_notes: "Service in progress.",
            parts_used: [],
          });
        } else if (status === "completed") {
          const completedAt = now - 5 * 60 * 1000;
          const finalizedAt = bookingSequence % 2 === 0 ? completedAt : undefined;
          await ctx.db.insert("job_actuals", {
            booking_id: bookingId,
            mechanic_id: mechanic._id,
            actual_labor_minutes: adjustedEstimatedMinutes,
            actual_parts_cost: service.partsCost,
            started_at: completedAt - adjustedEstimatedMinutes * 60 * 1000,
            completed_at_ms: completedAt,
            logged_at_ms: completedAt,
            created_at: completedAt,
            updated_at: completedAt,
            difficulty_rating: 2,
            parts_used: [
              {
                part_name: "Seeded service parts",
                oem_number: "N/A",
                cost: service.partsCost,
              },
            ],
            technician_notes:
              finalizedAt != null
                ? "Seeded finalized actuals."
                : "Completed booking awaiting finalized actuals.",
            finalized_at_ms: finalizedAt,
          });
        }

        bookingStatusCounts[status] = (bookingStatusCounts[status] ?? 0) + 1;
        remainingBookingsByMechanic.set(
          mechanicKey,
          Math.max(0, (remainingBookingsByMechanic.get(mechanicKey) ?? 0) - 1)
        );
        bookingSequence += 1;
      }
    }

    await syncShopAvailabilityWindow(ctx, { shopId: args.shopId });

    return {
      success: true,
      shopId: args.shopId,
      dates: openDates.map(({ date }) => date),
      created: bookingStatusCounts,
    };
  },
});
export const clearDashboardBookingsBatch = mutation({
  args: {
    shopId: v.id("shops"),
  },
  handler: async (ctx, args) => {
    const shop = await ctx.db.get(args.shopId);
    if (!shop) throw new Error(`Shop ${args.shopId} not found.`);

    const existingBookings = await ctx.db
      .query("bookings")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
      .take(75);

    for (const booking of existingBookings) {
      const historyRows = await ctx.db
        .query("booking_status_history")
        .withIndex("by_booking_id", (q) => q.eq("booking_id", booking._id))
        .collect();
      for (const row of historyRows) {
        await ctx.db.delete(row._id);
      }

      const jobActualRows = await ctx.db
        .query("job_actuals")
        .withIndex("by_booking_id", (q) => q.eq("booking_id", booking._id))
        .collect();
      for (const row of jobActualRows) {
        await ctx.db.delete(row._id);
      }

      await ctx.db.delete(booking._id);
    }

    const existingSlots = await ctx.db
      .query("time_slots")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
      .take(250);
    for (const slot of existingSlots) {
      await ctx.db.delete(slot._id);
    }

    const blockTypes = await ctx.db
      .query("block_time_types")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
      .take(100);
    for (const type of blockTypes) {
      await ctx.db.delete(type._id);
    }

    const existingLateStartReviews = await ctx.db
      .query("late_start_reviews")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
      .take(100);
    for (const review of existingLateStartReviews) {
      await ctx.db.delete(review._id);
    }

    const existingLateStartMonitors = await ctx.db
      .query("late_start_monitors")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
      .take(100);
    for (const monitor of existingLateStartMonitors) {
      await ctx.db.delete(monitor._id);
    }

    const processed =
      existingBookings.length +
      existingSlots.length +
      blockTypes.length +
      existingLateStartReviews.length +
      existingLateStartMonitors.length;

    return {
      done: processed === 0,
      processed,
      processedBookings: existingBookings.length,
      processedSlots: existingSlots.length,
      processedBlockTypes: blockTypes.length,
      processedLateStartReviews: existingLateStartReviews.length,
      processedLateStartMonitors: existingLateStartMonitors.length,
    };
  },
});;

export const seedLateStartReviewScenario = mutation({
  args: {
    shopId: v.id("shops"),
    clearExisting: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const shop = await ctx.db.get(args.shopId);
    if (!shop) throw new Error(`Shop ${args.shopId} not found.`);

    const now = Date.now();
    const today = new Date(now).toISOString().split("T")[0];

    if (args.clearExisting ?? true) {
      const existingReviews = await ctx.db
        .query("late_start_reviews")
        .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
        .collect();
      for (const review of existingReviews) {
        await ctx.db.delete(review._id);
      }

      const existingMonitors = await ctx.db
        .query("late_start_monitors")
        .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
        .collect();
      for (const monitor of existingMonitors) {
        await ctx.db.delete(monitor._id);
      }

      const existingBookings = await ctx.db
        .query("bookings")
        .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
        .collect();

      for (const booking of existingBookings) {
        const historyRows = await ctx.db
          .query("booking_status_history")
          .withIndex("by_booking_id", (q) => q.eq("booking_id", booking._id))
          .collect();
        for (const row of historyRows) {
          await ctx.db.delete(row._id);
        }

        const jobActualRows = await ctx.db
          .query("job_actuals")
          .withIndex("by_booking_id", (q) => q.eq("booking_id", booking._id))
          .collect();
        for (const row of jobActualRows) {
          await ctx.db.delete(row._id);
        }
      }

      for (const booking of existingBookings) {
        await ctx.db.delete(booking._id);
      }

      const existingSlots = await ctx.db
        .query("time_slots")
        .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
        .collect();
      for (const slot of existingSlots) {
        await ctx.db.delete(slot._id);
      }
    }

    const existingServices = await ctx.db.query("services").collect();
    const existingCategories = await ctx.db.query("service_categories").collect();
    const existingShopServices = await ctx.db
      .query("shop_services")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
      .collect();
    const servicesBySlug = new Map(
      existingServices
        .filter((service) => service.slug)
        .map((service) => [service.slug as string, service])
    );
    const categoryIdsByName = new Map(
      existingCategories.map((category) => [category.name, category._id])
    );
    const linkedShopServiceIds = new Set(
      existingShopServices.map((shopService) => String(shopService.service_id))
    );

    const ensureService = async (slug: string, name: string, categoryName: string) => {
      const existingService = servicesBySlug.get(slug);
      let serviceId: any;

      if (existingService) {
        serviceId = existingService._id;
      } else {
        const categoryId =
          categoryIdsByName.get(categoryName) ??
          (await ctx.db.insert("service_categories", {
            name: categoryName,
            icon_name: "wrench",
            display_order: 99,
          }));
        categoryIdsByName.set(categoryName, categoryId);

        serviceId = await ctx.db.insert("services", {
          name,
          slug,
          description: name,
          service_category_id: categoryId,
          default_labor_hours: 1,
          is_labor_only: false,
          has_options: false,
          display_order: 99,
        });
        servicesBySlug.set(slug, {
          _id: serviceId,
          name,
          slug,
          description: name,
          service_category_id: categoryId,
          default_labor_hours: 1,
          is_labor_only: false,
          has_options: false,
          display_order: 99,
        } as any);
      }

      if (!linkedShopServiceIds.has(String(serviceId))) {
        await ctx.db.insert("shop_services", {
          shop_id: args.shopId,
          service_id: serviceId,
          is_offered: true,
        });
        linkedShopServiceIds.add(String(serviceId));
      }

      return serviceId;
    };

    const oilChangeId = await ensureService("oil-change", "Oil Change", "Maintenance");
    const brakePadsId = await ensureService(
      "brake-pads",
      "Brake Pad Replacement",
      "Brakes"
    );

    const ensureMechanic = async ({
      clerkUserId,
      email,
      firstName,
      lastName,
      title,
    }: {
      clerkUserId: string;
      email: string;
      firstName: string;
      lastName: string;
      title: string;
    }) => {
      let user = await ctx.db
        .query("users")
        .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", clerkUserId))
        .unique();
      if (!user) {
        const userId = await ctx.db.insert("users", {
          clerkUserId,
          onboardingCompleted: true,
          createdAt: now,
          email,
          first_name: firstName,
          last_name: lastName,
          role: "shop_mechanic",
        });
        user = await ctx.db.get(userId);
      }
      if (!user) throw new Error(`Could not create user for ${email}`);

      let mechanic = await ctx.db
        .query("mechanics")
        .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
        .filter((q) =>
          q.and(
            q.eq(q.field("first_name"), firstName),
            q.eq(q.field("last_name"), lastName)
          )
        )
        .first();
      if (!mechanic) {
        const mechanicId = await ctx.db.insert("mechanics", {
          shop_id: args.shopId,
          first_name: firstName,
          last_name: lastName,
          title,
          email,
          is_active: true,
          rating: 0,
          review_count: 0,
        });
        mechanic = await ctx.db.get(mechanicId);
      }
      if (!mechanic) throw new Error(`Could not create mechanic ${firstName} ${lastName}`);

      const existingMembership = await ctx.db
        .query("shop_users")
        .withIndex("by_user_and_shop", (q) =>
          q.eq("user_id", user._id).eq("shop_id", args.shopId)
        )
        .unique();
      if (!existingMembership) {
        await ctx.db.insert("shop_users", {
          user_id: user._id,
          shop_id: args.shopId,
          role: "shop_mechanic",
          mechanic_id: mechanic._id,
          is_active: true,
          invited_at: now,
          accepted_at: now,
          created_at: now,
          updated_at: now,
        });
      }

      return mechanic;
    };

    const [johnMechanic, jamesMechanic, miaMechanic] = await Promise.all([
      ensureMechanic({
        clerkUserId: "late-start-mechanic-john",
        email: "john.late.start@demo.otopair.com",
        firstName: "John",
        lastName: "Delay",
        title: "Lead Tech",
      }),
      ensureMechanic({
        clerkUserId: "late-start-mechanic-james",
        email: "james.late.start@demo.otopair.com",
        firstName: "James",
        lastName: "Openbay",
        title: "Shop Technician",
      }),
      ensureMechanic({
        clerkUserId: "late-start-mechanic-mia",
        email: "mia.late.start@demo.otopair.com",
        firstName: "Mia",
        lastName: "Backup",
        title: "Diagnostic Tech",
      }),
    ]);

    const ensureCustomer = async ({
      clerkUserId,
      email,
      firstName,
      lastName,
      vin,
      year,
      make,
      model,
    }: {
      clerkUserId: string;
      email: string;
      firstName: string;
      lastName: string;
      vin: string;
      year: number;
      make: string;
      model: string;
    }) => {
      let user = await ctx.db
        .query("users")
        .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", clerkUserId))
        .unique();
      if (!user) {
        const userId = await ctx.db.insert("users", {
          clerkUserId,
          onboardingCompleted: true,
          createdAt: now,
          email,
          first_name: firstName,
          last_name: lastName,
        });
        user = await ctx.db.get(userId);
      }
      if (!user) throw new Error(`Could not create customer ${email}`);

      const existingVehicle = await ctx.db
        .query("vehicles")
        .withIndex("by_vin", (q) => q.eq("vin", vin))
        .unique();
      if (!existingVehicle) {
        await ctx.db.insert("vehicles", {
          vin,
          year,
          created_at: now,
          updated_at: now,
          metadata: { make, model },
        });
      }

      const ownership = await ctx.db
        .query("vehicle_owners")
        .withIndex("by_vin_user", (q) => q.eq("vin", vin).eq("user_id", user._id))
        .unique();
      if (!ownership) {
        await ctx.db.insert("vehicle_owners", {
          vin,
          user_id: user._id,
          status: "active",
          is_primary: true,
          added_at: now,
        });
      }

      return user;
    };

    const [
      acceptUpstreamCustomer,
      acceptDownstreamCustomer,
      pushUpstreamCustomer,
      pushDownstreamCustomer,
      manualUpstreamCustomer,
      manualDownstreamCustomer,
      blockerCustomer,
    ] = await Promise.all([
      ensureCustomer({
        clerkUserId: "late-start-accept-upstream",
        email: "accept.upstream@demo.otopair.com",
        firstName: "Aaron",
        lastName: "Accept",
        vin: "LATETEST000001",
        year: 2020,
        make: "Toyota",
        model: "Camry",
      }),
      ensureCustomer({
        clerkUserId: "late-start-accept-downstream",
        email: "accept.downstream@demo.otopair.com",
        firstName: "Bianca",
        lastName: "Alternate",
        vin: "LATETEST000002",
        year: 2021,
        make: "Honda",
        model: "CR-V",
      }),
      ensureCustomer({
        clerkUserId: "late-start-push-upstream",
        email: "push.upstream@demo.otopair.com",
        firstName: "Carlos",
        lastName: "Push",
        vin: "LATETEST000003",
        year: 2019,
        make: "Ford",
        model: "Escape",
      }),
      ensureCustomer({
        clerkUserId: "late-start-push-downstream",
        email: "push.downstream@demo.otopair.com",
        firstName: "Diana",
        lastName: "Delay",
        vin: "LATETEST000004",
        year: 2022,
        make: "Subaru",
        model: "Forester",
      }),
      ensureCustomer({
        clerkUserId: "late-start-manual-upstream",
        email: "manual.upstream@demo.otopair.com",
        firstName: "Ethan",
        lastName: "Manual",
        vin: "LATETEST000005",
        year: 2018,
        make: "BMW",
        model: "X3",
      }),
      ensureCustomer({
        clerkUserId: "late-start-manual-downstream",
        email: "manual.downstream@demo.otopair.com",
        firstName: "Farah",
        lastName: "Manual",
        vin: "LATETEST000006",
        year: 2023,
        make: "Audi",
        model: "Q5",
      }),
      ensureCustomer({
        clerkUserId: "late-start-blocker",
        email: "blocker.booking@demo.otopair.com",
        firstName: "Gavin",
        lastName: "Blocker",
        vin: "LATETEST000007",
        year: 2017,
        make: "Jeep",
        model: "Cherokee",
      }),
    ]);

    const createBooking = async ({
      customer,
      vin,
      mechanicId,
      serviceId,
      scheduledTime,
      estimatedMinutes,
      laborCost,
      partsCost,
    }: {
      customer: any;
      vin: string;
      mechanicId: any;
      serviceId: any;
      scheduledTime: string;
      estimatedMinutes: number;
      laborCost: number;
      partsCost: number;
    }) => {
      const bookingId = await ctx.db.insert("bookings", {
        user_id: customer._id,
        vin,
        shop_id: args.shopId,
        mechanic_id: mechanicId,
        service_ids: [serviceId],
        scheduled_date: today,
        scheduled_time: scheduledTime,
        labor_cost: laborCost,
        parts_cost: partsCost,
        total_cost: laborCost + partsCost,
        estimated_labor_minutes: estimatedMinutes,
        status: "confirmed",
        created_at: now,
        updated_at: now,
      });

      await ctx.db.insert("booking_status_history", {
        booking_id: bookingId,
        old_status: undefined,
        new_status: "confirmed",
        reason: "seed_late_start_review",
        changed_at: now,
      });

      return bookingId;
    };

    const acceptUpstreamBookingId = await createBooking({
      customer: acceptUpstreamCustomer,
      vin: "LATETEST000001",
      mechanicId: johnMechanic._id,
      serviceId: oilChangeId,
      scheduledTime: "09:00",
      estimatedMinutes: 60,
      laborCost: 55,
      partsCost: 30,
    });
    const acceptDownstreamBookingId = await createBooking({
      customer: acceptDownstreamCustomer,
      vin: "LATETEST000002",
      mechanicId: johnMechanic._id,
      serviceId: brakePadsId,
      scheduledTime: "10:00",
      estimatedMinutes: 60,
      laborCost: 110,
      partsCost: 75,
    });

    const pushUpstreamBookingId = await createBooking({
      customer: pushUpstreamCustomer,
      vin: "LATETEST000003",
      mechanicId: johnMechanic._id,
      serviceId: oilChangeId,
      scheduledTime: "11:30",
      estimatedMinutes: 60,
      laborCost: 55,
      partsCost: 30,
    });
    const pushDownstreamBookingId = await createBooking({
      customer: pushDownstreamCustomer,
      vin: "LATETEST000004",
      mechanicId: johnMechanic._id,
      serviceId: brakePadsId,
      scheduledTime: "12:30",
      estimatedMinutes: 60,
      laborCost: 115,
      partsCost: 80,
    });
    await createBooking({
      customer: blockerCustomer,
      vin: "LATETEST000007",
      mechanicId: jamesMechanic._id,
      serviceId: oilChangeId,
      scheduledTime: "12:30",
      estimatedMinutes: 60,
      laborCost: 50,
      partsCost: 20,
    });

    const manualUpstreamBookingId = await createBooking({
      customer: manualUpstreamCustomer,
      vin: "LATETEST000005",
      mechanicId: johnMechanic._id,
      serviceId: oilChangeId,
      scheduledTime: "14:00",
      estimatedMinutes: 60,
      laborCost: 55,
      partsCost: 30,
    });
    const manualDownstreamBookingId = await createBooking({
      customer: manualDownstreamCustomer,
      vin: "LATETEST000006",
      mechanicId: johnMechanic._id,
      serviceId: brakePadsId,
      scheduledTime: "15:00",
      estimatedMinutes: 60,
      laborCost: 120,
      partsCost: 90,
    });
    await createBooking({
      customer: blockerCustomer,
      vin: "LATETEST000007",
      mechanicId: jamesMechanic._id,
      serviceId: brakePadsId,
      scheduledTime: "15:00",
      estimatedMinutes: 60,
      laborCost: 100,
      partsCost: 65,
    });

    for (const monitor of [
      { upstreamBookingId: acceptUpstreamBookingId, status: "active" },
      { upstreamBookingId: pushUpstreamBookingId, status: "active" },
      { upstreamBookingId: manualUpstreamBookingId, status: "manual_takeover" },
    ]) {
      await ctx.db.insert("late_start_monitors", {
        shop_id: args.shopId,
        upstream_booking_id: monitor.upstreamBookingId,
        cycle_minutes: 15,
        warning_due_at_ms: now - 2 * 60 * 1000,
        auto_apply_at_ms: now + 3 * 60 * 1000,
        status: monitor.status,
        created_at: now,
        updated_at: now,
      });
    }

    await ctx.db.insert("late_start_reviews", {
      shop_id: args.shopId,
      upstream_booking_id: acceptUpstreamBookingId,
      cycle_minutes: 15,
      status: "pending_staff_review",
      decision_due_at_ms: now + 5 * 60 * 1000,
      proposals: [
        {
          booking_id: acceptDownstreamBookingId,
          original_scheduled_date: today,
          original_scheduled_time: "10:00",
          original_mechanic_id: johnMechanic._id,
          proposed_scheduled_date: today,
          proposed_scheduled_time: "10:00",
          proposed_mechanic_id: jamesMechanic._id,
          used_alternate_mechanic: true,
        },
      ],
      created_at: now,
      updated_at: now,
    });

    await ctx.db.insert("late_start_reviews", {
      shop_id: args.shopId,
      upstream_booking_id: pushUpstreamBookingId,
      cycle_minutes: 15,
      status: "pending_staff_review",
      decision_due_at_ms: now + 5 * 60 * 1000,
      proposals: [
        {
          booking_id: pushDownstreamBookingId,
          original_scheduled_date: today,
          original_scheduled_time: "12:30",
          original_mechanic_id: johnMechanic._id,
          proposed_scheduled_date: today,
          proposed_scheduled_time: "12:45",
          proposed_mechanic_id: johnMechanic._id,
          used_alternate_mechanic: false,
        },
      ],
      created_at: now,
      updated_at: now,
    });

    await ctx.db.insert("late_start_reviews", {
      shop_id: args.shopId,
      upstream_booking_id: manualUpstreamBookingId,
      cycle_minutes: 15,
      status: "blocked_manual_review",
      decision_due_at_ms: now + 5 * 60 * 1000,
      proposals: [
        {
          booking_id: manualDownstreamBookingId,
          original_scheduled_date: today,
          original_scheduled_time: "15:00",
          original_mechanic_id: johnMechanic._id,
          proposed_scheduled_date: today,
          proposed_scheduled_time: "16:00",
          proposed_mechanic_id: miaMechanic._id,
          used_alternate_mechanic: true,
          blocked_reason:
            "Automatic delay was intentionally paused for manual review testing.",
        },
      ],
      blocking_reason:
        "Automatic delay was intentionally paused so staff can test manual reassignment.",
      created_at: now,
      updated_at: now,
    });

    return {
      success: true,
      seededDate: today,
      reviewCount: 3,
    };
  },
});;
