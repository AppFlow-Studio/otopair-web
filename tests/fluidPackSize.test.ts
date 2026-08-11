import { describe, it, expect } from "vitest";
import {
  detectPackQuarts,
  normalizeFluidPrice,
  PACKAGED_FLUID_SUBCATEGORIES,
} from "../convex/lib/fluidPackSize";

describe("detectPackQuarts", () => {
  it("reads the container sizes fluids are actually sold in", () => {
    expect(detectPackQuarts("Mobil 1 Full Synthetic 5 Quart")).toBe(5);
    expect(detectPackQuarts("ACDelco dexos1 5qt jug")).toBe(5);
    expect(detectPackQuarts("Genuine Toyota Motor Oil 5-Quart")).toBe(5);
    expect(detectPackQuarts("Castrol EDGE 1 Gallon")).toBe(4);
    expect(detectPackQuarts("Prestone Coolant Gallon")).toBe(4);
    expect(detectPackQuarts("Genuine VW Oil 5L")).toBeCloseTo(5.28, 1);
    expect(detectPackQuarts("Case of 6")).toBe(6);
    expect(detectPackQuarts("12-pack")).toBe(12);
  });

  it("NEVER reads a viscosity grade as a container size", () => {
    // The whole trap: "0W-20" and "5W-30" carry bare digits next to nothing.
    expect(detectPackQuarts("Genuine Nissan 0W-20 Motor Oil")).toBeNull();
    expect(detectPackQuarts("Mopar 5W-30 Engine Oil")).toBeNull();
    expect(detectPackQuarts("SAE 0W-16")).toBeNull();
    // ...and still finds the real size when both are present.
    expect(detectPackQuarts("Genuine Nissan 0W-20 Motor Oil 5 Quart")).toBe(5);
    expect(detectPackQuarts("Mopar 5W-30 Full Synthetic 1 Gallon")).toBe(4);
  });

  it("NEVER reads an engine DISPLACEMENT as a container size", () => {
    // Live false positive (third-bird-914): this title normalized a correct
    // $8.04/qt price down to $1.34 by dividing by a nonexistent 5.7qt jug.
    expect(detectPackQuarts("Engine Oil (5.7L Engine)")).toBeNull();
    expect(detectPackQuarts("Motor Oil 3.6L V6")).toBeNull();
    expect(detectPackQuarts("Oil 2.0L Turbo")).toBeNull();
    expect(detectPackQuarts("Coolant 6.7L Diesel")).toBeNull();
    // A real spelled-out fractional container still resolves.
    expect(detectPackQuarts("Engine Oil 1.5 litre bottle")).toBeCloseTo(1.59, 1);
  });

  it("refuses to read a size out of a scrape-junk markdown title", () => {
    // Live row: the "part number" was a timestamp from the image URL and the
    // price was equally unreliable — dividing by its stated "(5 Liters)"
    // would have produced a confident $2.38/qt.
    const junk =
      "- [![5W30 Top Tec 4600 Engine Oil (5 Liters) - Liqui Moly LM20448](https://www.fcpeuro.com/a.jpg?1737984165)";
    expect(detectPackQuarts(junk)).toBeNull();
    // The same size stated in a clean title is still trusted.
    expect(detectPackQuarts("Top Tec 4600 Engine Oil (5 Liters)")).toBeCloseTo(5.28, 1);
  });

  it("returns null on a titleless or size-less listing rather than guessing", () => {
    expect(detectPackQuarts(null)).toBeNull();
    expect(detectPackQuarts("")).toBeNull();
    expect(detectPackQuarts("Engine Oil")).toBeNull();
    expect(detectPackQuarts("Part 19432351")).toBeNull();
  });
});

describe("normalizeFluidPrice", () => {
  it("normalizes the live over-billing case (a $36 5-quart jug)", () => {
    const v = normalizeFluidPrice({
      subcategory: "engine_oil",
      price: 36,
      title: "Genuine Motor Oil 0W-20 5 Quart",
    });
    expect(v.action).toBe("normalized");
    expect(v.packQuarts).toBe(5);
    expect(v.price).toBe(7.2); // 6-qt car: 6 x 7.20 = $43.20, not $216
  });

  it("normalizes a CHEAP jug too — the error is the unit, not the amount", () => {
    const v = normalizeFluidPrice({
      subcategory: "engine_oil",
      price: 22,
      title: "5 Quart Jug",
    });
    expect(v.action).toBe("normalized");
    expect(v.price).toBe(4.4);
  });

  it("flags a container-shaped price whose title states no size", () => {
    const v = normalizeFluidPrice({
      subcategory: "engine_oil",
      price: 102.1, // the live 0W-20 row
      title: "Motor Oil",
    });
    expect(v.action).toBe("suspect_unpriceable");
    expect(v.price).toBe(102.1); // caller decides what to do; value untouched
  });

  it("leaves an ordinary per-quart bottle completely alone", () => {
    for (const price of [8.04, 10.53, 14.0, 24.99]) {
      const v = normalizeFluidPrice({
        subcategory: "engine_oil",
        price,
        title: "Genuine Motor Oil 0W-20 1 Quart",
      });
      expect(v.action, String(price)).toBe("ok");
      expect(v.price, String(price)).toBe(price);
    }
  });

  it("ignores non-fluid roles entirely", () => {
    const v = normalizeFluidPrice({
      subcategory: "front_brake_pad",
      price: 320,
      title: "Brake Pad Set (4)",
    });
    expect(v.action).toBe("ok");
    expect(v.price).toBe(320);
  });

  it("covers the fluid roles that are billed per quart", () => {
    for (const s of ["engine_oil", "coolant", "atf_fluid", "gear_oil", "brake_fluid", "ps_fluid"]) {
      expect(PACKAGED_FLUID_SUBCATEGORIES.has(s), s).toBe(true);
    }
  });
});
