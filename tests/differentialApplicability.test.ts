/**
 * Jun-9 review (medium): the quote engine refused differential_service for
 * everything except exactly "AWD" — but RWD has a rear differential and
 * 4WD has front+rear+transfer case. Only FWD (transaxle) lacks a separately
 * serviceable diff; unknown drivetrains stay refused (fail-safe — never bill
 * a service the car might not have).
 */
import { describe, test, expect } from "vitest";
import { hasServiceableDifferential } from "../convex/lib/quoteEngine";

describe("hasServiceableDifferential", () => {
  test.each(["AWD", "awd", "4WD", "4x4", "RWD", "rwd"])(
    "%s → true",
    (d) => expect(hasServiceableDifferential(d)).toBe(true),
  );
  test.each(["FWD", "fwd", "unknown", "", undefined, null])(
    "%s → false (fail-safe)",
    (d) => expect(hasServiceableDifferential(d as any)).toBe(false),
  );
});
