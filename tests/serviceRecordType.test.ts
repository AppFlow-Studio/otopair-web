import { describe, it, expect } from "vitest";
import {
  recordTypeForServiceSlug,
  SERVICE_SLUG_TO_RECORD_TYPE,
} from "../convex/lib/serviceRecordType";

describe("recordTypeForServiceSlug — booking-completion → maintenance record type (#90)", () => {
  it("maps the canonical snake_case service slugs to record types", () => {
    expect(recordTypeForServiceSlug("oil_change")).toBe("oil");
    expect(recordTypeForServiceSlug("brake_pad_replacement")).toBe("brakes");
    expect(recordTypeForServiceSlug("rotor_replacement")).toBe("brakes");
    expect(recordTypeForServiceSlug("tire_rotation")).toBe("tires");
    expect(recordTypeForServiceSlug("tire_balance")).toBe("tires");
    expect(recordTypeForServiceSlug("wheel_alignment")).toBe("tires");
    expect(recordTypeForServiceSlug("tire_replacement")).toBe("tires");
    expect(recordTypeForServiceSlug("battery_replacement")).toBe("battery");
    expect(recordTypeForServiceSlug("battery_test")).toBe("battery");
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
