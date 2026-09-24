// =============================================================================
// config-key builders — transmission-in-identity unit tests (vitest)
// =============================================================================
//
// Guards the transmission-in-config-identity fix: an automatic and a manual of
// the SAME engine must produce DIFFERENT keys (so they never share one enriched
// vehicle_configs row), while an unknown/absent transmission must leave the key
// byte-identical to the legacy transmission-less form (so existing keys and
// unknown-transmission VINs stay in the same namespace and never fragment).
//
//   npx vitest run tests/configKeyTransmission.test.ts
// =============================================================================

import { describe, expect, it } from "vitest";

import {
  buildEngineKey,
  buildNhtsaVinKey,
  transmissionKeyToken,
} from "../convex/vehicleEnrichment/types";

const engineBase = {
  vehicleId: "v1",
  year: 2020,
  make: "Honda",
  model: "Civic",
  trim: "Touring",
  engineCode: "L15B7",
  displacement: "1.5",
};

const nhtsaBase = {
  year: 2020,
  make: "Honda",
  model: "Civic",
  trim: "Touring",
  displacementL: 1.5,
  cylinders: 4,
  fuelType: "Gasoline",
};

describe("transmissionKeyToken", () => {
  it("maps the four canonical families case-insensitively", () => {
    expect(transmissionKeyToken("automatic")).toBe("automatic");
    expect(transmissionKeyToken("Automatic")).toBe("automatic");
    expect(transmissionKeyToken("manual")).toBe("manual");
    expect(transmissionKeyToken("CVT")).toBe("cvt");
    expect(transmissionKeyToken("cvt")).toBe("cvt");
    expect(transmissionKeyToken("DCT")).toBe("dct");
  });

  it("returns '' for unknown/absent so the token drops out of the key", () => {
    expect(transmissionKeyToken(null)).toBe("");
    expect(transmissionKeyToken(undefined)).toBe("");
    expect(transmissionKeyToken("")).toBe("");
    expect(transmissionKeyToken("unknown")).toBe("");
    expect(transmissionKeyToken("slushbox")).toBe(""); // non-canonical raw string
  });
});

describe("buildEngineKey — transmission in config identity", () => {
  const legacy = buildEngineKey(engineBase);

  it("automatic and manual of the same engine produce DIFFERENT keys", () => {
    const auto = buildEngineKey({ ...engineBase, transmissionFamily: "automatic" });
    const manual = buildEngineKey({ ...engineBase, transmissionFamily: "manual" });
    expect(auto).not.toBe(manual);
    expect(auto).not.toBe(legacy);
    expect(manual).not.toBe(legacy);
  });

  it("appends the family token LAST (new key === legacy + _token)", () => {
    expect(buildEngineKey({ ...engineBase, transmissionFamily: "automatic" })).toBe(
      `${legacy}_automatic`,
    );
    expect(buildEngineKey({ ...engineBase, transmissionFamily: "DCT" })).toBe(`${legacy}_dct`);
  });

  it("unknown/absent transmission is byte-identical to the legacy key", () => {
    expect(buildEngineKey({ ...engineBase, transmissionFamily: null })).toBe(legacy);
    expect(buildEngineKey({ ...engineBase, transmissionFamily: "unknown" })).toBe(legacy);
    expect(buildEngineKey(engineBase)).toBe(legacy);
  });
});

describe("buildNhtsaVinKey — transmission in base key", () => {
  const legacy = buildNhtsaVinKey(nhtsaBase);

  it("distinguishes families and appends the token last", () => {
    const auto = buildNhtsaVinKey({ ...nhtsaBase, transmissionFamily: "automatic" });
    const cvt = buildNhtsaVinKey({ ...nhtsaBase, transmissionFamily: "CVT" });
    expect(auto).toBe(`${legacy}_automatic`);
    expect(cvt).toBe(`${legacy}_cvt`);
    expect(auto).not.toBe(cvt);
  });

  it("unknown/absent leaves the legacy transmission-less key unchanged", () => {
    expect(buildNhtsaVinKey({ ...nhtsaBase, transmissionFamily: null })).toBe(legacy);
    expect(buildNhtsaVinKey({ ...nhtsaBase, transmissionFamily: "unknown" })).toBe(legacy);
    expect(buildNhtsaVinKey(nhtsaBase)).toBe(legacy);
  });
});
