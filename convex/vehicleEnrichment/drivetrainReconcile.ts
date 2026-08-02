/**
 * vehicleEnrichment/drivetrainReconcile.ts — reconcile the NHTSA VIN-decoded
 * drive type against an AI/LLM-normalized drivetrain guess.
 *
 * Batch-3 audit (Jul 2026): two of five VINs shipped the WRONG drivetrain and
 * with it phantom services. The 2021 Sienna (NHTSA DriveType "4x2", a FWD
 * minivan) and the 2016 F-150 (NHTSA "4x2", a 2WD truck) both stored AWD/4WD
 * and were sold rear-diff / transfer-case service. Root cause: the old
 * `mapNhtsaDriveType` returned undefined for "4x2" (it only matched 4wd/awd/
 * fwd/rwd), so the authoritative VIN-encoded "this is 2-wheel-drive" signal was
 * dropped and the LLM's guess ("AWD") won.
 *
 * DriveType is VIN-encoded and authoritative for the AXLE COUNT (2WD vs 4WD).
 * The LLM is only trustworthy for REFINING within an axle class (FWD vs RWD, or
 * AWD vs 4WD) — never for overriding the axle count. This module encodes that:
 * NHTSA decides 2WD-vs-4WD; the AI refines the specific label.
 *
 * Pure module — no IO. Exported for tests.
 */

export type CanonicalDrivetrain = "FWD" | "RWD" | "AWD" | "4WD";

const CANON = new Set<CanonicalDrivetrain>(["FWD", "RWD", "AWD", "4WD"]);

function normalizeCanon(raw: string | null | undefined): CanonicalDrivetrain | null {
  if (!raw) return null;
  const c = raw.trim().toUpperCase();
  return CANON.has(c as CanonicalDrivetrain) ? (c as CanonicalDrivetrain) : null;
}

/** Coarse axle count from a raw NHTSA DriveType string (or a canonical value).
 *  "4x2" → 2wd, "4x4"/"AWD" → 4wd. This is the load-bearing addition: "4x2"
 *  is now recognized as an authoritative 2WD signal. */
export function nhtsaAxleClass(
  driveType: string | null | undefined,
): "2wd" | "4wd" | null {
  if (!driveType) return null;
  const d = driveType.toLowerCase();
  if (
    d.includes("4wd") || d.includes("4x4") || d.includes("4-wheel") ||
    d.includes("four wheel") || d.includes("four-wheel") ||
    d.includes("awd") || d.includes("all-wheel") || d.includes("all wheel")
  ) {
    return "4wd";
  }
  if (
    d.includes("4x2") || d.includes("2wd") || d.includes("2-wheel") ||
    d.includes("two wheel") || d.includes("two-wheel") ||
    d.includes("fwd") || d.includes("front-wheel") || d.includes("front wheel") ||
    d.includes("rwd") || d.includes("rear-wheel") || d.includes("rear wheel")
  ) {
    return "2wd";
  }
  return null;
}

function axleOf(canon: CanonicalDrivetrain | null): "2wd" | "4wd" | null {
  if (canon == null) return null;
  return canon === "AWD" || canon === "4WD" ? "4wd" : "2wd";
}

/** The specific canonical label a NHTSA DriveType names, if any. "4x2" names
 *  no FWD/RWD (needs body class to refine), so it returns null. */
function nhtsaSpecificLabel(
  driveType: string | null | undefined,
): CanonicalDrivetrain | null {
  if (!driveType) return null;
  const d = driveType.toLowerCase();
  if (d.includes("4wd") || d.includes("4x4") || d.includes("4-wheel") || d.includes("four")) return "4WD";
  if (d.includes("awd") || d.includes("all-wheel") || d.includes("all wheel")) return "AWD";
  if (d.includes("fwd") || d.includes("front-wheel") || d.includes("front wheel")) return "FWD";
  if (d.includes("rwd") || d.includes("rear-wheel") || d.includes("rear wheel")) return "RWD";
  return null; // "4x2"/"2wd" — axle known, side unknown
}

/** Split a known-2WD vehicle into FWD vs RWD by body class. Pickups, cargo
 *  vans, and body-on-frame trucks are RWD in 2WD form; everything else
 *  (minivans, crossovers, sedans, hatchbacks) defaults FWD. A heuristic, but
 *  a far better default than the LLM's AWD hallucination it replaces. */
export function refine2wdByBody(
  bodyClass: string | null | undefined,
): CanonicalDrivetrain {
  const b = (bodyClass ?? "").toLowerCase();
  if (
    b.includes("pickup") || b.includes("truck") || b.includes("chassis cab") ||
    b.includes("cab chassis") || b.includes("cargo van") || b.includes("cutaway") ||
    b.includes("incomplete")
  ) {
    return "RWD";
  }
  return "FWD";
}

/**
 * Reconcile the raw NHTSA DriveType against the AI/LLM canonical guess.
 *
 * - NHTSA has no axle signal → trust the AI value (prior behavior).
 * - NHTSA and AI agree on axle count → use the AI's specific label (it refines
 *   "4x2" → FWD/RWD, or "4x4" → AWD/4WD, which NHTSA can't distinguish).
 * - They DISAGREE on axle count → NHTSA wins (the batch-3 fix). A specific
 *   NHTSA label is used if present; a bare "4x2" is refined by body class.
 *
 * Returns undefined only when neither source yields a usable value.
 */
export function reconcileDrivetrain(
  nhtsaDriveType: string | null | undefined,
  aiCanonical: string | null | undefined,
  bodyClass?: string | null,
): CanonicalDrivetrain | undefined {
  const nAxle = nhtsaAxleClass(nhtsaDriveType);
  const ai = normalizeCanon(aiCanonical);

  if (nAxle == null) return ai ?? undefined;

  if (ai && axleOf(ai) === nAxle) return ai;

  // Conflict, or no usable AI value: NHTSA's axle count is authoritative.
  const nSpecific = nhtsaSpecificLabel(nhtsaDriveType);
  if (nSpecific) return nSpecific;
  // Bare "4x2": refine to FWD/RWD by body class.
  if (nAxle === "2wd") return refine2wdByBody(bodyClass);
  // Bare 4WD-class with no specific label (rare) — keep an AI 4wd label if any.
  return ai && axleOf(ai) === "4wd" ? ai : "4WD";
}
