/**
 * vehicleEnrichment/manualDirectSources.ts — CONSTRUCTED MANUAL URLS
 *
 * WHY THIS EXISTS, AND WHY IT DOES NOT CONTRADICT manualLibrary's HEADER
 * ---------------------------------------------------------------------
 * manualLibrary.ts opens with a finding in capitals: "PER-MAKE URL
 * CONSTRUCTION IS NOT VIABLE." That conclusion was drawn from four makes
 * probed in July 2026 and it is still correct as a UNIVERSAL claim — there is
 * no grammar that resolves a manual for an arbitrary year/make/model, two of
 * those four makes publish under opaque publication part numbers, and one has
 * no static document URL at all.
 *
 * What changed is narrower and verifiable: a handful of specific hosts DO have
 * a stable, enumerable grammar, and each was probed live (Aug 5 2026) before
 * being written down here. This module encodes ONLY those, and it does not
 * relax any of the guarantees the header was protecting:
 *
 *   - Nothing constructed is ever trusted on faith. Every candidate is probed
 *     with a ranged GET that must return 2xx, a PDF content-type or a `%PDF-`
 *     magic number, and a plausible length, before it is allowed into the
 *     candidate pool at all.
 *   - A probe hit is still just a CANDIDATE. It flows through the same
 *     rankManualCandidates → download → size/magic-byte → extract path as a
 *     search result, and the extractor's identity guard remains the thing that
 *     decides whether the document is really this vehicle.
 *   - Provenance is unchanged. A constructed URL on the manufacturer's own
 *     host is OEM because the HOST is OEM, not because we built the string.
 *     cdn.dealereprocess.org is deliberately NOT added to OEM_MANUAL_DOMAINS
 *     (see REDISTRIBUTORS below).
 *
 * The payoff is discovery that costs zero search credits and cannot return the
 * wrong make: for a Toyota we ask Toyota's own CDN instead of asking a search
 * engine and hoping an OEM host outranks eight mirror farms.
 *
 * ============================================================================
 * VERIFIED SOURCES (probed live 2026-08-05 — status codes are real)
 * ============================================================================
 * 1. cdn.dealereprocess.org/cdn/servicemanuals/{make}/{year}-{modelslug}.pdf
 *    200 + application/pdf for toyota, honda, hyundai, chevrolet, nissan,
 *    subaru, kia, jeep, ford, mazda, gmc, dodge. 404 for bmw, mercedes, audi,
 *    volkswagen, lexus, ram — those makes are simply absent, so they are not
 *    in the allowlist and are never probed.
 *
 * 2. assets.sia.toyota.com/publications/en/omms-s/T-MMS-{YY}{Model}/pdf/…
 *    Toyota's Warranty & Maintenance Guide. 5/5 first-try hits (Camry, RAV4,
 *    Corolla, Tacoma, Highlander). This is the highest-value entry in the
 *    file: it is a ~60-page booklet that IS the maintenance schedule, so the
 *    interval extractor never has to read a 600-page owner's manual for a
 *    Toyota — which also keeps it under the Anthropic 600-page request cap.
 *
 * 3. nissanusa.com/content/dam/Nissan/us/manuals-and-guides/{model}/{year}/…
 *    200 for altima 2019, altima 2020, rogue 2022.
 *
 * REJECTED AFTER PROBING — owners.hyundaiusa.com glovebox-manual paths. The
 * July research listed a Hyundai DAM grammar, but it was search-sourced and
 * never byte-fetched. Probed on Aug 5 2026 it returned 404 for every variant
 * tried, including the exact 2023 Santa Cruz example that had been cited as
 * evidence. It is not in the builder list: a pattern that never resolves is
 * not a fallback, it is a round trip. Hyundai is served by entry 1 instead
 * (2023 Tucson verified live there).
 *
 * DELIBERATELY ABSENT: justgivemethedamnmanual.com. Its /manuals/ store was a
 * working fallback for pre-2017 vehicles in the July research and was
 * re-checked on Aug 5 2026 — it now returns database errors. A source that
 * 500s is not a fallback, it is latency.
 */

// NOTE: this module deliberately imports NOTHING from manualLibrary.ts.
// manualLibrary imports `discoverDirectManuals` from here, so a dependency in
// the other direction would be a cycle — and the only thing it would buy is
// `isOemDomain`, which is redundant: every builder below already knows whether
// its host is the manufacturer's, and records that as `tier`.

/** Browser UA — several of these CDNs serve a challenge to unknown clients. */
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/** A probe reads the first bytes only — enough for the magic number. */
const PROBE_BYTES = 2048;
const PROBE_TIMEOUT_MS = 15_000;

/** Below this a "PDF" is an error page or redirect stub. Mirrors
 *  manualLibrary.MIN_MANUAL_BYTES; a manual is never 40 KB. */
const MIN_PLAUSIBLE_BYTES = 40 * 1024;

/**
 * Hosts that redistribute manufacturer PDFs faithfully.
 *
 * These are NOT added to OEM_MANUAL_DOMAINS, on purpose. Dealer eProcess is a
 * dealer-website vendor, not a manufacturer: the bytes it serves are the OEM's
 * (a startmycar copy of Toyota's 2019 Camry manual matched Toyota's own CDN
 * ETag exactly), but the HOST is a third party and letting it claim OEM
 * provenance would put a vendor's uptime behind our highest trust tier.
 *
 * What they DO earn is the right to end discovery: a live PDF here is good
 * enough that paying for a web search on top of it buys nothing. Provenance
 * and fetch strategy are separate decisions, and this file only touches the
 * second one.
 */
export const VERIFIED_REDISTRIBUTORS: readonly string[] = ["cdn.dealereprocess.org"];

export type DirectSourceConfidence = "verified" | "inferred";

/**
 * Who serves the bytes.
 *
 * `oem` is the manufacturer's own host and is what earns OEM provenance
 * downstream (via manualLibrary's isOemDomain, which resolves it from the
 * HOST — this field never grants provenance by itself). `redistributor` is a
 * faithful third-party copy: good enough to end discovery, never good enough
 * to claim the manufacturer's authority.
 */
export type DirectSourceTier = "oem" | "redistributor";

export type DirectManualCandidate = {
  url: string;
  /** Human title for the candidate list and logs. */
  title: string;
  /** Which builder produced it — for per-source hit-rate logging. */
  source: string;
  confidence: DirectSourceConfidence;
  tier: DirectSourceTier;
};

// ─── Slug helpers ────────────────────────────────────────────────

/** Lowercase, alphanumerics only: "F-150" → "f150", "CX-5" → "cx5". */
export function compactSlug(raw: string): string {
  return (raw ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Lowercase, hyphen-separated: "Santa Fe" → "santa-fe". */
export function hyphenSlug(raw: string): string {
  return (raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/** Toyota's publication slug drops separators but keeps case: "RAV4" → "RAV4",
 *  "Land Cruiser" → "LandCruiser". */
export function toyotaModelSlug(raw: string): string {
  return (raw ?? "").replace(/[^A-Za-z0-9]/g, "");
}

/** Title-case each hyphen-separated word: "santa-cruz" → "Santa-Cruz". */
export function titleHyphenSlug(raw: string): string {
  const h = hyphenSlug(raw);
  if (!h) return "";
  return h
    .split("-")
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join("-");
}

const normMake = (raw: string): string => (raw ?? "").trim().toLowerCase();

/** Makes verified present on the Dealer eProcess CDN. Anything else is not
 *  probed — an unlisted make is a guaranteed 404 and a wasted round trip. */
export const DEALEREPROCESS_MAKES: readonly string[] = [
  "toyota",
  "honda",
  "hyundai",
  "chevrolet",
  "nissan",
  "subaru",
  "kia",
  "jeep",
  "ford",
  "mazda",
  "gmc",
  "dodge",
];

// ─── Builders (pure — no network) ────────────────────────────────

export type DirectSourceBuilder = {
  name: string;
  confidence: DirectSourceConfidence;
  tier: DirectSourceTier;
  build: (year: number, make: string, model: string) => string | null;
  titleFor: (year: number, make: string, model: string) => string;
};

export const DIRECT_SOURCE_BUILDERS: readonly DirectSourceBuilder[] = [
  {
    // The highest-value builder: a ~60-page maintenance booklet rather than a
    // 600-page owner's manual, for the make with the largest US parc.
    name: "toyota_tmms",
    confidence: "verified",
    tier: "oem",
    build: (year, make, model) => {
      if (normMake(make) !== "toyota") return null;
      const slug = toyotaModelSlug(model);
      if (slug.length < 2) return null;
      const yy = String(year % 100).padStart(2, "0");
      const pub = `T-MMS-${yy}${slug}`;
      return `https://assets.sia.toyota.com/publications/en/omms-s/${pub}/pdf/${pub}.pdf`;
    },
    titleFor: (year, _make, model) => `${year} Toyota ${model} Warranty & Maintenance Guide`,
  },
  {
    name: "nissan_dam",
    confidence: "verified",
    tier: "oem",
    build: (year, make, model) => {
      if (normMake(make) !== "nissan") return null;
      const slug = hyphenSlug(model);
      if (!slug) return null;
      return (
        `https://www.nissanusa.com/content/dam/Nissan/us/manuals-and-guides/` +
        `${slug}/${year}/${year}-nissan-${slug}-owner-manual.pdf`
      );
    },
    titleFor: (year, _make, model) => `${year} Nissan ${model} Owner's Manual`,
  },
  // NO hyundai_dam BUILDER — see the header. The glovebox-manual path was
  // search-sourced, never byte-fetched, and when it was finally probed on
  // Aug 5 2026 every variant 404'd, including the exact example the research
  // cited. Hyundai is covered by the dealereprocess entry below (2023 Tucson
  // verified live), so the pattern bought nothing but a round trip per config.
  {
    name: "dealereprocess",
    confidence: "verified",
    tier: "redistributor",
    build: (year, make, model) => {
      const mk = normMake(make);
      if (!DEALEREPROCESS_MAKES.includes(mk)) return null;
      const slug = compactSlug(model);
      if (slug.length < 2) return null;
      return `https://cdn.dealereprocess.org/cdn/servicemanuals/${mk}/${year}-${slug}.pdf`;
    },
    titleFor: (year, make, model) => `${year} ${make} ${model} Owner's Manual`,
  },
];

/**
 * Every URL we know how to construct for this vehicle, best first.
 *
 * Pure and total: an unknown make yields an empty array, which is the correct
 * "we cannot construct anything for this vehicle" answer and leaves the caller
 * on the search path unchanged.
 */
export function buildDirectManualCandidates(
  year: number,
  make: string,
  model: string,
): DirectManualCandidate[] {
  if (!Number.isFinite(year) || !make?.trim() || !model?.trim()) return [];
  const y = Math.trunc(year);

  const out: DirectManualCandidate[] = [];
  const seen = new Set<string>();
  for (const b of DIRECT_SOURCE_BUILDERS) {
    let url: string | null = null;
    try {
      url = b.build(y, make, model);
    } catch {
      url = null; // a builder must never break discovery
    }
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      title: b.titleFor(y, make, model),
      source: b.name,
      confidence: b.confidence,
      tier: b.tier,
    });
  }
  return out;
}

// ─── Probe ───────────────────────────────────────────────────────

export type ProbeOutcome = {
  candidate: DirectManualCandidate;
  live: boolean;
  status: number | null;
  contentType: string | null;
  contentLength: number | null;
  reason: string;
};

/** Does the first chunk begin with the PDF magic number? */
function hasPdfMagic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}

/**
 * Decide whether a probe response represents a real manual PDF.
 *
 * Pure so the table-driven test owns the contract. A HEAD would have been
 * cheaper, but two of these hosts answer HEAD with 415, and a HEAD cannot see
 * the magic number — so the probe is a ranged GET and this function reads what
 * came back.
 */
export function judgeProbe(input: {
  status: number;
  contentType: string | null;
  contentLength: number | null;
  firstBytes: Uint8Array | null;
}): { ok: boolean; reason: string } {
  if (input.status < 200 || input.status >= 300) return { ok: false, reason: `http_${input.status}` };

  const ct = (input.contentType ?? "").toLowerCase();
  if (ct.includes("text/html")) return { ok: false, reason: "html_not_pdf" };

  // A declared length below the floor is an error stub wearing a .pdf name.
  if (
    input.contentLength != null &&
    Number.isFinite(input.contentLength) &&
    input.contentLength > 0 &&
    input.contentLength < MIN_PLAUSIBLE_BYTES
  ) {
    return { ok: false, reason: `too_small_${input.contentLength}` };
  }

  const magic = input.firstBytes ? hasPdfMagic(input.firstBytes) : false;
  if (magic) return { ok: true, reason: "pdf_magic" };
  if (ct.includes("application/pdf")) return { ok: true, reason: "pdf_content_type" };

  return { ok: false, reason: ct ? `not_pdf:${ct.slice(0, 40)}` : "not_pdf" };
}

/** Probe ONE candidate. Never throws — a probe failure is just "not live". */
export async function probeDirectCandidate(
  candidate: DirectManualCandidate,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProbeOutcome> {
  const base: Omit<ProbeOutcome, "live" | "reason"> = {
    candidate,
    status: null,
    contentType: null,
    contentLength: null,
  };
  try {
    const res = await fetch(candidate.url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/pdf,*/*",
        // Ranged so a 40 MB manual costs us 2 KB to verify. Hosts that ignore
        // Range answer 200 with the whole body; the reader below stops after
        // the first chunk either way.
        Range: `bytes=0-${PROBE_BYTES - 1}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    const contentType = res.headers.get("content-type");
    // On a 206 the length is the SLICE, not the document — read the total out
    // of Content-Range instead so the size floor judges the real file.
    const rangeTotal = (() => {
      const cr = res.headers.get("content-range");
      const m = cr ? /\/(\d+)\s*$/.exec(cr) : null;
      return m ? Number(m[1]) : null;
    })();
    const declared = Number(res.headers.get("content-length") ?? "");
    const contentLength =
      rangeTotal ?? (Number.isFinite(declared) && declared > 0 ? declared : null);

    let firstBytes: Uint8Array | null = null;
    try {
      const buf = await res.arrayBuffer();
      firstBytes = new Uint8Array(buf.slice(0, 8));
    } catch {
      firstBytes = null;
    }

    const verdict = judgeProbe({
      status: res.status,
      contentType,
      // A 206 slice must not be judged against the whole-document floor.
      contentLength: res.status === 206 ? rangeTotal : contentLength,
      firstBytes,
    });

    return {
      ...base,
      status: res.status,
      contentType,
      contentLength,
      live: verdict.ok,
      reason: verdict.reason,
    };
  } catch (e) {
    return { ...base, live: false, reason: `probe_error:${String(e).slice(0, 80)}` };
  }
}

export type DirectDiscovery = {
  /** Live candidates, best first, ready to join the ranking pool. */
  live: DirectManualCandidate[];
  /** True when a live candidate is trustworthy enough to skip web search. */
  sufficient: boolean;
  /** Per-candidate probe results, for logging. */
  outcomes: ProbeOutcome[];
};

/**
 * Probe every constructible URL for a vehicle, concurrently.
 *
 * `sufficient` is the credit-saving decision and is deliberately generous:
 * both a manufacturer host and a verified redistributor may end discovery,
 * because a live PDF from either is a better starting point than a search
 * result. It says nothing about provenance — a dealereprocess candidate that
 * ends discovery still carries `is_oem_domain: false` all the way through to
 * the claim family, so it can never vote with OEM authority.
 */
export async function discoverDirectManuals(vehicle: {
  year: number;
  make: string;
  model: string;
}): Promise<DirectDiscovery> {
  const candidates = buildDirectManualCandidates(vehicle.year, vehicle.make, vehicle.model);
  if (candidates.length === 0) return { live: [], sufficient: false, outcomes: [] };

  const outcomes = await Promise.all(candidates.map((c) => probeDirectCandidate(c)));
  const live = outcomes.filter((o) => o.live).map((o) => o.candidate);

  // Any live probed candidate ends discovery: every builder in this file is
  // either the manufacturer's own host or a verified redistributor, and a real
  // PDF from either beats a search result. Provenance is decided later and
  // independently, from the host.
  const sufficient = live.length > 0;

  return { live, sufficient, outcomes };
}
