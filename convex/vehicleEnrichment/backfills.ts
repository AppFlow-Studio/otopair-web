/**
 * vehicleEnrichment/backfills.ts — One-time corpus backfills.
 *
 * backfillPartPrices: re-prices already-enriched parts whose part_prices rows
 * hold the old wrong (discount / "You Save" / mis-associated) value.
 *
 * Strategy — keyed off the source_url already stored on each price row (no
 * make/model joins needed):
 *   1. page through oem_parts;
 *   2. for each part, re-fetch the distinct source URLs on its price rows and run
 *      the deterministic parser;
 *   3. write the correct price (price_type 'sale') for any URL whose JSON-LD
 *      contains THIS part's exact OEM number — possibly several sources;
 *   4. ONLY THEN prune the part's legacy poison rows (source_domain 'enrichment'
 *      OR price_type 'online_discount'/'you_save'), snapshotting each into
 *      price_backfill_log first (reversible). A part whose correct page can't be
 *      re-derived (e.g. a rotor mis-stored under a brake-pads URL) keeps its old
 *      row rather than being left priceless.
 *
 * Idempotent: upsertPartPrice dedups by (part_id, source_domain); prune is
 * conditional on a fresh 'sale' row existing. Safe to re-run.
 *
 * Live runs require BACKFILL_PARTS_PRICES=on. Default is dryRun (reports only).
 *   npx convex run vehicleEnrichment/backfills:backfillPartPrices '{"dryRun":true,"selfContinue":false,"limit":20}'
 */

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { fetchUrlWithHtml } from "./firecrawl";
import { parsePartPrices, normalizeOemNumber } from "./priceParser";
import { LABOR_ONLY_SLUGS, roleForSubcategory } from "../lib/servicePartsReference";

const LEGACY_PRICE_TYPES = new Set(["online_discount", "you_save"]);
const LEGACY_DOMAINS = new Set(["enrichment"]);
// Current-format rows the NEW pipeline writes — NEVER prune these, even though
// the llm_estimate fallback can land under the synthetic 'enrichment' domain.
const CURRENT_PRICE_TYPES = new Set(["sale", "llm_estimate"]);

function isLegacyPriceRow(row: { source_domain?: string; price_type?: string }): boolean {
  // A correct current-format price (deterministic 'sale' or tagged 'llm_estimate')
  // is never legacy, regardless of source_domain.
  if (row.price_type != null && CURRENT_PRICE_TYPES.has(row.price_type)) return false;
  return (
    (row.source_domain != null && LEGACY_DOMAINS.has(row.source_domain)) ||
    (row.price_type != null && LEGACY_PRICE_TYPES.has(row.price_type))
  );
}

/** One page of oem_parts with the distinct re-fetchable URLs on their price rows. */
export const _oemPartsPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), limit: v.number() },
  handler: async (ctx, { cursor, limit }) => {
    const res = await ctx.db.query("oem_parts").paginate({ cursor, numItems: limit });
    const items = [];
    for (const part of res.page) {
      const prices = await ctx.db
        .query("part_prices")
        .withIndex("by_part", (q) => q.eq("part_id", part._id))
        .collect();
      const urls = [
        ...new Set(
          prices
            .map((p) => p.source_url)
            .filter((u): u is string => !!u && /^https?:\/\//i.test(u)),
        ),
      ];
      const hasLegacy = prices.some(isLegacyPriceRow);
      items.push({ partId: part._id, oemNumber: part.oem_part_number, urls, hasLegacy });
    }
    return { items, isDone: res.isDone, cursor: res.continueCursor };
  },
});

/** Snapshot + delete a part's legacy poison rows. Returns the count pruned. */
export const _pruneAndLogLegacy = internalMutation({
  args: { partId: v.id("oem_parts"), batch: v.string() },
  handler: async (ctx, { partId, batch }) => {
    const rows = await ctx.db
      .query("part_prices")
      .withIndex("by_part", (q) => q.eq("part_id", partId))
      .collect();
    let pruned = 0;
    for (const r of rows) {
      if (!isLegacyPriceRow(r)) continue;
      await ctx.db.insert("price_backfill_log", {
        part_id: partId,
        deleted_row: r,
        batch,
        deleted_at: Date.now(),
      });
      await ctx.db.delete(r._id);
      pruned++;
    }
    return pruned;
  },
});

type BackfillSummary = {
  batch: string;
  dryRun: boolean;
  partsScanned: number;
  repricedParts: number;
  saleWrites: number;
  prunedParts: number;
  isDone: boolean;
  nextCursor: string;
  samples: Array<{ oem: string; found: string[] }>;
};

export const backfillPartPrices = internalAction({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
    selfContinue: v.optional(v.boolean()),
    batch: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<BackfillSummary> => {
    const dryRun = args.dryRun ?? true;
    if (!dryRun && process.env.BACKFILL_PARTS_PRICES !== "on") {
      throw new Error(
        "Live backfill disabled. Set BACKFILL_PARTS_PRICES=on, or pass dryRun:true.",
      );
    }
    const limit = args.limit ?? 25;
    const selfContinue = args.selfContinue ?? true;
    const batch = args.batch ?? `bf_${Date.now()}`;

    const page = await ctx.runQuery(internal.vehicleEnrichment.backfills._oemPartsPage, {
      cursor: args.cursor ?? null,
      limit,
    });

    // Memoize page fetches across this batch so a shared catalog page (many
    // parts) is only fetched once.
    const fetchMemo = new Map<string, Map<string, { price: number; domain: string; url: string }>>();
    let repricedParts = 0;
    let saleWrites = 0;
    let prunedParts = 0;
    const samples: Array<{ oem: string; found: string[] }> = [];

    for (const item of page.items) {
      if (!item.hasLegacy || item.urls.length === 0) continue;
      const norm = normalizeOemNumber(item.oemNumber);

      const hits: Array<{ price: number; domain: string; url: string }> = [];
      for (const url of item.urls) {
        let parsedMap = fetchMemo.get(url);
        if (!parsedMap) {
          parsedMap = new Map();
          try {
            const { html } = await fetchUrlWithHtml(url);
            if (html) {
              for (const p of parsePartPrices(html, url)) {
                parsedMap.set(p.oem_part_number, {
                  price: p.price,
                  domain: p.source_domain,
                  url: p.source_url,
                });
              }
            }
          } catch (e) {
            console.warn(`[backfill] fetch/parse failed for ${url}:`, e);
          }
          fetchMemo.set(url, parsedMap);
        }
        const hit = parsedMap.get(norm);
        if (hit) hits.push(hit);
      }

      if (hits.length === 0) continue; // no correct source — leave legacy row intact
      repricedParts++;
      if (samples.length < 12) {
        samples.push({ oem: item.oemNumber, found: hits.map((h) => `$${h.price}@${h.domain}`) });
      }

      if (!dryRun) {
        for (const h of hits) {
          await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertPartPrice, {
            part_id: item.partId,
            price: h.price,
            price_type: "sale",
            source_url: h.url,
            source_domain: h.domain,
          });
          saleWrites++;
        }
        const pruned = await ctx.runMutation(
          internal.vehicleEnrichment.backfills._pruneAndLogLegacy,
          { partId: item.partId, batch },
        );
        if (pruned > 0) prunedParts++;
      }
    }

    const summary = {
      batch,
      dryRun,
      partsScanned: page.items.length,
      repricedParts,
      saleWrites,
      prunedParts,
      isDone: page.isDone,
      nextCursor: page.cursor,
      samples,
    };
    console.log(`[backfill] ${JSON.stringify({ ...summary, samples: samples.length })}`);

    if (selfContinue && !page.isDone) {
      await ctx.scheduler.runAfter(2000, internal.vehicleEnrichment.backfills.backfillPartPrices, {
        cursor: page.cursor,
        limit,
        dryRun,
        selfContinue,
        batch,
      });
    }
    return summary;
  },
});

// ════════════════════════════════════════════════════════════════════════════
// Service Parts Reference corpus backfills (SERVICE_PARTS_REFERENCE_DESIGN.md §6)
//
// All paginate part_fitments, follow the dry-run→live + flag-gate + reversible-
// log pattern above, and reuse price_backfill_log (distinct `batch` prefix per
// sweep; the fitment's part_id goes in part_id, the full fitment row in
// deleted_row). Deletes/patches are batched per page; the action self-continues.
// ════════════════════════════════════════════════════════════════════════════

const FITMENT_PAGE_LIMIT = 200;

/** One page of part_fitments, with each row's part hydrated (null when the
 *  referenced oem_parts doc was deleted — those are orphans). */
export const _fitmentsPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), limit: v.number() },
  handler: async (ctx, { cursor, limit }) => {
    const res = await ctx.db.query("part_fitments").paginate({ cursor, numItems: limit });
    const items = [];
    for (const fitment of res.page) {
      const part = await ctx.db.get(fitment.part_id);
      items.push({
        fitment,
        partExists: part !== null,
        subcategory: part?.subcategory ?? null,
        category: part?.category ?? null,
      });
    }
    return { items, isDone: res.isDone, cursor: res.continueCursor };
  },
});

// ── 1. Orphan fitments — delete fitments whose oem_parts doc is gone ──────────

/** Snapshot + delete one orphan fitment (its part_id is dangling). Returns 1
 *  when deleted, 0 when the part turned out to exist (lost a race). */
export const _deleteOrphanFitment = internalMutation({
  args: { fitmentId: v.id("part_fitments"), batch: v.string() },
  handler: async (ctx, { fitmentId, batch }) => {
    const fitment = await ctx.db.get(fitmentId);
    if (!fitment) return 0;
    const part = await ctx.db.get(fitment.part_id);
    if (part !== null) return 0; // no longer orphan — leave intact
    await ctx.db.insert("price_backfill_log", {
      part_id: fitment.part_id,
      deleted_row: fitment,
      batch,
      deleted_at: Date.now(),
    });
    await ctx.db.delete(fitmentId);
    return 1;
  },
});

type OrphanSummary = {
  batch: string;
  dryRun: boolean;
  fitmentsScanned: number;
  orphansFound: number;
  orphansDeleted: number;
  isDone: boolean;
  nextCursor: string;
};

export const backfillDeleteOrphanFitments = internalAction({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
    selfContinue: v.optional(v.boolean()),
    batch: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<OrphanSummary> => {
    const dryRun = args.dryRun ?? true;
    if (!dryRun && process.env.BACKFILL_ORPHAN_FITMENTS !== "on") {
      throw new Error(
        "Live backfill disabled. Set BACKFILL_ORPHAN_FITMENTS=on, or pass dryRun:true.",
      );
    }
    const limit = args.limit ?? FITMENT_PAGE_LIMIT;
    const selfContinue = args.selfContinue ?? true;
    const batch = args.batch ?? `orphan_fitments_${dryRun ? "dryrun" : "live"}`;

    const page = await ctx.runQuery(internal.vehicleEnrichment.backfills._fitmentsPage, {
      cursor: args.cursor ?? null,
      limit,
    });

    let orphansFound = 0;
    let orphansDeleted = 0;
    for (const item of page.items) {
      if (item.partExists) continue;
      orphansFound++;
      if (!dryRun) {
        orphansDeleted += await ctx.runMutation(
          internal.vehicleEnrichment.backfills._deleteOrphanFitment,
          { fitmentId: item.fitment._id, batch },
        );
      }
    }

    const summary = {
      batch,
      dryRun,
      fitmentsScanned: page.items.length,
      orphansFound,
      orphansDeleted,
      isDone: page.isDone,
      nextCursor: page.cursor,
    };
    console.log(`[backfill:orphan] ${JSON.stringify(summary)}`);

    if (selfContinue && !page.isDone) {
      await ctx.scheduler.runAfter(
        1000,
        internal.vehicleEnrichment.backfills.backfillDeleteOrphanFitments,
        { cursor: page.cursor, limit, dryRun, selfContinue, batch },
      );
    }
    return summary;
  },
});

// ── 2. Stamp service_role from the canonical reference ───────────────────────

/** Patch one fitment's service_role. Idempotent: re-resolves and re-patches the
 *  same value. Returns 1 when patched, 0 when the role couldn't be resolved. */
export const _stampServiceRole = internalMutation({
  args: { fitmentId: v.id("part_fitments"), serviceRole: v.string() },
  handler: async (ctx, { fitmentId, serviceRole }) => {
    const fitment = await ctx.db.get(fitmentId);
    if (!fitment) return 0;
    await ctx.db.patch(fitmentId, { service_role: serviceRole });
    return 1;
  },
});

type StampSummary = {
  batch: string;
  dryRun: boolean;
  fitmentsScanned: number;
  alreadyStamped: number;
  resolved: number;
  unresolved: number;
  patched: number;
  byRole: Record<string, number>;
  isDone: boolean;
  nextCursor: string;
};

export const backfillStampServiceRoles = internalAction({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
    selfContinue: v.optional(v.boolean()),
    batch: v.optional(v.string()),
    // Counts accumulate across self-continued pages for a single readable total.
    byRole: v.optional(v.record(v.string(), v.number())),
  },
  handler: async (ctx, args): Promise<StampSummary> => {
    const dryRun = args.dryRun ?? true;
    if (!dryRun && process.env.BACKFILL_SERVICE_ROLES !== "on") {
      throw new Error(
        "Live backfill disabled. Set BACKFILL_SERVICE_ROLES=on, or pass dryRun:true.",
      );
    }
    const limit = args.limit ?? FITMENT_PAGE_LIMIT;
    const selfContinue = args.selfContinue ?? true;
    const batch = args.batch ?? `service_roles_${dryRun ? "dryrun" : "live"}`;
    const byRole: Record<string, number> = { ...(args.byRole ?? {}) };

    const page = await ctx.runQuery(internal.vehicleEnrichment.backfills._fitmentsPage, {
      cursor: args.cursor ?? null,
      limit,
    });

    let alreadyStamped = 0;
    let resolved = 0;
    let unresolved = 0;
    let patched = 0;
    for (const item of page.items) {
      const { fitment } = item;
      if (fitment.service_role != null) {
        alreadyStamped++;
        continue;
      }
      const role = roleForSubcategory(
        fitment.service_type ?? "",
        item.subcategory,
        item.category,
      );
      if (!role) {
        unresolved++;
        continue;
      }
      resolved++;
      // Report counts per (service_type, roleKey) so the dry run shows exactly
      // what would be stamped where.
      const key = `${fitment.service_type ?? "?"}::${role.roleKey}=${role.serviceRole}`;
      byRole[key] = (byRole[key] ?? 0) + 1;
      if (!dryRun) {
        patched += await ctx.runMutation(
          internal.vehicleEnrichment.backfills._stampServiceRole,
          { fitmentId: fitment._id, serviceRole: role.serviceRole },
        );
      }
    }

    const summary = {
      batch,
      dryRun,
      fitmentsScanned: page.items.length,
      alreadyStamped,
      resolved,
      unresolved,
      patched,
      byRole,
      isDone: page.isDone,
      nextCursor: page.cursor,
    };
    console.log(
      `[backfill:roles] ${JSON.stringify({ ...summary, byRole: Object.keys(byRole).length })}`,
    );

    if (selfContinue && !page.isDone) {
      await ctx.scheduler.runAfter(
        1000,
        internal.vehicleEnrichment.backfills.backfillStampServiceRoles,
        { cursor: page.cursor, limit, dryRun, selfContinue, batch, byRole },
      );
    }
    return summary;
  },
});

// ── 3. Fix malformed positions ("Front, LEFT, RIGHT" → "front") ──────────────

/** Lowercased first axle token of a comma-bearing position, or null when no
 *  recognizable front/rear axle token leads the string. */
function firstAxleToken(position: string): string | null {
  const first = position.split(",")[0]?.trim().toLowerCase() ?? "";
  if (first === "front" || first === "rear") return first;
  return null;
}

export const _fixFitmentPosition = internalMutation({
  args: { fitmentId: v.id("part_fitments"), position: v.string() },
  handler: async (ctx, { fitmentId, position }) => {
    const fitment = await ctx.db.get(fitmentId);
    if (!fitment) return 0;
    await ctx.db.patch(fitmentId, { position });
    return 1;
  },
});

type PositionSummary = {
  batch: string;
  dryRun: boolean;
  fitmentsScanned: number;
  malformedFound: number;
  patched: number;
  byFix: Record<string, number>;
  isDone: boolean;
  nextCursor: string;
};

export const backfillFixMalformedPositions = internalAction({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
    selfContinue: v.optional(v.boolean()),
    batch: v.optional(v.string()),
    byFix: v.optional(v.record(v.string(), v.number())),
  },
  handler: async (ctx, args): Promise<PositionSummary> => {
    const dryRun = args.dryRun ?? true;
    if (!dryRun && process.env.BACKFILL_FIX_POSITIONS !== "on") {
      throw new Error(
        "Live backfill disabled. Set BACKFILL_FIX_POSITIONS=on, or pass dryRun:true.",
      );
    }
    const limit = args.limit ?? FITMENT_PAGE_LIMIT;
    const selfContinue = args.selfContinue ?? true;
    const batch = args.batch ?? `fix_positions_${dryRun ? "dryrun" : "live"}`;
    const byFix: Record<string, number> = { ...(args.byFix ?? {}) };

    const page = await ctx.runQuery(internal.vehicleEnrichment.backfills._fitmentsPage, {
      cursor: args.cursor ?? null,
      limit,
    });

    let malformedFound = 0;
    let patched = 0;
    for (const item of page.items) {
      const pos = item.fitment.position;
      if (pos == null || !pos.includes(",")) continue;
      const fixed = firstAxleToken(pos);
      if (!fixed) continue; // no clean axle token to recover — leave untouched
      malformedFound++;
      const key = `${pos} → ${fixed}`;
      byFix[key] = (byFix[key] ?? 0) + 1;
      if (!dryRun) {
        patched += await ctx.runMutation(
          internal.vehicleEnrichment.backfills._fixFitmentPosition,
          { fitmentId: item.fitment._id, position: fixed },
        );
      }
    }

    const summary = {
      batch,
      dryRun,
      fitmentsScanned: page.items.length,
      malformedFound,
      patched,
      byFix,
      isDone: page.isDone,
      nextCursor: page.cursor,
    };
    console.log(`[backfill:positions] ${JSON.stringify(summary)}`);

    if (selfContinue && !page.isDone) {
      await ctx.scheduler.runAfter(
        1000,
        internal.vehicleEnrichment.backfills.backfillFixMalformedPositions,
        { cursor: page.cursor, limit, dryRun, selfContinue, batch, byFix },
      );
    }
    return summary;
  },
});

// ── 4. Sweep stray labor-only fitments (currently zero — invariant insurance) ─

/** Snapshot + delete one fitment whose service_type is labor-only. */
export const _deleteLaborOnlyFitment = internalMutation({
  args: { fitmentId: v.id("part_fitments"), batch: v.string() },
  handler: async (ctx, { fitmentId, batch }) => {
    const fitment = await ctx.db.get(fitmentId);
    if (!fitment) return 0;
    await ctx.db.insert("price_backfill_log", {
      part_id: fitment.part_id,
      deleted_row: fitment,
      batch,
      deleted_at: Date.now(),
    });
    await ctx.db.delete(fitmentId);
    return 1;
  },
});

type LaborOnlySummary = {
  batch: string;
  dryRun: boolean;
  fitmentsScanned: number;
  strayFound: number;
  deleted: number;
  byService: Record<string, number>;
  isDone: boolean;
  nextCursor: string;
};

export const backfillSweepLaborOnlyFitments = internalAction({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
    selfContinue: v.optional(v.boolean()),
    batch: v.optional(v.string()),
    byService: v.optional(v.record(v.string(), v.number())),
  },
  handler: async (ctx, args): Promise<LaborOnlySummary> => {
    const dryRun = args.dryRun ?? true;
    if (!dryRun && process.env.BACKFILL_LABOR_ONLY_SWEEP !== "on") {
      throw new Error(
        "Live backfill disabled. Set BACKFILL_LABOR_ONLY_SWEEP=on, or pass dryRun:true.",
      );
    }
    const limit = args.limit ?? FITMENT_PAGE_LIMIT;
    const selfContinue = args.selfContinue ?? true;
    const batch = args.batch ?? "labor_only_sweep";
    const byService: Record<string, number> = { ...(args.byService ?? {}) };

    const page = await ctx.runQuery(internal.vehicleEnrichment.backfills._fitmentsPage, {
      cursor: args.cursor ?? null,
      limit,
    });

    let strayFound = 0;
    let deleted = 0;
    for (const item of page.items) {
      const svc = item.fitment.service_type;
      if (svc == null || !LABOR_ONLY_SLUGS.has(svc)) continue;
      strayFound++;
      byService[svc] = (byService[svc] ?? 0) + 1;
      if (!dryRun) {
        deleted += await ctx.runMutation(
          internal.vehicleEnrichment.backfills._deleteLaborOnlyFitment,
          { fitmentId: item.fitment._id, batch },
        );
      }
    }

    const summary = {
      batch,
      dryRun,
      fitmentsScanned: page.items.length,
      strayFound,
      deleted,
      byService,
      isDone: page.isDone,
      nextCursor: page.cursor,
    };
    console.log(`[backfill:labor-only] ${JSON.stringify(summary)}`);

    if (selfContinue && !page.isDone) {
      await ctx.scheduler.runAfter(
        1000,
        internal.vehicleEnrichment.backfills.backfillSweepLaborOnlyFitments,
        { cursor: page.cursor, limit, dryRun, selfContinue, batch, byService },
      );
    }
    return summary;
  },
});

// ---------------------------------------------------------------------------
// migrateRotorObservedLabelPerAxle — one-shot (2026-07-29, audit G4).
//
// The shared rotor_min_observed_label column let a front label vouch for a
// rear value. New writes are per-axle; this migrates existing rows:
//   - exactly one PIPELINE-quality axle has a minimum → label describes it;
//     copy to that axle's column.
//   - both axles have minimums → provenance is unrecoverable (the writer took
//     front ?? rear); copy to BOTH and audit-log the ambiguity for review.
//   - human-quality axles are never touched.
// The legacy column is kept (read fallback) until a later cleanup.
// Idempotent: rows with a per-axle label already set are skipped.
//   npx convex run vehicleEnrichment/backfills:migrateRotorObservedLabelPerAxle '{}'
// ---------------------------------------------------------------------------

const HUMAN_ROTOR_QUALITIES = new Set(["mechanic_read", "director_verified"]);

export const migrateRotorObservedLabelPerAxle = internalMutation({
  args: { cursor: v.optional(v.string()), pageSize: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("vehicle_configs")
      .paginate({ cursor: args.cursor ?? null, numItems: args.pageSize ?? 200 });

    let migrated = 0;
    let ambiguous = 0;
    for (const cfg of page.page) {
      const legacy = cfg.rotor_min_observed_label;
      if (!legacy) continue;
      if (cfg.rotor_front_min_observed_label || cfg.rotor_rear_min_observed_label) continue;

      const frontPipeline =
        cfg.rotor_front_min_thickness_mm != null &&
        !HUMAN_ROTOR_QUALITIES.has(cfg.rotor_front_min_quality ?? "");
      const rearPipeline =
        cfg.rotor_rear_min_thickness_mm != null &&
        !HUMAN_ROTOR_QUALITIES.has(cfg.rotor_rear_min_quality ?? "");

      if (frontPipeline && rearPipeline) {
        await ctx.db.patch(cfg._id, {
          rotor_front_min_observed_label: legacy,
          rotor_rear_min_observed_label: legacy,
        });
        await ctx.db.insert("audit_log", {
          entity_type: "vehicle_config",
          entity_id: String(cfg._id),
          action: "rotor_label_migration_ambiguous",
          actor: "system",
          detail:
            `Shared rotor label "${legacy}" copied to BOTH axles — original provenance ` +
            `unrecoverable (writer stored front ?? rear). Review if the axles disagree.`,
          created_at: Date.now(),
        });
        ambiguous++;
        migrated++;
      } else if (frontPipeline) {
        await ctx.db.patch(cfg._id, { rotor_front_min_observed_label: legacy });
        migrated++;
      } else if (rearPipeline) {
        await ctx.db.patch(cfg._id, { rotor_rear_min_observed_label: legacy });
        migrated++;
      }
    }

    return {
      migrated,
      ambiguous,
      isDone: page.isDone,
      continueCursor: page.isDone ? null : page.continueCursor,
    };
  },
});
