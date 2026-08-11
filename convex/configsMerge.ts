/**
 * configsMerge.ts — duplicate vehicle_configs audit + merge migration (Aug 2026).
 *
 * A systematic snapshot double-import left 69 config_key values with FOUR
 * vehicle_configs rows each (verified on dev:third-bird-914 and
 * dev:ardent-crab-641 via makesMerge:audit → duplicate_config_keys). Children
 * (part_fitments, enrichment_runs, field_claims, …) are stamped under
 * whichever twin their creation path resolved, so reads that join by _id can
 * land on a bare twin while the enriched twin holds the data.
 *
 * Style/ledger identical to makesMerge.ts: every write is journaled into
 * make_merge_log (entity "vehicle_configs") under one batch_id so the whole
 * run is revertable. Creation-side guards (getOrCreate-by-config_key,
 * reconcileConfigForReenrich collision checks) already exist — this is the
 * data fix, not the guard.
 *
 * Everything is internal — run via CLI, per deployment, in this order:
 *
 *   0. npx convex run configsMerge:verify '{}'          (read-only BASELINE —
 *      records pre-existing orphans so post-merge diffs are attributable)
 *   1. npx convex run configsMerge:audit '{}'                    (read-only)
 *   2. npx convex run configsMerge:mergeConfigs '{"dry_run": true}'
 *   3. npx convex run configsMerge:mergeConfigs '{"dry_run": false}'
 *      → note the returned batch_id
 *   4. npx convex run configsMerge:restampScanTables \
 *        '{"batch_id": "...", "dry_run": false}'
 *      — the tables with no vehicle_config_id-leading index (snapshots,
 *        vin_queue, enrichment_run_steps, …) are re-stamped here via slim
 *        paged scans. enrichment_run_steps carries full request/response
 *        text, so its pages and patch chunks stay ≤12 docs to respect the
 *        16MiB transaction read limit (same rule as scrape_cache in
 *        makesMerge).
 *   5. npx convex run configsMerge:verify '{}'                   (read-only)
 *
 * Revert: npx convex run configsMerge:revertConfigsMerge '{"batch_id":"..."}'
 * — revives loser rows (NEW _ids; Convex cannot restore deleted ids),
 * re-points every journaled restamp whose FK still equals the canonical id,
 * and restores absorbed canonical fields. Scan-table restamps share the merge
 * batch_id, so one revert covers both phases.
 *
 * Merge mechanics per config_key (the mutation RE-RESOLVES rows by key inside
 * the transaction — duplicate groups are never addressed by cached _ids):
 * canonical = highest fill_rate, then enrichment_status "complete", then most
 * part_fitments, then oldest. Missing metadata is absorbed from losers
 * (na_role_keys / verified_fields are unioned), each loser is snapshotted
 * into make_merge_log and deleted.
 *
 * Children are DEDUPE-AWARE (verified via sampleKeyFitments: the import
 * cloned children too — all four twins carry field-identical part_fitments
 * sets). A loser child that is field-identical to a canonical-side child
 * (ignoring _id/_creationTime/vehicle_config_id and bookkeeping timestamps)
 * is snapshotted into make_merge_log (kind "dup_child") and DELETED — blind
 * re-stamping would stack 4× duplicate fitments/intervals/labor rows under
 * the canonical and corrupt quantity aggregation in the quote path. Only
 * children with no canonical equivalent are re-stamped. enrichment_runs and
 * mechanic_verifications are exempt (run history / audit trails are genuinely
 * per-twin and always re-stamped verbatim).
 *
 * NOTE: this file must live in the MAIN checkout — a `convex dev` watcher
 * deploys from there and reverts out-of-band pushes to third-bird-914.
 */
import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";

// ============================================================================
// FK maps — every table carrying a vehicle_configs reference. Verified against
// schema.ts (grep v.id("vehicle_configs")): 20 tables have an index whose
// FIRST field is vehicle_config_id (re-stamped inside the per-key merge
// transaction); 10 references have no config-leading index and are re-stamped
// by restampScanTables via full paged scans.
// ============================================================================

const CONFIG_REF_INDEXED: Array<{ table: string; index: string }> = [
  { table: "drivetrain_configs", index: "by_vehicle_config" },
  { table: "trim_specs", index: "by_vehicle_config" },
  { table: "refuted_fitments", index: "by_config" },
  { table: "part_fitments", index: "by_vehicle_config" },
  { table: "estimator_estimates", index: "by_config" },
  { table: "repairpal_endpoint_estimates", index: "by_config" },
  { table: "enrichment_runs", index: "by_vehicle_config" },
  { table: "mechanic_verifications", index: "by_vehicle_config" },
  { table: "config_service_exclusions", index: "by_config" },
  { table: "service_intervals", index: "by_vehicle_config" },
  { table: "labor_times", index: "by_vehicle_config" },
  { table: "labor_observations", index: "by_config_service" }, // prefix
  { table: "vehicles", index: "by_vehicle_config" },
  { table: "data_incident_configs", index: "by_config" },
  { table: "vehicle_facts", index: "by_vehicle_config" }, // prefix [config, topic]
  { table: "pricing_vehicle_assignments", index: "by_vehicle_config" },
  { table: "vehicle_recalls", index: "by_config" },
  { table: "config_reliability_signals", index: "by_config" },
  { table: "config_epa_economy", index: "by_config" },
  { table: "field_claims", index: "by_config" },
];

// page_size caps a single scan-query's read volume; chunk caps how many docs a
// single restamp mutation get()s. enrichment_run_steps rows carry full LLM
// request/response text → both stay at 12. service_vehicle_specs carries
// parts_required (v.any()) → kept small.
const CONFIG_REF_SCANS: Array<{
  table: string;
  field: string;
  page_size: number;
  chunk: number;
}> = [
  { table: "shop_part_preferences", field: "vehicle_config_id", page_size: 250, chunk: 250 },
  { table: "part_snapshots", field: "vehicle_config_id", page_size: 100, chunk: 100 },
  { table: "labor_quote_snapshots", field: "vehicle_config_id", page_size: 250, chunk: 250 },
  { table: "parts_quote_snapshots", field: "vehicle_config_id", page_size: 100, chunk: 100 },
  { table: "vin_queue", field: "vehicle_config_id", page_size: 250, chunk: 250 },
  { table: "service_vehicle_specs", field: "vehicle_config_id", page_size: 50, chunk: 50 },
  { table: "vehicle_facts_audit", field: "vehicle_config_id", page_size: 100, chunk: 100 },
  { table: "pricing_baselines", field: "anchor_vehicle_config_id", page_size: 250, chunk: 250 },
  { table: "vehicle_configs", field: "cloned_from_config_id", page_size: 100, chunk: 100 },
  { table: "enrichment_run_steps", field: "vehicle_config_id", page_size: 12, chunk: 12 },
];

/** Scalar fields the canonical row absorbs from losers when it lacks them.
 *  Enrichment bookkeeping (fill_rate, enrichment_status, last_enriched_at,
 *  confidence_avg, verification_count, enrichment_version) is deliberately
 *  NOT absorbed — the canonical's own run history must stay truthful. */
const CONFIG_ABSORB_FIELDS = [
  "nhtsa_vin_key",
  "generation_id",
  "trim_name",
  "trim_slug",
  "engine_id",
  "transmission_id",
  "drivetrain",
  "has_brake_pad_sensor",
  "brake_fluid_type",
  "brake_fluid_capacity_oz",
  "brake_system_type",
  "rotor_front_min_thickness_mm",
  "rotor_rear_min_thickness_mm",
  "rotor_front_nominal_thickness_mm",
  "rotor_rear_nominal_thickness_mm",
  "rotor_front_min_quality",
  "rotor_rear_min_quality",
  "rotor_min_source_url",
  "rotor_min_observed_label",
  "rotor_front_min_observed_label",
  "rotor_rear_min_observed_label",
  "ps_fluid_type",
  "ps_fluid_capacity_oz",
  "chassis_code",
  "image_url",
  "pricing_tier",
  "pricing_tier_source",
  "pricing_tier_set_at",
  "packages_available",
] as const;

/** Durable human/system confirmations — unioned across all twins. */
const CONFIG_UNION_FIELDS = ["na_role_keys", "verified_fields"] as const;

/** Tables whose rows are genuinely per-twin history — never deduped, always
 *  re-stamped verbatim onto the canonical. */
const DEDUPE_EXEMPT = new Set(["enrichment_runs", "mechanic_verifications"]);

/** Fields ignored when computing a child's dedupe signature. Everything else
 *  (part ids, quantities, specs, confidence, source arrays, …) must match
 *  exactly for a loser child to count as a clone of a canonical child. */
const SIG_IGNORED_FIELDS = new Set([
  "_id",
  "_creationTime",
  "vehicle_config_id",
  "created_at",
  "updated_at",
  "first_confirmed_at",
  "last_confirmed_at",
]);

/** Deterministic deep-stable stringify (sorted object keys). */
function stableStringify(x: unknown): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x);
  if (Array.isArray(x)) return `[${x.map(stableStringify).join(",")}]`;
  const keys = Object.keys(x as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((x as any)[k])}`)
    .join(",")}}`;
}

function childSignature(doc: Record<string, unknown>): string {
  const slim: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(doc)) {
    if (SIG_IGNORED_FIELDS.has(k)) continue;
    if (val === undefined) continue;
    slim[k] = val;
  }
  return stableStringify(slim);
}

const RESTAMP_WRITE_BUDGET = 5000; // stay far below the 8192-writes/tx cap
const DOC_IDS_CHUNK = 4000; // stay far below the 8192-item array cap

function present(x: unknown): boolean {
  return x !== null && x !== undefined && x !== "";
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

type PickRow = { doc: Doc<"vehicle_configs">; fitments: number };

/** Deterministic canonical pick: highest fill_rate, then
 *  enrichment_status === "complete", then most part_fitments, then oldest. */
function pickCanonicalConfig(rows: PickRow[]): PickRow {
  return [...rows].sort(
    (a, b) =>
      (b.doc.fill_rate ?? -1) - (a.doc.fill_rate ?? -1) ||
      (b.doc.enrichment_status === "complete" ? 1 : 0) -
        (a.doc.enrichment_status === "complete" ? 1 : 0) ||
      b.fitments - a.fitments ||
      a.doc._creationTime - b.doc._creationTime ||
      String(a.doc._id).localeCompare(String(b.doc._id)),
  )[0];
}

async function fitmentCount(
  ctx: { db: any },
  configId: Id<"vehicle_configs">,
): Promise<number> {
  const docs = await ctx.db
    .query("part_fitments")
    .withIndex("by_vehicle_config", (q: any) =>
      q.eq("vehicle_config_id", configId),
    )
    .collect();
  return docs.length;
}

async function collectIndexedRefs(
  ctx: { db: any },
  table: string,
  index: string,
  configId: Id<"vehicle_configs">,
): Promise<Array<{ _id: unknown }>> {
  return await ctx.db
    .query(table)
    .withIndex(index, (q: any) => q.eq("vehicle_config_id", configId))
    .collect();
}

// ============================================================================
// 1. configKeysPage — slim paged scan in by_config_key order so duplicate
//    keys land adjacent and the aggregating actions can stream.
// ============================================================================

export const configKeysPage = internalQuery({
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

/** Streams the full table once and returns every config_key that has ≥2 rows.
 *  Shared by audit / mergeConfigs / verify. */
async function streamDuplicateKeys(
  ctx: { runQuery: any },
): Promise<{ dupKeys: string[]; totalConfigs: number }> {
  const dupSet = new Set<string>();
  let prev: string | null = null;
  let totalConfigs = 0;
  let cursor: string | null = null;
  for (;;) {
    const page: any = await ctx.runQuery(internal.configsMerge.configKeysPage, {
      cursor,
      num_items: 400,
    });
    for (const row of page.rows) {
      totalConfigs++;
      if (prev !== null && prev === row.config_key) dupSet.add(row.config_key);
      prev = row.config_key;
    }
    if (page.is_done) break;
    cursor = page.cursor;
  }
  return { dupKeys: [...dupSet], totalConfigs };
}

// ============================================================================
// 2. auditKey / pickKey — per-group detail + canonical-pick preview
// ============================================================================

export const auditKey = internalQuery({
  args: { config_key: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_config_key", (q) => q.eq("config_key", args.config_key))
      .collect();
    const pickRows: PickRow[] = [];
    for (const doc of rows) {
      pickRows.push({ doc, fitments: await fitmentCount(ctx, doc._id) });
    }
    const canonical = rows.length ? pickCanonicalConfig(pickRows) : null;

    const rowReports = [];
    for (const pr of pickRows) {
      const refs: Record<string, number> = {};
      let total = 0;
      for (const t of CONFIG_REF_INDEXED) {
        const docs =
          t.table === "part_fitments"
            ? new Array(pr.fitments) // already counted for the pick
            : await collectIndexedRefs(ctx, t.table, t.index, pr.doc._id);
        if (docs.length) refs[t.table] = docs.length;
        total += docs.length;
      }
      rowReports.push({
        id: String(pr.doc._id),
        fill_rate: pr.doc.fill_rate ?? null,
        enrichment_status: pr.doc.enrichment_status ?? null,
        part_fitments: pr.fitments,
        creation_time: pr.doc._creationTime,
        is_canonical_pick: canonical !== null && pr.doc._id === canonical.doc._id,
        total_indexed_refs: total,
        refs,
      });
    }
    return { config_key: args.config_key, rows: rowReports };
  },
});

export const pickKey = internalQuery({
  args: { config_key: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_config_key", (q) => q.eq("config_key", args.config_key))
      .collect();
    if (rows.length < 2) return { canonical_id: null, loser_ids: [] };
    const pickRows: PickRow[] = [];
    for (const doc of rows) {
      pickRows.push({ doc, fitments: await fitmentCount(ctx, doc._id) });
    }
    const canonical = pickCanonicalConfig(pickRows);
    return {
      canonical_id: String(canonical.doc._id),
      loser_ids: rows
        .filter((r) => r._id !== canonical.doc._id)
        .map((r) => String(r._id)),
    };
  },
});

/** Read-only sampling: per twin, the identifying tuple of every part_fitment
 *  — answers whether loser fitments are exact copies of the canonical's
 *  (restamp would stack duplicates) or complementary (restamp consolidates). */
export const sampleKeyFitments = internalQuery({
  args: { config_key: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_config_key", (q) => q.eq("config_key", args.config_key))
      .collect();
    const out = [];
    for (const cfg of rows) {
      const fits = await ctx.db
        .query("part_fitments")
        .withIndex("by_vehicle_config", (q) =>
          q.eq("vehicle_config_id", cfg._id),
        )
        .collect();
      out.push({
        config_id: String(cfg._id),
        fill_rate: cfg.fill_rate ?? null,
        fitments: fits.map((f) => ({
          part_id: String(f.part_id),
          service_type: f.service_type ?? null,
          position: f.position ?? null,
          package_code: f.package_code ?? null,
          service_role: f.service_role ?? null,
          quantity_needed: f.quantity_needed ?? null,
        })),
      });
    }
    return { config_key: args.config_key, rows: out };
  },
});

// ============================================================================
// 3. audit — the full read-only report
// ============================================================================

export const audit = internalAction({
  args: {},
  handler: async (ctx): Promise<Record<string, unknown>> => {
    const { dupKeys, totalConfigs } = await streamDuplicateKeys(ctx);
    const groups: any[] = [];
    for (const key of dupKeys.sort()) {
      groups.push(await ctx.runQuery(internal.configsMerge.auditKey, {
        config_key: key,
      }));
    }
    return {
      vehicle_configs_total: totalConfigs,
      duplicate_config_keys: dupKeys.length,
      groups,
    };
  },
});

// ============================================================================
// 4. mergeConfigKey — one config_key group merged in ONE transaction.
//    Rows are re-resolved by key inside the tx (never by cached _ids — a
//    prior session's twin deletion mid-flight is the reason this rule exists).
// ============================================================================

export const mergeConfigKey = internalMutation({
  args: {
    config_key: v.string(),
    dry_run: v.boolean(),
    batch_id: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const rows = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_config_key", (q) => q.eq("config_key", args.config_key))
      .collect();
    if (rows.length < 2) {
      return { config_key: args.config_key, skipped: true, rows: rows.length };
    }

    const pickRows: PickRow[] = [];
    for (const doc of rows) {
      pickRows.push({ doc, fitments: await fitmentCount(ctx, doc._id) });
    }
    const canonical = pickCanonicalConfig(pickRows).doc;
    const losers = rows.filter((r) => r._id !== canonical._id);

    // ---- Plan phase (reads only) so the write budget is enforced up front.
    // Canonical-side child signatures per non-exempt table. This is a RUNNING
    // set: a loser child promoted onto the canonical adds its signature, so an
    // identical child of a LATER loser still dedupes instead of surviving as a
    // pair of clones.
    const canonicalSigs = new Map<string, Set<string>>();
    for (const t of CONFIG_REF_INDEXED) {
      if (DEDUPE_EXEMPT.has(t.table)) continue;
      const docs = await collectIndexedRefs(
        ctx,
        t.table,
        t.index,
        canonical._id,
      );
      canonicalSigs.set(
        t.table,
        new Set(docs.map((d) => childSignature(d as any))),
      );
    }

    type LoserPlan = {
      loser: Doc<"vehicle_configs">;
      perTable: Array<{
        table: string;
        restampIds: string[];
        dupDocs: Array<Record<string, unknown>>;
      }>;
    };
    const loserPlans: LoserPlan[] = [];
    let totalRestamps = 0;
    let totalDups = 0;
    for (const loser of losers) {
      const perTable: LoserPlan["perTable"] = [];
      for (const t of CONFIG_REF_INDEXED) {
        const docs = await collectIndexedRefs(ctx, t.table, t.index, loser._id);
        const restampIds: string[] = [];
        const dupDocs: Array<Record<string, unknown>> = [];
        const sigs = canonicalSigs.get(t.table); // undefined ⇒ exempt table
        for (const d of docs) {
          const sig = sigs ? childSignature(d as any) : null;
          if (sig !== null && sigs!.has(sig)) {
            dupDocs.push(d as any);
          } else {
            restampIds.push(String((d as any)._id));
            if (sig !== null) sigs!.add(sig);
          }
        }
        perTable.push({ table: t.table, restampIds, dupDocs });
        totalRestamps += restampIds.length;
        totalDups += dupDocs.length;
      }
      loserPlans.push({ loser, perTable });
    }
    if (totalRestamps + totalDups > RESTAMP_WRITE_BUDGET) {
      throw new Error(
        `mergeConfigKey(${args.config_key}) would touch ${totalRestamps + totalDups} child docs — over the single-transaction budget (${RESTAMP_WRITE_BUDGET}). Pre-stamp this key via collectRefsByIndexPage + restampDocsByIds, then retry.`,
      );
    }

    // Absorb: scalars canonical lacks; union arrays across all twins.
    const absorb: Record<string, unknown> = {};
    const before: Record<string, unknown> = {};
    for (const f of CONFIG_ABSORB_FIELDS) {
      if (present((canonical as any)[f])) continue;
      const donor = losers.find((l) => present((l as any)[f]));
      if (donor) {
        absorb[f] = (donor as any)[f];
        before[f] = (canonical as any)[f] ?? null;
      }
    }
    for (const f of CONFIG_UNION_FIELDS) {
      const merged = [
        ...new Set(
          [canonical, ...losers].flatMap(
            (r) => ((r as any)[f] ?? []) as string[],
          ),
        ),
      ];
      const cur = ((canonical as any)[f] ?? []) as string[];
      if (merged.length > cur.length) {
        absorb[f] = merged;
        before[f] = (canonical as any)[f] ?? null;
      }
    }

    const restampCounts: Record<string, number> = {};
    const dedupeCounts: Record<string, number> = {};
    for (const lp of loserPlans) {
      for (const t of lp.perTable) {
        if (t.restampIds.length) {
          restampCounts[t.table] =
            (restampCounts[t.table] ?? 0) + t.restampIds.length;
        }
        if (t.dupDocs.length) {
          dedupeCounts[t.table] =
            (dedupeCounts[t.table] ?? 0) + t.dupDocs.length;
        }
      }
    }

    if (!args.dry_run) {
      for (const lp of loserPlans) {
        for (const t of lp.perTable) {
          for (const id of t.restampIds) {
            await ctx.db.patch(id as Id<any>, {
              vehicle_config_id: canonical._id,
            });
          }
          for (const ids of chunk(t.restampIds, DOC_IDS_CHUNK)) {
            await ctx.db.insert("make_merge_log", {
              batch_id: args.batch_id,
              entity: "vehicle_configs",
              kind: "restamp",
              entity_key: args.config_key,
              canonical_id: String(canonical._id),
              loser_id: String(lp.loser._id),
              table: t.table,
              field: "vehicle_config_id",
              doc_ids: ids,
              count: ids.length,
              created_at: now,
            });
          }
          // Clone children: snapshot + delete. Revert revives them under the
          // revived loser's new id.
          for (const dup of t.dupDocs) {
            await ctx.db.insert("make_merge_log", {
              batch_id: args.batch_id,
              entity: "vehicle_configs",
              kind: "dup_child",
              entity_key: args.config_key,
              canonical_id: String(canonical._id),
              loser_id: String(lp.loser._id),
              table: t.table,
              field: "vehicle_config_id",
              loser_snapshot: { ...dup },
              created_at: now,
            });
            await ctx.db.delete((dup as any)._id);
          }
        }
        await ctx.db.insert("make_merge_log", {
          batch_id: args.batch_id,
          entity: "vehicle_configs",
          kind: "loser",
          entity_key: args.config_key,
          canonical_id: String(canonical._id),
          loser_id: String(lp.loser._id),
          loser_snapshot: { ...lp.loser },
          created_at: now,
        });
        await ctx.db.delete(lp.loser._id);
      }

      if (Object.keys(absorb).length) {
        await ctx.db.insert("make_merge_log", {
          batch_id: args.batch_id,
          entity: "vehicle_configs",
          kind: "canonical_patch",
          entity_key: args.config_key,
          canonical_id: String(canonical._id),
          patch_before: before,
          created_at: now,
        });
        await ctx.db.patch(canonical._id, absorb as any);
      }
    }

    return {
      config_key: args.config_key,
      skipped: false,
      canonical: {
        id: String(canonical._id),
        fill_rate: canonical.fill_rate ?? null,
        enrichment_status: canonical.enrichment_status ?? null,
      },
      losers: losers.map((l) => ({
        id: String(l._id),
        fill_rate: l.fill_rate ?? null,
        enrichment_status: l.enrichment_status ?? null,
      })),
      pairs: losers.map((l) => ({
        from: String(l._id),
        to: String(canonical._id),
      })),
      restamps: restampCounts,
      deduped: dedupeCounts,
      total_restamps: totalRestamps,
      total_deduped: totalDups,
      absorbed_fields: Object.keys(absorb),
    };
  },
});

// ============================================================================
// 5. Escape hatch for a key whose children exceed the per-tx write budget:
//    slim-page its refs, pre-stamp them in chunks, then retry mergeConfigKey.
// ============================================================================

export const collectRefsByIndexPage = internalQuery({
  args: {
    table: v.string(),
    index: v.string(),
    config_id: v.string(),
    cursor: v.union(v.string(), v.null()),
    num_items: v.number(),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query(args.table as any)
      .withIndex(args.index as any, (q: any) =>
        q.eq("vehicle_config_id", args.config_id as Id<"vehicle_configs">),
      )
      .paginate({ cursor: args.cursor, numItems: args.num_items });
    return {
      ids: page.page.map((d: any) => String(d._id)),
      cursor: page.continueCursor,
      is_done: page.isDone,
    };
  },
});

/** Same contract as makesMerge.restampDocsByIds: patches only docs whose
 *  current FK value matches a mapping's `from`; journals per-pair restamp
 *  rows so revertConfigsMerge can replay them. */
export const restampDocsByIds = internalMutation({
  args: {
    batch_id: v.string(),
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
          entity: "vehicle_configs",
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

// ============================================================================
// 6. mergeConfigs — the orchestrating action. Streams duplicate keys and
//    merges each in its own transaction (key-level atomicity; cross-key
//    atomicity is not needed). Budget-overflow keys fall back to chunked
//    pre-stamping, then retry.
// ============================================================================

export const mergeConfigs = internalAction({
  args: {
    dry_run: v.boolean(),
    only_keys: v.optional(v.array(v.string())),
    max_keys: v.optional(v.number()),
    batch_id: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const batchId = args.batch_id ?? `configs_merge_${Date.now()}`;
    const { dupKeys } = await streamDuplicateKeys(ctx);
    let keys = dupKeys.sort();
    if (args.only_keys?.length) {
      const onlySet = new Set(args.only_keys);
      keys = keys.filter((k) => onlySet.has(k));
    }
    const remaining =
      args.max_keys !== undefined ? keys.slice(args.max_keys) : [];
    if (args.max_keys !== undefined) keys = keys.slice(0, args.max_keys);

    const groups: any[] = [];
    const failed: Array<{ config_key: string; error: string }> = [];
    let totalRestamps = 0;
    let totalDeduped = 0;
    for (const key of keys) {
      try {
        let res: any;
        try {
          res = await ctx.runMutation(internal.configsMerge.mergeConfigKey, {
            config_key: key,
            dry_run: args.dry_run,
            batch_id: batchId,
          });
        } catch (e: any) {
          if (!String(e?.message ?? e).includes("over the single-transaction budget")) {
            throw e;
          }
          // Budget overflow: pre-stamp this key's indexed refs in chunks,
          // then retry the (now small) transactional merge. The pick is
          // stable under pre-stamping — moving children onto the intended
          // canonical only reinforces the fitment-count tiebreak.
          const pick: any = await ctx.runQuery(internal.configsMerge.pickKey, {
            config_key: key,
          });
          if (!pick.canonical_id) throw e;
          if (args.dry_run) {
            groups.push({
              config_key: key,
              skipped: false,
              over_budget: true,
              canonical: { id: pick.canonical_id },
              losers: pick.loser_ids.map((id: string) => ({ id })),
            });
            continue;
          }
          const mapping = pick.loser_ids.map((id: string) => ({
            from: id,
            to: pick.canonical_id,
          }));
          for (const loserId of pick.loser_ids) {
            for (const t of CONFIG_REF_INDEXED) {
              let cursor: string | null = null;
              for (;;) {
                const page: any = await ctx.runQuery(
                  internal.configsMerge.collectRefsByIndexPage,
                  {
                    table: t.table,
                    index: t.index,
                    config_id: loserId,
                    cursor,
                    num_items: 50,
                  },
                );
                if (page.ids.length) {
                  await ctx.runMutation(
                    internal.configsMerge.restampDocsByIds,
                    {
                      batch_id: batchId,
                      table: t.table,
                      field: "vehicle_config_id",
                      mapping,
                      doc_ids: page.ids,
                    },
                  );
                }
                if (page.is_done) break;
                cursor = page.cursor;
              }
            }
          }
          res = await ctx.runMutation(internal.configsMerge.mergeConfigKey, {
            config_key: key,
            dry_run: args.dry_run,
            batch_id: batchId,
          });
          res.over_budget_prestamped = true;
        }
        groups.push(res);
        totalRestamps += res.total_restamps ?? 0;
        totalDeduped += res.total_deduped ?? 0;
      } catch (e: any) {
        failed.push({ config_key: key, error: String(e?.message ?? e) });
      }
    }

    return {
      batch_id: batchId,
      dry_run: args.dry_run,
      keys_processed: keys.length,
      merged: groups.filter((g) => !g.skipped).length,
      skipped: groups.filter((g) => g.skipped).length,
      total_indexed_restamps: totalRestamps,
      total_deduped_children: totalDeduped,
      failed,
      remaining_keys: remaining,
      groups,
      next_step: args.dry_run
        ? "re-run with dry_run:false"
        : `npx convex run configsMerge:restampScanTables '{"batch_id":"${batchId}","dry_run":false}'`,
    };
  },
});

// ============================================================================
// 7. restampScanTables — the tables with no vehicle_config_id-leading index.
//    Mapping comes from the batch's journaled loser rows (or, for a dry run
//    without a live batch, from pickKey previews). Slim paged scans; per-table
//    page/chunk sizes respect the 16MiB read limit (enrichment_run_steps ≤12).
// ============================================================================

export const logMappingForBatch = internalQuery({
  args: { batch_id: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("make_merge_log")
      .withIndex("by_batch", (q) => q.eq("batch_id", args.batch_id))
      .collect();
    const pairs: Array<{ from: string; to: string }> = [];
    for (const r of rows) {
      if (r.kind === "loser" && r.entity === "vehicle_configs" && r.loser_id) {
        pairs.push({ from: r.loser_id, to: r.canonical_id });
      }
    }
    return { pairs };
  },
});

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

export const restampScanTables = internalAction({
  args: {
    batch_id: v.optional(v.string()),
    dry_run: v.boolean(),
    tables: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    let pairs: Array<{ from: string; to: string }> = [];
    if (args.batch_id) {
      const m: any = await ctx.runQuery(
        internal.configsMerge.logMappingForBatch,
        { batch_id: args.batch_id },
      );
      pairs = m.pairs;
    } else {
      if (!args.dry_run) {
        throw new Error(
          "restampScanTables without batch_id is preview-only — pass the batch_id from mergeConfigs for a live run.",
        );
      }
      const { dupKeys } = await streamDuplicateKeys(ctx);
      for (const key of dupKeys) {
        const pick: any = await ctx.runQuery(internal.configsMerge.pickKey, {
          config_key: key,
        });
        if (!pick.canonical_id) continue;
        for (const id of pick.loser_ids) {
          pairs.push({ from: id, to: pick.canonical_id });
        }
      }
    }
    if (!pairs.length) {
      return { pairs: 0, note: "no loser→canonical pairs found", tables: {} };
    }
    const fromSet = new Set(pairs.map((p) => p.from));
    const scans = CONFIG_REF_SCANS.filter(
      (s) => !args.tables || args.tables.includes(s.table),
    );

    const perTable: Record<string, unknown> = {};
    await Promise.all(
      scans.map(async (scan) => {
        const affected: string[] = [];
        let scanned = 0;
        let cursor: string | null = null;
        for (;;) {
          const page: any = await ctx.runQuery(
            internal.configsMerge.scanRefsPage,
            {
              table: scan.table,
              fk_fields: [scan.field],
              cursor,
              num_items: scan.page_size,
            },
          );
          for (const row of page.rows) {
            scanned++;
            const val = row.fks[scan.field];
            if (val && fromSet.has(val)) affected.push(row.id);
          }
          if (page.is_done) break;
          cursor = page.cursor;
        }
        if (args.dry_run) {
          perTable[scan.table] = { scanned, would_restamp: affected.length };
          return;
        }
        let patched = 0;
        for (const ids of chunk(affected, scan.chunk)) {
          const res: any = await ctx.runMutation(
            internal.configsMerge.restampDocsByIds,
            {
              batch_id: args.batch_id!,
              table: scan.table,
              field: scan.field,
              mapping: pairs,
              doc_ids: ids,
            },
          );
          patched += res.patched;
        }
        perTable[scan.table] = { scanned, restamped: patched };
      }),
    );

    return {
      batch_id: args.batch_id ?? null,
      dry_run: args.dry_run,
      pairs: pairs.length,
      tables: perTable,
    };
  },
});

// ============================================================================
// 8. verify — read-only invariants:
//    (a) zero duplicate config_key values
//    (b) no doc in any of the 30 references points at a nonexistent config
//    Run BEFORE the merge too — pre-existing orphans (earlier ad-hoc twin
//    deletions) must not be attributed to this migration.
// ============================================================================

const VERIFY_SCANS: Array<{ table: string; fks: string[]; page_size: number }> =
  [
    { table: "drivetrain_configs", fks: ["vehicle_config_id"], page_size: 250 },
    { table: "trim_specs", fks: ["vehicle_config_id"], page_size: 250 },
    { table: "refuted_fitments", fks: ["vehicle_config_id"], page_size: 250 },
    { table: "part_fitments", fks: ["vehicle_config_id"], page_size: 250 },
    { table: "estimator_estimates", fks: ["vehicle_config_id"], page_size: 250 },
    {
      table: "repairpal_endpoint_estimates",
      fks: ["vehicle_config_id"],
      page_size: 250,
    },
    { table: "enrichment_runs", fks: ["vehicle_config_id"], page_size: 50 },
    {
      table: "mechanic_verifications",
      fks: ["vehicle_config_id"],
      page_size: 250,
    },
    {
      table: "config_service_exclusions",
      fks: ["vehicle_config_id"],
      page_size: 250,
    },
    { table: "service_intervals", fks: ["vehicle_config_id"], page_size: 250 },
    { table: "labor_times", fks: ["vehicle_config_id"], page_size: 250 },
    { table: "labor_observations", fks: ["vehicle_config_id"], page_size: 250 },
    { table: "vehicles", fks: ["vehicle_config_id"], page_size: 250 },
    {
      table: "data_incident_configs",
      fks: ["vehicle_config_id"],
      page_size: 250,
    },
    { table: "vehicle_facts", fks: ["vehicle_config_id"], page_size: 100 },
    {
      table: "pricing_vehicle_assignments",
      fks: ["vehicle_config_id"],
      page_size: 250,
    },
    { table: "vehicle_recalls", fks: ["vehicle_config_id"], page_size: 250 },
    {
      table: "config_reliability_signals",
      fks: ["vehicle_config_id"],
      page_size: 250,
    },
    { table: "config_epa_economy", fks: ["vehicle_config_id"], page_size: 250 },
    { table: "field_claims", fks: ["vehicle_config_id"], page_size: 250 },
    {
      table: "shop_part_preferences",
      fks: ["vehicle_config_id"],
      page_size: 250,
    },
    { table: "part_snapshots", fks: ["vehicle_config_id"], page_size: 100 },
    {
      table: "labor_quote_snapshots",
      fks: ["vehicle_config_id"],
      page_size: 250,
    },
    {
      table: "parts_quote_snapshots",
      fks: ["vehicle_config_id"],
      page_size: 100,
    },
    { table: "vin_queue", fks: ["vehicle_config_id"], page_size: 250 },
    {
      table: "service_vehicle_specs",
      fks: ["vehicle_config_id"],
      page_size: 50,
    },
    { table: "vehicle_facts_audit", fks: ["vehicle_config_id"], page_size: 100 },
    {
      table: "pricing_baselines",
      fks: ["anchor_vehicle_config_id"],
      page_size: 250,
    },
    { table: "vehicle_configs", fks: ["cloned_from_config_id"], page_size: 100 },
    // Full request/response LLM text per row — pages must stay ≤12.
    { table: "enrichment_run_steps", fks: ["vehicle_config_id"], page_size: 12 },
  ];

export const verify = internalAction({
  args: {},
  handler: async (ctx): Promise<Record<string, unknown>> => {
    // Live config ids + duplicate keys in one slim stream.
    const liveConfigIds = new Set<string>();
    const dups = new Map<string, string[]>();
    let prev: { key: string; id: string } | null = null;
    let cursor: string | null = null;
    for (;;) {
      const page: any = await ctx.runQuery(
        internal.configsMerge.configKeysPage,
        { cursor, num_items: 400 },
      );
      for (const row of page.rows) {
        liveConfigIds.add(row.id);
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

    const orphans: Array<{
      table: string;
      field: string;
      count: number;
      sample: string[];
    }> = [];
    await Promise.all(
      VERIFY_SCANS.map(async (scan) => {
        const counts = new Map<string, { count: number; sample: string[] }>();
        let c: string | null = null;
        for (;;) {
          const page: any = await ctx.runQuery(
            internal.configsMerge.scanRefsPage,
            {
              table: scan.table,
              fk_fields: scan.fks,
              cursor: c,
              num_items: scan.page_size,
            },
          );
          for (const row of page.rows) {
            for (const f of scan.fks) {
              const val = row.fks[f];
              if (val == null) continue;
              if (!liveConfigIds.has(val)) {
                const cc = counts.get(f) ?? { count: 0, sample: [] };
                cc.count++;
                if (cc.sample.length < 10) cc.sample.push(row.id);
                counts.set(f, cc);
              }
            }
          }
          if (page.is_done) break;
          c = page.cursor;
        }
        for (const [field, cc] of counts) {
          orphans.push({
            table: scan.table,
            field,
            count: cc.count,
            sample: cc.sample,
          });
        }
      }),
    );

    return {
      ok: dups.size === 0 && orphans.length === 0,
      vehicle_configs_total: liveConfigIds.size,
      duplicate_config_keys: [...dups.entries()].map(([config_key, ids]) => ({
        config_key,
        ids,
      })),
      orphan_refs: orphans.sort((a, b) => b.count - a.count),
    };
  },
});

// ============================================================================
// 9. revertConfigsMerge — replay a batch backwards from make_merge_log.
//    kinds/tables filters allow chunked reverts if a batch is too large for
//    one transaction (fat enrichment_run_steps docs are get()-read fully).
// ============================================================================

export const revertConfigsMerge = internalMutation({
  args: {
    batch_id: v.string(),
    kinds: v.optional(v.array(v.string())),
    tables: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("make_merge_log")
      .withIndex("by_batch", (q) => q.eq("batch_id", args.batch_id))
      .collect();
    if (!rows.length) throw new Error(`no log rows for batch ${args.batch_id}`);
    const wrongEntity = rows.find((r) => r.entity !== "vehicle_configs");
    if (wrongEntity) {
      throw new Error(
        `batch ${args.batch_id} contains entity "${wrongEntity.entity}" rows — use makesMerge:revertMerge for makes/models batches.`,
      );
    }
    const now = Date.now();
    const wantKind = (k: string) => !args.kinds || args.kinds.includes(k);

    // 1) Revive losers (new _ids — Convex cannot restore deleted ids).
    const idMap = new Map<string, string>();
    let revived = 0;
    if (wantKind("loser")) {
      for (const lr of rows.filter(
        (r) => r.kind === "loser" && !r.reverted_at,
      )) {
        const snap = { ...(lr.loser_snapshot as Record<string, unknown>) };
        delete snap._id;
        delete snap._creationTime;
        const newId = await ctx.db.insert("vehicle_configs", snap as any);
        idMap.set(lr.loser_id!, String(newId));
        await ctx.db.patch(lr._id, { reverted_at: now });
        revived++;
      }
    }

    const priorRevivals = new Map<string, string>();
    for (const lr of rows.filter((r) => r.kind === "loser" && r.reverted_at)) {
      if (lr.loser_id && lr.revived_as) {
        priorRevivals.set(lr.loser_id, lr.revived_as);
      }
    }
    const revivedIdFor = (loserId: string | undefined) =>
      loserId ? (idMap.get(loserId) ?? priorRevivals.get(loserId)) : undefined;

    // 1b) Revive deduped clone children under the revived loser's new id.
    //     Children whose loser was not revived in this or a prior call are
    //     left in the log un-reverted (re-run with kinds:["dup_child"] after
    //     reviving losers).
    let childrenRevived = 0;
    let childrenSkipped = 0;
    if (wantKind("dup_child")) {
      for (const dc of rows.filter(
        (r) =>
          r.kind === "dup_child" &&
          !r.reverted_at &&
          (!args.tables || args.tables.includes(r.table!)),
      )) {
        const newLoserId = revivedIdFor(dc.loser_id ?? undefined);
        if (!newLoserId) {
          childrenSkipped++;
          continue;
        }
        const snap = { ...(dc.loser_snapshot as Record<string, unknown>) };
        delete snap._id;
        delete snap._creationTime;
        snap.vehicle_config_id = newLoserId;
        await ctx.db.insert(dc.table as any, snap as any);
        await ctx.db.patch(dc._id, { reverted_at: now });
        childrenRevived++;
      }
    }

    // 2) Re-point restamped docs back to the revived rows. Docs whose FK no
    //    longer points at the merge's canonical (someone changed them since)
    //    are skipped, not clobbered. Restamp rows for a loser revived in an
    //    EARLIER chunked call still resolve via its logged new id.
    let repointed = 0;
    let skipped = 0;
    if (wantKind("restamp")) {
      for (const rr of rows.filter(
        (r) =>
          r.kind === "restamp" &&
          !r.reverted_at &&
          (!args.tables || args.tables.includes(r.table!)),
      )) {
        const newLoserId =
          idMap.get(rr.loser_id!) ?? priorRevivals.get(rr.loser_id!);
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
    }

    // 3) Restore canonical rows' absorbed fields (null → remove).
    let canonicalsRestored = 0;
    if (wantKind("canonical_patch")) {
      for (const cp of rows.filter(
        (r) => r.kind === "canonical_patch" && !r.reverted_at,
      )) {
        const beforeVals = (cp.patch_before ?? {}) as Record<string, unknown>;
        const patch: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(beforeVals)) {
          patch[k] = val === null ? undefined : val;
        }
        const canonicalDoc = await ctx.db.get(
          cp.canonical_id as Id<"vehicle_configs">,
        );
        if (canonicalDoc && Object.keys(patch).length) {
          await ctx.db.patch(
            cp.canonical_id as Id<"vehicle_configs">,
            patch as any,
          );
          canonicalsRestored++;
        }
        await ctx.db.patch(cp._id, { reverted_at: now });
      }
    }

    // Persist loser_id → revived id so chunked follow-up calls can re-point
    // restamps journaled for losers revived in this call.
    for (const [loserId, newId] of idMap) {
      const lr = rows.find((r) => r.kind === "loser" && r.loser_id === loserId);
      if (lr) await ctx.db.patch(lr._id, { revived_as: newId });
    }

    return {
      batch_id: args.batch_id,
      revived,
      new_ids: Object.fromEntries(idMap.entries()),
      children_revived: childrenRevived,
      children_skipped: childrenSkipped,
      repointed,
      skipped,
      canonicals_restored: canonicalsRestored,
    };
  },
});
