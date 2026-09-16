import { describe, it, expect } from "vitest";
import { buildMergedMaintenanceItems } from "@/utils/mergedMaintenance";
import { buildMaintenanceItems } from "@/utils/maintenanceEnrichment";
import { ALL_MAINTENANCE_TYPES } from "@/utils/maintenanceStatus";

// Locks the Cars-page merge behavior that useMergedMaintenance used to inline, so
// it can be shared with Oto's get_vehicle_health for score convergence without
// drift. The ring uses OPTIMISTIC no-record fallbacks (oil -> due_soon, others
// -> on_time), appends mechanic driver recs, and adds the consolidated
// unpaired-light item.
const NOW = 1_700_000_000_000;

function merge(overrides: {
  records?: any[];
  knownIssues?: string[];
  vehicleYear?: number;
  driverRecommendations?: any[];
  scopeId?: string;
} = {}) {
  const records = overrides.records ?? [];
  const userItems = buildMaintenanceItems(
    records.map((r: any) => ({
      type: r.type,
      lastServiceDate: r.lastServiceDate,
      lastServiceMileage: r.lastServiceMileage,
      customInputs: r.customInputs,
      confirmedHealthyAt: r.confirmedHealthyAt,
    })),
    40000,
    undefined,
    undefined,
    undefined,
    overrides.knownIssues,
    overrides.vehicleYear,
    undefined,
  );
  return buildMergedMaintenanceItems({
    userItems,
    records,
    knownIssues: overrides.knownIssues,
    vehicleYear: overrides.vehicleYear,
    driverRecommendations: overrides.driverRecommendations,
    scopeId: overrides.scopeId ?? "owner_1",
    now: NOW,
    // This suite exercises the anchored-only merge; the catalog-pass inputs are
    // explicitly opted out rather than forgotten (see the requiredness note on
    // BuildMergedMaintenanceInput).
    currentOdometer: undefined,
    oemIntervals: undefined,
    classCtx: undefined,
    serviceSlugById: undefined,
  });
}

describe("buildMergedMaintenanceItems (shared Cars-page / Oto merge)", () => {
  it("emits one item per tracked maintenance type when there are no records", () => {
    const items = merge();
    // oil/brakes/tires/battery (inspection excluded until a record exists).
    expect(items.length).toBeGreaterThanOrEqual(ALL_MAINTENANCE_TYPES.length);
  });

  it("reports no-record types as unknown rather than guessing at them", () => {
    // Was: "optimistic no-record fallbacks (oil -> due_soon, brakes -> on_time)".
    // Those guesses told a 300,000-mile car its brakes were fine, and because
    // they never arrived as `unknown` they slipped past §08's exclusion and
    // scored — a fixed 93 for every record-less vehicle. Ahmad, 2026-08-27.
    const items = merge();
    const oil = items.find((i) => i.id === "unknown-oil");
    const brakes = items.find((i) => i.id === "unknown-brakes");
    expect(oil?.status).toBe("unknown");
    expect(brakes?.status).toBe("unknown");
    expect(brakes?.description).toMatch(/not on file|history on file/i);
  });

  it("appends a mechanic driver recommendation as a rec-* item", () => {
    const items = merge({
      driverRecommendations: [
        {
          _id: "rec1",
          service_id: "svc1",
          service_name: "Tire Rotation",
          urgency: "next_visit",
          reason: "Recommended by your mechanic",
          shop_name: "ExpressAuto",
          mechanic_name: "John Stamos",
        } as any,
      ],
    });
    const rec = items.find((i) => i.id === "rec-rec1");
    expect(rec).toBeTruthy();
    expect(rec?.serviceName).toBe("Tire Rotation");
    expect(rec?.status).toBe("due_soon"); // next_visit -> due_soon
  });

  it("escalates the paired tile to overdue and adds the consolidated card for an unpaired light", () => {
    const items = merge({ knownIssues: ["oil_pressure", "temperature"] });
    const oil = items.find((i) => i.id === "unknown-oil");
    expect(oil?.status).toBe("overdue"); // oil_pressure paired -> escalated
    const warning = items.find((i) => i.id.startsWith("warning-active-"));
    expect(warning).toBeTruthy(); // temperature is unpaired -> consolidated card
  });

  it("forces on_time when a record was confirmed healthy in the last 90 days", () => {
    const items = merge({
      records: [{ type: "brakes", lastServiceMileage: 10000, confirmedHealthyAt: NOW - 1000 }],
    });
    const brakes = items.find((i) => i.id.includes("brakes"));
    expect(brakes?.status).toBe("on_time");
  });

  // A from-odometer catalog item (coolant flush) must close out once the exact
  // service is recorded — measured from the slug-specific minor anchor, not from
  // new — and surface the "Resolved by [shop]" overlay until acked.
  it("closes out a catalog-inference item once its slug-specific service is recorded, with the resolved overlay", () => {
    const oemIntervals = {
      coolant_flush: { interval_miles: 100000, interval_months: null },
    } as any;
    const currentOdometer = 171000;

    // Before service: no anchor at all → UNKNOWN, not overdue.
    //
    // This assertion was "overdue" when Temur wrote it, and measuring from new
    // was the behaviour then. Ahmad changed it during Quick Check v2: a row we
    // have no record for is unknown, not a finding. Calling it overdue asserts
    // wear we have not observed — the car may have had the service last month
    // at a shop we have never heard of. The rest of this test is unchanged and
    // still guards what it was written to guard: the close-out and the
    // resolved overlay.
    const before = buildMergedMaintenanceItems({
      userItems: new Map(),
      records: [],
      scopeId: "owner_1",
      now: NOW,
      currentOdometer,
      oemIntervals,
      classCtx: undefined,
      serviceSlugById: undefined,
    });
    expect(before.find((i) => i.id === "catalog-coolant_flush")?.status).toBe("unknown");

    // After service: the minor anchor carries the completion mileage + booking →
    // on_time AND resolved (targets minor_cool_condition for the ack).
    const after = buildMergedMaintenanceItems({
      userItems: new Map(),
      records: [
        {
          type: "minor_cool_condition",
          lastServiceMileage: 171000,
          lastServiceDate: NOW,
          lastServiceBookingId: "booking_123",
          lastServiceShopName: "Brooklyn Auto",
        },
      ] as any,
      scopeId: "owner_1",
      now: NOW,
      currentOdometer,
      oemIntervals,
      classCtx: undefined,
      serviceSlugById: undefined,
    });
    const coolant = after.find((i) => i.id === "catalog-coolant_flush");
    expect(coolant?.status).toBe("on_time");
    expect(coolant?.resolvedByBookingId).toBe("booking_123");
    expect(coolant?.resolvedRecordType).toBe("minor_cool_condition");
    expect(coolant?.resolvedShopName).toBe("Brooklyn Auto");
  });
});
