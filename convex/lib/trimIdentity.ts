/**
 * lib/trimIdentity.ts — do two trim strings name the same trim?
 *
 * Bug #351. A config found by `nhtsa_vin_key` used to be reused for any car
 * with that key, whatever trim the car was added as. The key is built from
 * NHTSA's trim, but the config is enriched — and named — for the trim the owner
 * picked on the review screen. So one owner picking "X" for a VIN NHTSA calls
 * "Limited" left a config named "X" under a `…_limited_…` key, and every later
 * Limited with that engine attached to it: the customer saw "Cherokee Limited",
 * the shop saw "X trim", and parts were sourced for the X.
 *
 * Callers compare the trim being added with a candidate config's `trim_name`
 * and reuse the config only when they agree.
 */

import { trimTokenSet } from "../vehicleEnrichment/estimatorEndpointMatch";

/**
 * Strip Car API's body/door/drivetrain descriptors off a plain trim so the
 * picker shows a bare token. "EX 4dr SUV AWD" → "EX", "Sport 2dr Coupe" →
 * "Sport". Conservative — multi-word trims ("Black Label") survive.
 */
export function cleanTrimToken(raw: string): string {
  let s = String(raw ?? "").trim();
  if (!s) return "";
  // A label that is ONLY body/doors ("2dr", "4dr Sedan", "Coupe") names no
  // trim — Car API files a model's single base row that way.
  if (/^\d+\s*-?\s*(?:dr|door)s?\b/i.test(s)) return "";
  if (/^(?:sedan|coupe|hatchback|wagon|suv|convertible|roadster)\b/i.test(s)) return "";
  s = s.replace(/\s+\d+\s*-?\s*(?:dr|door)s?\b.*$/i, "");
  s = s.replace(
    /\s+\b(?:sedan|coupe|hatchback|wagon|suv|truck|van|minivan|convertible|roadster|cab|pickup|crew|awd|fwd|rwd|4wd|4x4|2wd)\b.*$/i,
    "",
  );
  return s.trim();
}

/**
 * Order-independent tokens that identify a trim. Body/door/drivetrain tails go
 * (older configs carry VDB's verbose "XSE 4dr All-Wheel Drive Sedan Automatic"),
 * so does a bare displacement ("Premium 3.8L"), and so does "Base" — the
 * decoder's placeholder when nothing named a trim.
 */
export function trimIdentityTokens(trim: string | null | undefined): Set<string> {
  const cleaned = cleanTrimToken(String(trim ?? "")).replace(/\b\d+\.\d\s*l\b/gi, " ");
  const tokens = trimTokenSet(cleaned);
  tokens.delete("base");
  return tokens;
}

/**
 * True when the two strings name the same trim. An unknown trim (empty or
 * "Base") contradicts nothing, so it agrees with anything — that keeps the old
 * reuse behaviour wherever a side never had a trim to compare.
 */
export function trimsAgree(a: string | null | undefined, b: string | null | undefined): boolean {
  const A = trimIdentityTokens(a);
  const B = trimIdentityTokens(b);
  if (A.size === 0 || B.size === 0) return true;
  return A.size === B.size && [...A].every((t) => B.has(t));
}
