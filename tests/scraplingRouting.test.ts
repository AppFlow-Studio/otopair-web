/**
 * Scrapling routing — the miss contract.
 *
 * The defect these pin: the original wiring accepted ANY non-empty body as a
 * successful scrape. A Cloudflare interstitial is several KB of real HTML, so it
 * sailed through and pre-empted the Firecrawl stealth retry / direct fallback
 * that might actually have gotten the page. Failure was invisible — it surfaced
 * as thin extraction downstream, never as an error.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  looksBlockedBody,
  scraplingFetchPage,
  scraplingFetchUrlWithHtml,
} from "../convex/vehicleEnrichment/scrapling";
import {
  adapterFetch,
  isScraplingEligible,
} from "../convex/vehicleEnrichment/sourceAdapters/http";

const SERVICE = "https://scraper.test";
const TARGET = "https://www.mycarusermanual.com/bmw/3-series";

const CHALLENGE_HTML =
  '<!DOCTYPE html><html><head><title>Just a moment...</title>' +
  '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>' +
  "</head><body>" +
  "x".repeat(3000) + // comfortably past the service's 1000-char floor
  "</body></html>";

const REAL_PAGE_HTML =
  "<html><body><h1>3 Series Owner's Manual</h1>" +
  "<p>Engine oil capacity 5.2 quarts. Please wait a moment for the page to " +
  "load, then access the maintenance section to continue.</p>" +
  "</body></html>";

/** Fake service envelope: the service answers 200 and reports UPSTREAM status. */
const svc = (body: Record<string, unknown>) => ({
  ok: true,
  status: 200,
  statusText: "OK",
  json: async () => body,
});

/** Fake direct-tier page response. */
const page = (status: number, body: string) => ({
  status,
  text: async () => body,
});

let envBackup: Record<string, string | undefined>;

beforeEach(() => {
  envBackup = {
    SCRAPLING_URL: process.env.SCRAPLING_URL,
    SCRAPLING_TOKEN: process.env.SCRAPLING_TOKEN,
    PARTS_SCRAPLING_ADAPTERS: process.env.PARTS_SCRAPLING_ADAPTERS,
  };
  process.env.SCRAPLING_URL = SERVICE;
  process.env.PARTS_SCRAPLING_ADAPTERS = "on";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Route the single global fetch: service calls vs. direct-tier page calls. */
function mockNetwork(opts: {
  service?: Record<string, unknown>;
  serviceHttpFails?: boolean;
  direct?: { status: number; body: string };
  directThrows?: boolean;
}) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).startsWith(SERVICE)) {
        calls.push("service");
        if (opts.serviceHttpFails) {
          return { ok: false, status: 502, statusText: "Bad Gateway" };
        }
        return svc(opts.service ?? {});
      }
      calls.push("direct");
      if (opts.directThrows) throw new Error("ECONNREFUSED");
      return page(opts.direct?.status ?? 200, opts.direct?.body ?? REAL_PAGE_HTML);
    }),
  );
  return calls;
}

describe("looksBlockedBody", () => {
  it("catches the challenge signatures", () => {
    expect(looksBlockedBody(CHALLENGE_HTML)).toBe(true);
    expect(looksBlockedBody('<div id="px-captcha"></div>')).toBe(true);
    expect(looksBlockedBody("<h1>Attention Required! | Cloudflare</h1>")).toBe(true);
    expect(looksBlockedBody("window._cf_chl_opt={};")).toBe(true);
  });

  it("does not fire on ordinary page copy that happens to use the words", () => {
    // The patterns must be narrow enough that a real manual page containing
    // "moment" / "access" / "continue" is never discarded as a wall.
    expect(looksBlockedBody(REAL_PAGE_HTML)).toBe(false);
    expect(looksBlockedBody("Access denied to the trunk release.")).toBe(false);
    expect(looksBlockedBody("")).toBe(false);
    expect(looksBlockedBody(null)).toBe(false);
  });

  it("only scans the head of the body", () => {
    // A signature buried past 4000 chars is not a challenge page — a challenge
    // puts its tell up top. Scanning the whole body would be a false-positive
    // machine on long pages that quote script tags.
    expect(looksBlockedBody("y".repeat(5000) + "_cf_chl_opt")).toBe(false);
  });
});

describe("scraplingFetchUrlWithHtml — misses are null", () => {
  it("returns the page on a clean 200", async () => {
    mockNetwork({ service: { status: 200, html: REAL_PAGE_HTML, markdown: "# 3 Series" } });
    const r = await scraplingFetchUrlWithHtml(TARGET);
    expect(r).not.toBeNull();
    expect(r!.markdown).toBe("# 3 Series");
  });

  it("rejects an upstream 4xx even though the service call itself succeeded", async () => {
    // The service answers 200 and reports the target's 403 in the envelope.
    mockNetwork({ service: { status: 403, html: CHALLENGE_HTML } });
    expect(await scraplingFetchUrlWithHtml(TARGET)).toBeNull();
  });

  it("rejects a 200 that is actually an interstitial — THE regression", async () => {
    // Status 200, 3 KB of real HTML: passes every length/status guard there was.
    mockNetwork({ service: { status: 200, html: CHALLENGE_HTML } });
    expect(await scraplingFetchUrlWithHtml(TARGET)).toBeNull();
  });

  it("honors the service's own blocked verdict", async () => {
    mockNetwork({ service: { status: 200, html: "<html>short but walled</html>", blocked: true } });
    expect(await scraplingFetchUrlWithHtml(TARGET)).toBeNull();
  });

  it("returns null on an empty body and on a service HTTP failure", async () => {
    mockNetwork({ service: { status: 200, html: null, markdown: null } });
    expect(await scraplingFetchUrlWithHtml(TARGET)).toBeNull();

    mockNetwork({ serviceHttpFails: true });
    expect(await scraplingFetchUrlWithHtml(TARGET)).toBeNull();
  });

  it("no-ops when SCRAPLING_URL is unset", async () => {
    delete process.env.SCRAPLING_URL;
    const calls = mockNetwork({ service: { status: 200, html: REAL_PAGE_HTML } });
    expect(await scraplingFetchUrlWithHtml(TARGET)).toBeNull();
    expect(calls).toHaveLength(0); // never touched the network
  });
});

describe("scraplingFetchPage", () => {
  it("hands back raw HTML for the adapter layer", async () => {
    mockNetwork({ service: { status: 200, html: REAL_PAGE_HTML } });
    const r = await scraplingFetchPage(TARGET);
    expect(r).toEqual({ status: 200, body: REAL_PAGE_HTML });
  });

  it("is null when only markdown came back — adapters parse HTML", async () => {
    mockNetwork({ service: { status: 200, html: null, markdown: "# something" } });
    expect(await scraplingFetchPage(TARGET)).toBeNull();
  });
});

describe("isScraplingEligible", () => {
  it("accepts a plain HTML GET with browser-identity headers only", () => {
    expect(
      isScraplingEligible({
        headers: {
          "User-Agent": "x",
          Accept: "text/html",
          "Accept-Language": "en-US",
          "Sec-Fetch-Mode": "navigate",
          "sec-ch-ua-platform": '"Windows"',
          "Upgrade-Insecure-Requests": "1",
        },
      }),
    ).toBe(true);
  });

  it("refuses requests whose meaning depends on headers the service cannot send", () => {
    // Routing these would silently change the request: unauthenticated,
    // cross-origin, or no longer an XHR.
    expect(isScraplingEligible({ headers: { Cookie: "sess=1" } })).toBe(false);
    expect(isScraplingEligible({ headers: { Referer: "https://x.test" } })).toBe(false);
    expect(isScraplingEligible({ headers: { "X-Requested-With": "XMLHttpRequest" } })).toBe(false);
    expect(isScraplingEligible({ headers: { origin: "https://x.test" } })).toBe(false); // case-insensitive
  });

  it("refuses JSON endpoints — the service HTML-parses what it fetches", () => {
    expect(isScraplingEligible({ expects: "json" })).toBe(false);
  });

  it("is off unless both the flag and the URL are set", () => {
    process.env.PARTS_SCRAPLING_ADAPTERS = "off";
    expect(isScraplingEligible({})).toBe(false);

    process.env.PARTS_SCRAPLING_ADAPTERS = "on";
    delete process.env.SCRAPLING_URL;
    expect(isScraplingEligible({})).toBe(false);
  });
});

describe("adapterFetch", () => {
  it("prefers Scrapling when eligible", async () => {
    mockNetwork({ service: { status: 200, html: REAL_PAGE_HTML } });
    const r = await adapterFetch(TARGET);
    expect(r.via).toBe("scrapling");
    expect(r.body).toBe(REAL_PAGE_HTML);
  });

  it("falls back to the direct tier when Scrapling returns a wall", async () => {
    const calls = mockNetwork({
      service: { status: 200, html: CHALLENGE_HTML },
      direct: { status: 200, body: REAL_PAGE_HTML },
    });
    const r = await adapterFetch(TARGET);
    expect(calls).toEqual(["service", "direct"]);
    expect(r.via).toBe("direct");
    expect(r.body).toBe(REAL_PAGE_HTML);
  });

  it("goes straight to direct with the flag off, without calling the service", async () => {
    process.env.PARTS_SCRAPLING_ADAPTERS = "off";
    const calls = mockNetwork({ direct: { status: 200, body: REAL_PAGE_HTML } });
    const r = await adapterFetch(TARGET);
    expect(calls).toEqual(["direct"]);
    expect(r.via).toBe("direct");
  });

  it("returns the body on a non-2xx so callers can classify the wall", async () => {
    process.env.PARTS_SCRAPLING_ADAPTERS = "off";
    mockNetwork({ direct: { status: 403, body: CHALLENGE_HTML } });
    const r = await adapterFetch(TARGET);
    expect(r.status).toBe(403);
    expect(r.body).toBe(CHALLENGE_HTML);
  });

  it("reports status 0 on a network error, or rethrows when asked", async () => {
    process.env.PARTS_SCRAPLING_ADAPTERS = "off";
    mockNetwork({ directThrows: true });
    expect(await adapterFetch(TARGET)).toEqual({ status: 0, body: "", via: "direct" });

    mockNetwork({ directThrows: true });
    await expect(adapterFetch(TARGET, { throwOnError: true })).rejects.toThrow();
  });
});
