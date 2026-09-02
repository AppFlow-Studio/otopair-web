/**
 * Class default intervals — Tiered Interval Fallback v2 §4.
 *
 * When enrichment has not returned an OEM schedule for a vehicle, this is what
 * the app measures against. Originally specced as a *fallback*; Ahmad's call
 * (2026-08-30) is that it is the **default**, because enrichment is not
 * returning fast enough to be relied on. Enrichment still wins when it lands,
 * and replaces this silently.
 *
 * Keyed by taxonomy slug rather than `MaintenanceType`: only five of these rows
 * map to a core type, the rest are catalog services, and one table has to feed
 * both paths.
 *
 * Every value is **miles / months, whichever comes first**. `null` on an axis
 * means that axis does not apply — brake pads genuinely have no time side, and
 * battery genuinely has no mileage side.
 */
import type { Drivetrain, VehicleClass } from "@/utils/vehicleClass";

export interface ClassInterval {
  miles: number | null;
  months: number | null;
}

/**
 * A table cell is usually a plain interval, but two rows in the spec are not
 * constants:
 *
 *  - **coolant** has a longer first-change interval than every subsequent one,
 *    so the value depends on whether a coolant service is already on record.
 *  - **tire rotation** is defined as "follows the oil interval" — a reference,
 *    not a number, so it inherits whatever tier oil resolved from (including
 *    enrichment).
 */
type ClassCell =
  | ClassInterval
  | { follows: string }
  | { firstChange: ClassInterval; afterService: ClassInterval };

const T = (miles: number | null, months: number | null): ClassInterval => ({ miles, months });

/**
 * §4, verbatim. Values are the class *floor*, not any single car's number —
 * a specific vehicle's real schedule comes from enrichment.
 */
export const CLASS_INTERVALS: Readonly<Record<string, Record<VehicleClass, ClassCell>>> = {
  // C was 8,000 in v1; M3, Corvette and Mustang GT are all 7,500 — only AMG
  // and Porsche are 10k.
  oil_change: { A: T(7_500, 12), B: T(10_000, 12), C: T(7_500, 12) },

  // The spec splits engine-air (30/40/20k) from cabin (20k flat), but the
  // taxonomy has ONE slug covering both ("Air & cabin filters"). Shipping the
  // stricter of the two — cabin — so we never tell someone a filter is fine
  // when half of it isn't. Splitting the slug is a follow-up; see the plan.
  filter_replacement: { A: T(20_000, 24), B: T(20_000, 24), C: T(20_000, 24) },

  // Literally tied to oil — v1 said "7,500 (with oil)", which was wrong for
  // Class B's 10k oil interval.
  tire_rotation: {
    A: { follows: "oil_change" },
    B: { follows: "oil_change" },
    C: { follows: "oil_change" },
  },

  // Euro is time-based: BMW, MB, Audi and VW all say 2 years, Volvo 3.
  // Porsche is explicit — "2 years regardless of miles".
  brake_fluid_flush: { A: T(30_000, 36), B: T(null, 24), C: T(null, 24) },

  // A was 60k/60 in v1 — far too short (Toyota 100k, Honda ~100k, Mazda 120k,
  // Ford 100k, GM 150k; only Hyundai is 60k). This is the correction that
  // motivated the whole confidence-hold rule: at 60k the 1.5x deduction landed
  // at 90k on a Camry whose manufacturer says 100k.
  coolant_flush: {
    A: { firstChange: T(100_000, 72), afterService: T(50_000, 36) },
    B: { firstChange: T(80_000, 60), afterService: T(50_000, 36) },
    C: { firstChange: T(40_000, 36), afterService: T(30_000, 24) },
  },

  // A: NA engines run 60–120k. C: AMG 40k, Porsche 30–40k.
  spark_plugs: { A: T(90_000, null), B: T(60_000, null), C: T(40_000, null) },

  // The honest middle between OEM "lifetime" claims and ZF's own 50–75k spec.
  transmission_service: { A: T(60_000, null), B: T(60_000, null), C: T(40_000, null) },

  // Gated by drivetrain — see `classInterval`. v1 fired this for a FWD Camry.
  differential_service: { A: T(60_000, null), B: T(60_000, null), C: T(40_000, null) },

  // AAA's northern-US average is 58 months, CR says 3–5 years. 48 is the safe
  // NY default. No mileage side: batteries age by years.
  battery_replacement: { A: T(null, 48), B: T(null, 48), C: T(null, 36) },

  // Miles only; pads don't age. Conservative end of each band on purpose —
  // with the 1.5x rule, deductions land at 60k / 52k / 37k.
  brake_pad_replacement: { A: T(40_000, null), B: T(35_000, null), C: T(25_000, null) },

  // Touring all-season warranties run 80–90k, so 50k is a conservative
  // real-world default; UHP summer is 25–40k in CR testing. 72 months = due;
  // 10 years is a hard stop in copy, not a number here.
  tire_replacement: { A: T(50_000, 72), B: T(40_000, 72), C: T(25_000, 72) },

  // Statutory, not a manufacturer schedule. Anchored to the sticker month,
  // which we do not capture yet — so this cannot fire meaningfully today.
  state_inspection: { A: T(null, 12), B: T(null, 12), C: T(null, 12) },
};

/**
 * Engine modifiers the VIN decode can tell us about — §4.
 *
 * v1 said a turbocharged Class A car should "use Class B spark-plug and oil
 * values", but Class B oil is 10,000, i.e. *longer*, which is backwards for an
 * engine under more thermal stress. Corrected: plugs shorten, oil does not.
 * Mazda's own schedule is the cleanest proof — 2.5T plugs at 40k vs 75k NA,
 * same oil interval.
 *
 * Class B needs no rule because the B table already assumes turbo (nearly
 * every B engine is one). Superchargers are deliberately not covered: the spec
 * is silent, and inventing a rule for them is worse than leaving them on the
 * class value.
 */
const TURBO_SPARK_PLUGS_CLASS_A = 60_000;

export interface ClassIntervalOptions {
  turbo?: boolean;
  drivetrain?: Drivetrain | null;
  /** From `drivetrain_configs.has_differential` when known. A hard `false`
   *  excludes the row even on an AWD car. */
  hasDifferential?: boolean | null;
  /** Whether a coolant service is already on record — picks the shorter
   *  subsequent interval over the longer first-change one. */
  hasCoolantServiceOnRecord?: boolean;
  /** Resolves a `{ follows: slug }` cell. Injected so tire rotation can inherit
   *  whatever tier oil actually resolved from, enrichment included, rather than
   *  re-deriving the class value. */
  resolveFollows?: (slug: string) => ClassInterval | null;
}

/**
 * The class default for one service, or `null` when the row does not apply to
 * this vehicle at all.
 *
 * `null` means "this car does not have this component" — a FWD car has no
 * differential, and the row should disappear rather than render as on-time.
 */
export function classInterval(
  slug: string,
  vehicleClass: VehicleClass,
  options: ClassIntervalOptions = {},
): ClassInterval | null {
  const row = CLASS_INTERVALS[slug];
  if (!row) return null;

  // Drivetrain gate. The spec is narrower than the app's existing applicability
  // rule, which only excludes differential on positive-FWD and therefore hands
  // one to a 4WD car: here it is rwd/awd only.
  if (slug === "differential_service") {
    if (options.hasDifferential === false) return null;
    const dt = options.drivetrain;
    if (dt === "fwd") return null;
    if (dt == null && options.hasDifferential !== true) return null;
    if (dt === "4wd" && options.hasDifferential !== true) return null;
  }

  const cell = row[vehicleClass];

  if ("follows" in cell) {
    return options.resolveFollows?.(cell.follows) ?? null;
  }

  if ("firstChange" in cell) {
    return options.hasCoolantServiceOnRecord ? cell.afterService : cell.firstChange;
  }

  if (slug === "spark_plugs" && vehicleClass === "A" && options.turbo) {
    return { miles: TURBO_SPARK_PLUGS_CLASS_A, months: cell.months };
  }

  return cell;
}

/** Every slug the class table can answer for. */
export const CLASS_INTERVAL_SLUGS = Object.keys(CLASS_INTERVALS);
