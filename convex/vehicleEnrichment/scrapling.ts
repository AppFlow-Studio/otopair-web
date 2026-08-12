/**
 * vehicleEnrichment/scrapling.ts — adapter to the self-hosted Scrapling scraper
 * (see /scraper). Mirrors firecrawl.ts `fetchUrl` / `fetchUrlWithHtml` so callers
 * can route to it, and NO-OPS (returns null) when SCRAPLING_URL is unset —
 * safe to import and call anywhere; the caller falls back to Firecrawl.
 *
 * Wire it in behind a flag (PARTS_SCRAPLING="on") so the default path is
 * unchanged until the service is stood up. Env:
 *   SCRAPLING_URL    base URL of the deployed service (no trailing slash needed)
 *   SCRAPLING_TOKEN  optional bearer token (must match the service's SCRAPLING_TOKEN)
 *
 * MISSES ARE `null`, NOT AN EMPTY STRING. Every public fetcher here returns null
 * for "we did not get the page", so a caller writing `if (r) return r` cannot
 * accidentally accept a Cloudflare interstitial. That distinction is the whole
 * point: an anti-bot challenge page is 2-5 KB of perfectly real HTML, well over
 * the service's own MIN_OK_CHARS floor, and the original wiring returned it as a
 * success — which silently skipped Firecrawl's stealth-proxy retry, the tier
 * most likely to have actually gotten the page.
 */

const DEFAULT_TIMEOUT_MS = 45_000;

export type ScrapeMode = "http" | "stealth" | "auto";

function serviceBase(): string | null {
  const base = process.env.SCRAPLING_URL;
  return base ? base.replace(/\/+$/, "") : null;
}

/** True when a Scrapling service URL is configured. */
export function scraplingEnabled(): boolean {
  return serviceBase() !== null;
}

/**
 * Anti-bot interstitial detection, shared with the adapter layer.
 *
 * Deliberately narrow — these are vendor internals (script names, challenge
 * tokens, exact title strings), not prose a real automotive page would contain.
 * A page that merely says "access denied" somewhere in its copy must NOT match,
 * because a false positive here throws away a page we successfully fetched.
 */
const BLOCK_SIGNATURES = [
  /_cf_chl_opt/i,
  /challenge-platform/i,
  /\bcf-chl-/i,
  /<title>\s*Just a moment/i,
  /Checking your browser before accessing/i,
  /Attention Required!\s*\|\s*Cloudflare/i,
  /DDoS protection by\s*Cloudflare/i,
  /_Incapsula_Resource/i,
  /PerimeterX|px-captcha/i,
  /Enable JavaScript and cookies to continue/i,
];

/** True when the body looks like an anti-bot challenge rather than the page. */
export function looksBlockedBody(body: string | null | undefined): boolean {
  if (!body) return false;
  // Challenge pages put their tell in the head; cap the scan so a long real
  // page cannot pay for this and cannot trip a late false positive.
  const head = body.slice(0, 4000);
  return BLOCK_SIGNATURES.some((re) => re.test(head));
}

type RawResult = {
  status: number;
  markdown: string | null;
  html: string | null;
  /** Service-side challenge verdict. Absent on older deploys — defaults false,
   *  and `usable` re-sniffs the body anyway, so the guard never depends on it. */
  blocked: boolean;
};

async function callScrapling(
  url: string,
  mode: ScrapeMode,
  formats: string[],
  timeoutMs: number,
): Promise<RawResult | null> {
  const base = serviceBase();
  if (!base) return null; // not configured — caller falls back to Firecrawl

  try {
    const response = await fetch(`${base}/scrape`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.SCRAPLING_TOKEN
          ? { Authorization: `Bearer ${process.env.SCRAPLING_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({ url, mode, formats, timeout_ms: timeoutMs }),
      // Give the service a little longer than its own page cap before we sever.
      signal: AbortSignal.timeout(timeoutMs + 5_000),
    });

    if (!response.ok) {
      console.error(
        `[scrapling] ${mode} scrape failed for ${url}: ${response.status} ${response.statusText}`,
      );
      return null;
    }

    const d = await response.json();
    return {
      status: typeof d?.status === "number" ? d.status : 200,
      markdown: (d?.markdown ?? null) as string | null,
      html: (d?.html ?? null) as string | null,
      blocked: d?.blocked === true,
    };
  } catch (error) {
    console.error(`[scrapling] ${mode} scrape error for ${url}:`, error);
    return null;
  }
}

/**
 * Reject anything that is not the page we asked for.
 *
 * The service reports the UPSTREAM status in its 200 envelope, so a 403 from the
 * target site arrives here as a successful HTTP call carrying a challenge body.
 * Both of those are misses, and both must fall through to Firecrawl.
 */
function usable(r: RawResult | null, url: string): RawResult | null {
  if (!r) return null;
  if (r.status >= 400) {
    console.warn(`[scrapling] upstream ${r.status} for ${url} — treating as a miss`);
    return null;
  }
  if (!r.html && !r.markdown) return null;
  if (r.blocked || looksBlockedBody(r.html) || looksBlockedBody(r.markdown)) {
    console.warn(`[scrapling] anti-bot interstitial for ${url} — treating as a miss`);
    return null;
  }
  return r;
}

/**
 * Markdown + HTML fetch — drop-in shape for firecrawl.fetchUrlWithHtml, except
 * that a miss is `null` rather than a pair of nulls.
 */
export async function scraplingFetchUrlWithHtml(
  url: string,
  opts: { mode?: ScrapeMode; timeoutMs?: number } = {},
): Promise<{ markdown: string | null; html: string | null } | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const r = usable(
    await callScrapling(url, opts.mode ?? "auto", ["markdown", "html"], timeoutMs),
    url,
  );
  return r ? { markdown: r.markdown, html: r.html } : null;
}

/**
 * Raw-HTML page fetch for the source-adapter layer, which parses HTML itself and
 * has no use for the markdown conversion. Returns null on any miss so the caller
 * can fall back to a direct fetch.
 */
export async function scraplingFetchPage(
  url: string,
  opts: { mode?: ScrapeMode; timeoutMs?: number } = {},
): Promise<{ status: number; body: string } | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const r = usable(
    await callScrapling(url, opts.mode ?? "auto", ["html"], timeoutMs),
    url,
  );
  if (!r?.html) return null;
  return { status: r.status, body: r.html };
}
