// =============================================================================
// Oto AI — canonicalize.ts unit tests (vitest-compatible)
// =============================================================================
//
// Sprint 1 Day 2 (2026-05-16). Owner: Memory Systems Engineer.
//
// HOW TO RUN
// ----------
// The repo does NOT currently have a test framework configured (see
// package.json — no vitest, jest, or mocha). These tests are written in
// vitest-compatible syntax. To run them once vitest is added:
//
//   npm install --save-dev vitest
//   npx vitest run convex/oto/canonicalize.test.ts
//
// vitest is the natural choice because Convex's own examples use it and
// `crypto.subtle.digest` is available in vitest's Node environment.
//
// Until vitest lands, this file is a living spec — it documents the
// expected behaviour of `normalize` and `sha256Hex` and can be hand-run by
// pasting the body of each test into a scratch script.
// =============================================================================

import { describe, expect, it } from "vitest";

import {
  canonicalQuestionKey,
  normalize,
  sha256Hex,
} from "./canonicalize";

describe("normalize", () => {
  it("collapses the four canonical variants to the same form", () => {
    const expected = "what oil does my engine take";
    expect(normalize("What oil does my engine take?")).toBe(expected);
    expect(normalize("WHAT OIL DOES MY ENGINE TAKE?")).toBe(expected);
    expect(normalize("  what  oil  does my engine take.  ")).toBe(expected);
    expect(normalize("What oil does my engine take?!?!")).toBe(expected);
  });

  it("is idempotent across a half-dozen sample inputs", () => {
    const samples = [
      "What oil does my engine take?",
      "  HELLO   World!!!  ",
      "When should I rotate my tires?",
      "How long does it take to change brake pads?!",
      "Engine code P0420...",
      "What's the recommended tire pressure for my Civic?",
    ];
    for (const s of samples) {
      const once = normalize(s);
      const twice = normalize(once);
      expect(twice).toBe(once);
    }
  });

  it("preserves internal punctuation that is not whitespace or terminal", () => {
    // Apostrophes and internal hyphens are meaningful tokens; do not strip.
    expect(normalize("What's the recommended tire pressure?")).toBe(
      "what's the recommended tire pressure",
    );
    expect(normalize("All-wheel-drive service interval?")).toBe(
      "all-wheel-drive service interval",
    );
  });

  it("applies NFKC normalization (fullwidth digits fold to ASCII)", () => {
    // U+FF11 .. U+FF12 are fullwidth "1" and "2". NFKC folds them.
    expect(normalize("Coolant for ２００５ Civic?")).toBe(
      "coolant for 2005 civic",
    );
  });

  it("returns empty string for whitespace-only and punctuation-only input", () => {
    expect(normalize("   ")).toBe("");
    expect(normalize("???!!!")).toBe("");
    expect(normalize("")).toBe("");
  });
});

describe("sha256Hex", () => {
  it("returns the standard SHA-256 of the empty string", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("returns the standard SHA-256 of 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("returns 64 lowercase hex characters", async () => {
    const hex = await sha256Hex("hello world");
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("canonicalQuestionKey", () => {
  it("returns the same hash for differently-cased / punctuated phrasings", async () => {
    const a = await canonicalQuestionKey("What oil does my engine take?");
    const b = await canonicalQuestionKey("WHAT OIL DOES MY ENGINE TAKE?");
    const c = await canonicalQuestionKey(
      "  what  oil  does my engine take.  ",
    );
    const d = await canonicalQuestionKey("What oil does my engine take?!?!");
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(d).toBe(a);
  });

  it("returns DIFFERENT hashes for genuinely different questions", async () => {
    const a = await canonicalQuestionKey("What oil does my engine take?");
    const b = await canonicalQuestionKey("When should I rotate my tires?");
    const c = await canonicalQuestionKey(
      "How long does it take to change brake pads?",
    );
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });

  it("matches sha256Hex(normalize(text))", async () => {
    const text = "What oil does my engine take?";
    const direct = await sha256Hex(normalize(text));
    const helper = await canonicalQuestionKey(text);
    expect(helper).toBe(direct);
  });
});
