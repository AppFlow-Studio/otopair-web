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

/**
 * ISO 3779 transliteration table for the check-digit calculation.
 *
 * I, O and Q are absent by design: they are not in the VIN alphabet, so
 * `isRealVin` has already rejected any string containing them.
 */
const TRANSLITERATION: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};

/** Positional weights, 1-indexed. Position 9 is the check digit itself (0). */
const POSITION_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/**
 * True when position 9 matches the FMVSS 565 / ISO 3779 check digit.
 *
 * This is the only thing that catches a VIN whose SERIAL was altered. NHTSA's
 * decoder reads the make, year and engine out of characters 1–11 alone, so
 * `WAULDAF87PN000000` and `WAULDAF87PN012340` both come back "2023 Audi A8" —
 * the last six characters are the serial and no decoder can tell you they are
 * wrong. The check digit can: it is computed over all 17 characters, so any
 * single-character edit breaks it.
 *
 * Deliberately NOT folded into `isRealVin`, which is documented as the exact
 * complement of `isPseudoVin`. A real VIN with a typo is a mistyped VIN, not a
 * placeholder we minted, and it must not start being treated as one by
 * walkinVinRepair or the booking VIN resolver.
 */
export function hasValidVinCheckDigit(vin: string | null | undefined): boolean {
  if (!isRealVin(vin)) return false;
  const v = canonicalVin(vin as string);

  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const ch = v[i];
    const value = ch >= "0" && ch <= "9" ? Number(ch) : TRANSLITERATION[ch];
    if (value === undefined) return false; // unreachable past isRealVin; belt and braces
    sum += value * POSITION_WEIGHTS[i];
  }

  const remainder = sum % 11;
  return v[8] === (remainder === 10 ? "X" : String(remainder));
}

/**
 * True when the WMI (position 1) is a North American region code, 1–5
 * (US, Canada, Mexico). Only these VINs are guaranteed to carry a check
 * digit; European and Asian home-market VINs often use position 9 for
 * something else, so a failed check there says nothing about a typo.
 */
export function isNorthAmericanVin(vin: string | null | undefined): boolean {
  if (!isRealVin(vin)) return false;
  return /^[1-5]/.test(canonicalVin(vin as string));
}

/**
 * True when the check digit is either valid or not required: enforced for
 * North American VINs only, so imports and grey-market cars still decode.
 */
export function passesVinCheckDigitGate(vin: string | null | undefined): boolean {
  return !isNorthAmericanVin(vin) || hasValidVinCheckDigit(vin);
}

/**
 * True when `vin` is worth handing to a decoder: real alphabet AND, for North
 * American VINs, a check digit that proves it was transcribed correctly.
 *
 * Use this at VIN-ENTRY doors (typed, scanned, pasted) where a wrong answer
 * becomes a car in someone's garage. Keep using `isRealVin` for "is this a
 * placeholder", which is a different question with different callers.
 */
export function isDecodableVin(vin: string | null | undefined): boolean {
  return isRealVin(vin) && passesVinCheckDigitGate(vin);
}
