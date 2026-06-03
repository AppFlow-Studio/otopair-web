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
import {
  selectPart,
  normalizeDataQuality,
  type CandidateInput,
  type TraceEntry,
} from "./partSelector";

/** Confidence floor for the selector's confidence gate. Below this a fitment
 *  can still win, but only after the gate has eliminated everyone and the
 *  booking is flagged low_confidence_parts=true. */
export const PART_CONFIDENCE_GATE_THRESHOLD = 0.7;

const MS_PER_DAY = 1000 * 60 * 60 * 24;

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
  unit_price: number;        // mean of kept set — the price quoted to the mechanic. 0 when no part_prices rows exist.
  line_total: number;        // quantity × unit_price
  // Per-part range over the post-outlier-rejection sample (kept set).
  // Drives the customer-facing band on each line in Review & Pay. Both 0
  // when no price data; collapses to a single value when only one source.
  unit_price_low: number;
  unit_price_high: number;
  line_total_low: number;
  line_total_high: number;
  has_price_data: boolean;
  price_sample_size: number;
};

export type PricedPartsForService = {
  serviceId: Id<"services">;
  serviceName: string;
  serviceSlug: string;
  /** The single winning part for this service (null when no fitments match). */
  winner: PricedFitment | null;
  /** Candidates the selector considered but did not pick. Empty when winner is
   *  null or when there was only one candidate. Surfaces in mechanic / director
   *  trace UIs; the customer-facing Review & Pay screen renders only winner. */
  losers: PricedFitment[];
  /** Where the winner came from: a prior install on this VIN, the 7-layer
   *  scorer, or no candidates at all. */
  selectionSource: "vin_sticky" | "scored" | "no_candidates";
  /** True when the confidence gate eliminated every candidate on this service
   *  and we fell back to the full pool. */
  lowConfidence: boolean;
  partsTotal: number;        // winner.line_total + secondaryWinner.line_total (or 0)
  /** Second axle's winner when the customer chose `position: "both"` (e.g.
   *  Brake Pad Replacement on all four). The primary `winner` holds front,
   *  `secondaryWinner` holds rear. Null for single-axle (or non-positional)
   *  services. */
  secondaryWinner?: PricedFitment | null;
  /** Losers from the second-axle resolver pass (mirrors `losers`). */
  secondaryLosers?: PricedFitment[];
};

// ─── Shared resolver: from (vin, config, service) → winner + losers + trace ─

type WinnerCandidate = {
  fitment: Doc<"part_fitments">;
  part: Doc<"oem_parts">;
  priceSummary: Awaited<ReturnType<typeof summarizePartPrices>>;
};

export type ResolvedServiceWinner = {
  winner: WinnerCandidate | null;
  losers: WinnerCandidate[];
  source: "vin_sticky" | "scored" | "no_candidates";
  trace?: TraceEntry[];
  eliminatedByGatePartIds?: Id<"oem_parts">[];
  lowConfidence: boolean;
};

/**
 * Core selection helper. Used at booking-create time (via
 * computePricedPartsSnapshot) and on the Review & Pay query.
 *
 * Composition (per product decision):
 *   1. If `vehicle_part_preferences` has an `is_default=true` row for
 *      (vin, service_id) AND that part_id is in this vehicle's fitment pool →
 *      VIN-sticky wins, skip scoring. "We know this car has XYZ inside it."
 *   2. Otherwise run the 7-layer scorer over the fitment pool.
 *   3. With no fitments at all → `source: "no_candidates"` (caller falls back
 *      to default_parts_estimate).
 */
export async function resolveWinningPartForService(
  ctx: { db: any },
  args: {
    vin: string;
    serviceId: Id<"services">;
    serviceSlug: string;
    vehicleConfigId: Id<"vehicle_configs">;
    confirmedPackages: Set<string>;
    /** Optional `part_fitments.position` filter. When set, only fitments
     *  whose `position` matches (case-insensitive) survive into the scorer.
     *  Use "front"/"rear" for single-axle resolution; "both" or undefined
     *  means no filter (legacy behavior — caller takes responsibility for
     *  what that picks). */
    positionFilter?: string;
  },
): Promise<ResolvedServiceWinner> {
  // The catalog has two co-existing slug forms for the same service —
  // `seed_services.ts` writes dash form ("brake-pads") while the v3
  // enrichment pipeline (v3pipeline.ts:829) writes underscore form
  // ("brake_pad_replacement") into part_fitments.service_type. Query
  // both forms so we don't return empty just because the customer's
  // booked service.slug happens to be the dash form. Safe because
  // service_type is scoped to a single vehicle_config_id, so cross-talk
  // is impossible.
  const slugDash = args.serviceSlug;
  const slugUnderscore = args.serviceSlug.replace(/-/g, "_");
  const slugAliases = slugDash === slugUnderscore ? [slugDash] : [slugDash, slugUnderscore];

  const fitmentBuckets: Doc<"part_fitments">[][] = [];
  for (const slug of slugAliases) {
    const rows = await ctx.db
      .query("part_fitments")
      .withIndex("by_config_service", (q: any) =>
        q.eq("vehicle_config_id", args.vehicleConfigId).eq("service_type", slug),
      )
      .collect();
    fitmentBuckets.push(rows);
  }
  // De-dup by fitment _id in case both slug forms point at the same row.
  const seen = new Set<string>();
  const fitments: Doc<"part_fitments">[] = [];
  for (const bucket of fitmentBuckets) {
    for (const f of bucket) {
      const key = String(f._id);
      if (seen.has(key)) continue;
      seen.add(key);
      fitments.push(f);
    }
  }

  const packageGated = fitments.filter(
    (f: Doc<"part_fitments">) =>
      f.package_code == null || args.confirmedPackages.has(f.package_code),
  );

  // Hydrate parts first — we need `oem_parts.subcategory` for position
  // matching as a fallback when `part_fitments.position` is null. The v3
  // pipeline writes subcategory reliably (e.g. "front_brake_pad" /
  // "rear_brake_pad") but `position` is only set on the OEM seed map and
  // can be missing on older fitment rows.
  const hydratedAll: WinnerCandidate[] = [];
  for (const f of packageGated) {
    const part = await ctx.db.get(f.part_id);
    if (!part) continue;
    const priceSummary = await summarizePartPrices(ctx, f.part_id);
    hydratedAll.push({ fitment: f, part, priceSummary });
  }

  // Position-aware narrowing — only after the package gate. "both" /
  // undefined → no filter. A candidate matches when EITHER its
  // fitment.position OR its part.subcategory carries the requested axle.
  const positionFilter = args.positionFilter?.toLowerCase();
  const hydrated =
    positionFilter && positionFilter !== "both"
      ? hydratedAll.filter((c) => {
          const pos = (c.fitment.position ?? "").toLowerCase();
          const sub = (c.part.subcategory ?? "").toLowerCase();
          if (pos === positionFilter) return true;
          // subcategory like "front_brake_pad" / "rear_brake_pad" / "front_rotor"
          if (sub.startsWith(`${positionFilter}_`)) return true;
          return false;
        })
      : hydratedAll;

  if (hydrated.length === 0) {
    return { winner: null, losers: [], source: "no_candidates", lowConfidence: false };
  }

  // VIN-sticky check — prefer a previously installed part on this exact VIN.
  const vinPrefs = await ctx.db
    .query("vehicle_part_preferences")
    .withIndex("by_vin_service", (q: any) =>
      q.eq("vin", args.vin).eq("service_id", args.serviceId),
    )
    .collect();
  const stickyDefault = vinPrefs.find(
    (p: Doc<"vehicle_part_preferences">) => p.is_default === true,
  );
  if (stickyDefault) {
    const sticky = hydrated.find((c) => c.part._id === stickyDefault.part_id);
    if (sticky) {
      const losers = hydrated.filter((c) => c.part._id !== sticky.part._id);
      return { winner: sticky, losers, source: "vin_sticky", lowConfidence: false };
    }
    // Sticky preference points at a part no longer in the fitment pool (e.g.
    // catalog churn). Fall through to scoring rather than picking a part we
    // can't price.
  }

  // 7-layer scorer.
  const now = Date.now();
  const inputs: CandidateInput[] = hydrated.map((c) => ({
    part_id: c.part._id,
    confidence: c.fitment.confidence ?? 0,
    mechanic_verified: c.fitment.mechanic_verified === true,
    data_quality: normalizeDataQuality(
      c.fitment.data_quality ?? c.part.data_quality ?? null,
    ),
    prices: c.priceSummary.sources_used.map((s) => ({
      price: s.price,
      refreshed_days_ago:
        s.refreshed_at != null
          ? Math.max(0, Math.floor((now - s.refreshed_at) / MS_PER_DAY))
          : 9999,
    })),
  }));

  const result = selectPart(inputs, {
    gateEnabled: true,
    gateThreshold: PART_CONFIDENCE_GATE_THRESHOLD,
  });
  if (!result.winner) {
    return { winner: null, losers: [], source: "no_candidates", lowConfidence: false };
  }
  const winner = hydrated.find((c) => c.part._id === result.winner!.part_id)!;
  const losers = hydrated.filter((c) => c.part._id !== winner.part._id);
  return {
    winner,
    losers,
    source: "scored",
    trace: result.trace,
    eliminatedByGatePartIds: result.eliminatedByGate.map((e) => e.part_id),
    lowConfidence: result.low_confidence,
  };
}

function toPricedFitment(c: WinnerCandidate): PricedFitment {
  const quantity = c.fitment.quantity_needed ?? 1;
  const unit_price = c.priceSummary.average;
  const line_total = Math.round(quantity * unit_price * 100) / 100;
  const unit_price_low = c.priceSummary.min_kept;
  const unit_price_high = c.priceSummary.max_kept;
  const line_total_low = Math.round(quantity * unit_price_low * 100) / 100;
  const line_total_high = Math.round(quantity * unit_price_high * 100) / 100;
  return {
    part_id: c.part._id,
    name: c.part.name,
    oem_part_number: c.part.oem_part_number,
    category: c.part.category,
    position: c.fitment.position,
    quantity,
    unit_price,
    line_total,
    unit_price_low,
    unit_price_high,
    line_total_low,
    line_total_high,
    has_price_data: c.priceSummary.sample_size > 0,
    price_sample_size: c.priceSummary.sample_size,
  };
}

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
    /** Per-service axle/position choice. Maps `serviceId → "front" | "rear" |
     *  "both"`. Driven by the SERVICE_VARIANTS registry in
     *  constants/serviceVariants.ts. Services not present here behave as
     *  before (no position filter). For "both", the resolver runs twice
     *  (front + rear) and both winners surface on the returned row. */
    serviceVariants: v.optional(
      v.array(
        v.object({
          serviceId: v.id("services"),
          position: v.string(),
        }),
      ),
    ),
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

    const positionByServiceId = new Map<string, string>();
    for (const v of args.serviceVariants ?? []) {
      positionByServiceId.set(String(v.serviceId), v.position.toLowerCase());
    }

    const out: PricedPartsForService[] = [];

    for (const serviceId of args.serviceIds) {
      const service = await ctx.db.get(serviceId);
      if (!service?.slug) continue;

      const position = positionByServiceId.get(String(serviceId));

      // "both" → two passes (front + rear) so the breakdown carries two
      // priced lines. Single-pass for "front"/"rear"/undefined.
      if (position === "both") {
        const frontRes = await resolveWinningPartForService(ctx, {
          vin: owner.vin,
          serviceId,
          serviceSlug: service.slug,
          vehicleConfigId: configId,
          confirmedPackages: confirmed,
          positionFilter: "front",
        });
        const rearRes = await resolveWinningPartForService(ctx, {
          vin: owner.vin,
          serviceId,
          serviceSlug: service.slug,
          vehicleConfigId: configId,
          confirmedPackages: confirmed,
          positionFilter: "rear",
        });

        const frontWinner = frontRes.winner ? toPricedFitment(frontRes.winner) : null;
        const rearWinner = rearRes.winner ? toPricedFitment(rearRes.winner) : null;

        out.push({
          serviceId,
          serviceName: service.name,
          serviceSlug: service.slug,
          winner: frontWinner,
          losers: frontRes.losers.map(toPricedFitment),
          selectionSource:
            frontRes.source !== "no_candidates" ? frontRes.source : rearRes.source,
          lowConfidence: frontRes.lowConfidence || rearRes.lowConfidence,
          partsTotal:
            (frontWinner?.line_total ?? 0) + (rearWinner?.line_total ?? 0),
          secondaryWinner: rearWinner,
          secondaryLosers: rearRes.losers.map(toPricedFitment),
        });
        continue;
      }

      const resolution = await resolveWinningPartForService(ctx, {
        vin: owner.vin,
        serviceId,
        serviceSlug: service.slug,
        vehicleConfigId: configId,
        confirmedPackages: confirmed,
        positionFilter: position,
      });

      const winner = resolution.winner ? toPricedFitment(resolution.winner) : null;
      const losers = resolution.losers.map(toPricedFitment);

      out.push({
        serviceId,
        serviceName: service.name,
        serviceSlug: service.slug,
        winner,
        losers,
        selectionSource: resolution.source,
        lowConfidence: resolution.lowConfidence,
        partsTotal: winner?.line_total ?? 0,
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
