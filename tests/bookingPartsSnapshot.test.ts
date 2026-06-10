/**
 * Locked parts-snapshot tests — fix for review item 10
 * (docs/superpowers/reviews/2026-06-09-enrichment-pipeline-review.md):
 *
 * A part whose every price row is poison/unverified summarizes to an EMPTY
 * price summary; the booking snapshot then claimed `unit_price_cents: 0` as if
 * zero were a real price — billing $0 in the locked quote with no flag, no
 * fallback, nobody told (reproduced live on dev). The locked contract must
 * mark such rows `price_unknown: true` and flip the result's low_confidence
 * signal (persisted as bookings.low_confidence_parts) so the mechanic's
 * post-job confirmation knows the line needs a real price.
 */
import { describe, expect, it } from "vitest";
import { snapshotRowsForResolution } from "../convex/booking_quotes";
import type { Id } from "../convex/_generated/dataModel";

const svcId = "svc1" as Id<"services">;

const PRICED_SUMMARY = {
  part_id: "p1",
  average: 25,
  median: 24,
  trimmed_median: 24,
  min_kept: 20,
  max_kept: 30,
  sample_size: 3,
  used: 3,
  sources_used: [],
};

const EMPTY_SUMMARY = {
  part_id: "p2",
  average: 0,
  median: 0,
  trimmed_median: 0,
  min_kept: 0,
  max_kept: 0,
  sample_size: 0,
  used: 0,
  sources_used: [],
};

function roleWinner(overrides: Record<string, any>) {
  return {
    roleKey: "front_pads",
    serviceRole: "core",
    candidate: {
      part: {
        _id: "p1",
        oem_part_number: "34116860242",
        name: "Front Brake Pad Set",
        brand: "BMW",
      },
      fitment: {},
      priceSummary: PRICED_SUMMARY,
    },
    losers: [],
    source: "scored",
    lowConfidence: false,
    quantity: 1,
    quantityBasis: "fitment",
    includeInLockedQuote: true,
    ...overrides,
  };
}

describe("snapshotRowsForResolution — price_unknown contract (item 10)", () => {
  it("prices a normal locked winner with no price_unknown marker", () => {
    const res = snapshotRowsForResolution(svcId, {
      lowConfidence: false,
      roleWinners: [roleWinner({})],
    } as any);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].unit_price_cents).toBe(2500);
    expect(res.rows[0].line_total_cents).toBe(2500);
    expect(res.rows[0].price_unknown).toBeUndefined();
    expect(res.low_confidence).toBe(false);
  });

  it("marks an all-poison (empty-summary) locked winner price_unknown and flips low_confidence", () => {
    const res = snapshotRowsForResolution(svcId, {
      lowConfidence: false,
      roleWinners: [
        roleWinner({
          candidate: {
            part: { _id: "p2", oem_part_number: "1K0615301", name: "Rotor" },
            fitment: {},
            priceSummary: EMPTY_SUMMARY,
          },
        }),
      ],
    } as any);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].unit_price_cents).toBe(0);
    expect(res.rows[0].price_unknown).toBe(true);
    expect(res.low_confidence).toBe(true);
  });

  it("keeps as_needed roles out of the locked rows (unpriced or not)", () => {
    const res = snapshotRowsForResolution(svcId, {
      lowConfidence: false,
      roleWinners: [
        roleWinner({
          serviceRole: "as_needed",
          includeInLockedQuote: false,
          candidate: {
            part: { _id: "p2", oem_part_number: "1K0615301", name: "Rotor" },
            fitment: {},
            priceSummary: EMPTY_SUMMARY,
          },
        }),
      ],
    } as any);
    expect(res.rows).toHaveLength(0);
    // Not in the locked contract — must not flip the booking-level flag.
    expect(res.low_confidence).toBe(false);
    // But the selection trace still records the role.
    expect(res.trace).toHaveLength(1);
  });

  it("emits a no_candidates trace row for an empty resolution", () => {
    const res = snapshotRowsForResolution(svcId, {
      lowConfidence: false,
      roleWinners: [],
    } as any);
    expect(res.rows).toHaveLength(0);
    expect(res.trace).toEqual([
      { service_id: svcId, winner_part_id: undefined, source: "no_candidates" },
    ]);
  });

  it("propagates resolution-level lowConfidence", () => {
    const res = snapshotRowsForResolution(svcId, {
      lowConfidence: true,
      roleWinners: [roleWinner({})],
    } as any);
    expect(res.low_confidence).toBe(true);
  });
});
