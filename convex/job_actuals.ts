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
  // The booking service this suggestion belongs to. Lets the post-job and
  // backfill flows render per-service parts blocks and lets snapshot
  // attribution stay accurate on multi-service jobs.
  service_id?: Id<"services">;
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

    const trim = engine.trim_id ? await ctx.db.get(engine.trim_id) : null;
    const model = trim ? await ctx.db.get(trim.model_id as Id<"models">) : null;
    const make = model ? await ctx.db.get(model.make_id as Id<"makes">) : null;

    const vehicleLabel = [make?.name, model?.name, trim?.name, vehicle.year]
      .filter(Boolean)
      .join(" ");

    const mechanic = booking.mechanic_id ? await ctx.db.get(booking.mechanic_id) : null;
    const mechanicName = mechanic
      ? `${mechanic.first_name} ${mechanic.last_name}`
      : "Unassigned";

    const allSpecs = await ctx.db.query("service_vehicle_specs").collect();
    const specs = allSpecs.find((row: any) => row.engine_id === engine._id);

    const suggestedParts: SuggestedPart[] = [];

    // Sentinel-prefix tire identifiers so downstream consumers that key on
    // oem_number (part_snapshots, shop_part_preferences) don't get bare
    // size codes treated as OEM numbers.
    const tireOem = (size: string | null | undefined) =>
      size ? `TIRE-${size}` : "";

    // Per-service suggestion build. Each service in the booking gets its own
    // shot at: layers 1+2 (cascade) → layer 3 (catalog floor) → tire-specific
    // prefill. Stamping service_id on every push keeps multi-service jobs
    // correctly attributed downstream (snapshots, per-service analytics).
    for (const sid of booking.service_ids ?? []) {
      const svc: any = await ctx.db.get(sid);
      if (!svc) continue;

      const before = suggestedParts.length;

      if (vehicle.vehicle_config_id && booking.shop_id) {
        const cascadeSuggestions = await resolveSuggestedPartsFromCascade(ctx, {
          shopId: booking.shop_id,
          serviceId: sid,
          vehicleConfigId: vehicle.vehicle_config_id,
        });
        for (const s of cascadeSuggestions) {
          suggestedParts.push({ ...s, service_id: sid });
        }
      }

      // Layer 3 catalog floor — only when the cascade produced nothing for
      // this service. Uses service_vehicle_specs OEM columns indexed by
      // engine to suggest canonical parts even with zero historical data.
      if (suggestedParts.length === before && specs) {
        // TODO(ts-fix): service_vehicle_specs schema is missing OEM-part fields used below:
        //   oil_filter_oem, oil_capacity_qts (lives on engines), oil_viscocity (note: actual field on engines is oil_viscosity),
        //   oil_drain_plug_gasket_oem, front_brake_pad_oem, rear_brake_pad_oem, engine_air_filter_oem,
        //   cabin_air_filter_oem, spark_plug_oem, spark_plug_quantity (lives on engines),
        //   serpentine_belt_oem, front_brake_rotor_oem, rear_brake_rotor_oem.
        //   Verify intent (rename/migrate/add to schema); using `any` cast meanwhile.
        const s = specs as any;
        const slug = svc.slug;
        if (slug === "oil-change") {
          suggestedParts.push({
            part_name: "Oil Filter",
            oem_number: s.oil_filter_oem ?? "",
            cost: 12,
            service_id: sid,
          });
          suggestedParts.push({
            part_name: `Synthetic Oil ${s.oil_capacity_qts ?? "-"}qt`,
            oem_number: s.oil_viscocity ?? "",
            cost: 35,
            service_id: sid,
          });
          if (s.oil_drain_plug_gasket_oem) {
            suggestedParts.push({
              part_name: "Drain Plug Gasket",
              oem_number: s.oil_drain_plug_gasket_oem,
              cost: 2,
              service_id: sid,
            });
          }
        } else if (slug === "brake-pads") {
          suggestedParts.push({
            part_name: "Front Brake Pads",
            oem_number: s.front_brake_pad_oem ?? "",
            cost: 45,
            service_id: sid,
          });
          suggestedParts.push({
            part_name: "Rear Brake Pads",
            oem_number: s.rear_brake_pad_oem ?? "",
            cost: 40,
            service_id: sid,
          });
        } else if (slug === "engine-air-filter" && s.engine_air_filter_oem) {
          suggestedParts.push({
            part_name: "Engine Air Filter",
            oem_number: s.engine_air_filter_oem,
            cost: 25,
            service_id: sid,
          });
        } else if (slug === "cabin-air-filter" && s.cabin_air_filter_oem) {
          suggestedParts.push({
            part_name: "Cabin Air Filter",
            oem_number: s.cabin_air_filter_oem,
            cost: 22,
            service_id: sid,
          });
        } else if (slug === "spark-plugs" && s.spark_plug_oem) {
          const qty = s.spark_plug_quantity ?? 4;
          suggestedParts.push({
            part_name: `Spark Plugs (x${qty})`,
            oem_number: s.spark_plug_oem,
            cost: 12 * qty,
            service_id: sid,
          });
        } else if (slug === "serpentine-belt" && s.serpentine_belt_oem) {
          suggestedParts.push({
            part_name: "Serpentine Belt",
            oem_number: s.serpentine_belt_oem,
            cost: 45,
            service_id: sid,
          });
        } else if (slug === "brake-rotors" && s.front_brake_rotor_oem) {
          suggestedParts.push({
            part_name: "Front Brake Rotors",
            oem_number: s.front_brake_rotor_oem ?? "",
            cost: 85,
            service_id: sid,
          });
          if (s.rear_brake_rotor_oem) {
            suggestedParts.push({
              part_name: "Rear Brake Rotors",
              oem_number: s.rear_brake_rotor_oem,
              cost: 75,
              service_id: sid,
            });
          }
        }
      }

      // Tire-replacement — independent of service_vehicle_specs. For in-app
      // bookings the accepted tire_quote_responses row has brand / model /
      // per-tire price / qty; for walk-in / backfilled jobs fall back to
      // booking.tire_specs and leave cost 0 for the mechanic to fill.
      if (suggestedParts.length === before && svc.slug === "tire-replacement") {
        const acceptedQuote = await ctx.db
          .query("tire_quote_responses")
          .withIndex("by_booking_id", (q: any) =>
            q.eq("booking_id", booking._id),
          )
          .filter((q: any) => q.eq(q.field("superseded_at"), undefined))
          .first();
        if (acceptedQuote) {
          const qty = acceptedQuote.quantity ?? 4;
          const brandModel = [acceptedQuote.tire_brand, acceptedQuote.tire_model]
            .filter(Boolean)
            .join(" ");
          suggestedParts.push({
            part_name: brandModel
              ? `Tires — ${brandModel} (x${qty})`
              : `Tires (x${qty})`,
            oem_number: tireOem(booking.tire_specs?.size),
            cost: (acceptedQuote.per_tire_price ?? 0) * qty,
            service_id: sid,
          });
        } else if (booking.tire_specs) {
          const qty = booking.tire_specs.quantity ?? 4;
          suggestedParts.push({
            part_name: `Tires — ${booking.tire_specs.tier} ${booking.tire_specs.type} (x${qty})`,
            oem_number: tireOem(booking.tire_specs.size),
            cost: 0,
            service_id: sid,
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
          service_id: rec.service_id,
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

    // One-active-job-per-mechanic invariant. Mirrors startWithPrejob.
    if (booking.status === "vehicle_at_shop") {
      const inProgress = await ctx.db
        .query("bookings")
        .withIndex("by_shop_and_status", (q: any) =>
          q.eq("shop_id", booking.shop_id).eq("status", "in_progress"),
        )
        .collect();
      const conflict = inProgress.find(
        (b: any) =>
          b.mechanic_id &&
          String(b.mechanic_id) === String(args.mechanicId) &&
          String(b._id) !== String(args.bookingId),
      );
      if (conflict) {
        throw new Error(`MECHANIC_HAS_ACTIVE_JOB:${String(conflict._id)}`);
      }
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
