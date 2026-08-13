import { describe, it, expect } from "vitest";
import { symptomForServiceSlug, symptomForRecordType } from "../convex/lib/serviceSymptoms";
describe("serviceSymptoms", () => {
  it("maps service slugs to warning-light codes", () => {
    expect(symptomForServiceSlug("oil_change")).toBe("oil_pressure");
    expect(symptomForServiceSlug("brake_pad_replacement")).toBe("brake_warning");
    expect(symptomForServiceSlug("spark_plugs")).toBe(null);
  });
  it("maps record types to the same codes (for clearing)", () => {
    expect(symptomForRecordType("oil")).toBe("oil_pressure");
    expect(symptomForRecordType("diagnostics")).toBe("check_engine");
    expect(symptomForRecordType("fluids")).toBe(null);
  });
});
