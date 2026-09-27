import { describe, expect, test } from "vitest";
import { isFutureScheduleSlot } from "../lib/follow-up-slot-validation";

describe("isFutureScheduleSlot", () => {
  test("rejects a slot that has already elapsed today", () => {
    expect(
      isFutureScheduleSlot("2026-09-22", "08:15", new Date(2026, 8, 22, 21, 0)),
    ).toBe(false);
  });

  test("accepts a later slot on the current day", () => {
    expect(
      isFutureScheduleSlot("2026-09-22", "21:15", new Date(2026, 8, 22, 21, 0)),
    ).toBe(true);
  });

  test("rejects a slot at the current minute", () => {
    expect(
      isFutureScheduleSlot("2026-09-22", "21:00", new Date(2026, 8, 22, 21, 0)),
    ).toBe(false);
  });
});
