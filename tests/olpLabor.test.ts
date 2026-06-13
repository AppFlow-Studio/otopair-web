import { describe, it, expect } from "vitest";
import {
  extractBuildId,
  parseJsonLoose,
  olpModelCandidates,
  pickOlpVehicle,
  type OlpVehicleRow,
} from "../convex/vehicleEnrichment/olpLabor";
import modelBrowse from "./fixtures/olp/model-browse-civic.json";

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

describe("olpModelCandidates", () => {
  it("orders most specific first and dedupes", () => {
    // OLP nameplates are trim-qualified: civic, civic-si, civic-type-r
    expect(olpModelCandidates("Civic", "Si")).toEqual(["civic-si", "si", "civic"]);
  });
  it("strips xDrive like the RepairPal candidates do", () => {
    expect(olpModelCandidates("5 Series", "M550i xDrive")).toEqual([
      "5-series-m550i-xdrive",
      "m550i-xdrive",
      "m550i",
      "5-series",
    ]);
  });
  it("handles empty trim", () => {
    expect(olpModelCandidates("Jetta", "")).toEqual(["jetta"]);
  });
});

describe("pickOlpVehicle", () => {
  const vehicles = (modelBrowse as any).pageProps.data
    .vehicles as OlpVehicleRow[];

  it("picks the turbo 1.5 over the 2.0 NA for a turbo hint", () => {
    const r = pickOlpVehicle(vehicles, 2018, {
      displacementL: 1.5,
      cylinders: 4,
      turbo: true,
    });
    expect(r?.engineSlug).toBe("1.5l-i4-turbo");
  });
  it("picks the 2.0 NA when displacement says so", () => {
    const r = pickOlpVehicle(vehicles, 2018, {
      displacementL: 2.0,
      cylinders: 4,
      turbo: false,
    });
    expect(r?.engineSlug).toBe("2.0l-i4");
  });
  it("returns the single row when the year has only one engine", () => {
    const r = pickOlpVehicle(vehicles, 2005, {
      displacementL: null,
      cylinders: null,
      turbo: null,
    });
    expect(r?.engineSlug).toBe("1.7l-i4-d17");
  });
  it("returns null for a year OLP does not list", () => {
    expect(
      pickOlpVehicle(vehicles, 1999, { displacementL: 1.6, cylinders: 4, turbo: false }),
    ).toBeNull();
  });
});
