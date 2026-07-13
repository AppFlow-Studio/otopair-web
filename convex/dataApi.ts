// =============================================================================
// External Data API (Data spec §12) — key-authed read access to the enriched
// vehicle catalog, with the sellability gate applied VISIBLY.
//
//   GET /v0/maintenance?config_key=…|vin=…      scope maintenance:read
//   GET /v0/labor?config_key=…|vin=…[&service=] scope labor:read
//
// The gate (convex/lib/dataLayers.ts): Layer A (OEM/official), C
// (web-search/scraped — our own enrichment work, the product per team
// decision Jul 13), D (empirical — ours) and E (human-verified — ours) are
// served. B (Vehicle Databases / structured DB — licensed, not sellable) and
// X (flagged) are EXCLUDED, and every excluded field is listed in the
// response with its blocking layer — the gate is a feature, not a filter to
// hide.
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
import { deriveLayer, isServable, LAYER_FORMULA, type LayerLetter } from "./lib/dataLayers";
import { collectSpecFields, latestFieldEvidence } from "./dataCatalog";
import { isPoisonPriceType, isNonPooledPriceType } from "./lib/priceTypes";
import type { QueryCtx } from "./_generated/server";
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
      if (ev && isServable(layer.letter, ev.source_type)) {
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
        gate: "A+C+D+E (OEM, web-derived, empirical, human-verified). B (licensed DB) and X (flagged) excluded and listed.",
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

/** Every director gets ONE self-service sandbox key ("log in and have a
 *  key") — any valid session may mint it, no admin.manage needed. Re-minting
 *  revokes the previous personal key so exactly one is live per director. */
export const createPersonalKey = action({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<{ key: string; prefix: string; id: string }> => {
    const session = await ctx.runQuery(api.director_auth.validateSession, { token });
    if (!session) throw new Error("unauthorized: invalid or expired director session");

    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    const key = `otp_live_${hex}`;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
    const key_hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");

    const id = await ctx.runMutation(internal.dataApi._insertPersonalKey, {
      key_hash,
      prefix: key.slice(0, 12),
      created_by: session.userId as Id<"director_users">,
      actor_name: session.name,
    });
    return { key, prefix: key.slice(0, 12), id: String(id) };
  },
});

export const _insertPersonalKey = internalMutation({
  args: {
    key_hash: v.string(),
    prefix: v.string(),
    created_by: v.id("director_users"),
    actor_name: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"api_keys">> => {
    const name = `personal: ${args.actor_name}`;
    // Revoke any prior live personal key for this director (one live at a time).
    const existing = await ctx.db.query("api_keys").withIndex("by_created_at").order("desc").take(100);
    for (const k of existing) {
      if (k.name === name && String(k.created_by) === String(args.created_by) && k.revoked_at == null) {
        await ctx.db.patch(k._id, { revoked_at: Date.now() });
      }
    }
    const id = await ctx.db.insert("api_keys", {
      name,
      key_hash: args.key_hash,
      prefix: args.prefix,
      scopes: ["maintenance:read", "labor:read"],
      rate_limit_per_min: DEFAULT_RATE_LIMIT_PER_MIN,
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
        action: "personal_key_minted",
        detail: `self-service sandbox key (previous personal key revoked if any)`,
      },
    );
    return id;
  },
});

/** The caller's own live personal key (prefix only) — drives the "your key"
 *  banner on the sandbox. */
export const myPersonalKey = query({
  args: { token: v.string() },
  handler: async (
    ctx,
    { token },
  ): Promise<{ prefix: string; created_at: number; requests_24h: number } | null> => {
    const actor = await requireDirector(ctx, token);
    const name = `personal: ${actor.name}`;
    const keys = await ctx.db.query("api_keys").withIndex("by_created_at").order("desc").take(100);
    const mine = keys.find(
      (k) => k.name === name && String(k.created_by) === String(actor.userId) && k.revoked_at == null,
    );
    if (!mine) return null;
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const recent = await ctx.db
      .query("api_usage")
      .withIndex("by_key_and_time", (q) => q.eq("api_key_id", mine._id).gte("created_at", dayAgo))
      .take(1000);
    return { prefix: mine.prefix, created_at: mine.created_at, requests_24h: recent.length };
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

// ─── /v0/vehicle — the full picture ──────────────────────────────────────────
// Everything currently enriched for one vehicle: identity, ALL populated spec
// fields (layer-tagged; B-licensed/X still excluded and listed), the full OEM
// tire package, OEM service intervals, parts per service with live prices,
// empirical + enrichment labor, and (VIN lookups only) the car's history on
// our platform: passport condition snapshot + completed service visits. No
// customer identity or payment amounts are ever included.

type YmmtMatch = { config_key: string | null; label: string };

type ServicePartEntry = {
  oem_part_number: string;
  name: string | null;
  subcategory: string | null;
  role: string | null;
  position: string | null;
  quantity: number | null;
  mechanic_verified: boolean;
  confidence: number | null;
  price: { amount: number; msrp: number | null; source_domain: string | null; as_of: number | null } | null;
};

type VehicleServiceEntry = {
  service: string;
  parts: ServicePartEntry[];
  labor: { empirical_hours: number | null; sample_size: number | null; estimated_hours: number | null };
};

/** Resolve year/make/model[/trim] against config_key's normalized prefix via
 *  the by_config_key index range — nobody outside the team knows config_keys. */
async function resolveByYmmt(
  ctx: { db: QueryCtx["db"] },
  year: number,
  make: string,
  model: string,
  trim: string | null,
): Promise<{ config: Doc<"vehicle_configs"> | null; matches: YmmtMatch[] }> {
  const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const prefix = `${year}_${slug(make)}_${slug(model)}`;
  const rows = await ctx.db
    .query("vehicle_configs")
    .withIndex("by_config_key", (q) => q.gte("config_key", prefix).lt("config_key", prefix + "￿"))
    .take(50);
  const trimSlug = trim ? slug(trim) : null;
  const filtered = trimSlug ? rows.filter((r) => r.config_key.includes(trimSlug)) : rows;
  const pool = filtered.length > 0 ? filtered : rows;
  const matches: YmmtMatch[] = pool.map((r) => ({
    config_key: r.config_key ?? null,
    label: r.config_key,
  }));
  return { config: pool.length === 1 ? pool[0] : null, matches };
}

export type VehicleResponse =
  | {
      object: "vehicle";
      config: {
        config_key: string | null;
        year: number;
        make: string;
        model: string;
        trim: string | null;
        chassis_code: string | null;
        drivetrain: string | null;
        engine: {
          label: string | null;
          code: string | null;
          cylinders: number | null;
          displacement_l: number | null;
          aspiration: string | null;
          fuel_injection: string | null;
        } | null;
        transmission: string | null;
        enrichment: { status: string | null; fill_rate: number | null; confidence_avg: number | null };
      };
      specs: MaintenanceField[];
      excluded: ExcludedField[];
      tires: {
        options: unknown[] | null;
        front_size: string | null;
        rear_size: string | null;
        pressure_front_psi: number | null;
        pressure_rear_psi: number | null;
        is_staggered: boolean | null;
        is_run_flat: boolean | null;
        battery_cca: number | null;
        source: string | null;
      } | null;
      intervals: Array<{
        service: string;
        name: string;
        interval_miles: number | null;
        interval_months: number | null;
        display: string | null;
        confidence: number | null;
        mechanic_verified: boolean;
      }>;
      services: VehicleServiceEntry[];
      history: {
        passport: {
          mileage: number | null;
          last_shop_confirmed_at: number | null;
          brakes: unknown | null;
          tires: unknown | null;
        } | null;
        visits: Array<{ date: string | null; status: string; services: string[]; shop: string | null }>;
      } | null;
      meta: { gate: string; layer_formula: string; generated_at: number };
    }
  | { object: "multiple_matches"; matches: YmmtMatch[] }
  | null;

export const assembleVehicle = internalQuery({
  args: {
    config_key: v.optional(v.string()),
    vin: v.optional(v.string()),
    year: v.optional(v.number()),
    make: v.optional(v.string()),
    model: v.optional(v.string()),
    trim: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<VehicleResponse> => {
    // ── Resolve the config (config_key | vin | ymmt) ──
    let c = await resolveConfig(ctx, args.config_key ?? null, args.vin ?? null);
    if (!c && args.year && args.make && args.model) {
      const { config, matches } = await resolveByYmmt(ctx, args.year, args.make, args.model, args.trim ?? null);
      if (!config) {
        if (matches.length === 0) return null;
        return { object: "multiple_matches", matches };
      }
      c = config;
    }
    if (!c) return null;

    const make = await ctx.db.get(c.make_id);
    const model = await ctx.db.get(c.model_id);
    const engine = c.engine_id ? await ctx.db.get(c.engine_id) : null;
    const transmission = c.transmission_id ? await ctx.db.get(c.transmission_id) : null;

    // ── Specs: everything populated, layer-tagged. Fields WITHOUT an evidence
    //    trail are our own stored enrichment values — served as Layer C. Only
    //    B-licensed (VDB) and X-flagged values are excluded (and listed). ──
    const specs: MaintenanceField[] = [];
    const excluded: ExcludedField[] = [];
    for (const f of collectSpecFields(c, engine, transmission)) {
      if (f.value == null) continue;
      const ev = await latestFieldEvidence(ctx, c, f.field_name);
      const layer = deriveLayer(ev?.source_type ?? null, ev?.confidence ?? null);
      if (!ev || isServable(layer.letter, ev.source_type)) {
        specs.push({
          field: f.field_name,
          label: f.label,
          group: f.group,
          value: f.value,
          layer: ev ? layer.letter : "C",
          confidence: ev?.confidence ?? null,
          source_domain: ev?.source_domain ?? null,
        });
      } else {
        excluded.push({ field: f.field_name, label: f.label, blocking_layer: layer.letter, reason: layer.reason });
      }
    }

    // ── Tires (trim_specs — full OEM fitment package) ──
    const ts = await ctx.db
      .query("trim_specs")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", c._id))
      .first();
    const tires = ts
      ? {
          options: (ts.tire_options as unknown[] | undefined) ?? null,
          front_size: ts.tire_size_front ?? null,
          rear_size: ts.tire_size_rear ?? null,
          pressure_front_psi: ts.recommended_tire_pressure_front_psi ?? null,
          pressure_rear_psi: ts.recommended_tire_pressure_rear_psi ?? null,
          is_staggered: ts.is_staggered ?? null,
          is_run_flat: ts.is_run_flat ?? null,
          battery_cca: ts.battery_cca ?? null,
          source: ts.tire_options_source ?? null,
        }
      : null;

    // ── Service name lookup (23 rows — cheap) ──
    const allServices = await ctx.db.query("services").collect();
    const serviceById = new Map(allServices.map((s) => [String(s._id), s]));

    // ── OEM intervals (per-config table; display_string is the honest form) ──
    const intervalRows = await ctx.db
      .query("service_intervals")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", c._id))
      .take(100);
    const intervals = intervalRows
      .filter((r) => r.interval_miles != null || r.interval_months != null || r.display_string)
      .map((r) => {
        const svc = serviceById.get(String(r.service_id));
        return {
          service: svc?.slug ?? String(r.service_id),
          name: svc?.name ?? "?",
          interval_miles: r.interval_miles ?? null,
          interval_months: r.interval_months ?? null,
          display: r.display_string ?? null,
          confidence: r.confidence ?? null,
          mechanic_verified: r.mechanic_verified === true,
        };
      });

    // ── Parts per service, with the latest trusted price per part ──
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", c._id))
      .take(200);
    const laborRows = await ctx.db
      .query("labor_times")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", c._id))
      .take(100);
    const svsRows = engine
      ? await ctx.db
          .query("service_vehicle_specs")
          .withIndex("by_engine_id", (q) => q.eq("engine_id", engine._id))
          .take(100)
      : [];

    const byService = new Map<string, VehicleServiceEntry>();
    const serviceEntry = (slugKey: string): VehicleServiceEntry => {
      let e = byService.get(slugKey);
      if (!e) {
        e = { service: slugKey, parts: [], labor: { empirical_hours: null, sample_size: null, estimated_hours: null } };
        byService.set(slugKey, e);
      }
      return e;
    };

    const priceCache = new Map<string, ServicePartEntry["price"]>();
    for (const f of fitments) {
      if (f.data_quality === "cross_make_quarantined") continue; // contaminated — never serve
      const part = await ctx.db.get(f.part_id);
      if (!part || part.is_current === false) continue;

      let price = priceCache.get(String(f.part_id));
      if (price === undefined) {
        const priceRows = await ctx.db
          .query("part_prices")
          .withIndex("by_part", (q) => q.eq("part_id", f.part_id))
          .take(50);
        const trusted = priceRows
          .filter((p) => !isPoisonPriceType(p.price_type) && !isNonPooledPriceType(p.price_type) && p.price > 0)
          .sort((a, b) => (b.refreshed_at ?? b.created_at ?? 0) - (a.refreshed_at ?? a.created_at ?? 0));
        price = trusted[0]
          ? {
              amount: trusted[0].price,
              msrp: trusted[0].msrp ?? null,
              source_domain: trusted[0].source_domain ?? null,
              as_of: trusted[0].refreshed_at ?? trusted[0].created_at ?? null,
            }
          : null;
        priceCache.set(String(f.part_id), price);
      }

      serviceEntry(f.service_type ?? "unassigned").parts.push({
        oem_part_number: part.oem_part_number,
        name: part.name ?? null,
        subcategory: part.subcategory ?? null,
        role: f.service_role ?? null,
        position: f.position ?? null,
        quantity: f.quantity_needed ?? null,
        mechanic_verified: f.mechanic_verified === true,
        confidence: f.confidence ?? null,
        price,
      });
    }

    for (const row of laborRows) {
      const svc = serviceById.get(String(row.service_id));
      const entry = serviceEntry(svc?.slug ?? String(row.service_id));
      if (row.empirical_hours && (row.empirical_sample_size ?? 0) > 0) {
        entry.labor.empirical_hours = row.empirical_hours;
        entry.labor.sample_size = row.empirical_sample_size ?? null;
      }
    }
    for (const row of svsRows) {
      const svc = serviceById.get(String(row.service_id));
      const entry = byService.get(svc?.slug ?? String(row.service_id));
      // Only annotate services we already surfaced (parts or empirical labor).
      if (entry && entry.labor.estimated_hours == null) {
        entry.labor.estimated_hours = row.estimated_labor_hours ?? row.labor_hours ?? null;
      }
    }

    // ── History (VIN lookups only): passport snapshot + platform visits.
    //    No customer identity, no payment amounts. ──
    let history: Extract<NonNullable<VehicleResponse>, { object: "vehicle" }>["history"] = null;
    if (args.vin) {
      const vinUpper = args.vin.trim().toUpperCase();
      const passport = await ctx.db
        .query("vehicle_passports")
        .withIndex("by_vin", (q) => q.eq("vin", vinUpper))
        .first();
      const visitsRaw = await ctx.db
        .query("bookings")
        .withIndex("by_vin", (q) => q.eq("vin", vinUpper))
        .take(50);
      const shopNames = new Map<string, string | null>();
      const visits: Array<{ date: string | null; status: string; services: string[]; shop: string | null }> = [];
      for (const b of visitsRaw) {
        if (b.status !== "completed") continue;
        let shop: string | null = null;
        if (b.shop_id) {
          if (shopNames.has(String(b.shop_id))) {
            shop = shopNames.get(String(b.shop_id)) ?? null;
          } else {
            shop = (await ctx.db.get(b.shop_id))?.name ?? null;
            shopNames.set(String(b.shop_id), shop);
          }
        }
        visits.push({
          date: b.scheduled_date ?? null,
          status: b.status,
          services: (b.service_ids ?? [])
            .map((id) => serviceById.get(String(id))?.name)
            .filter((n): n is string => Boolean(n)),
          shop,
        });
      }
      visits.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
      history = {
        passport: passport
          ? {
              mileage: passport.mileage ?? null,
              last_shop_confirmed_at: passport.last_shop_confirmed_at ?? null,
              brakes: passport.brakes ?? null,
              tires: passport.tires ?? null,
            }
          : null,
        visits,
      };
    }

    const engineLabel = engine
      ? [
          (engine.displacement_l ?? engine.displacement_liters) != null
            ? `${engine.displacement_l ?? engine.displacement_liters}L`
            : null,
          engine.engine_code ?? null,
          engine.cylinders != null ? `${engine.cylinders}cyl` : null,
        ]
          .filter(Boolean)
          .join(" ") || null
      : null;

    return {
      object: "vehicle",
      config: {
        config_key: c.config_key ?? null,
        year: c.year,
        make: make?.name ?? "?",
        model: model?.name ?? "?",
        trim: c.trim_name ?? null,
        chassis_code: c.chassis_code ?? null,
        drivetrain: c.drivetrain ?? null,
        engine: engine
          ? {
              label: engineLabel,
              code: engine.engine_code ?? null,
              cylinders: engine.cylinders ?? null,
              displacement_l:
                engine.displacement_l ??
                (engine.displacement_liters != null ? Number(engine.displacement_liters) : null),
              aspiration: engine.aspiration ?? null,
              fuel_injection: engine.fuel_injection ?? null,
            }
          : null,
        transmission: transmission?.transmission_type ?? transmission?.type ?? null,
        enrichment: {
          status: c.enrichment_status ?? null,
          fill_rate: c.fill_rate ?? null,
          confidence_avg: c.confidence_avg ?? null,
        },
      },
      specs,
      excluded,
      tires,
      intervals,
      services: [...byService.values()].sort((a, b) => a.service.localeCompare(b.service)),
      history,
      meta: {
        gate: "A+C+D+E served (incl. stored values without an evidence trail, tagged C). B (licensed DB, except public NHTSA) and X excluded and listed.",
        layer_formula: LAYER_FORMULA,
        generated_at: Date.now(),
      },
    };
  },
});
