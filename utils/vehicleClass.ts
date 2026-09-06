/**
 * Interval class — A (Mainstream) / B (Euro-Lux) / C (Performance).
 *
 * Tiered Interval Fallback v2 §3. The class decides which column of the
 * default-interval table a car reads, and it is derived from the pricing tier
 * we already compute at add-car time (`convex/lib/vehicleTiers.ts`,
 * `vehicle_configs.pricing_tier`). Pricing tier is about labour and parts cost;
 * interval class is about engineering — they agree most of the time, and the
 * exceptions below are where they don't.
 *
 * Pure and Convex-free: `VehicleTier` is imported type-only, so nothing from
 * `convex/values` reaches the RN bundle. The runtime map is a plain object.
 */
import type { VehicleTier } from "@/convex/lib/vehicleTiers";

export type VehicleClass = "A" | "B" | "C";
export type VehicleClassSource = "performance_tier" | "make_override" | "pricing_tier" | "default";

/**
 * The straight tier → class mapping, before exceptions.
 *
 * Keyed by every tier so a future eighth tier is a compile error rather than a
 * silent fall-through to Class A (there is a test asserting this covers
 * `VEHICLE_TIERS` exactly).
 */
export const TIER_TO_CLASS: Record<VehicleTier, VehicleClass> = {
  T1: "A",
  T2a: "A",
  T2b: "B",
  T2c: "B",
  T3a: "C",
  T3b: "C",
  T4: "C",
};

/**
 * Makes the spec pulls into Class A regardless of tier: their schedules are
 * line-for-line mainstream even though they price as luxury. Lexus ES/RX match
 * the Camry (10k oil, 60k plugs); Acura tracks Accord's Maintenance Minder;
 * Genesis G80 oil is 7,500 like the Sonata; Infiniti QX60 is 7,500 — longer
 * than Nissan's own 5,000. The Class B table (2-year brake fluid, 10k oil)
 * would over-fire on all four.
 */
const MAKE_TO_CLASS_A = new Set(["lexus", "acura", "infiniti", "genesis"]);

/**
 * Volvo is `T2a` in the pricing table — which maps to Class A — but the spec
 * places it in Class B with the rest of the Europeans. So the override list has
 * to work in both directions, not just into A.
 */
const MAKE_TO_CLASS_B = new Set(["volvo"]);

/** Tiers that are genuinely performance cars, whatever the badge says. */
const PERFORMANCE_TIERS: ReadonlySet<string> = new Set(["T3a", "T3b", "T4"]);

/**
 * Make → class for the makes §3 names explicitly, used when no pricing tier is
 * available.
 *
 * This is not belt-and-braces: most `vehicle_configs` rows carry no
 * `pricing_tier` at all until the seeder has run for that config, so without
 * this an Audi Q5 resolves to Class A and reads a 7,500-mile oil interval
 * instead of 10,000. The spec defines the classes by make in the first place;
 * the tier is just how we usually resolve it.
 *
 * Class C is deliberately absent — a performance variant is identified by tier
 * or trim, never by badge alone, and guessing "Porsche → C" would put a base
 * Macan on 40,000-mile coolant.
 */
const MAKE_TO_CLASS_FALLBACK: Readonly<Record<string, VehicleClass>> = {
  // B — European / Luxury (§3)
  bmw: "B",
  "mercedes-benz": "B",
  mercedes: "B",
  audi: "B",
  volkswagen: "B",
  vw: "B",
  "land rover": "B",
  landrover: "B",
  jaguar: "B",
  mini: "B",
  porsche: "B",
  maserati: "B",
  alfa: "B",
  "alfa romeo": "B",
};

export interface VehicleClassInput {
  /** `vehicle_configs.pricing_tier`. Null when the config has no tier yet. */
  pricingTier?: VehicleTier | string | null;
  /** Vehicle make, any casing. */
  make?: string | null;
}

/**
 * Resolve a vehicle's interval class.
 *
 * Order matters, and the first rule is the one the spec's own wording misses:
 * a **performance tier always wins**. The spec says "Class A ... plus the
 * override list: Lexus, Acura, Infiniti, Genesis", but Lexus F / RC F / LC and
 * Acura Type S are `T3a` in `seedPricing.ts` — genuinely Class C cars. Applying
 * the make override blindly would put an LC 500 on a 7,500-mile mainstream oil
 * interval. So performance is checked first, and the make override only reaches
 * the value/German tiers it was written for.
 *
 * Defaults to A when nothing is known. There is no "conservative" default here:
 * A is stricter than B on oil (7,500 vs 10,000) but looser on spark plugs
 * (90,000 vs 60,000) and brake pads (40,000 vs 35,000). A is the mode of the
 * fleet, and `source: "default"` keeps that visible so the confidence hold can
 * be widened to cover it later if we want.
 */
export function resolveVehicleClass(input: VehicleClassInput): {
  vehicleClass: VehicleClass;
  source: VehicleClassSource;
} {
  const tier = typeof input.pricingTier === "string" ? input.pricingTier : null;
  const make = (input.make ?? "").trim().toLowerCase();

  // 1. A performance tier is never overridden by a make.
  if (tier && PERFORMANCE_TIERS.has(tier)) {
    return { vehicleClass: "C", source: "performance_tier" };
  }

  // 2. Make exceptions, both directions.
  if (MAKE_TO_CLASS_B.has(make)) return { vehicleClass: "B", source: "make_override" };
  if (MAKE_TO_CLASS_A.has(make)) return { vehicleClass: "A", source: "make_override" };

  // 3. The plain tier map.
  if (tier && tier in TIER_TO_CLASS) {
    return { vehicleClass: TIER_TO_CLASS[tier as VehicleTier], source: "pricing_tier" };
  }

  // 4. No tier — most configs have none until the pricing seeder reaches them,
  //    so fall back to the make list the spec defines the classes with.
  const byMake = MAKE_TO_CLASS_FALLBACK[make];
  if (byMake) return { vehicleClass: byMake, source: "make_override" };

  // 5. Nothing known.
  return { vehicleClass: "A", source: "default" };
}

/**
 * Powertrain classification derived from the raw `engines.fuel_type` string.
 *
 * There is no `is_ev` / `is_hybrid` boolean anywhere in the schema, so this is
 * derived. It matters because **Otopair does not service battery-electric
 * vehicles** — a BEV is out of scope and the interval fallback must never run
 * for one (Fallback v2 §2). Hybrids and PHEVs are gas cars with a battery and
 * use their class table in full.
 *
 * Ordering is deliberate: "plug-in hybrid" contains "hybrid", and several
 * sources write a BEV's fuel type as "Electric" while a hybrid's primary fuel
 * is bare "Gasoline". So hybrid is tested before electric, and anything
 * unrecognised is treated as combustion — the safe direction, since the cost of
 * a false BEV is that we silently stop asking a real car about its oil.
 */
export type FuelClass = "bev" | "hybrid" | "combustion";

export function classifyFuelType(fuelType?: string | null): FuelClass {
  const f = (fuelType ?? "").trim().toLowerCase();
  if (!f) return "combustion";
  if (f.includes("hybrid") || f.includes("phev")) return "hybrid";
  if (f.includes("electric") || f === "bev" || f.includes("battery")) return "bev";
  return "combustion";
}

/** Canonical drivetrain, lowercased. Mirrors `vehicle_configs.drivetrain`. */
export type Drivetrain = "fwd" | "rwd" | "awd" | "4wd";

export function normalizeDrivetrain(raw?: string | null): Drivetrain | null {
  const d = (raw ?? "").trim().toLowerCase().replace(/[\s-]/g, "");
  if (d === "fwd" || d === "frontwheeldrive") return "fwd";
  if (d === "rwd" || d === "rearwheeldrive") return "rwd";
  if (d === "awd" || d === "allwheeldrive") return "awd";
  if (d === "4wd" || d === "4x4" || d === "fourwheeldrive") return "4wd";
  return null;
}

/** `engines.aspiration` is a free string ("turbo", "Turbocharged", "Twin Turbo"). */
export function isTurbocharged(aspiration?: string | null): boolean {
  return (aspiration ?? "").toLowerCase().includes("turbo");
}
