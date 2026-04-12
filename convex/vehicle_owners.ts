import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/**
 * vehicle_owners.ts - Ownership relationship queries
 * 
 * Provides queries for the vehicle_owners soft-delete join table.
 * Mutations are in vehicles.ts (addOwner, removeOwner, updateOwnershipPrimary).
 */

// QUERIES

/**
 * Get all ownership records for a VIN (active + removed)
 */
export const getByVin = query({
  args: { vin: v.string() },
  handler: async (ctx, args) => {
    const normalizedVin = args.vin.toUpperCase().trim();
    
    return await ctx.db
      .query("vehicle_owners")
      .withIndex("by_vin", (q) => q.eq("vin", normalizedVin))
      .collect();
  },
});

/**
 * Get only active ownership records for a VIN
 */
export const getActiveByVin = query({
  args: { vin: v.string() },
  handler: async (ctx, args) => {
    const normalizedVin = args.vin.toUpperCase().trim();
    
    return await ctx.db
      .query("vehicle_owners")
      .withIndex("by_vin", (q) => q.eq("vin", normalizedVin))
      .collect()
      .then((records) => records.filter((r) => r.status === "active"));
  },
});

/**
 * Get all ownership records for a user (active + removed)
 */
export const getByUser = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("vehicle_owners")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .collect();
  },
});

/**
 * Get only active ownership records for a user
 */
export const getActiveByUser = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("vehicle_owners")
      .withIndex("by_user_status", (q) =>
        q.eq("user_id", args.userId).eq("status", "active")
      )
      .collect();
  },
});

/**
 * Get a specific ownership record by VIN and user (active or removed)
 */
export const getByVinAndUser = query({
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
 * Get the primary vehicle for a user (if any)
 */
export const getPrimaryVehicle = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const ownerships = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_user_status", (q) =>
        q.eq("user_id", args.userId).eq("status", "active")
      )
      .collect();
    
    return ownerships.find((o) => o.is_primary) ?? null;
  },
});

/**
 * Check if a user owns a vehicle (active ownership)
 */
export const isOwnedByUser = query({
  args: {
    vin: v.string(),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const normalizedVin = args.vin.toUpperCase().trim();
    
    const ownership = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_vin_user", (q) =>
        q.eq("vin", normalizedVin).eq("user_id", args.userId)
      )
      .unique();
    
    return ownership?.status === "active";
  },
});

/**
 * Count active owners for a vehicle
 */
export const getOwnerCount = query({
  args: { vin: v.string() },
  handler: async (ctx, args) => {
    const normalizedVin = args.vin.toUpperCase().trim();
    
    const ownerships = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_vin", (q) => q.eq("vin", normalizedVin))
      .collect();
    
    return ownerships.filter((o) => o.status === "active").length;
  },
});

// MUTATIONS

/**
 * Dismiss the "Finish Car Setup" card for a vehicle ownership
 */
export const dismissSetupCard = mutation({
  args: { vehicleOwnerId: v.id("vehicle_owners") },
  handler: async (ctx, { vehicleOwnerId }) => {
    await ctx.db.patch(vehicleOwnerId, { setupCardDismissed: true });
  },
});

/**
 * Mark onboarding as complete (used by "Finish for now" in CarInfoStepper)
 */
export const markOnboardingComplete = mutation({
  args: { vehicleOwnerId: v.id("vehicle_owners") },
  handler: async (ctx, { vehicleOwnerId }) => {
    await ctx.db.patch(vehicleOwnerId, { onboardingComplete: true });
  },
});
