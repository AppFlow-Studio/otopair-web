import { describe, expect, it } from "vitest";
import {
  MAX_LABOR_HOURS,
  formatHoursValue,
  hoursToMinutes,
  minutesToHours,
  parseHoursInput,
} from "../lib/labor-units";

describe("hoursToMinutes", () => {
  it("converts decimal hours to whole minutes", () => {
    expect(hoursToMinutes(0.5)).toBe(30);
    expect(hoursToMinutes(0.25)).toBe(15);
    expect(hoursToMinutes(0.75)).toBe(45);
    expect(hoursToMinutes(1)).toBe(60);
    expect(hoursToMinutes(1.5)).toBe(90);
    expect(hoursToMinutes(0.1)).toBe(6);
    expect(hoursToMinutes(1.7)).toBe(102);
    expect(hoursToMinutes(0)).toBe(0);
  });

  it("rounds to the nearest whole minute", () => {
    // 0.7 hr = 42 min exactly; 0.42 hr ≈ 25.2 → 25
    expect(hoursToMinutes(0.7)).toBe(42);
    expect(hoursToMinutes(0.42)).toBe(25);
  });
});

describe("minutesToHours", () => {
  it("converts minutes to decimal hours", () => {
    expect(minutesToHours(30)).toBe(0.5);
    expect(minutesToHours(90)).toBe(1.5);
    expect(minutesToHours(60)).toBe(1);
    expect(minutesToHours(0)).toBe(0);
  });
});

describe("round-trip", () => {
  it("hoursToMinutes(minutesToHours(m)) === m for whole minutes", () => {
    for (const m of [0, 15, 30, 45, 60, 75, 90, 102, 165, 480]) {
      expect(hoursToMinutes(minutesToHours(m))).toBe(m);
    }
  });
});

describe("formatHoursValue", () => {
  it("formats stored minutes as a trimmed hours string", () => {
    expect(formatHoursValue(30)).toBe("0.5");
    expect(formatHoursValue(15)).toBe("0.25");
    expect(formatHoursValue(45)).toBe("0.75");
    expect(formatHoursValue(60)).toBe("1");
    expect(formatHoursValue(90)).toBe("1.5");
    expect(formatHoursValue(42)).toBe("0.7");
  });

  it("caps odd values at two decimals", () => {
    expect(formatHoursValue(25)).toBe("0.42");
  });

  it("returns '0' for zero / negative / non-finite", () => {
    expect(formatHoursValue(0)).toBe("0");
    expect(formatHoursValue(-30)).toBe("0");
    expect(formatHoursValue(Number.NaN)).toBe("0");
  });
});

describe("parseHoursInput", () => {
  it("parses valid decimal hours", () => {
    expect(parseHoursInput("0.5")).toBe(0.5);
    expect(parseHoursInput("1.25")).toBe(1.25);
    expect(parseHoursInput("0")).toBe(0);
    expect(parseHoursInput("24")).toBe(24);
    // Mid-typing a decimal point should still parse.
    expect(parseHoursInput("1.")).toBe(1);
  });

  it("returns null for blank / invalid / out-of-range", () => {
    expect(parseHoursInput("")).toBeNull();
    expect(parseHoursInput("   ")).toBeNull();
    expect(parseHoursInput("abc")).toBeNull();
    expect(parseHoursInput("-1")).toBeNull();
    expect(parseHoursInput(String(MAX_LABOR_HOURS + 1))).toBeNull();
  });
});
