/**
 * vehicleEnrichment/transmissionTypeReconcile.ts — catch a wrong NHTSA vPIC
 * automatic-vs-manual transmission decode using the transmission FLUID as the
 * deterministic tie-breaker.
 *
 * Batch-8 (Jul 21 2026): a 2021 Jeep Wrangler EcoDiesel — which has a ZF 8HP75
 * 8-speed AUTOMATIC — was decoded by vPIC as a "6-speed MANUAL" (a known vPIC
 * error) and stored verbatim (type="manual", speeds=6, conf 0.70) with no
 * reconciliation. That wrong type then poisoned the fluid gate. There was no
 * transmission analog to drivetrainReconcile.ts, and the LLM Batch-1 answer is
 * instructed to echo vPIC, so nothing could contradict a bad decode.
 *
 * The load-bearing insight: a real 3-pedal MANUAL never takes an automatic ATF
 * / CVT / DCT fluid (it uses MTF or a GL-4/5 gear oil), and an automatic never
 * takes MTF. So the transmission FLUID the vehicle actually uses is an
 * authoritative, cheap, deterministic cross-check on the automatic-vs-manual
 * decode — the same shape as reconcileDrivetrain using NHTSA's axle count.
 *
 * Pure module — no IO. Exported for tests. Mirrors drivetrainReconcile.ts.
 */

/** What kind of gearbox a transmission-fluid spec implies. "automatic" covers
 *  every non-3-pedal box (torque-converter auto, CVT, DCT) — all of which take
 *  a fluid a manual never uses; the point of this classifier is only to tell
 *  "definitely not a 3-pedal manual" from "a 3-pedal manual". */
export type FluidTransmissionClass = "automatic" | "manual" | null;

// Tokens that appear only in AUTOMATIC / CVT / DCT transmission fluids.
const AUTOMATIC_FLUID_TOKENS = [
  "atf", "dexron", "mercon", "atf+4", "atf +4",
  "cvt", "continuously variable",
  "dct", "dual clutch", "dual-clutch", "dsg", "s tronic", "s-tronic", "pdk",
  "lifeguard", "lifeguardfluid",
  "type t-iv", "type t-4", "type iv ", "t-iv", "jws",
  "ns-1", "ns-2", "ns-3", "ns1", "ns2", "ns3",
  "sp-iii", "sp-iv", "sp-3", "sp-4", "sp iii", "sp iv",
  "matic", "dw-1", "dw1", "ws (", "world standard", "atfws", "atf ws",
  "z1", "j1", "hcf-2", "nsf", // Honda/Acura CVT/ATF families
];

// Tokens that appear only in MANUAL-transmission fluids / gear oils.
const MANUAL_FLUID_TOKENS = [
  "mtf", "manual transmission fluid", "manual trans fluid",
  "gl-4", "gl-5", "gl4", "gl5",
  "75w-90", "75w90", "75w-85", "75w85", "80w-90", "80w90", "75w-80", "75w80",
  "gear oil", "sae 75", "sae 80", "syncromesh", "synchromesh",
];

/** Classify a transmission-fluid spec string. Returns null when the spec is
 *  empty or names no recognizable family token (ambiguous — no reconciliation).
 *  Automatic tokens win ties (an "ATF" mention is a strong automatic signal
 *  even if a viscosity-like number also appears). */
export function classifyFluidTransmission(
  fluidSpec: string | null | undefined,
): FluidTransmissionClass {
  if (!fluidSpec) return null;
  const s = fluidSpec.toLowerCase();
  const isAuto = AUTOMATIC_FLUID_TOKENS.some((t) => s.includes(t));
  if (isAuto) return "automatic";
  const isManual = MANUAL_FLUID_TOKENS.some((t) => s.includes(t));
  if (isManual) return "manual";
  return null;
}

/** Canonical family of a (possibly display) transmission-type string. */
function canonFamily(type: string | null | undefined): string | null {
  if (!type) return null;
  const t = type.toLowerCase();
  if (t.includes("cvt") || t.includes("continuously variable")) return "cvt";
  if (t.includes("dct") || t.includes("dual clutch") || t.includes("dual-clutch")) return "dct";
  if (t.includes("manual") || t === "mt" || t.includes("amt") || t.includes("automated manual")) return "manual";
  if (t.includes("auto") || t === "at") return "automatic";
  return null;
}

export interface TransTypeReconcileResult {
  /** The reconciled canonical type, when a correction is warranted; else the
   *  input is unchanged and this is undefined. */
  type?: "automatic" | "CVT" | "DCT";
  corrected: boolean;
  /** Set whenever there is a contradiction — used to flag even when we don't
   *  correct (the automatic-decode-but-manual-fluid direction only flags). */
  flagReason?: string;
}

/**
 * Reconcile a decoded transmission type against the vehicle's stored trans
 * fluid.
 *
 * - decoded MANUAL but fluid is an AUTOMATIC/CVT/DCT fluid → CORRECT to the
 *   fluid-implied automatic family. This direction is high-precision: a 3-pedal
 *   manual never takes ATF, so an ATF present means the "manual" decode is
 *   wrong. The CVT/DCT sub-family is taken from the fluid when it names one.
 * - decoded AUTOMATIC/CVT/DCT but fluid reads MANUAL → only FLAG (weaker: a
 *   gear-oil string can be a diff fluid mis-slotted into the trans field, and
 *   overwriting a correct automatic would be the batch-8 mistake in reverse).
 * - agreement, or no recognizable fluid token → no change.
 *
 * Never nulls/deletes; the caller decides how to persist a correction or flag.
 */
export function reconcileTransmissionType(
  decodedType: string | null | undefined,
  fluidSpec: string | null | undefined,
): TransTypeReconcileResult {
  const decoded = canonFamily(decodedType);
  const fClass = classifyFluidTransmission(fluidSpec);
  if (!decoded || !fClass) return { corrected: false };

  const decodedIsManual = decoded === "manual";
  if (decodedIsManual && fClass === "automatic") {
    // Refine the automatic sub-family from the fluid when it names one.
    const s = (fluidSpec ?? "").toLowerCase();
    const refined: "automatic" | "CVT" | "DCT" =
      s.includes("cvt") || s.includes("continuously variable")
        ? "CVT"
        : s.includes("dct") || s.includes("dual clutch") || s.includes("dual-clutch") || s.includes("dsg") || s.includes("tronic") || s.includes("pdk")
          ? "DCT"
          : "automatic";
    return {
      type: refined,
      corrected: true,
      flagReason: `transmission_type_reconciled:decoded_manual_but_fluid_is_${refined.toLowerCase()}:${(fluidSpec ?? "").slice(0, 60)}`,
    };
  }

  if (!decodedIsManual && fClass === "manual") {
    // Contradiction the other way — flag for review, do not overwrite.
    return {
      corrected: false,
      flagReason: `transmission_type_suspect:decoded_${decoded}_but_fluid_reads_manual:${(fluidSpec ?? "").slice(0, 60)}`,
    };
  }

  return { corrected: false };
}

/**
 * Gear count implied by a transmission UNIT designation (round 8, batch-10).
 *
 * Batch-10: a 2009 Cobalt stored "Automatic, 5 speeds" — no 5-speed-automatic
 * Cobalt ever existed. NHTSA's transSpeeds carried the MANUAL's gear count (5,
 * Getrag F23) and it was merged onto the resolved automatic (4T45 = 4-speed)
 * with nothing cross-checking speeds against the resolved unit. The trans-fluid
 * verifier already names the specific unit ("4T45", "6HP26", "4R75E", "8HP75",
 * "6T70"); most unit designations lead with their gear count — extract it and
 * let the caller compare against stored speeds.
 *
 * Returns null when the unit doesn't encode a leading gear count (CD4E, JF506E,
 * Powerglide, CVTs...) — no reconciliation, never a guess. Pure; exported for
 * tests.
 */
export function speedsFromTransUnit(unit: string | null | undefined): number | null {
  if (!unit) return null;
  const u = unit.trim().toUpperCase();
  // CVTs have no discrete gear count — a digit in a CVT name (JF017E…) is not
  // a gear count.
  if (u.includes("CVT")) return null;
  // Leading digit(s) immediately followed by a letter: 4T45, 6T70, 6L80,
  // 8HP75, 6HP26, 4R75E, 5R55S, 6R80, 9T50, 10R80, 8F35...
  const m = u.match(/(?:^|[\s(])(\d{1,2})(?=[A-Z])/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  // Real gearbox counts only — a "3.6L" style capture or a part-number digit
  // run must not read as a gear count.
  return n >= 3 && n <= 10 ? n : null;
}
