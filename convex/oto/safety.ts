/**
 * safety.ts — pre-routing hazard classifier (Wave 2.2, 2026-08-10)
 *
 * WHY THIS EXISTS
 * ---------------
 * Before this file there was NO safety code anywhere in the Oto backend.
 * `grep -i safety` across chat.ts returned two incidental comment hits. Safety
 * existed only as prose in prompt/stable.ts, and it resolved to essentially one
 * rule: the steady-vs-flashing check-engine question. There was no oil-pressure
 * rule, no temperature rule, no brake rule, no smoke/fumes/fire rule.
 *
 * Worse, `stable.ts` is an INTENT-ROUTING ladder (wants-a-service / reports-a-
 * light / mileage / vague-symptom). Safety was a rider on branch 2, not a gate
 * in front of the ladder — so anything that didn't match a branch never met a
 * safety check at all. That is every miss in the Aug-08 QA report:
 *
 *   C1    smoke from under the hood  → explained the cause, never said
 *                                      "don't open the hood"           (D-22)
 *   E2    fuel smell + AC smell      → opened routine triage Q&A
 *   L1    soft brake pedal           → two diagnostic questions, zero
 *                                      safety framing, three turns
 *   p.112 oil-pressure light ON      → "drive to a gas station, check
 *                                      the dipstick" — could seize the engine
 *
 * THE INVERSION THIS FIXES
 * ------------------------
 * The report's unifying finding was "Oto responds to alarm, not to danger" —
 * it escalates when the user SOUNDS worried and matches their tone when they
 * sound calm, regardless of what they described. That is backwards, because the
 * dangerous cases are exactly the ones where the driver doesn't know to worry
 * ("my brake pedal feels kinda soft lately no big deal right").
 *
 * So this classifier is deliberately TONE-BLIND. It keys only on the hazard
 * itself. There is no urgency-word input, no sentiment input, and no model call
 * — it runs before the model so the model cannot talk itself out of it.
 *
 * FALSE-POSITIVE POSTURE
 * ----------------------
 * Asymmetric costs: a false negative is a driver who doesn't get told to stop;
 * a false positive is one extra cautionary sentence. We accept false positives.
 * Patterns still require a hazard DESCRIPTOR rather than a bare noun, so "just
 * got my brakes done, they feel great" does not trip the brake rule.
 *
 * ⚠️ DOMAIN REVIEW PENDING (Q5) — same caveat as WARNING_LIGHT_HAZARD: the
 * mechanism is engineering, the content needs a mechanic's sign-off.
 */

import {
  WARNING_LIGHT_HAZARD,
  mostSevereLight,
  toCanonicalLight,
  type CanonicalWarningLight,
  type WarningLightSeverity,
} from "../../lib/warningLightVocab";

export type HazardCategory =
  | "fire_smoke"
  | "fumes"
  | "braking"
  | "steering"
  | "overheating"
  | "visibility"
  | "wheel_detachment"
  | "warning_light"
  | "medical_injury";

export interface SafetyFinding {
  category: HazardCategory;
  severity: WarningLightSeverity;
  /** Driver-facing imperative — leads the response. */
  action: string;
  /** One clause of plain-language justification. */
  because: string;
  /** The matched surface, for logging/telemetry. Never shown to the user. */
  matched: string;
  /**
   * Optional hands-on step, carried through from the hazard table and rendered
   * as an OFFER the driver can decline. Only ever populated for named lights
   * with a genuinely user-performable task — symptom findings (smoke, a sinking
   * brake pedal) have no safe self-check and never carry one.
   */
  selfCheck?: string;
}

interface HazardRule {
  category: HazardCategory;
  severity: WarningLightSeverity;
  re: RegExp;
  action: string;
  because: string;
}

/**
 * Symptom rules. Each requires a hazard descriptor, not just a noun — the
 * pattern has to describe something WRONG, so ordinary mentions of brakes,
 * smells, or steering don't trip it.
 */
const HAZARD_RULES: readonly HazardRule[] = [
  // ── fire / smoke ────────────────────────────────────────────────────────
  // C1 / D-22. "Don't open the hood" is the specific instruction the report
  // called out as missing: lifting it feeds oxygen to an engine-bay fire.
  {
    category: "fire_smoke",
    severity: "stop_now",
    // 2026-08-14: "burning" removed from the hood/engine proximity alternation
    // — it made "my ENGINE smells like BURNING oil" match this stop_now rule,
    // preempting the tiered burning-smell rules below (the w2 harness caught
    // it). Actual-fire phrasing keeps its own alternative ("engine is
    // burning"); smell phrasing is owned by the tiered rules.
    re: /\b(smoke|smoking|steam|steaming)\b[^.!?\n]{0,30}\b(hood|engine|bonnet|bay|front|dash|vent)|\b(hood|engine|bonnet|dash)\b[^.!?\n]{0,30}\b(smoke|smoking|steam|steaming|on fire|fire|flames?)\b|\b(car|it|something)\b[^.!?\n]{0,15}\b(on fire|caught fire|flames?)\b|\b(car|engine|hood|it)\s+is\s+burning\b|\bsparks?\b[^.!?\n]{0,25}\b(engine|hood|dash|wiring)\b/i,
    action:
      "Pull over now, shut the engine off, and get everyone out and well away from the car. Do NOT open the hood — opening it feeds air to a fire. Call 911 if you see flames.",
    because:
      "an engine-bay fire can go from smoke to fully involved in under a minute, and lifting the hood is what turns one into the other",
  },
  // Burning-smell severities split by substance (2026-08-14, Waleed's catch:
  // "V8s can generate an oil-burning smell without the fire classifier —
  // think like a mechanic"). The original rule mapped EVERY burning smell to
  // stop_now, which told every owner of a chronically-seeping engine (the
  // N63 in the eval M550i is the canonical example: valve-cover seep onto a
  // hot downpipe) to stop driving and tow — an over-trigger that erodes
  // trust in the stop instructions that matter. Published guidance
  // (southjersey.aaa.com "How to Tell if Your Car is Burning Oil";
  // autozone.com/diy/symptoms/why-does-my-car-car-smell-like-burning-oil)
  // treats a burning-OIL smell as find-and-fix-the-leak-soon, with the
  // escalation triggers being visible smoke, heavy dripping, or the
  // oil-pressure light — each of which already has its OWN rule here (the
  // smoke rule above; oil_pressure via the light table). Electrical/melting
  // smells stay stop_now: wiring insulation burning IS a fire precursor.
  // Rule order matters — the oil rule must precede the generic-smell rule
  // ("smells like burning oil" contains "smells like burning"), and the
  // per-category dedupe keeps the first match.
  {
    category: "fire_smoke",
    severity: "stop_now",
    re: /\bburning\s+(wire|wiring|electrical|plastic|insulation)\b|\bsmells?\s+(like\s+)?(electrical|melting|burning plastic|burning wir\w+)\b|\belectrical\s+(burning|smell|odou?r)\b/i,
    action:
      "Pull over safely and shut the engine off. Don't keep driving on it, and don't open the hood if you see any smoke.",
    because:
      "an electrical or melting-plastic smell means wiring insulation is overheating, and that can turn into a fire while you drive",
  },
  {
    // Below the override threshold on purpose ("soon" is filtered out of
    // classifyTurnSafety): a burning-oil smell WITHOUT smoke routes through
    // normal symptom handling — narrowing, the trust gate, the diagnostic
    // booking — where Oto can still say the honest thing about smoke being
    // the stop condition. If there IS smoke, the smoke rule fires instead.
    category: "fire_smoke",
    severity: "soon",
    re: /\bburn(?:ing|t)\s+oil\b|\boil\s+burning\b|\bsmells?\s+(like\s+)?burn(?:ing|t)\s+oil\b/i,
    action:
      "Get the leak found and fixed soon — oil seeping onto hot exhaust parts is the usual cause. If you ever see smoke from the hood or the oil-pressure light comes on, stop driving.",
    because:
      "a burning-oil smell is usually a slow seep onto the exhaust — worth fixing promptly, but the stop-driving triggers are smoke or the oil light, not the smell alone",
  },
  {
    category: "fire_smoke",
    severity: "urgent",
    re: /\bburning\s+(smell|odou?r|rubber)\b|\bsmells?\s+(like\s+)?(burning|something burning)\b/i,
    action:
      "Get it checked promptly — today, not next week. If the smell gets stronger while driving or you see any smoke, pull over and shut the engine off.",
    because:
      "an unidentified burning smell can be a slipping belt, a dragging brake, or something hotter — worth a same-day look, and smoke is the signal to stop immediately",
  },
  // ── fuel / exhaust fumes ────────────────────────────────────────────────
  // E2. Fuel vapour is an ignition risk; exhaust in the cabin is CO poisoning.
  {
    category: "fumes",
    severity: "stop_now",
    re: /\bsmells?\s+(like\s+)?(gas|gasoline|petrol|fuel|raw fuel)\b|\b(gas|gasoline|petrol|fuel)\s+(smell|odou?r|fumes|leak(ing)?)\b/i,
    action:
      "Pull over, shut the engine off, and step away from the car. Don't smoke, don't restart it, and don't use anything that sparks. Have it towed.",
    because:
      "a fuel smell means raw gasoline or vapour is escaping somewhere it shouldn't be, and it only needs one ignition source",
  },
  {
    category: "fumes",
    severity: "stop_now",
    re: /\b(exhaust|fumes|carbon monoxide|co)\b[^.!?\n]{0,30}\b(inside|in the cabin|in the car|coming in)\b|\bsmells?\s+(like\s+)?exhaust\b[^.!?\n]{0,25}\b(inside|cabin|car)\b/i,
    action:
      "Open all the windows now, turn the recirculation off, and pull over as soon as you can. Don't drive it again until it's fixed.",
    because:
      "exhaust entering the cabin means carbon monoxide — it's odourless on its own, causes drowsiness before you notice it, and it kills",
  },
  // ── braking ─────────────────────────────────────────────────────────────
  // L1. The report's canonical "calm user, dangerous symptom" case.
  {
    category: "braking",
    severity: "stop_now",
    // Descriptor list covers the four registers the same hazard gets described
    // in: mechanical ("to the floor", "spongy"), absolute ("gone", "no brakes"),
    // failure verbs ("gave out", "failed"), and negation ("not working",
    // "barely"). The tone-blindness harness caught "brakes are completely gone"
    // slipping through an earlier, narrower list — widen on the side of firing.
    re: /\b(brake|brakes|brake pedal|pedal)\b[^.!?\n]{0,40}\b(to the floor|goes? to the floor|sinks?|spongy|soft|squishy|mushy|nothing|no resistance|not working|barely|hardly|gone|dead|failing|failed|gave out|went out|giving out)\b|\b(no brakes|lost (my |the )?brakes)\b|\b(soft|spongy|squishy|mushy)\b[^.!?\n]{0,20}\bbrake\b/i,
    action:
      "Treat this as unsafe to drive. Get the car somewhere safe and stop using it — have it towed rather than driving it in.",
    because:
      "a soft or sinking brake pedal points at air in the lines, a fluid leak, or a failing master cylinder, and each of those can go from degraded to no brakes without warning",
  },
  {
    category: "braking",
    severity: "urgent",
    re: /\bbrakes?\b[^.!?\n]{0,30}\b(grinding|grind|metal on metal|scraping)\b|\b(grinding|metal on metal)\b[^.!?\n]{0,25}\b(brake|braking|stopping|wheel)\b/i,
    action:
      "Stop driving it beyond getting to a shop, and go now rather than later.",
    because:
      "grinding means the friction material is gone and steel is cutting into the rotor, so stopping distance is already compromised and it gets worse fast",
  },
  // ── steering ────────────────────────────────────────────────────────────
  {
    category: "steering",
    severity: "stop_now",
    re: /\b(steering|steering wheel|wheel)\b[^.!?\n]{0,40}\b(loose|no resistance|not responding|nothing|stiff|locked|hard to turn|won'?t turn|shaking violently|violent)\b|\b(car|it)\b[^.!?\n]{0,20}\b(pulls? hard|veers?|darts?)\b[^.!?\n]{0,20}\b(one side|left|right)\b/i,
    action:
      "Stop driving this. Get it off the road somewhere safe and have it towed.",
    because:
      "steering that's gone loose, stiff, or self-steering points at a failing linkage or suspension component, and those fail suddenly rather than gradually",
  },
  // ── wheel / tire detachment ─────────────────────────────────────────────
  {
    category: "wheel_detachment",
    severity: "stop_now",
    re: /\b(wheel|tire|tyre)\b[^.!?\n]{0,30}\b(wobbl\w+|falling off|coming off|loose|shaking badly)\b|\blug ?nuts?\b[^.!?\n]{0,25}\b(loose|missing|fell)\b|\bblow ?out\b/i,
    action:
      "Slow down gently, avoid braking hard, and pull over as soon as it's safe. Don't drive it further.",
    because:
      "a wobbling wheel or loose lug nuts can separate from the car at speed, and a blowout at speed takes the steering with it",
  },
  // ── overheating (symptom-side; the gauge/light side comes via the light table)
  {
    category: "overheating",
    severity: "stop_now",
    re: /\b(temp|temperature)\s*(gauge|needle)?\b[^.!?\n]{0,25}\b(red|redline|max|all the way up|pegged)\b|\boverheat\w*\b/i,
    action:
      "Pull over and shut the engine off. Let it cool at least 30 minutes before you touch anything, and don't open the radiator cap.",
    because:
      "continuing to drive an overheating engine warps heads and blows gaskets, and the cooling system is pressurised hot enough to scald on opening",
  },
  // ── visibility ──────────────────────────────────────────────────────────
  {
    category: "visibility",
    severity: "urgent",
    re: /\b(wipers?|defroster|defrost|headlights?|head lights?)\b[^.!?\n]{0,30}\b(not working|don'?t work|dead|stopped|out|failed|broken)\b/i,
    action:
      "Don't drive at night or in rain until this is fixed — pull over and wait it out if conditions turn.",
    because:
      "you can't react to what you can't see, and this is the one failure where the danger depends entirely on the weather and the hour",
  },
  // ── personal injury / medical (v0.48, 2026-08-13) ───────────────────────
  // The person is hurt, not the car. medical_redirect at N=10 caught the model
  // emitting burn first-aid ("run it under cool water") 5/10 DESPITE the
  // v0.48 hard prompt rule — a rule that emphatic being violated anyway needs
  // the per-turn injected override, same mechanism as every other hazard.
  // Patterns require a PERSON descriptor (my hand, myself, I'm) so car-part
  // phrasing ("clutch smells burnt", "burning oil") never trips it — those hit
  // the fire/fumes rules instead. renderSafetyOverrideBlock adds a category-
  // specific no-treatment rule line; chat.ts EXCLUDES this category from the
  // open-symptom ledger (a burned hand is not a vehicle symptom to fold into
  // booking notes).
  {
    category: "medical_injury",
    severity: "urgent",
    re: /\b(burn(?:ed|t)?|scald(?:ed)?)\s+(?:my|both|his|her|their)\s+(hands?|arms?|fingers?|wrists?|face|skin|leg)\b|\b(?:I|i)(?:'ve| have| just)?\s*(?:burn(?:ed|t)|scalded|cut|gashed|sliced)\s+(?:myself|my)\b|\bcut\s+(?:my|myself)\b|\b(?:bleeding|blood)\b[^.!?\n]{0,25}\b(?:hand|arm|finger|head|badly|won'?t stop)\b|\b(?:dizzy|light-?headed|nauseous|nauseated|faint|throbbing headache)\b[^.!?\n]{0,40}\b(?:fumes?|exhaust|smell|driving|in the car|garage)\b|\bwhiplash\b|\bhit\s+my\s+head\b|\b(?:I'?m|I am)\s+(?:hurt|injured|in pain|bleeding)\b/i,
    action:
      "Get that looked at by a person, not an app — call 911 if it's serious, otherwise urgent care or your doctor is the right next step.",
    because:
      "I can help with the car side, but I can't give medical advice and it's not something to guess at",
  },
];

/**
 * Scan a user message for hazards, tone-blind. Returns findings ordered most
 * severe first. Multiple categories can match one message (fuel smell AND
 * smoke); all are returned so the override can mention each.
 */
export function classifyMessageHazards(message: string): SafetyFinding[] {
  if (!message) return [];
  const found: SafetyFinding[] = [];
  const seen = new Set<HazardCategory>();
  for (const rule of HAZARD_RULES) {
    const m = rule.re.exec(message);
    if (!m) continue;
    // One finding per category — the first (most severe, given rule order)
    // wins, so a "stop_now" brake rule isn't diluted by the "urgent" one.
    if (seen.has(rule.category)) continue;
    seen.add(rule.category);
    found.push({
      category: rule.category,
      severity: rule.severity,
      action: rule.action,
      because: rule.because,
      matched: m[0].slice(0, 60),
    });
  }
  return found.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}

function severityRank(s: WarningLightSeverity): number {
  return s === "stop_now" ? 3 : s === "urgent" ? 2 : s === "soon" ? 1 : 0;
}

/**
 * Hazard findings for warning lights the user names in this message. Reads the
 * shared hazard table so Oto, the Cars tracker, and the health score can never
 * disagree about what a light means.
 */
export function classifyNamedLights(message: string): SafetyFinding[] {
  if (!message) return [];
  const lights: CanonicalWarningLight[] = [];
  // Phrase → canonical id. Deliberately narrow: the user has to be talking
  // about a LIGHT, not just the subsystem.
  const LIGHT_PHRASES: [RegExp, string][] = [
    [/\boil\s*(pressure)?\s*(light|lamp|warning)\b|\blight\b[^.!?\n]{0,20}\boil\b/i, "oil_pressure"],
    [/\b(temp|temperature|coolant)\s*(light|lamp|warning)\b/i, "temperature"],
    [/\b(battery|charging|alternator)\s*(light|lamp|warning)\b/i, "battery_charging"],
    [/\babs\s*(light|lamp|warning)?\b/i, "abs"],
    [/\b(tpms|tire pressure)\s*(light|lamp|warning)?\b/i, "tpms"],
    [/\b(airbag|srs)\s*(light|lamp|warning)?\b/i, "airbag_srs"],
    [/\btransmission\s*(light|lamp|warning)\b/i, "transmission"],
    [/\bcheck\s*engine\s*(light|lamp)?\b|\bengine\s*light\b/i, "check_engine"],
  ];
  for (const [re, id] of LIGHT_PHRASES) {
    if (re.test(message)) {
      const canonical = toCanonicalLight(id);
      if (canonical && !lights.includes(canonical)) lights.push(canonical);
    }
  }
  if (lights.length === 0) return [];

  // Flashing check-engine is a stop-driving case, but the canonical vocabulary
  // has no flashing variant — `check_engine` is one id carrying both meanings,
  // and the hazard table is keyed by id alone, so it is tiered for the steady
  // case (`soon`) and gets filtered out of the override entirely. Without this
  // branch, "my check engine light is flashing" produced NO safety escalation
  // for an active misfire that can destroy a catalytic converter in one drive.
  // Escalate here, where the raw wording is still available.
  if (
    lights.includes("check_engine" as CanonicalWarningLight) &&
    /\b(flash|flashing|flashes|blink|blinking|blinks|pulsing|strobing)\b/i.test(message)
  ) {
    return [
      {
        category: "warning_light",
        severity: "stop_now",
        action:
          "Stop driving — pull over somewhere safe and have it towed rather than driving it in.",
        because:
          "a flashing check-engine light means the engine is actively misfiring and dumping raw fuel into the catalytic converter, which can wreck an expensive part in a short drive",
        matched: "check_engine:flashing",
      },
    ];
  }

  const worst = mostSevereLight(lights);
  if (!worst) return [];
  // Only surface the single most severe light — stacking four light warnings
  // in one turn is the D-13 "stacked cards during an emergency" failure.
  const hazard = WARNING_LIGHT_HAZARD[worst.light];
  return [
    {
      category: "warning_light",
      severity: hazard.severity,
      action: hazard.action,
      because: hazard.because,
      matched: worst.light,
      ...(hazard.selfCheck ? { selfCheck: hazard.selfCheck } : {}),
    },
  ];
}

/**
 * Full per-turn safety pass. Combines symptom hazards and named-light hazards,
 * dropping anything below `urgent` — "soon" and "informational" findings are
 * ordinary conversation and don't warrant overriding the intent ladder.
 */
export function classifyTurnSafety(message: string): SafetyFinding[] {
  const all = [...classifyMessageHazards(message), ...classifyNamedLights(message)];
  return all
    .filter((f) => f.severity === "stop_now" || f.severity === "urgent")
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}

/**
 * Render the envelope block. Modeled on `<polite_exit_required>` — a named
 * block carrying a mandatory instruction, injected before the model call so it
 * arrives as context rather than as something the model chose.
 *
 * The instruction deliberately does two things beyond stating the hazard:
 *  1. Orders the response — safety FIRST, before any diagnosis or clarifying
 *     question. The report's L1 failure was accurate information delivered in
 *     the wrong order (two triage questions, then nothing).
 *  2. Bans tone-matching. The whole point of a tone-blind classifier is lost if
 *     the model then softens the instruction to match a calm user.
 */
export function renderSafetyOverrideBlock(findings: SafetyFinding[]): string | null {
  if (findings.length === 0) return null;
  const worst = findings[0];
  const lines = [
    `<safety_override>`,
    `  severity: ${worst.severity}`,
    `  detected: ${findings.map((f) => f.category).join(", ")}`,
  ];
  for (const f of findings) {
    lines.push(`  hazard:`);
    lines.push(`    category: ${f.category}`);
    lines.push(`    instruction: ${f.action}`);
    lines.push(`    reason: ${f.because}`);
    if (f.selfCheck) lines.push(`    optional_self_check: ${f.selfCheck}`);
  }
  lines.push(
    `  rule: The user has described something physically dangerous. Lead your response with the instruction above, in your own words, in the FIRST sentence — before any diagnosis, clarifying question, booking offer, or record update. State the reason once, plainly. Do NOT soften this because the user sounds calm, casual, or dismissive; a driver who does not know to be worried is exactly who this is for, and matching their tone here is the failure mode. Do NOT ask a clarifying question before the instruction. After the instruction you may continue normally — offer the booking, ask what they need — but the instruction comes first.`,
  );
  if (findings.some((f) => f.selfCheck)) {
    lines.push(
      `  self_check_rule: Where optional_self_check is present, offer it AFTER the instruction and only as a choice the user can decline without friction. Never phrase it as a step they will take: not "pop the hood and check the dipstick", but "if you want to check it yourself, I'll walk you through it — otherwise let's get you towed." Published roadside advice assumes a driver who can already do these things; you have no idea whether this one can, and someone who cannot will not say so — they will guess, and a wrong guess here reads as reassurance. If the user declines, ignores the offer, says they are not sure, or asks you to decide, take the safe option immediately and without making them justify it. A self-check NEVER produces an all-clear on its own: "it looked fine" does NOT clear this — only a concrete positive result does, such as the level being visibly low, topped up, and the light then going out, and even then the visit still gets booked. Do not ask about their mechanical experience or their knowledge level to decide whether to offer it — offer it the same way to everyone and let them choose.`,
    );
  }
  if (worst.severity === "stop_now") {
    lines.push(
      `  do_not_render: Do NOT call render_vehicle_update on this turn. Logging a fault to the vehicle record is not the response to an active hazard, and a confirmation card competing with a stop-driving instruction buries it.`,
    );
  }
  if (findings.some((f) => f.category === "medical_injury")) {
    lines.push(
      `  medical_rule: The user is HURT. The instruction above (get medical help) is the COMPLETE medical content of your reply. Give NO treatment or first-aid advice of any kind — not what to run it under, put on it, or take, not how serious it looks, and not as a helpful extra alongside the redirect. You are a car app; the redirect IS the help. After the redirect, handle any car-side question normally.`,
    );
  }
  lines.push(`</safety_override>`);
  return lines.join("\n");
}
