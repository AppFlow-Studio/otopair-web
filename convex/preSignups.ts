// =============================================================================
// Pre-signup lead capture (flagship marketing hero)
// =============================================================================
//
// When a visitor finishes the Oto demo on the marketing site and shares their
// email (and ideally a decoded VIN), we create a "presignup-" stub user — the
// SAME shape as a shop walk-in stub (convex/bookings.ts:createByShop), minus
// the booking. The vehicle + vehicle_owners link is attached so that when the
// person later signs up in the app with a matching email, the existing
// claim-on-signup logic (convex/users.ts:upsertFromClerk) migrates the stub
// onto their real Clerk identity — car already attached, smoother onboarding.
//
// No real booking is created here — Oto is only demoing on the marketing page.
//
// ⛔ NEVER trigger vehicle enrichment from this path. These are UNGOVERNED guest
//    sessions (people testing the flagship Oto AI, not authenticated users), so
//    there is no per-user rate limiting or abuse governance. Enrichment is an
//    expensive LLM-backed pipeline (convex/vehicleEnrichment) — running it for
//    every guest VIN would be uncapped spend. We ONLY link an EXISTING
//    vehicle_configs row (by nhtsa_vin_key) and otherwise keep the raw NHTSA
//    decode. The governed walk-in path (convex/bookings.ts:createByShop) is the
//    only place allowed to schedule enrichment.
// =============================================================================

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { buildNhtsaVinKey } from "./vehicleEnrichment/types";

function canonicalVin(vin?: string): string | undefined {
  const c = vin?.trim().toUpperCase();
  return c && /^[A-HJ-NPR-Z0-9]{11,17}$/.test(c) ? c : undefined;
}

function normalizePhoneE164(raw?: string): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (raw.startsWith("+")) return raw;
  return undefined;
}

/**
 * Read-only: does a pre-existing vehicle_config exist for this NHTSA decode?
 * Used by the flagship hero at decode time to show richer specs when we already
 * have them — WITHOUT ever triggering enrichment. Returns display-safe fields
 * only. If no config exists, the caller falls back to the raw NHTSA decode.
 */
export const lookupConfig = query({
  args: {
    year: v.number(),
    make: v.string(),
    model: v.string(),
    trim: v.optional(v.string()),
    displacementL: v.optional(v.number()),
    cylinders: v.optional(v.number()),
    fuelType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const nhtsaKey = buildNhtsaVinKey({
      year: args.year,
      make: args.make,
      model: args.model,
      trim: args.trim,
      displacementL: args.displacementL,
      cylinders: args.cylinders,
      fuelType: args.fuelType,
    });
    const cfg = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_nhtsa_vin_key", (q) => q.eq("nhtsa_vin_key", nhtsaKey))
      .first();
    if (!cfg) return { found: false as const };

    const clean = <T>(x: T | null | undefined): T | undefined =>
      x === null || x === undefined || x === "" ? undefined : x;

    // Engine + oil/coolant/plug specs.
    let engineLabel: string | undefined;
    const eng: Record<string, unknown> = {};
    if (cfg.engine_id) {
      const e = await ctx.db.get(cfg.engine_id);
      if (e) {
        const dispRaw =
          e.displacement_l ??
          (typeof e.displacement_liters === "number"
            ? e.displacement_liters
            : Number(e.displacement_liters));
        const parts: string[] = [];
        if (Number.isFinite(dispRaw) && (dispRaw as number) > 0) {
          parts.push(`${Number(dispRaw).toFixed(1)}L`);
        }
        if (e.configuration) parts.push(e.configuration);
        else if (e.cylinders) parts.push(`${e.cylinders}-cyl`);
        if (e.aspiration && /turbo|super/i.test(e.aspiration)) parts.push(e.aspiration);
        let label = parts.join(" ");
        if (e.engine_code) label = label ? `${label} (${e.engine_code})` : e.engine_code;
        engineLabel = label || undefined;
        eng.engineCode = clean(e.engine_code);
        eng.engineFamily = clean(e.engine_family);
        eng.aspiration = clean(e.aspiration);
        eng.fuelInjection = clean(e.fuel_injection);
        eng.timingSystem = clean(e.timing_system);
        eng.oilViscosity = clean(e.oil_viscosity);
        eng.oilCapacityQts = clean(e.oil_capacity_qts);
        eng.coolantType = clean(e.coolant_type);
        eng.coolantCapacityQts = clean(e.coolant_capacity_qts);
        eng.sparkPlugQty = clean(e.spark_plug_quantity);
        eng.sparkPlugGapMm = clean(e.spark_plug_gap_mm);
      }
    }

    // Transmission.
    let transmission: string | undefined;
    const trans: Record<string, unknown> = {};
    if (cfg.transmission_id) {
      const t = await ctx.db.get(cfg.transmission_id);
      if (t) {
        const speeds = t.speeds ? `${t.speeds}-speed` : "";
        const type = t.transmission_type || t.type || "";
        transmission = [speeds, type].filter(Boolean).join(" ") || t.code || undefined;
        trans.transFluidType = clean(t.fluid_type);
        trans.transManufacturer = clean(t.manufacturer);
        trans.transLifetimeFill = t.is_lifetime_fill === true ? true : undefined;
      }
    }

    // Drivetrain (differential / transfer case).
    const dt = await ctx.db
      .query("drivetrain_configs")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", cfg._id))
      .first();

    // Trim specs (tires / alignment).
    const ts = await ctx.db
      .query("trim_specs")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", cfg._id))
      .first();

    // Chassis specs (brakes / battery / wipers / steering).
    let cs = null;
    if (cfg.chassis_code) {
      cs = await ctx.db
        .query("chassis_specs")
        .withIndex("by_chassis_code", (q) => q.eq("chassis_code", cfg.chassis_code as string))
        .unique();
    }

    // Available OEM tire sizes (deduped front[/rear]).
    const tireOptions: string[] = Array.isArray(ts?.tire_options)
      ? Array.from(
          new Set(
            (ts!.tire_options as Array<{ size_front?: string; size_rear?: string }>)
              .map((o) => {
                if (!o.size_front) return null;
                const rear =
                  o.size_rear && o.size_rear !== o.size_front ? ` / ${o.size_rear}` : "";
                return `${o.size_front}${rear}`;
              })
              .filter((x): x is string => Boolean(x))
          )
        )
      : [];

    const packages = Array.isArray(cfg.packages_available)
      ? cfg.packages_available.map((p) => p.label).filter(Boolean)
      : [];

    return {
      found: true as const,
      trim: cfg.trim_name ?? undefined,
      drivetrain: cfg.drivetrain ?? undefined,
      engineLabel,
      packagesCount: packages.length,
      // The richer "beyond a basic VIN decode" marketing spec set.
      specs: {
        ...eng,
        ...trans,
        transmission,
        drivetrain: clean(cfg.drivetrain),
        diffFluidType: clean(dt?.diff_fluid_type),
        hasTransferCase: dt?.has_transfer_case === true ? true : undefined,
        // Tires
        tireFront: clean(ts?.tire_size_front),
        tireRear: clean(ts?.tire_size_rear),
        tirePressureFront: clean(ts?.recommended_tire_pressure_front_psi),
        tirePressureRear: clean(ts?.recommended_tire_pressure_rear_psi),
        runFlat: ts?.is_run_flat === true ? true : undefined,
        staggered: ts?.is_staggered === true ? true : undefined,
        alignmentType: clean(ts?.alignment_type),
        tireOptions,
        // Brakes / battery / chassis
        brakeFluidType: clean(cs?.brake_fluid_type ?? cfg.brake_fluid_type),
        psFluidType: clean(cs?.ps_fluid_type ?? cfg.ps_fluid_type),
        batteryGroup: clean(cs?.battery_group),
        batteryType: clean(cs?.battery_type),
        steeringType: clean(cs?.steering_type),
        parkingBrakeType: clean(cs?.parking_brake_type),
        chassisCode: clean(cfg.chassis_code),
        packages,
      },
    };
  },
});

export const createStub = mutation({
  args: {
    email: v.string(),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    phone: v.optional(v.string()),
    vin: v.optional(v.string()),
    year: v.optional(v.number()),
    make: v.optional(v.string()),
    model: v.optional(v.string()),
    trim: v.optional(v.string()),
    displacementL: v.optional(v.number()),
    cylinders: v.optional(v.number()),
    fuelType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const email = args.email.trim().toLowerCase();
    if (!email || !email.includes("@")) {
      throw new Error("A valid email is required.");
    }
    const vin = canonicalVin(args.vin);
    const phone = normalizePhoneE164(args.phone);

    // Resolve the user row to attach to.
    const existing = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();

    let userId;
    let isRealUser = false;

    if (existing) {
      const clerkId = String(existing.clerkUserId ?? "");
      const isStub =
        clerkId.startsWith("presignup-") || clerkId.startsWith("shop-created-");
      userId = existing._id;
      isRealUser = !isStub;
      if (isStub) {
        // Refresh stub contact details with anything new we collected.
        await ctx.db.patch(existing._id, {
          first_name: args.firstName ?? existing.first_name,
          last_name: args.lastName ?? existing.last_name,
          phone: phone ?? existing.phone,
          lastUpdated: now,
        });
      }
    } else {
      const randomSuffix = Math.random().toString(36).slice(2, 8);
      userId = await ctx.db.insert("users", {
        clerkUserId: `presignup-${now}-${randomSuffix}`,
        email,
        phone,
        first_name: args.firstName,
        last_name: args.lastName,
        onboardingCompleted: false,
        essentialOnboardingCompleted: false,
        createdAt: now,
      });
    }

    // Attach the decoded vehicle (mirror the walk-in path) — but NEVER enrich.
    // If a vehicle_config already exists for this NHTSA key, link it so the
    // user inherits the richer spec data on signup. If none exists, we keep
    // only the raw NHTSA decode and do NOT kick off enrichment.
    let vehicleAttached = false;
    let configLinked = false;
    if (vin) {
      let matchedConfigId: Id<"vehicle_configs"> | undefined;
      if (args.year && args.make && args.model) {
        const nhtsaKey = buildNhtsaVinKey({
          year: args.year,
          make: args.make,
          model: args.model,
          trim: args.trim,
          displacementL: args.displacementL,
          cylinders: args.cylinders,
          fuelType: args.fuelType,
        });
        const cfg = await ctx.db
          .query("vehicle_configs")
          .withIndex("by_nhtsa_vin_key", (q) => q.eq("nhtsa_vin_key", nhtsaKey))
          .first();
        matchedConfigId = cfg?._id;
        configLinked = Boolean(cfg);
      }

      const vehicle = await ctx.db
        .query("vehicles")
        .withIndex("by_vin", (q) => q.eq("vin", vin))
        .first();

      if (!vehicle) {
        await ctx.db.insert("vehicles", {
          vin,
          year: args.year,
          metadata: { make: args.make, model: args.model, trim: args.trim },
          ...(matchedConfigId ? { vehicle_config_id: matchedConfigId } : {}),
          created_at: now,
          updated_at: now,
        });
      } else if (matchedConfigId && !vehicle.vehicle_config_id) {
        // Backfill the config link on an existing bare vehicle row.
        await ctx.db.patch(vehicle._id, {
          vehicle_config_id: matchedConfigId,
          updated_at: now,
        });
      }

      const link = await ctx.db
        .query("vehicle_owners")
        .withIndex("by_vin_user", (q) => q.eq("vin", vin).eq("user_id", userId))
        .first();
      if (!link) {
        await ctx.db.insert("vehicle_owners", {
          vin,
          user_id: userId,
          status: "active",
          is_primary: true,
          added_at: now,
        });
      }
      vehicleAttached = true;
    }

    // Never leak the internal id; the client only needs a success signal.
    return { ok: true, isRealUser, vehicleAttached, configLinked };
  },
});
