/**
 * Rotor grading honesty.
 *
 * Two failure directions, both expensive:
 *   ref too HIGH (a nominal mistaken for a minimum) -> healthy rotors read
 *     "Below min" and we recommend brake jobs that aren't needed.
 *   ref too LOW (or absent, via the old `ref ?? 0` fallback) -> worn rotors
 *     read "In spec".
 *
 * Regression anchor: classify() used `const r = typeof ref === "number" ? ref : 0`,
 * so a vehicle with no OEM minimum on file graded every rotor as a clean pass.
 * The whole fleet was previously graded against a hardcoded 23.0 / 8.0 while the
 * field hint called those numbers "OEM min".
 */
import { describe, it, expect } from "vitest";
import {
  buildInspectionZones,
  classify,
  createInspectionState,
  deriveSuggestedRecommendations,
  INSPECTION_ZONES,
  NO_ROTOR_REF,
  type InspectionState,
  type RotorRef,
} from "../lib/inspection-template";

const SOURCED: RotorRef = {
  minMm: 24,
  kind: "oem_spec",
  nominalMm: 26,
  sourceDomain: "subaru.oempartsonline.com",
};
const ESTIMATED: RotorRef = { minMm: 24, kind: "derived_from_nominal", nominalMm: 26 };
const NOMINAL_ONLY: RotorRef = { minMm: null, kind: "none", nominalMm: 26 };

function rotorState(mm: string): InspectionState {
  const state = createInspectionState();
  for (const corner of ["FL", "FR", "RL", "RR"] as const) {
    const zone = state.zones[corner];
    if (zone) {
      zone.measures.rotor = mm;
      zone.done = true;
    }
  }
  return state;
}

describe("classify('rotor') — no minimum on file", () => {
  it("returns unknown, NOT ok, when there is no reference", () => {
    const res = classify("rotor", 23.0, NO_ROTOR_REF);
    expect(res.lvl).toBe("unknown");
    expect(res.lvl).not.toBe("ok");
    expect(res.txt).toBe("No OEM min");
  });

  it("returns unknown for an omitted ref — the old `ref ?? 0` graded this as In spec", () => {
    expect(classify("rotor", 23.0, undefined).lvl).toBe("unknown");
    expect(classify("rotor", 0.5, null).lvl).toBe("unknown");
  });

  it("a nominal-only ref is still unknown — nominal is never graded against", () => {
    expect(classify("rotor", 25.0, NOMINAL_ONLY).lvl).toBe("unknown");
  });
});

describe("classify('rotor') — sourced minimum", () => {
  it("grades normally", () => {
    expect(classify("rotor", 26.0, SOURCED)).toEqual({ lvl: "ok", txt: "In spec" });
    expect(classify("rotor", 24.5, SOURCED)).toEqual({ lvl: "warn", txt: "Near min" });
    expect(classify("rotor", 23.5, SOURCED)).toEqual({ lvl: "bad", txt: "Below min" });
  });
});

describe("classify('rotor') — estimated minimum is capped at warn", () => {
  it("never returns a clean pass", () => {
    const res = classify("rotor", 30.0, ESTIMATED);
    expect(res.lvl).toBe("warn");
    expect(res.lvl).not.toBe("ok");
    expect(res.txt).toBe("In spec (est. min)");
  });

  it("labels every estimated verdict as an estimate", () => {
    expect(classify("rotor", 24.5, ESTIMATED).txt).toBe("Near min (est.)");
    expect(classify("rotor", 23.0, ESTIMATED).txt).toBe("Below min (est.)");
  });

  it("a bare number ref carries no provenance, so it is treated as an estimate", () => {
    expect(classify("rotor", 30.0, 24).lvl).toBe("warn");
  });
});

describe("buildInspectionZones — hint text", () => {
  const hintFor = (ref: RotorRef | undefined) => {
    const zones = buildInspectionZones({ frontRotor: ref });
    const fl = zones.find((z) => z.id === "FL")!;
    const field = fl.fields.find(
      (f) => f.type === "measure" && f.key === "rotor",
    );
    return field && field.type === "measure" ? field.hint : undefined;
  };

  it("names the source when the minimum is real", () => {
    expect(hintFor(SOURCED)).toBe("OEM min 24.0 mm · subaru.oempartsonline.com");
  });

  it("marks an estimate as unverified", () => {
    expect(hintFor(ESTIMATED)).toContain("UNVERIFIED");
  });

  it("tells the mechanic to read the casting when nothing is on file", () => {
    expect(hintFor(undefined)).toBe(
      "No OEM minimum on file — read MIN TH cast on the rotor.",
    );
  });

  it("shows nominal but says plainly it is not the minimum", () => {
    const hint = hintFor(NOMINAL_ONLY)!;
    expect(hint).toContain("26.0 mm is NOT the minimum");
  });

  it("the default template carries no rotor minimum at all", () => {
    const fl = INSPECTION_ZONES.find((z) => z.id === "FL")!;
    const field = fl.fields.find((f) => f.type === "measure" && f.key === "rotor");
    expect(field && field.type === "measure" ? field.ref : null).toEqual(NO_ROTOR_REF);
  });
});

describe("cast-minimum capture", () => {
  const castField = (ref: RotorRef | undefined, zoneId: string) => {
    const zones = buildInspectionZones({ frontRotor: ref, rearRotor: ref });
    const zone = zones.find((z) => z.id === zoneId)!;
    return zone.fields.find(
      (f) => f.type === "measure" && f.key === "rotor_min_cast",
    );
  };

  it("asks for the cast minimum when none is on file", () => {
    expect(castField(undefined, "FL")).toBeDefined();
    expect(castField(undefined, "RL")).toBeDefined();
  });

  it("asks when the minimum we hold is only an estimate", () => {
    expect(castField(ESTIMATED, "FL")).toBeDefined();
  });

  it("does NOT ask once a real minimum is on file", () => {
    expect(castField(SOURCED, "FL")).toBeUndefined();
  });

  it("asks once per axle, not on every corner", () => {
    expect(castField(undefined, "FR")).toBeUndefined();
    expect(castField(undefined, "RR")).toBeUndefined();
  });
});

describe("deriveSuggestedRecommendations — rotor", () => {
  const recFor = (state: InspectionState, ref: RotorRef | undefined) =>
    deriveSuggestedRecommendations(state, {
      zones: buildInspectionZones({ frontRotor: ref, rearRotor: ref }),
    }).find((r) => r.key === "rotors");

  it("suggests replacement off a sourced minimum", () => {
    const rec = recFor(rotorState("23.0"), SOURCED);
    expect(rec?.urgency).toBe("soon");
    expect(rec?.requires_confirmation).toBeUndefined();
    expect(rec?.reason).toContain("below OEM minimum");
  });

  it("NEVER auto-suggests replacement when there is no minimum on file", () => {
    expect(recFor(rotorState("1.0"), undefined)).toBeUndefined();
  });

  it("downgrades an estimated-minimum finding and demands confirmation", () => {
    const rec = recFor(rotorState("23.0"), ESTIMATED);
    expect(rec?.urgency).toBe("next_visit");
    expect(rec?.requires_confirmation).toBe(true);
    expect(rec?.reason).toContain("ESTIMATED");
    expect(rec?.reason).toContain("cast on the rotor");
  });

  it("a healthy rotor on a sourced minimum produces no suggestion", () => {
    expect(recFor(rotorState("26.0"), SOURCED)).toBeUndefined();
  });
});
