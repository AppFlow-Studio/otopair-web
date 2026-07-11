/**
 * Fluid/chemical OEM SKU acceptance per make.
 *
 * Live finding (Jul 2026, 2012 Audi A4 B8): the batch extracted every fluid
 * SKU (engine_oil_oem "G 052 167 A2", coolant_oem "G 012 A8G M1",
 * atf_fluid_oem "G 060 162 A2") but the VAG pattern required a 3-char first
 * block, so sanitizePartNumber rejected ALL of them as failed_sanitization —
 * zero fluid fitments were ever written for VAG configs, which is why no oil
 * price could appear on an oil-change quote. This matrix pins fluid-SKU
 * acceptance for every make with an enforcing pattern so the failure class
 * can't silently return.
 */
import { describe, it, expect } from "vitest";
import {
  sanitizePartNumber,
  matchesForeignBrandSignature,
} from "../convex/vehicleEnrichment/contentSanitization";

describe("VAG fluid/chemical G- and B-numbers", () => {
  it("accepts spaced and compact G-numbers for Audi/VW/Porsche", () => {
    expect(sanitizePartNumber("G 052 167 A2", "Audi")).toBe("G 052 167 A2");
    expect(sanitizePartNumber("G052167A2", "Audi")).toBe("G052167A2");
    expect(sanitizePartNumber("G 012 A8G M1", "Audi")).toBe("G 012 A8G M1");
    expect(sanitizePartNumber("G012A8GM1", "Volkswagen")).toBe("G012A8GM1");
    expect(sanitizePartNumber("G 060 162 A2", "Audi")).toBe("G 060 162 A2");
    expect(sanitizePartNumber("G060162A2", "Porsche")).toBe("G060162A2");
    // G13 coolant, DSG fluid
    expect(sanitizePartNumber("G 013 A8J M1", "Volkswagen")).toBe("G 013 A8J M1");
    expect(sanitizePartNumber("G 052 182 A2", "Audi")).toBe("G 052 182 A2");
  });

  it("accepts VAG B-number brake fluid", () => {
    expect(sanitizePartNumber("B 000 750 M3", "Audi")).toBe("B 000 750 M3");
    expect(sanitizePartNumber("B000750M3", "Volkswagen")).toBe("B000750M3");
  });

  it("still accepts regular VAG hard-part numbers", () => {
    expect(sanitizePartNumber("06J115403Q", "Audi")).toBe("06J115403Q");
    expect(sanitizePartNumber("8K0698451A", "Audi")).toBe("8K0698451A");
    expect(sanitizePartNumber("000915105DH", "Audi")).toBe("000915105DH");
    expect(sanitizePartNumber("06L115562B", "Volkswagen")).toBe("06L115562B");
  });

  it("accepts VAG N-number standard hardware (rejected live 2026-07-10)", () => {
    expect(sanitizePartNumber("N0138157", "Audi")).toBe("N0138157");
    expect(sanitizePartNumber("N 013 815 7", "Audi")).toBe("N 013 815 7");
    expect(sanitizePartNumber("N90813202", "Volkswagen")).toBe("N90813202");
    expect(sanitizePartNumber("N 908 132 02", "Porsche")).toBe("N 908 132 02");
  });

  it("rejects TL spec designations and viscosity-spec strings (not orderable SKUs)", () => {
    expect(sanitizePartNumber("TL 774J", "Volkswagen")).toBeNull();
    // The LLM returned this for engine_oil_oem on the 2026-07-10 re-run — a
    // spec/viscosity mashup, not a SKU. Must stay rejected.
    expect(sanitizePartNumber("VW502.00-5W30-1QT", "Audi")).toBeNull();
  });

  it("rejects a VAG G-number extracted for a foreign make", () => {
    expect(matchesForeignBrandSignature("G 052 167 A2", "Toyota")).toBe("vag_fluid");
    expect(matchesForeignBrandSignature("G012A8GM1", "Honda")).toBe("vag_fluid");
    expect(sanitizePartNumber("G 052 167 A2", "Toyota")).toBeNull();
  });

  it("does not flag a G-number as foreign for VAG-family makes", () => {
    expect(matchesForeignBrandSignature("G 052 167 A2", "Audi")).toBeNull();
    expect(matchesForeignBrandSignature("G012A8GM1", "Volkswagen")).toBeNull();
    expect(matchesForeignBrandSignature("G060162A2", "Porsche")).toBeNull();
  });
});

describe("GM / ACDelco fluid dash codes", () => {
  it("accepts ACDelco chemical dash codes", () => {
    expect(sanitizePartNumber("10-9243", "Chevrolet")).toBe("10-9243");
    expect(sanitizePartNumber("10-4133", "GMC")).toBe("10-4133");
    expect(sanitizePartNumber("10-5077A", "Buick")).toBe("10-5077A");
  });

  it("still accepts regular GM numbers", () => {
    expect(sanitizePartNumber("12345678", "Chevrolet")).toBe("12345678");
    expect(sanitizePartNumber("PF64", "Chevrolet")).toBe("PF64");
    expect(sanitizePartNumber("TS10083", "GMC")).toBe("TS10083");
  });
});

describe("Nissan/Infiniti chemical SKUs", () => {
  it("accepts mixed-prefix chemical SKUs", () => {
    expect(sanitizePartNumber("999MP-A9001", "Nissan")).toBe("999MP-A9001");
    expect(sanitizePartNumber("KE908-99931", "Nissan")).toBe("KE908-99931");
    expect(sanitizePartNumber("999MP-MTF00P", "Infiniti")).toBe("999MP-MTF00P");
  });

  it("still accepts regular Nissan numbers", () => {
    expect(sanitizePartNumber("15208-65F0E", "Nissan")).toBe("15208-65F0E");
  });
});

describe("fluid SKUs already covered by existing patterns (pinned)", () => {
  it("Toyota/Lexus chemicals pass", () => {
    expect(sanitizePartNumber("00279-0WQTE", "Toyota")).toBe("00279-0WQTE");
    expect(sanitizePartNumber("00272-SLLC2", "Toyota")).toBe("00272-SLLC2");
    expect(sanitizePartNumber("08886-02505", "Lexus")).toBe("08886-02505");
  });

  it("Honda/Acura fluids pass", () => {
    expect(sanitizePartNumber("08200-9008", "Honda")).toBe("08200-9008");
    expect(sanitizePartNumber("08798-9080", "Acura")).toBe("08798-9080");
  });

  it("Mercedes oil SKU passes", () => {
    expect(sanitizePartNumber("A000989830111", "Mercedes-Benz")).toBe("A000989830111");
  });

  it("BMW coolant/oil SKUs pass", () => {
    expect(sanitizePartNumber("83212365950", "BMW")).toBe("83212365950");
    expect(sanitizePartNumber("83-21-2-365-950", "BMW")).toBe("83-21-2-365-950");
  });

  it("Motorcraft fluid SKUs pass for Ford", () => {
    expect(sanitizePartNumber("XT-10-QLVC", "Ford")).toBe("XT-10-QLVC");
    expect(sanitizePartNumber("VC-3DIL-B", "Ford")).toBe("VC-3DIL-B");
  });
});

describe("garbage still rejected", () => {
  it("rejects viscosity strings, marketing names, and prose", () => {
    expect(sanitizePartNumber("5W-40 Full Synthetic", "Audi")).toBeNull();
    expect(sanitizePartNumber("TFSI", "Audi")).toBeNull();
    expect(sanitizePartNumber("Genuine Audi Coolant", "Audi")).toBeNull();
    expect(sanitizePartNumber("G12++ coolant concentrate 1L", "Audi")).toBeNull();
  });
});
