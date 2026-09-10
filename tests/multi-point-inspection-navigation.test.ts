import { afterEach, describe, expect, it, vi } from "vitest";

import {
  nextInspectionZoneAfterCompletion,
  scheduleCopyDestinationNavigation,
} from "../lib/inspection-template";

afterEach(() => {
  vi.useRealTimers();
});

describe("multi-point inspection completion navigation", () => {
  it("always follows the fixed physical inspection order", () => {
    expect(nextInspectionZoneAfterCompletion("FL")).toBe("FR");
    expect(nextInspectionZoneAfterCompletion("RR")).toBe("ENG");
    expect(nextInspectionZoneAfterCompletion("ENG")).toBe("FRT");
    expect(nextInspectionZoneAfterCompletion("FRT")).toBe("UND");
    expect(nextInspectionZoneAfterCompletion("UND")).toBeNull();
  });

  it("opens the copied-to corner after showing confirmation for one second", () => {
    vi.useFakeTimers();
    const openZone = vi.fn();

    scheduleCopyDestinationNavigation("FR", openZone);

    vi.advanceTimersByTime(999);
    expect(openZone).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(openZone).toHaveBeenCalledOnce();
    expect(openZone).toHaveBeenCalledWith("FR");
  });
});
