import { describe, expect, test } from "vitest";

import {
  formatShopTime,
  shopTodayISO,
} from "@/lib/shopTimezone";
import * as shopTimezone from "@/lib/shopTimezone";

describe("shop timezone formatting", () => {
  test("labels an appointment using the shop's daylight-saving abbreviation", () => {
    expect(formatShopTime("15:00", "2026-09-21", "America/New_York")).toBe("3:00 PM EDT");
  });

  test("uses standard time outside daylight saving time", () => {
    expect(formatShopTime("15:00", "2026-01-21", "America/New_York")).toBe("3:00 PM EST");
  });

  test("uses the shop's business date instead of the viewer's date", () => {
    expect(shopTodayISO("America/New_York", new Date("2026-09-22T00:30:00Z"))).toBe("2026-09-21");
  });

  test("creates a calendar date for the shop's business day", () => {
    const date = (shopTimezone as typeof shopTimezone & {
      shopTodayCalendarDate: (timezone: string, now: Date) => Date;
    }).shopTodayCalendarDate("America/New_York", new Date("2026-09-22T00:30:00Z"));

    expect([date.getFullYear(), date.getMonth() + 1, date.getDate()]).toEqual([2026, 9, 21]);
  });

  test("bounds a Today filter by the shop's midnight", () => {
    const bounds = (shopTimezone as typeof shopTimezone & {
      shopTodayBounds: (timezone: string, now: Date) => { start: number; end: number };
    }).shopTodayBounds("America/New_York", new Date("2026-09-22T00:30:00Z"));

    expect(new Date(bounds.start).toISOString()).toBe("2026-09-21T04:00:00.000Z");
    expect(new Date(bounds.end).toISOString()).toBe("2026-09-22T04:00:00.000Z");
  });
});
