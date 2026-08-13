/**
 * services.ts - Service Catalog Management
 *
 * DESCRIPTION:
 * Manages the master catalog of services offered on the platform.
 * Examples: Oil Change, Tire Rotation, Brake Inspection, Transmission Fluid Flush
 * Services are organized into categories and may have options/variations.
 *
 * PRICING: Services do not store a fixed price. Price is determined at booking time by:
 *   (estimated_labor_time × mechanic/shop labor_rate) + parts + %taxes + %service_fees
 * Use services.default_labor_hours (and optional service_options / service_insights) with
 * shops.labor_rate to compute labor; add parts estimate and tax/fee percentages.
 *
 * TABLE: services
 *   - Master list of all services
 *   - Belongs to a service_category
 *   - Can have multiple options (variations)
 *   - Has default_labor_hours (used in price formula)
 *   - Referenced by bookings, shops, and specs
 *
 * KEY RELATIONSHIPS:
 *   - Belongs-to: service_category (via service_category_id)
 *   - Has-many: bookings (via service_id)
 *   - Has-many: service_options (via service_id)
 *   - Has-many: shop_services (via service_id)
 *   - Has-many: service_insights (via service_id)
 *   - Has-many: service_vehicle_specs (via service_id)
 *
 * USE CASES:
 *   1. Display available services to users
 *   2. Show service details and pricing estimates
 *   3. Filter by category
 *   4. Get cost/time estimates for booking
 *   5. Track service offerings at shops
 *
 * OWNER: Service Catalog Team
 */

import { query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { isServiceApplicable } from "./services/applicability";
import { partFitsConfigMake } from "./partSelector";

/**
 * QUERY: list
 * Returns all services with related category data and default parts estimate.
 * Parts estimate = avg of first service_option's parts_cost_low and parts_cost_high.
 * Ordered by category and display order.
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    // Dataset-only rows (is_bookable === false, e.g. serpentine_belt) exist so
    // enrichment data has a service_id to land on — they are never offered and
    // never surface in any service menu. Undefined = bookable (legacy rows).
    const services = (await ctx.db.query("services").collect()).filter(
      (s) => s.is_bookable !== false,
    );
    return await Promise.all(
      services.map(async (service) => {
        const serviceCategory = service.service_category_id
          ? await ctx.db.get(service.service_category_id)
          : null;
        const options = await ctx.db
          .query("service_options")
          .withIndex("by_service_id", (q) => q.eq("service_id", service._id))
          .collect();
        const firstOption = options.sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))[0];
        const default_parts_estimate =
          firstOption != null ? ((firstOption.parts_cost_low ?? 0) + (firstOption.parts_cost_high ?? 0)) / 2 : 0;
        return { ...service, serviceCategory, default_parts_estimate };
      }),
    );
  },
});

/**
 * QUERY: getById
 * Fetch a specific service by ID with category info.
 *
 * ARGS:
 *   - id: Service ID
 *
 * RETURNS:
 *   {
 *     _id: service id,
 *     name: string (e.g., "Oil Change"),
 *     description: string,
 *     slug: string,
 *     service_category_id: id,
 *     default_labor_hours: number,
 *     is_labor_only: boolean,
 *     has_options: boolean,
 *     display_order: number,
 *     serviceCategory: { icon_name, name, ... }
 *   }
 */
/**
 * QUERY: listForVehicle
 * Surfaces services likely relevant to a specific vehicle engine, used by the
 * post-job recommendation picker. When `engineId` is provided we prefer the
 * services tagged in `service_vehicle_specs`; we always fall back to the full
 * catalog so the mechanic can still find anything via substring search.
 *
 * The `query` filter does a case-insensitive substring match against name and
 * slug. Returns at most `limit` rows (default 25), ranked engine-matches first.
 */
export const listForVehicle = query({
  args: {
    engineId: v.optional(v.id("engines")),
    query: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 25;
    const needle = (args.query ?? "").trim().toLowerCase();

    const engineMatchedIds = new Set<string>();
    if (args.engineId) {
      const specs = await ctx.db
        .query("service_vehicle_specs")
        .withIndex("by_engine_id", (q) => q.eq("engine_id", args.engineId!))
        .collect();
      for (const spec of specs) {
        if (spec.is_applicable === false) continue;
        engineMatchedIds.add(String(spec.service_id));
      }
    }

    // Dataset-only rows (is_bookable === false) never surface — a mechanic
    // can't recommend a service the platform doesn't offer.
    const all = (await ctx.db.query("services").collect()).filter(
      (s) => s.is_bookable !== false,
    );
    const filtered = needle
      ? all.filter((s) => {
          const name = (s.name ?? "").toLowerCase();
          const slug = (s.slug ?? "").toLowerCase();
          return name.includes(needle) || slug.includes(needle);
        })
      : all;

    const sorted = filtered.sort((a, b) => {
      const aMatch = engineMatchedIds.has(String(a._id)) ? 0 : 1;
      const bMatch = engineMatchedIds.has(String(b._id)) ? 0 : 1;
      if (aMatch !== bMatch) return aMatch - bMatch;
      return (a.display_order ?? 999) - (b.display_order ?? 999);
    });

    return sorted.slice(0, limit).map((s) => ({
      _id: s._id,
      name: s.name,
      slug: s.slug ?? null,
      service_category_id: s.service_category_id ?? null,
      has_options: Boolean(s.has_options),
      is_vehicle_match: engineMatchedIds.has(String(s._id)),
    }));
  },
});

export const getById = query({
  args: { id: v.id("services") },
  handler: async (ctx, args) => {
    const service = await ctx.db.get(args.id);
    if (!service) {
      return null;
    }
    const serviceCategory = service.service_category_id
      ? await ctx.db.get(service.service_category_id)
      : null;
    return { ...service, serviceCategory };
  },
});

/**
 * QUERY: listBookableForVehicle
 *
 * The dynamic filter engine. Returns the APPLICABLE services for this vehicle
 * with a `state` per service. Reactive — when fitments land, enrichment status
 * flips, or the user answers a package question, the returned shape updates
 * and the booking-flow picker re-renders without a refresh.
 *
 * Return shape:
 *   Array<{ service_id, slug, state }>
 *
 *   state values (drives frontend render):
 *     - "bookable"              → enabled, click to add
 *     - "blocked_by_enrichment" → parts-required, pipeline still running.
 *                                 Render greyed (no action — wait it out).
 *     - "blocked_by_specs"      → pending package question affects this slug.
 *                                 Render greyed + tappable; tap redirects to
 *                                 the My Cars vehicle detail so user answers.
 *     - "missing_data"          → enrichment complete but no fitments exist
 *                                 (and not blocked by packages). Backend gap —
 *                                 HIDE entirely; user has no recourse.
 *
 * Non-applicable services are NOT returned at all — they never render.
 *
 * Coverage rule (per service S, vehicle V):
 *
 *   Visibility (returned at all):
 *     - S.is_applicable !== false for this vehicle, where applicability is:
 *         owner override (vehicle_service_states.is_applicable) wins;
 *         else engine default (service_vehicle_specs.is_applicable) applies;
 *         else assume applicable.
 *
 *   Bookable flag:
 *     - LABOR-ONLY services (S.is_labor_only === true OR S.requires_parts !==
 *       true) are ALWAYS bookable, even during enrichment — they need no parts
 *       data. Inspections, state-inspection, emissions, diagnostic scans.
 *     - PARTS-REQUIRED services need ALL of:
 *         a. config.enrichment_status ∈ {seeded, partial, complete, verified}
 *         b. part_fitments has ≥1 row for (config_id, service_type=S.slug)
 *         c. No package in packages_available has S.slug ∈ services_affected
 *            AND code ∉ (confirmed ∪ denied)
 *
 * Slug shape: hyphenated everywhere (services.slug, part_fitments.service_type,
 * packages_available[].services_affected all use the KNOWN_SERVICE_SLUGS form
 * from convex/lib/packageRules.ts).
 *
 * See docs/TICKET_PACKAGE_QUESTIONS.md.
 */
export type BookableState =
  | "bookable"
  | "blocked_by_enrichment"
  | "blocked_by_specs"
  | "missing_data";

export const listBookableForVehicle = query({
  args: { vehicleOwnerId: v.id("vehicle_owners") },
  handler: async (
    ctx,
    args,
  ): Promise<
    Array<{ service_id: Id<"services">; slug: string; state: BookableState }>
  > => {
    const TERMINAL_STATES = new Set([
      "seeded",
      "partial",
      "complete",
      "verified",
    ]);

    const owner = await ctx.db.get(args.vehicleOwnerId);
    if (!owner) return [];

    // Vehicle + config lookups are best-effort. If the user just added a VIN
    // and enrichment hasn't created the config yet, OR the config was deleted
    // for debugging, we should STILL return labor-only services (inspections,
    // diagnostics, tire rotation, etc.) — they don't need any vehicle-specific
    // data. Only parts-required services get gated by config presence below.
    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", owner.vin))
      .first();
    const config = vehicle?.vehicle_config_id
      ? await ctx.db.get(vehicle.vehicle_config_id)
      : null;

    // ── Applicability lookups ──────────────────────────────────────────────
    // Engine-level defaults: services tagged is_applicable=false for this
    // engine type (e.g. timing belt for chain engines). Both lookups are
    // skipped when the relevant context is missing — applicability defaults
    // to "applicable" without engine-level data.
    const engineId = vehicle?.engine_id ?? config?.engine_id ?? null;
    const engineNonApplicable = new Set<string>();
    if (engineId) {
      const engineSpecs = await ctx.db
        .query("service_vehicle_specs")
        .withIndex("by_engine_id", (q) => q.eq("engine_id", engineId))
        .collect();
      for (const spec of engineSpecs) {
        if (spec.is_applicable === false) {
          engineNonApplicable.add(String(spec.service_id));
        }
      }
    }

    // Owner-level overrides take precedence over engine defaults.
    const ownerStates = await ctx.db
      .query("vehicle_service_states")
      .withIndex("by_vehicle_owner", (q) =>
        q.eq("vehicle_owner_id", args.vehicleOwnerId),
      )
      .collect();
    const ownerApplicableOverride = new Map<string, boolean>();
    for (const state of ownerStates) {
      if (state.is_applicable !== undefined) {
        ownerApplicableOverride.set(String(state.service_id), state.is_applicable);
      }
    }

    const isEnrichmentReady = Boolean(
      config?.enrichment_status && TERMINAL_STATES.has(config.enrichment_status),
    );

    // Pending-package slugs only matter once enrichment is ready (before that,
    // packages_available may not even be populated yet). Without a config,
    // there's nothing to check.
    //
    // packageRules.services_affected and services.slug both use the underscored
    // shape (per seeds/seedServices.ts). Direct set match — no normalization.
    // Rows written before the rule rename will have hyphenated slugs and
    // won't match here; re-enrich the vehicle to refresh packages_available.
    const pendingSlugs = new Set<string>();
    if (isEnrichmentReady && config) {
      const ownerSpecs = await ctx.db
        .query("vehicle_owner_specs")
        .withIndex("by_vehicle_owner", (q) =>
          q.eq("vehicle_owner_id", args.vehicleOwnerId),
        )
        .first();
      const confirmed = new Set(ownerSpecs?.confirmed_packages ?? []);
      const denied = new Set(ownerSpecs?.denied_packages ?? []);
      for (const pkg of config.packages_available ?? []) {
        if (confirmed.has(pkg.code) || denied.has(pkg.code)) continue;
        for (const slug of pkg.services_affected) pendingSlugs.add(slug);
      }
    }

    // ── Structural applicability rows (Service Parts Reference N/A rules) ───
    // Fetch the rows isServiceApplicable() needs ONCE, before the per-service
    // loop. These encode the reference's "Not Applicable" gates: timing belt on
    // a chain-driven engine, PS flush on electric power steering, any ICE
    // service on an EV, differential service without a serviceable diff, tire
    // rotation on staggered+directional fitments, OBD-II services below the
    // min model year. isServiceApplicable fails OPEN on every missing input, so
    // nulls here simply mean "don't gate on that dimension". The gate only runs
    // when both engine and config (its two required, non-null inputs) exist.
    const structuralEngine = engineId ? await ctx.db.get(engineId) : null;
    const [structuralChassis, structuralDrivetrain, structuralTrim] = config
      ? await Promise.all([
          config.chassis_code
            ? ctx.db
                .query("chassis_specs")
                .withIndex("by_chassis_code", (q) =>
                  q.eq("chassis_code", config.chassis_code!),
                )
                .first()
            : null,
          ctx.db
            .query("drivetrain_configs")
            .withIndex("by_vehicle_config", (q) =>
              q.eq("vehicle_config_id", config._id),
            )
            .first(),
          ctx.db
            .query("trim_specs")
            .withIndex("by_vehicle_config", (q) =>
              q.eq("vehicle_config_id", config._id),
            )
            .first(),
        ])
      : [null, null, null];

    const services = await ctx.db.query("services").collect();
    const out: Array<{
      service_id: Id<"services">;
      slug: string;
      state: BookableState;
    }> = [];

    for (const service of services) {
      const slug = service.slug;
      if (!slug) continue;
      // Dataset-only services (is_bookable === false, seeded by
      // seeds/seedServices.ts seedDatasetServices) hold enrichment data for
      // services we do NOT offer — never bookable, never rendered.
      if (service.is_bookable === false) continue;
      const sid = String(service._id);

      // Applicability: owner override wins; else engine default; else applicable.
      const ownerOverride = ownerApplicableOverride.get(sid);
      if (ownerOverride === false) continue;
      if (ownerOverride === undefined && engineNonApplicable.has(sid)) continue;

      // Structural N/A gate (Service Parts Reference). Excludes services the
      // reference marks Not Applicable for this vehicle's hardware: timing belt
      // on a chain-driven engine, power-steering flush on electric PS, ICE-only
      // services on an EV, differential service without a serviceable diff,
      // tire rotation on staggered+directional fitments, OBD-II services below
      // the min model year. Same treatment as is_applicable === false: the
      // service is excluded from results entirely.
      //
      // Precedence: an explicit owner override of is_applicable === true wins
      // over this gate (the owner knows their car best), so we only consult the
      // structural rules when there is NO owner override. The gate also needs
      // both required inputs — isServiceApplicable fails open without them.
      if (
        ownerOverride === undefined &&
        structuralEngine &&
        config &&
        !isServiceApplicable(
          service,
          structuralEngine,
          structuralChassis,
          structuralDrivetrain,
          structuralTrim,
          config,
        )
      ) {
        continue;
      }

      // Labor-only services bypass enrichment + fitment + package gates.
      // They need no parts data and can be booked the moment the vehicle exists.
      // Examples in the catalog: inspections (NY State, brake system),
      // diagnostics (general, check engine, battery test), and labor-only
      // operations (tire rotation, wheel alignment, TPMS calibration).
      // Trust `is_labor_only` only — `requires_parts` isn't consistently set
      // in the seed (most services leave it undefined), so falling back on it
      // would treat almost everything as labor-only by accident.
      if (service.is_labor_only === true) {
        out.push({ service_id: service._id, slug, state: "bookable" });
        continue;
      }

      // tire_replacement is parts-required but the parts come from the
      // /(tire-booking) picker, not part_fitments. Coverage = whether the
      // enrichment captured OEM tire data on `trim_specs` for this config:
      // either a tire size (front/rear) or any tire_options entries.
      // (config is non-null here — the blocked_by_enrichment branch above
      // catches null configs and continues, but TS doesn't narrow across
      // the per-service control flow inside the loop.)
      if (slug === "tire_replacement" && config) {
        const trimSpecs = await ctx.db
          .query("trim_specs")
          .withIndex("by_vehicle_config", (q) =>
            q.eq("vehicle_config_id", config._id),
          )
          .first();
        const hasTireData = Boolean(
          trimSpecs?.tire_size_front ||
            trimSpecs?.tire_size_rear ||
            (Array.isArray(trimSpecs?.tire_options) &&
              trimSpecs.tire_options.length > 0),
        );
        out.push({
          service_id: service._id,
          slug,
          state: hasTireData ? "bookable" : "missing_data",
        });
        continue;
      }

      // Parts-required (is_labor_only is false or unset): classify the reason
      // it can't be booked NOW so the frontend can render the right affordance.
      // Without a config (vehicle not yet attached, or config deleted for
      // debugging), treat as still-enriching — greyed, no action.
      if (!config || !isEnrichmentReady) {
        out.push({
          service_id: service._id,
          slug,
          state: "blocked_by_enrichment",
        });
        continue;
      }

      // Enrichment is ready. Pending package questions take precedence over
      // missing-data because the user CAN unblock them by answering specs.
      if (pendingSlugs.has(slug)) {
        out.push({ service_id: service._id, slug, state: "blocked_by_specs" });
        continue;
      }

      // Fitment lookup. NOTE: services.slug is underscored but the enrichment
      // pipeline currently writes `part_fitments.service_type` using the
      // hyphenated PART_FIELD_MAP.serviceSlug values (see v3pipeline.ts).
      // Until those are standardized to match, parts-required services that
      // depend on pipeline-written fitments will appear as missing_data.
      const fitmentRows = await ctx.db
        .query("part_fitments")
        .withIndex("by_config_service", (q) =>
          q.eq("vehicle_config_id", config._id).eq("service_type", slug),
        )
        .collect();
      // I1 make guard: drop cross-make contaminant parts — a contaminated
      // fitment must not count toward coverage. Orphaned rows (part deleted)
      // still count, matching the previous existence-only check.
      const fitmentParts = await Promise.all(
        fitmentRows.map((f) => ctx.db.get(f.part_id)),
      );
      const hasFitment = fitmentParts.some(
        (part) => !part || partFitsConfigMake(part.make_id, config.make_id),
      );
      if (!hasFitment) {
        out.push({ service_id: service._id, slug, state: "missing_data" });
        continue;
      }

      out.push({ service_id: service._id, slug, state: "bookable" });
    }

    return out;
  },
});

/**
 * QUERY: getMostBookedThisWeek
 *
 * Aggregates the past 7 days of bookings and returns the top-N most-
 * frequently-booked services. Used by the "Most Booked" hero card on
 * the new booking-flow entry screen (Screen 1).
 *
 * Counts each service_id across every booking — a single 3-service
 * booking contributes 1 to each of its 3 services. No deduping per
 * user (popularity = raw booking frequency, not unique-customer reach).
 */
export const getMostBookedThisWeek = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 1;
    const sevenDaysAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;

    const recent = await ctx.db
      .query("bookings")
      .filter((q) => q.gt(q.field("_creationTime"), sevenDaysAgoMs))
      .collect();

    const counts = new Map<string, number>();
    for (const b of recent) {
      const ids = (b as { service_ids?: Id<"services">[] }).service_ids ?? [];
      for (const id of ids) {
        const key = String(id);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }

    const ranked = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);

    const results = await Promise.all(
      ranked.map(async ([id, count]) => {
        const service = await ctx.db.get(id as Id<"services">);
        return service ? { service, count } : null;
      }),
    );
    return results.filter((r): r is NonNullable<typeof r> => r !== null);
  },
});
