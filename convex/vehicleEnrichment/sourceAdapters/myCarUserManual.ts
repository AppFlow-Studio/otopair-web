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
  AdapterResult,
  AdapterVehicle,
  Claim,
  SourceAdapter,
} from "./types";
import { callClaudeExtractOnly } from "../utils/claudeClient";
import { normalizeSpecValue, SPEC_FIELDS, SPEC_FIELD_KEYS } from "../manualSpecs";
import { adapterFetch } from "./http";

const ADAPTER_NAME = "mycarusermanual";
const HOST = "www.mycarusermanual.com";
const BASE = `https://${HOST}`;

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 20_000;

/** Sections fetched per vehicle. Each is ~100-200 KB of HTML, and the
 *  extraction prompt has to hold their text, so this is the main cost dial. */
const MAX_SECTIONS = 4;
/** Cleaned text kept per section — enough for a full chapter, bounded so a
 *  pathological page cannot blow the extraction context. */
const MAX_SECTION_CHARS = 24_000;

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
  { re: /wheels?-?and-?tires?|wheels?-?and-?tyres?|tire|tyre/i, score: 7 },
  { re: /maintenance|service/i, score: 6 },
  { re: /coolant|fluid/i, score: 6 },
  { re: /care|mobility/i, score: 2 },
];

export function scoreSection(slug: string): number {
  let score = 0;
  for (const k of SECTION_KEYWORDS) if (k.re.test(slug)) score += k.score;
  return score;
}

/**
 * Choose which sections to fetch.
 *
 * Prefers the exact model year, then the nearest year the site actually
 * published (a generation page only links ONE year's chapters, and it is not
 * always the year we want). Scored sections only, best first.
 */
export function pickSections(
  links: readonly SectionLink[],
  year: number,
  limit: number = MAX_SECTIONS,
): SectionLink[] {
  if (links.length === 0) return [];

  // A generation page publishes chapters under ONE key — either a single year
  // or the range — so group by that key and take the closest to our year
  // rather than assuming which form we are looking at.
  const keys = [...new Set(links.map((l) => l.yearKey))];
  const bestKey = keys.sort((a, b) => {
    const ya = Number(a.slice(0, 4));
    const yb = Number(b.slice(0, 4));
    return Math.abs(ya - year) - Math.abs(yb - year) || yb - ya;
  })[0];

  return links
    .filter((l) => l.yearKey === bestKey)
    .map((l) => ({ link: l, score: scoreSection(l.slug) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.link.slug.localeCompare(b.link.slug))
    .slice(0, limit)
    .map((s) => s.link);
}

/** Strip markup/boilerplate to readable text. Never throws. */
export function htmlToText(html: string, cap: number = MAX_SECTION_CHARS): string {
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

/** Build the extraction prompt from the shared SPEC_FIELDS contract. */
export function buildExtractionPrompt(
  vehicle: { year: number; make: string; model: string },
  sections: ReadonlyArray<{ slug: string; text: string }>,
): string {
  const fieldLines = SPEC_FIELDS.map((f) => `- ${f.key} (${f.unit}): ${f.hint}`);
  const body = sections.map((s) => `### SECTION: ${s.slug}\n${s.text}`).join("\n\n");
  return [
    `Below are chapters from the owner's manual for the ${vehicle.year} ${vehicle.make} ${vehicle.model}, republished as text.`,
    "",
    "Extract these specifications:",
    ...fieldLines,
    "",
    "Rules:",
    "1. Report ONLY values stated in the text below. Never infer, convert from a similar model, or fill from general knowledge. Omit anything absent.",
    "2. Every value needs `quoted_text`: a verbatim span from the text stating it. No quote, no value.",
    "3. Capacities marked (qts) must be US quarts; pressures psi; torque ft-lbs; wiper lengths inches. Put the bare number in `value`.",
    "4. Engine oil capacity = DRAIN AND REFILL WITH FILTER, not dry fill. Transmission = drain-and-fill service quantity, not total.",
    "5. If a value is split by engine or trim, copy that row's label verbatim into `engine_qualifier`; if you cannot tell which applies, omit the field.",
    "6. Omit anything the vehicle does not have. An absent field is a correct answer; a zero is not.",
    "",
    'Respond with ONLY a JSON object: {"specs":[{"field_key":"...","value":...,"unit_as_printed":"...","engine_qualifier":null,"quoted_text":"..."}]}',
    "",
    body,
  ].join("\n");
}

/** Parse the model's JSON into claims-ready rows. Fails closed per row. */
export function parseExtraction(
  parsed: unknown,
): Array<{ field_key: string; value: string; value_raw: string; quoted_text: string }> {
  const rows = (parsed as any)?.specs;
  if (!Array.isArray(rows)) return [];
  const out: Array<{ field_key: string; value: string; value_raw: string; quoted_text: string }> = [];
  const seen = new Set<string>();

  for (const raw of rows) {
    const key = typeof raw?.field_key === "string" ? raw.field_key.trim() : "";
    if (!SPEC_FIELD_KEYS.includes(key) || seen.has(key)) continue;

    const value = normalizeSpecValue(key, raw?.value);
    if (value == null) continue;

    const quoted =
      typeof raw?.quoted_text === "string" && raw.quoted_text.trim().length > 0
        ? raw.quoted_text.trim().slice(0, 600)
        : null;
    // Same rule as the PDF path: an unquotable value is not evidence.
    if (!quoted) continue;

    const printed = typeof raw?.unit_as_printed === "string" ? raw.unit_as_printed.trim().slice(0, 40) : "";
    const rawVal =
      typeof raw?.value === "number" || typeof raw?.value === "string" ? String(raw.value) : value;

    seen.add(key);
    out.push({
      field_key: key,
      value,
      value_raw: printed ? `${rawVal} ${printed}`.trim() : rawVal,
      quoted_text: quoted,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Network.
// ─────────────────────────────────────────────────────────────────────────────

type Page = { status: number; body: string };

async function fetchPage(url: string): Promise<Page> {
  const r = await adapterFetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" },
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  // Unchanged contract: a non-2xx hands back an empty body, so every parser
  // downstream keeps reading "not ok" as "nothing here". adapterFetch swallows
  // network errors into status 0, matching the try/catch this replaced.
  const ok = r.status >= 200 && r.status < 300;
  return { status: r.status, body: ok ? r.body : "" };
}

function fail(error: string): AdapterResult {
  return { adapter: ADAPTER_NAME, ok: false, claims: [], error };
}

/** Ran fine, found nothing to claim — a normal, non-error outcome. */
function empty(note: string): AdapterResult {
  return { adapter: ADAPTER_NAME, ok: true, claims: [], error: note };
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter.
// ─────────────────────────────────────────────────────────────────────────────

async function lookupMyCarUserManual(vehicle: AdapterVehicle): Promise<AdapterResult> {
  try {
    const mkSlug = makeSlug(vehicle.make);
    if (!mkSlug) return empty("no make slug");

    // 1) Make page → model links.
    const makePage = await fetchPage(`${BASE}/${mkSlug}`);
    if (makePage.status === 404) return empty(`make "${vehicle.make}" not on site`);
    if (makePage.status !== 200) return fail(`make page HTTP ${makePage.status}`);

    const models = parseModelLinks(makePage.body, mkSlug);
    const model = pickModel(models, vehicle.model);
    if (!model) return empty(`model "${vehicle.model}" not found among ${models.length} listed`);

    // 2) Model page → generations.
    const modelPage = await fetchPage(model.url);
    if (modelPage.status !== 200) return fail(`model page HTTP ${modelPage.status}`);

    const gens = parseGenerationLinks(modelPage.body, mkSlug, model.slug);
    const gen = pickGeneration(gens, vehicle.year);
    // A model the site has but not for our year is an honest gap, not a
    // failure — and emitting from the wrong generation would be far worse.
    if (!gen) return empty(`no generation covering ${vehicle.year} (have ${gens.length})`);

    // 3) Generation page → year-scoped sections, scored.
    const genPage = await fetchPage(gen.url);
    if (genPage.status !== 200) return fail(`generation page HTTP ${genPage.status}`);

    const sectionLinks = parseSectionLinks(genPage.body, mkSlug, model.slug, gen.body);
    const chosen = pickSections(sectionLinks, vehicle.year);
    if (chosen.length === 0) return empty(`no spec-bearing sections among ${sectionLinks.length}`);

    // 4) Fetch the chosen chapters.
    const fetched = await Promise.all(
      chosen.map(async (s) => {
        const page = await fetchPage(s.url);
        return { slug: s.slug, url: s.url, text: page.status === 200 ? htmlToText(page.body) : "" };
      }),
    );
    const usable = fetched.filter((s) => s.text.length > 500);
    if (usable.length === 0) return empty("sections fetched empty");

    // 5) One extraction over all chapters — a capacity in one chapter and its
    //    viscosity in another are the normal case, so they are read together.
    // `callClaudeExtractOnly` already parses the response into `.data` — the
    // same contract priceReextract.ts consumes. It also owns retries and the
    // shared token-budget gate, which is why this adapter does not talk to the
    // Anthropic API directly.
    let data: Record<string, any> = {};
    try {
      const res = await callClaudeExtractOnly({
        system:
          "You extract vehicle specifications from owner's manual text. You only report values that appear verbatim in the supplied text, and you never fill gaps from general knowledge.",
        userPrompt: buildExtractionPrompt(vehicle, usable),
        maxTokens: 4096,
        temperature: 0,
        // ~3 chars/token for the chapters, plus headroom for the field list.
        estimatedInputTokens:
          usable.reduce((n, s) => n + Math.ceil(s.text.length / 3), 0) + 1500,
      });
      data = res.data ?? {};
    } catch (e) {
      return fail(`extraction failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    const rows = parseExtraction(data);
    if (rows.length === 0) return empty("extraction produced no usable specs");

    // The claim points at the section we actually read, not the site root, so
    // an audit can re-open the exact page the value came from.
    const bySlug = new Map(usable.map((s) => [s.slug, s.url]));
    const observedAt = Date.now();
    const claims: Claim[] = rows.map((r) => ({
      field_key: r.field_key,
      value: r.value,
      value_raw: r.value_raw,
      source_family: "aggregator" as const,
      source_domain: HOST,
      source_url: bySlug.get(usable[0].slug) ?? gen.url,
      method: "llm_extraction" as const,
      observed_label: r.quoted_text,
      observed_at: observedAt,
    }));

    return { adapter: ADAPTER_NAME, ok: true, claims };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export const myCarUserManualAdapter: SourceAdapter = {
  name: ADAPTER_NAME,
  family: "aggregator",
  fields: MYCARUSERMANUAL_FIELDS,
  lookup: lookupMyCarUserManual,
};
