/**
 * OEM manual library (P2.2) — pure-function tests. No network, no ctx.
 *
 * Fixtures under tests/fixtures/manualLibrary/ are LIVE-CAPTURED search
 * results from 2026-07-30 (see each file's `_note`), which is what makes the
 * ranking tests meaningful: the Subaru set is eight mirrors and zero OEM hits
 * on a plain query, the Honda set is *only* mirrors because Honda has no
 * static manual URL at all, and the Toyota set contains the one byte-verified
 * OEM maintenance-schedule PDF in the whole study.
 *
 * The laws under test:
 *   - discovery queries are site-scoped FIRST when the make is known, and
 *     degrade to generic queries (never a fabricated URL) when it is not;
 *   - OEM classification is PER-MAKE (a honda.com URL is not OEM provenance
 *     for a Toyota) and covers manufacturer content hosts, not just dot-coms;
 *   - OEM + maintenance_schedule outranks third-party + owners_manual;
 *   - the 14-day negative cache suppresses retries of a known-dead source;
 *   - manual data never downgrades a deterministic/oem_manual/mechanic-verified
 *     row — the ONE exception being a both-miles-and-months fill onto a stored
 *     row that lacks months.
 */
import { describe, it, expect } from "vitest";
import {
  buildManualQueries,
  buildPdfEmbedMirrorPages,
  contradictsVehicle,
  extractEmbeddedPdfUrl,
  isPdfEmbedMirrorPage,
  normalizeMakeKey,
  hostnameOf,
  isOemDomain,
  isMirrorDomain,
  classifyDocKind,
  looksLikePdfUrl,
  looksLikePdfBytes,
  estimatePdfPageCount,
  rankManualCandidates,
  shouldSkipManualLookup,
  shouldOverwriteInterval,
  parseManualIntervals,
  dedupeIntervalsByService,
  extractToolPayload,
  collectCitationSpans,
  formatIntervalDisplay,
  manualFileName,
  buildManualExtractionSchema,
  buildManualExtractionPrompt,
  MANUAL_INTERVAL_TO_SERVICE,
  MANUAL_INTERVAL_ORDER,
  OEM_MANUAL_DOMAINS,
  MANUAL_FAILURE_TTL_DAYS,
  MANUAL_REFRESH_DAYS,
  type StoredIntervalLike,
  type IncomingInterval,
} from "../convex/vehicleEnrichment/manualLibrary";

import toyotaSearch from "./fixtures/manualLibrary/search-toyota-camry-2020.json";
import fordSearch from "./fixtures/manualLibrary/search-ford-f150-2019.json";
import hondaSearch from "./fixtures/manualLibrary/search-honda-crv-2021.json";
import subaruSearch from "./fixtures/manualLibrary/search-subaru-crosstrek-2022.json";
import extractionResponse from "./fixtures/manualLibrary/extraction-response-camry-2020.json";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-30T12:00:00Z");

const CAMRY = { make: "Toyota", model: "Camry", year: 2020 };
const F150 = { make: "Ford", model: "F-150", year: 2019 };
const CRV = { make: "Honda", model: "CR-V", year: 2021 };
const CROSSTREK = { make: "Subaru", model: "Crosstrek", year: 2022 };

// ─── Query builder ───────────────────────────────────────────────

describe("buildManualQueries", () => {
  it("puts the OEM site:-scoped queries first for a known make", () => {
    const queries = buildManualQueries(2020, "Toyota", "Camry");
    expect(queries).toHaveLength(5);
    expect(queries[0]).toBe(
      "2020 Toyota Camry maintenance schedule guide filetype:pdf site:toyota.com",
    );
    expect(queries[1]).toBe("2020 Toyota Camry owner's manual pdf site:toyota.com");
    // Generic fallbacks keep working when the site: operator is ignored.
    expect(queries[2]).toContain("warranty and maintenance guide");
    expect(queries[3]).toContain("maintenance schedule miles months");
    // Verified mirror rescue stays LAST — it must never shadow the OEM pair.
    expect(queries[4]).toContain("site:carmans.net");
  });

  it("scopes to the make's own primary domain, case-insensitively", () => {
    expect(buildManualQueries(2022, "SUBARU", "Crosstrek")[0]).toContain("site:subaru.com");
    expect(buildManualQueries(2019, "  ford  ", "F-150")[0]).toContain("site:ford.com");
    expect(buildManualQueries(2020, "Mercedes-Benz", "C300")[0]).toContain("site:mbusa.com");
  });

  it("degrades to the generic pair for an unknown make rather than guessing a domain", () => {
    const queries = buildManualQueries(2024, "Koenigsegg", "Jesko");
    expect(queries).toHaveLength(3);
    // No OEM-domain guess — the only site: left is the verified-mirror rescue.
    expect(queries.filter((q) => q.includes("site:"))).toEqual([
      "2024 Koenigsegg Jesko owner's manual site:carmans.net",
    ]);
    expect(queries[0]).toContain("2024 Koenigsegg Jesko");
  });

  it("returns nothing on incomplete vehicle args (fail open, never a bare query)", () => {
    expect(buildManualQueries(2020, "", "Camry")).toEqual([]);
    expect(buildManualQueries(2020, "Toyota", "   ")).toEqual([]);
    expect(buildManualQueries(Number.NaN, "Toyota", "Camry")).toEqual([]);
  });
});

// ─── Wrong-vehicle candidate filter (Aug 9 2026) ─────────────────

describe("contradictsVehicle", () => {
  const SIERRA = { year: 2019, model: "Sierra 1500" };

  it("REJECTS the live wrong-vehicle manual that burned us (2015 Sierra 3500HD for a 2019 1500)", () => {
    const url =
      "https://www.gmc.com/ownercenter/content/dam/gmownercenter/gmna/dynamic/manuals/2015/gmc/sierra_3500hd/2k15sierraden3rdPrint.pdf";
    expect(contradictsVehicle(url, null, SIERRA)).toMatch(/year_mismatch/);
  });
  it("rejects on model-number contradiction even without a URL year", () => {
    const url = "https://www.gmc.com/manuals/gmc/sierra_3500hd/sierraden3rdPrint.pdf";
    expect(contradictsVehicle(url, null, SIERRA)).toMatch(/model_number_mismatch:sierra3500/);
  });
  it("accepts the correct year+model candidate", () => {
    const url = "https://cdn.dealereprocess.org/cdn/servicemanuals/gmc/2019-sierra1500.pdf";
    expect(contradictsVehicle(url, null, SIERRA)).toBeNull();
  });
  it("accepts anonymous candidates (no year, no model) — ranking handles those", () => {
    const url = "https://assets.sia.toyota.com/publications/en/omms-s/T-MMS-20Camry/pdf/T-MMS-20Camry.pdf";
    expect(contradictsVehicle(url, null, { year: 2020, model: "Camry" })).toBeNull();
  });
  it("treats a revision date next to the model year as a match, not a contradiction", () => {
    const url =
      "https://www.volvocars.com/images/cs/v3/assets/x/y/Volvo_Wty_Manual_2021_CC_05-29-2020.pdf";
    expect(contradictsVehicle(url, null, { year: 2021, model: "XC90" })).toBeNull();
  });
  it("accepts a year RANGE that covers the vehicle", () => {
    const url = "https://mirror.example.com/manuals/2018-2022_Grand_Cherokee_Service.pdf";
    expect(contradictsVehicle(url, null, { year: 2019, model: "Grand Cherokee" })).toBeNull();
  });
  it("kills the sibling-model trap (CX-5 manual for a CX-30)", () => {
    const url = "https://www.carmans.net/2021-mazda-cx-5/owners-manual.pdf";
    expect(contradictsVehicle(url, "2021 Mazda CX-5 Owner's Manual", { year: 2021, model: "CX-30" })).toMatch(
      /model_number_mismatch:cx5/,
    );
  });
});

// ─── PDF-embed mirror adapter (Aug 9 2026) ───────────────────────

describe("extractEmbeddedPdfUrl / isPdfEmbedMirrorPage", () => {
  const PAGE = "https://www.carmans.net/2019-gmc-sierra/";
  // Verbatim from the live page — the pdf.js iframe carmans actually serves.
  const CARMANS_IFRAME =
    `<iframe id="game" src="/pdf.js/web/viewer.html?file=/wp-content/uploads/pdf/2019-gmc-sierra.pdf#zoom=page-width&pagemode=bookmarks" style="width: 100%" scrolling="no" frameborder="0"></iframe>`;

  it("extracts the ?file= target from the real carmans pdf.js iframe and resolves it", () => {
    expect(extractEmbeddedPdfUrl(CARMANS_IFRAME, PAGE)).toBe(
      "https://www.carmans.net/wp-content/uploads/pdf/2019-gmc-sierra.pdf",
    );
  });
  it("decodes a URI-encoded file param", () => {
    const html = `<iframe src="/viewer.html?file=%2Fwp-content%2Fuploads%2Fpdf%2F2019-gmc-sierra.pdf"></iframe>`;
    expect(extractEmbeddedPdfUrl(html, PAGE)).toBe(
      "https://www.carmans.net/wp-content/uploads/pdf/2019-gmc-sierra.pdf",
    );
  });
  it("accepts a viewer URL as the haystack itself (search returns these directly)", () => {
    const viewerUrl = "https://www.carmans.net/pdf.js/web/viewer.html?file=/wp-content/uploads/pdf/2019-gmc-sierra.pdf";
    expect(extractEmbeddedPdfUrl(viewerUrl, viewerUrl)).toBe(
      "https://www.carmans.net/wp-content/uploads/pdf/2019-gmc-sierra.pdf",
    );
  });
  it("falls back to plain .pdf attributes and resolves relative paths", () => {
    const html = `<embed type="application/pdf" src="docs/owners-manual.pdf?v=2">`;
    expect(extractEmbeddedPdfUrl(html, PAGE)).toBe(
      "https://www.carmans.net/2019-gmc-sierra/docs/owners-manual.pdf?v=2",
    );
  });
  it("refuses the bundled pdf.js demo document", () => {
    const html = `<iframe src="/pdf.js/web/viewer.html?file=compressed.tracemonkey-pldi-09.pdf"></iframe>`;
    expect(extractEmbeddedPdfUrl(html, PAGE)).toBeNull();
  });
  it("returns null when nothing PDF-shaped is present", () => {
    expect(extractEmbeddedPdfUrl(`<iframe src="/videos/tour.mp4"></iframe>`, PAGE)).toBeNull();
  });

  it("constructs carmans page candidates including the collapsed trim-family slug", () => {
    expect(buildPdfEmbedMirrorPages({ year: 2019, make: "GMC", model: "Sierra 1500" })).toEqual([
      { url: "https://www.carmans.net/2019-gmc-sierra-1500/", title: "2019 GMC Sierra 1500 Owner's Manual (carmans.net)" },
      { url: "https://www.carmans.net/2019-gmc-sierra/", title: "2019 GMC Sierra 1500 Owner's Manual (carmans.net)" },
    ]);
    // Digit-bearing model names dedupe to one URL.
    expect(buildPdfEmbedMirrorPages({ year: 2021, make: "Mazda", model: "CX-30" })).toEqual([
      { url: "https://www.carmans.net/2021-mazda-cx-30/", title: "2021 Mazda CX-30 Owner's Manual (carmans.net)" },
    ]);
    expect(buildPdfEmbedMirrorPages({ year: NaN, make: "GMC", model: "Sierra" })).toEqual([]);
  });

  it("classifies carmans HTML pages as adaptable, direct PDFs and other mirrors as not", () => {
    expect(isPdfEmbedMirrorPage("https://www.carmans.net/2019-gmc-sierra/")).toBe(true);
    // A direct .pdf on carmans is already a normal candidate — no adaptation.
    expect(isPdfEmbedMirrorPage("https://www.carmans.net/wp-content/uploads/pdf/2019-gmc-sierra.pdf")).toBe(false);
    // lemon-manuals is HTML-native (nothing to extract); scribd is the farm.
    expect(isPdfEmbedMirrorPage("https://lemon-manuals.la/GMC/2019/")).toBe(false);
    expect(isPdfEmbedMirrorPage("https://www.scribd.com/document/123/manual")).toBe(false);
  });
});

// ─── OEM-domain classification ───────────────────────────────────

describe("normalizeMakeKey / hostnameOf", () => {
  it("normalizes make keys and hostnames", () => {
    expect(normalizeMakeKey("  Land   Rover ")).toBe("land rover");
    expect(normalizeMakeKey(null)).toBe("");
    expect(hostnameOf("https://WWW.Toyota.com/owners/")).toBe("toyota.com");
    expect(hostnameOf("not a url")).toBeNull();
    expect(hostnameOf(undefined)).toBeNull();
  });
});

describe("isOemDomain", () => {
  it("accepts the manufacturer's own CONTENT hosts, not just the dot-com", () => {
    // All four verified in the discovery study.
    expect(isOemDomain("https://assets.sia.toyota.com/publications/en/omms-s/x.pdf", "Toyota")).toBe(true);
    expect(
      isOemDomain(
        "https://www.fordservicecontent.com/Ford_Content/Catalog/owner_information/x.pdf",
        "Ford",
      ),
    ).toBe(true);
    expect(isOemDomain("https://techinfo.subaru.com/stis/doc/ownerManual/x.pdf", "Subaru")).toBe(true);
    expect(isOemDomain("https://mygarage.honda.com/s/find-honda", "Honda")).toBe(true);
  });

  it("is PER-MAKE — another brand's domain is never OEM provenance", () => {
    expect(isOemDomain("https://www.honda.com/manual.pdf", "Toyota")).toBe(false);
    expect(isOemDomain("https://www.toyota.com/manual.pdf", "Honda")).toBe(false);
  });

  it("rejects mirrors, lookalikes and unknown makes", () => {
    expect(isOemDomain("https://cdn.dealereprocess.org/cdn/servicemanuals/ford/2019-f150.pdf", "Ford")).toBe(
      false,
    );
    // Suffix match must not be a substring match.
    expect(isOemDomain("https://nottoyota.com/manual.pdf", "Toyota")).toBe(false);
    expect(isOemDomain("https://www.toyota.com.evil.example/manual.pdf", "Toyota")).toBe(false);
    expect(isOemDomain("https://www.toyota.com/x.pdf", "Koenigsegg")).toBe(false);
    expect(isOemDomain(null, "Toyota")).toBe(false);
  });

  it("keeps every allowlist entry a bare host (never a URL or a path)", () => {
    for (const [make, domains] of Object.entries(OEM_MANUAL_DOMAINS)) {
      expect(domains.length, `${make} has no domains`).toBeGreaterThan(0);
      for (const d of domains) {
        expect(d, `${make}: "${d}"`).not.toMatch(/[/:\s]/);
        expect(d).toBe(d.toLowerCase());
      }
    }
  });
});

describe("isMirrorDomain", () => {
  it("flags the republisher farms that dominate a plain manual search", () => {
    for (const r of subaruSearch.results) {
      expect(isMirrorDomain(r.url), r.url).toBe(true);
    }
    expect(isMirrorDomain(subaruSearch.site_scoped_results[0].url)).toBe(false);
  });
});

// ─── Doc-kind classification ─────────────────────────────────────

describe("classifyDocKind", () => {
  it("reads Toyota's 'Warranty & Maintenance Guide' as a maintenance_schedule", () => {
    // Verified: this IS Toyota's maintenance schedule publication, despite
    // "warranty" being the first word of the title.
    expect(
      classifyDocKind(
        "https://assets.sia.toyota.com/publications/en/omms-s/T-MMS-20CamryAWD/pdf/T-MMS-20CamryAWD.pdf",
        "2020 WARRANTY & MAINTENANCE GUIDE AWD",
      ),
    ).toBe("maintenance_schedule");
  });

  it("recognises Toyota's publisher path segments, which name neither document", () => {
    // Both observed live on assets.sia.toyota.com. Neither URL nor its search
    // title contains "maintenance" or "owner's manual" — the first live run
    // classified the om-s document as "unknown" until these were added.
    expect(
      classifyDocKind("https://assets.sia.toyota.com/publications/en/om-s/OM20K1QRG/pdf/OM20K1QRG.pdf", ""),
    ).toBe("owners_manual");
    expect(
      classifyDocKind(
        "https://assets.sia.toyota.com/publications/en/omms-s/T-MMS-20CamryAWD/pdf/T-MMS-20CamryAWD.pdf",
        "",
      ),
    ).toBe("maintenance_schedule");
  });

  it("classifies owner's manuals, warranty-only booklets and unknowns", () => {
    expect(
      classifyDocKind(
        "https://www.fordservicecontent.com/.../2019-Ford-F-150-Owners-Manual-version-1_om-EN-US_09_2018.pdf",
        "2019 F-150 Owner's Manual",
      ),
    ).toBe("owners_manual");
    expect(classifyDocKind("https://example.com/x.pdf", "Warranty Booklet")).toBe("warranty_guide");
    expect(classifyDocKind("https://example.com/brochure.pdf", "Camry Brochure")).toBe("unknown");
    expect(classifyDocKind(null, null)).toBe("unknown");
  });
});

describe("looksLikePdfUrl", () => {
  it("only accepts a .pdf path, ignoring query and fragment", () => {
    expect(looksLikePdfUrl("https://a.com/b.PDF")).toBe(true);
    expect(looksLikePdfUrl("https://a.com/b.pdf?v=2#page=3")).toBe(true);
    expect(looksLikePdfUrl("https://www.toyota.com/owners/warranty-owners-manuals/vehicle/camry/2020/")).toBe(
      false,
    );
    expect(looksLikePdfUrl("https://a.com/pdf/viewer")).toBe(false);
  });
});

// ─── Candidate ranking ───────────────────────────────────────────

describe("rankManualCandidates", () => {
  it("puts the byte-verified OEM maintenance-schedule PDF first for the 2020 Camry", () => {
    const ranked = rankManualCandidates(toyotaSearch.results, CAMRY);
    expect(ranked[0].url).toBe(
      "https://assets.sia.toyota.com/publications/en/omms-s/T-MMS-20CamryAWD/pdf/T-MMS-20CamryAWD.pdf",
    );
    expect(ranked[0].is_oem_domain).toBe(true);
    expect(ranked[0].doc_kind).toBe("maintenance_schedule");
    expect(ranked[0].is_pdf).toBe(true);
    // The eBay listing is last.
    expect(ranked[ranked.length - 1].source_domain).toContain("ebay");
  });

  it("OEM + maintenance_schedule beats third-party + owners_manual", () => {
    const ranked = rankManualCandidates(
      [
        // A perfect third-party owner's manual: right year, right model, a PDF.
        {
          url: "https://cdn.dealereprocess.org/cdn/servicemanuals/toyota/2020-camry.pdf",
          title: "2020 Camry Owner's Manual",
        },
        // A bare-bones OEM schedule with no year/model tokens at all.
        {
          url: "https://assets.sia.toyota.com/publications/en/omms-s/x/pdf/maintenance-schedule.pdf",
          title: "Maintenance Schedule",
        },
      ],
      CAMRY,
    );
    expect(ranked[0].source_domain).toBe("assets.sia.toyota.com");
    expect(ranked[0].is_oem_domain).toBe(true);
    expect(ranked[0].doc_kind).toBe("maintenance_schedule");
    expect(ranked[1].is_oem_domain).toBe(false);
    expect(ranked[1].doc_kind).toBe("owners_manual");
  });

  // Regression: 2019 Subaru Forester, canary round Jul 30 2026.
  // `MSA5B1906A_STIS.pdf` on Subaru's own techinfo host won on the OEM bonus
  // alone — it names neither the model nor the year — and turned out to be the
  // 2019 BRZ Quick Guide. The extractor caught it, but only after paying for a
  // 2.75 MB download and a Files API upload.
  it("an ANONYMOUS OEM candidate loses to a self-identifying OEM candidate", () => {
    const FORESTER = { make: "Subaru", model: "Forester", year: 2019 };
    const ranked = rankManualCandidates(
      [
        // Real PDF, real OEM host, but nothing ties it to this vehicle.
        { url: "https://techinfo.subaru.com/stis/doc/ownerManual/MSA5B1906A_STIS.pdf", title: "" },
        // Same host, same doc kind, but it says what it is.
        {
          url: "https://techinfo.subaru.com/stis/doc/ownerManual/2019_Forester_OM.pdf",
          title: "2019 Forester Owner's Manual",
        },
      ],
      FORESTER,
    );
    expect(ranked[0].url).toContain("2019_Forester_OM.pdf");
    expect(ranked[1].url).toContain("MSA5B1906A_STIS.pdf");
  });

  it("the anonymity penalty never outweighs OEM provenance", () => {
    // The penalty must only re-order WITHIN a provenance tier. An anonymous OEM
    // document is still better than a third-party one that names the vehicle —
    // provenance is the product requirement.
    const FORESTER = { make: "Subaru", model: "Forester", year: 2019 };
    const ranked = rankManualCandidates(
      [
        {
          url: "https://www.manualslib.com/subaru/2019-forester-owners-manual.pdf",
          title: "2019 Subaru Forester Owner's Manual",
        },
        { url: "https://techinfo.subaru.com/stis/doc/ownerManual/MSA5B1906A_STIS.pdf", title: "" },
      ],
      FORESTER,
    );
    expect(ranked[0].is_oem_domain).toBe(true);
    expect(ranked[0].url).toContain("techinfo.subaru.com");
  });

  it("within the OEM tier, a maintenance schedule beats an owner's manual", () => {
    const ranked = rankManualCandidates(
      [
        { url: "https://www.toyota.com/x/2020-camry-owners-manual.pdf", title: "2020 Camry Owner's Manual" },
        {
          url: "https://www.toyota.com/x/2020-camry-maintenance-guide.pdf",
          title: "2020 Camry Warranty & Maintenance Guide",
        },
      ],
      CAMRY,
    );
    expect(ranked[0].doc_kind).toBe("maintenance_schedule");
    expect(ranked[1].doc_kind).toBe("owners_manual");
  });

  it("prefers Ford's own content host over the dealer CDN mirror", () => {
    const ranked = rankManualCandidates(fordSearch.results, F150);
    expect(ranked[0].source_domain).toBe("fordservicecontent.com");
    expect(ranked[0].is_oem_domain).toBe(true);
    const mirror = ranked.find((c) => c.source_domain === "cdn.dealereprocess.org");
    expect(mirror).toBeDefined();
    expect(mirror!.is_oem_domain).toBe(false);
    expect(mirror!.score).toBeLessThan(ranked[0].score);
  });

  it("still surfaces a usable mirror when the make publishes no reachable OEM URL (Honda)", () => {
    const ranked = rankManualCandidates(hondaSearch.results, CRV);
    const pdfs = ranked.filter((c) => c.is_pdf);
    expect(pdfs.length).toBeGreaterThan(0);
    // …but it never gets to claim OEM provenance.
    expect(ranked.every((c) => c.is_oem_domain === false)).toBe(true);
    expect(pdfs[0].url).toBe("https://cdn.dealereprocess.org/cdn/servicemanuals/honda/2021-crv.pdf");
  });

  it("lifts the OEM host above eight mirrors once the site:-scoped query runs (Subaru)", () => {
    const plain = rankManualCandidates(subaruSearch.results, CROSSTREK);
    expect(plain.every((c) => c.is_oem_domain === false)).toBe(true);

    const withOem = rankManualCandidates(
      [...subaruSearch.results, ...subaruSearch.site_scoped_results],
      CROSSTREK,
    );
    expect(withOem[0].source_domain).toBe("techinfo.subaru.com");
    expect(withOem[0].is_oem_domain).toBe(true);
  });

  it("dedupes repeated URLs and drops unparseable ones", () => {
    const ranked = rankManualCandidates(
      [
        { url: "https://www.toyota.com/a.pdf", title: "A" },
        { url: "https://www.toyota.com/a.pdf", title: "A again" },
        { url: "javascript:void(0)", title: "junk" },
        { url: "", title: "empty" },
      ],
      CAMRY,
    );
    expect(ranked).toHaveLength(1);
  });

  it("rewards the matching model year and the two-digit Toyota slug form", () => {
    const ranked = rankManualCandidates(
      [
        { url: "https://www.toyota.com/x/T-MMS-19CamryAWD.pdf", title: "2019 Warranty & Maintenance Guide" },
        { url: "https://www.toyota.com/x/T-MMS-20CamryAWD.pdf", title: "2020 Warranty & Maintenance Guide" },
      ],
      CAMRY,
    );
    expect(ranked[0].url).toContain("20Camry");
  });
});

// ─── Negative cache / staleness ──────────────────────────────────

describe("shouldSkipManualLookup", () => {
  it("proceeds when there is no row at all", () => {
    expect(shouldSkipManualLookup(null, NOW)).toEqual({ skip: false, reason: "no_row" });
    expect(shouldSkipManualLookup(undefined, NOW).skip).toBe(false);
  });

  it("reuses a fresh stored manual instead of re-paying for it", () => {
    const decision = shouldSkipManualLookup(
      { file_id: "file_abc", fetched_at: NOW - 5 * DAY_MS, expires_at: NOW + 100 * DAY_MS },
      NOW,
    );
    expect(decision).toEqual({ skip: true, reason: "fresh_manual" });
  });

  it("re-resolves once the stored manual passes its expiry or refresh horizon", () => {
    expect(
      shouldSkipManualLookup({ file_id: "file_abc", fetched_at: NOW - DAY_MS, expires_at: NOW - 1 }, NOW),
    ).toEqual({ skip: false, reason: "manual_expired" });
    expect(
      shouldSkipManualLookup({ file_id: "file_abc", fetched_at: NOW - (MANUAL_REFRESH_DAYS + 1) * DAY_MS }, NOW),
    ).toEqual({ skip: false, reason: "manual_stale" });
  });

  it("suppresses retries of a failure for exactly 14 days, then lets one through", () => {
    const justInside = shouldSkipManualLookup(
      { failure_reason: "download_error:timeout", attempts: 2, fetched_at: NOW - (MANUAL_FAILURE_TTL_DAYS * DAY_MS - 1) },
      NOW,
    );
    expect(justInside).toEqual({ skip: true, reason: "negative_cache" });

    const justOutside = shouldSkipManualLookup(
      { failure_reason: "download_error:timeout", attempts: 2, fetched_at: NOW - (MANUAL_FAILURE_TTL_DAYS * DAY_MS + 1) },
      NOW,
    );
    expect(justOutside).toEqual({ skip: false, reason: "negative_cache_expired" });
  });

  it("prefers a stored file_id over a stale failure_reason on the same row", () => {
    expect(
      shouldSkipManualLookup(
        { file_id: "file_abc", failure_reason: "old_failure", fetched_at: NOW - DAY_MS },
        NOW,
      ),
    ).toEqual({ skip: true, reason: "fresh_manual" });
  });

  it("honours a caller-supplied TTL override", () => {
    const row = { failure_reason: "boom", fetched_at: NOW - 3 * DAY_MS };
    expect(shouldSkipManualLookup(row, NOW, { failureTtlDays: 1 }).skip).toBe(false);
    expect(shouldSkipManualLookup(row, NOW, { failureTtlDays: 30 }).skip).toBe(true);
  });

  it("proceeds on a row that is neither a success nor a recorded failure", () => {
    expect(shouldSkipManualLookup({ fetched_at: NOW }, NOW)).toEqual({
      skip: false,
      reason: "incomplete_row",
    });
  });
});

// ─── Write precedence (table-driven) ─────────────────────────────

// Regression: 2019 Subaru Forester, canary round Jul 30 2026. The extractor
// read the downloaded PDF and reported it was the BRZ Quick Guide, but the row
// still carried a file_id — so the wrong document was cached as this vehicle's
// manual for 180 days. Rejection clears the file_id; these tests pin what the
// skip logic must then do.
describe("shouldSkipManualLookup — rejection loop", () => {
  const rejected = (rejections: number, ageDays = 0) => ({
    file_id: null,
    failure_reason:
      "rejected_after_extraction: The uploaded document is the 2019 Subaru BRZ Quick Guide",
    rejected_urls: Array.from({ length: rejections }, (_, i) => `https://x/${i}.pdf`),
    fetched_at: Date.now() - ageDays * 24 * 60 * 60 * 1000,
  });

  it("retries IMMEDIATELY after a rejection — the loop must not wait 14 days", () => {
    const d = shouldSkipManualLookup(rejected(1));
    expect(d.skip).toBe(false);
    expect(d.reason).toBe("retry_after_rejection");
  });

  it("keeps retrying while untried candidates remain", () => {
    expect(shouldSkipManualLookup(rejected(2)).skip).toBe(false);
  });

  it("stops paying once the rejection limit is reached", () => {
    const d = shouldSkipManualLookup(rejected(3));
    expect(d.skip).toBe(true);
    expect(d.reason).toBe("rejection_limit_reached");
  });

  it("reopens the exhausted vehicle after the negative-cache TTL", () => {
    expect(shouldSkipManualLookup(rejected(3, 30)).skip).toBe(false);
  });

  it("an ORDINARY failure still uses the plain negative cache", () => {
    // A dead host must not get the fast-retry path — nothing has changed that
    // would make the next attempt more likely to work.
    const d = shouldSkipManualLookup({
      file_id: null,
      failure_reason: "download_error:timeout",
      fetched_at: Date.now(),
    });
    expect(d.skip).toBe(true);
    expect(d.reason).toBe("negative_cache");
  });

  it("a successful manual is still reused — rejection logic doesn't touch it", () => {
    expect(
      shouldSkipManualLookup({ file_id: "file_abc", fetched_at: Date.now() }).skip,
    ).toBe(true);
  });
});

describe("shouldOverwriteInterval", () => {
  const cases: Array<{
    name: string;
    existing: StoredIntervalLike;
    incoming: IncomingInterval;
    write: boolean;
    reason: string;
  }> = [
    {
      name: "no stored row → write",
      existing: null,
      incoming: { interval_miles: 10000, interval_months: 12 },
      write: true,
      reason: "no_existing_row",
    },
    {
      name: "empty incoming (both null) → never write",
      existing: null,
      incoming: { interval_miles: null, interval_months: null },
      write: false,
      reason: "empty_incoming",
    },
    {
      name: "zero/negative incoming is not a value",
      existing: null,
      incoming: { interval_miles: 0, interval_months: -12 },
      write: false,
      reason: "empty_incoming",
    },
    {
      name: "mechanic_verified is untouchable, even by a complete manual reading",
      existing: { interval_miles: 5000, data_quality: "enriched", mechanic_verified: true },
      incoming: { interval_miles: 10000, interval_months: 12 },
      write: false,
      reason: "mechanic_verified",
    },
    {
      name: "default_fallback is overwritten (the 26% this module exists to fix)",
      existing: { interval_miles: 5000, interval_months: null, data_quality: "default_fallback" },
      incoming: { interval_miles: 10000, interval_months: 12 },
      write: true,
      reason: "upgrade_from_default_fallback",
    },
    {
      name: "enriched is overwritten",
      existing: { interval_miles: 7500, interval_months: 6, data_quality: "enriched" },
      incoming: { interval_miles: 10000, interval_months: 12 },
      write: true,
      reason: "upgrade_from_enriched",
    },
    {
      name: "vdb_schedule is overwritten",
      existing: { interval_miles: 7500, interval_months: 12, data_quality: "vdb_schedule" },
      incoming: { interval_miles: 10000, interval_months: 12 },
      write: true,
      reason: "upgrade_from_vdb_schedule",
    },
    {
      name: "an unset data_quality is overwritten",
      existing: { interval_miles: 7500 },
      incoming: { interval_miles: 10000, interval_months: 12 },
      write: true,
      reason: "upgrade_from_unset",
    },
    {
      name: "a miles-only reading may fill an empty row",
      existing: null,
      incoming: { interval_miles: 10000, interval_months: null },
      write: true,
      reason: "no_existing_row",
    },
    {
      name: "deterministic is protected from a miles-only reading",
      existing: { interval_miles: 10000, interval_months: null, data_quality: "deterministic" },
      incoming: { interval_miles: 7500, interval_months: null },
      write: false,
      reason: "protected_deterministic",
    },
    {
      name: "deterministic WITHOUT months yields to a both-values reading (the months fill)",
      existing: { interval_miles: 10000, interval_months: null, data_quality: "deterministic" },
      incoming: { interval_miles: 10000, interval_months: 12 },
      write: true,
      reason: "months_fill_upgrade",
    },
    {
      name: "deterministic WITH months is never overwritten",
      existing: { interval_miles: 10000, interval_months: 12, data_quality: "deterministic" },
      incoming: { interval_miles: 7500, interval_months: 6 },
      write: false,
      reason: "protected_deterministic",
    },
    {
      name: "oem_manual WITHOUT months yields to a both-values reading",
      existing: { interval_miles: 10000, interval_months: null, data_quality: "oem_manual" },
      incoming: { interval_miles: 10000, interval_months: 12 },
      write: true,
      reason: "months_fill_upgrade",
    },
    {
      name: "oem_manual WITH months is never overwritten (no re-run churn)",
      existing: { interval_miles: 10000, interval_months: 12, data_quality: "oem_manual" },
      incoming: { interval_miles: 10000, interval_months: 12 },
      write: false,
      reason: "protected_oem_manual",
    },
    {
      name: "oem_manual months-less row is NOT overwritten by a months-only reading",
      existing: { interval_miles: 10000, interval_months: null, data_quality: "oem_manual" },
      incoming: { interval_miles: null, interval_months: 12 },
      write: false,
      reason: "protected_oem_manual",
    },
    {
      name: "data_quality matching is case/whitespace tolerant",
      existing: { interval_miles: 10000, interval_months: 12, data_quality: "  Deterministic " },
      incoming: { interval_miles: 5000, interval_months: 6 },
      write: false,
      reason: "protected_deterministic",
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(shouldOverwriteInterval(c.existing, c.incoming)).toEqual({
        write: c.write,
        reason: c.reason,
      });
    });
  }

  it("never downgrades a protected tier across a re-run (idempotent)", () => {
    const stored: StoredIntervalLike = {
      interval_miles: 10000,
      interval_months: 12,
      data_quality: "oem_manual",
    };
    for (let i = 0; i < 5; i++) {
      expect(shouldOverwriteInterval(stored, { interval_miles: 10000, interval_months: 12 }).write).toBe(false);
    }
  });
});

// ─── Response parsing ────────────────────────────────────────────

describe("extractToolPayload / collectCitationSpans", () => {
  it("pulls the forced tool payload out of a Messages API body", () => {
    const payload = extractToolPayload(extractionResponse, "record_maintenance_schedule");
    expect(payload).not.toBeNull();
    expect(payload!.schedule_found).toBe(true);
    expect(Array.isArray(payload!.services)).toBe(true);
  });

  it("returns null for a missing/renamed tool rather than guessing a block", () => {
    expect(extractToolPayload(extractionResponse, "some_other_tool")).toBeNull();
    expect(extractToolPayload({ content: [{ type: "text", text: "hi" }] }, "record_maintenance_schedule")).toBeNull();
    expect(extractToolPayload(null, "record_maintenance_schedule")).toBeNull();
    expect(extractToolPayload("not json", "record_maintenance_schedule")).toBeNull();
  });

  it("collects the citation spans that make an oem_manual row auditable", () => {
    const spans = collectCitationSpans(extractionResponse);
    expect(spans).toHaveLength(2);
    expect(spans[0]).toContain("Every 10,000 miles or 12 months");
    expect(collectCitationSpans({ content: [] })).toEqual([]);
    expect(collectCitationSpans(undefined)).toEqual([]);
  });
});

describe("parseManualIntervals", () => {
  const payload = extractToolPayload(extractionResponse, "record_maintenance_schedule")!;
  const rows = parseManualIntervals(payload);

  it("drops unknown service keys instead of inventing a service", () => {
    expect(
      parseManualIntervals({
        services: [{ service_key: "fuel_filter", interval_miles: 30000 }],
      }),
    ).toEqual([]);
  });

  it("parses the fixture's wiper_blades row now that wipers are a real key (Aug 9 2026)", () => {
    // This row was the canonical "unknown key gets dropped" example before
    // wiper replacement became extractable — GM's schedule prints it as a
    // real scheduled row ("Replace windshield wiper blades … or every three
    // years").
    const wiper = rows.find((r) => r.service_key === "wiper_blades");
    expect(wiper?.service_slug).toBe("wiper_blade_replacement");
  });

  it("drops entries with neither miles nor months", () => {
    expect(rows.some((r) => r.service_key === "transmission_service")).toBe(false);
  });

  it("keeps a months-only interval (the exact gap this module fills)", () => {
    const brake = rows.find((r) => r.service_key === "brake_fluid_flush")!;
    expect(brake.interval_miles).toBeNull();
    expect(brake.interval_months).toBe(36);
    expect(brake.service_slug).toBe("brake_fluid_flush");
  });

  it("coerces a comma-formatted string number", () => {
    const air = rows.find((r) => r.service_key === "air_filter")!;
    expect(air.interval_miles).toBe(30000);
  });

  it("carries the verbatim quote and page for provenance", () => {
    const oil = rows.find((r) => r.service_key === "oil_change")!;
    expect(oil.quoted_text).toContain("Replace engine oil and oil filter");
    expect(oil.page_number).toBe(12);
    expect(oil.severe_miles).toBe(5000);
    expect(oil.severe_months).toBe(6);
    expect(oil.display_string).toBe("Every 10,000 miles or 12 months (severe: 5,000 mi / 6 mo)");
  });

  it("maps every emitted key through MANUAL_INTERVAL_TO_SERVICE", () => {
    for (const row of rows) {
      expect(MANUAL_INTERVAL_TO_SERVICE[row.service_key]).toBe(row.service_slug);
    }
  });

  it("fails open on malformed input", () => {
    expect(parseManualIntervals(null)).toEqual([]);
    expect(parseManualIntervals({})).toEqual([]);
    expect(parseManualIntervals({ services: "nope" })).toEqual([]);
    expect(parseManualIntervals({ services: [null, 3, { service_key: 12 }] })).toEqual([]);
  });

  it("never emits brake_pads — a wear estimate must not wear OEM provenance", () => {
    expect(MANUAL_INTERVAL_TO_SERVICE.brake_pads).toBeUndefined();
    expect(
      parseManualIntervals({
        services: [{ service_key: "brake_pads", interval_miles: 40000, interval_months: 48 }],
      }),
    ).toEqual([]);
  });

  it("wear-adjacent keys map to the services they actually describe (Aug 9 2026)", () => {
    // A battery CHECK cadence is battery_test — writing it to
    // battery_replacement would be the exact inspect→replace corruption the
    // brake_pads exclusion pins.
    expect(MANUAL_INTERVAL_TO_SERVICE.battery_inspection).toBe("battery_test");
    expect(MANUAL_INTERVAL_TO_SERVICE.battery_inspection).not.toBe("battery_replacement");
    expect(MANUAL_INTERVAL_TO_SERVICE.wiper_blades).toBe("wiper_blade_replacement");
    expect(MANUAL_INTERVAL_TO_SERVICE.tire_max_age).toBe("tire_replacement");
    // rotor/pad/tread replacement stay unmapped — wear-to-spec, not scheduled.
    expect(MANUAL_INTERVAL_TO_SERVICE.rotor_replacement).toBeUndefined();
    expect(MANUAL_INTERVAL_TO_SERVICE.tire_replacement).toBeUndefined();
    expect(MANUAL_INTERVAL_TO_SERVICE.battery_replacement).toBeUndefined();
  });

  it("a months-only tire_max_age row survives parsing (age ceilings have no mileage)", () => {
    const rows = parseManualIntervals({
      services: [
        {
          service_key: "tire_max_age",
          interval_miles: null,
          interval_months: 72,
          quoted_text: "Replace tires over six years old regardless of tread wear.",
        },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].service_slug).toBe("tire_replacement");
    expect(rows[0].interval_months).toBe(72);
    expect(rows[0].interval_miles).toBeNull();
  });
});

describe("dedupeIntervalsByService", () => {
  it("resolves the air_filter / cabin_filter collision deterministically", () => {
    const payload = extractToolPayload(extractionResponse, "record_maintenance_schedule")!;
    const deduped = dedupeIntervalsByService(parseManualIntervals(payload));
    const filterRows = deduped.filter((r) => r.service_slug === "filter_replacement");
    expect(filterRows).toHaveLength(1);
    // Engine air filter wins regardless of the order the model listed them
    // (the fixture puts cabin_filter FIRST on purpose).
    expect(filterRows[0].service_key).toBe("air_filter");
  });

  it("emits rows in MANUAL_INTERVAL_ORDER, one per service slug", () => {
    const payload = extractToolPayload(extractionResponse, "record_maintenance_schedule")!;
    const deduped = dedupeIntervalsByService(parseManualIntervals(payload));
    const slugs = deduped.map((r) => r.service_slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    const positions = deduped.map((r) => MANUAL_INTERVAL_ORDER.indexOf(r.service_key));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(slugs).toEqual([
      "oil_change",
      "tire_rotation",
      "filter_replacement",
      "spark_plugs",
      "brake_fluid_flush",
      "wiper_blade_replacement",
    ]);
  });

  it("is a no-op on an empty list", () => {
    expect(dedupeIntervalsByService([])).toEqual([]);
  });
});

// ─── Formatting / PDF sniffing / schema ──────────────────────────

describe("formatIntervalDisplay", () => {
  it("renders miles-only, months-only and severe variants", () => {
    expect(formatIntervalDisplay({ interval_miles: 10000, interval_months: null })).toBe("Every 10,000 miles");
    expect(formatIntervalDisplay({ interval_miles: null, interval_months: 36 })).toBe("Every 36 months");
    expect(
      formatIntervalDisplay({ interval_miles: 10000, interval_months: 12, severe_miles: 5000 }),
    ).toBe("Every 10,000 miles or 12 months (severe: 5,000 mi)");
    expect(formatIntervalDisplay({ interval_miles: null, interval_months: null })).toBeNull();
  });
});

describe("looksLikePdfBytes", () => {
  const bytesOf = (s: string) => new TextEncoder().encode(s);

  it("accepts a real PDF header and rejects an HTML error page wearing a .pdf URL", () => {
    expect(looksLikePdfBytes(bytesOf("%PDF-1.7\n%\xe2\xe3\xcf\xd3"))).toBe(true);
    expect(looksLikePdfBytes(bytesOf("<!DOCTYPE html><html><body>404"))).toBe(false);
    expect(looksLikePdfBytes(bytesOf("PDF"))).toBe(false);
    expect(looksLikePdfBytes(new Uint8Array(0))).toBe(false);
    expect(looksLikePdfBytes(null)).toBe(false);
  });
});

describe("estimatePdfPageCount", () => {
  it("counts /Type /Page objects, and reports null rather than a wrong zero", () => {
    const pdf = new TextEncoder().encode(
      "%PDF-1.7\n1 0 obj<</Type /Pages /Count 3>>endobj\n" +
        "2 0 obj<</Type /Page /Parent 1 0 R>>endobj\n" +
        "3 0 obj<</Type /Page /Parent 1 0 R>>endobj\n" +
        "4 0 obj<</Type /Page /Parent 1 0 R>>endobj\n",
    );
    expect(estimatePdfPageCount(pdf)).toBe(3);
    expect(estimatePdfPageCount(new TextEncoder().encode("%PDF-1.7\nno pages here"))).toBeNull();
    expect(estimatePdfPageCount(null)).toBeNull();
  });
});

describe("manualFileName", () => {
  it("builds a stable, path-safe upload filename", () => {
    expect(manualFileName(CAMRY, "maintenance_schedule")).toBe(
      "2020-toyota-camry-maintenance-schedule.pdf",
    );
    expect(manualFileName(CRV, "owners_manual")).toBe("2021-honda-cr-v-owners-manual.pdf");
    expect(manualFileName(F150, "")).toBe("2019-ford-f-150-manual.pdf");
  });
});

describe("buildManualExtractionSchema", () => {
  const schema = buildManualExtractionSchema();

  it("is strict-shaped in the batchSchemas.ts style", () => {
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual([
      "document_matches_vehicle",
      "document_vehicle_text",
      "schedule_found",
      "schedule_kind",
      "services",
      "notes",
    ]);

    const entry = schema.properties.services.items;
    expect(entry.additionalProperties).toBe(false);
    expect(entry.required).toContain("quoted_text");
    expect(entry.required).toContain("severe_miles");
    expect(entry.properties.service_key.enum).toEqual([...MANUAL_INTERVAL_ORDER]);
  });

  it("uses anyOf-nullable leaves rather than bare types (values stay permissive)", () => {
    const entry = schema.properties.services.items;
    for (const key of ["interval_miles", "interval_months", "severe_miles", "severe_months", "quoted_text"]) {
      expect(entry.properties[key].anyOf, key).toBeDefined();
      expect(entry.properties[key].anyOf).toContainEqual({ type: "null" });
    }
  });

  it("keeps the enum and the service map in lockstep", () => {
    expect([...MANUAL_INTERVAL_ORDER].sort()).toEqual(Object.keys(MANUAL_INTERVAL_TO_SERVICE).sort());
  });
});

describe("buildManualExtractionPrompt", () => {
  it("forbids inference and demands a verbatim quote", () => {
    const prompt = buildManualExtractionPrompt(CAMRY);
    expect(prompt).toContain("2020 Toyota Camry");
    expect(prompt).toContain("Never infer");
    expect(prompt).toContain("VERBATIM");
    expect(prompt).toContain("Maintenance Minder");
    for (const key of MANUAL_INTERVAL_ORDER) expect(prompt).toContain(key);
  });
});
