/**
 * Which mileage to believe.
 *
 * A vehicle's odometer is recorded in two places that nothing reconciles:
 *
 *   - `vehicle_passports.mileage`  — the shop side, written at a visit
 *     (pre-job survey finalize, confirmVehiclePassport, post-job completion).
 *   - `vehicle_owners.mileage`     — the driver side, written from the mobile
 *     app (Oto chat confirm, quarterly check-in).
 *
 * The flow between them is one-way: `upsertVehiclePassportRecord` pushes
 * passport values DOWN into every active owner row after a shop visit, but no
 * mobile writer ever pushes back UP. So a driver who updates their odometer
 * between visits leaves the passport stale, and every shop surface that reads
 * the passport shows the old number.
 *
 * That is the Aug 20 partner-session bug: the driver's app read 49,000 while
 * the shop job detail pulled 37,376 from the previous visit's passport — and
 * rendered it tagged "verified", because the provenance was derived from the
 * same passport-first precedence.
 *
 * Recency decides instead of precedence. Both sides already carry a write
 * timestamp (`last_reported_at` / `mileage_updated_at`), so the newer write
 * wins. Ties and missing timestamps fall back to the historical passport-first
 * order — a passport row written before `last_reported_at` existed should still
 * beat an owner row that never recorded a write time.
 *
 * Deliberately NOT max(): an odometer only goes up, so taking the larger number
 * looks equivalent and is right almost always — but one fat-fingered 490,000
 * would then poison the vehicle permanently, with no later correction able to
 * bring it back down. Recency stays correctable.
 */

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export type MileageSide = "passport" | "owner" | null;

export type ResolvedMileage = {
  mileage: number | null;
  /** Which side won — the provenance badge has to follow the value. */
  from: MileageSide;
};

export function resolveVehicleMileage(
  passportRecord:
    | { mileage?: unknown; last_reported_at?: unknown }
    | null
    | undefined,
  owner: { mileage?: unknown; mileage_updated_at?: unknown } | null | undefined,
): ResolvedMileage {
  const passportMileage = finiteNumber(passportRecord?.mileage);
  const ownerMileage = finiteNumber(owner?.mileage);

  if (passportMileage == null) {
    return ownerMileage == null
      ? { mileage: null, from: null }
      : { mileage: ownerMileage, from: "owner" };
  }
  if (ownerMileage == null) return { mileage: passportMileage, from: "passport" };

  const passportAt = finiteNumber(passportRecord?.last_reported_at);
  const ownerAt = finiteNumber(owner?.mileage_updated_at);
  if (ownerAt != null && (passportAt == null || ownerAt > passportAt)) {
    return { mileage: ownerMileage, from: "owner" };
  }
  return { mileage: passportMileage, from: "passport" };
}

/** Provenance tag for the resolved value, matching the passport `sources` map. */
export function mileageSourceTag(
  from: MileageSide,
): "verified" | "user_reported" | "empty" {
  if (from === "passport") return "verified";
  if (from === "owner") return "user_reported";
  return "empty";
}
