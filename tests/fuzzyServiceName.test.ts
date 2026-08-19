/**
 * Typo tolerance for the cross-shop name suggester.
 *
 * The asymmetry these tests protect: this matcher is allowed to be LOOSE
 * because a false positive is one ignored suggestion, while a false negative is
 * a duplicate cluster that never merges. But it must not be so loose that it
 * suggests a different job — a mechanic who accepts "rear brake" when they
 * meant "gear" has been actively misled.
 */
import { describe, it, expect } from "vitest";
import {
  boundedEditDistance,
  fuzzyTokensMatch,
  fuzzyNameSimilarity,
} from "../convex/lib/fuzzyServiceName";

describe("boundedEditDistance", () => {
  it("counts a transposition as one edit, not two", () => {
    // The common fast-typist error. Plain Levenshtein charges 2 and would push
    // this past every sane threshold.
    expect(boundedEditDistance("brake", "brkae", 2)).toBe(1);
  });

  it("bails out past the cap instead of computing the true distance", () => {
    expect(boundedEditDistance("alignment", "carburettor", 2)).toBe(3);
  });

  it("is symmetric", () => {
    expect(boundedEditDistance("carbon", "cabron", 2)).toBe(
      boundedEditDistance("cabron", "carbon", 2),
    );
  });

  it("handles empty input", () => {
    expect(boundedEditDistance("", "", 2)).toBe(0);
    expect(boundedEditDistance("abc", "", 5)).toBe(3);
  });
});

describe("fuzzyTokensMatch", () => {
  it("accepts a misspelling in a long token", () => {
    expect(fuzzyTokensMatch("cleaning", "cleening")).toBe(true);
    expect(fuzzyTokensMatch("alignment", "alignmnet")).toBe(true);
  });

  it("keeps short tokens strict", () => {
    // One edit apart, but genuinely different parts of the car. At four
    // characters a typo budget stops discriminating and starts inventing.
    expect(fuzzyTokensMatch("gear", "rear")).toBe(false);
    expect(fuzzyTokensMatch("disc", "disk")).toBe(false);
  });

  it("still honours the prefix rule for shop shorthand", () => {
    expect(fuzzyTokensMatch("trans", "transmission")).toBe(true);
  });
});

describe("fuzzyNameSimilarity", () => {
  it("matches through casing, punctuation and word order", () => {
    expect(
      fuzzyNameSimilarity("Carbon Cleaning (walnut blast)", "walnut blast carbon clean"),
    ).toBeGreaterThan(0.6);
  });

  it("matches through a typo", () => {
    expect(
      fuzzyNameSimilarity("carbon cleening", "Carbon Cleaning"),
    ).toBeGreaterThan(0.8);
  });

  it("does not pull together unrelated work", () => {
    expect(
      fuzzyNameSimilarity("Power window switch replacement", "Rear wiper motor"),
    ).toBeLessThan(0.3);
  });

  it("scores an exact restatement at 1", () => {
    expect(fuzzyNameSimilarity("Roll fenders", "roll fenders")).toBe(1);
  });
});
