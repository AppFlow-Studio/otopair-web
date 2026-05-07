import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
  applyBookingStatusTransition,
} from "./bookings";
import {
  ensureJobActualRecord,
  finalizeJobActuals,
  getLatestJobActualForBooking,
  jobActualInputValidator,
  jobActualPartValidator,
  reopenJobActuals,
  saveJobActualDraft,
} from "./lib/job_actuals";

function primaryServiceId(booking: { service_ids?: Id<"services">[] }): Id<"services"> | undefined {
  return booking.service_ids?.[0];
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

    return await getLatestJobActualForBooking(ctx, args.bookingId);
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

    if (specs && service) {
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

    return {
      vehicleLabel,
      serviceName: service?.name ?? "",
      serviceSlug: service?.slug ?? "",
      engineCode: engine.engine_code,
      engineId: engine._id,
      serviceId,
      mechanicName,
      suggestedParts,
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
