/**
 * sourceAdapters/http.ts — the one place the source adapters reach the network.
 *
 * Before this, all eight adapters did a bare `fetch()` with their own private
 * copy of a Chrome User-Agent string. A spoofed UA does nothing about the TLS
 * handshake, which is what Cloudflare/Akamai/Imperva actually fingerprint
 * (JA3/JA4) — so from a Convex datacenter IP the adapters present as "a Chrome
 * that handshakes like Python". Routing them through the self-hosted Scrapling
 * service (see /scraper) gets curl_cffi TLS impersonation on the cheap tier and
 * a real headless browser on escalation.
 *
 * Two adapters carry more weight than the rest:
 *   - myCarUserManual is the ONLY route to BMW/Mercedes/VW/Audi, which publish
 *     no open PDFs, so the manual pipeline has no fallback if it gets walled.
 *   - amsoil is the corroborating source_family behind manualSpecs' owners_manual
 *     claims. Lose it and two-family 0.85 collapses to single-family 0.6, which
 *     is under the 0.75 quote gate — specs stop being quotable, silently.
 *
 * Off by default. Set PARTS_SCRAPLING_ADAPTERS="on" (plus SCRAPLING_URL) to
 * enable; a miss at any point falls through to the direct fetch, so behavior with
 * the flag unset — or the service down — is byte-for-byte what it was.
 *
 * This flag is deliberately SEPARATE from PARTS_SCRAPLING (which gates the price
 * path in firecrawl.ts): the adapter layer parses HTML structurally and is far
 * more sensitive to getting a different rendering than the price path is, so it
 * gets its own switch and its own rollback.
 */

import {
  looksBlockedBody,
  scraplingEnabled,
  scraplingFetchPage,
  type ScrapeMode,
} from "../scrapling";

export { looksBlockedBody };

/** Shared browser identity for the direct tier. Was duplicated in 8 adapters. */
export const ADAPTER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export const DEFAULT_ADAPTER_TIMEOUT_MS = 20_000;

export type AdapterFetchOutcome = {
  status: number;
  body: string;
  /** Which tier served this. Surfaced for logging and test assertions. */
  via: "scrapling" | "direct";
};

/**
 * Headers whose PRESENCE changes what the server returns, as opposed to headers
 * that merely describe the client.
 *
 * The deployed /scrape takes no header passthrough, so a request carrying any of
 * these must go direct or it silently becomes a different request — an
 * unauthenticated one, a cross-origin one, a non-XHR one. Browser-identity
 * headers (User-Agent, Accept, Accept-Language, Sec-Fetch-*, sec-ch-ua*,
 * Upgrade-Insecure-Requests) are NOT in this set on purpose: Scrapling generates
 * its own internally consistent set via stealthy_headers, and ours would
 * contradict its TLS fingerprint if they could even be sent.
 */
const SEMANTIC_HEADERS = new Set([
  "cookie",
  "authorization",
  "origin",
  "referer",
  "x-requested-with",
  "content-type",
]);

function carriesSemanticHeaders(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((k) => SEMANTIC_HEADERS.has(k.toLowerCase()));
}

export type AdapterFetchOptions = {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /**
   * "json" pins the request to the direct tier. The service HTML-parses whatever
   * it fetches and hands back `html`, which mangles a JSON body — so JSON
   * endpoints must never route through Scrapling regardless of the flag.
   */
  expects?: "html" | "json";
  mode?: ScrapeMode;
  /**
   * Re-throw network errors instead of reporting `{status: 0}`. Set true for the
   * adapters whose original helper had no try/catch, so a dead host keeps
   * unwinding to their entry-point handler exactly as it did before.
   */
  throwOnError?: boolean;
};

/** True when the adapter Scrapling tier is switched on AND configured. */
export function scraplingAdaptersEnabled(): boolean {
  return process.env.PARTS_SCRAPLING_ADAPTERS === "on" && scraplingEnabled();
}

/** Exported for tests: would this request be offered to Scrapling? */
export function isScraplingEligible(opts: AdapterFetchOptions = {}): boolean {
  if ((opts.expects ?? "html") !== "html") return false;
  if (carriesSemanticHeaders(opts.headers ?? {})) return false;
  return scraplingAdaptersEnabled();
}

/**
 * Fetch a page for an adapter. Scrapling first when eligible, direct fetch
 * otherwise — and direct fetch again on any Scrapling miss.
 */
export async function adapterFetch(
  url: string,
  opts: AdapterFetchOptions = {},
): Promise<AdapterFetchOutcome> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS;
  const headers = opts.headers ?? {};

  if (isScraplingEligible(opts)) {
    // scraplingFetchPage already rejects non-2xx/3xx, empty bodies and anti-bot
    // interstitials, so a non-null result here is a page we can actually parse.
    const s = await scraplingFetchPage(url, { mode: opts.mode, timeoutMs });
    if (s) return { status: s.status, body: s.body, via: "scrapling" };
    console.warn(`[adapterFetch] scrapling miss for ${url} — falling back to direct`);
  }

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": ADAPTER_USER_AGENT, ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Read the body even on a non-2xx: the anti-bot detectors need the challenge
    // page to classify it, and every caller here already gates on status.
    return { status: res.status, body: await res.text(), via: "direct" };
  } catch (e) {
    if (opts.throwOnError) throw e;
    return { status: 0, body: "", via: "direct" };
  }
}
