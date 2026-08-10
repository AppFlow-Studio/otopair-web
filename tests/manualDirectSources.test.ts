import { describe, expect, it } from "vitest";
import {
  buildDirectManualCandidates,
  compactSlug,
  DEALEREPROCESS_MAKES,
  hyphenSlug,
  judgeProbe,
  toyotaModelSlug,
} from "../convex/vehicleEnrichment/manualDirectSources";

const pdfMagic = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // "%PDF-1.7"
const htmlBytes = new Uint8Array([0x3c, 0x21, 0x44, 0x4f, 0x43, 0x54, 0x59, 0x50]); // "<!DOCTYP"

describe("slug helpers", () => {
  it("compactSlug matches the dealereprocess grammar", () => {
    expect(compactSlug("F-150")).toBe("f150");
    expect(compactSlug("CX-5")).toBe("cx5");
    expect(compactSlug("Silverado 1500")).toBe("silverado1500");
  });

  it("hyphenSlug matches the Nissan DAM grammar", () => {
    expect(hyphenSlug("Altima")).toBe("altima");
    expect(hyphenSlug("Rogue Sport")).toBe("rogue-sport");
  });

  it("toyotaModelSlug drops separators but keeps case", () => {
    expect(toyotaModelSlug("RAV4")).toBe("RAV4");
    expect(toyotaModelSlug("Land Cruiser")).toBe("LandCruiser");
  });
});

describe("buildDirectManualCandidates", () => {
  it("builds the verified Toyota maintenance-guide URL", () => {
    // Live-verified shape: T-MMS-19Camry. This booklet is the maintenance
    // schedule itself, so a Toyota never needs the 600-page owner's manual.
    const urls = buildDirectManualCandidates(2019, "Toyota", "Camry").map((c) => c.url);
    expect(urls).toContain(
      "https://assets.sia.toyota.com/publications/en/omms-s/T-MMS-19Camry/pdf/T-MMS-19Camry.pdf",
    );
  });

  it("builds the verified Nissan DAM URL", () => {
    const urls = buildDirectManualCandidates(2019, "Nissan", "Altima").map((c) => c.url);
    expect(urls).toContain(
      "https://www.nissanusa.com/content/dam/Nissan/us/manuals-and-guides/altima/2019/2019-nissan-altima-owner-manual.pdf",
    );
  });

  it("builds the verified dealereprocess URL with a compact slug", () => {
    const urls = buildDirectManualCandidates(2020, "Ford", "F-150").map((c) => c.url);
    expect(urls).toContain("https://cdn.dealereprocess.org/cdn/servicemanuals/ford/2020-f150.pdf");
  });

  it("tags OEM hosts and redistributors distinctly", () => {
    const byName = new Map(
      buildDirectManualCandidates(2019, "Toyota", "Camry").map((c) => [c.source, c]),
    );
    // Provenance rides on the host: Toyota's CDN is OEM, the dealer-website
    // vendor is not, however faithful its bytes are.
    expect(byName.get("toyota_tmms")?.tier).toBe("oem");
    expect(byName.get("dealereprocess")?.tier).toBe("redistributor");
  });

  it("emits nothing for a make with no verified grammar", () => {
    // BMW/Mercedes/VW/Audi publish no open PDFs — that is what the
    // mycarusermanual adapter is for.
    expect(buildDirectManualCandidates(2019, "Mercedes-Benz", "GLC 300")).toEqual([]);
    expect(buildDirectManualCandidates(2022, "BMW", "3 Series")).toEqual([]);
  });

  it("has no Hyundai builder — the DAM pattern 404'd on every probe", () => {
    const sources = buildDirectManualCandidates(2023, "Hyundai", "Tucson").map((c) => c.source);
    expect(sources).not.toContain("hyundai_dam");
    // Still covered, via the redistributor (2023 Tucson verified live).
    expect(sources).toContain("dealereprocess");
  });

  it("rejects unusable vehicle args instead of building junk URLs", () => {
    expect(buildDirectManualCandidates(NaN, "Toyota", "Camry")).toEqual([]);
    expect(buildDirectManualCandidates(2019, "", "Camry")).toEqual([]);
    expect(buildDirectManualCandidates(2019, "Toyota", " ")).toEqual([]);
  });

  it("only probes makes verified present on the redistributor", () => {
    for (const mk of ["bmw", "mercedes-benz", "audi", "volkswagen", "lexus", "ram"]) {
      expect(DEALEREPROCESS_MAKES).not.toContain(mk);
    }
  });
});

describe("judgeProbe — a constructed URL is never trusted on faith", () => {
  it("accepts real PDF bytes", () => {
    expect(
      judgeProbe({ status: 206, contentType: "application/pdf", contentLength: 8_000_000, firstBytes: pdfMagic }),
    ).toMatchObject({ ok: true });
  });

  it("accepts a PDF content-type even when the body slice is unreadable", () => {
    expect(
      judgeProbe({ status: 200, contentType: "application/pdf", contentLength: 900_000, firstBytes: null }),
    ).toMatchObject({ ok: true });
  });

  it("rejects an HTML error page wearing a .pdf URL", () => {
    // The exact failure mode constructed URLs invite: a 200 that is a 404 page.
    expect(
      judgeProbe({ status: 200, contentType: "text/html; charset=utf-8", contentLength: 5_000, firstBytes: htmlBytes }),
    ).toMatchObject({ ok: false, reason: "html_not_pdf" });
  });

  it("rejects non-2xx", () => {
    expect(judgeProbe({ status: 404, contentType: null, contentLength: null, firstBytes: null })).toMatchObject({
      ok: false,
      reason: "http_404",
    });
  });

  it("rejects a body too small to be a manual", () => {
    expect(
      judgeProbe({ status: 200, contentType: "application/pdf", contentLength: 1_024, firstBytes: null }),
    ).toMatchObject({ ok: false });
  });

  it("rejects bytes that are neither PDF magic nor a PDF content-type", () => {
    expect(
      judgeProbe({ status: 200, contentType: "application/octet-stream", contentLength: 900_000, firstBytes: htmlBytes }),
    ).toMatchObject({ ok: false });
  });
});
