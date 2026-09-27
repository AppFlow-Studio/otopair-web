import { describe, expect, it } from "vitest";

import {
  canMarkFieldUnavailable,
  completeInspectionPhaseForDevelopment,
  cornerCopyPatch,
  classify,
  createInspectionState,
  deriveStateInspectionFailures,
  deriveTierInspectionScope,
  derivePrejobFromInspection,
  deriveSuggestedRecommendations,
  effectiveRotorRef,
  isNysSafetyField,
  SERVICE_SLUGS,
  formatZonesForPdf,
  gatherFindings,
  getDirtyIncompleteZones,
  INSPECTION_ZONES,
  INSPECTION_ZONES_BY_ID,
  isFieldApplicableToZone,
  isFieldRequiredForZone,
  isZoneDoneForPhase,
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
        phase: "mpi" as const,
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
        phase: "mpi" as const,
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
        phase: "mpi" as const,
      }).tier2Corners,
    ).toEqual(["FR", "RL"]);

    expect(
      deriveTierInspectionScope({
        serviceNames: ["Brake Pad Replacement"],
        brakeScope: { hasBrakeWork: true, front: true, rear: false },
        phase: "mpi" as const,
      }).tier2Corners,
    ).toEqual(["FL", "FR"]);

    expect(
      deriveTierInspectionScope({
        serviceNames: ["Rotor Replacement"],
        brakeScope: { hasBrakeWork: true, front: false, rear: false },
        phase: "mpi" as const,
      }).bookingScopeError,
    ).toContain("axle");
  });

  it("requires Tier 1 zones and fields on every visit while exempting only outgoing-tire checks", () => {
    expect(
      requiredZonesForBooking({
        serviceNames: ["Oil Change"],
        phase: "pre",
        brakeScope: { hasBrakeWork: false, front: false, rear: false },
      }),
    ).toEqual(["FL", "FR", "RL", "RR", "ENG", "FRT"]);
    const context = {
      serviceNames: ["Tire Replacement"],
      brakeScope: { hasBrakeWork: false, front: false, rear: false },
      phase: "pre" as const,
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
      phase: "pre" as const,
      isFirstShopVisit: false,
      priorTreadReadings: { FL: 6 },
      inspectionState: state,
    };
    for (const field of ["tire_size", "run_flat"]) {
      expect(isFieldRequiredForZone("FL", field, laterContext)).toBe(true);
    }
    expect(
      isFieldRequiredForZone("FR", "tire_size", {
        ...laterContext,
        isFirstShopVisit: true,
      }),
    ).toBe(true);
    expect(isFieldRequiredForZone("FR", "tire_size", laterContext)).toBe(false);

    state.zones.FL!.statuses.tread = "not_visible";
    expect(isFieldRequiredForZone("FL", "tire_size", laterContext)).toBe(false);
  });

  it("offers brand, model and type on a Tier 5 corner without requiring them", () => {
    // Decision D3 — mechanics don't record brand/model unless the car is
    // high-end, and many shops fit no-name stock. They stay visible so the data
    // can be captured, but never block zone completion.
    const state = createInspectionState();
    state.zones.FL!.measures.tread = "8";
    const tier5Context = {
      serviceNames: ["Oil Change"],
      brakeScope: { hasBrakeWork: false, front: false, rear: false },
      phase: "pre" as const,
      isFirstShopVisit: true,
      inspectionState: state,
    };
    for (const field of ["tire_brand", "tire_model", "tire_type"]) {
      expect(isFieldApplicableToZone("FL", field, tier5Context)).toBe(true);
      expect(isFieldRequiredForZone("FL", field, tier5Context)).toBe(false);
    }
    // The fitment-defining half is still mandatory.
    expect(isFieldRequiredForZone("FL", "tire_size", tier5Context)).toBe(true);

    // And the optional fields disappear with the rest of the block when the
    // Tier 5 gate is shut — "not required" must not mean "always rendered".
    const noTier5 = { ...tier5Context, isFirstShopVisit: false };
    expect(isFieldApplicableToZone("FL", "tire_brand", noTier5)).toBe(false);
  });

  it("requires a tagged rotor-stamp photo only until permanent corner evidence exists", () => {
    const context = {
      serviceNames: ["Tire Rotation"],
      brakeScope: { hasBrakeWork: false, front: false, rear: false },
      phase: "mpi" as const,
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
      phase: "mpi" as const,
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
    const zones = (serviceNames: string[], phase: "pre" | "mpi") =>
      requiredZonesForBooking({
        serviceNames,
        phase,
        brakeScope: { hasBrakeWork: false, front: false, rear: false },
      });

    // The pre-check is the same walkaround for every booking: four corners for
    // tread and pressure, the engine bay, the front lights/glass/wipers.
    expect(zones(["Oil Change"], "pre")).toEqual([
      "FL", "FR", "RL", "RR", "ENG", "FRT",
    ]);
    expect(zones(["Tire Rotation"], "pre")).toEqual([
      "FL", "FR", "RL", "RR", "ENG", "FRT",
    ]);
    // Underbody is wholly on-lift, so it never gates the pre-check — not even
    // for the alignment that makes it required.
    expect(zones(["Wheel Alignment"], "pre")).toEqual([
      "FL", "FR", "RL", "RR", "ENG", "FRT",
    ]);

    // The MPI half demands only what actually needs the car in the air. An oil
    // change never lifts a wheel, so it adds no second gate at all.
    expect(zones(["Oil Change"], "mpi")).toEqual([]);
    // A rotation takes all four wheels off, so all four corners come back.
    expect(zones(["Tire Rotation"], "mpi")).toEqual(["FL", "FR", "RL", "RR"]);
    // An alignment doesn't pull wheels, but it does put the car up.
    expect(zones(["Wheel Alignment"], "mpi")).toEqual(["UND"]);
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
      phase: "pre" as const,
      brakeScope: { hasBrakeWork: false, front: false, rear: false },
    };
    // Same booking seen from both halves — the tire rows are asked on the
    // ground, the pad rows only once the wheel is off.
    const frontBrakePre = {
      serviceNames: ["Brake Pad Replacement"],
      phase: "pre" as const,
      brakeScope: { hasBrakeWork: true, front: true, rear: false },
    };
    const frontBrakeContext = { ...frontBrakePre, phase: "mpi" as const };

    const tireContext = {
      serviceNames: ["Tire Rotation"],
      brakeScope: { hasBrakeWork: false, front: false, rear: false },
      phase: "pre" as const,
      isFirstShopVisit: true,
    };

    expect(isFieldRequiredForZone("FR", "tire_brand", oilContext)).toBe(false);
    expect(isFieldRequiredForZone("FR", "tire_size", oilContext)).toBe(false);
    // tire_size, not tire_brand — brand is optional identity since D3.
    expect(isFieldRequiredForZone("FR", "tire_size", tireContext)).toBe(true);
    expect(isFieldRequiredForZone("FR", "psi", tireContext)).toBe(true);
    expect(isFieldRequiredForZone("FR", "pad_inner", oilContext)).toBe(false);
    expect(isFieldRequiredForZone("FR", "pad_inner", frontBrakeContext)).toBe(true);
    expect(isFieldRequiredForZone("RR", "pad_inner", frontBrakeContext)).toBe(false);
    // ...and never before the job starts, however the booking is scoped.
    expect(isFieldRequiredForZone("FR", "pad_inner", frontBrakePre)).toBe(false);
    expect(isFieldRequiredForZone("FR", "psi", frontBrakePre)).toBe(true);
    expect(isFieldRequiredForZone("ENG", "oil_viscosity", oilContext)).toBe(true);
    expect(isFieldRequiredForZone("ENG", "oil_type", oilContext)).toBe(true);
    expect(
      isFieldRequiredForZone("ENG", "coolant_type", {
        serviceNames: ["Coolant Flush"],
        brakeScope: { hasBrakeWork: false, front: false, rear: false },
        phase: "pre" as const,
      }),
    ).toBe(true);
    expect(
      isFieldRequiredForZone("ENG", "af", {
        serviceNames: ["Engine Air Filter"],
        brakeScope: { hasBrakeWork: false, front: false, rear: false },
        phase: "pre" as const,
      }),
    ).toBe(false);
  });

  it("requires Battery & electrical readings before completing a Battery Test", () => {
    // Split across both halves: corrosion on the terminals is visible with the
    // hood up, but a load test needs a tester, so it waits for the MPI half.
    const preContext = {
      serviceNames: ["Battery Test"],
      phase: "pre" as const,
      brakeScope: { hasBrakeWork: false, front: false, rear: false },
    };
    const context = { ...preContext, phase: "mpi" as const };

    expect(isFieldRequiredForZone("ENG", "batt", context)).toBe(true);
    expect(isFieldRequiredForZone("ENG", "batt", preContext)).toBe(false);
    expect(isFieldRequiredForZone("ENG", "term", preContext)).toBe(true);
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
      phase: "pre" as const,
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
        phase: "mpi" as const,
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
        phase: "pre" as const,
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
        phase: "pre" as const,
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
        phase: "pre" as const,
        isFirstShopVisit: false,
      }),
    ).toMatchObject({ valid: false, fieldKey: "run_flat" });

    zone.select.run_flat = "";
    zone.methods.pad_method = "guess";
    expect(
      validateZoneForCompletion(state, "FL", {
        serviceNames: ["Oil Change"],
        brakeScope: { hasBrakeWork: false, front: false, rear: false },
        phase: "mpi" as const,
        isFirstShopVisit: false,
      }),
    ).toMatchObject({ valid: false, fieldKey: "pad_method" });

    zone.methods.pad_method = "";
    zone.descriptors.desc = ["cracked-in-half"];
    expect(
      validateZoneForCompletion(state, "FL", {
        serviceNames: ["Oil Change"],
        brakeScope: { hasBrakeWork: false, front: false, rear: false },
        phase: "mpi" as const,
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
        phase: "pre" as const,
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
      phase: "mpi" as const,
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
        "tire_type",
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
        phase: "mpi" as const,
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

  it("never recommends courtesy fluid top-offs, but still flags oil and brake fluid", () => {
    // Coolant + washer top-offs are shop protocol and free — recommending them
    // manufactures a service suggestion we did not earn. Oil is not a courtesy
    // fluid (low oil is a real finding), and brake fluid is explicitly excluded
    // because low brake fluid means pads or a leak.
    const state = createInspectionState();
    state.zones.ENG!.done = true;
    state.zones.ENG!.tri.cool_level = "r";
    state.zones.ENG!.tri.washer = "r";
    state.zones.ENG!.tri.oil_level = "r";
    state.zones.ENG!.tri.bf_condition = "r";

    const labels = deriveSuggestedRecommendations(state, {
      onlyCompletedZones: true,
    }).map((recommendation) => recommendation.label);

    expect(labels).not.toContain("Coolant Top-Off");
    expect(labels).not.toContain("Washer Fluid Top-Off");
    expect(labels).toContain("Oil Top-Off");
    expect(labels).toContain("Brake Fluid Flush");
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

// Fresh state with the FRT horn tri set to the given value.
function stateWithHorn(value: "g" | "y" | "r" | undefined): InspectionState {
  const state = createInspectionState();
  const frt = state.zones.FRT!;
  if (value) frt.tri.horn = value;
  frt.done = true;
  return state;
}

describe("horn — NYS safety item (locked Aug 2026)", () => {
  it("is a mandatory NYS safety field that can't be skipped", () => {
    expect(isNysSafetyField("FRT", "horn")).toBe(true);
    expect(canMarkFieldUnavailable("FRT", "horn")).toBe(false);
  });

  it("leaves the other FRT items skippable", () => {
    expect(isNysSafetyField("FRT", "lamp")).toBe(false);
    expect(canMarkFieldUnavailable("FRT", "lamp")).toBe(true);
    expect(canMarkFieldUnavailable("FRT", "wipe")).toBe(true);
  });

  it("flags a red horn as an automatic state-inspection failure", () => {
    expect(deriveStateInspectionFailures(stateWithHorn("r"))).toEqual([
      { zoneId: "FRT", fieldKey: "horn", label: "Horn" },
    ]);
  });

  it("does not flag a working (green) horn", () => {
    expect(deriveStateInspectionFailures(stateWithHorn("g"))).toEqual([]);
  });
});

describe("horn recommendation — two-stage diagnostic-first flow", () => {
  it("recommends a Horn Diagnostic (not a repair) with soon urgency on failure", () => {
    const recs = deriveSuggestedRecommendations(stateWithHorn("r"));
    const horn = recs.find((r) => r.key === "horn");
    expect(horn).toBeDefined();
    expect(horn!.label).toBe("Horn Diagnostic");
    expect(horn!.urgency).toBe("soon");
    expect(horn!.reasons.join(" ")).toMatch(/NYS inspection failure/i);
    expect(horn!.reasons.join(" ")).toMatch(/before a replacement/i);
    // Never routes straight to a swap.
    expect(recs.some((r) => /horn repair/i.test(r.label))).toBe(false);
  });

  it("recommends a lower-urgency diagnostic for an intermittent (yellow) horn", () => {
    const recs = deriveSuggestedRecommendations(stateWithHorn("y"));
    const horn = recs.find((r) => r.key === "horn");
    expect(horn).toBeDefined();
    expect(horn!.label).toBe("Horn Diagnostic");
    expect(horn!.urgency).toBe("within_3_months");
  });

  it("makes no horn recommendation when the horn works", () => {
    const recs = deriveSuggestedRecommendations(stateWithHorn("g"));
    expect(recs.some((r) => r.key === "horn")).toBe(false);
  });
});

describe("per-vehicle rotor minimum grading (enrichment nominal × 0.85)", () => {
  it("effectiveRotorRef prefers the per-axle vehicle min, falls back to the field default", () => {
    // Front corners read the front min, rear corners the rear.
    expect(effectiveRotorRef("FL", 23, { front: 25, rear: 8 })).toBe(25);
    expect(effectiveRotorRef("FR", 23, { front: 25, rear: 8 })).toBe(25);
    expect(effectiveRotorRef("RR", 8, { front: 25, rear: 10 })).toBe(10);
    // A null axle (no nominal sourced) falls back to the static field default.
    expect(effectiveRotorRef("FL", 23, { front: null, rear: 10 })).toBe(23);
    // No override at all → field default.
    expect(effectiveRotorRef("FL", 23, null)).toBe(23);
    expect(effectiveRotorRef("FL", 23, undefined)).toBe(23);
  });

  // A front rotor read at 24 mm: in spec against the 23 mm static default, but
  // below a 25 mm per-vehicle minimum (a rotor whose OEM nominal is ~29.4 mm).
  function stateWithFrontRotor(mm: string): InspectionState {
    const state = createInspectionState();
    const fl = state.zones.FL!;
    fl.done = true;
    fl.measures.rotor = mm;
    fl.select.rotor_unit = "mm";
    return state;
  }

  it("gatherFindings flags a rotor that passes the default but fails the per-vehicle min", () => {
    const state = stateWithFrontRotor("24");
    // Static fallback (23 mm): 24 mm is in spec → no rotor attention finding.
    const baseline = gatherFindings(state);
    expect(
      baseline.attention.some((f) => /rotor/i.test(f.label)),
    ).toBe(false);
    // Per-vehicle min (25 mm): 24 mm is below → attention finding.
    const graded = gatherFindings(state, { rotorMin: { front: 25, rear: null } });
    expect(
      graded.attention.some((f) => /brake rotor thickness · below min/i.test(f.label)),
    ).toBe(true);
  });

  it("drives a Rotor Replacement recommendation off the per-vehicle min", () => {
    const state = stateWithFrontRotor("24");
    // No override → graded against 23 mm default → no recommendation.
    expect(
      deriveSuggestedRecommendations(state).some((r) => r.key === SERVICE_SLUGS.rotors),
    ).toBe(false);
    // Per-vehicle min 25 mm → below → "Rotor Replacement", soon.
    const recs = deriveSuggestedRecommendations(state, {
      rotorMin: { front: 25, rear: null },
    });
    const rotorRec = recs.find((r) => r.key === SERVICE_SLUGS.rotors);
    expect(rotorRec).toBeDefined();
    expect(rotorRec!.label).toBe("Rotor Replacement");
    expect(rotorRec!.urgency).toBe("soon");
  });
});

describe("pre-check / MPI phase split (Spec v2 §1.1)", () => {
  const brakeJob = (phase: "pre" | "mpi") => ({
    serviceNames: ["Brake Pad Replacement"],
    phase,
    brakeScope: { hasBrakeWork: true, front: true, rear: false },
  });

  it("assigns every template field to exactly one phase", () => {
    for (const zone of INSPECTION_ZONES) {
      for (const field of zone.fields) {
        expect(
          ["pre", "mpi"],
          `${zone.id}.${field.key} has no phase`,
        ).toContain(field.phase);
      }
    }
  });

  it("keeps every lift- or wheel-off item out of the pre-check", () => {
    // The whole point of the split: if it needs the car in the air or a wheel
    // off, the mechanic must be on the clock before being asked for it.
    const deferred = [
      ["FL", "pad_inner"], ["FL", "pad_outer"], ["FL", "rotor"],
      ["FL", "desc"], ["FL", "caliper"], ["FL", "brake_hose"],
      ["FL", "pad_brand"], ["FL", "steering_play"], ["FL", "ball_joint_play"],
      ["FL", "wheel_bearing_play"], ["ENG", "batt"],
      ["UND", "leaks"], ["UND", "cv"], ["UND", "strut"], ["UND", "exh"],
      ["UND", "damage"],
    ] as const;
    for (const [zoneId, fieldKey] of deferred) {
      expect(
        INSPECTION_ZONES_BY_ID[zoneId].fields.find((f) => f.key === fieldKey)
          ?.phase,
        `${zoneId}.${fieldKey} must be MPI`,
      ).toBe("mpi");
    }
  });

  it("defers a booked axle's pad reading out of the pre-check", () => {
    // Same booking, same corner — only the phase differs.
    expect(isFieldRequiredForZone("FL", "pad_inner", brakeJob("pre"))).toBe(false);
    expect(isFieldRequiredForZone("FL", "pad_inner", brakeJob("mpi"))).toBe(true);
    // ...and it isn't merely optional in the pre-check, it isn't shown at all.
    expect(isFieldApplicableToZone("FL", "pad_inner", brakeJob("pre"))).toBe(false);
    expect(isFieldApplicableToZone("FL", "pad_inner", brakeJob("mpi"))).toBe(true);
  });

  it("still asks for the ground-level rows during the pre-check", () => {
    for (const key of ["tread", "psi", "wear", "brake_visual"]) {
      expect(isFieldRequiredForZone("FL", key, brakeJob("pre"))).toBe(true);
      // And stops asking once they're behind us — they're read-only by then.
      expect(isFieldRequiredForZone("FL", key, brakeJob("mpi"))).toBe(false);
    }
    expect(isFieldRequiredForZone("FRT", "horn", brakeJob("pre"))).toBe(true);
  });

  it("re-opens a corner completed in the pre-check once the MPI half starts", () => {
    const zone = createInspectionState().zones.FL!;
    zone.done = true;
    zone.donePhase = "pre";
    expect(isZoneDoneForPhase(zone, "pre")).toBe(true);
    expect(isZoneDoneForPhase(zone, "mpi")).toBe(false);

    zone.donePhase = "mpi";
    expect(isZoneDoneForPhase(zone, "mpi")).toBe(true);
  });

  it("reads a row saved before the split as a pre-check completion", () => {
    const zone = createInspectionState().zones.FL!;
    zone.done = true;
    delete zone.donePhase;
    expect(isZoneDoneForPhase(zone, "pre")).toBe(true);
    expect(isZoneDoneForPhase(zone, "mpi")).toBe(false);
    expect(isZoneDoneForPhase(undefined, "pre")).toBe(false);
  });

  it("never mirrors a measured reading between corners", () => {
    const state = createInspectionState();
    const source = state.zones.FL!;
    source.measures.tread = "7";
    source.measures.psi = "40";
    source.tri.wear = "y";
    source.text.tire_brand = "Michelin";
    source.text.tire_size = "225/45R18";
    source.text.pad_brand = "Akebono";

    const destination = state.zones.FR!;
    destination.measures.psi = "43"; // staggered setup, Aug 20

    const pre = cornerCopyPatch(source, destination, "pre");
    expect(pre.text?.tire_brand).toBe("Michelin");
    expect(pre.text?.tire_size).toBe("225/45R18");
    // The bug this closes: pressure and tread used to travel with the copy.
    expect(pre.measures?.psi).toBe("43");
    expect(pre.measures?.tread ?? "").toBe("");
    expect(pre.tri?.wear ?? "").not.toBe("y");
    // Pad brand belongs to the other half — not copied during the pre-check.
    expect(pre.text?.pad_brand ?? "").toBe("");

    const mpi = cornerCopyPatch(source, destination, "mpi");
    expect(mpi.text?.pad_brand).toBe("Akebono");
    expect(mpi.text?.tire_brand ?? "").toBe("");
  });

  it("does not block zone completion on a field from the other half", () => {
    const state = createInspectionState();
    const zone = state.zones.FL!;
    zone.measures.tread = "7";
    zone.measures.psi = "35";
    zone.tri.wear = "g";
    zone.tri.brake_visual = "g";
    zone.text.tire_size = "225/45R18";
    zone.select.run_flat = "no";

    // A front-axle brake job: every wheel-off row is still blank, and that must
    // not stop the mechanic finishing the pre-check and starting the clock.
    expect(validateZoneForCompletion(state, "FL", brakeJob("pre"))).toEqual({
      valid: true,
    });
    // The same corner, once the wheel is off, does demand them.
    expect(validateZoneForCompletion(state, "FL", brakeJob("mpi"))).toMatchObject({
      valid: false,
    });
  });
});

describe("development inspection phase completion", () => {
  it("fills only the required pre-check fields for the booked service", () => {
    const initial = createInspectionState();
    const state = completeInspectionPhaseForDevelopment(initial, {
      serviceNames: ["Oil Change"],
      phase: "pre",
      brakeScope: { hasBrakeWork: false, front: false, rear: false },
      isFirstShopVisit: false,
    });

    expect(state.zones.FL).toMatchObject({
      done: true,
      donePhase: "pre",
      statuses: {
        tread: "not_visible",
        psi: "not_visible",
        wear: "not_visible",
        brake_visual: "not_visible",
      },
    });
    expect(state.zones.ENG?.lights.warning_lights).toEqual([{ light: "none" }]);
    expect(state.zones.FRT?.tri.horn).toBe("g");
    expect(state.zones.UND).toEqual(initial.zones.UND);
    expect(state.zones.FL?.measures.pad_inner ?? "").toBe("");
  });

  it("fills only the active MPI phase", () => {
    const initial = createInspectionState();
    const state = completeInspectionPhaseForDevelopment(initial, {
      serviceNames: ["Brake Pad Replacement"],
      phase: "mpi",
      brakeScope: { hasBrakeWork: true, front: true, rear: false },
      isFirstShopVisit: false,
    });

    expect(state.zones.FL).toMatchObject({ done: true, donePhase: "mpi" });
    expect(state.zones.FR).toMatchObject({ done: true, donePhase: "mpi" });
    expect(state.zones.RL).toEqual(initial.zones.RL);
    expect(state.zones.ENG).toEqual(initial.zones.ENG);
    expect(state.zones.FL?.statuses.tread).toBeUndefined();
    expect(state.zones.FL?.statuses.pad_inner).toBe("not_visible");
  });
});
