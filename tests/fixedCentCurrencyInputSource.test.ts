import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";

describe("FixedCentCurrencyInput shared component", () => {
  it("centralizes fixed-cent currency input behavior and is used by parts price fields", () => {
    const componentPath = "components/ui/fixed-cent-currency-input.tsx";
    expect(existsSync(componentPath)).toBe(true);

    const componentSource = readFileSync(componentPath, "utf8");
    expect(componentSource).toContain("appendFixedCentDigit");
    expect(componentSource).toContain("backspaceFixedCentCurrency");
    expect(componentSource).toContain("syncFixedCentCurrencyInput");
    expect(componentSource).toContain("formatFixedCentCurrency(value)");

    const postJobSource = readFileSync("components/post-job-survey-dialog.tsx", "utf8");
    expect(postJobSource).toContain("FixedCentCurrencyInput");
    expect(postJobSource).not.toContain("function handlePartCostKeyDown");

    const createBookingSource = readFileSync(
      "app/(portal)/schedule/create-booking-drawer.tsx",
      "utf8",
    );
    expect(createBookingSource).toContain("FixedCentCurrencyInput");
    expect(createBookingSource).not.toContain("handleCatalogUnitPriceKeyDown");
  });
});
