/**
 * directorCars — admin-panel queries for the Cars tab.
 *
 * Returns vehicles enriched with owner(s), make/model/trim/engine/transmission
 * labels, vehicle_config enrichment status, vehicle_passport mileage + fluids,
 * and booking counts. Mirrors the shape used by shopsList / usersList so the
 * UI can render a familiar table + drill-down modal.
 *
 * Access-controlled at middleware level (admin.otopair.com). No Clerk check.
 */

import { query } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { partFitsConfigMake } from "./partSelector";
import { normalizeMakeKey } from "./vehicleEnrichment/manualLibrary";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveMakeModelTrim(
  ctx: any,
  vehicle: Doc<"vehicles">,
): Promise<{ make: string; model: string; trim: string; year?: number }> {
  let make = "—";
  let model = "—";
  let trim = "—";
  if (vehicle.trim_id) {
    const trimRow = await ctx.db.get(vehicle.trim_id);
    if (trimRow) {
      trim = trimRow.name ?? "—";
      const modelRow = await ctx.db.get(trimRow.model_id);
      if (modelRow) {
        model = modelRow.name ?? "—";
        const makeRow = await ctx.db.get(modelRow.make_id);
        if (makeRow) make = makeRow.name ?? "—";
      }
    }
  }
  return { make, model, trim, year: vehicle.year };
}

function enrichmentLabel(cfg: Doc<"vehicle_configs"> | null): {
  status: string;
  fillRate?: number;
  confidence?: number;
  lastEnrichedAt?: number;
} {
  if (!cfg) return { status: "no_config" };
  return {
    status: cfg.enrichment_status ?? "unknown",
    fillRate: cfg.fill_rate,
    confidence: cfg.confidence_avg,
    lastEnrichedAt: cfg.last_enriched_at,
  };
}

// ---------------------------------------------------------------------------
// carsList — table rows for the Cars tab
// ---------------------------------------------------------------------------

export const carsList = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { limit }) => {
    const take = limit ?? 200;
    const vehicles = await ctx.db
      .query("vehicles")
      .order("desc")
      .take(take);

    return Promise.all(
      vehicles.map(async (vehicle) => {
        const ymm = await resolveMakeModelTrim(ctx, vehicle);

        // Owners — vehicle_owners is keyed by VIN.
        const owners = await ctx.db
          .query("vehicle_owners")
          .withIndex("by_vin", (q) => q.eq("vin", vehicle.vin))
          .filter((q) => q.neq(q.field("status"), "removed"))
          .collect();

        const primaryOwnerRow = owners.find((o) => o.is_primary) ?? owners[0];
        let ownerName: string | undefined;
        let ownerEmail: string | undefined;
        let ownerId: Id<"users"> | undefined;
        if (primaryOwnerRow) {
          const u = await ctx.db.get(primaryOwnerRow.user_id);
          if (u) {
            ownerId = u._id;
            ownerName =
              [u.first_name, u.last_name].filter(Boolean).join(" ").trim() ||
              u.username ||
              u.email ||
              "User";
            ownerEmail = u.email;
          }
        }

        // Booking count by VIN — no direct index, so scan by user_id then
        // filter. For a director surface this is fine (we cap vehicles@200).
        let bookingCount = 0;
        const seenUsers = new Set<string>();
        for (const o of owners) {
          if (seenUsers.has(String(o.user_id))) continue;
          seenUsers.add(String(o.user_id));
          const userBookings = await ctx.db
            .query("bookings")
            .withIndex("by_user_id", (q) => q.eq("user_id", o.user_id))
            .collect();
          bookingCount += userBookings.filter((b) => b.vin === vehicle.vin).length;
        }

        // Enrichment status from vehicle_configs.
        const cfg = vehicle.vehicle_config_id
          ? await ctx.db.get(vehicle.vehicle_config_id)
          : null;

        // Passport mileage if present.
        const passport = await ctx.db
          .query("vehicle_passports")
          .withIndex("by_vin", (q) => q.eq("vin", vehicle.vin))
          .unique();

        return {
          id:           vehicle._id,
          vin:          vehicle.vin,
          ymm: [ymm.year, ymm.make, ymm.model].filter(Boolean).join(" "),
          year:         vehicle.year,
          make:         ymm.make,
          model:        ymm.model,
          trim:         ymm.trim,
          image_url:    vehicle.image_url,
          ownerId,
          ownerName,
          ownerEmail,
          ownerCount:   owners.length,
          mileage:      passport?.mileage ?? primaryOwnerRow?.mileage,
          bookingCount,
          enrichment:   enrichmentLabel(cfg),
          createdAt:    vehicle.created_at,
          updatedAt:    vehicle.updated_at,
        };
      }),
    );
  },
});

// ---------------------------------------------------------------------------
// carDetail — full payload for the drill-down modal
// ---------------------------------------------------------------------------

export const carDetail = query({
  args: { id: v.id("vehicles") },
  handler: async (ctx, { id }) => {
    const vehicle = await ctx.db.get(id);
    if (!vehicle) return null;

    const ymm = await resolveMakeModelTrim(ctx, vehicle);

    const [engine, transmission, chassis, trim, vehicleConfig, passport] =
      await Promise.all([
        vehicle.engine_id ? ctx.db.get(vehicle.engine_id) : null,
        vehicle.transmission_id ? ctx.db.get(vehicle.transmission_id) : null,
        vehicle.chassis_id ? ctx.db.get(vehicle.chassis_id) : null,
        vehicle.trim_id ? ctx.db.get(vehicle.trim_id) : null,
        vehicle.vehicle_config_id ? ctx.db.get(vehicle.vehicle_config_id) : null,
        ctx.db
          .query("vehicle_passports")
          .withIndex("by_vin", (q) => q.eq("vin", vehicle.vin))
          .unique(),
      ]);

    // Chassis specs (platform-level) via chassis_code on vehicle_configs.
    let chassisSpecs: Doc<"chassis_specs"> | null = null;
    if (vehicleConfig?.chassis_code) {
      chassisSpecs = await ctx.db
        .query("chassis_specs")
        .withIndex("by_chassis_code", (q) => q.eq("chassis_code", vehicleConfig.chassis_code as string))
        .unique();
    }

    // Trim-specific specs (tires, etc.)
    const trimSpecs = vehicle.trim_id
      ? await ctx.db
          .query("trim_specs")
          .withIndex("by_trim", (q) => q.eq("trim_id", vehicle.trim_id))
          .first()
      : null;

    // Owners with display names.
    const ownerRows = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_vin", (q) => q.eq("vin", vehicle.vin))
      .collect();
    const owners = await Promise.all(
      ownerRows.map(async (o) => {
        const u = await ctx.db.get(o.user_id);
        return {
          ownerId: o._id, // vehicle_owners row id — needed for per-owner edits
          userId: o.user_id,
          userName: u
            ? [u.first_name, u.last_name].filter(Boolean).join(" ").trim() ||
              u.username ||
              u.email ||
              "User"
            : "Unknown",
          userEmail: u?.email,
          userPhone: u?.phone,
          status: o.status,
          isPrimary: o.is_primary,
          nickname: o.nickname,
          mileage: o.mileage,
          ownership_plan: o.ownership_plan,
          health_score: o.health_score,
          ownership_type: o.ownershipType,
          usage_pattern: o.usagePattern,
          driving_conditions: o.drivingConditions,
          annual_mileage_band: o.annualMileageBand,
          owner_segment: o.owner_segment,
          vehicle_mode: o.vehicle_mode,
          added_at: o.added_at,
          removed_at: o.removed_at,
        };
      }),
    );

    // Bookings on this VIN across all owners.
    const userIds = [...new Set(ownerRows.map((o) => String(o.user_id)))];
    const bookings: Doc<"bookings">[] = [];
    for (const uid of userIds) {
      const rows = await ctx.db
        .query("bookings")
        .withIndex("by_user_id", (q) => q.eq("user_id", uid as Id<"users">))
        .collect();
      for (const b of rows) if (b.vin === vehicle.vin) bookings.push(b);
    }
    bookings.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));

    const enrichedBookings = await Promise.all(
      bookings.slice(0, 25).map(async (b) => {
        const [shop, user] = await Promise.all([
          b.shop_id ? ctx.db.get(b.shop_id) : null,
          ctx.db.get(b.user_id),
        ]);
        const services = await Promise.all(
          b.service_ids.map(async (sid) => {
            const s = await ctx.db.get(sid);
            return s?.name ?? "—";
          }),
        );
        return {
          id:        b._id,
          shop:      shop?.name ?? "—",
          shopId:    b.shop_id,
          scheduled: b.scheduled_date ?? "—",
          time:      b.scheduled_time ?? "—",
          status:    b.status,
          total:     b.total_cost ?? 0,
          services,
          userName:  user
            ? [user.first_name, user.last_name].filter(Boolean).join(" ").trim() ||
              user.email ||
              "User"
            : "Unknown",
          userId:    b.user_id,
          createdAt: b.created_at,
        };
      }),
    );

    return {
      id:           vehicle._id,
      vin:          vehicle.vin,
      year:         vehicle.year,
      make:         ymm.make,
      model:        ymm.model,
      trim:         ymm.trim,
      ymmt: [ymm.year, ymm.make, ymm.model, ymm.trim !== "—" ? ymm.trim : null]
        .filter(Boolean)
        .join(" "),
      image_url:    vehicle.image_url,

      // Linked specs
      engine:       engine
        ? {
            id:                engine._id,
            code:              engine.engine_code,
            family:            engine.engine_family,
            cylinders:         engine.cylinders,
            configuration:     engine.configuration,
            aspiration:        engine.aspiration,
            fuel_type:         engine.fuel_type,
            fuel_injection:    engine.fuel_injection,
            displacement_l:    engine.displacement_l ?? engine.displacement_liters,
            timing_system:     engine.timing_system,
            oil_viscosity:     engine.oil_viscosity,
            oil_capacity_qts:  engine.oil_capacity_qts,
            coolant_type:      engine.coolant_type,
            coolant_capacity_qts: engine.coolant_capacity_qts,
            spark_plug_quantity:  engine.spark_plug_quantity,
            spark_plug_gap_mm:    engine.spark_plug_gap_mm,
            water_pump_timing_driven: engine.water_pump_timing_driven,
            data_quality:      engine.data_quality,
            last_enriched_at:  engine.last_enriched_at,
          }
        : null,
      transmission: transmission
        ? {
            id:                transmission._id,
            type:              transmission.transmission_type ?? transmission.type,
            code:              transmission.code,
            speeds:            transmission.speeds,
            manufacturer:      transmission.manufacturer,
            fluid_type:        transmission.fluid_type,
            fluid_capacity_drain_fill_qts: transmission.fluid_capacity_drain_fill_qts,
            is_lifetime_fill:  transmission.is_lifetime_fill,
            has_serviceable_filter: transmission.has_serviceable_filter,
            service_method:    transmission.service_method,
            data_quality:      transmission.data_quality,
          }
        : null,
      chassis:      chassis
        ? {
            id:               chassis._id,
            drivetrain_type:  chassis.drivetrain_type,
            notes:            chassis.notes,
            confidence_score: chassis.confidence_score,
          }
        : null,
      chassisSpecs: chassisSpecs
        ? {
            chassis_code:          chassisSpecs.chassis_code,
            brake_fluid_type:      chassisSpecs.brake_fluid_type,
            brake_fluid_capacity_oz: chassisSpecs.brake_fluid_capacity_oz,
            ps_fluid_type:         chassisSpecs.ps_fluid_type,
            ps_fluid_capacity_oz:  chassisSpecs.ps_fluid_capacity_oz,
            lug_nut_torque_ft_lbs: chassisSpecs.lug_nut_torque_ft_lbs,
            wiper_blade_driver_size_in: chassisSpecs.wiper_blade_driver_size_in,
            wiper_blade_passenger_size_in: chassisSpecs.wiper_blade_passenger_size_in,
            wiper_blade_rear_size_in: chassisSpecs.wiper_blade_rear_size_in,
            battery_group:         chassisSpecs.battery_group,
            battery_type:          chassisSpecs.battery_type,
            steering_type:         chassisSpecs.steering_type,
            parking_brake_type:    chassisSpecs.parking_brake_type,
            has_rear_wiper:        chassisSpecs.has_rear_wiper,
            has_brake_pad_sensor:  chassisSpecs.has_brake_pad_sensor,
            data_quality:          chassisSpecs.data_quality,
            last_enriched_at:      chassisSpecs.last_enriched_at,
          }
        : null,
      trimSpecs: trimSpecs
        ? {
            tire_size_front:    trimSpecs.tire_size_front,
            tire_size_rear:     trimSpecs.tire_size_rear,
            recommended_tire_pressure_front_psi: trimSpecs.recommended_tire_pressure_front_psi,
            recommended_tire_pressure_rear_psi:  trimSpecs.recommended_tire_pressure_rear_psi,
            is_staggered:       trimSpecs.is_staggered,
            tire_directional:   trimSpecs.tire_directional,
            is_run_flat:        trimSpecs.is_run_flat,
            alignment_type:     trimSpecs.alignment_type,
            tire_options:       trimSpecs.tire_options ?? [],
            tire_options_source: trimSpecs.tire_options_source,
          }
        : null,

      vehicleConfig: vehicleConfig
        ? {
            id:                  vehicleConfig._id,
            config_key:          vehicleConfig.config_key,
            nhtsa_vin_key:       vehicleConfig.nhtsa_vin_key,
            chassis_code:        vehicleConfig.chassis_code,
            drivetrain:          vehicleConfig.drivetrain,
            enrichment_status:   vehicleConfig.enrichment_status,
            fill_rate:           vehicleConfig.fill_rate,
            confidence_avg:      vehicleConfig.confidence_avg,
            last_enriched_at:    vehicleConfig.last_enriched_at,
            last_verified_at:    vehicleConfig.last_verified_at,
            enrichment_version:  vehicleConfig.enrichment_version,
            verification_count:  vehicleConfig.verification_count,
            packages_available:  vehicleConfig.packages_available,
          }
        : null,

      passport: passport
        ? {
            mileage:              passport.mileage,
            last_reported_at:     passport.last_reported_at,
            mileage_velocity:     passport.mileage_velocity,
            tires:                passport.tires,
            fluids:               passport.fluids,
            brakes:               passport.brakes,
            inspection:           passport.inspection,
            modifications:        passport.modifications,
            first_shop_confirmed_at: passport.first_shop_confirmed_at,
            last_shop_confirmed_at:  passport.last_shop_confirmed_at,
            updated_at:           passport.updated_at,
          }
        : null,

      owners,
      bookings:    enrichedBookings,
      bookingCount: bookings.length,

      enrichment:  enrichmentLabel(vehicleConfig),
      raw: {
        engine_id:         vehicle.engine_id,
        transmission_id:   vehicle.transmission_id,
        chassis_id:        vehicle.chassis_id,
        trim_id:           vehicle.trim_id,
        vehicle_config_id: vehicle.vehicle_config_id,
        created_at:        vehicle.created_at,
        updated_at:        vehicle.updated_at,
      },
    };
  },
});

// ---------------------------------------------------------------------------
// userVehicleHistory — bookings + services for a (user, vehicle) pair.
// Used by the user modal's "click a vehicle" drill-down.
// ---------------------------------------------------------------------------

export const userVehicleHistory = query({
  args: {
    userId:   v.id("users"),
    vehicleId: v.id("vehicles"),
  },
  handler: async (ctx, { userId, vehicleId }) => {
    const vehicle = await ctx.db.get(vehicleId);
    if (!vehicle) return null;

    const ymm = await resolveMakeModelTrim(ctx, vehicle);

    const ownership = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_vin", (q) => q.eq("vin", vehicle.vin))
      .filter((q) => q.eq(q.field("user_id"), userId))
      .first();

    const userBookings = await ctx.db
      .query("bookings")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .collect();
    const bookings = userBookings.filter((b) => b.vin === vehicle.vin);
    bookings.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));

    const enrichedBookings = await Promise.all(
      bookings.map(async (b) => {
        const shop = b.shop_id ? await ctx.db.get(b.shop_id) : null;
        const services = await Promise.all(
          b.service_ids.map(async (sid) => {
            const s = await ctx.db.get(sid);
            return s?.name ?? "—";
          }),
        );
        return {
          id:        b._id,
          shop:      shop?.name ?? "—",
          shopId:    b.shop_id,
          scheduled: b.scheduled_date ?? "—",
          time:      b.scheduled_time ?? "—",
          status:    b.status,
          total:     b.total_cost ?? 0,
          labor:     b.labor_cost ?? 0,
          parts:     b.parts_cost ?? 0,
          services,
          createdAt: b.created_at,
        };
      }),
    );

    const completed = bookings.filter((b) => b.status === "completed");
    const totalSpend = completed.reduce((sum, b) => sum + (b.total_cost ?? 0), 0);

    const passport = await ctx.db
      .query("vehicle_passports")
      .withIndex("by_vin", (q) => q.eq("vin", vehicle.vin))
      .unique();

    return {
      vehicleId:   vehicle._id,
      vin:         vehicle.vin,
      year:        vehicle.year,
      make:        ymm.make,
      model:       ymm.model,
      trim:        ymm.trim,
      image_url:   vehicle.image_url,
      ownership: ownership
        ? {
            nickname:       ownership.nickname,
            status:         ownership.status,
            isPrimary:      ownership.is_primary,
            mileage:        ownership.mileage,
            ownership_plan: ownership.ownership_plan,
            health_score:   ownership.health_score,
            ownership_type: ownership.ownershipType,
            added_at:       ownership.added_at,
          }
        : null,
      passportMileage: passport?.mileage,
      bookings:        enrichedBookings,
      bookingCount:    bookings.length,
      completedCount:  completed.length,
      totalSpend,
    };
  },
});

// ===========================================================================
// Vehicle CONFIGS surface — "what we know about this YMMT", platform-level.
// Distinct from carsList/carDetail which are per-VIN. A single vehicle_config
// can be referenced by many vehicles (every BMW 2020 M550i xDrive shares one
// config). The Configs tab is the right place to inspect/audit the catalog
// itself: enrichment status, OEM specs, packages, fitments, intervals.
// ===========================================================================

export const vehicleConfigsList = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const take = limit ?? 300;
    // Order by enrichment status first (so partials surface) — fall back to
    // creation time by re-sorting client-side.
    const configs = await ctx.db
      .query("vehicle_configs")
      .order("desc")
      .take(take);

    return Promise.all(
      configs.map(async (cfg) => {
        const [makeRow, modelRow, engineRow, transRow] = await Promise.all([
          cfg.make_id ? ctx.db.get(cfg.make_id) : null,
          cfg.model_id ? ctx.db.get(cfg.model_id) : null,
          cfg.engine_id ? ctx.db.get(cfg.engine_id) : null,
          cfg.transmission_id ? ctx.db.get(cfg.transmission_id) : null,
        ]);

        // Count vehicles using this config (a "how many VINs" stat).
        const vehiclesForConfig = await ctx.db
          .query("vehicles")
          .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", cfg._id))
          .collect();

        // Latest enrichment_run for status freshness.
        const latestRun = await ctx.db
          .query("enrichment_runs")
          .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", cfg._id))
          .order("desc")
          .first();

        return {
          id:                  cfg._id,
          configKey:           cfg.config_key,
          nhtsaVinKey:         cfg.nhtsa_vin_key,
          year:                cfg.year,
          make:                makeRow?.name ?? "—",
          model:               modelRow?.name ?? "—",
          trim:                cfg.trim_name ?? "—",
          drivetrain:          cfg.drivetrain,
          chassisCode:         cfg.chassis_code,
          engineCode:          engineRow?.engine_code,
          engineFamily:        engineRow?.engine_family,
          transmissionType:    transRow?.transmission_type ?? transRow?.type,
          enrichmentStatus:    cfg.enrichment_status ?? "unknown",
          fillRate:            cfg.fill_rate,
          confidenceAvg:       cfg.confidence_avg,
          enrichmentVersion:   cfg.enrichment_version,
          lastEnrichedAt:      cfg.last_enriched_at,
          lastVerifiedAt:      cfg.last_verified_at,
          verificationCount:   cfg.verification_count ?? 0,
          packagesCount:       cfg.packages_available?.length ?? 0,
          // Rotor-minimum coverage at a glance — a config with no minimum
          // grades its rotors ungraded in the bay.
          rotorFrontMinMm:     cfg.rotor_front_min_thickness_mm ?? null,
          rotorRearMinMm:      cfg.rotor_rear_min_thickness_mm ?? null,
          rotorMinEstimated:
            cfg.rotor_front_min_quality === "derived_from_nominal" ||
            cfg.rotor_rear_min_quality === "derived_from_nominal",
          vehicleCount:        vehiclesForConfig.length,
          latestRunStatus:     latestRun?.status,
          latestRunAt:         latestRun?.created_at,
          createdAt:           cfg._creationTime,
        };
      }),
    );
  },
});

/**
 * Director: list all part_fitments for a vehicle_config, grouped by service_type,
 * each enriched with the OEM part's identity fields. Base fitments (no package)
 * sort before package-specific variants. Use with the part drill-down drawer
 * — partFitmentDetail fetches per-part prices + sources on demand.
 */
export const vehicleConfigFitments = query({
  args: { vehicle_config_id: v.id("vehicle_configs") },
  handler: async (ctx, { vehicle_config_id }) => {
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", vehicle_config_id))
      .collect();

    // I1 make guard: annotate cross-make contaminant parts (directors see them, never dropped)
    const cfg = await ctx.db.get(vehicle_config_id);

    const rows = await Promise.all(
      fitments.map(async (f) => {
        const part = (await ctx.db.get(f.part_id)) as any | null;
        const prices = await ctx.db
          .query("part_prices")
          .withIndex("by_part", (q) => q.eq("part_id", f.part_id))
          .collect();
        return {
          fitmentId:        String(f._id),
          partId:           String(f.part_id),
          serviceType:      (f as any).service_type ?? "unknown",
          packageCode:      (f as any).package_code ?? null,
          quantity:         (f as any).quantity_needed ?? null,
          confidence:       (f as any).confidence ?? null,
          sourceCount:      (f as any).source_count ?? null,
          mechanicVerified: !!(f as any).mechanic_verified,
          partNumber:       part?.oem_part_number ?? null,
          partName:         part?.name ?? null,
          brand:            part?.brand ?? null,
          category:         part?.category ?? null,
          subcategory:      part?.subcategory ?? null,
          partTier:         part?.part_tier ?? null,
          priceCount:       prices.length,
          cross_make:       part ? !partFitsConfigMake(part.make_id, cfg?.make_id) : false,
        };
      }),
    );

    // Group by service_type; within each, base before package-specific.
    const map = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = r.serviceType;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    const groups = [...map.entries()]
      .map(([service, items]) => ({
        service,
        items: items.sort((a, b) => {
          // Base fitments (null packageCode) first.
          if ((a.packageCode === null) !== (b.packageCode === null)) {
            return a.packageCode === null ? -1 : 1;
          }
          const pkgCmp = (a.packageCode ?? "").localeCompare(b.packageCode ?? "");
          if (pkgCmp !== 0) return pkgCmp;
          return (a.partName ?? a.partNumber ?? "").localeCompare(b.partName ?? b.partNumber ?? "");
        }),
      }))
      .sort((a, b) => a.service.localeCompare(b.service));

    return { groups, total: rows.length };
  },
});

/**
 * Director: drill-down detail for a single OEM part — identity, all recorded
 * prices (with source URL/domain), and any enrichment_evidence rows scoped to
 * the vehicle_config the part is attached to (the pipeline writes part-field
 * evidence under entity_type="part", entity_id=vehicle_config_id).
 */
export const partFitmentDetail = query({
  args: {
    part_id: v.id("oem_parts"),
    vehicle_config_id: v.optional(v.id("vehicle_configs")),
  },
  handler: async (ctx, { part_id, vehicle_config_id }) => {
    const part = (await ctx.db.get(part_id)) as any | null;
    if (!part) return null;

    const prices = await ctx.db
      .query("part_prices")
      .withIndex("by_part", (q) => q.eq("part_id", part_id))
      .collect();

    let evidence: any[] = [];
    if (vehicle_config_id) {
      evidence = await ctx.db
        .query("enrichment_evidence")
        .withIndex("by_entity", (q) =>
          q.eq("entity_type", "part").eq("entity_id", String(vehicle_config_id)),
        )
        .collect();
    }

    return {
      partId:       String(part_id),
      partNumber:   part.oem_part_number ?? null,
      name:         part.name ?? null,
      brand:        part.brand ?? null,
      category:     part.category ?? null,
      subcategory:  part.subcategory ?? null,
      partTier:     part.part_tier ?? null,
      sourceCount:  part.source_count ?? null,
      prices: prices
        .map((p) => ({
          price:         p.price,
          priceType:     (p as any).price_type ?? null,
          sourceUrl:     (p as any).source_url ?? null,
          sourceDomain:  (p as any).source_domain ?? null,
          refreshedAt:   (p as any).refreshed_at ?? null,
          msrp:          (p as any).msrp ?? null,
          discount:      (p as any).discount ?? null,
        }))
        .sort((a, b) => a.price - b.price),
      evidence: evidence
        .map((e: any) => ({
          field:        e.field_name ?? null,
          value:        e.observed_value ?? null,
          sourceUrl:    e.source_url ?? null,
          sourceDomain: e.source_domain ?? null,
          sourceType:   e.source_type ?? null,
          confidence:   e.confidence ?? null,
          observedAt:   e.observed_at ?? null,
          isLatest:     e.is_latest ?? null,
        }))
        // Most relevant first: latest, then highest confidence
        .sort((a, b) => {
          if (a.isLatest !== b.isLatest) return a.isLatest ? -1 : 1;
          return (b.confidence ?? 0) - (a.confidence ?? 0);
        })
        .slice(0, 50),
    };
  },
});

export const vehicleConfigDetail = query({
  args: { id: v.id("vehicle_configs") },
  handler: async (ctx, { id }) => {
    const cfg = await ctx.db.get(id);
    if (!cfg) return null;

    const [makeRow, modelRow, generationRow, engineRow, transRow] = await Promise.all([
      cfg.make_id ? ctx.db.get(cfg.make_id) : null,
      cfg.model_id ? ctx.db.get(cfg.model_id) : null,
      cfg.generation_id ? ctx.db.get(cfg.generation_id) : null,
      cfg.engine_id ? ctx.db.get(cfg.engine_id) : null,
      cfg.transmission_id ? ctx.db.get(cfg.transmission_id) : null,
    ]);

    // Drivetrain config (1:1 child)
    const drivetrain = await ctx.db
      .query("drivetrain_configs")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", id))
      .first();

    // Trim specs (1:1 child, scoped by vehicle_config_id)
    const trimSpecs = await ctx.db
      .query("trim_specs")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", id))
      .first();

    // Chassis specs via chassis_code
    let chassisSpecs: Doc<"chassis_specs"> | null = null;
    if (cfg.chassis_code) {
      chassisSpecs = await ctx.db
        .query("chassis_specs")
        .withIndex("by_chassis_code", (q) => q.eq("chassis_code", cfg.chassis_code as string))
        .unique();
    }

    // Service intervals + labor times (per-service rollup)
    const intervalsRows = await ctx.db
      .query("service_intervals")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", id))
      .collect();
    const serviceIntervals = await Promise.all(
      intervalsRows.map(async (row) => ({
        serviceName: (await ctx.db.get(row.service_id))?.name ?? "—",
        miles:       row.interval_miles,
        months:      row.interval_months,
        confidence:  row.confidence,
        verified:    row.mechanic_verified,
        display:     row.display_string,
        // Provenance, so the UI can mark which rows the manual actually
        // produced. months carries its own source because a row can legitimately
        // have OEM-manual miles and a weaker months (see the schema note on
        // interval_months_source); UNSET means "same provenance as data_quality".
        dataQuality:  row.data_quality ?? null,
        monthsSource: row.interval_months_source ?? null,
      })),
    );

    // OEM manuals for this vehicle. vehicle_manuals is keyed by (make, model,
    // year) rather than by config — one PDF serves every config of the same
    // YMM — so the lookup has to normalize its key exactly the way
    // upsertManualRow does, or nothing matches.
    //
    // Failed rows are returned, not filtered: "we tried this URL and it was the
    // wrong document" is the negative cache driving shouldSkipManualLookup, and
    // a director looking at an empty intervals table needs to see that the
    // library tried and why it gave up.
    const manualMake = normalizeMakeKey(makeRow?.name);
    const manualModel = normalizeMakeKey(modelRow?.name);
    const manualRows =
      manualMake && manualModel
        ? await ctx.db
            .query("vehicle_manuals")
            .withIndex("by_ymm", (q) =>
              q.eq("make", manualMake).eq("model", manualModel).eq("year", cfg.year),
            )
            .collect()
        : [];

    const manuals = manualRows
      .map((m) => ({
        id:             m._id,
        sourceUrl:      m.source_url,
        domain:         m.source_domain,
        isOemDomain:    m.is_oem_domain,
        docKind:        m.doc_kind,
        pageCount:      m.page_count ?? null,
        fileBytes:      m.file_bytes ?? null,
        // A file_id is what makes a manual extractable; without one the row is
        // a record of an attempt, not a usable document.
        hasFile:        !!m.file_id,
        failureReason:  m.failure_reason ?? null,
        attempts:       m.attempts ?? null,
        rejectedCount:  m.rejected_urls?.length ?? 0,
        fetchedAt:      m.fetched_at,
        expiresAt:      m.expires_at ?? null,
      }))
      // Usable documents first, then most recently fetched.
      .sort((a, b) =>
        a.hasFile === b.hasFile ? b.fetchedAt - a.fetchedAt : a.hasFile ? -1 : 1,
      );

    // How many interval rows this library actually produced — the honest
    // headline for "did the manual do anything for this car".
    const manualBackedIntervals = intervalsRows.filter(
      (r) => r.data_quality === "oem_manual" || r.interval_months_source === "oem_manual",
    ).length;

    // Labor times — per-service rollup (book hours + source + confidence), so a
    // director can audit which services have real (OLP-backed) labor vs the
    // tier-estimate fallback. Read-only.
    const laborRows = await ctx.db
      .query("labor_times")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", id))
      .collect();
    const laborTimes = (
      await Promise.all(
        laborRows.map(async (row) => {
          const svc = await ctx.db.get(row.service_id);
          if (!svc) return null;
          return {
            serviceName: (svc as any).name ?? "—",
            hours: row.book_hours ?? row.empirical_hours ?? null,
            source: row.source ?? null,
            confidence: row.confidence ?? null,
          };
        }),
      )
    )
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => a.serviceName.localeCompare(b.serviceName));

    // Part fitments — show how many parts are mapped for this config.
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", id))
      .collect();
    // I1 make guard: annotate cross-make contaminant parts (directors see them, never dropped)
    const fitmentParts = await Promise.all(fitments.map((f) => ctx.db.get(f.part_id)));
    const fitmentSummary = (() => {
      const byService: Record<string, { count: number; cross_make_count: number }> = {};
      fitments.forEach((f, i) => {
        const key = (f as any).service_type ?? "unknown";
        const part = fitmentParts[i] as any | null;
        const entry = (byService[key] ??= { count: 0, cross_make_count: 0 });
        entry.count += 1;
        if (part && !partFitsConfigMake(part.make_id, cfg.make_id)) entry.cross_make_count += 1;
      });
      return Object.entries(byService).map(([service, counts]) => ({ service, ...counts }));
    })();

    // Enrichment runs (full history)
    const enrichmentRuns = await ctx.db
      .query("enrichment_runs")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", id))
      .order("desc")
      .take(20);

    // Latest "Reprice parts" audit row — the reprice action doesn't write to
    // enrichment_runs; its only signal is an audit_log row. Detail prefix is
    // matched in the UI to derive a scheduled / complete / failed state.
    const repriceAuditRows = await ctx.db
      .query("audit_log")
      .withIndex("by_entity", (q) =>
        q.eq("entity_type", "vehicle_config").eq("entity_id", String(id)),
      )
      .order("desc")
      .take(40);
    const latestRepriceAudit = (() => {
      const row = repriceAuditRows.find((r) =>
        (r.detail ?? "").startsWith("Reprice parts"),
      );
      if (!row) return null;
      return {
        id: row._id,
        detail: row.detail,
        createdAt: row.created_at,
        actor: row.actor,
      };
    })();

    // Vehicles using this config — sample so director can jump to a VIN.
    const vehicles = await ctx.db
      .query("vehicles")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", id))
      .collect();
    const vehicleSample = vehicles.slice(0, 25).map((v) => ({
      id:        v._id,
      vin:       v.vin,
      year:      v.year,
      createdAt: v.created_at,
    }));

    return {
      id:                  cfg._id,
      configKey:           cfg.config_key,
      nhtsaVinKey:         cfg.nhtsa_vin_key,
      year:                cfg.year,
      make:                makeRow?.name ?? "—",
      model:               modelRow?.name ?? "—",
      makeId:              cfg.make_id,
      modelId:             cfg.model_id,
      generation:          generationRow?.name,
      trimName:            cfg.trim_name,
      trimSlug:            cfg.trim_slug,
      drivetrain:          cfg.drivetrain,
      chassisCode:         cfg.chassis_code,
      hasBrakeP:           cfg.has_brake_pad_sensor,
      brakeFluidType:      cfg.brake_fluid_type,
      brakeFluidCapacityOz: cfg.brake_fluid_capacity_oz,
      psFluidType:         cfg.ps_fluid_type,
      psFluidCapacityOz:   cfg.ps_fluid_capacity_oz,

      // OEM rotor thickness. Minimum and nominal are surfaced SEPARATELY and
      // labelled as such — a nominal read as a minimum condemns healthy rotors.
      // `observedLabel` is the verbatim text the minimum was read under so a
      // director can audit whether we read a real minimum or a bare "Thickness".
      rotor: {
        frontMinMm:     cfg.rotor_front_min_thickness_mm ?? null,
        rearMinMm:      cfg.rotor_rear_min_thickness_mm ?? null,
        frontNominalMm: cfg.rotor_front_nominal_thickness_mm ?? null,
        rearNominalMm:  cfg.rotor_rear_nominal_thickness_mm ?? null,
        frontQuality:   cfg.rotor_front_min_quality ?? null,
        rearQuality:    cfg.rotor_rear_min_quality ?? null,
        sourceUrl:      cfg.rotor_min_source_url ?? null,
        observedLabel:  cfg.rotor_min_observed_label ?? null,
      },
      verifiedFields:      cfg.verified_fields ?? [],

      enrichment: {
        status:            cfg.enrichment_status,
        fillRate:          cfg.fill_rate,
        confidenceAvg:     cfg.confidence_avg,
        version:           cfg.enrichment_version,
        lastEnrichedAt:    cfg.last_enriched_at,
        lastVerifiedAt:    cfg.last_verified_at,
        verificationCount: cfg.verification_count,
      },

      engine: engineRow
        ? {
            id:                engineRow._id,
            code:              engineRow.engine_code,
            family:            engineRow.engine_family,
            cylinders:         engineRow.cylinders,
            configuration:     engineRow.configuration,
            displacement_l:    engineRow.displacement_l ?? engineRow.displacement_liters,
            aspiration:        engineRow.aspiration,
            fuel_type:         engineRow.fuel_type,
            fuel_injection:    engineRow.fuel_injection,
            timing_system:     engineRow.timing_system,
            oil_viscosity:     engineRow.oil_viscosity,
            oil_capacity_qts:  engineRow.oil_capacity_qts,
            coolant_type:      engineRow.coolant_type,
            coolant_capacity_qts: engineRow.coolant_capacity_qts,
            spark_plug_quantity:  engineRow.spark_plug_quantity,
            spark_plug_gap_mm:    engineRow.spark_plug_gap_mm,
            water_pump_timing_driven: engineRow.water_pump_timing_driven,
            data_quality:      engineRow.data_quality,
            last_enriched_at:  engineRow.last_enriched_at,
          }
        : null,

      transmission: transRow
        ? {
            id:                transRow._id,
            type:              transRow.transmission_type ?? transRow.type,
            code:              transRow.code,
            speeds:            transRow.speeds,
            manufacturer:      transRow.manufacturer,
            fluid_type:        transRow.fluid_type,
            fluid_capacity_drain_fill_qts: transRow.fluid_capacity_drain_fill_qts,
            is_lifetime_fill:  transRow.is_lifetime_fill,
            has_serviceable_filter: transRow.has_serviceable_filter,
            service_method:    transRow.service_method,
            data_quality:      transRow.data_quality,
          }
        : null,

      drivetrainConfig: drivetrain
        ? {
            drivetrain_type:         drivetrain.drivetrain_type,
            has_differential:        drivetrain.has_differential,
            diff_fluid_type:         drivetrain.diff_fluid_type,
            diff_fluid_capacity_qts: drivetrain.diff_fluid_capacity_qts,
            lsd_additive_required:   drivetrain.lsd_additive_required,
            has_transfer_case:       drivetrain.has_transfer_case,
            tc_fluid_type:           drivetrain.tc_fluid_type,
            tc_fluid_capacity_qts:   drivetrain.tc_fluid_capacity_qts,
            data_quality:            drivetrain.data_quality,
          }
        : null,

      trimSpecs: trimSpecs
        ? {
            tire_size_front: trimSpecs.tire_size_front,
            tire_size_rear:  trimSpecs.tire_size_rear,
            recommended_tire_pressure_front_psi: trimSpecs.recommended_tire_pressure_front_psi,
            recommended_tire_pressure_rear_psi:  trimSpecs.recommended_tire_pressure_rear_psi,
            is_staggered:    trimSpecs.is_staggered,
            tire_directional: trimSpecs.tire_directional,
            is_run_flat:     trimSpecs.is_run_flat,
            alignment_type:  trimSpecs.alignment_type,
            tire_options:    trimSpecs.tire_options ?? [],
            tire_options_source: trimSpecs.tire_options_source,
          }
        : null,

      chassisSpecs: chassisSpecs
        ? {
            chassis_code:             chassisSpecs.chassis_code,
            brake_fluid_type:         chassisSpecs.brake_fluid_type,
            brake_fluid_capacity_oz:  chassisSpecs.brake_fluid_capacity_oz,
            ps_fluid_type:            chassisSpecs.ps_fluid_type,
            ps_fluid_capacity_oz:     chassisSpecs.ps_fluid_capacity_oz,
            lug_nut_torque_ft_lbs:    chassisSpecs.lug_nut_torque_ft_lbs,
            wiper_blade_driver_size_in:    chassisSpecs.wiper_blade_driver_size_in,
            wiper_blade_passenger_size_in: chassisSpecs.wiper_blade_passenger_size_in,
            wiper_blade_rear_size_in:      chassisSpecs.wiper_blade_rear_size_in,
            battery_group:            chassisSpecs.battery_group,
            battery_type:             chassisSpecs.battery_type,
            steering_type:            chassisSpecs.steering_type,
            parking_brake_type:       chassisSpecs.parking_brake_type,
            has_rear_wiper:           chassisSpecs.has_rear_wiper,
            has_brake_pad_sensor:     chassisSpecs.has_brake_pad_sensor,
            data_quality:             chassisSpecs.data_quality,
            last_enriched_at:         chassisSpecs.last_enriched_at,
          }
        : null,

      packages: cfg.packages_available ?? [],
      serviceIntervals,
      manuals,
      manualBackedIntervals,
      laborTimes,
      fitmentSummary,
      fitmentTotal: fitments.length,

      enrichmentRuns: enrichmentRuns.map((r) => ({
        id:                r._id,
        version:           r.version,
        trigger:           r.trigger,
        status:            r.status,
        fillRate:          r.fill_rate,
        fieldsFilled:      r.fields_filled,
        fieldsTotal:       r.fields_total,
        durationMs:        r.duration_ms,
        startedAt:         r.started_at,
        completedAt:       r.completed_at,
        createdAt:         r.created_at,
        scrapeCacheHit:    r.scrape_cache_hit,
        errors:            r.errors,
        fieldGaps:         r.field_gaps,
        quotability:       r.quotability,
        totalTokensIn:     r.total_tokens_in,
        totalTokensOut:    r.total_tokens_out,
        estimatedCostUsd:  r.estimated_cost_usd,
      })),
      latestRepriceAudit,

      vehicles:       vehicleSample,
      vehicleCount:   vehicles.length,

      clonedFromConfigId: cfg.cloned_from_config_id,
    };
  },
});
