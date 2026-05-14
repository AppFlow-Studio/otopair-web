import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";

// Outlier thresholds — keep generous so we don't flag normal price variation.
// Triggered only with a minimum sample of OUTLIER_MIN_SAMPLE prior snapshots.
const OUTLIER_LOW_RATIO = 0.5;
const OUTLIER_HIGH_RATIO = 2.0;
const OUTLIER_MIN_SAMPLE = 5;
const OUTLIER_LOOKBACK = 50;

const VALID_PART_TIERS = new Set([
  "oem",
  "aftermarket",
  "performance",
  "economy",
  "unknown",
]);
const VALID_SUPPLIED_BY = new Set(["shop", "customer"]);

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export type InsertSnapshotArgs = {
  booking_id: Id<"bookings">;
  job_actual_id?: Id<"job_actuals">;
  shop_id: Id<"shops">;
  mechanic_id: Id<"users">;

  vehicle_id: Id<"vehicles">;
  vehicle_config_id?: Id<"vehicle_configs">;
  engine_id?: Id<"engines">;
  chassis_id?: Id<"chassis_variants">;
  trim_id?: Id<"trims">;

  service_id: Id<"services">;

  part_id?: Id<"oem_parts">;
  part_name: string;
  oem_part_number?: string;
  brand?: string;
  part_tier?: string;

  supplied_by: string;
  quantity?: number;
  unit_cost: number;
  currency?: string;

  corrects_snapshot_id?: Id<"part_snapshots">;
  notes?: string;
  recorded_at?: number;
};

/**
 * Internal implementation of the snapshot insert. Exported as a plain async
 * function (not a mutation) so other mutations (e.g. the post-job finalize
 * path in bookings.ts) can call it atomically within the same transaction.
 * The public `insertSnapshot` mutation is a thin wrapper around this.
 *
 * Responsibilities:
 *   1. Validate enum fields and enforce customer-supplied -> unit_cost=0.
 *   2. Resolve part_id from oem_parts when possible (best-effort match on
 *      oem_part_number); set flag_reason="missing_part_id" when no match.
 *   3. Compute reasonableness flag against recent same-part snapshots on the
 *      same vehicle_config. Never blocks — just records the flag.
 *   4. Insert the row.
 *   5. If a vehicle_config_id is known and supplied_by="shop", schedule
 *      recordPartUsage to bump shop_part_preferences.
 */
export async function insertSnapshotImpl(
  ctx: any,
  args: InsertSnapshotArgs,
): Promise<Id<"part_snapshots">> {
  if (!VALID_SUPPLIED_BY.has(args.supplied_by)) {
    throw new Error(
      `Invalid supplied_by "${args.supplied_by}". Expected "shop" or "customer".`,
    );
  }
  const partTier = args.part_tier ?? "oem";
  if (!VALID_PART_TIERS.has(partTier)) {
    throw new Error(`Invalid part_tier "${partTier}".`);
  }

  const isCustomer = args.supplied_by === "customer";
  const unitCost = isCustomer ? 0 : Math.max(0, args.unit_cost);
  const quantity = Math.max(1, args.quantity ?? 1);
  const totalCost = unitCost * quantity;
  const recordedAt = args.recorded_at ?? Date.now();

  let partId: Id<"oem_parts"> | undefined = args.part_id;
  if (!partId && args.oem_part_number && args.oem_part_number.trim() !== "") {
    const match = await ctx.db
      .query("oem_parts")
      .withIndex("by_part_number", (q: any) =>
        q.eq("oem_part_number", args.oem_part_number!.trim()),
      )
      .first();
    if (match) partId = match._id;
  }

  // Reasonableness check — silent. Compares unit_cost against the median
  // unit_cost of recent same-part snapshots on the same vehicle_config that
  // haven't been superseded. Skipped for customer parts and when we lack the
  // vehicle_config_id needed to scope the comparison.
  let flaggedForReview: boolean | undefined;
  let flagReason: string | undefined;

  if (!isCustomer && partId && args.vehicle_config_id) {
    const sameConfig = await ctx.db
      .query("part_snapshots")
      .withIndex("by_service_config", (q: any) =>
        q
          .eq("service_id", args.service_id)
          .eq("vehicle_config_id", args.vehicle_config_id),
      )
      .order("desc")
      .take(OUTLIER_LOOKBACK);
    const samePart = sameConfig.filter(
      (row: any) =>
        row.part_id === partId &&
        row.supplied_by === "shop" &&
        row.superseded_by_id === undefined,
    );
    if (samePart.length >= OUTLIER_MIN_SAMPLE) {
      const med = median(samePart.map((row: any) => row.unit_cost));
      if (med > 0) {
        if (unitCost < med * OUTLIER_LOW_RATIO) {
          flaggedForReview = true;
          flagReason = "cost_outlier_low";
        } else if (unitCost > med * OUTLIER_HIGH_RATIO) {
          flaggedForReview = true;
          flagReason = "cost_outlier_high";
        }
      }
    }
  }

  if (!partId && !flaggedForReview) {
    flaggedForReview = true;
    flagReason = "missing_part_id";
  }

  const insertedId: Id<"part_snapshots"> = await ctx.db.insert("part_snapshots", {
    booking_id: args.booking_id,
    job_actual_id: args.job_actual_id,
    shop_id: args.shop_id,
    mechanic_id: args.mechanic_id,

    vehicle_id: args.vehicle_id,
    vehicle_config_id: args.vehicle_config_id,
    engine_id: args.engine_id,
    chassis_id: args.chassis_id,
    trim_id: args.trim_id,

    service_id: args.service_id,

    part_id: partId,
    part_name: args.part_name.trim(),
    oem_part_number: args.oem_part_number?.trim() || undefined,
    brand: args.brand?.trim() || undefined,
    part_tier: partTier,

    supplied_by: args.supplied_by,
    quantity,
    unit_cost: unitCost,
    total_cost: totalCost,
    currency: args.currency ?? "USD",

    flagged_for_review: flaggedForReview,
    flag_reason: flagReason,

    corrects_snapshot_id: args.corrects_snapshot_id,

    recorded_at: recordedAt,
    notes: args.notes,
  });

  if (args.corrects_snapshot_id) {
    const original = await ctx.db.get(args.corrects_snapshot_id);
    if (original) {
      await ctx.db.patch(original._id, { superseded_by_id: insertedId });
    }
  }

  if (!isCustomer && partId && args.vehicle_config_id) {
    await ctx.scheduler.runAfter(
      0,
      internal.shop_part_preferences.recordPartUsage,
      {
        shop_id: args.shop_id,
        service_id: args.service_id,
        vehicle_config_id: args.vehicle_config_id,
        part_id: partId,
        used_at: recordedAt,
      },
    );
  }

  return insertedId;
}

/** Public mutation wrapping insertSnapshotImpl. */
export const insertSnapshot = mutation({
  args: {
    booking_id: v.id("bookings"),
    job_actual_id: v.optional(v.id("job_actuals")),
    shop_id: v.id("shops"),
    mechanic_id: v.id("users"),

    vehicle_id: v.id("vehicles"),
    vehicle_config_id: v.optional(v.id("vehicle_configs")),
    engine_id: v.optional(v.id("engines")),
    chassis_id: v.optional(v.id("chassis_variants")),
    trim_id: v.optional(v.id("trims")),

    service_id: v.id("services"),

    part_id: v.optional(v.id("oem_parts")),
    part_name: v.string(),
    oem_part_number: v.optional(v.string()),
    brand: v.optional(v.string()),
    part_tier: v.optional(v.string()),

    supplied_by: v.string(),
    quantity: v.optional(v.number()),
    unit_cost: v.number(),
    currency: v.optional(v.string()),

    corrects_snapshot_id: v.optional(v.id("part_snapshots")),
    notes: v.optional(v.string()),
    recorded_at: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await insertSnapshotImpl(ctx, args);
  },
});

/**
 * All non-superseded snapshots for a booking, in the order they were recorded.
 * Powers the booking-detail panel's parts view once we cut over from the
 * embedded job_actuals.parts_used array.
 */
export const listByBooking = query({
  args: { booking_id: v.id("bookings") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("part_snapshots")
      .withIndex("by_booking", (q) => q.eq("booking_id", args.booking_id))
      .collect();
    return rows
      .filter((row) => row.superseded_by_id === undefined)
      .sort((a, b) => a.recorded_at - b.recorded_at);
  },
});

/**
 * Cross-shop aggregate for the parts-prefill cascade (layer 2). Groups
 * non-superseded shop-supplied snapshots for (service, vehicle_config) by
 * part_id and returns the top N by use count. Skips part_id=null entries —
 * those need catalog promotion before they can be suggested.
 */
export const aggregateByServiceConfig = query({
  args: {
    service_id: v.id("services"),
    vehicle_config_id: v.id("vehicle_configs"),
    limit: v.optional(v.number()),
    min_sample: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 2;
    const minSample = args.min_sample ?? 5;

    const rows = await ctx.db
      .query("part_snapshots")
      .withIndex("by_service_config", (q) =>
        q
          .eq("service_id", args.service_id)
          .eq("vehicle_config_id", args.vehicle_config_id),
      )
      .collect();

    const eligible = rows.filter(
      (row) =>
        row.superseded_by_id === undefined &&
        row.supplied_by === "shop" &&
        row.part_id !== undefined,
    );
    if (eligible.length < minSample) return [];

    const byPart = new Map<
      string,
      {
        part_id: Id<"oem_parts">;
        use_count: number;
        last_used_at: number;
        median_unit_cost: number;
        sample_unit_costs: number[];
      }
    >();
    for (const row of eligible) {
      const key = row.part_id as Id<"oem_parts">;
      const bucket = byPart.get(key as unknown as string);
      if (bucket) {
        bucket.use_count += 1;
        bucket.last_used_at = Math.max(bucket.last_used_at, row.recorded_at);
        bucket.sample_unit_costs.push(row.unit_cost);
      } else {
        byPart.set(key as unknown as string, {
          part_id: key,
          use_count: 1,
          last_used_at: row.recorded_at,
          median_unit_cost: 0,
          sample_unit_costs: [row.unit_cost],
        });
      }
    }

    const aggregated = Array.from(byPart.values())
      .map((bucket) => ({
        part_id: bucket.part_id,
        use_count: bucket.use_count,
        last_used_at: bucket.last_used_at,
        median_unit_cost: median(bucket.sample_unit_costs),
      }))
      .sort((a, b) => b.use_count - a.use_count)
      .slice(0, limit);

    return aggregated;
  },
});

/**
 * Admin queue: flagged snapshots that need review (cost outliers, missing
 * catalog match, manual flags). Newest first. Routes into the same triage
 * surface as app_feedback.
 */
export const listFlagged = query({
  args: {
    limit: v.optional(v.number()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;
    const rows = await ctx.db
      .query("part_snapshots")
      .withIndex("by_flagged", (q) => q.eq("flagged_for_review", true))
      .order("desc")
      .take(limit * 4);
    const filtered = args.reason
      ? rows.filter((row) => row.flag_reason === args.reason)
      : rows;
    return filtered
      .filter((row) => row.superseded_by_id === undefined)
      .slice(0, limit);
  },
});

/**
 * Manual flag — admin marks a snapshot for review with a free-form reason.
 * Distinct from the automatic outlier/missing-catalog flags so we can tell
 * model decisions from human ones in the queue.
 */
export const flagManually = internalMutation({
  args: {
    snapshot_id: v.id("part_snapshots"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.snapshot_id, {
      flagged_for_review: true,
      flag_reason: args.reason ?? "manual",
    });
  },
});

/**
 * Admin clears the flag once the snapshot has been reviewed. Snapshots
 * themselves stay append-only — the flag is the only adjustable signal here.
 */
export const clearFlag = internalMutation({
  args: { snapshot_id: v.id("part_snapshots") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.snapshot_id, {
      flagged_for_review: false,
      flag_reason: undefined,
    });
  },
});

export type PartSnapshot = Doc<"part_snapshots">;
