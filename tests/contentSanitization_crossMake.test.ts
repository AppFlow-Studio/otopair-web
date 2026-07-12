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

describe("sanitizePartNumber — Hyundai chemical/accessory SKUs (Veloster Turbo case)", () => {
  it("accepts fluid SKUs with a third block or revision suffix", () => {
    expect(sanitizePartNumber("00232-FSYN5-30WAR", "Hyundai")).toBe("00232-FSYN5-30WAR");
    expect(sanitizePartNumber("08950-00020-B", "Hyundai")).toBe("08950-00020-B");
  });

  it("still accepts the plain 5-5 part format", () => {
    expect(sanitizePartNumber("26300-35505", "Hyundai")).toBe("26300-35505");
    expect(sanitizePartNumber("28113-2V100", "Kia")).toBe("28113-2V100");
  });

  it("still rejects wrong-make formats for Hyundai", () => {
    expect(sanitizePartNumber("11428583898", "Hyundai")).toBeNull(); // BMW 11-digit
    expect(sanitizePartNumber("BC3Z-6731-B", "Hyundai")).toBeNull(); // Ford OE
  });
});

describe("sanitizePartNumber — audit-driven pattern widenings (Jul 11 2026)", () => {
  it("Toyota: dashless compact + chemical third block", () => {
    expect(sanitizePartNumber("9091602570", "Toyota")).toBe("9091602570");
    expect(sanitizePartNumber("00544-21171-325", "Toyota")).toBe("00544-21171-325");
    expect(sanitizePartNumber("00279-0WQTE-01", "Toyota")).toBe("00279-0WQTE-01");
    expect(sanitizePartNumber("00544-H8AGM-TS", "Toyota")).toBe("00544-H8AGM-TS");
    // 11-digit BMW number must NOT pass the dashless branch (exactly 5+5)
    expect(sanitizePartNumber("11428583898", "Toyota")).toBeNull();
  });

  it("Nissan: brake-part and chemical first blocks + 7-char tails", () => {
    expect(sanitizePartNumber("D1060-9HE0B", "Nissan")).toBe("D1060-9HE0B");
    expect(sanitizePartNumber("D4060-9HU0A", "Nissan")).toBe("D4060-9HU0A");
    expect(sanitizePartNumber("110D2-6CA0B", "Nissan")).toBe("110D2-6CA0B");
    expect(sanitizePartNumber("999M1-NBH5A", "Nissan")).toBe("999M1-NBH5A");
    expect(sanitizePartNumber("999MP-L25500P", "Nissan")).toBe("999MP-L25500P");
    expect(sanitizePartNumber("999PK-000W20N", "Nissan")).toBe("999PK-000W20N");
    expect(sanitizePartNumber("15208-65F0E", "Nissan")).toBe("15208-65F0E");
  });

  it("GM: ACDelco battery codes and 5-digit dash bodies", () => {
    expect(sanitizePartNumber("94RAGM", "Chevrolet")).toBe("94RAGM");
    expect(sanitizePartNumber("48AGM", "Chevrolet")).toBe("48AGM");
    expect(sanitizePartNumber("15-11125", "Chevrolet")).toBe("15-11125");
    expect(sanitizePartNumber("10-9243", "GMC")).toBe("10-9243");
  });

  it("Ford: 1-char second block (XL-3 friction modifier)", () => {
    expect(sanitizePartNumber("XL-3", "Ford")).toBe("XL-3");
    expect(sanitizePartNumber("FL-820-S", "Ford")).toBe("FL-820-S");
  });

  it("Honda: NGK-style plug SKUs", () => {
    expect(sanitizePartNumber("9807B-5517W", "Honda")).toBe("9807B-5517W");
  });

  it("Mercedes: Q-prefix accessory SKUs", () => {
    expect(sanitizePartNumber("Q1030004", "Mercedes")).toBe("Q1030004");
    expect(sanitizePartNumber("Q 103 0004", "Mercedes-Benz")).toBe("Q 103 0004");
  });

  it("VAG: double-suffix wiper SKUs", () => {
    expect(sanitizePartNumber("17B955425A03C", "Volkswagen")).toBe("17B955425A03C");
    expect(sanitizePartNumber("5NN955425", "Volkswagen")).toBe("5NN955425");
  });

  it("multi-number strings and prose stay rejected", () => {
    expect(sanitizePartNumber('99H09-AK026H (driver 26") + 99H09-AK018-H (passenger 18")', "Hyundai")).toBeNull();
    expect(sanitizePartNumber("Included with oil filter 04152-WAA03", "Toyota")).toBeNull();
    expect(sanitizePartNumber("G13 / G12evo (VW spec TL-VW 774 J)", "Volkswagen")).toBeNull();
  });
});

describe("sanitizePartNumber — Hyundai Mobis digit-led alphanumeric first block", () => {
  it("accepts 2SF79-AQ000 (Veloster cabin filter, rejected live Jul 11 2026)", () => {
    expect(sanitizePartNumber("2SF79-AQ000", "Hyundai")).toBe("2SF79-AQ000");
  });

  it("still rejects letter-led first blocks and foreign formats", () => {
    expect(sanitizePartNumber("BC3Z-6731-B", "Hyundai")).toBeNull(); // Ford OE
    expect(sanitizePartNumber("PE01-14-302A", "Hyundai")).toBeNull(); // Mazda
  });
});
