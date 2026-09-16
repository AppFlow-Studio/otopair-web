/**
 * One physical finding, one card.
 *
 * Ahmad, 2026-09-04: a coolant flush rendered twice — once as the interval row
 * ("50,001 mi past interval — Coolant flush overdue") and once as the
 * mechanic's eye-check recommendation ("Coolant Flush flagged on eye-check
 * (monitor) · Suggested by James Bond at Chelala Service Center"). Both cards
 * were true. Two cards for one job is not.
 *
 * The interval row wins, which is the OPPOSITE of how the same collision is
 * resolved for minor eye-check items — and the asymmetry is the whole point.
 * A minor item is a bare grade with nothing behind it, so the recommendation
 * is strictly richer. An interval row carries the mileage maths and the
 * driver's own answer, and unlike a recommendation it SCORES: dropping it
 * would silently raise the health score the moment a mechanic mentioned the
 * service.
 */
import { describe, expect, it } from "vitest";
import { buildMergedMaintenanceItems } from "@/utils/mergedMaintenance";

const NOW = new Date(2026, 8, 4).getTime();
const CLASS_B = { vehicleClass: "B", drivetrain: "awd", hasDifferential: true };

function build(opts: {
  odometer: number;
  year: number;
  urgency?: string;
  rec?: boolean;
  slugResolves?: boolean;
}) {
  return buildMergedMaintenanceItems({
    userItems: new Map(),
    vehicleYear: opts.year,
    now: NOW,
    currentOdometer: opts.odometer,
    // No OEM intervals here: this suite exercises the class-table fallback.
    // Explicit opt-out — the input is required on BuildMergedMaintenanceInput.
    oemIntervals: undefined,
    scopeId: "v",
    classCtx: CLASS_B as never,
    records: [
      {
        type: "catalog_coolant_flush",
        lastServiceMileage: 0,
        lastServiceDate: new Date(opts.year, 0, 1).getTime(),
        customInputs: { answerType: "never" },
      },
    ] as never,
    serviceSlugById: (id: string) =>
      opts.slugResolves === false ? undefined : id === "svc_coolant" ? "coolant_flush" : undefined,
    driverRecommendations: opts.rec === false ? [] : ([
      {
        _id: "rec1",
        service_id: "svc_coolant",
        service_name: "Coolant Flush",
        urgency: opts.urgency ?? "within_3_months",
        reason: "Coolant Flush flagged on eye-check (monitor)",
        shop_name: "Chelala Service Center",
        mechanic_name: "James Bond",
      },
    ] as never),
  });
}

const coolantCards = (items: ReturnType<typeof build>) =>
  items.filter((i) => /coolant/i.test(i.serviceName));

describe("the reported duplicate", () => {
  it("renders one card, not two", () => {
    expect(coolantCards(build({ odometer: 130_000, year: 2020 }))).toHaveLength(1);
  });

  it("keeps the interval row, not the recommendation", () => {
    const [card] = coolantCards(build({ odometer: 130_000, year: 2020 }));
    expect(card.id).toBe("catalog-coolant_flush");
    expect(card.description).toMatch(/past interval/);
  });

  it("does not lose the mechanic's attribution", () => {
    // "Suggested by …" renders off mechanicProvenance alone, so folding it in
    // carries the credit without dragging the recommendation lifecycle along.
    const [card] = coolantCards(build({ odometer: 130_000, year: 2020 }));
    expect(card.mechanicProvenance).toEqual({
      shopName: "Chelala Service Center",
      mechanicName: "James Bond",
    });
  });

  it("still scores exactly what the interval said", () => {
    const merged = coolantCards(build({ odometer: 130_000, year: 2020 }))[0];
    const alone = coolantCards(build({ odometer: 130_000, year: 2020, rec: false }))[0];
    expect(merged.rawScore).toBe(alone.rawScore);
    expect(merged.excludeFromScore).toBe(alone.excludeFromScore);
  });
});

describe("a mechanic can make the card louder, never quieter", () => {
  it("does not bury an urgent finding in HEALTHY", () => {
    // Interval says the coolant is fine; the mechanic says service it soon.
    // Folding that into an on_time row would hide it in the quiet section.
    const [card] = coolantCards(build({ odometer: 5_000, year: 2024, urgency: "soon" }));
    expect(card.status).toBe("overdue");
  });

  it("escalates the display without starting a deduction", () => {
    // Recommendations are excluded from Upkeep today; this merge is not the
    // change that reverses that. rawScore stays pinned to the interval.
    const [card] = coolantCards(build({ odometer: 5_000, year: 2024, urgency: "soon" }));
    expect(card.rawScore).toBe(1);
  });

  it("leaves a quieter recommendation alone", () => {
    const [card] = coolantCards(build({ odometer: 130_000, year: 2020, urgency: "within_3_months" }));
    expect(card.status).toBe("overdue"); // the interval's own verdict, unchanged
  });
});

describe("when the merge cannot be made", () => {
  it("keeps both cards rather than dropping the mechanic's finding", () => {
    // Oto's server-side merge passes no serviceSlugById, so no slug resolves.
    // Degrading to today's behaviour is right; silently discarding a
    // mechanic's recommendation is not.
    expect(coolantCards(build({ odometer: 130_000, year: 2020, slugResolves: false })))
      .toHaveLength(2);
  });
});
