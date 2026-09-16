/**
 * Quick Check firing rules — which tiles are worth asking about for THIS car.
 *
 * Today every driver answers the same five questions regardless of the vehicle,
 * so a two-year-old car at 10,000 miles gets asked when its tires were last
 * replaced. Quick Check Spec v2 §4 replaces that with a per-tile threshold:
 * a tile renders only once the car has plausibly reached the service.
 *
 * Every rule is **miles OR months, whichever comes first**. Nothing fires on
 * miles alone — that is what keeps a 2,000-mile-a-year car honest, since it
 * would otherwise never reach an oil interval by distance while being years
 * past it by time.
 *
 * Pure and dependency-free on purpose: the tile grid, the progress denominator
 * and the write loops all have to agree on the same set, and Oto's server-side
 * merge may want it later.
 */

export type QuickCheckTileId =
  | "warningLights"
  | "oil"
  | "tires"
  | "brakes"
  | "battery"
  | "biggerServices";

/**
 * Spec §4, verbatim, as data rather than conditionals so the doc and the code
 * are the same object.
 *
 * `null` on an axis means that axis never fires — battery is deliberately
 * age-only, because batteries die by years, not miles.
 */
export const QUICK_CHECK_THRESHOLDS: Readonly<
  Record<
    Exclude<QuickCheckTileId, "warningLights" | "biggerServices">,
    { miles: number | null; months: number | null }
  >
> = {
  // First real interval on any car. Covers oil and both filters in one tap.
  oil: { miles: 7_500, months: 12 },
  // v1 asked at 2 years, which is the "why is it asking me this" moment on a
  // low-mileage car. Originals rarely matter before 3 years unless miles get
  // there first.
  tires: { miles: 20_000, months: 36 },
  // Pads wear by miles only; the 36-month arm exists because brake fluid ages.
  brakes: { miles: 25_000, months: 36 },
  // Mileage ignored entirely.
  battery: { miles: null, months: 36 },
};

/** Render order — spec §3. Warning Lights leads, Bigger Services closes. */
const TILE_ORDER: readonly QuickCheckTileId[] = [
  "warningLights",
  "oil",
  "tires",
  "brakes",
  "battery",
  "biggerServices",
];

export interface FiringInput {
  /** `vehicle_owners.mileage`. Null when unknown — the miles arm then never
   *  fires, but the age arm still can. */
  currentMiles: number | null;
  /** Model year from the VIN decode. Null → the age arm never fires. */
  modelYear: number | null;
  /** How many Bigger Services items qualified (see quickCheckBiggerServices).
   *  The tile is hidden entirely at zero. */
  biggerServiceCandidates?: number;
  /** What we already know, per tile. A tile whose service is already anchored
   *  — a booking closed it out, or the driver answered it before — is not
   *  worth asking about again, and asking anyway is what made the Quick Check
   *  re-interrogate a car that was already set up.
   *
   *  Measured from the anchor rather than from new: a car serviced at 40,000
   *  and now reading 45,000 is 5,000 into its interval, not 45,000. */
  anchors?: Partial<Record<QuickCheckTileId, ServiceAnchor>>;
  /** Injectable clock, for tests. */
  now?: number;
}

/** What is on record for one service. Either half may be missing. */
export interface ServiceAnchor {
  lastServiceMileage?: number | null;
  lastServiceDate?: number | null;
}

const MS_PER_MONTH = 30.44 * 24 * 60 * 60 * 1000;

/**
 * Age in months, measured from **January 1 of the model year** — spec §2.
 *
 * The model year is the only date the VIN reliably gives us. Counting from
 * Jan 1 errs slightly old, which is the safe direction: a question fires a
 * little early rather than never.
 */
export function ageMonths(modelYear: number | null, now: number = Date.now()): number | null {
  if (modelYear == null || !Number.isFinite(modelYear)) return null;
  const jan1 = new Date(modelYear, 0, 1).getTime();
  return Math.max(0, (now - jan1) / MS_PER_MONTH);
}

/** Whether one tile's rule is met. Exported for the progress denominator and
 *  for tests that want a single tile rather than the whole set. */
export function tileFires(tile: QuickCheckTileId, input: FiringInput): boolean {
  // The only live-malfunction signal we have. Every car, every time.
  if (tile === "warningLights") return true;

  // The list assembles itself; no qualifying item means no tile.
  if (tile === "biggerServices") return (input.biggerServiceCandidates ?? 0) > 0;

  const rule = QUICK_CHECK_THRESHOLDS[tile];
  const now = input.now ?? Date.now();
  const anchor = input.anchors?.[tile];

  // Miles SINCE the last known service, not the odometer. With no anchor the
  // two are the same thing — the interval has been running since the car was
  // new — which is why this reads identically for a car we know nothing about.
  const milesSince =
    input.currentMiles != null && Number.isFinite(input.currentMiles)
      ? input.currentMiles - (typeof anchor?.lastServiceMileage === "number"
          ? anchor.lastServiceMileage
          : 0)
      : null;

  // Same for age: months since the service, falling back to months since the
  // car was built.
  const monthsSince =
    typeof anchor?.lastServiceDate === "number"
      ? Math.max(0, (now - anchor.lastServiceDate) / MS_PER_MONTH)
      : ageMonths(input.modelYear, now);

  const byMiles = rule.miles != null && milesSince != null && milesSince >= rule.miles;
  const byAge = rule.months != null && monthsSince != null && monthsSince >= rule.months;

  return byMiles || byAge;
}

/**
 * The ordered set of tiles to render. This is the single source of truth for
 * the grid, the "N of M" denominator, `canGoNext`, `allDone` and both write
 * loops — they disagreed in v1 and that is what produced a progress counter
 * that could never reach its own total.
 */
export function firedTiles(input: FiringInput): QuickCheckTileId[] {
  return TILE_ORDER.filter((tile) => tileFires(tile, input));
}
