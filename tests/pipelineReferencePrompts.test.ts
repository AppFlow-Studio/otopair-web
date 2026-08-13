/**
 * What the director panel's Pipeline tab actually shows.
 *
 * The tab used to render only the SYSTEM prompts, which carry none of the
 * per-field rules — every rotor instruction lives in the per-vehicle USER
 * message. It now renders the user message too, built by these same builders,
 * so these assertions are what keep that panel honest.
 *
 * Also pins the gap-fill carve-out: rotor DISCARD minimums must never be
 * askable through a contract that has no slot for the verbatim label.
 */
import { describe, expect, it } from "vitest";
import { buildBatch1Prompt } from "../convex/vehicleEnrichment/prompts/batch1Prompt";
import { buildBatch2Prompt } from "../convex/vehicleEnrichment/prompts/batch2Prompt";
import { buildGapFillPrompt } from "../convex/vehicleEnrichment/prompts/gapFillPrompt";
import { GAP_FILL_EXCLUDED_FIELDS } from "../convex/vehicleEnrichment/v3pipeline";
import { V4_FIELD_KEYS } from "../convex/vehicleEnrichment/types";
import type { VehicleIdentity, VehicleInput } from "../convex/vehicleEnrichment/types";

const VEHICLE: VehicleInput = {
  vehicleId: "sample",
  year: 2019,
  make: "Subaru",
  model: "Crosstrek",
  trim: "Premium",
  engineCode: "FB20",
  displacement: "2.0",
  cylinders: 4,
  fuelType: "Gasoline",
};

const VPIC: VehicleIdentity = {
  drivetrain: "AWD",
  turbo: false,
  transmission_type: "CVT",
  fuel_injection_type: "direct",
  timing_system: "chain",
  cylinders: 4,
  displacement_l: 2.0,
  fuel_type: "Gasoline",
  gvwr_lbs: 4400,
  engine_manufacturer: "Subaru",
  body_class: "SUV",
  engine_config: "Flat",
  make: "Subaru",
  model: "Crosstrek",
  model_year: 2019,
  plant_city: "Gunma",
  plant_country: "Japan",
};

const gapFillable = () =>
  V4_FIELD_KEYS.filter((k) => !GAP_FILL_EXCLUDED_FIELDS.has(k));

describe("Batch 1 user message — the rotor rules the Pipeline tab must show", () => {
  const prompt = buildBatch1Prompt(VEHICLE, VPIC, "", "", []);

  it("declares the rotor_specs output block", () => {
    expect(prompt).toContain('"rotor_specs"');
    expect(prompt).toContain('"thickness_kind"');
    expect(prompt).toContain('"observed_label"');
  });

  it("spells out all three numbers", () => {
    expect(prompt).toContain("THREE DIFFERENT NUMBERS");
    expect(prompt).toMatch(/NOMINAL/);
    expect(prompt).toMatch(/MACHINE-TO/);
    expect(prompt).toMatch(/DISCARD/);
  });

  it("warns that the first number of a size string is the diameter", () => {
    expect(prompt).toContain("DIAMETER");
    expect(prompt).toContain("330x22mm");
  });

  it("forbids promoting an unlabelled thickness to a minimum", () => {
    expect(prompt).toContain('NEVER "discard_min"');
  });

  it("forbids deriving one rotor number from another", () => {
    expect(prompt).toContain("NEVER derive one rotor number from another");
  });

  it("renders without scraped markdown, so the sample is safe to display", () => {
    expect(prompt).toContain("no scraped data available");
    expect(prompt.length).toBeGreaterThan(1000);
  });
});

describe("gap-fill carve-out", () => {
  it("excludes exactly the two rotor DISCARD minimums", () => {
    expect([...GAP_FILL_EXCLUDED_FIELDS].sort()).toEqual([
      "rotor_front_min_thickness_mm",
      "rotor_rear_min_thickness_mm",
    ]);
  });

  it("Batch 2 never asks for a minimum, but may ask for the nominal", () => {
    const prompt = buildBatch2Prompt(VEHICLE, gapFillable(), {});
    expect(prompt).not.toContain("rotor_front_min_thickness_mm");
    expect(prompt).not.toContain("rotor_rear_min_thickness_mm");
    expect(prompt).toContain("rotor_front_nominal_thickness_mm");
    expect(prompt).toContain("This is NOT a minimum");
  });

  it("the gap-fill re-ask inherits the same exclusion", () => {
    const prompt = buildGapFillPrompt(VEHICLE, gapFillable());
    expect(prompt).not.toContain("rotor_front_min_thickness_mm");
    expect(prompt).toContain("rotor_rear_nominal_thickness_mm");
  });

  it("the nominal fields are still in the registry — they are real data", () => {
    expect(V4_FIELD_KEYS).toContain("rotor_front_nominal_thickness_mm");
    expect(V4_FIELD_KEYS).toContain("rotor_front_min_thickness_mm");
  });
});
