/**
 * directorConfigBackfills — three PUBLIC director actions that power the
 * per-vehicle-config backfill buttons in the director panel:
 *
 *   1. reEnrichConfig      — FULL re-enrich (force=true, writeScope="full")
 *   2. backfillConfigParts — PARTS-ONLY re-enrich (force=true, writeScope="parts")
 *   3. repriceConfigParts  — PRICES-ONLY, self-contained, no LLM / no pipeline
 *
 * AUTH (hardened Jun 9 2026, review finding "Director backfill actions are
 * public with trusted actorName"): all three validate a director session
 * token server-side (director_auth.validateSession — same gate as
 * simulateOtoForDirector) and derive the audit actor FROM the session. The
 * old convention (NO ctx.auth, caller-supplied trusted actorName/actorId)
 * let any anonymous caller burn LLM/scrape spend and forge audit attribution.
 * NOTE: directorConfigActions.ts mutations still follow the old convention —
 * sweeping those is a tracked follow-up in the Jun-9 review doc.
 *
 * Each writes one audit_log row on success and returns a small summary object
 * for a UI toast. Actions can't touch ctx.db, so the audit row is written
 * through the `_writeBackfillAudit` internalMutation below via ctx.runMutation.
 */

import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal, api } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { extractPriceFirecrawl } from "./vehicleEnrichment/firecrawl";
import { priceAllSources } from "./vehicleEnrichment/priceReextract";
import { UNVERIFIED_PRICE_TYPE } from "./lib/priceTypes";
import { roleHasCapability, type Capability, type DirectorRole } from "./directorGate";
import { buildCacheKey } from "./vehicleEnrichment/scraperQueries";
import { resolveRotorMinimums, computeAxlesWithFitment } from "./vehicleEnrichment/utils/rotorSpecResource";
import { validateRotorResolution } from "./vehicleEnrichment/validation/sanityChecks";
import { reconcileClaims } from "./vehicleEnrichment/sourceAdapters/claimLedger";

// ---------------------------------------------------------------------------
// Audit-log writer (actions can't use ctx.db — go through a mutation).
// Mirrors the audit_log shape used across directorConfigActions.ts.
// ---------------------------------------------------------------------------

export const _writeBackfillAudit = internalMutation({
  args: {
    id: v.id("vehicle_configs"),
    actorName: v.string(),
    actorId: v.optional(v.id("director_users")),
    detail: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("audit_log", {
      entity_type: "vehicle_config",
      entity_id: String(args.id),
      action: "backfill",
      actor: args.actorName,
      actor_id: args.actorId,
      detail: args.detail,
      created_at: Date.now(),
    });
  },
});

// Shared args for the three PUBLIC director backfill actions: the audit actor
// is derived from the validated session, never trusted from the caller.
const backfillArgs = {
  id: v.id("vehicle_configs"),
  /** Director session token (localStorage `otopair_director_token`) —
   *  validated server-side via director_auth.validateSession. */
  token: v.string(),
} as const;

// Args for the INTERNAL scheduled run — actor already validated by the public
// action that scheduled it.
const backfillRunArgs = {
  id: v.id("vehicle_configs"),
  actorName: v.string(),
  actorId: v.optional(v.id("director_users")),
} as const;

/** Validate the director session and return the audit actor. Throws on a
 *  missing/expired session — mirrors oto/simulate.ts simulateOtoForDirector.
 *  Actions can't use directorGate.requireDirector (no ctx.db), so this
 *  validates via director_auth.validateSession and enforces the capability
 *  with the shared roleHasCapability table. */
async function requireDirector(
  ctx: { runQuery: (ref: any, args: any) => Promise<any> },
  token: string,
  capability?: Capability,
): Promise<{ name: string; userId: Id<"director_users"> }> {
  const session = await ctx.runQuery(api.director_auth.validateSession, { token });
  if (!session) {
    throw new Error("unauthorized: invalid or expired director session");
  }
  const role = session.role as DirectorRole;
  if (capability && !roleHasCapability(role, capability)) {
    throw new Error(`forbidden: role '${role}' lacks capability '${capability}'`);
  }
  return { name: session.name, userId: session.userId };
}

// ---------------------------------------------------------------------------
// 0. backfillRotorMinimums — deterministic re-parse of ALREADY-CACHED pages.
//
// The cheapest possible backfill: no scrape, no LLM, no spend. It re-reads the
// parts markdown already on disk with the label-aware parser, so a page whose
// minimum the extraction missed can still yield one. A page that only carries a
// nominal produces NO minimum — that stays an honest gap.
// ---------------------------------------------------------------------------

export const _backfillRotorMinimumsRun = internalMutation({
  args: {
    id: v.id("vehicle_configs"),
    /** When true, run the FULL resolver + validation pipeline but skip the
     *  ctx.db.patch — the return value reports exactly what WOULD be written.
     *  Used by backfillRotorMinimumsFleet's dry-run mode. */
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const cfg = await ctx.db.get(args.id);
    if (!cfg) return { status: "not_found" as const };

    const [makeRow, modelRow] = await Promise.all([
      ctx.db.get(cfg.make_id),
      ctx.db.get(cfg.model_id),
    ]);
    const cacheKey = buildCacheKey(
      makeRow?.name ?? "",
      modelRow?.name ?? "",
      cfg.year,
      "parts_catalog",
      cfg.trim_name ?? "",
    );
    const cached = await ctx.db
      .query("scrape_cache")
      .withIndex("by_cache_key", (q) => q.eq("cache_key", cacheKey))
      .first();

    // Only axles that actually carry a rotor fitment are candidates; a drum
    // axle must never be reported as a gap. Shared helper with the pipeline
    // finalize so the two call sites can never disagree.
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.id))
      .collect();
    const fitParts = await Promise.all(fitments.map((f) => ctx.db.get(f.part_id)));
    const axlesWithFitment = computeAxlesWithFitment(
      fitParts.map((p) => ({ subcategory: p?.subcategory ?? null })),
    );

    // Aftermarket-catalogue minimums from the claim ledger, reconciled with the
    // SAME deterministic function the pipeline uses so the two call sites can
    // never disagree about what the evidence says.
    //
    // This is what makes rotor minimums healable WITHOUT a full re-enrich: the
    // network work (gatherClaims) already happened and persisted, so this
    // mutation only has to read and reconcile. A conflict_tie yields
    // `value: null` and is therefore correctly absent — a tie must contribute
    // nothing.
    const claimRows = await ctx.db
      .query("field_claims")
      .withIndex("by_config", (q) => q.eq("vehicle_config_id", args.id))
      .collect();
    const catalogClaimFor = (axle: "front" | "rear") => {
      const pick = (fieldKey: string) => {
        const forField = claimRows.filter((c) => c.field_key === fieldKey);
        if (forField.length === 0) return null;
        const verdict = reconcileClaims(fieldKey, forField as any);
        return verdict.value != null ? verdict : null;
      };
      const min = pick(`rotor_${axle}_min_thickness_mm`);
      const nominal = pick(`rotor_${axle}_nominal_thickness_mm`);
      if (!min && !nominal) return undefined;
      return {
        minMm: min?.value != null ? Number(min.value) : null,
        nominalMm: nominal?.value != null ? Number(nominal.value) : null,
        observedLabel: null,
        sourceUrl: min?.source_urls?.[0] ?? nominal?.source_urls?.[0] ?? null,
      };
    };

    const resolutions = resolveRotorMinimums({
      markdown: cached?.markdown ?? null,
      catalogClaims: {
        front: catalogClaimFor("front"),
        rear: catalogClaimFor("rear"),
      },
      existing: {
        front: {
          minMm: cfg.rotor_front_min_thickness_mm ?? null,
          nominalMm: cfg.rotor_front_nominal_thickness_mm ?? null,
          quality: cfg.rotor_front_min_quality ?? null,
          observedLabel:
            cfg.rotor_front_min_observed_label ?? cfg.rotor_min_observed_label ?? null,
          sourceUrl: cfg.rotor_min_source_url ?? null,
        },
        rear: {
          minMm: cfg.rotor_rear_min_thickness_mm ?? null,
          nominalMm: cfg.rotor_rear_nominal_thickness_mm ?? null,
          quality: cfg.rotor_rear_min_quality ?? null,
          observedLabel:
            cfg.rotor_rear_min_observed_label ?? cfg.rotor_min_observed_label ?? null,
          sourceUrl: cfg.rotor_min_source_url ?? null,
        },
      },
      naRoleKeys: (cfg.na_role_keys ?? []) as string[],
      axlesWithFitment: axlesWithFitment.length ? axlesWithFitment : undefined,
    });

    // Same physics gate as the pipeline persist — the parser's guarantees plus
    // range/impossibility/pairing checks. Previously this path wrote whatever
    // the parser returned with zero validation.
    const byAxle = Object.fromEntries(resolutions.map((r) => [r.axle, r])) as Partial<
      Record<"front" | "rear", (typeof resolutions)[number]>
    >;
    const verdict = validateRotorResolution({
      front: { minMm: byAxle.front?.minMm, nominalMm: byAxle.front?.nominalMm },
      rear: { minMm: byAxle.rear?.minMm, nominalMm: byAxle.rear?.nominalMm },
    });

    // verified_fields still guards the write, so a director's or a mechanic's
    // value can't be overwritten even if the resolver were wrong.
    const verified = new Set(cfg.verified_fields ?? []);
    const patch: Partial<Doc<"vehicle_configs">> = {};
    const rejected: string[] = [];
    for (const r of resolutions) {
      if (!r.changed) continue;
      const isFront = r.axle === "front";
      const minCol = isFront
        ? "rotor_front_min_thickness_mm"
        : "rotor_rear_min_thickness_mm";
      const nomCol = isFront
        ? "rotor_front_nominal_thickness_mm"
        : "rotor_rear_nominal_thickness_mm";
      if (r.minMm != null && !verified.has(minCol)) {
        const rejectReason = verdict.rejects[r.axle];
        if (rejectReason) {
          rejected.push(`${r.axle}:${rejectReason}`);
        } else {
          const flagReason = verdict.flags[r.axle];
          const quality =
            flagReason && (r.quality ?? "oem_spec") === "oem_spec"
              ? "oem_spec_flagged"
              : r.quality ?? "oem_spec";
          patch[minCol] = r.minMm;
          if (isFront) {
            patch.rotor_front_min_quality = quality;
            if (r.observedLabel) patch.rotor_front_min_observed_label = r.observedLabel;
          } else {
            patch.rotor_rear_min_quality = quality;
            if (r.observedLabel) patch.rotor_rear_min_observed_label = r.observedLabel;
          }
        }
      }
      if (r.nominalMm != null && !verified.has(nomCol)) {
        patch[nomCol] = r.nominalMm;
      }
    }
    const dryRun = args.dryRun ?? false;
    if (!dryRun && Object.keys(patch).length > 0) await ctx.db.patch(args.id, patch);

    const patchKeys = Object.keys(patch);
    const minsWritten = patchKeys.filter(
      (k) => k === "rotor_front_min_thickness_mm" || k === "rotor_rear_min_thickness_mm",
    ).length;
    const nominalsWritten = patchKeys.filter(
      (k) =>
        k === "rotor_front_nominal_thickness_mm" ||
        k === "rotor_rear_nominal_thickness_mm",
    ).length;

    return {
      status: "ok" as const,
      dryRun,
      hadCache: !!cached?.markdown,
      outcomes: resolutions.map((r) => `${r.axle}:${r.outcome}`),
      // In dryRun these report what WOULD have been written (patch skipped).
      written: patchKeys.length,
      minsWritten,
      nominalsWritten,
      rejected,
    };
  },
});

/** Explicit, because the action calls a mutation in its OWN module and the
 *  inferred type would otherwise be circular. */
type RotorBackfillRun =
  | { status: "not_found" }
  | {
      status: "ok";
      dryRun: boolean;
      hadCache: boolean;
      outcomes: string[];
      written: number;
      minsWritten: number;
      nominalsWritten: number;
      rejected: string[];
    };

export const backfillRotorMinimums = action({
  args: backfillArgs,
  handler: async (
    ctx,
    args,
  ): Promise<
    | { status: "not_found"; message: string }
    | { status: "done"; hadCache: boolean; outcomes: string[]; written: number }
  > => {
    const actor = await requireDirector(ctx, args.token, "data.trigger");
    const res = (await ctx.runMutation(
      internal.directorConfigBackfills._backfillRotorMinimumsRun,
      { id: args.id },
    )) as RotorBackfillRun;
    if (res.status === "not_found") {
      return { status: "not_found" as const, message: "Vehicle config not found" };
    }
    await ctx.runMutation(internal.directorConfigBackfills._writeBackfillAudit, {
      id: args.id,
      actorName: actor.name,
      actorId: actor.userId,
      detail:
        `Rotor minimum backfill (cached-page re-parse, no spend): ` +
        `${res.outcomes.join(", ")}; ${res.written} column(s) written` +
        (res.hadCache ? "" : "; NO cached parts page on file"),
    });
    return {
      status: "done" as const,
      hadCache: res.hadCache,
      outcomes: res.outcomes,
      written: res.written,
    };
  },
});

// ---------------------------------------------------------------------------
// 0b. backfillRotorMinimumsFleet — the per-config re-parse above, FLEET-WIDE.
//
// Paginates ALL vehicle_configs (100/page) and runs _backfillRotorMinimumsRun
// on each — still no scrape, no LLM, no spend, and every write passes the same
// verified_fields guard + validateRotorResolution physics gate. Follows the
// self-continue pattern of vehicleEnrichment/backfills.ts:backfillPartPrices:
// one page per action tick, accumulators threaded through the scheduled
// continuation so the FINAL invocation logs fleet totals.
//
// Default is dryRun (resolver + validation run, NOTHING written — the run
// mutation's dryRun flag skips the patch and reports what it WOULD write).
//   npx convex run directorConfigBackfills:backfillRotorMinimumsFleet '{"dryRun":true}'
//   npx convex run directorConfigBackfills:backfillRotorMinimumsFleet '{"dryRun":false}'
// ---------------------------------------------------------------------------

/** One page of vehicle_config ids — the run mutation re-reads everything else. */
export const _vehicleConfigsPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), limit: v.number() },
  handler: async (ctx, { cursor, limit }) => {
    const res = await ctx.db
      .query("vehicle_configs")
      .paginate({ cursor, numItems: limit });
    return {
      ids: res.page.map((c) => c._id),
      isDone: res.isDone,
      cursor: res.continueCursor,
    };
  },
});

// Fleet accumulators, threaded through self-continued invocations so the last
// page's summary is the whole-fleet total.
const fleetAcc = v.object({
  configsScanned: v.number(),
  hadCache: v.number(),
  written: v.number(),
  minsWritten: v.number(),
  nominalsWritten: v.number(),
  rejects: v.number(),
  rejectReasons: v.record(v.string(), v.number()),
  outcomes: v.record(v.string(), v.number()),
  /** Up to 10 config ids that gained (or would gain) a minimum — spot checks. */
  gainedMinSamples: v.array(v.string()),
  /** Up to 10 config ids that gained (or would gain) ONLY a nominal. */
  gainedNominalSamples: v.array(v.string()),
});

type FleetAcc = {
  configsScanned: number;
  hadCache: number;
  written: number;
  minsWritten: number;
  nominalsWritten: number;
  rejects: number;
  rejectReasons: Record<string, number>;
  outcomes: Record<string, number>;
  gainedMinSamples: string[];
  gainedNominalSamples: string[];
};

type RotorFleetSummary = FleetAcc & {
  batch: string;
  dryRun: boolean;
  isDone: boolean;
  nextCursor: string | null;
};

export const backfillRotorMinimumsFleet = internalAction({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
    selfContinue: v.optional(v.boolean()),
    batch: v.optional(v.string()),
    acc: v.optional(fleetAcc),
  },
  handler: async (ctx, args): Promise<RotorFleetSummary> => {
    const dryRun = args.dryRun ?? true; // safe default — pass false explicitly to write
    const limit = args.limit ?? 100; // mutations are cheap; 100 configs per tick
    const selfContinue = args.selfContinue ?? true;
    const batch =
      args.batch ?? `rotor_fleet_${dryRun ? "dryrun" : "live"}_${Date.now()}`;
    const acc: FleetAcc = args.acc ?? {
      configsScanned: 0,
      hadCache: 0,
      written: 0,
      minsWritten: 0,
      nominalsWritten: 0,
      rejects: 0,
      rejectReasons: {},
      outcomes: {},
      gainedMinSamples: [],
      gainedNominalSamples: [],
    };

    const page = await ctx.runQuery(
      internal.directorConfigBackfills._vehicleConfigsPage,
      { cursor: args.cursor ?? null, limit },
    );

    for (const id of page.ids) {
      const res = (await ctx.runMutation(
        internal.directorConfigBackfills._backfillRotorMinimumsRun,
        { id, dryRun },
      )) as RotorBackfillRun;
      acc.configsScanned++;
      if (res.status !== "ok") continue; // config deleted mid-run — nothing to do
      if (res.hadCache) acc.hadCache++;
      acc.written += res.written;
      acc.minsWritten += res.minsWritten;
      acc.nominalsWritten += res.nominalsWritten;
      acc.rejects += res.rejected.length;
      for (const r of res.rejected) {
        acc.rejectReasons[r] = (acc.rejectReasons[r] ?? 0) + 1;
      }
      for (const o of res.outcomes) {
        acc.outcomes[o] = (acc.outcomes[o] ?? 0) + 1;
      }
      if (res.minsWritten > 0 && acc.gainedMinSamples.length < 10) {
        acc.gainedMinSamples.push(String(id));
      } else if (res.nominalsWritten > 0 && acc.gainedNominalSamples.length < 10) {
        acc.gainedNominalSamples.push(String(id));
      }
    }

    const summary: RotorFleetSummary = {
      batch,
      dryRun,
      ...acc,
      isDone: page.isDone,
      nextCursor: page.isDone ? null : page.cursor,
    };
    console.log(`[rotor-fleet] ${JSON.stringify(summary)}`);

    if (selfContinue && !page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.directorConfigBackfills.backfillRotorMinimumsFleet,
        { cursor: page.cursor, limit, dryRun, selfContinue, batch, acc },
      );
    }
    return summary;
  },
});

// ---------------------------------------------------------------------------
// 1. reEnrichConfig — FULL re-enrich (force + writeScope="full")
// ---------------------------------------------------------------------------

export const reEnrichConfig = action({
  args: backfillArgs,
  handler: async (ctx, args) => {
    const actor = await requireDirector(ctx, args.token, "data.trigger");
    const resolved = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.resolveConfigForBackfill,
      { vehicleConfigId: args.id },
    );
    if (!resolved) {
      return { status: "not_found" as const, message: "Vehicle config not found" };
    }
    if (!resolved.vehicleId) {
      // The vehicle-keyed pipeline requires a vehicles row to enrich against.
      return {
        status: "no_vehicle" as const,
        message: "No vehicle row attached to this config",
      };
    }

    await ctx.scheduler.runAfter(
      0,
      internal.vehicleEnrichment.v3pipeline.enrichVehicleBatchV3,
      {
        vehicleId: resolved.vehicleId,
        year: resolved.year,
        make: resolved.make,
        model: resolved.model,
        trim: resolved.trim,
        engineCode: resolved.engineCode,
        displacement: resolved.displacement,
        drivetrain: resolved.drivetrain,
        force: true,
        writeScope: "full",
        targetConfigId: args.id, // PIN: update THIS config in place (no duplicate)
      },
    );

    await ctx.runMutation(internal.directorConfigBackfills._writeBackfillAudit, {
      id: args.id,
      actorName: actor.name,
      actorId: actor.userId,
      detail: `Full re-enrich scheduled (force) for ${resolved.year} ${resolved.make} ${resolved.model} ${resolved.trim}`.trim(),
    });

    return { status: "scheduled" as const, scope: "full" as const };
  },
});

// ---------------------------------------------------------------------------
// 2. backfillConfigParts — PARTS-ONLY re-enrich (force + writeScope="parts")
// ---------------------------------------------------------------------------

export const backfillConfigParts = action({
  args: backfillArgs,
  handler: async (ctx, args) => {
    const actor = await requireDirector(ctx, args.token, "data.trigger");
    const resolved = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.resolveConfigForBackfill,
      { vehicleConfigId: args.id },
    );
    if (!resolved) {
      return { status: "not_found" as const, message: "Vehicle config not found" };
    }
    if (!resolved.vehicleId) {
      return {
        status: "no_vehicle" as const,
        message: "No vehicle row attached to this config",
      };
    }

    await ctx.scheduler.runAfter(
      0,
      internal.vehicleEnrichment.v3pipeline.enrichVehicleBatchV3,
      {
        vehicleId: resolved.vehicleId,
        year: resolved.year,
        make: resolved.make,
        model: resolved.model,
        trim: resolved.trim,
        engineCode: resolved.engineCode,
        displacement: resolved.displacement,
        drivetrain: resolved.drivetrain,
        force: true,
        writeScope: "parts",
        targetConfigId: args.id, // PIN: update THIS config in place (no duplicate)
      },
    );

    await ctx.runMutation(internal.directorConfigBackfills._writeBackfillAudit, {
      id: args.id,
      actorName: actor.name,
      actorId: actor.userId,
      detail: `Parts-only re-enrich scheduled (force) for ${resolved.year} ${resolved.make} ${resolved.model} ${resolved.trim}`.trim(),
    });

    return { status: "scheduled" as const, scope: "parts" as const };
  },
});

// ---------------------------------------------------------------------------
// 2b. repairConfigRoles — round 12: fill EMPTY binding core roles in place
// ---------------------------------------------------------------------------
//
// No purge, no re-run: detects missing binding core roles from live fitments
// (the Crosstrek shipped rear-only brake data as "complete") and repairs them
// via the state-based re-source loop — Tier-1 year-scoped storefront lookup,
// Tier-2 verified research with a drum-brake not_applicable escape. Empty-fill
// only; every write passes the blocklist/cross-make/role-identity chokepoints.
// Fire-and-return like the other backfills; the internal action logs its own
// summary and reconciles the run row via patchRunRoleHealth.

export const repairConfigRoles = action({
  args: backfillArgs,
  handler: async (ctx, args) => {
    const actor = await requireDirector(ctx, args.token, "data.trigger");
    const resolved = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.resolveConfigForBackfill,
      { vehicleConfigId: args.id },
    );
    if (!resolved) {
      return { status: "not_found" as const, message: "Vehicle config not found" };
    }

    await ctx.scheduler.runAfter(
      0,
      internal.vehicleEnrichment.resourceRoles.repairMissingRoles,
      { vehicleConfigId: args.id },
    );

    await ctx.runMutation(internal.directorConfigBackfills._writeBackfillAudit, {
      id: args.id,
      actorName: actor.name,
      actorId: actor.userId,
      detail: `Role-completeness repair scheduled for ${resolved.year} ${resolved.make} ${resolved.model} ${resolved.trim}`.trim(),
    });

    return { status: "scheduled" as const, scope: "roles" as const };
  },
});

// ---------------------------------------------------------------------------
// 3. repriceConfigParts — PRICES-ONLY, self-contained (no LLM, no pipeline)
// ---------------------------------------------------------------------------
//
// Scrapes this config's registry sources for deterministic JSON-LD prices and
// writes them onto THIS config's EXISTING parts only. Replicates the v3pipeline
// deterministic price loop (v3pipeline.ts @1946-2078): build a Map keyed by
// normalizeOemNumber(oem_part_number) → { price, source_domain, source_url } and
// upsert a "sale" price for every existing part whose normalized OEM number is in
// the map. Deterministic "sale" prices remain authoritative — we only write
// price_type:"sale", never an llm_estimate, so this can't be outranked by a
// later LLM estimate.
//
// Runs live on an explicit director click — NOT gated on BACKFILL_PARTS_PRICES.
//
// SHAPE (fixed 2026-06-09): the live multi-page scrape used to run SYNCHRONOUSLY
// inside this public action, so a slow/erroring config timed out the click
// ("Your request couldn't be completed") AND — because the only audit row was
// written on SUCCESS at the very end — left NO trace that the button was pressed.
// Now the public action is fire-and-return (mirrors reEnrichConfig above): it
// writes a "scheduled" audit row IMMEDIATELY (so every click is recorded), then
// hands the heavy scrape to the _repriceConfigPartsRun internal action below,
// which writes its own completion/error audit row. The click can no longer time
// out, and a failed scrape is recorded instead of vanishing.

export const repriceConfigParts = action({
  args: backfillArgs,
  handler: async (ctx, args) => {
    const actor = await requireDirector(ctx, args.token, "data.trigger");
    const resolved = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.resolveConfigForBackfill,
      { vehicleConfigId: args.id },
    );
    if (!resolved) {
      return { status: "not_found" as const, message: "Vehicle config not found" };
    }

    const label =
      `${resolved.year} ${resolved.make} ${resolved.model} ${resolved.trim}`.trim();

    // (a) Record EVERY click immediately, BEFORE the heavy scrape — so a timeout
    //     or error downstream can never swallow the fact that reprice was run.
    await ctx.runMutation(internal.directorConfigBackfills._writeBackfillAudit, {
      id: args.id,
      actorName: actor.name,
      actorId: actor.userId,
      detail: `Reprice parts scheduled (deterministic) for ${label}`.trim(),
    });

    // (b) Fire-and-return: do the live scrape + price writes in a scheduled
    //     internal action so this click can't time out. That action writes a
    //     completion (or error) audit row with the priced count.
    await ctx.scheduler.runAfter(
      0,
      internal.directorConfigBackfills._repriceConfigPartsRun,
      { id: args.id, actorName: actor.name, actorId: actor.userId },
    );

    return { status: "scheduled" as const, scope: "reprice" as const };
  },
});

// The heavy lifting, isolated in a scheduled internal action so it can run for
// as long as the scrape needs without timing out the director's click. The
// ENTIRE body is wrapped so any failure (scrape error, source timeout, missing
// config) is recorded as an audit row instead of vanishing silently.
export const _repriceConfigPartsRun = internalAction({
  args: backfillRunArgs,
  handler: async (ctx, args) => {
    const audit = (detail: string) =>
      ctx.runMutation(internal.directorConfigBackfills._writeBackfillAudit, {
        id: args.id,
        actorName: args.actorName,
        actorId: args.actorId,
        detail,
      });

    const resolved = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.resolveConfigForBackfill,
      { vehicleConfigId: args.id },
    );
    const label = resolved
      ? `${resolved.year} ${resolved.make} ${resolved.model} ${resolved.trim}`.trim()
      : String(args.id);

    try {
      if (!resolved) {
        await audit(`Reprice parts failed: config not found (${args.id})`);
        return;
      }

      // (1) Load this config's existing fitments → distinct part_ids → oem_parts.
      const fitments = await ctx.runQuery(
        internal.vehicleEnrichment.v3queries.getPartFitments,
        { vehicleConfigId: args.id },
      );
      // Dedup part_ids (a part can have multiple fitments — base + package variants).
      const partIdById = new Map<string, (typeof fitments)[number]["part_id"]>();
      for (const f of fitments) {
        partIdById.set(String(f.part_id), f.part_id);
      }
      if (partIdById.size === 0) {
        await audit(`Reprice parts complete: no parts on this config (${label})`);
        return;
      }

      // Hydrate each distinct part → its OEM number (the join key for pricing)
      // and a display name (a hint for the Tier-2 LLM extractor).
      const existingParts: Array<{
        part_id: (typeof fitments)[number]["part_id"];
        oem_part_number: string | null;
        part_name: string | null;
      }> = [];
      for (const partId of partIdById.values()) {
        const part = await ctx.runQuery(
          internal.vehicleEnrichment.v3queries.getOemPartById,
          { partId },
        );
        if (!part) continue;
        existingParts.push({
          part_id: partId,
          oem_part_number: (part as any).oem_part_number ?? null,
          part_name: (part as any).part_name ?? (part as any).name ?? null,
        });
      }
      if (existingParts.length === 0) {
        await audit(`Reprice parts complete: no parts on this config (${label})`);
        return;
      }

      // (2) Re-read EACH existing price's page and correct it IN PLACE via the
      // shared two-tier re-extraction (Tier 1 structured data → Tier 2 LLM on the
      // page's own text, domain-agnostic, with median guardrails). We do NOT
      // search for new sources or new parts — for every shop price already on a
      // part (the buggy "online_discount" figures) we re-fetch that exact page
      // and overwrite the row. upsertPartPrice keys by (part_id, source_domain),
      // so passing the row's OWN domain PATCHES that row in place.
      //
      // Per part we do two passes so the Tier-2 outlier guardrail has a reference:
      //   Pass 1 — fetch each row's page once; collect the Tier-1 structured
      //            prices to compute a cross-source median for THIS part.
      //   Pass 2 — run the two-tier helper on each row (reusing the fetched page);
      //            a verified price is written "sale", and a row neither tier can
      //            trust is marked "unverified" (kept for audit, excluded from the
      //            customer-facing median) instead of leaving a known-wrong value.
      let totalPrices = 0;
      let fixed = 0;
      let markedUnverified = 0;
      let fetchFailed = 0;
      for (const part of existingParts) {
        const prices = await ctx.runQuery(
          internal.vehicleEnrichment.v3queries.getPricesForPart,
          { partId: part.part_id },
        );
        const urls = (prices as any[])
          .filter((r) => r.source_url && r.source_domain)
          .map((r) => r.source_url as string);
        if (urls.length === 0) continue;

        const rows = await priceAllSources(
          urls,
          { oem: part.oem_part_number, partName: part.part_name },
          extractPriceFirecrawl,
        );
        for (const row of rows) {
          totalPrices++;
          const o = row.outcome;
          if (o.status === "fetch_failed") { fetchFailed++; continue; }
          // Patch the EXISTING row in place: upsertPartPrice keys on
          // (part_id, source_domain), so we must reuse the DB's stored
          // source_domain — domainOf(url) can differ (www-stripping) and would
          // otherwise insert a duplicate row instead of updating.
          const existingRow = (prices as any[]).find((r) => r.source_url === row.source_url);
          const source_domain = (existingRow?.source_domain as string) ?? row.source_domain;
          if (o.status === "sale") {
            await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertPartPrice, {
              part_id: part.part_id,
              price: o.price,
              price_type: "sale",
              source_domain,
              source_url: row.source_url,
              msrp: o.msrp ?? undefined,
              discount: o.discount ?? undefined,
            });
            fixed++;
          } else {
            await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertPartPrice, {
              part_id: part.part_id,
              price: typeof existingRow?.price === "number" ? existingRow.price : 0,
              price_type: UNVERIFIED_PRICE_TYPE,
              source_domain,
              source_url: row.source_url,
            });
            markedUnverified++;
          }
        }
      }

      // (3) Audit the outcome — corrected vs marked-unverified vs left-alone
      // (fetch failures are skipped, not demoted) across all rows.
      await audit(
        `Reprice parts complete: ${fixed}/${totalPrices} corrected (sale), ${markedUnverified} marked unverified, ${fetchFailed} skipped (fetch failed, left untouched) for ${label}`.trim(),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await audit(`Reprice parts failed for ${label}: ${msg}`);
      // Re-throw so the failure also surfaces in the Convex function logs.
      throw err;
    }
  },
});
