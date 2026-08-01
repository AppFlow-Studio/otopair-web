import { describe, expect, it } from "vitest";

import {
  classify,
  createInspectionState,
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
    const zone = createInspectionState({ isFirstVisit: true }).zones.FL!;
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
    const zone = createInspectionState({ isFirstVisit: true }).zones.FL!;
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

  it("requires only service-relevant zones", () => {
    expect(requiredZonesForBooking(["Oil Change"])).toEqual([
      "ENG",
    ]);
    expect(requiredZonesForBooking(["Tire Rotation"])).toEqual([
      "FL",
      "FR",
      "RL",
      "RR",
    ]);
    expect(requiredZonesForBooking(["Brake Pad Replacement"])).toEqual([
      "FL",
      "FR",
      "RL",
      "RR",
    ]);
    expect(requiredZonesForBooking(["Battery Replacement"])).toEqual([]);
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
        (recommendation) => recommendation.key === "rotors",
      )?.reason,
    ).toContain("23.01mm");
  });

  it("matches field requirements to the server's booking scope", () => {
    const oilContext = {
      serviceNames: ["Oil Change"],
      brakeScope: { hasBrakeWork: false, front: false, rear: false },
    };
    const frontBrakeContext = {
      serviceNames: ["Front Brake Pad Replacement"],
      brakeScope: { hasBrakeWork: true, front: true, rear: false },
    };

    const tireContext = {
      serviceNames: ["Tire Rotation"],
      brakeScope: { hasBrakeWork: false, front: false, rear: false },
    };

    expect(isFieldRequiredForZone("FR", "tire_brand", oilContext)).toBe(false);
    expect(isFieldRequiredForZone("FR", "tire_size", oilContext)).toBe(false);
    expect(isFieldRequiredForZone("FR", "tire_brand", tireContext)).toBe(true);
    expect(isFieldRequiredForZone("FR", "psi", tireContext)).toBe(true);
    expect(isFieldRequiredForZone("FR", "pad", oilContext)).toBe(false);
    expect(isFieldRequiredForZone("FR", "pad", frontBrakeContext)).toBe(true);
    expect(isFieldRequiredForZone("RR", "pad", frontBrakeContext)).toBe(false);
    expect(isFieldRequiredForZone("FR", "psi", frontBrakeContext)).toBe(false);
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
    expect(validateZoneForCompletion(createInspectionState(), "ENG", context)).toEqual({
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
    expect(isFieldRequiredForZone("FR", "tire_size", context)).toBe(true);
    expect(isFieldRequiredForZone("FL", "tread", context)).toBe(true);
  });

  it("completes a replacement corner with installed axle size and no outgoing-tire reading", () => {
    const state = createInspectionState();
    state.zones.FR!.text.tire_size = "225/45R18";

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
    zone.measures.pad = "6";
    zone.measures.rotor = "23";
    zone.text.tire_brand = "michelin";
    zone.text.tire_size = "225/45R18";
    zone.tri.wear = "g";
    const context = {
      serviceNames: ["Front Brake Pad Replacement"],
      brakeScope: { hasBrakeWork: true, front: true, rear: false },
    };
    expect(validateZoneForCompletion(state, "FL", context)).toEqual({
      valid: true,
    });

    state.zones.ENG!.measures.batt = "-1";
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
        "pad",
        "rotor",
        "desc",
        "pad_brand",
      ]);
      expect(
        fields
          .map((field) => field.section)
          .filter((section, index, sections) => section !== sections[index - 1]),
      ).toEqual(["Tire", "Brakes"]);
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
});
