import { internalMutation, internalQuery, query, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { awardPointsImpl } from "./healthPoints";
import {
  deriveHistoryConfidence,
  ownershipDurationToMonths,
  calculatePrevOwnerAnnualRate,
} from "./lib/classifier";
import { resolveTireSizesForVin } from "./lib/vehicle_passports";
import { isRealVin } from "./lib/vinIdentity";

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
/**
 * QUERY: getBrakeSystemTypeForVin
 *
 * Returns the OEM brake system tier for the vehicle behind the given VIN.
 * Drives the "According to our records, your YYYY Make Model has: Standard
 * brakes" radio pre-selection on Shop Rotors (spec section 2, field 1).
 *
 * Returns `null` when the field hasn't been backfilled yet — the UI then
 * leaves no radio pre-selected and the user picks manually.
 */
export const getBrakeSystemTypeForVin = query({
  args: { vin: v.string() },
  handler: async (ctx, args) => {
    const normalizedVin = args.vin.toUpperCase().trim();
    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", normalizedVin))
      .unique();
    if (!vehicle?.vehicle_config_id) return null;
    const config = await ctx.db.get(vehicle.vehicle_config_id);
    if (!config) return null;
    return config.brake_system_type ?? null;
  },
});

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

    // Passport-derived tire sizes so the customer booking flow can offer
    // the actual sizes a mechanic recorded (pre-job/post-job) instead of
    // generic OEM defaults.
    const passport = await ctx.db
      .query("vehicle_passports")
      .withIndex("by_vin", (q) => q.eq("vin", normalizedVin))
      .unique();
    const tireSizeFront = passport?.tires?.size_front ?? null;
    const tireSizeRear = passport?.tires?.size_rear ?? null;

    return {
      year,
      make,
      model,
      trim,
      owners,
      tire_size_front: tireSizeFront,
      tire_size_rear: tireSizeRear,
    };
  },
});

/**
 * Tire-size options for a specific vehicle (by VIN), annotated with source.
 *
 * Returns sizes the customer booking flow (mobile Shop Tires) should offer:
 * passport-recorded sizes first (`source: "verified"`), then OEM defaults from
 * `trim_specs` (`source: "oem_default"`). `lastKnown` carries the most recently
 * recorded brand/model/run-flat so the mobile UI can pre-select tier hints.
 */
export const getTireOptionsForVehicle = query({
  args: { vin: v.string() },
  handler: async (ctx, args) => {
    return await resolveTireSizesForVin(ctx, args.vin);
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
 * Internal query that returns the cached image URL + key vehicle
 * fields for a VIN. Called by the Node-only `lib.vehicle_image`
 * resolver before deciding whether to hit the VDB API.
 */
export const getCachedVehicleImage = internalQuery({
  args: { vin: v.string() },
  handler: async (ctx, args) => {
    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) =>
        q.eq("vin", args.vin.toUpperCase().trim()),
      )
      .unique();
    if (!vehicle) return null;
    // YMMT-level fallback: if this VIN's vehicles row has no image yet
    // but it's already linked to a vehicle_configs row, surface that
    // config's cached image so resolveVehicleImage can return without
    // hitting VDB. The link is set when the vehicle is confirmed.
    const configId = (vehicle as any).vehicle_config_id as string | undefined;
    const configRow = configId ? await ctx.db.get(configId as any) : null;
    return {
      image_url: (vehicle as any).image_url ?? null,
      config_image_url: (configRow as any)?.image_url ?? null,
      year: (vehicle as any).year ?? null,
      make: (vehicle as any).metadata?.make ?? null,
      model: (vehicle as any).metadata?.model ?? null,
      trim: (vehicle as any).metadata?.trim ?? null,
    };
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
    if (!vehicle) return;
    await ctx.db.patch(vehicle._id, { image_url: args.image_url });

    // Promote the image to the YMMT cache (vehicle_configs.image_url) so
    // a different VIN with the same year/make/model/trim skips VDB next
    // time. First-fetched-wins: only write if the config slot is empty,
    // so concurrent fetches for sibling VINs don't fight over it.
    const configId = (vehicle as any).vehicle_config_id as string | undefined;
    if (configId) {
      const cfg = await ctx.db.get(configId as any);
      if (cfg && !(cfg as any).image_url) {
        await ctx.db.patch(cfg._id, { image_url: args.image_url } as any);
      }
    }
  },
});

/** Stamp a resolved image straight onto a vehicle_configs row — the path for
 *  YMMT-only resolutions (no VIN to hang the cache on). First-fetched-wins,
 *  same rule as the saveVehicleImageUrl promotion above. */
export const _stampConfigImage = internalMutation({
  args: { vehicle_config_id: v.id("vehicle_configs"), image_url: v.string() },
  handler: async (ctx, { vehicle_config_id, image_url }) => {
    const cfg = await ctx.db.get(vehicle_config_id);
    if (cfg && !cfg.image_url) {
      await ctx.db.patch(vehicle_config_id, { image_url });
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
    // Vehicle identity for cars added WITHOUT a VIN (the consumer app's
    // "enter it manually" flow, which mints a MANUAL-… placeholder client-side).
    //
    // These are new and optional so older clients keep working. Before them
    // this mutation created a vehicles row holding ONLY {vin, created_at,
    // updated_at} — the year/make/model the owner had just typed was dropped on
    // the floor, surviving nowhere but the free-text `nickname`. With nothing to
    // identify the car by, it could never be enriched, so it could never clear
    // the enrichment gate in bookings.ts and the owner could never book a
    // parts-dependent service on it.
    year: v.optional(v.float64()),
    make: v.optional(v.string()),
    model: v.optional(v.string()),
    trim: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const normalizedVin = args.vin.toUpperCase().trim();
    const hasYmmt = Boolean(args.year && args.make && args.model);

    // Ensure vehicle exists (upsert it if not)
    let vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", normalizedVin))
      .unique();

    if (!vehicle) {
      const now = Date.now();
      const vehicleId = await ctx.db.insert("vehicles", {
        vin: normalizedVin,
        ...(args.year ? { year: args.year } : {}),
        ...(hasYmmt
          ? { metadata: { make: args.make, model: args.model, trim: args.trim } }
          : {}),
        created_at: now,
        updated_at: now,
      });
      vehicle = await ctx.db.get(vehicleId);
    } else if (hasYmmt && !vehicle.year) {
      // Backfill identity onto a bare row created by an older client.
      await ctx.db.patch(vehicle._id, {
        year: args.year,
        metadata: {
          ...(vehicle.metadata ?? {}),
          make: args.make,
          model: args.model,
          trim: args.trim,
        },
        updated_at: Date.now(),
      });
      vehicle = await ctx.db.get(vehicle._id);
    }

    // Kick off identity resolution for a car nothing has resolved yet.
    //
    // `engine_id` is the discriminator, not `vehicle_config_id`: the VIN path
    // (confirmVehicleForUser, runHeadless) calls upsertVehicle with the decoded
    // trim/engine BEFORE calling addOwner, so an engine_id here means a decode
    // already ran and scheduled its own enrichment. Without that check we'd
    // double-schedule the pipeline on every VIN add.
    if (vehicle && !vehicle.vehicle_config_id && !vehicle.engine_id) {
      if (isRealVin(normalizedVin)) {
        await ctx.scheduler.runAfter(0, internal.vehicleEnrichment.runHeadless.go, {
          vin: normalizedVin,
        });
      } else if (hasYmmt) {
        await ctx.scheduler.runAfter(0, internal.ymmtPipeline.enrichVehicleFromYmmt, {
          vin: normalizedVin,
          year: args.year!,
          make: args.make!,
          model: args.model!,
          trim: args.trim,
        });
      }
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
      // Primary defaults to "first car wins": a new vehicle becomes
      // primary only when the user has no primary yet. True for their
      // first car; every car added while a primary already exists (2nd,
      // 3rd, 4th, ...) defaults to secondary. Also self-heals — if a
      // previous primary was removed, the next added car restores one.
      // An explicit is_primary still wins (e.g. the "set as primary"
      // toggle, applied via updateOwnershipPrimary after creation).
      let isPrimary = args.is_primary;
      if (isPrimary === undefined) {
        const activeOwnerships = await ctx.db
          .query("vehicle_owners")
          .withIndex("by_user_status", (q) =>
            q.eq("user_id", args.userId).eq("status", "active")
          )
          .collect();
        isPrimary = !activeOwnerships.some((o) => o.is_primary);
      }

      // Create new ownership. The first car also gets garageRole "primary"
      // so its role tag + the maintenance classifier agree from the start;
      // subsequent cars start role-less (user picks one after onboarding).
      const ownershipId = await ctx.db.insert("vehicle_owners", {
        vin: normalizedVin,
        user_id: args.userId,
        status: "active",
        nickname: args.nickname,
        is_primary: isPrimary,
        garageRole: isPrimary ? "primary" : undefined,
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
 * Set a vehicle's garageRole (the user-facing "role" label, e.g. Primary,
 * Secondary, Commuter, Family, Weekend, or a custom string). garageRole is
 * the single source of truth for role — it also feeds the maintenance
 * classifier (weekend/stored get a lighter schedule).
 *
 * "Primary" is special: it's a radio that designates the default car shown
 * on app reopen, so setting it flips is_primary on this car and clears it
 * on every other active ownership. Any other role (or null) clears
 * is_primary on this car.
 */
export const setVehicleRole = mutation({
  args: {
    vin: v.string(),
    userId: v.id("users"),
    role: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const normalizedVin = args.vin.toUpperCase().trim();

    const ownership = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_vin_user", (q) =>
        q.eq("vin", normalizedVin).eq("user_id", args.userId)
      )
      .unique();
    if (!ownership) {
      throw new Error("This customer isn't listed as an owner of that vehicle.");
    }

    // Store lowercase so it matches the maintenance classifier's checks
    // ("weekend"/"stored") and the "primary" detection; the UI title-cases
    // it for display.
    const role = args.role && args.role.trim() ? args.role.trim().toLowerCase() : undefined;
    const isPrimaryRole = role === "primary";

    if (isPrimaryRole) {
      // Radio: this car becomes the default; clear primary on every other.
      const others = await ctx.db
        .query("vehicle_owners")
        .withIndex("by_user_status", (q) =>
          q.eq("user_id", args.userId).eq("status", "active")
        )
        .collect();
      await Promise.all(
        others.map(async (o) => {
          if (o._id !== ownership._id && o.is_primary) {
            await ctx.db.patch(o._id, { is_primary: false });
          }
        })
      );
      await ctx.db.patch(ownership._id, { garageRole: "primary", is_primary: true });
    } else {
      // Non-primary (or cleared) role is cosmetic for the default-car flag.
      await ctx.db.patch(ownership._id, { garageRole: role, is_primary: false });
    }
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
      // TODO(ts-fix): schema expects string but args provide string[]; cast to preserve runtime behavior
      lastServiceWhat: args.lastServiceWhat as any,
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

    // ── Vehicle model year → Jan 1 timestamp (used by "Never" recency) ──
    // CarInfoStepper offers a "Never" option for oil/tires/brakes/battery.
    // When picked, infer the service "date" as the vehicle's model year so
    // MaintenanceTracker has a real timestamp to compute status against.
    async function modelYearInstallDate(): Promise<number | undefined> {
      const owner = await ctx.db.get(vehicleOwnerId);
      if (!owner) return undefined;
      const vehicle = await ctx.db
        .query("vehicles")
        .withIndex("by_vin", (q) => q.eq("vin", owner.vin))
        .unique();
      return vehicle?.year ? new Date(vehicle.year, 0, 1).getTime() : undefined;
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
        const v = value as { date?: number; mileage?: number; recency?: string; exactDate?: number };
        let oilDate = v.date;
        if (!oilDate && v.recency) {
          // "exact_date" carries a user-picked timestamp in v.exactDate
          // — use it directly. "never" infers from model year. Other
          // recency buckets fall back to approximate-age presets so
          // MaintenanceTracker has SOMETHING to compute status against.
          if (v.recency === "exact_date" && v.exactDate) {
            oilDate = v.exactDate;
          } else if (v.recency === "never") {
            oilDate = await modelYearInstallDate();
          } else {
            const MS = 24 * 60 * 60 * 1000;
            const recencyMap: Record<string, number> = {
              recently: now - 30 * MS,
              few_months: now - 90 * MS,
              over_6mo: now - 210 * MS,
            };
            oilDate = recencyMap[v.recency];
          }
        }
        await upsertRecord("oil", oilDate, v.mileage, {
          recency: v.recency,
          ...(v.exactDate ? { exactDate: v.exactDate } : {}),
        });
        break;
      }
      case "tires": {
        // Quick Read shape: { replaced, replacedWhen?, repaired } or v3 shape: { original }
        // Legacy shape:     { type, date? }
        // CarInfoStepper shape: { recency, original }
        const v = value as { type?: string; date?: number; replaced?: string; replacedWhen?: string; repaired?: string; original?: string; recency?: string; exactDate?: number };
        let tireDate = v.date ?? (v.replacedWhen ? quickReadDateToTimestamp(v.replacedWhen) : undefined);
        // CarInfoStepper sends `recency` (recently / few_months / over_6mo / exact_date / not_sure).
        // Mirror the oil pattern so onboarding answers produce a real lastServiceDate.
        if (!tireDate && v.recency) {
          if (v.recency === "exact_date" && v.exactDate) {
            tireDate = v.exactDate;
          } else if (v.recency === "never") {
            tireDate = await modelYearInstallDate();
          } else {
            const MS = 24 * 60 * 60 * 1000;
            const recencyMap: Record<string, number> = {
              recently: now - 30 * MS,
              few_months: now - 90 * MS,
              over_6mo: now - 210 * MS,
            };
            tireDate = recencyMap[v.recency];
          }
        }
        // Bridge CarInfoStepper's "original" answer to the "tireReplaced" field
        // that computeTireStatusCore reads for status calculation.
        // "Never replaced" → also treat as original tires.
        let tireReplaced = v.replaced;
        if (!tireReplaced && v.original) {
          tireReplaced = v.original === "yes" ? "original"
            : v.original === "no" ? "replaced"
            : "dont_know";
        }
        if (!tireReplaced && v.recency === "never") {
          tireReplaced = "original";
        }
        await upsertRecord("tires", tireDate, undefined, {
          tireServiceType: v.type,
          tireReplaced,
          tireReplacedWhen: v.replacedWhen,
          tireRepaired: v.repaired,
          tireOriginal: v.original,
          recency: v.recency,
          ...(v.exactDate ? { exactDate: v.exactDate } : {}),
        });
        break;
      }
      case "brakes": {
        // v3 modal shape:       { feel }
        // Legacy shape:         { date? }
        // CarInfoStepper shape: { recency, feel }
        const v = value as { date?: number; lastDone?: string; feel?: string; actionStatus?: string; recency?: string; exactDate?: number };
        let brakeDate = v.date ?? (v.lastDone ? quickReadDateToTimestamp(v.lastDone) : undefined);
        // CarInfoStepper sends `recency` (recently / few_months / over_6mo / exact_date / not_sure).
        // Mirror the oil/tires/battery pattern so onboarding answers produce a real lastServiceDate.
        if (!brakeDate && v.recency) {
          if (v.recency === "exact_date" && v.exactDate) {
            brakeDate = v.exactDate;
          } else if (v.recency === "never") {
            brakeDate = await modelYearInstallDate();
          } else {
            const MS = 24 * 60 * 60 * 1000;
            const recencyMap: Record<string, number> = {
              recently: now - 30 * MS,
              few_months: now - 90 * MS,
              over_6mo: now - 210 * MS,
            };
            brakeDate = recencyMap[v.recency];
          }
        }
        await upsertRecord("brakes", brakeDate, undefined, {
          brakeLastDoneAnswer: v.lastDone,
          brakeFeel: v.feel,
          brakeActionStatus: v.actionStatus,
          recency: v.recency,
          ...(v.exactDate ? { exactDate: v.exactDate } : {}),
        });
        break;
      }
      case "battery": {
        const v = value as { date?: number; isOriginal?: boolean; modelYear?: number; replaced?: string; recency?: string; exactDate?: number };
        let installDate = v.date;
        if (v.isOriginal && !installDate && v.modelYear) {
          installDate = new Date(v.modelYear, 0, 1).getTime();
        }
        // Original battery (not replaced, or "Never" picked in onboarding) —
        // infer install date from vehicle model year via the shared helper.
        if (!installDate && (v.replaced === "no" || v.recency === "never")) {
          installDate = await modelYearInstallDate();
        }
        // CarInfoStepper sends `recency` for "When was your battery last replaced?".
        // Honors exact_date when provided; otherwise falls back to a bucketed timestamp.
        // ("never" is already handled above via the model-year path.)
        if (!installDate && v.recency) {
          if (v.recency === "exact_date" && v.exactDate) {
            installDate = v.exactDate;
          } else {
            const MS = 24 * 60 * 60 * 1000;
            const recencyMap: Record<string, number> = {
              recently: now - 30 * MS,
              few_months: now - 90 * MS,
              over_6mo: now - 210 * MS,
            };
            installDate = recencyMap[v.recency];
          }
        }
        await upsertRecord("battery", installDate, undefined, {
          batteryReplaced: v.replaced,
          recency: v.recency,
          ...(v.exactDate ? { exactDate: v.exactDate } : {}),
        });
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

/**
 * One-time cleanup: strips the legacy Smartcar fields
 * (smartcarVehicleId, connectionStatus, connectedAt) from every
 * vehicle_owners row. Run via:
 *
 *   npx convex run vehicles:scrubLegacySmartcarFields
 *
 * After this returns successfully, the corresponding `v.optional(...)`
 * lines in convex/schema.ts (vehicle_owners) can be removed in a
 * follow-up commit.
 */
export const scrubLegacySmartcarFields = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("vehicle_owners").collect();
    let cleaned = 0;
    for (const row of rows) {
      const r = row as Record<string, unknown>;
      const hasLegacy =
        r.smartcarVehicleId !== undefined ||
        r.connectionStatus !== undefined ||
        r.connectedAt !== undefined;
      if (!hasLegacy) continue;
      await ctx.db.patch(row._id, {
        smartcarVehicleId: undefined,
        connectionStatus: undefined,
        connectedAt: undefined,
      });
      cleaned += 1;
    }
    return { scanned: rows.length, cleaned };
  },
});

/**
 * QUERY: getReadiness
 *
 * Single-shot read for the My Cars vehicle-detail surface. Returns whether the
 * vehicle is still being set up (pipeline running) or ready, and — when ready —
 * the package questions the user needs to answer before the affected services
 * become bookable.
 *
 * See docs/TICKET_PACKAGE_QUESTIONS.md and docs/PACKAGE_AWARE_PARTS.md.
 *
 * Status taxonomy:
 *   - "enriching" = pipeline still running (or vehicle not yet config-attached).
 *                   UI shows "Setting up your car…" pill.
 *   - "ready"     = enrichment_status is terminal (seeded | partial | complete |
 *                   verified). UI shows the package-questions CTA if pending > 0.
 *
 * Lazy-row semantics: if no vehicle_owner_specs row exists, confirmed/denied
 * both default to empty — pending = everything in packages_available.
 */
export const getReadiness = query({
  args: { vehicleOwnerId: v.id("vehicle_owners") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    status: "enriching" | "ready";
    pendingPackages: Array<{
      code: string;
      label: string;
      services_affected: string[];
      detected_from: string;
      confidence?: number;
    }>;
  }> => {
    // Terminal "data exists, use it" states. Matches the precedent at
    // vehicleEnrichment/runPublic.ts:105 and runTest.ts:91. `seeded` is the
    // fixture state used by seed.ts:2520 with fill_rate: 1.0.
    const TERMINAL_STATES = new Set([
      "seeded",
      "partial",
      "complete",
      "verified",
    ]);

    const owner = await ctx.db.get(args.vehicleOwnerId);
    if (!owner) {
      // Owner row missing — fail safe to "enriching" so the UI shows the
      // pending pill rather than the spec CTA on a broken context.
      return { status: "enriching", pendingPackages: [] };
    }

    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", owner.vin))
      .first();
    if (!vehicle?.vehicle_config_id) {
      // Vehicle not yet attached to a config (early enrichment window).
      return { status: "enriching", pendingPackages: [] };
    }

    const config = await ctx.db.get(vehicle.vehicle_config_id);
    if (!config) {
      return { status: "enriching", pendingPackages: [] };
    }

    const status: "enriching" | "ready" =
      config.enrichment_status && TERMINAL_STATES.has(config.enrichment_status)
        ? "ready"
        : "enriching";

    if (status === "enriching") {
      return { status, pendingPackages: [] };
    }

    // status === "ready" — compute pending packages against owner specs.
    const ownerSpecs = await ctx.db
      .query("vehicle_owner_specs")
      .withIndex("by_vehicle_owner", (q) =>
        q.eq("vehicle_owner_id", args.vehicleOwnerId),
      )
      .first();

    const confirmed = new Set(ownerSpecs?.confirmed_packages ?? []);
    const denied = new Set(ownerSpecs?.denied_packages ?? []);

    const pendingPackages = (config.packages_available ?? [])
      .filter((p) => !confirmed.has(p.code) && !denied.has(p.code))
      .map((p) => ({
        code: p.code,
        label: p.label,
        services_affected: p.services_affected,
        detected_from: p.detected_from,
        confidence: p.confidence,
      }));

    return { status, pendingPackages };
  },
});

// Enrichment-status sets — duplicated from v3pipeline.ts:1118 so this
// public query doesn't have to import the pipeline module.
const ENRICHMENT_IN_PROGRESS_STATUSES = new Set<string>([
  "enriching",
  "scraping",
  "batch1",
  "batch2",
  "started",
]);
// Terminal states — bookings can proceed once a config lands here.
// Mirrors convex/vehicles.ts:~1760 (existing booking gate constant).
const ENRICHMENT_TERMINAL_STATUSES = new Set<string>([
  "seeded",
  "partial",
  "complete",
  "verified",
]);
// Typical end-to-end enrichment runtime from docs/ENRICHMENT_PIPELINE_COMPLETE.md
// (~7 minutes async, Batch API polled every 1 min). Used as the ETA baseline
// for the "try again in N minutes" toast on the booking flow.
const ENRICHMENT_BASELINE_MS = 7 * 60 * 1000;

/**
 * Public read of a vehicle's enrichment status keyed by VIN. Powers the
 * booking-flow "your car is still being prepped" toast on Screen 1.
 *
 * Returns `null` when the VIN doesn't resolve to a vehicle (or the vehicle
 * has no `vehicle_config_id` yet — meaning enrichment hasn't even been
 * scheduled). When found, returns:
 *   - `isInProgress` — true iff status ∈ in-progress set
 *   - `etaMinutes`   — best-effort minutes until enrichment finishes, computed
 *     from the latest `enrichment_runs.started_at` (fallback:
 *     `vehicle_configs._creationTime`) + the 7-minute baseline. Capped at 1
 *     minute minimum so we never tell the user "0 minutes". Null when not
 *     in-progress.
 *   - `elapsedMs`    — ms since the run started. Null when not in-progress.
 *
 * The client decides the copy ("Try again in ~N minutes" vs the soft
 * "almost there" message once `elapsedMs > baseline`).
 */
export const getEnrichmentStatusByVin = query({
  args: { vin: v.string() },
  handler: async (ctx, args) => {
    const normalizedVin = args.vin.toUpperCase().trim();
    if (normalizedVin.length === 0) return null;

    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", normalizedVin))
      .first();
    if (!vehicle) return null;

    const configId = (vehicle as any).vehicle_config_id;
    if (!configId) {
      // No config attached yet. Two cases:
      //   (1) Early window — the user JUST added this vehicle and
      //       confirmVehicleForUser has scheduled enrichVehicleBatchV3
      //       but STAGE 0 hasn't created the vehicle_configs row yet
      //       (~seconds-to-tens-of-seconds gap on a cold scheduler).
      //       Until the config exists we have nothing to read a status
      //       off, so this query was reporting `isInProgress: false`
      //       and the Screen 1 toast skipped.
      //   (2) Genuinely stuck — the vehicle row has been around for a
      //       while with no config (legacy data, never enriched, etc.).
      //
      // Treat case (1) as in-progress by using the vehicle row's own
      // age: if it was created within RECENT_THRESHOLD_MS, the pipeline
      // is almost certainly running but just hasn't stamped the config
      // yet. Use `vehicle._creationTime` as the elapsed-time origin.
      const RECENT_THRESHOLD_MS = 15 * 60 * 1000;
      const vehicleCreated = (vehicle as any)._creationTime as number | undefined;
      if (vehicleCreated != null) {
        const elapsedMs = Math.max(0, Date.now() - vehicleCreated);
        if (elapsedMs < RECENT_THRESHOLD_MS) {
          const remainingMs = Math.max(0, ENRICHMENT_BASELINE_MS - elapsedMs);
          const etaMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
          return {
            status: null,
            isInProgress: true,
            etaMinutes,
            elapsedMs,
          };
        }
      }
      return {
        status: null,
        isInProgress: false,
        etaMinutes: null,
        elapsedMs: null,
      };
    }

    const config = await ctx.db.get(configId);
    if (!config) return null;

    const status = (config as any).enrichment_status ?? null;
    const isInProgress =
      typeof status === "string" && ENRICHMENT_IN_PROGRESS_STATUSES.has(status);

    if (!isInProgress) {
      return { status, isInProgress: false, etaMinutes: null, elapsedMs: null };
    }

    // Resolve a start timestamp. Prefer the latest enrichment_runs.started_at
    // — that's the true pipeline launch. Fall back to the config's creation
    // time if no run row exists yet (rare scheduler race).
    const latestRun = await ctx.db
      .query("enrichment_runs")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", configId))
      .order("desc")
      .first();
    const startedAt =
      (latestRun as any)?.started_at ?? (config as any)._creationTime ?? null;

    const now = Date.now();
    const elapsedMs = startedAt != null ? Math.max(0, now - startedAt) : 0;
    const remainingMs = Math.max(0, ENRICHMENT_BASELINE_MS - elapsedMs);
    // Round UP so a 30s remainder still reads as "1 minute" instead of "0".
    const etaMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));

    return { status, isInProgress: true, etaMinutes, elapsedMs };
  },
});

/**
 * Rich per-vehicle enrichment detail for the tappable status sheet.
 *
 * Unlike the coarse `enrichment_status` string (a single pipeline phase),
 * this reports PER-CATEGORY readiness by ACTUAL DATA PRESENCE — a category
 * is "ready" only when its real rows exist in the DB, never a heuristic:
 *   - specs     → config_epa_economy (MPG) + engines (displacement/oil/…)
 *   - intervals → service_intervals (confidence-gated, joined to service name)
 *   - parts     → oem_parts catalogued for the config (count only)
 *
 * `facts` are short, real, human-readable strings the sheet types out
 * (e.g. "22 city · 32 hwy MPG", "Spark Plugs · every 100,000 mi"). Empty
 * when the category hasn't landed yet — the UI shows those as still-working.
 *
 * Returns null for an unknown VIN. `phase` mirrors getEnrichmentStatusByVin's
 * in-progress/terminal classification so the sheet only says "ready" when the
 * pipeline is genuinely done.
 */
export const getEnrichmentDetail = query({
  args: { vin: v.string() },
  handler: async (ctx, args) => {
    const normalizedVin = args.vin.toUpperCase().trim();
    if (normalizedVin.length === 0) return null;

    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", normalizedVin))
      .first();
    if (!vehicle) return null;

    // Resolve make/model/trim (trim → model → make) for the label + car image.
    let make: string | null = null;
    let model: string | null = null;
    let trimName: string | null = null;
    if (vehicle.trim_id) {
      const trim = await ctx.db.get(vehicle.trim_id);
      if (trim) {
        trimName = (trim as { name?: string }).name ?? null;
        const modelId = (trim as { model_id?: Id<"models"> }).model_id;
        if (modelId) {
          const modelRow = await ctx.db.get(modelId);
          if (modelRow) {
            model = (modelRow as { name?: string }).name ?? null;
            const makeId = (modelRow as { make_id?: Id<"makes"> }).make_id;
            if (makeId) {
              const makeRow = await ctx.db.get(makeId);
              if (makeRow) make = (makeRow as { name?: string }).name ?? null;
            }
          }
        }
      }
    }
    const year = vehicle.year ?? null;
    const labelParts: string[] = [];
    if (year != null) labelParts.push(String(year));
    if (make) labelParts.push(make);
    if (model) labelParts.push(model);
    const label = labelParts.length ? labelParts.join(" ") : "your car";

    const configId = vehicle.vehicle_config_id ?? null;

    // Status / phase — same classification as getEnrichmentStatusByVin.
    let status: string | null = null;
    let phase: "in_progress" | "ready" | "not_started" = "not_started";
    if (configId) {
      const config = await ctx.db.get(configId);
      status = (config as { enrichment_status?: string } | null)?.enrichment_status ?? null;
      if (status && ENRICHMENT_IN_PROGRESS_STATUSES.has(status)) phase = "in_progress";
      else if (status && ENRICHMENT_TERMINAL_STATUSES.has(status)) phase = "ready";
    }

    // ── Vehicle specs facts (real presence) ──────────────────────────────
    const specFacts: string[] = [];
    if (configId) {
      const epa = await ctx.db
        .query("config_epa_economy")
        .withIndex("by_config", (q) => q.eq("vehicle_config_id", configId))
        .first();
      if (epa) {
        if (epa.mpg_city != null && epa.mpg_highway != null) {
          specFacts.push(`${epa.mpg_city} city · ${epa.mpg_highway} hwy MPG`);
        } else if (epa.mpg_combined != null) {
          specFacts.push(`${epa.mpg_combined} MPG combined`);
        }
      }
    }
    if (vehicle.engine_id) {
      const engine = await ctx.db.get(vehicle.engine_id);
      if (engine) {
        const e = engine as {
          displacement_l?: number;
          cylinders?: number;
          configuration?: string;
          aspiration?: string;
          fuel_type?: string;
          oil_viscosity?: string;
          oil_capacity_qts?: number;
          oil_spec_standard?: string;
          spark_plug_gap_mm?: number;
          spark_plug_quantity?: number;
          coolant_type?: string;
          coolant_capacity_qts?: number;
          transmission_fluid_capacity_qts?: number;
        };
        const disp = e.displacement_l != null ? `${e.displacement_l}L` : null;
        const forced =
          e.aspiration && /turbo|super/i.test(e.aspiration)
            ? e.aspiration.replace(/charged/i, "").trim()
            : null;
        const layout = e.configuration ?? (e.cylinders != null ? `I${e.cylinders}` : null);
        const engineDesc = [disp, forced, layout].filter(Boolean).join(" ");
        if (engineDesc) specFacts.push(engineDesc);
        if (e.fuel_type) specFacts.push(`Fuel: ${e.fuel_type}`);
        if (e.oil_viscosity) specFacts.push(`${e.oil_viscosity} oil`);
        if (e.oil_capacity_qts != null) specFacts.push(`${e.oil_capacity_qts} qt oil capacity`);
        if (e.oil_spec_standard) specFacts.push(`Oil spec ${e.oil_spec_standard}`);
        if (e.spark_plug_gap_mm != null) {
          const qty = e.spark_plug_quantity != null ? `${e.spark_plug_quantity}× ` : "";
          specFacts.push(`${qty}Spark plug gap ${e.spark_plug_gap_mm} mm`);
        }
        if (e.coolant_type) {
          const cap = e.coolant_capacity_qts != null ? ` · ${e.coolant_capacity_qts} qt` : "";
          specFacts.push(`Coolant ${e.coolant_type}${cap}`);
        }
        if (e.transmission_fluid_capacity_qts != null) {
          specFacts.push(`Trans fluid ${e.transmission_fluid_capacity_qts} qt`);
        }
      }
    }

    // ── Service interval facts ───────────────────────────────────────────
    // "Service Name · every N mi", strongest provenance first, real numbers.
    const fmtMiles = (n: number) =>
      String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const intervalFacts: string[] = [];
    if (configId) {
      const rows = await ctx.db
        .query("service_intervals")
        .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", configId))
        .collect();
      const usable = rows
        .filter(
          (r) =>
            r.interval_miles != null &&
            (r.mechanic_verified === true || (r.confidence ?? 0) >= 0.75),
        )
        .sort(
          (a, b) =>
            Number(b.mechanic_verified ?? false) - Number(a.mechanic_verified ?? false) ||
            (b.confidence ?? 0) - (a.confidence ?? 0),
        )
        .slice(0, 6);
      for (const r of usable) {
        const svc = await ctx.db.get(r.service_id);
        const name = (svc as { name?: string } | null)?.name;
        if (!name) continue;
        intervalFacts.push(`${name} · every ${fmtMiles(r.interval_miles as number)} mi`);
      }
    }

    // ── Tire sizes (real — passport / trim specs). Best-effort. ──────────
    const tireFacts: string[] = [];
    try {
      const tires = await resolveTireSizesForVin(ctx, normalizedVin);
      const first = tires.sizes[0];
      if (first?.size) tireFacts.push(`Tire size ${first.size}`);
    } catch {
      // Tire resolution is best-effort; skip on any lookup miss.
    }

    // ── Parts catalogued: distinct parts fitted to this config. ──────────
    let partsCount = 0;
    if (configId) {
      const fitments = await ctx.db
        .query("part_fitments")
        .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", configId))
        .collect();
      partsCount = new Set(fitments.map((f) => String(f.part_id))).size;
    }

    // One comprehensive stream of REAL facts for the "thinking" ticker —
    // specs, then tires, then every service interval, then the parts tally.
    const facts: string[] = [
      ...specFacts,
      ...tireFacts,
      ...intervalFacts,
      ...(partsCount > 0 ? [`${partsCount.toLocaleString()} parts catalogued`] : []),
    ];

    return {
      vin: normalizedVin,
      label,
      year,
      make,
      model,
      trim: trimName,
      status,
      phase,
      facts,
      specs: { ready: specFacts.length > 0, facts: specFacts },
      intervals: { ready: intervalFacts.length > 0, facts: intervalFacts },
      parts: { ready: partsCount > 0, count: partsCount },
    };
  },
});

/**
 * Returns every active-owned vehicle for the current user with its current
 * enrichment phase. Powers the global completion watcher that fires a
 * persistent "your car is ready — book now" toast when a vehicle's
 * enrichment finishes mid-session.
 *
 * Phase classification (client-friendly):
 *   - "in_progress" → status ∈ in-progress set (pipeline running)
 *   - "ready"       → status ∈ terminal set (bookable)
 *   - "not_started" → no vehicle_config_id, or status is null
 *
 * Returns `null` when not authenticated. Returns `[]` when the user has
 * no active ownerships.
 */
export const getMyVehiclesEnrichmentStatus = query({
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
        q.eq("user_id", user._id).eq("status", "active"),
      )
      .collect();

    const results = await Promise.all(
      ownerships.map(async (ownership) => {
        const vin = ownership.vin;
        const vehicle = await ctx.db
          .query("vehicles")
          .withIndex("by_vin", (q) => q.eq("vin", vin))
          .unique();

        // Resolve a user-readable label. Same shape the cars page +
        // the existing "Enriching your <car>" toast use.
        let label = "your car";
        if (vehicle) {
          const trim = vehicle.trim_id ? await ctx.db.get(vehicle.trim_id) : null;
          let make: string | null = null;
          let model: string | null = null;
          if (trim) {
            const trimRow = trim as { name?: string; model_id?: any };
            const modelRow = trimRow.model_id ? await ctx.db.get(trimRow.model_id) : null;
            if (modelRow) {
              const mRow = modelRow as { name?: string; make_id?: any };
              model = mRow.name ?? null;
              const makeRow = mRow.make_id ? await ctx.db.get(mRow.make_id) : null;
              if (makeRow) make = (makeRow as { name?: string }).name ?? null;
            }
          }
          const parts: string[] = [];
          if (vehicle.year != null) parts.push(String(vehicle.year));
          if (make) parts.push(make);
          if (model) parts.push(model);
          if (parts.length > 0) label = parts.join(" ");
        }

        const configId = (vehicle as any)?.vehicle_config_id ?? null;
        let phase: "in_progress" | "ready" | "not_started" = "not_started";
        let status: string | null = null;
        if (configId) {
          const config = await ctx.db.get(configId);
          status = (config as any)?.enrichment_status ?? null;
          if (typeof status === "string") {
            if (ENRICHMENT_IN_PROGRESS_STATUSES.has(status)) phase = "in_progress";
            else if (ENRICHMENT_TERMINAL_STATUSES.has(status)) phase = "ready";
          }
        } else if (vehicle) {
          // Early-window race: vehicle row exists but vehicle_config_id
          // isn't stamped yet (see getEnrichmentStatusByVin for the long
          // comment). Treat as in-progress when the vehicle row is very
          // recent so the global completion watcher also picks up the
          // transition later (in_progress → ready) for newly-added cars.
          const RECENT_THRESHOLD_MS = 15 * 60 * 1000;
          const vehicleCreated = (vehicle as any)._creationTime as number | undefined;
          if (vehicleCreated != null && Date.now() - vehicleCreated < RECENT_THRESHOLD_MS) {
            phase = "in_progress";
          }
        }

        return {
          vin,
          label,
          ownershipId: String(ownership._id),
          status,
          phase,
        };
      }),
    );

    return results;
  },
});
