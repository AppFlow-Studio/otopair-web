/**
 * vehicleEnrichment/fitmentQuarantine.ts — ONE-TIME cleanup sweep.
 *
 * Two corpus problems, one file:
 *
 *  1. CROSS-MAKE FITMENT CONTAMINATION — the chassis/engine sibling-clone path
 *     copied make-stamped parts onto configs of a DIFFERENT make (e.g. a Ford
 *     brake pad fitted to an Alfa Romeo Stelvio). `scanCrossMakeFitments`
 *     detects these two ways and QUARANTINES the fitment row (patches
 *     data_quality:"cross_make_quarantined") — it never deletes, and it never
 *     touches the part row, because the part itself is valid for its OWN make:
 *       A. make-id mismatch: !partFitsConfigMake(part.make_id, config.make_id)
 *          (the same pure guard the 7-layer selector applies at read time).
 *       B. foreign brand signature: the part number matches another
 *          manufacturer family's format (matchesForeignBrandSignature) even
 *          though the part was STAMPED with this config's own make_id — e.g.
 *          Motorcraft "BXT-94RH7-730" written as an Alfa Romeo part, which
 *          detector A can't see because the ids agree.
 *     Mechanic-verified fitments are NEVER quarantined (a human signed off);
 *     they are reported separately as `verified_skipped` for manual triage.
 *
 *  2. FORMATTING-DUPLICATE oem_parts — "5Q0 698 451 A" and "5Q0698451A" landed
 *     as two rows before normalized upserts existed. `dedupeNormalizedParts`
 *     merges each group into the earliest-created canonical row: fitments and
 *     prices are repointed (or deleted when the canonical already has the
 *     equivalent row), and the duplicate part row is kept for audit with
 *     { is_current:false, superseded_by, data_quality:"merged_duplicate" }.
 *
 * Both mutations paginate (default ~200/100 rows per transaction) so a single
 * mutation never approaches the Convex per-transaction read/write ceilings.
 * `runQuarantineScan` is the driver action that loops both to completion —
 * each page runs in its OWN runMutation call (own transaction), which is what
 * keeps the sweep within mutation size limits on a large corpus.
 *
 * Everything here is internal-only; nothing is exposed to clients.
 *
 * Usage (dry run first — counts only, zero writes):
 *   npx convex run vehicleEnrichment/fitmentQuarantine:runQuarantineScan '{"dryRun":true}'
 * Then live:
 *   npx convex run vehicleEnrichment/fitmentQuarantine:runQuarantineScan '{"dryRun":false}'
 * Post-run check:
 *   npx convex run vehicleEnrichment/fitmentQuarantine:quarantineReport '{}'
 */

import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { Doc, Id } from "../_generated/dataModel";
import { partFitsConfigMake } from "../partSelector";
import { matchesForeignBrandSignature, makesSameFamily } from "./contentSanitization";
import { normalizeOemNumber } from "./priceParser";

/** data_quality value stamped on quarantined fitments — the read-time make
 *  guard already drops these parts from selection; the stamp makes the
 *  contamination queryable/reversible instead of only implicit. */
export const QUARANTINED_QUALITY = "cross_make_quarantined";
const MERGED_QUALITY = "merged_duplicate";

const SCAN_BATCH_DEFAULT = 200;
// Dedupe pages are smaller: each duplicate fans out into fitment + price index
// reads and per-row patches, so the per-transaction cost per part is higher.
const DEDUPE_BATCH_DEFAULT = 100;

// ---------------------------------------------------------------------------
// 1. scanCrossMakeFitments — one page of part_fitments, detect + quarantine
// ---------------------------------------------------------------------------

type ScanExample = {
  fitmentId: string;
  partNumber: string;
  partMake: string;
  configMake: string;
  detector: "A" | "B";
};

type ScanPageSummary = {
  scanned: number;
  contaminatedA: number;
  contaminatedB: number;
  quarantined: number;
  verified_skipped: number;
  family_shared_skipped: number;
  byMakePair: Record<string, number>;
  examples: ScanExample[];
  continueCursor: string;
  isDone: boolean;
};

export const scanCrossMakeFitments = internalMutation({
  args: {
    dryRun: v.boolean(),
    cursor: v.optional(v.string()),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<ScanPageSummary> => {
    const numItems = args.batchSize ?? SCAN_BATCH_DEFAULT;
    const res = await ctx.db
      .query("part_fitments")
      .paginate({ cursor: args.cursor ?? null, numItems });

    // Memoize make-name lookups — the makes table is tiny but each page can
    // reference the same handful of makes hundreds of times.
    const makeNameCache = new Map<string, string>();
    const makeName = async (
      makeId: Id<"makes"> | null | undefined,
    ): Promise<string> => {
      if (makeId == null) return "(none)";
      const key = String(makeId);
      const hit = makeNameCache.get(key);
      if (hit !== undefined) return hit;
      const make = await ctx.db.get(makeId);
      const name = (make?.name ?? key).toLowerCase();
      makeNameCache.set(key, name);
      return name;
    };

    let contaminatedA = 0;
    let contaminatedB = 0;
    let quarantined = 0;
    let verified_skipped = 0;
    let family_shared_skipped = 0;
    const byMakePair: Record<string, number> = {};
    const examples: ScanExample[] = [];

    for (const fitment of res.page) {
      const part = await ctx.db.get(fitment.part_id);
      if (!part) continue; // orphan fitment — the orphan sweep in backfills.ts owns those
      const config = await ctx.db.get(fitment.vehicle_config_id);
      if (!config) continue; // dangling config ref — nothing to compare against
      const configMake = await makeName(config.make_id);

      // Detector A: make-id disagreement. Detector B only runs when A passes —
      // B exists to catch rows A is BLIND to (foreign-format number stamped
      // with the config's own make_id, so the ids agree).
      let detector: "A" | "B" | null = null;
      let pairKey: string | null = null;
      if (!partFitsConfigMake(part.make_id, config.make_id)) {
        const partMake = await makeName(part.make_id);
        // Corporate siblings (audi↔vw, jeep↔alfa romeo) genuinely share OEM
        // catalogs — the make_id stamp just records which vehicle was
        // enriched first. NOT contamination; never quarantine (Jul 2026
        // dry-run: 87 audi→vw shared-platform rows vs 27 true ford→alfa).
        if (makesSameFamily(partMake, configMake)) {
          family_shared_skipped++;
          byMakePair[`family:${partMake}->${configMake}`] =
            (byMakePair[`family:${partMake}->${configMake}`] ?? 0) + 1;
          continue;
        }
        detector = "A";
        pairKey = `${partMake}->${configMake}`;
      } else {
        const sig = matchesForeignBrandSignature(part.oem_part_number, configMake);
        if (sig !== null) {
          detector = "B";
          pairKey = `sig:${sig}->${configMake}`;
        }
      }
      if (detector === null) continue;

      // A mechanic explicitly verified this fitment — a human beats both
      // heuristics, so never auto-quarantine; surface for manual review.
      if (fitment.mechanic_verified === true) {
        verified_skipped++;
        continue;
      }

      if (detector === "A") contaminatedA++;
      else contaminatedB++;
      byMakePair[pairKey!] = (byMakePair[pairKey!] ?? 0) + 1;
      if (examples.length < 20) {
        examples.push({
          fitmentId: String(fitment._id),
          partNumber: part.oem_part_number,
          partMake: await makeName(part.make_id),
          configMake,
          detector,
        });
      }

      if (!args.dryRun) {
        // Quarantine, don't delete: the stamp is reversible and auditable, and
        // the read-time make guard already excludes these from selection.
        await ctx.db.patch(fitment._id, { data_quality: QUARANTINED_QUALITY });
        quarantined++;
      }
    }

    return {
      scanned: res.page.length,
      contaminatedA,
      contaminatedB,
      quarantined,
      verified_skipped,
      family_shared_skipped,
      byMakePair,
      examples,
      continueCursor: res.continueCursor,
      isDone: res.isDone,
    };
  },
});

// ---------------------------------------------------------------------------
// 2. dedupeNormalizedParts — one page of oem_parts, merge formatting dupes
// ---------------------------------------------------------------------------

type DedupeExample = {
  normalized: string;
  canonicalPartNumber: string;
  canonicalPartId: string;
  duplicatePartNumbers: string[];
};

type DedupePageSummary = {
  scanned: number;
  duplicateGroups: number;
  fitmentsRepointed: number;
  fitmentsDeleted: number;
  pricesRepointed: number;
  pricesDeleted: number;
  examples: DedupeExample[];
  continueCursor: string;
  isDone: boolean;
};

/** Fitment identity for redundancy checks when repointing: a fitment is "the
 *  same" when it targets the same config for the same service/package. */
const fitmentKey = (f: Doc<"part_fitments">): string =>
  `${String(f.vehicle_config_id)}|${f.service_type ?? ""}|${f.package_code ?? ""}`;

export const dedupeNormalizedParts = internalMutation({
  args: {
    dryRun: v.boolean(),
    cursor: v.optional(v.string()),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<DedupePageSummary> => {
    const numItems = args.batchSize ?? DEDUPE_BATCH_DEFAULT;
    const res = await ctx.db
      .query("oem_parts")
      .paginate({ cursor: args.cursor ?? null, numItems });

    let duplicateGroups = 0;
    let fitmentsRepointed = 0;
    let fitmentsDeleted = 0;
    let pricesRepointed = 0;
    let pricesDeleted = 0;
    const examples: DedupeExample[] = [];

    // Group THIS page by normalized number so an in-page pair is found even
    // when neither row has oem_part_number_normalized backfilled yet.
    const inPageByNorm = new Map<string, Doc<"oem_parts">[]>();
    for (const part of res.page) {
      // Rows already merged in a previous run/page are audit tombstones —
      // never a canonical, never re-merged.
      if (part.is_current === false || part.data_quality === MERGED_QUALITY) continue;
      const norm = normalizeOemNumber(part.oem_part_number);
      if (norm.length === 0) continue;
      const bucket = inPageByNorm.get(norm);
      if (bucket) bucket.push(part);
      else inPageByNorm.set(norm, [part]);
    }

    for (const [norm, inPage] of inPageByNorm) {
      // ALSO consult the by_part_number_normalized index: an earlier-created
      // canonical may live OUTSIDE this page. Because live runs backfill the
      // normalized field on every row they scan (below), and pagination walks
      // _creationTime ascending, the earliest row is always indexed by the
      // time its later-created duplicates are scanned — one live pass suffices.
      const indexed = await ctx.db
        .query("oem_parts")
        .withIndex("by_part_number_normalized", (q) =>
          q.eq("oem_part_number_normalized", norm),
        )
        .collect();

      const byId = new Map<string, Doc<"oem_parts">>();
      for (const p of inPage) byId.set(String(p._id), p);
      for (const p of indexed) {
        if (p.is_current === false || p.data_quality === MERGED_QUALITY) continue;
        byId.set(String(p._id), p);
      }
      const group = [...byId.values()];

      if (group.length < 2) {
        // Not a dupe — but on live runs, lazily backfill the normalized field
        // on the single row so future index lookups (this run's later pages,
        // and upsert-time dedup) can see it.
        const solo = group[0];
        if (!args.dryRun && solo && solo.oem_part_number_normalized !== norm) {
          await ctx.db.patch(solo._id, { oem_part_number_normalized: norm });
        }
        continue;
      }

      // Canonical = earliest _creationTime — deterministic and stable across
      // re-runs (source_count would work too, but ties would need breaking).
      group.sort((a, b) => a._creationTime - b._creationTime);
      const canonical = group[0];
      const duplicates = group.slice(1);
      duplicateGroups++;
      if (examples.length < 20) {
        examples.push({
          normalized: norm,
          canonicalPartNumber: canonical.oem_part_number,
          canonicalPartId: String(canonical._id),
          duplicatePartNumbers: duplicates.map((d) => d.oem_part_number),
        });
      }

      // Canonical's existing fitment keys / price domains — anything the dup
      // holds that matches one of these is redundant and gets deleted rather
      // than repointed (repointing would create a functional double-row).
      const canonicalFitments = await ctx.db
        .query("part_fitments")
        .withIndex("by_part", (q) => q.eq("part_id", canonical._id))
        .collect();
      const seenFitmentKeys = new Set(canonicalFitments.map(fitmentKey));
      const canonicalPrices = await ctx.db
        .query("part_prices")
        .withIndex("by_part", (q) => q.eq("part_id", canonical._id))
        .collect();
      const seenDomains = new Set(canonicalPrices.map((p) => p.source_domain ?? ""));

      for (const dup of duplicates) {
        const dupFitments = await ctx.db
          .query("part_fitments")
          .withIndex("by_part", (q) => q.eq("part_id", dup._id))
          .collect();
        for (const f of dupFitments) {
          const key = fitmentKey(f);
          if (seenFitmentKeys.has(key)) {
            fitmentsDeleted++;
            if (!args.dryRun) await ctx.db.delete(f._id);
          } else {
            fitmentsRepointed++;
            seenFitmentKeys.add(key); // two dup fitments with the same key → keep one
            if (!args.dryRun) await ctx.db.patch(f._id, { part_id: canonical._id });
          }
        }

        const dupPrices = await ctx.db
          .query("part_prices")
          .withIndex("by_part", (q) => q.eq("part_id", dup._id))
          .collect();
        for (const p of dupPrices) {
          const domain = p.source_domain ?? "";
          if (seenDomains.has(domain)) {
            pricesDeleted++;
            if (!args.dryRun) await ctx.db.delete(p._id);
          } else {
            pricesRepointed++;
            seenDomains.add(domain);
            if (!args.dryRun) await ctx.db.patch(p._id, { part_id: canonical._id });
          }
        }

        if (!args.dryRun) {
          // Keep the duplicate row for audit (supersession chain), never delete.
          await ctx.db.patch(dup._id, {
            is_current: false,
            superseded_by: canonical.oem_part_number,
            data_quality: MERGED_QUALITY,
            oem_part_number_normalized: norm,
          });
        }
      }

      if (!args.dryRun && canonical.oem_part_number_normalized !== norm) {
        await ctx.db.patch(canonical._id, { oem_part_number_normalized: norm });
      }
    }

    return {
      scanned: res.page.length,
      duplicateGroups,
      fitmentsRepointed,
      fitmentsDeleted,
      pricesRepointed,
      pricesDeleted,
      examples,
      continueCursor: res.continueCursor,
      isDone: res.isDone,
    };
  },
});

// ---------------------------------------------------------------------------
// 3. runQuarantineScan — driver: loop both sweeps to completion, aggregate
// ---------------------------------------------------------------------------

const EXAMPLES_CAP = 50;
// Hard stop so a cursor bug can never loop an action forever. 5000 pages at
// the default batch sizes covers ~1M fitments / ~500k parts — far beyond the
// current corpus.
const MAX_PAGES = 5000;

type QuarantineReport = {
  dryRun: boolean;
  crossMakeScan: {
    pages: number;
    scanned: number;
    contaminatedA: number;
    contaminatedB: number;
    quarantined: number;
    verified_skipped: number;
    family_shared_skipped: number;
    byMakePair: Record<string, number>;
    examples: ScanExample[];
  };
  dedupe: {
    pages: number;
    scanned: number;
    duplicateGroups: number;
    fitmentsRepointed: number;
    fitmentsDeleted: number;
    pricesRepointed: number;
    pricesDeleted: number;
    examples: DedupeExample[];
  };
};

export const runQuarantineScan = internalAction({
  args: {
    dryRun: v.boolean(),
    // Optional page-size overrides for both sweeps (mostly for testing).
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<QuarantineReport> => {
    const mode = args.dryRun ? "DRY RUN" : "LIVE";
    console.log(`[quarantine] starting sweep (${mode})`);

    // ── Phase 1: cross-make fitment scan ──────────────────────────────────
    // Each page is its OWN runMutation call (its own transaction) so no single
    // mutation approaches the Convex read/write ceilings on a large corpus.
    const scan: QuarantineReport["crossMakeScan"] = {
      pages: 0,
      scanned: 0,
      contaminatedA: 0,
      contaminatedB: 0,
      quarantined: 0,
      verified_skipped: 0,
      family_shared_skipped: 0,
      byMakePair: {},
      examples: [],
    };
    let cursor: string | undefined = undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const page: ScanPageSummary = await ctx.runMutation(
        internal.vehicleEnrichment.fitmentQuarantine.scanCrossMakeFitments,
        { dryRun: args.dryRun, cursor, batchSize: args.batchSize },
      );
      scan.pages++;
      scan.scanned += page.scanned;
      scan.contaminatedA += page.contaminatedA;
      scan.contaminatedB += page.contaminatedB;
      scan.quarantined += page.quarantined;
      scan.verified_skipped += page.verified_skipped;
      scan.family_shared_skipped += page.family_shared_skipped;
      for (const [pair, n] of Object.entries(page.byMakePair)) {
        scan.byMakePair[pair] = (scan.byMakePair[pair] ?? 0) + n;
      }
      for (const ex of page.examples) {
        if (scan.examples.length < EXAMPLES_CAP) scan.examples.push(ex);
      }
      console.log(
        `[quarantine] scan page ${scan.pages}: scanned=${page.scanned} A=${page.contaminatedA} B=${page.contaminatedB} quarantined=${page.quarantined} verified_skipped=${page.verified_skipped}`,
      );
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    console.log(
      `[quarantine] scan complete: ${JSON.stringify({ ...scan, examples: scan.examples.length })}`,
    );

    // ── Phase 2: normalized-number dedupe ─────────────────────────────────
    const dedupe: QuarantineReport["dedupe"] = {
      pages: 0,
      scanned: 0,
      duplicateGroups: 0,
      fitmentsRepointed: 0,
      fitmentsDeleted: 0,
      pricesRepointed: 0,
      pricesDeleted: 0,
      examples: [],
    };
    cursor = undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const page: DedupePageSummary = await ctx.runMutation(
        internal.vehicleEnrichment.fitmentQuarantine.dedupeNormalizedParts,
        { dryRun: args.dryRun, cursor, batchSize: args.batchSize },
      );
      dedupe.pages++;
      dedupe.scanned += page.scanned;
      dedupe.duplicateGroups += page.duplicateGroups;
      dedupe.fitmentsRepointed += page.fitmentsRepointed;
      dedupe.fitmentsDeleted += page.fitmentsDeleted;
      dedupe.pricesRepointed += page.pricesRepointed;
      dedupe.pricesDeleted += page.pricesDeleted;
      for (const ex of page.examples) {
        if (dedupe.examples.length < EXAMPLES_CAP) dedupe.examples.push(ex);
      }
      console.log(
        `[quarantine] dedupe page ${dedupe.pages}: scanned=${page.scanned} groups=${page.duplicateGroups} fitments=${page.fitmentsRepointed}+${page.fitmentsDeleted}del prices=${page.pricesRepointed}+${page.pricesDeleted}del`,
      );
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    console.log(
      `[quarantine] dedupe complete: ${JSON.stringify({ ...dedupe, examples: dedupe.examples.length })}`,
    );

    // Dry-run caveat: legacy dupes whose rows sit in DIFFERENT pages and lack
    // oem_part_number_normalized are invisible to a dry run (the index can't
    // see them and the page can't group them). The live run backfills the
    // field as it walks, so it catches them in one pass — expect the live
    // duplicateGroups count to be >= the dry-run count.
    return { dryRun: args.dryRun, crossMakeScan: scan, dedupe };
  },
});

// ---------------------------------------------------------------------------
// 4. quarantineReport — how many fitments carry the quarantine stamp?
// ---------------------------------------------------------------------------

export const quarantineReport = internalQuery({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ quarantined: number; sampleFitmentIds: string[] }> => {
    // Index-less filter over part_fitments is acceptable here: this is an
    // internal one-off diagnostic and the table is bounded (the read-only
    // diagnostic in _diagnostic_i1_i2.ts already .collect()s the whole table
    // within limits). If the corpus outgrows a single query, switch to a
    // paginate loop inside an action.
    const rows = await ctx.db
      .query("part_fitments")
      .filter((q) => q.eq(q.field("data_quality"), QUARANTINED_QUALITY))
      .collect();
    return {
      quarantined: rows.length,
      sampleFitmentIds: rows.slice(0, 20).map((r) => String(r._id)),
    };
  },
});
