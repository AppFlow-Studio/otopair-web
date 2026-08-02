/**
 * drivetrainReconcile — NHTSA axle count is authoritative; the AI/LLM only
 * refines within an axle class. Batch-3 regression: "4x2" VINs must not be
 * upgraded to AWD/4WD by an LLM guess.
 */
import { describe, expect, test } from "vitest";
import {
  reconcileDrivetrain,
  nhtsaAxleClass,
  refine2wdByBody,
} from "../convex/vehicleEnrichment/drivetrainReconcile";

describe("nhtsaAxleClass", () => {
  test("4x2 is a 2WD signal (the batch-3 bug fix)", () => {
    expect(nhtsaAxleClass("4x2")).toBe("2wd");
  });
  test("4x4 / AWD are 4WD signals", () => {
    expect(nhtsaAxleClass("4x4")).toBe("4wd");
    expect(nhtsaAxleClass("AWD/All-Wheel Drive")).toBe("4wd");
  });
  test("FWD/RWD are 2WD; unknown is null", () => {
    expect(nhtsaAxleClass("FWD")).toBe("2wd");
    expect(nhtsaAxleClass("RWD")).toBe("2wd");
    expect(nhtsaAxleClass("")).toBeNull();
    expect(nhtsaAxleClass(null)).toBeNull();
  });
});

describe("refine2wdByBody", () => {
  test("pickups/cargo vans → RWD", () => {
    expect(refine2wdByBody("Pickup")).toBe("RWD");
    expect(refine2wdByBody("Cargo Van")).toBe("RWD");
    expect(refine2wdByBody("Truck-Tractor")).toBe("RWD");
  });
  test("minivans/crossovers/sedans → FWD", () => {
    expect(refine2wdByBody("Minivan")).toBe("FWD");
    expect(refine2wdByBody("Sport Utility Vehicle (SUV)/Multi-Purpose Vehicle (MPV)")).toBe("FWD");
    expect(refine2wdByBody("Sedan")).toBe("FWD");
    expect(refine2wdByBody(null)).toBe("FWD");
  });
});

describe("reconcileDrivetrain", () => {
  test("Sienna: NHTSA 4x2 (minivan) beats LLM AWD guess → FWD", () => {
    expect(reconcileDrivetrain("4x2", "AWD", "Minivan")).toBe("FWD");
  });

  test("F-150: NHTSA 4x2 (pickup) beats LLM 4WD guess → RWD", () => {
    expect(reconcileDrivetrain("4x2", "4WD", "Pickup")).toBe("RWD");
  });

  test("agree on axle → AI's specific label is kept (NHTSA 4x2 can't tell FWD/RWD)", () => {
    expect(reconcileDrivetrain("4x2", "FWD", "Minivan")).toBe("FWD");
    expect(reconcileDrivetrain("4x2", "RWD", "Pickup")).toBe("RWD");
  });

  test("NHTSA 4x4 + AI AWD (agree on 4wd axle) → keep AI's AWD refinement", () => {
    expect(reconcileDrivetrain("4x4", "AWD", "SUV")).toBe("AWD");
  });

  test("NHTSA 4x4 beats an LLM FWD guess → 4WD", () => {
    expect(reconcileDrivetrain("4x4", "FWD", "Pickup")).toBe("4WD");
  });

  test("no NHTSA signal → trust the AI value (prior behavior preserved)", () => {
    expect(reconcileDrivetrain("", "AWD")).toBe("AWD");
    expect(reconcileDrivetrain(null, "FWD")).toBe("FWD");
    expect(reconcileDrivetrain(undefined, undefined)).toBeUndefined();
  });

  test("canonical strings work in the authoritative slot (v3pipeline resolution reuse)", () => {
    // existingDrivetrain is already canonical FWD; a Batch-1B AWD must not win.
    expect(reconcileDrivetrain("FWD", "AWD")).toBe("FWD");
    // unknown existing → LLM fills.
    expect(reconcileDrivetrain("unknown", "AWD")).toBe("AWD");
  });
});
