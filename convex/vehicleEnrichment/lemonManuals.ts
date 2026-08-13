/**
 * vehicleEnrichment/lemonManuals.ts — LEMON Manuals website-route ingester
 *
 * WHY THIS EXISTS
 * ---------------
 * LEMON Manuals (lemon-manuals.la / .org.ua / .gy) is a static, autoindexed
 * mirror of factory SERVICE manuals. It hosts NO per-vehicle PDFs — its content
 * is HTML — so the PDF-only manualLibrary path can never ingest it. This module
 * is the website route: for one vehicle it resolves the LEMON trim folder, uses
 * the "Repair and Diagnosis (Single Page)" doc as an INDEX, fetches the handful
 * of clean spec leaves ("Standards and Service Limits" tables), and renders them
 * to markdown in the exact shape scrapeManual() returns — so the content flows
 * into the SAME batch1a extractor the pipeline already runs. No bespoke parser.
 *
 * See docs/LEMON_MANUALS_INGESTION.md for the full source dossier.
 *
 * PROVENANCE: LEMON is a low-trust mirror, not OEM. Nothing here writes to the
 * enrichment tables directly — it only produces markdown + source URLs. When it
 * is wired into scrapeManual (a later step), extracted rows must carry a
 * NON-protected data_quality (never oem_manual/deterministic) so OEM,
 * deterministic, and mechanic-verified data always win. See manualLibrary.ts,
 * where lemon-manuals.la is already registered in MANUAL_MIRROR_DOMAINS.
 *
 * PIPELINE LAW: fail open. Every network path returns empty ({markdown:"",...})
 * and never throws. A wrong trim match costs an empty result, never bad data.
 *
 * Convex runtime note: no DOM is available, so all HTML parsing here is
 * regex-based on LEMON's simple generated markup. Pure helpers take no ctx/fetch
 * and are exported for unit tests.
 */

import { v } from "convex/values";
import { internalAction } from "../_generated/server";

// ─── Tunables ────────────────────────────────────────────────────

/** Rotating mirror domains, tried in order until one answers (§1 of the dossier). */
export const LEMON_HOSTS: readonly string[] = [
  "lemon-manuals.la",
  "lemon-manuals.org.ua",
  "lemon-manuals.gy",
];

const FETCH_TIMEOUT_MS = 20_000;
/** The single-page index is ~3.3 MB of link tree — give it room. */
const INDEX_FETCH_TIMEOUT_MS = 40_000;
/** Most spec leaves we will read + render for one vehicle. Each is a fetch. */
export const MAX_LEMON_LEAVES = 12;
/** Extra fetches allowed while skipping content-duplicate leaves (see §4/§5). */
export const LEAF_FETCH_SLACK = 8;
/** Per-leaf rendered-markdown cap. Spec tables are small; this is a guard. */
const PER_LEAF_CHAR_CAP = 8_000;
/** Total rendered-markdown cap fed downstream. */
const TOTAL_MARKDOWN_CAP = 48_000;

// ============================================================================
// Pure helpers (no ctx, no fetch — exported for tests)
// ============================================================================

/** Lowercase alphanumeric key (drops spaces, punctuation). */
export function alnumKey(raw: string | null | undefined): string {
  return typeof raw === "string" ? raw.toLowerCase().replace(/[^a-z0-9]+/g, "") : "";
}

/**
 * Map an OtoPair make to LEMON's make-folder name.
 *
 * LEMON's homepage lists a handful of folder names that don't match our make
 * strings 1:1 (verified against the live index). Everything else falls back to
 * the make as given — the resolver validates by actually fetching the year dir,
 * so a wrong guess just fails open.
 */
export const LEMON_MAKE_FOLDER: Record<string, string> = {
  ram: "Dodge and Ram",
  dodge: "Dodge and Ram",
  nissan: "Nissan-Datsun",
  datsun: "Nissan-Datsun",
  "mercedes-benz": "Mercedes Benz",
  mercedes: "Mercedes Benz",
  mercedesbenz: "Mercedes Benz",
};

export function lemonMakeFolder(make: string): string {
  const key = alnumKey(make);
  return LEMON_MAKE_FOLDER[key] ?? LEMON_MAKE_FOLDER[make.trim().toLowerCase()] ?? make.trim();
}

/**
 * Encode one LEMON path segment. `encodeURIComponent` deliberately leaves
 * `!'()*` unescaped, but LEMON's canonical URLs use %28/%29 for parens and
 * answer the literal form with a 308 — one wasted round trip per fetch (the
 * "(Single Page)" index paid it on every run). Encode them up front.
 */
export function encodeLemonSegment(seg: string): string {
  return encodeURIComponent(seg).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/** Build the year-directory URL for a host. */
export function buildLemonYearUrl(host: string, makeFolder: string, year: number): string {
  return `https://${host}/${encodeLemonSegment(makeFolder)}/${year}/`;
}

/**
 * Parse an autoindex directory page into its immediate child folder names.
 *
 * LEMON is inconsistent: the make dir links years RELATIVELY (`href="2021/"`),
 * but the year dir links trims ABSOLUTELY and multi-segment
 * (`href="/Honda/2021/CR-V%20EX%2C%20AWD/"`). Resolving every href against the
 * directory URL and keeping only those exactly one segment deeper than the
 * directory's own path handles both forms and drops breadcrumbs/ancestors.
 */
export function parseChildFolders(html: string, dirUrl: string): string[] {
  let base: URL;
  try {
    base = new URL(dirUrl);
  } catch {
    return [];
  }
  const basePath = base.pathname.endsWith("/") ? base.pathname : base.pathname + "/";

  const out: string[] = [];
  const seen = new Set<string>();
  const re = /href="([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    if (!href || href.startsWith("#") || href.endsWith(".css") || href.endsWith(".js")) continue;
    let resolved: URL;
    try {
      resolved = new URL(href, dirUrl);
    } catch {
      continue;
    }
    if (resolved.host !== base.host) continue;
    const path = resolved.pathname;
    if (!path.startsWith(basePath)) continue;
    const rest = path.slice(basePath.length);
    // Exactly one more segment, ending in "/": "Segment/".
    if (rest.length === 0 || !rest.endsWith("/") || rest.slice(0, -1).includes("/")) continue;
    const name = safeDecode(rest.slice(0, -1));
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** The drivetrain tokens LEMON puts in its folder names. */
export const DRIVETRAIN_TOKENS = ["awd", "fwd", "rwd", "4wd"] as const;

/**
 * Reduce a drivetrain string to the token LEMON uses, or null.
 *
 * NHTSA rarely returns a bare "AWD" — it returns things like
 * "4WD/4-Wheel Drive/4x4" or "FWD/Front-Wheel Drive", and the Batch-1 extraction
 * returns prose. Matching those against a bare-token regex silently dropped the
 * drivetrain signal entirely, so normalize before comparing.
 */
export function normalizeDrivetrain(raw: string | null | undefined): string | null {
  const s = typeof raw === "string" ? raw.toLowerCase() : "";
  if (!s) return null;
  if (/\b(4wd|4x4|four[\s-]?wheel)\b/.test(s)) return "4wd";
  if (/\b(awd|all[\s-]?wheel)\b/.test(s)) return "awd";
  if (/\b(fwd|front[\s-]?wheel)\b/.test(s)) return "fwd";
  if (/\b(rwd|rear[\s-]?wheel)\b/.test(s)) return "rwd";
  return null;
}

/**
 * Score how well a LEMON trim folder matches the vehicle. Higher is better;
 * a folder that doesn't contain the model at all scores -1 (disqualified).
 *
 * LEMON trim folders are drivetrain/engine-qualified: "CR-V EX, AWD",
 * "Accord Sport, 1.5L Eng". We require the model, then reward trim/drivetrain/
 * displacement echoes. Deterministic: no ties are broken here (the caller
 * applies a stable tiebreak).
 */
export function scoreLemonTrim(
  vehicle: { model: string; trim?: string | null; drivetrain?: string | null; displacement_l?: number | null },
  folderName: string,
): number {
  const folderKey = alnumKey(folderName);
  const modelKey = alnumKey(vehicle.model);
  if (modelKey.length < 1 || !folderKey.includes(modelKey)) return -1;

  const folderLc = folderName.toLowerCase();
  // WORD tokens, not substrings — so trim "LE" does not match "XLE" and
  // drivetrain "AWD" does not match some incidental substring. (Camry LE vs
  // Camry XLE was the live miss that motivated this.)
  const folderToks = new Set(folderLc.split(/[^a-z0-9]+/).filter(Boolean));
  let score = 0;
  if (folderKey.startsWith(modelKey)) score += 5; // model at the front, not incidental

  // Trim tokens (e.g. "EX-L" → ["ex", "l"]) present as whole words in the folder.
  const trimToks = (vehicle.trim ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 1);
  for (const t of trimToks) if (folderToks.has(t)) score += 4;

  // Drivetrain: reward the matching token, PENALIZE a contradicting one. LEMON
  // publishes sibling folders that differ ONLY by drivetrain ("CR-V EX, AWD" vs
  // "CR-V EX, FWD"). Rewarding alone left them tied whenever we knew the
  // drivetrain but the folder disagreed, and the lexicographic tiebreak then
  // handed every FWD car the AWD manual — including a rear-differential fluid
  // capacity that vehicle does not have.
  const dt = normalizeDrivetrain(vehicle.drivetrain);
  if (dt) {
    // AWD and 4WD are cross-labelled between makers: Toyota lists its AWD
    // sedans as "…, 4WD" while NHTSA decodes them "AWD/All-Wheel Drive". Treat
    // the pair as compatible (+2, just under an exact echo) so the penalty only
    // fires on a REAL contradiction (fwd vs awd/4wd/rwd) — otherwise the
    // correct folder got −6 and the pick fell to the lexicographic tiebreak.
    const isAllWheel = (t: string) => t === "awd" || t === "4wd";
    const folderDts: string[] = DRIVETRAIN_TOKENS.filter((t) => folderToks.has(t));
    // German makes write AWD as the brand word, never the token: "430i xDrive
    // 2D Coupe", "C 300 4MATIC", "A4 quattro". Without this alias the AWD/RWD
    // sibling folders tie and the length tiebreak — not the drivetrain — picks.
    if (["xdrive", "quattro", "4matic"].some((t) => folderToks.has(t))) {
      folderDts.push("awd");
    }
    if (folderDts.includes(dt)) score += 3;
    else if (isAllWheel(dt) && folderDts.some(isAllWheel)) score += 2;
    else if (folderDts.length > 0) score -= 6;
  }

  // Displacement echo ("1.5L" ↔ 1.5).
  if (typeof vehicle.displacement_l === "number" && vehicle.displacement_l > 0) {
    const d = vehicle.displacement_l.toFixed(1);
    if (folderLc.includes(`${d}l`) || folderLc.includes(`${d} l`)) score += 3;
  }
  // Clamp at 0: the drivetrain penalty must DEMOTE a contradicting folder, never
  // push it below the -1 sentinel that means "doesn't contain the model" — a
  // wrong-drivetrain manual still beats no manual when it's the only one there.
  return Math.max(0, score);
}

/**
 * Pick the best-matching LEMON trim folder, or null if none contains the model.
 * Stable tiebreak: higher score, then SHORTER folder (the most "base" trim),
 * then lexicographic — so the same vehicle always resolves to the same folder.
 */
export function pickLemonTrim(
  vehicle: { model: string; trim?: string | null; drivetrain?: string | null; displacement_l?: number | null },
  folderNames: readonly string[],
): string | null {
  const run = (v: typeof vehicle): { name: string; score: number } | null => {
    let best: { name: string; score: number } | null = null;
    for (const name of folderNames) {
      const score = scoreLemonTrim(v, name);
      if (score < 0) continue;
      if (
        !best ||
        score > best.score ||
        (score === best.score && name.length < best.name.length) ||
        (score === best.score && name.length === best.name.length && name < best.name)
      ) {
        best = { name, score };
      }
    }
    return best;
  };

  const primary = run(vehicle);
  if (primary) return primary.name;

  // Trim-designation fallback. German-make folders carry the designation, not
  // the marketing model — "430i xDrive 2D Coupe" under a car whose model reads
  // "4 Series" — so the model gate disqualifies the entire directory (the live
  // miss: 2023 BMW 430i xDrive resolved nothing while the folder sat there).
  // Re-anchor on the trim's leading designation token, under two guards that
  // keep this from ever loosening the gate elsewhere:
  //   1. it fires only when NO folder matched the model (directory-level
  //      scheme detection, not a per-folder relaxation);
  //   2. the designation must contain a digit ("430i", "M2", "300") — a
  //      digit-less trim like Honda's "EX" stays model-gated, so a Civic EX
  //      can never adopt "Pilot EX-L"'s manual.
  const designation = (vehicle.trim ?? "")
    .split(/[^a-zA-Z0-9]+/)
    .find((t) => t.length >= 2 && /\d/.test(t));
  if (!designation || alnumKey(designation) === alnumKey(vehicle.model)) return null;
  return run({ ...vehicle, model: designation })?.name ?? null;
}

// ─── Variant equivalence ("This manual is identical to…") ───────────────────

/**
 * Trim LANDING pages (the folder page at trimBaseUrl — verified the header
 * exists nowhere else, not on the single-page index nor on leaves) open with:
 *
 *   This manual is identical to the manual for the following model variants,
 *   except for possibly the "Labor Times", "Fluids", and "Tire Fitment" pages:
 *   <ul><li>Sierra 1500 Elevation, 5.3L Eng VIN D, 4WD<li>…</ul>
 *
 * It is the mirror's own assertion of which sibling folders share this manual
 * (same sentence verified live on GMC, Honda, and BMW pages, Aug 2026 — the
 * BMW one even bridges the known Coupe/Convertible body-style residual).
 * Parsed, it serves two jobs:
 *   1. resolveLemonVehicle: a best-effort pick whose equivalence names the
 *      config's trim is exact-by-assertion — the mirror says this manual
 *      covers that trim (trim_match: "equivalent").
 *   2. Claim attribution: spec claims extracted from one variant's pages hold
 *      for the sibling variants too, EXCEPT claims from the page families the
 *      header excludes — Labor Times / Fluids / Tire Fitment may genuinely
 *      differ per trim, so those must stay per-variant.
 */
export type LemonEquivalence = {
  /** Sibling folder names the mirror asserts share this manual (doc order). */
  variants: string[];
  /**
   * Page FAMILIES (top-level folders like "Labor Times") the identity claim
   * excludes. Claims from leaves under these families must never be attributed
   * across variants. Parsed from the header sentence's quoted names; if the
   * "except" clause is present but its names fail to parse, falls back to the
   * known trio rather than silently claiming full identity.
   */
  excluded_pages: string[];
};

/** The excluded-family trio every live header names (the defensive fallback). */
export const LEMON_EQUIVALENCE_DEFAULT_EXCLUDED: readonly string[] = [
  "Labor Times",
  "Fluids",
  "Tire Fitment",
];

const LEMON_EQUIVALENCE_SENTENCE_RE =
  /This manual is identical to the manual for the following model variants([^<]*)/i;
/** GM equivalence lists (cab × box × engine) run long; bound them anyway. */
const MAX_EQUIVALENCE_VARIANTS = 64;
const MAX_VARIANT_NAME_CHARS = 200;

/**
 * Parse the variant-equivalence header from a trim landing page. Null when the
 * header is absent or unparseable — callers treat null as "no assertion", so a
 * page without the header behaves exactly as before this parser existed.
 */
export function parseLemonEquivalence(html: string): LemonEquivalence | null {
  if (typeof html !== "string" || html.length === 0) return null;
  const m = LEMON_EQUIVALENCE_SENTENCE_RE.exec(html);
  if (!m) return null;

  // Excluded families ride the sentence tail as quoted names — in the raw HTML
  // the quotes are &quot; entities, which stripTags decodes.
  const tail = stripTags(m[1] ?? "");
  const excluded: string[] = [];
  const quoted = /"([^"]{1,60})"/g;
  let qm: RegExpExecArray | null;
  while ((qm = quoted.exec(tail)) !== null) {
    const name = qm[1].trim();
    if (name && !excluded.includes(name)) excluded.push(name);
  }
  const excluded_pages =
    excluded.length > 0
      ? excluded
      : /\bexcept\b/i.test(tail)
        ? [...LEMON_EQUIVALENCE_DEFAULT_EXCLUDED]
        : [];

  // The variant list is the first <ul> AFTER the sentence (the folder-links
  // <ul> sits before it). <li> items are unclosed: `<li>A<li>B`.
  const from = m.index + m[0].length;
  const ulStart = html.indexOf("<ul>", from);
  if (ulStart < 0 || ulStart - from > 2_000) return null;
  const ulEnd = html.indexOf("</ul>", ulStart);
  if (ulEnd < 0) return null;

  const variants: string[] = [];
  const seen = new Set<string>();
  for (const piece of html.slice(ulStart, ulEnd).split(/<li[^>]*>/i).slice(1)) {
    const name = stripTags(piece).replace(/\s+/g, " ").trim();
    if (!name || name.length > MAX_VARIANT_NAME_CHARS) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    variants.push(name);
    if (variants.length >= MAX_EQUIVALENCE_VARIANTS) break;
  }
  return variants.length > 0 ? { variants, excluded_pages } : null;
}

/**
 * True when the vehicle's WHOLE trim is echoed in a LEMON folder/variant name —
 * every trim token present as a whole word (the same tokenization
 * scoreLemonTrim rewards per-token). This is the "exact" bar: "SLT" is covered
 * by "Sierra 1500 SLT, 4D Pickup Crew Cab, …" but not by "Sierra 1500 SLE, …",
 * and "430i xDrive" needs both tokens. A vehicle with no trim covers nothing.
 */
export function nameCoversTrim(vehicle: { trim?: string | null }, name: string): boolean {
  const trimToks = (vehicle.trim ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (trimToks.length === 0) return false;
  const nameToks = new Set(name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  return trimToks.every((t) => nameToks.has(t));
}

/** First equivalence variant that names the vehicle's trim, or null. */
export function equivalentVariantForTrim(
  vehicle: { trim?: string | null },
  variants: readonly string[],
): string | null {
  for (const variant of variants) {
    if (nameCoversTrim(vehicle, variant)) return variant;
  }
  return null;
}

/**
 * True when a leaf path (raw href, decoded path, or full URL) falls under a
 * page family the equivalence header excludes from its identity claim.
 *
 * Family = a whole path SEGMENT equal to the family name ("Labor Times/…"),
 * not a substring match: the excluded "Fluids" is a top-level page family,
 * while "…/Fluids And Lubricants" is a leaf INSIDE Repair and Diagnosis — a
 * tree the header asserts identical — so it stays attributable. Trailing-s
 * tolerance covers singular/plural drift ("Labor Time" vs "Labor Times").
 */
export function isEquivalenceExcludedPath(
  path: string,
  excludedPages: readonly string[],
): boolean {
  const famKeys = excludedPages.map(alnumKey).filter(Boolean);
  if (famKeys.length === 0) return false;
  for (const seg of hrefSegments(path)) {
    const k = alnumKey(seg);
    if (!k) continue;
    if (famKeys.some((f) => k === f || k === `${f}s` || `${k}s` === f)) return true;
  }
  return false;
}

/**
 * Leaf-section allowlist, most valuable first. LEMON is a service manual, so the
 * clean structured data lives on spec tables. Each entry: a matcher against the
 * DECODED href path + a priority weight.
 *
 * The vocabulary is NOT uniform across makes — verified live on three:
 *   Honda CR-V   "Standards and Service Limits" ×18, "Service Specifications" ×18
 *   Toyota Camry "Standards and Service Limits" ×0,  "Service Specifications" ×470
 *   Ford  F-150  both ×0 — it uses "General Specifications" ×22, "Capacities" ×8,
 *                "Torque Specifications" ×3, "Lubricants, Fluids, Sealers and
 *                Adhesives" ×4
 * A Honda-only allowlist therefore harvested NOTHING of value on Ford. Every
 * entry below is grounded in a live index.
 *
 * `/\bcapacit(y|ies)\b/` is deliberately word-bounded: the earlier `/\bcapacit/`
 * also matched "Ignition Transformer Capacitor" — a wiring-diagram page. Both
 * numbers are needed: Ford titles its pages "Capacities", Toyota "Engine Oil
 * Standard Capacity". Likewise one `/\blubricants?\b/` covers Ford's
 * "Lubricants, Fluids, Sealers and Adhesives" and Toyota's "Fluids And
 * Lubricants" without a per-make string.
 */
export const LEMON_LEAF_SECTIONS: ReadonlyArray<{ re: RegExp; weight: number; label: string }> = [
  // OEM MAINTENANCE INTERVALS — top weight because they are the rarest and the
  // only source here for batch1a's `intervals` block (interval_miles /
  // interval_months). LEMON is a SERVICE manual, so most makes carry no
  // schedule; Honda is the exception — its FSM embeds the Maintenance Minder
  // tables ("Replace air cleaner element … every 15,000 miles (24,000 km)",
  // "change the brake fluid every 3 years"). Verified present on 2021 CR-V and
  // 2021 Odyssey; ABSENT on BMW 330i and Toyota Camry/RAV4, and Ford's
  // "Maintenance Schedules" pages are stubs that point at the Owner's Guide.
  // Costs nothing where absent — the allowlist simply matches nothing.
  // 130/126 sit above the maximum spec score (100 section + 12 subsystem bonus
  // = 112), so "top weight" holds even against a bonused service-limits leaf.
  { re: /maintenance (main|sub) items/i, weight: 130, label: "maintenance_items" },
  { re: /maintenance schedule/i, weight: 126, label: "maintenance_schedule" },
  { re: /standards and service limits/i, weight: 100, label: "service_limits" },
  { re: /\bcapacit(y|ies)\b/i, weight: 95, label: "capacity" },
  { re: /\blubricants?\b/i, weight: 90, label: "lubricants" },
  { re: /general specifications/i, weight: 85, label: "general_specifications" },
  { re: /torque specifications/i, weight: 82, label: "torque_specifications" },
  // BMW files its spec content as numbered-group "Technical Data" pages
  // ("11 00 ENGINE" carries the oil fill capacity, "17 00 COOLING" the coolant
  // circuits, "34 11 Front Brakes" the disc MIN TH) — none of the vocabulary
  // above appears anywhere in its 20k-leaf index. Verified live on 2020 330i.
  { re: /technical data/i, weight: 88, label: "technical_data" },
  { re: /service specifications/i, weight: 80, label: "service_specifications" },
  { re: /fluid type specifications/i, weight: 70, label: "fluid_type" },
  { re: /lubrication system - service information/i, weight: 50, label: "lubrication" },
  { re: /\bfluid\b/i, weight: 20, label: "fluid" },
];

/**
 * Subsystem bonus, applied on top of the section weight.
 *
 * Toyota publishes 470 "Service Specifications" leaves; a cap of 12 with no
 * tiebreak but href-alphabetical picked an ARBITRARY dozen (whatever sorts
 * first). The bonus pulls the leaves whose PATH names a subsystem we actually
 * extract — fluids, capacities, torque — to the front of that pack. Highest
 * matching bonus wins (not a sum), so ordering stays easy to reason about.
 */
export const LEMON_LEAF_SUBSYSTEMS: ReadonlyArray<{ re: RegExp; bonus: number }> = [
  { re: /lubrication|engine oil|coolant|cooling|brake fluid|transmission fluid|\bcapacities\b|fluid type/i, bonus: 12 },
  { re: /engine mechanical|\bbrakes\b|transmission|drivelines|axles|steering|suspension/i, bonus: 6 },
];

/**
 * Leaf DENY list, checked before the allowlist.
 *
 * Honda files non-US-market maintenance pages in the same tree as the US ones:
 * "Maintenance Schedule for Normal and Severe Conditions - General Countries
 * (Ecuador)" and "Lubricants and Fluids (Ecuador)" sit beside the US-market
 * "(KA/KC)" variants. Their intervals and fluid specs are for other markets
 * (fixed-mileage schedules, injector-cleaner mandates, different oils) —
 * feeding them to batch1a would write wrong-market data for US vehicles. The
 * KA/KC pages are untouched by these patterns.
 *
 * `collision`: BMW's "Collision - Body Dimensions And Torque Specifications"
 * subtree is body-shop panel-gap and frame-jig data. Its pages ride the
 * `torque specifications` allowlist match and on a 2020 330i took 9 of 12
 * harvest slots with door-gap dimensions — zero enrichment value.
 */
export const LEMON_LEAF_DENY: readonly RegExp[] = [
  // Honda's wrong-market labels…
  /general countries/i,
  /\becuador\b/i,
  // …and Chrysler/Ram's: a 2020 Ram 1500 harvest pulled "Maintenance Schedule -
  // Middle East" and "Maintenance Schedules - LATIN AMERICA" beside the
  // "North AMERICA" pages. Same hazard, different maker vocabulary.
  /middle east/i,
  /latin america/i,
  /\bcollision\b/i,
];

/** Every relative leaf href in the single-page index (deduped, in doc order). */
export function extractLeafHrefs(indexHtml: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /href="([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(indexHtml)) !== null) {
    const href = m[1];
    if (!href || href.startsWith("/") || href.startsWith("..") || href.startsWith("http")) continue;
    if (href.startsWith("#") || href.endsWith(".css") || href.endsWith(".js")) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    out.push(href);
  }
  return out;
}

export type LemonLeaf = { href: string; weight: number; score: number; label: string };

/**
 * Rank the index's leaf hrefs by the section allowlist (+ subsystem bonus) and
 * return the top N. Deterministic: sort by score desc, then href asc; dedupe.
 */
export function selectRelevantLeaves(hrefs: readonly string[], cap = MAX_LEMON_LEAVES): LemonLeaf[] {
  const scored: LemonLeaf[] = [];
  // The single-page index lists the SAME content page under multiple parent
  // folders (its own note: "the same page can appear multiple times under a
  // different folder"). Dedupe on the last two decoded path segments — specific
  // enough to keep distinct specs ("…/Brakes" vs "…/Cooling System") while
  // collapsing a page that appears under two parents into one fetch.
  const seenTail = new Set<string>();
  for (const href of hrefs) {
    const decoded = safeDecode(href);
    if (LEMON_LEAF_DENY.some((d) => d.test(decoded))) continue;
    let matched: { weight: number; label: string } | null = null;
    for (const s of LEMON_LEAF_SECTIONS) {
      if (s.re.test(decoded)) {
        if (!matched || s.weight > matched.weight) matched = { weight: s.weight, label: s.label };
      }
    }
    if (!matched) continue;
    const segs = hrefSegments(href);
    const tail = segs.slice(-2).join("/").toLowerCase();
    if (seenTail.has(tail)) continue;
    seenTail.add(tail);
    const bonus = LEMON_LEAF_SUBSYSTEMS.find((s) => s.re.test(decoded))?.bonus ?? 0;
    scored.push({ href, weight: matched.weight, score: matched.weight + bonus, label: matched.label });
  }
  scored.sort((a, b) => b.score - a.score || a.href.localeCompare(b.href));
  return scored.slice(0, Math.max(0, cap));
}

/**
 * Resolve a leaf href (relative to an index dir) to an absolute URL.
 *
 * The paren re-encode is belt-and-suspenders on top of encodeLemonSegment:
 * a literal paren anywhere in the final URL (from a base built before the
 * helper, or a raw href) draws LEMON's 308 to the %28 form — one wasted round
 * trip per fetch. Normalising here guarantees the canonical URL regardless of
 * how the base was assembled.
 */
export function resolveLeafUrl(indexUrl: string, href: string): string | null {
  try {
    return new URL(href, indexUrl).toString().replace(/\(/g, "%28").replace(/\)/g, "%29");
  } catch {
    return null;
  }
}

/** Decode a %XX/entity-ish path without throwing. */
export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Split an href into its path segments — RAW split first, decode each segment
 * after. Never decode the whole path and then split it.
 *
 * LEMON has folder names that CONTAIN a slash: "A/C Compressor Drive Belt",
 * "Brake Shoes &/Or Pads". The site percent-encodes those (%2F) inside a single
 * segment, so decode-then-split turns one folder into two and the
 * "component / action" tail of every such operation comes out wrong — which is
 * exactly why the brake-pad and A/C operations never matched.
 */
export function hrefSegments(href: string): string[] {
  return href
    .split("/")
    .filter((s) => s.length > 0)
    .map(safeDecode);
}

/** The "Component / Action" tail of a leaf href ("Spark Plugs / Remove & Replace"). */
export function hrefTail(href: string): string | null {
  const segs = hrefSegments(href);
  return segs.length >= 2 ? `${segs[segs.length - 2]} / ${segs[segs.length - 1]}` : null;
}

/** Strip tags + decode the handful of entities LEMON emits. */
function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    });
}

/**
 * Render a LEMON leaf page's main content to compact markdown.
 *
 * Isolates <div class="main"> … </div>, drops the "So it begins" announcement,
 * flattens tables to `a | b | c` rows and list items to `- item`, then strips
 * remaining tags. The output is what feeds the batch1a extractor — clean enough
 * that the model reads spec rows, small enough to stay in the token budget.
 */
export function htmlLeafToMarkdown(html: string): string {
  // Isolate main content; fall back to the whole doc if the marker is absent.
  const start = html.indexOf('<div class="main">');
  let body = start >= 0 ? html.slice(start + '<div class="main">'.length) : html;
  const footer = body.search(/<div class="theme-colors footer"|<div class="other-warning/i);
  if (footer >= 0) body = body.slice(0, footer);

  // Drop the takedown announcement if it slipped in ahead of the footer cut.
  body = body.replace(/<div class="other-announcement[\s\S]*?<\/div>/gi, " ");

  // Table + list structure → line-oriented text BEFORE tags are stripped.
  body = body
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<h[1-6][^>]*>/gi, "\n## ")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");

  const text = stripTags(body);

  // Per-line cleanup: collapse the cell separators and inner whitespace.
  const lines = text
    .split("\n")
    .map((ln) => ln.replace(/[ \t]+/g, " ").replace(/\s*\|\s*/g, " | ").replace(/(?: \| )+$/, "").trim())
    .filter((ln) => ln.length > 0);

  return lines.join("\n").slice(0, PER_LEAF_CHAR_CAP).trim();
}

// ============================================================================
// Action: preview ingest (no writes — inspect data quality before wiring)
// ============================================================================

export async function lemonFetch(url: string, timeoutMs: number): Promise<{ ok: boolean; status: number; body: string }> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "text/html,*/*", "User-Agent": "OtoPair-Enrichment/1.0" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = res.ok ? await res.text() : "";
    return { ok: res.ok, status: res.status, body };
  } catch {
    return { ok: false, status: 0, body: "" };
  }
}

export type LemonPreview = {
  ok: boolean;
  reason: string;
  host: string | null;
  make_folder: string | null;
  resolved_trim: string | null;
  index_url: string | null;
  leaf_count: number;
  leaves: Array<{ url: string; label: string; chars: number }>;
  markdown: string;
  total_chars: number;
  /** How the resolved folder relates to the config's trim; null when unresolved. */
  trim_match: LemonTrimMatch | null;
  /** Sibling variants the mirror asserts share this manual ([] when no header). */
  equivalent_variants: string[];
  /**
   * Page families excluded from that identity claim ([] when no header).
   * Claims from leaves under these families (isEquivalenceExcludedPath) must
   * never be attributed to sibling-variant configs.
   */
  equivalence_excluded_pages: string[];
  /** The variant that named the config's trim, when trim_match="equivalent". */
  matched_variant: string | null;
};

/**
 * Resolve → index → select leaves → fetch leaves → render markdown, for one
 * vehicle. Writes NOTHING. Returns diagnostics + the markdown that WOULD feed
 * batch1a, so we can eyeball data quality before wiring into scrapeManual.
 */
export type LemonFetchArgs = {
  make: string;
  model: string;
  year: number;
  trim?: string | null;
  drivetrain?: string | null;
  displacement_l?: number | null;
  maxLeaves?: number;
};

/**
 * How the resolved trim folder relates to the config's trim:
 *  - "exact": the folder name itself echoes the whole trim;
 *  - "equivalent": it doesn't, but the landing page's equivalence header names
 *    a variant that does — the mirror asserts this manual covers the config's
 *    trim, so the pick is exact-by-assertion (excluded page families aside);
 *  - "best_effort": neither — the closest folder the scoring gate allows
 *    (also the classification for trim-less vehicles).
 */
export type LemonTrimMatch = "exact" | "equivalent" | "best_effort";

export type LemonResolved = {
  host: string;
  makeFolder: string;
  trim: string;
  trimBaseUrl: string;
  /** Only set when resolved with {equivalence:true} (the spec path). */
  trim_match?: LemonTrimMatch;
  /** Parsed landing-page header; null when absent/unreachable. Opt-in as above. */
  equivalence?: LemonEquivalence | null;
  /** The equivalence variant that named the trim, when trim_match="equivalent". */
  matched_variant?: string | null;
};

/**
 * Resolve a vehicle to a live host + best-match trim folder. Shared by the spec
 * ingester (this file) and the labor ingester (lemonLabor.ts). Fail-open: null
 * when no host answers or no trim matches. `trimBaseUrl` ends in "/", ready to
 * append a section folder ("Repair and Diagnosis (Single Page)/", "Labor Times/").
 *
 * `opts.equivalence` adds ONE fetch of the ~2KB trim landing page — the only
 * place the variant-equivalence header exists — and fills the optional
 * trim_match/equivalence/matched_variant fields. The labor path stays opted
 * out: Labor Times is an excluded family, so equivalence can never strengthen
 * a labor pick, and the extra fetch would buy nothing.
 */
export async function resolveLemonVehicle(
  args: LemonFetchArgs,
  opts?: { equivalence?: boolean },
): Promise<LemonResolved | null> {
  const makeFolder = lemonMakeFolder(args.make);
  const vehicle = {
    model: args.model,
    trim: args.trim ?? null,
    drivetrain: args.drivetrain ?? null,
    displacement_l: args.displacement_l ?? null,
  };
  let host: string | null = null;
  let folders: string[] = [];
  for (const h of LEMON_HOSTS) {
    const yearUrl = buildLemonYearUrl(h, makeFolder, args.year);
    const res = await lemonFetch(yearUrl, FETCH_TIMEOUT_MS);
    if (res.ok && res.body.length > 0) {
      const parsed = parseChildFolders(res.body, yearUrl);
      if (parsed.length > 0) {
        host = h;
        folders = parsed;
        break;
      }
    }
  }
  if (!host) return null;
  const trim = pickLemonTrim(vehicle, folders);
  if (!trim) return null;
  const trimBaseUrl = buildLemonYearUrl(host, makeFolder, args.year) + `${encodeLemonSegment(trim)}/`;
  const base: LemonResolved = { host, makeFolder, trim, trimBaseUrl };
  if (!opts?.equivalence) return base;

  // Fail-open: an unreachable landing page or absent header just leaves the
  // equivalence null and the classification at what the folder name alone says.
  const exact = nameCoversTrim(vehicle, trim);
  let equivalence: LemonEquivalence | null = null;
  const landing = await lemonFetch(trimBaseUrl, FETCH_TIMEOUT_MS);
  if (landing.ok && landing.body.length > 0) {
    equivalence = parseLemonEquivalence(landing.body);
  }
  const matched_variant =
    !exact && equivalence ? equivalentVariantForTrim(vehicle, equivalence.variants) : null;
  return {
    ...base,
    equivalence,
    matched_variant,
    trim_match: exact ? "exact" : matched_variant ? "equivalent" : "best_effort",
  };
}

/**
 * THE core ingester: resolve → index → select leaves → fetch → render markdown.
 *
 * No ctx, no writes — just `fetch`. This is what scrapeManual() calls to fold
 * LEMON's spec tables into `manualMarkdown` (which feeds batch1a), and what the
 * previewLemonIngest action wraps for eyeballing data quality. Fail-open: any
 * failure yields an `ok:false` result with an empty markdown, never throws.
 */
export async function fetchLemonManualMarkdown(args: LemonFetchArgs): Promise<LemonPreview> {
    const empty = (reason: string, extra: Partial<LemonPreview> = {}): LemonPreview => ({
      ok: false,
      reason,
      host: null,
      make_folder: null,
      resolved_trim: null,
      index_url: null,
      leaf_count: 0,
      leaves: [],
      markdown: "",
      total_chars: 0,
      trim_match: null,
      equivalent_variants: [],
      equivalence_excluded_pages: [],
      matched_variant: null,
      ...extra,
    });

    const makeFolder = lemonMakeFolder(args.make);

    // ── 1-2. Resolve a live host + best-match trim folder ───────────
    // equivalence:true — the spec path wants the landing page's variant-identity
    // assertion both to classify the pick and to ride the scrape result for
    // cross-variant claim attribution.
    const resolved = await resolveLemonVehicle(args, { equivalence: true });
    if (!resolved) return empty("unresolved", { make_folder: makeFolder });
    const { host, trim } = resolved;
    const equivalenceFields: Pick<
      LemonPreview,
      "trim_match" | "equivalent_variants" | "equivalence_excluded_pages" | "matched_variant"
    > = {
      trim_match: resolved.trim_match ?? null,
      equivalent_variants: resolved.equivalence?.variants ?? [],
      equivalence_excluded_pages: resolved.equivalence?.excluded_pages ?? [],
      matched_variant: resolved.matched_variant ?? null,
    };

    // ── 3. Fetch the single-page index (link tree) ──────────────────
    const indexUrl = resolved.trimBaseUrl + `${encodeLemonSegment("Repair and Diagnosis (Single Page)")}/`;
    const indexRes = await lemonFetch(indexUrl, INDEX_FETCH_TIMEOUT_MS);
    if (!indexRes.ok || indexRes.body.length === 0) {
      return empty("index_unreachable", { host, make_folder: makeFolder, resolved_trim: trim, index_url: indexUrl, ...equivalenceFields });
    }

    // ── 4. Select the spec leaves ───────────────────────────────────
    // Over-select: the path dedupe keys on the last TWO segments, which is right
    // for Ford (several genuinely different "…/Capacities" pages) but too loose
    // for Toyota, which files ONE page under half a dozen parents — six slots of
    // twelve went to the same "Engine Oil Standard Capacity" page. Take a deeper
    // candidate list and let the fetch loop below drop content duplicates.
    const cap = Math.max(1, Math.trunc(args.maxLeaves ?? MAX_LEMON_LEAVES));
    const chosen = selectRelevantLeaves(extractLeafHrefs(indexRes.body), cap * 3);
    if (chosen.length === 0) {
      return empty("no_spec_leaves", { host, make_folder: makeFolder, resolved_trim: trim, index_url: indexUrl, ...equivalenceFields });
    }

    // ── 5. Fetch + render each leaf into markdown ───────────────────
    const parts: string[] = [];
    const leaves: LemonPreview["leaves"] = [];
    const seenContent = new Set<string>();
    let total = 0;
    let fetches = 0;
    for (const leaf of chosen) {
      if (total >= TOTAL_MARKDOWN_CAP || leaves.length >= cap) break;
      // Bound the extra fetches the over-selection could cost: a page-count
      // budget, not just an accepted-leaf budget.
      if (fetches >= cap + LEAF_FETCH_SLACK) break;
      const url = resolveLeafUrl(indexUrl, leaf.href);
      if (!url) continue;
      fetches++;
      const res = await lemonFetch(url, FETCH_TIMEOUT_MS);
      if (!res.ok || res.body.length === 0) continue;
      const md = htmlLeafToMarkdown(res.body);
      if (md.length === 0) continue;
      // Same content under a different parent — keep the first, skip the rest.
      const fingerprint = `${md.length}:${md.slice(0, 240)}`;
      if (seenContent.has(fingerprint)) continue;
      seenContent.add(fingerprint);
      const block = `\n\n--- Source: ${url} ---\n${md}`;
      parts.push(block);
      leaves.push({ url, label: leaf.label, chars: md.length });
      total += block.length;
    }

    if (leaves.length === 0) {
      return empty("leaves_empty", { host, make_folder: makeFolder, resolved_trim: trim, index_url: indexUrl, ...equivalenceFields });
    }

    const markdown = parts.join("").slice(0, TOTAL_MARKDOWN_CAP).trim();
    return {
      ok: true,
      reason: "ok",
      host,
      make_folder: makeFolder,
      resolved_trim: trim,
      index_url: indexUrl,
      leaf_count: leaves.length,
      leaves,
      markdown,
      total_chars: markdown.length,
      ...equivalenceFields,
    };
}

/**
 * Thin action wrapper around fetchLemonManualMarkdown — run it from
 * `npx convex run` to inspect data quality on a vehicle. Writes nothing.
 */
export const previewLemonIngest = internalAction({
  args: {
    make: v.string(),
    model: v.string(),
    year: v.float64(),
    trim: v.optional(v.string()),
    drivetrain: v.optional(v.string()),
    displacement_l: v.optional(v.float64()),
    maxLeaves: v.optional(v.float64()),
  },
  handler: async (_ctx, args): Promise<LemonPreview> => fetchLemonManualMarkdown(args),
});
