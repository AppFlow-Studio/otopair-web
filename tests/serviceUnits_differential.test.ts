/**
 * differential_service per_unit_spec conversion — unit-count resolution from
 * drivetrain_configs.diff_fluid_capacity_qts (enriched) with the engines
 * column (director edits) as fallback, and baseline-2 scaling.
 */
import { describe, expect, test } from "vitest";
import {
  resolveServiceUnitCount,
  unitScale,
} from "../convex/lib/serviceUnits";
import type { Doc } from "../convex/_generated/dataModel";

const service = {
  parts_kind: "per_unit_spec",
  parts_unit_label: "qt",
  parts_unit_spec_source: "differential_fluid_capacity_qts",
} as unknown as Doc<"services">;

const engine = (diffQts?: number) =>
  ({ differential_fluid_capacity_qts: diffQts }) as unknown as Doc<"engines">;

const drivetrain = (diffQts?: number) =>
  ({ diff_fluid_capacity_qts: diffQts }) as unknown as Doc<"drivetrain_configs">;

describe("differential_service per_unit_spec", () => {
  test("resolves from the drivetrain doc first", () => {
    const res = resolveServiceUnitCount({
      service,
      engine: engine(undefined),
      drivetrain: drivetrain(3),
      bookingPosition: null,
      baselineFromSpec: 2,
    });
    expect(res.count).toBe(3);
    expect(res.is_estimate).toBe(false);
    expect(res.label).toBe("qt");
  });

  test("falls back to the engines column (director edit) when drivetrain has none", () => {
    const res = resolveServiceUnitCount({
      service,
      engine: engine(1.5),
      drivetrain: drivetrain(undefined),
      bookingPosition: null,
      baselineFromSpec: 2,
    });
    expect(res.count).toBe(1.5);
    expect(res.is_estimate).toBe(false);
  });

  test("drivetrain value wins over engine value", () => {
    const res = resolveServiceUnitCount({
      service,
      engine: engine(1.5),
      drivetrain: drivetrain(3),
      bookingPosition: null,
      baselineFromSpec: 2,
    });
    expect(res.count).toBe(3);
  });

  test("both missing → baseline with is_estimate", () => {
    const res = resolveServiceUnitCount({
      service,
      engine: engine(undefined),
      drivetrain: null,
      bookingPosition: null,
      baselineFromSpec: 2,
    });
    expect(res.count).toBe(2);
    expect(res.is_estimate).toBe(true);
  });

  test("baseline-2 scaling: a 3-qt diff scales the band by 1.5×, not 3×", () => {
    const res = resolveServiceUnitCount({
      service,
      engine: null,
      drivetrain: drivetrain(3),
      bookingPosition: null,
      baselineFromSpec: 2, // Camry band = 2 qt
    });
    expect(unitScale(res)).toBeCloseTo(1.5);
  });

  test("transmission_service resolves ATF capacity from the transmissions doc first", () => {
    const transService = {
      parts_kind: "per_unit_spec",
      parts_unit_label: "qt",
      parts_unit_spec_source: "transmission_fluid_capacity_qts",
    } as unknown as Doc<"services">;
    const res = resolveServiceUnitCount({
      service: transService,
      engine: { transmission_fluid_capacity_qts: 6 } as unknown as Doc<"engines">,
      transmission: { fluid_capacity_drain_fill_qts: 4.5 } as unknown as Doc<"transmissions">,
      bookingPosition: null,
      baselineFromSpec: 4,
    });
    expect(res.count).toBe(4.5); // transmissions doc wins over engines column
    expect(res.is_estimate).toBe(false);
  });

  test("transmission_service falls back to the engines column (director edit)", () => {
    const transService = {
      parts_kind: "per_unit_spec",
      parts_unit_label: "qt",
      parts_unit_spec_source: "transmission_fluid_capacity_qts",
    } as unknown as Doc<"services">;
    const res = resolveServiceUnitCount({
      service: transService,
      engine: { transmission_fluid_capacity_qts: 6 } as unknown as Doc<"engines">,
      transmission: {} as unknown as Doc<"transmissions">,
      bookingPosition: null,
      baselineFromSpec: 4,
    });
    expect(res.count).toBe(6);
  });

  test("other per_unit_spec fields still read only from the engine", () => {
    const coolantService = {
      parts_kind: "per_unit_spec",
      parts_unit_label: "qt",
      parts_unit_spec_source: "coolant_capacity_qts",
    } as unknown as Doc<"services">;
    const res = resolveServiceUnitCount({
      service: coolantService,
      engine: { coolant_capacity_qts: 9 } as unknown as Doc<"engines">,
      drivetrain: drivetrain(3), // must be ignored for coolant
      bookingPosition: null,
      baselineFromSpec: 7,
    });
    expect(res.count).toBe(9);
  });
});
