import { describe, expect, it } from "vitest";
import {
  appendFixedCentDigit,
  backspaceFixedCentCurrency,
  deleteFixedCentDigit,
  formatFixedCentCurrency,
  parsePastedCurrencyCents,
  syncFixedCentCurrencyInput,
  typeFixedCentDigit,
} from "../lib/fixed-cent-currency";

describe("fixed-cent currency input", () => {
  it("normalizes blank and numeric values to dollars with two cents digits", () => {
    expect(formatFixedCentCurrency("")).toBe("0.00");
    expect(formatFixedCentCurrency("12")).toBe("12.00");
    expect(formatFixedCentCurrency("12.5")).toBe("12.50");
    expect(formatFixedCentCurrency("0012.345")).toBe("12.35");
  });

  it("keeps an intentionally blank optional price empty", () => {
    expect(formatFixedCentCurrency("", { emptyWhenBlank: true })).toBe("");
  });

  it("appends typed digits from the cents side", () => {
    let value = "0.00";

    value = appendFixedCentDigit(value, "3");
    expect(value).toBe("0.03");

    value = appendFixedCentDigit(value, "5");
    expect(value).toBe("0.35");

    value = appendFixedCentDigit(value, "8");
    expect(value).toBe("3.58");

    value = appendFixedCentDigit(value, "0");
    expect(value).toBe("35.80");

    value = appendFixedCentDigit(value, "0");
    expect(value).toBe("358.00");
  });

  it("removes the rightmost cent digit with backspace", () => {
    expect(backspaceFixedCentCurrency("358.00")).toBe("35.80");
    expect(backspaceFixedCentCurrency("0.03")).toBe("0.00");
    expect(backspaceFixedCentCurrency("0.00")).toBe("0.00");
  });

  it("syncs raw text input changes as fixed-cent edits", () => {
    expect(syncFixedCentCurrencyInput("0.00", "0.003")).toBe("0.03");
    expect(syncFixedCentCurrencyInput("0.35", "0.358")).toBe("3.58");
    expect(syncFixedCentCurrencyInput("35.80", "35.8")).toBe("3.58");
  });

  // #419 — "select $20.00 and paste 99999" gave $2,000,999.99.
  it("a typed digit replaces a selection instead of appending to it", () => {
    expect(typeFixedCentDigit("20.00", "9", true)).toBe("0.09");
    expect(typeFixedCentDigit("20.00", "9", false)).toBe("200.09");
  });

  it("backspace over a selection clears the value", () => {
    expect(deleteFixedCentDigit("20.00", true)).toBe("0.00");
    expect(deleteFixedCentDigit("20.00", false)).toBe("2.00");
  });

  it("a paste is read as a dollar amount", () => {
    expect(parsePastedCurrencyCents("99999")).toBe(9_999_900);
    expect(formatFixedCentCurrency(parsePastedCurrencyCents("99999")! / 100)).toBe("99999.00");
    expect(parsePastedCurrencyCents("12.5")).toBe(1250);
    expect(parsePastedCurrencyCents("$1,234.56")).toBe(123456);
    expect(parsePastedCurrencyCents("1.2.3")).toBe(123);
    expect(parsePastedCurrencyCents("abc")).toBeNull();
    expect(parsePastedCurrencyCents("")).toBeNull();
  });
});
