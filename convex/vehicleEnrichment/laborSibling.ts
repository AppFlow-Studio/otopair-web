/**
 * laborSibling — pure platform-matching helpers shared by the OLP pipeline.
 * Labor is a function of chassis (brake/suspension/body jobs) and engine family
 * (engine-bay jobs), so we match on the dimension that determines THIS service's
 * labor.
 *
 * Estimator-specific actions (resolveLaborSibling, catalogSiblingCandidates,
 * llmSiblingCandidates, getConfigChassisCode) were removed when Estimator was
 * decommissioned (Task 7).
 */

export type LaborDeterminant = "engine" | "chassis" | "both";
export type PlatformKey = { chassis_code?: string; engine_family?: string };

/**
 * Derive the engine FAMILY from a full engine code when engine_family is unset
 * (it's null on many dev rows). The family is the leading letter+number group:
 * "N63B44O2" → "N63", "B58B30M0" → "B58". Returns undefined if unparseable.
 * Family (not the sub-variant) is the right grain for labor — a water-pump job
 * is identical across N63B44O2/T4. BMW-shaped; good enough for our fleet.
 */
export function deriveEngineFamily(engineCode?: string): string | undefined {
  if (!engineCode) return undefined;
  const code = engineCode.trim().toUpperCase();
  if (!code) return undefined;

  // 1. A separator already marks the family/variant boundary, so honour it:
  //    Toyota 2GR-FKS -> 2GR, A25A-FKS -> A25A.
  const beforeSeparator = code.split(/[-\s_]/)[0];
  if (beforeSeparator !== code && beforeSeparator.length > 0) return beforeSeparator;

  // 2. No separator: the original letters-then-digits rule, which is the one
  //    that produces the documented BMW grain (N63B44O2 -> N63, B58B30M0 ->
  //    B58) and also handles QR25DE -> QR25, K24W9 -> K24, FB25D -> FB25.
  const m = code.match(/^[A-Z]+\d+/);
  if (m) return m[0];

  // 3. DIGIT-LEADING codes reach here and used to return undefined, silently:
  //    the whole Toyota V6/V8 range (2GR-FKS, 1GR-FE, 3UR-FE — when passed
  //    without their dash), Mitsubishi 4B12/4J12, JLR 306DT, RAM ETK. An
  //    undefined family flows onto the labor observation with no flag and
  //    siblingMatches short-circuits on `!!target.engine_family`, so sibling
  //    labor inheritance was dark for those engines with nothing to show for
  //    it. The code itself is a better family key than nothing — but ONLY when
  //    it actually looks like a code. Returning arbitrary text ("???") as an
  //    engine family would key sibling inheritance on garbage and let unrelated
  //    vehicles inherit each other's labor, which is worse than no family.
  return /^[A-Z0-9]{2,12}$/.test(code) ? code : undefined;
}

/** Which platform key(s) a service's labor depends on. */
export function matchKeyForDeterminant(
  d: LaborDeterminant,
  v: { chassis_code?: string; engine_family?: string },
): PlatformKey {
  if (d === "engine") return { engine_family: v.engine_family };
  if (d === "chassis") return { chassis_code: v.chassis_code };
  return { chassis_code: v.chassis_code, engine_family: v.engine_family };
}

/**
 * Is `candidate` a valid labor source for a `d`-determined service on `target`?
 * engine → same engine_family; chassis → same chassis_code; both → both.
 */
export function siblingMatches(
  d: LaborDeterminant,
  target: { chassis_code?: string; engine_family?: string },
  candidate: { chassis_code?: string; engine_family?: string },
): boolean {
  const chassisOk =
    !!target.chassis_code && target.chassis_code === candidate.chassis_code;
  const engineOk =
    !!target.engine_family && target.engine_family === candidate.engine_family;
  if (d === "engine") return engineOk;
  if (d === "chassis") return chassisOk;
  return chassisOk && engineOk;
}

