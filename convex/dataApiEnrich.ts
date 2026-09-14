/**
 * dataApiEnrich.ts — POST /v0/enrich trigger path (Data API v0).
 *
 * Mirrors vehicleEnrichment/runHeadless.ts:go — the ownerless precedent —
 * WITHOUT the two consumer add-car side effects:
 *   - no vehicle_owners row (addOwner): API callers own no cars
 *   - no tire-scrape scheduling (that rides confirmVehicleForUser only)
 *
 * A VIN-keyed `vehicles` catalog row IS created (the v3 pipeline is
 * vehicle-keyed); that row carries no user linkage. Quota + cache-hit logic
 * live in the http.ts handler — by the time this action runs, the caller has
 * already paid a quota slot for a real decode + batch run.
 */
import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { internal, api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

export type TriggerEnrichResult =
  | { status: "decode_failed" }
  | { status: "vehicle_upsert_failed" }
  | { status: "no_engine_code" }
  | {
      status: "scheduled";
      vehicleId: Id<"vehicles">;
      year: number;
      make: string;
      model: string;
      trim: string | null;
    };

// `@ts-expect-error TS2589` (if ever needed): same Convex+TS depth quirk as
// vehicleEnrichment/runHeadless.ts — see the header comment there.
export const triggerEnrichForVin = internalAction({
  args: { vin: v.string() },
  handler: async (ctx, args): Promise<TriggerEnrichResult> => {
    const vin = args.vin.toUpperCase().trim();
    console.log(`[dataApiEnrich] VIN: ${vin}`);

    const decoded = await ctx.runAction(internal.vehicle_pipeline.processVin, { vin });
    if (!decoded) {
      console.error("[dataApiEnrich] Decode FAILED");
      return { status: "decode_failed" };
    }

    const vehicle = await ctx.runMutation(api.vehicles.upsertVehicle, {
      vin,
      trim_id: decoded.trimId,
      engine_id: decoded.engineId,
      transmission_id: decoded.transmissionId ?? undefined,
      year: decoded.year,
    });
    if (!vehicle?._id) {
      console.error("[dataApiEnrich] Vehicle upsert failed");
      return { status: "vehicle_upsert_failed" };
    }

    if (!decoded.engineCode) {
      console.warn("[dataApiEnrich] No engine code — cannot enrich this VIN");
      return { status: "no_engine_code" };
    }

    await ctx.scheduler.runAfter(0, internal.vehicleEnrichment.v3pipeline.enrichVehicleBatchV3, {
      vehicleId: vehicle._id,
      year: decoded.year,
      make: decoded.make,
      model: decoded.model,
      trim: decoded.trim ?? "",
      engineCode: decoded.engineCode,
      displacement: decoded.displacement ?? "",
      drivetrain: (decoded as any).drivetrain ?? undefined,
      nhtsaVinKey: (decoded as any).nhtsaVinKey ?? undefined,
    });

    console.log(`[dataApiEnrich] Scheduled enrichment for ${vin} (vehicle ${vehicle._id})`);
    return {
      status: "scheduled",
      vehicleId: vehicle._id,
      year: decoded.year,
      make: decoded.make,
      model: decoded.model,
      trim: decoded.trim ?? null,
    };
  },
});

// ─── Self-serve enrich-run ledger + notifications ────────────────────────────
// Backs the Otofacts /developers "Enrichment runs" card and the queued/complete
// /failed emails. A row is created ONLY when a POST /v0/enrich actually
// schedules a run (202) for a dev-portal key that has an owner; cache hits and
// team keys create nothing. See schema.ts `data_api_enrich_runs`.

/** Build the payload the enrich email templates read. Kept identity-only; the
 *  Node template composes the dashboard link from env. */
function enrichEmailPayload(
  vin: string,
  identity: { year?: number | null; make?: string | null; model?: string | null; trim?: string | null },
  extra?: { config_key?: string | null; fill_rate?: number | null; error?: string | null },
): Record<string, unknown> {
  const vehicle = [identity.year, identity.make, identity.model, identity.trim]
    .filter((x) => x != null && x !== "")
    .join(" ");
  return {
    vin,
    vehicle: vehicle || null,
    year: identity.year ?? null,
    make: identity.make ?? null,
    model: identity.model ?? null,
    trim: identity.trim ?? null,
    config_key: extra?.config_key ?? null,
    fill_rate: extra?.fill_rate ?? null,
    error: extra?.error ?? null,
  };
}

/** Enqueue one enrich email onto notification_outbox (drained by the existing
 *  dispatch-pending-emails cron → lib.email_provider.sendWalkinUpdate). */
async function enqueueEnrichEmail(
  ctx: MutationCtx,
  opts: {
    userId: Id<"users">;
    runId: Id<"data_api_enrich_runs">;
    phase: "queued" | "complete" | "failed";
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await ctx.db.insert("notification_outbox", {
    user_id: opts.userId,
    channel: "email",
    category: `enrich_${opts.phase}`,
    status: "pending",
    dedupe_key: `enrich:${opts.runId}:${opts.phase}`,
    payload: opts.payload,
    created_at: Date.now(),
  });
}

/** Create the ledger row + enqueue the "queued" email. Called from the
 *  /v0/enrich POST handler after a 202 (owner keys only). */
export const recordEnrichRunQueued = internalMutation({
  args: {
    owner_user_id: v.id("users"),
    api_key_id: v.id("api_keys"),
    vin: v.string(),
    vehicle_id: v.optional(v.id("vehicles")),
    year: v.optional(v.number()),
    make: v.optional(v.string()),
    model: v.optional(v.string()),
    trim: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"data_api_enrich_runs">> => {
    const now = Date.now();
    const runId = await ctx.db.insert("data_api_enrich_runs", {
      owner_user_id: args.owner_user_id,
      api_key_id: args.api_key_id,
      vin: args.vin,
      vehicle_id: args.vehicle_id,
      status: "queued",
      year: args.year,
      make: args.make,
      model: args.model,
      trim: args.trim,
      queued_at: now,
      last_status_at: now,
      notified_queued: true,
      notified_complete: false,
    });
    await enqueueEnrichEmail(ctx, {
      userId: args.owner_user_id,
      runId,
      phase: "queued",
      payload: enrichEmailPayload(args.vin, args),
    });
    return runId;
  },
});

/** Active (non-terminal) runs the reconcile cron must re-check. */
export const listActiveEnrichRuns = internalQuery({
  args: {},
  handler: async (ctx) => {
    const queued = await ctx.db
      .query("data_api_enrich_runs")
      .withIndex("by_status", (q) => q.eq("status", "queued"))
      .take(200);
    const enriching = await ctx.db
      .query("data_api_enrich_runs")
      .withIndex("by_status", (q) => q.eq("status", "enriching"))
      .take(200);
    return [...queued, ...enriching].map((r) => ({
      id: r._id,
      vin: r.vin,
      status: r.status,
      queued_at: r.queued_at,
    }));
  },
});

/** Patch a run's status; enqueue the completion email exactly once (terminal). */
export const applyEnrichRunTransition = internalMutation({
  args: {
    runId: v.id("data_api_enrich_runs"),
    status: v.union(v.literal("enriching"), v.literal("complete"), v.literal("failed")),
    config_key: v.optional(v.string()),
    fill_rate: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    const run = await ctx.db.get(args.runId);
    if (!run) return;
    const now = Date.now();
    const patch: Record<string, unknown> = { status: args.status, last_status_at: now };
    if (args.config_key != null) patch.config_key = args.config_key;
    if (args.fill_rate != null) patch.fill_rate = args.fill_rate;
    if (args.error != null) patch.error = args.error;

    const terminal = args.status === "complete" || args.status === "failed";
    if (terminal) patch.completed_at = now;
    if (terminal && !run.notified_complete) {
      patch.notified_complete = true;
      await enqueueEnrichEmail(ctx, {
        userId: run.owner_user_id,
        runId: run._id,
        phase: args.status === "complete" ? "complete" : "failed",
        payload: enrichEmailPayload(
          run.vin,
          { year: run.year, make: run.make, model: run.model, trim: run.trim },
          {
            config_key: args.config_key ?? run.config_key,
            fill_rate: args.fill_rate ?? run.fill_rate,
            error: args.error,
          },
        ),
      });
    }
    await ctx.db.patch(args.runId, patch as any);
  },
});

// A run silent past this hard stop is force-failed so it never hangs on the
// dashboard (2h ≫ the 7-40 min typical run; the pipeline's own zombie reaper
// resets stuck configs, which surfaces here as a non-complete status past TTL).
const ENRICH_RUN_TIMEOUT_MS = 120 * 60 * 1000;

/** Cron entry (every 2 min): reconcile each active run against its config's
 *  live enrichment_status, flipping to enriching/complete/failed + emailing. */
export const reconcileEnrichRuns = internalAction({
  args: {},
  handler: async (ctx): Promise<{ checked: number }> => {
    const active = await ctx.runQuery(internal.dataApiEnrich.listActiveEnrichRuns, {});
    for (const run of active) {
      const s = await ctx.runQuery(internal.dataApi.getEnrichStatusByVin, { vin: run.vin });
      const raw = s?.enrichment_status ?? null;

      if (raw === "complete" || raw === "verified") {
        await ctx.runMutation(internal.dataApiEnrich.applyEnrichRunTransition, {
          runId: run.id,
          status: "complete",
          config_key: s?.config_key ?? undefined,
          fill_rate: s?.fill_rate ?? undefined,
        });
        continue;
      }
      if (raw === "failed") {
        await ctx.runMutation(internal.dataApiEnrich.applyEnrichRunTransition, {
          runId: run.id,
          status: "failed",
          config_key: s?.config_key ?? undefined,
          error: "Enrichment failed — the pipeline could not complete this VIN.",
        });
        continue;
      }
      if (Date.now() - run.queued_at > ENRICH_RUN_TIMEOUT_MS) {
        await ctx.runMutation(internal.dataApiEnrich.applyEnrichRunTransition, {
          runId: run.id,
          status: "failed",
          error: "Timed out — enrichment did not complete in time.",
        });
        continue;
      }
      if ((raw === "enriching" || raw === "pending") && run.status !== "enriching") {
        await ctx.runMutation(internal.dataApiEnrich.applyEnrichRunTransition, {
          runId: run.id,
          status: "enriching",
          config_key: s?.config_key ?? undefined,
        });
      }
    }
    return { checked: active.length };
  },
});
