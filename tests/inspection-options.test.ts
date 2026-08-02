import { describe, expect, it } from "vitest";

import { tireModelOptionsForBrand } from "../lib/inspection-options";

describe("tire model options", () => {
  it("shows only Bridgestone models when Bridgestone is selected", () => {
    expect(tireModelOptionsForBrand("bridgestone").map(({ value }) => value)).toEqual([
      "bridgestone_turanza",
      "bridgestone_potenza",
      "bridgestone_blizzak",
      "bridgestone_dueler",
    ]);
  });
});
