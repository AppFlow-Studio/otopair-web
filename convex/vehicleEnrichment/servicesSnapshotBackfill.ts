/**
 * vehicleEnrichment/servicesSnapshotBackfill.ts — give pre-metric runs a
 * quotability snapshot so the completion gate can see them at all.
 *
 * WHY. reevaluateGate refuses to promote without a persisted
 * applicable-service list (`run.quotability.services`) — "a promote would
 * rest on an unverifiable quotability". Correct — but ~113 configs on
 * third-bird-914 (the bulk Ford/VW imports, Aug 2026 census) ran before the
 * metric existed, so every heal, resweep, and nightly leg returns
 * `no_quotability_snapshot` forever. They are invisible to the entire
 * promotion machinery: not failing the gate — unmeasurable by it.
 *
 * WHAT COUNTS AS HONEST HERE. The applicable-service list is a MODEL-JUDGED
 * fact (chain vs belt, EV vs gas, CVT vs geared), not something to
 * reconstruct from which rows happen to exist — deriving it from stored
 * intervals would bias the denominator toward services that already got data
 * and inflate quotability. So this reuses the SERVICES RESCUE mechanism
 * (prompts/batch2Prompt.ts), the same services-only re-ask the pipeline runs
 * when batch-2 returns empty — one bounded call per config, judged against
 * the real vehicle. A config whose rescue returns nothing applicable is
 * reported and left unstamped: still honest, still visible as a failure.
 *
 * The stamp is only-if-absent — a real finalize-time snapshot is never
 * overwritten — and the promotion itself is delegated to reevaluateGate, so
 * there is exactly one gate path no matter who asks.
 *
 *   npx convex run vehicleEnrichment/servicesSnapshotBackfill:backfill '{"limit":6,"dryRun":true}'
 */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { callClaudeWithWebSearch } from "./utils/claudeClient";
import { normalizeBatchShape } from "./utils/batchSchemas";
import { SERVICES_RESCUE_SYSTEM, buildServicesRescuePrompt } from "./prompts/batch2Prompt";
import { parseBatch2, PART_FIELD_MAP, SERVICE_NAME_TO_SLUG } from "./v3pipeline";
import { computeQuotability, missingCoreRoles } from "./quotability";

/** Terminal run statuses this backfill may stamp. A mid-flight run stamps its
 *  own snapshot at finalize; touching it here would race the pipeline. */
const TERMINAL_RUN = new Set(["complete", "timeout", "error", "failed"]);

export const _cohortPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), limit: v.float64() },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("vehicle_configs")
      .paginate({ cursor: args.cursor, numItems: Math.max(1, Math.trunc(args.limit)) });

    const targets: any[] = [];
    for (const cfg of page.page as any[]) {
      if (!["partial", "complete", "verified"].includes(cfg.enrichment_status ?? "")) continue;
      const run: any = await ctx.db
        .query("enrichment_runs")
        .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", cfg._id))
        .order("desc")
        .first();
      if (!run || !TERMINAL_RUN.has(String(run.status ?? ""))) continue;
      const services = (run.quotability?.services ?? []) as any[];
      if (services.length > 0) continue; // already measurable

      const [mk, md, eng] = await Promise.all([
        cfg.make_id ? ctx.db.get(cfg.make_id) : null,
        cfg.model_id ? ctx.db.get(cfg.model_id) : null,
        cfg.engine_id ? ctx.db.get(cfg.engine_id) : null,
      ]);
      // Stored part numbers give the rescue call vehicle-grounding context,
      // exactly as the in-run rescue passes its extracted numbers.
      const knownParts: Record<string, string> = {};
      const fitments = await ctx.db
        .query("part_fitments")
        .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", cfg._id))
        .collect();
      for (const f of fitments) {
        if (Object.keys(knownParts).length >= 20) break;
        const part: any = await ctx.db.get(f.part_id);
        const oem: string = part?.oem_part_number ?? "";
        const sub: string = part?.subcategory ?? "";
        if (!oem || !sub || oem.startsWith("OTOPAIR-UNIV") || knownParts[sub]) continue;
        knownParts[sub] = oem;
      }
      targets.push({
        vehicleConfigId: cfg._id,
        runId: run._id,
        configKey: String(cfg.config_key ?? ""),
        enrichmentStatus: cfg.enrichment_status ?? null,
        naRoleKeys: (cfg.na_role_keys ?? []) as string[],
        runFieldGaps: (run.field_gaps ?? []) as Array<{ field: string; reason: string }>,
        vehicle: {
          vehicleId: String(cfg._id),
          year: Number(cfg.year),
          make: String((mk as any)?.name ?? ""),
          model: String((md as any)?.name ?? ""),
          trim: String(cfg.trim_name ?? ""),
          engineCode: ((eng as any)?.engine_code as string | undefined) ?? undefined,
          displacement:
            (eng as any)?.displacement_l != null
              ? String((eng as any).displacement_l)
              : undefined,
        },
        knownParts,
      });
    }
    return { targets, continueCursor: page.continueCursor, isDone: page.isDone };
  },
});

export const _stampSnapshot = internalMutation({
  args: {
    runId: v.id("enrichment_runs"),
    quotability: v.object({
      pct: v.number(),
      services: v.array(
        v.object({
          slug: v.string(),
          core_total: v.number(),
          core_with_fitment: v.number(),
          core_with_price: v.number(),
          missing_roles: v.optional(v.array(v.string())),
        }),
      ),
    }),
  },
  handler: async (ctx, args) => {
    const run: any = await ctx.db.get(args.runId);
    if (!run) return { stamped: false, reason: "run_gone" };
    // Only-if-absent: a finalize-time snapshot is evidence of record and this
    // backfill must never replace it (re-checked inside the transaction so a
    // concurrent finalize can't be clobbered).
    if (((run.quotability?.services ?? []) as any[]).length > 0) {
      return { stamped: false, reason: "snapshot_exists" };
    }
    await ctx.db.patch(args.runId, { quotability: args.quotability });
    return { stamped: true };
  },
});

/** Diagnose ONE cohort config's rescue call — raw response head + parse
 *  counts. For the Aug 20 finding that 57/75 rescue failures were Fords. */
export const probeOne = internalAction({
  args: { configKey: v.string() },
  handler: async (ctx, args): Promise<any> => {
    const cfg: any = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getVehicleConfigByKey,
      { configKey: args.configKey },
    );
    if (!cfg) return { error: "config_not_found" };
    let cursor: string | null = null;
    for (let i = 0; i < 300; i++) {
      const page: any = await ctx.runQuery(
        internal.vehicleEnrichment.servicesSnapshotBackfill._cohortPage,
        { cursor, limit: 20 },
      );
      const t = page.targets.find((x: any) => x.configKey === args.configKey);
      if (t) {
        const res = await callClaudeWithWebSearch({
          system: SERVICES_RESCUE_SYSTEM,
          userPrompt: buildServicesRescuePrompt(t.vehicle as any, t.knownParts),
          maxSearchUses: 8,
          maxTokens: 8000,
          temperature: 0,
        });
        if (res.usage.tokensOut === 0) {
          return { configKey: t.configKey, error: "anthropic_channel_down" };
        }
        const parsed = parseBatch2(normalizeBatchShape(res.data, "2"), []);
        return {
          configKey: t.configKey,
          vehicleLine: `${t.vehicle.year} ${t.vehicle.make} ${t.vehicle.model} ${t.vehicle.trim} — ${t.vehicle.engineCode} ${t.vehicle.displacement}L`,
          knownParts: Object.keys(t.knownParts).length,
          parsedServices: parsed.services.length,
          applicable: parsed.services.filter((s: any) => s.is_applicable).length,
          serviceNames: parsed.services.slice(0, 6).map((s: any) => s.service_name),
          mappedSlugs: parsed.services
            .filter((s: any) => s.is_applicable)
            .map((s: any) => SERVICE_NAME_TO_SLUG[s.service_name] ?? `UNMAPPED:${s.service_name}`)
            .slice(0, 10),
          rawHead: JSON.stringify(res.data).slice(0, 600),
        };
      }
      if (page.isDone) return { error: "not_in_cohort (already stamped or no terminal run)" };
      cursor = page.continueCursor;
    }
    return { error: "cursor_exhausted" };
  },
});

export const backfill = internalAction({
  args: {
    limit: v.optional(v.float64()),
    cursor: v.optional(v.union(v.string(), v.null())),
    /** Rescue + compute + report, but no stamp and no gate call. */
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<any> => {
    const limit = Math.max(1, Math.trunc(args.limit ?? 8));
    const page: any = await ctx.runQuery(
      internal.vehicleEnrichment.servicesSnapshotBackfill._cohortPage,
      { cursor: args.cursor ?? null, limit },
    );

    const rows: any[] = [];
    for (const t of page.targets) {
      try {
        const res = await callClaudeWithWebSearch({
          system: SERVICES_RESCUE_SYSTEM,
          userPrompt: buildServicesRescuePrompt(t.vehicle as any, t.knownParts),
          maxSearchUses: 8,
          maxTokens: 8000,
          temperature: 0,
        });
        // Channel-death guard. Terminal API failure returns {data:{}, usage
        // all-zero} — a REAL model answer always has output tokens. Without
        // this, an out-of-credits key reads as "no applicable services" per
        // config and the run burns to a vacuous completion (Aug 20 2026: 75
        // of 140 cohort configs "failed" this way after the key's balance ran
        // out mid-run). Abort the invocation with the SAME cursor so a re-run
        // resumes exactly here.
        if (res.usage.tokensOut === 0) {
          console.error(
            `[snapshot-backfill] Anthropic channel down (zero output tokens) at ${t.configKey} — aborting invocation`,
          );
          return {
            aborted: "anthropic_channel_down",
            pageConfigs: page.targets.length,
            stamped: rows.filter((r) => r.status === "stamped").length,
            promoted: rows.filter((r) => r.promoted).length,
            rows,
            continueCursor: args.cursor ?? null,
            isDone: false,
          };
        }
        // Same slug derivation as finalize: the rescue returns human
        // service_name rows; SERVICE_NAME_TO_SLUG is the one canonical map.
        const parsed = parseBatch2(normalizeBatchShape(res.data, "2"), []);
        const applicable = parsed.services
          .filter((s: any) => s.is_applicable)
          .map((s: any) => SERVICE_NAME_TO_SLUG[s.service_name])
          .filter((x: any): x is string => !!x);
        if (applicable.length === 0) {
          rows.push({ configKey: t.configKey, status: "rescue_no_applicable" });
          continue;
        }

        // Same N/A recipe as finalize + reevaluateGate: run-level
        // not_applicable field gaps ∪ the config's durable na_role_keys.
        const naRoleKeys = new Set<string>([
          ...t.runFieldGaps
            .filter((g: any) => g.reason === "not_applicable" && (PART_FIELD_MAP as any)[g.field])
            .map((g: any) => (PART_FIELD_MAP as any)[g.field].subcategory),
          ...t.naRoleKeys,
        ]);
        const fitments: any[] = await ctx.runQuery(
          internal.vehicleEnrichment.v3queries.getFitmentsWithPriceFlag,
          { vehicleConfigId: t.vehicleConfigId },
        );
        const q = computeQuotability(fitments, applicable, naRoleKeys);
        const missingBySlug = new Map<string, string[]>();
        for (const m of missingCoreRoles(fitments, applicable, naRoleKeys)) {
          missingBySlug.set(m.serviceSlug, [
            ...(missingBySlug.get(m.serviceSlug) ?? []),
            m.roleKey,
          ]);
        }
        const snapshot = {
          pct: q.pct,
          services: q.services.map((s) => ({
            ...s,
            missing_roles: missingBySlug.get(s.slug),
          })),
        };

        if (args.dryRun) {
          rows.push({
            configKey: t.configKey,
            status: "would_stamp",
            applicable: applicable.length,
            pct: q.pct,
          });
          continue;
        }

        const stamp: any = await ctx.runMutation(
          internal.vehicleEnrichment.servicesSnapshotBackfill._stampSnapshot,
          { runId: t.runId, quotability: snapshot },
        );
        let gate: any = null;
        if (stamp?.stamped) {
          // One gate path for everyone: the same promote-only re-evaluation
          // the heal ladder and gateResweep use.
          gate = await ctx.runAction(
            internal.vehicleEnrichment.completionReevaluate.reevaluateGate,
            { vehicleConfigId: t.vehicleConfigId },
          );
        }
        rows.push({
          configKey: t.configKey,
          status: stamp?.stamped ? "stamped" : `skipped:${stamp?.reason}`,
          applicable: applicable.length,
          pct: q.pct,
          gate: gate?.decision ?? null,
          promoted: gate?.promoted ?? false,
        });
      } catch (e) {
        rows.push({ configKey: t.configKey, status: "error", message: String((e as any)?.message ?? e) });
      }
    }

    const summary = {
      pageConfigs: page.targets.length,
      stamped: rows.filter((r) => r.status === "stamped").length,
      promoted: rows.filter((r) => r.promoted).length,
      rows,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
    console.log(
      `[snapshot-backfill] ${summary.pageConfigs} target(s): ${summary.stamped} stamped, ` +
        `${summary.promoted} promoted${args.dryRun ? " [dry-run]" : ""}`,
    );
    return summary;
  },
});
