/**
 * warningLightVocab — the single, format- and vocabulary-agnostic reader for
 * `vehicle_owners.knownIssues`.
 *
 * WHY THIS EXISTS
 * ---------------
 * `knownIssues` is written in two incompatible SHAPES depending on which path
 * last touched it:
 *   • LEGACY sentinel-prefixed — `[status, ...lights]` where `status` is one of
 *     `no_all_clear | check_engine | other | not_sure | different_light`.
 *     Written by the onboarding stepper (convex/vehicles.ts) +
 *     autoCompleteNewVehicleOnboarding.
 *   • FLAT code-set — a bare list of light-id codes, no sentinel. Written by the
 *     quarterly check-in (convex/checkin.ts) and by Oto (convex/vehicleTruth.ts
 *     applyVehicleTruth, which raw-appends).
 *
 * It also mixes two VOCABULARIES:
 *   • CANONICAL dashboard light ids the client health/tracker readers key on:
 *     `oil_pressure | battery_charging | temperature | abs | tpms | airbag_srs |
 *      transmission | check_engine | not_sure_which`.
 *   • SYMPTOM codes written by the pipeline / serviceSymptoms.ts / check-in:
 *     `brake_warning | battery | battery_hesitate | battery_no_start |
 *      tire_issue | TPMS | soft_slow | alignment | ...`. Crucially
 *     `brake_warning != abs` and `battery != battery_charging`.
 *
 * Readers that assumed `knownIssues[0]` was a sentinel (health-score penalty,
 * the consolidated warning-light card) silently dropped lights written in the
 * flat shape; readers that hard-coded a canonical `.includes()` missed lights
 * written in the symptom vocabulary. This module collapses BOTH axes: scan the
 * WHOLE array, map any recognised alias to its canonical light id, drop
 * everything that isn't a dashboard light. Every warning-light reader should go
 * through `canonicalWarningLights` so a light logged via ANY writer surfaces
 * consistently on the Cars tracker, the Home Now-tier, and the health score.
 *
 * Pure module: zero React Native / Convex / `@/` value imports, so it is safe to
 * import from client hooks, `utils/`, and Convex server code alike.
 */

/** Canonical dashboard warning-light ids — the vocabulary the client
 *  health-score + maintenance-tracker readers key on. */
export const CANONICAL_WARNING_LIGHTS = [
  "oil_pressure",
  "battery_charging",
  "temperature",
  "abs",
  "tpms",
  "airbag_srs",
  "transmission",
  "check_engine",
  "not_sure_which",
] as const;

export type CanonicalWarningLight = (typeof CANONICAL_WARNING_LIGHTS)[number];

// ---------------------------------------------------------------------------
// Hazard mapping (Wave 2.1, 2026-08-10)
// ---------------------------------------------------------------------------
//
// Until now this module carried ids and aliases and NO hazard data, which meant
// the oil-pressure light and the TPMS light were indistinguishable to every
// consumer — including Oto. That is the p.112 defect in the Aug-08 QA report:
// an illuminated oil-pressure light received "drive to a gas station and check
// the dipstick" instead of "stop the engine now". Running an engine with no oil
// pressure can destroy it in minutes, so that instruction was actively harmful.
//
// `severity` is ordered: stop_now > urgent > soon > informational.
//   stop_now       — continuing to drive risks catastrophic damage or injury.
//                    Pull over and shut down; the trip is over.
//   urgent         — safe to drive briefly, directly to a shop. Do not defer.
//   soon           — degraded but not dangerous today. Book it.
//   informational  — needs identification before anything can be said.
//
// `action` is the driver-facing instruction, written as the first thing a driver
// should hear. It is intentionally imperative and short.
//
// SOURCING (Q5, revised 2026-08-13). This table is no longer pending one
// person's sign-off — it is grounded in published consumer roadside guidance,
// primarily AAA, which is the right register because it is written for drivers
// deciding whether to keep driving rather than for technicians.
//
// The tier boundaries mirror the industry colour convention AAA states directly:
//   red    → serious; stop immediately, and do NOT drive it to the shop — tow it
//   amber  → low-grade; usually drivable a few more miles, address very soon
//   green  → notification only, not a fault
// which is why `stop_now` reads "the trip is over" and `soon` reads "book it".
//
// Per-light sources:
//   oil_pressure  AAA: pull over, shut off, let it sit, check the level; if the
//                 level is fine or the light returns after topping up, tow it.
//                 Deliberately NOT an unconditional tow — see that entry.
//   temperature   AAA: pull off at the earliest safe opportunity, shut it off,
//                 let it cool; tow if there are signs of a coolant leak.
//   transmission  Manufacturer + trade guidance: stop, let it cool ~30 min;
//                 towing is the recommended course.
//   battery_chg   AAA: get it to a repair facility immediately — drive it, do
//                 not tow, but do not defer.
//   abs           Trade consensus: the amber ABS lamp means assist is disabled
//                 and base hydraulic braking is unaffected. NOTE the alias
//                 caveat on this entry — this bucket is not purely ABS.
//   check_engine  Trade consensus: steady = stored fault, drivable; FLASHING =
//                 active misfire that can destroy a catalytic converter.
//   tpms          Trade guidance: the lamp trips around 25% under-inflation;
//                 drive to the nearest air source, and stop if the car pulls,
//                 vibrates, thumps, or a tire is visibly flat.
//   airbag_srs    AAA: have the system inspected. Notably AAA does NOT tell the
//                 driver to stop — the fault is to passive protection in a
//                 crash, not to control of the car. Tiered accordingly.
//
// WHAT IS STILL JUDGMENT, and should be read as such: the exact tier boundary
// for airbag_srs (a severe consequence with a low probability of occurring on
// this trip) and the wording of every `action`, which is ours. The severities
// and the drive/tow calls are sourced.

export type WarningLightSeverity = "stop_now" | "urgent" | "soon" | "informational";

export interface WarningLightHazard {
  severity: WarningLightSeverity;
  /**
   * Driver-facing imperative. Leads the response when this light is active.
   *
   * INVARIANT: this string must require NO mechanical skill, NO tools, and no
   * access to the engine bay. A beginner and a mechanic execute it identically.
   * Anything that asks the driver to inspect, measure, or interpret belongs in
   * `selfCheck` instead — see the note below.
   */
  action: string;
  /** Why it matters — one clause, plain language, no jargon. */
  because: string;
  /**
   * OPTIONAL hands-on step, phrased as an OFFER rather than an instruction.
   *
   * Published roadside guidance (AAA and friends) is written for someone
   * already standing at the roadside with the hood open — "check the dipstick",
   * "top it up", "see if it's leaking". Those conditionals assume competence
   * OtoPair has no basis to assume, and the assumption does not fail neutrally:
   * a driver who cannot do the check does not stop, they GUESS, and a bad
   * dipstick read produces a false all-clear — "looked fine" → keep driving →
   * the exact engine loss `stop_now` exists to prevent, reached THROUGH the
   * safety instruction rather than despite it.
   *
   * The asymmetry decides it. Over-cautious costs a tow. Under-cautious costs
   * an engine or strands someone. So the hands-on branch is never the default
   * path: it is offered, it is declinable without friction, and silence
   * resolves to the conservative answer.
   *
   * Rules enforced downstream in convex/oto/safety.ts:
   *   1. `action` is stated first and unconditionally; `selfCheck` follows it.
   *   2. Declining, ignoring, or not answering resolves to the safe option.
   *   3. A self-check NEVER issues an all-clear on its own. "Looked fine to me"
   *      does not clear a `stop_now`; only a concrete positive result does
   *      (e.g. "I added oil and the light went out"), and that still books a
   *      visit.
   *
   * Present ONLY where a genuinely user-performable task exists. A flashing
   * check-engine light has none, so it has no `selfCheck`, and inventing one
   * would be noise at the worst possible moment.
   *
   * NOT gated on `car_knowledge` from onboarding. That field is self-declared,
   * people overestimate, and a tick-box from signup is not evidence about who
   * is standing on a hard shoulder in the rain. Use it for how much to explain,
   * never for whether the safety floor applies.
   */
  selfCheck?: string;
}

export const WARNING_LIGHT_HAZARD: Readonly<
  Record<CanonicalWarningLight, WarningLightHazard>
> = {
  oil_pressure: {
    severity: "stop_now",
    // The tow is CONDITIONAL, not automatic. An earlier draft said "have it
    // towed" outright, which is stricter than AAA and would send a truck to a
    // driver who is simply a quart low. AAA's sequence is stop → shut off →
    // let it settle → check the level → top up if low → tow only if the level
    // was already fine or the light returns. The harmful instruction in the
    // QA report (p.112) was DRIVING to a gas station, not checking the oil.
    action: "Pull over as soon as it's safe and shut the engine off — don't drive it any further, not even a short distance.",
    because: "no oil pressure means moving metal parts are running without lubrication, which can destroy an engine within minutes — of all the warning lights this one gives you the least time to react",
    selfCheck: "Once it's sat for a few minutes there's one thing that sometimes clears this — checking the oil level and topping it up if it's low. I can walk you through exactly where to look and what to do, if you want to try. If you'd rather not, or you're not sure, that's completely fine and it's the safer call anyway — we'll get you towed instead.",
  },
  temperature: {
    severity: "stop_now",
    action: "Pull over as soon as it's safe and shut the engine off. Don't open the radiator cap or the coolant tank — the system is hot enough and under enough pressure to scald badly.",
    because: "an overheating engine can warp the head or blow a gasket, and the cooling system stays dangerously pressurised long after you stop",
    selfCheck: "After it's had at least half an hour to cool, there's a simple look-and-see for how much coolant is in the tank and whether anything's dripping underneath. I can talk you through it if you'd like to check — otherwise we skip it and get you towed, which is the safer option regardless.",
  },
  transmission: {
    severity: "stop_now",
    action: "Pull over safely and stop driving. Have it towed rather than driving it in.",
    because: "a transmission fault can escalate to total loss of drive with no warning, including at speed",
  },
  battery_charging: {
    severity: "urgent",
    action: "Drive straight to a shop now if it's close, and don't shut the engine off until you're there — it may not restart.",
    because: "this usually means the alternator has stopped charging, so the car is running on battery alone and will lose electrical power",
  },
  abs: {
    severity: "urgent",
    // ⚠️ THIS BUCKET IS NOT PURELY ABS. `ALIAS_TO_CANONICAL` folds the symptom
    // code `brake_warning` onto `abs`, contradicting this module's own header
    // ("Crucially brake_warning != abs"), and four separate label maps call it
    // "ABS / brake". So a report that is actually the RED brake lamp — low
    // fluid or a failed hydraulic circuit, i.e. reduced stopping ability —
    // arrives here indistinguishable from an amber ABS-only fault.
    //
    // Therefore this text must NOT assert that the base brakes are fine, which
    // an earlier draft did ("Your normal brakes still work"). That sentence is
    // reassurance the data cannot support, delivered to the one caller who may
    // be least able to stop. Lead with the dangerous reading and let the driver
    // resolve which lamp they have. Severity stays `urgent` for the same
    // reason: downgrading to `soon` would be right for ABS alone and wrong for
    // the merged bucket. Splitting them is filed separately — it needs a 10th
    // canonical id across ~10 files plus a check-in UI option.
    // "Check which light it is" (the 2026-08-13 morning draft) was itself a
    // competence assumption — it hands the driver an interpretation task and
    // waits. Oto can just ask, then answer, which is what `not_sure_which`
    // already does. Both branches are stated so nobody is left holding a
    // question instead of an instruction.
    action: "Tell me what color it is and I'll tell you which one you've got — red and amber mean very different things here. If it's RED, treat the car as unsafe to drive: stop somewhere safe and have it towed, because that one can mean low fluid or a failed brake circuit. If it's AMBER, normal braking still works and only the anti-lock assist is off — leave extra stopping distance, avoid hard braking, and get it looked at now.",
    because: "the red lamp points at the hydraulic system that actually stops the car, while the amber ABS lamp only means the anti-lock assist is disabled — and if both are lit together it is the more serious of the two",
  },
  airbag_srs: {
    // Downgraded urgent → soon on 2026-08-13. AAA's guidance is to have the
    // system inspected; it does not tell the driver to stop or to hurry. The
    // fault is to passive protection IF a crash happens, not to control of the
    // car now — so it should not fire a physical-hazard override that leads the
    // whole turn with a safety instruction. The consequence is severe, which is
    // why the wording stays blunt rather than soft. This tier boundary is the
    // most debatable line in the table.
    severity: "soon",
    action: "The car drives normally, so there's nothing to do this minute — but book it, and don't let it sit. While that light is on you should assume the airbags won't deploy in a crash.",
    because: "an SRS fault can disable the airbags and seatbelt pretensioners entirely, and there is no way to tell from the driver's seat whether they still work",
  },
  check_engine: {
    // NOTE: `soon` is the STEADY case. A flashing lamp is a stop-driving case
    // and is escalated separately in convex/oto/safety.ts, because the canonical
    // id has no flashing variant and this table is keyed by id alone.
    severity: "soon",
    action: "If it's FLASHING, stop driving — pull over somewhere safe and have it towed rather than driving it in. If it's steady, the car is safe to keep driving; book a scan so we can read the fault.",
    because: "a flashing light means an active misfire dumping raw fuel into the catalytic converter, which can wreck it in a short drive and is an expensive part; steady means a stored fault that just needs reading",
  },
  tpms: {
    severity: "soon",
    action: "It's usually fine to drive as far as the nearest gas station or air pump. Pull over sooner than that if the car pulls to one side, vibrates, thumps, or a tire looks visibly flat.",
    because: "the light usually trips once a tire is about a quarter below its proper pressure, and an underinflated tire builds heat and can fail at speed — but it can equally be a cold morning",
    selfCheck: "If you want to sort it there yourself, I can tell you the right pressures for your car and walk you through the air pump. Or just book it and someone will check all four properly, including whether anything's stuck in the tread.",
  },
  not_sure_which: {
    severity: "informational",
    action: "Tell me the color and shape and I'll identify it — red usually means stop, amber means service soon.",
    because: "the right advice depends entirely on which light it is, and guessing could send you the wrong way",
  },
};

/** Severity ordering for comparisons — higher number wins. */
const SEVERITY_RANK: Readonly<Record<WarningLightSeverity, number>> = {
  informational: 0,
  soon: 1,
  urgent: 2,
  stop_now: 3,
};

/**
 * The most severe hazard among a set of canonical lights, or null when the set
 * is empty. Used to decide whether a turn needs a safety override at all.
 */
export function mostSevereLight(
  lights: readonly CanonicalWarningLight[],
): { light: CanonicalWarningLight; hazard: WarningLightHazard } | null {
  let best: { light: CanonicalWarningLight; hazard: WarningLightHazard } | null = null;
  for (const light of lights) {
    const hazard = WARNING_LIGHT_HAZARD[light];
    if (!hazard) continue;
    if (!best || SEVERITY_RANK[hazard.severity] > SEVERITY_RANK[best.hazard.severity]) {
      best = { light, hazard };
    }
  }
  return best;
}

const CANONICAL_SET: ReadonlySet<string> = new Set(CANONICAL_WARNING_LIGHTS);

/** The four lights that escalate a matching maintenance tile to the Now tier
 *  (handled by the paired-tile path in useMaintenanceData / vehicleHealth), so
 *  the consolidated "warning lights active" card excludes them to avoid a
 *  double prompt for one root cause. */
export const PAIRED_WARNING_LIGHTS: ReadonlySet<string> = new Set([
  "oil_pressure",
  "battery_charging",
  "abs",
  "tpms",
]);

/**
 * Symptom-code / stepper-sentinel vocabulary → canonical light id. Keys are the
 * exact tokens that appear in stored `knownIssues` arrays. Anything not a
 * dashboard light (bare sentinels `no_all_clear` / `other` / `different_light`,
 * pure symptom codes `soft_slow` / `alignment` / `diagnostic_noise`) is
 * intentionally absent — it maps to nothing.
 */
const ALIAS_TO_CANONICAL: Readonly<Record<string, string>> = {
  brake_warning: "abs",
  battery: "battery_charging",
  battery_hesitate: "battery_charging",
  battery_no_start: "battery_charging",
  tire_issue: "tpms",
  TPMS: "tpms",
  tire_pressure: "tpms",
  oil: "oil_pressure",
  not_sure: "not_sure_which",
};

/**
 * Map one raw `knownIssues` code to its canonical dashboard-light id, or `null`
 * if the code is not a warning light (a sentinel, a non-light symptom code, or
 * unrecognised). Exact-match first, then a lowercase retry so a stray
 * upper/mixed-case id ("TPMS", "Oil_Pressure") still resolves.
 */
export function toCanonicalLight(code: string): CanonicalWarningLight | null {
  if (!code) return null;
  if (CANONICAL_SET.has(code)) return code as CanonicalWarningLight;
  if (code in ALIAS_TO_CANONICAL) return ALIAS_TO_CANONICAL[code] as CanonicalWarningLight;
  const lower = code.toLowerCase();
  if (lower !== code) {
    if (CANONICAL_SET.has(lower)) return lower as CanonicalWarningLight;
    if (lower in ALIAS_TO_CANONICAL) return ALIAS_TO_CANONICAL[lower] as CanonicalWarningLight;
  }
  return null;
}

/**
 * The canonical dashboard warning-light ids present in a `knownIssues` array,
 * deduped and in first-seen order. Format-agnostic (scans the whole array, so
 * the sentinel-prefixed legacy shape and the flat code-set shape both work) and
 * vocabulary-agnostic (symptom aliases fold onto their canonical light).
 */
export function canonicalWarningLights(
  knownIssues?: readonly string[] | null,
): CanonicalWarningLight[] {
  if (!knownIssues || knownIssues.length === 0) return [];
  const out: CanonicalWarningLight[] = [];
  for (const code of knownIssues) {
    const canonical = toCanonicalLight(code);
    if (canonical && !out.includes(canonical)) out.push(canonical);
  }
  return out;
}

/**
 * Canonicalise a single fault-light id as emitted by Oto's render_vehicle_update
 * before it is written to `knownIssues`, so the stored value matches the reader
 * vocabulary. Recognised aliases (e.g. the wrong `tire_pressure` the tool schema
 * example used) fold to canonical; anything unrecognised passes through
 * unchanged so we never silently drop a user-reported light.
 */
export function normalizeFaultLight(raw: string): string {
  const trimmed = raw.trim();
  return toCanonicalLight(trimmed) ?? trimmed;
}
