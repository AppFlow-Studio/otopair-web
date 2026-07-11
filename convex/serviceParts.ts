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
import { summarizePartPrices, quoteUnitPrice } from "./part_prices";
import {
  selectPart,
  partFitsConfigMake,
  passesI1ReadGuard,
  normalizeDataQuality,
  type CandidateInput,
  type TraceEntry,
} from "./partSelector";
import {
  getServicePartsSpec,
  normalizeServiceSlug,
  roleForSubcategory,
  type PartRoleSpec,
  type ServiceRole,
} from "./lib/servicePartsReference";
import {
  effectiveServiceRole,
  resolveRoleQuantity,
  roleApplies,
  type VehicleSpecBundle,
} from "./lib/partRoleQuantity";
import {
  axleForBrakeService,
  axlePositionByServiceId,
  fitmentMatchesPosition,
  isBrakeSlug,
  resolveBrakeScopeForBooking,
  type BrakeScope,
} from "./lib/brakeScope";

/** Confidence floor for the selector's confidence gate. Below this a fitment
 *  can still win, but only after the gate has eliminated everyone and the
 *  booking is flagged low_confidence_parts=true. */
export const PART_CONFIDENCE_GATE_THRESHOLD = 0.7;

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Per-service parts rule. Replaces the legacy `BILLABLE_SUBCATEGORIES_BY_SERVICE`
 * constant — director-editable via the Service Parts admin tab, seeded from the
 * May 2026 PDF in seeds/seedServicePartsRules.ts.
 *
 *   - `allowed` is the union of core + as-needed subcategories. Null means
 *     "no rule row for this service" → preserve legacy "no filter" behavior.
 *   - `pinnedPartIdsBySubcategory` maps subcategory → pinned oem_parts._id.
 *     When the resolver finds a candidate whose subcategory has a pinned
 *     entry, it short-circuits the 7-layer selector and picks the pin.
 *   - `qtyOverride` (when set) wins over serviceUnits.resolveServiceUnitCount.
 */
type ServicePartsRuleSnapshot = {
  allowed: Set<string> | null;
  pinnedPartIdsBySubcategory: Map<string, Id<"oem_parts">>;
  qtyOverride: number | null;
};

async function loadServicePartsRule(
  ctx: { db: any },
  serviceId: Id<"services">,
): Promise<ServicePartsRuleSnapshot> {
  const rule = await ctx.db
    .query("service_parts_rules")
    .withIndex("by_service", (q: any) => q.eq("service_id", serviceId))
    .first();
  if (!rule) {
    return {
      allowed: null,
      pinnedPartIdsBySubcategory: new Map(),
      qtyOverride: null,
    };
  }
  const allowed = new Set<string>([
    ...rule.core_subcategories,
    ...rule.as_needed_subcategories,
  ]);
  const pinnedPartIdsBySubcategory = new Map<string, Id<"oem_parts">>();
  for (const p of rule.pinned_parts as Array<{
    subcategory: string;
    part_id: Id<"oem_parts">;
  }>) {
    pinnedPartIdsBySubcategory.set(p.subcategory, p.part_id);
  }
  return {
    allowed,
    pinnedPartIdsBySubcategory,
    qtyOverride: rule.qty_override ?? null,
  };
}

function isBillableSubcategoryViaRule(
  rule: ServicePartsRuleSnapshot,
  subcategory: string | undefined | null,
): boolean {
  if (rule.allowed == null) return true; // no rule row → legacy behavior
  return subcategory != null && rule.allowed.has(subcategory);
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PackageQuestion {
  code: string;
  label: string;
  services_affected: string[];
  detected_from: string;
  confidence?: number;
}

export interface ResolvedFitment {
  /** Optional: snapshot-sourced rows (pre/post-job, quote-anchored) have no
   *  originating fitment row — only the resolver path sets this. No consumer
   *  reads it; it's a provenance breadcrumb. */
  fitment_id?: Id<"part_fitments">;
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

    // Load the director-editable rule once for this service so the per-fitment
    // loop below can apply the subcategory allowlist without re-querying.
    const serviceForRule = await ctx.db
      .query("services")
      .withIndex("by_slug", (q) => q.eq("slug", args.serviceSlug))
      .first();
    const rule = serviceForRule
      ? await loadServicePartsRule(ctx, serviceForRule._id)
      : { allowed: null, pinnedPartIdsBySubcategory: new Map(), qtyOverride: null };

    // 3. Hydrate the part info for each fitment. Drop subcategories that
    //    aren't billable for this service per service_parts_rules.
    const makeDocForGuard = config.make_id ? await ctx.db.get(config.make_id) : null;
    const resolved: ResolvedFitment[] = [];
    for (const f of applicable) {
      const part = await ctx.db.get(f.part_id);
      if (!part) continue;
      // I1 make guard + brand-signature backstop: never quote a part whose
      // make disagrees with this config's make or whose number format betrays
      // a foreign brand — unless a mechanic physically verified the fitment,
      // which overrides both heuristics (see passesI1ReadGuard).
      if (
        !passesI1ReadGuard({
          partMakeId: part.make_id,
          configMakeId: config.make_id,
          oemPartNumber: part.oem_part_number,
          configMakeName: makeDocForGuard?.name,
          mechanicVerified: f.mechanic_verified === true,
        })
      )
        continue;
      if (!isBillableSubcategoryViaRule(rule, part.subcategory)) continue;
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

    // ── Quote-anchored source of truth ────────────────────────────────────
    // Pre-job (and post-job) must list exactly what the system QUOTED — the
    // frozen `priced_parts_snapshot` (one row per locked role winner) — not
    // every catalog candidate the resolver considered. Without this the dialog
    // listed all six oil filters on file for the chassis instead of the one
    // oil filter on the quote. The snapshot is the same data the customer saw
    // on Review & Pay and the mechanic sees in the job scope, so all three
    // surfaces agree. Grouped by service, in the booking's service order.
    const snapshot = ((booking as any).priced_parts_snapshot ?? []) as Array<{
      service_id: Id<"services">;
      part_id?: Id<"oem_parts">;
      oem_number: string;
      part_name: string;
      quantity: number;
      role_key?: string;
      integrity_flag?: string;
    }>;
    if (snapshot.length > 0) {
      // Integrity guard for frozen rows. Snapshots created before the Jul 2026
      // hardening can carry cross-make contaminated parts; the sweep
      // (snapshotRevalidation) stamps those `integrity_flag`, and un-swept rows
      // get the same live check here so a contaminant never reaches the pre/
      // post-job dialog. Fail-open when the config make can't be resolved —
      // we can't prove a mismatch, same posture as partFitsConfigMake.
      const vehicleForGuard = await ctx.db
        .query("vehicles")
        .withIndex("by_vin", (q) => q.eq("vin", booking.vin))
        .first();
      const configForGuard = vehicleForGuard?.vehicle_config_id
        ? await ctx.db.get(vehicleForGuard.vehicle_config_id)
        : null;
      const guardMakeId = configForGuard?.make_id ?? null;
      const guardMakeDoc = guardMakeId ? await ctx.db.get(guardMakeId) : null;

      const rowPassesGuard = async (row: (typeof snapshot)[number]) => {
        if (row.integrity_flag != null) return false; // sweep already judged it
        const part = row.part_id ? await ctx.db.get(row.part_id) : null;
        // First pass without the fitment lookup — clean rows (the vast
        // majority) never touch part_fitments.
        if (
          passesI1ReadGuard({
            partMakeId: part?.make_id ?? null,
            configMakeId: guardMakeId,
            oemPartNumber: row.oem_number,
            configMakeName: guardMakeDoc?.name,
          })
        )
          return true;
        // Failing row: a mechanic-verified fitment on this config exempts it.
        if (!row.part_id || !configForGuard) return false;
        const fits = await ctx.db
          .query("part_fitments")
          .withIndex("by_part", (q) => q.eq("part_id", row.part_id!))
          .collect();
        return fits.some(
          (f) =>
            f.vehicle_config_id === configForGuard._id &&
            f.mechanic_verified === true,
        );
      };

      const bySvc = new Map<string, OemPartsForService>();
      for (const row of snapshot) {
        if (!(await rowPassesGuard(row))) continue;
        const key = String(row.service_id);
        let entry = bySvc.get(key);
        if (!entry) {
          const service = await ctx.db.get(row.service_id);
          if (!service?.slug) continue;
          entry = {
            serviceId: row.service_id,
            serviceName: service.name,
            serviceSlug: service.slug,
            parts: [],
          };
          bySvc.set(key, entry);
        }
        // Position is implicit in the snapshot (it already froze the booked
        // axle); surface it from the role_key for the brakes display only.
        const rk = row.role_key ?? "";
        const position = /^front_/.test(rk)
          ? "front"
          : /^rear_/.test(rk)
            ? "rear"
            : undefined;
        entry.parts.push({
          part_id: row.part_id as Id<"oem_parts">,
          oem_part_number: row.oem_number,
          name: row.part_name,
          position,
          quantity_needed: row.quantity,
        });
      }
      const out: OemPartsForService[] = [];
      for (const sid of booking.service_ids ?? []) {
        const entry = bySvc.get(String(sid));
        if (entry) out.push(entry);
      }
      // Defensive: emit any snapshot service not on service_ids (shouldn't
      // happen, but never silently drop a quoted line).
      for (const entry of bySvc.values()) {
        if (!out.includes(entry)) out.push(entry);
      }
      return out;
    }

    // ── Legacy fallback (no priced snapshot) ──────────────────────────────
    // Older bookings created before quote snapshotting carry no quoted parts;
    // there's nothing to anchor to, so fall back to the informational catalog
    // resolve (every billable fitment for the booked axle).
    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", booking.vin))
      .first();
    if (!vehicle?.vehicle_config_id) return [];

    const configId = vehicle.vehicle_config_id;
    // I1 make guard needs this config's make to reject cross-make contaminants.
    const legacyConfig = await ctx.db.get(configId);
    const configMakeId = legacyConfig?.make_id ?? null;
    const makeDocForGuard = configMakeId ? await ctx.db.get(configMakeId) : null;
    const out: OemPartsForService[] = [];

    // Customer's axle choice per service (brake pads front/rear/both). Drives
    // the position filter below so the card shows only what was booked — a
    // "Rear pads only" job must not list front pads.
    const axleByServiceId = axlePositionByServiceId(booking);

    for (const serviceId of booking.service_ids ?? []) {
      const service = await ctx.db.get(serviceId);
      if (!service?.slug) continue;

      const position = isBrakeSlug(service.slug)
        ? axleForBrakeService(
            booking,
            String(serviceId),
            service.slug,
            axleByServiceId,
          )
        : undefined;

      const fitments = await ctx.db
        .query("part_fitments")
        .withIndex("by_config_service", (q) =>
          q.eq("vehicle_config_id", configId).eq("service_type", service.slug),
        )
        .collect();

      // Drop package-conditional fitments — pre-job is informational; we don't
      // gate on owner package answers here, just show the universal base parts.
      const base = fitments.filter((f) => f.package_code == null);

      const rule = await loadServicePartsRule(ctx, serviceId);

      const resolved: ResolvedFitment[] = [];
      for (const f of base) {
        const part = await ctx.db.get(f.part_id);
        if (!part) continue;
        // I1 make guard + brand-signature backstop; mechanic verification
        // overrides both (see passesI1ReadGuard).
        if (
          !passesI1ReadGuard({
            partMakeId: part.make_id,
            configMakeId,
            oemPartNumber: part.oem_part_number,
            configMakeName: makeDocForGuard?.name,
            mechanicVerified: f.mechanic_verified === true,
          })
        )
          continue;
        if (!isBillableSubcategoryViaRule(rule, part.subcategory)) continue;
        // Scope to the booked axle. Position-neutral parts (hardware kits,
        // grease) survive a single-axle filter; "both"/unspecified keeps all.
        if (!fitmentMatchesPosition(f.position, part.subcategory, position)) {
          continue;
        }
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

/**
 * The brake axle(s) a booking actually covers — drives the pre-job brakes
 * section so a "Rear pads only" job hides the front-pad field (and vice
 * versa). Union across every brake/rotor service on the booking. When a brake
 * service carries no explicit axle option (legacy booking), we fall back to
 * "both" so nothing is hidden by mistake. Returns hasBrakeWork:false for
 * non-brake bookings — the dialog then keeps both pad fields visible as
 * optional passport capture.
 */
export const getBrakeScopeForBooking = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args): Promise<BrakeScope> => {
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) return { hasBrakeWork: false, front: false, rear: false };
    return await resolveBrakeScopeForBooking(ctx, booking);
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
  /** Service Parts Reference role fields (2026-06). Which part role this line
   *  fills (role_key === oem_parts.subcategory), how it participates in the
   *  quote (core locks, as_needed ranges, kit bundles), and how the billed
   *  quantity was derived (capacity math for fluids). */
  service_role?: ServiceRole;
  role_key?: string;
  quantity_basis?: string;
  /** True when this line goes into the locked quote (core, or kit with
   *  includeByDefault) — mirrors the snapshot's `includeInLockedQuote`. The
   *  customer's Review & Pay renders EVERY locked line (not just the primary
   *  winner) so its parts match the mechanic's frozen `priced_parts_snapshot`.
   *  Undefined on loser candidates (no role winner). */
  locked?: boolean;
  /** True when this is a synthesized universal consumable line. */
  virtual?: boolean;
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
  /** Σ line_total over the LOCKED lines in `parts` (core + default kits).
   *  Pre-reference this was just the winner's line. */
  partsTotal: number;
  /** Σ line_total over as_needed lines — the discovery adder that turns the
   *  quote into a range (high side = partsTotal + asNeededTotal). */
  asNeededTotal: number;
  /** ALL resolved part lines for the service, one per role (engine oil +
   *  filter + washer…), in reference order. `winner` above is parts[primary]
   *  for back-compat. For "both" axle bookings this contains front + rear
   *  lines with shared roles (grease) billed once. */
  parts: PricedFitment[];
  /** Second axle's winner when the customer chose `position: "both"` (e.g.
   *  Brake Pad Replacement on all four). The primary `winner` holds front,
   *  `secondaryWinner` holds rear. Null for single-axle (or non-positional)
   *  services. */
  secondaryWinner?: PricedFitment | null;
  /** Losers from the second-axle resolver pass (mirrors `losers`). */
  secondaryLosers?: PricedFitment[];
};

// ─── Shared resolver: from (vin, config, service) → role winners + trace ────

type WinnerCandidate = {
  /** Real fitment row, or a synthetic stub for universal-consumable
   *  fallbacks (virtual: true on the RoleWinner). */
  fitment: Doc<"part_fitments">;
  part: Doc<"oem_parts">;
  priceSummary: Awaited<ReturnType<typeof summarizePartPrices>>;
};

/** One resolved part ROLE within a service (oil, filter, washer, grease…).
 *  The 7-layer scorer runs *within* each role group — it picks among
 *  candidate SKUs for the same role, never across roles. */
export type RoleWinner = {
  /** === oem_parts.subcategory (or category fallback for legacy rows). */
  roleKey: string;
  /** core | as_needed | kit — after vehicle-conditional promotion. */
  serviceRole: ServiceRole;
  candidate: WinnerCandidate;
  losers: WinnerCandidate[];
  source: "vin_sticky" | "scored" | "universal_fallback";
  trace?: TraceEntry[];
  eliminatedByGatePartIds?: Id<"oem_parts">[];
  lowConfidence: boolean;
  /** Billed quantity + audit string (capacity math for fluids,
   *  per-cylinder for plugs). See lib/partRoleQuantity.ts. */
  quantity: number;
  quantityBasis: string;
  /** core, or kit with includeByDefault — goes into the locked snapshot.
   *  as_needed stays out of the contract (discovery range only). */
  includeInLockedQuote: boolean;
  /** True when this line is a synthesized universal consumable (no enriched
   *  fitment existed for a core role with a universalFallback). */
  virtual?: boolean;
};

export type ResolvedServiceWinner = {
  /** Back-compat: the PRIMARY role's winner (pads for a brake job, oil for
   *  an oil change). Full multi-part output lives in `roleWinners`. */
  winner: WinnerCandidate | null;
  /** Back-compat: the primary role's losing candidates. */
  losers: WinnerCandidate[];
  source: "vin_sticky" | "scored" | "no_candidates";
  trace?: TraceEntry[];
  eliminatedByGatePartIds?: Id<"oem_parts">[];
  lowConfidence: boolean;
  /** One winner per part role, in reference order (primary/core first). */
  roleWinners: RoleWinner[];
};

// Fresh object per call — callers receive mutable arrays.
function emptyResolution(): ResolvedServiceWinner {
  return {
    winner: null,
    losers: [],
    source: "no_candidates",
    lowConfidence: false,
    roleWinners: [],
  };
}

/** Fetch the spec rows quantity/condition resolution needs — once per
 *  resolver call, only when the service's reference roles require any. */
async function fetchSpecBundle(
  ctx: { db: any },
  vehicleConfigId: Id<"vehicle_configs">,
): Promise<VehicleSpecBundle> {
  const config = await ctx.db.get(vehicleConfigId);
  if (!config) return {};
  const [engine, transmission, chassis, drivetrain] = await Promise.all([
    config.engine_id ? ctx.db.get(config.engine_id) : Promise.resolve(null),
    config.transmission_id ? ctx.db.get(config.transmission_id) : Promise.resolve(null),
    config.chassis_code
      ? ctx.db
          .query("chassis_specs")
          .withIndex("by_chassis_code", (q: any) => q.eq("chassis_code", config.chassis_code))
          .first()
      : Promise.resolve(null),
    ctx.db
      .query("drivetrain_configs")
      .withIndex("by_vehicle_config", (q: any) => q.eq("vehicle_config_id", vehicleConfigId))
      .first(),
  ]);
  return { config, engine, transmission, chassis, drivetrain };
}

/** Query part_fitments for a service_type under both slug forms (dash from
 *  seed_services, underscore from the v3 pipeline), de-duped by _id. */
async function fitmentsForServiceType(
  ctx: { db: any },
  vehicleConfigId: Id<"vehicle_configs">,
  serviceSlug: string,
): Promise<Doc<"part_fitments">[]> {
  const slugDash = serviceSlug.replace(/_/g, "-");
  const slugUnderscore = serviceSlug.replace(/-/g, "_");
  const slugAliases =
    slugDash === slugUnderscore ? [slugUnderscore] : [slugUnderscore, slugDash];

  const seen = new Set<string>();
  const fitments: Doc<"part_fitments">[] = [];
  for (const slug of slugAliases) {
    const rows = await ctx.db
      .query("part_fitments")
      .withIndex("by_config_service", (q: any) =>
        q.eq("vehicle_config_id", vehicleConfigId).eq("service_type", slug),
      )
      .collect();
    for (const f of rows) {
      const key = String(f._id);
      if (seen.has(key)) continue;
      seen.add(key);
      fitments.push(f);
    }
  }
  return fitments;
}

/** Plausibility cap for consumable roles: a candidate whose quote unit price
 *  exceeds this multiple of the role's reference anchor (universalFallback
 *  defaultPriceUsd) is treated as a captured MSRP/multi-pack/garbage figure
 *  (e.g. the Jun-10 $49 crush washer vs its $4 anchor — 12×). 6× is generous
 *  for genuine OEM-premium consumables while catching order-of-magnitude
 *  grabs that MAD outlier rejection can't see at n<4 sources. */
const PLAUSIBLE_ANCHOR_MULT = 6;

/**
 * Synthesize a role's universal-consumable candidate: the seeded oem_parts
 * row (category "consumable", subcategory === roleKey) with a PRICED summary,
 * or null when the seed is missing/unpriced. Used in two places:
 *   1. CORE roles with NO enriched fitment (the original fallback), and
 *   2. the all-unpriced SWAP (Jun-10 live finding, 750i gear oil): a junk
 *      fitment with zero trustworthy price rows used to BLOCK the fallback —
 *      synthesis only fired when no fitment group existed — so the role
 *      billed $0 while a priced seed sat unused.
 */
async function synthesizeUniversalCandidate(
  ctx: { db: any },
  role: PartRoleSpec,
  slug: string,
  vehicleConfigId: Id<"vehicle_configs">,
  serviceRole: ServiceRole,
): Promise<WinnerCandidate | null> {
  if (!role.universalFallback) return null;
  const universalPart = await ctx.db
    .query("oem_parts")
    .withIndex("by_subcategory", (q: any) => q.eq("subcategory", role.roleKey))
    .filter((q: any) => q.eq(q.field("category"), "consumable"))
    .first();
  if (!universalPart) return null; // seed not run yet — skip silently
  const priceSummary = await summarizePartPrices(ctx, universalPart._id);
  if (priceSummary.sample_size === 0) return null; // unpriced seed — skip
  const stubFitment = {
    _id: `virtual:${slug}:${role.roleKey}`,
    part_id: universalPart._id,
    vehicle_config_id: vehicleConfigId,
    service_type: slug,
    quantity_needed: undefined,
    position: undefined,
    package_code: undefined,
    service_role: serviceRole,
    confidence: 1, // deliberate fallback, not a low-confidence guess
    mechanic_verified: false,
  } as unknown as Doc<"part_fitments">;
  return { fitment: stubFitment, part: universalPart, priceSummary };
}

/**
 * Core selection helper. Used at booking-create time (via
 * computePricedPartsSnapshot) and on the Review & Pay query.
 *
 * Selection runs PER PART ROLE (oil + filter + washer…), per the Service
 * Parts Reference (lib/servicePartsReference.ts):
 *   1. Labor-only services return no parts, unconditionally.
 *   2. Fitments are pulled for this service AND any borrowed services the
 *      reference declares (rotor jobs borrow pads from brake_pad_replacement).
 *   3. Candidates are grouped by role (part.subcategory); within each group:
 *      VIN-sticky preference first, otherwise the 7-layer scorer.
 *   4. Reference CORE roles with no enriched fitment but a universalFallback
 *      get a synthesized consumable line (grease, washers, DOT4) so core
 *      coverage never silently drops.
 *   5. Quantities resolve per role: fluids = ceil(capacity / packageSize)
 *      from the vehicle's spec rows, plugs = per cylinder, else fitment/fixed.
 *   6. `winner`/`losers` stay back-compat (= the PRIMARY role's outcome);
 *      the full multi-part output is `roleWinners`.
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
     *  what that picks). Positionless roles (caliper grease) bypass it. */
    positionFilter?: string;
    /** Set on the SECOND pass of a "both" (front+rear) resolution so shared,
     *  positionless roles (grease) and universal fallbacks aren't billed
     *  twice. */
    suppressSharedRoles?: boolean;
  },
): Promise<ResolvedServiceWinner> {
  const slug = normalizeServiceSlug(args.serviceSlug);
  const spec = getServicePartsSpec(slug);

  // Labor-only services NEVER bill parts (Service Parts Reference). Also
  // covers services whose parts run through a dedicated flow (tires).
  if (spec && (spec.laborOnly || spec.handledByDedicatedFlow)) {
    return emptyResolution();
  }

  // ── Collect fitments: own service + reference-borrowed services ──────────
  const fitments = await fitmentsForServiceType(ctx, args.vehicleConfigId, slug);
  const ownFitmentIds = new Set(fitments.map((f) => String(f._id)));

  const borrowedServices = new Set<string>();
  for (const r of spec?.roles ?? []) {
    if (r.fitmentService) borrowedServices.add(normalizeServiceSlug(r.fitmentService));
  }
  for (const borrowed of borrowedServices) {
    if (borrowed === slug) continue;
    const rows = await fitmentsForServiceType(ctx, args.vehicleConfigId, borrowed);
    for (const f of rows) {
      if (!ownFitmentIds.has(String(f._id))) fitments.push(f);
    }
  }

  const packageGated = fitments.filter(
    (f: Doc<"part_fitments">) =>
      f.package_code == null || args.confirmedPackages.has(f.package_code),
  );

  // Director-editable rule: subcategory allowlist + pinned parts. Loaded
  // once per resolver call; null `allowed` preserves the legacy "no filter"
  // behavior for any service without a rule row.
  const rule = await loadServicePartsRule(ctx, args.serviceId);

  // Hydrate parts first — we need `oem_parts.subcategory` both for role
  // grouping (Service Parts Reference) and for position matching as a
  // fallback when `part_fitments.position` is null. The v3 pipeline writes
  // subcategory reliably (e.g. "front_brake_pad" / "rear_brake_pad") but
  // `position` is only set on the OEM seed map and can be missing on older
  // fitment rows.
  //
  // Billing-subcategory gate: drop fitments whose subcategory isn't on the
  // service's billable allowlist per service_parts_rules. Pipeline still
  // stores these for the vehicle profile; we just don't price them.
  // I1 make guard — load this config's make so the hydration loop can reject
  // cross-make contaminants (e.g. a Ford brake pad cloned onto this Alfa config
  // by the chassis/engine sibling-clone path). Filtering here also protects the
  // director-pin and VIN-sticky overrides below: both select only from the
  // already-hydrated candidate pool, so a dropped wrong-make part can never win
  // outright through those paths either.
  const configForMake = await ctx.db.get(args.vehicleConfigId);
  const configMakeId =
    (configForMake as Doc<"vehicle_configs"> | null)?.make_id ?? null;
  const makeDocForGuard = configMakeId ? await ctx.db.get(configMakeId) : null;

  const hydratedAll: WinnerCandidate[] = [];
  for (const f of packageGated) {
    const part = await ctx.db.get(f.part_id);
    if (!part) continue;
    // I1 make guard + brand-signature backstop (write-time provenance bugs
    // pass the id guard but carry a foreign brand's number format, e.g.
    // Motorcraft BXT-… on an Alfa Romeo). A mechanic-verified fitment
    // overrides both — quarantine spares those rows for the same reason.
    if (
      !passesI1ReadGuard({
        partMakeId: part.make_id,
        configMakeId,
        oemPartNumber: part.oem_part_number,
        configMakeName: makeDocForGuard?.name,
        mechanicVerified: f.mechanic_verified === true,
      })
    )
      continue;
    if (!isBillableSubcategoryViaRule(rule, part.subcategory)) continue;
    const priceSummary = await summarizePartPrices(ctx, f.part_id);
    hydratedAll.push({ fitment: f, part, priceSummary });
  }

  // Spec bundle for fluid capacities / cylinder counts / condition flags —
  // fetched once, only when the reference needs it for this service.
  const needsBundle = (spec?.roles ?? []).some(
    (r) => r.quantity.kind !== "fixed" || r.condition != null,
  );
  const bundle: VehicleSpecBundle = needsBundle
    ? await fetchSpecBundle(ctx, args.vehicleConfigId)
    : {};

  // ── Role grouping ─────────────────────────────────────────────────────────
  // Each candidate maps to a reference role via its part's subcategory (with
  // a category fallback for legacy rows). Own-service candidates that match
  // no declared role still form ad-hoc groups (pre-reference behavior, and
  // services without a spec); BORROWED candidates that match no declared
  // role are dropped — we only borrowed them for specific roles.
  type Group = {
    roleKey: string;
    role: PartRoleSpec | null;
    candidates: WinnerCandidate[];
  };
  const groups = new Map<string, Group>();
  for (const c of hydratedAll) {
    const role = roleForSubcategory(slug, c.part.subcategory, c.part.category);
    const isBorrowed = !ownFitmentIds.has(String(c.fitment._id));
    if (!role && isBorrowed) continue;
    const roleKey =
      role?.roleKey ??
      (c.part.subcategory ?? c.part.category ?? "unknown").toLowerCase();
    const g = groups.get(roleKey) ?? { roleKey, role, candidates: [] };
    g.candidates.push(c);
    groups.set(roleKey, g);
  }

  // ── Position narrowing (per group) ────────────────────────────────────────
  // "both"/undefined → no filter. Positionless roles (grease) bypass the
  // filter, but are dropped entirely on the suppressed (rear) pass of a
  // "both" resolution so they bill once.
  //
  // Axle default: for services whose reference declares BOTH front_* and
  // rear_* primary roles (brake pads, rotors), an omitted position would now
  // bill BOTH axles — a silent price double the legacy single-winner
  // behavior never produced. Callers that want both axles must say "both"
  // (which runs two passes); an omitted position defaults to front.
  let positionFilter = args.positionFilter?.toLowerCase();
  if (!positionFilter && spec) {
    const primaryAxles = new Set(
      spec.roles
        .filter((r) => r.primary)
        .map((r) => /^(front|rear)_/.exec(r.roleKey)?.[1])
        .filter(Boolean),
    );
    if (primaryAxles.size > 1) positionFilter = "front";
  }
  const filteredGroups: Group[] = [];
  for (const g of groups.values()) {
    if (g.role?.positionless) {
      if (!args.suppressSharedRoles) filteredGroups.push(g);
      continue;
    }
    if (!positionFilter || positionFilter === "both") {
      filteredGroups.push(g);
      continue;
    }
    const kept = g.candidates.filter((c) => {
      const pos = (c.fitment.position ?? "").toLowerCase();
      const sub = (c.part.subcategory ?? "").toLowerCase();
      if (pos === positionFilter) return true;
      // subcategory like "front_brake_pad" / "rear_brake_pad" / "front_rotor"
      if (sub.startsWith(`${positionFilter}_`)) return true;
      // Position-neutral parts (oil filter, battery) carry neither marker —
      // they survive a position pass untouched.
      return pos === "" && !/^(front|rear)_/.test(sub);
    });
    if (kept.length > 0) filteredGroups.push({ ...g, candidates: kept });
  }

  // ── Universal-consumable fallbacks for missing CORE roles ─────────────────
  // Only on the unsuppressed pass, only for roles the vehicle qualifies for,
  // and only when the reference defines a fallback. Synthesized candidates
  // carry a stub fitment and skip the scorer (source: universal_fallback).
  const virtualRoleKeys = new Set<string>();
  if (spec && !args.suppressSharedRoles) {
    for (const role of spec.roles) {
      if (!role.universalFallback) continue;
      if (filteredGroups.some((g) => g.roleKey === role.roleKey)) continue;
      if (!roleApplies(role, bundle)) continue;
      if (effectiveServiceRole(role, bundle) !== "core") continue;
      if (
        positionFilter &&
        positionFilter !== "both" &&
        !role.positionless &&
        /^(front|rear)_/.test(role.roleKey) &&
        !role.roleKey.startsWith(`${positionFilter}_`)
      ) {
        continue;
      }
      const candidate = await synthesizeUniversalCandidate(
        ctx,
        role,
        slug,
        args.vehicleConfigId,
        effectiveServiceRole(role, bundle),
      );
      if (!candidate) continue; // seed not run / unpriced — skip silently
      filteredGroups.push({
        roleKey: role.roleKey,
        role,
        candidates: [candidate],
      });
      virtualRoleKeys.add(role.roleKey);
    }
  }

  if (filteredGroups.length === 0) {
    return emptyResolution();
  }

  // ── VIN-sticky preference (prior install on this exact VIN) ──────────────
  const vinPrefs = await ctx.db
    .query("vehicle_part_preferences")
    .withIndex("by_vin_service", (q: any) =>
      q.eq("vin", args.vin).eq("service_id", args.serviceId),
    )
    .collect();
  const stickyDefault = vinPrefs.find(
    (p: Doc<"vehicle_part_preferences">) => p.is_default === true,
  );

  // ── Score each role group ─────────────────────────────────────────────────
  const now = Date.now();
  const roleWinners: RoleWinner[] = [];
  for (const g of filteredGroups) {
    // Skip role groups the vehicle positively doesn't qualify for
    // (serviceable_filter === false). Fail-open on missing data.
    if (g.role && !roleApplies(g.role, bundle)) continue;

    const effRole: ServiceRole = g.role ? effectiveServiceRole(g.role, bundle) : "core";
    const { quantity, quantityBasis } = (() => {
      // Use the winner's fitment quantity after selection; compute from the
      // group's first candidate now and recompute below if a different
      // candidate wins (quantities within a role group are homogeneous in
      // practice — same part type).
      return (({ quantity, basis }) => ({ quantity, quantityBasis: basis }))(
        resolveRoleQuantity(g.role, bundle, g.candidates[0]?.fitment.quantity_needed),
      );
    })();
    const includeInLockedQuote =
      effRole === "core" || (effRole === "kit" && g.role?.includeByDefault === true);

    // Unusable-group swap (Jun-10): when EVERY enriched candidate in a
    // declared CORE role group is unusable for billing — either UNPRICED
    // (empty summary → bills $0/price_unknown; the 750i's junk gear-oil
    // fitment blocked a perfectly good $22 seed) or IMPLAUSIBLE (price
    // > PLAUSIBLE_ANCHOR_MULT × the reference's defaultPriceUsd anchor; the
    // Jetta's crush washer billed $49 against a $4 anchor — a captured
    // MSRP/multi-pack/garbage figure that survives MAD at n<4) — swap to the
    // priced universal seed. Anchors exist only on consumable roles (the
    // roles that declare universalFallback), so real parts (pads, rotors,
    // batteries) are never price-capped by this. Suppressed (rear) passes
    // skip positionless roles, mirroring the virtual block, so shared
    // consumables still bill once.
    const anchorUsd = g.role?.universalFallback?.defaultPriceUsd;
    const unusableForBilling = (c: WinnerCandidate) =>
      c.priceSummary.sample_size === 0 ||
      (anchorUsd != null &&
        anchorUsd > 0 &&
        quoteUnitPrice(c.priceSummary) > anchorUsd * PLAUSIBLE_ANCHOR_MULT);
    if (
      g.role?.universalFallback &&
      effRole === "core" &&
      !virtualRoleKeys.has(g.roleKey) &&
      !(args.suppressSharedRoles && g.role.positionless) &&
      g.candidates.length > 0 &&
      g.candidates.every(unusableForBilling)
    ) {
      const swapped = await synthesizeUniversalCandidate(
        ctx,
        g.role,
        slug,
        args.vehicleConfigId,
        effRole,
      );
      if (swapped) {
        roleWinners.push({
          roleKey: g.roleKey,
          serviceRole: effRole,
          candidate: swapped,
          losers: g.candidates,
          source: "universal_fallback",
          lowConfidence: false,
          quantity,
          quantityBasis,
          includeInLockedQuote,
          virtual: true,
        });
        continue;
      }
    }

    // Virtual fallback group — single deliberate candidate, no scorer.
    if (virtualRoleKeys.has(g.roleKey)) {
      roleWinners.push({
        roleKey: g.roleKey,
        serviceRole: effRole,
        candidate: g.candidates[0],
        losers: [],
        source: "universal_fallback",
        lowConfidence: false,
        quantity,
        quantityBasis,
        includeInLockedQuote,
        virtual: true,
      });
      continue;
    }

    // Director-pinned part wins its group outright — beats VIN-sticky and the
    // scorer. Highest-priority signal: a director said "this exact part is
    // the canonical OEM for this service-role".
    if (rule.pinnedPartIdsBySubcategory.size > 0) {
      const pinned = g.candidates.find((c) => {
        const sub = c.part.subcategory ?? "";
        const pinnedPartId = rule.pinnedPartIdsBySubcategory.get(sub);
        return pinnedPartId != null && pinnedPartId === c.part._id;
      });
      // I1 defense-in-depth: g.candidates is already make-filtered at hydration,
      // so `pinned` is make-correct today. Re-assert here so a future refactor
      // that resolves the pin's part_id independently can't reintroduce a
      // cross-make win — a wrong-make pin falls through to normal selection.
      // Mechanic verification exempts, matching the hydration guard.
      if (
        pinned &&
        (partFitsConfigMake(pinned.part.make_id, configMakeId) ||
          pinned.fitment.mechanic_verified === true)
      ) {
        const q = resolveRoleQuantity(g.role, bundle, pinned.fitment.quantity_needed);
        roleWinners.push({
          roleKey: g.roleKey,
          serviceRole: effRole,
          candidate: pinned,
          losers: g.candidates.filter((c) => c.part._id !== pinned.part._id),
          source: "scored",
          lowConfidence: false,
          quantity: q.quantity,
          quantityBasis: q.basis,
          includeInLockedQuote,
        });
        continue;
      }
    }

    // VIN-sticky wins its group outright, skipping the scorer.
    if (stickyDefault) {
      const sticky = g.candidates.find((c) => c.part._id === stickyDefault.part_id);
      // I1 defense-in-depth: g.candidates is already make-filtered at hydration,
      // so a wrong-make sticky part_id isn't found here today. Re-assert so a
      // future refactor that resolves the sticky part_id independently can't
      // serve a cross-make part — a wrong-make sticky falls through.
      // Mechanic verification exempts, matching the hydration guard.
      if (
        sticky &&
        (partFitsConfigMake(sticky.part.make_id, configMakeId) ||
          sticky.fitment.mechanic_verified === true)
      ) {
        const q = resolveRoleQuantity(g.role, bundle, sticky.fitment.quantity_needed);
        roleWinners.push({
          roleKey: g.roleKey,
          serviceRole: effRole,
          candidate: sticky,
          losers: g.candidates.filter((c) => c.part._id !== sticky.part._id),
          source: "vin_sticky",
          lowConfidence: false,
          quantity: q.quantity,
          quantityBasis: q.basis,
          includeInLockedQuote,
        });
        continue;
      }
    }

    const inputs: CandidateInput[] = g.candidates.map((c) => ({
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
    if (!result.winner) continue;
    const winner = g.candidates.find((c) => c.part._id === result.winner!.part_id)!;
    const q = resolveRoleQuantity(g.role, bundle, winner.fitment.quantity_needed);
    // Corroboration rule (PARTS_REQUIRE_CORROBORATION=on): a scored winner
    // attested by fewer than 2 distinct source domains — and neither
    // mechanic-verified nor reverse-fitment confirmed — is still quoted, but
    // flagged low-confidence (surfaces in bookings.low_confidence_parts for
    // post-job review). Ships OFF: source_domains only started accruing in
    // Jul 2026, so flipping this on immediately would flag nearly every
    // booking; enable once re-runs / the reverse-fitment check have populated
    // second attestations.
    const corroborated =
      process.env.PARTS_REQUIRE_CORROBORATION !== "on" ||
      winner.fitment.mechanic_verified === true ||
      (winner.fitment.source_domains?.length ?? 0) >= 2 ||
      winner.fitment.data_quality === "reverse_fitment_confirmed";
    roleWinners.push({
      roleKey: g.roleKey,
      serviceRole: effRole,
      candidate: winner,
      losers: g.candidates.filter((c) => c.part._id !== winner.part._id),
      source: "scored",
      trace: result.trace,
      eliminatedByGatePartIds: result.eliminatedByGate.map((e) => e.part_id),
      lowConfidence: result.low_confidence || !corroborated,
      quantity: q.quantity,
      quantityBasis: q.basis,
      includeInLockedQuote,
    });
  }

  if (roleWinners.length === 0) {
    return emptyResolution();
  }

  // ── Order + back-compat primary ───────────────────────────────────────────
  // Reference order first (primary/core roles lead), ad-hoc groups after.
  const roleOrder = new Map<string, number>();
  (spec?.roles ?? []).forEach((r, i) => roleOrder.set(r.roleKey, i));
  roleWinners.sort(
    (a, b) => (roleOrder.get(a.roleKey) ?? 999) - (roleOrder.get(b.roleKey) ?? 999),
  );

  const primaryKeys = new Set(
    (spec?.roles ?? []).filter((r) => r.primary).map((r) => r.roleKey),
  );
  const primary =
    roleWinners.find((rw) => primaryKeys.has(rw.roleKey)) ??
    roleWinners.find((rw) => rw.serviceRole === "core") ??
    roleWinners[0];

  return {
    winner: primary.candidate,
    losers: primary.losers,
    source: primary.source === "universal_fallback" ? "scored" : primary.source,
    trace: primary.trace,
    eliminatedByGatePartIds: primary.eliminatedByGatePartIds,
    lowConfidence: roleWinners.some((rw) => rw.lowConfidence),
    roleWinners,
  };
}

function toPricedFitment(c: WinnerCandidate, rw?: RoleWinner): PricedFitment {
  // Role winners carry reference-resolved quantity (fluid capacity math,
  // per-cylinder plugs); bare candidates (losers) fall back to the fitment.
  const quantity = rw?.quantity ?? c.fitment.quantity_needed ?? 1;
  // PARTS_PRICE_SOURCE flag: median@>=3 sources once flipped, else average.
  const unit_price = quoteUnitPrice(c.priceSummary);
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
    service_role: rw?.serviceRole,
    role_key: rw?.roleKey,
    quantity_basis: rw?.quantityBasis,
    locked: rw?.includeInLockedQuote,
    virtual: rw?.virtual,
  };
}

/** Map a resolution's role winners to priced lines + locked/range totals. */
function pricedLinesFromResolution(res: ResolvedServiceWinner): {
  parts: PricedFitment[];
  lockedTotal: number;
  asNeededTotal: number;
} {
  const parts = res.roleWinners.map((rw) => toPricedFitment(rw.candidate, rw));
  let lockedTotal = 0;
  let asNeededTotal = 0;
  for (let i = 0; i < res.roleWinners.length; i++) {
    const rw = res.roleWinners[i];
    if (rw.includeInLockedQuote) lockedTotal += parts[i].line_total;
    else if (rw.serviceRole === "as_needed") asNeededTotal += parts[i].line_total;
  }
  return {
    parts,
    lockedTotal: Math.round(lockedTotal * 100) / 100,
    asNeededTotal: Math.round(asNeededTotal * 100) / 100,
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

      // "both" → two passes (front + rear) so the breakdown carries both
      // axles' lines. The rear pass suppresses shared, positionless roles
      // (caliper grease) so they bill once. Single-pass otherwise.
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
          suppressSharedRoles: true,
        });

        const front = pricedLinesFromResolution(frontRes);
        const rear = pricedLinesFromResolution(rearRes);
        const frontWinner = frontRes.winner
          ? toPricedFitment(frontRes.winner, frontRes.roleWinners[0])
          : null;
        const rearWinner = rearRes.winner
          ? toPricedFitment(rearRes.winner, rearRes.roleWinners[0])
          : null;

        out.push({
          serviceId,
          serviceName: service.name,
          serviceSlug: service.slug,
          winner: frontWinner,
          losers: frontRes.losers.map((c) => toPricedFitment(c)),
          selectionSource:
            frontRes.source !== "no_candidates" ? frontRes.source : rearRes.source,
          lowConfidence: frontRes.lowConfidence || rearRes.lowConfidence,
          partsTotal:
            Math.round((front.lockedTotal + rear.lockedTotal) * 100) / 100,
          asNeededTotal:
            Math.round((front.asNeededTotal + rear.asNeededTotal) * 100) / 100,
          parts: [...front.parts, ...rear.parts],
          secondaryWinner: rearWinner,
          secondaryLosers: rearRes.losers.map((c) => toPricedFitment(c)),
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

      const primaryRw = resolution.roleWinners.find(
        (rw) => rw.candidate === resolution.winner,
      );
      const winner = resolution.winner
        ? toPricedFitment(resolution.winner, primaryRw)
        : null;
      const losers = resolution.losers.map((c) => toPricedFitment(c));
      const lines = pricedLinesFromResolution(resolution);

      out.push({
        serviceId,
        serviceName: service.name,
        serviceSlug: service.slug,
        winner,
        losers,
        selectionSource: resolution.source,
        lowConfidence: resolution.lowConfidence,
        partsTotal: lines.lockedTotal,
        asNeededTotal: lines.asNeededTotal,
        parts: lines.parts,
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
 * Record the battery chemistry actually installed in the car. Customer
 * picks Standard (flooded) / AGM / EFB in SingleServiceOptionsSheet; the
 * label is mapped client-side to the enrichment vocabulary
 * ("AGM" | "flooded" | "EFB" | "lithium-ion") and passed here.
 *
 * Mirrors recordTireSetup — stamps confirmed_at + source ("user" by
 * default), upserts the vehicle_owner_specs row.
 */
export const recordBatteryType = mutation({
  args: {
    vehicleOwnerId: v.id("vehicle_owners"),
    battery_type: v.string(),
    source: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const owner = await ctx.db.get(args.vehicleOwnerId);
    if (!owner) throw new Error("vehicle_owner not found");

    const now = Date.now();
    const battery = {
      type: args.battery_type,
      confirmed_at: now,
      source: args.source ?? "user",
    };

    const existing = await ctx.db
      .query("vehicle_owner_specs")
      .withIndex("by_vehicle_owner", (q) =>
        q.eq("vehicle_owner_id", args.vehicleOwnerId),
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        battery,
        last_updated_at: now,
      });
    } else {
      await ctx.db.insert("vehicle_owner_specs", {
        vehicle_owner_id: args.vehicleOwnerId,
        battery,
        created_at: now,
        last_updated_at: now,
      });
    }
  },
});

/**
 * Read the owner-confirmed battery field. Returns null if the
 * vehicle_owner_specs row doesn't exist or hasn't recorded a battery yet.
 * Used by the battery option-selection sheet to pre-fill the customer's
 * prior choice ahead of falling back to chassis_specs.battery_type.
 */
export const getOwnerSpecBattery = query({
  args: { vehicleOwnerId: v.id("vehicle_owners") },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("vehicle_owner_specs")
      .withIndex("by_vehicle_owner", (q) =>
        q.eq("vehicle_owner_id", args.vehicleOwnerId),
      )
      .first();
    return row?.battery ?? null;
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
