// =============================================================================
// convex/vehicleEnrichment/rotorThickness.ts
//
// Rotor thickness has THREE distinct numbers and they are NEVER interchangeable:
//
//   nominal     — thickness when new. This is what OEM storefront listings
//                 publish, usually inside a size string ("330x22mm" = 330 mm
//                 DIAMETER x 22 mm nominal thickness).
//   machine_to  — thinnest a rotor may be machined TO and returned to service.
//                 Typically nominal − 0.050"..0.060".
//   discard_min — the replace-at number, cast on the rotor hat. THE minimum.
//                 Typically machine_to − ~0.015".
//
// Only `discard_min` may be used as the grading reference in
// lib/inspection-template.ts classify("rotor"). Grading against a nominal
// condemns healthy rotors and sells brake jobs that aren't needed; grading
// against nothing (the old `ref ?? 0`) passes worn ones.
//
// This module is pure — no network, no LLM, no ctx. It is used in two
// directions:
//   1. as the deterministic Tier-0 extractor over cached page markdown, and
//   2. as the cross-check on the LLM's self-reported kind: if the model claims
//      "discard_min" but the label it quoted classifies as something else, the
//      value is rejected. That cross-check is the structural guard — without
//      it, a confident model turns a nominal into a minimum.
// =============================================================================

export type RotorThicknessKind = "discard_min" | "machine_to" | "nominal";

export type RotorThicknessReading = {
  kind: RotorThicknessKind;
  /** Always millimetres. Inches are converted; the original stays in the text. */
  valueMm: number;
  /** VERBATIM label the value was read under — the human audit trail. */
  observedLabel: string;
  /** VERBATIM value as printed, in the source's own unit ("0.945 in"). */
  observedValueText: string;
};

// Checked in this order. "Minimum Machining Thickness" is a machine-to limit
// even though it contains "Minimum", so machine-to must win first.
const MACHINE_TO_LABELS: RegExp[] = [
  /machin(?:e|ing)/i,
  /refinish(?:ing)?/i,
  /resurfac(?:e|ing)/i,
];

const DISCARD_LABELS: RegExp[] = [
  /min(?:imum)?\.?\s*(?:disc\s*|rotor\s*|brake\s*)?th(?:ickness|k)?\b/i,
  /\bmin\.?\s*th\b/i,
  /\bdiscard\b/i,
  /wear\s*limit/i,
  /service\s*limit/i,
  /replace\s*at\b/i,
];

// The catch-all `thickness` MUST stay last and MUST resolve to nominal: an
// unqualified "Thickness" is a new-thickness spec, never a minimum.
const NOMINAL_LABELS: RegExp[] = [
  /\bnominal\b/i,
  /\bnew\s*thickness\b/i,
  /\boriginal\s*thickness\b/i,
  /\bthickness\b/i,
];

/**
 * Every label form `classifyThicknessLabel` recognises, in one list.
 *
 * Exported for the MANUAL PAGE SCORER (manualPageIndex.ts), which decides
 * which pages of a PDF are worth paying Reducto to read. The two have to hunt
 * for the same vocabulary or the pipeline pays for the wrong pages in both
 * directions: a page selected on a label this parser cannot classify is billed
 * for nothing, and a label this parser knows but the scorer ignores is a page
 * that never gets sent at all.
 *
 * Order is not meaningful here — the scorer counts hits, it does not classify.
 * Classification stays in classifyThicknessLabel, where precedence matters.
 */
export const ROTOR_THICKNESS_LABEL_PATTERNS: readonly RegExp[] = [
  ...MACHINE_TO_LABELS,
  ...DISCARD_LABELS,
  ...NOMINAL_LABELS,
];

/** Plausible discard-minimum bands, mm. Shared with the sanity rules. */
export const ROTOR_MIN_BANDS = {
  front: { typicalLow: 15, typicalHigh: 32, validLow: 8, validHigh: 40 },
  rear: { typicalLow: 6, typicalHigh: 24, validLow: 4, validHigh: 32 },
} as const;

/** Physical bounds for a rotor size string, used to reject non-rotor matches. */
const DIAMETER_MM = { min: 200, max: 430 };

/**
 * Bounds any rotor thickness must fall inside, nominal or minimum, mm.
 *
 * Exported because consumers that accept a thickness from somewhere other than
 * `parseRotorThickness` — the manual extractor's cross-check, the adapters —
 * need the same floor and ceiling. sourceAdapters/brembo.ts still carries its
 * own identical copy (`NOMINAL_VALID_MM`); fold it in when that file is next
 * touched.
 */
export const ROTOR_THICKNESS_VALID_MM = { min: 5, max: 60 } as const;

const THICKNESS_MM = ROTOR_THICKNESS_VALID_MM;

/** How far back to look for the label that qualifies a number. */
const LABEL_WINDOW = 64;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Map a verbatim label to the kind of number it introduces.
 * Returns null when the label says nothing about thickness at all — callers
 * must treat null as "refuse the value", not as "assume nominal".
 */
export function classifyThicknessLabel(
  label: string | null | undefined,
): RotorThicknessKind | null {
  const s = (label ?? "").trim();
  if (!s) return null;
  if (MACHINE_TO_LABELS.some((re) => re.test(s))) return "machine_to";
  if (DISCARD_LABELS.some((re) => re.test(s))) return "discard_min";
  if (NOMINAL_LABELS.some((re) => re.test(s))) return "nominal";
  return null;
}

/**
 * True when `label` actually supports the claimed `kind`. This is the guard the
 * pipeline applies to the LLM's output — a model that answers
 * `{kind: "discard_min", observed_label: "Thickness"}` is rejected.
 */
export function labelSupportsKind(
  label: string | null | undefined,
  kind: RotorThicknessKind,
): boolean {
  return classifyThicknessLabel(label) === kind;
}

/** The label text immediately preceding a value, bounded by cell/clause edges. */
function labelBefore(text: string, index: number): string {
  const start = Math.max(0, index - LABEL_WINDOW);
  let chunk = text.slice(start, index);
  // Drop the separators that sit between a label and its value.
  chunk = chunk.replace(/[\s:=|\-–—]*$/u, "");
  // A label never spans a table cell, list item or line break.
  let cut = -1;
  for (const sep of ["|", "\n", ";", ",", ")", "•", "*", "#"]) {
    cut = Math.max(cut, chunk.lastIndexOf(sep));
  }
  if (cut >= 0) chunk = chunk.slice(cut + 1);
  return chunk.trim();
}

/**
 * Extract every rotor thickness reading from a block of page text.
 *
 * Guarantees:
 *   - a bare number with no classifiable label yields NOTHING;
 *   - a size string yields only its SECOND number, always as `nominal`
 *     (the first is the diameter and is never returned as a thickness);
 *   - inches are converted to mm with the original preserved verbatim;
 *   - a value with no explicit unit is skipped — missing beats guessed.
 */
export function parseRotorThickness(
  text: string | null | undefined,
): RotorThicknessReading[] {
  if (!text) return [];
  const out: RotorThicknessReading[] = [];
  const consumed: Array<[number, number]> = [];

  // 1) Size strings: "330x22mm" / "330 x 22 mm". The diameter bound keeps this
  //    from matching thread specs and other AxB text.
  const sizeRe = /(\d{3}(?:\.\d)?)\s*[x×]\s*(\d{1,2}(?:\.\d{1,2})?)\s*(?:mm\b)?/gi;
  for (let m = sizeRe.exec(text); m; m = sizeRe.exec(text)) {
    const diameter = parseFloat(m[1]);
    const thickness = parseFloat(m[2]);
    if (!Number.isFinite(diameter) || !Number.isFinite(thickness)) continue;
    if (diameter < DIAMETER_MM.min || diameter > DIAMETER_MM.max) continue;
    if (thickness < THICKNESS_MM.min || thickness > THICKNESS_MM.max) continue;
    consumed.push([m.index, m.index + m[0].length]);
    out.push({
      kind: "nominal",
      valueMm: thickness,
      observedLabel: "size string (diameter x thickness)",
      observedValueText: m[0].trim(),
    });
  }

  // 2) Labelled values. An explicit unit is required, and the label must
  //    classify — those two rules together are what stop a stray "22" from
  //    becoming a minimum.
  const valueRe =
    /(\d{1,3}(?:\.\d{1,3})?)\s*(mm\b|millimet(?:er|re)s?\b|in\b\.?|inch(?:es)?\b|″|")/gi;
  for (let m = valueRe.exec(text); m; m = valueRe.exec(text)) {
    const at = m.index;
    if (consumed.some(([s, e]) => at >= s && at < e)) continue;
    const label = labelBefore(text, at);
    const kind = classifyThicknessLabel(label);
    if (!kind) continue;
    const raw = parseFloat(m[1]);
    if (!Number.isFinite(raw)) continue;
    const isInches = /^(?:in|inch|″|")/i.test(m[2].trim());
    const valueMm = isInches ? round2(raw * 25.4) : raw;
    // A rotor is 5-60 mm thick. Anything outside that is not a rotor spec,
    // whatever its label said.
    //
    // The size-string branch above has always bounded its output; this branch
    // did not, and the catch-all `\bthickness\b` / `\bnominal\b` labels are
    // wide enough to need it. Live fire (2021 GMC Acadia owner's manual, p317):
    // "tires with nominal rim diameters of 10 to 12 in" classified as `nominal`
    // and yielded 304.8 mm. Unbounded, that reading wins `pickRotorThickness`'s
    // largest-nominal tie-break outright and becomes the vehicle's nominal —
    // and a nominal that large makes every real minimum look coherent beside
    // it. The risk grew when the resolver widened from one cached page to all
    // of them: more pages means more tyre, glass and trim text reaching this
    // parser, and precision here is what makes that widening safe.
    if (valueMm < ROTOR_THICKNESS_VALID_MM.min || valueMm > ROTOR_THICKNESS_VALID_MM.max) {
      continue;
    }
    out.push({
      kind,
      valueMm,
      observedLabel: label,
      observedValueText: m[0].trim(),
    });
  }

  return out;
}

export type RotorThicknessPick = {
  discardMinMm: number | null;
  nominalMm: number | null;
  machineToMm: number | null;
  /** Label backing `discardMinMm`, for the audit trail. Null when unsourced. */
  observedLabel: string | null;
  observedValueText: string | null;
};

/**
 * Collapse readings into one answer per axle. Ties break toward the SMALLEST
 * minimum and the LARGEST nominal — the pairing least likely to condemn a
 * healthy rotor if the page carried more than one variant.
 */
export function pickRotorThickness(
  readings: RotorThicknessReading[],
): RotorThicknessPick {
  let min: RotorThicknessReading | null = null;
  let nominal: RotorThicknessReading | null = null;
  let machineTo: RotorThicknessReading | null = null;

  for (const r of readings) {
    if (r.kind === "discard_min") {
      if (!min || r.valueMm < min.valueMm) min = r;
    } else if (r.kind === "nominal") {
      if (!nominal || r.valueMm > nominal.valueMm) nominal = r;
    } else if (r.kind === "machine_to") {
      if (!machineTo || r.valueMm < machineTo.valueMm) machineTo = r;
    }
  }

  return {
    discardMinMm: min?.valueMm ?? null,
    nominalMm: nominal?.valueMm ?? null,
    machineToMm: machineTo?.valueMm ?? null,
    observedLabel: min?.observedLabel ?? null,
    observedValueText: min?.observedValueText ?? null,
  };
}
