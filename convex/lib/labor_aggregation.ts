/**
 * convex/lib/labor_aggregation.ts — Service-time aggregation.
 *
 * Replaces the old "highest-confidence source wins" labor model (which made
 * Vehicle Databases the de-facto source of truth) with the same shape parts
 * pricing uses: append-only per-source observations → robust median, with
 * internal/empirical data preferred as it accrues.
 *
 * recomputeLaborForConfigService recomputes ONE (vehicle_config, service):
 *   - book_hours      = robust WEIGHTED median of CATALOG observations (OLP,
 *                       LLM book times, VDB, …), clamped to sane bounds, rounded
 *                       0.1h. Each source's `weight` biases the result
 *                       (weightedMedian walks the cumulative-weight frontier), so
 *                       the high-trust anchor olp_labor (0.8) dominates LLM
 *                       (0.3-0.5) and VDB (0.05). With a lone source, book_hours
 *                       is that source's value (clamped).
 *   - empirical_hours = robust median of POST-JOB actual durations from
 *                       SINGLE-service bookings, but only once there are
 *                       >= LABOR_EMPIRICAL_MIN_SAMPLES of them (else cleared).
 *
 * The resolver (convex/laborTimes.ts) already prefers empirical_hours over
 * book_hours, so empirical silently takes over per (config, service) as real
 * jobs complete — "our internal data is better" without re-enriching.
 */

import { summarizeObservations, weightedMedian, nonOutlierIndices } from "./robustStats";
import { STRONG_LABOR_SOURCES, withinGuardrail, withinAgreementBand } from "./laborBands";
import { computeLaborTierFloorHours } from "./laborFallback";
import { detectTier } from "./quoteEngine";

// Empirical sample-size gates live in a leaf module (laborConstants, no imports)
// so importing them here can't form a cycle with quoteEngine (which imports
// detectTier from this file). Re-exported for the existing importers of these names.
import { LABOR_EMPIRICAL_MIN_SAMPLES, LABOR_EMPIRICAL_QUOTE_MIN_SAMPLES } from "./laborConstants";
export { LABOR_EMPIRICAL_MIN_SAMPLES, LABOR_EMPIRICAL_QUOTE_MIN_SAMPLES };

// Generic sanity bounds — reject absurd labor values regardless of service.
const LABOR_MIN_HOURS = 0.1;
const LABOR_MAX_HOURS = 8.0;

function clampRound(hours: number): number {
  const c = Math.min(LABOR_MAX_HOURS, Math.max(LABOR_MIN_HOURS, hours));
  return Math.round(c * 10) / 10;
}

/**
 * Book-hours precedence. The RepairPal estimate endpoint is exact MOTOR/Chilton
 * flat-rate time — the most authoritative labor source we have — so when an
 * `repairpal_endpoint` observation exists it IS the book value (the face value),
 * never averaged down by lower-weight sources (a real disagreement is surfaced
 * by the confidence/`labor_sources_disagree` flag, not resolved away). When no
 * endpoint observation exists, book_hours is the robust WEIGHTED median of the
 * remaining catalog sources (OLP/web/LLM/…) — the agreement model. Clamped.
 */
export function resolveBookHours(
  catalog: { hours: number; weight?: number; source: string }[],
): number {
  const endpoint = catalog.find((o) => o.source === "repairpal_endpoint" && o.hours > 0);
  if (endpoint) return clampRound(endpoint.hours);
  return clampRound(
    weightedMedian(
      catalog.map((o) => o.hours),
      catalog.map((o) => o.weight ?? 1),
    ),
  );
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
  if (catalog.length > 0) {
    // Weighted robust median over the catalog sources, each carrying its own
    // weight: repairpal_endpoint (0.9) wins outright when present; otherwise
    // olp_labor (0.7) anchors with web_labor (0.6) as additional corroboration,
    // ahead of LLM (0.3-0.5) and VDB (0.05). A wrong high-weight value is
    // guarded at WRITE time by the scrape's sanity gate, not here.
    bookHours = resolveBookHours(catalog as { hours: number; weight?: number; source: string }[]);
    engineFamily = catalog.find((o: any) => o.engine_family)?.engine_family;
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

  // ── Agreement + fallback-guardrail confidence (spec 2026-06-13) ──
  // Confidence comes from source AGREEMENT, not source identity, and every
  // value is weighed against the Pricing-v2 tier fallback within a 15-min
  // guardrail. The fallback FLAGS a suspicious single source; it never inflates.
  let confidence: number | undefined;
  let outsideFallbackBand = false;
  let sourcesDisagree = false;
  let fallbackGapMinutes: number | undefined;

  if (bookHours !== undefined) {
    // `kept` mirrors the observations weightedMedian actually used (its internal
    // MAD drops wide outliers at n>=4), so confidence reflects what DROVE
    // book_hours — a strong source dropped as an outlier must not lend its trust
    // to a value the weaker sources produced. Disagreement, by contrast, uses the
    // PRE-MAD strong set so a contested pair is still flagged after MAD removes one.
    const keepIdx = new Set(nonOutlierIndices(catalog.map((o: any) => o.hours as number)));
    const kept = catalog.filter((_: any, i: number) => keepIdx.has(i));
    const strongRaw = catalog.filter((o: any) => STRONG_LABOR_SOURCES.has(o.source));
    const strong = kept.filter((o: any) => STRONG_LABOR_SOURCES.has(o.source));
    const nonVdb = kept.filter((o: any) => o.source !== "vdb_repair_estimates");

    // Tier fallback for the guardrail. detectTier resolves the tier via the rule
    // engine when pricing_tier hasn't been persisted yet (fresh enrichments set it
    // lazily at first quote), so the guardrail isn't silently skipped for new cars.
    const cfg = await ctx.db.get(vehicleConfigId);
    const tier = cfg ? await detectTier(ctx, cfg) : null;
    let fallbackHours: number | null = null;
    if (tier) {
      fallbackHours = await computeLaborTierFloorHours(ctx, {
        serviceId,
        vehicleTier: tier,
      });
    }
    let fallbackOutOfBand = false;
    if (fallbackHours != null) {
      // Round the fallback to book_hours' 0.1h precision so the 15-min band
      // isn't tripped by a rounding asymmetry at the boundary.
      const fb = Math.round(fallbackHours * 10) / 10;
      fallbackGapMinutes = Math.round(Math.abs(bookHours - fb) * 60);
      fallbackOutOfBand = !withinGuardrail(bookHours, fb);
    }

    if (strongRaw.length >= 2) {
      const hrs = strongRaw.map((o: any) => o.hours as number);
      sourcesDisagree = !withinAgreementBand(Math.min(...hrs), Math.max(...hrs));
    }

    if (strong.length >= 2 && !sourcesDisagree) {
      confidence = 0.9; // ≥2 strong sources agree
    } else if (sourcesDisagree) {
      // Contested but real — quotable (clears the 0.75 gate) and flagged for
      // director review, rather than punting to a worse tier estimate.
      confidence = 0.75;
    } else if (strong.length >= 1 && strong.some((o: any) => withinAgreementBand(o.hours as number, bookHours))) {
      // 1 strong source that actually DROVE book_hours (its value is within the
      // agreement band of the weighted-median result). A strong source that
      // SURVIVED MAD but was OUTVOTED on the frontier must not lend its 0.8 to a
      // value the weaker sources produced — same invariant as the MAD-drop guard.
      if (fallbackOutOfBand) {
        confidence = 0.6;
        outsideFallbackBand = true;
      } else {
        confidence = 0.8; // within guardrail, or no fallback to corroborate
      }
    } else if (nonVdb.length >= 2) {
      confidence = 0.6; // LLM-only consensus — below the 0.75 quote gate
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
      // silently veto a freshly aggregated OLP value.
      patch.data_quality = "aggregated";
      if (engineFamily) patch.engine_family = engineFamily;
      patch.labor_outside_fallback_band = outsideFallbackBand;
      patch.labor_sources_disagree = sourcesDisagree;
      patch.fallback_gap_minutes = fallbackGapMinutes;
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
    labor_outside_fallback_band: outsideFallbackBand,
    labor_sources_disagree: sourcesDisagree,
    fallback_gap_minutes: fallbackGapMinutes,
    empirical_hours: empirical ? empirical.hours : 0,
    empirical_sample_size: empirical ? empirical.n : empiricalCount,
    empirical_p25: empirical ? empirical.p25 : 0,
    empirical_p75: empirical ? empirical.p75 : 0,
    created_at: ts,
  });
}
