/**
 * convex/lib/estimatorApi.ts — external estimator endpoint configuration.
 *
 * The provider's hostname is deliberately NOT in source. It is supplied per
 * deployment via Convex environment variables, so the repository never names
 * the vendor while the integration keeps resolving.
 *
 * Required environment variables (see the migration runbook,
 * docs/superpowers/runbooks/2026-07-27-vendor-name-purge-migration.md):
 *
 *   ESTIMATOR_API_BASE      Base URL of the estimate endpoint, no trailing
 *                           slash. Callers append /makes, /base-vehicles,
 *                           /estimate. UNSET → every estimator lookup is
 *                           skipped and reports resolved:false (graceful; the
 *                           labor aggregate simply falls back to its other
 *                           catalog sources).
 *
 *   ESTIMATOR_SPEC_DOMAINS  Comma-separated hostnames that should count as
 *                           high-authority spec sources (see
 *                           vehicleEnrichment/validation/sourceAuthority.ts).
 *                           UNSET → those hostnames merely lose single-source
 *                           accept and need corroboration instead. Degrades
 *                           quality, never breaks.
 */

/** Base URL for the estimate endpoint, or null when unconfigured. */
export function estimatorApiBase(): string | null {
  const base = process.env.ESTIMATOR_API_BASE;
  if (!base) return null;
  return base.replace(/\/+$/, "");
}

/**
 * Base URL, logging once when unconfigured so a silently-skipped enrichment run
 * is diagnosable from the Convex logs rather than looking like a provider miss.
 */
export function requireEstimatorApiBase(context: string): string | null {
  const base = estimatorApiBase();
  if (!base) {
    console.warn(
      `[estimator] ESTIMATOR_API_BASE not set — skipping ${context}. ` +
        `Set it on this deployment to re-enable the estimator source.`,
    );
  }
  return base;
}

/** Hostnames the estimator provider serves spec pages from (env-supplied). */
export function estimatorSpecDomains(): string[] {
  return (process.env.ESTIMATOR_SPEC_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Stable, vendor-neutral marker written to `part_prices.source_url` for rows
 * projected from the estimate endpoint. This value lands in the DATABASE, so it
 * must never contain the provider hostname. It is an internal scheme, not a
 * fetchable URL — the raw response is already cached in `estimator_estimates`.
 */
export const ESTIMATOR_SOURCE_URL = "internal://estimator/estimate";
