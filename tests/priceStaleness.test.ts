/**
 * isPriceDataStale — read-time price-age flag (PARTS_PRICE_MAX_AGE_DAYS,
 * default 45). Pure with an injectable clock.
 */
import { afterEach, describe, expect, test } from "vitest";
import { isPriceDataStale } from "../convex/part_prices";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000; // fixed clock

afterEach(() => {
  delete process.env.PARTS_PRICE_MAX_AGE_DAYS;
});

describe("isPriceDataStale", () => {
  test("null / missing timestamp → stale (rows predate timestamps)", () => {
    expect(isPriceDataStale(null, NOW)).toBe(true);
    expect(isPriceDataStale(undefined, NOW)).toBe(true);
  });

  test("fresh price → not stale", () => {
    expect(isPriceDataStale(NOW - 10 * DAY, NOW)).toBe(false);
  });

  test("default boundary at 45 days", () => {
    expect(isPriceDataStale(NOW - 45 * DAY, NOW)).toBe(false); // exactly at threshold
    expect(isPriceDataStale(NOW - 45 * DAY - 1, NOW)).toBe(true);
  });

  test("env override respected", () => {
    process.env.PARTS_PRICE_MAX_AGE_DAYS = "90";
    expect(isPriceDataStale(NOW - 60 * DAY, NOW)).toBe(false);
    expect(isPriceDataStale(NOW - 91 * DAY, NOW)).toBe(true);
  });

  test("garbage env falls back to default", () => {
    process.env.PARTS_PRICE_MAX_AGE_DAYS = "not-a-number";
    expect(isPriceDataStale(NOW - 46 * DAY, NOW)).toBe(true);
    expect(isPriceDataStale(NOW - 44 * DAY, NOW)).toBe(false);
  });
});
