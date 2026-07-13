// =============================================================================
// External Data API (Data spec §12) — key-authed read access to the enriched
// vehicle catalog, with the sellability gate applied VISIBLY.
//
//   GET /v0/maintenance?config_key=…|vin=…      scope maintenance:read
//   GET /v0/labor?config_key=…|vin=…[&service=] scope labor:read
//
// The gate (convex/lib/dataLayers.ts): only Layer A (OEM/official), D
// (empirical — ours) and E (human-verified — ours) values are served. B
// (Vehicle Databases / structured DB — licensed, not sellable), C
// (web/model-derived) and X (flagged) are EXCLUDED, and every excluded field
// is listed in the response with its blocking layer, per spec — the gate is
// a feature, not a filter to hide.
//
// Labor serves ONLY empirical_* values — "the one labor layer that is
// unambiguously ours" (spec §12); book_hours (RepairPal/MOTOR/VDB blend) is
// internal-use and never leaves.
//
// Keys: otp_live_… plaintext shown once; SHA-256 hash stored. Per-key
// rate limit enforced over an api_usage index window; every request metered.
// =============================================================================
import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireDirector, logAudit, roleHasCapability, type DirectorRole } from "./directorGate";
import { deriveLayer, SELLABLE_LAYERS, LAYER_FORMULA, type LayerLetter } from "./lib/dataLayers";
import { collectSpecFields, latestFieldEvidence } from "./dataCatalog";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";

export const API_SCOPES = ["maintenance:read", "labor:read"] as const;
export type ApiScope = (typeof API_SCOPES)[number];
const DEFAULT_RATE_LIMIT_PER_MIN = 60;

// ─── Key auth plumbing (used by http.ts) ─────────────────────────────────────

export type KeyAuth = {
  keyId: Id<"api_keys">;
  name: string;
  scopes: string[];
  rate_limit_per_min: number;
  revoked: boolean;
};

export const lookupKeyByHash = internalQuery({
  args: { key_hash: v.string() },
  handler: async (ctx, { key_hash }): Promise<KeyAuth | null> => {
    const key = await ctx.db
      .query("api_keys")
      .withIndex("by_key_hash", (q) => q.eq("key_hash", key_hash))
      .first();
    if (!key) return null;
    return {
      keyId: key._id,
      name: key.name,
      scopes: key.scopes,
      rate_limit_per_min: key.rate_limit_per_min,
      revoked: key.revoked_at != null,
    };
  },
});

export const countRecentUsage = internalQuery({
  args: { api_key_id: v.id("api_keys"), since: v.number() },
  handler: async (ctx, { api_key_id, since }): Promise<number> => {
    const rows = await ctx.db
      .query("api_usage")
      .withIndex("by_key_and_time", (q) => q.eq("api_key_id", api_key_id).gte("created_at", since))
      .take(500); // rate limits are two orders of magnitude below this cap
    return rows.length;
  },
});

export const recordUsage = internalMutation({
  args: {
    api_key_id: v.id("api_keys"),
    endpoint: v.string(),
    status: v.number(),
    config_key: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    await ctx.db.insert("api_usage", { ...args, created_at: Date.now() });
    const key = await ctx.db.get(args.api_key_id);
    if (key) {
      await ctx.db.patch(args.api_key_id, {
        last_used_at: Date.now(),
        request_count: key.request_count + 1,
      });
    }
  },
});

// ─── Response assembly ───────────────────────────────────────────────────────

async function resolveConfig(
  ctx: { db: Parameters<typeof latestFieldEvidence>[0]["db"] },
  configKey: string | null,
  vin: string | null,
): Promise<Doc<"vehicle_configs"> | null> {
  if (configKey) {
    return await ctx.db
      .query("vehicle_configs")
      .withIndex("by_config_key", (q) => q.eq("config_key", configKey))
      .first();
  }
  if (vin) {
    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", vin.trim().toUpperCase()))
      .first();
    if (vehicle?.vehicle_config_id) return await ctx.db.get(vehicle.vehicle_config_id);
  }
  return null;
}

export type MaintenanceField = {
  field: string;
  label: string;
  group: string;
  value: string;
  layer: LayerLetter;
  confidence: number | null;
  source_domain: string | null;
};
export type ExcludedField = {
  field: string;
  label: string;
  blocking_layer: LayerLetter | "unknown";
  reason: string;
};
export type MaintenanceResponse = {
  object: "maintenance_specs";
  config: {
    config_key: string | null;
    year: number;
    make: string;
    model: string;
    trim: string | null;
    engine: string | null;
    drivetrain: string | null;
  };
  fields: MaintenanceField[];
  excluded: ExcludedField[];
  meta: { gate: string; layer_formula: string; generated_at: number };
} | null;

export const assembleMaintenance = internalQuery({
  args: { config_key: v.optional(v.string()), vin: v.optional(v.string()) },
  handler: async (ctx, { config_key, vin }): Promise<MaintenanceResponse> => {
    const c = await resolveConfig(ctx, config_key ?? null, vin ?? null);
    if (!c) return null;
    const make = await ctx.db.get(c.make_id);
    const model = await ctx.db.get(c.model_id);
    const engine = c.engine_id ? await ctx.db.get(c.engine_id) : null;
    const transmission = c.transmission_id ? await ctx.db.get(c.transmission_id) : null;

    const fields: MaintenanceField[] = [];
    const excluded: ExcludedField[] = [];
    for (const f of collectSpecFields(c, engine, transmission)) {
      if (f.value == null) continue; // never serve empties
      const ev = await latestFieldEvidence(ctx, c, f.field_name);
      const layer = deriveLayer(ev?.source_type ?? null, ev?.confidence ?? null);
      if (ev && SELLABLE_LAYERS.has(layer.letter)) {
        fields.push({
          field: f.field_name,
          label: f.label,
          group: f.group,
          value: f.value,
          layer: layer.letter,
          confidence: ev.confidence,
          source_domain: ev.source_domain,
        });
      } else {
        excluded.push({
          field: f.field_name,
          label: f.label,
          blocking_layer: ev ? layer.letter : "unknown",
          reason: ev ? layer.reason : "no evidence trail — provenance unknown, treated as unsellable",
        });
      }
    }

    const engineLabel = engine
      ? [
          (engine.displacement_l ?? engine.displacement_liters) != null
            ? `${engine.displacement_l ?? engine.displacement_liters}L`
            : null,
          engine.engine_code ?? null,
        ]
          .filter(Boolean)
          .join(" ") || null
      : null;

    return {
      object: "maintenance_specs",
      config: {
        config_key: c.config_key ?? null,
        year: c.year,
        make: make?.name ?? "?",
        model: model?.name ?? "?",
        trim: c.trim_name ?? null,
        engine: engineLabel,
        drivetrain: c.drivetrain ?? null,
      },
      fields,
      excluded,
      meta: {
        gate: "A+D+E (OEM, empirical, human-verified). B/C/X excluded and listed.",
        layer_formula: LAYER_FORMULA,
        generated_at: Date.now(),
      },
    };
  },
});

export type LaborResponse = {
  object: "empirical_labor";
  config_key: string | null;
  services: Array<{
    service: string;
    name: string;
    empirical_hours: number;
    sample_size: number | null;
    p25_hours: number | null;
    p75_hours: number | null;
  }>;
  note: string;
} | null;

export const assembleLabor = internalQuery({
  args: {
    config_key: v.optional(v.string()),
    vin: v.optional(v.string()),
    service: v.optional(v.string()),
  },
  handler: async (ctx, { config_key, vin, service }): Promise<LaborResponse> => {
    const c = await resolveConfig(ctx, config_key ?? null, vin ?? null);
    if (!c) return null;

    const rows = await ctx.db
      .query("labor_times")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", c._id))
      .take(100);

    const services: NonNullable<LaborResponse>["services"] = [];
    for (const row of rows) {
      // ONLY the empirical layer leaves the building (spec §12); the blended
      // book_hours (RepairPal/MOTOR/VDB) is internal-use. Many rows encode
      // "no empirical data yet" as hours=0 / n=0 — a measurement requires a
      // positive value AND at least one real sample.
      if (!row.empirical_hours || !(row.empirical_sample_size && row.empirical_sample_size > 0)) continue;
      const svc = await ctx.db.get(row.service_id);
      const slug = svc?.slug ?? String(row.service_id);
      if (service && slug !== service) continue;
      services.push({
        service: slug,
        name: svc?.name ?? slug,
        empirical_hours: row.empirical_hours,
        sample_size: row.empirical_sample_size ?? null,
        p25_hours: row.empirical_p25 ?? null,
        p75_hours: row.empirical_p75 ?? null,
      });
    }

    return {
      object: "empirical_labor",
      config_key: c.config_key ?? null,
      services,
      note: "Empirical values only — measured from completed Otopair jobs. Book-time blends are not served by this API.",
    };
  },
});

// ─── Key management (portal, gated) ─────────────────────────────────────────

export const _insertKey = internalMutation({
  args: {
    name: v.string(),
    key_hash: v.string(),
    prefix: v.string(),
    scopes: v.array(v.union(v.literal("maintenance:read"), v.literal("labor:read"))),
    rate_limit_per_min: v.number(),
    created_by: v.id("director_users"),
    actor_name: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"api_keys">> => {
    const id = await ctx.db.insert("api_keys", {
      name: args.name,
      key_hash: args.key_hash,
      prefix: args.prefix,
      scopes: args.scopes,
      rate_limit_per_min: args.rate_limit_per_min,
      created_by: args.created_by,
      created_at: Date.now(),
      request_count: 0,
    });
    await logAudit(
      ctx,
      { name: args.actor_name, userId: args.created_by },
      {
        entity_type: "api_key",
        entity_id: String(id),
        action: "api_key_created",
        detail: `"${args.name}" scopes=${args.scopes.join(",")} rate=${args.rate_limit_per_min}/min`,
      },
    );
    return id;
  },
});

/** Action (not mutation): key generation + hashing need Web Crypto. The
 *  plaintext is returned exactly once and never stored. */
export const createKey = action({
  args: {
    token: v.string(),
    name: v.string(),
    scopes: v.array(v.union(v.literal("maintenance:read"), v.literal("labor:read"))),
    rate_limit_per_min: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { token, name, scopes, rate_limit_per_min },
  ): Promise<{ key: string; prefix: string; id: string }> => {
    const session = await ctx.runQuery(api.director_auth.validateSession, { token });
    if (!session) throw new Error("unauthorized: invalid or expired director session");
    if (!roleHasCapability(session.role as DirectorRole, "admin.manage")) {
      throw new Error(`forbidden: role '${session.role}' lacks capability 'admin.manage'`);
    }
    if (name.trim().length < 3) throw new Error("Key name must be at least 3 characters.");
    if (scopes.length === 0) throw new Error("Pick at least one scope.");

    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    const key = `otp_live_${hex}`;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
    const key_hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");

    const id = await ctx.runMutation(internal.dataApi._insertKey, {
      name: name.trim(),
      key_hash,
      prefix: key.slice(0, 12),
      scopes,
      rate_limit_per_min: rate_limit_per_min ?? DEFAULT_RATE_LIMIT_PER_MIN,
      created_by: session.userId as Id<"director_users">,
      actor_name: session.name,
    });
    return { key, prefix: key.slice(0, 12), id: String(id) };
  },
});

export const revokeKey = mutation({
  args: { token: v.string(), reason: v.string(), id: v.id("api_keys") },
  handler: async (ctx, { token, reason, id }): Promise<{ ok: true }> => {
    const actor = await requireDirector(ctx, token, "admin.manage");
    if (reason.trim().length < 4) throw new Error("a reason is required");
    const key = await ctx.db.get(id);
    if (!key) throw new Error("key not found");
    if (key.revoked_at != null) throw new Error("key is already revoked");
    await ctx.db.patch(id, { revoked_at: Date.now() });
    await logAudit(ctx, actor, {
      entity_type: "api_key",
      entity_id: String(id),
      action: "api_key_revoked",
      detail: `"${key.name}" — ${reason.trim()}`,
    });
    return { ok: true };
  },
});

export type ApiKeyRow = {
  id: Id<"api_keys">;
  name: string;
  prefix: string;
  scopes: string[];
  rate_limit_per_min: number;
  created_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
  request_count: number;
  requests_24h: number;
};

export const listKeys = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<ApiKeyRow[]> => {
    await requireDirector(ctx, token);
    const keys = await ctx.db.query("api_keys").withIndex("by_created_at").order("desc").take(100);
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const rows: ApiKeyRow[] = [];
    for (const k of keys) {
      const recent = await ctx.db
        .query("api_usage")
        .withIndex("by_key_and_time", (q) => q.eq("api_key_id", k._id).gte("created_at", dayAgo))
        .take(1000);
      rows.push({
        id: k._id,
        name: k.name,
        prefix: k.prefix,
        scopes: k.scopes,
        rate_limit_per_min: k.rate_limit_per_min,
        created_at: k.created_at,
        revoked_at: k.revoked_at ?? null,
        last_used_at: k.last_used_at ?? null,
        request_count: k.request_count,
        requests_24h: recent.length,
      });
    }
    return rows;
  },
});

export type UsageRow = {
  endpoint: string;
  status: number;
  config_key: string | null;
  created_at: number;
  key_prefix: string;
};

export const recentUsage = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<UsageRow[]> => {
    await requireDirector(ctx, token);
    const rows = await ctx.db.query("api_usage").withIndex("by_created_at").order("desc").take(50);
    const prefixes = new Map<string, string>();
    const out: UsageRow[] = [];
    for (const r of rows) {
      let prefix = prefixes.get(String(r.api_key_id));
      if (prefix === undefined) {
        prefix = (await ctx.db.get(r.api_key_id))?.prefix ?? "(deleted)";
        prefixes.set(String(r.api_key_id), prefix);
      }
      out.push({
        endpoint: r.endpoint,
        status: r.status,
        config_key: r.config_key ?? null,
        created_at: r.created_at,
        key_prefix: prefix,
      });
    }
    return out;
  },
});
