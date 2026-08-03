/**
 * vehicleEnrichment/variantDecodeReconcile.ts — reject a VDB performance-halo
 * mis-decode that NHTSA contradicts.
 *
 * Batch-9 (Jul 22 2026): a 2003 Subaru Impreza Outback (2.5 NA, EJ251) decoded
 * as an "Impreza WRX" (2.0 turbo, EJ205) — because the third-party VDB decode
 * returned "Impreza WRX" and the pipeline's YMMT agreement check is a fuzzy
 * SUBSTRING match: "Impreza WRX" ⊇ "Impreza", so VDB's invented performance
 * variant read as "agreeing" with NHTSA and won. That wrong model then led the
 * engine-code resolver to the turbo EJ205 and a wrong (WRX) spark plug —
 * variant mis-ID at the decode layer, upstream of everything.
 *
 * The rule here mirrors drivetrainReconcile's philosophy: NHTSA's VIN decode is
 * authoritative when it makes a POSITIVE claim. VDB may REFINE NHTSA's model
 * with a performance variant only when NHTSA corroborates it (the token appears
 * in NHTSA's model/series/trim) OR NHTSA is silent on the variant. But when VDB
 * adds a performance-halo token NHTSA lacks AND NHTSA positively decoded a
 * DIFFERENT specific variant (series/trim = "Outback"), the halo is a mis-decode
 * — prefer NHTSA. NHTSA's positive decode beats VDB's guess; NHTSA's silence
 * does not (a real WRX that NHTSA left as a bare "Impreza" is kept).
 *
 * Pure module — no IO. Exported for tests.
 */

/** Model-level PERFORMANCE / halo variant tokens — words that denote a distinct
 *  variant with its own engine and parts, and that are prone to VDB mis-decode.
 *  Compact (spaceless) forms are also matched so "type r" hits "typer". Kept to
 *  clear, engine-distinct variants — not ordinary trims (LE, Premium, Sport). */
const PERFORMANCE_VARIANT_TOKENS: readonly string[] = [
  "wrx", "sti",
  "type r", "type s",
  "gti", "golf r", "r32",
  "ss", "z06", "zl1", "zr1", "blackwing",
  "hellcat", "redeye", "trackhawk", "srt", "scat pack",
  "raptor", "shelby", "gt350", "gt500", "svt", "cobra", "lightning",
  "nismo", "trd pro",
  "amg", "quadrifoglio", "abarth", "cupra",
  "john cooper works", "jcw",
];

const compact = (s: string) => s.replace(/[^a-z0-9]+/g, "");
function padded(s: string | null | undefined): string {
  return " " + (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() + " ";
}

export interface VariantReconcileResult {
  /** True → prefer NHTSA's model over VDB's (the VDB performance variant is a
   *  mis-decode NHTSA contradicts). */
  demote: boolean;
  reason?: string;
  /** The performance token that triggered the demotion. */
  token?: string;
}

/**
 * Decide whether VDB's model is claiming a performance variant that NHTSA
 * contradicts.
 *
 * @param vdbModel          VDB's decoded model (may carry a performance token).
 * @param nhtsaModel        NHTSA's decoded model.
 * @param nhtsaVariantText  NHTSA's series + trim (+ series2/trim2) joined — the
 *                          fields where NHTSA records the specific variant.
 */
export function reconcilePerformanceVariant(
  vdbModel: string | null | undefined,
  nhtsaModel: string | null | undefined,
  nhtsaVariantText: string | null | undefined,
): VariantReconcileResult {
  if (!vdbModel || !nhtsaModel) return { demote: false };
  const vdbPad = padded(vdbModel);
  const vdbCompact = compact(vdbPad);
  // NHTSA's FULL identity — model + series/trim combined, because NHTSA records
  // the specific variant in different fields per make (a Subaru "Outback" lands
  // in Model, a trim like "Premium" in Trim). Checking the union handles both.
  const nhtsaFullPad = padded(`${nhtsaModel ?? ""} ${nhtsaVariantText ?? ""}`);
  const nhtsaFullCompact = compact(nhtsaFullPad);
  const vdbTokens = new Set(vdbPad.trim().split(/\s+/).filter(Boolean));

  for (const token of PERFORMANCE_VARIANT_TOKENS) {
    const tPad = " " + token + " ";
    const tCompact = compact(token);
    const vdbHas = vdbPad.includes(tPad) || vdbCompact.includes(tCompact);
    if (!vdbHas) continue;

    // NHTSA corroborates the token anywhere → keep VDB.
    if (nhtsaFullPad.includes(tPad) || nhtsaFullCompact.includes(tCompact)) {
      return { demote: false };
    }

    // VDB claims a performance variant NHTSA lacks. Demote ONLY when NHTSA
    // POSITIVELY named a DIFFERENT variant — i.e. NHTSA's identity carries a
    // significant token (≥2 chars, not a year) that VDB's model does NOT. That
    // is NHTSA decoding a specific, conflicting variant (the "Outback" the WRX
    // claim contradicts). If NHTSA is silent (only the shared base model), keep
    // VDB — a real WRX that NHTSA left as a bare "Impreza" must survive.
    // A conflict token is an alphabetic VARIANT/TRIM word (≥2 letters, not a
    // pure number) NHTSA names that VDB's model lacks — e.g. "Outback". Pure
    // numbers (displacement "2.5") are deliberately excluded: they're engine
    // info, not a variant, and would otherwise false-demote a real WRX whose
    // NHTSA record carries a displacement.
    const nhtsaTokens = nhtsaFullPad.trim().split(/\s+/);
    const conflict = nhtsaTokens.some(
      (t) => t.length >= 2 && /[a-z]/.test(t) && !/\d/.test(t) && !vdbTokens.has(t),
    );
    if (conflict) {
      return {
        demote: true,
        token,
        reason: `VDB claims "${token.toUpperCase()}" but NHTSA decoded a different variant ("${`${nhtsaModel ?? ""} ${nhtsaVariantText ?? ""}`.trim()}") — preferring NHTSA`,
      };
    }
    return { demote: false };
  }
  return { demote: false };
}
