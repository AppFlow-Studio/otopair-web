import { describe, expect, it } from "vitest";

import { nextInspectionZoneAfterCompletion } from "../lib/inspection-template";

describe("multi-point inspection completion navigation", () => {
  it("always follows the fixed physical inspection order", () => {
    expect(nextInspectionZoneAfterCompletion("FL")).toBe("FR");
    expect(nextInspectionZoneAfterCompletion("RR")).toBe("ENG");
    expect(nextInspectionZoneAfterCompletion("ENG")).toBe("FRT");
    expect(nextInspectionZoneAfterCompletion("FRT")).toBe("UND");
    expect(nextInspectionZoneAfterCompletion("UND")).toBeNull();
  });
});
