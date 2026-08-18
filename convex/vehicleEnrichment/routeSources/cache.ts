// =============================================================================
// routeSources/cache.ts — when a route walk is worth paying for again.
//
// Modelled on manualLibrary.shouldSkipManualLookup, with one deliberate
// difference: that function has TWO states to reason about (resolved / failed)
// because a PDF either downloads or does not. A route walk has THREE, and
// collapsing them is the failure this file exists to prevent:
//
//   ok   — we read content. Static text; re-walking soon buys nothing.
//   gap  — the site does not carry this vehicle. Sites DO add coverage, so
//          this expires — just slowly.
//   fail — the site broke, blocked us, or changed shape. Transient far more
//          often than not, so it expires fast; `attempts` is what stops a
//          permanently-broken source from costing a walk on every run.
//
// This cache is READ ONLY BY THE ROUTE PIPELINE. It must never be consulted by
// shouldSkipManualLookup and vice versa — a dead route may not suppress a PDF
// retry, and a rejected PDF may not suppress a route walk. See the
// vehicle_route_docs comment in schema.ts.
// =============================================================================

const DAY_MS = 24 * 60 * 60 * 1000;

/** Content is static; a successful walk is good for a long time. */
export const ROUTE_OK_REFRESH_DAYS = 60;

/**
 * A coverage gap is not permanent — republishers add model years continuously
 * — but re-walking a five-rung ladder to rediscover the same absence is pure
 * cost. Roughly one content cycle.
 */
export const ROUTE_GAP_TTL_DAYS = 90;

/** Blocks and outages usually clear within hours. */
export const ROUTE_FAIL_TTL_DAYS = 3;

/**
 * After this many consecutive failures the source is treated as gapped for this
 * vehicle rather than retried on the short TTL. A site redesign fails
 * identically forever, and without this bound it would be re-walked every run
 * until someone noticed.
 */
export const ROUTE_MAX_FAILS = 5;

export type RouteDocRowLike = {
  outcome?: string | null;
  walked_at?: number | null;
  attempts?: number | null;
} | null;

export type RouteSkipDecision = { skip: boolean; reason: string };

export function shouldSkipRouteWalk(
  row: RouteDocRowLike,
  now: number = Date.now(),
  opts?: { okRefreshDays?: number; gapTtlDays?: number; failTtlDays?: number; maxFails?: number },
): RouteSkipDecision {
  if (!row) return { skip: false, reason: "no_row" };

  const walkedAt = typeof row.walked_at === "number" ? row.walked_at : 0;
  const age = now - walkedAt;
  const attempts = typeof row.attempts === "number" ? row.attempts : 0;
  const outcome = (row.outcome ?? "").trim().toLowerCase();

  const okTtl = (opts?.okRefreshDays ?? ROUTE_OK_REFRESH_DAYS) * DAY_MS;
  const gapTtl = (opts?.gapTtlDays ?? ROUTE_GAP_TTL_DAYS) * DAY_MS;
  const failTtl = (opts?.failTtlDays ?? ROUTE_FAIL_TTL_DAYS) * DAY_MS;
  const maxFails = opts?.maxFails ?? ROUTE_MAX_FAILS;

  if (outcome === "ok") {
    return age < okTtl ? { skip: true, reason: "fresh_route_walk" } : { skip: false, reason: "route_stale" };
  }

  if (outcome === "gap") {
    return age < gapTtl ? { skip: true, reason: "known_gap" } : { skip: false, reason: "gap_expired" };
  }

  if (outcome === "fail") {
    if (attempts >= maxFails) {
      // Same bound as MANUAL_MAX_REJECTIONS: a self-correcting loop is only
      // worth running while it can still correct something.
      return age < gapTtl
        ? { skip: true, reason: `fail_bounded_${attempts}` }
        : { skip: false, reason: "fail_bound_expired" };
    }
    return age < failTtl ? { skip: true, reason: "recent_failure" } : { skip: false, reason: "retry_failure" };
  }

  return { skip: false, reason: `unknown_outcome_${outcome || "empty"}` };
}
