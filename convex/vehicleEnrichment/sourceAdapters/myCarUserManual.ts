// =============================================================================
// sourceAdapters/myCarUserManual.ts — owner's-manual TEXT for ANY make.
//
// WHY THIS ADAPTER EXISTS
// -----------------------
// manualLibrary's whole pipeline is PDF-shaped: discover a PDF, upload it to
// the Files API, read it with a document block. That works beautifully for the
// makes that publish PDFs — and it is structurally incapable of reaching the
// ones that do not. Probing on Aug 5 2026 confirmed BMW, Mercedes, VW and Audi
// publish no open owner's-manual PDF at all: BMW is VIN-gated behind
// aos.bmwgroup.com, Mercedes serves an interactive viewer with zero .pdf
// hrefs, and VW/Audi are explicitly online-only. For those makes the PDF path
// does not degrade — it returns nothing, forever.
//
// mycarusermanual.com republishes the manufacturers' own manual TEXT as
// chapterised HTML, and it covers them. It is not German-specific: the same
// grammar serves Toyota, Kia, Hyundai and the rest, so this adapter is make-
// agnostic and simply attests whatever the site has. It is a genuine
// second family for every vehicle, not just a gap-filler for four brands.
//
// PROVENANCE: family `aggregator`, never `owners_manual`.
// The text originates with the manufacturer, but this is a third-party
// transcription on a third-party host — the same discipline manualLibrary
// applies to mirrors. It corroborates; it never speaks with OEM authority.
//
// ============================================================================
// WHAT THIS FILE IS NOW
// ============================================================================
// It used to own its own ladder walk, extraction prompt and claim assembly —
// ~570 lines, none of which were specific to this host except the grammar
// below. That engine now lives in routeSources/ and this file is the site's
// GRAMMAR plus a manifest entry. Everything verified live on Aug 5 2026 is
// preserved rule for rule; three things changed:
//
//   - Claims cite the chapter their quote was actually found on. The old code
//     stamped every claim with `usable[0]`'s URL, so a tyre-pressure value
//     cited the oil chapter (see routeSources/assemble.ts).
//   - A quote that cannot be found in the fetched text drops the value.
//   - Chapters are fetched sequentially with a crawl delay, not all at once.
//
// ============================================================================
// SITE GRAMMAR (walked live 2026-08-05 — every hop verified)
// ============================================================================
//   /{make}                                   → 200; lists model links
//   /{make}/{model}                           → lists /{body}/{start}-{end}
//   /{make}/{model}/{body}/{start}-{end}      → generation page; links sections
//   /{make}/{model}/{body}/{YEAR}/{section}   → the manual text
//
// Two traps that shaped the design:
//
//   1. SECTIONS ARE YEAR-SCOPED, NOT RANGE-SCOPED. The generation page lives
//      at `/4-door/2019-2025` but links its chapters at `/4-door/2022/…`. A
//      naive `${range}/${section}` URL is a 404.
//   2. THE SECTION TAXONOMY IS THE MANUFACTURER'S OWN. BMW files oil under
//      `mobility--engine-oil`; Mercedes uses `maintenance-and-care`. There is
//      no shared vocabulary, so sections are DISCOVERED from the generation
//      page and scored, never hardcoded. That is what makes this work for a
//      make nobody has looked at yet.
//
// Make slugs are mostly the plain lowercase make, with a short alias table for
// the ones that differ (`mercedes-benz` → `mercedes`, `volkswagen` → `vw` —
// both verified: the un-aliased forms 404).
// =============================================================================

import type {
  RouteContentLink,
  RouteSource,
  RouteWalkContext,
  RungOutcome,
} from "../routeSources/types";
import { htmlToText as walkHtmlToText, rankContentLinks } from "../routeSources/walk";
import { parseRouteExtraction, type ExtractedSpecRow } from "../routeSources/ingest";
import { routeAdapterFor } from "./routeIngestor";
import { SPEC_FIELD_KEYS } from "../manualSpecs";
import type { SourceAdapter } from "./types";

const ADAPTER_NAME = "mycarusermanual";
const HOST = "www.mycarusermanual.com";
const BASE = `https://${HOST}`;

/** Sections fetched per vehicle. Each is ~100-200 KB of HTML, and the
 *  extraction prompt has to hold their text, so this is the main cost dial. */
const MAX_SECTIONS = 4;
/** Cleaned text kept per section — enough for a full chapter, bounded so a
 *  pathological page cannot blow the extraction context. */
const MAX_SECTION_CHARS = 24_000;
/** Below this a chapter fetched fine but carries no readable body. */
const MIN_SECTION_CHARS = 500;

/** This adapter can attest the same contract manualSpecs defines, so a claim
 *  from here clusters against a manual-PDF claim on identical field keys. */
export const MYCARUSERMANUAL_FIELDS: readonly string[] = SPEC_FIELD_KEYS;

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers — string in, structures out, NEVER throw.
// ─────────────────────────────────────────────────────────────────────────────

/** Uppercase alphanumerics only: "F-150" ≡ "F150", "3 Series" ≡ "3SERIES". */
export function normName(s: string): string {
  return (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Make → site slug.
 *
 * Verified: the site uses `mercedes` (not mercedes-benz) and `vw` (not
 * volkswagen); both un-aliased forms return 404. Everything else falls through
 * to the plain hyphenated lowercase make, which is what the site uses for the
 * long tail (`land-rover`, `alfa-romeo`).
 */
export const MAKE_SLUG_ALIASES: Readonly<Record<string, string>> = {
  "mercedes-benz": "mercedes",
  "mercedes benz": "mercedes",
  mercedesbenz: "mercedes",
  volkswagen: "vw",
  "land rover": "land-rover",
  "alfa romeo": "alfa-romeo",
  chevy: "chevrolet",
};

export function makeSlug(make: string): string {
  const raw = (make ?? "").trim().toLowerCase();
  if (!raw) return "";
  const alias = MAKE_SLUG_ALIASES[raw];
  if (alias) return alias;
  return raw.replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/** Absolute hrefs on this host, deduped, in document order. */
export function extractHrefs(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /href="(https:\/\/www\.mycarusermanual\.com\/[^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const url = m[1];
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/**
 * Model links on a make page: exactly `/{make}/{model}` — one path segment
 * past the make, so the make's own link and deeper generation links are both
 * excluded.
 */
export function parseModelLinks(html: string, mkSlug: string): Array<{ slug: string; url: string }> {
  const out: Array<{ slug: string; url: string }> = [];
  const seen = new Set<string>();
  for (const url of extractHrefs(html)) {
    const m = new RegExp(`^${BASE}/${mkSlug}/([^/?#]+)/?$`).exec(url);
    if (!m) continue;
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push({ slug, url: `${BASE}/${mkSlug}/${slug}` });
  }
  return out;
}

/** Drop the family suffix the site appends: "glc-class" → "glc",
 *  "3-series" → "3". Verified: Mercedes lists ONLY a/c/e/glc-class, so a
 *  config model of "GLC 300" can never match without this. */
export function stripFamilySuffix(slug: string): string {
  return (slug ?? "").replace(/-(class|classe|series|serie)$/i, "");
}

/**
 * Pick the model whose slug best matches the config's model name.
 *
 * Three tiers, strictest first. The last one is the interesting case: the site
 * names a FAMILY ("glc-class") where a config names a VARIANT ("GLC 300"), so
 * a family slug matches when the config model starts with it AND everything
 * left over is just the trim number.
 *
 * That trailing-digits rule is what keeps the tier safe. Without it "CX5"
 * would match a "c-class" family slug on its leading "C" — with it, the
 * leftover "X5" contains a letter and is rejected. A wrong model here would
 * put another vehicle's capacities into the ledger, so the tier fails closed.
 */
export function pickModel(
  models: ReadonlyArray<{ slug: string; url: string }>,
  model: string,
): { slug: string; url: string } | null {
  const want = normName(model);
  if (!want || models.length === 0) return null;

  // 1. Exact: "3 Series" ≡ "3-series".
  const exact = models.find((m) => normName(m.slug) === want);
  if (exact) return exact;

  // 2. Exact against the family-stripped slug: "GLC" ≡ "glc-class".
  const stripped = models.find((m) => normName(stripFamilySuffix(m.slug)) === want);
  if (stripped) return stripped;

  // 3. Family + trim number: "GLC 300" → "glc-class", "A 220" → "a-class".
  const familyMatches = models
    .map((m) => ({ m, base: normName(stripFamilySuffix(m.slug)) }))
    .filter(({ base }) => {
      if (base.length === 0 || !want.startsWith(base)) return false;
      const rest = want.slice(base.length);
      // Nothing left = handled above. A remainder with any letter is a
      // different model, not a trim of this one.
      return rest.length > 0 && /^[0-9]+$/.test(rest);
    });
  if (familyMatches.length > 0) {
    // Longest base wins — "GLC" beats a hypothetical "G" for "GLC 300".
    return [...familyMatches].sort((a, b) => b.base.length - a.base.length)[0].m;
  }

  // 4. Config carries extra words the site does not ("Camry Hybrid" → "camry").
  const prefix = models.filter((m) => {
    const base = normName(m.slug);
    return base.length >= 3 && want.startsWith(base);
  });
  if (prefix.length > 0) {
    return [...prefix].sort((a, b) => normName(b.slug).length - normName(a.slug).length)[0];
  }

  return null;
}

export type Generation = { body: string; start: number; end: number; url: string };

/**
 * Generation links: `/{make}/{model}/{body}/{start}-{end}` OR
 * `/{make}/{model}/{body}/{year}`.
 *
 * The single-year form is real and not rare — verified live, Audi publishes
 * the Q5 as `/audi/q5/suv/2020`. Requiring a range silently returned zero
 * generations for every entry shaped that way, which reads identically to "the
 * site doesn't have this vehicle" and is the worst kind of bug: a coverage hole
 * that looks like an honest gap. A single year is modelled as a range of one.
 */
export function parseGenerationLinks(
  html: string,
  mkSlug: string,
  modelSlug: string,
): Generation[] {
  const out: Generation[] = [];
  const seen = new Set<string>();
  const re = new RegExp(`^${BASE}/${mkSlug}/${modelSlug}/([^/?#]+)/(\\d{4})(?:-(\\d{4}))?/?$`);
  for (const url of extractHrefs(html)) {
    const m = re.exec(url);
    if (!m) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const start = Number(m[2]);
    const end = m[3] ? Number(m[3]) : start;
    if (end < start) continue; // nonsense range — skip rather than invert
    out.push({ body: m[1], start, end, url });
  }
  return out;
}

/**
 * The generation covering this year.
 *
 * Ranges are inclusive on both ends and the site's ranges can overlap at the
 * boundary (a 2013-2019 and a 2019-2025 both claim 2019). The narrower range
 * wins that tie: a boundary year is almost always the first year of the new
 * generation in the site's own numbering, and the narrower span is the more
 * specific claim.
 */
export function pickGeneration(gens: readonly Generation[], year: number): Generation | null {
  const covering = gens.filter((g) => year >= g.start && year <= g.end);
  if (covering.length === 0) return null;
  return [...covering].sort(
    (a, b) => a.end - a.start - (b.end - b.start) || b.start - a.start,
  )[0];
}

export type SectionLink = {
  /** The path segment the chapters hang off: "2022" or "2016-2021". */
  yearKey: string;
  /** Numeric year for proximity ranking — the range's START when it is one. */
  year: number;
  slug: string;
  url: string;
};

/**
 * Section links off a generation page.
 *
 * BOTH forms exist on this site and the choice is per-entry, not per-make —
 * verified live: BMW 3 Series hangs its chapters off a single YEAR
 * (`/4-door/2022/mobility--engine-oil`) while Honda CR-V hangs them off the
 * RANGE (`/suv/2016-2021/controls`). Matching only one form silently returned
 * zero sections for half the fleet, so this accepts either and records which
 * it saw.
 */
export function parseSectionLinks(
  html: string,
  mkSlug: string,
  modelSlug: string,
  body: string,
): SectionLink[] {
  const out: SectionLink[] = [];
  const seen = new Set<string>();
  const re = new RegExp(
    `^${BASE}/${mkSlug}/${modelSlug}/${body}/(\\d{4}(?:-\\d{4})?)/([^/?#]+)/?$`,
  );
  for (const url of extractHrefs(html)) {
    const m = re.exec(url);
    if (!m) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const yearKey = m[1];
    out.push({ yearKey, year: Number(yearKey.slice(0, 4)), slug: m[2], url });
  }
  return out;
}

/**
 * Section relevance for SPEC extraction.
 *
 * Manufacturer taxonomies share no vocabulary, so this scores on the words
 * that actually appear in chapter slugs across the manuals inspected: BMW
 * ("mobility--engine-oil", "mobility--wheels-and-tires"), Mercedes
 * ("maintenance-and-care"), and the generic "technical-data"/"specifications"
 * that most others use. Unmatched sections score 0 and are never fetched.
 */
export const SECTION_KEYWORDS: ReadonlyArray<{ re: RegExp; score: number }> = [
  { re: /technical-?data|specification|capacit/i, score: 10 },
  { re: /engine-?oil|\boil\b/i, score: 8 },
  { re: /wheels?-?and-?t[iy]res?/i, score: 7 },
  { re: /maintenance|service/i, score: 6 },
  { re: /coolant|fluid/i, score: 6 },
];

/**
 * Chapters that match a keyword but carry no specifications.
 *
 * Both were caught on the first live walk (Aug 13 2026, 2021 Honda CR-V): a
 * bare `/tire/` rule scored `handling-the-unexpected--if-a-tire-goes-flat` at 7
 * and a `/care/` rule scored `maintenance--remote-transmitter-care` at 2, so
 * 15 KB of jack-and-spare and key-fob-battery text went into the specs context
 * ahead of nothing useful. The bare alternations are gone from the rules above;
 * this is the belt to that braces, because "tire" and "care" are exactly the
 * words a legitimate chapter name also uses.
 */
export const SECTION_EXCLUSIONS: ReadonlyArray<RegExp> = [
  /goes-flat|flat-tire|spare-?wheel|puncture|jack/i,
  /remote-?transmitter|key-?fob|transmitter-?care/i,
  /breakdown|roadside|emergency|towing/i,
];

export function scoreSection(slug: string): number {
  if (SECTION_EXCLUSIONS.some((re) => re.test(slug))) return 0;
  let score = 0;
  for (const k of SECTION_KEYWORDS) if (k.re.test(slug)) score += k.score;
  return score;
}

/**
 * Narrow section links to the ONE key the generation page actually publishes
 * under, closest to the model year.
 *
 * A generation page hangs its chapters off a single key — either a year or the
 * range — so this groups by that key and takes the nearest rather than assuming
 * which form we are looking at. Scoring and the fetch limit are the walker's
 * job; this is only the year decision.
 */
export function sectionsForBestYearKey(
  links: readonly SectionLink[],
  year: number,
): SectionLink[] {
  if (links.length === 0) return [];
  const keys = [...new Set(links.map((l) => l.yearKey))];
  const bestKey = keys.sort((a, b) => {
    const ya = Number(a.slice(0, 4));
    const yb = Number(b.slice(0, 4));
    return Math.abs(ya - year) - Math.abs(yb - year) || yb - ya;
  })[0];
  return links.filter((l) => l.yearKey === bestKey);
}

/**
 * Choose which sections to fetch: the published key nearest our year, scored,
 * best first, capped.
 *
 * This is the composed form of what the walker does generically — leaf
 * `candidates` narrows the year key, leaf `score` ranks, and the walker applies
 * the limit through the same `rankContentLinks`. Kept as one function because
 * the selection rule is the site's own and is locked by tests as a unit; the
 * shared ranker is what keeps it from being a second copy of the sort.
 */
export function pickSections(
  links: readonly SectionLink[],
  year: number,
  limit: number = MAX_SECTIONS,
): SectionLink[] {
  return rankContentLinks(sectionsForBestYearKey(links, year), (l) => scoreSection(l.slug), limit);
}

/**
 * Strip markup/boilerplate to readable text.
 *
 * The implementation moved to routeSources/walk.ts when the walk was
 * generalized; this keeps the source's own entry point (and its default cap)
 * so the site's tests exercise the same code the walker runs.
 */
export function htmlToText(html: string, cap: number = MAX_SECTION_CHARS): string {
  return walkHtmlToText(html, cap);
}

/**
 * Parse the extractor's JSON into claims-ready rows, failing closed per row.
 *
 * Thin over routeSources/ingest.parseRouteExtraction, which additionally
 * reports WHY each row was dropped. The array shape is preserved here because
 * that is what this adapter's contract has always been.
 */
export function parseExtraction(parsed: unknown): ExtractedSpecRow[] {
  return parseRouteExtraction(parsed).rows;
}

/**
 * Drop a chapter that republishes one we are already fetching.
 *
 * This site encodes hierarchy in the slug with a `--` separator: `maintenance`
 * is the parent of `maintenance--before-performing-maintenance`, and the parent
 * page contains its children's text.
 *
 * Fetching both is worse than wasteful. Verified live on the 2021 CR-V (Aug 13
 * 2026): the walk took `maintenance` (truncated at the 24 KB cap) and
 * `maintenance--before-performing-maintenance` (also 24 KB), every quote then
 * existed in two sections, and the citation index refused to place ANY of them
 * — four good fetches, zero claims. Keeping only the specific chapters also
 * avoids spending the cap on a page that is mostly duplicate.
 *
 * Order is preserved, so the ranking above still decides which chapters win.
 */
export function collapseParentChapters<T extends { slug: string }>(links: readonly T[]): T[] {
  return links.filter(
    (candidate) => !links.some((other) => other.slug.startsWith(`${candidate.slug}--`)),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The manifest entry: the grammar above, expressed as a ladder.
// ─────────────────────────────────────────────────────────────────────────────

export const mycarusermanualSource: RouteSource = {
  id: ADAPTER_NAME,
  host: HOST,
  family: "aggregator",
  // A third-party transcription, not the manufacturer's own host. This is what
  // keeps routeIntervalProvenance from ever handing it an OEM-tier stamp.
  tier: "redistributor",
  license: "public",
  crawlDelayMs: 500,
  minContentChars: MIN_SECTION_CHARS,
  maxContentChars: MAX_SECTION_CHARS,

  entry: (vehicle) => {
    const mk = makeSlug(vehicle.make);
    return mk ? `${BASE}/${mk}` : null;
  },

  // Every page on this site links back to itself absolutely. A response that
  // never names the host is a wall, a redirect, or a redesign that broke
  // extractHrefs — none of which should be recorded as "vehicle not on site".
  looksLikeContent: (html) => html.includes("mycarusermanual.com"),

  rungs: [
    {
      name: "make page",
      next: (html, ctx: RouteWalkContext): RungOutcome => {
        const mkSlug = makeSlug(ctx.vehicle.make);
        const models = parseModelLinks(html, mkSlug);
        const model = pickModel(models, ctx.vehicle.model);
        if (!model) {
          return {
            kind: "gap",
            reason: `model "${ctx.vehicle.model}" not found among ${models.length} listed`,
          };
        }
        return { kind: "advance", url: model.url, vars: { mkSlug, modelSlug: model.slug } };
      },
    },
    {
      name: "model page",
      next: (html, ctx: RouteWalkContext): RungOutcome => {
        const { mkSlug, modelSlug } = ctx.vars;
        const gens = parseGenerationLinks(html, mkSlug, modelSlug);
        const gen = pickGeneration(gens, ctx.vehicle.year);
        // A model the site has but not for our year is an honest gap, not a
        // failure — and emitting from the wrong generation would be far worse.
        if (!gen) {
          return {
            kind: "gap",
            reason: `no generation covering ${ctx.vehicle.year} (have ${gens.length})`,
          };
        }
        return { kind: "advance", url: gen.url, vars: { body: gen.body } };
      },
    },
  ],

  leaf: {
    name: "generation page",
    maxPages: MAX_SECTIONS,
    candidates: (html, ctx): RouteContentLink[] => {
      const { mkSlug, modelSlug, body } = ctx.vars;
      const links = parseSectionLinks(html, mkSlug, modelSlug, body);
      return sectionsForBestYearKey(links, ctx.vehicle.year).map((l) => ({
        slug: l.slug,
        url: l.url,
      }));
    },
    score: (link) => scoreSection(link.slug),
    collapse: collapseParentChapters,
  },
};

export const myCarUserManualAdapter: SourceAdapter = routeAdapterFor(
  mycarusermanualSource,
  MYCARUSERMANUAL_FIELDS,
);
