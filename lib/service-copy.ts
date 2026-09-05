/**
 * Customer-facing service copy, mirrored from otopair-1
 * constants/serviceCopy.ts (the OTOPAIR Service Guide: the three-line
 * quick summary and the "simple" tier). The app's ServiceInfoSheet shows
 * exactly this text, so the web renders the same words and never
 * paraphrases. Re-sync from the app file when the guide changes; do not
 * edit here.
 */
export type ServiceCopy = { quick: readonly [string, string, string]; whatItIs: string; whyItMatters: string; signs: string };

export const SERVICE_COPY: Record<string, ServiceCopy> = {
  diagnostic_scan: {
    quick: ["Your car has a brain that remembers problems.", "We hook up a computer and ask it what's wrong.", "Now we know what to fix."],
    whatItIs: "Your car has a little brain. When something goes wrong, it remembers. We hook up a small computer and ask the car's brain what's wrong.",
    whyItMatters: "It helps us find the problem fast, so we fix the right thing and you don't waste money.",
    signs: "A warning light pops up. The car feels weird. You want to know why a light came on.",
  },
  check_engine_light: {
    quick: ["A light on your dashboard turned on.", "We find the real reason behind it.", "Then you know what to fix."],
    whatItIs: "One dashboard light is the 'check engine' light. It can mean many things. We dig in and find the real reason it turned on.",
    whyItMatters: "It can mean something tiny or something big. Finding the reason early stops a small problem from becoming a costly one.",
    signs: "The light is glowing. If it's blinking, that's more serious — drive gently. The car may shake, feel weak, or use more gas.",
  },
  state_inspection: {
    quick: ["New York wants your car checked once a year.", "We make sure the safety parts work.", "You get a sticker that says you're okay to drive."],
    whatItIs: "Once a year, New York wants someone to check your car is safe. We look at the brakes, lights, tires, and more. If it's all good, you get a sticker.",
    whyItMatters: "It's the law. It also keeps your car safe for you and everyone around you.",
    signs: "Your sticker is old or about to run out. You just got the car. It's that time of year.",
  },
  emissions_test: {
    quick: ["When cars run, gas comes out the back.", "We make sure yours isn't too dirty.", "It keeps the air clean and follows the law."],
    whatItIs: "When a car runs, smoke and gas come out the back. We check that yours isn't making too much dirty air.",
    whyItMatters: "It keeps the air clean, it's the law, and it can catch hidden engine problems.",
    signs: "Done with your yearly check. If your check engine light is on, the car can fail. You see smoke from the back.",
  },
  oil_change: {
    quick: ["Oil keeps the parts inside your engine slippery.", "Old oil gets dirty and stops working.", "We swap it for fresh, clean oil."],
    whatItIs: "Inside your engine, metal parts rub together fast. Oil is the slippery juice that stops them grinding. It gets dirty over time. We drain it and add fresh oil, plus a new filter that catches dirt.",
    whyItMatters: "Oil is like lotion for your engine. Without it the parts scrape and overheat, and the engine can break — which costs a lot.",
    signs: "It's been a while or lots of miles. A little oil-can light pops up. The oil looks black, not golden.",
  },
  filter_replacement: {
    quick: ["Your car has filters that catch dirt.", "We put in fresh, clean ones.", "The engine and your air both feel better."],
    whatItIs: "Your car has filters that catch dirt. One cleans the air your engine breathes. One cleans the air you breathe inside. We put in fresh ones.",
    whyItMatters: "A dirty engine filter is like breathing through a stuffy nose. A dirty cabin filter makes the inside air dusty and smelly.",
    signs: "The car feels weak or uses more gas. Vent air is weak or smells. The filters look dark.",
  },
  spark_plugs: {
    quick: ["Tiny parts make sparks to run your engine.", "Old ones wear out and spark weakly.", "We put in new ones so it runs smooth."],
    whatItIs: "Your car runs on tiny explosions. Spark plugs make the spark that starts each one — like a lighter's click. They wear out. We put in new ones.",
    whyItMatters: "Good sparks mean a smooth, strong car that saves gas. Worn ones make it shake, feel weak, and hard to start.",
    signs: "The engine shakes or stutters. Hard to start. Feels slow or uses more gas. A warning light.",
  },
  timing_belt: {
    quick: ["A belt keeps your engine parts moving in time.", "If it snaps, the engine can break badly.", "We replace it before that happens."],
    whatItIs: "Engine parts at the top and bottom must move together, like two people clapping at the same time. A rubber belt keeps them in sync. It can wear and snap, so we replace it first. (Some cars use a metal chain instead.)",
    whyItMatters: "If the belt snaps while driving, the engine parts crash and break — costing thousands. Changing it on time is way cheaper.",
    signs: "Mostly about miles — usually 60,000 to 100,000 (your manual says). Sometimes a ticking sound.",
  },
  coolant_flush: {
    quick: ["Coolant keeps your hot engine cool.", "Over time it gets old and weak.", "We swap it for fresh coolant."],
    whatItIs: "Engines get very hot. Coolant is a liquid that soaks up the heat, like a wet towel. It gets old and stops working. We drain it and add fresh.",
    whyItMatters: "Without good coolant the engine gets too hot and can break. Old coolant also rusts the parts inside.",
    signs: "The heat gauge climbs or the engine runs hot. Steam under the hood (stop driving!). Coolant looks dirty or rusty.",
  },
  transmission_service: {
    quick: ["Your car uses fluid to change gears smoothly.", "That fluid gets dirty over time.", "We replace it so shifting stays smooth."],
    whatItIs: "Your car changes 'gears' to go faster or slower, like gears on a bike. Inside is a fluid that keeps it shifting smoothly. It gets dirty. We drain it and add fresh (sometimes a filter too).",
    whyItMatters: "This part is very expensive to fix. Clean fluid keeps shifting smooth and stops it wearing out. Old fluid makes it jerk and slip.",
    signs: "Changing speeds feels rough, slow, or jerky. Fluid is dark or smells burnt. Lots of miles.",
  },
  tire_rotation: {
    quick: ["Tires wear unevenly in their spots.", "We move them around the car.", "This helps them all last longer."],
    whatItIs: "Your four tires wear down at different speeds depending on their spot. We move them around (like front to back) so they wear evenly. Nothing is replaced.",
    whyItMatters: "It makes your tires last longer and saves money, and keeps the car driving evenly.",
    signs: "Usually done on a schedule, often with your oil change. Some tires look more worn.",
  },
  tire_balance: {
    quick: ["Wheels can wobble if one spot is heavier.", "We add little weights to even them out.", "Your ride gets nice and smooth."],
    whatItIs: "Every wheel has one spot that's a little heavier. At fast speeds that makes it wobble. We add tiny weights to even it out so it spins smooth.",
    whyItMatters: "Balanced wheels give a smooth ride and last longer. Wobbly wheels shake the car and wear out tires.",
    signs: "The car or steering wheel shakes when you go fast. New tires. A tire wearing oddly.",
  },
  wheel_alignment: {
    quick: ["Your wheels need to point straight.", "We measure and adjust them.", "The car drives straight and tires last longer."],
    whatItIs: "Your wheels need to point straight. Potholes and bumps knock them crooked. We use a machine to measure and adjust them back to straight. Nothing is replaced.",
    whyItMatters: "Crooked wheels make the car pull and wear tires out fast. Straight wheels keep it driving straight and tires lasting.",
    signs: "The car pulls to one side. The steering wheel (the round wheel you turn) sits crooked. One tire edge is worn. You hit a big pothole.",
  },
  tire_replacement: {
    quick: ["Tires wear down and lose their grip.", "We put on fresh new ones.", "You get safe stopping and a smooth ride."],
    whatItIs: "Tires are the round rubber parts that touch the road. Their grooves grip the ground. When they wear down or get damaged, we take off the old ones and put on brand-new tires.",
    whyItMatters: "Tires are the ONLY part touching the ground. Worn ones can't grip or stop and slide in rain. New ones keep you safe.",
    signs: "Grooves look worn or smooth. A flat, leak, or bubble. Old, cracked tires. The car slides in rain.",
  },
  brake_pad_replacement: {
    quick: ["Pads squeeze to stop your car.", "They slowly wear down every time you brake.", "We put in new ones so you can stop safely."],
    whatItIs: "To stop, two pads squeeze a spinning part at each wheel — like pinching a spinning plate. The pads wear away each time you brake. We put in new ones.",
    whyItMatters: "Brakes are how you stop, so this matters for safety. Fresh pads stop you fast; worn ones take longer and can damage other parts.",
    signs: "Squeaky or screechy braking. Grinding (check right away). Longer stops. A brake light.",
  },
  rotor_replacement: {
    quick: ["Brake pads squeeze a spinning part called a rotor.", "Rotors wear out or bend over time.", "We replace them for safe, smooth stops."],
    whatItIs: "Remember the spinning part the pads squeeze? That's the rotor. Over time it wears thin or warps (bends from heat). We replace it, and usually the pads too.",
    whyItMatters: "Smooth rotors mean safe, smooth stops. Worn or bent ones make brakes shake or feel weak.",
    signs: "The pedal or steering wheel shakes when slowing. Grinding sounds. Deep scratches on the metal part.",
  },
  brake_fluid_flush: {
    quick: ["Your brakes work by pushing fluid through tubes.", "That fluid gets watery and weak over time.", "We swap it so your brakes stay strong."],
    whatItIs: "When you push the brake pedal, you push a liquid through tubes that squeezes the brakes. That liquid soaks up water and gets weak. We remove the old and add fresh.",
    whyItMatters: "This liquid turns your foot-push into stopping power. Old, watery fluid makes the pedal soft and brakes weak — right when you need them.",
    signs: "The pedal feels soft or squishy. Brakes feel weak. It's been about 2 to 3 years.",
  },
  battery_test: {
    quick: ["We check how strong your battery still is.", "This warns you before it dies.", "You don't get stuck by surprise."],
    whatItIs: "The battery gives your car power to start, like big remote-control batteries. We use a tool to check how strong it still is. Nothing is replaced — just a check-up.",
    whyItMatters: "Batteries die with little warning, usually at a bad time. Testing tells you it's getting weak before it leaves you stuck.",
    signs: "The car is slow to start. Lights look dim. Battery is a few years old. It died once before.",
  },
  battery_replacement: {
    quick: ["The battery gives your car power to start.", "Old ones run out of power and die.", "We put in a fresh one so it starts every time."],
    whatItIs: "The battery is the box that gives your car power to start and run its lights. After a few years it wears out. We take out the old one and put in a fresh one.",
    whyItMatters: "A good battery starts your car every time. A dead one leaves you stuck. A fresh one fixes that.",
    signs: "Starts slowly or not at all. Dim lights. Fast clicking at the key. Old battery.",
  },
  power_steering_flush: {
    quick: ["Some cars use fluid to make steering easy.", "That fluid gets dirty over time.", "We replace it so the wheel turns easily."],
    whatItIs: "Turning the steering wheel (the round wheel you hold to steer) is made easy by a helper fluid. It gets dirty over time. We swap it for fresh. (Some newer cars use an electric helper and don't need this.)",
    whyItMatters: "Clean fluid keeps the wheel turning easily. Old, dirty fluid makes it hard to turn and can whine.",
    signs: "The wheel is hard to turn, especially parking. A whine when you turn. Dark fluid.",
  },
  differential_service: {
    quick: ["Special gears help your wheels turn corners.", "Thick oil keeps those gears safe.", "We replace the oil to protect them."],
    whatItIs: "When your car turns a corner, the outside wheels spin a bit faster than the inside ones. A set of gears makes that work. They sit in thick, gooey oil. We drain the old oil and add fresh.",
    whyItMatters: "The gears work hard, and the thick oil keeps them from wearing out. Old oil leads to noise and costly damage.",
    signs: "A whining or humming sound under the car. Lots of miles. Old or low oil.",
  },
  fuel_system_cleaning: {
    quick: ["Gunk builds up where gas and air go in.", "We clean it all out.", "Your engine runs smoother and saves gas."],
    whatItIs: "Your engine needs fuel (gas) and air mixed to run. Over time sticky gunk builds up on the parts that handle the gas and air. We clean it out.",
    whyItMatters: "When those parts are clean, the engine runs smooth, starts easy, and saves gas. Gunky parts run rough and waste fuel.",
    signs: "The engine shakes when sitting still. Feels weak or jerky. Uses more gas. Hard to start.",
  },
};

export function serviceCopy(slug: string): ServiceCopy | undefined {
  return SERVICE_COPY[slug];
}
