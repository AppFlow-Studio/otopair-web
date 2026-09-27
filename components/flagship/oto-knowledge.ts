/**
 * Content for the two explanation surfaces Oto gained on 2026-09-07:
 * a service card and a symptom card.
 *
 * Why these two: the diagnostic of 305 live conversations found Oto could
 * explain the PRODUCT fourteen different ways and could not explain a CAR at
 * all. "What is a brake fluid flush and do I actually need one" — the question
 * people actually arrive with — had no visual answer, only the generic info
 * card. These give it one.
 *
 * Rules the copy here follows, because the site's copy locks apply to anything
 * Oto can put on screen:
 *   · No prices, no ranges, ever. Not even "usually cheap".
 *   · No promise about how long a job takes at a specific shop.
 *   · Each service says what the site's own service page says (2026-09-14
 *     audit): the catalog description in lib/service-catalog.ts, which cars it
 *     applies to, and the page's "When do I need it?" cue. Intervals are always
 *     deferred to the car's own schedule, which the app checks.
 *   · A warning light is never mapped to one service with certainty — a light
 *     names a system, and the shop confirms the cause.
 *   · Safety-critical systems always end at "get it inspected before you drive
 *     it again", matching the agent prompt's own guardrail. `safety: true`
 *     renders that line.
 *   · Danger first: a hazard's safe first step (`firstStep`) leads the symptom
 *     card, before any possibility is named.
 *   · Nothing here diagnoses. Causes are possibilities, in plain language.
 *   · US spelling throughout.
 *
 * scripts/setup-oto-agent.mjs reads the service names and symptom ids out of
 * this file for the agent's tool enums, matching 4-space-indented `service:`
 * and `id:` lines inside the two arrays below — keep that format.
 */

/** Service names MUST match SERVICE_CATALOG in oto-flow.ts exactly — the tool
 *  enum is generated from those names, and a mismatch means a silent miss. */
export interface ServiceExplainer {
  service: string;
  category: string;
  /** One line: what it actually is. */
  what: string;
  /** What happens at the shop — the thing nobody explains. */
  shop: string[];
  /** Why it matters / what skipping it leads to. */
  why: string;
  /** How you know it is time. Hedged, and deferred to the car's own schedule. */
  due: string;
  /** Load-bearing systems: adds the inspection line. */
  safety?: boolean;
}

export const SERVICE_EXPLAINERS: ServiceExplainer[] = [
  // ---- Routine ----
  {
    service: "Oil Change",
    category: "Routine",
    what: "Replacing the engine oil and filter, with oil to the specification your engine's maker sets. Gas and hybrid engines only.",
    shop: ["Lift the car and drain the old oil", "Replace the oil filter", "Refill with the specified grade and quantity", "Check for leaks and reset the service light"],
    why: "Oil stops metal touching metal. Old oil stops doing that, and engines are the expensive part.",
    due: "When your car's service schedule calls for it. If the oil pressure light comes on, that's different: pull over, shut the engine off and have it checked.",
  },
  {
    service: "Filter Replacement",
    category: "Routine",
    what: "Replacing the engine air filter and the cabin air filter.",
    shop: ["Replace the engine air filter", "Replace the cabin air filter", "Confirm each housing seals properly"],
    why: "A choked air filter makes the engine work harder; a dirty cabin filter is what you are breathing.",
    due: "When your car's maintenance schedule calls for it — these are interval items, not symptom items.",
  },
  {
    service: "Battery Replacement",
    category: "Routine",
    what: "Fitting a new battery matched to your car's group size and cold-cranking amps (CCA) rating.",
    shop: ["Confirm the battery, not the charging system, is the problem", "Fit the correct group size and CCA rating", "Clean the terminals and confirm the alternator is charging"],
    why: "A weak battery usually gives one warning, then strands you somewhere inconvenient.",
    due: "When a Battery Test says the battery is done. A battery light or slow starting is the cue to test it first — the cause can also be the charging system.",
  },

  // ---- Tires & Brakes ----
  {
    service: "Tire Rotation",
    category: "Tires & Brakes",
    what: "Moving each tire to a different corner so they wear evenly and last longer.",
    shop: ["Lift the car and move the tires in the pattern your drivetrain needs", "Check tread depth at each corner", "Reset the pressures"],
    why: "Fronts and rears wear at different rates. Rotating means you replace four tires at once instead of two, twice.",
    due: "When your car's schedule calls for it. Only offered where the car's tire setup allows rotation.",
    safety: true,
  },
  {
    service: "Tire Balance",
    category: "Tires & Brakes",
    what: "Balancing all four wheels so they spin without wobbling.",
    shop: ["Spin each wheel on a balancer to find the heavy spot", "Add corrective weights", "Re-spin to confirm it runs true"],
    why: "An unbalanced wheel shakes the steering at speed and chews the tire unevenly.",
    due: "When you feel vibration through the wheel or seat at speed, and whenever new tires go on.",
    safety: true,
  },
  {
    service: "Wheel Alignment",
    category: "Tires & Brakes",
    what: "Adjusting the wheel angles back to the manufacturer's specification.",
    shop: ["Put the car on an alignment rack and measure the current angles", "Adjust toe, and camber and caster where they are adjustable", "Road-test that it tracks straight"],
    why: "Bad alignment scrubs a tire flat on one edge and pulls the car to one side.",
    due: "When the car pulls to one side or the steering wheel sits off-center, after a hard pothole or curb hit, with new tires, and on schedule.",
    safety: true,
  },
  {
    service: "Tire Replacement",
    category: "Tires & Brakes",
    what: "Mounting and balancing new tires to your car's OEM size specification.",
    shop: ["Remove the old tires and inspect the wheels", "Mount and balance the new ones", "Set the pressures and reset the sensors"],
    why: "Tread is what stops you in the rain. Below the wear bars, wet braking falls off sharply.",
    due: "When a tire is worn to its wear bars, damaged or aged. On Otopair it's a quote request: shops quote the exact tire for your car, and nothing is booked until you accept one.",
    safety: true,
  },
  {
    service: "Brake Pad Replacement",
    category: "Tires & Brakes",
    what: "Replacing the front and/or rear brake pads with OEM parts — the shop confirms which axle after inspecting.",
    shop: ["Remove the wheels and inspect pads, rotors and calipers", "Fit new pads and free off the caliper slides", "Bed the brakes in on a road test"],
    why: "Pads are a wear item. Run them to the backing plate and you are replacing rotors too.",
    due: "Squealing is often the built-in wear indicator doing its job. Grinding means it has gone further — get it inspected before you drive it again.",
    safety: true,
  },
  {
    service: "Rotor Replacement",
    category: "Tires & Brakes",
    what: "Replacing the brake rotors — the discs the pads clamp onto — together with the pads, on the front and/or rear axle.",
    shop: ["Measure rotor thickness and check for warping", "Replace the rotors in pairs across an axle", "Fit fresh pads and bed everything in"],
    why: "Worn or warped rotors pulse through the pedal and lengthen how far you take to stop.",
    due: "When braking pulses, or the pads have worn into the rotors — judged on thickness and runout.",
    safety: true,
  },
  {
    service: "Brake Fluid Flush",
    category: "Tires & Brakes",
    what: "A full flush and bleed of the brake fluid at all four corners.",
    shop: ["Test the fluid's moisture content and boiling point", "Bleed old fluid through every corner until it runs clean", "Confirm a firm pedal"],
    why: "Brake fluid absorbs water from the air over time. Wet fluid boils under hard braking, and boiled fluid means a soft pedal exactly when you need it.",
    due: "When your car's schedule calls for it — brake fluid ages whether you drive or not. A soft pedal or a brake warning light means get it inspected before you drive it again.",
    safety: true,
  },

  // ---- Scheduled Service ----
  {
    service: "Spark Plugs",
    category: "Scheduled Service",
    what: "Replacing the spark plugs with plugs to your engine's specification. Gas and hybrid engines only.",
    shop: ["Remove the coils and old plugs", "Fit new plugs at the specified gap and torque", "Check for misfire codes afterwards"],
    why: "Worn plugs misfire, which costs fuel economy and can damage the catalytic converter.",
    due: "When your car's service schedule calls for it — the interval varies a lot by plug type.",
  },
  {
    service: "Drive Belt",
    category: "Scheduled Service",
    what: "Replacing the drive belt kit — the belt, tensioner and idler pulleys — on engines that have a belt rather than a chain.",
    shop: ["Strip the front of the engine to reach the belt", "Replace the belt, tensioner and idler pulleys", "Re-time the engine precisely and verify"],
    why: "On many engines a snapped belt means the valves and pistons meet. That is an engine rebuild, not a repair.",
    due: "Strictly on your car's schedule — it's an interval item, not a symptom item. Only belt-driven engines have one.",
  },
  {
    service: "Coolant Flush",
    category: "Scheduled Service",
    what: "Flushing the whole cooling system and refilling it with the coolant your car specifies.",
    shop: ["Drain the old coolant and flush the system", "Refill with the correct specification", "Bleed the air out and pressure-test for leaks"],
    why: "Coolant is also corrosion protection. Spent coolant lets the inside of the engine rust.",
    due: "When your car's schedule calls for a cooling-system service. If the temperature gauge climbs, pull over first — the cause needs finding before anything else.",
  },
  {
    service: "Transmission Service",
    category: "Scheduled Service",
    what: "A drain-and-fill of the transmission fluid, with the fluid your car's maker specifies.",
    shop: ["Drain the old fluid", "Refill to the correct level with the specified fluid", "Check for leaks and correct shift behavior"],
    why: "Transmission fluid is a hydraulic and a lubricant. Tired fluid shifts badly and wears the internals.",
    due: "Your car's schedule decides this one — some transmissions are sealed. A transmission warning light means stop driving and have it checked first.",
  },
  {
    service: "Power Steering Flush",
    category: "Scheduled Service",
    what: "Flushing and replacing the hydraulic fluid in the power steering system.",
    shop: ["Extract the old fluid from the reservoir and lines", "Refill with the specified fluid", "Cycle the steering to purge air"],
    why: "Dirty fluid wears the pump and rack, which are the expensive parts of steering.",
    due: "When your car's schedule calls for it, and only with hydraulic power steering — most newer cars steer electrically and have no fluid to flush.",
    safety: true,
  },
  {
    service: "Differential Service",
    category: "Scheduled Service",
    what: "Draining and refilling the differential and transfer case fluid, on AWD and RWD cars with a separate differential.",
    shop: ["Drain the old gear oil and inspect it for metal", "Refill to the correct level and specification", "Check the seals"],
    why: "Gear oil takes a beating. Metal in the old oil is an early warning worth catching.",
    due: "When your car's schedule calls for it. A front-wheel-drive car's final drive shares the transmission fluid, so there's nothing separate to service.",
  },
  {
    service: "Fuel System Cleaning",
    category: "Scheduled Service",
    what: "Cleaning the fuel injectors and intake valves to restore performance. Gas and hybrid engines only.",
    shop: ["Check how the engine is running", "Clean the fuel injectors and intake valves", "Confirm the idle and fuel trims afterwards"],
    why: "Deposits make an engine idle roughly and lose economy.",
    due: "When your car's schedule calls for it, or when performance has fallen off.",
  },

  // ---- Inspections ----
  {
    service: "Diagnostic Scan",
    category: "Inspections",
    what: "An OBD-II scan that reads — and clears — the trouble codes your car has stored. For 1996 and newer cars.",
    shop: ["Connect a scanner to the car's OBD-II port", "Read the stored trouble codes", "Clear them, so the next step is a decision rather than a guess"],
    why: "A code names the circuit that complained, not the part to replace. Finding the root cause is what Check Engine Light Diagnosis does.",
    due: "When a warning light is on and you want to know what the car is reporting before committing to a repair.",
  },
  {
    service: "Check Engine Light Diagnosis",
    category: "Inspections",
    what: "Going past the code to the root cause of a check engine light, so you know what to book next. The repair itself is approved separately. For 1996 and newer cars.",
    shop: ["Read the stored code and its freeze-frame data", "Test the parts that code implicates", "Confirm the cause before replacing anything"],
    why: "The same code can come from several causes. Testing is what separates a fix from a parts-swap.",
    due: "When the check engine light comes on. If it's flashing, stop driving and have the car towed rather than driving it in.",
  },
  {
    service: "State Inspection",
    category: "Inspections",
    what: "New York's annual state safety inspection certification — done only at shops licensed by the NY DMV as inspection stations.",
    shop: ["Check brakes, steering, suspension, lights, tires and glass", "Check the seat belts and the horn", "Issue the sticker if it passes"],
    why: "It is required to keep the car on the road legally.",
    due: "Once a year — book it before the expiry month on your current sticker ends.",
  },
  {
    service: "Emissions Test",
    category: "Inspections",
    what: "New York's state-required emissions compliance test — for gas and hybrid engines, at NY DMV-licensed inspection stations only.",
    shop: ["Check the readiness monitors are complete", "Confirm no emissions-related codes are stored", "Record the result"],
    why: "It's a state compliance check, needed where New York requires it for your registration.",
    due: "When New York requires it for your registration. A recently cleared computer can fail on readiness alone.",
  },
  {
    service: "Battery Test",
    category: "Inspections",
    what: "A load test of the battery, plus a check of the charging system.",
    shop: ["Load-test the battery", "Measure the alternator's output", "Check for a parasitic drain if the battery keeps dying"],
    why: "A battery that keeps going flat is often a charging fault, not a battery fault.",
    due: "When the battery light comes on, when the car is slow to start, before paying to replace a battery, and before winter.",
  },
];

export const SERVICE_NAMES = SERVICE_EXPLAINERS.map((s) => s.service);

/** The labels the app's own screens (and the site's app mockups) use for some
 *  services, mapped to the catalog name, so an agent or visitor saying "tire
 *  balancing" or "oil & filter change" lands on the right card instead of a
 *  loose word match ("Oil & Filter Service" used to resolve to Transmission
 *  Service). Kept outside SERVICE_EXPLAINERS on purpose. */
export const SERVICE_ALIASES: Record<string, string> = {
  "oil & filter change": "Oil Change",
  "oil and filter change": "Oil Change",
  "oil & filter service": "Oil Change",
  "oil and filter service": "Oil Change",
  "air & cabin filters": "Filter Replacement",
  "air and cabin filters": "Filter Replacement",
  "tire balancing": "Tire Balance",
  "brake rotor replacement": "Rotor Replacement",
  "rotor resurfacing": "Rotor Replacement",
  "spark plug replacement": "Spark Plugs",
  "timing belt replacement": "Drive Belt",
  "timing belt": "Drive Belt",
  "drive belt replacement": "Drive Belt",
  "drive belt": "Drive Belt",
  "transmission fluid change": "Transmission Service",
  "differential fluid change": "Differential Service",
  "check-engine light diagnosis": "Check Engine Light Diagnosis",
  "check engine light": "Check Engine Light Diagnosis",
};

/** Resolve a service by exact name, then by an app-screen alias, then
 *  loosely, so the agent's phrasing ("brake pads", "oil") still lands on the
 *  right card. */
export function findService(q: string): ServiceExplainer | null {
  const t = (q ?? "").trim().toLowerCase();
  if (!t) return null;
  const exact = SERVICE_EXPLAINERS.find((s) => s.service.toLowerCase() === t);
  if (exact) return exact;
  const alias = SERVICE_ALIASES[t];
  if (alias) {
    const aliased = SERVICE_EXPLAINERS.find((s) => s.service === alias);
    if (aliased) return aliased;
  }
  const contains = SERVICE_EXPLAINERS.find(
    (s) => s.service.toLowerCase().includes(t) || t.includes(s.service.toLowerCase())
  );
  if (contains) return contains;
  const words = t.split(/\s+/).filter((w) => w.length > 3);
  let best: { s: ServiceExplainer; n: number } | null = null;
  for (const s of SERVICE_EXPLAINERS) {
    const hay = `${s.service} ${s.what}`.toLowerCase();
    const n = words.filter((w) => hay.includes(w)).length;
    if (n && (!best || n > best.n)) best = { s, n };
  }
  return best?.s ?? null;
}

/* ------------------------------------------------------------------ */
/* Symptoms — the question people actually arrive with.                */
/* ------------------------------------------------------------------ */

export type Urgency = "now" | "soon" | "watch";

export interface SymptomExplainer {
  id: string;
  symptom: string;
  /** Plain-language possibilities. NEVER a diagnosis — the card says so. */
  couldBe: string[];
  urgency: Urgency;
  /** What a mechanic actually checks, so the visit is not a black box. */
  checks: string[];
  /** Catalog services this can lead to, for the follow-on card. Possibilities,
   *  never "this light means that service". */
  services?: string[];
  safety?: boolean;
  /** Hazards only: the safe first step, shown first on the card. */
  firstStep?: string;
}

export const URGENCY_COPY: Record<Urgency, { label: string; line: string }> = {
  now: { label: "Get it looked at now", line: "Don't put this one off — get it inspected before you drive it again." },
  soon: { label: "Book it soon", line: "Not an emergency, but worth booking rather than leaving." },
  watch: { label: "Worth mentioning", line: "Keep an eye on it and mention it at your next visit." },
};

export const SYMPTOMS: SymptomExplainer[] = [
  {
    id: "brake_squeal",
    symptom: "Squealing when you brake",
    couldBe: ["Worn pads — many have a metal tab that squeals on purpose", "Glazed or dusty pads and rotors", "Surface rust after rain, which clears in a few stops"],
    urgency: "soon",
    checks: ["Pad thickness at all four corners", "Rotor surface and thickness", "Whether the calipers are sliding freely"],
    services: ["Brake Pad Replacement", "Rotor Replacement"],
    safety: true,
  },
  {
    id: "brake_grinding",
    symptom: "Grinding when you brake",
    couldBe: ["Pads worn through to the backing plate", "Something caught between pad and rotor", "A seized caliper"],
    urgency: "now",
    checks: ["Whether any pad material is left", "Rotor damage", "Caliper and slide condition"],
    services: ["Brake Pad Replacement", "Rotor Replacement"],
    safety: true,
  },
  {
    id: "steering_shake",
    symptom: "Shaking through the steering wheel",
    couldBe: ["Wheels out of balance, if it comes on at speed", "Warped rotors, if it happens under braking", "A worn suspension or steering component"],
    urgency: "soon",
    checks: ["Wheel balance and tire condition", "Rotor runout", "Play in the tie rods, ball joints and bearings"],
    services: ["Tire Balance", "Rotor Replacement", "Wheel Alignment"],
    safety: true,
  },
  {
    id: "rattle_underneath",
    symptom: "Rattling from underneath",
    couldBe: ["A loose or corroded exhaust heat shield — a common cause", "Worn sway bar links", "A loose exhaust hanger"],
    urgency: "soon",
    checks: ["Everything under the car, by hand, on a lift", "Exhaust mounts and shields", "Suspension bushings and links"],
    safety: true,
  },
  {
    id: "check_engine",
    symptom: "Check engine light",
    couldBe: ["Anything from a loose fuel cap to a sensor to a real fault", "The code names the circuit that complained, not the part to replace"],
    urgency: "soon",
    checks: ["Stored codes and the freeze-frame from when it triggered", "Live data from the parts that code implicates", "Whether it is a current fault or a stored history"],
    services: ["Check Engine Light Diagnosis", "Diagnostic Scan"],
  },
  {
    id: "check_engine_flashing",
    symptom: "Check engine light flashing",
    couldBe: ["An active misfire, which can damage the catalytic converter quickly"],
    urgency: "now",
    checks: ["Which cylinder is misfiring", "Coils, plugs and injectors on that cylinder", "Whether the converter has already been affected"],
    services: ["Check Engine Light Diagnosis"],
    safety: true,
    firstStep: "Stop driving and have the car towed rather than driving it in.",
  },
  {
    id: "oil_pressure_light",
    symptom: "Oil pressure light",
    couldBe: ["Low engine oil, or a leak", "A failing oil pump", "A faulty pressure sensor or its wiring"],
    urgency: "now",
    checks: ["Oil level and condition", "Oil pressure measured with a gauge, not just the light", "The sensor and its wiring"],
    services: ["Oil Change"],
    firstStep: "Pull over as soon as it's safe and shut the engine off — don't drive it any further.",
  },
  {
    id: "brake_warning_light",
    symptom: "ABS or brake light",
    couldBe: ["Low brake fluid, or a leak", "Worn brake pads", "The parking brake still on, or a faulty switch", "An ABS sensor fault, if it's the amber ABS light"],
    urgency: "now",
    checks: ["Brake fluid level and any leaks", "Pad thickness at every corner", "Stored ABS codes and the wheel-speed sensors"],
    services: ["Brake Fluid Flush", "Brake Pad Replacement", "Rotor Replacement"],
    safety: true,
    firstStep: "Red brake light: stop somewhere safe and have the car towed. Amber ABS light: get it inspected before you drive it again.",
  },
  {
    id: "battery_light",
    symptom: "Battery or charging light on",
    couldBe: ["The alternator not charging", "A battery at the end of its life", "A loose or corroded connection"],
    urgency: "soon",
    checks: ["The battery under load", "The alternator's output", "Terminals, cables and the drive belt"],
    services: ["Battery Test", "Battery Replacement"],
    firstStep: "If a shop is close, drive straight there and keep the engine running until you arrive — it may not restart.",
  },
  {
    id: "transmission_warning",
    symptom: "Transmission light",
    couldBe: ["Fluid low or running hot", "A sensor or solenoid fault", "A stored transmission fault"],
    urgency: "now",
    checks: ["Fluid level and condition", "Stored transmission codes", "Shift behavior once it's safe to test"],
    services: ["Diagnostic Scan", "Transmission Service"],
    firstStep: "Stop driving and have the car towed rather than driving it in.",
  },
  {
    id: "tpms_light",
    symptom: "Tire pressure (TPMS) light on",
    couldBe: ["A tire below its proper pressure — a cold morning can do it", "A slow leak or a puncture", "A faulty pressure sensor"],
    urgency: "soon",
    checks: ["The pressure in every tire", "Each tire for a nail, a cut or a leaking valve", "The pressure sensors"],
    safety: true,
    firstStep: "Drive gently to the nearest air pump and check the pressures. Pull over sooner if the car pulls, vibrates or a tire looks flat.",
  },
  {
    id: "airbag_light",
    symptom: "Airbag (SRS) light",
    couldBe: ["A fault in an airbag or seat belt pretensioner circuit", "A connector under a seat disturbed", "A faulty crash or occupant sensor"],
    urgency: "now",
    checks: ["Stored airbag system codes", "The connectors and wiring under the seats and in the steering column", "The crash and occupant sensors"],
    safety: true,
    firstStep: "Assume the airbags may not deploy until it's fixed, and get it inspected before you drive it again.",
  },
  {
    id: "hard_start",
    symptom: "Slow or hard starting",
    couldBe: ["A battery near the end of its life", "The charging system not keeping up", "A parasitic drain flattening it overnight"],
    urgency: "soon",
    checks: ["Battery under load", "Alternator output", "Current draw with everything switched off"],
    services: ["Battery Test", "Battery Replacement"],
  },
  {
    id: "overheating",
    // Covers both a climbing temperature gauge and the temperature warning
    // light; the title stays short enough to fit beside the urgency pill.
    symptom: "Engine running hot",
    couldBe: ["Low coolant or a leak, which can send the temperature gauge up or turn its light on", "A failed thermostat", "A cooling fan not running"],
    urgency: "now",
    checks: ["Coolant level and a pressure test for leaks", "Thermostat operation", "Fan operation and the radiator itself"],
    services: ["Coolant Flush"],
    safety: true,
    firstStep: "Pull over, shut the engine off and let it cool. Don't open the radiator cap or the coolant tank.",
  },
  {
    id: "pulling",
    symptom: "Pulling to one side",
    couldBe: ["Alignment out of specification", "Uneven tire pressures or wear", "A brake dragging on one side"],
    urgency: "soon",
    checks: ["Alignment angles on a rack", "Tire pressures and wear pattern", "Whether one brake is binding"],
    services: ["Wheel Alignment", "Tire Rotation"],
    safety: true,
  },
  {
    id: "soft_pedal",
    symptom: "Brake pedal feels soft or sinks",
    couldBe: ["Air or moisture in the brake fluid", "A leak somewhere in the system", "A failing master cylinder"],
    urgency: "now",
    checks: ["Fluid level, condition and boiling point", "Every line and caliper for leaks", "Master cylinder function"],
    services: ["Brake Fluid Flush"],
    safety: true,
    firstStep: "Treat the car as unsafe to drive: get somewhere safe, stop, and have it towed rather than driving it in.",
  },
];

export function findSymptom(q: string): SymptomExplainer | null {
  const t = (q ?? "").trim().toLowerCase();
  if (!t) return null;
  const byId = SYMPTOMS.find((s) => s.id === t);
  if (byId) return byId;
  const words = t.split(/\s+/).filter((w) => w.length > 2);
  let best: { s: SymptomExplainer; n: number } | null = null;
  for (const s of SYMPTOMS) {
    const hay = `${s.id} ${s.symptom} ${s.couldBe.join(" ")}`.toLowerCase();
    const n = words.filter((w) => hay.includes(w)).length;
    if (n && (!best || n > best.n)) best = { s, n };
  }
  return best?.s ?? null;
}
