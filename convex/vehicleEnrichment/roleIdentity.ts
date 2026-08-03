/**
 * vehicleEnrichment/roleIdentity.ts — component-identity lexicon for part roles.
 *
 * Round 12 (batch-12 Equinox): part 84257919 — a battery ground extension
 * CABLE — filled the `battery` role and survived all eleven rounds of gates,
 * because every gate tests provenance, number shape, cross-make, or vehicle
 * FITMENT. A genuine, fitment-correct accessory is invisible to all of them;
 * even the manual ground-truth review web-verified the number without noticing
 * it isn't a battery. The missing dimension is COMPONENT IDENTITY: is this
 * part the thing the service replaces?
 *
 * This module is the deterministic core of that dimension. Per roleKey
 * (== oem_parts.subcategory) it holds:
 *   block   — POSITIVE evidence the listing titles a DIFFERENT component
 *             (adjacent hardware / accessory / consumable-for-it). Checked
 *             FIRST; a block hit wins even when require also matches
 *             ("Battery Cable" hits /batter/ AND /cable/ → wrong component).
 *   require — the component's own noun. Its ABSENCE is only a soft signal
 *             (dealer titles like "84257919 - GM Genuine Part" carry no noun);
 *             callers promote require-misses to the adversarial verifier,
 *             never reject on them.
 *   mode    — "reject": block hits refuse the write / drop the scrape link.
 *             "flag": roles whose legit products routinely bundle blocked
 *             nouns (integrated-housing thermostats, plug+washer combos) —
 *             block hits only flag for verification.
 *
 * Fired at three layers, same table everywhere:
 *   1. scraper.ts detail-link selection (the cable page never gets scraped),
 *   2. upsertPartAndFitment write choke point (rejected: "role_identity"),
 *   3. partFitmentVerifier prompt evidence + roleIdentityAudit retro sweep.
 *
 * Deliberately NOT persisted into refuted_fitments by the deterministic gate:
 * the regex re-fires identically on every run, so it is its own durable
 * memory, and a lexicon bug stays reversible by editing this one file.
 *
 * Pure module — no ctx, no imports beyond the service reference. Unit-tested
 * in tests/roleIdentity.test.ts.
 */

import { SERVICE_PARTS_REFERENCE } from "../lib/servicePartsReference";

export type RoleIdentityMode = "reject" | "flag";

export interface RoleLexicon {
  /** The component's own noun(s). Absence → "require_miss" (soft). */
  require?: RegExp;
  /** Positive wrong-component evidence. Presence → "reject" verdict. */
  block?: RegExp;
  mode: RoleIdentityMode;
}

export type RoleIdentityVerdict =
  | { verdict: "pass" }
  | { verdict: "no_title" }
  | { verdict: "unknown_role" }
  /** Title present, no block hit, but the component noun is absent — promote
   *  to the verifier; never reject on absence of evidence. */
  | { verdict: "require_miss"; expected: string }
  /** Block hit. mode "reject" → refuse; mode "flag" → keep + verify. */
  | { verdict: "reject"; mode: RoleIdentityMode; matched: string; expected: string };

// ─── Shared fragments (front/rear pairs share one lexicon) ──────────────────

const BRAKE_PAD_LEXICON: RoleLexicon = {
  // "Disc Brake Pad Set" is the standard retail title — "disc" must NOT block.
  require: /pad/i,
  block:
    /rotor|\bshoe\b|\bdrum\b|caliper\s?(assembly|bracket|pin|bolt)|grease|fluid|hose|\bline\b|backing\s?plate|dust\s?shield/i,
  // Deliberately absent: "sensor" (Euro pad kits ship "with wear sensor"),
  // "hardware"/"shim"/"clip"/"kit" (premium pad sets include hardware). A pad
  // part in the wrong SLOT for those roles require-misses → verifier.
  mode: "reject",
};

const ROTOR_LEXICON: RoleLexicon = {
  require: /rotor|brake\s?disc|\bdisc\b/i,
  // "brake drum" as a phrase — bare "drum" must not block drum-in-hat rotors.
  block: /\bpads?\b|caliper|shield|splash|backing|bearing|\bscrew\b|\bshoe\b|brake\s?drum\b/i,
  mode: "reject",
};

const WIPER_LEXICON: RoleLexicon = {
  require: /wiper|blade/i,
  block: /\barm\b|motor|linkage|pivot|nozzle|washer\s?(pump|hose|reservoir|jet)|switch|relay/i,
  mode: "reject",
};

// ─── The lexicon ────────────────────────────────────────────────────────────

export const ROLE_IDENTITY_LEXICON: Record<string, RoleLexicon> = {
  // ── battery_replacement ───────────────────────────────────────────────────
  battery: {
    require: /batter/i, // battery / batteries / batterie (fr/de) / batteria (it)
    // Supersedes the round-11 battery guard in v3mutations (telematic|dcm|
    // auxiliar|backup|key fob|remote|data communication) — those terms are all
    // here, so write-gate behavior is a strict superset. GM catalog
    // abbreviations included: CBL / GRD / GND / HARN.
    block:
      /cable|\bcbl\b|wir(e|ing)|harness|\bharn\b|terminal|bracket|tray|hold[\s-]?down|retainer|\bbolt\b|sensor|\bvent\b|extension|ground|\bgrd\b|\bgnd\b|strap|junction|fuse|relay|charger|maintainer|tender|blanket|heater|insulat|\bcover\b|\bbox\b|carrier|clamp|\bmat\b|\bpad\b|monitor|tester|disconnect|isolator|key\s?fob|remote|telematic|\bdcm\b|auxiliar|backup|data.?communication/i,
    mode: "reject",
  },
  // Battery-cable-adjacent accessory role — must keep ACCEPTING terminal parts.
  terminal_protection: {
    require: /terminal|anti.?corrosion|dielectric|grease|washer|protect/i,
    mode: "flag",
  },

  // ── oil_change ────────────────────────────────────────────────────────────
  engine_oil: {
    require: /\boil\b|\b\d{1,2}w[\s-]?\d{2}\b/i, // "oil" or a 0W-20-style grade
    block:
      /filter|additive|treatment|stop.?leak|flush|stabilizer|drain\s?plug|funnel|\bpan\b|cooler|pump|pressure|sensor|switch|\bcap\b|dipstick|level|extractor/i,
    mode: "reject",
  },
  oil_filter: {
    require: /filter|element|filtre/i, // OEM term is often "Oil Filter ELEMENT"
    block:
      /housing|\bcap\b|adapter|bracket|wrench|stud|\bbolt\b|bypass|cooler|\bline\b|hose|sensor|switch|drain\s?plug|relocat/i,
    mode: "reject",
  },
  drain_plug_gasket: {
    require: /gasket|washer|\bseal\b|o.?ring|crush/i,
    // "Oil Drain Plug" (the plug itself) must flag; "Drain Plug Gasket" passes.
    block: /\bplugs?\b(?!\s*(gasket|washer|seal|o.?ring))|valve\b|tool\b/i,
    mode: "flag", // low-consequence commodity; plugs often ship WITH the washer
  },
  oil_filter_housing_oring: {
    require: /o.?ring|\bseal\b|gasket/i,
    block: /housing\s+(assembly|unit)\b|wrench|tool\b|filter\s?element/i,
    mode: "flag",
  },

  // ── filter_replacement ────────────────────────────────────────────────────
  air_filter: {
    require: /filter|element|filtre/i, // "Air Cleaner Element" is the OEM term
    block:
      /housing|\bbox\b|\blid\b|\bcover\b|intake\s?(tube|duct|pipe)|duct|hose|clamp|bracket|\bmaf\b|mass\s?air|sensor|resonator|snorkel/i,
    mode: "reject",
  },
  cabin_filter: {
    require: /filter|element|filtre/i,
    block: /housing|\bcover\b|\bdoor\b|actuator|blower|motor|resistor|duct/i,
    mode: "reject",
  },

  // ── spark_plugs ───────────────────────────────────────────────────────────
  spark_plug: {
    require: /spark\s?plug|bougie/i,
    block:
      /\bwire\b|cable|\bboot\b|\btube\b|\bseal\b|\bcoil\b|gasket|glow\s?plug|socket|wrench|gapp?er|anti.?seize|thread|insert|extractor/i,
    mode: "reject",
  },
  ignition_coil: {
    require: /coil/i,
    block: /boot\s?only|connector|bracket|\bwire\b|harness/i,
    mode: "flag",
  },
  intake_manifold_gasket: { require: /gasket|\bseal\b|o.?ring/i, mode: "flag" },

  // ── brakes (front/rear pairs share fragments) ─────────────────────────────
  front_brake_pad: BRAKE_PAD_LEXICON,
  rear_brake_pad: BRAKE_PAD_LEXICON,
  front_rotor: ROTOR_LEXICON,
  rear_rotor: ROTOR_LEXICON,
  front_brake_hardware_kit: { require: /hardware|kit|clip|shim|abutment|spring/i, mode: "flag" },
  rear_brake_hardware_kit: { require: /hardware|kit|clip|shim|abutment|spring/i, mode: "flag" },
  front_brake_wear_sensor: { require: /sensor|indicator|wear/i, mode: "flag" },
  rear_brake_wear_sensor: { require: /sensor|indicator|wear/i, mode: "flag" },

  // ── fluids ────────────────────────────────────────────────────────────────
  coolant: {
    require: /coolant|antifreeze|anti.?freeze/i,
    block:
      /hose|clamp|reservoir|\btank\b|\bcap\b|sensor|temperatur|thermostat|pump|flush\s?(kit|tool|tee)|funnel|tester|heater|\bline\b|pipe|valve/i,
    mode: "reject",
  },
  atf_fluid: {
    require: /fluid|\batf\b|\bcvt\b|dexron|mercon|\bulv\b|lifeguard|maxlife/i,
    block:
      /filter|gasket|\bpan\b|cooler|\bline\b|hose|mount|sensor|solenoid|valve|dipstick|funnel|additive|stop.?leak|treatment/i,
    mode: "reject",
  },
  brake_fluid: {
    require: /brake\s?fluid|dot\s?[345]/i,
    block: /bleeder|bleed\s?kit|tester|hose|\bline\b|reservoir|\bcap\b|sensor|switch/i,
    mode: "reject",
  },
  ps_fluid: {
    require: /fluid|\bpsf\b|\bchf\b|pentosin/i,
    block:
      /pump|hose|\bline\b|reservoir|\bcap\b|rack|belt|filter|sensor|stop.?leak|additive/i,
    mode: "reject",
  },
  gear_oil: {
    require: /gear\s?(oil|lube)|75w|80w|85w|hypoid|\bgl-?5\b/i,
    block:
      /friction\s?modifier|limited.?slip\s?additive|\badditive\b|pump|gasket|\bcover\b|bearing|\bseal\b/i,
    mode: "reject",
  },
  friction_modifier: { require: /friction|modifier|limited.?slip|\blsd\b|additive/i, mode: "flag" },

  // ── belts / timing / cooling hardware ─────────────────────────────────────
  serpentine_belt: {
    require: /belt/i,
    block: /tensioner|idler|pulley|tool\b/i,
    mode: "reject",
  },
  timing_belt: {
    require: /belt/i,
    // A chain part in the belt slot is a chain-vs-belt engine mixup; a KIT
    // belongs in the timing_kit role (its bundle price poisons the belt role).
    block: /chain|tensioner|idler|pulley|guide|\bcover\b|\bseal\b|water\s?pump|\bkit\b/i,
    mode: "reject",
  },
  timing_kit: { require: /kit|tensioner|component/i, mode: "flag" },
  water_pump: {
    require: /water\s?pump|coolant\s?pump/i,
    block: /pulley\s?only|stud|hose/i,
    mode: "flag",
  },
  thermostat: {
    // Integrated-housing thermostat assemblies are legit → flag, never reject.
    require: /thermostat/i,
    block: /gasket|o.?ring|\bseal\b|sensor|switch/i,
    mode: "flag",
  },
  thermostat_gasket: { require: /gasket|\bseal\b|o.?ring/i, mode: "flag" },

  // ── transmission_service extras ───────────────────────────────────────────
  trans_filter: {
    require: /filter|strainer/i,
    block: /fluid\b|cooler|solenoid|sensor/i,
    mode: "flag",
  },
  trans_pan_gasket: { require: /gasket|\bpan\b|rtv|sealant/i, mode: "flag" },
  cvt_internal_filter: { require: /filter|screen|strainer/i, mode: "flag" },
  cvt_external_filter: { require: /filter/i, mode: "flag" },

  // ── wipers ────────────────────────────────────────────────────────────────
  wiper_blade_front_set: WIPER_LEXICON,
  wiper_blade_rear: WIPER_LEXICON,
};

// ─── Verdict ────────────────────────────────────────────────────────────────

/** Normalize a scraped/echoed title for matching: decode the common HTML
 *  entities and collapse whitespace. Matching is substring-based and
 *  case-insensitive; order of words never matters. */
function normalizeTitle(title: string): string {
  return title
    .replace(/&amp;/gi, "&")
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function checkRoleIdentity(
  roleKey: string,
  title: string | null | undefined,
): RoleIdentityVerdict {
  const lex = ROLE_IDENTITY_LEXICON[roleKey];
  if (!lex) return { verdict: "unknown_role" };
  const t = normalizeTitle(title ?? "");
  if (!t) return { verdict: "no_title" };
  if (lex.block) {
    const m = t.match(lex.block);
    if (m) {
      return {
        verdict: "reject",
        mode: lex.mode,
        matched: m[0],
        expected: String(lex.require ?? roleKey),
      };
    }
  }
  if (lex.require && !lex.require.test(t)) {
    return { verdict: "require_miss", expected: String(lex.require) };
  }
  return { verdict: "pass" };
}

// ─── Scraper bridge: search-plan slug → roleKeys it fetches for ─────────────

/** Covers BOTH the legacy combined slugs (brake_pads, brake_disc) and the
 *  round-12 position-split slugs, so the scraper screen works regardless of
 *  which registry map a make uses. */
export const ROLEKEYS_BY_PART_SLUG: Record<string, string[]> = {
  oil_filter: ["oil_filter"],
  air_filter: ["air_filter"],
  cabin_air_filter: ["cabin_filter"],
  spark_plug: ["spark_plug"],
  brake_pads: ["front_brake_pad", "rear_brake_pad"],
  front_brake_pads: ["front_brake_pad"],
  rear_brake_pads: ["rear_brake_pad"],
  brake_disc: ["front_rotor", "rear_rotor"],
  front_brake_disc: ["front_rotor"],
  rear_brake_disc: ["rear_rotor"],
  front_brake_rotor: ["front_rotor"],
  rear_brake_rotor: ["rear_rotor"],
  serpentine_belt: ["serpentine_belt"],
  drain_plug: ["drain_plug_gasket"],
  wiper_blade: ["wiper_blade_front_set", "wiper_blade_rear"],
  battery: ["battery"],
  coolant: ["coolant"],
  engine_oil: ["engine_oil"],
};

// ─── Reference bridge: which roleKeys are core anywhere in the catalog ──────

const CORE_ROLE_KEYS: ReadonlySet<string> = new Set(
  Object.values(SERVICE_PARTS_REFERENCE)
    .flatMap((s) => s.roles)
    .filter((r) => r.serviceRole === "core")
    .map((r) => r.roleKey),
);

/** True when any of the 23 services lists this roleKey as a core role — the
 *  retro sweep's scope filter (core roles carry quote/invoice consequence). */
export function isCoreRoleKey(roleKey: string | null | undefined): boolean {
  return roleKey != null && CORE_ROLE_KEYS.has(roleKey);
}
