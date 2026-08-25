/**
 * devOnly/dataFixes — audited one-off data corrections, CLI only.
 *
 * For enrichment data errors a director would otherwise fix through the panel
 * (the panel mutations are token-gated; CLI ops run these internal functions
 * instead). Every fix writes an audit_log row with the reason so corrections
 * are traceable next to regular director edits.
 *
 *   npx convex run devOnly/dataFixes:engineTimingAudit
 *   npx convex run devOnly/dataFixes:fixEngineFields '{"engine_id":"...","timing_system":"belt","reason":"..."}'
 */
import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { isMarketplaceDomain, isMarketplaceUrl } from "../vehicleEnrichment/sourceRegistry";
import { ASSIGNMENT_RULES, matchRule } from "../seeds/seedPricing";
import { VehicleTier } from "../lib/vehicleTiers";

/**
 * READ-ONLY spot-check sweep: every vehicle_config with its engine's
 * timing_system / cylinders / displacement so misclassifications (the Jetta's
 * "chain" EA211, cylinders holding displacement) are visible per car.
 */
export const engineTimingAudit = internalQuery({
  args: {},
  handler: async (ctx) => {
    const configs = (await ctx.db.query("vehicle_configs").collect()) as any[];
    const rows: any[] = [];
    for (const c of configs) {
      const engine = c.engine_id ? ((await ctx.db.get(c.engine_id)) as any) : null;
      rows.push({
        config_key: c.config_key,
        enrichment_status: c.enrichment_status,
        engine_id: c.engine_id ?? null,
        engine_code: engine?.engine_code ?? null,
        engine_family: engine?.engine_family ?? null,
        timing_system: engine?.timing_system ?? null,
        cylinders: engine?.cylinders ?? null,
        displacement_l: engine?.displacement_l ?? engine?.displacement_liters ?? null,
        cylinders_suspect:
          engine?.cylinders != null && !Number.isInteger(engine.cylinders),
      });
    }
    return rows;
  },
});

/**
 * Audited one-off engine field correction. Only patches fields that actually
 * change; writes one audit_log `data_fix` row (actor "CLI data fix") with the
 * before → after diff and the caller's reason. No-op (no audit row) when the
 * stored values already match.
 */
export const fixEngineFields = internalMutation({
  args: {
    engine_id: v.id("engines"),
    timing_system: v.optional(v.string()),
    cylinders: v.optional(v.number()),
    coolant_capacity_qts: v.optional(v.number()),
    oil_capacity_qts: v.optional(v.number()),
    engine_code: v.optional(v.string()),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const engine = await ctx.db.get(args.engine_id);
    if (!engine) return { ok: false as const, reason: "engine_not_found" };

    const patch: Record<string, unknown> = {};
    const changes: string[] = [];
    const tryPatch = (
      key: "timing_system" | "cylinders" | "coolant_capacity_qts" | "oil_capacity_qts" | "engine_code",
      nextVal: unknown,
    ) => {
      if (nextVal === undefined) return;
      const cur = (engine as any)[key];
      if (cur === nextVal) return;
      patch[key] = nextVal;
      changes.push(`${key}: ${cur ?? "—"} → ${nextVal}`);
    };
    tryPatch("timing_system", args.timing_system);
    tryPatch("cylinders", args.cylinders);
    tryPatch("coolant_capacity_qts", args.coolant_capacity_qts);
    tryPatch("oil_capacity_qts", args.oil_capacity_qts);
    tryPatch("engine_code", args.engine_code);

    // Stamp every PROVIDED field as human-verified — including ones whose
    // stored value already matched (confirming a value is itself a
    // verification). The pipeline writer skips verified keys and the batch
    // field-merge honors them; without the stamp the next re-enrich clobbers
    // the fix (observed live on the Jetta, Jun 10).
    const verified = new Set(((engine as any).verified_fields ?? []) as string[]);
    const before = verified.size;
    if (args.timing_system !== undefined) verified.add("timing_system");
    if (args.cylinders !== undefined) verified.add("cylinders");
    if (args.coolant_capacity_qts !== undefined) verified.add("coolant_capacity_qts");
    if (args.oil_capacity_qts !== undefined) verified.add("oil_capacity_qts");
    if (args.engine_code !== undefined) verified.add("engine_code");

    if (Object.keys(patch).length === 0) {
      if (verified.size > before) {
        await ctx.db.patch(args.engine_id, { verified_fields: [...verified] } as any);
      }
      return { ok: true as const, changes: 0 };
    }
    (patch as any).verified_fields = [...verified];

    await ctx.db.patch(args.engine_id, patch as any);
    await ctx.db.insert("audit_log", {
      entity_type: "engine",
      entity_id: String(args.engine_id),
      action: "data_fix",
      actor: "CLI data fix",
      detail: `Engine data fix · ${changes.join(", ")} · reason: ${args.reason}`,
      created_at: Date.now(),
    });
    return { ok: true as const, changes: changes.length };
  },
});

/**
 * Delete marketplace-sourced part_prices rows (amazon/ebay/walmart/…). These
 * entered before the price path enforced MARKETPLACE_DOMAINS (Jul 2026: a
 * rear-brake-pad row held $31.78 from an Amazon FRONT-pad listing). Rows are
 * DELETED, not quarantined — a leftover row would hide the part from the
 * zero-price backfill (zeroPricePartsPage), blocking its clean reprice.
 *
 *   npx convex run devOnly/dataFixes:deleteMarketplacePrices \
 *     '{"dry_run":true,"reason":"audit"}'
 */
export const deleteMarketplacePrices = internalMutation({
  args: {
    dry_run: v.optional(v.boolean()),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const all = await ctx.db.query("part_prices").collect();
    const matches = all.filter(
      (row) => isMarketplaceDomain(row.source_domain) || isMarketplaceUrl(row.source_url),
    );

    const byDomain: Record<string, number> = {};
    for (const row of matches) {
      const d = row.source_domain ?? "unknown";
      byDomain[d] = (byDomain[d] ?? 0) + 1;
    }

    if (args.dry_run) {
      return {
        ok: true as const,
        dry_run: true,
        matched: matches.length,
        by_domain: byDomain,
        rows: matches.map((r) => ({
          part_id: String(r.part_id),
          price: r.price,
          source_domain: r.source_domain,
          source_url: r.source_url,
        })),
      };
    }

    for (const row of matches) {
      await ctx.db.delete(row._id);
    }
    if (matches.length > 0) {
      await ctx.db.insert("audit_log", {
        entity_type: "part_prices",
        entity_id: "bulk",
        action: "data_fix",
        actor: "CLI data fix",
        detail:
          `Deleted ${matches.length} marketplace-sourced part_prices rows · ` +
          Object.entries(byDomain).map(([d, n]) => `${d}: ${n}`).join(", ") +
          ` · reason: ${args.reason}`,
        created_at: Date.now(),
      });
    }
    return { ok: true as const, dry_run: false, deleted: matches.length, by_domain: byDomain };
  },
});

/**
 * Delete recently-written part_prices rows whose source URL does not contain
 * the part's OEM number. Used once after the Jul 2026 backfill wrote
 * wrong-product prices from search-discovered pages (an air-filter page
 * priced "engine oil" 19432331) before requireOemEcho landed. Bounded by
 * `since_ms` so long-standing LLM-cited rows (legitimately echo-less) are
 * untouched; deleted parts return to the zero-price pool and get re-priced
 * under the strict rule.
 *
 *   npx convex run devOnly/dataFixes:deletePricesWithoutUrlEcho \
 *     '{"since_ms":1783300000000,"dry_run":true,"reason":"audit"}'
 */
export const deletePricesWithoutUrlEcho = internalMutation({
  args: {
    since_ms: v.float64(),
    dry_run: v.optional(v.boolean()),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const all = await ctx.db.query("part_prices").collect();
    const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

    const matches: Array<{ row: any; oem: string }> = [];
    for (const row of all) {
      if ((row.refreshed_at ?? row.created_at ?? 0) < args.since_ms) continue;
      if (!row.source_url) continue;
      const part = await ctx.db.get(row.part_id);
      if (!part) continue;
      const oemNorm = norm(part.oem_part_number);
      if (oemNorm.length < 5) continue; // short numbers can't be URL-matched reliably
      if (norm(row.source_url).includes(oemNorm)) continue;
      matches.push({ row, oem: part.oem_part_number });
    }

    if (args.dry_run) {
      return {
        ok: true as const,
        dry_run: true,
        matched: matches.length,
        rows: matches.map((m) => ({
          oem: m.oem,
          price: m.row.price,
          source_domain: m.row.source_domain,
          source_url: m.row.source_url,
        })),
      };
    }

    for (const m of matches) {
      await ctx.db.delete(m.row._id);
    }
    if (matches.length > 0) {
      await ctx.db.insert("audit_log", {
        entity_type: "part_prices",
        entity_id: "bulk",
        action: "data_fix",
        actor: "CLI data fix",
        detail:
          `Deleted ${matches.length} part_prices rows without URL OEM echo (since ${new Date(args.since_ms).toISOString()}) · ` +
          `reason: ${args.reason}`,
        created_at: Date.now(),
      });
    }
    return { ok: true as const, dry_run: false, deleted: matches.length };
  },
});

/**
 * Surgically delete one part's price row(s) for a given source domain —
 * for confirmed wrong-product rows (verified by opening the page). The
 * nightly refresh can't self-heal these: it re-extracts from the same wrong
 * page and re-confirms it.
 *
 *   npx convex run devOnly/dataFixes:deletePartPriceForOem \
 *     '{"oem_part_number":"19432331","source_domain":"gmpartsgiant.com","reason":"..."}'
 */
export const deletePartPriceForOem = internalMutation({
  args: {
    oem_part_number: v.string(),
    source_domain: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const part = await ctx.db
      .query("oem_parts")
      .withIndex("by_part_number", (q) => q.eq("oem_part_number", args.oem_part_number))
      .first();
    if (!part) return { ok: false as const, reason: "part_not_found" };

    const rows = (
      await ctx.db
        .query("part_prices")
        .withIndex("by_part", (q) => q.eq("part_id", part._id))
        .collect()
    ).filter((r) => r.source_domain === args.source_domain);

    for (const r of rows) await ctx.db.delete(r._id);
    if (rows.length > 0) {
      await ctx.db.insert("audit_log", {
        entity_type: "part_prices",
        entity_id: String(part._id),
        action: "data_fix",
        actor: "CLI data fix",
        detail: `Deleted ${rows.length} price row(s) for ${args.oem_part_number} @ ${args.source_domain} · reason: ${args.reason}`,
        created_at: Date.now(),
      });
    }
    return { ok: true as const, deleted: rows.length };
  },
});

/**
 * Set services.requires_parts by slug — CLI-only flag fix with an audit row.
 *
 *   npx convex run devOnly/dataFixes:setServiceRequiresParts \
 *     '{"slug":"transmission_service","value":false,"reason":"..."}'
 */
export const setServiceRequiresParts = internalMutation({
  args: {
    slug: v.string(),
    value: v.boolean(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const svc = await ctx.db
      .query("services")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
    if (!svc) return { ok: false as const, reason: "service_not_found" };
    const before = (svc as any).requires_parts;
    if (before === args.value) return { ok: true as const, changes: 0 };
    await ctx.db.patch(svc._id, { requires_parts: args.value });
    await ctx.db.insert("audit_log", {
      entity_type: "service",
      entity_id: String(svc._id),
      action: "data_fix",
      actor: "CLI data fix",
      detail: `services.requires_parts (${args.slug}): ${before ?? "—"} → ${args.value} · reason: ${args.reason}`,
      created_at: Date.now(),
    });
    return { ok: true as const, changes: 1 };
  },
});

/**
 * Nulls out job_actuals.prejob_report.modifications rows that carry the
 * legacy shape {notes, status} from before the affected-systems model.
 * Those documents fail schema validation on push — run this once to unblock.
 *
 *   npx convex run devOnly/dataFixes:fixLegacyPrejobModifications
 */
export const fixLegacyPrejobModifications = internalMutation({
  args: { dry_run: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const dryRun = args.dry_run ?? false;
    const rows = (await ctx.db.query("job_actuals").collect()) as any[];
    let patched = 0;
    for (const row of rows) {
      const mods = row.prejob_report?.modifications;
      if (mods === null || mods === undefined) continue;
      // Legacy shape: had {notes, status} but NOT has_mods / affected_systems
      const isLegacy =
        !("has_mods" in mods) || !("affected_systems" in mods);
      if (!isLegacy) continue;
      if (!dryRun) {
        await ctx.db.patch(row._id, {
          prejob_report: { ...row.prejob_report, modifications: null },
        });
        await ctx.db.insert("audit_log", {
          entity_type: "job_actual",
          entity_id: String(row._id),
          action: "data_fix",
          actor: "CLI data fix",
          detail: `prejob_report.modifications: legacy {notes,status} shape → null (schema migration)`,
          created_at: Date.now(),
        });
      }
      patched++;
    }
    return { ok: true as const, dry_run: dryRun, patched };
  },
});

/**
 * Nulls out vehicle_passports.modifications rows that carry the legacy
 * {notes, status} shape from before the affected-systems model.
 *
 *   npx convex run devOnly/dataFixes:fixLegacyPassportModifications
 */
export const fixLegacyPassportModifications = internalMutation({
  args: { dry_run: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const dryRun = args.dry_run ?? false;
    const rows = (await ctx.db.query("vehicle_passports").collect()) as any[];
    let patched = 0;
    for (const row of rows) {
      const mods = row.modifications;
      if (mods === null || mods === undefined) continue;
      const isLegacy = !("has_mods" in mods) || !("affected_systems" in mods);
      if (!isLegacy) continue;
      if (!dryRun) {
        await ctx.db.patch(row._id, { modifications: undefined });
        await ctx.db.insert("audit_log", {
          entity_type: "vehicle_passport",
          entity_id: String(row._id),
          action: "data_fix",
          actor: "CLI data fix",
          detail: `modifications: legacy {notes,status} shape → undefined (schema migration)`,
          created_at: Date.now(),
        });
      }
      patched++;
    }
    return { ok: true as const, dry_run: dryRun, patched };
  },
});

/**
 * Re-tier BMW configs mis-stamped `T3b` by the old part5_seed, which put the
 * full M-cars (M2/M3/M4/M5/M8 + X3 M…X6 M) into T3b — contradicting both the
 * trim-aware ASSIGNMENT_RULES AND the canonical tier labels (T3a = "Performance
 * — BMW M, AMG, Audi RS/S"; T3b = "911, Cayman, AMG GT, R8"). Under the
 * reconciled model NO BMW is T3b, so any BMW currently at T3b is a mis-stamp.
 * Recompute each via the trim-aware rules: base M → T3a, CS/CSL/Competition
 * flagships → T4. Scoping on `pricing_tier === "T3b"` keeps this surgical —
 * correctly-tiered BMWs (T2c/T3a/T4) are never touched, so a right rule that
 * happens not to re-match (e.g. an M-Performance trim) can't regress them.
 *
 * The live symptom this fixes: a 2022 M3 Competition stamped T3b was quoted a
 * whole band high ($275/hr) and tripped LABOR_COST_TIER_MISMATCH at booking.
 *
 * Preserves manual overrides. Dry-run first. Run per deployment.
 *   npx convex run devOnly/dataFixes:retierBmwMCars '{"dry_run":true}'
 *   npx convex run devOnly/dataFixes:retierBmwMCars
 */
export const retierBmwMCars = internalMutation({
  args: { dry_run: v.optional(v.boolean()), force_manual: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const dryRun = args.dry_run ?? false;
    const now = Date.now();
    const configs = (await ctx.db.query("vehicle_configs").collect()) as any[];
    const changes: any[] = [];
    let skippedManual = 0;
    let unresolved = 0;

    for (const cfg of configs) {
      if (cfg.pricing_tier !== "T3b") continue;
      const make = cfg.make_id ? ((await ctx.db.get(cfg.make_id)) as any) : null;
      if (!make || String(make.name ?? "").toLowerCase() !== "bmw") continue;
      if (cfg.pricing_tier_source === "manual" && !args.force_manual) {
        skippedManual++;
        continue;
      }
      const model = cfg.model_id ? ((await ctx.db.get(cfg.model_id)) as any) : null;
      const matchCtx = {
        make: make.name as string,
        model: (model?.name ?? "") as string,
        trim: (cfg.trim_name ?? "") as string,
        year: cfg.year as number,
      };
      let matched: VehicleTier | null = null;
      for (const rule of ASSIGNMENT_RULES) {
        if (matchRule(rule, matchCtx)) {
          matched = rule.tier;
          break;
        }
      }
      // No rule matched, or the rules somehow still say T3b — don't guess.
      if (!matched || matched === "T3b") {
        unresolved++;
        continue;
      }
      changes.push({
        config_key: cfg.config_key,
        model: matchCtx.model,
        trim: matchCtx.trim,
        from: "T3b",
        to: matched,
      });
      if (!dryRun) {
        await ctx.db.patch(cfg._id, {
          pricing_tier: matched,
          pricing_tier_source: "rules_engine",
          pricing_tier_set_at: now,
        });
        await ctx.db.insert("audit_log", {
          entity_type: "vehicle_config",
          entity_id: String(cfg._id),
          action: "data_fix",
          actor: "CLI data fix",
          detail:
            `pricing_tier: T3b → ${matched} (BMW M-car re-tier via trim-aware ` +
            `ASSIGNMENT_RULES; model="${matchCtx.model}" trim="${matchCtx.trim}")`,
          created_at: now,
        });
      }
    }
    return {
      ok: true as const,
      dry_run: dryRun,
      retiered: changes.length,
      skippedManual,
      unresolved,
      changes,
    };
  },
});
