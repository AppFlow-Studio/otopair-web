import { query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

// Service history + previous mechanic feedback for the Vehicle Passport card
// in the 4-step mechanic workspace. Scoped to bookings at the requesting
// user's shop (no `by_vin` index on bookings yet — keeping queries shop-
// scoped avoids a full table scan). Excludes the current booking so the
// Vehicle Passport "Service history" section shows only prior visits.

interface VinHistoryPart {
  partName: string;
  oemNumber: string | null;
  brand: string | null;
  quantity: number;
  cost: number;
  suppliedBy: "shop" | "customer" | null;
}

interface VinHistoryEntry {
  bookingId: Id<"bookings">;
  serviceNames: string[];
  status: string;
  scheduledDate: string | null;
  completedAtMs: number | null;
  totalCost: number | null;
  laborCost: number | null;
  partsCost: number | null;
  actualLaborMinutes: number | null;
  completionMileage: number | null;
  mechanicName: string | null;
  difficultyRating: number | null;
  mechanicFindings: string | null;
  technicianNotes: string | null;
  postjobReport: unknown;
  flaggedVehicleSpecs: boolean;
  partsUsed: VinHistoryPart[];
}

async function getCurrentUserOrNull(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) =>
      q.eq("clerkUserId", identity.subject),
    )
    .unique();
}

async function resolveAccessibleShopIds(ctx: any, userId: Id<"users">) {
  const shopIds = new Set<string>();

  const memberships = await ctx.db
    .query("shop_users")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .filter((q: any) => q.eq(q.field("is_active"), true))
    .collect();
  for (const m of memberships) shopIds.add(String(m.shop_id));

  const ownedShops = await ctx.db
    .query("shops")
    .withIndex("by_owner_user_id", (q: any) => q.eq("owner_user_id", userId))
    .collect();
  for (const s of ownedShops) shopIds.add(String(s._id));

  return shopIds;
}

export const getServiceHistoryForVin = query({
  args: {
    vin: v.string(),
    // Optional booking id to exclude from results (the current job — its
    // own actuals are surfaced elsewhere in the workspace).
    excludeBookingId: v.optional(v.id("bookings")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return [] as VinHistoryEntry[];

    const accessibleShopIds = await resolveAccessibleShopIds(ctx, user._id);
    if (accessibleShopIds.size === 0) return [] as VinHistoryEntry[];

    const vin = args.vin.trim().toUpperCase();
    const limit = args.limit ?? 10;

    // Walk completed bookings per accessible shop, filter by VIN. Cancelled,
    // declined, no-show, and in-flight visits are excluded — the Vehicle
    // Passport history is for real service performed on this VIN, not the
    // intent that never made it past the schedule.
    const matched: any[] = [];
    for (const shopIdStr of accessibleShopIds) {
      const shopId = shopIdStr as Id<"shops">;
      const rows = await ctx.db
        .query("bookings")
        .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shopId))
        .filter((q: any) =>
          q.and(
            q.eq(q.field("vin"), vin),
            q.eq(q.field("status"), "completed"),
          ),
        )
        .collect();
      for (const row of rows) {
        if (args.excludeBookingId && String(row._id) === String(args.excludeBookingId)) {
          continue;
        }
        matched.push(row);
      }
    }

    matched.sort((a, b) => {
      const aTs = a.completed_at_ms ?? a.created_at ?? 0;
      const bTs = b.completed_at_ms ?? b.created_at ?? 0;
      return bTs - aTs;
    });

    const sliced = matched.slice(0, limit);

    const serviceNameCache = new Map<string, string>();
    const mechanicNameCache = new Map<string, string>();

    const enriched: VinHistoryEntry[] = await Promise.all(
      sliced.map(async (booking) => {
        const serviceNames: string[] = [];
        for (const sid of booking.service_ids ?? []) {
          const key = String(sid);
          let name = serviceNameCache.get(key);
          if (!name) {
            const svc = await ctx.db.get(sid as Id<"services">);
            name = svc?.name ?? "Unknown service";
            serviceNameCache.set(key, name);
          }
          serviceNames.push(name);
        }

        let mechanicName: string | null = null;
        if (booking.mechanic_id) {
          const key = String(booking.mechanic_id);
          if (mechanicNameCache.has(key)) {
            mechanicName = mechanicNameCache.get(key) ?? null;
          } else {
            const mech: any = await ctx.db.get(
              booking.mechanic_id as Id<"mechanics">,
            );
            mechanicName = mech?.name ?? null;
            mechanicNameCache.set(key, mechanicName ?? "");
          }
        }

        const actuals = await ctx.db
          .query("job_actuals")
          .withIndex("by_booking_id", (q: any) =>
            q.eq("booking_id", booking._id),
          )
          .first();

        const rawParts: any[] = Array.isArray(actuals?.parts_used)
          ? (actuals!.parts_used as any[])
          : [];
        const partsUsed: VinHistoryPart[] = rawParts.map((p) => ({
          partName: String(p?.part_name ?? "Unknown part"),
          oemNumber:
            typeof p?.oem_number === "string" && p.oem_number.length > 0
              ? p.oem_number
              : null,
          brand:
            typeof p?.brand === "string" && p.brand.length > 0 ? p.brand : null,
          quantity:
            typeof p?.quantity === "number" && Number.isFinite(p.quantity)
              ? p.quantity
              : 1,
          cost: typeof p?.cost === "number" && Number.isFinite(p.cost) ? p.cost : 0,
          suppliedBy:
            p?.supplied_by === "shop" || p?.supplied_by === "customer"
              ? p.supplied_by
              : null,
        }));

        return {
          bookingId: booking._id,
          serviceNames,
          status: booking.status,
          scheduledDate: booking.scheduled_date ?? null,
          completedAtMs: booking.completed_at_ms ?? null,
          totalCost:
            typeof booking.total_cost === "number" ? booking.total_cost : null,
          laborCost:
            typeof booking.labor_cost === "number" ? booking.labor_cost : null,
          partsCost:
            typeof booking.parts_cost === "number" ? booking.parts_cost : null,
          actualLaborMinutes:
            typeof actuals?.actual_labor_minutes === "number"
              ? actuals.actual_labor_minutes
              : null,
          completionMileage:
            typeof actuals?.completion_mileage === "number"
              ? actuals.completion_mileage
              : null,
          mechanicName,
          difficultyRating: actuals?.difficulty_rating ?? null,
          mechanicFindings: actuals?.mechanic_findings ?? null,
          technicianNotes: actuals?.technician_notes ?? null,
          postjobReport: actuals?.postjob_report ?? null,
          flaggedVehicleSpecs: Boolean(actuals?.flagged_vehicle_specs),
          partsUsed,
        } satisfies VinHistoryEntry;
      }),
    );

    return enriched;
  },
});
