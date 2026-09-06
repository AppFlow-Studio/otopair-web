/**
 * VIN field hygiene (lib/vin.ts).
 *
 * The failure this guards against is a mechanic typing a VIN with an "O" where
 * they meant "0". Before, that either stalled the create-booking drawer one
 * char shy of the 17-char check (no enrichment popup, no parts, no pricing) or
 * got silently stripped on the walk-in page (16-char VIN → decode skipped). The
 * fix auto-corrects the ISO-ambiguous letters (O→0, I→1) so the VIN reaches the
 * check, and drops only what has no digit twin (Q, punctuation), reporting both
 * so the field can explain the change instead of mutating input in silence.
 */
import { describe, it, expect } from "vitest";
import { sanitizeVinInput, isCompleteVin } from "../lib/vin";

describe("sanitizeVinInput", () => {
  it("auto-corrects O→0 and I→1 and flags the correction", () => {
    // A real VIN with the two digits mis-typed as their look-alike letters.
    const r = sanitizeVinInput("1hgbh41jxmnO09I86");
    expect(r.value).toBe("1HGBH41JXMN009186");
    expect(r.correctedOI).toBe(true);
    expect(r.droppedInvalid).toBe(false);
    expect(isCompleteVin(r.value)).toBe(true);
  });

  it("uppercases and keeps a clean VIN untouched (no flags)", () => {
    const r = sanitizeVinInput("5yj3e1ea7kf317654");
    expect(r.value).toBe("5YJ3E1EA7KF317654");
    expect(r.correctedOI).toBe(false);
    expect(r.droppedInvalid).toBe(false);
  });

  it("drops Q and other out-of-alphabet characters, flagging the drop", () => {
    const r = sanitizeVinInput("1HG-BH41 JXMNQ09186");
    // hyphen + space removed, Q removed → 16 usable chars left.
    expect(r.value).toBe("1HGBH41JXMN09186");
    expect(r.droppedInvalid).toBe(true);
    expect(r.correctedOI).toBe(false);
  });

  it("reports both when a keystroke corrects and drops at once", () => {
    const r = sanitizeVinInput("O Q");
    expect(r.value).toBe("0"); // O→0, space + Q dropped
    expect(r.correctedOI).toBe(true);
    expect(r.droppedInvalid).toBe(true);
  });

  it("caps at 17 chars without flagging the overflow as a drop", () => {
    // A valid 17-char VIN with four extra digits fat-fingered on the end.
    const r = sanitizeVinInput("1HGBH41JXMN1091860000");
    expect(r.value).toHaveLength(17);
    expect(r.value).toBe("1HGBH41JXMN109186");
    expect(r.droppedInvalid).toBe(false);
  });

  it("handles empty input", () => {
    const r = sanitizeVinInput("");
    expect(r).toEqual({ value: "", correctedOI: false, droppedInvalid: false });
  });
});

describe("isCompleteVin", () => {
  it("accepts a 17-char VIN in the ISO alphabet", () => {
    expect(isCompleteVin("1HGCV1F30LA012345")).toBe(true);
  });

  it("rejects wrong length and I/O/Q", () => {
    expect(isCompleteVin("1HGCV1F30LA01234")).toBe(false); // 16
    expect(isCompleteVin("1HGCV1F30LA01234O")).toBe(false); // contains O
    expect(isCompleteVin(null)).toBe(false);
    expect(isCompleteVin("")).toBe(false);
  });
});
