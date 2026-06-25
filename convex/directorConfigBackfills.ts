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
import { action, internalAction, internalMutation } from "./_generated/server";
import { internal, api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { extractPriceFirecrawl } from "./vehicleEnrichment/firecrawl";
import { priceAllSources } from "./vehicleEnrichment/priceReextract";
import { UNVERIFIED_PRICE_TYPE } from "./lib/priceTypes";

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
 *  missing/expired session — mirrors oto/simulate.ts simulateOtoForDirector. */
async function requireDirector(
  ctx: { runQuery: (ref: any, args: any) => Promise<any> },
  token: string,
): Promise<{ name: string; userId: Id<"director_users"> }> {
  const session = await ctx.runQuery(api.director_auth.validateSession, { token });
  if (!session) {
    throw new Error("unauthorized: invalid or expired director session");
  }
  return { name: session.name, userId: session.userId };
}

// ---------------------------------------------------------------------------
// 1. reEnrichConfig — FULL re-enrich (force + writeScope="full")
// ---------------------------------------------------------------------------

export const reEnrichConfig = action({
  args: backfillArgs,
  handler: async (ctx, args) => {
    const actor = await requireDirector(ctx, args.token);
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
    const actor = await requireDirector(ctx, args.token);
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
    const actor = await requireDirector(ctx, args.token);
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
