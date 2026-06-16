import { describe, it, expect } from "vitest";
import {
  parseAxlePosition,
  partNameAxle,
  fitmentMatchesPosition,
  deriveServiceVariantsFromOptions,
  isBrakeSlug,
} from "../convex/lib/brakeScope";
import type { Id } from "../convex/_generated/dataModel";

const svc = (n: string) => n as unknown as Id<"services">;

describe("parseAxlePosition", () => {
  it("reads single-axle option labels", () => {
    expect(parseAxlePosition("Front only")).toBe("front");
    expect(parseAxlePosition("Rear only")).toBe("rear");
  });
  it("reads both-axle labels in either phrasing", () => {
    expect(parseAxlePosition("Both")).toBe("both");
    expect(parseAxlePosition("Both (front + rear)")).toBe("both");
    expect(parseAxlePosition("Front and rear")).toBe("both");
  });
  it("returns null for non-axial labels", () => {
    expect(parseAxlePosition("Cabin air filter only")).toBeNull();
    expect(parseAxlePosition("")).toBeNull();
    expect(parseAxlePosition(null)).toBeNull();
  });
});

describe("partNameAxle", () => {
  it("classifies brake part names by axle", () => {
    expect(partNameAxle("Front Brake Pads")).toBe("front");
    expect(partNameAxle("Rear Brake Rotors")).toBe("rear");
  });
  it("keeps ambiguous / neutral names (null)", () => {
    expect(partNameAxle("Brake Hardware Kit")).toBeNull();
    expect(partNameAxle("Front and rear pad set")).toBeNull();
    expect(partNameAxle(undefined)).toBeNull();
  });
});

describe("fitmentMatchesPosition", () => {
  it("passes everything for both/undefined", () => {
    expect(fitmentMatchesPosition("front", "front_brake_pad", undefined)).toBe(true);
    expect(fitmentMatchesPosition("rear", "rear_brake_pad", "both")).toBe(true);
  });
  it("matches on explicit fitment position", () => {
    expect(fitmentMatchesPosition("rear", null, "rear")).toBe(true);
    expect(fitmentMatchesPosition("front", null, "rear")).toBe(false);
  });
  it("matches on front_/rear_ subcategory when position is blank", () => {
    expect(fitmentMatchesPosition("", "rear_brake_pad", "rear")).toBe(true);
    expect(fitmentMatchesPosition("", "front_brake_pad", "rear")).toBe(false);
  });
  it("keeps position-neutral parts on a single-axle filter", () => {
    expect(fitmentMatchesPosition("", "brake_hardware_kit", "rear")).toBe(true);
    expect(fitmentMatchesPosition(null, "caliper_grease", "front")).toBe(true);
  });
});

describe("deriveServiceVariantsFromOptions", () => {
  it("maps axle_position options to service variants", () => {
    const out = deriveServiceVariantsFromOptions([
      { service_id: svc("a"), option_label: "Rear only", option_type: "axle_position" },
      { service_id: svc("b"), option_label: "Both", option_type: "axle_position" },
    ]);
    expect(out).toEqual([
      { serviceId: svc("a"), position: "rear" },
      { serviceId: svc("b"), position: "both" },
    ]);
  });
  it("ignores non-axle option types and unparseable labels", () => {
    const out = deriveServiceVariantsFromOptions([
      { service_id: svc("c"), option_label: "Cabin air filter only", option_type: "filter_type" },
      { service_id: svc("d"), option_label: "Engine air filter only", option_type: "filter_type" },
    ]);
    expect(out).toEqual([]);
  });
  it("handles empty / nullish input", () => {
    expect(deriveServiceVariantsFromOptions(undefined)).toEqual([]);
    expect(deriveServiceVariantsFromOptions([])).toEqual([]);
  });
});

describe("isBrakeSlug", () => {
  it("matches brake and rotor slugs", () => {
    expect(isBrakeSlug("brake_pad_replacement")).toBe(true);
    expect(isBrakeSlug("rotor_replacement")).toBe(true);
    expect(isBrakeSlug("brake-pads")).toBe(true);
    expect(isBrakeSlug("oil-change")).toBe(false);
    expect(isBrakeSlug(null)).toBe(false);
  });
});
