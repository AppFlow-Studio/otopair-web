/**
 * symptomTracking.ts — Issue 2 (Aug-08 QA report, 2026-08-15)
 *
 * WHY THIS EXISTS
 * ---------------
 * The report's hardest-input case put four symptoms in one message — no-start,
 * a dash light, an AC smell, a brake squeak — and Oto carried none of them as
 * visible state. The ruling: "pin unresolved symptoms to the thread as visible
 * state, and pre-check every one of them in the service picker when the
 * booking is built."
 *
 * The W3.2 open-symptom ledger (ai_conversations.open_symptoms) already
 * carries unresolved symptoms deterministically — but only ones the Wave 2
 * safety classifier fires on (urgent/stop_now hazards). A brake squeak, a
 * musty AC smell, or a steady check-engine light never reached it. This module
 * adds the NON-hazard symptom classes, plus the two translations the client
 * and the booking bundler need:
 *
 *   classifyTrackedSymptoms(msg)  → tracked rows to append (chat.ts)
 *   symptomDisplayLabel(category) → short pin-list label   (SymptomTrackerPin)
 *   symptomServiceTarget(category)→ service slug to pre-check (chat.ts §7c)
 *
 * Same posture as convex/oto/safety.ts: deterministic regex, tone-blind, runs
 * before/around the model so the model cannot forget. Patterns require a
 * "something is wrong" descriptor, not a bare noun — "just got my brakes done,
 * no more squeaking" is a false positive we accept; "thinking about brakes"
 * is not allowed to pin anything.
 *
 * LEDGER CATEGORY FORMATS this module understands:
 *   tracked:<key>              — rows appended by this classifier
 *   tracked:light:<canonical>  — named dash lights (any severity)
 *   <hazard>:<matched>         — W3.2 safety rows (braking:…, fumes:…)
 *   warning_light:<light[...]> — W3.2 safety rows for named lights
 */

import { toCanonicalLight, type CanonicalWarningLight } from "./warningLightVocab";

export type DiagnosticSystem =
  | "brakes"
  | "tires_wheels"
  | "engine"
  | "battery_electrical"
  | "not_sure";

export interface TrackedSymptom {
  /** Stable dedupe key — becomes ledger category `tracked:<key>`. */
  key: string;
  /** Short pin label, e.g. "no-start", "brake noise". */
  label: string;
  /** The user's matched words (regex match surface), for booking notes. */
  text: string;
}

interface TrackedRule {
  key: string;
  label: string;
  re: RegExp;
}

/**
 * Non-hazard symptom classes. Anything urgent enough to stop the car is the
 * safety classifier's job (convex/oto/safety.ts) — chat.ts suppresses a
 * tracked row when a hazard row already claimed the same subsystem this turn,
 * so these deliberately include phrasings that ALSO trip hazard rules.
 */
const TRACKED_RULES: readonly TrackedRule[] = [
  {
    key: "no_start",
    label: "no-start",
    re: /\b(?:won'?t|wont|will not|doesn'?t|does not|can'?t|cannot|refuses? to)\s+(?:start|turn\s+over|crank|fire\s+up)\b|\bno[-\s]start\b|\bnot\s+starting\b|\bcranks?\s+but\b|\bjust\s+clicks?\b|\bclicking\b[^.!?\n]{0,30}\b(?:start|ignition|key)\b/i,
  },
  {
    key: "stalling",
    label: "stalling",
    re: /\bstall(?:s|ed|ing)\b|\b(?:dies|died|keeps? dying|cuts?\s+(?:out|off)|shuts?\s+(?:off|down))\b[^.!?\n]{0,35}\b(?:driving|drive|idle|idling|stop(?:s|light)?|light|highway|randomly|while)\b/i,
  },
  {
    key: "brake_noise",
    label: "brake noise",
    re: /\bbrakes?\b[^.!?\n]{0,40}\b(?:squeak\w*|squeal\w*|screech\w*|chirp\w*|nois[ey]\w*)\b|\b(?:squeak\w*|squeal\w*|screech\w*)\b[^.!?\n]{0,30}\b(?:brake|braking|stop(?:ping)?|slow(?:ing)?\s+down)\b/i,
  },
  {
    key: "engine_noise",
    label: "engine noise",
    re: /\b(?:engine|motor)\b[^.!?\n]{0,35}\b(?:knock\w*|tick\w*|rattl\w*|whin\w*|clatter\w*|nois[ey]\w*|loud)\b|\b(?:knock(?:ing)?|ticking|rattling|whining)\b[^.!?\n]{0,30}\b(?:engine|hood|motor)\b/i,
  },
  {
    key: "suspension_noise",
    label: "clunking noise",
    re: /\b(?:clunk\w*|creak\w*|rattl\w*|knock\w*)\b[^.!?\n]{0,35}\b(?:bumps?|potholes?|turn(?:s|ing)?|road|suspension|front\s+end|going\s+over)\b|\bsuspension\b[^.!?\n]{0,30}\b(?:nois[ey]\w*|clunk\w*|creak\w*)\b/i,
  },
  {
    key: "vibration",
    label: "vibration",
    re: /\b(?:vibrat\w+|shak\w+|shudder\w*|wobbl\w+)\b[^.!?\n]{0,40}\b(?:steering|wheel|seat|highway|speeds?|mph|braking|idle)\b|\b(?:car|truck|whole\s+car|it)\s+(?:vibrates?|shakes?|shudders?)\b/i,
  },
  {
    key: "ac_smell",
    label: "AC smell",
    re: /\b(?:a\/?c|air\s*condition\w*|vents?|blower|heater)\b[^.!?\n]{0,35}\b(?:smell\w*|stink\w*|odou?r|musty|moldy|mildew\w*|funky)\b|\b(?:smell\w*|stink\w*|odou?r)\b[^.!?\n]{0,35}\b(?:a\/?c\b|air\s*condition\w*|vents?)\b|\bmusty\b[^.!?\n]{0,25}\b(?:smell|air|car)\b/i,
  },
  {
    key: "fluid_leak",
    label: "fluid leak",
    re: /\b(?:leak(?:s|ing)?|dripping|puddle|spots?)\b[^.!?\n]{0,40}\b(?:oil|coolant|fluid|antifreeze|transmission|underneath|under\s+(?:the\s+|my\s+)?car|driveway|garage\s+floor)\b|\b(?:oil|coolant|fluid|antifreeze)\b[^.!?\n]{0,25}\b(?:leak\w*|dripping|puddle)\b/i,
  },
  {
    key: "battery_weak",
    label: "battery trouble",
    re: /\bbattery\b[^.!?\n]{0,30}\b(?:dead|died|dying|weak|low|won'?t\s+hold|keeps?\s+dying|draining)\b|\b(?:dead|weak)\s+battery\b|\bjump[-\s]?start\w*\b|\bslow\s+crank\w*\b/i,
  },
];

/**
 * Named-light phrases — mirrors convex/oto/safety.ts classifyNamedLights, but
 * with NO severity filter: a steady check-engine or TPMS light ("soon" tier)
 * never reaches the safety ledger, yet is exactly what the pin list is for.
 * chat.ts suppresses the tracked row when the safety path already appended
 * the same light this turn.
 */
const LIGHT_PHRASES: readonly [RegExp, string][] = [
  [/\boil\s*(pressure)?\s*(light|lamp|warning)\b|\blight\b[^.!?\n]{0,20}\boil\b/i, "oil_pressure"],
  [/\b(temp|temperature|coolant)\s*(light|lamp|warning)\b/i, "temperature"],
  [/\b(battery|charging|alternator)\s*(light|lamp|warning)\b/i, "battery_charging"],
  [/\babs\s*(light|lamp|warning)?\b/i, "abs"],
  [/\b(tpms|tire pressure)\s*(light|lamp|warning)?\b/i, "tpms"],
  [/\b(airbag|srs)\s*(light|lamp|warning)?\b/i, "airbag_srs"],
  [/\btransmission\s*(light|lamp|warning)\b/i, "transmission"],
  [/\bcheck\s*engine\s*(light|lamp)?\b|\bengine\s*light\b/i, "check_engine"],
];

const LIGHT_LABEL: Readonly<Record<string, string>> = {
  oil_pressure: "oil light",
  temperature: "temperature light",
  battery_charging: "battery light",
  abs: "ABS light",
  tpms: "tire-pressure light",
  airbag_srs: "airbag light",
  transmission: "transmission light",
  check_engine: "check-engine light",
  not_sure_which: "dash light",
};

/** Scan a user message for trackable (non-hazard-tier) symptoms + named lights. */
export function classifyTrackedSymptoms(message: string): TrackedSymptom[] {
  if (!message) return [];
  const found: TrackedSymptom[] = [];
  for (const rule of TRACKED_RULES) {
    const m = rule.re.exec(message);
    if (m) found.push({ key: rule.key, label: rule.label, text: m[0].slice(0, 80) });
  }
  for (const [re, id] of LIGHT_PHRASES) {
    const m = re.exec(message);
    if (!m) continue;
    const canonical = toCanonicalLight(id);
    if (!canonical) continue;
    const key = `light:${canonical}`;
    if (!found.some((f) => f.key === key)) {
      found.push({
        key,
        label: LIGHT_LABEL[canonical] ?? "dash light",
        text: m[0].slice(0, 80),
      });
    }
  }
  return found;
}

/** Pin-list labels for the W3.2 SAFETY ledger categories (`<hazard>:<matched>`). */
const HAZARD_LABEL: Readonly<Record<string, string>> = {
  fire_smoke: "smoke/burning smell",
  fumes: "fuel/exhaust smell",
  braking: "brake issue",
  steering: "steering issue",
  overheating: "overheating",
  visibility: "wipers/lights out",
  wheel_detachment: "wheel/tire issue",
};

/**
 * Short display label for ANY ledger category. Falls back to the row's own
 * text (truncated) so an unrecognized category still renders something honest.
 */
export function symptomDisplayLabel(category: string, text: string): string {
  if (category.startsWith("tracked:light:")) {
    const light = category.slice("tracked:light:".length);
    return LIGHT_LABEL[light] ?? "dash light";
  }
  if (category.startsWith("tracked:")) {
    const key = category.slice("tracked:".length);
    const rule = TRACKED_RULES.find((r) => r.key === key);
    if (rule) return rule.label;
  }
  if (category.startsWith("warning_light:")) {
    // Safety rows store the canonical light id (or "check_engine:flashing").
    const light = category.slice("warning_light:".length).split(":")[0];
    return LIGHT_LABEL[light] ?? "dash light";
  }
  const prefix = category.split(":")[0];
  if (HAZARD_LABEL[prefix]) return HAZARD_LABEL[prefix];
  const t = text.trim();
  return t.length > 28 ? t.slice(0, 25).trimEnd() + "…" : t || "symptom";
}

export interface SymptomServiceTarget {
  /** serviceTaxonomy slug to pre-check in the booking service picker. */
  slug: string;
  /** Populated iff slug === "diagnostic_scan". */
  system?: DiagnosticSystem;
}

const LIGHT_TARGET: Readonly<Record<string, SymptomServiceTarget>> = {
  check_engine: { slug: "check_engine_light" },
  battery_charging: { slug: "battery_test" },
  oil_pressure: { slug: "diagnostic_scan", system: "engine" },
  temperature: { slug: "diagnostic_scan", system: "engine" },
  transmission: { slug: "diagnostic_scan", system: "engine" },
  abs: { slug: "diagnostic_scan", system: "brakes" },
  tpms: { slug: "diagnostic_scan", system: "tires_wheels" },
  airbag_srs: { slug: "diagnostic_scan", system: "not_sure" },
  not_sure_which: { slug: "diagnostic_scan", system: "not_sure" },
};

const TRACKED_TARGET: Readonly<Record<string, SymptomServiceTarget>> = {
  no_start: { slug: "diagnostic_scan", system: "battery_electrical" },
  stalling: { slug: "diagnostic_scan", system: "engine" },
  brake_noise: { slug: "diagnostic_scan", system: "brakes" },
  engine_noise: { slug: "diagnostic_scan", system: "engine" },
  suspension_noise: { slug: "diagnostic_scan", system: "not_sure" },
  vibration: { slug: "diagnostic_scan", system: "tires_wheels" },
  ac_smell: { slug: "diagnostic_scan", system: "not_sure" },
  fluid_leak: { slug: "diagnostic_scan", system: "engine" },
  battery_weak: { slug: "battery_test" },
};

const HAZARD_TARGET: Readonly<Record<string, SymptomServiceTarget>> = {
  braking: { slug: "diagnostic_scan", system: "brakes" },
  fire_smoke: { slug: "diagnostic_scan", system: "engine" },
  fumes: { slug: "diagnostic_scan", system: "engine" },
  overheating: { slug: "diagnostic_scan", system: "engine" },
  steering: { slug: "diagnostic_scan", system: "not_sure" },
  wheel_detachment: { slug: "diagnostic_scan", system: "tires_wheels" },
  visibility: { slug: "diagnostic_scan", system: "battery_electrical" },
};

/** Which service pre-checks an open symptom of this ledger category. */
export function symptomServiceTarget(category: string): SymptomServiceTarget | null {
  if (category.startsWith("tracked:light:")) {
    return LIGHT_TARGET[category.slice("tracked:light:".length)] ?? null;
  }
  if (category.startsWith("tracked:")) {
    return TRACKED_TARGET[category.slice("tracked:".length)] ?? null;
  }
  if (category.startsWith("warning_light:")) {
    return LIGHT_TARGET[category.slice("warning_light:".length).split(":")[0]] ?? null;
  }
  return HAZARD_TARGET[category.split(":")[0]] ?? null;
}

/**
 * Slugs that already cover a diagnostic system — when the booking already
 * carries one of these, a diagnostic_scan pre-check for the same subsystem is
 * redundant noise, not coverage.
 */
const SYSTEM_COVERED_BY: Readonly<Record<DiagnosticSystem, readonly string[]>> = {
  brakes: ["brake_pad_replacement", "rotor_replacement", "brake_fluid_flush"],
  tires_wheels: ["tire_rotation", "tire_balance", "wheel_alignment", "tire_replacement"],
  battery_electrical: ["battery_test", "battery_replacement"],
  engine: [],
  not_sure: [],
};

/** True when `existingSlugs` already covers what `target` would add. */
export function targetAlreadyCovered(
  target: SymptomServiceTarget,
  existingSlugs: readonly string[],
): boolean {
  if (existingSlugs.includes(target.slug)) return true;
  if (target.slug === "battery_test" && existingSlugs.includes("battery_replacement"))
    return true;
  if (target.slug === "diagnostic_scan" && target.system) {
    return SYSTEM_COVERED_BY[target.system].some((s) => existingSlugs.includes(s));
  }
  return false;
}

/**
 * Trust-gate hard floor (chat.ts §7b', 2026-08-15) — which maintenance-record
 * type an open symptom's ledger category puts in question. STRICT elimination-
 * test pairs ONLY (the render_record_confirmation contradiction test): the
 * recorded service, had it really happened, would have ELIMINATED the
 * symptom. Squeal-after-fresh-pads and slow-crank-after-fresh-battery
 * qualify; a vibration does NOT contest a tire-service record, a TPMS light
 * does NOT contest one either, and a no-start could be a starter — those
 * coexist with a true record and belong to the diagnostic branch. (The first
 * cut of this map included vibration→tires and the §7b' floor hijacked
 * tires_symptom_routes_to_diagnostic_scan turn 1 — narrowness is the point.)
 */
const SYMPTOM_MAINTENANCE_TYPE: Readonly<Record<string, string>> = {
  "tracked:brake_noise": "brakes",
  "tracked:battery_weak": "battery",
};

export function symptomMaintenanceType(category: string): string | null {
  if (SYMPTOM_MAINTENANCE_TYPE[category]) return SYMPTOM_MAINTENANCE_TYPE[category];
  // Hazard-tier brake findings (grinding = friction material gone) contradict
  // a fresh brake-service record the same way squeal does. (§7b' itself never
  // fires on emergency turns; this mapping serves the §7b'' booking rewrite.)
  if (category.split(":")[0] === "braking") return "brakes";
  return null;
}

/**
 * Direct (non-diagnostic) service slugs whose BOOKING asserts the maintenance
 * record of that type is due — booking one against an on_time self_reported
 * record is the trust-gate defect chat.ts §7b' repairs. Routine-cadence slugs
 * (oil_change, tire_rotation) are deliberately absent: booking those on an
 * explicit ask is normal and must never trip the gate.
 */
const DIRECT_SLUG_MAINTENANCE_TYPE: Readonly<Record<string, string>> = {
  brake_pad_replacement: "brakes",
  rotor_replacement: "brakes",
  brake_fluid_flush: "brakes",
  battery_replacement: "battery",
  tire_replacement: "tires",
};

export function directSlugMaintenanceType(slug: string): string | null {
  return DIRECT_SLUG_MAINTENANCE_TYPE[slug] ?? null;
}

/**
 * Did the USER's own message ask for this direct service by name? An explicit
 * ask always wins — the §7b'' diagnostic rewrite must never override "just
 * replace the pads".
 */
const DIRECT_SLUG_USER_ASK: Readonly<Record<string, RegExp>> = {
  brake_pad_replacement: /\bbrake\s*pads?\b|\bpad\s+replacement\b|\breplace\s+(?:the\s+|my\s+)?pads?\b/i,
  rotor_replacement: /\brotors?\b/i,
  brake_fluid_flush: /\bbrake\s+fluid\b/i,
  battery_replacement: /\breplace\s+(?:the\s+|my\s+)?battery\b|\bnew\s+battery\b|\bbattery\s+replacement\b/i,
  tire_replacement: /\bnew\s+tires?\b|\breplace\s+(?:the\s+|my\s+)?tires?\b|\btire\s+replacement\b/i,
};

export function userAskedForDirectService(slug: string, message: string): boolean {
  const re = DIRECT_SLUG_USER_ASK[slug];
  return re ? re.test(message) : false;
}

/**
 * chat.ts overlap suppression: when the safety classifier fired on a hazard
 * this turn, the tracked row for the same subsystem is a duplicate pin.
 * (e.g. "brakes are grinding" → braking hazard row; suppress brake_noise.)
 */
const HAZARD_SUPPRESSES_TRACKED: Readonly<Record<string, readonly string[]>> = {
  braking: ["brake_noise"],
  fire_smoke: ["ac_smell", "engine_noise"],
  fumes: ["ac_smell"],
  overheating: ["stalling"],
  steering: ["vibration"],
  wheel_detachment: ["vibration", "suspension_noise"],
};

export function trackedSuppressedByHazards(
  trackedKey: string,
  hazards: readonly { category: string; matched: string }[],
): boolean {
  for (const h of hazards) {
    // Same named light already appended by the safety path.
    if (h.category === "warning_light" && trackedKey.startsWith("light:")) {
      const light = trackedKey.slice("light:".length);
      if (h.matched.split(":")[0] === light || h.matched.startsWith(light)) return true;
    }
    if ((HAZARD_SUPPRESSES_TRACKED[h.category] ?? []).includes(trackedKey)) return true;
  }
  return false;
}
