/**
 * Prioritized price-URL discovery queue ordering.
 *
 * Live finding (Jul 2026, 2012 Audi A4): the per-run discovery budget (10) was
 * spent first-come-first-served in fitment iteration order with a silent skip
 * once exhausted — the battery (sole part of battery_replacement) and rear
 * brake pads ended with 0 price rows while front pads held 4. The queue must
 * spend budget on quotability first.
 */
import { describe, it, expect } from "vitest";
import {
  prioritizeDiscoveryQueue,
  type DiscoveryQueueItem,
} from "../convex/vehicleEnrichment/priceDiscovery";

const item = (
  partId: string,
  serviceSlug: string,
  serviceRole: string | null = "core",
  subcategory: string | null = null,
): DiscoveryQueueItem => ({
  partId,
  oem: `OEM-${partId}`,
  name: partId,
  subcategory: subcategory ?? partId,
  serviceSlug,
  serviceRole,
});

describe("prioritizeDiscoveryQueue", () => {
  it("puts core parts of zero-priced services first (the A4 battery/rear-pads scenario)", () => {
    // oil_change already has a priced part; battery_replacement and
    // brake_pad_replacement have none.
    const priced = new Map([["oil_change", 1]]);
    const queue = [
      item("extra_oil_source", "oil_change", "core"),
      item("wear_sensor", "brake_pad_replacement", "as_needed"),
      item("battery", "battery_replacement", "core"),
      item("rear_pads", "brake_pad_replacement", "core"),
    ];
    const ordered = prioritizeDiscoveryQueue(queue, priced);
    expect(ordered.map((i) => i.partId)).toEqual([
      "battery",      // tier 0: core on zero-priced service (stable order)
      "rear_pads",    // tier 0
      "extra_oil_source", // tier 1: core on already-priced service
      "wear_sensor",  // tier 2: as_needed
    ]);
  });

  it("with budget 2, exactly the two tier-0 parts are attempted first", () => {
    const priced = new Map([["oil_change", 1]]);
    const ordered = prioritizeDiscoveryQueue(
      [
        item("extra_oil_source", "oil_change", "core"),
        item("battery", "battery_replacement", "core"),
        item("rear_pads", "brake_pad_replacement", "core"),
      ],
      priced,
    );
    const budgeted = ordered.slice(0, 2).map((i) => i.partId);
    expect(budgeted).toEqual(["battery", "rear_pads"]);
    // the leftover is the already-covered service's extra source
    expect(ordered[2].partId).toBe("extra_oil_source");
  });

  it("treats an unclassifiable role as core (fail-closed, like the quote engine)", () => {
    const ordered = prioritizeDiscoveryQueue(
      [item("kit_part", "transmission_service", "kit"), item("orphan", "coolant_flush", null)],
      new Map(),
    );
    expect(ordered[0].partId).toBe("orphan");
  });

  it("is stable within tiers and does not mutate the input", () => {
    const queue = [
      item("a", "svc1", "core"),
      item("b", "svc2", "core"),
      item("c", "svc3", "core"),
    ];
    const snapshot = [...queue];
    const ordered = prioritizeDiscoveryQueue(queue, new Map());
    expect(ordered.map((i) => i.partId)).toEqual(["a", "b", "c"]);
    expect(queue).toEqual(snapshot);
  });
});
