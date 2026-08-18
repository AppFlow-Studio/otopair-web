import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  declaredLength,
  fetchMaybeProxied,
  isEgressBlockedHost,
  isEgressRefusal,
  planFetch,
  proxyTruncated,
  rangeTotal,
} from "../convex/vehicleEnrichment/egressProxy";

const ENV_KEYS = ["PARTS_EGRESS_PROXY", "SCRAPLING_URL", "SCRAPLING_TOKEN"] as const;

let snapshot: Record<string, string | undefined>;

beforeEach(() => {
  snapshot = {};
  for (const key of ENV_KEYS) {
    snapshot[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const saved = snapshot[key];
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const enableProxy = () => {
  process.env.PARTS_EGRESS_PROXY = "on";
  process.env.SCRAPLING_URL = "https://scraper.example.dev";
};

const UA = "test-agent";
const MANUAL_URL = "https://cdn.dealereprocess.org/cdn/servicemanuals/gmc/2019-sierra1500.pdf";

describe("isEgressBlockedHost", () => {
  it("matches the CDN that refuses Convex while serving everyone else", () => {
    expect(isEgressBlockedHost(MANUAL_URL)).toBe(true);
    expect(isEgressBlockedHost("https://sub.cdn.dealereprocess.org/x.pdf")).toBe(true);
  });

  it("does NOT match a genuine bot wall — proxying it buys the same 403", () => {
    expect(isEgressBlockedHost("https://www.volvocars.com/manual.pdf")).toBe(false);
  });

  it("does not match a lookalike host that merely contains the name", () => {
    expect(isEgressBlockedHost("https://cdn.dealereprocess.org.evil.com/x.pdf")).toBe(false);
    expect(isEgressBlockedHost("https://notdealereprocess.org/x.pdf")).toBe(false);
  });

  it("survives unparseable input", () => {
    expect(isEgressBlockedHost("not a url")).toBe(false);
  });
});

describe("isEgressRefusal", () => {
  it("covers only the statuses an IP-range block produces", () => {
    expect(isEgressRefusal(403)).toBe(true);
    expect(isEgressRefusal(429)).toBe(true);
  });

  it("leaves a missing document and an origin fault alone", () => {
    // A second opinion cannot make a 404 exist, and re-asking would double the
    // round trips on every dead constructed URL.
    for (const s of [200, 206, 404, 410, 500, 503]) expect(isEgressRefusal(s)).toBe(false);
  });
});

describe("planFetch", () => {
  it("is direct-only while the flag is dark, even for a known-blocked host", () => {
    process.env.SCRAPLING_URL = "https://scraper.example.dev";
    expect(planFetch(MANUAL_URL)).toBe("direct_only");
  });

  it("is direct-only when the flag is on but no service is configured", () => {
    process.env.PARTS_EGRESS_PROXY = "on";
    expect(planFetch(MANUAL_URL)).toBe("direct_only");
  });

  it("skips the guaranteed-wasted direct leg for a known-blocked host", () => {
    enableProxy();
    expect(planFetch(MANUAL_URL)).toBe("proxy_first");
  });

  it("keeps everything else direct-first, with the proxy as a rescue", () => {
    enableProxy();
    expect(planFetch("https://assets.sia.toyota.com/x.pdf")).toBe("direct_then_proxy");
  });
});

describe("response header readers", () => {
  const res = (headers: Record<string, string>) => new Response("", { headers });

  it("prefers upstream's declared length over the proxy's own body length", () => {
    // The proxy's content-length is what IT sent us (a 2 KB range slice); the
    // size floor needs the document's real size.
    expect(
      declaredLength(res({ "content-length": "2048", "x-upstream-content-length": "16519382" })),
    ).toBe(16519382);
  });

  it("prefers the Content-Range total over BOTH content-lengths on a 206", () => {
    // Live shape from cdn.dealereprocess.org: a ranged probe answers 206 with
    // content-length AND x-upstream-content-length both set to the 2048-byte
    // SLICE, while only the range total names the document. Trusting either
    // length here puts a real 7.9 MB manual under the 40 KB plausibility floor
    // and rejects it.
    expect(
      declaredLength(
        res({
          "content-length": "2048",
          "x-upstream-content-length": "2048",
          "content-range": "bytes 0-2047/7938015",
        }),
      ),
    ).toBe(7938015);
  });

  it("falls back to content-length on the direct tier", () => {
    expect(declaredLength(res({ "content-length": "16519382" }))).toBe(16519382);
    expect(declaredLength(res({}))).toBeNull();
    expect(declaredLength(res({ "content-length": "0" }))).toBeNull();
  });

  it("reads the document total out of a Content-Range", () => {
    expect(rangeTotal(res({ "content-range": "bytes 0-2047/16519382" }))).toBe(16519382);
    expect(rangeTotal(res({ "content-range": "bytes 0-2047/*" }))).toBeNull();
    expect(rangeTotal(res({}))).toBeNull();
  });

  it("reports proxy truncation, which is the only signal a prefix is not the whole file", () => {
    expect(proxyTruncated(res({ "x-proxy-truncated": "1" }))).toBe(true);
    expect(proxyTruncated(res({ "x-proxy-truncated": "0" }))).toBe(false);
    expect(proxyTruncated(res({}))).toBe(false);
  });
});

describe("fetchMaybeProxied", () => {
  /** A /fetch reply: HTTP 200 envelope carrying the target's real status. */
  const proxyReply = (upstream: number, body = "%PDF-1.7") =>
    new Response(body, {
      status: 200,
      headers: { "x-upstream-status": String(upstream), "content-type": "application/pdf" },
    });

  it("goes straight out when the flag is dark, and never calls the service", () => {
    const fetchMock = vi.fn(async () => new Response("%PDF-1.7", { status: 206 }));
    vi.stubGlobal("fetch", fetchMock);

    return fetchMaybeProxied(MANUAL_URL, UA).then((out) => {
      expect(out.via).toBe("direct");
      expect(out.status).toBe(206);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toBe(MANUAL_URL);
    });
  });

  it("reports the TARGET's status, not the proxy's 200 envelope", async () => {
    enableProxy();
    vi.stubGlobal("fetch", vi.fn(async () => proxyReply(403)));

    const out = await fetchMaybeProxied(MANUAL_URL, UA);
    // The regression this guards: `res.ok` is true here because the PROXY
    // answered fine. A caller branching on it would treat a refusal as a PDF.
    expect(out.res.ok).toBe(true);
    expect(out.status).toBe(403);
  });

  it("rescues a 403 from an unlisted host through the proxy", async () => {
    enableProxy();
    const url = "https://cdn.newvendor.example/2022-manual.pdf";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("<html>blocked</html>", { status: 403 }))
      .mockResolvedValueOnce(proxyReply(206));
    vi.stubGlobal("fetch", fetchMock);

    const out = await fetchMaybeProxied(url, UA);
    expect(out.via).toBe("proxy");
    expect(out.status).toBe(206);
    expect(out.directStatus).toBe(403);
    expect(String(fetchMock.mock.calls[1][0])).toBe("https://scraper.example.dev/fetch");
  });

  it("does not spend a proxy call on a 404", async () => {
    enableProxy();
    const fetchMock = vi.fn(async () => new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await fetchMaybeProxied("https://cdn.newvendor.example/x.pdf", UA);
    expect(out.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports a both-tiers refusal as the proxy's answer (the bot-wall case)", async () => {
    enableProxy();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 403 }))
      .mockResolvedValueOnce(proxyReply(403));
    vi.stubGlobal("fetch", fetchMock);

    const out = await fetchMaybeProxied("https://www.volvocars.com/manual.pdf", UA);
    expect(out.status).toBe(403);
    expect(out.directStatus).toBe(403);
  });

  it("falls back to direct when the service itself is down", async () => {
    enableProxy();
    const fetchMock = vi
      .fn()
      // proxy_first: the service errors...
      .mockResolvedValueOnce(new Response("nope", { status: 502 }))
      // ...so the direct leg still runs and reports honestly.
      .mockResolvedValueOnce(new Response("<html>", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await fetchMaybeProxied(MANUAL_URL, UA);
    expect(out.via).toBe("direct");
    expect(out.status).toBe(403);
  });

  it("treats a service with no upstream-status header as a miss", async () => {
    // An older /scrape-only deploy would answer 200 with an HTML body; reading
    // that as the document would hand the extractor a challenge page.
    enableProxy();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("<html>", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await fetchMaybeProxied(MANUAL_URL, UA);
    expect(out.via).toBe("direct");
  });

  it("passes Range and Referer through to the service", async () => {
    enableProxy();
    const fetchMock = vi.fn(async () => proxyReply(206));
    vi.stubGlobal("fetch", fetchMock);

    await fetchMaybeProxied(MANUAL_URL, UA, {
      range: "bytes=0-2047",
      referer: "https://cdn.dealereprocess.org/",
      maxBytes: 2048,
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body).toMatchObject({
      url: MANUAL_URL,
      range: "bytes=0-2047",
      referer: "https://cdn.dealereprocess.org/",
      max_bytes: 2048,
    });
  });
});
