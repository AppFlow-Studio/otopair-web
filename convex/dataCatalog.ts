// =============================================================================
// Data · Vehicle Catalog read layer — /data/catalog list + config workspace.
// All functions token-gated via requireDirector. One write surface:
// fetchConfigImage (data.trigger + ceremony + cooldown) schedules the VD
// vehicle-images resolver for a config with no cached render.
// Bounded reads only: vehicle_configs is 384 rows (take 500); enrichment_runs
// windowed via by_vehicle_config; enrichment_evidence ONLY via by_entity_field
// per selected field (never collected en masse); the image fallback's sibling
// lookup is take(3) on by_vehicle_config per config (see configImageUrl).
//
// Evidence entity keying mirrors the writer (vehicleEnrichment/v3pipeline.ts
// getEntityType + entityId rule): engine fields are keyed by the engine doc id,
// transmission fields by transmission id (falling back to config id), and all
// other entity types (vehicle_config / trim_spec / part / interval /
// drivetrain_config) stay keyed by the vehicle_config id.
// =============================================================================
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireDirector, logAudit } from "./directorGate";
import type { Doc, Id } from "./_generated/dataModel";

// --- Authored return types -----------------------------------------------------
// Explicit handler return types are load-bearing (see convex/backfillTires.ts
// _listCandidates): without them TS must infer each handler while resolving the
// whole ApiFromModules barrel, which exhausts the checker's instantiation budget
// and silently degrades api.* types to `any` in consumer files.

export type CatalogConfigRow = {
  id: Id<"vehicle_configs">;
  year: number;
  make: string;
  model: string;
  trim_name: string | null;
  engine_label: string | null;
  drivetrain: string | null;
  fill_rate: number | null;
  confidence_avg: number | null;
  enrichment_status: string | null;
  verification_count: number;
  last_enriched_at: number | null;
  image_url: string | null;
};
export type ListConfigsResult = { rows: CatalogConfigRow[]; truncated: boolean };

export type WorkspaceSpecField = {
  field_name: string;
  label: string;
  value: string | null;
  entity_type: string;
  group: string;
};
export type WorkspaceRun = {
  id: Id<"enrichment_runs">;
  status: string;
  trigger: string | null;
  version: string | null;
  fill_rate: number | null;
  applicable_fill_rate: number | null;
  fields_filled: number | null;
  fields_total: number | null;
  estimated_cost_usd: number | null;
  started_at: number;
  completed_at: number | null;
  error_count: number;
};
export type ConfigWorkspaceResult = {
  id: Id<"vehicle_configs">;
  year: number;
  make: string;
  model: string;
  trim_name: string | null;
  chassis_code: string | null;
  engine_label: string | null;
  engine_id: Id<"engines"> | null;
  transmission_id: Id<"transmissions"> | null;
  enrichment_status: string | null;
  fill_rate: number | null;
  confidence_avg: number | null;
  verification_count: number;
  last_enriched_at: number | null;
  last_verified_at: number | null;
  enrichment_version: string | null;
  pricing_tier: string | null;
  image_url: string | null;
  fields: WorkspaceSpecField[];
  runs: WorkspaceRun[];
};

export type FieldEvidenceRow = {
  id: Id<"enrichment_evidence">;
  observed_value: string | null;
  source_domain: string | null;
  source_url: string | null;
  source_type: string | null;
  confidence: number | null;
  is_latest: boolean;
  observed_at: number;
  enrichment_run_id: Id<"enrichment_runs"> | null;
};
export type FieldEvidenceResult = {
  entity_type_used: string;
  entity_id_used: string;
  canonical: boolean;
  rows: FieldEvidenceRow[];
};

// --- Field → evidence entity_type mapping (copy of the writer's getEntityType
//     in vehicleEnrichment/v3pipeline.ts — kept in sync manually; the writer is
//     internal and this module must not import pipeline code). -----------------
function evidenceEntityType(fieldName: string): string {
  if (
    fieldName.includes("tire") ||
    fieldName.includes("wiper") ||
    fieldName.includes("lug_nut") ||
    fieldName.includes("battery_group") ||
    fieldName.includes("battery_cca") ||
    fieldName.includes("battery_type") ||
    fieldName.includes("battery_location") ||
    fieldName.includes("alignment")
  )
    return "trim_spec";
  if (
    fieldName.includes("oil_") ||
    fieldName.includes("coolant") ||
    fieldName.includes("timing") ||
    fieldName.includes("spark_plug") ||
    fieldName.includes("fuel_injection") ||
    fieldName === "turbo" ||
    fieldName.includes("aspiration") ||
    fieldName.includes("serpentine")
  )
    return "engine";
  if (fieldName.includes("trans_fluid") || fieldName.includes("transmission")) return "transmission";
  if (fieldName.includes("diff_fluid") || fieldName.includes("transfer_case")) return "drivetrain_config";
  if (fieldName.endsWith("_oem")) return "part";
  if (fieldName.endsWith("_miles") || fieldName.endsWith("_months")) return "interval";
  return "vehicle_config";
}

// --- Shared spec-field collection (workspace UI + external data API) ----------

export type SpecField = {
  field_name: string;
  label: string;
  value: string | null;
  entity_type: string;
  group: string;
};

/** The curated maintenance-spec field map: stored doc value → evidence field
 *  key. One list, consumed by configWorkspace (portal) and dataApi (external
 *  /v0/maintenance) so the two can never drift. */
export function collectSpecFields(
  c: Doc<"vehicle_configs">,
  engine: Doc<"engines"> | null,
  transmission: Doc<"transmissions"> | null,
): SpecField[] {
  const fields: SpecField[] = [];
  const push = (field_name: string, label: string, raw: unknown, group: string) => {
    fields.push({
      field_name,
      label,
      value: raw == null ? null : String(raw),
      entity_type: evidenceEntityType(field_name),
      group,
    });
  };

  // Fluids (engine + config docs)
  push("oil_viscosity", "Oil viscosity", engine?.oil_viscosity, "Fluids");
  push("oil_capacity_qts", "Oil capacity (qts)", engine?.oil_capacity_qts, "Fluids");
  push("coolant_type", "Coolant type", engine?.coolant_type, "Fluids");
  push("coolant_capacity_qts", "Coolant capacity (qts)", engine?.coolant_capacity_qts, "Fluids");
  push("brake_fluid_type", "Brake fluid type", c.brake_fluid_type, "Fluids");
  push("brake_fluid_capacity_oz", "Brake fluid capacity (oz)", c.brake_fluid_capacity_oz, "Fluids");
  push("power_steering_type", "Power steering fluid", c.ps_fluid_type, "Fluids");
  push("ps_fluid_capacity_oz", "PS fluid capacity (oz)", c.ps_fluid_capacity_oz, "Fluids");
  push(
    "transmission_fluid_capacity_qts",
    "Trans fluid capacity (qts)",
    engine?.transmission_fluid_capacity_qts,
    "Fluids",
  );

  // Attributes
  push("drivetrain", "Drivetrain", c.drivetrain, "Attributes");
  push("timing_system", "Timing system", engine?.timing_system ?? engine?.timing_type, "Attributes");
  push("fuel_injection_type", "Fuel injection", engine?.fuel_injection, "Attributes");
  push("turbo", "Aspiration", engine?.aspiration, "Attributes");
  push("spark_plug_quantity", "Spark plug qty", engine?.spark_plug_quantity, "Attributes");
  push(
    "transmission_type",
    "Transmission type",
    transmission?.transmission_type ?? transmission?.type,
    "Attributes",
  );
  push("trans_fluid_type", "Trans fluid type", transmission?.fluid_type, "Fluids");

  return fields;
}

/** Newest evidence row for one field (canonical key first, then the two known
 *  legacy keyings — every attempt an indexed bounded read). Used by the API's
 *  layer gate; prefers is_latest rows. */
export async function latestFieldEvidence(
  ctx: { db: QueryCtx["db"] },
  c: Doc<"vehicle_configs">,
  fieldName: string,
): Promise<{ source_type: string | null; confidence: number | null; source_domain: string | null } | null> {
  const entityType = evidenceEntityType(fieldName);
  const canonicalId =
    entityType === "engine" && c.engine_id
      ? String(c.engine_id)
      : entityType === "transmission"
        ? String(c.transmission_id ?? c._id)
        : String(c._id);
  const attempts: Array<{ type: string; id: string }> = [];
  const addAttempt = (type: string, entityId: string) => {
    if (!attempts.some((a) => a.type === type && a.id === entityId)) attempts.push({ type, id: entityId });
  };
  addAttempt(entityType, canonicalId);
  addAttempt(entityType, String(c._id));
  addAttempt("vehicle_config", String(c._id));

  for (const attempt of attempts) {
    const rows = await ctx.db
      .query("enrichment_evidence")
      .withIndex("by_entity_field", (q) =>
        q.eq("entity_type", attempt.type).eq("entity_id", attempt.id).eq("field_name", fieldName),
      )
      .order("desc")
      .take(10);
    if (rows.length > 0) {
      const best = rows.find((r) => r.is_latest !== false) ?? rows[0];
      return {
        source_type: best.source_type ?? null,
        confidence: best.confidence ?? null,
        source_domain: best.source_domain ?? null,
      };
    }
  }
  return null;
}

// --- List ---------------------------------------------------------------------

/** A config's render, falling back to any linked VIN's cached image.
 *
 *  vehicle_configs.image_url is the YMMT-level cache, but the only thing that
 *  routinely resolves an image is the booking-confirmation email path, which
 *  writes vehicles.image_url per VIN. Its promotion to the config slot
 *  (vehicles.saveVehicleImageUrl) postdates the images already on file, so
 *  those rows never stamped a config and read as "no img" here while the same
 *  render shows in the director panel. Same sibling lookup as
 *  dataApi.assembleVehicleImage — bounded take(3), by_vehicle_config index. */
async function configImageUrl(
  ctx: QueryCtx,
  c: Doc<"vehicle_configs">,
): Promise<string | null> {
  if (c.image_url) return c.image_url;
  const siblings = await ctx.db
    .query("vehicles")
    .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", c._id))
    .take(3);
  return siblings.find((s) => s.image_url != null)?.image_url ?? null;
}

export const listConfigs = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<ListConfigsResult> => {
    await requireDirector(ctx, token);
    // 384 rows measured at build time — hard-capped window, not an unbounded collect.
    const configs = await ctx.db.query("vehicle_configs").take(500);

    const makeNames = new Map<string, string>();
    const modelNames = new Map<string, string>();
    const engineLabels = new Map<string, string>();

    const rows: CatalogConfigRow[] = [];
    for (const c of configs) {
      let make = makeNames.get(c.make_id);
      if (make === undefined) {
        make = (await ctx.db.get(c.make_id))?.name ?? "?";
        makeNames.set(c.make_id, make);
      }
      let model = modelNames.get(c.model_id);
      if (model === undefined) {
        model = (await ctx.db.get(c.model_id))?.name ?? "?";
        modelNames.set(c.model_id, model);
      }
      let engineLabel: string | null = null;
      if (c.engine_id) {
        const cached = engineLabels.get(c.engine_id);
        if (cached !== undefined) {
          engineLabel = cached || null;
        } else {
          const e = await ctx.db.get(c.engine_id);
          engineLabel = e ? formatEngineLabel(e) : null;
          engineLabels.set(c.engine_id, engineLabel ?? "");
        }
      }
      rows.push({
        id: c._id,
        year: c.year,
        make,
        model,
        trim_name: c.trim_name ?? null,
        engine_label: engineLabel,
        drivetrain: c.drivetrain ?? null,
        fill_rate: c.fill_rate ?? null,
        confidence_avg: c.confidence_avg ?? null,
        enrichment_status: c.enrichment_status ?? null,
        verification_count: c.verification_count ?? 0,
        last_enriched_at: c.last_enriched_at ?? null,
        image_url: await configImageUrl(ctx, c),
      });
    }
    rows.sort((a, b) => b.year - a.year || a.make.localeCompare(b.make) || a.model.localeCompare(b.model));
    return { rows, truncated: configs.length === 500 };
  },
});

function formatEngineLabel(e: Doc<"engines">): string {
  const disp = e.displacement_l ?? e.displacement_liters;
  const parts = [
    disp != null ? `${disp}L` : null,
    e.engine_code ?? null,
    e.cylinders != null ? `${e.cylinders}cyl` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "engine on file";
}

// --- Workspace ------------------------------------------------------------------

/** Curated spec fields for the left pane. Each entry maps a stored doc value to
 *  the evidence field_name the pipeline writes, so the right pane can pull the
 *  exact evidence trail via by_entity_field. */
export const configWorkspace = query({
  args: { token: v.string(), id: v.id("vehicle_configs") },
  handler: async (ctx, { token, id }): Promise<ConfigWorkspaceResult | null> => {
    await requireDirector(ctx, token);
    const c = await ctx.db.get(id);
    if (!c) return null;

    const make = c.make_id ? await ctx.db.get(c.make_id) : null;
    const model = c.model_id ? await ctx.db.get(c.model_id) : null;
    const engine = c.engine_id ? await ctx.db.get(c.engine_id) : null;
    const transmission = c.transmission_id ? await ctx.db.get(c.transmission_id) : null;

    // Runs — indexed window, newest first.
    const runs = await ctx.db
      .query("enrichment_runs")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", id))
      .order("desc")
      .take(15);

    // Spec fields: label → stored value → evidence field key + entity type.
    const fields = collectSpecFields(c, engine, transmission);

    return {
      id: c._id,
      year: c.year,
      make: make?.name ?? "?",
      model: model?.name ?? "?",
      trim_name: c.trim_name ?? null,
      chassis_code: c.chassis_code ?? null,
      engine_label: engine ? formatEngineLabel(engine) : null,
      engine_id: c.engine_id ?? null,
      transmission_id: c.transmission_id ?? null,
      enrichment_status: c.enrichment_status ?? null,
      fill_rate: c.fill_rate ?? null,
      confidence_avg: c.confidence_avg ?? null,
      verification_count: c.verification_count ?? 0,
      last_enriched_at: c.last_enriched_at ?? null,
      last_verified_at: c.last_verified_at ?? null,
      enrichment_version: c.enrichment_version ?? null,
      pricing_tier: c.pricing_tier ?? null,
      image_url: await configImageUrl(ctx, c),
      fields,
      runs: runs.map((r) => ({
        id: r._id,
        status: r.status,
        trigger: r.trigger ?? null,
        version: r.version ?? null,
        fill_rate: r.fill_rate ?? null,
        applicable_fill_rate: r.applicable_fill_rate ?? null,
        fields_filled: r.fields_filled ?? null,
        fields_total: r.fields_total ?? null,
        estimated_cost_usd: r.estimated_cost_usd ?? null,
        started_at: r.started_at ?? r._creationTime,
        completed_at: r.completed_at ?? null,
        error_count: r.errors?.length ?? 0,
      })),
    };
  },
});

// --- Per-field evidence -----------------------------------------------------------

/** Evidence trail for ONE field of a config. Indexed lookups only (by_entity_field,
 *  take 50). Tries the writer's canonical (entity_type, entity_id) key first, then
 *  known legacy keyings (older rows were all keyed by config id / vehicle_config). */
export const fieldEvidence = query({
  args: {
    token: v.string(),
    configId: v.id("vehicle_configs"),
    fieldName: v.string(),
  },
  handler: async (ctx, { token, configId, fieldName }): Promise<FieldEvidenceResult | null> => {
    await requireDirector(ctx, token);
    const c = await ctx.db.get(configId);
    if (!c) return null;

    const entityType = evidenceEntityType(fieldName);
    const canonicalId =
      entityType === "engine" && c.engine_id
        ? String(c.engine_id)
        : entityType === "transmission"
          ? String(c.transmission_id ?? configId)
          : String(configId);

    // Canonical key + legacy fallbacks, deduped, each an indexed bounded read.
    const attempts: Array<{ type: string; id: string }> = [];
    const addAttempt = (type: string, entityId: string) => {
      if (!attempts.some((a) => a.type === type && a.id === entityId)) attempts.push({ type, id: entityId });
    };
    addAttempt(entityType, canonicalId);
    addAttempt(entityType, String(configId)); // pre-fix rows keyed engine fields by config id
    addAttempt("vehicle_config", String(configId)); // oldest rows: everything vehicle_config

    for (const attempt of attempts) {
      const rows = await ctx.db
        .query("enrichment_evidence")
        .withIndex("by_entity_field", (q) =>
          q.eq("entity_type", attempt.type).eq("entity_id", attempt.id).eq("field_name", fieldName),
        )
        .order("desc")
        .take(50);
      if (rows.length > 0) {
        return {
          entity_type_used: attempt.type,
          entity_id_used: attempt.id,
          canonical: attempt.type === entityType && attempt.id === canonicalId,
          rows: rows.map((e) => ({
            id: e._id,
            observed_value: e.observed_value == null ? null : String(e.observed_value),
            source_domain: e.source_domain ?? null,
            source_url: e.source_url ?? null,
            source_type: e.source_type ?? null,
            confidence: e.confidence ?? null,
            is_latest: e.is_latest ?? false,
            observed_at: e.observed_at ?? e._creationTime,
            enrichment_run_id: (e.enrichment_run_id as Id<"enrichment_runs"> | undefined) ?? null,
          })),
        };
      }
    }
    return { entity_type_used: entityType, entity_id_used: canonicalId, canonical: true, rows: [] };
  },
});

// --- Image fetch trigger --------------------------------------------------------

const IMAGE_FETCH_COOLDOWN_MS = 30 * 60 * 1000;

/** Schedule the Vehicle Databases image resolver for a config (Data portal
 *  catalog). VIN-first when a decoded sibling exists, else YMMT. Ceremony +
 *  audit + 30-min per-config cooldown — each miss costs a VDB call. */
export const fetchConfigImage = mutation({
  args: { token: v.string(), reason: v.string(), configId: v.id("vehicle_configs") },
  handler: async (
    ctx,
    { token, reason, configId },
  ): Promise<{ ok: true; via: "vin" | "ymmt" }> => {
    const actor = await requireDirector(ctx, token, "data.trigger");
    if (reason.trim().length < 4) throw new Error("A reason is required.");
    const c = await ctx.db.get(configId);
    if (!c) throw new Error("That config no longer exists.");
    if (c.image_url) throw new Error("This config already has a cached image.");

    // Cooldown via the audit trail (same pattern as the Control Room triggers).
    const recent = await ctx.db
      .query("audit_log")
      .withIndex("by_entity", (q) =>
        q.eq("entity_type", "vehicle_config").eq("entity_id", String(configId)),
      )
      .order("desc")
      .take(10);
    const lastFetch = recent.find((r) => r.action === "image_fetch_triggered");
    if (lastFetch && Date.now() - lastFetch.created_at < IMAGE_FETCH_COOLDOWN_MS) {
      const mins = Math.ceil(
        (IMAGE_FETCH_COOLDOWN_MS - (Date.now() - lastFetch.created_at)) / 60000,
      );
      throw new Error(`Image fetch is on cooldown for this config — available in ${mins}m.`);
    }

    // VIN-first: any decoded sibling of this config.
    const sibling = await ctx.db
      .query("vehicles")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", configId))
      .first();
    const make = await ctx.db.get(c.make_id);
    const model = await ctx.db.get(c.model_id);
    const via: "vin" | "ymmt" = sibling ? "vin" : "ymmt";
    if (!sibling && !c.trim_name) {
      throw new Error(
        "No linked VIN and no trim name — the VDB YMMT image endpoint needs a trim. " +
          "Queue a VIN for this config first.",
      );
    }
    await ctx.scheduler.runAfter(0, internal.lib.vehicle_image.resolveVehicleImage, {
      vin: sibling?.vin,
      year: c.year,
      make: (make as { name?: string } | null)?.name,
      model: (model as { name?: string } | null)?.name,
      trim: c.trim_name ?? undefined,
      vehicle_config_id: configId,
    });
    await logAudit(ctx, actor, {
      entity_type: "vehicle_config",
      entity_id: String(configId),
      action: "image_fetch_triggered",
      detail: `via ${via}${sibling ? ` (${sibling.vin})` : ""} — one VDB vehicle-images call — ${reason.trim()}`,
    });
    return { ok: true, via };
  },
});
