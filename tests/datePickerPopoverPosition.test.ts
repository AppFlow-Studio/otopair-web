import { describe, expect, test } from "vitest";
import { getDatePickerPopoverPosition } from "../components/ui/date-picker";

describe("getDatePickerPopoverPosition", () => {
  test("positions the portal popup below its trigger", () => {
    expect(
      getDatePickerPopoverPosition({ left: 18, bottom: 94 }),
    ).toEqual({ left: 18, top: 102 });
  });
});
