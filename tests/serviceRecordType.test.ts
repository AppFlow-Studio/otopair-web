import { describe, it, expect } from "vitest";
import {
  anchorRecordTypeForServiceSlug,
  recordTypeForServiceSlug,
  recordTypesForCompletedService,
  serviceAnchorRecordType,
  SERVICE_SLUG_TO_RECORD_TYPE,
} from "../convex/lib/serviceRecordType";

describe("recordTypeForServiceSlug — booking-completion → maintenance record type (#90)", () => {
  it("maps the canonical snake_case service slugs to record types", () => {
    expect(recordTypeForServiceSlug("oil_change")).toBe("oil");
    expect(recordTypeForServiceSlug("brake_pad_replacement")).toBe("brakes");
    expect(recordTypeForServiceSlug("rotor_replacement")).toBe("brakes");
    expect(recordTypeForServiceSlug("tire_replacement")).toBe("tires");
    expect(recordTypeForServiceSlug("battery_replacement")).toBe("battery");
    expect(recordTypeForServiceSlug("coolant_flush")).toBe("fluids");
    expect(recordTypeForServiceSlug("brake_fluid_flush")).toBe("fluids");
    expect(recordTypeForServiceSlug("transmission_service")).toBe("fluids");
    expect(recordTypeForServiceSlug("power_steering_flush")).toBe("fluids");
    expect(recordTypeForServiceSlug("differential_service")).toBe("fluids");
    expect(recordTypeForServiceSlug("filter_replacement")).toBe("filters");
    expect(recordTypeForServiceSlug("spark_plugs")).toBe("engine_parts");
    expect(recordTypeForServiceSlug("timing_belt")).toBe("engine_parts");
    expect(recordTypeForServiceSlug("fuel_system_cleaning")).toBe("engine_parts");
    expect(recordTypeForServiceSlug("diagnostic_scan")).toBe("diagnostics");
    expect(recordTypeForServiceSlug("check_engine_light")).toBe("diagnostics");
    expect(recordTypeForServiceSlug("state_inspection")).toBe("inspection");
    expect(recordTypeForServiceSlug("emissions_test")).toBe("inspection");
  });

  it("REGRESSION (#90): the old kebab-case keys must NOT match — they silently no-op'd completion write-back", () => {
    expect(recordTypeForServiceSlug("oil-change")).toBeNull();
    expect(recordTypeForServiceSlug("brake-pads")).toBeNull();
    expect(recordTypeForServiceSlug("tire-replacement")).toBeNull();
    expect(recordTypeForServiceSlug("battery-replacement")).toBeNull();
  });

  it("returns null for unmapped / unknown slugs (no record write)", () => {
    expect(recordTypeForServiceSlug("pre_purchase_inspection")).toBeNull(); // intentionally unmapped (not a maintenance reset)
    expect(recordTypeForServiceSlug("mystery_service")).toBeNull();
    expect(recordTypeForServiceSlug("")).toBeNull();
  });

  it("every mapped key is a real snake_case slug (no kebab leaked in)", () => {
    for (const slug of Object.keys(SERVICE_SLUG_TO_RECORD_TYPE)) {
      expect(slug).not.toContain("-");
      expect(slug).toMatch(/^[a-z0-9_]+$/);
    }
  });
});

describe("upkeep on a part never resets the part's life (#413 / #428)", () => {
  it("rotation, balance, alignment and a battery test map to no life record", () => {
    for (const slug of ["tire_rotation", "tire_balance", "wheel_alignment", "battery_test"]) {
      expect(recordTypeForServiceSlug(slug)).toBeNull();
      expect(recordTypesForCompletedService(slug)).not.toContain("tires");
      expect(recordTypesForCompletedService(slug)).not.toContain("battery");
    }
  });

  it("each of them is still recorded, on its own anchor", () => {
    expect(recordTypesForCompletedService("tire_rotation")).toEqual(["service_tire_rotation"]);
    expect(recordTypesForCompletedService("battery_test")).toEqual(["service_battery_test"]);
    // …which is also what the pipeline anchors the rotation spec on.
    expect(anchorRecordTypeForServiceSlug("tire_rotation")).toBe("service_tire_rotation");
  });
});

describe("serviceAnchorRecordType — every catalog service has its own anchor (#206)", () => {
  it("keeps the five minor_* rows", () => {
    expect(serviceAnchorRecordType("coolant_flush")).toBe("minor_cool_condition");
    expect(serviceAnchorRecordType("brake_fluid_flush")).toBe("minor_bf_condition");
  });

  it("gives shared-aggregate services a service_<slug> row", () => {
    expect(serviceAnchorRecordType("spark_plugs")).toBe("service_spark_plugs");
    expect(serviceAnchorRecordType("differential_service")).toBe("service_differential_service");
    expect(serviceAnchorRecordType("diagnostic_scan")).toBe("service_diagnostic_scan");
    expect(recordTypesForCompletedService("spark_plugs")).toEqual(["service_spark_plugs", "engine_parts"]);
  });

  it("adds no duplicate row where the aggregate already is the anchor", () => {
    expect(serviceAnchorRecordType("oil_change")).toBeNull();
    expect(serviceAnchorRecordType("tire_replacement")).toBeNull();
    expect(recordTypesForCompletedService("oil_change")).toEqual(["oil"]);
  });

  it("the pipeline keeps anchoring on the aggregate where one exists", () => {
    expect(anchorRecordTypeForServiceSlug("spark_plugs")).toBe("engine_parts");
    expect(anchorRecordTypeForServiceSlug("oil_change")).toBe("oil");
  });
});
