/**
 * vehicleEnrichment/transFluidSpecReconcile.ts — deterministic CVT
 * spec↔part reconcile (round 9, batch-11 Rogue).
 *
 * The fluid SPEC string (`transmissions.fluid_type`) and the orderable fluid
 * PART (`atf_fluid` fitment) are independent extractions. Batch-11 shipped an
 * internally contradictory record: spec "Nissan Matic S" (a stepped-automatic
 * ATF) next to the genuine NS-3 CVT part 999MP-CSHNS3, on a resolved CVT —
 * the round-7 trans_fluid_suspect flag fired but the contradictory spec
 * persisted, and a stepped ATF in a CVT destroys the unit.
 *
 * ── Why this may correct when the batch-8 doctrine says "never overwrite" ──
 * The batch-8 flag-only doctrine (transFluidVerifier.ts) bans the WEB-SEARCH
 * VERIFIER from overwriting: its failure mode is unit mis-identification, and
 * when wrong it replaces a correct value with a damaging one. This module
 * involves no LLM and no search. It fires only on a CATEGORY contradiction
 * inside our own already-extracted record: the resolved transmission family
 * is CVT, the purchasable part we extracted is token-identifiably a CVT
 * fluid, and the spec string is token-identifiably a stepped-gearbox ATF
 * family. Two independent signals (type + part) against one (spec) — the
 * correction target comes from the part we already trust enough to sell.
 * Everything weaker stays flag-only.
 *
 * eCVT caution: Toyota hybrid transaxles legitimately use ATF WS, so "WS" /
 * "World Standard" is deliberately NOT a stepped token — a Grand Highlander
 * Hybrid (eCVT + WS spec + WS part) must not fire this gate.
 */

const CVT_TYPE_RE = /\bcvt\b|continuously\s+variable|lineartronic|xtronic|e-?cvt/i;

/** Stepped-gearbox ATF families that must never be specced into a CVT.
 *  Word-boundary'd so "Matic S" hits but "automatic" does not. */
const STEPPED_SPEC_RE =
  /\bmatic(?:\s*[a-z])?\b|\bdexron\b|\bmercon\b|\batf\s*\+\s*4\b|\bsp[\s-]?(?:ii|iii|iv|4m?)\b|\bt[\s-]?iv\b|\btype\s*t\b/i;

/** CVT-fluid tokens — presence in the spec string means it's already a CVT
 *  spec (no contradiction). */
const CVT_SPEC_RE = /\bns[\s-]?[123]\b|\bcvtf?\b|\bhcf[\s-]?2\b|\bcvt\b/i;

/** Token → canonical CVT fluid label, detected in the PART's OEM number/name
 *  after stripping separators (999MP-CSHNS3 → …CSHNS3 → NS3). Only these
 *  precise tokens authorize a correction; anything else is flag-only. */
const PART_TOKEN_TO_SPEC: Array<[RegExp, string]> = [
  [/NS3/, "Nissan CVT Fluid NS-3"],
  [/NS2/, "Nissan CVT Fluid NS-2"],
  [/HCF2/, "Honda HCF-2 CVT Fluid"],
  [/CVTF/, "OEM CVT Fluid (CVTF)"],
];

/** Geared-automatic type text (round 10, the Equinox mirror direction).
 *  Deliberately narrow: plain "Automatic" / "N-speed automatic"; anything
 *  CVT-ish is excluded by the CVT check running first. */
const GEARED_AUTO_TYPE_RE = /\bautomatic\b|\b\d+\s*-?\s*speed\b/i;

/** Stepped-ATF family tokens in the PART's number/name (normalized) that
 *  authorize the mirror correction. */
const PART_STEPPED_TOKEN_TO_SPEC: Array<[RegExp, string]> = [
  [/DEXRONVI/, "DEXRON-VI ATF"],
  [/DEXRONULV/, "DEXRON-ULV ATF"],
  [/MERCONLV/, "MERCON LV ATF"],
  [/MERCONV/, "MERCON V ATF"],
  [/ATF4/, "ATF+4"],
  [/MATICS/, "Nissan Matic S ATF"],
];

export type TransFluidSpecReconcile =
  | { action: "keep" }
  | { action: "flag"; reason: string }
  | { action: "correct"; correctedSpec: string; reason: string };

export function reconcileTransFluidSpecWithPart(input: {
  /** Resolved transmission type text (canonical type and/or display string). */
  transTypeText: string | null | undefined;
  /** Stored fluid spec string (transmissions.fluid_type / trans_fluid_type). */
  spec: string | null | undefined;
  /** The atf_fluid part's OEM number and (if known) name, concatenated. */
  partText: string | null | undefined;
}): TransFluidSpecReconcile {
  const type = (input.transTypeText ?? "").trim();
  const spec = (input.spec ?? "").trim();
  if (!type || !spec) return { action: "keep" };
  const partNorm = (input.partText ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

  // Direction 1 (batch-11 Rogue): CVT unit + stepped-ATF spec.
  if (CVT_TYPE_RE.test(type)) {
    if (CVT_SPEC_RE.test(spec)) return { action: "keep" }; // spec already CVT-family
    if (!STEPPED_SPEC_RE.test(spec)) return { action: "keep" }; // not identifiably stepped — leave alone
    for (const [re, label] of PART_TOKEN_TO_SPEC) {
      if (re.test(partNorm)) {
        return {
          action: "correct",
          correctedSpec: label,
          reason: `CVT transmission with stepped-ATF spec "${spec}" contradicted by CVT-family fluid part — spec reconciled to the part's family`,
        };
      }
    }
    return {
      action: "flag",
      reason: `CVT transmission but spec "${spec}" is a stepped-gearbox ATF family and no CVT-family fluid part corroborates a replacement`,
    };
  }

  // Direction 2 (round 10, batch-11 Equinox): geared automatic + CVT-family
  // spec — the inverse contradiction ("GM CVT Fluid (green)" on the 6T45,
  // anchored by next-generation content). Same evidence bar mirrored.
  if (GEARED_AUTO_TYPE_RE.test(type)) {
    if (!CVT_SPEC_RE.test(spec)) return { action: "keep" }; // spec not CVT-family — nothing to do
    if (STEPPED_SPEC_RE.test(spec)) return { action: "keep" }; // ambiguous chimera string — leave for the verifier
    for (const [re, label] of PART_STEPPED_TOKEN_TO_SPEC) {
      if (re.test(partNorm)) {
        return {
          action: "correct",
          correctedSpec: label,
          reason: `geared automatic with CVT-family spec "${spec}" contradicted by stepped-ATF fluid part — spec reconciled to the part's family`,
        };
      }
    }
    return {
      action: "flag",
      reason: `geared automatic transmission but spec "${spec}" is a CVT fluid family and no stepped-ATF fluid part corroborates a replacement`,
    };
  }

  return { action: "keep" };
}
