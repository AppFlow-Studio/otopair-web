/**
 * laborSibling — pure platform-matching helpers shared by the OLP pipeline.
 * Labor is a function of chassis (brake/suspension/body jobs) and engine family
 * (engine-bay jobs), so we match on the dimension that determines THIS service's
 * labor.
 *
 * RepairPal-specific actions (resolveLaborSibling, catalogSiblingCandidates,
 * llmSiblingCandidates, getConfigChassisCode) were removed when RepairPal was
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
  const m = engineCode.match(/^[A-Z]+\d+/);
  return m ? m[0] : undefined;
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

