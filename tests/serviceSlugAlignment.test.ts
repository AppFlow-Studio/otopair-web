/**
 * Durable guard for the census P0.1 routing-bug class: a slug that exists in a
 * vocabulary but NOT in the seeded services catalog resolves to null, and the
 * write is silently `continue`d — no error, no gap entry, just missing data.
 * That is how serpentine-belt intervals + labor were lost on every run, and how
 * six Batch-2 service names had their pricing/labor thrown away.
 *
 * These tests fail loudly the moment a vocabulary drifts from the seed again.
 */
import { describe, expect, test } from "vitest";
import {
  ALL_SERVICE_SEEDS,
  SEEDED_SERVICE_SLUGS,
} from "../convex/seeds/seedServices";
import { OTOPAIR_SERVICE_SLUGS } from "../convex/lib/vehicleDatabases";
import { SERVICE_LIST } from "../convex/vehicleEnrichment/types";
import { SERVICE_NAME_TO_SLUG, INTERVAL_TO_SERVICE } from "../convex/vehicleEnrichment/v3pipeline";

const SEEDED_SLUGS = new Set(SEEDED_SERVICE_SLUGS);

describe("service slug alignment", () => {
  test("every 1C VDB vocabulary slug is a seeded service", () => {
    const orphans = OTOPAIR_SERVICE_SLUGS.filter((s) => !SEEDED_SLUGS.has(s));
    expect(orphans).toEqual([]);
  });

  test("every Batch-2 SERVICE_LIST name maps to a seeded service", () => {
    const unmapped = SERVICE_LIST.filter((name) => {
      const slug = SERVICE_NAME_TO_SLUG[name];
      return !slug || !SEEDED_SLUGS.has(slug);
    });
    expect(unmapped).toEqual([]);
  });

  test("every INTERVAL_TO_SERVICE target is a seeded service", () => {
    const orphans = Object.entries(INTERVAL_TO_SERVICE)
      .filter(([, slug]) => !SEEDED_SLUGS.has(slug as string))
      .map(([key]) => key);
    expect(orphans).toEqual([]);
  });

  test("interval keys map to DISTINCT services (diff vs transfer case must not collide)", () => {
    // Both used to map to differential_service, so whichever the loop wrote
    // second overwrote the other on the same service_intervals row.
    expect(INTERVAL_TO_SERVICE.diff_fluid).not.toBe(
      INTERVAL_TO_SERVICE.transfer_case_fluid,
    );
  });

  test("dataset-only services are seeded but never bookable", () => {
    const serpentine = ALL_SERVICE_SEEDS.find((s) => s.slug === "serpentine_belt");
    expect(serpentine).toBeDefined();
    // We do not offer the service — but the car's belt data still belongs in
    // the dataset (parts, interval, labor).
    expect(serpentine!.is_bookable).toBe(false);
  });
});
