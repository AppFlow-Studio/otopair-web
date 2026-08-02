// =============================================================================
// Data · Pipeline Control Room (/data/control-room) — server side.
//
// Reads: enrichment_runs windows (by_created_at / by_status, take 50) with the
// vehicle_config resolved to a human label. vin_queue reads live in
// convex/vinQueueQueries.ts and are wrapped, not duplicated.
//
// Writes: the three director triggers (re-enrich / fix-prices / report) —
// capability "data.trigger", full ceremony contract ({token, reason, vin}),
// a 30-minute per-(vin,trigger) cooldown enforced by reading the newest
// audit_log row via by_entity("vin_trigger:<kind>", vin), and an audit row in
// the same mutation. Re-enrich schedules the existing
// internal.vehicleEnrichment.marketplaceScraper.enrichAndTrack action when the
// VIN exists in vin_queue. Fix-prices is record-only (see note inside).
// =============================================================================
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireDirector, logAudit } from "./directorGate";

// Authored return type — load-bearing (see convex/backfillTires.ts
// _listCandidates): without it TS must infer the handler while resolving the
// whole ApiFromModules barrel, which exhausts the checker's instantiation
// budget and silently degrades api.* types to `any` in consumer files.
export type ControlRoomRunRow = {
  id: Id<"enrichment_runs">;
  configId: Id<"vehicle_configs">;
  configLabel: string;
  status: string;
  trigger: string | null;
  applicableFillRate: number | null;
  fillRate: number | null;
  fieldsFilled: number | null;
  fieldsTotal: number | null;
  costUsd: number | null;
  durationMs: number | null;
  sanityFlagCount: number;
  errorCount: number;
  cacheHit: boolean;
  createdAt: number;
};

const RUNS_WINDOW = 50;
const COOLDOWN_MS = 30 * 60 * 1000; // 30 min per (vin, trigger)

// ─── Runs table ──────────────────────────────────────────────────────────────

export const listRuns = query({
  args: { token: v.string(), status: v.optional(v.string()) },
  handler: async (ctx, { token, status }): Promise<ControlRoomRunRow[]> => {
    await requireDirector(ctx, token);

    const runs = status
      ? await ctx.db
          .query("enrichment_runs")
          .withIndex("by_status", (q) => q.eq("status", status))
          .order("desc")
          .take(RUNS_WINDOW)
      : await ctx.db
          .query("enrichment_runs")
          .withIndex("by_created_at")
          .order("desc")
          .take(RUNS_WINDOW);

    // Resolve config → "2019 BMW 740i xDrive" labels. Memoized: 50 runs share
    // far fewer configs/makes/models than 50 of each.
    const makeNames = new Map<string, string>();
    const modelNames = new Map<string, string>();
    const configLabels = new Map<string, string>();

    const rows: ControlRoomRunRow[] = [];
    for (const run of runs) {
      const cfgKey = run.vehicle_config_id as unknown as string;
      let label = configLabels.get(cfgKey);
      if (label === undefined) {
        const cfg = await ctx.db.get(run.vehicle_config_id);
        if (!cfg) {
          label = "(config deleted)";
        } else {
          const makeKey = cfg.make_id as unknown as string;
          let makeName = makeNames.get(makeKey);
          if (makeName === undefined) {
            makeName = (await ctx.db.get(cfg.make_id))?.name ?? "?";
            makeNames.set(makeKey, makeName);
          }
          const modelKey = cfg.model_id as unknown as string;
          let modelName = modelNames.get(modelKey);
          if (modelName === undefined) {
            modelName = (await ctx.db.get(cfg.model_id))?.name ?? "?";
            modelNames.set(modelKey, modelName);
          }
          label = [cfg.year, makeName, modelName, cfg.trim_name].filter(Boolean).join(" ");
        }
        configLabels.set(cfgKey, label);
      }

      rows.push({
        id: run._id,
        configId: run.vehicle_config_id,
        configLabel: label,
        status: run.status,
        trigger: run.trigger ?? null,
        applicableFillRate: run.applicable_fill_rate ?? null,
        fillRate: run.fill_rate ?? null,
        fieldsFilled: run.fields_filled ?? null,
        fieldsTotal: run.fields_total ?? null,
        costUsd: run.estimated_cost_usd ?? null,
        durationMs: run.duration_ms ?? null,
        sanityFlagCount: run.sanity_flags?.length ?? 0,
        errorCount: run.errors?.length ?? 0,
        cacheHit: run.scrape_cache_hit ?? false,
        createdAt: run.created_at ?? run._creationTime,
      });
    }
    return rows;
  },
});

// ─── Trigger cooldown + shared body ─────────────────────────────────────────

async function enforceCooldown(
  ctx: MutationCtx,
  kind: "re_enrich" | "fix_prices" | "report",
  vin: string,
): Promise<void> {
  const last = await ctx.db
    .query("audit_log")
    .withIndex("by_entity", (q) =>
      q.eq("entity_type", `vin_trigger:${kind}`).eq("entity_id", vin),
    )
    .order("desc")
    .first();
  if (!last) return;
  const lastAt = last.created_at ?? last._creationTime;
  const elapsed = Date.now() - lastAt;
  if (elapsed < COOLDOWN_MS) {
    const remainMin = Math.ceil((COOLDOWN_MS - elapsed) / 60_000);
    throw new Error(
      `Cooldown: "${kind.replace("_", "-")}" was already triggered for ${vin} ` +
        `${Math.floor(elapsed / 60_000)} min ago. Try again in ~${remainMin} min.`,
    );
  }
}

function cleanVin(vin: string): string {
  const t = vin.trim().toUpperCase();
  if (t.length < 11 || t.length > 17) throw new Error(`"${vin}" does not look like a VIN.`);
  return t;
}

function requireReason(reason: string): string {
  const r = reason.trim();
  if (r.length < 4) throw new Error("A reason is required (at least a few words).");
  return r;
}

// ─── Trigger: Re-enrich (full Tier 1) ───────────────────────────────────────

export const triggerReEnrich = mutation({
  args: { token: v.string(), reason: v.string(), vin: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireDirector(ctx, args.token, "data.trigger");
    const reason = requireReason(args.reason);
    const vin = cleanVin(args.vin);
    await enforceCooldown(ctx, "re_enrich", vin);

    // The pipeline's real per-VIN entry point tracks status back onto the
    // vin_queue row, so it needs one to exist.
    const queueRow = await ctx.db
      .query("vin_queue")
      .withIndex("by_vin", (q) => q.eq("vin", vin))
      .first();
    if (!queueRow) {
      throw new Error(
        `${vin} is not in vin_queue — re-enrich runs through the queue tracker ` +
          `(enrichAndTrack) and needs a queue row. Add it via scraping/decode first.`,
      );
    }

    await ctx.scheduler.runAfter(
      0,
      internal.vehicleEnrichment.marketplaceScraper.enrichAndTrack,
      { vin, vin_queue_id: queueRow._id },
    );

    await logAudit(ctx, actor, {
      entity_type: "vin_trigger:re_enrich",
      entity_id: vin,
      action: "trigger_re_enrich",
      detail: `${reason} — scheduled enrichAndTrack (queue row ${queueRow._id}, was ${queueRow.status})`,
    });
    return { scheduled: true };
  },
});

// ─── Trigger: Fix prices (per-VIN parts-price backfill) ─────────────────────

// How many unpriced parts one trigger may price (Firecrawl spend ceiling).
// Explicit here because the director ceremony IS the deliberate-spend gate —
// it overrides the PARTS_PRICE_BACKFILL_BUDGET=0 env default on purpose.
const FIX_PRICES_PART_BUDGET = 12;

export const triggerFixPrices = mutation({
  args: { token: v.string(), reason: v.string(), vin: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireDirector(ctx, args.token, "data.trigger");
    const reason = requireReason(args.reason);
    const vin = cleanVin(args.vin);
    await enforceCooldown(ctx, "fix_prices", vin);

    // Resolve VIN → vehicle_config via vehicles.by_vin. Without a config
    // there is nothing to price against — re-enrich decodes first.
    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", vin))
      .first();
    const configId = vehicle?.vehicle_config_id;
    if (!configId) {
      throw new Error(
        `${vin} has no decoded vehicle_config yet — run re-enrich first, then fix-prices.`,
      );
    }

    // Targeted leg of the existing nightly refresher: prices this config's
    // UNPRICED parts via known-URL / discovery machinery (priceRefresh.ts),
    // bounded self-rechaining. budget:0 skips the fleet-wide stale sweep.
    // Note: parts that already have (stale) price rows are refreshed by the
    // nightly stale sweep, not this trigger.
    await ctx.scheduler.runAfter(0, internal.vehicleEnrichment.priceRefresh.refreshStalePrices, {
      vehicleConfigId: configId,
      budget: 0,
      backfillBudget: FIX_PRICES_PART_BUDGET,
      maxChainDepth: 2,
    });

    await logAudit(ctx, actor, {
      entity_type: "vin_trigger:fix_prices",
      entity_id: vin,
      action: "trigger_fix_prices",
      detail: `${reason} — scheduled targeted price backfill for config ${String(configId)} (budget ${FIX_PRICES_PART_BUDGET} parts)`,
    });
    return { scheduled: true, configId: String(configId) };
  },
});

// ─── Trigger: Report wrong data (→ review_queue) ────────────────────────────

export const triggerReport = mutation({
  args: { token: v.string(), reason: v.string(), vin: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireDirector(ctx, args.token, "data.trigger");
    const reason = requireReason(args.reason);
    const vin = cleanVin(args.vin);
    await enforceCooldown(ctx, "report", vin);

    const itemId = await ctx.db.insert("review_queue", {
      source_stream: "report" as const,
      source_id: vin, // report triggers have no source document; the VIN is the anchor
      entity_type: "vin",
      entity_id: vin,
      vin,
      title: `Wrong data reported for ${vin}: ${reason}`,
      priority: "normal" as const,
      status: "open" as const,
      created_at: Date.now(),
    });

    await logAudit(ctx, actor, {
      entity_type: "vin_trigger:report",
      entity_id: vin,
      action: "trigger_report",
      detail: `${reason} — review_queue item ${itemId} created`,
    });
    return { scheduled: true, reviewItemId: itemId };
  },
});
