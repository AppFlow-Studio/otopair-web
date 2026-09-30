import { hoursToMinutes, parseHoursInput } from "./labor-units";
import { workedMsAt, type JobClock } from "@/convex/lib/jobClock";

export type JobActualPart = {
  part_name: string;
  brand?: string | null;
  oem_number: string;
  cost: number;
};

export type JobActualDetails = {
  status: "draft" | "finalized";
  startedAt?: number | null;
  /** The inspection window — Start Job to the MPI gate closing. Recorded
   *  separately from startedAt so micrometer time stays out of labor. */
  mpiStartedAt?: number | null;
  mpiCompletedAt?: number | null;
  completedAtMs?: number | null;
  actualLaborMinutes?: number | null;
  actualPartsCost?: number | null;
  difficultyRating?: number | null;
  technicianNotes?: string;
  partsUsed?: JobActualPart[];
} | null | undefined;

export type JobActualsPayload = {
  actual_labor_minutes?: number | null;
  actual_parts_cost?: number | null;
  difficulty_rating?: number | null;
  technician_notes?: string | null;
  parts_used?: JobActualPart[] | null;
};

export type PartRowState = {
  part_name: string;
  brand: string;
  oem_number: string;
  cost: string;
};

/** Shown when a part the shop is charging for has no name. The server rejects
 *  that row (convex/lib/job_actuals.ts, booking_approvals.performSubmission) —
 *  an unnamed priced line reached customers as a blank row (#331). */
export const UNNAMED_PRICED_PART_MESSAGE =
  "Every part with a price needs a name. Add a name or remove the part.";

/** True when any row has a price but no name. */
export function hasUnnamedPricedPart(
  parts: Array<{ part_name: string; cost: string }>,
): boolean {
  return parts.some((p) => !p.part_name.trim() && Number(p.cost || 0) > 0);
}

export function toNumberString(value?: number | null) {
  return value == null ? "" : String(value);
}

export function buildPartRows(parts?: JobActualPart[]): PartRowState[] {
  if (!parts || parts.length === 0) return [];
  return parts.map((part) => ({
    part_name: part.part_name,
    brand: part.brand ?? "",
    oem_number: part.oem_number,
    cost: toNumberString(part.cost),
  }));
}

/**
 * What the labor field starts at: the recorded actual if there is one, else
 * the time on the clock, else the estimate. With the job clock (`clock`) the
 * clock figure is WORKED time — blockers, recorded flag-issue time and the
 * mechanic's Pause subtracted — not wall clock since start, which prefilled
 * paused time as labor (bug #348). Without it, the old wall-clock figure.
 */
export function getDefaultLaborMinutes(
  jobActuals: JobActualDetails,
  estimatedLaborMinutes?: number | null,
  clock?: JobClock | null,
) {
  if (jobActuals?.actualLaborMinutes != null) {
    return jobActuals.actualLaborMinutes;
  }

  if (clock?.startedAtMs != null) {
    return Math.max(0, Math.round(workedMsAt(clock, Date.now()) / 60000));
  }

  if (jobActuals?.startedAt != null) {
    const endedAt = jobActuals.completedAtMs ?? Date.now();
    return Math.max(0, Math.round((endedAt - jobActuals.startedAt) / 60000));
  }

  return estimatedLaborMinutes ?? null;
}

export function toPayload(
  parts: PartRowState[],
  values: {
    laborHours: string;
    partsCost: string;
    difficultyRating: string;
    technicianNotes: string;
  },
): JobActualsPayload {
  const normalizedParts = parts
    .filter(
      (part) =>
        part.part_name.trim() ||
        part.brand.trim() ||
        part.oem_number.trim() ||
        part.cost.trim(),
    )
    .map((part) => ({
      part_name: part.part_name.trim(),
      brand: part.brand.trim() || null,
      oem_number: part.oem_number.trim(),
      cost: Number(part.cost || 0),
    }));

  const laborHours = parseHoursInput(values.laborHours);
  return {
    actual_labor_minutes: laborHours == null ? null : hoursToMinutes(laborHours),
    actual_parts_cost:
      values.partsCost.trim() === "" ? null : Number(values.partsCost),
    difficulty_rating:
      values.difficultyRating.trim() === ""
        ? null
        : Number(values.difficultyRating),
    technician_notes: values.technicianNotes,
    parts_used: normalizedParts,
  };
}
