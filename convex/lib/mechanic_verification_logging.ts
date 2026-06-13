/**
 * mechanic_verification_logging.ts — bridge the pre-job spec review into the
 * Director "Mechanic Edits" page.
 *
 * The Director tab (`TabMechanicEdits.tsx`) reads the `mechanic_verifications`
 * table. Until now the only writer was `services/verification.ts ::
 * processMechanicVerification`, which is an internalMutation called *only* by
 * the test suite — so in production the table was always empty.
 *
 * This helper closes that gap: every time a mechanic submits the pre-job
 * survey we diff the values they entered against the vehicle passport we showed
 * them, and upsert ONE `mechanic_verifications` row (status:"pending") carrying
 * the per-field `confirmed | corrected` decisions. That row is exactly the
 * shape `director_mechanic_verifications.mapRow` + `acceptVerification` /
 * `undoMechanicVerification` expect.
 *
 * Called from `persistPrejobSurvey` (the single chokepoint behind
 * commitInspectionAndAwaitEstimate / savePrejob / startWithPrejob), so all
 * pre-job paths log identically. It is best-effort: a failure here must never
 * roll back the pre-job submit, so the whole body is wrapped in try/catch and
 * the row insert is the last write.
 */

// field_name keys use the Director field-routing vocabulary where one exists
// (see undoMechanicVerification.ts §8 sets). Keys not in those sets still log
// and render on the page; they just won't write-through to a data table on
// accept/undo — acceptable for an audit row.
type FieldMapping = {
  field_name: string;
  our: unknown;
  mechanic: unknown;
};

// Schema stores overall_accuracy as a number (0–1) so the AccuracyBar renders a
// percent. Mirror the enum→number map in services/verification.ts.
const ACCURACY_BY_ENUM: Record<string, number> = {
  accurate: 1.0,
  mostly_accurate: 0.85,
  needs_correction: 0.5,
};

/** Trimmed display string, or undefined for "no value". */
function displayValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  const s = String(value).trim();
  return s.length > 0 ? s : undefined;
}

/** Loose equality for comparing "our" vs mechanic value — case/space
 *  insensitive, and numeric-aware (so 6 == 6.0 and "6.0 qts" stays distinct). */
function sameValue(a: string, b: string): boolean {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function buildVerifications(prejob: any, passport: any) {
  const fluids = passport?.fluids ?? {};
  const tires = passport?.tires ?? {};
  const overrides = prejob?.fluid_overrides ?? {};

  const mappings: FieldMapping[] = [
    { field_name: "oil_viscosity", our: fluids.oil_viscosity, mechanic: overrides.oil_viscosity },
    { field_name: "oil_capacity_qts", our: fluids.oil_capacity_qts, mechanic: overrides.oil_capacity_qts },
    { field_name: "oil_type", our: fluids.oil_type, mechanic: overrides.oil_type },
    { field_name: "coolant_type", our: fluids.coolant_type, mechanic: overrides.coolant_type },
    { field_name: "brake_fluid_type", our: fluids.brake_fluid_type, mechanic: overrides.brake_fluid_type },
    { field_name: "transmission_fluid_type", our: fluids.transmission_fluid_type, mechanic: overrides.transmission_fluid_type },
    { field_name: "tire_size_front", our: tires.size_front, mechanic: prejob?.tire_size_front },
    { field_name: "tire_size_rear", our: tires.size_rear, mechanic: prejob?.tire_size_rear },
    { field_name: "tire_brand", our: tires.brand, mechanic: prejob?.tire_brand },
  ];

  const verifications: Array<{
    field_name: string;
    our_value: string;
    status: "confirmed" | "corrected";
    corrected_value?: string;
  }> = [];
  let correctedCount = 0;

  for (const m of mappings) {
    const mechanicStr = displayValue(m.mechanic);
    // The mechanic didn't enter anything for this field — nothing to verify.
    if (mechanicStr === undefined) continue;
    const ourStr = displayValue(m.our) ?? "";

    if (ourStr !== "" && sameValue(ourStr, mechanicStr)) {
      verifications.push({
        field_name: m.field_name,
        our_value: ourStr,
        status: "confirmed",
      });
    } else {
      correctedCount += 1;
      verifications.push({
        field_name: m.field_name,
        our_value: ourStr,
        status: "corrected",
        corrected_value: mechanicStr,
      });
    }
  }

  return { verifications, correctedCount };
}

function accuracyEnum(correctedCount: number, total: number): string {
  if (correctedCount === 0) return "accurate";
  if (correctedCount / total <= 0.34) return "mostly_accurate";
  return "needs_correction";
}

/**
 * Diff the pre-job survey against the shown passport and upsert a pending
 * `mechanic_verifications` row. Idempotent per (job_actual, config): a
 * re-submitted pre-job patches the existing pending row instead of stacking
 * duplicates. Never throws.
 */
export async function logPrejobMechanicVerification(
  ctx: any,
  {
    booking,
    passportView,
    prejob,
    jobActualId,
    now,
  }: {
    booking: any;
    passportView: any;
    prejob: any;
    jobActualId: any;
    now: number;
  },
) {
  try {
    // Required FKs — without any of these the row can't render on the page
    // (mapRow joins mechanic + config), so skip rather than write a dead row.
    const mechanicId = booking?.mechanic_id;
    const serviceId = Array.isArray(booking?.service_ids)
      ? booking.service_ids[0]
      : undefined;
    if (!mechanicId || !serviceId || !booking?.vin) return;

    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q: any) => q.eq("vin", booking.vin))
      .first();
    const vehicleConfigId = vehicle?.vehicle_config_id;
    if (!vehicleConfigId) return;

    const { verifications, correctedCount } = buildVerifications(
      prejob,
      passportView?.passport,
    );
    if (verifications.length === 0) return;

    const accuracy = accuracyEnum(correctedCount, verifications.length);
    const overall_accuracy = ACCURACY_BY_ENUM[accuracy] ?? 0;

    // Idempotency: reuse the open (pending) row for this job_actual + config.
    const existing = await ctx.db
      .query("mechanic_verifications")
      .withIndex("by_job", (q: any) => q.eq("job_id", jobActualId))
      .collect();
    const openRow = existing.find(
      (r: any) =>
        r.status === "pending" &&
        String(r.vehicle_config_id) === String(vehicleConfigId),
    );

    if (openRow) {
      await ctx.db.patch(openRow._id, {
        verifications,
        overall_accuracy,
        verified_at: now,
      });
      return;
    }

    await ctx.db.insert("mechanic_verifications", {
      mechanic_id: mechanicId,
      vehicle_config_id: vehicleConfigId,
      job_id: jobActualId,
      service_id: serviceId,
      verifications,
      overall_accuracy,
      status: "pending",
      verified_at: now,
      created_at: now,
    });
  } catch (err) {
    // Best-effort: the pre-job submit must succeed even if logging fails.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[mechanic_verifications] pre-job logging skipped: ${message}`);
  }
}
