import test from "node:test";
import assert from "node:assert/strict";

import {
  getMissingRequiredPassportFields,
  getVehiclePassportCompletionPercent,
  getVehicleUpdatePrompts,
  serviceLikelyUsesParts,
  type VehiclePassportData,
} from "./vehicle-passport.ts";

const basePassport: VehiclePassportData = {
  vin: "1ABCDEFGH12345678",
  vehicle_label: "2022 Toyota Camry",
  vehicle_short_label: "2022 T. Camry",
  service_name: "Oil change",
  service_slug: "oil-change",
  requires_parts: true,
  is_complete: true,
  completion_percent: 100,
  missing_fields: [],
  passport: {
    mileage: 34215,
    last_reported_at: 1713897600000,
    mileage_velocity: 1100,
    tires: {
      brand: "Michelin",
      model: "Pilot Sport",
      size_front: "215/55R17",
      size_rear: "215/55R17",
      run_flat: false,
      overall_condition: "good",
      front_condition: "good",
      rear_condition: "good",
      last_verified_at: 1713897600000,
    },
    fluids: {
      oil_viscosity: "0W-20",
      oil_type: "Full synthetic",
      coolant_type: "Toyota SLLC",
      brake_fluid_type: "DOT 3",
      transmission_fluid_type: "WS",
      confirmation_status: "updated",
    },
    brakes: {
      pad_brand: "Akebono",
      front_pad_mm: 9,
      rear_pad_mm: 8,
      rotor_condition: "good",
    },
    inspection: {
      looks_current: true,
      expires_at: "2026-12",
      status: "current",
    },
    modifications: {
      status: "none_observed",
      notes: null,
    },
  },
  usage: {
    driving_type: "Mostly local",
    ownership: "Owned",
  },
  recent_services: [],
  mechanic_notes: [],
  sources: {
    mileage: "verified",
    "tires.brand": "verified",
    "tires.model": "verified",
    "tires.size_front": "oem_default",
    "tires.size_rear": "oem_default",
    "tires.run_flat": "oem_default",
    "tires.overall_condition": "verified",
    "fluids.oil_viscosity": "verified",
    "fluids.oil_type": "verified",
    "fluids.coolant_type": "oem_default",
    "fluids.brake_fluid_type": "oem_default",
    "fluids.transmission_fluid_type": "oem_default",
  },
};

test("passport completeness drops when required fields are missing", () => {
  const percent = getVehiclePassportCompletionPercent({
    ...basePassport.passport,
    mileage: null,
    tires: {
      ...basePassport.passport.tires,
      brand: null,
      model: null,
      overall_condition: null,
    },
  });

  assert.equal(percent, 0);
});

test("passport completeness accepts valid tire condition enums", () => {
  const missing = getMissingRequiredPassportFields({
    ...basePassport.passport,
    tires: {
      ...basePassport.passport.tires,
      overall_condition: "replace_soon",
    },
  });

  assert.deepEqual(missing, []);
});

test("serviceLikelyUsesParts respects explicit flag", () => {
  assert.equal(serviceLikelyUsesParts("tire-rotation", true), true);
  assert.equal(serviceLikelyUsesParts("oil-change", false), false);
});

test("oil-change prompts include oil filter and oil fluid confirmations", () => {
  const prompts = getVehicleUpdatePrompts("oil-change", basePassport);

  assert.deepEqual(
    prompts.map((prompt) => prompt.key),
    ["oil_viscosity", "oil_type", "oil_filter_part_number"]
  );
});

test("tire services prompt for tire-specific passport fields", () => {
  const prompts = getVehicleUpdatePrompts("tire-rotation", basePassport);

  assert.ok(prompts.some((prompt) => prompt.key === "tire_brand"));
  assert.ok(prompts.some((prompt) => prompt.key === "run_flat"));
});
