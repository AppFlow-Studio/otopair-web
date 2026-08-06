/**
 * Guards for the LEMON Manuals labor-time source.
 *
 * The headline test is "every rule targets a REAL catalog slug". The first cut
 * of this table was written against invented slugs (`brake_rotor`, `water_pump`,
 * `alternator`, `starter`) and validated by a preview action that used those
 * same invented slugs — so it reported 9/10 matches while production, which
 * passes SERVICE_NAME_TO_SLUG keys, would have matched almost nothing. A rule
 * table keyed on an external vocabulary has to be tested against the SYSTEM's
 * keys, never against hand-written ones.
 *
 * Operation names below are the real MOTOR-style tails verified live on three
 * labor indexes (2021 Honda CR-V, 2021 Honda Odyssey, 2020 BMW 330i).
 */
import { describe, it, expect } from "vitest";
import {
  LEMON_LABOR_RULES,
  matchLemonLaborRule,
  parseLaborLeafHours,
  axlePreferences,
  DEFAULT_PREVIEW_SERVICES,
} from "../convex/vehicleEnrichment/lemonLabor";
import { SERVICE_NAME_TO_SLUG } from "../convex/vehicleEnrichment/v3pipeline";

/** Exactly what laborAllSources receives: the mapped (slug, name) pairs. */
const CATALOG = Object.entries(SERVICE_NAME_TO_SLUG).map(([name, slug]) => ({ slug, name }));
const CATALOG_SLUGS = new Set(Object.values(SERVICE_NAME_TO_SLUG));

/** A realistic slice of one vehicle's labor index, including the near-misses. */
const OP_TAILS = [
  "Spark Plugs / Remove & Replace",
  "Cabin Air Filter / Remove & Replace",
  "Air Cleaner Element / Remove & Replace",
  "Engine Oil Filter / Remove & Replace",
  "Brake Shoes &/Or Pads / Remove & Replace",
  "Disc Rotor / Remove & Replace",
  "Disc Rotor (On Vehicle) / Refinish",
  "Brake Drum Or Rotor (Removed) / Refinish",
  "Brake System / Bleed",
  "Cooling System / Flush",
  "Cooling System / Drain & Refill",
  "Automatic Transmission Fluid / Drain & Refill",
  "Differential Fluid / Drain & Refill",
  "Differential Fluid Temperature Sensor / Remove & Replace",
  "Transfer Case Fluid / Drain & Refill",
  "Serpentine Drive Belt / Remove & Replace",
  "Serpentine Belt TENSIONER / Remove & Replace",
  "A/C Compressor Drive Belt / Remove & Replace",
  "Timing Chain / Remove & Replace",
  "Timing Chain TENSIONER / Remove & Replace",
  "Battery / Remove & Replace",
  "Battery / Testing",
  "Battery Cable / Remove & Replace",
  "Wheel Bearing / Remove & Replace",
  "Wiper Arm &/Or Blades / Remove & Replace",
];

const opsFor = (rx: RegExp) => OP_TAILS.filter((t) => rx.test(t));

describe("LEMON_LABOR_RULES ↔ the real service catalog", () => {
  it("REGRESSION: every rule targets a slug the pipeline actually emits", () => {
    const orphans = LEMON_LABOR_RULES.filter((r) => !CATALOG_SLUGS.has(r.slug)).map((r) => r.slug);
    expect(orphans).toEqual([]);
  });

  it("REGRESSION: the preview action uses real catalog pairs, not invented ones", () => {
    const known = new Set(CATALOG.map((c) => `${c.slug}|${c.name}`));
    const invented = DEFAULT_PREVIEW_SERVICES.filter((s) => !known.has(`${s.slug}|${s.name}`));
    expect(invented).toEqual([]);
  });

  it("has no duplicate (slug, nameTest) rule that could shadow another", () => {
    const keys = LEMON_LABOR_RULES.map((r) => `${r.slug}|${r.nameTest?.source ?? ""}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("matchLemonLaborRule", () => {
  it("REGRESSION: a rotor service does not get routed to the brake-pad operation", () => {
    // "Brake Pad + Rotor Replacement - Front" maps to slug `rotor_replacement`.
    // The old loose /brake[\s_-]?pad/ rule matched that NAME and won, so rotors
    // were priced as pads — and since pads were resolved first and consumed the
    // op, rotors ended up with nothing at all.
    const rotor = matchLemonLaborRule({ slug: "rotor_replacement", name: "Brake Pad + Rotor Replacement - Front" });
    expect(rotor?.label).toBe("brake_rotor");
    expect(opsFor(rotor!.ops[0])).toEqual(["Disc Rotor / Remove & Replace"]);

    const pads = matchLemonLaborRule({ slug: "brake_pad_replacement", name: "Brake Pad Replacement - Rear" });
    expect(pads?.label).toBe("brake_pads");
    expect(opsFor(pads!.ops[0])).toEqual(["Brake Shoes &/Or Pads / Remove & Replace"]);
  });

  it("splits the one slug that carries two service names", () => {
    expect(matchLemonLaborRule({ slug: "filter_replacement", name: "Cabin Air Filter Replacement" })?.label).toBe(
      "cabin_air_filter",
    );
    expect(matchLemonLaborRule({ slug: "filter_replacement", name: "Air Filter Replacement" })?.label).toBe(
      "engine_air_filter",
    );
  });

  it("returns null for the slugs LEMON has no honest equivalent for", () => {
    for (const slug of ["oil_change", "tire_rotation", "wheel_alignment", "ac_recharge", "multi_point_inspection"]) {
      expect(matchLemonLaborRule({ slug, name: "whatever" })).toBeNull();
    }
  });

  it("resolves every catalog pair without throwing, and covers the expected set", () => {
    const covered = new Set(CATALOG.filter((c) => matchLemonLaborRule(c)).map((c) => c.slug));
    expect([...covered].sort()).toEqual([
      "battery_replacement",
      "brake_fluid_flush",
      "brake_pad_replacement",
      "coolant_flush",
      "differential_service",
      "filter_replacement",
      "rotor_replacement",
      "serpentine_belt",
      "spark_plugs",
      "timing_belt",
      "transfer_case_service",
      "transmission_service",
      "wheel_bearing_replacement",
      "wiper_blade_replacement",
    ]);
  });
});

describe("operation regexes vs the real index (near-miss exclusion)", () => {
  it("each rule's preferences match at most one operation, and never a near-miss", () => {
    for (const rule of LEMON_LABOR_RULES) {
      for (const rx of rule.ops) {
        expect(opsFor(rx).length, `${rule.label} :: ${rx}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it("excludes Refinish, TENSIONER, Testing and Cable variants", () => {
    const belt = LEMON_LABOR_RULES.find((r) => r.slug === "serpentine_belt")!;
    expect(opsFor(belt.ops[0])).toEqual(["Serpentine Drive Belt / Remove & Replace"]);

    const battery = LEMON_LABOR_RULES.find((r) => r.slug === "battery_replacement")!;
    expect(opsFor(battery.ops[0])).toEqual(["Battery / Remove & Replace"]);

    const rotor = LEMON_LABOR_RULES.find((r) => r.slug === "rotor_replacement")!;
    expect(opsFor(rotor.ops[0])).toEqual(["Disc Rotor / Remove & Replace"]);

    const timing = LEMON_LABOR_RULES.find((r) => r.slug === "timing_belt")!;
    expect(timing.ops.flatMap(opsFor)).toEqual(["Timing Chain / Remove & Replace"]);
  });

  it("prefers a flush over a drain-and-refill for the coolant service", () => {
    const coolant = LEMON_LABOR_RULES.find((r) => r.slug === "coolant_flush")!;
    expect(opsFor(coolant.ops[0])).toEqual(["Cooling System / Flush"]);
    expect(opsFor(coolant.ops[1])).toEqual(["Cooling System / Drain & Refill"]);
  });

  it("does not confuse the differential fluid service with its temperature sensor", () => {
    const diff = LEMON_LABOR_RULES.find((r) => r.slug === "differential_service")!;
    expect(opsFor(diff.ops[0])).toEqual(["Differential Fluid / Drain & Refill"]);
  });
});

describe("axlePreferences + variant row selection", () => {
  // The real 2021 CR-V pad table. Its FIRST row is the whole-car variant.
  const padTable =
    `<div class="main"><table>` +
    `<tr><th>Applies To</th><th>Note</th><th>Standard Hours</th><th>Warranty Hours</th><th>Skill Level</th></tr>` +
    `<tr><td>All,Both Axles</td><td></td><td>1.8</td><td></td><td>B</td></tr>` +
    `<tr><td>Front,Both Sides</td><td></td><td>1.0</td><td></td><td>B</td></tr>` +
    `<tr><td>Rear,Both Sides</td><td></td><td>1.0</td><td></td><td>B</td></tr>` +
    `<tr><td>Combination Procedure: CALIPER: Overhaul: Includes: Bleed Brake System.</td></tr>` +
    `<tr><td>One</td><td></td><td>0.7</td><td></td><td>B</td></tr>` +
    `</table></div>`;

  it("REGRESSION: a front pad job bills the front row, not 'All, Both Axles'", () => {
    expect(parseLaborLeafHours(padTable, axlePreferences("Brake Pad Replacement - Front"))).toBe(1.0);
    expect(parseLaborLeafHours(padTable, axlePreferences("Brake Pad Replacement - Rear"))).toBe(1.0);
    // What the old first-row-wins parser produced — nearly double.
    expect(parseLaborLeafHours(padTable)).not.toBe(1.8);
  });

  it("prefers the both-sides row over the one-side half job", () => {
    const rotors =
      `<div class="main"><table>` +
      `<tr><th>Applies To</th><th>Standard Hours</th></tr>` +
      `<tr><td>Front,One Side</td><td>0.6</td></tr>` +
      `<tr><td>Front,Both</td><td>1.0</td></tr>` +
      `</table></div>`;
    expect(parseLaborLeafHours(rotors, axlePreferences("Brake Pad + Rotor Replacement - Front"))).toBe(1.0);
  });

  it("stops at the combination-procedure separator", () => {
    // Without the cut, a leaf whose base rows are all blank would fall through
    // to an add-on operation's hours and report a bleed as the whole job.
    const html =
      `<div class="main"><table><tr><th>Applies To</th><th>Standard Hours</th></tr>` +
      `<tr><td>All</td><td>&nbsp;</td></tr>` +
      `<tr><td>Combination Procedure: BLEED BRAKE SYSTEM:</td></tr>` +
      `<tr><td>One</td><td>0.5</td></tr></table></div>`;
    expect(parseLaborLeafHours(html)).toBeNull();
  });

  it("REGRESSION: returns null rather than guessing between unequal variants", () => {
    // The real CR-V wheel-bearing table: rear 1.9, front 3.4. The catalog
    // service carries no axle, so there is nothing to choose with — and an
    // arbitrary pick is a wrong number entering a weighted median at 0.7.
    const bearings =
      `<div class="main"><table><tr><th>Applies To</th><th>Standard Hours</th></tr>` +
      `<tr><td>AWD, Rear,Both</td><td>1.9</td></tr>` +
      `<tr><td>AWD, Rear,One Side</td><td>1.0</td></tr>` +
      `<tr><td>Front,Both</td><td>3.4</td></tr></table></div>`;
    expect(parseLaborLeafHours(bearings, axlePreferences("Wheel Bearing Replacement"))).toBeNull();
  });

  it("takes the value when every variant agrees", () => {
    const html =
      `<div class="main"><table><tr><th>Applies To</th><th>Standard Hours</th></tr>` +
      `<tr><td>Gas</td><td>0.7</td></tr><tr><td>Hybrid</td><td>0.7</td></tr></table></div>`;
    expect(parseLaborLeafHours(html)).toBe(0.7);
  });

  it("has no axle preference for a service that names no axle", () => {
    expect(axlePreferences("Coolant Flush")).toEqual([]);
    expect(axlePreferences("Brake Pad Replacement - Front")).toHaveLength(2);
  });

  it("REVIEW: wiper set bills the Blade,Both row — not the first (Arm) row", () => {
    // The real 2021 CR-V wiper leaf: rows are Arm/Blade × Both/One. First row
    // is "Arm,Both" 0.4 — a different job than replacing the blades. Before the
    // per-rule row preference, first-row-wins returned 0.4 for a blade set.
    const wiperTable =
      `<div class="main"><table>` +
      `<tr><th>Applies To</th><th>Note</th><th>Standard Hours</th><th>Warranty Hours</th><th>Skill Level</th></tr>` +
      `<tr><td>Arm,Both</td><td></td><td>0.4</td><td></td><td>D</td></tr>` +
      `<tr><td>Arm,One Side</td><td></td><td>0.3</td><td></td><td>D</td></tr>` +
      `<tr><td>Blade,Both</td><td></td><td>0.3</td><td></td><td>D</td></tr>` +
      `<tr><td>Blade,One Side</td><td></td><td>0.2</td><td></td><td>D</td></tr>` +
      `</table></div>`;
    const rule = matchLemonLaborRule({ slug: "wiper_blade_replacement", name: "Wiper Blade Replacement (set)" });
    expect(rule?.rows).toBeDefined();
    expect(parseLaborLeafHours(wiperTable, rule!.rows!)).toBe(0.3);
    // Without the preference the table is ambiguous → withheld, never 0.4.
    expect(parseLaborLeafHours(wiperTable)).toBeNull();
  });
});

describe("parseLaborLeafHours", () => {
  const leaf = (rows: string) =>
    `<html><body><div class="main"><table>` +
    `<tr><th>Applies To</th><th>Note</th><th>Standard Hours</th><th>Warranty Hours</th><th>Skill Level</th></tr>` +
    rows +
    `</table></div><div class="theme-colors footer">junk</div></body></html>`;

  it("reads the Standard Hours column, not the first number on the row", () => {
    expect(parseLaborLeafHours(leaf("<tr><td>Gas</td><td></td><td>4.8</td><td>3.9</td><td>B</td></tr>"))).toBe(4.8);
  });

  it("skips leading rows with no usable value", () => {
    const rows =
      `<tr><td>Hybrid</td><td>see note</td><td>&nbsp;</td><td></td><td>C</td></tr>` +
      `<tr><td>Gas</td><td></td><td>0.70</td><td></td><td>C</td></tr>`;
    expect(parseLaborLeafHours(leaf(rows))).toBe(0.7);
  });

  it("returns null rather than a guess when the column or rows are missing", () => {
    expect(parseLaborLeafHours(leaf(""))).toBeNull();
    expect(
      parseLaborLeafHours(
        `<div class="main"><table><tr><th>Applies To</th><th>Skill Level</th></tr>` +
          `<tr><td>Gas</td><td>B</td></tr></table></div>`,
      ),
    ).toBeNull();
    expect(parseLaborLeafHours("")).toBeNull();
    expect(parseLaborLeafHours("<html><body>no table here</body></html>")).toBeNull();
  });

  it("falls back to a bare Hours header and rounds to two places", () => {
    const html =
      `<div class="main"><table><tr><th>Applies To</th><th>Hours</th></tr>` +
      `<tr><td>Gas</td><td>1.2345</td></tr></table></div>`;
    expect(parseLaborLeafHours(html)).toBe(1.23);
  });

  it("ignores non-positive hours", () => {
    expect(parseLaborLeafHours(leaf("<tr><td>Gas</td><td></td><td>0.0</td><td></td><td>B</td></tr>"))).toBeNull();
  });
});
