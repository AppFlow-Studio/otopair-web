import { describe, expect, it } from "vitest";

import {
  classify,
  createInspectionState,
  deriveTierInspectionScope,
  derivePrejobFromInspection,
  deriveSuggestedRecommendations,
  formatZonesForPdf,
  gatherFindings,
  getDirtyIncompleteZones,
  INSPECTION_ZONES_BY_ID,
  isFieldRequiredForZone,
  patchInspectionZone,
  patchSharedInspectionText,
  requiredZonesForBooking,
  requiresRotorStampPhoto,
  rotorEvidenceCornersFromSubmission,
  specPrefillFromPassport,
  toggleInspectionTreadMode,
  validateZoneForCompletion,
  type InspectionState,
  type ZoneId,
} from "../lib/inspection-template";

function completeCorner(
  state: InspectionState,
  id: Extract<ZoneId, "FL" | "FR" | "RL" | "RR">,
  values: {
    tread: string;
    pad?: string;
    rotor?: string;
    rotorUnit?: "mm" | "in";
  },
) {
  const zone = state.zones[id]!;
  zone.done = true;
  zone.measures.tread = values.tread;
  zone.measures.pad = values.pad ?? "";
  zone.measures.rotor = values.rotor ?? "";
  zone.select.rotor_unit = values.rotorUnit ?? "mm";
}

describe("multi-point inspection requirements", () => {
  it("derives Tier 2 and Tier 3 scope from the booked service without consulting lift telemetry", () => {
    expect(
      deriveTierInspectionScope({
        serviceNames: ["Tire Rotation"],
        brakeScope: { hasBrakeWork: false, front: false, rear: false },
        liftStatus: "no",
      }),
    ).toMatchObject({
      tier2Corners: ["FL", "FR", "RL", "RR"],
      tier3AChecksRequired: false,
      tier3BCorners: ["FL", "FR", "RL", "RR"],
      bookingScopeError: null,
    });

    expect(
      deriveTierInspectionScope({
        serviceNames: ["Wheel Alignment"],
        brakeScope: { hasBrakeWork: false, front: false, rear: false },
        liftStatus: "no",
      }),
    ).toMatchObject({
      tier2Corners: [],
      tier3AChecksRequired: true,
      tier3BCorners: [],
    });
  });

  it("maps replacement positions and brake axles without defaulting missing brake scope to all corners", () => {
    expect(
      deriveTierInspectionScope({
        serviceNames: ["Tire Replacement"],
        tireReplacementPositions: ["FR", "RL"],
        brakeScope: { hasBrakeWork: false, front: false, rear: false },
      }).tier2Corners,
    ).toEqual(["FR", "RL"]);

    expect(
      deriveTierInspectionScope({
        serviceNames: ["Brake Pad Replacement"],
        brakeScope: { hasBrakeWork: true, front: true, rear: false },
      }).tier2Corners,
    ).toEqual(["FL", "FR"]);

    expect(
      deriveTierInspectionScope({
        serviceNames: ["Rotor Replacement"],
        brakeScope: { hasBrakeWork: true, front: false, rear: false },
      }).bookingScopeError,
    ).toContain("axle");
  });

  it("requires Tier 1 zones and fields on every visit while exempting only outgoing-tire checks", () => {
    expect(requiredZonesForBooking(["Oil Change"])).toEqual([
      "FL",
      "FR",
      "RL",
      "RR",
      "ENG",
      "FRT",
    ]);
    const context = {
      serviceNames: ["Tire Replacement"],
      brakeScope: { hasBrakeWork: false, front: false, rear: false },
      tireReplacementPositions: ["FR"] as const,
      isFirstShopVisit: false,
      priorTreadReadings: { FL: 6, FR: 6, RL: 6, RR: 6 },
    };
    expect(isFieldRequiredForZone("FR", "tread", context)).toBe(false);
    expect(isFieldRequiredForZone("FR", "psi", context)).toBe(false);
    expect(isFieldRequiredForZone("FR", "wear", context)).toBe(false);
    expect(isFieldRequiredForZone("FR", "brake_visual", context)).toBe(true);
    expect(isFieldRequiredForZone("FL", "tread", context)).toBe(true);
    expect(isFieldRequiredForZone("FL", "psi", context)).toBe(true);
    expect(isFieldRequiredForZone("FL", "wear", context)).toBe(true);
  });

  it("requires Tier 5 identity on a true first visit and later only when tread increased", () => {
    const state = createInspectionState();
    state.zones.FL!.measures.tread = "8";
    const laterContext = {
      serviceNames: ["Oil Change"],
      brakeScope: { hasBrakeWork: false, front: false, rear: false },
      isFirstShopVisit: false,
      priorTreadReadings: { FL: 6 },
      inspectionState: state,
    };
    for (const field of ["tire_brand", "tire_model", "tire_size", "run_flat"]) {
      expect(isFieldRequiredForZone("FL", field, laterContext)).toBe(true);
    }
    expect(
      isFieldRequiredForZone("FR", "tire_brand", {
        ...laterContext,
        isFirstShopVisit: true,
      }),
    ).toBe(true);
    expect(isFieldRequiredForZone("FR", "tire_brand", laterContext)).toBe(false);

    state.zones.FL!.statuses.tread = "not_visible";
    expect(isFieldRequiredForZone("FL", "tire_brand", laterContext)).toBe(false);
  });

  it("requires a tagged rotor-stamp photo only until permanent corner evidence exists", () => {
    const context = {
      serviceNames: ["Tire Rotation"],
      brakeScope: { hasBrakeWork: false, front: false, rear: false },
      rotorPhotoEvidence: { FL: false, FR: true },
    };
    const state = createInspectionState();
    expect(requiresRotorStampPhoto(state, "FL", context)).toBe(true);
    state.zones.FL!.photoIds.push("photo-1");
    state.zones.FL!.photoTags["photo-1"] = "rotor_stamp";
    expect(requiresRotorStampPhoto(state, "FL", context)).toBe(false);
    expect(requiresRotorStampPhoto(state, "FR", context)).toBe(false);
  });

  it("grants rotor evidence only for completed wheel-off corners with an attached tag", () => {
    const context = {
      serviceNames: ["Tire Replacement"],
      tireReplacementPositions: ["FL"] as const,
      brakeScope: { hasBrakeWork: false, front: false, rear: false },
      rotorPhotoEvidence: { FL: false },
    };
    const state = createInspectionState();
    state.zones.FL!.photoIds = ["photo-1"];
    state.zones.FL!.photoTags["photo-1"] = "rotor_stamp";
    expect(rotorEvidenceCornersFromSubmission(state, context)).toEqual([]);
    state.zones.FL!.done = true;
    expect(rotorEvidenceCornersFromSubmission(state, context)).toEqual(["FL"]);
    state.zones.FL!.select.rotor_applicable = "no";
    expect(rotorEvidenceCornersFromSubmission(state, context)).toEqual([]);
    state.zones.FL!.select.rotor_applicable = "yes";
    state.zones.FL!.photoIds = [];
    expect(rotorEvidenceCornersFromSubmission(state, context)).toEqual([]);
  });
  it("starts every inspection field blank with no implicit green ratings", () => {
    const state = createInspectionState();

    for (const zone of Object.values(state.zones)) {
      expect(zone?.tri).toEqual({});
      expect(Object.values(zone?.measures ?? {}).every((value) => value === "")).toBe(true);
      expect(Object.values(zone?.text ?? {}).every((value) => value === "")).toBe(true);
    }
  });

  it("does not confirm or replace optional passport data when nothing was entered", () => {
    const payload = derivePrejobFromInspection(createInspectionState(), {
      mileage: null,
    });

    expect(payload.fluids_match_oem).toBeUndefined();
    expect(payload.fluid_overrides).toBeNull();
    expect(payload.modifications).toBeNull();
  });

  it("keeps detailed tread readings in the local zone state when returning to shallowest-only mode", () => {
    const zone = createInspectionState().zones.FL!;
    zone.select.tread_mode = "detailed";
    zone.measures = {
      ...zone.measures,
      tread: "4",
      tread_inner: "6",
      tread_center: "4",
      tread_outer: "5",
    };

    const patch = toggleInspectionTreadMode(zone);

    expect(patch.select?.tread_mode).toBe("");
    expect(patch.measures).toMatchObject({
      tread_inner: "6",
      tread_center: "4",
      tread_outer: "5",
    });
  });

  it("restores the shallowest reading when returning to detailed tread mode", () => {
    const zone = createInspectionState().zones.FL!;
    zone.measures = {
      ...zone.measures,
      tread_inner: "6",
      tread_center: "4",
      tread_outer: "5",
    };

    const patch = toggleInspectionTreadMode(zone);

    expect(patch.select?.tread_mode).toBe("detailed");
    expect(patch.measures?.tread).toBe("4");
  });

  it("requires the Tier 1 zones on every service and adds Underbody for alignment", () => {
    expect(requiredZonesForBooking(["Oil Change"])).toEqual([
      "FL", "FR", "RL", "RR", "ENG", "FRT",
    ]);
    expect(requiredZonesForBooking(["Tire Rotation"])).toEqual([
      "FL", "FR", "RL", "RR", "ENG", "FRT",
    ]);
    expect(requiredZonesForBooking(["Wheel Alignment"])).toEqual([
      "FL", "FR", "RL", "RR", "ENG", "UND", "FRT",
    ]);
  });

  it("labels a rotor at the reference as in spec but near the minimum", () => {
    expect(classify("rotor", "23.0", 23)).toEqual({
      lvl: "warn",
      txt: "In spec · near min",
    });
    expect(classify("rotor", "23.99", 23)).toEqual({
      lvl: "warn",
      txt: "In spec · near min",
    });
    expect(classify("rotor", "24", 23)).toEqual({
      lvl: "ok",
      txt: "In spec",
    });
    expect(classify("rotor", "22.99", 23)).toEqual({
      lvl: "bad",
      txt: "Below min",
    });
  });

  it("classifies an inch rotor reading against the millimeter reference", () => {
    const state = createInspectionState();
    const zone = state.zones.FL!;
    zone.done = true;
    zone.measures.rotor = "0.906";
    zone.select.rotor_unit = "in";

    expect(gatherFindings(state, { onlyCompletedZones: true }).monitor).toContainEqual({
      label: "Brake rotor thickness · In spec · near min",
      zone: "Front-left corner",
    });
    expect(
      deriveSuggestedRecommendations(state, { onlyCompletedZones: true }).find(
        (recommendation) => recommendation.key === "rotor_replacement",
      )?.reasons.join(" "),
    ).toContain("23.01mm");
  });

  it("matches field requirements to the server's booking scope", () => {
    const oilContext = {
      serviceNames: ["Oil Change"],
      brakeScope: { hasBrakeWork: false, front: false, rear: false },
    };
    const frontBrakeContext = {
      serviceNames: ["Brake Pad Replacement"],
      brakeScope: { hasBrakeWork: true, front: true, rear: false },
    };

    const tireContext = {
      serviceNames: ["Tire Rotation"],
      brakeScope: { hasBrakeWork: false, front: false, rear: false },
      isFirstShopVisit: true,
    };

    expect(isFieldRequiredForZone("FR", "tire_brand", oilContext)).toBe(false);
    expect(isFieldRequiredForZone("FR", "tire_size", oilContext)).toBe(false);
    expect(isFieldRequiredForZone("FR", "tire_brand", tireContext)).toBe(true);
    expect(isFieldRequiredForZone("FR", "psi", tireContext)).toBe(true);
    expect(isFieldRequiredForZone("FR", "pad_inner", oilContext)).toBe(false);
    expect(isFieldRequiredForZone("FR", "pad_inner", frontBrakeContext)).toBe(true);
    expect(isFieldRequiredForZone("RR", "pad_inner", frontBrakeContext)).toBe(false);
    expect(isFieldRequiredForZone("FR", "psi", frontBrakeContext)).toBe(true);
    expect(isFieldRequiredForZone("ENG", "oil_viscosity", oilContext)).toBe(true);
    expect(isFieldRequiredForZone("ENG", "oil_type", oilContext)).toBe(true);
    expect(
      isFieldRequiredForZone("ENG", "coolant_type", {
        serviceNames: ["Coolant Flush"],
        brakeScope: { hasBrakeWork: false, front: false, rear: false },
      }),
    ).toBe(true);
    expect(
      isFieldRequiredForZone("ENG", "af", {
        serviceNames: ["Engine Air Filter"],
        brakeScope: { hasBrakeWork: false, front: false, rear: false },
      }),
    ).toBe(false);
  });

  it("requires Battery & electrical readings before completing a Battery Test", () => {
    const context = {
      serviceNames: ["Battery Test"],
      brakeScope: { hasBrakeWork: false, front: false, rear: false },
    };

    expect(isFieldRequiredForZone("ENG", "batt", context)).toBe(true);
    expect(isFieldRequiredForZone("ENG", "term", context)).toBe(true);
    const state = createInspectionState();
    for (const key of [
      "oil_condition",
      "oil_level",
      "cool_condition",
      "cool_level",
      "bf_level",
      "bf_leak",
      "bf_condition",
      "washer",
      "warning_lights",
      "term",
    ]) {
      state.zones.ENG!.statuses[key] = "not_inspected";
    }
    expect(validateZoneForCompletion(state, "ENG", context)).toEqual({
      valid: false,
      fieldKey: "batt",
      error: "Battery load test is required.",
    });
  });

  it("waives outgoing-tire checks only at booked replacement corners", () => {
    const context = {
      serviceNames: ["Tire Replacement"],
      brakeScope: { hasBrakeWork: false, front: false, rear: false },
      tireReplacementPositions: ["FR"] as const,
    };

    expect(isFieldRequiredForZone("FR", "tread", context)).toBe(false);
    expect(isFieldRequiredForZone("FR", "wear", context)).toBe(false);
    expect(isFieldRequiredForZone("FR", "tire_brand", context)).toBe(false);
    expect(isFieldRequiredForZone("FR", "tire_size", context)).toBe(false);
    expect(isFieldRequiredForZone("FL", "tread", context)).toBe(true);
  });

  it("completes a replacement corner without outgoing-tire readings after its wheel-off checks", () => {
    const state = createInspectionState();
    const zone = state.zones.FR!;
    zone.tri.brake_visual = "g";
    zone.measures.pad_inner = "6";
    zone.measures.pad_outer = "7";
    zone.select.pad_method = "gauge";
    zone.select.rotor_applicable = "yes";
    zone.measures.rotor = "24";
    zone.select.rotor_tool = "micrometer";
    zone.text.rotor_stamp = "MIN TH 23 MM";
    zone.descriptors.desc = ["none"];
    zone.tri.caliper = "g";
    zone.tri.brake_hose = "g";
    zone.text.pad_brand = "Akebono";
    zone.tri.steering_play = "g";
    zone.tri.ball_joint_play = "g";
    zone.tri.wheel_bearing_play = "g";
    zone.photoIds.push("photo-1");
    zone.photoTags["photo-1"] = "rotor_stamp";

    expect(
      validateZoneForCompletion(state, "FR", {
        serviceNames: ["Tire Replacement"],
        brakeScope: { hasBrakeWork: false, front: false, rear: false },
        tireReplacementPositions: ["FR"],
      }),
    ).toEqual({ valid: true });
  });

  it("requires tire condition on a corner that is not being replaced", () => {
    const state = createInspectionState();
    state.zones.FL!.measures.tread = "7";
    state.zones.FL!.measures.psi = "32";
    state.zones.FL!.text.tire_brand = "michelin";
    state.zones.FL!.text.tire_size = "225/45R18";

    expect(
      validateZoneForCompletion(state, "FL", {
        serviceNames: ["Tire Replacement"],
        brakeScope: { hasBrakeWork: false, front: false, rear: false },
        tireReplacementPositions: ["FR"],
      }),
    ).toEqual({
      valid: false,
      fieldKey: "wear",
      error: "Tire wear / overall condition is required.",
    });
  });

  it("rejects conflicting installed tire sizes on the same axle", () => {
    const state = createInspectionState();
    state.zones.FL!.text.tire_size = "225/45R18";
    state.zones.FR!.text.tire_size = "235/45R18";
    for (const key of ["tread", "psi", "wear", "brake_visual"]) {
      state.zones.FL!.statuses[key] = "not_inspected";
    }

    expect(
      validateZoneForCompletion(state, "FL", {
        serviceNames: ["Oil Change"],
        brakeScope: { hasBrakeWork: false, front: false, rear: false },
        isFirstShopVisit: false,
        inspectionState: state,
      }),
    ).toEqual({
      valid: false,
      fieldKey: "tire_size",
      error: "Installed tire sizes must match within the axle.",
    });
  });

  it("rejects select, measurement-method, and descriptor values outside the template", () => {
    const state = createInspectionState();
    const zone = state.zones.FL!;
    for (const key of ["tread", "psi", "wear", "brake_visual"]) {
      zone.statuses[key] = "not_inspected";
    }
    zone.select.run_flat = "sometimes";
    expect(
      validateZoneForCompletion(state, "FL", {
        serviceNames: ["Oil Change"],
        brakeScope: { hasBrakeWork: false, front: false, rear: false },
        isFirstShopVisit: false,
      }),
    ).toMatchObject({ valid: false, fieldKey: "run_flat" });

    zone.select.run_flat = "";
    zone.methods.pad_method = "guess";
    expect(
      validateZoneForCompletion(state, "FL", {
        serviceNames: ["Oil Change"],
        brakeScope: { hasBrakeWork: false, front: false, rear: false },
        isFirstShopVisit: false,
      }),
    ).toMatchObject({ valid: false, fieldKey: "pad_method" });

    zone.methods.pad_method = "";
    zone.descriptors.desc = ["cracked-in-half"];
    expect(
      validateZoneForCompletion(state, "FL", {
        serviceNames: ["Oil Change"],
        brakeScope: { hasBrakeWork: false, front: false, rear: false },
        isFirstShopVisit: false,
      }),
    ).toMatchObject({ valid: false, fieldKey: "desc" });
  });

  it("rejects a partial detailed tread measurement when completing a zone", () => {
    const state = createInspectionState();
    const zone = state.zones.FL!;
    zone.text.tire_brand = "michelin";
    zone.text.tire_size = "225/45R18";
    zone.select.tread_mode = "detailed";
    zone.measures.tread_inner = "7";
    zone.measures.tread_center = "6";

    expect(
      validateZoneForCompletion(state, "FL", {
        serviceNames: ["Oil Change"],
        brakeScope: { hasBrakeWork: false, front: false, rear: false },
      }),
    ).toEqual({
      valid: false,
      fieldKey: "tread_outer",
      error: "Enter inner, center, and outer tread readings.",
    });
  });

  it("accepts valid brake-scoped corners and rejects invalid supplied optional values", () => {
    const state = createInspectionState();
    const zone = state.zones.FL!;
    zone.measures.tread = "7";
    zone.measures.psi = "32";
    zone.measures.pad_inner = "6";
    zone.measures.pad_outer = "7";
    zone.measures.rotor = "23";
    zone.tri.wear = "g";
    zone.tri.brake_visual = "g";
    zone.select.pad_method = "gauge";
    zone.select.rotor_applicable = "yes";
    zone.select.rotor_tool = "micrometer";
    zone.text.rotor_stamp = "MIN TH 23 MM";
    zone.descriptors.desc = ["none"];
    zone.tri.caliper = "g";
    zone.tri.brake_hose = "g";
    zone.text.pad_brand = "Akebono";
    zone.tri.steering_play = "g";
    zone.tri.ball_joint_play = "g";
    zone.tri.wheel_bearing_play = "g";
    const context = {
      serviceNames: ["Brake Pad Replacement"],
      brakeScope: { hasBrakeWork: true, front: true, rear: false },
      rotorPhotoEvidence: { FL: true },
    };
    expect(validateZoneForCompletion(state, "FL", context)).toEqual({
      valid: true,
    });

    state.zones.ENG!.measures.batt = "-1";
    for (const key of [
      "oil_condition",
      "oil_level",
      "cool_condition",
      "cool_level",
      "bf_level",
      "bf_leak",
      "bf_condition",
      "washer",
      "warning_lights",
      "term",
    ]) {
      state.zones.ENG!.statuses[key] = "not_inspected";
    }
    expect(validateZoneForCompletion(state, "ENG", context)).toEqual({
      valid: false,
      fieldKey: "batt",
      error: "Battery load test must be a valid number.",
    });
  });

  it("requires reconfirmation after any completed-zone edit", () => {
    const state = createInspectionState();
    state.zones.FL!.done = true;

    const edited = patchInspectionZone(state, "FL", {
      measures: { ...state.zones.FL!.measures, tread: "8" },
    });
    expect(edited.zones.FL!.done).toBe(false);
    expect(getDirtyIncompleteZones(edited)).toEqual(["FL"]);

    const confirmed = patchInspectionZone(edited, "FL", { done: true });
    expect(confirmed.zones.FL!.done).toBe(true);
    expect(getDirtyIncompleteZones(confirmed)).toEqual([]);
  });

  it("does not treat hydrated or shared prefill as an unconfirmed user edit", () => {
    const state = createInspectionState();
    state.zones.FL!.text.tire_brand = "michelin";
    state.zones.FR!.text.tire_brand = "michelin";

    expect(getDirtyIncompleteZones(state)).toEqual([]);
  });

  it("shares axle tire sizes but keeps tire brands in their entered corner", () => {
    const state = createInspectionState();
    state.zones.FL!.done = true;

    const withSize = patchSharedInspectionText(
      state,
      "FR",
      "tire_size",
      "225/45R18",
    );
    expect(withSize.zones.FL!.text.tire_size).toBe("225/45R18");
    expect(withSize.zones.FR!.text.tire_size).toBe("225/45R18");
    expect(withSize.zones.RL!.text.tire_size).toBe("");
    expect(withSize.zones.FL!.done).toBe(false);
    expect(withSize.zones.FL!.dirty).toBe(true);
    expect(withSize.zones.FR!.dirty).toBe(true);
    expect(withSize.zones.RL!.dirty).toBe(false);

    const withBrand = patchSharedInspectionText(
      createInspectionState(),
      "RR",
      "tire_brand",
      "michelin",
    );
    expect(
      ["FL", "FR", "RL", "RR"].map(
        (id) => withBrand.zones[id as ZoneId]!.text.tire_brand,
      ),
    ).toEqual(["", "", "", "michelin"]);
  });

  it("shows the shared tire and brake metadata once in every corner", () => {
    for (const id of ["FL", "FR", "RL", "RR"] as const) {
      const fields = INSPECTION_ZONES_BY_ID[id].fields;
      expect(fields.map((field) => field.key)).toEqual([
        "tread",
        "psi",
        "wear",
        "tire_brand",
        "tire_model",
        "tire_size",
        "run_flat",
        "brake_visual",
        "pad_inner",
        "pad_outer",
        "pad_method",
        "rotor_applicable",
        "rotor",
        "rotor_tool",
        "rotor_stamp",
        "desc",
        "caliper",
        "brake_hose",
        "pad_brand",
        "steering_play",
        "ball_joint_play",
        "wheel_bearing_play",
      ]);
      expect(
        fields
          .map((field) => field.section)
          .filter((section, index, sections) => section !== sections[index - 1]),
      ).toEqual([
        "Tire",
        "Brakes · visual",
        "Brakes · wheel off",
        "Lift · wheel off",
      ]);
    }
  });
});

describe("multi-point inspection payload derivation", () => {
  it("excludes unconfirmed zones from the PDF rows", () => {
    expect(
      formatZonesForPdf([
        {
          zone_id: "FL",
          done: false,
          measures: { tread: "2" },
          tri: { wear: "r" },
        },
      ]),
    ).toEqual([]);
  });

  it("prints unavailable statuses distinctly instead of treating them as green", () => {
    expect(
      formatZonesForPdf([
        {
          zone_id: "FRT",
          done: true,
          statuses: { lamp: "not_visible", glass: "not_inspected", horn: "not_applicable" },
        },
      ])[0]?.rows,
    ).toEqual([
      { label: "Headlights / hazards / tail", value: "Not visible", grade: "none" },
      { label: "Windshield — chips / cracks", value: "Not inspected", grade: "none" },
      { label: "Horn", value: "N/A", grade: "none" },
    ]);
  });

  it("emits all structured tread and rotor readings from completed corners", () => {
    const state = createInspectionState();
    completeCorner(state, "FL", {
      tread: "8",
      pad: "7",
      rotor: "1.000",
      rotorUnit: "in",
    });
    completeCorner(state, "FR", {
      tread: "7",
      pad: "6",
      rotor: "25.4",
    });
    completeCorner(state, "RL", {
      tread: "6",
      pad: "5",
      rotor: "10",
    });
    completeCorner(state, "RR", {
      tread: "5",
      pad: "4",
      rotor: "9",
    });
    state.zones.FL!.text.tire_brand = "michelin";
    state.zones.FL!.text.tire_model = "defender";
    state.zones.FR!.text.tire_brand = "goodyear";
    state.zones.FR!.text.tire_model = "assurance";
    state.zones.RL!.text.tire_brand = "continental";
    state.zones.RL!.text.tire_model = "truecontact";
    state.zones.RR!.text.tire_brand = "bridgestone";
    state.zones.RR!.text.tire_model = "turanza";
    state.zones.FL!.text.tire_size = "225/45R18";
    state.zones.RL!.text.tire_size = "245/40R18";

    const payload = derivePrejobFromInspection(state, { mileage: 45_000 });

    expect(payload.tire_tread).toEqual({
      front_left: { reported_min_32nds: 8 },
      front_right: { reported_min_32nds: 7 },
      rear_left: { reported_min_32nds: 6 },
      rear_right: { reported_min_32nds: 5 },
    });
    expect(payload.brakes?.rotor_thickness).toEqual({
      front_left: {
        entered_value: 1,
        entered_unit: "in",
        normalized_um: 25_400,
      },
      front_right: {
        entered_value: 25.4,
        entered_unit: "mm",
        normalized_um: 25_400,
      },
      rear_left: {
        entered_value: 10,
        entered_unit: "mm",
        normalized_um: 10_000,
      },
      rear_right: {
        entered_value: 9,
        entered_unit: "mm",
        normalized_um: 9_000,
      },
    });
    expect(payload.tire_details).toEqual({
      front_left: { brand: "michelin", model: "defender" },
      front_right: { brand: "goodyear", model: "assurance" },
      rear_left: { brand: "continental", model: "truecontact" },
      rear_right: { brand: "bridgestone", model: "turanza" },
    });
  });

  it("derives the reported tread from complete inner, center, and outer readings", () => {
    const state = createInspectionState();
    completeCorner(state, "FL", { tread: "6" });
    state.zones.FL!.select.tread_mode = "detailed";
    state.zones.FL!.measures.tread_inner = "7";
    state.zones.FL!.measures.tread_center = "6";
    state.zones.FL!.measures.tread_outer = "8";

    const payload = derivePrejobFromInspection(state, { mileage: 45_000 });

    expect(payload.tire_tread?.front_left).toEqual({
      reported_min_32nds: 6,
      inner_32nds: 7,
      center_32nds: 6,
      outer_32nds: 8,
    });
  });

  it("does not derive findings or measurements from an unconfirmed zone", () => {
    const state = createInspectionState();
    const zone = state.zones.FL!;
    zone.done = false;
    zone.measures.tread = "2";
    zone.measures.pad = "2";
    zone.measures.rotor = "20";
    zone.tri.wear = "r";

    const payload = derivePrejobFromInspection(state, { mileage: 45_000 });

    expect(payload.tire_tread?.front_left).toBeUndefined();
    expect(payload.brakes).toBeNull();
    expect(payload.front_tire_condition).toBeNull();
  });

  it("does not derive stale values hidden by an unavailable status", () => {
    const state = createInspectionState();
    const zone = state.zones.FL!;
    zone.done = true;
    zone.measures.tread = "8";
    zone.measures.rotor = "24";
    zone.tri.wear = "r";
    zone.statuses.tread = "not_visible";
    zone.statuses.rotor = "not_visible";
    zone.statuses.wear = "not_inspected";

    const payload = derivePrejobFromInspection(state, { mileage: 45_000 });

    expect(payload.tire_tread?.front_left).toBeUndefined();
    expect(payload.brakes).toBeNull();
    expect(payload.front_tire_condition).toBeNull();
  });

  it("does not derive tier-scoped values outside the booking trigger", () => {
    const state = createInspectionState();
    const zone = state.zones.FL!;
    zone.done = true;
    zone.text.tire_brand = "Michelin";
    zone.measures.pad_inner = "8";
    zone.measures.pad_outer = "7";
    zone.measures.rotor = "24";

    const payload = derivePrejobFromInspection(state, {
      mileage: 45_000,
      completionContext: {
        serviceNames: ["Oil Change"],
        brakeScope: { hasBrakeWork: false, front: false, rear: false },
        isFirstShopVisit: false,
        inspectionState: state,
      },
    });

    expect(payload.tire_details).toBeNull();
    expect(payload.brakes).toBeNull();
  });

  it("derives legacy axle pad thickness from the shallowest inner or outer reading", () => {
    const state = createInspectionState();
    state.zones.FL!.done = true;
    state.zones.FL!.measures.pad_inner = "7";
    state.zones.FL!.measures.pad_outer = "5";
    state.zones.FR!.done = true;
    state.zones.FR!.measures.pad_inner = "6";
    state.zones.FR!.measures.pad_outer = "8";

    expect(derivePrejobFromInspection(state, { mileage: 45_000 }).brakes?.front_pad_mm).toBe(5);
  });

  it("does not recommend a filter from a stale unavailable rating", () => {
    const state = createInspectionState();
    state.zones.ENG!.done = true;
    state.zones.ENG!.tri.af = "r";
    state.zones.ENG!.statuses.af = "not_visible";

    expect(
      deriveSuggestedRecommendations(state, { onlyCompletedZones: true }).find(
        (recommendation) => recommendation.key === "filter",
      ),
    ).toBeUndefined();
    expect(
      derivePrejobFromInspection(state, { mileage: 45_000 }).filters,
    ).toEqual({ engine_air_filter: "not_checked", cabin_air_filter: null });
  });
});

describe("specPrefillFromPassport", () => {
  it("seeds ENG fluid specs into the text bucket so the type:'text' fields render them", () => {
    // Regression: these entries were bucketed "select" while the ENG fields
    // render from zs.text, so every enriched fluid spec (oil viscosity,
    // coolant, brake fluid, ATF) rendered blank on a first visit even though
    // the passport carried the value.
    const passport = {
      tires: {},
      brakes: {},
      fluids: {
        oil_viscosity: "0W-16",
        coolant_type: "Toyota Super Long Life Coolant (SLLC) / Pink",
        brake_fluid_type: "DOT 3",
        transmission_fluid_type: "Toyota Genuine ATF WS",
      },
    } as never;

    const eng = specPrefillFromPassport(passport, null).ENG ?? [];
    const byKey = Object.fromEntries(eng.map((e) => [e.fieldKey, e]));

    expect(byKey.coolant_type?.value).toBe(
      "Toyota Super Long Life Coolant (SLLC) / Pink",
    );
    expect(byKey.oil_viscosity?.value).toBe("0W-16");
    // A "select" bucket here silently blanks the field — every ENG spec must
    // land in the text bucket the fields read from.
    expect(eng.every((e) => e.bucket === "text")).toBe(true);
  });
});
