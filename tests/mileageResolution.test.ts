/**
 * The Aug 20 partner-session mileage split.
 *
 * Yassin's app read 49,000; the shop job detail pulled 37,376 from the previous
 * visit's passport — and rendered it tagged "verified". Two sources of truth
 * (vehicle_passports.mileage, vehicle_owners.mileage) with a one-way sync:
 * passport pushes down into owner after a visit, nothing pushes back up.
 *
 * The old rule was precedence — passport always won, however stale. The new
 * rule is recency, with the historical passport-first order as the tiebreak.
 */
import { describe, expect, it } from "vitest";
import {
  mileageSourceTag,
  resolveVehicleMileage,
} from "../convex/lib/mileage";

const T = 1_700_000_000_000;
const DAY = 86_400_000;

describe("resolveVehicleMileage", () => {
  it("reproduces the session case: the driver's newer number wins", () => {
    const out = resolveVehicleMileage(
      { mileage: 37_376, last_reported_at: T - 30 * DAY },
      { mileage: 49_000, mileage_updated_at: T },
    );
    expect(out).toEqual({ mileage: 49_000, from: "owner" });
    // And the badge follows the value — this is what said "verified" before.
    expect(mileageSourceTag(out.from)).toBe("user_reported");
  });

  it("keeps the shop reading when it is the newer of the two", () => {
    const out = resolveVehicleMileage(
      { mileage: 51_000, last_reported_at: T },
      { mileage: 49_000, mileage_updated_at: T - DAY },
    );
    expect(out).toEqual({ mileage: 51_000, from: "passport" });
    expect(mileageSourceTag(out.from)).toBe("verified");
  });

  it("falls back to passport-first when timestamps can't decide", () => {
    // Rows written before these timestamp fields existed must not lose to a
    // driver row that never recorded a write time either.
    expect(
      resolveVehicleMileage({ mileage: 37_376 }, { mileage: 49_000 }),
    ).toEqual({ mileage: 37_376, from: "passport" });

    // Same instant is a tie, not an owner win.
    expect(
      resolveVehicleMileage(
        { mileage: 37_376, last_reported_at: T },
        { mileage: 49_000, mileage_updated_at: T },
      ),
    ).toEqual({ mileage: 37_376, from: "passport" });
  });

  it("uses whichever side actually has a number", () => {
    expect(
      resolveVehicleMileage(null, { mileage: 49_000, mileage_updated_at: T }),
    ).toEqual({ mileage: 49_000, from: "owner" });

    expect(
      resolveVehicleMileage({ mileage: 37_376, last_reported_at: T }, null),
    ).toEqual({ mileage: 37_376, from: "passport" });

    expect(resolveVehicleMileage(null, null)).toEqual({
      mileage: null,
      from: null,
    });
    expect(mileageSourceTag(null)).toBe("empty");
  });

  it("ignores non-finite junk rather than treating it as a reading", () => {
    expect(
      resolveVehicleMileage(
        { mileage: Number.NaN, last_reported_at: T },
        { mileage: 49_000, mileage_updated_at: T - DAY },
      ),
    ).toEqual({ mileage: 49_000, from: "owner" });
  });

  it("does not take the larger number", () => {
    // Deliberate: max() is right almost always, but one fat-fingered 490,000
    // would poison the vehicle permanently with no way to correct it down.
    // Recency lets a later correction win.
    expect(
      resolveVehicleMileage(
        { mileage: 490_000, last_reported_at: T - DAY },
        { mileage: 49_000, mileage_updated_at: T },
      ),
    ).toEqual({ mileage: 49_000, from: "owner" });
  });
});
