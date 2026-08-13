/**
 * Shared routing + coercion helpers for the mechanic-verification accept/undo
 * pair. The director's accept mutation and the undo mutation BOTH route per-
 * field values into the same data tables (engines / transmissions /
 * chassis_specs / trim_specs / vehicle_configs). Keeping the field sets and
 * type table in one place prevents the two sides from drifting.
 *
 * Type coercion matters because the mechanic-side writer stores every
 * `our_value` / `corrected_value` as v.string(), but the destination columns
 * include numbers and booleans. Without coercion, Convex schema validators
 * reject the patch and the operation fails. Helpers here translate raw values
 * to the destination column's real type.
 */

// ─── Field routing sets (copied verbatim from the previous inline copy in
// undoMechanicVerification.ts so behavior is preserved) ────────────────────
export const ENGINE_FIELDS = new Set([
  "oil_viscosity",
  "oil_capacity_qts",
  "coolant_type",
  "coolant_capacity_qts",
  "spark_plug_quantity",
  "spark_plug_gap_mm",
  "timing_system",
  "aspiration",
  "fuel_type",
  "fuel_injection",
  "water_pump_timing_driven",
  "cylinders",
  "displacement_l",
  "engine_code",
  "configuration",
  "engine_family",
]);

export const TRANSMISSION_FIELDS = new Set([
  "transmission_type",
  "fluid_type",
  "fluid_capacity_drain_fill_qts",
  "is_lifetime_fill",
  "has_serviceable_filter",
  "service_method",
  "code",
  "speeds",
]);

export const CHASSIS_FIELDS = new Set([
  "lug_nut_torque_ft_lbs",
  "wiper_blade_driver_size_in",
  "wiper_blade_passenger_size_in",
  "wiper_blade_rear_size_in",
  "battery_group",
  "battery_type",
  "battery_location",
  "steering_type",
  "parking_brake_type",
  "has_rear_wiper",
  "has_brake_pad_sensor",
]);

export const TRIM_FIELDS = new Set([
  "tire_size_front",
  "tire_size_rear",
  "recommended_tire_pressure_front_psi",
  "recommended_tire_pressure_rear_psi",
  "is_staggered",
  "tire_directional",
  "is_run_flat",
  "alignment_type",
]);

export const CONFIG_FIELDS = new Set([
  "brake_fluid_type",
  "ps_fluid_type",
  "drivetrain",
  "chassis_code",
  "brake_fluid_capacity_oz",
  "ps_fluid_capacity_oz",
]);

// ─── Destination column types ──────────────────────────────────────────────
// Mirrors convex/schema.ts for every routable field. Drives coerceFieldValue.
// If a field is added to one of the routing Sets above, add it here too —
// otherwise coercion will default it to "string" (safe for free-text columns,
// wrong for numeric/boolean ones).
export type FieldType = "string" | "number" | "boolean";

export const FIELD_TYPES: Record<string, FieldType> = {
  // engines
  oil_viscosity: "string",
  oil_capacity_qts: "number",
  coolant_type: "string",
  coolant_capacity_qts: "number",
  spark_plug_quantity: "number",
  spark_plug_gap_mm: "number",
  timing_system: "string",
  aspiration: "string",
  fuel_type: "string",
  fuel_injection: "string",
  water_pump_timing_driven: "boolean",
  cylinders: "number",
  displacement_l: "number",
  engine_code: "string",
  configuration: "string",
  engine_family: "string",
  // transmissions
  transmission_type: "string",
  fluid_type: "string",
  fluid_capacity_drain_fill_qts: "number",
  is_lifetime_fill: "boolean",
  has_serviceable_filter: "boolean",
  service_method: "string",
  code: "string",
  speeds: "number",
  // chassis_specs
  lug_nut_torque_ft_lbs: "number",
  wiper_blade_driver_size_in: "number",
  wiper_blade_passenger_size_in: "number",
  wiper_blade_rear_size_in: "number",
  battery_group: "string",
  battery_type: "string",
  battery_location: "string",
  steering_type: "string",
  parking_brake_type: "string",
  has_rear_wiper: "boolean",
  has_brake_pad_sensor: "boolean",
  // trim_specs
  tire_size_front: "string",
  tire_size_rear: "string",
  recommended_tire_pressure_front_psi: "number",
  recommended_tire_pressure_rear_psi: "number",
  is_staggered: "boolean",
  tire_directional: "boolean",
  is_run_flat: "boolean",
  alignment_type: "string",
  // vehicle_configs
  brake_fluid_type: "string",
  ps_fluid_type: "string",
  drivetrain: "string",
  chassis_code: "string",
  brake_fluid_capacity_oz: "number",
  ps_fluid_capacity_oz: "number",
};

/**
 * coerceFieldValue — translate a raw value (typically a v.string() captured
 * by the mechanic writer) to the destination column's real type so Convex
 * schema validators accept the write.
 *
 * Returns the coerced value. Returns the same `undefined` / `null` passthrough
 * the undo path already relies on (callers use `undefined` to delete a key).
 * Throws on numeric values that aren't parseable so the caller can downgrade
 * the decision to "skip" rather than silently coercing to NaN.
 */
export function coerceFieldValue(
  fieldName: string,
  raw: unknown,
): unknown {
  if (raw === undefined || raw === null) return raw;
  const type = FIELD_TYPES[fieldName] ?? "string";

  if (type === "number") {
    if (typeof raw === "number") {
      if (!Number.isFinite(raw)) {
        throw new Error(`coerceFieldValue: non-finite number for ${fieldName}`);
      }
      return raw;
    }
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed === "") return undefined;
      const n = Number(trimmed);
      if (!Number.isFinite(n)) {
        throw new Error(
          `coerceFieldValue: cannot parse "${raw}" as number for ${fieldName}`,
        );
      }
      return n;
    }
    throw new Error(
      `coerceFieldValue: cannot coerce ${typeof raw} to number for ${fieldName}`,
    );
  }

  if (type === "boolean") {
    if (typeof raw === "boolean") return raw;
    if (typeof raw === "string") {
      const s = raw.trim().toLowerCase();
      if (s === "true" || s === "yes" || s === "1") return true;
      if (s === "false" || s === "no" || s === "0") return false;
      if (s === "") return undefined;
      throw new Error(
        `coerceFieldValue: cannot parse "${raw}" as boolean for ${fieldName}`,
      );
    }
    if (typeof raw === "number") return raw !== 0;
    throw new Error(
      `coerceFieldValue: cannot coerce ${typeof raw} to boolean for ${fieldName}`,
    );
  }

  // string default — stringify if needed (numbers/booleans become "5"/"true")
  if (typeof raw === "string") return raw;
  return String(raw);
}

// ─── Routing buckets ────────────────────────────────────────────────────────

export type PatchBuckets = {
  config: Record<string, unknown>;
  engine: Record<string, unknown>;
  transmission: Record<string, unknown>;
  chassis: Record<string, unknown>;
  trim: Record<string, unknown>;
};

export function newPatchBuckets(): PatchBuckets {
  return {
    config: {},
    engine: {},
    transmission: {},
    chassis: {},
    trim: {},
  };
}

/**
 * routeFieldToPatchBucket — assigns `value` into one of the patch maps based
 * on which routing Set owns `fieldName`. Returns `true` when the field routed
 * to a data table; `false` when it didn't (caller still writes evidence but
 * skips the data-table write).
 */
export function routeFieldToPatchBucket(
  fieldName: string,
  value: unknown,
  buckets: PatchBuckets,
): boolean {
  if (ENGINE_FIELDS.has(fieldName)) {
    buckets.engine[fieldName] = value;
    return true;
  }
  if (TRANSMISSION_FIELDS.has(fieldName)) {
    buckets.transmission[fieldName] = value;
    return true;
  }
  if (CHASSIS_FIELDS.has(fieldName)) {
    buckets.chassis[fieldName] = value;
    return true;
  }
  if (TRIM_FIELDS.has(fieldName)) {
    buckets.trim[fieldName] = value;
    return true;
  }
  if (CONFIG_FIELDS.has(fieldName)) {
    buckets.config[fieldName] = value;
    return true;
  }
  return false;
}

// ─── Patch application ──────────────────────────────────────────────────────

/**
 * applyPatchWithDelete — db.replace under the hood so `undefined`/`null`
 * values cleanly remove the key (schema validators reject `null` on optional
 * fields; db.patch can't drop a key that's already set). Used by undo to
 * restore the pre-mechanic shape.
 */
async function applyPatchWithDelete(
  ctx: any,
  rowId: any,
  values: Record<string, unknown>,
) {
  if (Object.keys(values).length === 0) return;
  const current = await ctx.db.get(rowId);
  if (!current) return;
  const { _id, _creationTime, ...rest } = current;
  const next: Record<string, unknown> = { ...rest };
  for (const [k, val] of Object.entries(values)) {
    if (val === undefined || val === null) {
      delete next[k];
    } else {
      next[k] = val;
    }
  }
  await ctx.db.replace(rowId, next);
}

/**
 * Resolves the chassis_specs row for a given vehicle_config, or null when
 * the config has no chassis_code or no chassis_specs row exists yet.
 */
async function resolveChassisRow(ctx: any, config: any) {
  if (!config?.chassis_code) return null;
  return await ctx.db
    .query("chassis_specs")
    .withIndex("by_chassis_code", (q: any) =>
      q.eq("chassis_code", config.chassis_code),
    )
    .unique();
}

/**
 * Resolves the trim_specs row for a given vehicle_config (one per config),
 * or null when none exists yet.
 */
async function resolveTrimRow(ctx: any, configId: any) {
  return await ctx.db
    .query("trim_specs")
    .withIndex("by_vehicle_config", (q: any) =>
      q.eq("vehicle_config_id", configId),
    )
    .first();
}

/**
 * applyForwardPatch — used by accept. Symmetric counterpart to
 * applyRevertPatch: writes the values into the right data tables. Uses
 * db.patch (additive) because forward writes shouldn't drop unrelated keys.
 * Non-existent target rows (e.g. no chassis_specs row yet) are silently
 * skipped — accept still wrote evidence so the value is recorded somewhere.
 */
export async function applyForwardPatch(
  ctx: any,
  config: any,
  buckets: PatchBuckets,
) {
  if (Object.keys(buckets.config).length > 0) {
    await ctx.db.patch(config._id, buckets.config);
  }
  if (config.engine_id && Object.keys(buckets.engine).length > 0) {
    await ctx.db.patch(config.engine_id, buckets.engine);
  }
  if (config.transmission_id && Object.keys(buckets.transmission).length > 0) {
    await ctx.db.patch(config.transmission_id, buckets.transmission);
  }
  if (Object.keys(buckets.chassis).length > 0) {
    const chassisRow = await resolveChassisRow(ctx, config);
    if (chassisRow) await ctx.db.patch(chassisRow._id, buckets.chassis);
  }
  if (Object.keys(buckets.trim).length > 0) {
    const trimRow = await resolveTrimRow(ctx, config._id);
    if (trimRow) await ctx.db.patch(trimRow._id, buckets.trim);
  }
}

/**
 * applyRevertPatch — used by undo. Writes `undefined`/`null` as "delete key"
 * via db.replace. Mirrors the original behavior in undoMechanicVerification.
 */
export async function applyRevertPatch(
  ctx: any,
  config: any,
  buckets: PatchBuckets,
) {
  await applyPatchWithDelete(ctx, config._id, buckets.config);
  if (config.engine_id) {
    await applyPatchWithDelete(ctx, config.engine_id, buckets.engine);
  }
  if (config.transmission_id) {
    await applyPatchWithDelete(ctx, config.transmission_id, buckets.transmission);
  }
  const chassisRow = await resolveChassisRow(ctx, config);
  if (chassisRow) {
    await applyPatchWithDelete(ctx, chassisRow._id, buckets.chassis);
  }
  const trimRow = await resolveTrimRow(ctx, config._id);
  if (trimRow) {
    await applyPatchWithDelete(ctx, trimRow._id, buckets.trim);
  }
}

// ─── Shared formatting + types ──────────────────────────────────────────────

export type ReviewDecisionAction = "accept" | "skip" | "override";

export type ReviewDecision = {
  field_name: string;
  action: ReviewDecisionAction;
  override_value?: unknown;
};

export function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return "(empty)";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
}
