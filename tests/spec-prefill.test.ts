import { describe, expect, it } from "vitest";

import {
  isSpecPrefillField,
  specPrefillFromPassport,
} from "../lib/inspection-template";
import type {
  PassportSource,
  VehiclePassportSnapshot,
} from "../lib/vehicle-passport";

function snapshot(
  overrides: Partial<VehiclePassportSnapshot> = {},
): VehiclePassportSnapshot {
  return {
    tires: {},
    fluids: {},
    brakes: {},
    inspection: {},
    modifications: { has_mods: false, affected_systems: [] },
    ...overrides,
  };
}

describe("specPrefillFromPassport", () => {
  it("seeds tire identity across corners, splitting size by axle", () => {
    const out = specPrefillFromPassport(
      snapshot({
        tires: {
          brand: "Michelin",
          model: "Defender",
          size_front: "225/45R18",
          size_rear: "255/40R18",
        },
      }),
      {},
    );

    for (const corner of ["FL", "FR", "RL", "RR"] as const) {
      const byKey = new Map(out[corner]!.map((s) => [s.fieldKey, s.value]));
      expect(byKey.get("tire_brand")).toBe("Michelin");
      expect(byKey.get("tire_model")).toBe("Defender");
    }
    const size = (zone: "FL" | "RL") =>
      out[zone]!.find((s) => s.fieldKey === "tire_size")!.value;
    expect(size("FL")).toBe("225/45R18");
    expect(size("RL")).toBe("255/40R18");
  });

  it("seeds fluid specs into the ENG zone with provenance from sources", () => {
    const sources: Record<string, PassportSource> = {
      "fluids.oil_viscosity": "verified",
      "fluids.coolant_type": "oem_default",
    };
    const out = specPrefillFromPassport(
      snapshot({ fluids: { oil_viscosity: "0W-20", coolant_type: "OAT" } }),
      sources,
    );
    const eng = new Map(out.ENG!.map((s) => [s.fieldKey, s]));
    expect(eng.get("oil_viscosity")).toMatchObject({
      value: "0W-20",
      source: "verified",
      bucket: "select",
    });
    expect(eng.get("coolant_type")).toMatchObject({
      value: "OAT",
      source: "oem_default",
    });
  });

  it("omits empty/whitespace values and never seeds measured fields", () => {
    const out = specPrefillFromPassport(
      snapshot({ tires: { brand: "   ", model: "Pilot" } }),
      {},
    );
    const fl = new Map(out.FL!.map((s) => [s.fieldKey, s.value]));
    expect(fl.has("tire_brand")).toBe(false); // whitespace-only dropped
    expect(fl.get("tire_model")).toBe("Pilot");
    // No measured/observed keys ever appear.
    for (const specs of Object.values(out)) {
      for (const s of specs!) {
        expect(["tread", "psi", "wear", "pad", "rotor", "desc"]).not.toContain(
          s.fieldKey,
        );
      }
    }
  });

  it("pad brand seeds with a null source (no provenance key)", () => {
    const out = specPrefillFromPassport(
      snapshot({ brakes: { pad_brand: "Akebono" } }),
      {},
    );
    const pad = out.FL!.find((s) => s.fieldKey === "pad_brand")!;
    expect(pad.value).toBe("Akebono");
    expect(pad.source).toBeNull();
  });

  it("returns nothing for a passport with no stored specs", () => {
    expect(specPrefillFromPassport(snapshot(), {})).toEqual({});
    expect(specPrefillFromPassport(null, {})).toEqual({});
  });

  it("isSpecPrefillField recognizes seeded fields only", () => {
    expect(isSpecPrefillField("FL", "tire_brand")).toBe(true);
    expect(isSpecPrefillField("ENG", "oil_viscosity")).toBe(true);
    expect(isSpecPrefillField("FL", "tread")).toBe(false);
    expect(isSpecPrefillField("ENG", "tire_brand")).toBe(false);
  });
});
