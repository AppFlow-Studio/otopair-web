export type JobActualPart = {
  part_name: string;
  brand?: string | null;
  oem_number: string;
  cost: number;
};

export type JobActualDetails = {
  status: "draft" | "finalized";
  startedAt?: number | null;
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

export function getDefaultLaborMinutes(
  jobActuals: JobActualDetails,
  estimatedLaborMinutes?: number | null,
) {
  if (jobActuals?.actualLaborMinutes != null) {
    return jobActuals.actualLaborMinutes;
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
    laborMinutes: string;
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

  return {
    actual_labor_minutes:
      values.laborMinutes.trim() === "" ? null : Number(values.laborMinutes),
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
