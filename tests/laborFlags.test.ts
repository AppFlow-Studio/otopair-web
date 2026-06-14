import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { laborFlagsFromEnv } from "../convex/vehicleEnrichment/laborResearch";

const ENV_KEYS = ["LABOR_SOURCE_OLP", "LABOR_SOURCE_REPAIRPAL", "LABOR_SOURCE_WEB"] as const;

describe("laborFlagsFromEnv", () => {
  // Snapshot and restore env vars so tests don't leak state into the suite.
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    snapshot = {};
    for (const key of ENV_KEYS) {
      snapshot[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const saved = snapshot[key];
      if (saved === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved;
      }
    }
  });

  it("all three vars absent → OLP default-on, repairpal and web default-off", () => {
    expect(laborFlagsFromEnv()).toEqual({ olp: true, repairpal: false, web: false });
  });

  it("LABOR_SOURCE_OLP='off' → olp: false", () => {
    process.env.LABOR_SOURCE_OLP = "off";
    expect(laborFlagsFromEnv()).toMatchObject({ olp: false });
  });

  it("LABOR_SOURCE_REPAIRPAL='on' → repairpal: true", () => {
    process.env.LABOR_SOURCE_REPAIRPAL = "on";
    expect(laborFlagsFromEnv()).toMatchObject({ repairpal: true });
  });

  it("LABOR_SOURCE_WEB='on' → web: true", () => {
    process.env.LABOR_SOURCE_WEB = "on";
    expect(laborFlagsFromEnv()).toMatchObject({ web: true });
  });

  it("non-'on' value (e.g. 'true') for LABOR_SOURCE_WEB → web: false (must be exactly 'on')", () => {
    process.env.LABOR_SOURCE_WEB = "true";
    expect(laborFlagsFromEnv()).toMatchObject({ web: false });
  });
});
