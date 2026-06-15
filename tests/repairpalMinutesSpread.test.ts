import { describe, it, expect } from "vitest";
import { normalizeName } from "../convex/devOnly/repairpalMinutesSpread";

describe("normalizeName", () => {
  it("lowercases, collapses whitespace, strips punctuation", () => {
    expect(normalizeName("  Civic ")).toBe("civic");
    expect(normalizeName("Mercedes-Benz")).toBe("mercedes benz");
    expect(normalizeName("F-150")).toBe("f 150");
    expect(normalizeName("3 Series")).toBe("3 series");
    expect(normalizeName("Model 3")).toBe("model 3");
  });
});
