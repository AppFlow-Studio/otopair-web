import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { applyBookingStatusTransition } from "./bookings";
import {
  ensureJobActualRecord,
  finalizeJobActuals,
  getLatestJobActualForBooking,
  jobActualInputValidator,
  jobActualPartValidator,
  reopenJobActuals,
  saveJobActualDraft,
} from "./lib/job_actuals";
import { summarizePartPrices } from "./part_prices";

function primaryServiceId(booking: { service_ids?: Id<"services">[] }): Id<"services"> | undefined {
  return booking.service_ids?.[0];
}

type SuggestedPart = {
  part_name: string;
  oem_number: string;
  cost: number;
};

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Three-layer prefill cascade for the post-job parts step.
 *
 *   Layer 1 — Shop preferences: parts where this shop has crossed the
 *             use-count default threshold for this (service, config).
 *             Cost = median of this shop's recent unit_costs for that part.
 *
 *   Layer 2 — Cross-shop aggregate: top-N parts other shops use for the
 *             same (service, config), ranked by use_count, with median
 *             unit_cost. Only fires once sample crosses the min threshold.
 *
 * If both miss, returns []. The caller falls through to the legacy
 * service_vehicle_specs slug-based suggestion as the catalog floor.
 */
async function resolveSuggestedPartsFromCascade(
  ctx: any,
  {
    shopId,
    serviceId,
    vehicleConfigId,
  }: {
    shopId: Id<"shops">;
    serviceId: Id<"services">;
    vehicleConfigId: Id<"vehicle_configs">;
  },
): Promise<SuggestedPart[]> {
  // Layer 1
  const prefs = await ctx.db
    .query("shop_part_preferences")
    .withIndex("by_shop_service_config", (q: any) =>
      q
        .eq("shop_id", shopId)
        .eq("service_id", serviceId)
        .eq("vehicle_config_id", vehicleConfigId),
    )
    .collect();
  const defaults = prefs.filter((p: any) => p.is_default);

  if (defaults.length > 0) {
    // Pull this shop's recent snapshots once and bucket by part_id so we can
    // compute a realistic suggested cost for each preferred part.
    const shopSnapshots = await ctx.db
      .query("part_snapshots")
      .withIndex("by_shop_service_config", (q: any) =>
        q
          .eq("shop_id", shopId)
          .eq("service_id", serviceId)
          .eq("vehicle_config_id", vehicleConfigId),
      )
      .order("desc")
      .take(50);

    const costsByPart = new Map<string, number[]>();
    for (const snap of shopSnapshots as any[]) {
      if (snap.superseded_by_id !== undefined) continue;
      if (snap.supplied_by !== "shop") continue;
      if (!snap.part_id) continue;
      const key = snap.part_id as unknown as string;
      const bucket = costsByPart.get(key) ?? [];
      bucket.push(snap.unit_cost);
      costsByPart.set(key, bucket);
    }

    const suggestions: SuggestedPart[] = [];
    for (const pref of defaults) {
      const part = await ctx.db.get(pref.part_id);
      if (!part) continue;
      const costs = costsByPart.get(pref.part_id as unknown as string) ?? [];
      suggestions.push({
        part_name: part.name,
        oem_number: part.oem_part_number,
        cost: medianOf(costs),
      });
    }
    if (suggestions.length > 0) return suggestions;
  }

  // Layer 2 — cross-shop aggregate. Min sample of 5 to avoid noise.
  const crossShop = await ctx.db
    .query("part_snapshots")
    .withIndex("by_service_config", (q: any) =>
      q.eq("service_id", serviceId).eq("vehicle_config_id", vehicleConfigId),
    )
    .collect();

  const eligible = (crossShop as any[]).filter(
    (row) =>
      row.superseded_by_id === undefined &&
      row.supplied_by === "shop" &&
      row.part_id !== undefined,
  );
  if (eligible.length < 5) return [];

  const byPart = new Map<
    string,
    { part_id: Id<"oem_parts">; count: number; costs: number[] }
  >();
  for (const row of eligible) {
    const key = row.part_id as unknown as string;
    const bucket = byPart.get(key);
    if (bucket) {
      bucket.count += 1;
      bucket.costs.push(row.unit_cost);
    } else {
      byPart.set(key, {
        part_id: row.part_id as Id<"oem_parts">,
        count: 1,
        costs: [row.unit_cost],
      });
    }
  }

  const ranked = Array.from(byPart.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 2);

  const suggestions: SuggestedPart[] = [];
  for (const entry of ranked) {
    const part = await ctx.db.get(entry.part_id);
    if (!part) continue;
    suggestions.push({
      part_name: part.name,
      oem_number: part.oem_part_number,
      cost: medianOf(entry.costs),
    });
  }
  return suggestions;
}

async function getCurrentUser(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");

  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) => q.eq("clerkUserId", identity.subject))
    .unique();

  if (!user) throw new Error("User not found");
  return user;
}

async function requireShopStaff(ctx: any, userId: any, shopId: any) {
  const shopUser = await ctx.db
    .query("shop_users")
    .withIndex("by_user_and_shop", (q: any) =>
      q.eq("user_id", userId).eq("shop_id", shopId)
    )
    .first();

  if (shopUser && shopUser.is_active) {
    return shopUser;
  }

  const ownedShop = await ctx.db
    .query("shops")
    .withIndex("by_owner_user_id", (q: any) => q.eq("owner_user_id", userId))
    .filter((q: any) => q.eq(q.field("_id"), shopId))
    .first();

  if (ownedShop) {
    return {
      user_id: userId,
      shop_id: shopId,
      role: "owner",
      is_active: true,
    };
  }

  throw new Error("Not authorized for this shop");
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("job_actuals").collect();
  },
});

export const getById = query({
  args: { id: v.id("job_actuals") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getByBookingId = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) return null;

    await requireShopStaff(ctx, user._id, booking.shop_id);
    if (booking.status !== "vehicle_at_shop" && booking.status !== "in_progress") {
      throw new Error("Mark the vehicle here before starting work.");
    }

    return await getLatestJobActualForBooking(ctx, args.bookingId);
  },
});

export const getPostjobReportForBooking = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) return null;

    await requireShopStaff(ctx, user._id, booking.shop_id);

    const actual = await getLatestJobActualForBooking(ctx, args.bookingId);
    if (!actual) return null;

    return {
      postjobReport: actual.postjob_report ?? null,
      submittedAt: actual.updated_at ?? actual._creationTime ?? null,
      mechanicId: actual.mechanic_id ?? null,
    };
  },
});

export const getPrefillData = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) return null;

    await requireShopStaff(ctx, user._id, booking.shop_id);

    const serviceId = primaryServiceId(booking);
    const service = serviceId ? await ctx.db.get(serviceId) : null;

    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", booking.vin))
      .unique();
    if (!vehicle) return null;

    const engine = vehicle.engine_id ? await ctx.db.get(vehicle.engine_id) : null;
    if (!engine) return null;

    const trim = await ctx.db.get(engine.trim_id);
    const model = trim ? await ctx.db.get(trim.model_id) : null;
    const make = model ? await ctx.db.get(model.make_id) : null;

    const vehicleLabel = [make?.name, model?.name, trim?.name, vehicle.year]
      .filter(Boolean)
      .join(" ");

    const mechanic = booking.mechanic_id ? await ctx.db.get(booking.mechanic_id) : null;
    const mechanicName = mechanic
      ? `${mechanic.first_name} ${mechanic.last_name}`
      : "Unassigned";

    const allSpecs = await ctx.db.query("service_vehicle_specs").collect();
    const specs = allSpecs.find((row: any) => row.engine_id === engine._id);

    const suggestedParts: Array<{
      part_name: string;
      oem_number: string;
      cost: number;
    }> = [];

    // Layers 1 + 2 of the prefill cascade. If either lands a hit, use those
    // suggestions and skip the legacy slug-based fallback below.
    if (serviceId && vehicle.vehicle_config_id) {
      const cascadeSuggestions = await resolveSuggestedPartsFromCascade(ctx, {
        shopId: booking.shop_id,
        serviceId,
        vehicleConfigId: vehicle.vehicle_config_id,
      });
      if (cascadeSuggestions.length > 0) {
        suggestedParts.push(...cascadeSuggestions);
      }
    }

    // Layer 3 (catalog floor) — only fires if the cascade is empty. Uses the
    // service_vehicle_specs OEM number columns indexed by engine to suggest
    // canonical parts even when there's zero historical data yet.
    if (suggestedParts.length === 0 && specs && service) {
      const slug = service.slug;
      if (slug === "oil-change") {
        suggestedParts.push({
          part_name: "Oil Filter",
          oem_number: specs.oil_filter_oem ?? "",
          cost: 12,
        });
        suggestedParts.push({
          part_name: `Synthetic Oil ${specs.oil_capacity_qts ?? "-"}qt`,
          oem_number: specs.oil_viscocity ?? "",
          cost: 35,
        });
        if (specs.oil_drain_plug_gasket_oem) {
          suggestedParts.push({
            part_name: "Drain Plug Gasket",
            oem_number: specs.oil_drain_plug_gasket_oem,
            cost: 2,
          });
        }
      } else if (slug === "brake-pads") {
        suggestedParts.push({
          part_name: "Front Brake Pads",
          oem_number: specs.front_brake_pad_oem ?? "",
          cost: 45,
        });
        suggestedParts.push({
          part_name: "Rear Brake Pads",
          oem_number: specs.rear_brake_pad_oem ?? "",
          cost: 40,
        });
      } else if (slug === "engine-air-filter" && specs.engine_air_filter_oem) {
        suggestedParts.push({
          part_name: "Engine Air Filter",
          oem_number: specs.engine_air_filter_oem,
          cost: 25,
        });
      } else if (slug === "cabin-air-filter" && specs.cabin_air_filter_oem) {
        suggestedParts.push({
          part_name: "Cabin Air Filter",
          oem_number: specs.cabin_air_filter_oem,
          cost: 22,
        });
      } else if (slug === "spark-plugs" && specs.spark_plug_oem) {
        const qty = specs.spark_plug_quantity ?? 4;
        suggestedParts.push({
          part_name: `Spark Plugs (x${qty})`,
          oem_number: specs.spark_plug_oem,
          cost: 12 * qty,
        });
      } else if (slug === "serpentine-belt" && specs.serpentine_belt_oem) {
        suggestedParts.push({
          part_name: "Serpentine Belt",
          oem_number: specs.serpentine_belt_oem,
          cost: 45,
        });
      } else if (slug === "brake-rotors" && specs.front_brake_rotor_oem) {
        suggestedParts.push({
          part_name: "Front Brake Rotors",
          oem_number: specs.front_brake_rotor_oem ?? "",
          cost: 85,
        });
        if (specs.rear_brake_rotor_oem) {
          suggestedParts.push({
            part_name: "Rear Brake Rotors",
            oem_number: specs.rear_brake_rotor_oem,
            cost: 75,
          });
        }
      }
    }

    // OEM catalog recommendations from part_fitments — one entry per service
    // on the booking. Surfaced in the post-job UI as a confirm-or-swap
    // checklist, so the mechanic can verify the catalog matches reality.
    type OemRecommendationPart = {
      part_id: Id<"oem_parts">;
      oem_part_number: string;
      part_name: string;
      brand: string | null;
      part_tier: string | null;
      category: string | null;
      quantity_needed: number | null;
      position: string | null;
      average_price: number;       // 0 when no price data
      price_sample_size: number;
      price_sources_used: number;
    };
    const oemRecommendations: Array<{
      service_id: Id<"services">;
      service_slug: string;
      service_name: string;
      parts: OemRecommendationPart[];
    }> = [];

    if (vehicle.vehicle_config_id) {
      for (const sid of booking.service_ids ?? []) {
        const svc = await ctx.db.get(sid);
        if (!svc?.slug) continue;
        const fitments = await ctx.db
          .query("part_fitments")
          .withIndex("by_config_service", (q) =>
            q
              .eq("vehicle_config_id", vehicle.vehicle_config_id!)
              .eq("service_type", svc.slug!),
          )
          .collect();
        const parts: OemRecommendationPart[] = [];
        for (const f of fitments) {
          if (f.package_code != null) continue;
          const part = await ctx.db.get(f.part_id);
          if (!part) continue;
          const priceSummary = await summarizePartPrices(ctx, f.part_id);
          parts.push({
            part_id: f.part_id,
            oem_part_number: part.oem_part_number,
            part_name: part.name,
            brand: part.brand ?? null,
            part_tier: part.part_tier ?? null,
            category: part.category ?? null,
            quantity_needed: f.quantity_needed ?? null,
            position: f.position ?? null,
            average_price: priceSummary.average,
            price_sample_size: priceSummary.sample_size,
            price_sources_used: priceSummary.used_sample_size,
          });
        }
        if (parts.length > 0) {
          oemRecommendations.push({
            service_id: sid,
            service_slug: svc.slug,
            service_name: svc.name,
            parts,
          });
        }
      }
    }

    // Merge any OEM-recommended parts that aren't already represented in
    // suggestedParts (by normalized oem_number) so they appear as
    // pre-listed rows in the post-job parts step ready to confirm.
    const normalize = (n: string) => n.trim().toUpperCase().replace(/\s+/g, "");
    const existingOemNumbers = new Set(
      suggestedParts
        .map((p) => p.oem_number)
        .filter(Boolean)
        .map(normalize),
    );
    for (const rec of oemRecommendations) {
      for (const part of rec.parts) {
        const key = normalize(part.oem_part_number);
        if (!key || existingOemNumbers.has(key)) continue;
        suggestedParts.push({
          part_name: part.part_name,
          oem_number: part.oem_part_number,
          cost: part.average_price,
        });
        existingOemNumbers.add(key);
      }
    }

    // Prior open recommendations for the same VIN (shop-scoped). Surfaced as
    // a muted "last visit said…" strip at the top of the post-job step so
    // the mechanic has memory aids — actual confirmation happens in pre-job.
    const priorRecRows = booking.shop_id
      ? (
          await ctx.db
            .query("job_recommendations")
            .withIndex("by_vehicle_and_status", (q) =>
              q.eq("vehicle_vin", booking.vin).eq("status", "open"),
            )
            .collect()
        )
          .filter((r) => String(r.shop_id) === String(booking.shop_id))
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, 5)
      : [];
    const priorOpenRecommendations = await Promise.all(
      priorRecRows.map(async (rec) => {
        const svc = rec.recommended_service_id
          ? await ctx.db.get(rec.recommended_service_id)
          : null;
        return {
          _id: rec._id,
          service_name: svc?.name ?? rec.freeform_text ?? "Unspecified",
          is_freeform: !rec.recommended_service_id,
          urgency: rec.urgency,
          reason: rec.reason ?? null,
          created_at: rec.created_at,
        };
      }),
    );

    return {
      vehicleLabel,
      serviceName: service?.name ?? "",
      serviceSlug: service?.slug ?? "",
      engineCode: engine.engine_code,
      engineId: engine._id,
      serviceId,
      mechanicName,
      suggestedParts,
      oemRecommendations,
      vehicleConfigId: vehicle.vehicle_config_id ?? null,
      priorOpenRecommendations,
    };
  },
});

export const startJob = mutation({
  args: {
    bookingId: v.id("bookings"),
    mechanicId: v.id("mechanics"),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");

    await requireShopStaff(ctx, user._id, booking.shop_id);
    if (!["vehicle_at_shop", "in_progress"].includes(booking.status)) {
      throw new Error("Mark the vehicle as here before starting this booking.");
    }

    const now = Date.now();
    await ensureJobActualRecord(ctx, {
      booking,
      mechanicId: args.mechanicId,
      now,
      startedAtMs: now,
    });

    if (booking.status === "vehicle_at_shop") {
      await applyBookingStatusTransition(ctx, {
        booking,
        newStatus: "in_progress",
        changedBy: user._id,
        reason: "started_by_shop",
      });
    }

    return await getLatestJobActualForBooking(ctx, args.bookingId);
  },
});

export const completeJob = mutation({
  args: {
    bookingId: v.id("bookings"),
    finalizeActuals: v.optional(v.boolean()),
    actuals: v.optional(jobActualInputValidator),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");

    await requireShopStaff(ctx, user._id, booking.shop_id);

    const now = Date.now();
    await saveJobActualDraft(ctx, {
      booking,
      actuals: args.actuals,
      now,
      completedAtMs: now,
      preferAutoLaborMinutes: true,
    });

    if (booking.status !== "completed") {
      await applyBookingStatusTransition(ctx, {
        booking,
        newStatus: "completed",
        changedBy: user._id,
        reason: "completed_by_shop",
      });
    }

    const completedBooking = await ctx.db.get(args.bookingId);
    if (!completedBooking) throw new Error("Booking not found");

    if (args.finalizeActuals) {
      await finalizeJobActuals(ctx, {
        booking: completedBooking,
        userId: user._id,
        actuals: args.actuals,
        now,
      });
    }

    return await getLatestJobActualForBooking(ctx, args.bookingId);
  },
});

export const saveDraft = mutation({
  args: {
    bookingId: v.id("bookings"),
    actuals: jobActualInputValidator,
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");

    await requireShopStaff(ctx, user._id, booking.shop_id);

    return await saveJobActualDraft(ctx, {
      booking,
      actuals: args.actuals,
      now: Date.now(),
      preferAutoLaborMinutes: booking.status === "completed",
    });
  },
});

export const finalizeByBooking = mutation({
  args: {
    bookingId: v.id("bookings"),
    actuals: v.optional(jobActualInputValidator),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");

    await requireShopStaff(ctx, user._id, booking.shop_id);

    if (booking.status !== "completed") {
      throw new Error("Booking must be completed before finalizing actuals.");
    }

    return await finalizeJobActuals(ctx, {
      booking,
      userId: user._id,
      actuals: args.actuals,
      now: Date.now(),
    });
  },
});

export const reopenByBooking = mutation({
  args: {
    bookingId: v.id("bookings"),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");

    await requireShopStaff(ctx, user._id, booking.shop_id);

    if (booking.status !== "completed") {
      throw new Error("Only completed bookings can reopen actuals.");
    }

    return await reopenJobActuals(ctx, {
      booking,
      now: Date.now(),
    });
  },
});

export const submitJobActuals = mutation({
  args: {
    bookingId: v.id("bookings"),
    parts_used: v.array(jobActualPartValidator),
    actual_parts_cost: v.float64(),
    difficulty_rating: v.float64(),
    technician_notes: v.string(),
    actual_labor_minutes: v.optional(v.union(v.float64(), v.null())),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");

    await requireShopStaff(ctx, user._id, booking.shop_id);

    const now = Date.now();
    await saveJobActualDraft(ctx, {
      booking,
      actuals: {
        actual_labor_minutes: args.actual_labor_minutes,
        actual_parts_cost: args.actual_parts_cost,
        difficulty_rating: args.difficulty_rating,
        technician_notes: args.technician_notes,
        parts_used: args.parts_used,
      },
      now,
      completedAtMs: booking.status === "completed" ? undefined : now,
      preferAutoLaborMinutes: true,
    });

    if (booking.status !== "completed") {
      await applyBookingStatusTransition(ctx, {
        booking,
        newStatus: "completed",
        changedBy: user._id,
        reason: "completed_by_shop",
      });
    }

    const completedBooking = await ctx.db.get(args.bookingId);
    if (!completedBooking) throw new Error("Booking not found");

    return await finalizeJobActuals(ctx, {
      booking: completedBooking,
      userId: user._id,
      actuals: {
        actual_labor_minutes: args.actual_labor_minutes,
        actual_parts_cost: args.actual_parts_cost,
        difficulty_rating: args.difficulty_rating,
        technician_notes: args.technician_notes,
        parts_used: args.parts_used,
      },
      now,
    });
  },
});
