/**
 * VIN validation at the decode door.
 *
 * Bug #275, Anesa 2026-09-18: `WAULDAF87PN000000`, `WAULDAF87PN0123AA` and
 * `WAULDAF87PN01234O` — all edits of a real 2023 Audi A8 VIN — each decoded to
 * that same Audi A8, and the card then echoed the ALTERED string back as if it
 * were the car's VIN.
 *
 * The cause is structural, not a missing string compare: a VIN decoder reads
 * make/year/engine out of characters 1-11. Characters 12-17 are the serial, and
 * no decoder on earth can tell you a serial is wrong — NHTSA returns
 * "2023 AUDI A8" for every one of the strings above. The check digit in
 * position 9 is computed over all 17 characters, so it is the only thing that
 * catches an edited serial. That is what these tests pin.
 *
 * Every expectation below was cross-checked against NHTSA vPIC's own Error Code
 * field (0 = "VIN decoded clean. Check Digit (9th position) is correct",
 * 1 = "Check Digit (9th position) does not calculate properly") on 2026-09-21.
 */
import { describe, expect, it } from "vitest";
import {
  hasValidVinCheckDigit,
  isDecodableVin,
  isNorthAmericanVin,
  isPseudoVin,
  isRealVin,
} from "../convex/lib/vinIdentity";

const TRUE_AUDI = "WAULDAF87PN012340";

describe("the reported case", () => {
  // The tester's car was an Audi (WMI "W"). The check digit itself catches the
  // altered serial, but the entry gate only enforces it for North American
  // VINs — see "only North American VINs are gated" below.
  it("the check digit accepts the real VIN the tester started from", () => {
    expect(hasValidVinCheckDigit(TRUE_AUDI)).toBe(true);
  });

  it.each([
    ["serial zeroed out", "WAULDAF87PN000000"],
    ["letters in the last two positions", "WAULDAF87PN0123AA"],
  ])("the check digit rejects the altered VIN — %s", (_label, vin) => {
    expect(hasValidVinCheckDigit(vin)).toBe(false);
  });

  it("rejects a trailing zero typed as the letter O", () => {
    expect(isDecodableVin("WAULDAF87PN01234O")).toBe(false);
  });
});

describe("only North American VINs are gated", () => {
  const TRUE_HONDA = "1HGCM82633A004352";

  it("recognises WMI regions 1–5 as North American", () => {
    expect(isNorthAmericanVin(TRUE_HONDA)).toBe(true);
    expect(isNorthAmericanVin("5YJ3E1EA7KF317000")).toBe(true);
    expect(isNorthAmericanVin(TRUE_AUDI)).toBe(false);
    expect(isNorthAmericanVin("JH4KA7561PC008269")).toBe(false);
  });

  it("rejects an altered North American serial", () => {
    expect(isDecodableVin(TRUE_HONDA)).toBe(true);
    const altered = ["1HGCM82633A000000", "1HGCM82633A0043AA"];
    expect(altered.every((v) => !isDecodableVin(v))).toBe(true);
  });

  it("lets an import through even when position 9 is not a check digit", () => {
    // European home-market VINs often put a filler (e.g. "Z") in position 9.
    expect(hasValidVinCheckDigit("WVWZZZ1KZAW000001")).toBe(false);
    expect(isDecodableVin("WVWZZZ1KZAW000001")).toBe(true);
    expect(isDecodableVin("WAULDAF87PN000000")).toBe(true);
  });
});

describe("check digit, against NHTSA's own verdict", () => {
  it.each([
    "WAULDAF87PN012340", // 2023 Audi A8
    "1HGCM82633A004352", // Honda Accord
    "1GC4YSEY4RF211250", // Chevrolet Silverado
    "1GCUYDED2KZ100001", // Chevrolet Silverado
    "1FMUK8KHXSGD02351", // Ford — check digit is the letter X
  ])("agrees the check digit is correct for %s", (vin) => {
    expect(hasValidVinCheckDigit(vin)).toBe(true);
  });

  it("handles a check digit of X, which is 10 and cannot be a digit", () => {
    // sum % 11 === 10 is encoded as "X". A validator that only ever compares
    // against String(remainder) rejects every one of these real VINs.
    expect("1FMUK8KHXSGD02351"[8]).toBe("X");
    expect(hasValidVinCheckDigit("1FMUK8KHXSGD02351")).toBe(true);
  });

  it.each([
    "19UUB2F34LA890123",
    "19XFC2F59KE039685",
    "1FA6P8CF5J5170067",
  ])("agrees the check digit is wrong for the made-up fixture %s", (vin) => {
    // These are invented VINs that live in this repo's test fixtures. They are
    // well-formed and decode to a plausible car, and NHTSA reports code 1 for
    // each — which is exactly the class of string this bug was about.
    expect(hasValidVinCheckDigit(vin)).toBe(false);
  });

  it("catches every single-character edit that changes a character's VALUE", () => {
    // Not a spot check: walk every position, substitute every other character,
    // and assert the check digit notices.
    //
    // The exception is real and worth knowing about rather than hiding: ISO
    // 3779 transliterates letters to 1-9, so several characters share a value
    // (A, J and the digit 1 are all 1). A substitution inside one of those
    // classes leaves the weighted sum untouched and IS invisible to the check
    // digit. That is a property of the standard, not of this implementation,
    // and it is the reason the check digit is a typo guard rather than proof
    // of authenticity. Position 9 is skipped — editing the check digit itself
    // to match a different sum is the other edit the scheme cannot see.
    const VALUE_OF: Record<string, number> = {
      A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
      J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
      S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
    };
    const valueOf = (c: string) => (c >= "0" && c <= "9" ? Number(c) : VALUE_OF[c]);

    const alphabet = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789";
    const missedValueChanging: string[] = [];
    let sameValueSubstitutions = 0;
    let tried = 0;

    for (let i = 0; i < 17; i++) {
      if (i === 8) continue;
      for (const ch of alphabet) {
        if (ch === TRUE_AUDI[i]) continue;
        tried++;
        const mutated = TRUE_AUDI.slice(0, i) + ch + TRUE_AUDI.slice(i + 1);
        const sameValue = valueOf(ch) === valueOf(TRUE_AUDI[i]);
        if (sameValue) sameValueSubstitutions++;
        else if (hasValidVinCheckDigit(mutated)) missedValueChanging.push(mutated);
      }
    }

    expect(tried).toBeGreaterThan(400);
    expect(missedValueChanging).toEqual([]);
    // Non-zero, so this test fails loudly if someone "fixes" it by quietly
    // widening the same-value escape hatch.
    expect(sameValueSubstitutions).toBe(36);
  });

  it("cannot see a swap between two characters of equal value", () => {
    // Stated as an explicit expectation so it reads as a known limit rather
    // than a gap someone later mistakes for a bug. The A at position 2 of the
    // Audi VIN can become a J and the check digit still passes.
    const swapped = "WJULDAF87PN012340";
    expect(swapped).not.toBe(TRUE_AUDI);
    expect(hasValidVinCheckDigit(swapped)).toBe(true);
  });
});

describe("the ISO 3779 alphabet", () => {
  it.each(["I", "O", "Q"])("rejects a VIN containing the letter %s", (letter) => {
    const vin = TRUE_AUDI.slice(0, 16) + letter;
    expect(isRealVin(vin)).toBe(false);
    expect(isDecodableVin(vin)).toBe(false);
  });

  it("rejects anything that is not 17 characters", () => {
    expect(isDecodableVin(TRUE_AUDI.slice(0, 16))).toBe(false);
    expect(isDecodableVin(TRUE_AUDI + "0")).toBe(false);
    expect(isDecodableVin("")).toBe(false);
    expect(isDecodableVin(null)).toBe(false);
    expect(isDecodableVin(undefined)).toBe(false);
  });

  it("normalises case and surrounding whitespace, as the entry field does", () => {
    expect(isDecodableVin(`  ${TRUE_AUDI.toLowerCase()}  `)).toBe(true);
  });
});

describe("the check digit must NOT leak into isRealVin", () => {
  // isRealVin is documented as the exact complement of isPseudoVin, and it
  // gates paid VIN-API calls and the walk-in placeholder repair. A real VIN
  // with a typo is a mistyped VIN, not a placeholder we minted — folding the
  // check digit into isRealVin would silently reclassify it as one.
  const REAL_BUT_MISTYPED = "WAULDAF87PN000000";

  it("still calls a check-digit failure a real VIN", () => {
    expect(isRealVin(REAL_BUT_MISTYPED)).toBe(true);
    expect(hasValidVinCheckDigit(REAL_BUT_MISTYPED)).toBe(false);
  });

  it("does not turn it into a pseudo VIN", () => {
    expect(isPseudoVin(REAL_BUT_MISTYPED)).toBe(false);
  });

  it("keeps isRealVin and isPseudoVin exact complements", () => {
    for (const vin of [TRUE_AUDI, REAL_BUT_MISTYPED, "OTO-ABC-123", "SHOP1758000000000", "MANUAL-1-x"]) {
      expect(isRealVin(vin)).toBe(!isPseudoVin(vin));
    }
  });

  it("still rejects the placeholders we mint ourselves", () => {
    for (const vin of ["OTO-ABC-123", "SHOP1758000000000", "MANUAL-1-x", "SEED1VIN00000N"]) {
      expect(isDecodableVin(vin)).toBe(false);
    }
  });
});
