import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { partFitsConfigMake } from "./partSelector";
import { makesSameFamily } from "./vehicleEnrichment/contentSanitization";
import { normalizeOemNumber } from "./vehicleEnrichment/priceParser";
import { accrueVehiclePreference } from "./shop_part_preferences";

/**
 * fitments.ts - Unified part fitment access layer
 *
 * All fitments now use the unified `part_fitments` table keyed by vehicle_config_id.
 * Replaces the old engine_part_fitments, transmission_part_fitments, trim_part_fitments tables.
 */

const ROLE_ALLOWLIST = [
  "oil_filter",
  "spark_plug",
  "serpentine_belt",
  "engine_air_filter",
  "cabin_air_filter",
  "oil_drain_plug_gasket",
  "battery",
  "front_brake_pad",
  "rear_brake_pad",
  "front_brake_rotor",
  "rear_brake_rotor",
  "wiper_blade_driver",
  "wiper_blade_passenger",
  "wiper_blade_rear",
  "transmission_filter",
  "transmission_pan_gasket",
] as const;

type FitmentRole = (typeof ROLE_ALLOWLIST)[number];

function assertValidRole(role: string): asserts role is FitmentRole {
  if (!ROLE_ALLOWLIST.includes(role as FitmentRole)) {
    throw new Error("That fitment role isn't supported.");
  }
}

const assertConfidence = (value: number) => {
  if (Number.isNaN(value) || value < 0 || value > 1) {
    throw new Error("Confidence score must be between 0 and 1.");
  }
};

const omitUndefined = <T extends Record<string, any>>(record: T): T => {
  const result = {} as any;
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) result[key] = value;
  }
  return result as T;
};

const attachPart = async (ctx: { db: any }, fitment: any) => {
  const part = await ctx.db.get(fitment.part_id);
  return { ...fitment, part };
};

// I1 make guard: drop cross-make contaminant parts
const dropCrossMake = (expanded: any[], config: { make_id?: any } | null) =>
  expanded.filter((f) => !f.part || partFitsConfigMake(f.part.make_id, config?.make_id));

/**
 * Family-aware WRITE guard — mirror of vehicleEnrichment/v3mutations
 * `partMakeCompatibleForWrite`. Refuses to write a fitment for a part whose make
 * FAMILY differs from the config's (e.g. a Ford Motorcraft battery on an Alfa
 * config). Universal parts (null make_id) and corporate siblings (VAG, Mopar,
 * Honda/Acura) pass — those catalogs genuinely share numbers. The read-time
 * dropCrossMake + serviceParts guard are the backstop; this stops the
 * contamination from being stored at all through these (legacy/manual) writers.
 */
async function assertMakeCompatibleForWrite(
  ctx: { db: any },
  part: { make_id?: any } | null,
  config: { make_id?: any } | null,
) {
  if (!part || partFitsConfigMake(part.make_id, config?.make_id)) return;
  const [partMake, configMake] = await Promise.all([
    part.make_id ? ctx.db.get(part.make_id) : null,
    config?.make_id ? ctx.db.get(config.make_id) : null,
  ]);
  if (makesSameFamily((partMake as any)?.name, (configMake as any)?.name)) return;
  throw new Error(
    `Refusing cross-make fitment: part make "${(partMake as any)?.name ?? part.make_id}" ` +
      `is not compatible with config make "${(configMake as any)?.name ?? config?.make_id}".`,
  );
}

// -----------------------------------------------------------------------------
// Upsert fitment (unified)
// -----------------------------------------------------------------------------

/**
 * Mark all base (non-package) part_fitments for a (config, service) pair as
 * mechanic_verified. Called from the post-job flow when a mechanic confirms
 * the OEM-recommended parts were the parts actually used.
 */
export const markVerified = mutation({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
    service_type: v.string(),
    part_ids: v.optional(v.array(v.id("oem_parts"))),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("part_fitments")
      .withIndex("by_config_service", (q) =>
        q
          .eq("vehicle_config_id", args.vehicle_config_id)
          .eq("service_type", args.service_type),
      )
      .collect();
    const filterSet = args.part_ids ? new Set(args.part_ids) : null;
    let count = 0;
    for (const row of rows) {
      if (row.package_code != null) continue;
      if (filterSet && !filterSet.has(row.part_id)) continue;
      if (row.mechanic_verified) continue;
      await ctx.db.patch(row._id, { mechanic_verified: true });
      count += 1;
    }
    return { verified_count: count };
  },
});

// -----------------------------------------------------------------------------
// Mechanic pre-job parts fill-in
// -----------------------------------------------------------------------------

async function getCurrentUser(ctx: { db: any; auth: any }) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) => q.eq("clerkUserId", identity.subject))
    .unique();
  if (!user) throw new Error("User not found");
  return user;
}

async function requireShopStaff(ctx: { db: any }, userId: any, shopId: any) {
  const shopUser = await ctx.db
    .query("shop_users")
    .withIndex("by_user_and_shop", (q: any) =>
      q.eq("user_id", userId).eq("shop_id", shopId),
    )
    .first();
  if (shopUser && shopUser.is_active) return shopUser;
  const ownedShop = await ctx.db
    .query("shops")
    .withIndex("by_owner_user_id", (q: any) => q.eq("owner_user_id", userId))
    .filter((q: any) => q.eq(q.field("_id"), shopId))
    .first();
  if (ownedShop) return { user_id: userId, shop_id: shopId, role: "owner", is_active: true };
  throw new Error("Not authorized for this shop");
}

/** Find the booking's service whose slug matches (dash/underscore insensitive). */
async function serviceIdForSlug(
  ctx: { db: any },
  booking: any,
  serviceSlug: string,
): Promise<Id<"services"> | null> {
  const want = serviceSlug.replace(/-/g, "_");
  for (const sid of booking.service_ids ?? []) {
    const svc = await ctx.db.get(sid);
    if (svc?.slug && svc.slug.replace(/-/g, "_") === want) return sid;
  }
  return null;
}

/**
 * Non-blocking Director review row for a mechanic's pre-job part correction.
 * Audit-only: the catalog write already happened; a reject won't roll it back.
 * Kept on its OWN job_id namespace (`partverify:<booking>`) so it never
 * collides with the pre-job SURVEY row (which patches its `verifications`
 * wholesale and would otherwise wipe these entries).
 */
async function logPartVerification(
  ctx: { db: any },
  {
    booking,
    vehicleConfigId,
    serviceId,
    roleKey,
    ourValue,
    oemNumber,
    now,
  }: {
    booking: any;
    vehicleConfigId: Id<"vehicle_configs">;
    serviceId: Id<"services"> | null;
    roleKey: string;
    ourValue: string;
    oemNumber: string;
    now: number;
  },
) {
  try {
    const mechanicId = booking?.mechanic_id;
    if (!mechanicId) return; // mapRow joins mechanic — skip dead rows
    const jobKey = `partverify:${String(booking._id)}`;
    const entry = {
      field_name: `part:${roleKey}`,
      our_value: ourValue,
      status: "corrected" as const,
      corrected_value: oemNumber,
    };

    const existing = await ctx.db
      .query("mechanic_verifications")
      .withIndex("by_job", (q: any) => q.eq("job_id", jobKey))
      .collect();
    const openRow = existing.find(
      (r: any) =>
        r.status === "pending" &&
        String(r.vehicle_config_id) === String(vehicleConfigId),
    );

    if (openRow) {
      const others = (openRow.verifications ?? []).filter(
        (v: any) => v.field_name !== entry.field_name,
      );
      await ctx.db.patch(openRow._id, {
        verifications: [...others, entry],
        verified_at: now,
      });
      return;
    }

    await ctx.db.insert("mechanic_verifications", {
      mechanic_id: mechanicId,
      vehicle_config_id: vehicleConfigId,
      job_id: jobKey,
      service_id: serviceId ?? undefined,
      verifications: [entry],
      overall_accuracy: 0.5, // "needs_correction" — a spec gap was filled
      status: "pending",
      verified_at: now,
      created_at: now,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[mechanic_verifications] part verify logging skipped: ${message}`);
  }
}

/**
 * A mechanic confirms/fills the OEM part for a MISSING or LOW_CONFIDENCE core
 * role during the pre-job inspection. Writes a permanent `mechanic_verified`
 * fitment (un-drops the part past the OEM-strict guard for THIS config), pins
 * the choice VIN-sticky (so a different car of the same config isn't forced
 * onto it), and logs a non-blocking Director review row.
 *
 * The fitment is keyed by SERVICE SLUG (not role key) with role identity on
 * `oem_parts.subcategory`, matching what `resolveWinningPartForService` reads.
 */
export const verifyPartForBooking = mutation({
  args: {
    bookingId: v.id("bookings"),
    serviceSlug: v.string(),
    roleKey: v.string(),
    mode: v.union(v.literal("confirm_existing"), v.literal("freehand")),
    partId: v.optional(v.id("oem_parts")),
    oemNumber: v.optional(v.string()),
    partName: v.optional(v.string()),
    quantityNeeded: v.optional(v.number()),
    position: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");
    await requireShopStaff(ctx, user._id, booking.shop_id);

    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q: any) => q.eq("vin", booking.vin))
      .first();
    if (!vehicle?.vehicle_config_id) {
      throw new Error("This vehicle has no resolved configuration to attach a part to.");
    }
    const configId = vehicle.vehicle_config_id as Id<"vehicle_configs">;
    const config = await ctx.db.get(configId);
    const configMakeId = config?.make_id ?? null;

    // Underscore form — the resolver queries fitments under both slug forms but
    // the v3 pipeline canonicalizes to underscore, so match it.
    const serviceType = args.serviceSlug.replace(/-/g, "_");
    const now = Date.now();

    // ── 1+2. Find-or-create part + write the mechanic_verified fitment ────────
    const { partId, oldOem, oemNumber } = await writeMechanicVerifiedFitment(ctx, {
      configId,
      configMakeId,
      serviceType,
      roleKey: args.roleKey,
      mode: args.mode,
      partId: args.partId,
      oemNumber: args.oemNumber,
      partName: args.partName,
      quantityNeeded: args.quantityNeeded,
      position: args.position,
      now,
    });

    // ── 3. VIN-sticky pin (per-car choice) ───────────────────────────────────
    const serviceId = await serviceIdForSlug(ctx, booking, args.serviceSlug);
    if (serviceId) {
      await accrueVehiclePreference(ctx, {
        vin: booking.vin,
        serviceId,
        partId,
        intent: "use",
        usedAt: now,
      });
    }

    // ── 4. Non-blocking Director review row ──────────────────────────────────
    await logPartVerification(ctx, {
      booking,
      vehicleConfigId: configId,
      serviceId,
      roleKey: args.roleKey,
      ourValue: args.mode === "freehand" ? "—" : oldOem,
      oemNumber,
      now,
    });

    return { ok: true, partId };
  },
});

/**
 * Shared write for a human-asserted part: find-or-create the `oem_parts` row,
 * then write/patch a SLUG-KEYED `mechanic_verified` fitment for the config so
 * `resolveWinningPartForService` re-reads it (un-dropping it past the OEM-strict
 * guard). Used by both the mechanic pre-job flow and the director "Add part".
 */
export async function writeMechanicVerifiedFitment(
  ctx: { db: any },
  args: {
    configId: Id<"vehicle_configs">;
    configMakeId: Id<"makes"> | null;
    serviceType: string; // underscore slug
    roleKey: string;
    mode: "confirm_existing" | "freehand";
    partId?: Id<"oem_parts">;
    oemNumber?: string;
    partName?: string;
    quantityNeeded?: number;
    position?: string;
    now: number;
  },
): Promise<{ partId: Id<"oem_parts">; oldOem: string; oemNumber: string }> {
  const now = args.now;

  // Resolve the target oem_parts row.
  let partId: Id<"oem_parts">;
  if (args.mode === "confirm_existing") {
    if (!args.partId) throw new Error("No part was selected to confirm.");
    partId = args.partId;
  } else {
    const raw = (args.oemNumber ?? "").trim();
    if (!raw) throw new Error("Enter the OEM part number.");
    const normalized = normalizeOemNumber(raw);

    let found =
      (await ctx.db
        .query("oem_parts")
        .withIndex("by_part_number_normalized", (q: any) =>
          q.eq("oem_part_number_normalized", normalized),
        )
        .first()) ?? null;
    if (!found) {
      const byRaw = await ctx.db
        .query("oem_parts")
        .withIndex("by_part_number", (q: any) => q.eq("oem_part_number", raw))
        .first();
      if (byRaw) {
        found = byRaw;
        if (!byRaw.oem_part_number_normalized) {
          await ctx.db.patch(byRaw._id, { oem_part_number_normalized: normalized });
        }
      }
    }

    if (found) {
      partId = found._id;
    } else {
      partId = await ctx.db.insert("oem_parts", {
        oem_part_number: raw,
        oem_part_number_normalized: normalized,
        name: (args.partName ?? raw).trim(),
        subcategory: args.roleKey,
        // Human asserts this part fits THIS make → stamp it so future
        // cross-make quarantine leaves it alone.
        make_id: args.configMakeId ?? undefined,
        part_tier: "oem",
        data_quality: "mechanic_verified",
        is_current: true,
        first_seen_at: now,
        last_confirmed_at: now,
        created_at: now,
      });
    }
  }

  const part = await ctx.db.get(partId);
  if (!part) throw new Error("The OEM part couldn't be found.");
  const oldOem = part.oem_part_number;

  // Ensure role grouping + make guard will accept this part on re-read.
  const partPatch: Record<string, unknown> = {};
  if (!part.subcategory) partPatch.subcategory = args.roleKey;
  if (part.make_id == null && args.configMakeId != null) {
    partPatch.make_id = args.configMakeId;
  }
  if (Object.keys(partPatch).length) await ctx.db.patch(partId, partPatch);

  // Slug-keyed mechanic_verified fitment. Many fitments share
  // (config, service_type) — one per role — so match on part_id, NOT .unique().
  const siblings = await ctx.db
    .query("part_fitments")
    .withIndex("by_config_service", (q: any) =>
      q.eq("vehicle_config_id", args.configId).eq("service_type", args.serviceType),
    )
    .collect();
  const existingFitment = siblings.find(
    (f: any) => String(f.part_id) === String(partId) && f.package_code == null,
  );
  if (existingFitment) {
    await ctx.db.patch(existingFitment._id, {
      mechanic_verified: true,
      confidence: 1,
      quantity_needed: args.quantityNeeded ?? existingFitment.quantity_needed,
      position: args.position ?? existingFitment.position,
      last_confirmed_at: now,
    });
  } else {
    await ctx.db.insert("part_fitments", {
      part_id: partId,
      vehicle_config_id: args.configId,
      service_type: args.serviceType,
      quantity_needed: args.quantityNeeded ?? 1,
      position: args.position,
      service_role: "core",
      confidence: 1,
      mechanic_verified: true,
      data_quality: "mechanic_verified",
      first_confirmed_at: now,
      last_confirmed_at: now,
      created_at: now,
    });
  }

  return { partId, oldOem, oemNumber: part.oem_part_number };
}

/**
 * Mechanic marks a gap service as NOT APPLICABLE to this vehicle (e.g. sealed
 * transmission → no transmission-filter service). Persists a
 * `config_service_exclusions` row so the pre-job gate stops demanding it on
 * future jobs for this config. Idempotent per (config, service).
 */
export const markServiceNotApplicable = mutation({
  args: {
    bookingId: v.id("bookings"),
    serviceSlug: v.string(),
    roleKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");
    await requireShopStaff(ctx, user._id, booking.shop_id);

    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q: any) => q.eq("vin", booking.vin))
      .first();
    if (!vehicle?.vehicle_config_id) {
      throw new Error("This vehicle has no resolved configuration.");
    }
    const configId = vehicle.vehicle_config_id as Id<"vehicle_configs">;
    const slug = args.serviceSlug.replace(/-/g, "_");

    const existing = await ctx.db
      .query("config_service_exclusions")
      .withIndex("by_config_service", (q: any) =>
        q.eq("vehicle_config_id", configId).eq("service_slug", slug),
      )
      .first();
    if (existing) return { ok: true };

    await ctx.db.insert("config_service_exclusions", {
      vehicle_config_id: configId,
      service_slug: slug,
      role_key: args.roleKey,
      marked_by_mechanic_id: booking.mechanic_id ?? undefined,
      booking_id: args.bookingId,
      reason: "mechanic_not_applicable",
      created_at: Date.now(),
    });
    return { ok: true };
  },
});


export const upsertPartFitment = mutation({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
    part_id: v.id("oem_parts"),
    service_type: v.string(),
    quantity_needed: v.optional(v.number()),
    position: v.optional(v.string()),
    confidence: v.number(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    assertValidRole(args.service_type);
    assertConfidence(args.confidence);

    const part = await ctx.db.get(args.part_id);
    if (!part) throw new Error("The OEM part you referenced couldn't be found.");

    const config = await ctx.db.get(args.vehicle_config_id);
    await assertMakeCompatibleForWrite(ctx, part, config);

    const existing = await ctx.db
      .query("part_fitments")
      .withIndex("by_config_service", (q) =>
        q.eq("vehicle_config_id", args.vehicle_config_id).eq("service_type", args.service_type)
      )
      .unique();

    const payload = omitUndefined({
      part_id: args.part_id,
      service_type: args.service_type,
      quantity_needed: args.quantity_needed,
      position: args.position,
      confidence: args.confidence,
    });

    if (existing) {
      await ctx.db.patch(existing._id, payload);
      return await ctx.db.get(existing._id);
    }

    const fitmentId = await ctx.db.insert("part_fitments", {
      ...payload,
      vehicle_config_id: args.vehicle_config_id,
      created_at: Date.now(),
    });
    return await ctx.db.get(fitmentId);
  },
});

// -----------------------------------------------------------------------------
// List fitments for a vehicle config
// -----------------------------------------------------------------------------

export const listFitments = query({
  args: { vehicle_config_id: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicle_config_id))
      .collect();
  },
});

export const listFitmentsExpanded = query({
  args: { vehicle_config_id: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicle_config_id))
      .collect();
    const config = await ctx.db.get(args.vehicle_config_id);
    const expanded = await Promise.all(fitments.map((f) => attachPart(ctx, f)));
    return dropCrossMake(expanded, config);
  },
});

// -----------------------------------------------------------------------------
// Legacy-compatible aliases (engine/transmission/trim fitments)
// These resolve the vehicle_config_id from the component ID, then query part_fitments.
// -----------------------------------------------------------------------------

export const upsertEnginePartFitment = mutation({
  args: {
    engine_id: v.id("engines"),
    part_id: v.id("oem_parts"),
    role: v.string(),
    quantity: v.optional(v.number()),
    spark_plug_gap_mm: v.optional(v.number()),
    notes: v.optional(v.string()),
    confidence_score: v.number(),
  },
  handler: async (ctx, args) => {
    assertValidRole(args.role);
    assertConfidence(args.confidence_score);

    const part = await ctx.db.get(args.part_id);
    if (!part) throw new Error("The OEM part you referenced couldn't be found.");

    // Find vehicle_config that uses this engine
    const config = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_engine", (q) => q.eq("engine_id", args.engine_id))
      .first();

    if (!config) {
      throw new Error("We couldn't find a matching engine configuration for this vehicle.");
    }
    await assertMakeCompatibleForWrite(ctx, part, config);

    const existing = await ctx.db
      .query("part_fitments")
      .withIndex("by_config_service", (q) =>
        q.eq("vehicle_config_id", config._id).eq("service_type", args.role)
      )
      .unique();

    const payload = omitUndefined({
      part_id: args.part_id,
      service_type: args.role,
      quantity_needed: args.quantity,
      position: args.spark_plug_gap_mm ? `gap_mm:${args.spark_plug_gap_mm}` : undefined,
      confidence: args.confidence_score,
    });

    if (existing) {
      await ctx.db.patch(existing._id, payload);
      return await ctx.db.get(existing._id);
    }

    const fitmentId = await ctx.db.insert("part_fitments", {
      ...payload,
      vehicle_config_id: config._id,
      created_at: Date.now(),
    });
    return await ctx.db.get(fitmentId);
  },
});

export const listEngineFitments = query({
  args: { engine_id: v.id("engines") },
  handler: async (ctx, args) => {
    const config = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_engine", (q) => q.eq("engine_id", args.engine_id))
      .first();
    if (!config) return [];
    return await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", config._id))
      .collect();
  },
});

export const listEngineFitmentsExpanded = query({
  args: { engine_id: v.id("engines") },
  handler: async (ctx, args) => {
    const config = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_engine", (q) => q.eq("engine_id", args.engine_id))
      .first();
    if (!config) return [];
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", config._id))
      .collect();
    const expanded = await Promise.all(fitments.map((f) => attachPart(ctx, f)));
    return dropCrossMake(expanded, config);
  },
});

export const upsertTransmissionPartFitment = mutation({
  args: {
    transmission_id: v.id("transmissions"),
    part_id: v.id("oem_parts"),
    role: v.string(),
    quantity: v.optional(v.number()),
    notes: v.optional(v.string()),
    confidence_score: v.number(),
  },
  handler: async (ctx, args) => {
    assertValidRole(args.role);
    assertConfidence(args.confidence_score);

    const part = await ctx.db.get(args.part_id);
    if (!part) throw new Error("The OEM part you referenced couldn't be found.");

    // Find vehicle_config via engine → vehicle_configs
    const configs = await ctx.db.query("vehicle_configs").collect();
    const config = configs.find((c: any) => c.transmission_id === args.transmission_id);

    if (!config) {
      throw new Error("We couldn't find a matching transmission configuration for this vehicle.");
    }
    await assertMakeCompatibleForWrite(ctx, part, config);

    const existing = await ctx.db
      .query("part_fitments")
      .withIndex("by_config_service", (q) =>
        q.eq("vehicle_config_id", config._id).eq("service_type", args.role)
      )
      .unique();

    const payload = omitUndefined({
      part_id: args.part_id,
      service_type: args.role,
      quantity_needed: args.quantity,
      confidence: args.confidence_score,
    });

    if (existing) {
      await ctx.db.patch(existing._id, payload);
      return await ctx.db.get(existing._id);
    }

    const fitmentId = await ctx.db.insert("part_fitments", {
      ...payload,
      vehicle_config_id: config._id,
      created_at: Date.now(),
    });
    return await ctx.db.get(fitmentId);
  },
});

export const listTransmissionFitments = query({
  args: { transmission_id: v.id("transmissions") },
  handler: async (ctx, args) => {
    const configs = await ctx.db.query("vehicle_configs").collect();
    const config = configs.find((c: any) => c.transmission_id === args.transmission_id);
    if (!config) return [];
    return await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", config._id))
      .collect();
  },
});

export const listTransmissionFitmentsExpanded = query({
  args: { transmission_id: v.id("transmissions") },
  handler: async (ctx, args) => {
    const configs = await ctx.db.query("vehicle_configs").collect();
    const config = configs.find((c: any) => c.transmission_id === args.transmission_id);
    if (!config) return [];
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", config._id))
      .collect();
    const expanded = await Promise.all(fitments.map((f) => attachPart(ctx, f)));
    return dropCrossMake(expanded, config);
  },
});

export const upsertTrimPartFitment = mutation({
  args: {
    trim_id: v.id("trims"),
    part_id: v.id("oem_parts"),
    role: v.string(),
    quantity: v.optional(v.number()),
    wiper_size_in: v.optional(v.number()),
    notes: v.optional(v.string()),
    confidence_score: v.number(),
  },
  handler: async (ctx, args) => {
    assertValidRole(args.role);
    assertConfidence(args.confidence_score);

    const part = await ctx.db.get(args.part_id);
    if (!part) throw new Error("The OEM part you referenced couldn't be found.");

    // Find vehicle_config via trim name match
    const configs = await ctx.db.query("vehicle_configs").collect();
    const trim = await ctx.db.get(args.trim_id);
    const config = trim
      ? configs.find((c: any) => c.trim_name === trim.name && c.model_id === trim.model_id)
      : null;

    if (!config) {
      throw new Error("We couldn't find a matching trim configuration for this vehicle.");
    }
    await assertMakeCompatibleForWrite(ctx, part, config);

    const existing = await ctx.db
      .query("part_fitments")
      .withIndex("by_config_service", (q) =>
        q.eq("vehicle_config_id", config._id).eq("service_type", args.role)
      )
      .unique();

    const payload = omitUndefined({
      part_id: args.part_id,
      service_type: args.role,
      quantity_needed: args.quantity,
      position: args.wiper_size_in ? `size_in:${args.wiper_size_in}` : undefined,
      confidence: args.confidence_score,
    });

    if (existing) {
      await ctx.db.patch(existing._id, payload);
      return await ctx.db.get(existing._id);
    }

    const fitmentId = await ctx.db.insert("part_fitments", {
      ...payload,
      vehicle_config_id: config._id,
      created_at: Date.now(),
    });
    return await ctx.db.get(fitmentId);
  },
});

export const listTrimFitments = query({
  args: { trim_id: v.id("trims") },
  handler: async (ctx, args) => {
    const configs = await ctx.db.query("vehicle_configs").collect();
    const trim = await ctx.db.get(args.trim_id);
    const config = trim
      ? configs.find((c: any) => c.trim_name === trim.name && c.model_id === trim.model_id)
      : null;
    if (!config) return [];
    return await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", config._id))
      .collect();
  },
});

export const listTrimFitmentsExpanded = query({
  args: { trim_id: v.id("trims") },
  handler: async (ctx, args) => {
    const configs = await ctx.db.query("vehicle_configs").collect();
    const trim = await ctx.db.get(args.trim_id);
    const config = trim
      ? configs.find((c: any) => c.trim_name === trim.name && c.model_id === trim.model_id)
      : null;
    if (!config) return [];
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", config._id))
      .collect();
    const expanded = await Promise.all(fitments.map((f) => attachPart(ctx, f)));
    return dropCrossMake(expanded, config);
  },
});
