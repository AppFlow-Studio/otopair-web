import { describe, it, expect } from "vitest";
import {
  extractBuildId,
  parseJsonLoose,
} from "../convex/vehicleEnrichment/olpLabor";

describe("extractBuildId", () => {
  it("finds buildId in script src", () => {
    const html =
      '<script src="/_next/static/9LcCyZqhNWcZKlN9hHFXY/_ssgManifest.js" defer></script>';
    expect(extractBuildId(html)).toBe("9LcCyZqhNWcZKlN9hHFXY");
  });
  it("accepts _buildManifest too", () => {
    const html = '<script src="/_next/static/abc-123_X/_buildManifest.js"></script>';
    expect(extractBuildId(html)).toBe("abc-123_X");
  });
  it("returns null when absent", () => {
    expect(extractBuildId("<html><body>nope</body></html>")).toBeNull();
  });
});

describe("parseJsonLoose", () => {
  it("parses plain JSON", () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
  });
  it("parses JSON wrapped in HTML (Firecrawl rawHtml of a JSON URL)", () => {
    const wrapped = '<html><body><pre>{"pageProps":{"x":2}}</pre></body></html>';
    expect(parseJsonLoose(wrapped)).toEqual({ pageProps: { x: 2 } });
  });
  it("returns null on garbage", () => {
    expect(parseJsonLoose("not json at all")).toBeNull();
  });
});
