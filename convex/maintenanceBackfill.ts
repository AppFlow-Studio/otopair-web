/**
 * maintenanceBackfill.ts — one-time migration.
 *
 * runCompletionSideEffects only started stamping maintenance_records with the
 * resolving booking (lastServiceBookingId) — and only started crediting an anchor
 * for a mid-job-added catalog service — as of this deploy. Bookings completed
 * BEFORE it never stamped the booking, and added catalog services completed
 * before it (custom_jobs written without a catalog_service_id) never wrote an
 * anchor at all, so the Cars tracker still shows those services as due and the
 * "Resolved by [shop]" card can't render.
 *
 * This backfill walks every vehicle's COMPLETED bookings oldest → newest and, for
 * each maintenance type, ties the anchor to the MOST RECENT completed booking that
 * performed a matching service — originally-booked (service_ids) or added
 * (custom_jobs, matched by catalog_service_id, or by name for legacy rows that
 * predate the column). It stamps lastServiceDate/lastServiceMileage/
 * lastServiceBookingId from that booking. Idempotent and re-runnable; never
 * regresses an anchor that already carries a newer service.
 */

import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
  recordTypeForServiceSlug,
  minorRecordTypeForServiceSlug,
} from "./lib/serviceRecordType";
import { resolveCatalogServiceIdByName } from "./customJobs";

type LatestHit = { bookingId: Id<"bookings">; date: number; mileage?: number };

/** When did this booking complete? Prefer the explicit completion stamp, then
 *  the last update, then creation — so ordering is stable even on older rows. */
function completionTime(b: any): number {
  if (typeof b.completed_at_ms === "number") return b.completed_at_ms;
  if (typeof b.updated_at === "number") return b.updated_at;
  if (typeof b.created_at === "number") return b.created_at;
  return 0;
}

async function backfillVehicle(
  ctx: any,
  owner: any,
  services: any[],
): Promise<number> {
  if (!owner?.vin) return 0;

  const bookings = (
    await ctx.db
      .query("bookings")
      .withIndex("by_vin", (q: any) => q.eq("vin", owner.vin))
      .collect()
  ).filter(
    (b: any) => b.status === "completed" && b.user_id === owner.user_id,
  );
  if (bookings.length === 0) return 0;

  // Oldest → newest so the last write per type is the most recent service.
  bookings.sort((a: any, b: any) => completionTime(a) - completionTime(b));

  const latestByType = new Map<string, LatestHit>();

  for (const b of bookings) {
    const date = completionTime(b);

    // Actual odometer at the service if a job_actual recorded it; else the
    // vehicle's current mileage (matches the live markServiced fallback).
    const jobActuals = await ctx.db
      .query("job_actuals")
      .withIndex("by_booking_id", (q: any) => q.eq("booking_id", b._id))
      .collect();
    const mileage =
      jobActuals
        .map((j: any) => j.completion_mileage)
        .find((m: any) => typeof m === "number") ??
      (typeof owner.mileage === "number" ? owner.mileage : undefined);

    // Catalog slugs this booking serviced: originally-booked + added catalog.
    const slugs: string[] = [];
    for (const sid of (b.service_ids ?? []) as Id<"services">[]) {
      const s = await ctx.db.get(sid);
      if ((s as any)?.slug) slugs.push((s as any).slug);
    }
    const customJobs = await ctx.db
      .query("custom_jobs")
      .withIndex("by_booking", (q: any) => q.eq("booking_id", b._id))
      .collect();
    for (const cj of customJobs) {
      if (cj.status !== "completed") continue;
      // New rows carry the catalog id; legacy rows predate the column, so fall
      // back to resolving the catalog service from the typed name (the same
      // match addCustomServiceForBooking uses). Off-catalog work resolves to
      // null and is skipped — the CUSTOM JOB INVARIANT holds here too.
      let serviceId: Id<"services"> | null = cj.catalog_service_id ?? null;
      if (!serviceId) {
        serviceId = await resolveCatalogServiceIdByName(ctx, cj.name, services);
      }
      if (!serviceId) continue;
      const s = await ctx.db.get(serviceId);
      if ((s as any)?.slug) slugs.push((s as any).slug);
    }

    for (const slug of slugs) {
      const types = [
        minorRecordTypeForServiceSlug(slug),
        recordTypeForServiceSlug(slug),
      ].filter(Boolean) as string[];
      for (const t of types) latestByType.set(t, { bookingId: b._id, date, mileage });
    }
  }

  let stamped = 0;
  const now = Date.now();
  for (const [type, hit] of latestByType) {
    const existing = await ctx.db
      .query("maintenance_records")
      .withIndex("by_vehicle_and_type", (q: any) =>
        q.eq("vehicleOwnerId", owner._id).eq("type", type),
      )
      .unique();
    const existingDate =
      typeof existing?.lastServiceDate === "number" ? existing.lastServiceDate : 0;
    // Don't regress a record that already reflects a NEWER service (e.g. a
    // user-reported one). Equal-or-older existing gets the booking stamp so the
    // resolved card can render.
    if (existing && existingDate > hit.date) continue;

    const data: Record<string, unknown> = {
      lastServiceDate: hit.date,
      serviceSource: "otopair",
      confidence: "verified",
      lastServiceBookingId: hit.bookingId,
      updatedAt: now,
    };
    if (typeof hit.mileage === "number") data.lastServiceMileage = hit.mileage;

    if (existing) {
      await ctx.db.patch(existing._id, data);
    } else {
      await ctx.db.insert("maintenance_records", {
        vehicleOwnerId: owner._id,
        type,
        ...data,
        createdAt: now,
      });
    }
    stamped += 1;
  }
  return stamped;
}

/** Backfill one vehicle. Safe to target when the full-sweep is too large. */
export const backfillCloseoutsForVehicle = internalMutation({
  args: { vehicleOwnerId: v.id("vehicle_owners") },
  handler: async (ctx, args) => {
    const owner = await ctx.db.get(args.vehicleOwnerId);
    if (!owner) return { ok: false as const, reason: "owner not found" };
    const services = await ctx.db.query("services").collect();
    const typesStamped = await backfillVehicle(ctx, owner, services);
    return { ok: true as const, typesStamped };
  },
});

/** Backfill every vehicle. Small deployments only — one transaction. */
export const backfillCloseoutsAll = internalMutation({
  args: {},
  handler: async (ctx) => {
    const owners = await ctx.db.query("vehicle_owners").collect();
    const services = await ctx.db.query("services").collect();
    let vehicles = 0;
    let typesStamped = 0;
    for (const owner of owners) {
      typesStamped += await backfillVehicle(ctx, owner, services);
      vehicles += 1;
    }
    return { vehicles, typesStamped };
  },
});
