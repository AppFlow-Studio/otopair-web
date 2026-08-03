/**
 * vehicleEnrichment/partIndex.ts — PART-NUMBER EXISTENCE ORACLE.
 *
 * A catalog sitemap enumerates every part number a storefront sells, with the
 * number encoded in the product URL. Downloading one gives us an offline set
 * membership test: "is 04152-YZZA1 a real Toyota part number?" becomes an
 * index lookup instead of a model's opinion. The 17 `sitemap_partsinfo*.xml.gz`
 * children of toyotapartsdeal.com carry 829,693 <loc> entries; measured Jul 30
 * 2026 those yield 829,693 DISTINCT Toyota numbers — the partsinfo sitemaps are
 * already one url per part number, so nothing collapses on dedupe. (An earlier
 * note put the distinct count at 556,792; re-measured across all 17 children it
 * does not reproduce, and every url in the corpus parses.)
 *
 * PIPELINE LAW. The oracle's dangerous verdict is "absent", because that is the
 * one that discards a part. It is issued ONLY on positive evidence: a completed,
 * fresh index for that exact make. Every other state — never indexed, ingest
 * running, ingest failed, index older than the freshness window — returns
 * "no_index", which means "we don't know" and must leave the caller's value
 * alone. A make we have never crawled must never be reported as "part doesn't
 * exist"; that is why `no_index` is a distinct verdict rather than a truthy
 * boolean. Correspondingly an ingest that could not read EVERY child sitemap
 * ends "failed", not "ok" — a partial index that claims completeness would
 * manufacture false "absent" verdicts, which is exactly the present-but-wrong
 * failure the pipeline forbids.
 *
 * POLITENESS BUDGET. These are storefront sitemaps; oempartsonline.com's
 * robots.txt names ClaudeBot with `Crawl-delay: 10` and toyotapartsdeal.com
 * publishes no delay at all, so 10s is applied to BOTH as the floor. Spacing is
 * achieved structurally, not by sleeping: an ingest tick processes exactly ONE
 * child sitemap and then reschedules itself `CRAWL_DELAY_MS` later. A full
 * Toyota partsdeal pass is therefore 18 requests (1 index + 17 children), never
 * two within 10s of each other, once a week — measured ~25 min end to end, of
 * which the crawl delay is the smaller half. Every request carries a browser
 * User-Agent (a bare fetch to these hosts answers 403) and an
 * AbortSignal.timeout.
 *
 * GZIP. The children are `.gz` served as application/octet-stream with no
 * Content-Encoding, so `fetch` does not transparently inflate them; the bytes
 * arrive with the 1f 8b magic intact. Probed live Jul 30 2026, the default
 * Convex runtime exposes NEITHER `DecompressionStream` nor `CompressionStream`,
 * and node:zlib is out of reach because a `"use node"` module may only export
 * actions while this one must also export the batch mutation and the oracle
 * query. So inflate is implemented in-file (see `gunzipToText`), dependency-free
 * and unit-tested against a real captured child sitemap.
 *
 * Wire-in points:
 *   - internal.vehicleEnrichment.partIndex.ingestPartIndex     (per make+source)
 *   - internal.vehicleEnrichment.partIndex.lookupPartNumbers   (the oracle)
 *   - internal.vehicleEnrichment.partIndex.refreshIndexedMakes (weekly cron)
 */

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { normalizeOemNumber } from "./priceParser";

/** Storefronts answer a bare fetch with 403; this is the same UA the other
 *  scrapers in this directory send. */
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

/** robots.txt floor for these hosts (ClaudeBot: Crawl-delay: 10). Doubles as
 *  the gap between self-continued ingest ticks. */
const CRAWL_DELAY_MS = 10_000;
const SITEMAP_INDEX_TIMEOUT_MS = 30_000;
/** Children are ~850KB gzipped / ~11MB inflated — a generous but bounded wait. */
const SITEMAP_CHILD_TIMEOUT_MS = 120_000;

/** Rows per write mutation. 1000 index lookups + up to 1000 inserts sits well
 *  inside a Convex mutation's read/write ceilings. */
const WRITE_BATCH_SIZE = 1000;

/** An index older than this may no longer speak for the catalog, so it loses
 *  the entitlement to say "absent". */
export const DEFAULT_INDEX_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Guards a runaway `partNumbers` array from turning one query into a scan. */
const MAX_LOOKUP_BATCH = 500;

// This module is new — `internal.vehicleEnrichment.partIndex` is absent from
// _generated/api.d.ts until `npx convex dev` regenerates it. Same pattern as
// nhtsaOdi.ts; tighten after codegen.
const selfApi = () => (internal as any).vehicleEnrichment.partIndex;

// ============================================================================
// Source registry
// ============================================================================

export type PartIndexSource = "partsdeal" | "revparts";

type SourceRoot = {
  /** Sitemap INDEX url. Child urls are always read from this document — never
   *  constructed. RevolutionParts names its children `products_0001.xml.gz`
   *  (4-digit, zero-padded); a non-padded guess 404s silently and would yield a
   *  0-URL "successful" ingest, i.e. an index that answers "absent" to
   *  everything. Parsing the real list makes that class of bug impossible. */
  root: string;
  /** Which children of the index carry PRODUCT urls. The other children
   *  (catalog/diagram/accessory/image sitemaps) hold no part numbers. */
  childPattern: RegExp;
};

/**
 * Explicit per-(source, make) roots. Deliberately NOT derived from the make
 * name — `https://www.${make}partsdeal.com/sitemap.xml` happens to be right for
 * several makes and wrong for others, and a wrong root that 404s is
 * indistinguishable from a make with no parts. Adding a make is a one-line
 * edit here plus one ingest run.
 */
const SOURCE_ROOTS: Record<PartIndexSource, Record<string, SourceRoot>> = {
  partsdeal: {
    toyota: {
      root: "https://www.toyotapartsdeal.com/sitemap.xml",
      childPattern: /sitemap_partsinfo\d+\.xml(\.gz)?$/i,
    },
  },
  revparts: {
    toyota: {
      root: "https://toyota.oempartsonline.com/sitemap.xml",
      childPattern: /products_\d+\.xml(\.gz)?$/i,
    },
  },
};

/** Canonical make key used for both the registry and the stored `make` column. */
export function normalizeMakeKey(make: string): string {
  return (make ?? "").trim().toLowerCase();
}

export function sourceRootFor(source: string, make: string): SourceRoot | null {
  const bySource = SOURCE_ROOTS[source as PartIndexSource];
  if (!bySource) return null;
  return bySource[normalizeMakeKey(make)] ?? null;
}

// ============================================================================
// Pure grammars (exported for tests — no ctx, no fetch)
// ============================================================================

export type ParsedPartNumber = {
  /** The number exactly as the URL spelled it (partsdeal keeps dashes). */
  raw: string;
  /** normalizeOemNumber form — the only key anything joins on. */
  normalized: string;
};

/**
 * Shape gate shared by both grammars. The last url segment is only a part
 * number if it looks like one; otherwise the caller gets null. Without this a
 * catalog url ending in a model name ("...~camry.html") would enter the index
 * as a "part number" and then make the oracle vouch for a string that is not a
 * part — present-but-wrong, inside the very table meant to catch it.
 *
 * Rules, drawn from the observed corpus (every one of the 50,000 urls in
 * partsinfo1 matches): alphanumerics-and-dashes only, at least two digits, and
 * 6..24 characters once normalized. That admits every OEM numbering scheme in
 * use (Toyota 04152-YZZA1, Honda 15400-PLM-A02, Ford F1TZ-6731-A, GM 12345678)
 * while rejecting words, years, and trim codes.
 */
function looksLikePartNumber(token: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(token)) return false;
  const normalized = normalizeOemNumber(token);
  if (normalized.length < 6 || normalized.length > 24) return false;
  const digits = normalized.replace(/[^0-9]/g, "").length;
  return digits >= 2;
}

/**
 * PartsDeal product url → part number.
 *
 * Grammar (verified live Jul 30 2026):
 *   https://www.toyotapartsdeal.com/oem/toyota~pad~kit~front~disc~brake~04465-33471.html
 *
 * `~` is the word separator for the WHOLE slug, so the part number is the last
 * tilde token before `.html`. Dashes are KEPT and everything is lowercased, so
 * the raw form survives the round trip; normalization is what makes it joinable.
 * Host-gated on *partsdeal.com because the family spans makes
 * (toyotapartsdeal.com, bmwpartsdeal.com, ...) but nothing else uses this shape.
 */
export function partNumberFromPartsdealUrl(url: string): ParsedPartNumber | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/(^|\.)[a-z0-9-]+partsdeal\.com$/i.test(parsed.hostname)) return null;
  const match = /^\/oem\/(.+)\.html$/i.exec(parsed.pathname);
  if (!match) return null;
  const token = match[1].split("~").pop() ?? "";
  if (!looksLikePartNumber(token)) return null;
  return { raw: token, normalized: normalizeOemNumber(token) };
}

/**
 * RevolutionParts product url → part number.
 *
 * Grammar (per platform convention):
 *   https://toyota.oempartsonline.com/oem-parts/toyota-engine-oil-filter-041520yzza1
 *
 * The slug is dash-separated and the part number has its OWN dashes STRIPPED,
 * so the number is the last dash token and its raw form is unrecoverable — only
 * the normalized form is meaningful, which is precisely why the index keys on
 * normalizeOemNumber. NOT host-gated: RevolutionParts powers thousands of
 * dealer domains and the `/oem-parts/` path is the platform's own signature.
 */
export function partNumberFromRevPartsUrl(url: string): ParsedPartNumber | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const match = /^\/oem-parts\/(.+?)\/?$/i.exec(parsed.pathname);
  if (!match) return null;
  const token = match[1].split("-").pop() ?? "";
  // A stripped-dash number is a single alphanumeric run; a token that still
  // contains a dash cannot have come from this grammar.
  if (token.includes("-") || !looksLikePartNumber(token)) return null;
  return { raw: token, normalized: normalizeOemNumber(token) };
}

/** Lowercase-hyphen/tilde-safe slug for the inverse constructors. */
function slugWords(label: string): string[] {
  return (label ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

/**
 * Inverse of `partNumberFromPartsdealUrl`. Takes the RAW (dashed) number
 * because partsdeal preserves dashes and nothing can reconstruct them from the
 * normalized form. Returns null for a number that would not parse back, so a
 * constructor can never mint a url the extractor would reject.
 */
export function partsdealUrlFromPartNumber(
  partNumberRaw: string,
  opts?: { host?: string; nameSlug?: string },
): string | null {
  const token = (partNumberRaw ?? "").trim().toLowerCase();
  if (!looksLikePartNumber(token)) return null;
  const host = opts?.host ?? "www.toyotapartsdeal.com";
  const words = slugWords(opts?.nameSlug ?? "");
  const slug = [...words, token].join("~");
  return `https://${host}/oem/${slug}.html`;
}

/**
 * Inverse of `partNumberFromRevPartsUrl`. Strips the number's dashes the way
 * the platform does, so round-tripping recovers the normalized form (never the
 * raw one — that information is destroyed by the grammar itself).
 */
export function revPartsUrlFromPartNumber(
  partNumberRaw: string,
  opts?: { host?: string; make?: string; nameSlug?: string },
): string | null {
  // Gate on the RAW token, not the normalized one: normalizeOemNumber strips
  // punctuation, so validating after it would happily mint a url from "04465/33471".
  const token = (partNumberRaw ?? "").trim();
  if (!looksLikePartNumber(token)) return null;
  const normalized = normalizeOemNumber(token);
  const host = opts?.host ?? "toyota.oempartsonline.com";
  const words = [...slugWords(opts?.make ?? ""), ...slugWords(opts?.nameSlug ?? "")];
  const slug = [...words, normalized.toLowerCase()].join("-");
  return `https://${host}/oem-parts/${slug}`;
}

const GRAMMARS: Record<PartIndexSource, (url: string) => ParsedPartNumber | null> = {
  partsdeal: partNumberFromPartsdealUrl,
  revparts: partNumberFromRevPartsUrl,
};

/** Dispatch to a source's grammar. An unknown source yields null for every url
 *  rather than falling back to a "best guess" parser. */
export function partNumberFromUrl(source: string, url: string): ParsedPartNumber | null {
  const grammar = GRAMMARS[source as PartIndexSource];
  return grammar ? grammar(url) : null;
}

// ============================================================================
// Pure sitemap parsing
// ============================================================================

/**
 * Pull `<loc>` values out of a sitemap or sitemapindex document. Deliberately
 * regex-based: the Convex runtime has no XML parser, the schema is two tags
 * deep, and these documents run to 11MB where a DOM would be the expensive
 * part. Whitespace inside `<loc>` is real — toyotapartsdeal.com pretty-prints
 * its index with the url on its own line.
 */
export function extractSitemapLocs(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([^<\s][^<]*?)\s*<\/loc>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push(m[1]);
  }
  return out;
}

/** Children of a sitemap index that carry product urls for this source. */
export function selectChildSitemaps(xml: string, childPattern: RegExp): string[] {
  return extractSitemapLocs(xml).filter((loc) => childPattern.test(loc));
}

export type CollectedParts = {
  /** Total <loc> entries seen, product or not. */
  urlCount: number;
  /** Distinct normalized numbers, first-seen raw form and url retained. */
  parts: Array<{ normalized: string; raw: string; url: string }>;
  /** Urls the grammar refused. A healthy child sitemap has very few. */
  unparsed: number;
};

/**
 * Sitemap document → distinct part numbers, deduped on the normalized form.
 * Two urls for the same number (different name slugs, or the same part listed
 * under several assemblies) collapse to one entry — the corpus is ~1.5 urls per
 * number, so this is where most of the volume disappears.
 */
export function collectPartNumbersFromSitemap(xml: string, source: string): CollectedParts {
  const locs = extractSitemapLocs(xml);
  const seen = new Map<string, { normalized: string; raw: string; url: string }>();
  let unparsed = 0;
  for (const loc of locs) {
    const parsed = partNumberFromUrl(source, loc);
    if (!parsed) {
      unparsed++;
      continue;
    }
    if (!seen.has(parsed.normalized)) {
      seen.set(parsed.normalized, { normalized: parsed.normalized, raw: parsed.raw, url: loc });
    }
  }
  return { urlCount: locs.length, parts: [...seen.values()], unparsed };
}

// ============================================================================
// The existence policy (pure — the whole point of factoring it out)
// ============================================================================

export type ExistenceVerdict = "found" | "absent" | "no_index";

/**
 * The single decision that decides whether the oracle is allowed to say a part
 * does not exist.
 *
 * "absent" requires positive evidence of completeness: a status of exactly "ok"
 * whose completed_at is inside the freshness window. Anything else — a make we
 * never crawled (status null), an ingest still running, an ingest that failed
 * partway, an index that has aged out, a completed_at we cannot read, or a
 * completed_at in the future (clock skew we refuse to reason about) — is
 * "no_index", meaning the caller learned nothing and must not change its value.
 *
 * A hit in a non-fresh index also returns "no_index" rather than "found": the
 * oracle either speaks from a verified-complete index or it does not speak.
 */
export function decideExistenceVerdict(args: {
  indexStatus: string | null | undefined;
  foundInIndex: boolean;
  indexAgeMs: number | null | undefined;
  maxAgeMs?: number;
}): ExistenceVerdict {
  const maxAgeMs = args.maxAgeMs ?? DEFAULT_INDEX_MAX_AGE_MS;
  if (args.indexStatus !== "ok") return "no_index";
  const age = args.indexAgeMs;
  if (typeof age !== "number" || !Number.isFinite(age) || age < 0) return "no_index";
  if (age > maxAgeMs) return "no_index";
  return args.foundInIndex ? "found" : "absent";
}

// ============================================================================
// Fetch layer — browser UA + abort on every request, fail open to null
// ============================================================================

// ── gzip ───────────────────────────────────────────────────────────────────
// The child sitemaps are `.gz`. The default Convex runtime has NO gzip: probed
// live Jul 30 2026, `DecompressionStream` and `CompressionStream` are both
// undefined (TransformStream and the rest of the streams API are present).
// node:zlib is not reachable either, because a `"use node"` module may only
// export actions and this module must also export the batch-writing mutation
// and the oracle query. So INFLATE (RFC 1951) + the gzip container (RFC 1952)
// are implemented here — ~120 lines, no dependency, and unit-testable against a
// real captured .gz. Structure follows zlib's reference `puff.c`: canonical
// Huffman decoded bit-by-bit, which costs a few seconds for an 11MB member and
// is irrelevant next to the 10s crawl delay between fetches.

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
];
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

type Huffman = { counts: Int32Array; symbols: Int32Array };

/** Canonical Huffman table from a code-length vector. */
function buildHuffman(lengths: Uint8Array, n: number): Huffman {
  const counts = new Int32Array(16);
  for (let s = 0; s < n; s++) counts[lengths[s]]++;
  counts[0] = 0;
  const offsets = new Int32Array(16);
  for (let len = 1; len < 16; len++) offsets[len] = offsets[len - 1] + counts[len - 1];
  const symbols = new Int32Array(n);
  for (let s = 0; s < n; s++) if (lengths[s] !== 0) symbols[offsets[lengths[s]]++] = s;
  return { counts, symbols };
}

let fixedLit: Huffman | null = null;
let fixedDist: Huffman | null = null;
function fixedTables(): { lit: Huffman; dist: Huffman } {
  if (fixedLit === null || fixedDist === null) {
    const litLengths = new Uint8Array(288);
    for (let i = 0; i < 144; i++) litLengths[i] = 8;
    for (let i = 144; i < 256; i++) litLengths[i] = 9;
    for (let i = 256; i < 280; i++) litLengths[i] = 7;
    for (let i = 280; i < 288; i++) litLengths[i] = 8;
    fixedLit = buildHuffman(litLengths, 288);
    const distLengths = new Uint8Array(30).fill(5);
    fixedDist = buildHuffman(distLengths, 30);
  }
  return { lit: fixedLit, dist: fixedDist };
}

/**
 * Raw DEFLATE stream → bytes. `expectedSize` comes from the gzip trailer so the
 * output buffer is allocated once at the right size; it is a hint, and the
 * buffer grows if the stream disagrees.
 */
function inflateRaw(data: Uint8Array, start: number, expectedSize: number): {
  out: Uint8Array;
  end: number;
} {
  let out = new Uint8Array(expectedSize > 0 ? expectedSize : 1 << 16);
  let outLen = 0;
  const grow = (needed: number) => {
    if (needed <= out.length) return;
    let size = out.length === 0 ? 1 << 16 : out.length;
    while (size < needed) size *= 2;
    const next = new Uint8Array(size);
    next.set(out.subarray(0, outLen));
    out = next;
  };

  let pos = start;
  let bitbuf = 0;
  let bitcnt = 0;
  const bits = (need: number): number => {
    let val = bitbuf;
    while (bitcnt < need) {
      if (pos >= data.length) throw new Error("deflate: input truncated");
      val |= data[pos++] << bitcnt;
      bitcnt += 8;
    }
    bitbuf = val >>> need;
    bitcnt -= need;
    return val & ((1 << need) - 1);
  };
  const decode = (h: Huffman): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= 15; len++) {
      code |= bits(1);
      const count = h.counts[len];
      if (code - count < first) return h.symbols[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error("deflate: invalid Huffman code");
  };

  for (;;) {
    const last = bits(1);
    const type = bits(2);
    if (type === 0) {
      // Stored: discard the partial byte, then LEN / ~LEN and a raw copy.
      bitbuf = 0;
      bitcnt = 0;
      if (pos + 4 > data.length) throw new Error("deflate: truncated stored block");
      const len = data[pos] | (data[pos + 1] << 8);
      const nlen = data[pos + 2] | (data[pos + 3] << 8);
      pos += 4;
      if ((len ^ 0xffff) !== nlen) throw new Error("deflate: stored block length mismatch");
      if (pos + len > data.length) throw new Error("deflate: truncated stored data");
      grow(outLen + len);
      out.set(data.subarray(pos, pos + len), outLen);
      outLen += len;
      pos += len;
    } else if (type === 1 || type === 2) {
      let lit: Huffman;
      let dist: Huffman;
      if (type === 1) {
        ({ lit, dist } = fixedTables());
      } else {
        const nlen = bits(5) + 257;
        const ndist = bits(5) + 1;
        const ncode = bits(4) + 4;
        if (nlen > 286 || ndist > 30) throw new Error("deflate: bad dynamic block counts");
        const clLengths = new Uint8Array(19);
        for (let i = 0; i < ncode; i++) clLengths[CODE_LENGTH_ORDER[i]] = bits(3);
        const clTable = buildHuffman(clLengths, 19);
        const lengths = new Uint8Array(nlen + ndist);
        let i = 0;
        while (i < nlen + ndist) {
          const sym = decode(clTable);
          if (sym < 16) {
            lengths[i++] = sym;
          } else if (sym === 16) {
            if (i === 0) throw new Error("deflate: repeat with no previous length");
            const prev = lengths[i - 1];
            let repeat = 3 + bits(2);
            while (repeat-- > 0 && i < nlen + ndist) lengths[i++] = prev;
          } else if (sym === 17) {
            let repeat = 3 + bits(3);
            while (repeat-- > 0 && i < nlen + ndist) lengths[i++] = 0;
          } else {
            let repeat = 11 + bits(7);
            while (repeat-- > 0 && i < nlen + ndist) lengths[i++] = 0;
          }
        }
        lit = buildHuffman(lengths.subarray(0, nlen), nlen);
        dist = buildHuffman(lengths.subarray(nlen), ndist);
      }

      for (;;) {
        const sym = decode(lit);
        if (sym < 256) {
          grow(outLen + 1);
          out[outLen++] = sym;
          continue;
        }
        if (sym === 256) break;
        const lenIdx = sym - 257;
        if (lenIdx >= LENGTH_BASE.length) throw new Error("deflate: invalid length symbol");
        const length = LENGTH_BASE[lenIdx] + bits(LENGTH_EXTRA[lenIdx]);
        const distSym = decode(dist);
        if (distSym >= DIST_BASE.length) throw new Error("deflate: invalid distance symbol");
        const distance = DIST_BASE[distSym] + bits(DIST_EXTRA[distSym]);
        if (distance > outLen) throw new Error("deflate: distance before start of output");
        grow(outLen + length);
        let from = outLen - distance;
        for (let n = 0; n < length; n++) out[outLen++] = out[from++];
      }
    } else {
      throw new Error("deflate: invalid block type");
    }
    if (last) break;
  }

  return { out: out.subarray(0, outLen), end: pos };
}

let crcTable: Int32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (crcTable === null) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/**
 * gzip member(s) → UTF-8 text. `TextDecoder` drops the leading BOM that these
 * sitemaps carry, which is why the output is one character shorter than
 * Node's `Buffer.toString("utf8")` on the same bytes — verified byte-identical
 * otherwise against zlib on the live 11MB partsinfo1 member.
 *
 * The CRC32 and ISIZE in each member's trailer are
 * VERIFIED, not skipped: a corrupt body is positive evidence of a bad value, so
 * this throws rather than handing a truncated catalog to the indexer, where it
 * would silently become "absent" for every part in the lost tail.
 */
export function gunzipToText(input: Uint8Array): string {
  const chunks: Uint8Array[] = [];
  let pos = 0;
  while (pos + 18 <= input.length) {
    if (input[pos] !== 0x1f || input[pos + 1] !== 0x8b) throw new Error("gzip: bad magic");
    if (input[pos + 2] !== 8) throw new Error("gzip: unsupported compression method");
    const flags = input[pos + 3];
    pos += 10;
    if (flags & 0x04) {
      const extraLen = input[pos] | (input[pos + 1] << 8);
      pos += 2 + extraLen;
    }
    if (flags & 0x08) while (pos < input.length && input[pos++] !== 0);
    if (flags & 0x10) while (pos < input.length && input[pos++] !== 0);
    if (flags & 0x02) pos += 2;

    // ISIZE (uncompressed length mod 2^32) sits in the last 4 bytes of the
    // member; for a single-member file that is the end of the buffer, which is
    // the case for every sitemap observed. Used only to size the output buffer.
    const isize =
      (input[input.length - 4] |
        (input[input.length - 3] << 8) |
        (input[input.length - 2] << 16) |
        (input[input.length - 1] << 24)) >>>
      0;
    const { out, end } = inflateRaw(input, pos, chunks.length === 0 ? isize : 0);
    pos = end;
    if (pos + 8 > input.length) throw new Error("gzip: truncated trailer");
    const expectedCrc =
      (input[pos] | (input[pos + 1] << 8) | (input[pos + 2] << 16) | (input[pos + 3] << 24)) >>> 0;
    const expectedSize =
      (input[pos + 4] |
        (input[pos + 5] << 8) |
        (input[pos + 6] << 16) |
        (input[pos + 7] << 24)) >>>
      0;
    pos += 8;
    if (out.length !== expectedSize) {
      throw new Error(`gzip: size mismatch (${out.length} != ${expectedSize})`);
    }
    if (crc32(out) !== expectedCrc) throw new Error("gzip: CRC32 mismatch");
    chunks.push(out);
  }
  if (chunks.length === 0) throw new Error("gzip: no members");
  if (chunks.length === 1) return new TextDecoder().decode(chunks[0]);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(joined);
}

/**
 * Sitemap bytes → text. `.xml.gz` children arrive as application/octet-stream
 * with no Content-Encoding, so fetch leaves the gzip container intact; a `.xml`
 * child (or one a CDN already decoded) arrives as plain text. Sniffing the
 * 1f 8b magic handles both without trusting the content-type header.
 */
export function decodeSitemapBody(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return gunzipToText(bytes);
  return new TextDecoder().decode(bytes);
}

/** GET a sitemap. Returns null on ANY failure — the caller treats null as
 *  "we do not know", never as "empty catalog". */
async function fetchSitemap(url: string, timeoutMs: number): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/xml,text/xml,application/x-gzip,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      console.warn(`[part-index] HTTP ${response.status} for ${url}`);
      return null;
    }
    return decodeSitemapBody(await response.arrayBuffer());
  } catch (e) {
    console.warn(`[part-index] fetch failed for ${url}:`, e);
    return null;
  }
}

// ============================================================================
// Mutations
// ============================================================================

/**
 * Insert a batch of part numbers, deduped on (make, part_number_normalized).
 * Check-then-insert per row against by_make_part: a number already indexed
 * (this run, a previous run, or the other source) is left exactly as it is
 * rather than re-stamped, so a weekly refresh of an unchanged catalog is ~0
 * writes. Freshness lives in part_index_status.completed_at — the only clock
 * the oracle consults — so nothing is lost by not touching these rows.
 */
export const writePartIndexBatch = internalMutation({
  args: {
    make: v.string(),
    source: v.string(),
    fetched_at: v.number(),
    parts: v.array(
      v.object({
        part_number_normalized: v.string(),
        part_number_raw: v.optional(v.string()),
        url: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args): Promise<{ inserted: number; skipped: number }> => {
    const make = normalizeMakeKey(args.make);
    // The existence checks are independent, so they go out together — 1000
    // sequential index round trips per batch is what makes an 800k-row ingest
    // take hours instead of minutes.
    const existing = await Promise.all(
      args.parts.map((part) =>
        ctx.db
          .query("part_url_index")
          .withIndex("by_make_part", (q) =>
            q.eq("make", make).eq("part_number_normalized", part.part_number_normalized),
          )
          .first(),
      ),
    );

    let inserted = 0;
    let skipped = 0;
    // A batch can repeat a number even when the table does not; `writtenHere`
    // keeps the check-then-insert honest within the transaction.
    const writtenHere = new Set<string>();
    for (let i = 0; i < args.parts.length; i++) {
      const part = args.parts[i];
      if (existing[i] !== null || writtenHere.has(part.part_number_normalized)) {
        skipped++;
        continue;
      }
      writtenHere.add(part.part_number_normalized);
      await ctx.db.insert("part_url_index", {
        make,
        part_number_normalized: part.part_number_normalized,
        part_number_raw: part.part_number_raw,
        source: args.source,
        url: part.url,
        fetched_at: args.fetched_at,
      });
      inserted++;
    }
    return { inserted, skipped };
  },
});

/**
 * Upsert the per-(make, source) ingest state. One row per pair for all time —
 * the oracle reads `status` + `completed_at` off it to decide whether it may
 * fail closed, so a second row for the same pair would let a stale "ok" outlive
 * a fresh "failed".
 */
export const upsertPartIndexStatus = internalMutation({
  args: {
    make: v.string(),
    source: v.string(),
    status: v.string(),
    url_count: v.optional(v.number()),
    part_count: v.optional(v.number()),
    sitemaps_processed: v.optional(v.number()),
    last_error: v.optional(v.string()),
    resume_state: v.optional(v.string()),
    started_at: v.optional(v.number()),
    completed_at: v.optional(v.number()),
    /** Explicitly blank the resume cursor / error on a terminal transition. */
    clear_resume_state: v.optional(v.boolean()),
    clear_last_error: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<null> => {
    const make = normalizeMakeKey(args.make);
    const existing = await ctx.db
      .query("part_index_status")
      .withIndex("by_make_source", (q) => q.eq("make", make).eq("source", args.source))
      .first();

    const patch: Record<string, unknown> = { status: args.status };
    if (args.url_count !== undefined) patch.url_count = args.url_count;
    if (args.part_count !== undefined) patch.part_count = args.part_count;
    if (args.sitemaps_processed !== undefined) patch.sitemaps_processed = args.sitemaps_processed;
    if (args.started_at !== undefined) patch.started_at = args.started_at;
    if (args.completed_at !== undefined) patch.completed_at = args.completed_at;
    if (args.clear_resume_state) patch.resume_state = undefined;
    else if (args.resume_state !== undefined) patch.resume_state = args.resume_state;
    if (args.clear_last_error) patch.last_error = undefined;
    else if (args.last_error !== undefined) patch.last_error = args.last_error;

    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return null;
    }
    await ctx.db.insert("part_index_status", {
      make,
      source: args.source,
      status: args.status,
      url_count: args.url_count,
      part_count: args.part_count,
      sitemaps_processed: args.sitemaps_processed,
      last_error: args.clear_last_error ? undefined : args.last_error,
      resume_state: args.clear_resume_state ? undefined : args.resume_state,
      started_at: args.started_at ?? Date.now(),
      completed_at: args.completed_at,
    });
    return null;
  },
});

// ============================================================================
// Queries
// ============================================================================

export const partIndexStatusesForMake = internalQuery({
  args: { make: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("part_index_status")
      .withIndex("by_make_source", (q) => q.eq("make", normalizeMakeKey(args.make)))
      .collect();
  },
});

export const allPartIndexStatuses = internalQuery({
  args: {},
  handler: async (ctx) => {
    // Bounded by (makes x sources) — tens of rows, not a scan risk.
    return await ctx.db.query("part_index_status").collect();
  },
});

export type LookupResult = {
  part_number: string;
  part_number_normalized: string;
  verdict: ExistenceVerdict;
  /** Sources whose crawl produced this number. Empty unless verdict is "found". */
  sources: string[];
  url: string | null;
};

/**
 * THE ORACLE. For each submitted number: "found" (this make's fresh index
 * contains it), "absent" (this make's fresh index does NOT contain it — the
 * hallucination signal), or "no_index" (we have no standing to judge).
 *
 * Make resolution takes the FRESHEST successful source: partsdeal and revparts
 * are independent crawls of the same manufacturer catalog, so one completing is
 * enough to answer, and a second source failing must not revoke the first's
 * entitlement. The flip side is that a number carried only by a source that
 * failed reads as "absent" — which is why a source is only ever stamped "ok"
 * after every one of its child sitemaps was read.
 */
export const lookupPartNumbers = internalQuery({
  args: {
    make: v.string(),
    partNumbers: v.array(v.string()),
    maxAgeMs: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    make: string;
    index_status: string | null;
    index_age_ms: number | null;
    index_completed_at: number | null;
    indexed_sources: string[];
    results: LookupResult[];
  }> => {
    const make = normalizeMakeKey(args.make);
    const now = Date.now();

    const statuses = await ctx.db
      .query("part_index_status")
      .withIndex("by_make_source", (q) => q.eq("make", make))
      .collect();

    const completed = statuses
      .filter((s) => s.status === "ok" && typeof s.completed_at === "number")
      .sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0));

    // Representative status for the make: a completed crawl if there is one,
    // otherwise the most optimistic non-terminal state we can honestly report.
    // Only the "ok" branch can ever produce "absent".
    let indexStatus: string | null = null;
    let completedAt: number | null = null;
    if (completed.length > 0) {
      indexStatus = "ok";
      completedAt = completed[0].completed_at ?? null;
    } else if (statuses.some((s) => s.status === "running")) {
      indexStatus = "running";
    } else if (statuses.length > 0) {
      indexStatus = statuses[0].status;
    }
    const indexAgeMs = completedAt === null ? null : now - completedAt;

    const results: LookupResult[] = [];
    for (const raw of args.partNumbers.slice(0, MAX_LOOKUP_BATCH)) {
      const normalized = normalizeOemNumber(raw);
      // An unnormalizable input has no index key; it is not evidence of
      // absence, so it fails open like any other unknown.
      const rows =
        normalized.length === 0
          ? []
          : await ctx.db
              .query("part_url_index")
              .withIndex("by_make_part", (q) =>
                q.eq("make", make).eq("part_number_normalized", normalized),
              )
              .collect();
      const verdict =
        normalized.length === 0
          ? "no_index"
          : decideExistenceVerdict({
              indexStatus,
              foundInIndex: rows.length > 0,
              indexAgeMs,
              maxAgeMs: args.maxAgeMs,
            });
      results.push({
        part_number: raw,
        part_number_normalized: normalized,
        verdict,
        sources: verdict === "found" ? [...new Set(rows.map((r) => r.source))] : [],
        url: verdict === "found" ? (rows[0]?.url ?? null) : null,
      });
    }

    return {
      make,
      index_status: indexStatus,
      index_age_ms: indexAgeMs,
      index_completed_at: completedAt,
      indexed_sources: completed.map((s) => s.source),
      results,
    };
  },
});

// ============================================================================
// Ingestion
// ============================================================================

/** Cursor persisted in part_index_status.resume_state between action ticks. */
type ResumeState = {
  children: string[];
  next_index: number;
  url_count: number;
  part_count: number;
  sitemaps_processed: number;
  started_at: number;
};

function parseResumeState(raw: string | undefined | null): ResumeState | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as ResumeState;
    if (!Array.isArray(parsed.children) || typeof parsed.next_index !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export type IngestResult = {
  make: string;
  source: string;
  status: "ok" | "running" | "failed" | "dry_run";
  url_count: number;
  part_count: number;
  sitemaps_processed: number;
  sitemaps_total: number;
  error?: string;
};

/**
 * Crawl one (make, source) catalog into part_url_index.
 *
 * SELF-CONTINUING: one child sitemap per tick, then `ctx.scheduler.runAfter`
 * this same action `CRAWL_DELAY_MS` later with the cursor in `resume_state`.
 * That satisfies the crawl delay without burning action time asleep and makes
 * the 600s action cap structurally unable to truncate an ingest — a Toyota pass
 * is 17 ticks of ~30s each, not one 10-minute tick that dies at 600s and leaves
 * a half-index stamped "ok".
 *
 * FAILURE IS TERMINAL, NOT PARTIAL. If any child cannot be read (after one
 * retry) the run ends "failed" with the reason recorded. Rows already written
 * stay — they are true — but without an "ok"+completed_at stamp the oracle will
 * not fail closed on them, so an interrupted crawl degrades to "we don't know"
 * instead of inventing "absent" for the parts in the children we never reached.
 */
export const ingestPartIndex = internalAction({
  args: {
    make: v.string(),
    source: v.string(),
    maxSitemaps: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
    /** Internal — set only by this action rescheduling itself. */
    resumeState: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<IngestResult> => {
    const make = normalizeMakeKey(args.make);
    const source = args.source;
    const dryRun = args.dryRun === true;
    const base: IngestResult = {
      make,
      source,
      status: dryRun ? "dry_run" : "failed",
      url_count: 0,
      part_count: 0,
      sitemaps_processed: 0,
      sitemaps_total: 0,
    };

    const rootSpec = sourceRootFor(source, make);
    if (!rootSpec) {
      const error = `no sitemap root registered for source=${source} make=${make}`;
      console.warn(`[part-index] ${error}`);
      if (!dryRun) {
        await ctx.runMutation(selfApi().upsertPartIndexStatus, {
          make,
          source,
          status: "failed",
          last_error: error,
          started_at: Date.now(),
          clear_resume_state: true,
        });
      }
      return { ...base, status: "failed", error };
    }

    const failRun = async (error: string, state: ResumeState | null): Promise<IngestResult> => {
      console.warn(`[part-index] ${make}/${source} FAILED: ${error}`);
      if (!dryRun) {
        await ctx.runMutation(selfApi().upsertPartIndexStatus, {
          make,
          source,
          status: "failed",
          last_error: error,
          url_count: state?.url_count,
          part_count: state?.part_count,
          sitemaps_processed: state?.sitemaps_processed,
          started_at: state?.started_at,
          clear_resume_state: true,
        });
      }
      return {
        ...base,
        status: "failed",
        url_count: state?.url_count ?? 0,
        part_count: state?.part_count ?? 0,
        sitemaps_processed: state?.sitemaps_processed ?? 0,
        sitemaps_total: state?.children.length ?? 0,
        error,
      };
    };

    // ── Tick 1: read the sitemap index and lay out the work ────────────────
    let state = parseResumeState(args.resumeState);
    if (!state) {
      const indexXml = await fetchSitemap(rootSpec.root, SITEMAP_INDEX_TIMEOUT_MS);
      if (indexXml === null) {
        return await failRun(`sitemap index unreachable: ${rootSpec.root}`, null);
      }
      let children = selectChildSitemaps(indexXml, rootSpec.childPattern);
      if (children.length === 0) {
        // A root that parses but yields no product children means the shape
        // changed under us. Refusing to proceed is the point: an empty crawl
        // stamped "ok" would answer "absent" to every part number alive.
        return await failRun(
          `sitemap index ${rootSpec.root} yielded 0 product children (${extractSitemapLocs(indexXml).length} locs total)`,
          null,
        );
      }
      if (typeof args.maxSitemaps === "number" && args.maxSitemaps > 0) {
        children = children.slice(0, args.maxSitemaps);
      }
      state = {
        children,
        next_index: 0,
        url_count: 0,
        part_count: 0,
        sitemaps_processed: 0,
        started_at: Date.now(),
      };
      if (!dryRun) {
        await ctx.runMutation(selfApi().upsertPartIndexStatus, {
          make,
          source,
          status: "running",
          url_count: 0,
          part_count: 0,
          sitemaps_processed: 0,
          started_at: state.started_at,
          resume_state: JSON.stringify(state),
          clear_last_error: true,
        });
      }
      console.log(
        `[part-index] ${make}/${source} start: ${children.length} child sitemap(s)` +
          (dryRun ? " (DRY RUN)" : ""),
      );
    }

    // ── Process children. A live run does exactly one per tick (crawl delay
    //    lives in the reschedule); a dry run walks its capped list inline. ──
    const perTick = dryRun ? state.children.length : 1;
    for (let n = 0; n < perTick && state.next_index < state.children.length; n++) {
      const childUrl = state.children[state.next_index];
      if (n > 0) await new Promise((r) => setTimeout(r, CRAWL_DELAY_MS));

      let xml = await fetchSitemap(childUrl, SITEMAP_CHILD_TIMEOUT_MS);
      if (xml === null) {
        // One retry after a full crawl delay — a single 429/blip should not
        // discard a crawl that is 16 children deep.
        await new Promise((r) => setTimeout(r, CRAWL_DELAY_MS));
        xml = await fetchSitemap(childUrl, SITEMAP_CHILD_TIMEOUT_MS);
      }
      if (xml === null) {
        return await failRun(`child sitemap unreachable after retry: ${childUrl}`, state);
      }

      const collected = collectPartNumbersFromSitemap(xml, source);
      state.url_count += collected.urlCount;
      state.next_index++;
      state.sitemaps_processed++;

      if (!dryRun) {
        const fetchedAt = Date.now();
        for (let i = 0; i < collected.parts.length; i += WRITE_BATCH_SIZE) {
          const slice = collected.parts.slice(i, i + WRITE_BATCH_SIZE);
          const { inserted }: { inserted: number; skipped: number } = await ctx.runMutation(
            selfApi().writePartIndexBatch,
            {
              make,
              source,
              fetched_at: fetchedAt,
              parts: slice.map((p) => ({
                part_number_normalized: p.normalized,
                part_number_raw: p.raw,
                url: p.url,
              })),
            },
          );
          state.part_count += inserted;
        }
      } else {
        state.part_count += collected.parts.length;
      }

      console.log(
        `[part-index] ${make}/${source} child ${state.next_index}/${state.children.length}: ` +
          `${collected.urlCount} urls, ${collected.parts.length} distinct parts, ` +
          `${collected.unparsed} unparsed (running total: ${state.part_count})`,
      );
    }

    const done = state.next_index >= state.children.length;

    if (dryRun) {
      return {
        ...base,
        status: "dry_run",
        url_count: state.url_count,
        part_count: state.part_count,
        sitemaps_processed: state.sitemaps_processed,
        sitemaps_total: state.children.length,
      };
    }

    if (!done) {
      await ctx.runMutation(selfApi().upsertPartIndexStatus, {
        make,
        source,
        status: "running",
        url_count: state.url_count,
        part_count: state.part_count,
        sitemaps_processed: state.sitemaps_processed,
        started_at: state.started_at,
        resume_state: JSON.stringify(state),
      });
      await ctx.scheduler.runAfter(CRAWL_DELAY_MS, selfApi().ingestPartIndex, {
        make,
        source,
        maxSitemaps: args.maxSitemaps,
        resumeState: JSON.stringify(state),
      });
      return {
        ...base,
        status: "running",
        url_count: state.url_count,
        part_count: state.part_count,
        sitemaps_processed: state.sitemaps_processed,
        sitemaps_total: state.children.length,
      };
    }

    const completedAt = Date.now();
    await ctx.runMutation(selfApi().upsertPartIndexStatus, {
      make,
      source,
      status: "ok",
      url_count: state.url_count,
      part_count: state.part_count,
      sitemaps_processed: state.sitemaps_processed,
      started_at: state.started_at,
      completed_at: completedAt,
      clear_resume_state: true,
      clear_last_error: true,
    });
    console.log(
      `[part-index] ${make}/${source} OK: ${state.url_count} urls across ` +
        `${state.sitemaps_processed} sitemaps → ${state.part_count} new part numbers`,
    );
    return {
      ...base,
      status: "ok",
      url_count: state.url_count,
      part_count: state.part_count,
      sitemaps_processed: state.sitemaps_processed,
      sitemaps_total: state.children.length,
    };
  },
});

/**
 * Weekly sweep: re-crawl every (make, source) pair that has ever been indexed.
 * Scoped to existing part_index_status rows on purpose — the cron discovers no
 * new makes, it only keeps what someone deliberately ingested from going stale
 * past the 30-day window that entitles the oracle to fail closed.
 *
 * Pairs already "running" are skipped unless their run has clearly died (no
 * progress for STALE_RUNNING_MS), so a self-continuing crawl in flight is never
 * given a competing head. Each pair starts on its own stagger so two catalogs
 * are never being fetched at the same instant.
 */
const STALE_RUNNING_MS = 6 * 60 * 60 * 1000;
const REFRESH_STAGGER_MS = 5 * 60 * 1000;

export const refreshIndexedMakes = internalAction({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ scheduled: number; skipped: number }> => {
    try {
      const limit = args.limit ?? 10;
      const rows: Array<{
        make: string;
        source: string;
        status: string;
        started_at: number;
        completed_at?: number;
      }> = await ctx.runQuery(selfApi().allPartIndexStatuses, {});

      const now = Date.now();
      let scheduled = 0;
      let skipped = 0;
      for (const row of rows) {
        if (scheduled >= limit) break;
        if (row.status === "running" && now - row.started_at < STALE_RUNNING_MS) {
          skipped++;
          continue;
        }
        if (!sourceRootFor(row.source, row.make)) {
          skipped++;
          continue;
        }
        await ctx.scheduler.runAfter(scheduled * REFRESH_STAGGER_MS, selfApi().ingestPartIndex, {
          make: row.make,
          source: row.source,
        });
        scheduled++;
      }
      console.log(`[part-index] weekly refresh scheduled=${scheduled} skipped=${skipped}`);
      return { scheduled, skipped };
    } catch (e) {
      console.warn("[part-index] refreshIndexedMakes failed:", e);
      return { scheduled: 0, skipped: 0 };
    }
  },
});
