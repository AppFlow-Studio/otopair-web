/**
 * orphanRepair.ts — pre-configsMerge orphaned-children repair (Aug 2026).
 *
 * configsMerge:verify reports 77 child docs whose vehicle_config_id points at
 * vehicle_configs rows that no longer exist — identically on dev:third-bird-914
 * and dev:ardent-crab-641 (labor_times 27, service_intervals 27, part_fitments
 * 18, enrichment_runs 3, drivetrain_configs 1, trim_specs 1). They PRE-DATE the
 * Aug 2026 configsMerge migration (identical before/after baselines) and stem
 * from earlier ad-hoc twin deletions (e.g. the heal-rung session's mid-flight
 * twin delete), so the dead ids have no make_merge_log loser rows to consult.
 *
 * Per-cluster disposition is decided by a HUMAN from the audit report and
 * passed explicitly to `repair` — the mutations never guess:
 *   - attach: the dead twin's config_key is derivable (enrichment_run step
 *     prompts, part-fitment siblings, ledger hits). Children move to the config
 *     that owns that key TODAY — re-resolved by key inside the transaction,
 *     never by a cached _id (heal-rung rule). Re-attachment is dedupe-aware
 *     like mergeConfigKey: an orphan whose semantic key already exists on the
 *     owner (labor_times/service_intervals: service_id; part_fitments:
 *     part_id+service_type+position+package_code; drivetrain_configs/
 *     trim_specs: one-per-config) is snapshotted and DELETED
 *     ("orphan_dup_child") — blind restamping would double labor rows and
 *     corrupt quote aggregation. enrichment_runs are per-twin history and
 *     always restamp verbatim (same exemption as configsMerge).
 *     drop_doc_ids carves per-doc exceptions out of an attach: rows that are
 *     provably NOT this vehicle's data (wrong-generation part fitments from
 *     the pre-hardening pipeline, rows keyed to service_ids that no longer
 *     exist) are snapshotted + deleted ("orphan_delete") instead of restamped
 *     — re-attaching them would inject wrong parts / dangling-service rows
 *     into a live config's quote path.
 *   - delete: identity underivable. Every doc is snapshotted into
 *     make_merge_log ("orphan_delete") before deletion; deleting an
 *     enrichment_run cascades its enrichment_run_steps (required FK) with
 *     snapshots. Optional run-provenance refs elsewhere are left dangling —
 *     verify does not track them and provenance rows outlive runs by design.
 *
 * Ledger: make_merge_log, entity "vehicle_configs", kinds "orphan_restamp" |
 * "orphan_dup_child" | "orphan_delete" under one batch_id. Kinds are disjoint
 * from configsMerge's, so revertConfigsMerge on an orphan batch is a no-op and
 * revertRepair refuses non-orphan batches.
 *
 * Runbook (per deployment; ardent-crab-641 via --env-file with its deploy key):
 *   1. npx convex run orphanRepair:audit '{}'                     (read-only)
 *   2. decide per dead id: attach (with expected config_key) or delete
 *   3. npx convex run orphanRepair:repair '{"dry_run":true,
 *        "attach":[{"dead_id":"...","config_key":"..."}],"delete_ids":[...]}'
 *   4. same with dry_run:false → note batch_id
 *   5. npx convex run configsMerge:verify '{}'   → ok:true, zero orphan_refs
 *
 * Revert: npx convex run orphanRepair:revertRepair '{"batch_id":"..."}' —
 * re-inserts snapshots (NEW _ids; deleted runs' steps are remapped to the
 * revived run id) and re-points restamped docs back at the dead id, restoring
 * the pre-repair orphan state.
 *
 * NOTE: lives in the MAIN checkout — the `convex dev` watcher deploys from
 * there and reverts out-of-band pushes to third-bird-914 (configsMerge rule).
 */
import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

// ============================================================================
// The 6 tables holding the 77 baseline orphans. All carry a
// vehicle_config_id-leading index, so cluster repair reads only its own docs.
// Page sizes mirror configsMerge.VERIFY_SCANS (enrichment_runs rows are fat).
// ============================================================================

const ORPHAN_TABLES: Array<{
  table: string;
  index: string;
  page_size: number;
}> = [
  { table: "labor_times", index: "by_vehicle_config", page_size: 250 },
  { table: "service_intervals", index: "by_vehicle_config", page_size: 250 },
  { table: "part_fitments", index: "by_vehicle_config", page_size: 250 },
  { table: "enrichment_runs", index: "by_vehicle_config", page_size: 50 },
  { table: "drivetrain_configs", index: "by_vehicle_config", page_size: 250 },
  { table: "trim_specs", index: "by_vehicle_config", page_size: 250 },
];

/** Semantic dedupe key per table — what makes an orphan child REDUNDANT when
 *  the owner already has a row for it. null ⇒ never deduped (run history). */
function semanticKey(table: string, doc: Record<string, unknown>): string | null {
  switch (table) {
    case "labor_times":
    case "service_intervals":
      return `svc:${String(doc.service_id)}`;
    case "part_fitments":
      return [
        String(doc.part_id),
        String(doc.service_type ?? ""),
        String(doc.position ?? ""),
        String(doc.package_code ?? ""),
      ].join("|");
    case "drivetrain_configs":
    case "trim_specs":
      return "singleton"; // one spec row per config
    case "enrichment_runs":
      return null;
    default:
      throw new Error(`semanticKey: unexpected table ${table}`);
  }
}

/** Same exact-clone signature as configsMerge.childSignature. */
const SIG_IGNORED_FIELDS = new Set([
  "_id",
  "_creationTime",
  "vehicle_config_id",
  "created_at",
  "updated_at",
  "first_confirmed_at",
  "last_confirmed_at",
]);

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

// ============================================================================
// Slim internal queries the audit/repair actions compose. Discovery reuses
// configsMerge.configKeysPage + configsMerge.scanRefsPage.
// ============================================================================

export const getDocsByIds = internalQuery({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, args) => {
    const out: Array<Record<string, unknown>> = [];
    for (const id of args.ids) {
      const d = await ctx.db.get(id as Id<any>);
      if (d) out.push(d as any);
    }
    return out;
  },
});

/** make_merge_log slim pager — lets the audit check whether a dead id was ever
 *  a ledgered loser (it would carry entity_key = config_key). Snapshots are
 *  not projected; page size keeps fat dup_child rows within read limits. */
export const mergeLogPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), num_items: v.number() },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("make_merge_log")
      .paginate({ cursor: args.cursor, numItems: args.num_items });
    return {
      rows: page.page.map((r) => ({
        id: String(r._id),
        batch_id: r.batch_id,
        entity: r.entity,
        kind: r.kind,
        entity_key: r.entity_key ?? null,
        canonical_id: r.canonical_id,
        loser_id: r.loser_id ?? null,
        table: r.table ?? null,
      })),
      cursor: page.continueCursor,
      is_done: page.isDone,
    };
  },
});

/** Steps of one run, text sliced for the audit report (docs are read whole —
 *  a run has ≤8 steps at ≤200k chars per text field, well under limits). */
export const runStepsSlim = internalQuery({
  args: { run_id: v.string() },
  handler: async (ctx, args) => {
    const steps = await ctx.db
      .query("enrichment_run_steps")
      .withIndex("by_run", (q) =>
        q.eq("enrichment_run_id", args.run_id as Id<"enrichment_runs">),
      )
      .collect();
    return steps
      .sort((a, b) => a.seq - b.seq)
      .map((s) => ({
        id: String(s._id),
        step: s.step,
        seq: s.seq,
        status: s.status ?? null,
        summary: s.summary ?? null,
        vehicle_config_id: s.vehicle_config_id
          ? String(s.vehicle_config_id)
          : null,
        request_head: s.request_text ? s.request_text.slice(0, 700) : null,
        response_head: s.response_text ? s.response_text.slice(0, 300) : null,
      }));
  },
});

/** Names for the audit report: which services / parts the orphans describe. */
export const namesForIds = internalQuery({
  args: { service_ids: v.array(v.string()), part_ids: v.array(v.string()) },
  handler: async (ctx, args) => {
    const services: Record<string, unknown> = {};
    for (const id of args.service_ids) {
      const s = await ctx.db.get(id as Id<"services">);
      if (s) services[id] = { name: s.name, slug: s.slug ?? null };
    }
    const parts: Record<string, unknown> = {};
    for (const id of args.part_ids) {
      const p = await ctx.db.get(id as Id<"oem_parts">);
      if (p) {
        parts[id] = {
          part_number: p.oem_part_number,
          name: p.name,
          subcategory: p.subcategory ?? null,
        };
      }
    }
    return { services, parts };
  },
});

/** Sibling hint: other configs the same part is fitted to — a Mercedes pad
 *  fitted to live GLC43 configs pins the dead twin's family. */
export const partSiblingKeys = internalQuery({
  args: { part_id: v.string(), exclude_config_id: v.string() },
  handler: async (ctx, args) => {
    const fits = await ctx.db
      .query("part_fitments")
      .withIndex("by_part", (q) =>
        q.eq("part_id", args.part_id as Id<"oem_parts">),
      )
      .take(60);
    const keys = new Set<string>();
    for (const f of fits) {
      const cfgId = String(f.vehicle_config_id);
      if (cfgId === args.exclude_config_id) continue;
      const cfg = await ctx.db.get(f.vehicle_config_id);
      if (cfg) keys.add((cfg as any).config_key);
    }
    return [...keys];
  },
});

/** by_config_key resolution used by audit to preview owners. */
export const configsForKey = internalQuery({
  args: { config_key: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_config_key", (q) => q.eq("config_key", args.config_key))
      .collect();
    return rows.map((r) => ({
      id: String(r._id),
      config_key: r.config_key,
      fill_rate: r.fill_rate ?? null,
      enrichment_status: r.enrichment_status ?? null,
    }));
  },
});

// ============================================================================
// Shared discovery: stream live config ids (reusing configsMerge pagers), then
// scan the 6 tables for docs pointing outside that set. ≈77 docs expected.
// ============================================================================

async function discoverOrphans(ctx: { runQuery: any }): Promise<{
  liveKeyById: Map<string, string>;
  clusters: Map<string, Map<string, string[]>>; // dead_id → table → doc ids
}> {
  const liveKeyById = new Map<string, string>();
  let cursor: string | null = null;
  for (;;) {
    const page: any = await ctx.runQuery(internal.configsMerge.configKeysPage, {
      cursor,
      num_items: 400,
    });
    for (const row of page.rows) liveKeyById.set(row.id, row.config_key);
    if (page.is_done) break;
    cursor = page.cursor;
  }

  const clusters = new Map<string, Map<string, string[]>>();
  for (const t of ORPHAN_TABLES) {
    let c: string | null = null;
    for (;;) {
      const page: any = await ctx.runQuery(internal.configsMerge.scanRefsPage, {
        table: t.table,
        fk_fields: ["vehicle_config_id"],
        cursor: c,
        num_items: t.page_size,
      });
      for (const row of page.rows) {
        const val = row.fks.vehicle_config_id;
        if (val == null || liveKeyById.has(val)) continue;
        const byTable = clusters.get(val) ?? new Map<string, string[]>();
        byTable.set(t.table, [...(byTable.get(t.table) ?? []), row.id]);
        clusters.set(val, byTable);
      }
      if (page.is_done) break;
      c = page.cursor;
    }
  }
  return { liveKeyById, clusters };
}

// ============================================================================
// 1. audit — read-only cluster report with every identity signal available:
//    per-table docs, service/part names, run step prompts, ledger mentions,
//    part-sibling config_keys. The attach/delete decision is made from this.
// ============================================================================

export const audit = internalAction({
  args: {},
  handler: async (ctx): Promise<Record<string, unknown>> => {
    const { liveKeyById, clusters } = await discoverOrphans(ctx);

    // Ledger mentions of any dead id (loser side ⇒ entity_key names the key).
    const deadIds = new Set(clusters.keys());
    const ledgerHits: Record<string, unknown[]> = {};
    let cursor: string | null = null;
    for (;;) {
      const page: any = await ctx.runQuery(internal.orphanRepair.mergeLogPage, {
        cursor,
        num_items: 200,
      });
      for (const row of page.rows) {
        for (const side of ["loser_id", "canonical_id"] as const) {
          const idv = row[side];
          if (idv && deadIds.has(idv)) {
            ledgerHits[idv] = [...(ledgerHits[idv] ?? []), { ...row, side }];
          }
        }
      }
      if (page.is_done) break;
      cursor = page.cursor;
    }

    const clusterReports: unknown[] = [];
    for (const [deadId, byTable] of clusters) {
      const tables: Record<string, unknown> = {};
      const serviceIds = new Set<string>();
      const partIds = new Set<string>();
      let ctMin = Infinity;
      let ctMax = -Infinity;

      for (const [table, ids] of byTable) {
        const docs: any[] = await ctx.runQuery(
          internal.orphanRepair.getDocsByIds,
          { ids },
        );
        for (const d of docs) {
          ctMin = Math.min(ctMin, d._creationTime);
          ctMax = Math.max(ctMax, d._creationTime);
          if (d.service_id) serviceIds.add(String(d.service_id));
          if (d.part_id) partIds.add(String(d.part_id));
        }
        if (table === "enrichment_runs") {
          const runs: unknown[] = [];
          for (const d of docs) {
            const steps = await ctx.runQuery(
              internal.orphanRepair.runStepsSlim,
              { run_id: String(d._id) },
            );
            runs.push({
              id: String(d._id),
              status: d.status,
              version: d.version ?? null,
              trigger: d.trigger ?? null,
              fill_rate: d.fill_rate ?? null,
              started_at: d.started_at ?? null,
              completed_at: d.completed_at ?? null,
              errors: (d.errors ?? []).slice(0, 4),
              batch_ids: d.batch_ids ?? null,
              steps,
            });
          }
          tables[table] = runs;
        } else {
          tables[table] = docs.map((d) => {
            const slim: Record<string, unknown> = { id: String(d._id) };
            for (const [k, val] of Object.entries(d)) {
              if (k === "_id" || k === "vehicle_config_id") continue;
              if (val === undefined || val === null) continue;
              slim[k] = val;
            }
            return slim;
          });
        }
      }

      const names: any = await ctx.runQuery(internal.orphanRepair.namesForIds, {
        service_ids: [...serviceIds],
        part_ids: [...partIds],
      });

      const siblingKeys: Record<string, string[]> = {};
      for (const pid of [...partIds].slice(0, 20)) {
        siblingKeys[pid] = await ctx.runQuery(
          internal.orphanRepair.partSiblingKeys,
          { part_id: pid, exclude_config_id: deadId },
        );
      }

      clusterReports.push({
        dead_config_id: deadId,
        doc_counts: Object.fromEntries(
          [...byTable.entries()].map(([t, ids]) => [t, ids.length]),
        ),
        children_creation_range:
          ctMin <= ctMax
            ? {
                min: new Date(ctMin).toISOString(),
                max: new Date(ctMax).toISOString(),
              }
            : null,
        ledger_mentions: ledgerHits[deadId] ?? [],
        service_names: names.services,
        part_names: names.parts,
        part_sibling_config_keys: siblingKeys,
        tables,
      });
    }

    return {
      live_configs: liveKeyById.size,
      dead_config_ids: clusters.size,
      total_orphan_docs: [...clusters.values()]
        .flatMap((m) => [...m.values()])
        .reduce((n, ids) => n + ids.length, 0),
      clusters: clusterReports,
    };
  },
});

// ============================================================================
// 2. repairCluster — ONE dead id re-attached in ONE transaction. The owner is
//    re-resolved by config_key inside the tx; requires exactly one live row.
// ============================================================================

export const repairCluster = internalMutation({
  args: {
    dead_id: v.string(),
    config_key: v.string(),
    dry_run: v.boolean(),
    batch_id: v.string(),
    drop_doc_ids: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const dropSet = new Set(args.drop_doc_ids ?? []);
    const matchedDrops = new Set<string>();
    const deadId = args.dead_id as Id<"vehicle_configs">;
    if (await ctx.db.get(deadId)) {
      throw new Error(
        `repairCluster(${args.dead_id}): config exists — not an orphan cluster`,
      );
    }
    const owners = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_config_key", (q) => q.eq("config_key", args.config_key))
      .collect();
    if (owners.length !== 1) {
      throw new Error(
        `repairCluster(${args.dead_id}): config_key "${args.config_key}" resolves to ${owners.length} configs — need exactly 1`,
      );
    }
    const owner = owners[0];

    const perTable: Record<
      string,
      { restamped: number; deduped: number; dropped: number }
    > = {};
    for (const t of ORPHAN_TABLES) {
      const orphanDocs = await ctx.db
        .query(t.table as any)
        .withIndex(t.index as any, (q: any) =>
          q.eq("vehicle_config_id", deadId),
        )
        .collect();
      if (!orphanDocs.length) continue;

      // Owner-side semantic keys + exact signatures (running sets — a promoted
      // orphan claims its key so a second same-key orphan dedupes against it).
      const ownerKeys = new Set<string>();
      const ownerSigs = new Set<string>();
      if (t.table !== "enrichment_runs") {
        const ownerDocs = await ctx.db
          .query(t.table as any)
          .withIndex(t.index as any, (q: any) =>
            q.eq("vehicle_config_id", owner._id),
          )
          .collect();
        for (const d of ownerDocs) {
          const key = semanticKey(t.table, d as any);
          if (key !== null) ownerKeys.add(key);
          ownerSigs.add(childSignature(d as any));
        }
      }

      let restamped = 0;
      let deduped = 0;
      let dropped = 0;
      const restampIds: string[] = [];
      for (const d of orphanDocs as any[]) {
        if (dropSet.has(String(d._id))) {
          dropped++;
          matchedDrops.add(String(d._id));
          if (!args.dry_run) {
            await ctx.db.insert("make_merge_log", {
              batch_id: args.batch_id,
              entity: "vehicle_configs",
              kind: "orphan_delete",
              entity_key: args.config_key,
              canonical_id: String(owner._id),
              loser_id: args.dead_id,
              table: t.table,
              field: "vehicle_config_id",
              loser_snapshot: { ...d },
              created_at: now,
            });
            await ctx.db.delete(d._id);
          }
          continue;
        }
        const key = semanticKey(t.table, d);
        if (key !== null && ownerKeys.has(key)) {
          deduped++;
          if (!args.dry_run) {
            await ctx.db.insert("make_merge_log", {
              batch_id: args.batch_id,
              entity: "vehicle_configs",
              kind: "orphan_dup_child",
              entity_key: args.config_key,
              canonical_id: String(owner._id),
              loser_id: args.dead_id,
              table: t.table,
              field: "vehicle_config_id",
              loser_snapshot: { ...d },
              patch_before: {
                semantic_key: key,
                exact_clone: ownerSigs.has(childSignature(d)),
              },
              created_at: now,
            });
            await ctx.db.delete(d._id);
          }
        } else {
          restamped++;
          restampIds.push(String(d._id));
          if (key !== null) ownerKeys.add(key);
          ownerSigs.add(childSignature(d));
          if (!args.dry_run) {
            await ctx.db.patch(d._id, { vehicle_config_id: owner._id });
          }
        }
      }
      if (!args.dry_run && restampIds.length) {
        await ctx.db.insert("make_merge_log", {
          batch_id: args.batch_id,
          entity: "vehicle_configs",
          kind: "orphan_restamp",
          entity_key: args.config_key,
          canonical_id: String(owner._id),
          loser_id: args.dead_id,
          table: t.table,
          field: "vehicle_config_id",
          doc_ids: restampIds,
          count: restampIds.length,
          created_at: now,
        });
      }
      perTable[t.table] = { restamped, deduped, dropped };
    }

    return {
      dead_id: args.dead_id,
      config_key: args.config_key,
      owner_id: String(owner._id),
      dry_run: args.dry_run,
      tables: perTable,
      unmatched_drop_ids: [...dropSet].filter((id) => !matchedDrops.has(id)),
    };
  },
});

// ============================================================================
// 3. deleteCluster — ONE dead id snapshotted + deleted in ONE transaction.
//    enrichment_run deletions cascade their steps (required FK) with
//    snapshots so revert can rebuild the run+steps pair.
// ============================================================================

export const deleteCluster = internalMutation({
  args: {
    dead_id: v.string(),
    dry_run: v.boolean(),
    batch_id: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const deadId = args.dead_id as Id<"vehicle_configs">;
    if (await ctx.db.get(deadId)) {
      throw new Error(
        `deleteCluster(${args.dead_id}): config exists — not an orphan cluster`,
      );
    }

    const perTable: Record<string, number> = {};
    const logDelete = async (table: string, doc: Record<string, unknown>) => {
      await ctx.db.insert("make_merge_log", {
        batch_id: args.batch_id,
        entity: "vehicle_configs",
        kind: "orphan_delete",
        canonical_id: "unresolved",
        loser_id: args.dead_id,
        table,
        field: "vehicle_config_id",
        loser_snapshot: { ...doc },
        created_at: now,
      });
      await ctx.db.delete((doc as any)._id);
    };

    for (const t of ORPHAN_TABLES) {
      const orphanDocs = await ctx.db
        .query(t.table as any)
        .withIndex(t.index as any, (q: any) =>
          q.eq("vehicle_config_id", deadId),
        )
        .collect();
      if (!orphanDocs.length) continue;
      perTable[t.table] = orphanDocs.length;

      for (const d of orphanDocs as any[]) {
        if (t.table === "enrichment_runs") {
          const steps = await ctx.db
            .query("enrichment_run_steps")
            .withIndex("by_run", (q) => q.eq("enrichment_run_id", d._id))
            .collect();
          perTable.enrichment_run_steps =
            (perTable.enrichment_run_steps ?? 0) + steps.length;
          if (!args.dry_run) {
            for (const s of steps) {
              await logDelete("enrichment_run_steps", s as any);
            }
          }
        }
        if (!args.dry_run) await logDelete(t.table, d);
      }
    }

    return { dead_id: args.dead_id, dry_run: args.dry_run, tables: perTable };
  },
});

// ============================================================================
// 4. repair — orchestrator. Re-discovers clusters live, enforces that every
//    dead id has an explicit disposition, runs one mutation per cluster.
// ============================================================================

export const repair = internalAction({
  args: {
    dry_run: v.boolean(),
    batch_id: v.optional(v.string()),
    attach: v.array(
      v.object({
        dead_id: v.string(),
        config_key: v.string(),
        drop_doc_ids: v.optional(v.array(v.string())),
      }),
    ),
    delete_ids: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const batchId = args.batch_id ?? `orphan_repair_${Date.now()}`;
    const attachBy = new Map(args.attach.map((a) => [a.dead_id, a]));
    const deleteSet = new Set(args.delete_ids);
    const overlap = args.attach.filter((a) => deleteSet.has(a.dead_id));
    if (overlap.length) {
      throw new Error(
        `dead ids in BOTH attach and delete_ids: ${overlap
          .map((o) => o.dead_id)
          .join(", ")}`,
      );
    }

    const { clusters } = await discoverOrphans(ctx);
    const unhandled = [...clusters.keys()].filter(
      (id) => !attachBy.has(id) && !deleteSet.has(id),
    );
    const stale = [
      ...[...attachBy.keys()].filter((id) => !clusters.has(id)),
      ...[...deleteSet].filter((id) => !clusters.has(id)),
    ];

    const results: unknown[] = [];
    const failed: Array<{ dead_id: string; error: string }> = [];
    for (const [deadId] of clusters) {
      try {
        if (attachBy.has(deadId)) {
          const a = attachBy.get(deadId)!;
          results.push(
            await ctx.runMutation(internal.orphanRepair.repairCluster, {
              dead_id: deadId,
              config_key: a.config_key,
              dry_run: args.dry_run,
              batch_id: batchId,
              drop_doc_ids: a.drop_doc_ids,
            }),
          );
        } else if (deleteSet.has(deadId)) {
          results.push(
            await ctx.runMutation(internal.orphanRepair.deleteCluster, {
              dead_id: deadId,
              dry_run: args.dry_run,
              batch_id: batchId,
            }),
          );
        }
      } catch (e: any) {
        failed.push({ dead_id: deadId, error: String(e?.message ?? e) });
      }
    }

    return {
      batch_id: batchId,
      dry_run: args.dry_run,
      clusters_found: clusters.size,
      handled: results.length,
      unhandled_dead_ids: unhandled,
      stale_instruction_ids: stale,
      failed,
      results,
      next_step: args.dry_run
        ? "re-run with dry_run:false"
        : "npx convex run configsMerge:verify '{}'",
    };
  },
});

// ============================================================================
// 5. revertRepair — replay an orphan batch backwards. Restores the PRE-REPAIR
//    orphan state: snapshots re-inserted (new _ids), restamps re-pointed at
//    the dead id. Deleted runs revive before their steps so the steps' run FK
//    can be remapped to the revived id.
// ============================================================================

export const revertRepair = internalMutation({
  args: { batch_id: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("make_merge_log")
      .withIndex("by_batch", (q) => q.eq("batch_id", args.batch_id))
      .collect();
    if (!rows.length) throw new Error(`no log rows for batch ${args.batch_id}`);
    const nonOrphan = rows.find((r) => !r.kind.startsWith("orphan_"));
    if (nonOrphan) {
      throw new Error(
        `batch ${args.batch_id} has kind "${nonOrphan.kind}" — not an orphanRepair batch`,
      );
    }
    const now = Date.now();

    const insertSnapshot = async (
      table: string,
      snap: Record<string, unknown>,
    ) => {
      const copy = { ...snap };
      delete copy._id;
      delete copy._creationTime;
      return await ctx.db.insert(table as any, copy as any);
    };

    // 1) Revive deleted enrichment_runs first, tracking old→new ids.
    const runIdMap = new Map<string, string>();
    let revived = 0;
    for (const r of rows) {
      if (r.kind !== "orphan_delete" || r.reverted_at) continue;
      if (r.table !== "enrichment_runs") continue;
      const snap = r.loser_snapshot as Record<string, unknown>;
      const oldId = String(snap._id);
      const newId = await insertSnapshot("enrichment_runs", snap);
      runIdMap.set(oldId, String(newId));
      await ctx.db.patch(r._id, { reverted_at: now, revived_as: String(newId) });
      revived++;
    }

    // 2) Everything else deleted (steps get their run FK remapped).
    for (const r of rows) {
      if (r.kind !== "orphan_delete" && r.kind !== "orphan_dup_child") continue;
      if (r.reverted_at || r.table === "enrichment_runs") continue;
      const snap = { ...(r.loser_snapshot as Record<string, unknown>) };
      if (r.table === "enrichment_run_steps") {
        const mapped = runIdMap.get(String(snap.enrichment_run_id));
        if (mapped) snap.enrichment_run_id = mapped;
      }
      const newId = await insertSnapshot(r.table!, snap);
      await ctx.db.patch(r._id, { reverted_at: now, revived_as: String(newId) });
      revived++;
    }

    // 3) Re-point restamped docs back at the dead id (skip docs someone else
    //    has since re-pointed elsewhere).
    let repointed = 0;
    let skipped = 0;
    for (const r of rows) {
      if (r.kind !== "orphan_restamp" || r.reverted_at) continue;
      for (const docId of r.doc_ids ?? []) {
        const doc: any = await ctx.db.get(docId as Id<any>);
        if (doc && String(doc[r.field!]) === r.canonical_id) {
          await ctx.db.patch(docId as Id<any>, { [r.field!]: r.loser_id });
          repointed++;
        } else {
          skipped++;
        }
      }
      await ctx.db.patch(r._id, { reverted_at: now });
    }

    return { batch_id: args.batch_id, revived, repointed, skipped };
  },
});
