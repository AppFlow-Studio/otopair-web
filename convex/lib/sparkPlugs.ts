/**
 * lib/sparkPlugs.ts — how many spark plugs does this engine take?
 *
 * WHY THIS EXISTS
 * ---------------
 * `spark_plugs` is a `per_cylinder` service (seedServiceParts): the booking
 * multiplies the plug's unit price by `engines.spark_plug_quantity`. That column
 * was only ever populated by the LLM enrichment pass, which returns null often
 * enough to matter — a 100-engine sample on Aug 17 2026 had it empty on 17, and
 * **15 of those 17 already knew their cylinder count**. Nothing derived one from
 * the other, so a number sitting right there in the same row went unused.
 *
 * The failure was not visible as a gap, either. `job_actuals` filled a missing
 * quantity with a hardcoded `?? 4`, so a V6 quoted four plugs and a V8 quoted
 * four plugs, confidently and silently. A wrong count here is a wrong invoice,
 * not a thin one — which is the worse class of error.
 *
 * PLUGS ARE NOT ALWAYS ONE PER CYLINDER
 * -------------------------------------
 * The obvious rule (quantity = cylinders) is right for the overwhelming
 * majority of the fleet and WRONG by a factor of two for twin-plug engines. A
 * 5.7 HEMI takes sixteen plugs, not eight. Encoding the exceptions is the whole
 * reason this is a module and not an inline `?? cylinders`.
 *
 * The exception list is deliberately SHORT and evidenced. Every entry is a
 * design that is documented as twin-plug, not a family someone assumed. When in
 * doubt the answer is the 1:1 default, because over-counting plugs on a
 * one-plug engine is the same size of billing error in the other direction.
 *
 * NULL-OVER-GUESS
 * ---------------
 * Unknown cylinder count returns null, never a default. A null quantity is a
 * visible gap that the manual pass, the director UI, or the mechanic's pre-job
 * form can fill. A fabricated 4 is indistinguishable from a real 4.
 */

/** Plugs per cylinder for engine families that fire two per cylinder. */
export type PlugBasis = "per_cylinder" | "twin_spark";

export type SparkPlugQuantity = {
  quantity: number;
  /** Which rule produced it — stored/logged so a wrong count is auditable. */
  basis: PlugBasis;
  /** Short human explanation for the log line. */
  why: string;
};

export type EngineFacts = {
  cylinders?: number | null;
  /** Display make name; matched case/punctuation-insensitively. */
  make?: string | null;
  engineCode?: string | null;
  displacementL?: number | string | null;
};

const norm = (s: unknown): string =>
  String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

function displacement(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : parseFloat(String(raw ?? ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Stellantis brands whose V8s of the listed displacements are twin-plug.
 * Mopar's modern HEMI (5.7 / 6.1 / 6.2 / 6.4) and the earlier 4.7 PowerTech
 * both fire two plugs per cylinder — sixteen on a V8.
 */
const MOPAR_MAKES = new Set(["chrysler", "dodge", "jeep", "ram", "mopar"]);
const MOPAR_TWIN_PLUG_V8_DISPLACEMENTS = [4.7, 5.7, 6.1, 6.2, 6.4];

/** Engine-code prefixes that are twin-plug regardless of make/displacement. */
const TWIN_PLUG_CODE_PATTERNS: ReadonlyArray<{ re: RegExp; why: string }> = [
  // Mercedes M112 (V6) and M113 (V8), ~1997-2011: two plugs per cylinder.
  // Their modern replacements (M276/M278) are single-plug, so this must stay
  // pinned to the code prefix and must not widen to "Mercedes V8".
  { re: /^m11[23]/i, why: "Mercedes M112/M113 twin-plug" },
];

/** Is this displacement one of the listed values (0.05 L tolerance)? */
function matchesAny(disp: number, list: readonly number[]): boolean {
  return list.some((d) => Math.abs(disp - d) < 0.05);
}

/**
 * Could this engine be twin-plug without us being able to tell?
 *
 * True only for the shape where make is the deciding evidence and we do not
 * have it: a V8 whose displacement is one Mopar builds as a twin-plug HEMI or
 * PowerTech. Every other engine either matches a decisive code pattern or is
 * safely 1:1, so this stays narrow — it is a refusal to answer, and refusing
 * too often just re-creates the gap it exists to keep honest.
 */
export function isTwinPlugAmbiguous(facts: EngineFacts): boolean {
  if (facts.cylinders !== 8) return false;
  const code = String(facts.engineCode ?? "");
  if (TWIN_PLUG_CODE_PATTERNS.some((p) => p.re.test(code))) return false; // decided
  const make = norm(facts.make);
  if (make.length > 0) return false; // make known — plugsPerCylinder decides
  const disp = displacement(facts.displacementL);
  return disp != null && matchesAny(disp, MOPAR_TWIN_PLUG_V8_DISPLACEMENTS);
}

/**
 * Plugs per cylinder for this engine. Defaults to 1; returns 2 only for an
 * explicitly evidenced twin-plug design.
 */
export function plugsPerCylinder(facts: EngineFacts): { n: 1 | 2; why: string } {
  const code = String(facts.engineCode ?? "");
  for (const p of TWIN_PLUG_CODE_PATTERNS) {
    if (p.re.test(code)) return { n: 2, why: p.why };
  }

  const disp = displacement(facts.displacementL);
  const make = norm(facts.make);
  if (
    MOPAR_MAKES.has(make) &&
    facts.cylinders === 8 &&
    disp != null &&
    matchesAny(disp, MOPAR_TWIN_PLUG_V8_DISPLACEMENTS)
  ) {
    return { n: 2, why: `Mopar ${disp}L V8 twin-plug (HEMI/PowerTech)` };
  }

  return { n: 1, why: "one plug per cylinder" };
}

/**
 * Derive the plug count, or null when the cylinder count is unknown.
 *
 * Pure and total. Rejects implausible cylinder counts the same way
 * cylindersRepair.sanitizeCylinders does — a 0 (the "decoder told us nothing"
 * sentinel, which is what a 2022 Maverick gets because vPIC returns no
 * EngineCylinders field at all for that VIN) must not become a quantity.
 */
export function deriveSparkPlugQuantity(facts: EngineFacts): SparkPlugQuantity | null {
  const cyl = facts.cylinders;
  if (typeof cyl !== "number" || !Number.isInteger(cyl) || cyl < 2 || cyl > 16) {
    return null;
  }

  // AMBIGUITY GUARD. Make is what decides the twin-plug question for a V8: a
  // 6.2 L V8 takes sixteen plugs as a Mopar Hellcat and eight as a Chevrolet
  // LT1. Deriving without a make would silently pick one, and the wrong pick is
  // a doubled-or-halved invoice. Refuse instead — null is a gap someone can
  // fill, a wrong count is not.
  if (isTwinPlugAmbiguous(facts)) return null;

  const { n, why } = plugsPerCylinder(facts);
  return {
    quantity: cyl * n,
    basis: n === 2 ? "twin_spark" : "per_cylinder",
    why: `${cyl} cylinder(s) × ${n} — ${why}`,
  };
}

/**
 * The quantity to bill, given whatever is on the engine row.
 *
 * Precedence: a stored quantity wins (it came from the manual or a human), then
 * the derivation, then null. Callers MUST handle null by surfacing a gap rather
 * than substituting a number — that substitution is the bug this replaces.
 */
export function resolveSparkPlugQuantity(
  engine: EngineFacts & { spark_plug_quantity?: number | null },
): { quantity: number | null; basis: PlugBasis | "stored" | "unknown" } {
  const stored = engine.spark_plug_quantity;
  if (typeof stored === "number" && Number.isFinite(stored) && stored > 0) {
    return { quantity: stored, basis: "stored" };
  }
  const derived = deriveSparkPlugQuantity(engine);
  return derived
    ? { quantity: derived.quantity, basis: derived.basis }
    : { quantity: null, basis: "unknown" };
}
