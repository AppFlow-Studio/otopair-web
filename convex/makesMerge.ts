/**
 * makesMerge.ts — duplicate-makes audit + merge migration (Aug 2026).
 *
 * The makes table holds case-variant duplicate rows of one manufacturer
 * ("Mercedes-Benz" j576y260e4fvemwt61a48c0nan84gh4d vs "MERCEDES-BENZ"
 * j578a32vhn73qd9400rj3s85dd80hed1 verified on dev:ardent-crab-641). Parts,
 * configs and catalog rows get stamped under whichever row their creation
 * path found, and the strict id-equality I1 read guard then rejects correct
 * same-make parts (lib/makeIdentity.ts ships the read-side escape; this file
 * is the durable fix it points at).
 *
 * Everything here is internal — run via CLI, per deployment, in this order:
 *
 *   1. npx convex run makesMerge:audit '{}'                       (read-only)
 *   2. npx convex run makesMerge:mergeMakes '{"dry_run": true}'
 *   3. npx convex run makesMerge:mergeMakes '{"dry_run": false}'
 *   4. npx convex run makesMerge:mergeModels '{"dry_run": ...}'
 *      — only if step 3 reported model_twins (same-named models that ended up
 *        under one make after the merge). Action wrapper: the model merge
 *        mutation plus a paged scrape_cache re-stamp (that table holds full
 *        page markdown — a single-transaction collect blows the 16MiB read
 *        limit, so it is scanned slim, few docs per page, outside the tx).
 *   5. npx convex run makesMerge:verify '{}'                      (read-only)
 *
 * Revert: npx convex run makesMerge:revertMerge '{"batch_id": "..."}'
 * using the batch_id from the merge summary. Reversal is faithful EXCEPT that
 * a revived row gets a NEW _id (Convex cannot restore a deleted document's
 * id) — restamped FK docs are re-pointed at the new id, so in-database state
 * is equivalent; only out-of-band copies of the old id stay dangling.
 *
 * Merge mechanics: rows are grouped by lib/makeKey.makeKeyOf. The canonical
 * row is the one with the most metadata (patterns/country/slug — i.e. the
 * properly seeded row), tie-broken toward mixed-case names then age. Every
 * FK table is re-stamped to the canonical id, missing metadata is absorbed
 * from losers, each loser is snapshotted into make_merge_log and deleted,
 * and every surviving row gets make_key stamped so the by_make_key index
 * (and the getOrCreateMake guard) prevents recurrence.
 */
import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { makeKeyOf, makeSlugOf } from "./lib/makeKey";

// ============================================================================
// FK maps — every table carrying a makes / models reference (schema-verified).
// transmissions and scrape_cache(model_id) have no usable index and are
// scanned; the scan is done once per merge call and reused.
// ============================================================================

const MAKE_REF_TABLES: Array<{ table: string; index: string | null }> = [
  { table: "models", index: "by_make_id" },
  { table: "engines", index: "by_make" },
  { table: "transmissions", index: null }, // make_id exists, no index
  { table: "chassis_specs", index: "by_make" },
  { table: "vehicle_configs", index: "by_make_model_year" }, // prefix on make_id
  { table: "oem_parts", index: "by_make_category" }, // prefix on make_id
  { table: "source_registry", index: "by_make" },
  { table: "scrape_cache", index: "by_make_year" }, // prefix on make_id
  { table: "model_year_cache", index: "by_make_year" }, // prefix on make_id
];

/** Metadata fields the canonical row absorbs from losers when it lacks them. */
const MAKE_ABSORB_FIELDS = [
  "slug",
  "country",
  "oem_part_pattern",
  "oem_part_pattern_alt",
  "parent_group",
  "logo",
  "logo_url",
] as const;

const RESTAMP_WRITE_BUDGET = 5000; // stay far below the 8192-writes/tx cap
const DOC_IDS_CHUNK = 4000; // stay far below the 8192-item array cap

function present(v: unknown): boolean {
  return v !== null && v !== undefined && v !== "";
}

function metadataScore(m: Doc<"makes">): number {
  let s = 0;
  for (const f of MAKE_ABSORB_FIELDS) if (present(m[f])) s++;
  return s;
}

function isMixedCase(n: string): boolean {
  return n !== n.toUpperCase() && n !== n.toLowerCase();
}

/** Deterministic canonical pick: most metadata (the seeded row), then a
 *  mixed-case display name over SHOUTING/lowercase variants, then oldest. */
function pickCanonicalMake(rows: Doc<"makes">[]): Doc<"makes"> {
  return [...rows].sort(
    (a, b) =>
      metadataScore(b) - metadataScore(a) ||
      (isMixedCase(b.name) ? 1 : 0) - (isMixedCase(a.name) ? 1 : 0) ||
      a._creationTime - b._creationTime ||
      String(a._id).localeCompare(String(b._id)),
  )[0];
}

async function collectMakeRefs(
  ctx: { db: any },
  table: string,
  index: string | null,
  makeId: Id<"makes">,
  scannedTransmissions: Doc<"transmissions">[],
): Promise<Array<{ _id: string }>> {
  if (table === "transmissions") {
    return scannedTransmissions.filter((t) => t.make_id === makeId) as any;
  }
  return await ctx.db
    .query(table)
    .withIndex(index!, (q: any) => q.eq("make_id", makeId))
    .collect();
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ============================================================================
// 1. auditMakes — read-only duplicate report (single transaction)
// ============================================================================

export const auditMakes = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("makes").collect();
    const byKey = new Map<string, Doc<"makes">[]>();
    for (const m of all) {
      const k = makeKeyOf(m.name);
      byKey.set(k, [...(byKey.get(k) ?? []), m]);
    }

    const dupEntries = [...byKey.entries()].filter(([, rows]) => rows.length > 1);

    // Ref counts only for rows in duplicate groups (keeps reads bounded).
    const scannedTransmissions = dupEntries.length
      ? await ctx.db.query("transmissions").collect()
      : [];
    const dup_groups = [];
    for (const [key, rows] of dupEntries) {
      const canonical = pickCanonicalMake(rows);
      const rowReports = [];
      for (const row of rows) {
        const refs: Record<string, number> = {};
        let total = 0;
        for (const t of MAKE_REF_TABLES) {
          const docs = await collectMakeRefs(
            ctx,
            t.table,
            t.index,
            row._id,
            scannedTransmissions,
          );
          if (docs.length) refs[t.table] = docs.length;
          total += docs.length;
        }
        rowReports.push({
          id: String(row._id),
          name: row.name,
          slug: row.slug ?? null,
          make_key: row.make_key ?? null,
          metadata_score: metadataScore(row),
          creation_time: row._creationTime,
          is_canonical_pick: row._id === canonical._id,
          total_refs: total,
          refs,
        });
      }
      dup_groups.push({ make_key: key, rows: rowReports });
    }

    // Model twins that exist RIGHT NOW (same normalized name under one make).
    const allModels = await ctx.db.query("models").collect();
    const modelsByMakeAndKey = new Map<string, Doc<"models">[]>();
    for (const mo of allModels) {
      const k = `${mo.make_id}::${makeKeyOf(mo.name)}`;
      modelsByMakeAndKey.set(k, [...(modelsByMakeAndKey.get(k) ?? []), mo]);
    }
    const makeName = new Map(all.map((m) => [String(m._id), m.name]));
    const model_twins = [...modelsByMakeAndKey.values()]
      .filter((rows) => rows.length > 1)
      .map((rows) => ({
        make: makeName.get(String(rows[0].make_id)) ?? String(rows[0].make_id),
        make_id: String(rows[0].make_id),
        models: rows.map((r) => ({ id: String(r._id), name: r.name })),
      }));

    return {
      makes_total: all.length,
      rows_missing_make_key: all.filter(
        (m) => m.make_key !== makeKeyOf(m.name),
      ).length,
      all_rows: all.map((m) => ({
        id: String(m._id),
        name: m.name,
        make_key: m.make_key ?? null,
        slug: m.slug ?? null,
      })),
      dup_groups,
      model_twins,
    };
  },
});

// ============================================================================
// 2. auditConfigKeysPage — paged slim scan in by_config_key order, so
//    duplicate keys land adjacent and the aggregating action can stream.
// ============================================================================

export const auditConfigKeysPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), num_items: v.number() },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_config_key")
      .paginate({ cursor: args.cursor, numItems: args.num_items });
    return {
      rows: page.page.map((c) => ({
        id: String(c._id),
        config_key: c.config_key,
      })),
      cursor: page.continueCursor,
      is_done: page.isDone,
    };
  },
});

// ============================================================================
// 3. audit — the full read-only report (makes dups + config_key dups)
// ============================================================================

export const audit = internalAction({
  args: {},
  handler: async (ctx): Promise<Record<string, unknown>> => {
    // `any`-typed: referencing this file's own functions through
    // internal.makesMerge is self-referential for inference (TS7022).
    const makes: any = await ctx.runQuery(internal.makesMerge.auditMakes, {});

    // Stream vehicle_configs in key order; dups are adjacent.
    const dupConfigKeys = new Map<string, string[]>();
    let prev: { key: string; id: string } | null = null;
    let totalConfigs = 0;
    let cursor: string | null = null;
    for (;;) {
      const page: any = await ctx.runQuery(
        internal.makesMerge.auditConfigKeysPage,
        { cursor, num_items: 400 },
      );
      for (const row of page.rows) {
        totalConfigs++;
        if (prev && prev.key === row.config_key) {
          const ids = dupConfigKeys.get(row.config_key) ?? [prev.id];
          ids.push(row.id);
          dupConfigKeys.set(row.config_key, ids);
        }
        prev = { key: row.config_key, id: row.id };
      }
      if (page.is_done) break;
      cursor = page.cursor;
    }

    return {
      ...makes,
      vehicle_configs_total: totalConfigs,
      duplicate_config_keys: [...dupConfigKeys.entries()].map(([key, ids]) => ({
        config_key: key,
        ids,
      })),
    };
  },
});

// ============================================================================
// 4. mergeMakes — the migration. One transaction: atomic, fully logged.
// ============================================================================

export const mergeMakes = internalMutation({
  args: {
    dry_run: v.boolean(),
    // Merge just one duplicate set (its makeKeyOf value) — the escape valve
    // if the all-groups run would exceed the write budget.
    only_key: v.optional(v.string()),
    batch_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const batchId = args.batch_id ?? `makes_merge_${Date.now()}`;
    const now = Date.now();
    const all = await ctx.db.query("makes").collect();

    const byKey = new Map<string, Doc<"makes">[]>();
    for (const m of all) {
      const k = makeKeyOf(m.name);
      byKey.set(k, [...(byKey.get(k) ?? []), m]);
    }
    const dupEntries = [...byKey.entries()].filter(
      ([k, rows]) => rows.length > 1 && (!args.only_key || k === args.only_key),
    );

    const scannedTransmissions = dupEntries.length
      ? await ctx.db.query("transmissions").collect()
      : [];

    // ---- Plan phase (reads only) so the write budget is enforced up front.
    type LoserPlan = {
      loser: Doc<"makes">;
      perTable: Array<{ table: string; ids: string[] }>;
    };
    const plans: Array<{
      key: string;
      canonical: Doc<"makes">;
      losers: Doc<"makes">[];
      loserPlans: LoserPlan[];
      absorb: Record<string, unknown>;
      before: Record<string, unknown>;
    }> = [];
    let totalRestamps = 0;

    for (const [key, rows] of dupEntries) {
      const canonical = pickCanonicalMake(rows);
      const losers = rows.filter((r) => r._id !== canonical._id);
      const loserPlans: LoserPlan[] = [];
      for (const loser of losers) {
        const perTable: LoserPlan["perTable"] = [];
        for (const t of MAKE_REF_TABLES) {
          const docs = await collectMakeRefs(
            ctx,
            t.table,
            t.index,
            loser._id,
            scannedTransmissions,
          );
          perTable.push({ table: t.table, ids: docs.map((d) => String(d._id)) });
          totalRestamps += docs.length;
        }
        loserPlans.push({ loser, perTable });
      }

      const absorb: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      for (const f of MAKE_ABSORB_FIELDS) {
        if (present(canonical[f])) continue;
        const donor = losers.find((l) => present(l[f]));
        if (donor) {
          absorb[f] = donor[f];
          before[f] = canonical[f] ?? null;
        }
      }
      plans.push({ key, canonical, losers, loserPlans, absorb, before });
    }

    if (totalRestamps > RESTAMP_WRITE_BUDGET) {
      throw new Error(
        `mergeMakes would re-stamp ${totalRestamps} docs — over the single-transaction budget (${RESTAMP_WRITE_BUDGET}). Run per group with only_key.`,
      );
    }

    const mergedLoserIds = new Set<string>();
    if (!args.dry_run) {
      for (const p of plans) {
        for (const lp of p.loserPlans) {
          for (const t of lp.perTable) {
            for (const id of t.ids) {
              await ctx.db.patch(id as Id<any>, { make_id: p.canonical._id });
            }
            for (const ids of chunk(t.ids, DOC_IDS_CHUNK)) {
              await ctx.db.insert("make_merge_log", {
                batch_id: batchId,
                entity: "makes",
                kind: "restamp",
                entity_key: p.key,
                canonical_id: String(p.canonical._id),
                loser_id: String(lp.loser._id),
                table: t.table,
                field: "make_id",
                doc_ids: ids,
                count: ids.length,
                created_at: now,
              });
            }
          }
          await ctx.db.insert("make_merge_log", {
            batch_id: batchId,
            entity: "makes",
            kind: "loser",
            entity_key: p.key,
            canonical_id: String(p.canonical._id),
            loser_id: String(lp.loser._id),
            loser_snapshot: { ...lp.loser },
            created_at: now,
          });
          mergedLoserIds.add(String(lp.loser._id));
          await ctx.db.delete(lp.loser._id);
        }

        const patch: Record<string, unknown> = {
          ...p.absorb,
          make_key: p.key,
        };
        if (!present(p.canonical.slug) && !("slug" in p.absorb)) {
          patch.slug = makeSlugOf(p.canonical.name);
        }
        await ctx.db.insert("make_merge_log", {
          batch_id: batchId,
          entity: "makes",
          kind: "canonical_patch",
          entity_key: p.key,
          canonical_id: String(p.canonical._id),
          patch_before: {
            ...p.before,
            make_key: p.canonical.make_key ?? null,
            ...(patch.slug !== undefined
              ? { slug: p.canonical.slug ?? null }
              : {}),
          },
          created_at: now,
        });
        await ctx.db.patch(p.canonical._id, patch);
      }

      // Backfill make_key on every surviving row so by_make_key is total.
      for (const m of all) {
        if (mergedLoserIds.has(String(m._id))) continue;
        if (plans.some((p) => p.canonical._id === m._id)) continue; // patched above
        if (m.make_key !== makeKeyOf(m.name)) {
          await ctx.db.patch(m._id, { make_key: makeKeyOf(m.name) });
        }
      }
    }

    // Model twins that will exist under each canonical after the merge —
    // input for mergeModelsUnderMake. Reads reflect our own writes, so on a
    // live run this is the true post-merge state.
    const model_twins: Array<{
      make: string;
      make_id: string;
      models: Array<{ id: string; name: string }>;
    }> = [];
    for (const p of plans) {
      const models = args.dry_run
        ? (
            await Promise.all(
              [p.canonical, ...p.losers].map((m) =>
                ctx.db
                  .query("models")
                  .withIndex("by_make_id", (q) => q.eq("make_id", m._id))
                  .collect(),
              ),
            )
          ).flat()
        : await ctx.db
            .query("models")
            .withIndex("by_make_id", (q) => q.eq("make_id", p.canonical._id))
            .collect();
      const grouped = new Map<string, Doc<"models">[]>();
      for (const mo of models) {
        const k = makeKeyOf(mo.name);
        grouped.set(k, [...(grouped.get(k) ?? []), mo]);
      }
      for (const rows of grouped.values()) {
        if (rows.length > 1) {
          model_twins.push({
            make: p.canonical.name,
            make_id: String(p.canonical._id),
            models: rows.map((r) => ({ id: String(r._id), name: r.name })),
          });
        }
      }
    }

    return {
      batch_id: batchId,
      dry_run: args.dry_run,
      groups: plans.map((p) => ({
        make_key: p.key,
        canonical: { id: String(p.canonical._id), name: p.canonical.name },
        losers: p.losers.map((l) => ({ id: String(l._id), name: l.name })),
        absorbed_fields: Object.keys(p.absorb),
        restamps: Object.fromEntries(
          p.loserPlans
            .flatMap((lp) => lp.perTable)
            .reduce((acc, t) => {
              acc.set(t.table, (acc.get(t.table) ?? 0) + t.ids.length);
              return acc;
            }, new Map<string, number>())
            .entries(),
        ),
      })),
      total_restamps: totalRestamps,
      model_twins,
    };
  },
});

// ============================================================================
// 5. mergeModelsUnderMake — follow-up: after the makes merge lands, the same
//    model can exist twice under the canonical make (one row per former makes
//    row). Merges models whose normalized names are IDENTICAL under one make;
//    never touches genuinely different names.
// ============================================================================

// scrape_cache is deliberately absent: its docs carry full page markdown, so
// any in-transaction collect breaks the 16MiB read limit. The mergeModels
// action re-stamps it afterwards via a slim paged scan + restampDocsByIds.
const MODEL_REF_TABLES: Array<{ table: string; index: string | null }> = [
  { table: "generations", index: "by_model" },
  { table: "trims", index: "by_model_id" },
  { table: "vehicle_configs", index: null }, // via by_make_model_year (needs make prefix) — handled specially
  { table: "trim_year_cache", index: "by_model_year" },
];

export const mergeModelsUnderMake = internalMutation({
  args: {
    dry_run: v.boolean(),
    make_id: v.optional(v.id("makes")), // limit to one make
    batch_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const batchId = args.batch_id ?? `models_merge_${Date.now()}`;
    const now = Date.now();
    const allModels = args.make_id
      ? await ctx.db
          .query("models")
          .withIndex("by_make_id", (q) => q.eq("make_id", args.make_id!))
          .collect()
      : await ctx.db.query("models").collect();

    const grouped = new Map<string, Doc<"models">[]>();
    for (const mo of allModels) {
      const k = `${mo.make_id}::${makeKeyOf(mo.name)}`;
      grouped.set(k, [...(grouped.get(k) ?? []), mo]);
    }
    const dupGroups = [...grouped.values()].filter((rows) => rows.length > 1);

    let totalRestamps = 0;
    const pairs: Array<{ from: string; to: string }> = [];
    const results = [];
    for (const rows of dupGroups) {
      // Canonical model: most metadata (slug/category), then oldest. NO
      // mixed-case preference here — model names are often acronyms where
      // "CR-V" (all caps) is correct and a title-cased "Cr-v" variant is the
      // junk row; oldest = the original catalog row.
      const canonical = [...rows].sort(
        (a, b) =>
          (present(b.slug) ? 1 : 0) +
            (present(b.category) ? 1 : 0) -
            ((present(a.slug) ? 1 : 0) + (present(a.category) ? 1 : 0)) ||
          a._creationTime - b._creationTime ||
          String(a._id).localeCompare(String(b._id)),
      )[0];
      const losers = rows.filter((r) => r._id !== canonical._id);
      const restampCounts: Record<string, number> = {};

      for (const loser of losers) {
        pairs.push({ from: String(loser._id), to: String(canonical._id) });
        const perTable: Array<{ table: string; ids: string[] }> = [];
        for (const t of MODEL_REF_TABLES) {
          let docs: Array<{ _id: unknown }>;
          if (t.table === "vehicle_configs") {
            docs = (
              await ctx.db
                .query("vehicle_configs")
                .withIndex("by_make_model_year", (q) =>
                  q.eq("make_id", loser.make_id).eq("model_id", loser._id),
                )
                .collect()
            ) as any;
          } else {
            docs = await ctx.db
              .query(t.table as any)
              .withIndex(t.index! as any, (q: any) =>
                q.eq("model_id", loser._id),
              )
              .collect();
          }
          perTable.push({ table: t.table, ids: docs.map((d) => String(d._id)) });
          totalRestamps += docs.length;
          restampCounts[t.table] =
            (restampCounts[t.table] ?? 0) + docs.length;
        }

        if (!args.dry_run) {
          for (const t of perTable) {
            for (const id of t.ids) {
              await ctx.db.patch(id as Id<any>, { model_id: canonical._id });
            }
            for (const ids of chunk(t.ids, DOC_IDS_CHUNK)) {
              await ctx.db.insert("make_merge_log", {
                batch_id: batchId,
                entity: "models",
                kind: "restamp",
                entity_key: makeKeyOf(loser.name),
                canonical_id: String(canonical._id),
                loser_id: String(loser._id),
                table: t.table,
                field: "model_id",
                doc_ids: ids,
                count: ids.length,
                created_at: now,
              });
            }
          }
          await ctx.db.insert("make_merge_log", {
            batch_id: batchId,
            entity: "models",
            kind: "loser",
            entity_key: makeKeyOf(loser.name),
            canonical_id: String(canonical._id),
            loser_id: String(loser._id),
            loser_snapshot: { ...loser },
            created_at: now,
          });
          await ctx.db.delete(loser._id);
        }
      }

      // Absorb slug/category onto canonical from losers.
      const absorb: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      for (const f of ["slug", "category"] as const) {
        if (present(canonical[f])) continue;
        const donor = losers.find((l) => present(l[f]));
        if (donor) {
          absorb[f] = donor[f];
          before[f] = canonical[f] ?? null;
        }
      }
      if (!args.dry_run && Object.keys(absorb).length) {
        await ctx.db.insert("make_merge_log", {
          batch_id: batchId,
          entity: "models",
          kind: "canonical_patch",
          entity_key: makeKeyOf(canonical.name),
          canonical_id: String(canonical._id),
          patch_before: before,
          created_at: now,
        });
        await ctx.db.patch(canonical._id, absorb);
      }

      results.push({
        make_id: String(canonical.make_id),
        canonical: { id: String(canonical._id), name: canonical.name },
        losers: losers.map((l) => ({ id: String(l._id), name: l.name })),
        restamps: restampCounts,
      });
    }

    if (totalRestamps > RESTAMP_WRITE_BUDGET) {
      // Reads already happened; writes above are gated per-group so this can
      // only trip on absurd scale — surface it loudly either way.
      throw new Error(
        `mergeModelsUnderMake re-stamp volume ${totalRestamps} exceeded budget ${RESTAMP_WRITE_BUDGET} — rerun scoped with make_id.`,
      );
    }

    return {
      batch_id: batchId,
      dry_run: args.dry_run,
      groups: results,
      total_restamps: totalRestamps,
      pairs,
    };
  },
});

/** Generic explicit-ids re-stamp used by mergeModels for scrape_cache (and
 *  any future no-index fat table). Patches only docs whose current FK value
 *  matches a mapping's `from`; logs per-pair restamp rows for revertMerge. */
export const restampDocsByIds = internalMutation({
  args: {
    batch_id: v.string(),
    entity: v.string(),
    table: v.string(),
    field: v.string(),
    mapping: v.array(v.object({ from: v.string(), to: v.string() })),
    doc_ids: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const byFrom = new Map(args.mapping.map((m) => [m.from, m.to]));
    const patchedByPair = new Map<string, string[]>();
    for (const docId of args.doc_ids) {
      const doc: any = await ctx.db.get(docId as Id<any>);
      if (!doc) continue;
      const cur = doc[args.field] != null ? String(doc[args.field]) : null;
      if (!cur) continue;
      const to = byFrom.get(cur);
      if (!to) continue;
      await ctx.db.patch(docId as Id<any>, { [args.field]: to });
      patchedByPair.set(cur, [...(patchedByPair.get(cur) ?? []), docId]);
    }
    const now = Date.now();
    let patched = 0;
    for (const [from, ids] of patchedByPair) {
      patched += ids.length;
      for (const idsChunk of chunk(ids, DOC_IDS_CHUNK)) {
        await ctx.db.insert("make_merge_log", {
          batch_id: args.batch_id,
          entity: args.entity,
          kind: "restamp",
          canonical_id: byFrom.get(from)!,
          loser_id: from,
          table: args.table,
          field: args.field,
          doc_ids: idsChunk,
          count: idsChunk.length,
          created_at: now,
        });
      }
    }
    return { patched };
  },
});

/**
 * Umbrella model-merge: runs mergeModelsUnderMake, then re-stamps
 * scrape_cache.model_id via a slim paged scan (12 docs/page — rows carry full
 * page markdown, so pages must stay small to respect the 16MiB read limit).
 */
export const mergeModels = internalAction({
  args: {
    dry_run: v.boolean(),
    make_id: v.optional(v.id("makes")),
  },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    // `any`-typed: self-referential inference through internal.makesMerge.
    const merged: any = await ctx.runMutation(
      internal.makesMerge.mergeModelsUnderMake,
      { dry_run: args.dry_run, make_id: args.make_id },
    );
    const pairs: Array<{ from: string; to: string }> = merged.pairs ?? [];
    if (!pairs.length) return { ...merged, scrape_cache_restamped: 0 };

    const fromSet = new Set(pairs.map((p) => p.from));
    const affected: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page: any = await ctx.runQuery(internal.makesMerge.scanRefsPage, {
        table: "scrape_cache",
        fk_fields: ["model_id"],
        cursor,
        num_items: 12,
      });
      for (const row of page.rows) {
        const mid = row.fks.model_id;
        if (mid && fromSet.has(mid)) affected.push(row.id);
      }
      if (page.is_done) break;
      cursor = page.cursor;
    }

    if (args.dry_run) {
      return { ...merged, scrape_cache_would_restamp: affected.length };
    }
    let patched = 0;
    for (const ids of chunk(affected, 500)) {
      const res: any = await ctx.runMutation(
        internal.makesMerge.restampDocsByIds,
        {
          batch_id: merged.batch_id,
          entity: "models",
          table: "scrape_cache",
          field: "model_id",
          mapping: pairs,
          doc_ids: ids,
        },
      );
      patched += res.patched;
    }
    return { ...merged, scrape_cache_restamped: patched };
  },
});

// ============================================================================
// 6. revertMerge — replay a batch backwards from make_merge_log.
// ============================================================================

export const revertMerge = internalMutation({
  args: { batch_id: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("make_merge_log")
      .withIndex("by_batch", (q) => q.eq("batch_id", args.batch_id))
      .collect();
    if (!rows.length) throw new Error(`no log rows for batch ${args.batch_id}`);
    const now = Date.now();

    // 1) Revive losers (new _ids — Convex cannot restore deleted ids).
    const idMap = new Map<string, string>();
    let revived = 0;
    for (const lr of rows.filter((r) => r.kind === "loser" && !r.reverted_at)) {
      const snap = { ...(lr.loser_snapshot as Record<string, unknown>) };
      delete snap._id;
      delete snap._creationTime;
      const tableName = lr.entity === "models" ? "models" : "makes";
      const newId = await ctx.db.insert(tableName as any, snap);
      idMap.set(lr.loser_id!, String(newId));
      await ctx.db.patch(lr._id, { reverted_at: now });
      revived++;
    }

    // 2) Re-point restamped docs back to the revived rows. Docs whose FK no
    //    longer points at the merge's canonical (someone changed them since)
    //    are skipped, not clobbered.
    let repointed = 0;
    let skipped = 0;
    for (const rr of rows.filter(
      (r) => r.kind === "restamp" && !r.reverted_at,
    )) {
      const newLoserId = idMap.get(rr.loser_id!);
      if (!newLoserId) {
        skipped += rr.count ?? 0;
        continue;
      }
      const fk = rr.field!;
      for (const docId of rr.doc_ids ?? []) {
        const doc: any = await ctx.db.get(docId as Id<any>);
        if (doc && String(doc[fk]) === rr.canonical_id) {
          await ctx.db.patch(docId as Id<any>, { [fk]: newLoserId });
          repointed++;
        } else {
          skipped++;
        }
      }
      await ctx.db.patch(rr._id, { reverted_at: now });
    }

    // 3) Restore canonical rows' absorbed/stamped fields (null → remove).
    let canonicalsRestored = 0;
    for (const cp of rows.filter(
      (r) => r.kind === "canonical_patch" && !r.reverted_at,
    )) {
      const before = (cp.patch_before ?? {}) as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(before)) {
        patch[k] = val === null ? undefined : val;
      }
      const canonicalDoc = await ctx.db.get(cp.canonical_id as Id<any>);
      if (canonicalDoc && Object.keys(patch).length) {
        await ctx.db.patch(cp.canonical_id as Id<any>, patch);
        canonicalsRestored++;
      }
      await ctx.db.patch(cp._id, { reverted_at: now });
    }

    return {
      batch_id: args.batch_id,
      revived,
      new_ids: Object.fromEntries(idMap.entries()),
      repointed,
      skipped,
      canonicals_restored: canonicalsRestored,
    };
  },
});

// ============================================================================
// 7. verify — post-merge invariants, read-only.
//    (a) no two makes share a make key; every row has make_key stamped
//    (b) no FK doc points at a nonexistent make/model (orphan scan, paged)
//    (c) duplicate config_key report
// ============================================================================

export const scanRefsPage = internalQuery({
  args: {
    table: v.string(),
    fk_fields: v.array(v.string()),
    cursor: v.union(v.string(), v.null()),
    num_items: v.number(),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query(args.table as any)
      .paginate({ cursor: args.cursor, numItems: args.num_items });
    return {
      rows: page.page.map((d: any) => ({
        id: String(d._id),
        fks: Object.fromEntries(
          args.fk_fields.map((f) => [f, d[f] != null ? String(d[f]) : null]),
        ),
      })),
      cursor: page.continueCursor,
      is_done: page.isDone,
    };
  },
});

export const allModelIds = internalQuery({
  args: {},
  handler: async (ctx) => {
    const models = await ctx.db.query("models").collect();
    return models.map((m) => String(m._id));
  },
});

// page_size: scrape_cache rows carry full page markdown — keep its pages tiny
// so a single scanRefsPage execution stays under the 16MiB read limit.
const VERIFY_SCANS: Array<{ table: string; fks: string[]; page_size?: number }> = [
  { table: "models", fks: ["make_id"] },
  { table: "engines", fks: ["make_id"] },
  { table: "transmissions", fks: ["make_id"] },
  { table: "chassis_specs", fks: ["make_id"] },
  { table: "vehicle_configs", fks: ["make_id", "model_id"] },
  { table: "oem_parts", fks: ["make_id"] },
  { table: "source_registry", fks: ["make_id"] },
  { table: "scrape_cache", fks: ["make_id", "model_id"], page_size: 12 },
  { table: "model_year_cache", fks: ["make_id"] },
  { table: "generations", fks: ["model_id"] },
  { table: "trims", fks: ["model_id"] },
  { table: "trim_year_cache", fks: ["model_id"] },
];

export const verify = internalAction({
  args: {},
  handler: async (ctx): Promise<Record<string, unknown>> => {
    // `any`-typed: see audit — self-referential inference otherwise (TS7022).
    const makes: any = await ctx.runQuery(internal.makesMerge.auditMakes, {});
    const liveMakeIds = new Set<string>(makes.all_rows.map((r: any) => r.id));
    const modelIds: any = await ctx.runQuery(internal.makesMerge.allModelIds, {});
    const liveModelIds = new Set<string>(modelIds);

    const orphans: Array<{
      table: string;
      field: string;
      count: number;
      sample: string[];
    }> = [];
    for (const scan of VERIFY_SCANS) {
      const counts = new Map<string, { count: number; sample: string[] }>();
      let cursor: string | null = null;
      for (;;) {
        const page: any = await ctx.runQuery(internal.makesMerge.scanRefsPage, {
          table: scan.table,
          fk_fields: scan.fks,
          cursor,
          num_items: scan.page_size ?? 250,
        });
        for (const row of page.rows) {
          for (const f of scan.fks) {
            const val = row.fks[f];
            if (val == null) continue;
            const liveSet = f === "make_id" ? liveMakeIds : liveModelIds;
            if (!liveSet.has(val)) {
              const c = counts.get(f) ?? { count: 0, sample: [] };
              c.count++;
              if (c.sample.length < 10) c.sample.push(row.id);
              counts.set(f, c);
            }
          }
        }
        if (page.is_done) break;
        cursor = page.cursor;
      }
      for (const [field, c] of counts) {
        orphans.push({ table: scan.table, field, count: c.count, sample: c.sample });
      }
    }

    // Duplicate config keys (same streaming approach as audit).
    const dupConfigKeys: Array<{ config_key: string; ids: string[] }> = [];
    {
      const dups = new Map<string, string[]>();
      let prev: { key: string; id: string } | null = null;
      let cursor: string | null = null;
      for (;;) {
        const page: any = await ctx.runQuery(
          internal.makesMerge.auditConfigKeysPage,
          { cursor, num_items: 400 },
        );
        for (const row of page.rows) {
          if (prev && prev.key === row.config_key) {
            const ids = dups.get(row.config_key) ?? [prev.id];
            ids.push(row.id);
            dups.set(row.config_key, ids);
          }
          prev = { key: row.config_key, id: row.id };
        }
        if (page.is_done) break;
        cursor = page.cursor;
      }
      for (const [key, ids] of dups) {
        dupConfigKeys.push({ config_key: key, ids });
      }
    }

    return {
      ok:
        makes.dup_groups.length === 0 &&
        makes.rows_missing_make_key === 0 &&
        orphans.length === 0,
      duplicate_make_groups: makes.dup_groups.length,
      rows_missing_make_key: makes.rows_missing_make_key,
      model_twins: makes.model_twins,
      orphan_refs: orphans,
      duplicate_config_keys: dupConfigKeys,
    };
  },
});
