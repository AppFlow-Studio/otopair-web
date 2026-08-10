import { describe, expect, it } from "vitest";
import {
  candidatesFromText,
  pickOilCandidates,
  viscosityMatcher,
} from "../convex/vehicleEnrichment/oilProduct";
import type { PageProduct } from "../convex/vehicleEnrichment/categoryHarvest";

const MB = "Mercedes-Benz";

const product = (oem: string, title: string | null, price: number | null = null): PageProduct => ({
  oem,
  title,
  price,
  sourceUrl: "https://classicparts.mbusa.com/oem-parts/x",
});

describe("viscosityMatcher", () => {
  it("matches the common title spellings of 0W-40", () => {
    const re = viscosityMatcher("0W-40")!;
    expect(re.test("Genuine Mercedes-Benz Engine Oil 0W-40 1 Liter")).toBe(true);
    expect(re.test("MB 229.5 Motor Oil 0w40")).toBe(true);
    expect(re.test("AMG Engine Oil 0 W 40")).toBe(true);
  });
  it("never cross-matches a different grade", () => {
    const re = viscosityMatcher("0W-40")!;
    expect(re.test("Engine Oil 5W-40 1 Quart")).toBe(false);
    expect(re.test("Engine Oil 0W-20 1 Quart")).toBe(false);
  });
  it("refuses to build from junk", () => {
    expect(viscosityMatcher(null)).toBeNull();
    expect(viscosityMatcher("synthetic")).toBeNull();
  });
});

describe("pickOilCandidates", () => {
  it("accepts a viscosity-matched per-liter OEM bottle and keeps its price", () => {
    const out = pickOilCandidates(
      [product("000-989-83-01-11", "Genuine Mercedes-Benz Engine Oil 0W-40 1 Liter", 14.5)],
      { make: MB, viscosity: "0W-40" },
    );
    expect(out).toHaveLength(1);
    expect(out[0].price).toBe(14.5);
    expect(out[0].sizeRank).toBe(2);
  });
  it("rejects the wrong grade — the per-type gate", () => {
    const out = pickOilCandidates(
      [product("000-989-83-01-11", "Genuine Mercedes-Benz Engine Oil 5W-30 1 Liter", 12)],
      { make: MB, viscosity: "0W-40" },
    );
    expect(out).toEqual([]);
  });
  it("rejects oil-adjacent products: filters, additives, gear oil", () => {
    const out = pickOilCandidates(
      [
        product("276-180-00-09", "Oil Filter Kit 0W-40 compatible"),
        product("000-989-25-45", "Engine Oil Additive 0W-40 friendly"),
        product("001-989-33-03", "Gear Oil 0W-40"),
      ],
      { make: MB, viscosity: "0W-40" },
    );
    expect(out).toEqual([]);
  });
  it("excludes multi-quart jugs whose price would corrupt per-quart math", () => {
    const out = pickOilCandidates(
      [product("000-989-83-01-13", "Mercedes-Benz Engine Oil 0W-40 5 Liter Jug", 60)],
      { make: MB, viscosity: "0W-40" },
    );
    expect(out).toEqual([]);
  });
  it("ranks explicit 1qt/1L bottles above size-unstated listings", () => {
    const out = pickOilCandidates(
      [
        product("000-989-83-01-15", "Mercedes-Benz Engine Oil 0W-40", 13),
        product("000-989-83-01-11", "Mercedes-Benz Engine Oil 0W-40 1 Quart", 14),
      ],
      { make: MB, viscosity: "0W-40" },
    );
    expect(out.map((c) => c.sizeRank)).toEqual([2, 1]);
  });
  it("drops numbers that fail the make format gate", () => {
    const out = pickOilCandidates(
      [product("MOB1-0W40", "Engine Oil 0W-40 1 Quart", 9)],
      { make: MB, viscosity: "0W-40" },
    );
    expect(out).toEqual([]);
  });
});

describe("candidatesFromText", () => {
  const src = { make: MB, viscosity: "0W-40", sourceUrl: "https://example.com/x" };
  it("mines a viscosity-adjacent genuine SKU out of prose", () => {
    const md = [
      "# Which oil for the AMG?",
      "Mercedes-Benz Genuine Engine Oil 0W-40 (MB 229.5), part number 000 989 79 02 11, is the factory fill.",
      "Unrelated line about brake pads 000-420-49-04.",
    ].join("\n");
    const out = candidatesFromText(md, src);
    expect(out).toHaveLength(1);
    expect(out[0].oem.replace(/[^0-9A-Z]/gi, "")).toBe("0009897902 11".replace(" ", ""));
    expect(out[0].price).toBeNull();
  });
  it("ignores numbers on lines without the exact viscosity or on oil-adjacent products", () => {
    const md = [
      "Engine Oil 5W-30 part 000 989 33 09 11 for older models.",
      "Oil FILTER 0W-40 compatible, part 276-180-00-09.",
    ].join("\n");
    expect(candidatesFromText(md, src)).toEqual([]);
  });
  it("returns nothing for empty markdown or junk viscosity", () => {
    expect(candidatesFromText(null, src)).toEqual([]);
    expect(candidatesFromText("Engine Oil 0W-40 part 000 989 79 02 11", { ...src, viscosity: "synthetic" })).toEqual([]);
  });
});
