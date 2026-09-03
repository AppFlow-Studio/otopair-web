/**
 * laborBreakdown — the single reader for AGREED per-line labor.
 *
 * Per-line labor time is scattered across three axes on a booking:
 *   • SEED (estimates): services.default_labor_hours, custom_jobs.estimated_minutes,
 *     bookings.custom_services[].duration_minutes
 *   • AGREED (what the customer approved): booking_approvals.labor_allocations[]
 *   • ACTUAL (post-completion): job_actuals.actual_labor_minutes
 *
 * The recurring bug is a reader reaching for a SEED field when it wants AGREED —
 * e.g. the receipt split labor by each line's ORIGINAL estimate instead of the
 * hours the mechanic actually set (a mid-job edit lands in `labor_allocations`,
 * not back on the custom_jobs/custom_services row). The total looked right while
 * the per-line split was stale. Centralizing the AGREED read here means every
 * consumer applies the same precedence and can't drift from a hand-rolled copy.
 *
 * `labor_allocations` is the canonical AGREED source: `line_key === "base"` is the
 * booked service(s) lump, every other key is a custom-job id, `hours` is decimal.
 */

import { serviceMatchKey } from "./serviceMatch";

/** One row of `booking_approvals.labor_allocations`. */
export type LaborAllocation = {
  line_key: string;
  label?: string | null;
  hours: number;
};

/**
 * Parse an approval's `labor_allocations` into the AGREED base + per-custom-job
 * hours. The low-level primitive both the receipt and the post-job seeding read,
 * instead of each re-finding `line_key === "base"` and building its own map.
 */
export function parseAgreedLaborAllocations(
  allocations: LaborAllocation[] | null | undefined,
): { baseHours: number | null; byLineKey: Map<string, number> } {
  const byLineKey = new Map<string, number>();
  let baseHours: number | null = null;
  if (Array.isArray(allocations)) {
    for (const a of allocations) {
      if (a?.line_key == null || typeof a.hours !== "number") continue;
      if (a.line_key === "base") {
        baseHours = a.hours;
      } else {
        byLineKey.set(String(a.line_key), a.hours);
      }
    }
  }
  return { baseHours, byLineKey };
}

/** Booked (catalog) service — name + its catalog default labor hours. */
export type BaseServiceInput = { name: string; catalogHours: number | null };

/** Off-catalog line as it appears on `bookings.custom_services`. */
export type CustomServiceInput = { name: string; durationMinutes: number | null };

/** The `custom_jobs` fields needed to join a display line to its allocation. */
export type CustomJobInput = {
  _id: string;
  name: string;
  match_key?: string | null;
  estimated_minutes?: number | null;
  status?: string | null;
};

export type ResolvedLaborLine = {
  name: string;
  /** Display hours, rounded to 2dp ("0.4 HRS", never "0.28333333…"). */
  laborHours: number | null;
  /** Dollar share of the labor subtotal for this line (full-precision split). */
  laborCost: number | null;
};

/**
 * Resolve the per-line labor a receipt/invoice should show and bill, splitting
 * the labor subtotal across every line the customer is paying for.
 *
 * Precedence for each line's hours:
 *   • booked services → the AGREED "base" lump distributed by catalog hours,
 *     falling back to the catalog default when no allocation was recorded
 *   • custom lines    → the AGREED allocation for that custom-job id, falling
 *     back to the line's own estimate (duration_minutes → estimated_minutes)
 *
 * The dollar split uses full-precision hours so `laborCost` reconciles exactly
 * to `laborSubtotalDollars`; only the displayed `laborHours` is rounded.
 */
export function resolveAgreedLaborLines(input: {
  baseServices: BaseServiceInput[];
  customServices: CustomServiceInput[];
  customJobs: CustomJobInput[];
  allocations: LaborAllocation[] | null | undefined;
  /** finalApproval.labor_cents / 100, else booking.labor_cost. */
  laborSubtotalDollars: number | null;
}): { lines: ResolvedLaborLine[]; totalHours: number } {
  const { baseHours: baseAllocHours, byLineKey: allocByJobId } =
    parseAgreedLaborAllocations(input.allocations);

  // match_key → custom-job id, and match_key → fallback minutes. Declined lines
  // never bill, so they're excluded from both.
  const jobIdByKey = new Map<string, string>();
  const jobMinutesByKey = new Map<string, number>();
  for (const c of input.customJobs) {
    if (c.status === "declined") continue;
    const key = c.match_key ?? serviceMatchKey(String(c.name));
    if (!jobIdByKey.has(key)) jobIdByKey.set(key, String(c._id));
    const mins =
      typeof c.estimated_minutes === "number" && c.estimated_minutes > 0
        ? c.estimated_minutes
        : null;
    if (mins != null && !jobMinutesByKey.has(key)) jobMinutesByKey.set(key, mins);
  }

  const raw: Array<{ name: string; hours: number | null }> = [];
  let totalHours = 0;

  // Booked services: distribute the agreed "base" lump across the booked lines
  // in proportion to their catalog hours so each line reads naturally and they
  // sum to the agreed base. No allocation → the catalog default stands.
  const catalogHoursSum = input.baseServices.reduce(
    (s, b) => s + (b.catalogHours ?? 0),
    0,
  );
  for (const b of input.baseServices) {
    let hours: number | null = b.catalogHours;
    if (baseAllocHours != null) {
      hours =
        catalogHoursSum > 0 && b.catalogHours != null
          ? baseAllocHours * (b.catalogHours / catalogHoursSum)
          : input.baseServices.length === 1
            ? baseAllocHours
            : b.catalogHours;
    }
    if (hours != null) totalHours += hours;
    raw.push({ name: b.name, hours });
  }

  // Custom lines: the AGREED allocation wins over the line's original estimate.
  for (const c of input.customServices) {
    const name = typeof c.name === "string" ? c.name.trim() : "";
    if (!name) continue;
    const key = serviceMatchKey(name);
    const jobId = jobIdByKey.get(key);
    const allocHours = jobId != null ? allocByJobId.get(jobId) : undefined;
    let hours: number | null;
    if (typeof allocHours === "number") {
      hours = allocHours;
    } else {
      const mins =
        typeof c.durationMinutes === "number" && c.durationMinutes > 0
          ? c.durationMinutes
          : (jobMinutesByKey.get(key) ?? null);
      hours = mins != null ? mins / 60 : null;
    }
    if (hours != null) totalHours += hours;
    raw.push({ name, hours });
  }

  const subtotal = input.laborSubtotalDollars;
  const lines: ResolvedLaborLine[] = raw.map((s) => {
    let laborCost: number | null = null;
    if (subtotal != null && s.hours != null && totalHours > 0) {
      laborCost = (subtotal * s.hours) / totalHours;
    } else if (raw.length === 1 && subtotal != null) {
      laborCost = subtotal;
    }
    return {
      name: s.name,
      laborHours: s.hours != null ? Math.round(s.hours * 100) / 100 : null,
      laborCost,
    };
  });

  return { lines, totalHours };
}
