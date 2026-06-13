/**
 * convex/lib/labor_aggregation.ts — Service-time aggregation.
 *
 * Replaces the old "highest-confidence source wins" labor model (which made
 * Vehicle Databases the de-facto source of truth) with the same shape parts
 * pricing uses: append-only per-source observations → robust median, with
 * internal/empirical data preferred as it accrues.
 *
 * recomputeLaborForConfigService recomputes ONE (vehicle_config, service):
 *   - book_hours      = robust (UNWEIGHTED) median of CATALOG observations (VDB,
 *                       LLM book times, …), clamped to sane bounds, rounded 0.1h.
 *                       VDB is de-throned by being ONE of N median inputs (no
 *                       longer the highest-confidence winner), NOT by the per-
 *                       source `weight` — weights are currently informational
 *                       (reserved for future source-scoring) and do not bias the
 *                       median. With a lone VDB source, book_hours is VDB's value
 *                       (clamped); it's diluted as soon as a second source exists.
 *   - empirical_hours = robust median of POST-JOB actual durations from
 *                       SINGLE-service bookings, but only once there are
 *                       >= LABOR_EMPIRICAL_MIN_SAMPLES of them (else cleared).
 *
 * The resolver (convex/laborTimes.ts) already prefers empirical_hours over
 * book_hours, so empirical silently takes over per (config, service) as real
 * jobs complete — "our internal data is better" without re-enriching.
 */

import { summarizeObservations, weightedMedian } from "./robustStats";

/** Post-job actuals must reach this count before empirical overrides book time. */
export const LABOR_EMPIRICAL_MIN_SAMPLES = 3;

// Generic sanity bounds — reject absurd labor values regardless of service.
const LABOR_MIN_HOURS = 0.1;
const LABOR_MAX_HOURS = 8.0;

function clampRound(hours: number): number {
  const c = Math.min(LABOR_MAX_HOURS, Math.max(LABOR_MIN_HOURS, hours));
  return Math.round(c * 10) / 10;
}

/**
 * Collect post-job actual labor hours for a (config, service) from SINGLE-service
 * bookings only. A booking with N services has ONE total `actual_labor_minutes`
 * that cannot be split per service, so multi-service bookings are excluded to
 * avoid crediting the full duration to every service.
 */
async function collectEmpiricalHours(
  ctx: any,
  vehicleConfigId: any,
  serviceId: any,
): Promise<number[]> {
  const finalized = (await ctx.db.query("job_actuals").collect()).filter(
    (j: any) => j.finalized_at_ms != null && j.actual_labor_minutes != null,
  );
  const hours: number[] = [];
  const bookingCache = new Map<string, any>();
  const vehicleCache = new Map<string, any>();

  for (const j of finalized) {
    let booking = bookingCache.get(String(j.booking_id));
    if (booking === undefined) {
      booking = await ctx.db.get(j.booking_id);
      bookingCache.set(String(j.booking_id), booking ?? null);
    }
    if (!booking) continue;

    // SINGLE-service bookings only.
    const sids = booking.service_ids ?? [];
    if (sids.length !== 1 || String(sids[0]) !== String(serviceId)) continue;

    let vehicle = vehicleCache.get(String(booking.vin));
    if (vehicle === undefined) {
      vehicle = await ctx.db
        .query("vehicles")
        .withIndex("by_vin", (q: any) => q.eq("vin", booking.vin))
        .unique();
      vehicleCache.set(String(booking.vin), vehicle ?? null);
    }
    if (!vehicle) continue;
    if (String(vehicle.vehicle_config_id ?? "") !== String(vehicleConfigId)) continue;

    hours.push(j.actual_labor_minutes / 60);
  }
  return hours;
}

export async function recomputeLaborForConfigService(
  ctx: any,
  {
    vehicleConfigId,
    serviceId,
    now,
    bookOnly,
  }: { vehicleConfigId: any; serviceId: any; now?: number; bookOnly?: boolean },
): Promise<void> {
  const ts = now ?? Date.now();

  // ── Catalog tier: weighted robust median of per-source observations ──
  const obs = await ctx.db
    .query("labor_observations")
    .withIndex("by_config_service", (q: any) =>
      q.eq("vehicle_config_id", vehicleConfigId).eq("service_id", serviceId),
    )
    .collect();
  const catalog = obs.filter(
    (o: any) => o.tier === "catalog" && typeof o.hours === "number" && o.hours > 0,
  );

  let bookHours: number | undefined;
  let engineFamily: string | undefined;
  let hasRepairpal = false;
  if (catalog.length > 0) {
    // Weighted robust median: repairpal_motor (0.8) dominates LLM (0.3-0.5) and
    // VDB (0.05). A wrong high-weight value is guarded at WRITE time by the
    // sibling validation gate, not here.
    bookHours = clampRound(
      weightedMedian(
        catalog.map((o: any) => o.hours as number),
        catalog.map((o: any) => (o.weight ?? 1) as number),
      ),
    );
    engineFamily = catalog.find((o: any) => o.engine_family)?.engine_family;
    hasRepairpal = catalog.some((o: any) => o.source === "repairpal_motor");
  }

  // ── Empirical tier: post-job actuals, gated at the min sample size ──
  // Skipped under bookOnly (the enrichment/scrape path): a scrape cannot change
  // post-job actuals, so there's no reason to full-scan job_actuals on every
  // observation write. Empirical is recomputed on job finalize + the cron.
  let empirical: { hours: number; n: number; p25: number; p75: number } | null = null;
  let empiricalCount = 0;
  if (!bookOnly) {
    const empiricalArr = await collectEmpiricalHours(ctx, vehicleConfigId, serviceId);
    empiricalCount = empiricalArr.length;
    if (empiricalArr.length >= LABOR_EMPIRICAL_MIN_SAMPLES) {
      const s = summarizeObservations(empiricalArr);
      empirical = { hours: s.median, n: empiricalArr.length, p25: s.p25, p75: s.p75 };
    }
  }

  // Data-good signal (spec §3.7). RepairPal (MOTOR) is the high-trust anchor;
  // corroboration by a second non-VDB source within 20% bumps it to 0.9.
  //
  // DECISION (Jun 9 2026 review): without a repairpal_motor observation the
  // ceiling is 0.6, which is BELOW the quote gate's MIN_VDB_CONFIDENCE (0.75)
  // — i.e. LLM-only consensus intentionally does NOT quote; the quote falls to
  // the transparent tier_estimate layer instead. That also means recompute can
  // downgrade an old VDB row (0.9) below the gate — accepted, that's the VDB
  // de-throning. Rollout consequence: flip LABOR_SOURCE_REPAIRPAL=on BEFORE
  // any catalog-wide re-enrich/relabor, or Layer-1 labor goes dark.
  const nonVdb = catalog.filter((o: any) => o.source !== "vdb_repair_estimates");
  const agree = (a: number, b: number) => Math.abs(a - b) / Math.max(a, b) <= 0.2;
  let confidence: number | undefined;
  if (bookHours !== undefined) {
    if (hasRepairpal) {
      const corroborated = nonVdb.some(
        (o: any) => o.source !== "repairpal_motor" && agree(o.hours, bookHours!),
      );
      confidence = corroborated ? 0.9 : 0.8;
    } else if (nonVdb.length >= 2) {
      confidence = 0.6;
    } else {
      confidence = 0.4;
    }
  }

  // ── Upsert the single labor_times row ──
  const existing = await ctx.db
    .query("labor_times")
    .withIndex("by_vehicle_config_and_service", (q: any) =>
      q.eq("vehicle_config_id", vehicleConfigId).eq("service_id", serviceId),
    )
    .first();

  // Clear empirical to 0 when below the gate so the resolver falls back to
  // book_hours (it treats empirical_hours > 0 as "use empirical"). Under
  // bookOnly we leave the empirical fields untouched (finalize/cron own them).
  const empiricalPatch = bookOnly
    ? null
    : {
        empirical_hours: empirical ? empirical.hours : 0,
        empirical_sample_size: empirical ? empirical.n : empiricalCount,
        empirical_p25: empirical ? empirical.p25 : 0,
        empirical_p75: empirical ? empirical.p75 : 0,
      };

  if (existing) {
    const patch: any = {};
    if (empiricalPatch) Object.assign(patch, empiricalPatch);
    // Only relabel source/book_hours when catalog observations actually drove
    // the value — otherwise a default-filled row would be mislabeled 'aggregated'.
    if (bookHours !== undefined) {
      patch.book_hours = bookHours;
      patch.confidence = confidence;
      patch.source = "aggregated";
      // Explicitly clear any stale clone/training stamp: the quote gate
      // disqualifies on data_quality, and a leftover 'chassis_clone' would
      // silently veto a freshly aggregated RepairPal/MOTOR value.
      patch.data_quality = "aggregated";
      if (engineFamily) patch.engine_family = engineFamily;
    }
    if (Object.keys(patch).length > 0) await ctx.db.patch(existing._id, patch);
    return;
  }

  if (bookHours === undefined && !empirical) return; // nothing to write

  await ctx.db.insert("labor_times", {
    vehicle_config_id: vehicleConfigId,
    service_id: serviceId,
    engine_family: engineFamily,
    book_hours: bookHours,
    source: bookHours !== undefined ? "aggregated" : undefined,
    data_quality: bookHours !== undefined ? "aggregated" : undefined,
    confidence,
    empirical_hours: empirical ? empirical.hours : 0,
    empirical_sample_size: empirical ? empirical.n : empiricalCount,
    empirical_p25: empirical ? empirical.p25 : 0,
    empirical_p75: empirical ? empirical.p75 : 0,
    created_at: ts,
  });
}
