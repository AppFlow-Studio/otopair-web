import { query, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { awardPointsImpl } from "./healthPoints";
import {
  deriveHistoryConfidence,
  ownershipDurationToMonths,
  calculatePrevOwnerAnnualRate,
} from "./lib/classifier";

/**
 * vehicles.ts - Canonical vehicle catalog management
 * 
 * Manages the canonical vehicle catalog (one row per VIN).
 * Ownership relationships are in vehicle_owners table.
 */

// QUERIES

/**
 * List all vehicles in the system
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("vehicles").collect();
  },
});

/**
 * Get a vehicle by ID
 */
export const getById = query({
  args: { id: v.id("vehicles") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

/**
 * Get vehicle by canonical VIN (unique lookup)
 */
export const getByVin = query({
  args: { vin: v.string() },
  handler: async (ctx, args) => {
    const normalizedVin = args.vin.toUpperCase().trim();
    return await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", normalizedVin))
      .unique();
  },
});

/**
 * Get vehicle with all its active owners
 */
export const getVehicleWithOwners = query({
  args: { vin: v.string() },
  handler: async (ctx, args) => {
    const normalizedVin = args.vin.toUpperCase().trim();
    
    // Get the vehicle
    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", normalizedVin))
      .unique();
    
    if (!vehicle) {
      throw new Error("We couldn't find this vehicle. Double-check the VIN and try again.");
    }
    
    // Get active owners
    const owners = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_vin", (q) => q.eq("vin", normalizedVin))
      .collect();
    
    const activeOwners = owners.filter((o) => o.status === "active");
    
    return {
      vehicle,
      owners: activeOwners,
    };
  },
});

/**
 * Get a specific ownership relationship
 */
export const getVehicleOwner = query({
  args: {
    vin: v.string(),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const normalizedVin = args.vin.toUpperCase().trim();
    
    return await ctx.db
      .query("vehicle_owners")
      .withIndex("by_vin_user", (q) =>
        q.eq("vin", normalizedVin).eq("user_id", args.userId)
      )
      .unique();
  },
});

/**
 * Resolved human-readable display info for one vehicle by VIN.
 *
 * Walks the FK chain so callers don't have to:
 *   vehicles.vehicle_config_id
 *     → vehicle_configs.make_id  → makes.name
 *     → vehicle_configs.model_id → models.name
 *     → vehicle_configs.trim_name (denormalized) ?? trims.name
 *
 * Used by the Oto AI chat action (convex/oto/chat.ts) to build the
 * <vehicle display: "..."> line of the uncached-zone envelope. No VIN is
 * exposed in the return shape — only year/make/model/trim and the opaque
 * vehicles document id.
 *
 * Returns null if no vehicle with that VIN exists.
 *
 * Note: this query does NOT enforce ownership. Callers should establish
 * ownership before calling (e.g. via getMyVehicles). Year/make/model/trim
 * is non-sensitive catalog metadata.
 */
export const getDisplayInfoForVin = query({
  args: { vin: v.string() },
  handler: async (ctx, args) => {
    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", args.vin))
      .unique();
    if (!vehicle) return null;

    let make: string | null = null;
    let model: string | null = null;
    let trim: string | null = null;

    if (vehicle.vehicle_config_id) {
      const config = await ctx.db.get(vehicle.vehicle_config_id);
      if (config) {
        if (config.make_id) {
          const makeRow = await ctx.db.get(config.make_id);
          make = makeRow?.name ?? null;
        }
        if (config.model_id) {
          const modelRow = await ctx.db.get(config.model_id);
          model = modelRow?.name ?? null;
        }
        if (config.trim_name && config.trim_name.trim() !== "") {
          trim = config.trim_name;
        }
      }
    }

    // Fallback: load trim from the trims table if config didn't carry it.
    if (!trim && vehicle.trim_id) {
      const trimRow = await ctx.db.get(vehicle.trim_id);
      trim = trimRow?.name ?? null;
    }

    // Last-ditch fallback: NHTSA metadata snapshot on the vehicles row.
    // Some partially-onboarded vehicles haven't been through the enrichment
    // pipeline yet and only have raw vPIC fields cached here.
    const meta = (vehicle.metadata ?? {}) as {
      make?: string;
      model?: string;
      trim?: string;
      year?: number | string;
    };
    if (!make && meta.make) make = String(meta.make);
    if (!model && meta.model) model = String(meta.model);
    if (!trim && meta.trim) trim = String(meta.trim);

    const year =
      vehicle.year ??
      (typeof meta.year === "number"
        ? meta.year
        : typeof meta.year === "string"
          ? Number.parseInt(meta.year, 10) || null
          : null);

    return {
      id: vehicle._id,
      year,
      make,
      model,
      trim,
    };
  },
});

/**
 * Combined lookup for the create-booking drawer.
 * Returns vehicle YMMT + active owners with their user contact details.
 * Returns null when the VIN isn't in the system yet (caller falls back to NHTSA).
 */
export const getVehicleBookingInfo = query({
  args: { vin: v.string() },
  handler: async (ctx, args) => {
    const normalizedVin = args.vin.toUpperCase().trim();

    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", normalizedVin))
      .unique();

    if (!vehicle) return null;

    // Resolve YMMT (same chain as getDisplayInfoForVin)
    let make: string | null = null;
    let model: string | null = null;
    let trim: string | null = null;

    if (vehicle.vehicle_config_id) {
      const config = await ctx.db.get(vehicle.vehicle_config_id);
      if (config) {
        if (config.make_id) {
          const makeRow = await ctx.db.get(config.make_id);
          make = makeRow?.name ?? null;
        }
        if (config.model_id) {
          const modelRow = await ctx.db.get(config.model_id);
          model = modelRow?.name ?? null;
        }
        if (config.trim_name && config.trim_name.trim() !== "") {
          trim = config.trim_name;
        }
      }
    }
    if (!trim && vehicle.trim_id) {
      const trimRow = await ctx.db.get(vehicle.trim_id);
      trim = trimRow?.name ?? null;
    }
    const meta = (vehicle.metadata ?? {}) as { make?: string; model?: string; trim?: string; year?: number | string };
    if (!make && meta.make) make = String(meta.make);
    if (!model && meta.model) model = String(meta.model);
    if (!trim && meta.trim) trim = String(meta.trim);
    const year =
      vehicle.year ??
      (typeof meta.year === "number"
        ? meta.year
        : typeof meta.year === "string"
          ? Number.parseInt(meta.year, 10) || null
          : null);

    // Resolve active owners with user contact details
    const ownerships = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_vin", (q) => q.eq("vin", normalizedVin))
      .collect();
    const activeOwnerships = ownerships.filter((o) => o.status === "active");

    const owners = (
      await Promise.all(
        activeOwnerships.map(async (o) => {
          const user = await ctx.db.get(o.user_id);
          if (!user) return null;
          return {
            userId: o.user_id,
            firstName: user.first_name ?? null,
            lastName: user.last_name ?? null,
            email: user.email ?? null,
            phone: user.phone ?? null,
          };
        })
      )
    ).filter((o): o is NonNullable<typeof o> => o !== null);

    return { year, make, model, trim, owners };
  },
});

/**
 * List all active vehicles for the currently authenticated user.
 * Returns null if not authenticated, empty array if no vehicles.
 */
export const getMyVehicles = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject))
      .unique();
    if (!user) return [];

    const ownerships = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_user_status", (q) =>
        q.eq("user_id", user._id).eq("status", "active")
      )
      .collect();

    const results = await Promise.all(
      ownerships.map(async (ownership) => {
        const vehicle = await ctx.db
          .query("vehicles")
          .withIndex("by_vin", (q) => q.eq("vin", ownership.vin))
          .unique();

        const trim = vehicle?.trim_id ? await ctx.db.get(vehicle.trim_id) : null;

        return {
          vin: ownership.vin,
          vehicle,
          ownership,
          trimName: trim?.name ?? null,
        };
      })
    );

    return results;
  },
});

/**
 * List all active vehicles owned by a user
 */
export const listVehiclesByUser = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    // Get active ownerships for this user
    const ownerships = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_user_status", (q) =>
        q.eq("user_id", args.userId).eq("status", "active")
      )
      .collect();
    
    // Fetch vehicle for each ownership
    const results = await Promise.all(
      ownerships.map(async (ownership) => {
        const vehicle = await ctx.db
          .query("vehicles")
          .withIndex("by_vin", (q) => q.eq("vin", ownership.vin))
          .unique();
        
        return {
          vin: ownership.vin,
          vehicle,
          ownership,
        };
      })
    );
    
    return results;
  },
});

/**
 * Get just the VINs a user owns (for quick lookups)
 */
export const listOwnedVINsByUser = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const ownerships = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_user_status", (q) =>
        q.eq("user_id", args.userId).eq("status", "active")
      )
      .collect();
    
    return ownerships.map((o) => o.vin);
  },
});


/**
 * Clear the cached image URL for a vehicle so the next app load re-fetches it.
 */
export const clearVehicleImageUrl = mutation({
  args: { vin: v.string() },
  handler: async (ctx, args) => {
    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", args.vin.toUpperCase().trim()))
      .unique();
    if (vehicle) {
      await ctx.db.patch(vehicle._id, { image_url: undefined });
    }
  },
});

/**
 * Save a cached image URL for a vehicle so we don't re-fetch from the API.
 */
export const saveVehicleImageUrl = mutation({
  args: {
    vin: v.string(),
    image_url: v.string(),
  },
  handler: async (ctx, args) => {
    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", args.vin.toUpperCase().trim()))
      .unique();
    if (vehicle) {
      await ctx.db.patch(vehicle._id, { image_url: args.image_url });
    }
  },
});

// MUTATIONS

/**
 * Create or update a vehicle (idempotent by VIN)
 * 
 * If vehicle with this VIN already exists, updates fields.
 * If not, creates new vehicle.
 */
export const upsertVehicle = mutation({
  args: {
    vin: v.string(),
    trim_id: v.optional(v.id("trims")),
    engine_id: v.optional(v.id("engines")),
    transmission_id: v.optional(v.id("transmissions")),
    chassis_id: v.optional(v.id("chassis_variants")),
    year: v.optional(v.float64()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    // Normalize VIN
    const normalizedVin = args.vin.toUpperCase().trim();
    
    // Check if vehicle exists
    const existing = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", normalizedVin))
      .unique();
    
    if (existing) {
      // Update existing vehicle with new fields (preserve if undefined)
      const updates: any = { updated_at: Date.now() };
      if (args.trim_id !== undefined) updates.trim_id = args.trim_id;
      if (args.engine_id !== undefined) updates.engine_id = args.engine_id;
      if (args.transmission_id !== undefined)
        updates.transmission_id = args.transmission_id;
      if (args.chassis_id !== undefined) updates.chassis_id = args.chassis_id;
      if (args.year !== undefined) updates.year = args.year;
      if (args.metadata !== undefined) updates.metadata = args.metadata;
      
      await ctx.db.patch(existing._id, updates);
      const updated = await ctx.db.get(existing._id);
      return updated;
    } else {
      // Create new vehicle
      const now = Date.now();
      const vehicleId = await ctx.db.insert("vehicles", {
        vin: normalizedVin,
        trim_id: args.trim_id,
        engine_id: args.engine_id,
        transmission_id: args.transmission_id,
        chassis_id: args.chassis_id,
        year: args.year,
        metadata: args.metadata,
        created_at: now,
        updated_at: now,
      });
      
      return await ctx.db.get(vehicleId);
    }
  },
});

/**
 * Add an owner to a vehicle (or reactivate removed ownership)
 * 
 * - Creates vehicle if it doesn't exist
 * - If ownership exists with status="removed", reactivates it
 * - If ownership is already active, updates fields
 */
export const addOwner = mutation({
  args: {
    vin: v.string(),
    userId: v.id("users"),
    nickname: v.optional(v.string()),
    is_primary: v.optional(v.boolean()),
    mileage: v.optional(v.float64()),
  },
  handler: async (ctx, args) => {
    const normalizedVin = args.vin.toUpperCase().trim();
    
    // Ensure vehicle exists (upsert it if not)
    let vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", normalizedVin))
      .unique();
    
    if (!vehicle) {
      const now = Date.now();
      const vehicleId = await ctx.db.insert("vehicles", {
        vin: normalizedVin,
        created_at: now,
        updated_at: now,
      });
      vehicle = await ctx.db.get(vehicleId);
    }
    
    // Check for existing ownership
    const existing = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_vin_user", (q) =>
        q.eq("vin", normalizedVin).eq("user_id", args.userId)
      )
      .unique();
    
    const now = Date.now();
    
    if (existing) {
      if (existing.status === "removed") {
        // Reactivate removed ownership
        const updates: any = {
          status: "active",
          removed_at: undefined,
          added_at: now,
        };
        if (args.nickname !== undefined) updates.nickname = args.nickname;
        if (args.is_primary !== undefined) updates.is_primary = args.is_primary;
        if (args.mileage !== undefined) updates.mileage = args.mileage;

        await ctx.db.patch(existing._id, updates);
        return existing._id;
      } else {
        // Active ownership - update fields
        const updates: any = {};
        if (args.nickname !== undefined) updates.nickname = args.nickname;
        if (args.is_primary !== undefined) updates.is_primary = args.is_primary;
        if (args.mileage !== undefined) updates.mileage = args.mileage;

        if (Object.keys(updates).length > 0) {
          await ctx.db.patch(existing._id, updates);
        }
        return existing._id;
      }
    } else {
      // Create new ownership
      const ownershipId = await ctx.db.insert("vehicle_owners", {
        vin: normalizedVin,
        user_id: args.userId,
        status: "active",
        nickname: args.nickname,
        is_primary: args.is_primary ?? false,
        mileage: args.mileage,
        added_at: now,
      });
      
      return ownershipId;
    }
  },
});

/**
 * Hard-delete ownership (remove vehicle from user).
 *
 * Deletes the row from vehicle_owners and cascades cleanup for
 * vehicle-owner scoped records.
 */
export const removeOwner = mutation({
  args: {
    vin: v.string(),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const normalizedVin = args.vin.toUpperCase().trim();
    
    // Find ownership
    const ownership = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_vin_user", (q) =>
        q.eq("vin", normalizedVin).eq("user_id", args.userId)
      )
      .unique();
    
    if (!ownership) {
      throw new Error("This customer isn't listed as an owner of that vehicle.");
    }
    
    // Delete maintenance records for this ownership
    const maintenanceRows = await ctx.db
      .query("maintenance_records")
      .withIndex("by_vehicle_owner", (q) => q.eq("vehicleOwnerId", ownership._id))
      .collect();
    for (const row of maintenanceRows) {
      await ctx.db.delete(row._id);
    }

    // Finally delete the ownership row itself.
    await ctx.db.delete(ownership._id);
  },
});

/**
 * Hard-delete ownership by vehicle_owners._id.
 *
 * Use this when caller already has ownership id (most reliable key).
 */
export const removeOwnerById = mutation({
  args: {
    vehicleOwnerId: v.id("vehicle_owners"),
  },
  handler: async (ctx, args) => {
    const ownership = await ctx.db.get(args.vehicleOwnerId);
    if (!ownership) {
      throw new Error("We couldn't find that vehicle ownership record.");
    }

    const maintenanceRows = await ctx.db
      .query("maintenance_records")
      .withIndex("by_vehicle_owner", (q) => q.eq("vehicleOwnerId", ownership._id))
      .collect();
    for (const row of maintenanceRows) {
      await ctx.db.delete(row._id);
    }

    await ctx.db.delete(ownership._id);
    return { success: true };
  },
});

/**
 * Set a vehicle as primary for a user
 * 
 * Ensures only one primary vehicle per user.
 * Automatically removes is_primary from other active ownerships.
 */
export const updateOwnershipPrimary = mutation({
  args: {
    vin: v.string(),
    userId: v.id("users"),
    is_primary: v.boolean(),
  },
  handler: async (ctx, args) => {
    const normalizedVin = args.vin.toUpperCase().trim();
    
    // Find ownership to update
    const ownership = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_vin_user", (q) =>
        q.eq("vin", normalizedVin).eq("user_id", args.userId)
      )
      .unique();
    
    if (!ownership) {
      throw new Error("This customer isn't listed as an owner of that vehicle.");
    }
    
    if (args.is_primary) {
      // Remove primary from all other active ownerships for this user
      const otherOwnerships = await ctx.db
        .query("vehicle_owners")
        .withIndex("by_user_status", (q) =>
          q.eq("user_id", args.userId).eq("status", "active")
        )
        .collect();
      
      await Promise.all(
        otherOwnerships.map(async (o) => {
          if (o._id !== ownership._id && o.is_primary) {
            await ctx.db.patch(o._id, { is_primary: false });
          }
        })
      );
    }
    
    // Update the target ownership
    await ctx.db.patch(ownership._id, { is_primary: args.is_primary });
  },
});

/**
 * Update vehicle mileage
 */
export const updateMileage = mutation({
  args: {
    vin: v.string(),
    userId: v.id("users"),
    mileage: v.float64(),
  },
  handler: async (ctx, args) => {
    const normalizedVin = args.vin.toUpperCase().trim();
    
    // Find ownership
    const ownership = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_vin_user", (q) =>
        q.eq("vin", normalizedVin).eq("user_id", args.userId)
      )
      .unique();
    
    if (!ownership) {
      throw new Error("This customer isn't listed as an owner of that vehicle.");
    }
    
    await ctx.db.patch(ownership._id, { mileage: args.mileage });
  },
});

// ============================================================================
// VEHICLE ONBOARDING
// ============================================================================

/**
 * Reset onboarding — clears profile fields on vehicle_owners and
 * deletes all maintenance_records for this vehicle, taking the user
 * back to the onboarding prompt.
 */
export const resetVehicleOnboarding = mutation({
  args: {
    vehicleOwnerId: v.id("vehicle_owners"),
  },
  handler: async (ctx, args) => {
    // Clear profile fields
    await ctx.db.patch(args.vehicleOwnerId, {
      ownershipType: undefined,
      ownedSinceNew: undefined,
      mileageAtPurchase: undefined,
      ownershipDuration: undefined,
      mileage: undefined,
      annualMileageBand: undefined,
      usagePattern: undefined,
      lastServiceWhen: undefined,
      lastServiceWhat: undefined,
      serviceLocationPreference: undefined,
      garageRole: undefined,
      avgMonthlyDriving: undefined,
      drivingConditions: undefined,
      knownIssues: undefined,
      preOnboardingComplete: undefined,
      onboardingComplete: undefined,
    });

    // Delete all maintenance_records for this vehicle
    const records = await ctx.db
      .query("maintenance_records")
      .withIndex("by_vehicle_owner", (q) =>
        q.eq("vehicleOwnerId", args.vehicleOwnerId)
      )
      .collect();

    for (const rec of records) {
      await ctx.db.delete(rec._id);
    }

    return { success: true };
  },
});

/**
 * Marks the pre-onboarding flow as complete for a vehicle owner.
 * This is the gate before the existing CarInfoStepper questions.
 */
export const completeVehiclePreOnboarding = mutation({
  args: {
    vehicleOwnerId: v.id("vehicle_owners"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.vehicleOwnerId, {
      preOnboardingComplete: true,
    });
    return { success: true };
  },
});

/**
 * Saves the branching pre-onboarding questionnaire (Vehicle Onboarding v2)
 * and marks preOnboardingComplete when required answers are present.
 */
export const saveVehiclePreOnboarding = mutation({
  args: {
    vehicleOwnerId: v.id("vehicle_owners"),
    ownershipType: v.string(), // "leased" | "owned"
    ownedSinceNew: v.optional(v.boolean()),
    mileageAtPurchase: v.optional(v.float64()),
    ownershipDuration: v.optional(v.string()),
    currentMileage: v.float64(),
    annualMileageBand: v.string(), // "light" | "avg" | "heavy" | "very_heavy"
    usagePattern: v.string(), // "mostly_local" | "mostly_highway" | "mixed"
    lastServiceWhen: v.optional(v.string()),
    lastServiceWhat: v.optional(v.array(v.string())),
    serviceLocationPreference: v.optional(v.string()),
    concernText: v.optional(v.string()),
    garageRole: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const owner = await ctx.db.get(args.vehicleOwnerId);
    if (!owner) {
      throw new Error(`Vehicle ownership not found: ${args.vehicleOwnerId}`);
    }

    if (args.ownershipType !== "leased" && args.ownershipType !== "owned") {
      throw new Error("Invalid ownershipType");
    }
    if (args.ownershipType === "owned" && args.ownedSinceNew === undefined) {
      throw new Error("ownedSinceNew is required when ownershipType is owned");
    }
    if (args.currentMileage < 0) {
      throw new Error("currentMileage must be >= 0");
    }

    // Map new pre-onboarding bands to existing fields used by maintenance logic.
    const avgMonthlyDriving =
      args.annualMileageBand === "light"
        ? "light"
        : args.annualMileageBand === "avg"
          ? "average"
          : "heavy"; // heavy + very_heavy collapse into existing model

    const drivingConditions =
      args.usagePattern === "mostly_local"
        ? "city"
        : args.usagePattern === "mostly_highway"
          ? "highway"
          : "mixed";

    const knownIssues =
      args.concernText && args.concernText.trim().length > 0
        ? [args.concernText.trim()]
        : undefined;

    const path3 = args.ownershipType === "owned" && args.ownedSinceNew === false;
    const isComplete =
      !!args.ownershipType &&
      args.currentMileage >= 0 &&
      !!args.annualMileageBand &&
      !!args.usagePattern &&
      (args.ownershipType === "leased" ||
        args.ownedSinceNew === true ||
        path3);

    // Derive Maintenance Intelligence modifier inputs
    const historyConfidence = deriveHistoryConfidence(
      args.ownedSinceNew,
      args.ownershipType,
      args.lastServiceWhen,
      args.lastServiceWhat ?? undefined
    );
    const durationMonths = ownershipDurationToMonths(args.ownershipDuration);
    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", owner.vin))
      .unique();
    const prevOwnerRate = path3
      ? calculatePrevOwnerAnnualRate(
          args.mileageAtPurchase,
          vehicle?.year ?? undefined,
          durationMonths
            ? new Date().getFullYear() - Math.round(durationMonths / 12)
            : undefined
        )
      : undefined;

    const mileageTier =
      args.currentMileage <= 75_000 ? "low" :
      args.currentMileage <= 150_000 ? "moderate" :
      args.currentMileage <= 250_000 ? "high" : "ultra";

    await ctx.db.patch(args.vehicleOwnerId, {
      ownershipType: args.ownershipType,
      ownedSinceNew: args.ownershipType === "owned" ? args.ownedSinceNew : undefined,
      mileageAtPurchase: path3 ? args.mileageAtPurchase : undefined,
      ownershipDuration: path3 ? args.ownershipDuration : undefined,
      mileage: args.currentMileage,
      annualMileageBand: args.annualMileageBand,
      usagePattern: args.usagePattern,
      lastServiceWhen: args.lastServiceWhen,
      lastServiceWhat: args.lastServiceWhat,
      serviceLocationPreference: args.serviceLocationPreference,
      garageRole: args.garageRole,
      avgMonthlyDriving,
      drivingConditions,
      knownIssues,
      preOnboardingComplete: isComplete,
      // Maintenance Intelligence fields
      usage_pattern: drivingConditions,
      vehicle_age_years: vehicle?.year
        ? new Date().getFullYear() - vehicle.year
        : undefined,
      mileage_tier: mileageTier,
      prev_usage_intensity: prevOwnerRate
        ? prevOwnerRate < 10_000 ? "light"
          : prevOwnerRate <= 15_000 ? "average"
          : prevOwnerRate <= 25_000 ? "heavy" : "ultra_heavy"
        : undefined,
      history_confidence: historyConfidence,
      prev_owner_annual_rate: prevOwnerRate,
    });

    // ── Create maintenance records from "last service" answers ──────────
    if (args.lastServiceWhen && args.lastServiceWhen !== "not_sure" && args.lastServiceWhat?.length) {
      const now = Date.now();
      const MS_PER_MONTH = 30.44 * 24 * 60 * 60 * 1000;

      const serviceDate: number =
        args.lastServiceWhen === "lt1mo" ? now - 0.5 * MS_PER_MONTH :
        args.lastServiceWhen === "1_3mo" ? now - 2 * MS_PER_MONTH :
        args.lastServiceWhen === "3_6mo" ? now - 4.5 * MS_PER_MONTH :
        args.lastServiceWhen === "6_12mo" ? now - 9 * MS_PER_MONTH :
        args.lastServiceWhen === "12plus" ? now - 15 * MS_PER_MONTH :
        now - 8 * MS_PER_MONTH;

      const TYPE_MAP: Record<string, string> = {
        oil_change: "oil",
        brakes: "brakes",
        tires: "tires",
        inspection: "inspection",
      };

      for (const what of args.lastServiceWhat) {
        const maintenanceType = TYPE_MAP[what];
        if (!maintenanceType) continue;

        const existing = await ctx.db
          .query("maintenance_records")
          .withIndex("by_vehicle_and_type", (q) =>
            q.eq("vehicleOwnerId", args.vehicleOwnerId).eq("type", maintenanceType)
          )
          .unique();

        const customInputs = maintenanceType === "inspection"
          ? { expirationDate: serviceDate + 12 * MS_PER_MONTH }
          : undefined;

        if (existing) {
          await ctx.db.patch(existing._id, {
            lastServiceDate: serviceDate,
            lastServiceMileage: undefined,
            customInputs,
            updatedAt: now,
          });
        } else {
          await ctx.db.insert("maintenance_records", {
            vehicleOwnerId: args.vehicleOwnerId,
            type: maintenanceType,
            lastServiceDate: serviceDate,
            lastServiceMileage: undefined,
            customInputs,
            createdAt: now,
            updatedAt: now,
          });
        }
      }
    }

    // Write to vehicle_driving_profiles (raw answers table)
    if (isComplete) {
      const now = Date.now();
      const onboardingPath =
        args.ownershipType === "leased" ? "leased" :
        args.ownedSinceNew ? "owned_new" : "owned_used";

      const existingProfile = await ctx.db
        .query("vehicle_driving_profiles")
        .withIndex("by_vehicle_owner", (q) =>
          q.eq("vehicle_owner_id", args.vehicleOwnerId)
        )
        .unique();

      const profileData = {
        vehicle_owner_id: args.vehicleOwnerId,
        onboarding_path: onboardingPath,
        onboarding_completed_at: now,
        mileage_at_purchase: path3 ? args.mileageAtPurchase : undefined,
        ownership_duration: path3 ? args.ownershipDuration : undefined,
        current_mileage: args.currentMileage,
        annual_mileage_band: args.annualMileageBand,
        usage_pattern: drivingConditions,
        last_service_when: args.lastServiceWhen,
        last_service_what: args.lastServiceWhat,
        where_serviced: args.serviceLocationPreference,
        current_concerns: args.concernText,
        garage_role: args.garageRole,
        source: "onboarding" as const,
        created_at: existingProfile?.created_at ?? now,
        updated_at: now,
      };

      if (existingProfile) {
        await ctx.db.patch(existingProfile._id, profileData);
      } else {
        await ctx.db.insert("vehicle_driving_profiles", profileData);
      }

      // For new vehicles (≤1000 mi), autoCompleteNewVehicleOnboarding will
      // create factory-fresh records and trigger the pipeline itself.
      // Triggering here would race and overwrite with a no-anchor result.
      const isNewVehicle = args.currentMileage <= 1000;
      if (!isNewVehicle) {
        await ctx.scheduler.runAfter(
          0,
          internal.maintenance_pipeline.runPipeline,
          {
            vehicleOwnerId: args.vehicleOwnerId,
            triggeredBy: "onboarding",
          }
        );
      }
    }

    return { success: true, preOnboardingComplete: isComplete };
  },
});

/**
 * Save a single onboarding field.
 *
 * Persists one field at a time:
 *   - "mileage" / "avgMonthlyDriving" / "drivingConditions" → patches vehicle_owners
 *   - "oil" / "tires" / "brakes" / "battery" / "inspection" → upserts maintenance_records
 *
 * After saving, checks whether all 6 required fields are complete.
 * If so, sets onboardingComplete = true on vehicle_owners.
 */
export const saveOnboardingField = mutation({
  args: {
    vehicleOwnerId: v.id("vehicle_owners"),
    field: v.string(),   // "mileage" | "avgMonthlyDriving" | "oil" | "tires" | "brakes" | "battery" | "inspection" | "drivingConditions"
    value: v.any(),      // shape depends on field (see handler)
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const { vehicleOwnerId, field, value } = args;

    // ── Helper: upsert maintenance_record ──────────────────────────────
    async function upsertRecord(
      type: string,
      lastServiceDate?: number,
      lastServiceMileage?: number,
      customInputs?: Record<string, unknown>
    ) {
      const existing = await ctx.db
        .query("maintenance_records")
        .withIndex("by_vehicle_and_type", (q) =>
          q.eq("vehicleOwnerId", vehicleOwnerId).eq("type", type)
        )
        .unique();

      const data = { lastServiceDate, lastServiceMileage, customInputs, updatedAt: now };

      if (existing) {
        // Clear confirmedHealthyAt — new info invalidates check-in confirmation
        await ctx.db.patch(existing._id, { ...data, confirmedHealthyAt: undefined });
      } else {
        await ctx.db.insert("maintenance_records", {
          vehicleOwnerId,
          type,
          ...data,
          createdAt: now,
        });
      }
    }

    // ── Quick Read date-range → approximate timestamp ────────────────
    const MS_PER_MONTH = 30.44 * 24 * 60 * 60 * 1000;
    function quickReadDateToTimestamp(range: string): number | undefined {
      switch (range) {
        case "within_6m": return now - 3 * MS_PER_MONTH;
        case "6m_to_1y":  return now - 9 * MS_PER_MONTH;
        case "over_1y":   return now - 18 * MS_PER_MONTH;
        case "1_to_2y":   return now - 18 * MS_PER_MONTH;
        case "over_2y":   return now - 30 * MS_PER_MONTH;
        default:          return undefined;
      }
    }

    // ── Dispatch by field ──────────────────────────────────────────────
    switch (field) {
      case "mileage": {
        await ctx.db.patch(vehicleOwnerId, { mileage: value as number });
        break;
      }
      case "avgMonthlyDriving": {
        await ctx.db.patch(vehicleOwnerId, { avgMonthlyDriving: value as string });
        break;
      }
      case "drivingConditions": {
        await ctx.db.patch(vehicleOwnerId, { drivingConditions: value as string });
        break;
      }
      case "oil": {
        const v = value as { date?: number; mileage?: number; recency?: string };
        let oilDate = v.date;
        if (!oilDate && v.recency) {
          const MS = 24 * 60 * 60 * 1000;
          const recencyMap: Record<string, number> = {
            recently: now - 30 * MS,
            few_months: now - 90 * MS,
            over_6mo: now - 210 * MS,
          };
          oilDate = recencyMap[v.recency];
        }
        await upsertRecord("oil", oilDate, v.mileage, { recency: v.recency });
        break;
      }
      case "tires": {
        // Quick Read shape: { replaced, replacedWhen?, repaired } or v3 shape: { original }
        // Legacy shape:     { type, date? }
        const v = value as { type?: string; date?: number; replaced?: string; replacedWhen?: string; repaired?: string; original?: string };
        const date = v.date ?? (v.replacedWhen ? quickReadDateToTimestamp(v.replacedWhen) : undefined);
        // Bridge CarInfoStepper's "original" answer to the "tireReplaced" field
        // that computeTireStatusCore reads for status calculation
        let tireReplaced = v.replaced;
        if (!tireReplaced && v.original) {
          tireReplaced = v.original === "yes" ? "original"
            : v.original === "no" ? "replaced"
            : "dont_know";
        }
        await upsertRecord("tires", date, undefined, {
          tireServiceType: v.type,
          tireReplaced,
          tireReplacedWhen: v.replacedWhen,
          tireRepaired: v.repaired,
          tireOriginal: v.original,
        });
        break;
      }
      case "brakes": {
        // v3 shape:     { feel }
        // Legacy shape: { date? }
        const v = value as { date?: number; lastDone?: string; feel?: string; actionStatus?: string };
        const date = v.date ?? (v.lastDone ? quickReadDateToTimestamp(v.lastDone) : undefined);
        await upsertRecord("brakes", date, undefined, {
          brakeLastDoneAnswer: v.lastDone,
          brakeFeel: v.feel,
          brakeActionStatus: v.actionStatus,
        });
        break;
      }
      case "battery": {
        const v = value as { date?: number; isOriginal?: boolean; modelYear?: number; replaced?: string };
        let installDate = v.date;
        if (v.isOriginal && !installDate && v.modelYear) {
          installDate = new Date(v.modelYear, 0, 1).getTime();
        }
        // Original battery (not replaced) — infer install date from vehicle model year
        if (v.replaced === "no" && !installDate) {
          const owner = await ctx.db.get(vehicleOwnerId);
          if (owner) {
            const vehicle = await ctx.db
              .query("vehicles")
              .withIndex("by_vin", (q) => q.eq("vin", owner.vin))
              .unique();
            if (vehicle?.year) {
              installDate = new Date(vehicle.year, 0, 1).getTime();
            }
          }
        }
        await upsertRecord("battery", installDate, undefined, { batteryReplaced: v.replaced });
        break;
      }
      case "inspection": {
        const v = value as { date: number };
        const expirationDate = v.date + 12 * 30.44 * 24 * 60 * 60 * 1000;
        await upsertRecord("inspection", v.date, undefined, { expirationDate });
        break;
      }
      case "lastServiceWhen": {
        await upsertRecord("service_history_when", undefined, undefined, { answer: value as string });
        break;
      }
      case "lastServiceWhat": {
        await upsertRecord("service_history_what", undefined, undefined, { items: value as string[] });
        break;
      }
      case "warningLights": {
        const v = value as { status: string | null; lightType?: string; lightTypes?: string[] };
        if (v.status === null) break;
        const issues: string[] = [v.status];
        if (v.lightTypes && v.lightTypes.length > 0) {
          issues.push(...v.lightTypes);
        } else if (v.lightType) {
          issues.push(v.lightType);
        }
        await ctx.db.patch(vehicleOwnerId, { knownIssues: issues });
        break;
      }
      case "knownIssues": {
        await ctx.db.patch(vehicleOwnerId, { knownIssues: value as string[] });
        break;
      }
      default:
        throw new Error(`Unknown onboarding field: ${field}`);
    }

    // ── Auto-compute onboardingComplete ────────────────────────────────
    // Required: mileage (from pre-onboarding) + warningLights answered (always the last step).
    // brakes/tires follow-up steps are conditional, so we cannot require their records here.
    const owner = await ctx.db.get(vehicleOwnerId);
    if (!owner) return { success: true };

    const hasMileage = owner.mileage != null && owner.mileage > 0;
    const hasWarningLights = owner.knownIssues != null;

    const isComplete = hasMileage && hasWarningLights;

    if (isComplete && !owner.onboardingComplete) {
      await ctx.db.patch(vehicleOwnerId, { onboardingComplete: true });

      // One-time +5 HP for fully completing the vehicle profile
      // (Rewards Framework v3 §11). `oneTimeKey` makes the award
      // idempotent against re-runs of this branch.
      await awardPointsImpl(ctx, {
        vin: owner.vin,
        userId: owner.user_id,
        delta: 5,
        oneTimeKey: "profile_complete",
      });

      // Create records for types the user said they serviced (from lastServiceWhat)
      // so skipped follow-up steps don't leave gaps as "unknown".
      const whenRecord = await ctx.db
        .query("maintenance_records")
        .withIndex("by_vehicle_and_type", (q) =>
          q.eq("vehicleOwnerId", vehicleOwnerId).eq("type", "service_history_when")
        )
        .unique();
      const whatRecord = await ctx.db
        .query("maintenance_records")
        .withIndex("by_vehicle_and_type", (q) =>
          q.eq("vehicleOwnerId", vehicleOwnerId).eq("type", "service_history_what")
        )
        .unique();
      const lastServiceWhenAnswer = (whenRecord?.customInputs as any)?.answer as string | undefined;
      const lastServiceWhatItems = (whatRecord?.customInputs as any)?.items as string[] | undefined;

      if (lastServiceWhenAnswer && lastServiceWhenAnswer !== "not_sure") {
        const MS = 24 * 60 * 60 * 1000;
        const dateMap: Record<string, number> = {
          recently:   now - 30  * MS,
          few_months: now - 90  * MS,
          over_6mo:   now - 210 * MS,
        };
        const estimatedDate = dateMap[lastServiceWhenAnswer];
        if (estimatedDate && lastServiceWhatItems) {
          const SERVICE_TO_TYPE: Record<string, string> = {
            brakes: "brakes",
            oil_change: "oil",
            tires: "tires",
            battery: "battery",
          };
          for (const item of lastServiceWhatItems) {
            const recordType = SERVICE_TO_TYPE[item];
            if (!recordType) continue;
            const existing = await ctx.db
              .query("maintenance_records")
              .withIndex("by_vehicle_and_type", (q) =>
                q.eq("vehicleOwnerId", vehicleOwnerId).eq("type", recordType)
              )
              .unique();
            if (!existing) {
              await upsertRecord(recordType, estimatedDate);
            } else if (!existing.lastServiceDate) {
              await ctx.db.patch(existing._id, { lastServiceDate: estimatedDate, updatedAt: now });
            }
          }
        }
      }

      // First-time onboarding complete → full pipeline with all new data
      await ctx.scheduler.runAfter(
        0,
        internal.maintenance_pipeline.runPipeline,
        { vehicleOwnerId, triggeredBy: "onboarding" }
      );
    } else if (owner.onboardingComplete && owner.preOnboardingComplete) {
      // Already onboarded — re-run pipeline with updated Quick Read data
      await ctx.scheduler.runAfter(
        0,
        internal.maintenance_pipeline.runPipeline,
        { vehicleOwnerId, triggeredBy: "quick_read" }
      );
    }

    return { success: true, onboardingComplete: isComplete };
  },
});

/**
 * Auto-complete onboarding for brand-new vehicles (≤1,000 miles).
 *
 * Creates healthy-default maintenance records for brakes and tires,
 * sets knownIssues to "no_all_clear", and marks onboardingComplete.
 * The user can still edit any of these via the maintenance input modal.
 */
export const autoCompleteNewVehicleOnboarding = mutation({
  args: {
    vehicleOwnerId: v.id("vehicle_owners"),
  },
  handler: async (ctx, args) => {
    const { vehicleOwnerId } = args;
    const owner = await ctx.db.get(vehicleOwnerId);
    if (!owner) throw new Error("Vehicle owner not found");
    if (owner.onboardingComplete) return { success: true };

    const now = Date.now();

    async function upsertRecord(
      type: string,
      lastServiceDate?: number,
      lastServiceMileage?: number,
      customInputs?: Record<string, unknown>
    ) {
      const existing = await ctx.db
        .query("maintenance_records")
        .withIndex("by_vehicle_and_type", (q) =>
          q.eq("vehicleOwnerId", vehicleOwnerId).eq("type", type)
        )
        .unique();

      const data = { lastServiceDate, lastServiceMileage, customInputs, updatedAt: now };

      if (existing) {
        await ctx.db.patch(existing._id, { ...data, confirmedHealthyAt: undefined });
      } else {
        await ctx.db.insert("maintenance_records", {
          vehicleOwnerId,
          type,
          ...data,
          createdAt: now,
        });
      }
    }

    const mileage = owner.mileage ?? 0;

    // Factory-fresh records for all service types
    await upsertRecord("oil", now, mileage);
    await upsertRecord("brakes", now, mileage, {
      brakeLastDoneAnswer: "within_6m",
      brakeFeel: "normal",
    });
    await upsertRecord("tires", now, mileage, {
      tireReplaced: "original",
      tireRepaired: "no",
    });
    await upsertRecord("battery", now, mileage);
    await upsertRecord("fluids", now, mileage);
    await upsertRecord("filters", now, mileage);
    await upsertRecord("wipers", now, mileage);
    await upsertRecord("engine_parts", now, mileage);
    await upsertRecord("diagnostics", now, mileage);

    const expirationDate = now + 12 * 30.44 * 24 * 60 * 60 * 1000;
    await upsertRecord("inspection", now, undefined, { expirationDate });

    // Warning lights: all clear
    await ctx.db.patch(vehicleOwnerId, {
      knownIssues: ["no_all_clear"],
      onboardingComplete: true,
    });

    // One-time +5 HP for the auto-complete path (same event as the
    // organic completion in saveOnboardingField; `oneTimeKey` dedupes).
    await awardPointsImpl(ctx, {
      vin: owner.vin,
      userId: owner.user_id,
      delta: 5,
      oneTimeKey: "profile_complete",
    });

    // Trigger the pipeline now that records exist
    await ctx.scheduler.runAfter(
      0,
      internal.maintenance_pipeline.runPipeline,
      { vehicleOwnerId, triggeredBy: "onboarding" }
    );

    return { success: true };
  },
});

/**
 * Toggle a specific warning light on or off in vehicle_owners.knownIssues.
 */
export const updateWarningLight = mutation({
  args: {
    vehicleOwnerId: v.id("vehicle_owners"),
    lightId: v.string(),
    isOn: v.boolean(),
  },
  handler: async (ctx, args) => {
    const owner = await ctx.db.get(args.vehicleOwnerId);
    if (!owner) throw new Error("Vehicle owner not found");

    const current = (owner.knownIssues as string[] | undefined) ?? [];

    let updated: string[];
    if (args.isOn) {
      if (current.includes(args.lightId)) return { success: true };
      if (current.length === 0 || (current.length === 1 && current[0] === "no_all_clear")) {
        updated = ["different_light", args.lightId];
      } else {
        updated = [...current, args.lightId];
      }
    } else {
      updated = current.filter((id) => id !== args.lightId);
      const remainingLights = updated.filter(
        (id) => !["no_all_clear", "different_light", "check_engine", "not_sure"].includes(id)
      );
      if (remainingLights.length === 0) {
        updated = ["no_all_clear"];
      }
    }

    await ctx.db.patch(args.vehicleOwnerId, { knownIssues: updated });

    // Re-run pipeline so urgency overrides from warning lights take effect
    if (owner.preOnboardingComplete) {
      await ctx.scheduler.runAfter(
        0,
        internal.maintenance_pipeline.runPipeline,
        { vehicleOwnerId: args.vehicleOwnerId, triggeredBy: "quick_read" }
      );
    }

    return { success: true };
  },
});
