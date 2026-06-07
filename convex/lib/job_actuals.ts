import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import {
  deleteSpecVarianceByJobActualId,
  upsertSpecVarianceRecord,
} from "../spec_variances";
import {
  partsAccuracyStatusValidator,
  postjobPartValidator,
  prejobReportValidator,
  vehicleUpdateValuesValidator,
} from "./vehicle_passports";
import { recomputeLaborForConfigService } from "./labor_aggregation";

export const jobActualPartValidator = postjobPartValidator;

export const jobActualInputValidator = v.object({
  actual_labor_minutes: v.optional(v.union(v.float64(), v.null())),
  actual_parts_cost: v.optional(v.union(v.float64(), v.null())),
  difficulty_rating: v.optional(v.union(v.float64(), v.null())),
  technician_notes: v.optional(v.union(v.string(), v.null())),
  parts_used: v.optional(v.union(v.array(jobActualPartValidator), v.null())),
  prejob_report: v.optional(v.union(prejobReportValidator, v.null())),
  completion_mileage: v.optional(v.union(v.float64(), v.null())),
  vehicle_updates: v.optional(v.union(vehicleUpdateValuesValidator, v.null())),
  parts_accuracy_status: v.optional(v.union(partsAccuracyStatusValidator, v.null())),
  parts_accuracy_feedback: v.optional(v.union(v.string(), v.null())),
  additional_observations: v.optional(v.union(v.string(), v.null())),
  flagged_vehicle_specs: v.optional(v.union(v.boolean(), v.null())),
  flagged_vehicle_specs_reason: v.optional(v.union(v.string(), v.null())),
});

export type JobActualPartInput = {
  part_name: string;
  brand?: string | null;
  oem_number: string;
  cost: number;
  quantity?: number;
  supplied_by?: string;
  part_tier?: string;
  service_id?: Id<"services">;
  source?: "catalog" | "manual";
  swap_from_oem_number?: string;
  not_used?: boolean;
};

export type JobActualInput = {
  actual_labor_minutes?: number | null;
  actual_parts_cost?: number | null;
  difficulty_rating?: number | null;
  technician_notes?: string | null;
  parts_used?: JobActualPartInput[] | null;
  prejob_report?: Record<string, unknown> | null;
  completion_mileage?: number | null;
  vehicle_updates?: Record<string, unknown> | null;
  parts_accuracy_status?: "correct" | "different_parts" | null;
  parts_accuracy_feedback?: string | null;
  additional_observations?: string | null;
  flagged_vehicle_specs?: boolean | null;
  flagged_vehicle_specs_reason?: string | null;
};

function hasOwn<T extends object>(value: T | undefined, key: keyof T) {
  return !!value && Object.prototype.hasOwnProperty.call(value, key);
}

function calculatePercentile(values: number[], percentile: number) {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0];

  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * percentile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) {
    return sorted[lower];
  }

  const weight = index - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}

function primaryServiceId(booking: {
  service_ids?: Id<"services">[];
}): Id<"services"> | undefined {
  return booking.service_ids?.[0];
}

export async function getJobActualsForBooking(ctx: any, bookingId: any) {
  const rows = await ctx.db
    .query("job_actuals")
    .withIndex("by_booking_id", (q: any) => q.eq("booking_id", bookingId))
    .collect();

  return rows.sort(
    (left: any, right: any) =>
      (right.updated_at ?? right._creationTime ?? 0) -
      (left.updated_at ?? left._creationTime ?? 0)
  );
}

export async function getLatestJobActualForBooking(ctx: any, bookingId: any) {
  const rows = await getJobActualsForBooking(ctx, bookingId);
  return rows[0] ?? null;
}

function getJobActualMechanicId(booking: any, mechanicId?: any) {
  const resolvedMechanicId = mechanicId ?? booking.mechanic_id;
  if (!resolvedMechanicId) {
    throw new Error("A mechanic must be assigned before recording job actuals.");
  }
  return resolvedMechanicId;
}

export function getAutoActualLaborMinutes({
  jobActual,
  fallbackMinutes,
  now,
}: {
  jobActual?: any;
  fallbackMinutes?: number | null;
  now: number;
}) {
  if (jobActual?.started_at != null) {
    return Math.max(0, Math.round((now - jobActual.started_at) / 60000));
  }
  if (jobActual?.actual_labor_minutes != null) {
    return jobActual.actual_labor_minutes;
  }
  return fallbackMinutes ?? undefined;
}

export async function ensureJobActualRecord(
  ctx: any,
  {
    booking,
    mechanicId,
    now,
    startedAtMs,
    completedAtMs,
  }: {
    booking: any;
    mechanicId?: any;
    now: number;
    startedAtMs?: number;
    completedAtMs?: number;
  }
) {
  const resolvedMechanicId = getJobActualMechanicId(booking, mechanicId);
  const existing = await getLatestJobActualForBooking(ctx, booking._id);

  if (existing) {
    const patch: Record<string, any> = {
      updated_at: now,
    };

    if (String(existing.mechanic_id) !== String(resolvedMechanicId)) {
      patch.mechanic_id = resolvedMechanicId;
    }
    if (startedAtMs != null && existing.started_at == null) {
      patch.started_at = startedAtMs;
    }
    if (completedAtMs != null && existing.completed_at_ms == null) {
      patch.completed_at_ms = completedAtMs;
    }

    if (Object.keys(patch).length > 1) {
      await ctx.db.patch(existing._id, patch);
      return {
        ...existing,
        ...patch,
      };
    }

    return existing;
  }

  const jobActualId = await ctx.db.insert("job_actuals", {
    booking_id: booking._id,
    mechanic_id: resolvedMechanicId,
    started_at: startedAtMs,
    completed_at_ms: completedAtMs,
    created_at: now,
    updated_at: now,
    parts_used: [],
    technician_notes: "",
  });

  return await ctx.db.get(jobActualId);
}

function applyActualsInputToPatch(patch: Record<string, any>, actuals?: JobActualInput) {
  if (!actuals) return;

  if (hasOwn(actuals, "actual_labor_minutes")) {
    patch.actual_labor_minutes = actuals.actual_labor_minutes ?? undefined;
  }
  if (hasOwn(actuals, "actual_parts_cost")) {
    patch.actual_parts_cost = actuals.actual_parts_cost ?? undefined;
  }
  if (hasOwn(actuals, "difficulty_rating")) {
    patch.difficulty_rating = actuals.difficulty_rating ?? undefined;
  }
  if (hasOwn(actuals, "technician_notes")) {
    patch.technician_notes = actuals.technician_notes ?? "";
  }
  if (hasOwn(actuals, "parts_used")) {
    patch.parts_used = actuals.parts_used ?? [];
  }
  if (hasOwn(actuals, "prejob_report")) {
    patch.prejob_report = actuals.prejob_report ?? undefined;
  }
  if (hasOwn(actuals, "completion_mileage")) {
    patch.completion_mileage = actuals.completion_mileage ?? undefined;
  }
  if (hasOwn(actuals, "vehicle_updates")) {
    patch.vehicle_updates = actuals.vehicle_updates ?? undefined;
  }
  if (hasOwn(actuals, "parts_accuracy_status")) {
    patch.parts_accuracy_status = actuals.parts_accuracy_status ?? undefined;
  }
  if (hasOwn(actuals, "parts_accuracy_feedback")) {
    patch.parts_accuracy_feedback = actuals.parts_accuracy_feedback ?? undefined;
  }
  if (hasOwn(actuals, "additional_observations")) {
    patch.additional_observations = actuals.additional_observations ?? undefined;
  }
  if (hasOwn(actuals, "flagged_vehicle_specs")) {
    patch.flagged_vehicle_specs = actuals.flagged_vehicle_specs ?? undefined;
  }
  if (hasOwn(actuals, "flagged_vehicle_specs_reason")) {
    patch.flagged_vehicle_specs_reason =
      actuals.flagged_vehicle_specs_reason ?? undefined;
  }
}

async function resolveLearningContext(ctx: any, booking: any) {
  const serviceId = primaryServiceId(booking);
  if (!serviceId) return null;

  const service = await ctx.db.get(serviceId);
  if (!service) return null;

  const vehicle = await ctx.db
    .query("vehicles")
    .withIndex("by_vin", (q: any) => q.eq("vin", booking.vin))
    .unique();
  if (!vehicle) {
    return {
      serviceId,
      service,
      vehicle: null,
      vehicleConfigId: null,
      engineId: null,
    };
  }

  return {
    serviceId,
    service,
    vehicle,
    vehicleConfigId: vehicle.vehicle_config_id ?? null,
    engineId: vehicle.engine_id ?? null,
  };
}

async function recomputeEmpiricalLaborTimes(
  ctx: any,
  {
    vehicleConfigId,
    serviceId,
    now,
  }: {
    vehicleConfigId: any;
    serviceId: any;
    now: number;
  }
) {
  // Delegates to the shared labor aggregator: book_hours from the robust median
  // of catalog observations, empirical_hours from SINGLE-service post-job actuals
  // gated at LABOR_EMPIRICAL_MIN_SAMPLES. (The previous implementation full-scanned
  // job_actuals, used a plain mean, and credited a multi-service booking's whole
  // duration to service_ids[0] — all fixed in recomputeLaborForConfigService.)
  await recomputeLaborForConfigService(ctx, { vehicleConfigId, serviceId, now });
}

async function upsertSpecVarianceForJobActual(
  ctx: any,
  {
    booking,
    jobActual,
  }: {
    booking: any;
    jobActual: any;
  }
) {
  const context = await resolveLearningContext(ctx, booking);
  if (!context?.engineId || !context.serviceId || jobActual.actual_labor_minutes == null) {
    await deleteSpecVarianceByJobActualId(ctx, jobActual._id);
    return;
  }

  const allSpecs = await ctx.db.query("service_vehicle_specs").collect();
  const spec = allSpecs.find(
    (row: any) =>
      String(row.service_id) === String(context.serviceId) &&
      String(row.engine_id) === String(context.engineId)
  );

  const predictedLaborHours = spec?.labor_hours ?? context.service.default_labor_hours ?? 0;
  const predictedPartsCost = spec
    ? ((spec.parts_cost_low ?? 0) + (spec.parts_cost_high ?? 0)) / 2
    : 0;

  await upsertSpecVarianceRecord(ctx, {
    engine_id: context.engineId,
    service_id: context.serviceId,
    job_actual_id: jobActual._id,
    predicted_labor_hours: predictedLaborHours,
    actual_labor_hours: jobActual.actual_labor_minutes / 60,
    predicted_parts_cost: predictedPartsCost,
    actual_parts_cost: jobActual.actual_parts_cost ?? 0,
  });
}

export async function syncJobActualDerivedData(
  ctx: any,
  {
    booking,
    jobActual,
    now,
  }: {
    booking: any;
    jobActual: any;
    now: number;
  }
) {
  const context = await resolveLearningContext(ctx, booking);

  if (!jobActual?.finalized_at_ms) {
    await deleteSpecVarianceByJobActualId(ctx, jobActual?._id);
  } else {
    await upsertSpecVarianceForJobActual(ctx, { booking, jobActual });
  }

  if (context?.vehicleConfigId && context?.serviceId) {
    await recomputeEmpiricalLaborTimes(ctx, {
      vehicleConfigId: context.vehicleConfigId,
      serviceId: context.serviceId,
      now,
    });
  }
}

export async function saveJobActualDraft(
  ctx: any,
  {
    booking,
    actuals,
    now,
    startedAtMs,
    completedAtMs,
    preferAutoLaborMinutes = false,
    actorUserId,
  }: {
    booking: any;
    actuals?: JobActualInput;
    now: number;
    startedAtMs?: number;
    completedAtMs?: number;
    preferAutoLaborMinutes?: boolean;
    /** Mechanic / shop-staff user attributed for the parts-edit audit log.
     *  Optional so system-driven paths can still call the helper, but when
     *  parts_used changes without an actor we skip the audit-log writes
     *  (better silent than misattributed). */
    actorUserId?: Id<"users">;
  }
) {
  const existing = await ensureJobActualRecord(ctx, {
    booking,
    now,
    startedAtMs,
    completedAtMs,
  });

  const patch: Record<string, any> = {
    updated_at: now,
    logged_at_ms: now,
  };

  if (startedAtMs != null && existing.started_at == null) {
    patch.started_at = startedAtMs;
  }
  if (completedAtMs != null) {
    patch.completed_at_ms = completedAtMs;
  }

  // Diff parts_used BEFORE the patch so we have a clean prev/next pair. Skip
  // when we don't have an actor — audit rows without `edited_by_user_id`
  // would leave the log half-attributed and the schema requires the field.
  if (
    actorUserId &&
    actuals &&
    Object.prototype.hasOwnProperty.call(actuals, "parts_used")
  ) {
    await recordPartEdits(ctx, {
      bookingId: booking._id,
      jobActualId: existing._id,
      previousParts: Array.isArray((existing as any).parts_used)
        ? ((existing as any).parts_used as any[])
        : [],
      nextParts: Array.isArray(actuals.parts_used) ? actuals.parts_used : [],
      actorUserId,
      now,
    });
  }

  applyActualsInputToPatch(patch, actuals);

  if (
    preferAutoLaborMinutes &&
    !hasOwn(actuals, "actual_labor_minutes") &&
    patch.actual_labor_minutes === undefined
  ) {
    patch.actual_labor_minutes = getAutoActualLaborMinutes({
      jobActual: {
        ...existing,
        ...patch,
      },
      fallbackMinutes: booking.estimated_labor_minutes ?? null,
      now: completedAtMs ?? now,
    });
  }

  await ctx.db.patch(existing._id, patch);
  return await ctx.db.get(existing._id);
}

export async function finalizeJobActuals(
  ctx: any,
  {
    booking,
    userId,
    actuals,
    now,
  }: {
    booking: any;
    userId: any;
    actuals?: JobActualInput;
    now: number;
  }
) {
  const draft = await saveJobActualDraft(ctx, {
    booking,
    actuals,
    now,
    preferAutoLaborMinutes: true,
    actorUserId: userId,
  });

  await ctx.db.patch(draft._id, {
    completed_at_ms: draft.completed_at_ms ?? now,
    finalized_at_ms: now,
    finalized_by_user_id: userId,
    logged_at_ms: now,
    updated_at: now,
  });

  const finalized = await ctx.db.get(draft._id);
  await syncJobActualDerivedData(ctx, {
    booking,
    jobActual: finalized,
    now,
  });
  return finalized;
}

export async function reopenJobActuals(
  ctx: any,
  {
    booking,
    now,
  }: {
    booking: any;
    now: number;
  }
) {
  const jobActual = await getLatestJobActualForBooking(ctx, booking._id);
  if (!jobActual) {
    throw new Error("No job_actuals found for this booking");
  }

  await ctx.db.patch(jobActual._id, {
    finalized_at_ms: undefined,
    finalized_by_user_id: undefined,
    updated_at: now,
  });

  const reopened = await ctx.db.get(jobActual._id);
  await syncJobActualDerivedData(ctx, {
    booking,
    jobActual: reopened,
    now,
  });
  return reopened;
}

// ---------------------------------------------------------------------------
// Part-edit audit log
// ---------------------------------------------------------------------------

function partKey(part: any): string {
  const oem = String(part?.oem_number ?? "").trim();
  if (oem) return `oem:${oem.toLowerCase()}`;
  const name = String(part?.part_name ?? "").trim();
  return name ? `name:${name.toLowerCase()}` : "";
}

function partSnapshotSummary(part: any): string {
  // Tiny JSON summary stamped into added/removed audit rows so the log is
  // readable without having to reconstruct historical parts_used state.
  return JSON.stringify({
    name: part?.part_name ?? null,
    oem: part?.oem_number ?? null,
    brand: part?.brand ?? null,
    cost: part?.cost ?? null,
    quantity: part?.quantity ?? 1,
    supplied_by: part?.supplied_by ?? "shop",
    source: part?.source ?? null,
  });
}

async function recordPartEdits(
  ctx: any,
  {
    bookingId,
    jobActualId,
    previousParts,
    nextParts,
    actorUserId,
    now,
  }: {
    bookingId: Id<"bookings">;
    jobActualId: Id<"job_actuals">;
    previousParts: any[];
    nextParts: any[];
    actorUserId: Id<"users">;
    now: number;
  },
) {
  const prevMap = new Map<string, any>();
  for (const part of previousParts) {
    const key = partKey(part);
    if (key) prevMap.set(key, part);
  }
  const nextMap = new Map<string, any>();
  for (const part of nextParts) {
    const key = partKey(part);
    if (key) nextMap.set(key, part);
  }

  // First pass: detect swaps via the explicit swap_from_oem_number marker.
  // A swap manifests across two keys (old oem → new oem), so we'd normally
  // log it as paired remove+add. With the marker, we emit a single "swap"
  // audit row and skip both keys in the standard diff below.
  const consumedKeys = new Set<string>();
  for (const next of nextParts) {
    const swapFromOem = next?.swap_from_oem_number;
    if (!swapFromOem || typeof swapFromOem !== "string") continue;
    const fromKey = `oem:${swapFromOem.trim().toLowerCase()}`;
    const toKey = partKey(next);
    const prev = prevMap.get(fromKey);
    // Only emit the swap audit when we actually have the swapped-from row in
    // the prior state — otherwise the swap is stale (e.g. submitted twice)
    // and the standard diff handles it.
    if (!prev || !toKey) continue;
    await ctx.db.insert("job_actual_part_edits", {
      booking_id: bookingId,
      job_actual_id: jobActualId,
      part_key: toKey,
      edit_type: "swap",
      old_value: swapFromOem,
      new_value: String(next.oem_number ?? ""),
      part_name_snapshot: next.part_name ? String(next.part_name) : undefined,
      oem_number_snapshot: next.oem_number ? String(next.oem_number) : undefined,
      edited_by_user_id: actorUserId,
      edited_at: now,
    });
    consumedKeys.add(fromKey);
    consumedKeys.add(toKey);
  }

  const allKeys = new Set<string>([...prevMap.keys(), ...nextMap.keys()]);

  for (const key of allKeys) {
    if (consumedKeys.has(key)) continue;
    const prev = prevMap.get(key);
    const next = nextMap.get(key);
    const snapshotSource = next ?? prev;
    const partNameSnap = snapshotSource?.part_name
      ? String(snapshotSource.part_name)
      : undefined;
    const oemSnap = snapshotSource?.oem_number
      ? String(snapshotSource.oem_number)
      : undefined;

    if (!prev && next) {
      await ctx.db.insert("job_actual_part_edits", {
        booking_id: bookingId,
        job_actual_id: jobActualId,
        part_key: key,
        edit_type: "added",
        new_value: partSnapshotSummary(next),
        part_name_snapshot: partNameSnap,
        oem_number_snapshot: oemSnap,
        edited_by_user_id: actorUserId,
        edited_at: now,
      });
      continue;
    }

    if (prev && !next) {
      await ctx.db.insert("job_actual_part_edits", {
        booking_id: bookingId,
        job_actual_id: jobActualId,
        part_key: key,
        edit_type: "removed",
        old_value: partSnapshotSummary(prev),
        part_name_snapshot: partNameSnap,
        oem_number_snapshot: oemSnap,
        edited_by_user_id: actorUserId,
        edited_at: now,
      });
      continue;
    }

    // Both present — compare the four mutable fields. Identity fields
    // (part_name, brand, oem_number) on catalog rows are locked in the UI;
    // we don't bother diffing them here because either the key would already
    // differ (oem change → key change → handled as add/remove pair above),
    // or the change came from a custom row where free-text edits are
    // expected and don't need a separate audit row beyond the field that
    // actually drives downstream behavior.

    const prevCost = String(prev.cost ?? "");
    const nextCost = String(next.cost ?? "");
    if (prevCost !== nextCost) {
      await ctx.db.insert("job_actual_part_edits", {
        booking_id: bookingId,
        job_actual_id: jobActualId,
        part_key: key,
        edit_type: "price",
        old_value: prevCost,
        new_value: nextCost,
        part_name_snapshot: partNameSnap,
        oem_number_snapshot: oemSnap,
        edited_by_user_id: actorUserId,
        edited_at: now,
      });
    }

    const prevQty = String(prev.quantity ?? 1);
    const nextQty = String(next.quantity ?? 1);
    if (prevQty !== nextQty) {
      await ctx.db.insert("job_actual_part_edits", {
        booking_id: bookingId,
        job_actual_id: jobActualId,
        part_key: key,
        edit_type: "quantity",
        old_value: prevQty,
        new_value: nextQty,
        part_name_snapshot: partNameSnap,
        oem_number_snapshot: oemSnap,
        edited_by_user_id: actorUserId,
        edited_at: now,
      });
    }

    const prevSupplier = String(prev.supplied_by ?? "shop");
    const nextSupplier = String(next.supplied_by ?? "shop");
    if (prevSupplier !== nextSupplier) {
      await ctx.db.insert("job_actual_part_edits", {
        booking_id: bookingId,
        job_actual_id: jobActualId,
        part_key: key,
        edit_type: "supplied_by",
        old_value: prevSupplier,
        new_value: nextSupplier,
        part_name_snapshot: partNameSnap,
        oem_number_snapshot: oemSnap,
        edited_by_user_id: actorUserId,
        edited_at: now,
      });
    }

    const prevNotUsed = prev.not_used === true;
    const nextNotUsed = next.not_used === true;
    if (prevNotUsed !== nextNotUsed) {
      await ctx.db.insert("job_actual_part_edits", {
        booking_id: bookingId,
        job_actual_id: jobActualId,
        part_key: key,
        edit_type: "not_used",
        old_value: prevNotUsed ? "true" : "false",
        new_value: nextNotUsed ? "true" : "false",
        part_name_snapshot: partNameSnap,
        oem_number_snapshot: oemSnap,
        edited_by_user_id: actorUserId,
        edited_at: now,
      });
    }
  }
}
