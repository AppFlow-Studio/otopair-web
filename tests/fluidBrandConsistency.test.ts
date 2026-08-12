/**
 * Round-7 (batch-8): fluid brand-consistency flag. When a fluid SPEC names a
 * different vehicle marque than the make (badge-engineered / third-party
 * powertrain), the orderable OEM fluid PART is routed to review — a Mazda-built
 * Yaris had a correct "Mazda ATF FZ" spec but a Toyota ATF WS part number.
 * Flag-only, high-precision (component makers + same-family marques don't trip).
 */
import { describe, expect, test } from "vitest";
import { fluidNamesForeignChassisBrand } from "../convex/vehicleEnrichment/fluidBrandConsistency";

describe("fluidNamesForeignChassisBrand", () => {
  test("the batch-8 Yaris cases: Mazda-branded fluid on a Toyota → flag", () => {
    expect(fluidNamesForeignChassisBrand("Mazda ATF FZ", "Toyota")).toBe("mazda");
    expect(fluidNamesForeignChassisBrand("Mazda FL22 (Green OAT)", "Toyota")).toBe("mazda");
  });

  test("same marque → no flag", () => {
    expect(fluidNamesForeignChassisBrand("Toyota ATF WS (World Standard)", "Toyota")).toBe(null);
    expect(fluidNamesForeignChassisBrand("Mopar ATF+4", "Jeep")).toBe(null); // same MOPAR family
    expect(fluidNamesForeignChassisBrand("Lexus genuine ATF", "Toyota")).toBe(null); // same family
    expect(fluidNamesForeignChassisBrand("Motorcraft Mercon LV", "Ford")).toBe(null); // Ford family
  });

  test("component-maker names are NOT marques → no flag", () => {
    expect(fluidNamesForeignChassisBrand("ZF Lifeguard 8", "BMW")).toBe(null);
    expect(fluidNamesForeignChassisBrand("Aisin AFW+ ATF", "Toyota")).toBe(null);
    expect(fluidNamesForeignChassisBrand("Jatco CVT NS-3", "Nissan")).toBe(null);
    expect(fluidNamesForeignChassisBrand("DEXRON VI", "Chevrolet")).toBe(null);
  });

  test("genuinely cross-branded platforms flag (worth a review)", () => {
    // The 86/BRZ (Subaru-built Toyota) and Pontiac Vibe (Toyota-built) are real
    // badge-engineering cases where a foreign-marque fluid spec is a valid signal.
    expect(fluidNamesForeignChassisBrand("Subaru Super Coolant", "Toyota")).toBe("subaru");
    expect(fluidNamesForeignChassisBrand("Toyota Genuine ATF WS", "Pontiac")).toBe("toyota");
  });

  test("null / empty inputs → null", () => {
    expect(fluidNamesForeignChassisBrand(null, "Toyota")).toBe(null);
    expect(fluidNamesForeignChassisBrand("Mazda ATF FZ", null)).toBe(null);
    expect(fluidNamesForeignChassisBrand("", "Toyota")).toBe(null);
  });

  test("no marque named → null (most fluids)", () => {
    expect(fluidNamesForeignChassisBrand("ATF+4", "Jeep")).toBe(null);
    expect(fluidNamesForeignChassisBrand("5W-30 full synthetic", "Honda")).toBe(null);
  });
});
