/**
 * convex/seedCatalog.ts — cross-deployment CATALOG seeder (Sep 2026).
 *
 * Copies fully-enriched, priced "cars" (a vehicle_configs row + its catalog
 * child graph) FROM the dev deployments (dev:ardent-crab-641,
 * dev:third-bird-914) INTO prod (mellow-cat-431) — WITHOUT the destructive
 * whole-deployment `convex export/import` (that would wipe prod). It is a
 * SELECTIVE, IDEMPOTENT, per-car seed.
 *
 * Convex `_id`s do NOT cross deployments, so nothing is copied by id. Every
 * row is re-linked on the destination by a natural business key:
 *   makes            → makeKeyOf(name)              (getOrCreateMake)
 *   models           → (make_id, name)
 *   trims            → (model_id, name, years)
 *   engines          → engine_code | (trim_id, displacement_l, cylinders, fuel)
 *   transmissions    → (trim_id, transmission_type, code)
 *   chassis_specs    → chassis_code
 *   vehicle_configs  → config_key   (stable YMMT+engine fingerprint; the car identity)
 *   oem_parts        → oem_part_number_normalized
 *   services         → slug         (service_id differs per deployment)
 *
 * WHAT A "CAR" IS (COPY set — catalog/enrichment only):
 *   vehicle_configs, drivetrain_configs, trim_specs,
 *   part_fitments → oem_parts → part_prices, refuted_fitments,
 *   service_intervals, labor_times, labor_observations,
 *   config_service_exclusions, config_reliability_signals,
 *   config_epa_economy, vehicle_recalls, estimator_estimates.
 *
 * DELIBERATELY NOT copied (per-deployment runtime / user / audit / provider
 * trace, or would collide with a real prod install):
 *   vehicles, enrichment_runs, enrichment_run_steps, mechanic_verifications,
 *   field_claims, vehicle_facts(_audit), data_incident_configs, vin_queue,
 *   part_snapshots, *_quote_snapshots, shop_part_preferences,
 *   service_vehicle_specs, pricing_baselines, pricing_vehicle_assignments
 *   (the config already carries its denormalized pricing_tier), chassis_variants,
 *   generations (deprecated — generation_id is dropped).
 *
 * SELECTION ("properly enriched, ≥85%, has parts"):
 *   enrichment_status ∈ {complete, verified}  AND  fill_rate ≥ min_fill (85)
 *   AND ≥1 part_fitment whose part carries a TRUSTED price row
 *   (not poison — online_discount/you_save/unverified — and not a
 *   non-pooled estimator-endpoint fallback point). See lib/priceTypes.ts.
 *
 * TRANSPORT: these are PUBLIC functions gated by a shared secret so a plain
 * Node driver (scripts/seed-prod-cars.mjs) can reach them over HTTP with just
 * the deployment URL — no admin key. Set the secret on EVERY deployment you
 * touch (both sources AND prod):
 *   npx convex env set SEED_SECRET <value>          (with .env.local pointed there)
 * The functions refuse to run if SEED_SECRET is unset or mismatched. They are
 * safe to leave deployed; remove this file + redeploy once the seed is done.
 *
 * Driver: `node scripts/seed-prod-cars.mjs` (dry-run) then `--execute`.
 */
import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { getOrCreateMake } from "./lib/makeKey";
import { normalizeOemNumber } from "./vehicleEnrichment/priceParser";
import { isPoisonPriceType, isNonPooledPriceType } from "./lib/priceTypes";

// ---------------------------------------------------------------------------
// Secret gate. process.env is available in the Convex runtime.
// ---------------------------------------------------------------------------
function assertSecret(provided: string): void {
  const expected = process.env.SEED_SECRET;
  if (!expected) {
    throw new Error(
      "seedCatalog: SEED_SECRET is not set on this deployment. Run `npx convex env set SEED_SECRET <value>` (with .env.local pointed at this deployment) before seeding.",
    );
  }
  if (provided !== expected) {
    throw new Error("seedCatalog: invalid seed secret.");
  }
}

const QUALIFYING_STATUSES = new Set(["complete", "verified"]);

/** Copy a row's scalar payload: drop Convex system fields, any listed FK
 *  fields (re-added remapped on import), and `undefined` values. */
function clean(row: Record<string, unknown>, drop: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(row)) {
    if (k === "_id" || k === "_creationTime") continue;
    if (drop.includes(k)) continue;
    if (val === undefined) continue;
    out[k] = val;
  }
  return out;
}

/** True when this part has at least one price row that counts toward the
 *  customer-facing price (mirrors the aggregator's trust filter). */
function hasTrustedPrice(prices: Doc<"part_prices">[]): boolean {
  return prices.some(
    (p) => !isPoisonPriceType(p.price_type) && !isNonPooledPriceType(p.price_type),
  );
}

/** Deterministic canonical pick among rows sharing a config_key: highest
 *  fill_rate, then status "complete/verified", then oldest. Matches the spirit
 *  of configsMerge.pickCanonicalConfig (without the fitment-count tiebreak,
 *  which would need extra reads here). */
function pickCanonical(rows: Doc<"vehicle_configs">[]): Doc<"vehicle_configs"> {
  return [...rows].sort(
    (a, b) =>
      (b.fill_rate ?? -1) - (a.fill_rate ?? -1) ||
      (QUALIFYING_STATUSES.has(b.enrichment_status ?? "") ? 1 : 0) -
        (QUALIFYING_STATUSES.has(a.enrichment_status ?? "") ? 1 : 0) ||
      a._creationTime - b._creationTime,
  )[0];
}

// ===========================================================================
// 1. listQualifyingConfigs — paged candidate scan on the SOURCE deployment.
//    Uses by_fill_rate to skip everything below the bar cheaply. The final
//    "has priced parts" leg is confirmed per-car in exportConfigBundle
//    (needs fitment+price reads), so this returns candidates, not winners.
// ===========================================================================
export const listQualifyingConfigs = query({
  args: {
    secret: v.string(),
    min_fill: v.number(),
    cursor: v.union(v.string(), v.null()),
    num_items: v.number(),
  },
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    const page = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_fill_rate", (q) => q.gte("fill_rate", args.min_fill))
      .paginate({ cursor: args.cursor, numItems: args.num_items });

    const rows = page.page
      .filter(
        (c) =>
          QUALIFYING_STATUSES.has(c.enrichment_status ?? "") &&
          (c.fill_rate ?? 0) >= args.min_fill,
      )
      .map((c) => ({
        config_key: c.config_key,
        fill_rate: c.fill_rate ?? null,
        enrichment_status: c.enrichment_status ?? null,
        year: c.year,
      }));

    return { rows, cursor: page.continueCursor, is_done: page.isDone };
  },
});

// ===========================================================================
// 2. peekConfigKeys — which of these config_keys already exist here? Used by
//    the driver against the DESTINATION for a dry-run new-vs-existing preview.
// ===========================================================================
export const peekConfigKeys = query({
  args: { secret: v.string(), config_keys: v.array(v.string()) },
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    const existing: string[] = [];
    for (const key of args.config_keys) {
      const hit = await ctx.db
        .query("vehicle_configs")
        .withIndex("by_config_key", (q) => q.eq("config_key", key))
        .first();
      if (hit) existing.push(key);
    }
    return { existing };
  },
});

// ===========================================================================
// 3. exportConfigBundle — the full, deployment-agnostic bundle for one car.
//    All ids stripped; parents carried by natural key, services by slug.
// ===========================================================================
export const exportConfigBundle = query({
  args: { secret: v.string(), config_key: v.string() },
  handler: async (ctx, args) => {
    assertSecret(args.secret);

    const rows = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_config_key", (q) => q.eq("config_key", args.config_key))
      .collect();
    if (rows.length === 0) return { found: false as const };
    const config = pickCanonical(rows);
    const configId = config._id;

    // --- parents -----------------------------------------------------------
    const make = await ctx.db.get(config.make_id);
    const model = await ctx.db.get(config.model_id);
    const engine = config.engine_id ? await ctx.db.get(config.engine_id) : null;
    const transmission = config.transmission_id
      ? await ctx.db.get(config.transmission_id)
      : null;
    // The trim row hangs off engine/transmission/trim_specs. Resolve one.
    const trimId =
      engine?.trim_id ?? transmission?.trim_id ?? undefined;
    const trim = trimId ? await ctx.db.get(trimId) : null;
    const chassis = config.chassis_code
      ? await ctx.db
          .query("chassis_specs")
          .withIndex("by_chassis_code", (q) =>
            q.eq("chassis_code", config.chassis_code as string),
          )
          .first()
      : null;

    // --- service slug map (service_id → slug) ------------------------------
    const serviceSlug = new Map<string, string | null>();
    const rememberService = async (id: Id<"services"> | undefined) => {
      if (!id) return;
      const key = String(id);
      if (serviceSlug.has(key)) return;
      const svc = await ctx.db.get(id);
      serviceSlug.set(key, svc?.slug ?? null);
    };

    // --- children (by config-leading index) --------------------------------
    const drivetrain_configs = await ctx.db
      .query("drivetrain_configs")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", configId))
      .collect();
    const trim_specs = await ctx.db
      .query("trim_specs")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", configId))
      .collect();
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", configId))
      .collect();
    const refuted = await ctx.db
      .query("refuted_fitments")
      .withIndex("by_config", (q) => q.eq("vehicle_config_id", configId))
      .collect();
    const intervals = await ctx.db
      .query("service_intervals")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", configId))
      .collect();
    const laborTimes = await ctx.db
      .query("labor_times")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", configId))
      .collect();
    const laborObs = await ctx.db
      .query("labor_observations")
      .withIndex("by_config_service", (q) => q.eq("vehicle_config_id", configId))
      .collect();
    const exclusions = await ctx.db
      .query("config_service_exclusions")
      .withIndex("by_config", (q) => q.eq("vehicle_config_id", configId))
      .collect();
    const reliability = await ctx.db
      .query("config_reliability_signals")
      .withIndex("by_config", (q) => q.eq("vehicle_config_id", configId))
      .collect();
    const epa = await ctx.db
      .query("config_epa_economy")
      .withIndex("by_config", (q) => q.eq("vehicle_config_id", configId))
      .collect();
    const recalls = await ctx.db
      .query("vehicle_recalls")
      .withIndex("by_config", (q) => q.eq("vehicle_config_id", configId))
      .collect();
    const estimator = await ctx.db
      .query("estimator_estimates")
      .withIndex("by_config", (q) => q.eq("vehicle_config_id", configId))
      .collect();

    // --- parts sub-graph (unique oem_parts + their prices) -----------------
    const partById = new Map<string, Doc<"oem_parts">>();
    const partsOut: Array<{
      normalized: string;
      make_name: string | null;
      part: Record<string, unknown>;
      prices: Array<Record<string, unknown>>;
    }> = [];
    let anyTrustedPrice = false;
    for (const f of fitments) {
      const key = String(f.part_id);
      if (partById.has(key)) continue;
      const part = await ctx.db.get(f.part_id);
      if (!part) continue;
      partById.set(key, part);
      const prices = await ctx.db
        .query("part_prices")
        .withIndex("by_part", (q) => q.eq("part_id", part._id))
        .collect();
      if (hasTrustedPrice(prices)) anyTrustedPrice = true;
      const normalized =
        part.oem_part_number_normalized ?? normalizeOemNumber(part.oem_part_number);
      const partMake = part.make_id ? await ctx.db.get(part.make_id) : null;
      partsOut.push({
        normalized,
        make_name: partMake?.name ?? null,
        part: clean(part, ["make_id"]),
        prices: prices.map((p) => clean(p, ["part_id"])),
      });
    }

    // --- service-slug annotation ------------------------------------------
    for (const r of [...intervals, ...laborTimes, ...laborObs, ...estimator]) {
      await rememberService((r as { service_id: Id<"services"> }).service_id);
    }
    const slugFor = (id: Id<"services">) => serviceSlug.get(String(id)) ?? null;
    const withSlug = <T extends { service_id: Id<"services"> }>(r: T) => ({
      ...clean(r, ["vehicle_config_id", "service_id"]),
      service_slug: slugFor(r.service_id),
    });

    const qualifies =
      anyTrustedPrice &&
      QUALIFYING_STATUSES.has(config.enrichment_status ?? "") &&
      (config.fill_rate ?? 0) > 0;

    return {
      found: true as const,
      config_key: config.config_key,
      fill_rate: config.fill_rate ?? null,
      enrichment_status: config.enrichment_status ?? null,
      qualifies,
      priced_part_count: partsOut.filter((p) => p.prices.length > 0).length,
      fitment_count: fitments.length,

      // parents (natural-keyed)
      make: make ? clean(make, []) : null,
      model: model ? clean(model, ["make_id"]) : null,
      trim: trim ? clean(trim, ["model_id"]) : null,
      engine: engine ? clean(engine, ["trim_id", "make_id"]) : null,
      transmission: transmission
        ? clean(transmission, ["trim_id", "make_id"])
        : null,
      chassis_specs: chassis ? clean(chassis, ["make_id"]) : null,

      // the car
      config: clean(config, [
        "make_id",
        "model_id",
        "generation_id",
        "engine_id",
        "transmission_id",
        "cloned_from_config_id",
      ]),

      // children
      children: {
        drivetrain_configs: drivetrain_configs.map((r) =>
          clean(r, ["vehicle_config_id"]),
        ),
        trim_specs: trim_specs.map((r) => ({
          ...clean(r, ["vehicle_config_id", "trim_id"]),
          trim_scoped: r.trim_id != null,
        })),
        part_fitments: fitments.map((f) => ({
          ...clean(f, [
            "vehicle_config_id",
            "part_id",
            "flag_dismissed_by_id",
          ]),
          part_normalized:
            partById.get(String(f.part_id))?.oem_part_number_normalized ??
            (partById.has(String(f.part_id))
              ? normalizeOemNumber(partById.get(String(f.part_id))!.oem_part_number)
              : null),
        })),
        refuted_fitments: refuted.map((r) => clean(r, ["vehicle_config_id"])),
        service_intervals: intervals.map(withSlug),
        labor_times: laborTimes.map(withSlug),
        labor_observations: laborObs.map(withSlug),
        config_service_exclusions: exclusions.map((r) =>
          clean(r, ["vehicle_config_id", "marked_by_mechanic_id", "booking_id"]),
        ),
        config_reliability_signals: reliability.map((r) =>
          clean(r, ["vehicle_config_id"]),
        ),
        config_epa_economy: epa.map((r) => clean(r, ["vehicle_config_id"])),
        vehicle_recalls: recalls.map((r) => clean(r, ["vehicle_config_id"])),
        estimator_estimates: estimator.map(withSlug),
      },

      parts: partsOut,
    };
  },
});

// ===========================================================================
// 4. importConfigBundle — insert ONE car on the DESTINATION, atomically.
//    Idempotent: an existing config_key is left untouched (returns skipped).
// ===========================================================================

async function getOrCreateModel(
  ctx: MutationCtx,
  makeId: Id<"makes">,
  name: string,
  extra: Record<string, unknown>,
): Promise<Id<"models">> {
  const existing = await ctx.db
    .query("models")
    .withIndex("by_make_id", (q) => q.eq("make_id", makeId))
    .collect();
  const hit = existing.find((m) => m.name === name);
  if (hit) return hit._id;
  return ctx.db.insert("models", { ...extra, make_id: makeId, name } as any);
}

async function getOrCreateTrim(
  ctx: MutationCtx,
  modelId: Id<"models">,
  trim: Record<string, unknown>,
): Promise<Id<"trims">> {
  const existing = await ctx.db
    .query("trims")
    .withIndex("by_model_id", (q) => q.eq("model_id", modelId))
    .collect();
  const hit = existing.find(
    (t) =>
      t.name === trim.name &&
      (t.year_start ?? null) === ((trim.year_start as number) ?? null) &&
      (t.year_end ?? null) === ((trim.year_end as number) ?? null),
  );
  if (hit) return hit._id;
  return ctx.db.insert("trims", { ...trim, model_id: modelId } as any);
}

async function getOrCreateEngine(
  ctx: MutationCtx,
  trimId: Id<"trims"> | undefined,
  makeId: Id<"makes"> | undefined,
  engine: Record<string, unknown>,
): Promise<Id<"engines">> {
  const code = engine.engine_code as string | undefined;
  if (code) {
    const byCode = await ctx.db
      .query("engines")
      .withIndex("by_engine_code", (q) => q.eq("engine_code", code))
      .collect();
    const hit = byCode.find(
      (e) => (trimId ? e.trim_id === trimId : true),
    );
    if (hit) return hit._id;
  } else if (trimId) {
    const byTrim = await ctx.db
      .query("engines")
      .withIndex("by_trim_id", (q) => q.eq("trim_id", trimId))
      .collect();
    const hit = byTrim.find(
      (e) =>
        (e.displacement_l ?? null) === ((engine.displacement_l as number) ?? null) &&
        (e.cylinders ?? null) === ((engine.cylinders as number) ?? null) &&
        (e.fuel_type ?? null) === ((engine.fuel_type as string) ?? null),
    );
    if (hit) return hit._id;
  }
  return ctx.db.insert("engines", {
    ...engine,
    ...(trimId ? { trim_id: trimId } : {}),
    ...(makeId ? { make_id: makeId } : {}),
  } as any);
}

async function getOrCreateTransmission(
  ctx: MutationCtx,
  trimId: Id<"trims"> | undefined,
  makeId: Id<"makes"> | undefined,
  tx: Record<string, unknown>,
): Promise<Id<"transmissions">> {
  if (trimId) {
    const byTrim = await ctx.db
      .query("transmissions")
      .withIndex("by_trim", (q) => q.eq("trim_id", trimId))
      .collect();
    const hit = byTrim.find(
      (t) =>
        (t.transmission_type ?? null) ===
          ((tx.transmission_type as string) ?? null) &&
        (t.code ?? null) === ((tx.code as string) ?? null),
    );
    if (hit) return hit._id;
  }
  return ctx.db.insert("transmissions", {
    ...tx,
    ...(trimId ? { trim_id: trimId } : {}),
    ...(makeId ? { make_id: makeId } : {}),
  } as any);
}

async function ensureChassisSpec(
  ctx: MutationCtx,
  makeId: Id<"makes"> | undefined,
  chassis: Record<string, unknown>,
): Promise<void> {
  const code = chassis.chassis_code as string | undefined;
  if (!code) return;
  const hit = await ctx.db
    .query("chassis_specs")
    .withIndex("by_chassis_code", (q) => q.eq("chassis_code", code))
    .first();
  if (hit) return;
  await ctx.db.insert("chassis_specs", {
    ...chassis,
    ...(makeId ? { make_id: makeId } : {}),
  } as any);
}

async function getOrCreatePart(
  ctx: MutationCtx,
  normalized: string,
  makeName: string | null,
  part: Record<string, unknown>,
): Promise<Id<"oem_parts">> {
  const hit = await ctx.db
    .query("oem_parts")
    .withIndex("by_part_number_normalized", (q) =>
      q.eq("oem_part_number_normalized", normalized),
    )
    .first();
  if (hit) return hit._id;
  const makeId = makeName ? await getOrCreateMake(ctx.db, makeName) : undefined;
  return ctx.db.insert("oem_parts", {
    ...part,
    oem_part_number_normalized: normalized,
    ...(makeId ? { make_id: makeId } : {}),
  } as any);
}

export const importConfigBundle = mutation({
  args: { secret: v.string(), bundle: v.any() },
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    const b = args.bundle as any;
    if (!b || !b.config || !b.config_key || !b.make?.name || !b.model?.name) {
      throw new Error("seedCatalog.import: malformed bundle");
    }

    // Idempotency: the car already exists → leave it alone.
    const existing = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_config_key", (q) => q.eq("config_key", b.config_key))
      .first();
    if (existing) {
      return { status: "skipped_exists", config_key: b.config_key };
    }

    // --- parents -----------------------------------------------------------
    const makeId = await getOrCreateMake(ctx.db, b.make.name, {
      country: b.make.country,
      logo: b.make.logo,
      logo_url: b.make.logo_url,
      oem_part_pattern: b.make.oem_part_pattern,
      oem_part_pattern_alt: b.make.oem_part_pattern_alt,
      parent_group: b.make.parent_group,
    });
    const modelId = await getOrCreateModel(ctx, makeId, b.model.name, {
      slug: b.model.slug,
      category: b.model.category,
    });
    const trimId = b.trim
      ? await getOrCreateTrim(ctx, modelId, b.trim)
      : undefined;
    const engineId = b.engine
      ? await getOrCreateEngine(ctx, trimId, makeId, b.engine)
      : undefined;
    const transmissionId = b.transmission
      ? await getOrCreateTransmission(ctx, trimId, makeId, b.transmission)
      : undefined;
    if (b.chassis_specs) await ensureChassisSpec(ctx, makeId, b.chassis_specs);

    // --- the car -----------------------------------------------------------
    const configId = await ctx.db.insert("vehicle_configs", {
      ...b.config,
      make_id: makeId,
      model_id: modelId,
      ...(engineId ? { engine_id: engineId } : {}),
      ...(transmissionId ? { transmission_id: transmissionId } : {}),
    } as any);

    // --- parts + prices (shared catalog; dedupe across previously-seeded cars)
    const partIdByNorm = new Map<string, Id<"oem_parts">>();
    let priceInserts = 0;
    for (const p of b.parts ?? []) {
      const partId = await getOrCreatePart(
        ctx,
        p.normalized,
        p.make_name ?? null,
        p.part,
      );
      partIdByNorm.set(p.normalized, partId);
      // Dedupe prices by (source_domain, price, price_type) — the part row is
      // shared, so it may already carry prices from an earlier seeded car.
      const existingPrices = await ctx.db
        .query("part_prices")
        .withIndex("by_part", (q) => q.eq("part_id", partId))
        .collect();
      const seen = new Set(
        existingPrices.map(
          (r) => `${r.source_domain ?? ""}|${r.price}|${r.price_type ?? ""}`,
        ),
      );
      for (const price of p.prices ?? []) {
        const sig = `${price.source_domain ?? ""}|${price.price}|${price.price_type ?? ""}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
        await ctx.db.insert("part_prices", { ...price, part_id: partId } as any);
        priceInserts++;
      }
    }

    // --- service slug → id resolver (skip rows whose service isn't on dest)
    const svcIdBySlug = new Map<string, Id<"services"> | null>();
    const resolveService = async (
      slug: string | null,
    ): Promise<Id<"services"> | null> => {
      if (!slug) return null;
      if (svcIdBySlug.has(slug)) return svcIdBySlug.get(slug)!;
      const svc = await ctx.db
        .query("services")
        .withIndex("by_slug", (q) => q.eq("slug", slug))
        .first();
      const id = svc?._id ?? null;
      svcIdBySlug.set(slug, id);
      return id;
    };

    const ch = b.children ?? {};
    const counts: Record<string, number> = {};
    const skipped: Record<string, number> = {};
    const bump = (t: string, m: Record<string, number>) => {
      m[t] = (m[t] ?? 0) + 1;
    };

    for (const r of ch.drivetrain_configs ?? []) {
      await ctx.db.insert("drivetrain_configs", {
        ...r,
        vehicle_config_id: configId,
      } as any);
      bump("drivetrain_configs", counts);
    }
    for (const r of ch.trim_specs ?? []) {
      const { trim_scoped, ...rest } = r;
      await ctx.db.insert("trim_specs", {
        ...rest,
        vehicle_config_id: configId,
        ...(trim_scoped && trimId ? { trim_id: trimId } : {}),
      } as any);
      bump("trim_specs", counts);
    }
    for (const f of ch.part_fitments ?? []) {
      const { part_normalized, ...rest } = f;
      const partId = part_normalized
        ? partIdByNorm.get(part_normalized)
        : undefined;
      if (!partId) {
        bump("part_fitments", skipped);
        continue;
      }
      await ctx.db.insert("part_fitments", {
        ...rest,
        vehicle_config_id: configId,
        part_id: partId,
      } as any);
      bump("part_fitments", counts);
    }
    for (const r of ch.refuted_fitments ?? []) {
      await ctx.db.insert("refuted_fitments", {
        ...r,
        vehicle_config_id: configId,
      } as any);
      bump("refuted_fitments", counts);
    }
    for (const r of ch.service_intervals ?? []) {
      const { service_slug, ...rest } = r;
      const sid = await resolveService(service_slug);
      if (!sid) {
        bump("service_intervals", skipped);
        continue;
      }
      await ctx.db.insert("service_intervals", {
        ...rest,
        vehicle_config_id: configId,
        service_id: sid,
      } as any);
      bump("service_intervals", counts);
    }
    for (const r of ch.labor_times ?? []) {
      const { service_slug, ...rest } = r;
      const sid = await resolveService(service_slug);
      if (!sid) {
        bump("labor_times", skipped);
        continue;
      }
      await ctx.db.insert("labor_times", {
        ...rest,
        vehicle_config_id: configId,
        service_id: sid,
      } as any);
      bump("labor_times", counts);
    }
    for (const r of ch.labor_observations ?? []) {
      const { service_slug, ...rest } = r;
      const sid = await resolveService(service_slug);
      if (!sid) {
        bump("labor_observations", skipped);
        continue;
      }
      await ctx.db.insert("labor_observations", {
        ...rest,
        vehicle_config_id: configId,
        service_id: sid,
      } as any);
      bump("labor_observations", counts);
    }
    for (const r of ch.config_service_exclusions ?? []) {
      await ctx.db.insert("config_service_exclusions", {
        ...r,
        vehicle_config_id: configId,
      } as any);
      bump("config_service_exclusions", counts);
    }
    for (const r of ch.config_reliability_signals ?? []) {
      await ctx.db.insert("config_reliability_signals", {
        ...r,
        vehicle_config_id: configId,
      } as any);
      bump("config_reliability_signals", counts);
    }
    for (const r of ch.config_epa_economy ?? []) {
      await ctx.db.insert("config_epa_economy", {
        ...r,
        vehicle_config_id: configId,
      } as any);
      bump("config_epa_economy", counts);
    }
    for (const r of ch.vehicle_recalls ?? []) {
      await ctx.db.insert("vehicle_recalls", {
        ...r,
        vehicle_config_id: configId,
      } as any);
      bump("vehicle_recalls", counts);
    }
    for (const r of ch.estimator_estimates ?? []) {
      const { service_slug, ...rest } = r;
      const sid = await resolveService(service_slug);
      if (!sid) {
        bump("estimator_estimates", skipped);
        continue;
      }
      await ctx.db.insert("estimator_estimates", {
        ...rest,
        vehicle_config_id: configId,
        service_id: sid,
      } as any);
      bump("estimator_estimates", counts);
    }

    return {
      status: "created",
      config_key: b.config_key,
      config_id: String(configId),
      parts: partIdByNorm.size,
      price_rows: priceInserts,
      inserted: counts,
      skipped_rows: skipped,
    };
  },
});
