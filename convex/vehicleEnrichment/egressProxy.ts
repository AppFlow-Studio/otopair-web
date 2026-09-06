/**
 * vehicleEnrichment/egressProxy.ts — fetch bytes from hosts that refuse CONVEX,
 * by borrowing the scraper service's egress IP.
 *
 * THE FINDING THIS EXISTS FOR (Aug 13 2026)
 * -----------------------------------------
 * The manual pipeline logged `dealereprocess:http_403` for months and every
 * post-mortem read it as "that source is dead". It was not. Four of the exact
 * URLs that 403'd in our runs — the 2019 Sierra, 2021 CX-30, 2020 Grand Cherokee
 * and 2022 Palisade owner's manuals — return 206 + real PDF bytes from a
 * workstation. Probed from inside Convex with three header variants (bare, UA
 * only, UA + Accept + Accept-Language + Referer) every single one came back
 * Cloudflare 403 HTML. Same URL, same headers, different answer: it is an
 * IP-range block on Convex's egress.
 *
 * That reframes the coverage number. We claim 12 makes with a deterministic
 * manual path; 11 of them route through cdn.dealereprocess.org. Reachable
 * coverage was 3 — Toyota, Nissan, Hyundai — which is exactly the set that ever
 * produced results. The rounds that "got unlucky" were hitting a wall we were
 * logging and ignoring.
 *
 * WHY A PROXY AND NOT A HEADER FIX
 * --------------------------------
 * There is nothing to fix in the request. A spoofed User-Agent does not change
 * the TLS handshake, which is what Cloudflare fingerprints, and no header
 * variant moved the answer. The scraper service (/scraper) already runs
 * elsewhere on a different IP with curl_cffi TLS impersonation, so it is the
 * proxy — it just needed to stop HTML-parsing what it fetches. See its
 * POST /fetch, added alongside this file.
 *
 * NOT EVERY 403 IS THIS
 * ---------------------
 * volvocars.com answers 403 from Convex AND from a workstation. That is a
 * genuine bot wall, not an egress block, and routing it here will not help. The
 * two are only distinguishable by probing from both sides, which is why the
 * blocked-host list below is an evidence record rather than a list of hosts that
 * once failed. A host earns a place by 403ing from Convex while serving real
 * bytes somewhere else.
 *
 * SAFETY
 * ------
 * Dark by default: PARTS_EGRESS_PROXY="on" plus a configured SCRAPLING_URL. With
 * the flag unset — or the service down, or slow, or refusing — every path here
 * falls through to the direct fetch that runs today, so behavior is byte-for-byte
 * unchanged. A miss is never an exception.
 */

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Hosts proven to serve real bytes to the open internet while refusing Convex.
 *
 * Keep this list short and evidenced. A host that 403s from BOTH sides is a bot
 * wall (volvocars.com) and does not belong here — proxying it burns a round trip
 * to collect the same 403.
 */
export const EGRESS_BLOCKED_HOSTS: readonly string[] = [
  // 206 + application/pdf from a workstation on all four probed manual URLs;
  // Cloudflare 403 HTML from Convex on all three header variants (Aug 13 2026).
  // This one host is the manual path for 11 of our 12 deterministic makes.
  "cdn.dealereprocess.org",
];

/** www-stripped hostname, or null when the URL will not parse. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/** Is this URL on a host known to block Convex's egress specifically? */
export function isEgressBlockedHost(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  return EGRESS_BLOCKED_HOSTS.some((h) => host === h || host.endsWith("." + h));
}

/** True when the proxy is switched on AND a service URL is configured. */
export function egressProxyEnabled(): boolean {
  return process.env.PARTS_EGRESS_PROXY === "on" && !!process.env.SCRAPLING_URL;
}

/**
 * Statuses worth re-trying through the proxy.
 *
 * Only the two an IP-range block actually produces. A 404 means the document is
 * not there and a second opinion cannot change that; a 5xx is the origin's own
 * problem. Widening this would turn every dead URL into two round trips.
 */
export function isEgressRefusal(status: number): boolean {
  return status === 403 || status === 429;
}

export type FetchPlan = "direct_only" | "proxy_first" | "direct_then_proxy";

/**
 * What to try, in what order. Pure so the routing decision is testable without
 * a network.
 *
 * `direct_then_proxy` is the load-bearing one: it is what makes the NEXT
 * dealereprocess self-heal instead of sitting in the logs as a dead source for a
 * quarter. Known-blocked hosts skip straight to the proxy because their direct
 * leg is a guaranteed wasted round trip.
 */
export function planFetch(url: string): FetchPlan {
  if (!egressProxyEnabled()) return "direct_only";
  return isEgressBlockedHost(url) ? "proxy_first" : "direct_then_proxy";
}

export type FetchOutcome = {
  /**
   * The status of the TARGET host. For a proxied response this is read out of
   * `X-Upstream-Status`, NOT the proxy's own 200 — so callers must branch on
   * this and never on `res.ok`.
   */
  status: number;
  /** Live response. Read `.body`/`.arrayBuffer()` exactly as a direct fetch. */
  res: Response;
  via: "direct" | "proxy";
  /** The direct tier's status when it was tried first and refused. */
  directStatus: number | null;
};

export type ProxyFetchOptions = {
  timeoutMs?: number;
  /** Verbatim Range header — the probe path asks for the first 2 KB. */
  range?: string;
  accept?: string;
  referer?: string;
  /** Cap on buffered bytes. The service clamps this to its own ceiling. */
  maxBytes?: number;
};

/**
 * Size of the DOCUMENT, whichever tier served the response.
 *
 * Three headers can answer this and they do not agree, so the order is:
 *
 *   1. `Content-Range` total — the only one that is unambiguously the whole
 *      document. On a 206 both content-lengths are the SLICE (2048 on a probe),
 *      which is under the 40 KB plausibility floor, so preferring either of them
 *      would reject every manual we successfully ranged.
 *   2. `X-Upstream-Content-Length` — what the target declared, echoed by the
 *      proxy because the proxy's own content-length is only what it chose to
 *      hand back after capping.
 *   3. `Content-Length` — the direct tier's ordinary answer.
 */
export function declaredLength(res: Response): number | null {
  const total = rangeTotal(res);
  if (total !== null) return total;
  const raw =
    res.headers.get("x-upstream-content-length") ?? res.headers.get("content-length");
  const n = Number(raw ?? "");
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Did the proxy stop short of the whole document?
 *
 * MUST be checked before treating a proxied body as complete. The service caps
 * what it buffers, so an oversize PDF comes back as a VALID-LOOKING prefix —
 * right magic number, right content-type, wrong document — and the streaming
 * size guard downstream cannot see it, because the bytes were already truncated
 * before they arrived. A truncated manual is worse than no manual: it extracts.
 */
export function proxyTruncated(res: Response): boolean {
  return res.headers.get("x-proxy-truncated") === "1";
}

/** Total document size from a `Content-Range: bytes 0-2047/16519382` header. */
export function rangeTotal(res: Response): number | null {
  const cr = res.headers.get("content-range");
  const m = cr ? /\/(\d+)\s*$/.exec(cr) : null;
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** POST the URL to the scraper service's byte passthrough. Null on any miss. */
async function proxyFetch(
  url: string,
  opts: ProxyFetchOptions,
): Promise<{ status: number; res: Response } | null> {
  const base = process.env.SCRAPLING_URL?.replace(/\/+$/, "");
  if (!base) return null;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const res = await fetch(`${base}/fetch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.SCRAPLING_TOKEN
          ? { Authorization: `Bearer ${process.env.SCRAPLING_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({
        url,
        timeout_ms: timeoutMs,
        range: opts.range ?? null,
        accept: opts.accept ?? "*/*",
        referer: opts.referer ?? null,
        max_bytes: opts.maxBytes ?? 0,
      }),
      // The service has its own deadline; give it room to answer before we cut.
      signal: AbortSignal.timeout(timeoutMs + 10_000),
    });

    // The service's OWN failure (auth, transport, crash). Distinct from the
    // target refusing us, which arrives as a 200 carrying X-Upstream-Status.
    if (!res.ok) {
      console.warn(`[egress-proxy] service ${res.status} for ${url} — falling back`);
      return null;
    }

    const upstream = Number(res.headers.get("x-upstream-status") ?? "");
    // A response with no upstream status is not from the /fetch endpoint we
    // think we are talking to (an older deploy, or something else on that
    // host). Treat it as a miss rather than reading a body of unknown meaning.
    if (!Number.isFinite(upstream) || upstream <= 0) {
      console.warn(`[egress-proxy] no upstream status for ${url} — service too old?`);
      return null;
    }
    return { status: upstream, res };
  } catch (e) {
    console.warn(`[egress-proxy] transport error for ${url}:`, e);
    return null;
  }
}

/** One direct fetch, with the browser identity the caller asked for. */
async function directFetch(
  url: string,
  userAgent: string,
  opts: ProxyFetchOptions,
): Promise<Response> {
  const headers: Record<string, string> = {
    "User-Agent": userAgent,
    Accept: opts.accept ?? "*/*",
    "Accept-Language": "en-US,en;q=0.9",
  };
  if (opts.range) headers.Range = opts.range;
  if (opts.referer) headers.Referer = opts.referer;
  return fetch(url, {
    headers,
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
}

/**
 * Fetch a URL, routing around an egress block when there is one.
 *
 * Throws only what a direct fetch would throw, and only when the direct tier is
 * the one that failed — so a caller with an existing try/catch keeps its exact
 * behavior with the flag off.
 */
export async function fetchMaybeProxied(
  url: string,
  userAgent: string,
  opts: ProxyFetchOptions = {},
): Promise<FetchOutcome> {
  const plan = planFetch(url);

  if (plan === "proxy_first") {
    const p = await proxyFetch(url, opts);
    if (p) {
      console.log(`[egress-proxy] ${url} → upstream ${p.status} via proxy`);
      return { status: p.status, res: p.res, via: "proxy", directStatus: null };
    }
    // The service is down or unset. A known-blocked host will refuse us, but
    // failing here would be worse than trying: the block could have lifted, and
    // the direct leg is what reports honestly if it has not.
    console.warn(`[egress-proxy] proxy miss for ${url} — trying direct anyway`);
    const res = await directFetch(url, userAgent, opts);
    return { status: res.status, res, via: "direct", directStatus: null };
  }

  const res = await directFetch(url, userAgent, opts);
  if (plan === "direct_only" || !isEgressRefusal(res.status)) {
    return { status: res.status, res, via: "direct", directStatus: null };
  }

  // Direct was refused with the signature of an egress block. Second opinion.
  const p = await proxyFetch(url, opts);
  if (!p) return { status: res.status, res, via: "direct", directStatus: res.status };

  if (isEgressRefusal(p.status)) {
    // Refused from both sides — a real bot wall (the volvocars.com class), not
    // an egress block. Say so, because the distinction is the whole point.
    console.warn(
      `[egress-proxy] ${url} refused from BOTH tiers (direct ${res.status}, proxy ${p.status}) — bot wall, not an egress block`,
    );
  } else {
    console.log(
      `[egress-proxy] ${url} rescued: direct ${res.status} → proxy ${p.status}. ` +
        `Add its host to EGRESS_BLOCKED_HOSTS to skip the wasted direct leg.`,
    );
  }
  return { status: p.status, res: p.res, via: "proxy", directStatus: res.status };
}
