/**
 * Cross-make part-number rejection + enforcing per-make format validation.
 *
 * Live finding (Jul 2026): the 2024 Alfa Romeo Stelvio Ti config carried FOUR
 * battery fitments — three Ford Motorcraft numbers (BAGM-94RH7-800,
 * BXT-94RH7-730, BXT-48H6-610) and one genuine Mopar part (BB0H8800AC).
 * Retailer "batteries that fit your car" pages entered the scrape corpus and
 * the pipeline stamped the Motorcraft numbers with ALFA's make_id, blinding
 * the read-time make guard. sanitizePartNumber is the write-time fix.
 */
import { describe, it, expect } from "vitest";
import {
  sanitizePartNumber,
  matchesForeignBrandSignature,
} from "../convex/vehicleEnrichment/contentSanitization";

describe("matchesForeignBrandSignature", () => {
  it("flags Motorcraft battery numbers for a non-Ford make", () => {
    expect(matchesForeignBrandSignature("BXT-94RH7-730", "Alfa Romeo")).toBe("motorcraft");
    expect(matchesForeignBrandSignature("BAGM-94RH7-800", "Alfa Romeo")).toBe("motorcraft");
    expect(matchesForeignBrandSignature("BXT-48H6-610", "Alfa Romeo")).toBe("motorcraft");
  });

  it("does not flag Motorcraft numbers for Ford/Lincoln", () => {
    expect(matchesForeignBrandSignature("BXT-94RH7-730", "Ford")).toBeNull();
    expect(matchesForeignBrandSignature("FL-820-S", "Lincoln")).toBeNull();
  });

  it("does not flag the genuine Mopar part for Alfa Romeo", () => {
    expect(matchesForeignBrandSignature("BB0H8800AC", "Alfa Romeo")).toBeNull();
    expect(matchesForeignBrandSignature("68400577AA", "Alfa Romeo")).toBeNull();
  });

  it("flags a Mopar-format number for BMW", () => {
    expect(matchesForeignBrandSignature("68400577AA", "BMW")).toBe("mopar");
  });

  it("flags an asian 5-5 number for BMW but not for Toyota/Hyundai/Nissan", () => {
    expect(matchesForeignBrandSignature("90915-YZZF2", "BMW")).toBe("asian_5_5");
    expect(matchesForeignBrandSignature("90915-YZZF2", "Toyota")).toBeNull();
    expect(matchesForeignBrandSignature("26300-35505", "Hyundai")).toBeNull();
    expect(matchesForeignBrandSignature("15208-65F0E", "Nissan")).toBeNull();
  });

  it("flags a Ford OE service number (…Z- prefix) for a non-Ford make", () => {
    expect(matchesForeignBrandSignature("BC3Z-6731-B", "Toyota")).toBe("ford_oe");
  });

  it("returns null with no make context", () => {
    expect(matchesForeignBrandSignature("BXT-94RH7-730", null)).toBeNull();
    expect(matchesForeignBrandSignature("BXT-94RH7-730", undefined)).toBeNull();
  });
});

describe("sanitizePartNumber — Stelvio battery acceptance case", () => {
  it("rejects all three Motorcraft batteries for Alfa Romeo", () => {
    expect(sanitizePartNumber("BAGM-94RH7-800", "Alfa Romeo")).toBeNull();
    expect(sanitizePartNumber("BXT-94RH7-730", "Alfa Romeo")).toBeNull();
    expect(sanitizePartNumber("BXT-48H6-610", "Alfa Romeo")).toBeNull();
  });

  it("keeps the genuine Mopar battery for Alfa Romeo", () => {
    expect(sanitizePartNumber("BB0H8800AC", "Alfa Romeo")).toBe("BB0H8800AC");
    expect(sanitizePartNumber("68400577AA", "Alfa Romeo")).toBe("68400577AA");
  });
});

describe("sanitizePartNumber — per-make format enforcement", () => {
  it("accepts alphanumeric BMW numbers (the case the old pattern rejected)", () => {
    expect(sanitizePartNumber("64115A1BDB6", "BMW")).toBe("64115A1BDB6");
    expect(sanitizePartNumber("11428583898", "BMW")).toBe("11428583898");
  });

  it("rejects a Toyota-format number extracted for BMW", () => {
    expect(sanitizePartNumber("90915-YZZF2", "BMW")).toBeNull();
  });

  it("accepts real formats across makes", () => {
    expect(sanitizePartNumber("90915-YZZF2", "Toyota")).toBe("90915-YZZF2");
    expect(sanitizePartNumber("00272-SLLC2", "Toyota")).toBe("00272-SLLC2");
    expect(sanitizePartNumber("15400-PLM-A02", "Honda")).toBe("15400-PLM-A02");
    expect(sanitizePartNumber("08798-9080", "Honda")).toBe("08798-9080");
    expect(sanitizePartNumber("06L115562B", "Volkswagen")).toBe("06L115562B");
    expect(sanitizePartNumber("5Q0698451A", "Audi")).toBe("5Q0698451A");
    expect(sanitizePartNumber("BXT-94RH7-730", "Ford")).toBe("BXT-94RH7-730");
    expect(sanitizePartNumber("12345678", "Chevrolet")).toBe("12345678");
    expect(sanitizePartNumber("26300-35505", "Hyundai")).toBe("26300-35505");
    expect(sanitizePartNumber("A0009898301", "Mercedes")).toBe("A0009898301");
    expect(sanitizePartNumber("PE01-14-302A", "Mazda")).toBe("PE01-14-302A");
    expect(sanitizePartNumber("LR011279", "Land Rover")).toBe("LR011279");
  });

  it("still rejects prose/garbage regardless of make", () => {
    expect(sanitizePartNumber("see owner's manual for details", "Toyota")).toBeNull();
    expect(sanitizePartNumber("varies", "BMW")).toBeNull();
  });

  it("makes without a pattern fall back to the generic plausibility check", () => {
    // No pattern registered for e.g. Tesla — plausible strings pass.
    expect(sanitizePartNumber("1067701-00-A", "Tesla")).toBe("1067701-00-A");
  });
});
