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
 *   · Intervals are general manufacturer practice, always hedged, and always
 *     deferred to the car's own schedule — which Oto has once it has the VIN.
 *     That deferral is not a dodge; it is also the reason to give a VIN.
 *   · Safety-critical systems always end at "get it inspected", matching the
 *     agent prompt's own guardrail. `safety: true` renders that line.
 *   · Nothing here diagnoses. Causes are possibilities, in plain language.
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
    what: "Draining the old engine oil and filter and replacing both with the grade your engine was built for.",
    shop: ["Lift the car and drain the old oil", "Replace the oil filter", "Refill with the specified grade and quantity", "Check for leaks and reset the service light"],
    why: "Oil stops metal touching metal. Old oil stops doing that, and engines are the expensive part.",
    due: "On the interval in your car's own schedule — modern engines often go far longer than the old rule of thumb.",
  },
  {
    service: "Filter Replacement",
    category: "Routine",
    what: "Swapping the filters that keep dirt out of the engine and the cabin air.",
    shop: ["Check the engine air filter and the cabin filter", "Replace whichever is dirty", "Confirm the housing seals properly"],
    why: "A choked air filter makes the engine work harder; a dirty cabin filter is what you are breathing.",
    due: "Usually judged by how they look rather than by mileage alone.",
  },
  {
    service: "Battery Replacement",
    category: "Routine",
    what: "Testing the battery under load and fitting a new one if it no longer holds charge.",
    shop: ["Load-test the battery and check the charging system", "Fit the correct group size and type", "Clean the terminals and confirm the alternator is charging"],
    why: "A weak battery usually gives one warning, then strands you somewhere inconvenient.",
    due: "Most batteries give a few years. Slow cranking and a battery light are the usual tells.",
  },

  // ---- Tires & Brakes ----
  {
    service: "Tire Rotation",
    category: "Tires & Brakes",
    what: "Moving each tire to a different corner so they wear evenly.",
    shop: ["Lift the car and move the tires in the pattern your drivetrain needs", "Check tread depth at each corner", "Reset the pressures"],
    why: "Fronts and rears wear at different rates. Rotating means you replace four tires at once instead of two, twice.",
    due: "Often paired with an oil change so the car is on the lift anyway.",
    safety: true,
  },
  {
    service: "Tire Balance",
    category: "Tires & Brakes",
    what: "Adding small weights to each wheel so it spins without wobbling.",
    shop: ["Spin each wheel on a balancer to find the heavy spot", "Add corrective weights", "Re-spin to confirm it runs true"],
    why: "An unbalanced wheel shakes the steering at speed and chews the tire unevenly.",
    due: "When you feel a vibration at highway speed, and whenever new tires go on.",
    safety: true,
  },
  {
    service: "Wheel Alignment",
    category: "Tires & Brakes",
    what: "Adjusting the angles the wheels sit at so they point where the car is going.",
    shop: ["Put the car on an alignment rack and measure the current angles", "Adjust toe, and camber and caster where they are adjustable", "Road-test that it tracks straight"],
    why: "Bad alignment scrubs a tire flat on one edge and pulls the car to one side.",
    due: "After a pothole or a kerb, when the steering wheel sits off-centre, or with new tires.",
    safety: true,
  },
  {
    service: "Tire Replacement",
    category: "Tires & Brakes",
    what: "Fitting new tires in the size your car specifies.",
    shop: ["Remove the old tires and inspect the wheels", "Mount and balance the new ones", "Set the pressures and reset the sensors"],
    why: "Tread is what stops you in the rain. Below the wear bars, wet braking falls off sharply.",
    due: "At the wear bars, or when the rubber has aged regardless of tread. Tires on Otopair work on live quotes rather than a fixed price.",
    safety: true,
  },
  {
    service: "Brake Pad Replacement",
    category: "Tires & Brakes",
    what: "Replacing the friction material that presses against the discs to stop the car.",
    shop: ["Remove the wheels and inspect pads, rotors and calipers", "Fit new pads and free off the caliper slides", "Bed the brakes in on a road test"],
    why: "Pads are a wear item. Run them to the backing plate and you are replacing rotors too.",
    due: "Squealing is often the built-in wear indicator doing its job. Grinding means it has gone further.",
    safety: true,
  },
  {
    service: "Rotor Replacement",
    category: "Tires & Brakes",
    what: "Replacing the discs the pads clamp onto.",
    shop: ["Measure rotor thickness and check for warping", "Replace in pairs across an axle", "Fit fresh pads and bed everything in"],
    why: "Worn or warped rotors pulse through the pedal and lengthen how far you take to stop.",
    due: "Usually judged on thickness and runout when the pads are being done.",
    safety: true,
  },
  {
    service: "Brake Fluid Flush",
    category: "Tires & Brakes",
    what: "Replacing the fluid that carries your foot's pressure to the brakes.",
    shop: ["Test the fluid's moisture content and boiling point", "Bleed old fluid through every corner until it runs clean", "Confirm a firm pedal"],
    why: "Brake fluid absorbs water from the air over time. Wet fluid boils under hard braking, and boiled fluid means a soft pedal exactly when you need it.",
    due: "Time-based rather than mileage-based — it ages whether you drive or not.",
    safety: true,
  },

  // ---- Scheduled Service ----
  {
    service: "Spark Plugs",
    category: "Scheduled Service",
    what: "Replacing the plugs that ignite the fuel in each cylinder.",
    shop: ["Remove the coils and old plugs", "Fit new plugs at the specified gap and torque", "Check for misfire codes afterwards"],
    why: "Worn plugs misfire, which costs fuel economy and can damage the catalytic converter.",
    due: "A long interval, and it varies a lot by plug type — your car's schedule is the one that matters.",
  },
  {
    service: "Timing Belt",
    category: "Scheduled Service",
    what: "Replacing the belt that keeps the valves and pistons in step, usually with the water pump and tensioners.",
    shop: ["Strip the front of the engine to reach the belt", "Replace the belt, tensioner and usually the water pump", "Re-time the engine precisely and verify"],
    why: "On many engines a snapped belt means the valves and pistons meet. That is an engine rebuild, not a repair.",
    due: "Strictly on the manufacturer's interval, in miles or years, whichever comes first. Not a job to run past.",
    safety: true,
  },
  {
    service: "Coolant Flush",
    category: "Scheduled Service",
    what: "Replacing the coolant that carries heat out of the engine.",
    shop: ["Drain the old coolant and flush the system", "Refill with the correct specification", "Bleed the air out and pressure-test for leaks"],
    why: "Coolant is also corrosion protection. Spent coolant lets the inside of the engine rust.",
    due: "Time-based, and the specification matters — mixing the wrong types causes its own problems.",
  },
  {
    service: "Transmission Service",
    category: "Scheduled Service",
    what: "Replacing the transmission fluid, and the filter where there is one.",
    shop: ["Drain or exchange the fluid to the correct level", "Replace the filter or pan gasket if fitted", "Check for leaks and correct shift behaviour"],
    why: "Transmission fluid is a hydraulic and a lubricant. Tired fluid shifts badly and wears the internals.",
    due: "Varies enormously — some are sealed 'lifetime' units. Your car's schedule decides this one.",
  },
  {
    service: "Power Steering Flush",
    category: "Scheduled Service",
    what: "Replacing the hydraulic fluid in the steering system.",
    shop: ["Extract the old fluid from the reservoir and lines", "Refill with the specified fluid", "Cycle the steering to purge air"],
    why: "Dirty fluid wears the pump and rack, which are the expensive parts of steering.",
    due: "Only applies to hydraulic systems — many newer cars steer electrically and have no fluid at all.",
    safety: true,
  },
  {
    service: "Differential Service",
    category: "Scheduled Service",
    what: "Replacing the gear oil in the differential, and the transfer case on four-wheel drive.",
    shop: ["Drain the old gear oil and inspect it for metal", "Refill to the correct level and specification", "Check the seals"],
    why: "Gear oil takes a beating. Metal in the old oil is an early warning worth catching.",
    due: "Usually a long interval, shorter if you tow or drive hard.",
  },
  {
    service: "Fuel System Cleaning",
    category: "Scheduled Service",
    what: "Clearing deposits off the injectors and intake.",
    shop: ["Inspect for the symptoms that actually indicate deposits", "Clean the injectors and intake as appropriate", "Confirm the idle and fuel trims afterwards"],
    why: "Deposits make an engine idle roughly and lose economy — but this is a service worth doing only when there is evidence for it.",
    due: "On symptoms rather than on a schedule. If a shop suggests it with no symptoms, ask what they found.",
  },

  // ---- Inspections ----
  {
    service: "Diagnostic Scan",
    category: "Inspections",
    what: "Reading the codes the car's computers have stored, and interpreting them.",
    shop: ["Read codes from every module, not just the engine", "Look at live data and freeze-frame from when the fault occurred", "Narrow down what to test next"],
    why: "A code names the circuit that complained, not the part to replace. The interpretation is the actual work.",
    due: "Whenever a warning light appears, or a symptom has no obvious cause.",
  },
  {
    service: "Check Engine Light Diagnosis",
    category: "Inspections",
    what: "Finding out what actually triggered the light, rather than guessing from the code.",
    shop: ["Read the stored code and its freeze-frame data", "Test the parts that code implicates", "Confirm the cause before replacing anything"],
    why: "The same code can come from several causes. Testing is what separates a fix from a parts-swap.",
    due: "As soon as it comes on. A flashing check engine light means stop driving and get it looked at.",
    safety: true,
  },
  {
    service: "State Inspection",
    category: "Inspections",
    what: "The annual New York safety inspection.",
    shop: ["Check brakes, steering, suspension, lights, tires and glass", "Check the seat belts and the horn", "Issue the sticker if it passes"],
    why: "It is required to keep the car on the road legally.",
    due: "Annually, by the month on your sticker.",
  },
  {
    service: "Emissions Test",
    category: "Inspections",
    what: "The emissions half of the New York inspection.",
    shop: ["Check the readiness monitors are complete", "Confirm no emissions-related codes are stored", "Record the result"],
    why: "Required alongside the safety inspection for most cars.",
    due: "Annually, with the safety inspection. A recently cleared computer can fail on readiness alone.",
  },
  {
    service: "Battery Test",
    category: "Inspections",
    what: "Checking whether the battery still holds charge, and whether the car is charging it.",
    shop: ["Load-test the battery", "Measure the alternator's output", "Check for a parasitic drain if the battery keeps dying"],
    why: "A battery that keeps going flat is often a charging fault, not a battery fault.",
    due: "Worth doing before winter, and any time the car cranks slowly.",
  },
];

export const SERVICE_NAMES = SERVICE_EXPLAINERS.map((s) => s.service);

/** Resolve a service by exact name, then loosely, so the agent's phrasing
 *  ("brake pads", "oil") still lands on the right card. */
export function findService(q: string): ServiceExplainer | null {
  const t = (q ?? "").trim().toLowerCase();
  if (!t) return null;
  const exact = SERVICE_EXPLAINERS.find((s) => s.service.toLowerCase() === t);
  if (exact) return exact;
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
  /** Catalog services this usually leads to, for the follow-on card. */
  services?: string[];
  safety?: boolean;
}

export const URGENCY_COPY: Record<Urgency, { label: string; line: string }> = {
  now: { label: "Get it looked at now", line: "Don't put this one off — have it inspected before you drive on it again." },
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
    couldBe: ["A loose or corroded exhaust heat shield — common and cheap", "Worn sway bar links", "A loose exhaust hanger"],
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
    symptom: "Temperature gauge climbing",
    couldBe: ["Low coolant or a leak", "A failed thermostat", "A cooling fan not running"],
    urgency: "now",
    checks: ["Coolant level and a pressure test for leaks", "Thermostat operation", "Fan operation and the radiator itself"],
    services: ["Coolant Flush"],
    safety: true,
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
