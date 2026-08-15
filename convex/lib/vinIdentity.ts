/**
 * lib/vinIdentity.ts — one definition of "is this string actually a VIN".
 *
 * WHY THIS EXISTS
 * ---------------
 * Several surfaces mint placeholder VINs for cars entered without one:
 *   - the walk-in drawer historically minted `SHOP${Date.now()}`
 *   - the consumer app mints `MANUAL-<ts>-<rand>`
 *   - seeds mint `SEED1VIN00000N`
 *
 * `SHOP` + a 13-digit epoch is EXACTLY 17 characters, so every downstream
 * `vin.length === 17` gate accepted it as a real VIN — including
 * lib/vehicle_image.ts, which then spends a paid Vehicle Databases lookup on a
 * string no decoder has ever seen. Length alone cannot separate the two.
 *
 * ISO 3779 excludes I, O and Q from the VIN alphabet precisely so they can't be
 * confused with 1 and 0. That gives us a total check: a real VIN is 17
 * characters drawn from [A-HJ-NPR-Z0-9]. Every placeholder above fails it —
 * `SHOP…` on the O, `MANUAL-…` on the hyphen, `SEED1VIN…` on length.
 *
 * Use `isRealVin` for "may I hand this to a VIN decoder / paid VIN API".
 * Use `isPseudoVin` for "is this a placeholder we minted ourselves". They are
 * exact complements, so a new placeholder format needs no change here.
 */

/** ISO 3779 VIN alphabet — I, O and Q are excluded by the standard. */
const VIN_CHARSET = /^[A-HJ-NPR-Z0-9]{17}$/;

/**
 * True when `vin` is structurally a real VIN: 17 chars, no I/O/Q.
 *
 * Deliberately does NOT verify the check digit. North American VINs carry one
 * in position 9, but imports and pre-1981 vehicles frequently don't, and we'd
 * rather send a slightly-wrong VIN to NHTSA (which fails loudly, in a way
 * `processVin` already handles) than refuse a valid import at the door.
 */
export function isRealVin(vin: string | null | undefined): boolean {
  if (!vin) return false;
  return VIN_CHARSET.test(vin.trim().toUpperCase());
}

/**
 * True when `vin` is a placeholder we minted for a car with no VIN.
 *
 * Exact complement of `isRealVin` over non-empty strings, so legacy formats
 * (`SHOP…`, `MANUAL-…`, `SEED1VIN…`) are recognised without enumerating them.
 */
export function isPseudoVin(vin: string | null | undefined): boolean {
  if (!vin || !vin.trim()) return false;
  return !isRealVin(vin);
}

/**
 * Mint a placeholder VIN for a vehicle with no real one.
 *
 * The `OTO-` prefix contains both a hyphen and an O, so the result can never
 * pass `isRealVin` no matter how the random suffix lands — the property that
 * `SHOP${Date.now()}` accidentally violated.
 *
 * Callers own uniqueness semantics: `bookings.resolveWalkInVin` reuses an
 * existing placeholder when the same customer returns with the same YMMT
 * rather than minting a fresh one, because service history is keyed by VIN
 * string and a new placeholder forks the car's history.
 */
export function mintPseudoVin(now: number, randomSuffix: string): string {
  const stamp = now.toString(36).toUpperCase();
  const suffix = randomSuffix.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 8);
  return `OTO-${stamp}-${suffix}`;
}

/**
 * Normalize a VIN for storage/lookup. Mirrors the `toCanonicalVin` helpers that
 * already exist in bookings.ts and tireOptionsLookup.ts — uppercase + trim, no
 * validation, so it is safe to call on placeholders too.
 */
export function canonicalVin(vin: string): string {
  return vin.trim().toUpperCase();
}
