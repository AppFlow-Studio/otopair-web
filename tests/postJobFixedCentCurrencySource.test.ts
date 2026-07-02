import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("post-job parts price input", () => {
  it("uses fixed-cent currency behavior for price per unit", () => {
    const source = readFileSync("components/post-job-survey-dialog.tsx", "utf8");
    const priceLabelIndex = source.indexOf("Price per unit");
    const priceInputBlock = source.slice(
      Math.max(0, priceLabelIndex - 1000),
      source.indexOf("{/* Quantity stepper", priceLabelIndex),
    );

    expect(priceInputBlock).toContain("<FixedCentCurrencyInput");
    expect(priceInputBlock).toContain("value={part.cost}");
    expect(priceInputBlock).toContain("onValueChange={(value)");
  });
});
