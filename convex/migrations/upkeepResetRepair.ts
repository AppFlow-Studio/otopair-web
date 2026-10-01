// Tire / battery life records that a rotation or a battery TEST reset as if the
// part had been replaced (bug #413, merged into #428).
//
// Until the fix, booking completion mapped tire_rotation / tire_balance /
// wheel_alignment onto the "tires" record and battery_test onto "battery". Those
// records measure tread life and battery age, so a rotation showed "Tires —
// 50,000 mi remaining" on a car whose tires were never replaced. New completions
// no longer do this; this repairs the records already written.
//
// For each "tires" / "battery" record whose last stamp came from a booking that
// did upkeep only (no tire_replacement / battery_replacement):
//   - the upkeep is recorded on its own anchor (service_tire_rotation, …) with
//     the booking's date, mileage and stamp, carrying the resolved-card ack over
//     so an already-seen card doesn't resurface;
//   - the life record's anchor is cleared. The value it held before the upkeep
//     was overwritten at the time and cannot be recovered, and the value it
//     holds now is false (it claims a replacement), so "not on file" is the
//     honest state. `hadPriorRecord` in the report marks the cars where the row
//     existed before the upkeep, i.e. where the driver may want to re-answer.
//     Grades and Quick Read answers in customInputs are left untouched.
//
// Records stamped by a booking that DID replace the part, or re-dated since
// (e.g. the driver answered after the visit), are left alone.
//
// Internal only; nothing here runs on deploy. Dry run first (the default):
//   npx convex run migrations/upkeepResetRepair:repair '{}'
//   npx convex run migrations/upkeepResetRepair:repair '{"vehicleOwnerId":"<id>"}'
// then the same with "dryRun":false. Add --prod for production.
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  recordTypeForServiceSlug,
  serviceAnchorRecordType,
  UPKEEP_SLUGS_BY_RECORD_TYPE,
} from "../lib/serviceRecordType";

/** A completion stamp is "still the booking's" when it lands within this window
 *  of the booking's completion time. Wider than any gap between completing the
 *  booking and its side effects; far narrower than a driver's later answer,
 *  which is a past month, not the visit day. */
const STAMP_WINDOW_MS = 36 * 60 * 60 * 1000;

async function performedSlugs(ctx: any, booking: Doc<"bookings">): Promise<Set<string>> {
  const slugs = new Set<string>();
  for (const serviceId of (booking.service_ids ?? []) as Id<"services">[]) {
    const service = await ctx.db.get(serviceId);
    if (service?.slug) slugs.add(service.slug);
  }
  const customJobs = await ctx.db
    .query("custom_jobs")
    .withIndex("by_booking", (q: any) => q.eq("booking_id", booking._id))
    .collect();
  for (const job of customJobs) {
    if (job.status !== "completed" || !job.catalog_service_id) continue;
    const service = await ctx.db.get(job.catalog_service_id);
    if (service?.slug) slugs.add(service.slug);
  }
  return slugs;
}

function stampIsTheBookings(record: Doc<"maintenance_records">, booking: any): boolean {
  if (typeof record.lastServiceDate !== "number") return false;
  if (typeof booking.completed_at_ms === "number") {
    return Math.abs(record.lastServiceDate - booking.completed_at_ms) <= STAMP_WINDOW_MS;
  }
  const created = typeof booking.created_at === "number" ? booking.created_at : booking._creationTime;
  return record.lastServiceDate >= created;
}

export const repair = internalMutation({
  args: {
    /** Limit to one vehicle. Omit to sweep every tires/battery record. */
    vehicleOwnerId: v.optional(v.id("vehicle_owners")),
    /** Defaults to true — report only, write nothing. */
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const now = Date.now();
    const lifeTypes = Object.keys(UPKEEP_SLUGS_BY_RECORD_TYPE);

    const candidates: Doc<"maintenance_records">[] = [];
    if (args.vehicleOwnerId) {
      for (const type of lifeTypes) {
        const row = await ctx.db
          .query("maintenance_records")
          .withIndex("by_vehicle_and_type", (q) =>
            q.eq("vehicleOwnerId", args.vehicleOwnerId!).eq("type", type),
          )
          .unique();
        if (row) candidates.push(row);
      }
    } else {
      for (const row of await ctx.db.query("maintenance_records").collect()) {
        if (lifeTypes.includes(row.type)) candidates.push(row);
      }
    }

    const repaired: Array<{
      recordId: Id<"maintenance_records">;
      vehicleOwnerId: Id<"vehicle_owners">;
      type: string;
      bookingId: Id<"bookings">;
      upkeepSlugs: string[];
      hadPriorRecord: boolean;
    }> = [];
    let skipped = 0;

    for (const record of candidates) {
      if (!record.lastServiceBookingId) { skipped += 1; continue; }
      const booking = await ctx.db.get(record.lastServiceBookingId);
      if (!booking || !stampIsTheBookings(record, booking)) { skipped += 1; continue; }

      const slugs = await performedSlugs(ctx, booking);
      const replaced = [...slugs].some((slug) => recordTypeForServiceSlug(slug) === record.type);
      const upkeepSlugs = (UPKEEP_SLUGS_BY_RECORD_TYPE[record.type] ?? []).filter((slug) =>
        slugs.has(slug),
      );
      if (replaced || upkeepSlugs.length === 0) { skipped += 1; continue; }

      // Inserted by the stamping write itself (live completion stamps createdAt
      // == lastServiceDate; the backfill inserts later than the booking date),
      // so the row did not exist before the upkeep.
      const hadPriorRecord =
        typeof record.createdAt !== "number" ||
        record.createdAt < (record.lastServiceDate as number);

      repaired.push({
        recordId: record._id,
        vehicleOwnerId: record.vehicleOwnerId,
        type: record.type,
        bookingId: booking._id,
        upkeepSlugs,
        hadPriorRecord,
      });
      if (dryRun) continue;

      for (const slug of upkeepSlugs) {
        const anchorType = serviceAnchorRecordType(slug);
        if (!anchorType) continue;
        const existing = await ctx.db
          .query("maintenance_records")
          .withIndex("by_vehicle_and_type", (q) =>
            q.eq("vehicleOwnerId", record.vehicleOwnerId).eq("type", anchorType),
          )
          .unique();
        const existingDate =
          typeof existing?.lastServiceDate === "number" ? existing.lastServiceDate : 0;
        if (existing && existingDate >= (record.lastServiceDate as number)) continue;
        const data = {
          lastServiceDate: record.lastServiceDate,
          lastServiceMileage: record.lastServiceMileage,
          serviceSource: "otopair",
          confidence: "verified",
          lastServiceBookingId: booking._id,
          resolutionAckedAt: record.resolutionAckedAt,
          updatedAt: now,
        };
        if (existing) {
          await ctx.db.patch(existing._id, data);
        } else {
          await ctx.db.insert("maintenance_records", {
            vehicleOwnerId: record.vehicleOwnerId,
            type: anchorType,
            ...data,
            createdAt: now,
          });
        }
      }

      await ctx.db.patch(record._id, {
        lastServiceDate: undefined,
        lastServiceMileage: undefined,
        lastServiceBookingId: undefined,
        serviceSource: undefined,
        confidence: undefined,
        resolutionAckedAt: undefined,
        updatedAt: now,
      });
    }

    if (!dryRun) {
      const owners = new Set(repaired.map((r) => r.vehicleOwnerId));
      for (const vehicleOwnerId of owners) {
        const owner = await ctx.db.get(vehicleOwnerId);
        if (!owner?.preOnboardingComplete) continue;
        await ctx.scheduler.runAfter(0, internal.maintenance_pipeline.runPipeline, {
          vehicleOwnerId,
          triggeredBy: "upkeep_reset_repair",
        });
      }
    }

    return {
      dryRun,
      scanned: candidates.length,
      repairCount: repaired.length,
      skipped,
      repaired,
    };
  },
});
