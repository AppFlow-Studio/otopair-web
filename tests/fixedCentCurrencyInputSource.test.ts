import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";

describe("FixedCentCurrencyInput shared component", () => {
  it("centralizes fixed-cent currency input behavior and is used by parts price fields", () => {
    const componentPath = "components/ui/fixed-cent-currency-input.tsx";
    expect(existsSync(componentPath)).toBe(true);

    const componentSource = readFileSync(componentPath, "utf8");
    // Typing / deleting go through the selection-aware helpers (#419): a
    // selection is REPLACED, never appended to. Paste reads a dollar amount.
    expect(componentSource).toContain("typeFixedCentDigit");
    expect(componentSource).toContain("deleteFixedCentDigit");
    expect(componentSource).toContain("parsePastedCurrencyCents");
    expect(componentSource).toContain("hasSelection(event.currentTarget)");
    expect(componentSource).toContain("syncFixedCentCurrencyInput");
    expect(componentSource).toContain("formatFixedCentCurrency(value, { emptyWhenBlank: allowEmpty })");

    const postJobSource = readFileSync("components/post-job-survey-dialog.tsx", "utf8");
    expect(postJobSource).toContain("FixedCentCurrencyInput");
    expect(postJobSource).not.toContain("function handlePartCostKeyDown");

    const createBookingSource = readFileSync(
      "app/(portal)/schedule/create-booking-drawer.tsx",
      "utf8",
    );
    expect(createBookingSource).toContain("FixedCentCurrencyInput");
    expect(createBookingSource).not.toContain("handleCatalogUnitPriceKeyDown");

    const servicePricingSource = readFileSync(
      "components/shop/service-price-tier-strip.tsx",
      "utf8",
    );
    expect(servicePricingSource).toContain("FixedCentCurrencyInput");
    expect(servicePricingSource).toContain("allowEmpty");
  });
});
