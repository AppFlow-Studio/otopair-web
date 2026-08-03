/**
 * vehicleEnrichment/scrapling.ts — adapter to the self-hosted Scrapling scraper
 * (see /scraper). Mirrors firecrawl.ts `fetchUrl` / `fetchUrlWithHtml` so callers
 * can route to it, and NO-OPS (returns null / empty) when SCRAPLING_URL is unset
 * — safe to import and call anywhere; the caller falls back to Firecrawl.
 *
 * Wire it in behind a flag (PARTS_SCRAPLING="on") so the default path is
 * unchanged until the service is stood up. Env:
 *   SCRAPLING_URL    base URL of the deployed service (no trailing slash needed)
 *   SCRAPLING_TOKEN  optional bearer token (must match the service's SCRAPLING_TOKEN)
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

async function callScrapling(
  url: string,
  mode: ScrapeMode,
  formats: string[],
  timeoutMs: number,
): Promise<{ status: number; markdown: string | null; html: string | null } | null> {
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
    };
  } catch (error) {
    console.error(`[scrapling] ${mode} scrape error for ${url}:`, error);
    return null;
  }
}

/** Markdown-only single-URL fetch — drop-in shape for firecrawl.fetchUrl. */
export async function scraplingFetchUrl(
  url: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string | null> {
  const r = await callScrapling(url, "http", ["markdown"], timeoutMs);
  return r?.markdown ?? null;
}

/** Markdown + HTML fetch — drop-in shape for firecrawl.fetchUrlWithHtml. */
export async function scraplingFetchUrlWithHtml(
  url: string,
  opts: { mode?: ScrapeMode; timeoutMs?: number } = {},
): Promise<{ markdown: string | null; html: string | null }> {
  const r = await callScrapling(
    url,
    opts.mode ?? "auto",
    ["markdown", "html"],
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  return { markdown: r?.markdown ?? null, html: r?.html ?? null };
}
