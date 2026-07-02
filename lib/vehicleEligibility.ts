/**
 * vehicleEligibility — gate on the VIN decode result.
 *
 * Otopair only serves consumer-grade road vehicles: cars, SUVs/MPVs,
 * and light-duty pickup trucks. Anything else (motorcycle, semi-truck,
 * bus, trailer, low-speed cart, incomplete chassis) is rejected with a
 * user-facing message before the user reaches the review screen.
 *
 * The check uses NHTSA's two best-known fields:
 *   - `vehicleType` (high-level category)
 *   - `bodyClass`   (specific body, e.g. "Truck-Tractor")
 *
 * Both are normalized to uppercase before matching so partial-letter
 * casing from VDB doesn't slip a rejected type through.
 */

const NORMALIZED_REJECT_BY_TYPE = new Set<string>([
  "MOTORCYCLE",
  "BUS",
  "TRAILER",
  "INCOMPLETE VEHICLE",
  "LOW SPEED VEHICLE",
  "LOW SPEED VEHICLE (LSV)",
]);

// Body-class substrings that mean "heavy / commercial truck" even
// though NHTSA's VehicleType for these is still "TRUCK". Lowercased
// for substring matching.
const REJECT_BODY_CLASS_SUBSTRINGS: readonly string[] = [
  "truck-tractor",
  "truck tractor",
  "tractor truck",
  "semi-tractor",
  "semitractor",
];

export interface EligibilityResult {
  ok: boolean;
  /** User-facing reason; populated when `ok === false`. */
  message?: string;
  /** Diagnostic label so the toast / log can mention what we saw. */
  detectedType?: string;
}

function norm(value: string | undefined | null): string {
  return (value ?? "").trim().toUpperCase();
}

/** Decide whether a decoded vehicle is something Otopair can service. */
export function checkVehicleEligibility(input: {
  vehicleType?: string | null;
  bodyClass?: string | null;
}): EligibilityResult {
  const type = norm(input.vehicleType);
  const body = norm(input.bodyClass);

  if (NORMALIZED_REJECT_BY_TYPE.has(type)) {
    return {
      ok: false,
      message: rejectMessage(type, body),
      detectedType: input.vehicleType ?? input.bodyClass ?? undefined,
    };
  }

  // TRUCK + heavy body class → reject (semi-trucks, 18-wheelers).
  if (type === "TRUCK" && body) {
    const lowerBody = body.toLowerCase();
    if (REJECT_BODY_CLASS_SUBSTRINGS.some((s) => lowerBody.includes(s))) {
      return {
        ok: false,
        message: rejectMessage(type, body),
        detectedType: input.bodyClass ?? undefined,
      };
    }
  }

  return { ok: true };
}

function rejectMessage(type: string, body: string): string {
  // Lean, friendly copy. Mentions the detected category when we have
  // a clean handle on it; otherwise stays generic.
  if (type === "MOTORCYCLE") {
    return "Otopair doesn't service motorcycles yet — we currently support cars, SUVs, and light-duty pickup trucks.";
  }
  if (type === "BUS") {
    return "Otopair doesn't service buses — we currently support cars, SUVs, and light-duty pickup trucks.";
  }
  if (type === "TRAILER") {
    return "Otopair doesn't service trailers — we currently support cars, SUVs, and light-duty pickup trucks.";
  }
  if (type === "LOW SPEED VEHICLE" || type === "LOW SPEED VEHICLE (LSV)") {
    return "Otopair doesn't service low-speed vehicles yet — we currently support cars, SUVs, and light-duty pickup trucks.";
  }
  if (type === "INCOMPLETE VEHICLE") {
    return "This VIN decodes as an incomplete vehicle chassis. Otopair only services finished consumer vehicles — cars, SUVs, and light-duty pickup trucks.";
  }
  if (type === "TRUCK" && body) {
    return "Otopair doesn't service semi-trucks or commercial big rigs yet — we currently support cars, SUVs, and light-duty pickup trucks.";
  }
  return "Otopair doesn't service this type of vehicle yet — we currently support cars, SUVs, and light-duty pickup trucks.";
}
