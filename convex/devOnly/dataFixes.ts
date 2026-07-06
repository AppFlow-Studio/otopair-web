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
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const engine = await ctx.db.get(args.engine_id);
    if (!engine) return { ok: false as const, reason: "engine_not_found" };

    const patch: Record<string, unknown> = {};
    const changes: string[] = [];
    const tryPatch = (key: "timing_system" | "cylinders", nextVal: unknown) => {
      if (nextVal === undefined) return;
      const cur = (engine as any)[key];
      if (cur === nextVal) return;
      patch[key] = nextVal;
      changes.push(`${key}: ${cur ?? "—"} → ${nextVal}`);
    };
    tryPatch("timing_system", args.timing_system);
    tryPatch("cylinders", args.cylinders);

    // Stamp every PROVIDED field as human-verified — including ones whose
    // stored value already matched (confirming a value is itself a
    // verification). The pipeline writer skips verified keys and the batch
    // field-merge honors them; without the stamp the next re-enrich clobbers
    // the fix (observed live on the Jetta, Jun 10).
    const verified = new Set(((engine as any).verified_fields ?? []) as string[]);
    const before = verified.size;
    if (args.timing_system !== undefined) verified.add("timing_system");
    if (args.cylinders !== undefined) verified.add("cylinders");

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
