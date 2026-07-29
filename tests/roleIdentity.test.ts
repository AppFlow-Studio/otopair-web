/**
 * Role-identity lexicon (round 12) — component-identity verdicts per roleKey.
 *
 * Origin defect: 84257919, a battery ground extension CABLE, filled the
 * `battery` role on 2024_chevrolet_equinox_premier_lsd and survived eleven
 * rounds of gates (all fitment/provenance/format-oriented). These tests pin
 * the lexicon's judgment calls, including the deliberate soft spots:
 * require-miss never rejects, flag-mode roles never hard-reject, and titles
 * are the ONLY evidence consulted.
 */
import { describe, expect, it } from "vitest";
import {
  ROLE_IDENTITY_LEXICON,
  ROLEKEYS_BY_PART_SLUG,
  checkRoleIdentity,
  isCoreRoleKey,
} from "../convex/vehicleEnrichment/roleIdentity";
import { PART_FIELD_MAP } from "../convex/vehicleEnrichment/v3pipeline";

const verdictOf = (roleKey: string, title: string | null) =>
  checkRoleIdentity(roleKey, title).verdict;

describe("battery role — the Equinox 84257919 class", () => {
  it("rejects battery cables / ground extensions in the battery role", () => {
    for (const title of [
      "Battery Cable / Ground Extension - GM 84257919",
      "CABLE ASM-BAT NEG",
      "EXTENSION, BAT GRD",
      "Battery Positive Cable Harness",
      "Battery Ground Strap",
    ]) {
      const v = checkRoleIdentity("battery", title);
      expect(v, title).toMatchObject({ verdict: "reject", mode: "reject" });
    }
  });

  it("rejects battery-adjacent hardware (tray, hold-down, sensor, heat mat)", () => {
    for (const title of [
      "Battery Tray",
      "Battery Hold-Down Retainer",
      "Battery Current Sensor",
      "Battery Heat Blanket / Insulator",
      "Battery Hold Down Bolt",
    ]) {
      expect(verdictOf("battery", title), title).toBe("reject");
    }
  });

  it("still rejects everything the old round-11 regex caught (strict superset)", () => {
    for (const title of [
      "Telematics Communication Module Battery",
      "DCM Backup Battery",
      "Auxiliary Battery",
      "Key Fob Remote Battery CR2032",
      "Data Communication Module Battery",
    ]) {
      expect(verdictOf("battery", title), title).toBe("reject");
    }
  });

  it("passes real starter batteries, including non-English catalog spellings", () => {
    for (const title of [
      "ACDelco Gold 47AGM Battery",
      "2024 Chevrolet Equinox Battery, Group 47",
      "Batterie AGM 70Ah",
      "Interstate Battery Group Size H6",
    ]) {
      expect(verdictOf("battery", title), title).toBe("pass");
    }
  });

  it("a noun-free dealer title is require_miss (soft), never a reject", () => {
    expect(verdictOf("battery", "84257919 - GM Genuine Part")).toBe("require_miss");
  });

  it("terminal_protection keeps accepting terminal parts (flag-mode, no battery block)", () => {
    const v = checkRoleIdentity(
      "terminal_protection",
      "Battery Terminal Anti-Corrosion Washers",
    );
    expect(v.verdict).toBe("pass");
  });
});

describe("brake roles — pads vs rotors vs drums", () => {
  it('passes standard pad titles including the "Disc" trap and bundled sensors', () => {
    for (const title of [
      "Disc Brake Pad Set (Front)",
      "Front Disc Brake Pad Kit",
      "Brake Pad Set with Wear Sensor",
    ]) {
      expect(verdictOf("front_brake_pad", title), title).toBe("pass");
    }
  });

  it("rejects a rotor in a pad slot and a pad in a rotor slot", () => {
    expect(verdictOf("front_brake_pad", "Front Brake Rotor")).toBe("reject");
    expect(verdictOf("rear_rotor", "Disc Brake Pad Set")).toBe("reject");
  });

  it("passes rotors incl. drum-in-hat; rejects brake drums and adjacent hardware", () => {
    expect(verdictOf("front_rotor", "Disc Brake Rotor")).toBe("pass");
    expect(verdictOf("rear_rotor", "Brake Rotor (Drum-in-Hat)")).toBe("pass");
    expect(verdictOf("rear_rotor", "Brake Drum, Rear")).toBe("reject");
    expect(verdictOf("front_rotor", "Brake Dust Shield / Splash Guard")).toBe("reject");
    expect(verdictOf("front_brake_pad", "Brake Shoe Set")).toBe("reject");
  });
});

describe("filters, oil, plugs", () => {
  it("oil_filter: element passes, housing/cap hardware rejects", () => {
    expect(verdictOf("oil_filter", "Engine Oil Filter Element")).toBe("pass");
    expect(verdictOf("oil_filter", "Oil Filter Housing Cap")).toBe("reject");
    expect(verdictOf("oil_filter", "Oil Filter Cap Wrench 32mm")).toBe("reject");
  });

  it("engine_oil: grade-only titles pass, a filter in the oil slot rejects", () => {
    expect(verdictOf("engine_oil", "Mobil 1 5W-30 Full Synthetic")).toBe("pass");
    expect(verdictOf("engine_oil", "ACDelco dexos1 0W-20 Motor Oil")).toBe("pass");
    expect(verdictOf("engine_oil", "Engine Oil Filter")).toBe("reject");
  });

  it("air/cabin filter: element passes, housing/duct rejects", () => {
    expect(verdictOf("air_filter", "Air Cleaner Element")).toBe("pass");
    expect(verdictOf("air_filter", "Air Cleaner Housing Assembly")).toBe("reject");
    expect(verdictOf("cabin_filter", "Cabin Air Filter")).toBe("pass");
    expect(verdictOf("cabin_filter", "Blower Motor Resistor")).toBe("reject");
  });

  it("spark_plug: plugs pass; wires, boots, coils, glow plugs reject", () => {
    expect(verdictOf("spark_plug", "NGK Laser Iridium Spark Plug")).toBe("pass");
    expect(verdictOf("spark_plug", "Spark Plug Wire Set")).toBe("reject");
    expect(verdictOf("spark_plug", "Ignition Coil")).toBe("reject");
    expect(verdictOf("spark_plug", "Glow Plug (Diesel)")).toBe("reject");
  });
});

describe("fluids and belts", () => {
  it("coolant: antifreeze passes; hoses, thermostats, sensors reject", () => {
    expect(verdictOf("coolant", "Prestone 50/50 Antifreeze/Coolant")).toBe("pass");
    expect(verdictOf("coolant", "Radiator Coolant Hose, Upper")).toBe("reject");
    expect(verdictOf("coolant", "Engine Coolant Temperature Sensor")).toBe("reject");
  });

  it("atf_fluid: CVT/ATF fluids pass; filters and pan hardware reject", () => {
    expect(verdictOf("atf_fluid", "Subaru CVT Fluid High Torque")).toBe("pass");
    expect(verdictOf("atf_fluid", "Automatic Transmission Filter Kit")).toBe("reject");
  });

  it("timing_belt: belt passes; chain, kit, tensioner reject (kit belongs in timing_kit)", () => {
    expect(verdictOf("timing_belt", "Gates Timing Belt")).toBe("pass");
    expect(verdictOf("timing_belt", "Timing Chain")).toBe("reject");
    expect(verdictOf("timing_belt", "Timing Belt Kit with Water Pump")).toBe("reject");
  });

  it("serpentine_belt: belt passes; tensioner/idler reject", () => {
    expect(verdictOf("serpentine_belt", "Serpentine Belt")).toBe("pass");
    expect(verdictOf("serpentine_belt", "Belt Tensioner Assembly")).toBe("reject");
  });

  it("wipers: blades pass; arms/motors reject; washer FLUID is only a require-miss", () => {
    expect(verdictOf("wiper_blade_front_set", "Wiper Blade Set")).toBe("pass");
    expect(verdictOf("wiper_blade_front_set", "Wiper Arm, Driver Side")).toBe("reject");
    expect(verdictOf("wiper_blade_rear", "Windshield Washer Fluid")).toBe("require_miss");
  });
});

describe("flag-mode roles never hard-reject", () => {
  it("thermostat gasket in the thermostat slot is a flag-mode reject verdict", () => {
    const v = checkRoleIdentity("thermostat", "Thermostat Gasket");
    expect(v).toMatchObject({ verdict: "reject", mode: "flag" });
  });

  it("integrated-housing thermostats pass (housing deliberately unblocked)", () => {
    expect(verdictOf("thermostat", "Engine Coolant Thermostat Housing Assembly")).toBe(
      "pass",
    );
  });

  it("a bare drain PLUG in the gasket slot is flag-mode; plug+washer combos pass", () => {
    expect(checkRoleIdentity("drain_plug_gasket", "Oil Drain Plug M14")).toMatchObject({
      verdict: "reject",
      mode: "flag",
    });
    expect(verdictOf("drain_plug_gasket", "Drain Plug Gasket")).toBe("pass");
    expect(verdictOf("drain_plug_gasket", "Oil Drain Plug Washer")).toBe("pass");
  });
});

describe("fail-open verdicts and normalization", () => {
  it("no title / unknown role fail open with distinct verdicts", () => {
    expect(verdictOf("battery", null)).toBe("no_title");
    expect(verdictOf("battery", "   ")).toBe("no_title");
    expect(verdictOf("caliper_grease", "Anything")).toBe("unknown_role");
  });

  it("decodes HTML entities before matching", () => {
    expect(verdictOf("battery", "Battery Cable &amp; Bracket")).toBe("reject");
    expect(verdictOf("front_brake_pad", "Brake&nbsp;Pad&nbsp;Set")).toBe("pass");
  });
});

describe("coverage contracts", () => {
  it("every PART_FIELD_MAP subcategory has a lexicon entry", () => {
    for (const [fieldKey, meta] of Object.entries(PART_FIELD_MAP)) {
      expect(
        ROLE_IDENTITY_LEXICON[meta.subcategory],
        `${fieldKey} → subcategory "${meta.subcategory}" has no ROLE_IDENTITY_LEXICON entry — a wrong-component part in that slot is invisible to the gate`,
      ).toBeDefined();
    }
  });

  it("every registry search slug the scraper screens has a roleKeys mapping", () => {
    // The screen fails open for unmapped slugs, but the known slugs must map.
    for (const slug of [
      "battery",
      "brake_pads",
      "front_brake_pads",
      "rear_brake_pads",
      "brake_disc",
      "front_brake_rotor",
      "rear_brake_rotor",
      "oil_filter",
      "wiper_blade",
    ]) {
      expect(ROLEKEYS_BY_PART_SLUG[slug], slug).toBeDefined();
    }
    for (const [slug, roleKeys] of Object.entries(ROLEKEYS_BY_PART_SLUG)) {
      for (const rk of roleKeys) {
        expect(
          ROLE_IDENTITY_LEXICON[rk],
          `slug "${slug}" maps to roleKey "${rk}" with no lexicon entry`,
        ).toBeDefined();
      }
    }
  });

  it("isCoreRoleKey reflects SERVICE_PARTS_REFERENCE core roles", () => {
    expect(isCoreRoleKey("battery")).toBe(true);
    expect(isCoreRoleKey("front_brake_pad")).toBe(true);
    expect(isCoreRoleKey("terminal_protection")).toBe(false);
    expect(isCoreRoleKey("ignition_coil")).toBe(false);
    expect(isCoreRoleKey(null)).toBe(false);
  });
});
