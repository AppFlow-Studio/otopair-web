/**
 * undoMechanicVerification — reverses a previously-accepted mechanic verification.
 *
 * What it does:
 *   1. Walks the verification's review_decisions / verifications fields
 *   2. For each accepted field, restores the previous value (our_value) to the
 *      appropriate data table (engines / transmissions / chassis_specs /
 *      trim_specs / vehicle_configs)
 *   3. Flips enrichment_evidence: marks the mechanic-source latest as
 *      is_latest:false, restores the most recent retired non-mechanic evidence
 *      back to is_latest:true (if any exists)
 *   4. Decrements verification_count on the vehicle_config (and unverifies if
 *      it drops below 3)
 *   5. Resets the verification row to status:"pending" so it can be re-reviewed
 *   6. Writes one audit_log entry per field with the from → to values
 *
 * Run from Convex dashboard: Functions → undoMechanicVerification → undoById
 * or undoLatest (which finds the most recent accepted verification).
 */

import { mutation, action, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

// Same routing as partialAccept used
const ENGINE_FIELDS = new Set([
  "oil_viscosity", "oil_capacity_qts", "coolant_type", "coolant_capacity_qts",
  "spark_plug_quantity", "spark_plug_gap_mm", "timing_system", "aspiration",
  "fuel_type", "fuel_injection", "water_pump_timing_driven", "cylinders",
  "displacement_l", "engine_code", "configuration", "engine_family",
]);
const TRANSMISSION_FIELDS = new Set([
  "transmission_type", "fluid_type", "fluid_capacity_drain_fill_qts",
  "is_lifetime_fill", "has_serviceable_filter", "service_method", "code", "speeds",
]);
const CHASSIS_FIELDS = new Set([
  "lug_nut_torque_ft_lbs", "wiper_blade_driver_size_in", "wiper_blade_passenger_size_in",
  "wiper_blade_rear_size_in", "battery_group", "battery_type", "battery_location",
  "steering_type", "parking_brake_type", "has_rear_wiper", "has_brake_pad_sensor",
]);
const TRIM_FIELDS = new Set([
  "tire_size_front", "tire_size_rear", "recommended_tire_pressure_front_psi",
  "recommended_tire_pressure_rear_psi", "is_staggered", "tire_directional",
  "is_run_flat", "alignment_type",
]);
const CONFIG_FIELDS = new Set([
  "brake_fluid_type", "ps_fluid_type", "drivetrain", "chassis_code",
  "brake_fluid_capacity_oz", "ps_fluid_capacity_oz",
]);

function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return "(empty)";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
}

/**
 * applyRevertPatch — patches a row, but properly REMOVES keys whose value is
 * null/undefined (which the schema rejects on patch). It does this by reading
 * the current row, computing the new shape, and using db.replace().
 *
 * Non-null/non-undefined keys are applied as normal field updates.
 */
async function applyRevertPatch(
  ctx: any,
  rowId: any,
  values: Record<string, unknown>,
) {
  if (Object.keys(values).length === 0) return;
  const current = await ctx.db.get(rowId);
  if (!current) return;
  const { _id, _creationTime, ...rest } = current;
  const next: Record<string, unknown> = { ...rest };
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === null) {
      delete next[k];
    } else {
      next[k] = v;
    }
  }
  await ctx.db.replace(rowId, next);
}

export const undoById = mutation({
  args: {
    id: v.id("mechanic_verifications"),
    actorName: v.string(),
    actorId: v.optional(v.id("director_users")),
  },
  handler: async (ctx, { id, actorName, actorId }) => {
    const row = await ctx.db.get(id);
    if (!row) return { ok: false as const, reason: "not_found" };
    if (row.status !== "accepted") {
      return { ok: false as const, reason: `not_accepted (status=${row.status})` };
    }

    const config = await ctx.db.get(row.vehicle_config_id);
    if (!config) return { ok: false as const, reason: "config_not_found" };

    const now = Date.now();
    const entityId = String(row.vehicle_config_id);
    const fields: any[] = Array.isArray(row.verifications) ? row.verifications : [];
    const reviewDecisions: any[] = Array.isArray((row as any).review_decisions)
      ? (row as any).review_decisions
      : [];

    const configPatch:       Record<string, unknown> = {};
    const enginePatch:       Record<string, unknown> = {};
    const transmissionPatch: Record<string, unknown> = {};
    const chassisPatch:      Record<string, unknown> = {};
    const trimPatch:         Record<string, unknown> = {};

    const undoneFields: { name: string; from: unknown; to: unknown }[] = [];

    // If review_decisions exists, use it (new partialAccept format).
    // Otherwise treat every non-unknown field as accepted (legacy format).
    const decisions = reviewDecisions.length > 0
      ? reviewDecisions
      : fields
          .filter((f: any) => f.status !== "unknown")
          .map((f: any) => ({ field_name: f.field_name, action: "accept" }));

    for (const decision of decisions) {
      if (decision.action === "skip") continue;

      const field = fields.find((f: any) => f.field_name === decision.field_name);
      if (!field) continue;

      const appliedValue = decision.action === "override"
        ? decision.override_value
        : (field.status === "confirmed" ? field.our_value : field.corrected_value);
      // Convex schema validators reject `null` for optional fields — patch with
      // `undefined` instead, which Convex treats as "delete this field" so the
      // record reverts to schema-missing (the pre-mechanic state).
      const restoredValue = field.our_value === null ? undefined : field.our_value;

      undoneFields.push({
        name: decision.field_name,
        from: appliedValue,
        to: field.our_value,
      });

      // Retire mechanic-source latest evidence; restore most recent non-mechanic
      // retired evidence to is_latest:true (if any)
      const all = await ctx.db
        .query("enrichment_evidence")
        .withIndex("by_entity_field", q =>
          q.eq("entity_type", "vehicle_config")
           .eq("entity_id", entityId)
           .eq("field_name", decision.field_name)
        )
        .collect();

      for (const e of all) {
        if (e.is_latest && e.source_type === "mechanic") {
          await ctx.db.patch(e._id, { is_latest: false });
        }
      }
      const previous = all
        .filter(e => !e.is_latest && e.source_type !== "mechanic")
        .sort((a, b) => (b.observed_at ?? 0) - (a.observed_at ?? 0))[0];
      if (previous) await ctx.db.patch(previous._id, { is_latest: true });

      // Restore prior value to the data table
      if (ENGINE_FIELDS.has(decision.field_name)) {
        enginePatch[decision.field_name] = restoredValue;
      } else if (TRANSMISSION_FIELDS.has(decision.field_name)) {
        transmissionPatch[decision.field_name] = restoredValue;
      } else if (CHASSIS_FIELDS.has(decision.field_name)) {
        chassisPatch[decision.field_name] = restoredValue;
      } else if (TRIM_FIELDS.has(decision.field_name)) {
        trimPatch[decision.field_name] = restoredValue;
      } else if (CONFIG_FIELDS.has(decision.field_name)) {
        configPatch[decision.field_name] = restoredValue;
      }
    }

    // Apply patches via applyRevertPatch — uses db.replace under the hood so
    // null/undefined values remove the field cleanly (db.patch can't drop
    // schema-required fields by passing undefined in this Convex version).
    await applyRevertPatch(ctx, row.vehicle_config_id, configPatch);
    if (config.engine_id)         await applyRevertPatch(ctx, config.engine_id,       enginePatch);
    if (config.transmission_id)   await applyRevertPatch(ctx, config.transmission_id, transmissionPatch);
    if (config.chassis_code) {
      const chassisRow = await ctx.db
        .query("chassis_specs")
        .withIndex("by_chassis_code", q => q.eq("chassis_code", config.chassis_code!))
        .unique();
      if (chassisRow) await applyRevertPatch(ctx, chassisRow._id, chassisPatch);
    }
    {
      const trimRow = await ctx.db
        .query("trim_specs")
        .withIndex("by_vehicle_config", q => q.eq("vehicle_config_id", row.vehicle_config_id))
        .first();
      if (trimRow) await applyRevertPatch(ctx, trimRow._id, trimPatch);
    }

    // Decrement verification_count + maybe re-downgrade enrichment_status
    const newCount = Math.max(0, (config.verification_count ?? 1) - 1);
    const patch: Record<string, unknown> = { verification_count: newCount };
    if (newCount < 3 && config.enrichment_status === "verified") {
      patch.enrichment_status = "enriched";
    }
    await ctx.db.patch(row.vehicle_config_id, patch as any);

    // Mark as "undone" — a terminal state distinct from rejected/pending.
    // Keeps the audit trail: this verification was accepted, then reverted.
    // verified_at and reviewer_id stay populated so we know WHEN and BY WHOM
    // the revert happened (last patch wins).
    await ctx.db.patch(id, {
      status: "undone",
      verified_at: now,
      reviewer_id: actorId,
    } as any);

    // Audit: one entry per field with from → to
    for (const u of undoneFields) {
      await ctx.db.insert("audit_log", {
        entity_type: "vehicle_config",
        entity_id: entityId,
        action: "field_edit",
        actor: actorName,
        actor_id: actorId,
        detail: `Undo: ${u.name}  ${fmtVal(u.from)} → ${fmtVal(u.to)}`,
        created_at: now,
      });
    }
    // Summary entry
    await ctx.db.insert("audit_log", {
      entity_type: "vehicle_config",
      entity_id: entityId,
      action: "field_edit",
      actor: actorName,
      actor_id: actorId,
      detail: `Mechanic verification reverted — ${undoneFields.length} fields restored`,
      created_at: now,
    });

    return { ok: true as const, undoneFields: undoneFields.length };
  },
});

/**
 * undoLatest — convenience action that finds the most recent accepted
 * verification and undoes it. Calls undoById internally.
 */
export const _findLatestAccepted = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("mechanic_verifications")
      .withIndex("by_status", q => q.eq("status", "accepted"))
      .order("desc")
      .take(1);
    return rows[0] ?? null;
  },
});

export const undoLatest = action({
  args: {},
  handler: async (ctx): Promise<
    | { ok: false; reason: string }
    | { ok: true; undoneFields: number; verificationId: string }
  > => {
    const latest = await ctx.runQuery(internal.undoMechanicVerification._findLatestAccepted, {});
    if (!latest) return { ok: false, reason: "No accepted verification found." };

    const result: { ok: boolean; reason?: string; undoneFields?: number } = await ctx.runMutation(
      internal.undoMechanicVerification._undoInternal,
      { id: latest._id }
    );
    if (!result.ok) return { ok: false, reason: result.reason ?? "unknown" };
    return { ok: true, undoneFields: result.undoneFields ?? 0, verificationId: String(latest._id) };
  },
});

// Internal wrapper — same logic as undoById but uses a hard-coded actor since
// actions can't easily forward the calling director's session.
export const _undoInternal = internalMutation({
  args: { id: v.id("mechanic_verifications") },
  handler: async (ctx, { id }): Promise<{ ok: boolean; reason?: string; undoneFields?: number }> => {
    const row: any = await ctx.db.get(id);
    if (!row) return { ok: false, reason: "not_found" };
    if (row.status !== "accepted") return { ok: false, reason: `not_accepted (status=${row.status})` };

    const config: any = await ctx.db.get(row.vehicle_config_id);
    if (!config) return { ok: false, reason: "config_not_found" };

    const now = Date.now();
    const entityId = String(row.vehicle_config_id);
    const fields: any[] = Array.isArray(row.verifications) ? row.verifications : [];
    const reviewDecisions: any[] = Array.isArray(row.review_decisions) ? row.review_decisions : [];

    const configPatch:       Record<string, unknown> = {};
    const enginePatch:       Record<string, unknown> = {};
    const transmissionPatch: Record<string, unknown> = {};
    const chassisPatch:      Record<string, unknown> = {};
    const trimPatch:         Record<string, unknown> = {};

    const undoneFields: { name: string; from: unknown; to: unknown }[] = [];

    const decisions = reviewDecisions.length > 0
      ? reviewDecisions
      : fields
          .filter((f: any) => f.status !== "unknown")
          .map((f: any) => ({ field_name: f.field_name, action: "accept" }));

    for (const decision of decisions) {
      if (decision.action === "skip") continue;
      const field = fields.find((f: any) => f.field_name === decision.field_name);
      if (!field) continue;

      const appliedValue = decision.action === "override"
        ? decision.override_value
        : (field.status === "confirmed" ? field.our_value : field.corrected_value);
      // null our_value → undefined, which Convex .patch() interprets as
      // "delete the field" (schema validators reject null for non-nullable optional fields).
      const restoredValue = field.our_value === null ? undefined : field.our_value;

      undoneFields.push({ name: decision.field_name, from: appliedValue, to: field.our_value });

      const all = await ctx.db
        .query("enrichment_evidence")
        .withIndex("by_entity_field", q =>
          q.eq("entity_type", "vehicle_config")
           .eq("entity_id", entityId)
           .eq("field_name", decision.field_name)
        )
        .collect();
      for (const e of all) {
        if (e.is_latest && e.source_type === "mechanic") {
          await ctx.db.patch(e._id, { is_latest: false });
        }
      }
      const previous = all
        .filter(e => !e.is_latest && e.source_type !== "mechanic")
        .sort((a, b) => (b.observed_at ?? 0) - (a.observed_at ?? 0))[0];
      if (previous) await ctx.db.patch(previous._id, { is_latest: true });

      if (ENGINE_FIELDS.has(decision.field_name))         enginePatch[decision.field_name]       = restoredValue;
      else if (TRANSMISSION_FIELDS.has(decision.field_name)) transmissionPatch[decision.field_name] = restoredValue;
      else if (CHASSIS_FIELDS.has(decision.field_name))      chassisPatch[decision.field_name]      = restoredValue;
      else if (TRIM_FIELDS.has(decision.field_name))         trimPatch[decision.field_name]         = restoredValue;
      else if (CONFIG_FIELDS.has(decision.field_name))       configPatch[decision.field_name]       = restoredValue;
    }

    await applyRevertPatch(ctx, row.vehicle_config_id, configPatch);
    if (config.engine_id)       await applyRevertPatch(ctx, config.engine_id,       enginePatch);
    if (config.transmission_id) await applyRevertPatch(ctx, config.transmission_id, transmissionPatch);
    if (config.chassis_code) {
      const cr = await ctx.db.query("chassis_specs").withIndex("by_chassis_code", q => q.eq("chassis_code", config.chassis_code!)).unique();
      if (cr) await applyRevertPatch(ctx, cr._id, chassisPatch);
    }
    {
      const tr = await ctx.db.query("trim_specs").withIndex("by_vehicle_config", q => q.eq("vehicle_config_id", row.vehicle_config_id)).first();
      if (tr) await applyRevertPatch(ctx, tr._id, trimPatch);
    }

    const newCount = Math.max(0, (config.verification_count ?? 1) - 1);
    const cfgPatch: Record<string, unknown> = { verification_count: newCount };
    if (newCount < 3 && config.enrichment_status === "verified") {
      cfgPatch.enrichment_status = "enriched";
    }
    await ctx.db.patch(row.vehicle_config_id, cfgPatch as any);

    await ctx.db.patch(id, {
      status: "undone",
      verified_at: now,
    } as any);

    for (const u of undoneFields) {
      await ctx.db.insert("audit_log", {
        entity_type: "vehicle_config",
        entity_id: entityId,
        action: "field_edit",
        actor: "System (undo)",
        detail: `Undo: ${u.name}  ${fmtVal(u.from)} → ${fmtVal(u.to)}`,
        created_at: now,
      });
    }
    await ctx.db.insert("audit_log", {
      entity_type: "vehicle_config",
      entity_id: entityId,
      action: "field_edit",
      actor: "System (undo)",
      detail: `Mechanic verification reverted — ${undoneFields.length} fields restored`,
      created_at: now,
    });

    return { ok: true, undoneFields: undoneFields.length };
  },
});
