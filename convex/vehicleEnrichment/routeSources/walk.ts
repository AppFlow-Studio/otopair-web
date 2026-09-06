// =============================================================================
// routeSources/walk.ts — run a RouteSource's ladder and bring back text.
//
// Generalized out of sourceAdapters/myCarUserManual.ts, which walked exactly
// this shape against one host. Behaviour preserved rung for rung; what changed
// is that the grammar now lives in a manifest entry and the walk is shared.
//
// TWO THINGS THIS FILE IS CAREFUL ABOUT
// -------------------------------------
// 1. A 200 IS NOT A PAGE. The Scrapling work established the defect class: a
//    Cloudflare interstitial is 2–5 KB of 200-status HTML, so `if (html)` reads
//    a wall as a success. Every fetch here goes through `looksBlockedBody`, and
//    a source may additionally assert `looksLikeContent` — because a site
//    REDESIGN also returns a valid 200 that parses to nothing, and without an
//    assertion that is indistinguishable from an honest coverage gap.
//
// 2. GAP AND FAIL ARE NOT THE SAME OUTCOME. See the header in ./types.ts. The
//    walker never converts one into the other, and callers must not either:
//    a gap is cacheable for a long time, a fail is retryable.
//
// The walk fetches through `adapterFetch`, so it inherits the PR-48 Scrapling
// tiers (curl_cffi TLS impersonation, headless escalation) for free and needs
// no fetch logic of its own.
// =============================================================================

import { adapterFetch, looksBlockedBody } from "../sourceAdapters/http";
import type {
  RouteSource,
  RouteVars,
  RouteWalkContext,
  RouteWalkResult,
  RouteWalkSection,
} from "./types";
import type { AdapterVehicle } from "../sourceAdapters/types";

const FETCH_TIMEOUT_MS = 20_000;

/** Hard stop on rungs walked, independent of the manifest, so a manifest edit
 *  can never turn a walk into a crawl. */
const MAX_RUNGS = 6;

export type RoutePage = { status: number; body: string; blocked: boolean };

export type WalkDeps = {
  /** Injected so the whole ladder is testable against saved HTML. */
  fetchPage: (url: string, source: RouteSource) => Promise<RoutePage>;
  sleep: (ms: number) => Promise<void>;
};

export type WalkOptions = {
  /**
   * Replace the leaf's relevance scorer for this walk.
   *
   * A source's own `score` is tuned for the capacities and pressures the specs
   * contract asks for. A maintenance-schedule walk wants different chapters
   * from the same site, and the alternative — a second RouteSource per purpose
   * on one host — would be two voices in the ledger sharing an upstream, which
   * is precisely what the manifest's duplicate-host check forbids.
   */
  score?: (link: { slug: string; url: string }, ctx: RouteWalkContext) => number;
};

/**
 * Rank content links by relevance and take the top `limit`.
 *
 * Exported because a source may need to state the same selection as a single
 * testable function (myCarUserManual.pickSections does), and two copies of a
 * sort whose tiebreak matters is how determinism quietly stops holding. The
 * slug tiebreak is what makes a walk reproducible when two chapters score
 * equally.
 */
export function rankContentLinks<T extends { slug: string }>(
  links: readonly T[],
  score: (link: T) => number,
  limit: number,
): T[] {
  return links
    .map((link) => ({ link, score: score(link) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.link.slug.localeCompare(b.link.slug))
    .slice(0, limit)
    .map((s) => s.link);
}

/** Strip markup/boilerplate to readable text. Never throws.
 *  Lifted verbatim from myCarUserManual.htmlToText — same behaviour, one copy. */
export function htmlToText(html: string, cap: number): string {
  try {
    let s = html.replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, " ");
    s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n");
    s = s.replace(/<[^>]+>/g, " ");
    s = s
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;|&apos;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)));
    s = s
      .split("\n")
      .map((l) => l.replace(/[ \t]+/g, " ").trim())
      .filter((l) => l.length > 0)
      .join("\n");
    return s.slice(0, cap);
  } catch {
    return "";
  }
}

/** The default fetcher: adapterFetch + the anti-bot classifier. */
export async function defaultFetchPage(url: string, source: RouteSource): Promise<RoutePage> {
  const r = await adapterFetch(url, {
    headers: { Accept: "text/html,*/*" },
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  const ok = r.status >= 200 && r.status < 300;
  if (!ok) {
    // A REFUSAL IS NOT AN ABSENCE, and the status code alone does not tell you
    // which one you got. Verified live on mycarusermanual.com (Aug 13 2026):
    // Cloudflare serves its "Just a moment…" challenge with status 403 and a
    // ~5.5 KB body — so the wall arrives as a non-2xx, not as the 200-with-
    // interstitial the price path taught us to expect.
    //
    // 403 and 429 are refusals by definition; anything else is classified on
    // the body, which is why adapterFetch hands back a body on non-2xx at all.
    // Getting this wrong costs a coverage hole that looks like an honest gap:
    // `blocked` is what raises needs_headless and keeps the walk on the short
    // retry TTL instead of caching "this vehicle is not on the site" for 90
    // days.
    const blocked = r.status === 403 || r.status === 429 || looksBlockedBody(r.body);
    return { status: r.status, body: "", blocked };
  }

  // A 200 that is really a challenge page. Classified here rather than in each
  // rung's parser, because a parser that gets an interstitial reports "no links
  // found" — which the walker would otherwise record as an honest gap.
  if (looksBlockedBody(r.body)) return { status: r.status, body: "", blocked: true };

  // A source's own structural assertion. A redesign passes looksBlockedBody
  // and fails here, which is the difference between "retry later" and
  // "this vehicle is not on the site".
  if (source.looksLikeContent && !source.looksLikeContent(r.body)) {
    return { status: r.status, body: "", blocked: true };
  }

  return { status: r.status, body: r.body, blocked: false };
}

const defaultDeps: WalkDeps = {
  fetchPage: defaultFetchPage,
  sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
};

function gap(source: RouteSource, visited: string[], reason: string): RouteWalkResult {
  return { source: source.id, ok: true, sections: [], visited, reason };
}

function fail(
  source: RouteSource,
  visited: string[],
  reason: string,
  blocked = false,
): RouteWalkResult {
  return { source: source.id, ok: false, sections: [], visited, reason, blocked };
}

/**
 * Walk a source's ladder for one vehicle and return the content pages, cleaned.
 *
 * Never throws: a parser that throws is reported as `fail` with the rung named,
 * because an exception from a pure parser is a bug in the manifest entry and
 * should be legible as one rather than unwinding into the adapter's catch-all.
 */
export async function walkRouteSource(
  source: RouteSource,
  vehicle: AdapterVehicle,
  deps: Partial<WalkDeps> = {},
  opts: WalkOptions = {},
): Promise<RouteWalkResult> {
  const { fetchPage, sleep } = { ...defaultDeps, ...deps };
  const scoreLink = opts.score ?? source.leaf.score;
  const visited: string[] = [];

  // The license gate. Not a formality: this is the one place that decides a
  // host may be walked at all, and it is deliberately checked at run time as
  // well as at manifest-authoring time.
  if (
    source.license !== "public" &&
    source.license !== "licensed" &&
    source.license !== "attribution_required"
  ) {
    return fail(source, visited, `license not permitted: ${String(source.license)}`);
  }

  if (source.rungs.length > MAX_RUNGS) {
    return fail(source, visited, `ladder too deep: ${source.rungs.length} rungs`);
  }

  let url: string | null;
  try {
    url = source.entry(vehicle);
  } catch (e) {
    return fail(source, visited, `entry builder threw: ${errText(e)}`);
  }
  if (!url) return gap(source, visited, "no entry url for vehicle");

  let ctx: RouteWalkContext = { vehicle, vars: {} };

  // ── Rungs ────────────────────────────────────────────────────────
  for (const rung of source.rungs) {
    const page = await fetchPage(url, source);
    visited.push(url);
    if (page.blocked) return fail(source, visited, `${rung.name}: blocked`, true);
    if (page.status === 404) return gap(source, visited, `${rung.name}: 404`);
    if (page.status !== 200) return fail(source, visited, `${rung.name}: HTTP ${page.status}`);

    let outcome;
    try {
      outcome = rung.next(page.body, ctx);
    } catch (e) {
      return fail(source, visited, `${rung.name}: parser threw: ${errText(e)}`);
    }

    if (outcome.kind === "gap") return gap(source, visited, `${rung.name}: ${outcome.reason}`);
    if (outcome.kind === "fail") return fail(source, visited, `${rung.name}: ${outcome.reason}`);

    url = outcome.url;
    if (outcome.vars) ctx = { ...ctx, vars: mergeVars(ctx.vars, outcome.vars) };
    await sleep(source.crawlDelayMs);
  }

  // ── Leaf: list, score, fetch ─────────────────────────────────────
  const leafPage = await fetchPage(url, source);
  visited.push(url);
  if (leafPage.blocked) return fail(source, visited, `${source.leaf.name}: blocked`, true);
  if (leafPage.status === 404) return gap(source, visited, `${source.leaf.name}: 404`);
  if (leafPage.status !== 200) {
    return fail(source, visited, `${source.leaf.name}: HTTP ${leafPage.status}`);
  }

  let ranked: Array<{ slug: string; url: string }>;
  try {
    // Rank everything, collapse redundant pages, THEN apply the budget — a
    // parent page dropped by collapse should free its slot, not shrink the walk.
    const scored = rankContentLinks(
      source.leaf.candidates(leafPage.body, ctx),
      (link) => scoreLink(link, ctx),
      Number.MAX_SAFE_INTEGER,
    );
    const collapsed = source.leaf.collapse ? source.leaf.collapse(scored) : scored;
    ranked = collapsed.slice(0, source.leaf.maxPages);
  } catch (e) {
    return fail(source, visited, `${source.leaf.name}: leaf parser threw: ${errText(e)}`);
  }

  if (ranked.length === 0) return gap(source, visited, `${source.leaf.name}: no scoring content links`);

  // Sequential, not Promise.all: the crawl delay is the point. The previous
  // single-host implementation fired its chapters concurrently, which is fine
  // for four pages on one site and stops being fine the moment the manifest
  // has several sources and a larger maxPages.
  const sections: RouteWalkSection[] = [];
  for (const link of ranked) {
    const page = await fetchPage(link.url, source);
    visited.push(link.url);
    // One dead chapter is not a dead walk — the others still carry values.
    if (page.status !== 200 || page.blocked) continue;
    const text = htmlToText(page.body, source.maxContentChars);
    if (text.length < source.minContentChars) continue;
    sections.push({ slug: link.slug, url: link.url, text });
    await sleep(source.crawlDelayMs);
  }

  if (sections.length === 0) return gap(source, visited, "content pages fetched empty");

  return { source: source.id, ok: true, sections, visited };
}

function mergeVars(base: RouteVars, next: RouteVars): RouteVars {
  return { ...base, ...next };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
