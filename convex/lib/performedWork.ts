/**
 * "Was this recommendation's work actually done on this visit?"
 *
 * `deriveSuggestedRecommendations` (lib/inspection-template.ts) is a pure
 * function of the inspection state — it takes no booking, no job_actuals, no
 * parts. So it reads `wipe = r`, emits "Wiper Blade Replacement / soon", and
 * has no way to know the wipers were fitted an hour ago.
 *
 * That produced the Aug 20 partner-session bug twice. Abdul, on wipers he had
 * just replaced: "it added it to soon and I thought it would still remember."
 * Then again on the tire: "do the tire replacement soon even though I already
 * did it."
 *
 * ── WHAT COUNTS AS PERFORMED ────────────────────────────────────────────────
 * Only on a booking that actually completed. The deferred reveal job runs on
 * every terminal state — completed, cancelled, no_show and declined — and a
 * cancelled booking performed nothing at all. Suppressing there would bury a
 * real finding on a car that was never touched, which is the dangerous
 * direction of this trade: a duplicated recommendation is noise, a swallowed
 * one is a safety finding the driver never hears about.
 *
 * A DECLINED line is not performed. `custom_jobs.status` distinguishes them,
 * and a customer who turned down a tire replacement still needs to be told the
 * tire is worn — arguably more than anyone.
 */

import { serviceMatchKey } from "./serviceMatch";

export type PerformedWork = {
  /** Catalog service ids performed on this visit. */
  serviceIds: Set<string>;
  /** Catalog slugs performed, for the oil-top-off style overrides. */
  slugs: Set<string>;
  /** Match keys of every performed service / custom line, for freeform recs. */
  matchKeys: Set<string>;
};

export const EMPTY_PERFORMED_WORK: PerformedWork = {
  serviceIds: new Set(),
  slugs: new Set(),
  matchKeys: new Set(),
};

/**
 * Collect what this booking actually did. Returns an empty set for any booking
 * that didn't complete, so no suppression can happen on a job that never ran.
 */
export async function collectPerformedWork(
  ctx: any,
  booking: any,
): Promise<PerformedWork> {
  if (booking?.status !== "completed") return EMPTY_PERFORMED_WORK;

  const serviceIds = new Set<string>();
  const slugs = new Set<string>();
  const matchKeys = new Set<string>();

  for (const serviceId of (booking.service_ids ?? []) as any[]) {
    const service = await ctx.db.get(serviceId);
    if (!service) continue;
    serviceIds.add(String(serviceId));
    if (typeof service.slug === "string" && service.slug) slugs.add(service.slug);
    if (typeof service.name === "string" && service.name) {
      matchKeys.add(serviceMatchKey(service.name));
    }
  }

  // Off-catalog lines. `completed` only — a declined or cancelled line records
  // what was OFFERED, not what was done.
  const customJobs = await ctx.db
    .query("custom_jobs")
    .withIndex("by_booking", (q: any) => q.eq("booking_id", booking._id))
    .collect();
  for (const job of customJobs) {
    if (job.status !== "completed") continue;
    if (typeof job.name === "string" && job.name) {
      matchKeys.add(serviceMatchKey(job.name));
    }
  }

  return { serviceIds, slugs, matchKeys };
}

/**
 * Freeform recommendations that a performed catalog service resolves, but whose
 * label would never match it by name. "Oil Top-Off" and "Oil Change" share no
 * useful tokens, yet a shop that changed the oil unavoidably topped it off —
 * per spec: "an oil change clears the oil top-off. Never recommend both."
 *
 * Coolant and washer top-offs aren't here because they no longer generate at
 * all (see deriveSuggestedRecommendations) — courtesy fluids, shop protocol.
 */
const SLUG_CLEARS_FREEFORM: Array<{ slug: string; label: string }> = [
  { slug: "oil_change", label: "Oil Top-Off" },
];

/** Was the work behind this recommendation performed on this visit? */
export function recommendationWasPerformed(
  rec: { recommended_service_id?: unknown; freeform_text?: unknown },
  performed: PerformedWork,
  /**
   * Resolved catalog service name for `recommended_service_id`, when the caller
   * has it. A catalog rec can be satisfied by an off-catalog custom line — a
   * mid-job "Add to this job" is recorded by NAME only (custom_jobs.name) and
   * never enters booking.service_ids — so without matching the name a rec the
   * shop clearly resolved this visit would be re-revealed to the driver instead
   * of closing as completed. `collectPerformedWork` records custom lines (and
   * catalog services) by matchKey, so the name check catches both.
   */
  serviceName?: string | null,
): boolean {
  if (rec.recommended_service_id) {
    if (performed.serviceIds.has(String(rec.recommended_service_id))) return true;
    const nameKey =
      typeof serviceName === "string" ? serviceMatchKey(serviceName) : "";
    return nameKey.length > 0 && performed.matchKeys.has(nameKey);
  }

  const label = typeof rec.freeform_text === "string" ? rec.freeform_text.trim() : "";
  if (!label) return false;

  for (const pair of SLUG_CLEARS_FREEFORM) {
    if (
      performed.slugs.has(pair.slug) &&
      serviceMatchKey(label) === serviceMatchKey(pair.label)
    ) {
      return true;
    }
  }

  return performed.matchKeys.has(serviceMatchKey(label));
}
