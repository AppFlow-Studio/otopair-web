// =============================================================================
// External Data API (Data spec §12) — key-authed read access to the enriched
// vehicle catalog, with the sellability gate applied VISIBLY.
//
//   GET  /v0/maintenance?config_key=…|vin=…      scope maintenance:read
//   GET  /v0/labor?config_key=…|vin=…[&service=] scope labor:read
//   GET  /v0/vehicle?vin=…|ymmt|config_key       scope maintenance:read
//   GET  /v0/vehicle-image?vin=…|ymmt|config_key scope media:read
//   GET  /v0/service-history?vin=…               scope service_history:read
//   POST /v0/enrich {vin} (+ GET status)         scope enrich:write
//
// The gate (convex/lib/dataLayers.ts): Layer A (OEM/official), C
// (web-search/scraped — our own enrichment work, the product per team
// decision Jul 13), D (empirical — ours) and E (human-verified — ours) are
// served. B (Vehicle Databases / structured DB — licensed, not sellable) and
// X (flagged) are EXCLUDED, and every excluded field is listed in the
// response with its blocking layer — the gate is a feature, not a filter to
// hide.
//
// Labor serves empirical_* values — "the one labor layer that is
// unambiguously ours" (spec §12) — plus tier-model ESTIMATES gated through
// lib/publicLabor.ts (the Camry-anchor × own-multiplier derivation). Raw
// book_hours (Estimator / Book Rate/VDB blend) is internal-use and never leaves;
// laborGateCheck is the exit test.
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
import { detectTier } from "./lib/quoteEngine";
import { resolvePublicLaborEstimate } from "./lib/publicLabor";
import { computeLaborTierFloorHours } from "./lib/laborFallback";
import type { VehicleTier } from "./lib/vehicleTiers";
import { getApplicableServices } from "./services/applicability";
import type { QueryCtx } from "./_generated/server";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";

export const API_SCOPES = [
  "maintenance:read",
  "labor:read",
  "media:read",
  "enrich:write",
  "service_history:read",
] as const;
export type ApiScope = (typeof API_SCOPES)[number];
const DEFAULT_RATE_LIMIT_PER_MIN = 60;
// Daily cost guardrails, metered from api_usage rows (enforced in http.ts):
// only 202 "scheduled" enrich responses and live VDB image fetches count.
export const ENRICH_DAILY_QUOTA = 5;
export const IMAGE_LIVE_FETCH_DAILY_CAP = 10;

/** One validator for every place that accepts key scopes — keep in sync with
 *  API_SCOPES and schema.ts api_keys.scopes. */
const scopeValidator = v.union(
  v.literal("maintenance:read"),
  v.literal("labor:read"),
  v.literal("media:read"),
  v.literal("enrich:write"),
  v.literal("service_history:read"),
);

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
  /** Gated estimate for every applicable service (lib/publicLabor.ts):
   *  "empirical" = measured Otopair jobs; "model_estimate" = our own
   *  Camry-anchored tier model. Licensed book-time blends never appear. */
  estimates: Array<{
    service: string;
    name: string;
    estimated_hours: number;
    estimate_source: "empirical" | "model_estimate";
    estimate_confidence: number | null;
  }>;
  tier: string | null;
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
      // book_hours (Estimator / Book Rate/VDB) is internal-use. Many rows encode
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

    // ── Estimates: the quote engine's answer for every applicable service,
    //    gated through lib/publicLabor.ts (empirical | model_estimate only).
    const estimates: NonNullable<LaborResponse>["estimates"] = [];
    const tier = c.pricing_tier ?? (await detectTier(ctx, c));
    if (tier) {
      for (const svc of await getApplicableServices(ctx, c._id)) {
        const slug = svc.slug ?? String(svc._id);
        if (service && slug !== service) continue;
        let est = await resolvePublicLaborEstimate(ctx, {
          vehicle_config_id: c._id,
          service_id: svc._id,
          vehicle_tier: tier as VehicleTier,
        });
        if (!est && svc.default_labor_hours != null) {
          // The spec minimum every booking falls back to when the ladder refuses.
          est = {
            hours: svc.default_labor_hours,
            source: "model_estimate",
            confidence: 0.2,
            tier_floor_applied: false,
          };
        }
        if (est) {
          estimates.push({
            service: slug,
            name: svc.name ?? slug,
            estimated_hours: est.hours,
            estimate_source: est.source,
            estimate_confidence: est.confidence,
          });
        }
      }
    }

    return {
      object: "empirical_labor",
      config_key: c.config_key ?? null,
      services,
      estimates,
      tier: tier ?? null,
      note:
        "services[] are empirical values measured from completed Otopair jobs. estimates[] blend " +
        "empirical with our own Camry-anchored tier model (model_estimate). Licensed book-time " +
        "blends are never served by this API.",
    };
  },
});

// ─── Key management (director-gated; CLI/admin escape hatches) ───────────────
// The internal console UI is gone — self-serve keys live in /developers
// (convex/devPortal.ts). These remain for admin issuance/revocation, e.g.
//   npx convex run dataApi:listKeys '{"token":"…"}'

export const _insertKey = internalMutation({
  args: {
    name: v.string(),
    key_hash: v.string(),
    prefix: v.string(),
    scopes: v.array(scopeValidator),
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
    scopes: v.array(scopeValidator),
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
  name: string | null;
  applicable: boolean;
  parts: ServicePartEntry[];
  labor: {
    hours: number | null;
    source: string;
    confidence: number | null;
    sample_size: number | null;
    tier_floor_applied: boolean;
  };
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

/** Completed platform visits for a VIN (bookings.by_vin), shop names joined,
 *  date-desc. Shared by assembleVehicle's history block (which serves shop
 *  names) and assembleServiceHistory (which deliberately drops them). */
async function collectCompletedVisits(
  ctx: QueryCtx,
  vinUpper: string,
  serviceById: Map<string, Doc<"services">>,
): Promise<
  Array<{ booking: Doc<"bookings">; date: string | null; services: string[]; shop: string | null }>
> {
  const visitsRaw = await ctx.db
    .query("bookings")
    .withIndex("by_vin", (q) => q.eq("vin", vinUpper))
    .take(50);
  const shopNames = new Map<string, string | null>();
  const visits: Array<{
    booking: Doc<"bookings">;
    date: string | null;
    services: string[];
    shop: string | null;
  }> = [];
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
      booking: b,
      date: b.scheduled_date ?? null,
      services: (b.service_ids ?? [])
        .map((id) => serviceById.get(String(id))?.name)
        .filter((n): n is string => Boolean(n)),
      shop,
    });
  }
  visits.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  return visits;
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

    const byService = new Map<string, VehicleServiceEntry>();
    const serviceEntry = (slugKey: string, name?: string | null, applicable = false): VehicleServiceEntry => {
      let e = byService.get(slugKey);
      if (!e) {
        e = {
          service: slugKey,
          name: name ?? null,
          applicable,
          parts: [],
          labor: { hours: null, source: "unresolved", confidence: null, sample_size: null, tier_floor_applied: false },
        };
        byService.set(slugKey, e);
      }
      if (name && !e.name) e.name = name;
      if (applicable) e.applicable = true;
      return e;
    };

    // ── Labor for EVERY bookable service — the booking flow's ladder
    //    (resolveLaborHours) gated through lib/publicLabor.ts: only
    //    "empirical" and "model_estimate" (the Camry×tier derivation) leave;
    //    licensed book-hour resolutions are substituted with the tier floor.
    //    services.default_labor_hours remains the final spec minimum. ──
    const applicableServices = await getApplicableServices(ctx, c._id);
    const tier = c.pricing_tier ?? (await detectTier(ctx, c));
    const empiricalBySvc = new Map<string, { hours: number; n: number }>();

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
      if (row.empirical_hours && (row.empirical_sample_size ?? 0) > 0) {
        const svc = serviceById.get(String(row.service_id));
        empiricalBySvc.set(svc?.slug ?? String(row.service_id), {
          hours: row.empirical_hours,
          n: row.empirical_sample_size ?? 0,
        });
      }
    }

    for (const svc of applicableServices) {
      const slugKey = svc.slug ?? String(svc._id);
      const entry = serviceEntry(slugKey, svc.name, true);

      let resolved: { hours: number; source: string; confidence: number | null; floor: boolean } | null = null;
      if (tier) {
        const est = await resolvePublicLaborEstimate(ctx, {
          vehicle_config_id: c._id,
          service_id: svc._id,
          vehicle_tier: tier,
        });
        if (est) {
          resolved = {
            hours: est.hours,
            source: est.source,
            confidence: est.confidence,
            floor: est.tier_floor_applied,
          };
        }
      }
      if (!resolved && svc.default_labor_hours != null) {
        // The spec minimum every booking falls back to when the ladder refuses.
        resolved = { hours: svc.default_labor_hours, source: "service_default", confidence: 0.2, floor: false };
      }
      if (resolved) {
        entry.labor.hours = resolved.hours;
        entry.labor.source = resolved.source;
        entry.labor.confidence = resolved.confidence;
        entry.labor.tier_floor_applied = resolved.floor;
      }
      entry.labor.sample_size = empiricalBySvc.get(slugKey)?.n ?? null;
    }

    // ── Second pass: entries created by the parts loop that the
    //    applicability rules excluded (e.g. differential_service on a FWD
    //    car) still get booking-grade hours — a customer can't book them,
    //    but the labor answer exists and integrators asked for no nulls.
    //    Buckets with NO catalog service behind them (fitment service_type
    //    strings like serpentine_belt) are parts-discovery only and are
    //    labeled parts_only instead of being given invented hours. ──
    for (const entry of byService.values()) {
      if (entry.labor.hours != null) continue;
      const svcDoc = await ctx.db
        .query("services")
        .withIndex("by_slug", (q) => q.eq("slug", entry.service))
        .first();
      if (!svcDoc) {
        entry.labor.source = "parts_only";
        continue;
      }
      if (!entry.name) entry.name = svcDoc.name;
      let resolved: { hours: number; source: string; confidence: number | null; floor: boolean } | null = null;
      if (tier) {
        const est = await resolvePublicLaborEstimate(ctx, {
          vehicle_config_id: c._id,
          service_id: svcDoc._id,
          vehicle_tier: tier,
        });
        if (est) {
          resolved = { hours: est.hours, source: est.source, confidence: est.confidence, floor: est.tier_floor_applied };
        }
      }
      if (!resolved && svcDoc.default_labor_hours != null) {
        resolved = { hours: svcDoc.default_labor_hours, source: "service_default", confidence: 0.2, floor: false };
      }
      if (resolved) {
        entry.labor.hours = resolved.hours;
        entry.labor.source = resolved.source;
        entry.labor.confidence = resolved.confidence;
        entry.labor.tier_floor_applied = resolved.floor;
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
      const visits = (await collectCompletedVisits(ctx, vinUpper, serviceById)).map((vst) => ({
        date: vst.date,
        status: vst.booking.status,
        services: vst.services,
        shop: vst.shop,
      }));
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

// ─── Gate exit tests ─────────────────────────────────────────────────────────

export type GateCheckRow = {
  config_key: string;
  served: number;
  excluded_b: number;
  excluded_x: number;
  clean: boolean;
};
export type GateCheckResult = {
  rows: GateCheckRow[];
  all_clean: boolean;
  total_excluded_b: number;
  note: string;
};

/** The P2 exit-test harness: run the maintenance gate over the top-25 configs
 *  by fill rate and assert zero licensed-B / X fields would be SERVED. Uses
 *  the same collectSpecFields + latestFieldEvidence + deriveLayer/isServable
 *  path the live endpoint uses, so the numbers cross-check the
 *  data.layer_b_exposure stat by construction.
 *  Run: npx convex run dataApi:gateCheck '{"token":"…"}' */
export const gateCheck = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<GateCheckResult> => {
    await requireDirector(ctx, token);
    const configs = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_fill_rate")
      .order("desc")
      .take(25);
    const rows: GateCheckRow[] = [];
    let totalB = 0;
    for (const c of configs) {
      const engine = c.engine_id ? await ctx.db.get(c.engine_id) : null;
      const transmission = c.transmission_id ? await ctx.db.get(c.transmission_id) : null;
      let served = 0;
      let excludedB = 0;
      let excludedX = 0;
      let leaked = false;
      for (const f of collectSpecFields(c, engine, transmission)) {
        if (f.value == null) continue;
        const ev = await latestFieldEvidence(ctx, c, f.field_name);
        const layer = ev
          ? deriveLayer(ev.source_type, ev.confidence)
          : deriveLayer(null, null); // stored value without evidence → C by default
        const servable = isServable(layer.letter, ev?.source_type ?? null);
        if (servable) {
          served++;
          // A served field must never carry licensed-B or X — the exit test.
          if (layer.letter === "X") leaked = true;
          if (layer.letter === "B" && (ev?.source_type ?? "").toLowerCase() !== "nhtsa")
            leaked = true;
        } else if (layer.letter === "B") {
          excludedB++;
        } else if (layer.letter === "X") {
          excludedX++;
        }
      }
      totalB += excludedB;
      rows.push({
        config_key: c.config_key,
        served,
        excluded_b: excludedB,
        excluded_x: excludedX,
        clean: !leaked,
      });
    }
    return {
      rows,
      all_clean: rows.every((r) => r.clean),
      total_excluded_b: totalB,
      note:
        "Same gate path as GET /v0/maintenance (collectSpecFields → latestFieldEvidence → deriveLayer → isServable). Excluded-B totals reconcile with data.layer_b_exposure.",
    };
  },
});

export type LaborGateCheckRow = {
  config_key: string;
  services_checked: number;
  empirical: number;
  model_estimate: number;
  clean: boolean;
};
export type LaborGateCheckResult = {
  rows: LaborGateCheckRow[];
  all_clean: boolean;
  note: string;
};

/** Exit test for the public labor gate (lib/publicLabor.ts): over the top-25
 *  configs by fill rate, every estimate the /v0 surface would serve must be
 *  "empirical" or "model_estimate", and every model_estimate must equal the
 *  recomputed Camry×tier floor — proof no licensed book-hours leak.
 *  Run: npx convex run dataApi:laborGateCheck '{"token":"…"}' */
export const laborGateCheck = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<LaborGateCheckResult> => {
    await requireDirector(ctx, token);
    const configs = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_fill_rate")
      .order("desc")
      .take(25);
    const rows: LaborGateCheckRow[] = [];
    for (const c of configs) {
      const tier = c.pricing_tier ?? (await detectTier(ctx, c));
      let checked = 0;
      let empirical = 0;
      let modelEstimate = 0;
      let clean = true;
      if (tier) {
        for (const svc of await getApplicableServices(ctx, c._id)) {
          const est = await resolvePublicLaborEstimate(ctx, {
            vehicle_config_id: c._id,
            service_id: svc._id,
            vehicle_tier: tier as VehicleTier,
          });
          if (!est) continue;
          checked++;
          if (est.source === "empirical") {
            empirical++;
          } else if (est.source === "model_estimate") {
            modelEstimate++;
            const floor = await computeLaborTierFloorHours(ctx, {
              serviceId: svc._id,
              vehicleTier: tier as unknown as string,
            });
            if (floor == null || Math.abs(est.hours - floor) > 1e-9) clean = false;
          } else {
            clean = false; // fails closed on any future source-label drift
          }
        }
      }
      rows.push({
        config_key: c.config_key,
        services_checked: checked,
        empirical,
        model_estimate: modelEstimate,
        clean,
      });
    }
    return {
      rows,
      all_clean: rows.every((r) => r.clean),
      note:
        "Same path as GET /v0/labor estimates[] (resolvePublicLaborEstimate). Every model_estimate must equal the recomputed Camry×tier floor; any other source label fails closed.",
    };
  },
});

// ─── /v0/vehicle-image — vehicle media (scope media:read) ────────────────────
// Serves the cached vehicle render for a config (VIN / YMMT / config_key).
// Source today: Vehicle Databases' vehicle-images API (EVOX renders), cached
// on vehicle_configs.image_url / vehicles.image_url by lib/vehicle_image.ts.
// The full VD image folder is inbound — once hosted, media_source flips to
// self-hosted storage and these URLs change WITHOUT the response shape
// changing. The licensing note rides in the response until then.

export type VehicleImageResponse =
  | {
      object: "vehicle_image";
      config: {
        config_key: string | null;
        year: number;
        make: string;
        model: string;
        trim: string | null;
      };
      image: {
        url: string;
        media_source: "vehicle_databases";
        licensing_note: string;
      } | null;
      meta: { generated_at: number };
    }
  | { object: "multiple_matches"; matches: { config_key: string | null; label: string }[] }
  | null;

export const assembleVehicleImage = internalQuery({
  args: {
    config_key: v.optional(v.string()),
    vin: v.optional(v.string()),
    year: v.optional(v.number()),
    make: v.optional(v.string()),
    model: v.optional(v.string()),
    trim: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<VehicleImageResponse> => {
    let c = await resolveConfig(ctx, args.config_key ?? null, args.vin ?? null);
    if (!c && args.year != null && args.make && args.model) {
      const { config, matches } = await resolveByYmmt(
        ctx,
        args.year,
        args.make,
        args.model,
        args.trim ?? null,
      );
      if (!config && matches.length > 1) return { object: "multiple_matches", matches };
      c = config;
    }

    // VIN-only fallback: the vehicle row may carry an image even when its
    // config link (or the config's own cache) is missing.
    let url: string | null = c?.image_url ?? null;
    if (!url && args.vin) {
      const vehicle = await ctx.db
        .query("vehicles")
        .withIndex("by_vin", (q) => q.eq("vin", args.vin!.trim().toUpperCase()))
        .first();
      url = vehicle?.image_url ?? null;
    }
    if (!url && c) {
      // Any sibling VIN of this config with a cached image (bounded — these
      // docs carry decode metadata, keep the window tiny).
      const siblings = await ctx.db
        .query("vehicles")
        .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", c!._id))
        .take(3);
      url = siblings.find((s) => s.image_url != null)?.image_url ?? null;
    }
    if (!c) return null;

    const make = await ctx.db.get(c.make_id);
    const model = await ctx.db.get(c.model_id);
    return {
      object: "vehicle_image",
      config: {
        config_key: c.config_key ?? null,
        year: c.year,
        make: (make as { name?: string } | null)?.name ?? "?",
        model: (model as { name?: string } | null)?.name ?? "?",
        trim: c.trim_name ?? null,
      },
      image: url
        ? {
            url,
            media_source: "vehicle_databases",
            licensing_note:
              "Rendered image sourced via the Vehicle Databases vehicle-images API. " +
              "Self-hosted media (the licensed VD image set) replaces these URLs when it lands; " +
              "the response shape will not change.",
          }
        : null,
      meta: { generated_at: Date.now() },
    };
  },
});

/** config_key → { id, sibling_vin } for the /v0/vehicle-image fetch-on-miss:
 *  the id lets resolveVehicleImage stamp the config's YMMT cache, and the
 *  sibling VIN makes the VDB call actually land — VDB's YMMT endpoint wants
 *  its own verbose trim names ("SE 4dr All-wheel Drive CVT"), so plain trims
 *  rarely match, while the VIN endpoint is reliable (same trick as
 *  dataCatalog.fetchConfigImage). */
export const configForImageFetch = internalQuery({
  args: { config_key: v.string() },
  handler: async (
    ctx,
    { config_key },
  ): Promise<{ id: Id<"vehicle_configs">; sibling_vin: string | null } | null> => {
    const c = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_config_key", (q) => q.eq("config_key", config_key))
      .first();
    if (!c) return null;
    const sibling = await ctx.db
      .query("vehicles")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", c._id))
      .first();
    return { id: c._id, sibling_vin: sibling?.vin ?? null };
  },
});

// ─── /v0/service-history — sanitized Carfax-style records by VIN ─────────────
// Union of three VIN-keyed record streams:
//   shop_visit     — completed platform bookings + job_actuals (dates, mileage,
//                    services, parts). Confidence "verified".
//   owner_reported — the owner's maintenance_records (one row per category).
//   document       — accepted Reducto extractions of uploaded receipts.
// Sanitization IS the contract: no PII, no costs, no shop identity, no
// free-text notes (technician_notes, mechanic_findings, prices, shop names,
// recommendations, warning-light text are all withheld).

export type ServiceHistoryRecord = {
  date: string | null;
  mileage: number | null;
  source: "shop_visit" | "owner_reported" | "document";
  confidence: string | number | null;
  services: string[];
  parts: Array<{
    name: string | null;
    oem_number: string | null;
    brand: string | null;
    quantity: number | null;
  }>;
};

export type ServiceHistoryResponse = {
  object: "service_history";
  vin: string;
  records: ServiceHistoryRecord[];
  meta: { record_count: number; sanitization: string; generated_at: number };
} | null;

/** Best-effort ISO yyyy-mm-dd; ms epochs and parseable strings normalize,
 *  anything else passes through raw (still string-sortable). */
function normalizeHistoryDate(d: string | number | undefined | null): string | null {
  if (d == null) return null;
  if (typeof d === "number") return new Date(d).toISOString().slice(0, 10);
  const t = Date.parse(d);
  return Number.isNaN(t) ? d : new Date(t).toISOString().slice(0, 10);
}

export const assembleServiceHistory = internalQuery({
  args: { vin: v.string() },
  handler: async (ctx, { vin }): Promise<ServiceHistoryResponse> => {
    const vinUpper = vin.trim().toUpperCase();
    const records: ServiceHistoryRecord[] = [];

    const allServices = await ctx.db.query("services").collect();
    const serviceById = new Map(allServices.map((s) => [String(s._id), s]));

    // 1) Completed platform visits (+ job_actuals mileage/parts). The shop
    //    name collectCompletedVisits joins is deliberately DROPPED here.
    for (const visit of await collectCompletedVisits(ctx, vinUpper, serviceById)) {
      const actual = await ctx.db
        .query("job_actuals")
        .withIndex("by_booking_id", (q) => q.eq("booking_id", visit.booking._id))
        .first();
      const parts: ServiceHistoryRecord["parts"] = [];
      const rawParts: unknown = actual?.parts_used;
      if (Array.isArray(rawParts)) {
        for (const p of rawParts.slice(0, 25) as Array<Record<string, unknown>>) {
          if (!p || typeof p !== "object") continue;
          parts.push({
            name:
              typeof p.part_name === "string" && p.part_name.length > 0
                ? p.part_name
                : typeof p.name === "string"
                  ? p.name
                  : null,
            oem_number:
              typeof p.oem_number === "string" && p.oem_number.length > 0
                ? p.oem_number
                : typeof p.oem_part_number === "string"
                  ? p.oem_part_number
                  : null,
            brand: typeof p.brand === "string" && p.brand.length > 0 ? p.brand : null,
            quantity:
              typeof p.quantity === "number" && Number.isFinite(p.quantity) ? p.quantity : null,
          });
        }
      }
      records.push({
        date: normalizeHistoryDate(visit.date),
        mileage: actual?.completion_mileage ?? actual?.odometer_in ?? null,
        source: "shop_visit",
        confidence: "verified",
        services: visit.services,
        parts,
      });
    }

    // 2) Owner-reported maintenance_records (active ownerships only).
    const owners = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_vin", (q) => q.eq("vin", vinUpper))
      .take(10);
    for (const owner of owners) {
      if (owner.removed_at != null) continue;
      const rows = await ctx.db
        .query("maintenance_records")
        .withIndex("by_vehicle_owner", (q) => q.eq("vehicleOwnerId", owner._id))
        .take(50);
      for (const r of rows) {
        records.push({
          date: normalizeHistoryDate(r.lastServiceDate ?? null),
          mileage: r.lastServiceMileage ?? null,
          source: "owner_reported",
          confidence: r.confidence ?? "self_reported",
          services: [r.type],
          parts: [], // customInputs stays internal
        });
      }
    }

    // 3) Accepted document extractions (auto_accepted | user_confirmed only).
    const docs = await ctx.db
      .query("vehicle_documents")
      .withIndex("by_vin", (q) => q.eq("vin", vinUpper))
      .take(50);
    for (const doc of docs) {
      if (doc.parse_status !== "parsed") continue;
      const ext = await ctx.db
        .query("vehicle_document_extractions")
        .withIndex("by_document", (q) => q.eq("document_id", doc._id))
        .first();
      if (!ext || (ext.review_state !== "auto_accepted" && ext.review_state !== "user_confirmed"))
        continue;
      const payload = (ext.payload ?? {}) as {
        service_date?: string;
        vehicle?: { odometer_in?: number };
        line_items?: Array<{ kind?: string; description?: string; fluid_type?: string; brand?: string }>;
      };
      const items = Array.isArray(payload.line_items) ? payload.line_items : [];
      const services: string[] = [];
      const parts: ServiceHistoryRecord["parts"] = [];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        if (item.kind === "service" && typeof item.description === "string") {
          services.push(item.description);
        } else if (item.kind === "fluid") {
          const label =
            typeof item.description === "string"
              ? item.description
              : item.fluid_type
                ? `${item.fluid_type} fluid service`
                : null;
          if (label) services.push(label);
        } else if (item.kind === "part") {
          parts.push({
            name: typeof item.description === "string" ? item.description : null,
            oem_number: null,
            brand: typeof item.brand === "string" ? item.brand : null,
            quantity: null,
          });
        }
      }
      records.push({
        date: normalizeHistoryDate(payload.service_date ?? null),
        mileage:
          typeof payload.vehicle?.odometer_in === "number" ? payload.vehicle.odometer_in : null,
        source: "document",
        confidence: ext.overall_confidence,
        services,
        parts,
      });
    }

    // 404 only for a VIN we know NOTHING about: zero records AND no vehicles row.
    if (records.length === 0) {
      const vehicle = await ctx.db
        .query("vehicles")
        .withIndex("by_vin", (q) => q.eq("vin", vinUpper))
        .first();
      if (!vehicle) return null;
    }

    records.sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
    return {
      object: "service_history",
      vin: vinUpper,
      records,
      meta: {
        record_count: records.length,
        sanitization:
          "No PII, costs, shop identity, or free-text notes are served. shop_visit records are shop-verified; owner_reported and document records carry their own confidence.",
        generated_at: Date.now(),
      },
    };
  },
});

// ─── /v0/enrich support — status lookup + daily-quota metering ───────────────

export type EnrichStatus = {
  config_key: string | null;
  enrichment_status: string | null;
  last_enriched_at: number | null;
  fill_rate: number | null;
  year: number;
  make: string;
  model: string;
  trim: string | null;
} | null;

export const getEnrichStatusByVin = internalQuery({
  args: { vin: v.optional(v.string()), config_key: v.optional(v.string()) },
  handler: async (ctx, { vin, config_key }): Promise<EnrichStatus> => {
    const c = await resolveConfig(ctx, config_key ?? null, vin ?? null);
    if (!c) return null;
    const make = await ctx.db.get(c.make_id);
    const model = await ctx.db.get(c.model_id);
    return {
      config_key: c.config_key ?? null,
      enrichment_status: c.enrichment_status ?? null,
      last_enriched_at: c.last_enriched_at ?? null,
      fill_rate: c.fill_rate ?? null,
      year: c.year,
      make: make?.name ?? "?",
      model: model?.name ?? "?",
      trim: c.trim_name ?? null,
    };
  },
});

/** Daily-quota meter: api_usage rows for one key × endpoint since a cutoff,
 *  optionally filtered to one status (202 = an enrich run actually scheduled;
 *  cache hits respond 200 and never consume quota). */
export const countUsageForEndpointSince = internalQuery({
  args: {
    api_key_id: v.id("api_keys"),
    endpoint: v.string(),
    since: v.number(),
    status: v.optional(v.number()),
  },
  handler: async (ctx, { api_key_id, endpoint, since, status }): Promise<number> => {
    const rows = await ctx.db
      .query("api_usage")
      .withIndex("by_key_and_time", (q) => q.eq("api_key_id", api_key_id).gte("created_at", since))
      .take(1000);
    return rows.filter(
      (r) => r.endpoint === endpoint && (status === undefined || r.status === status),
    ).length;
  },
});
