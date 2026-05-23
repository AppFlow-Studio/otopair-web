/**
 * convex/serviceParts.ts — Booking-time parts resolver.
 *
 * Given a service slug + a vehicle owner, returns either:
 *   - the exact OEM parts that apply to this car (with package-specific overrides
 *     filtered in), OR
 *   - a list of package questions the booking flow must ask the user before pricing.
 *
 * See docs/PACKAGE_AWARE_PARTS.md for the data model.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { summarizePartPrices } from "./part_prices";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PackageQuestion {
  code: string;
  label: string;
  services_affected: string[];
  detected_from: string;
  confidence?: number;
}

export interface ResolvedFitment {
  fitment_id: Id<"part_fitments">;
  part_id: Id<"oem_parts">;
  oem_part_number: string;
  name: string;
  category?: string;
  subcategory?: string;
  position?: string;
  package_code?: string;
  quantity_needed?: number;
  confidence?: number;
}

export type GetPartsResult =
  | { status: "needs_user_input"; questions: PackageQuestion[] }
  | { status: "resolved"; fitments: ResolvedFitment[] }
  | { status: "no_config"; reason: string };

// ─── Public query ───────────────────────────────────────────────────────────

/**
 * Resolve the parts for a service for a specific vehicle owner.
 *
 * If any package questions remain unanswered for this service, returns
 * `{ status: "needs_user_input", questions }` — the booking flow should render
 * those, collect answers via `recordPackageAnswers`, then call this query again.
 *
 * Otherwise returns `{ status: "resolved", fitments }` — base fitments plus
 * confirmed-package fitments, ready to price.
 */
export const getPartsForService = query({
  args: {
    serviceSlug: v.string(),
    vehicleOwnerId: v.id("vehicle_owners"),
  },
  handler: async (ctx, args): Promise<GetPartsResult> => {
    const owner = await ctx.db.get(args.vehicleOwnerId);
    if (!owner) {
      return { status: "no_config", reason: "vehicle_owner_not_found" };
    }

    // Find this owner's vehicle_config via the vehicle (vin → vehicle → vehicle_config_id).
    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", owner.vin))
      .first();
    if (!vehicle?.vehicle_config_id) {
      return { status: "no_config", reason: "vehicle_config_not_attached" };
    }

    const config = await ctx.db.get(vehicle.vehicle_config_id);
    if (!config) {
      return { status: "no_config", reason: "vehicle_config_missing" };
    }

    const ownerSpecs = await ctx.db
      .query("vehicle_owner_specs")
      .withIndex("by_vehicle_owner", (q) =>
        q.eq("vehicle_owner_id", args.vehicleOwnerId),
      )
      .first();

    const confirmed = new Set(ownerSpecs?.confirmed_packages ?? []);
    const denied = new Set(ownerSpecs?.denied_packages ?? []);

    // 1. Compute pending package questions for THIS service.
    const pending: PackageQuestion[] = (config.packages_available ?? [])
      .filter((p) => p.services_affected.includes(args.serviceSlug))
      .filter((p) => !confirmed.has(p.code) && !denied.has(p.code))
      .map((p) => ({
        code: p.code,
        label: p.label,
        services_affected: p.services_affected,
        detected_from: p.detected_from,
        confidence: p.confidence,
      }));

    if (pending.length > 0) {
      return { status: "needs_user_input", questions: pending };
    }

    // 2. Pull fitments and filter to base + confirmed packages.
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_config_service", (q) =>
        q
          .eq("vehicle_config_id", config._id)
          .eq("service_type", args.serviceSlug),
      )
      .collect();

    const applicable = fitments.filter(
      (f) => f.package_code == null || confirmed.has(f.package_code),
    );

    // 3. Hydrate the part info for each fitment.
    const resolved: ResolvedFitment[] = [];
    for (const f of applicable) {
      const part = await ctx.db.get(f.part_id);
      if (!part) continue;
      resolved.push({
        fitment_id: f._id,
        part_id: f.part_id,
        oem_part_number: part.oem_part_number,
        name: part.name,
        category: part.category,
        subcategory: part.subcategory,
        position: f.position,
        package_code: f.package_code,
        quantity_needed: f.quantity_needed,
        confidence: f.confidence,
      });
    }

    return { status: "resolved", fitments: resolved };
  },
});

// ─── Booking-facing: OEM parts for each service on a booking ───────────────

export type OemPartsForService = {
  serviceId: Id<"services">;
  serviceName: string;
  serviceSlug: string;
  parts: ResolvedFitment[];
};

export const getOemPartsForBooking = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args): Promise<OemPartsForService[]> => {
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) return [];

    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", booking.vin))
      .first();
    if (!vehicle?.vehicle_config_id) return [];

    const configId = vehicle.vehicle_config_id;
    const out: OemPartsForService[] = [];

    for (const serviceId of booking.service_ids ?? []) {
      const service = await ctx.db.get(serviceId);
      if (!service?.slug) continue;

      const fitments = await ctx.db
        .query("part_fitments")
        .withIndex("by_config_service", (q) =>
          q.eq("vehicle_config_id", configId).eq("service_type", service.slug),
        )
        .collect();

      // Drop package-conditional fitments — pre-job is informational; we don't
      // gate on owner package answers here, just show the universal base parts.
      const base = fitments.filter((f) => f.package_code == null);

      const resolved: ResolvedFitment[] = [];
      for (const f of base) {
        const part = await ctx.db.get(f.part_id);
        if (!part) continue;
        resolved.push({
          fitment_id: f._id,
          part_id: f.part_id,
          oem_part_number: part.oem_part_number,
          name: part.name,
          category: part.category,
          subcategory: part.subcategory,
          position: f.position,
          package_code: f.package_code,
          quantity_needed: f.quantity_needed,
          confidence: f.confidence,
        });
      }

      out.push({
        serviceId,
        serviceName: service.name,
        serviceSlug: service.slug,
        parts: resolved,
      });
    }

    return out;
  },
});

// ─── Booking review: priced parts breakdown for a vehicle owner ────────────
//
// Pre-booking variant of `getOemPartsForBooking` keyed by vehicle_owner instead
// of an existing booking row. Drives the "Review & Pay" parts lines so each
// part renders with quantity × unit price instead of being split evenly across
// a flat `default_parts_estimate`. Pricing comes from `part_prices` (averaged
// with outlier rejection — see part_prices.summarizePartPrices).

export type PricedFitment = {
  part_id: Id<"oem_parts">;
  name: string;
  oem_part_number: string;
  category?: string;
  position?: string;
  quantity: number;          // quantity_needed defaulted to 1
  unit_price: number;        // 0 when no part_prices rows exist
  line_total: number;        // quantity × unit_price
  has_price_data: boolean;
  price_sample_size: number;
};

export type PricedPartsForService = {
  serviceId: Id<"services">;
  serviceName: string;
  serviceSlug: string;
  parts: PricedFitment[];
  partsTotal: number;        // sum of line_totals
};

/**
 * Returns OEM parts + average unit prices for each requested service, scoped to
 * the vehicle's `vehicle_config_id` (resolved through the vehicle_owner row).
 * Package-conditional fitments are included only when the owner has confirmed
 * the package (matches the resolved branch of `getPartsForService`).
 *
 * Returns `[]` for any service that has no fitments or whose vehicle has no
 * resolved config — the UI then falls back to `default_parts_estimate`.
 */
export const getPricedPartsForServices = query({
  args: {
    vehicleOwnerId: v.id("vehicle_owners"),
    serviceIds: v.array(v.id("services")),
  },
  handler: async (ctx, args): Promise<PricedPartsForService[]> => {
    if (args.serviceIds.length === 0) return [];

    const owner = await ctx.db.get(args.vehicleOwnerId);
    if (!owner) return [];

    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", owner.vin))
      .first();
    if (!vehicle?.vehicle_config_id) return [];

    const configId = vehicle.vehicle_config_id;

    const ownerSpecs = await ctx.db
      .query("vehicle_owner_specs")
      .withIndex("by_vehicle_owner", (q) =>
        q.eq("vehicle_owner_id", args.vehicleOwnerId),
      )
      .first();
    const confirmed = new Set(ownerSpecs?.confirmed_packages ?? []);

    const out: PricedPartsForService[] = [];

    for (const serviceId of args.serviceIds) {
      const service = await ctx.db.get(serviceId);
      if (!service?.slug) continue;

      const fitments = await ctx.db
        .query("part_fitments")
        .withIndex("by_config_service", (q) =>
          q.eq("vehicle_config_id", configId).eq("service_type", service.slug!),
        )
        .collect();

      const applicable = fitments.filter(
        (f) => f.package_code == null || confirmed.has(f.package_code),
      );

      const parts: PricedFitment[] = [];
      let partsTotal = 0;
      for (const f of applicable) {
        const part = await ctx.db.get(f.part_id);
        if (!part) continue;

        const priceSummary = await summarizePartPrices(ctx, f.part_id);
        const quantity = f.quantity_needed ?? 1;
        const unit_price = priceSummary.average;
        const line_total = Math.round(quantity * unit_price * 100) / 100;
        partsTotal += line_total;

        parts.push({
          part_id: f.part_id,
          name: part.name,
          oem_part_number: part.oem_part_number,
          category: part.category,
          position: f.position,
          quantity,
          unit_price,
          line_total,
          has_price_data: priceSummary.sample_size > 0,
          price_sample_size: priceSummary.sample_size,
        });
      }

      out.push({
        serviceId,
        serviceName: service.name,
        serviceSlug: service.slug,
        parts,
        partsTotal: Math.round(partsTotal * 100) / 100,
      });
    }

    return out;
  },
});

// ─── Helper query: pending questions across ALL services for an owner ──────
// Useful for proactive onboarding ("you'll save time later if you answer these now")
// or for the cars screen to show a "questions remain" indicator.

export const getAllPendingPackageQuestions = query({
  args: { vehicleOwnerId: v.id("vehicle_owners") },
  handler: async (ctx, args): Promise<PackageQuestion[]> => {
    const owner = await ctx.db.get(args.vehicleOwnerId);
    if (!owner) return [];

    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", owner.vin))
      .first();
    if (!vehicle?.vehicle_config_id) return [];

    const config = await ctx.db.get(vehicle.vehicle_config_id);
    if (!config) return [];

    const ownerSpecs = await ctx.db
      .query("vehicle_owner_specs")
      .withIndex("by_vehicle_owner", (q) =>
        q.eq("vehicle_owner_id", args.vehicleOwnerId),
      )
      .first();

    const confirmed = new Set(ownerSpecs?.confirmed_packages ?? []);
    const denied = new Set(ownerSpecs?.denied_packages ?? []);

    return (config.packages_available ?? [])
      .filter((p) => !confirmed.has(p.code) && !denied.has(p.code))
      .map((p) => ({
        code: p.code,
        label: p.label,
        services_affected: p.services_affected,
        detected_from: p.detected_from,
        confidence: p.confidence,
      }));
  },
});

// ─── Mutations: record user answers ─────────────────────────────────────────

/**
 * Record one or more package answers from the user.
 *
 * Behavior:
 *   - confirmed packages get added to confirmed_packages (deduped).
 *   - denied packages get added to denied_packages (deduped) — PERMANENT.
 *   - A code can only be in one list at a time; later answer wins.
 *   - Creates the vehicle_owner_specs row lazily if it doesn't exist.
 */
export const recordPackageAnswers = mutation({
  args: {
    vehicleOwnerId: v.id("vehicle_owners"),
    confirmed: v.optional(v.array(v.string())),
    denied: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const owner = await ctx.db.get(args.vehicleOwnerId);
    if (!owner) throw new Error("vehicle_owner not found");

    const newConfirmed = args.confirmed ?? [];
    const newDenied = args.denied ?? [];
    if (newConfirmed.length === 0 && newDenied.length === 0) return;

    const existing = await ctx.db
      .query("vehicle_owner_specs")
      .withIndex("by_vehicle_owner", (q) =>
        q.eq("vehicle_owner_id", args.vehicleOwnerId),
      )
      .first();

    const now = Date.now();

    // Merge: drop any code from the opposite bucket if it appears in the new answers.
    const mergeBuckets = (
      currentConfirmed: string[],
      currentDenied: string[],
    ): { confirmed: string[]; denied: string[] } => {
      const confirmedSet = new Set(currentConfirmed);
      const deniedSet = new Set(currentDenied);
      for (const code of newConfirmed) {
        deniedSet.delete(code);
        confirmedSet.add(code);
      }
      for (const code of newDenied) {
        confirmedSet.delete(code);
        deniedSet.add(code);
      }
      return {
        confirmed: [...confirmedSet],
        denied: [...deniedSet],
      };
    };

    if (existing) {
      const merged = mergeBuckets(
        existing.confirmed_packages ?? [],
        existing.denied_packages ?? [],
      );
      await ctx.db.patch(existing._id, {
        confirmed_packages: merged.confirmed,
        denied_packages: merged.denied,
        last_updated_at: now,
      });
    } else {
      const merged = mergeBuckets([], []);
      await ctx.db.insert("vehicle_owner_specs", {
        vehicle_owner_id: args.vehicleOwnerId,
        confirmed_packages: merged.confirmed,
        denied_packages: merged.denied,
        created_at: now,
        last_updated_at: now,
      });
    }
  },
});

/**
 * Record the actual tire setup mounted on the car.
 * Source can be "user", "scan" (e.g., shop tag scan), or "inferred_from_oem".
 */
export const recordTireSetup = mutation({
  args: {
    vehicleOwnerId: v.id("vehicle_owners"),
    front: v.optional(
      v.object({
        brand: v.optional(v.string()),
        model: v.optional(v.string()),
        size: v.optional(v.string()),
        source: v.optional(v.string()),
      }),
    ),
    rear: v.optional(
      v.object({
        brand: v.optional(v.string()),
        model: v.optional(v.string()),
        size: v.optional(v.string()),
        source: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const owner = await ctx.db.get(args.vehicleOwnerId);
    if (!owner) throw new Error("vehicle_owner not found");

    const now = Date.now();
    const stamp = (
      t:
        | { brand?: string; model?: string; size?: string; source?: string }
        | undefined,
    ) => (t ? { ...t, confirmed_at: now } : undefined);

    const existing = await ctx.db
      .query("vehicle_owner_specs")
      .withIndex("by_vehicle_owner", (q) =>
        q.eq("vehicle_owner_id", args.vehicleOwnerId),
      )
      .first();

    const newSetup = {
      front: stamp(args.front) ?? existing?.tire_setup?.front,
      rear: stamp(args.rear) ?? existing?.tire_setup?.rear,
    };

    if (existing) {
      await ctx.db.patch(existing._id, {
        tire_setup: newSetup,
        last_updated_at: now,
      });
    } else {
      await ctx.db.insert("vehicle_owner_specs", {
        vehicle_owner_id: args.vehicleOwnerId,
        tire_setup: newSetup,
        created_at: now,
        last_updated_at: now,
      });
    }
  },
});

/**
 * Record an aftermarket modification on the vehicle (append).
 */
export const recordModification = mutation({
  args: {
    vehicleOwnerId: v.id("vehicle_owners"),
    type: v.string(),
    brand: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const owner = await ctx.db.get(args.vehicleOwnerId);
    if (!owner) throw new Error("vehicle_owner not found");

    const now = Date.now();
    const newMod = {
      type: args.type,
      brand: args.brand,
      note: args.note,
      added_at: now,
    };

    const existing = await ctx.db
      .query("vehicle_owner_specs")
      .withIndex("by_vehicle_owner", (q) =>
        q.eq("vehicle_owner_id", args.vehicleOwnerId),
      )
      .first();

    if (existing) {
      const updated = [...(existing.modifications ?? []), newMod];
      await ctx.db.patch(existing._id, {
        modifications: updated,
        last_updated_at: now,
      });
    } else {
      await ctx.db.insert("vehicle_owner_specs", {
        vehicle_owner_id: args.vehicleOwnerId,
        modifications: [newMod],
        created_at: now,
        last_updated_at: now,
      });
    }
  },
});

// Used elsewhere — keeping unused-import warning quiet.
export type _OwnerSpecs = Doc<"vehicle_owner_specs">;
