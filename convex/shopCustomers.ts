/**
 * shopCustomers.ts — Shop-scoped customer & vehicle directory.
 *
 * Powers /customers in the portal. All queries:
 *   - Scope to the caller's primary authorized shop (owner or active shop_user).
 *   - Return [] (or null for details) when the caller has no shop / no access.
 *   - Are read-only roll-ups of the bookings table.
 *
 * NOTE: The helper functions below (getCurrentUserOrNull, getPrimaryAuthorizedShop,
 * formatCustomerName, resolveServiceLabels) intentionally mirror the local helpers
 * in bookings.ts. We did not extract them to share — bookings.ts is large and
 * not part of this change's scope.
 *
 * Pagination: queries return up to 100 customers / 100 vehicles. Shops beyond
 * that range will need a paginated Convex query; UI is already prepared.
 */

import { query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

/* ------------------------------------------------------------------ */
/*  Local helpers (duplicated from bookings.ts — see note above)       */
/* ------------------------------------------------------------------ */

async function getCurrentUserOrNull(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) => q.eq("clerkUserId", identity.subject))
    .unique();
  return user ?? null;
}

async function getPrimaryAuthorizedShop(ctx: any, userId: any) {
  const activeMembership = await ctx.db
    .query("shop_users")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .filter((q: any) => q.eq(q.field("is_active"), true))
    .first();
  if (activeMembership) {
    return { shopId: activeMembership.shop_id, role: activeMembership.role };
  }
  const ownedShop = await ctx.db
    .query("shops")
    .withIndex("by_owner_user_id", (q: any) => q.eq("owner_user_id", userId))
    .first();
  if (ownedShop) return { shopId: ownedShop._id, role: "owner" };
  return null;
}

function formatCustomerName(customer: any) {
  return (
    `${customer?.first_name ?? ""} ${customer?.last_name ?? ""}`.trim() ||
    customer?.email ||
    "Unknown"
  );
}

async function resolveServiceLabels(
  ctx: any,
  serviceIds: Array<any> | undefined,
  selectedOptions:
    | Array<{ service_id: any; option_label?: string }>
    | undefined,
): Promise<string[]> {
  if (!serviceIds || serviceIds.length === 0) return [];
  const byServiceId = new Map<string, string>();
  for (const opt of selectedOptions ?? []) {
    if (opt.option_label) byServiceId.set(String(opt.service_id), opt.option_label);
  }
  return await Promise.all(
    serviceIds.map(async (serviceId: any) => {
      const service = await ctx.db.get(serviceId);
      const name = service?.name ?? "Unknown Service";
      const label = byServiceId.get(String(serviceId));
      return label ? `${name} — ${label}` : name;
    }),
  );
}

/**
 * Year/make/model/trim summary for a vehicle by VIN.
 * Simpler than bookings.ts:resolveVehicleLabel — no engine/chassis details.
 */
async function resolveVehicleSummary(
  ctx: any,
  vin: string,
): Promise<{
  vehicleId: Id<"vehicles"> | null;
  year: number | null;
  make: string;
  model: string;
  trim: string | null;
  imageUrl: string | null;
}> {
  const vehicle = await ctx.db
    .query("vehicles")
    .withIndex("by_vin", (q: any) => q.eq("vin", vin))
    .first();
  if (!vehicle) {
    return { vehicleId: null, year: null, make: "", model: "", trim: null, imageUrl: null };
  }

  let make = "";
  let model = "";
  let trim: string | null = null;
  let year: number | null = typeof vehicle.year === "number" ? vehicle.year : null;

  const config = vehicle.vehicle_config_id
    ? await ctx.db.get(vehicle.vehicle_config_id)
    : null;
  if (config) {
    if (typeof config.year === "number") year = config.year;
    if (typeof config.trim_name === "string") trim = config.trim_name;
    const [mk, md] = await Promise.all([
      config.make_id ? ctx.db.get(config.make_id) : null,
      config.model_id ? ctx.db.get(config.model_id) : null,
    ]);
    if (mk && typeof (mk as any).name === "string") make = (mk as any).name;
    if (md && typeof (md as any).name === "string") model = (md as any).name;
  }

  if ((!make || !model || !trim) && vehicle.trim_id) {
    const trimRow = await ctx.db.get(vehicle.trim_id);
    if (trimRow) {
      if (!trim) trim = trimRow.name ?? null;
      const md = await ctx.db.get(trimRow.model_id);
      if (md) {
        if (!model) model = md.name;
        const mk = await ctx.db.get(md.make_id);
        if (mk && !make) make = mk.name;
      }
    }
  }

  if (!make && vehicle.metadata?.make) make = String(vehicle.metadata.make);
  if (!model && vehicle.metadata?.model) model = String(vehicle.metadata.model);

  return {
    vehicleId: vehicle._id as Id<"vehicles">,
    year,
    make,
    model,
    trim,
    imageUrl: typeof vehicle.image_url === "string" ? vehicle.image_url : null,
  };
}

/**
 * Effective scheduled timestamp (ms) for sorting / "last visit" calculations.
 * Falls back to created_at when scheduled_date is missing.
 */
function bookingTimestampMs(booking: any): number {
  if (typeof booking.scheduled_date === "string" && booking.scheduled_date) {
    const time =
      typeof booking.scheduled_time === "string" && booking.scheduled_time
        ? booking.scheduled_time
        : "00:00";
    const parsed = Date.parse(`${booking.scheduled_date}T${time}:00`);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return typeof booking.created_at === "number" ? booking.created_at : 0;
}

/* ------------------------------------------------------------------ */
/*  Queries                                                            */
/* ------------------------------------------------------------------ */

export const listShopCustomers = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return [];
    const primary = await getPrimaryAuthorizedShop(ctx, user._id);
    if (!primary) return [];

    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", primary.shopId))
      .collect();

    type Agg = {
      userId: Id<"users">;
      totalJobs: number;
      lastVisitMs: number | null;
      lifetimeSpendCents: number;
      vins: Set<string>;
    };
    const byUser = new Map<string, Agg>();

    for (const b of bookings) {
      if (!b.user_id) continue;
      const key = String(b.user_id);
      const ts = bookingTimestampMs(b);
      const totalCents = Math.round(((b.total_cost ?? 0) as number) * 100);
      const existing = byUser.get(key);
      if (existing) {
        existing.totalJobs += 1;
        if (ts > (existing.lastVisitMs ?? 0)) existing.lastVisitMs = ts;
        existing.lifetimeSpendCents += totalCents;
        if (b.vin) existing.vins.add(b.vin);
      } else {
        byUser.set(key, {
          userId: b.user_id as Id<"users">,
          totalJobs: 1,
          lastVisitMs: ts || null,
          lifetimeSpendCents: totalCents,
          vins: b.vin ? new Set([b.vin]) : new Set(),
        });
      }
    }

    const rows = await Promise.all(
      Array.from(byUser.values()).map(async (agg) => {
        const u = await ctx.db.get(agg.userId);
        return {
          id: String(agg.userId),
          name: formatCustomerName(u),
          email: u?.email ?? "",
          phone: u?.phone ?? "",
          profilePhotoUrl: u?.profile_photo_url ?? null,
          vehiclesCount: agg.vins.size,
          totalJobs: agg.totalJobs,
          lastVisitMs: agg.lastVisitMs,
          lifetimeSpendCents: agg.lifetimeSpendCents,
        };
      }),
    );

    rows.sort((a, b) => (b.lastVisitMs ?? 0) - (a.lastVisitMs ?? 0));
    return rows.slice(0, 100);
  },
});

export const listShopVehicles = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return [];
    const primary = await getPrimaryAuthorizedShop(ctx, user._id);
    if (!primary) return [];

    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", primary.shopId))
      .collect();

    type Agg = {
      vin: string;
      jobsCount: number;
      lastServicedMs: number | null;
      latestUserId: Id<"users"> | null;
      latestUserMs: number;
    };
    const byVin = new Map<string, Agg>();

    for (const b of bookings) {
      if (!b.vin) continue;
      const ts = bookingTimestampMs(b);
      const existing = byVin.get(b.vin);
      if (existing) {
        existing.jobsCount += 1;
        if (ts > (existing.lastServicedMs ?? 0)) existing.lastServicedMs = ts;
        if (ts >= existing.latestUserMs && b.user_id) {
          existing.latestUserId = b.user_id as Id<"users">;
          existing.latestUserMs = ts;
        }
      } else {
        byVin.set(b.vin, {
          vin: b.vin,
          jobsCount: 1,
          lastServicedMs: ts || null,
          latestUserId: (b.user_id as Id<"users">) ?? null,
          latestUserMs: ts,
        });
      }
    }

    const rows = await Promise.all(
      Array.from(byVin.values()).map(async (agg) => {
        const summary = await resolveVehicleSummary(ctx, agg.vin);

        // Prefer the active vehicle_owner; fall back to the latest-booking user.
        let ownerUserId: Id<"users"> | null = null;
        let ownerMileage: number | null = null;
        const activeOwner = await ctx.db
          .query("vehicle_owners")
          .withIndex("by_vin", (q) => q.eq("vin", agg.vin))
          .filter((q) => q.eq(q.field("status"), "active"))
          .first();
        if (activeOwner) {
          ownerUserId = activeOwner.user_id as Id<"users">;
          if (typeof activeOwner.mileage === "number") {
            ownerMileage = activeOwner.mileage;
          }
        } else {
          ownerUserId = agg.latestUserId;
        }

        const ownerUser = ownerUserId ? await ctx.db.get(ownerUserId) : null;

        return {
          id: summary.vehicleId ? String(summary.vehicleId) : `vin:${agg.vin}`,
          vehicleId: summary.vehicleId,
          vin: agg.vin,
          year: summary.year,
          make: summary.make,
          model: summary.model,
          trim: summary.trim,
          imageUrl: summary.imageUrl,
          mileage: ownerMileage,
          ownerId: ownerUserId ? String(ownerUserId) : null,
          ownerName: formatCustomerName(ownerUser),
          lastServicedMs: agg.lastServicedMs,
          jobsCount: agg.jobsCount,
        };
      }),
    );

    rows.sort((a, b) => (b.lastServicedMs ?? 0) - (a.lastServicedMs ?? 0));
    return rows.slice(0, 100);
  },
});

export const getShopCustomerDetail = query({
  args: { customerId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return null;
    const primary = await getPrimaryAuthorizedShop(ctx, user._id);
    if (!primary) return null;

    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", primary.shopId))
      .collect();
    const customerBookings = bookings.filter(
      (b) => String(b.user_id) === String(args.customerId),
    );
    if (customerBookings.length === 0) return null;

    const customer = await ctx.db.get(args.customerId);
    if (!customer) return null;

    let firstVisitMs = Number.POSITIVE_INFINITY;
    let lifetimeSpendCents = 0;
    const vins = new Set<string>();
    for (const b of customerBookings) {
      const ts = bookingTimestampMs(b);
      if (ts && ts < firstVisitMs) firstVisitMs = ts;
      lifetimeSpendCents += Math.round(((b.total_cost ?? 0) as number) * 100);
      if (b.vin) vins.add(b.vin);
    }
    if (!Number.isFinite(firstVisitMs)) firstVisitMs = 0;
    const avgTicketCents = customerBookings.length
      ? Math.round(lifetimeSpendCents / customerBookings.length)
      : 0;

    const vehicleSummaries = await Promise.all(
      Array.from(vins).map(async (vin) => {
        const s = await resolveVehicleSummary(ctx, vin);
        return {
          vin,
          vehicleId: s.vehicleId ? String(s.vehicleId) : null,
          year: s.year,
          make: s.make,
          model: s.model,
          trim: s.trim,
          imageUrl: s.imageUrl,
        };
      }),
    );

    const jobs = await Promise.all(
      customerBookings
        .slice()
        .sort((a, b) => bookingTimestampMs(b) - bookingTimestampMs(a))
        .map(async (b) => {
          const serviceNames = await resolveServiceLabels(
            ctx,
            b.service_ids,
            b.selected_service_options as any,
          );
          const mechanic = b.mechanic_id ? await ctx.db.get(b.mechanic_id) : null;
          const veh = b.vin ? await resolveVehicleSummary(ctx, b.vin) : null;
          const vehicleLabel = veh
            ? [veh.year, veh.make, veh.model].filter(Boolean).join(" ") || b.vin
            : "";
          return {
            bookingId: String(b._id),
            scheduledMs: bookingTimestampMs(b),
            scheduledDate: b.scheduled_date ?? null,
            scheduledTime: b.scheduled_time ?? null,
            serviceNames,
            mechanicName: mechanic
              ? `${(mechanic as any).first_name ?? ""} ${(mechanic as any).last_name ?? ""}`.trim()
              : null,
            status: b.status,
            totalCents: Math.round(((b.total_cost ?? 0) as number) * 100),
            vehicleLabel,
            vin: b.vin ?? null,
          };
        }),
    );

    return {
      id: String(customer._id),
      name: formatCustomerName(customer),
      email: customer.email ?? "",
      phone: customer.phone ?? "",
      profilePhotoUrl: customer.profile_photo_url ?? null,
      firstVisitMs,
      vehiclesCount: vins.size,
      totalJobs: customerBookings.length,
      lifetimeSpendCents,
      avgTicketCents,
      vehicles: vehicleSummaries,
      jobs,
    };
  },
});

export const getShopVehicleDetail = query({
  args: { vehicleId: v.id("vehicles") },
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return null;
    const primary = await getPrimaryAuthorizedShop(ctx, user._id);
    if (!primary) return null;

    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle) return null;

    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", primary.shopId))
      .collect();
    const vehicleBookings = bookings.filter((b) => b.vin === vehicle.vin);
    if (vehicleBookings.length === 0) return null;

    const summary = await resolveVehicleSummary(ctx, vehicle.vin);

    let lastServicedMs: number | null = null;
    let lifetimeSpendCents = 0;
    for (const b of vehicleBookings) {
      const ts = bookingTimestampMs(b);
      if (ts && ts > (lastServicedMs ?? 0)) lastServicedMs = ts;
      lifetimeSpendCents += Math.round(((b.total_cost ?? 0) as number) * 100);
    }

    const activeOwner = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_vin", (q) => q.eq("vin", vehicle.vin))
      .filter((q) => q.eq(q.field("status"), "active"))
      .first();
    const ownerUser = activeOwner ? await ctx.db.get(activeOwner.user_id) : null;

    const jobs = await Promise.all(
      vehicleBookings
        .slice()
        .sort((a, b) => bookingTimestampMs(b) - bookingTimestampMs(a))
        .map(async (b) => {
          const serviceNames = await resolveServiceLabels(
            ctx,
            b.service_ids,
            b.selected_service_options as any,
          );
          const mechanic = b.mechanic_id ? await ctx.db.get(b.mechanic_id) : null;
          const bookingUser = await ctx.db.get(b.user_id);
          return {
            bookingId: String(b._id),
            scheduledMs: bookingTimestampMs(b),
            scheduledDate: b.scheduled_date ?? null,
            scheduledTime: b.scheduled_time ?? null,
            serviceNames,
            mechanicName: mechanic
              ? `${(mechanic as any).first_name ?? ""} ${(mechanic as any).last_name ?? ""}`.trim()
              : null,
            status: b.status,
            totalCents: Math.round(((b.total_cost ?? 0) as number) * 100),
            customerName: formatCustomerName(bookingUser),
          };
        }),
    );

    return {
      id: String(vehicle._id),
      vin: vehicle.vin,
      year: summary.year,
      make: summary.make,
      model: summary.model,
      trim: summary.trim,
      imageUrl: summary.imageUrl,
      mileage: typeof activeOwner?.mileage === "number" ? activeOwner.mileage : null,
      nickname: activeOwner?.nickname ?? null,
      ownerId: ownerUser ? String(ownerUser._id) : null,
      ownerName: formatCustomerName(ownerUser),
      lastServicedMs,
      jobsCount: vehicleBookings.length,
      lifetimeSpendCents,
      jobs,
    };
  },
});
