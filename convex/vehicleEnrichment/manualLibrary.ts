/**
 * vehicleEnrichment/manualLibrary.ts — OEM MANUAL LIBRARY (P2.2)
 *
 * WHY THIS EXISTS
 * ---------------
 * Maintenance intervals were 26% `default_fallback` with months only 32%
 * filled because the ONLY manual source was `scrapeManual` in scraper.ts —
 * two broad web searches returning 3 markdown-converted results each. The
 * real schedules live in the manufacturers' own PDFs. This module makes those
 * PDFs the source of truth for OEM-BACKED intervals: discover → download →
 * upload to the Anthropic Files API → extract with a native PDF document
 * block + citations → write `service_intervals` at data_quality "oem_manual".
 *
 * ============================================================================
 * DISCOVERY RESEARCH — VERIFIED vs INFERRED (2026-07-30)
 * ============================================================================
 * Four makes were probed live (WebFetch/WebSearch) before the allowlist was
 * written. The headline finding drove the whole design:
 *
 *   >>> PER-MAKE URL CONSTRUCTION IS NOT VIABLE. <<<
 *   No two makes share a manual URL grammar, two of the four probed makes
 *   publish under opaque publication part numbers, and one is behind a
 *   JS/login portal with no static document URL at all. Discovery is
 *   therefore SEARCH-FIRST (Firecrawl `searchAndFetch`) with the OEM
 *   allowlist used to CLASSIFY and RANK what search returns — never to
 *   synthesize a URL. A synthesized URL that 404s or, worse, resolves to the
 *   wrong model year is exactly the "present-but-wrong" failure the pipeline
 *   law forbids.
 *
 * TOYOTA — 2020 Camry — VERIFIED (byte-level)
 *   Portal page:  https://www.toyota.com/owners/warranty-owners-manuals/vehicle/{model}/{year}/
 *   Schedule PDF: https://assets.sia.toyota.com/publications/en/omms-s/T-MMS-20CamryAWD/pdf/T-MMS-20CamryAWD.pdf
 *   VERIFIED: that PDF URL is live and returned a 1.1 MB application/pdf body.
 *   Toyota is the ONE make that publishes a standalone "Warranty &
 *   Maintenance Guide" (the `omms-s` / `T-MMS-` path) separate from the
 *   500-page owner's manual — which is exactly the doc_kind we want, and why
 *   `maintenance_schedule` outranks `owners_manual` in the ranker.
 *   INFERRED (NOT verified): that the `T-MMS-{YY}{Model}{Drivetrain}` slug
 *   generalizes to other Toyota models. The "AWD" suffix on the Camry proves
 *   the slug carries trim/drivetrain qualifiers we cannot derive, so we never
 *   build it — we let search find it and check the host.
 *
 * FORD — 2019 F-150 — VERIFIED (search index), byte-fetch TIMED OUT
 *   Portal page:  https://www.ford.com/support/vehicle/f150/2019/owner-manuals/
 *   Manual PDF:   https://www.fordservicecontent.com/Ford_Content/Catalog/owner_information/
 *                   2019-Ford-F-150-Owners-Manual-version-1_om-EN-US_09_2018.pdf
 *   VERIFIED: both URLs are present in the live search index with those exact
 *   shapes. NOT VERIFIED: the PDF body — a 60 s WebFetch against
 *   fordservicecontent.com timed out (a ~14.8 MB / 644-page document on a slow
 *   host). Two design consequences, both real: the download abort is 60 s and
 *   FAILURES ARE CACHED NEGATIVELY so we do not re-pay for a slow host daily.
 *   KEY ALLOWLIST FINDING: Ford's PDFs are NOT on ford.com. `fordservicecontent.com`
 *   is a separate Ford-owned host. An allowlist of "the brand's dot-com" would
 *   classify Ford's own manual as third-party. Every make's entry therefore
 *   lists its content/CDN hosts too.
 *
 * HONDA — 2021 CR-V — VERIFIED NEGATIVE
 *   https://owners.honda.com/vehicles/information/2021/CR-V/manuals
 *     → HTTP 302 → https://mygarage.honda.com/s/find-honda
 *   VERIFIED: that redirect fires, and the destination is a Salesforce
 *   single-page app that returns only a loading shell to a non-JS client.
 *   There is NO constructible manual URL for Honda and no server-rendered
 *   index to crawl. Honda is fully search-dependent, and its manuals will
 *   usually surface on third-party mirrors — which is precisely why
 *   `is_oem_domain` is stored per row rather than assumed, and why a
 *   non-OEM candidate is still allowed to win when nothing OEM exists (it
 *   just never gets to claim OEM provenance).
 *
 * SUBARU — 2022 Crosstrek — VERIFIED (live, oversized)
 *   Manual PDF:   https://techinfo.subaru.com/stis/doc/ownerManual/MSA5M2207A_STIS-Opt.pdf
 *   VERIFIED: live — the fetch aborted on a >10 MB content-length cap, i.e.
 *   the URL resolves and serves a large PDF. INFERRED: nothing. `MSA5M2207A`
 *   is a Subaru publication part number; it is NOT derivable from
 *   year/make/model, confirming the search-first design. Note the host is
 *   `techinfo.subaru.com` (the STIS technical-information system), not
 *   www.subaru.com — another host that a naive dot-com allowlist would miss.
 *   Also the reason the size guard is 30 MB rather than something tighter:
 *   real OEM owner's manuals routinely exceed 10 MB.
 *
 * ALL OTHER MAKES in OEM_MANUAL_DOMAINS below are INFERRED from published
 * brand owner-portal hostnames and were NOT probed. They are used only for
 * classification (is this host the manufacturer's?), never to build a URL, so
 * an inferred-wrong entry costs us a provenance downgrade, not bad data.
 *
 * ============================================================================
 * STRUCTURED OUTPUT vs CITATIONS — a deliberate API choice
 * ============================================================================
 * The task asks for citations AND a structured-output schema. Per the platform
 * docs, `citations: {enabled: true}` is INCOMPATIBLE with
 * `output_config.format` — that combination returns a 400. So the schema is
 * carried as a TOOL input_schema (`tool_choice: {type:"tool"}`), built in the
 * exact style of utils/batchSchemas.ts (`additionalProperties: false`,
 * `anyOf`-nullable leaves, explicit `required`), which is compatible with
 * citations. `strict: true` is deliberately NOT set: strict tool use is not
 * available on every model `resolveExtractionModel` may return (notably
 * claude-sonnet-4-6, the current default), and a 400 on the extraction call
 * would cost us the whole manual. The shape is enforced by `parseManualIntervals`
 * instead, which drops anything malformed rather than storing a guess.
 *
 * ============================================================================
 * PIPELINE LAW
 * ============================================================================
 * FAIL OPEN: every network path returns null / writes a failure_reason and
 * never throws. PRESENT-BUT-WRONG IS FORBIDDEN: a body without a %PDF- magic
 * number is never uploaded; an interval without a positive miles-or-months is
 * never written; a row already at `deterministic`/`oem_manual` is never
 * downgraded; a mechanic-verified row is never touched.
 *
 * Wire-in points:
 *   - internal.vehicleEnrichment.manualLibrary.resolveManualForVehicle
 *   - internal.vehicleEnrichment.manualLibrary.extractIntervalsFromManual
 *   - internal.vehicleEnrichment.manualLibrary.backfillManualIntervals  (daily cron)
 */

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { searchAndFetch } from "./firecrawl";
import { resolveExtractionModel } from "./utils/enrichmentFlags";

// This module is new — `internal.vehicleEnrichment.manualLibrary` is absent
// from _generated/api.d.ts until `npx convex dev` regenerates it. Same pattern
// as nhtsaOdi.ts's selfApi(); tighten after codegen.
const selfApi = () => (internal as any).vehicleEnrichment.manualLibrary;

// ─── Tunables ────────────────────────────────────────────────────

const ANTHROPIC_API_BASE = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";
/** Files API beta — required on BOTH the upload and any messages call that
 *  references the returned file_id. */
const FILES_API_BETA = "files-api-2025-04-14";

/** Per the task spec: the PDF download aborts at 60s. */
const PDF_DOWNLOAD_TIMEOUT_MS = 60_000;
/** Upload is a second network hop over the same bytes; give it more room. */
const FILE_UPLOAD_TIMEOUT_MS = 120_000;
const EXTRACTION_TIMEOUT_MS = 180_000;

/** Skip anything above this — the Messages API request cap is 32 MB and a
 *  larger body is a mirror site's bundle, not a manual. */
export const MAX_MANUAL_BYTES = 30 * 1024 * 1024;
/** Below this a "PDF" is an error page or a redirect stub, not a manual. */
export const MIN_MANUAL_BYTES = 40 * 1024;

/** Negative caching: a failed (make, model, year) is not retried for this long. */
export const MANUAL_FAILURE_TTL_DAYS = 14;

/** How many candidate PDFs may be rejected for one vehicle before we stop
 *  paying for uploads and accept an honest gap. Each rejection costs a
 *  multi-MB download plus a Files API upload plus an extraction. */
export const MANUAL_MAX_REJECTIONS = 3;
/** A stored manual is re-resolved once it is older than this. */
export const MANUAL_REFRESH_DAYS = 180;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Gap between scheduled per-config manual jobs in the backfill sweep. Each
 *  job is a multi-MB download + a large-context Claude call, so keep it slow. */
const BACKFILL_STAGGER_MS = 90_000;
/** Configs per nightly cron run. Every one costs a PDF upload + an extraction
 *  call, so the default is deliberately tiny. Override with
 *  MANUAL_LIBRARY_DAILY_LIMIT (0 disables the cron entirely). */
export const DEFAULT_BACKFILL_LIMIT = 3;
/** Pages of vehicle_configs the backfill query will scan looking for gaps. */
const BACKFILL_SCAN_PAGE_SIZE = 200;

// ============================================================================
// Pure helpers (exported for tests — no ctx, no fetch)
// ============================================================================

/** Lowercase/trim/collapse a make or model name into a comparison key. */
export function normalizeMakeKey(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Hostname of a URL, lowercased with a leading `www.` stripped.
 * Returns null for anything unparseable (fail open — an unparseable URL is
 * simply never classified OEM).
 */
export function hostnameOf(url: string | null | undefined): string | null {
  if (typeof url !== "string" || url.trim().length === 0) return null;
  try {
    return new URL(url.trim()).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Per-make manufacturer-owned domains.
 *
 * These are CLASSIFICATION inputs only — nothing here is ever concatenated
 * into a URL (see the research header: URL construction is not viable).
 * Each entry lists the brand's owner portal AND its content/CDN hosts,
 * because on two of the four probed makes the actual PDF lives on a
 * non-brand-dot-com host (fordservicecontent.com, techinfo.subaru.com,
 * assets.sia.toyota.com).
 *
 * Matching is suffix-based, so "assets.sia.toyota.com" matches the
 * "toyota.com" entry and a bare "toyota.com" entry covers every subdomain.
 */
export const OEM_MANUAL_DOMAINS: Record<string, readonly string[]> = {
  // ── VERIFIED live (see header) ──
  toyota: ["toyota.com", "assets.sia.toyota.com", "techinfo.toyota.com"],
  ford: ["ford.com", "fordservicecontent.com", "owner.ford.com", "fordtechservice.dealerconnection.com"],
  honda: ["honda.com", "owners.honda.com", "mygarage.honda.com", "techinfo.honda.com"],
  subaru: ["subaru.com", "techinfo.subaru.com"],

  // ── INFERRED from published owner-portal hostnames (not probed) ──
  lexus: ["lexus.com", "drivers.lexus.com", "techinfo.lexus.com"],
  acura: ["acura.com", "owners.acura.com", "techinfo.acura.com"],
  chevrolet: ["chevrolet.com", "my.chevrolet.com", "gmc.com", "gm.com", "helminc.com"],
  gmc: ["gmc.com", "my.gmc.com", "gm.com"],
  buick: ["buick.com", "my.buick.com", "gm.com"],
  cadillac: ["cadillac.com", "my.cadillac.com", "gm.com"],
  hyundai: ["hyundaiusa.com", "owners.hyundaiusa.com", "hyundai.com"],
  kia: ["kia.com", "owners.kia.com", "kiatechinfo.com"],
  genesis: ["genesis.com", "genesismotorsamerica.com"],
  nissan: ["nissanusa.com", "owners.nissanusa.com", "nissan-techinfo.com"],
  infiniti: ["infinitiusa.com", "owners.infinitiusa.com"],
  mazda: ["mazdausa.com", "owners.mazdausa.com", "mazda.com"],
  mitsubishi: ["mitsubishicars.com", "mitsubishi-motors.com"],
  volkswagen: ["vw.com", "volkswagen.com", "erwin.volkswagen.de"],
  audi: ["audiusa.com", "my.audiusa.com", "audi.com"],
  porsche: ["porsche.com", "my.porsche.com"],
  bmw: ["bmwusa.com", "bmw.com", "aos.bmwusa.com"],
  mini: ["miniusa.com", "mini.com"],
  "mercedes-benz": ["mbusa.com", "mercedes-benz.com", "moba.i.mercedes-benz.com"],
  mercedes: ["mbusa.com", "mercedes-benz.com"],
  volvo: ["volvocars.com", "volvocars.us"],
  jaguar: ["jaguarusa.com", "jaguar.com", "topix.jaguar.jlrext.com"],
  "land rover": ["landroverusa.com", "landrover.com", "topix.landrover.jlrext.com"],
  jeep: ["jeep.com", "mopar.com", "moparownerconnect.com"],
  ram: ["ramtrucks.com", "mopar.com", "moparownerconnect.com"],
  dodge: ["dodge.com", "mopar.com", "moparownerconnect.com"],
  chrysler: ["chrysler.com", "mopar.com", "moparownerconnect.com"],
  fiat: ["fiatusa.com", "mopar.com"],
  alfa: ["alfaromeousa.com", "mopar.com"],
  "alfa romeo": ["alfaromeousa.com", "mopar.com"],
  tesla: ["tesla.com"],
  rivian: ["rivian.com"],
  lucid: ["lucidmotors.com"],
  polestar: ["polestar.com"],
  lincoln: ["lincoln.com", "fordservicecontent.com", "owner.lincoln.com"],
  buickgmc: ["gm.com"],
};

/**
 * Hosts that republish manufacturer PDFs. They are NOT blocked — a mirror is
 * often the only reachable copy (Honda: verified no static OEM URL exists) —
 * but they can never claim OEM provenance and are ranked below everything else.
 */
export const MANUAL_MIRROR_DOMAINS: readonly string[] = [
  "scribd.com",
  "manualslib.com",
  "manualsdir.com",
  "manual-directory.com",
  "manuals.plus",
  "ownersman.com",
  "ownersmanuals2.com",
  "submanuals.com",
  "carmanualsonline.info",
  "carmans.net",
  "vincheck.info",
  "startmycar.com",
  "dealereprocess.org",
  "oemdtc.com",
  "faxonautoliterature.com",
  "ebay.com",
  "amazon.com",
  "goodreads.com",
  "pinterest.com",
];

/** Suffix-match a host against a domain list (`a.b.com` matches `b.com`). */
function hostMatches(host: string, domains: readonly string[]): boolean {
  return domains.some((d) => {
    const dom = d.toLowerCase().replace(/^www\./, "");
    return host === dom || host.endsWith("." + dom);
  });
}

/**
 * Is this URL on the manufacturer's OWN domain for THIS make?
 *
 * Deliberately per-make: a honda.com URL is not OEM provenance for a Toyota.
 * An unknown make yields false rather than a guess — provenance is a claim we
 * only make when we can back it.
 */
export function isOemDomain(url: string | null | undefined, make: string | null | undefined): boolean {
  const host = hostnameOf(url);
  if (!host) return false;
  const domains = OEM_MANUAL_DOMAINS[normalizeMakeKey(make)];
  if (!domains) return false;
  return hostMatches(host, domains);
}

/** Is this URL a known third-party republisher? */
export function isMirrorDomain(url: string | null | undefined): boolean {
  const host = hostnameOf(url);
  if (!host) return false;
  return hostMatches(host, MANUAL_MIRROR_DOMAINS);
}

export type ManualDocKind = "maintenance_schedule" | "owners_manual" | "warranty_guide" | "unknown";

/**
 * Classify a candidate into a doc_kind from its URL + title.
 *
 * The ordering matters: Toyota's document is titled "Warranty & Maintenance
 * Guide" and IS the maintenance schedule (verified — it is the `omms-s` /
 * `T-MMS-` publication), so a title carrying BOTH words classifies as
 * maintenance_schedule, not warranty_guide.
 */
export function classifyDocKind(
  url: string | null | undefined,
  title: string | null | undefined,
): ManualDocKind {
  const hay = `${url ?? ""} ${title ?? ""}`.toLowerCase();
  if (hay.length === 0) return "unknown";

  // Publisher path segments verified live against assets.sia.toyota.com:
  //   /publications/en/omms-s/T-MMS-20CamryAWD/…  → the maintenance guide
  //   /publications/en/om-s/OM20K1QRG/…           → the owner's manual
  // Neither carries the words "maintenance" or "owner's manual" anywhere in
  // the URL or the search title, so without these segment patterns Toyota's
  // own documents classify as "unknown" (observed on the first live run).
  const hasMaintenance = /maintenance|service schedule|servicing schedule|t-mms|\bomms\b|\/omms-s\//.test(hay);
  const hasSchedule = /schedule|guide|intervals?/.test(hay);
  const hasOwners = /owner'?s?[\s_-]*manual|ownermanual|owner_manual|om-en|\/om-s\//.test(hay);
  const hasWarranty = /warranty/.test(hay);

  if (hasMaintenance && (hasSchedule || hasWarranty)) return "maintenance_schedule";
  if (hasOwners) return "owners_manual";
  if (hasMaintenance) return "maintenance_schedule";
  if (hasWarranty) return "warranty_guide";
  return "unknown";
}

/** Does this URL look like a direct PDF link? */
export function looksLikePdfUrl(url: string | null | undefined): boolean {
  if (typeof url !== "string") return false;
  const withoutQuery = url.split("?")[0].split("#")[0];
  return /\.pdf$/i.test(withoutQuery.trim());
}

export type ManualCandidate = {
  url: string;
  title: string;
  source_domain: string;
  is_oem_domain: boolean;
  doc_kind: ManualDocKind;
  is_pdf: boolean;
  score: number;
};

/** Doc-kind contribution to the score — schedule > owners manual > warranty. */
const DOC_KIND_SCORE: Record<ManualDocKind, number> = {
  maintenance_schedule: 40,
  owners_manual: 20,
  warranty_guide: 8,
  unknown: 0,
};

/**
 * Rank discovery candidates, best first.
 *
 * Weighting is intentionally lexicographic-ish: the OEM bonus (100) exceeds
 * every other signal combined, so an OEM owner's manual always outranks a
 * third-party maintenance schedule — provenance is the product requirement.
 * Within a provenance tier, doc_kind decides, then "is it actually a PDF",
 * then whether the year/model tokens are echoed by the URL or title (the
 * cheapest available guard against grabbing the wrong model year).
 */
export function rankManualCandidates(
  raw: ReadonlyArray<{ url: string; title?: string | null }>,
  vehicle: { make: string; model: string; year: number },
): ManualCandidate[] {
  const seen = new Set<string>();
  const out: ManualCandidate[] = [];

  for (const item of raw) {
    const host = hostnameOf(item?.url);
    if (!host) continue;
    const url = item.url.trim();
    if (seen.has(url)) continue;
    seen.add(url);

    const title = (item.title ?? "").trim();
    const oem = isOemDomain(url, vehicle.make);
    const docKind = classifyDocKind(url, title);
    const isPdf = looksLikePdfUrl(url);
    const hay = `${url} ${title}`.toLowerCase();

    let score = 0;
    if (oem) score += 100;
    if (isMirrorDomain(url)) score -= 40;
    score += DOC_KIND_SCORE[docKind];
    if (isPdf) score += 25;
    if (hay.includes(String(vehicle.year))) score += 15;
    // Two-digit model-year token: Toyota's verified slug is "T-MMS-20CamryAWD".
    if (!hay.includes(String(vehicle.year)) && hay.includes(String(vehicle.year % 100).padStart(2, "0"))) {
      score += 4;
    }
    const modelKey = normalizeMakeKey(vehicle.model).replace(/[^a-z0-9]/g, "");
    const modelEchoed =
      modelKey.length >= 2 && hay.replace(/[^a-z0-9]/g, "").includes(modelKey);
    if (modelEchoed) score += 10;
    if (normalizeMakeKey(vehicle.make).length > 0 && hay.includes(normalizeMakeKey(vehicle.make))) score += 5;
    // A candidate that names NEITHER the model nor the year is anonymous: there
    // is nothing in it tying the document to this vehicle. Subaru's
    // `MSA5B1906A_STIS.pdf` is exactly that shape — it won on the OEM bonus
    // alone and turned out to be the BRZ Quick Guide.
    //
    // A penalty rather than a filter, because some OEM hosts really do publish
    // opaque part-number filenames and the correct document can be among them;
    // this only has to move an anonymous candidate BELOW a self-identifying one
    // when both exist. It cannot exceed the OEM bonus, so provenance still wins.
    if (!modelEchoed && !hay.includes(String(vehicle.year))) score -= 30;

    out.push({
      url,
      title,
      source_domain: host,
      is_oem_domain: oem,
      doc_kind: docKind,
      is_pdf: isPdf,
      score,
    });
  }

  // Stable: score desc, then OEM, then PDF, then URL for determinism.
  return out.sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.is_oem_domain) - Number(a.is_oem_domain) ||
      Number(b.is_pdf) - Number(a.is_pdf) ||
      a.url.localeCompare(b.url),
  );
}

/**
 * Discovery queries for one vehicle, most-targeted first.
 *
 * Site-scoped queries come first when the make is in the allowlist — they are
 * the only lever that reliably surfaces the manufacturer's own host above the
 * mirror farms (verified: a plain "2022 Subaru Crosstrek owner's manual pdf"
 * search returned eight mirrors and zero OEM hits, while adding the host
 * surfaced techinfo.subaru.com). An unknown make gets only the generic pair.
 */
export function buildManualQueries(year: number, make: string, model: string): string[] {
  const y = Number.isFinite(year) ? String(Math.trunc(year)) : "";
  const mk = (make ?? "").trim();
  const md = (model ?? "").trim();
  if (!y || !mk || !md) return [];

  const ymm = `${y} ${mk} ${md}`;
  const domains = OEM_MANUAL_DOMAINS[normalizeMakeKey(mk)] ?? [];
  const primary = domains[0];

  const queries: string[] = [];
  if (primary) {
    queries.push(`${ymm} maintenance schedule guide filetype:pdf site:${primary}`);
    queries.push(`${ymm} owner's manual pdf site:${primary}`);
  }
  queries.push(`${ymm} warranty and maintenance guide pdf oil change interval`);
  queries.push(`${ymm} owner's manual pdf maintenance schedule miles months`);
  return queries;
}

// ─── Negative caching / freshness ────────────────────────────────

export type ManualRowLike = {
  file_id?: string | null;
  failure_reason?: string | null;
  attempts?: number | null;
  fetched_at?: number | null;
  expires_at?: number | null;
  rejected_urls?: readonly string[] | null;
} | null | undefined;

/** Prefix `rejectManualRow` writes into `failure_reason`. A rejection is a
 *  different kind of failure from a dead host: it means the document we read
 *  was the WRONG one, so there are untried candidates and the retry is cheap
 *  and likely to succeed. */
export const MANUAL_REJECTION_PREFIX = "rejected_after_extraction";

export type ManualSkipDecision = { skip: boolean; reason: string };

/**
 * Should `resolveManualForVehicle` short-circuit for this stored row?
 *
 * Three states:
 *   - a fresh SUCCESS row → skip (reuse the file_id, no spend)
 *   - a failure row younger than MANUAL_FAILURE_TTL_DAYS → skip (negative
 *     cache; the Ford byte-fetch timeout is exactly this case — a slow OEM
 *     host must not be re-paid for daily)
 *   - anything older, or no row → proceed (and bump `attempts`)
 */
export function shouldSkipManualLookup(
  row: ManualRowLike,
  now: number = Date.now(),
  opts?: { failureTtlDays?: number; refreshDays?: number },
): ManualSkipDecision {
  if (!row) return { skip: false, reason: "no_row" };

  const failureTtl = (opts?.failureTtlDays ?? MANUAL_FAILURE_TTL_DAYS) * DAY_MS;
  const refreshTtl = (opts?.refreshDays ?? MANUAL_REFRESH_DAYS) * DAY_MS;
  const fetchedAt = typeof row.fetched_at === "number" ? row.fetched_at : 0;

  if (typeof row.file_id === "string" && row.file_id.length > 0) {
    if (typeof row.expires_at === "number" && row.expires_at <= now) {
      return { skip: false, reason: "manual_expired" };
    }
    if (now - fetchedAt >= refreshTtl) return { skip: false, reason: "manual_stale" };
    return { skip: true, reason: "fresh_manual" };
  }

  if (typeof row.failure_reason === "string" && row.failure_reason.length > 0) {
    // A REJECTION is not a dead end. It means the document we downloaded was
    // the wrong one for this vehicle (the 2019 Forester got the BRZ Quick
    // Guide), so there are untried candidates and the rejected URL is now
    // excluded from ranking — the very next attempt tries something different.
    // Holding that behind the 14-day negative cache would make the
    // self-correcting loop take two weeks per candidate.
    //
    // Still bounded: once MANUAL_MAX_REJECTIONS candidates have been read and
    // found wrong, this falls back to the ordinary negative cache rather than
    // paying for a download + upload + extraction on every run forever.
    if (row.failure_reason.startsWith(MANUAL_REJECTION_PREFIX)) {
      const rejections = row.rejected_urls?.length ?? 0;
      if (rejections < MANUAL_MAX_REJECTIONS) {
        return { skip: false, reason: "retry_after_rejection" };
      }
      if (now - fetchedAt < failureTtl) {
        return { skip: true, reason: "rejection_limit_reached" };
      }
      return { skip: false, reason: "negative_cache_expired" };
    }
    if (now - fetchedAt < failureTtl) return { skip: true, reason: "negative_cache" };
    return { skip: false, reason: "negative_cache_expired" };
  }

  return { skip: false, reason: "incomplete_row" };
}

// ─── Write precedence ────────────────────────────────────────────

export type StoredIntervalLike = {
  interval_miles?: number | null;
  interval_months?: number | null;
  data_quality?: string | null;
  mechanic_verified?: boolean | null;
} | null | undefined;

export type IncomingInterval = {
  interval_miles?: number | null;
  interval_months?: number | null;
};

/** Tiers a manual extraction must never silently downgrade. */
export const PROTECTED_DATA_QUALITY = ["deterministic", "oem_manual"] as const;

export type OverwriteDecision = { write: boolean; reason: string };

const isPositive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/**
 * THE write-precedence rule for manual-sourced intervals.
 *
 * Pure and exported so the table-driven test owns the contract:
 *   1. an incoming row with neither miles nor months is never written;
 *   2. a mechanic-verified row is never overwritten by a machine;
 *   3. a row already at `deterministic`/`oem_manual` is only overwritten when
 *      the incoming row has BOTH miles and months AND the stored one lacks
 *      months (the exact months-fill gap this module exists to close);
 *   4. everything below that tier (enriched / estimated / default_fallback /
 *      vdb_schedule / unset) is overwritten by an OEM-manual reading.
 */
export function shouldOverwriteInterval(
  existing: StoredIntervalLike,
  incoming: IncomingInterval,
): OverwriteDecision {
  const inMiles = isPositive(incoming?.interval_miles);
  const inMonths = isPositive(incoming?.interval_months);
  if (!inMiles && !inMonths) return { write: false, reason: "empty_incoming" };

  if (!existing) return { write: true, reason: "no_existing_row" };
  if (existing.mechanic_verified === true) return { write: false, reason: "mechanic_verified" };

  const quality = (existing.data_quality ?? "").trim().toLowerCase();
  const isProtected = (PROTECTED_DATA_QUALITY as readonly string[]).includes(quality);

  if (isProtected) {
    const existingHasMonths = isPositive(existing.interval_months);
    if (inMiles && inMonths && !existingHasMonths) {
      return { write: true, reason: "months_fill_upgrade" };
    }
    return { write: false, reason: `protected_${quality}` };
  }

  return { write: true, reason: quality ? `upgrade_from_${quality}` : "upgrade_from_unset" };
}

// ─── Interval key → service slug ─────────────────────────────────

/**
 * Manual interval keys → `services.slug`.
 *
 * Mirrors INTERVAL_TO_SERVICE in v3pipeline.ts (which this module must not
 * import — v3pipeline is owned elsewhere and pulling it in would drag the
 * whole pipeline into the unit tests). Two deliberate divergences:
 *
 *   - `brake_pads` is ABSENT. Pads are wear items; a manual's pad text is
 *     inspection guidance, not a replacement schedule, and stamping it
 *     `oem_manual` would launder a wear estimate into OEM provenance.
 *   - `air_filter` and `cabin_filter` both resolve to `filter_replacement`
 *     (one shared row — see convex/lib/reviewFieldMap.ts). MANUAL_INTERVAL_ORDER
 *     below makes the collision deterministic instead of last-write-wins.
 */
export const MANUAL_INTERVAL_TO_SERVICE: Record<string, string> = {
  oil_change: "oil_change",
  tire_rotation: "tire_rotation",
  air_filter: "filter_replacement",
  cabin_filter: "filter_replacement",
  spark_plug: "spark_plugs",
  brake_fluid_flush: "brake_fluid_flush",
  coolant_flush: "coolant_flush",
  transmission_service: "transmission_service",
  serpentine_belt: "serpentine_belt",
  timing_service: "timing_belt",
  diff_fluid: "differential_service",
  transfer_case_fluid: "transfer_case_service",
  ps_fluid: "power_steering_flush",
};

/** Deterministic precedence for the shared-service collision. */
export const MANUAL_INTERVAL_ORDER: readonly string[] = [
  "oil_change",
  "tire_rotation",
  "air_filter",
  "cabin_filter",
  "spark_plug",
  "brake_fluid_flush",
  "coolant_flush",
  "transmission_service",
  "serpentine_belt",
  "timing_service",
  "diff_fluid",
  "transfer_case_fluid",
  "ps_fluid",
];

/** Core services whose missing `interval_months` qualifies a config for backfill. */
export const CORE_MONTHS_SERVICE_SLUGS: readonly string[] = [
  "oil_change",
  "brake_fluid_flush",
  "coolant_flush",
  "transmission_service",
  "filter_replacement",
  "spark_plugs",
];

// ─── Structured-output schema (batchSchemas.ts style) ────────────

export type JsonSchema = Record<string, any>;

/** anyOf-based nullable union — same canonical form as utils/batchSchemas.ts. */
export function nullable(...types: string[]): JsonSchema {
  return { anyOf: [...types.map((t) => ({ type: t })), { type: "null" }] };
}

/**
 * One extracted maintenance-schedule entry.
 *
 * `quoted_text` is the verbatim citation span from the PDF — it is what makes
 * an `oem_manual` row auditable, so it is `required` (nullable, never absent).
 */
export function manualIntervalEntrySchema(intervalKeys: readonly string[]): JsonSchema {
  return {
    type: "object",
    properties: {
      service_key: { type: "string", enum: [...intervalKeys] },
      interval_miles: nullable("number"),
      interval_months: nullable("number"),
      severe_miles: nullable("number"),
      severe_months: nullable("number"),
      quoted_text: nullable("string"),
      page_number: nullable("number"),
    },
    required: [
      "service_key",
      "interval_miles",
      "interval_months",
      "severe_miles",
      "severe_months",
      "quoted_text",
      "page_number",
    ],
    additionalProperties: false,
  };
}

/** Full tool input_schema for the manual extraction call. */
export function buildManualExtractionSchema(
  intervalKeys: readonly string[] = MANUAL_INTERVAL_ORDER,
): JsonSchema {
  return {
    type: "object",
    properties: {
      schedule_found: { type: "boolean" },
      schedule_kind: nullable("string"),
      services: { type: "array", items: manualIntervalEntrySchema(intervalKeys) },
      notes: nullable("string"),
    },
    required: ["schedule_found", "schedule_kind", "services", "notes"],
    additionalProperties: false,
  };
}

export function buildManualExtractionPrompt(vehicle: {
  year: number;
  make: string;
  model: string;
}): string {
  return [
    `The attached PDF is the manufacturer's published documentation for the ${vehicle.year} ${vehicle.make} ${vehicle.model}.`,
    "",
    "Find the MAINTENANCE SCHEDULE (often titled 'Maintenance Schedule', 'Scheduled Maintenance', 'Maintenance Log', or inside a Warranty & Maintenance Guide) and report the factory service intervals.",
    "",
    "Rules — these override any instinct to be helpful:",
    "1. Report ONLY intervals stated in THIS document. Never infer, average, or fill from general knowledge. A missing value is `null`.",
    "2. `interval_miles` / `interval_months` are the NORMAL (standard) schedule. `severe_miles` / `severe_months` are the severe/special operating-conditions schedule if the document publishes one, else null.",
    "3. `quoted_text` must be a VERBATIM span copied from the document that states the interval. If you cannot quote it, the interval does not belong in your answer.",
    "4. If the schedule is expressed as a repeating table (e.g. columns at 5,000 / 10,000 / 15,000 miles), report the RECURRENCE (the smallest repeating step for that item), not the first column.",
    "5. If the vehicle uses a condition-based reminder system (Honda Maintenance Minder, GM Oil Life) with no fixed mileage, set the mileage to null and say so in `notes` — do not substitute a typical value.",
    "6. Omit any service the document does not schedule. An empty `services` array is a correct answer.",
    "",
    `Allowed \`service_key\` values: ${MANUAL_INTERVAL_ORDER.join(", ")}.`,
    "",
    "Call the record_maintenance_schedule tool exactly once with your findings.",
  ].join("\n");
}

// ─── Response parsing ────────────────────────────────────────────

export type ParsedManualInterval = {
  service_key: string;
  service_slug: string;
  interval_miles: number | null;
  interval_months: number | null;
  severe_miles: number | null;
  severe_months: number | null;
  quoted_text: string | null;
  page_number: number | null;
  display_string: string | null;
};

const asPositiveNumber = (raw: unknown): number | null => {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.replace(/[,\s]/g, "")) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
};

/** "Every 10,000 miles or 12 months (severe: 5,000 mi / 6 mo)" */
export function formatIntervalDisplay(row: {
  interval_miles: number | null;
  interval_months: number | null;
  severe_miles?: number | null;
  severe_months?: number | null;
}): string | null {
  const parts: string[] = [];
  if (isPositive(row.interval_miles)) parts.push(`${row.interval_miles!.toLocaleString("en-US")} miles`);
  if (isPositive(row.interval_months)) parts.push(`${row.interval_months} months`);
  if (parts.length === 0) return null;
  let out = `Every ${parts.join(" or ")}`;

  const sev: string[] = [];
  if (isPositive(row.severe_miles)) sev.push(`${row.severe_miles!.toLocaleString("en-US")} mi`);
  if (isPositive(row.severe_months)) sev.push(`${row.severe_months} mo`);
  if (sev.length > 0) out += ` (severe: ${sev.join(" / ")})`;
  return out;
}

/**
 * Parse the tool payload into storable rows.
 *
 * Fails closed on every axis: unknown service_key dropped, non-positive
 * numbers nulled, an entry with neither miles nor months dropped entirely.
 * Never throws.
 */
export function parseManualIntervals(payload: unknown): ParsedManualInterval[] {
  const services = (payload as any)?.services;
  if (!Array.isArray(services)) return [];

  const out: ParsedManualInterval[] = [];
  for (const raw of services) {
    const key = typeof raw?.service_key === "string" ? raw.service_key.trim().toLowerCase() : "";
    const slug = MANUAL_INTERVAL_TO_SERVICE[key];
    if (!slug) continue;

    const interval_miles = asPositiveNumber(raw?.interval_miles);
    const interval_months = asPositiveNumber(raw?.interval_months);
    if (interval_miles === null && interval_months === null) continue;

    const severe_miles = asPositiveNumber(raw?.severe_miles);
    const severe_months = asPositiveNumber(raw?.severe_months);
    const quoted =
      typeof raw?.quoted_text === "string" && raw.quoted_text.trim().length > 0
        ? raw.quoted_text.trim().slice(0, 600)
        : null;
    const page = asPositiveNumber(raw?.page_number);

    out.push({
      service_key: key,
      service_slug: slug,
      interval_miles,
      interval_months,
      severe_miles,
      severe_months,
      quoted_text: quoted,
      page_number: page,
      display_string: formatIntervalDisplay({
        interval_miles,
        interval_months,
        severe_miles,
        severe_months,
      }),
    });
  }
  return out;
}

/**
 * Collapse entries that resolve to the SAME service slug.
 *
 * `air_filter` and `cabin_filter` share one `filter_replacement` row. Without
 * this, whichever the model listed last would win — non-deterministic across
 * runs for the same PDF. MANUAL_INTERVAL_ORDER decides instead (engine air
 * filter before cabin filter).
 */
export function dedupeIntervalsByService(rows: readonly ParsedManualInterval[]): ParsedManualInterval[] {
  const rank = new Map(MANUAL_INTERVAL_ORDER.map((k, i) => [k, i]));
  const best = new Map<string, ParsedManualInterval>();
  for (const row of rows) {
    const current = best.get(row.service_slug);
    if (!current) {
      best.set(row.service_slug, row);
      continue;
    }
    const a = rank.get(row.service_key) ?? Number.MAX_SAFE_INTEGER;
    const b = rank.get(current.service_key) ?? Number.MAX_SAFE_INTEGER;
    if (a < b) best.set(row.service_slug, row);
  }
  return MANUAL_INTERVAL_ORDER.map((k) => [...best.values()].find((r) => r.service_key === k)).filter(
    (r): r is ParsedManualInterval => r != null,
  );
}

/** Extract the tool payload from a Messages API response body. */
export function extractToolPayload(body: unknown, toolName: string): Record<string, any> | null {
  const content = (body as any)?.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block?.type === "tool_use" && block?.name === toolName && block?.input && typeof block.input === "object") {
      return block.input as Record<string, any>;
    }
  }
  return null;
}

/** Collect `cited_text` spans from citation-enabled text blocks (audit trail). */
export function collectCitationSpans(body: unknown, limit = 12): string[] {
  const content = (body as any)?.content;
  if (!Array.isArray(content)) return [];
  const spans: string[] = [];
  for (const block of content) {
    if (!Array.isArray(block?.citations)) continue;
    for (const cite of block.citations) {
      const text = typeof cite?.cited_text === "string" ? cite.cited_text.trim() : "";
      if (text.length > 0) spans.push(text.slice(0, 400));
      if (spans.length >= limit) return spans;
    }
  }
  return spans;
}

// ─── PDF sniffing ────────────────────────────────────────────────

/**
 * Real PDF? Checks the `%PDF-` magic number.
 *
 * This is the guard that keeps an HTML error page or a cookie wall from being
 * uploaded and "extracted" into confident, wrong intervals — the exact
 * present-but-wrong failure the pipeline law forbids.
 */
export function looksLikePdfBytes(bytes: Uint8Array | null | undefined): boolean {
  if (!bytes || bytes.length < 5) return false;
  return (
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 && // F
    bytes[4] === 0x2d //   -
  );
}

/**
 * Best-effort page count by counting `/Type /Page` objects. Returns null when
 * the document is too large to scan cheaply or nothing matched — a wrong page
 * count is worse than none, so a zero result is reported as null.
 */
export function estimatePdfPageCount(bytes: Uint8Array | null | undefined): number | null {
  if (!bytes || bytes.length === 0) return null;
  if (bytes.length > 8 * 1024 * 1024) return null; // too big to scan cheaply
  try {
    const text = new TextDecoder("latin1").decode(bytes);
    const matches = text.match(/\/Type\s*\/Page[^s]/g);
    const n = matches ? matches.length : 0;
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Filename for the Files API upload — stable, human-readable, path-safe. */
export function manualFileName(vehicle: { year: number; make: string; model: string }, docKind: string): string {
  const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return `${vehicle.year}-${slug(vehicle.make)}-${slug(vehicle.model)}-${slug(docKind) || "manual"}.pdf`;
}

// ============================================================================
// Convex data layer
// ============================================================================

export const getManualRow = internalQuery({
  args: { make: v.string(), model: v.string(), year: v.float64() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("vehicle_manuals")
      .withIndex("by_ymm", (q) =>
        q.eq("make", normalizeMakeKey(args.make)).eq("model", normalizeMakeKey(args.model)).eq("year", args.year),
      )
      .first();
  },
});

/**
 * Upsert the (make, model, year) manual row. `attempts` is monotonic — it is
 * the only durable signal that a vehicle has been repeatedly unresolvable.
 */
export const upsertManualRow = internalMutation({
  args: {
    make: v.string(),
    model: v.string(),
    year: v.float64(),
    source_url: v.string(),
    source_domain: v.string(),
    is_oem_domain: v.boolean(),
    doc_kind: v.string(),
    file_id: v.optional(v.string()),
    file_bytes: v.optional(v.float64()),
    page_count: v.optional(v.float64()),
    failure_reason: v.optional(v.string()),
    expires_at: v.optional(v.float64()),
  },
  handler: async (ctx, args) => {
    const make = normalizeMakeKey(args.make);
    const model = normalizeMakeKey(args.model);
    const existing = await ctx.db
      .query("vehicle_manuals")
      .withIndex("by_ymm", (q) => q.eq("make", make).eq("model", model).eq("year", args.year))
      .first();

    const patch = {
      make,
      model,
      year: args.year,
      source_url: args.source_url,
      source_domain: args.source_domain,
      is_oem_domain: args.is_oem_domain,
      doc_kind: args.doc_kind,
      file_id: args.file_id,
      file_bytes: args.file_bytes,
      page_count: args.page_count,
      failure_reason: args.failure_reason,
      attempts: (existing?.attempts ?? 0) + 1,
      fetched_at: Date.now(),
      expires_at: args.expires_at,
    };

    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }
    return await ctx.db.insert("vehicle_manuals", patch);
  },
});

/**
 * Reject the manual currently on file for a vehicle, so the next resolve tries
 * a DIFFERENT candidate instead of skipping.
 *
 * A successful download is not a successful manual. The 2019 Forester resolved
 * a real PDF from Subaru's own techinfo host that turned out to be the 2019 BRZ
 * Quick Guide; the extractor caught it, but the row still carried a `file_id`,
 * which shouldSkipManualLookup reads as `fresh_manual` — so the wrong document
 * would have been cached as this vehicle's manual for 180 days.
 *
 * Clearing `file_id` and recording the URL in `rejected_urls` turns that into a
 * self-correcting loop: the vehicle becomes eligible again, and the candidate
 * that wasted the attempt is skipped next time.
 */
export const rejectManualRow = internalMutation({
  args: {
    make: v.string(),
    model: v.string(),
    year: v.float64(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const make = normalizeMakeKey(args.make);
    const model = normalizeMakeKey(args.model);
    const row = await ctx.db
      .query("vehicle_manuals")
      .withIndex("by_ymm", (q) => q.eq("make", make).eq("model", model).eq("year", args.year))
      .first();
    if (!row) return { rejected: false, reason: "no_row" };

    const rejected = new Set<string>((row as any).rejected_urls ?? []);
    if (row.source_url) rejected.add(row.source_url);

    await ctx.db.patch(row._id, {
      // Cleared so the row stops reading as a fresh success.
      file_id: undefined,
      // Recorded as a FAILURE so the negative cache still applies — a vehicle
      // whose every candidate is wrong must not be re-searched every single
      // run. The 14-day TTL is the right bound for "try again later".
      failure_reason: `rejected_after_extraction: ${args.reason}`.slice(0, 400),
      rejected_urls: [...rejected],
      fetched_at: Date.now(),
    });
    console.warn(
      `[manual-library] REJECTED ${args.year} ${args.make} ${args.model} — ` +
        `${row.source_url} (${args.reason.slice(0, 160)})`,
    );
    return { rejected: true, rejected_count: rejected.size };
  },
});

/**
 * Everything extractIntervalsFromManual needs in one read: the config's YMM,
 * the resolved manual row, the service slug → id map, and the current
 * interval rows the precedence rule will be evaluated against.
 */
export const getManualExtractionContext = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.vehicleConfigId);
    if (!config) return null;
    const cfg = config as any;

    const [makeDoc, modelDoc] = await Promise.all([
      cfg.make_id ? ctx.db.get(cfg.make_id) : null,
      cfg.model_id ? ctx.db.get(cfg.model_id) : null,
    ]);
    const make = (makeDoc as any)?.name ?? null;
    const model = (modelDoc as any)?.name ?? null;
    if (!make || !model || typeof cfg.year !== "number") return null;

    const manual = await ctx.db
      .query("vehicle_manuals")
      .withIndex("by_ymm", (q) =>
        q.eq("make", normalizeMakeKey(make)).eq("model", normalizeMakeKey(model)).eq("year", cfg.year),
      )
      .first();

    return {
      year: cfg.year as number,
      make: make as string,
      model: model as string,
      manual: manual
        ? {
            file_id: manual.file_id ?? null,
            source_url: manual.source_url,
            is_oem_domain: manual.is_oem_domain,
            doc_kind: manual.doc_kind,
            failure_reason: manual.failure_reason ?? null,
            fetched_at: manual.fetched_at,
            expires_at: manual.expires_at ?? null,
          }
        : null,
    };
  },
});

/**
 * THE only write path for manual-sourced intervals.
 *
 * Re-reads the stored row inside the transaction (the action's view is stale
 * by the time it lands) and applies `shouldOverwriteInterval` per service.
 * A service slug that isn't seeded is logged and skipped — never invented.
 */
export const _writeManualIntervals = internalMutation({
  args: {
    vehicleConfigId: v.id("vehicle_configs"),
    source_url: v.optional(v.string()),
    rows: v.array(
      v.object({
        service_slug: v.string(),
        interval_miles: v.union(v.float64(), v.null()),
        interval_months: v.union(v.float64(), v.null()),
        display_string: v.union(v.string(), v.null()),
        quoted_text: v.union(v.string(), v.null()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    let written = 0;
    let skipped = 0;
    let unseeded = 0;
    const decisions: string[] = [];

    for (const row of args.rows) {
      const svc = await ctx.db
        .query("services")
        .withIndex("by_slug", (q) => q.eq("slug", row.service_slug))
        .first();
      if (!svc) {
        unseeded++;
        console.warn(`[manual-library] service slug not seeded, skipping: ${row.service_slug}`);
        continue;
      }

      const existing = await ctx.db
        .query("service_intervals")
        .withIndex("by_config_service", (q) =>
          q.eq("vehicle_config_id", args.vehicleConfigId).eq("service_id", svc._id),
        )
        .first();

      const decision = shouldOverwriteInterval(existing ?? null, {
        interval_miles: row.interval_miles,
        interval_months: row.interval_months,
      });
      decisions.push(`${row.service_slug}:${decision.reason}`);

      if (!decision.write) {
        skipped++;
        continue;
      }

      const fields = {
        interval_miles: row.interval_miles ?? undefined,
        interval_months: row.interval_months ?? undefined,
        status: "scheduled",
        display_string: row.display_string ?? undefined,
        confidence: 0.95,
        data_quality: "oem_manual",
        // Clear the months-provenance override when this write lands a REAL
        // months from the manual: the row's own data_quality ("oem_manual") is
        // then the truth for both numbers. Leaving a stale
        // interval_months_source="default_fallback" here would under-report
        // genuine OEM data, which is its own kind of wrong.
        //
        // A manual row carrying miles-only must NOT clear an existing default
        // months stamp — the months on that row is still the defaulted one.
        interval_months_source:
          row.interval_months != null
            ? undefined
            : ((existing as any)?.interval_months_source ?? undefined),
      };

      if (existing) {
        await ctx.db.patch(existing._id, fields);
      } else {
        await ctx.db.insert("service_intervals", {
          vehicle_config_id: args.vehicleConfigId,
          service_id: svc._id,
          created_at: Date.now(),
          ...fields,
        });
      }
      written++;
    }

    console.log(
      `[manual-library] intervals written=${written} skipped=${skipped} unseeded=${unseeded}` +
        (args.source_url ? ` src=${args.source_url}` : "") +
        ` [${decisions.join(", ")}]`,
    );
    return { written, skipped, unseeded };
  },
});

/**
 * Page of configs missing `interval_months` on a core service.
 *
 * Scans `vehicle_configs` a page at a time and checks each config's interval
 * rows via `by_vehicle_config`. Returns at most `limit` matches plus the
 * cursor to resume from, so the caller can walk the fleet across nights
 * without ever loading it all.
 */
export const manualBackfillPage = internalQuery({
  args: {
    limit: v.float64(),
    cursor: v.optional(v.union(v.string(), v.null())),
    scanPages: v.optional(v.float64()),
  },
  handler: async (ctx, args) => {
    const matches: Array<{
      vehicle_config_id: Id<"vehicle_configs">;
      year: number;
      make: string;
      model: string;
      missing: string[];
    }> = [];

    const coreServices = await Promise.all(
      CORE_MONTHS_SERVICE_SLUGS.map((slug) =>
        ctx.db
          .query("services")
          .withIndex("by_slug", (q) => q.eq("slug", slug))
          .first(),
      ),
    );
    const slugById = new Map<string, string>();
    coreServices.forEach((svc, i) => {
      if (svc) slugById.set(String(svc._id), CORE_MONTHS_SERVICE_SLUGS[i]);
    });
    if (slugById.size === 0) {
      console.warn("[manual-library] no core services seeded — backfill scan is a no-op");
      return { matches, cursor: null as string | null, isDone: true, scanned: 0 };
    }

    let cursor: string | null = args.cursor ?? null;
    let isDone = false;
    let scanned = 0;
    const maxPages = Math.max(1, Math.trunc(args.scanPages ?? 3));

    for (let page = 0; page < maxPages && matches.length < args.limit; page++) {
      const result = await ctx.db
        .query("vehicle_configs")
        .paginate({ numItems: BACKFILL_SCAN_PAGE_SIZE, cursor });
      cursor = result.continueCursor;
      isDone = result.isDone;

      for (const config of result.page) {
        scanned++;
        if (matches.length >= args.limit) break;
        const cfg = config as any;
        if (typeof cfg.year !== "number") continue;

        const intervals = await ctx.db
          .query("service_intervals")
          .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", config._id))
          .collect();

        const byService = new Map(intervals.map((i) => [String(i.service_id), i]));
        const missing: string[] = [];
        for (const [serviceId, slug] of slugById) {
          const row = byService.get(serviceId);
          if (!row) {
            missing.push(slug);
            continue;
          }
          if (row.mechanic_verified === true) continue;
          if (!isPositive(row.interval_months)) missing.push(slug);
        }
        if (missing.length === 0) continue;

        const [makeDoc, modelDoc] = await Promise.all([
          cfg.make_id ? ctx.db.get(cfg.make_id) : null,
          cfg.model_id ? ctx.db.get(cfg.model_id) : null,
        ]);
        const make = (makeDoc as any)?.name;
        const model = (modelDoc as any)?.name;
        if (!make || !model) continue;

        matches.push({
          vehicle_config_id: config._id,
          year: cfg.year,
          make,
          model,
          missing,
        });
      }

      if (isDone) break;
    }

    return { matches, cursor, isDone, scanned };
  },
});

// ============================================================================
// Actions
// ============================================================================

type AnthropicUploadResult = { file_id: string; bytes: number; page_count: number | null };

/** POST the PDF to the Anthropic Files API. Returns null on any failure. */
async function uploadPdfToFilesApi(
  bytes: Uint8Array,
  filename: string,
): Promise<{ ok: true; result: AnthropicUploadResult } | { ok: false; reason: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, reason: "no_anthropic_api_key" };

  try {
    const form = new FormData();
    // Content-Type is set on the Blob; the multipart boundary is set by fetch.
    form.append("file", new Blob([bytes as unknown as BlobPart], { type: "application/pdf" }), filename);

    const res = await fetch(`${ANTHROPIC_API_BASE}/files`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-beta": FILES_API_BETA,
      },
      body: form,
      signal: AbortSignal.timeout(FILE_UPLOAD_TIMEOUT_MS),
    });

    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      return { ok: false, reason: `files_api_${res.status}:${detail}` };
    }

    const json: any = await res.json();
    const fileId = typeof json?.id === "string" ? json.id : null;
    if (!fileId) return { ok: false, reason: "files_api_no_id" };

    return {
      ok: true,
      result: {
        file_id: fileId,
        bytes: typeof json?.size_bytes === "number" ? json.size_bytes : bytes.length,
        page_count: estimatePdfPageCount(bytes),
      },
    };
  } catch (e) {
    return { ok: false, reason: `files_api_error:${String(e).slice(0, 200)}` };
  }
}

/**
 * Resolve ONE vehicle's manual: discover → download → upload → store file_id.
 *
 * Fail-open contract: every failure path writes a `failure_reason` row (which
 * increments `attempts` and arms the 14-day negative cache) and returns null.
 * It never throws.
 */
export const resolveManualForVehicle = internalAction({
  args: {
    make: v.string(),
    model: v.string(),
    year: v.float64(),
    force: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    status: "cached" | "uploaded" | "failed";
    file_id: string | null;
    source_url: string | null;
    is_oem_domain: boolean | null;
    doc_kind: string | null;
    reason: string;
  }> => {
    const label = `${args.year} ${args.make} ${args.model}`;
    const fail = async (
      reason: string,
      candidate?: { url: string; source_domain: string; is_oem_domain: boolean; doc_kind: string },
    ) => {
      try {
        await ctx.runMutation(selfApi().upsertManualRow, {
          make: args.make,
          model: args.model,
          year: args.year,
          source_url: candidate?.url ?? "",
          source_domain: candidate?.source_domain ?? "",
          is_oem_domain: candidate?.is_oem_domain ?? false,
          doc_kind: candidate?.doc_kind ?? "unknown",
          failure_reason: reason.slice(0, 400),
        });
      } catch (e) {
        console.warn(`[manual-library] could not record failure for ${label}:`, e);
      }
      console.warn(`[manual-library] ${label}: FAILED (${reason})`);
      return {
        status: "failed" as const,
        file_id: null,
        source_url: candidate?.url ?? null,
        is_oem_domain: candidate?.is_oem_domain ?? null,
        doc_kind: candidate?.doc_kind ?? null,
        reason,
      };
    };

    try {
      // ── 0. Negative cache / freshness ─────────────────────────
      const existing = await ctx.runQuery(selfApi().getManualRow, {
        make: args.make,
        model: args.model,
        year: args.year,
      });
      if (!args.force) {
        const decision = shouldSkipManualLookup(existing as ManualRowLike);
        if (decision.skip) {
          console.log(`[manual-library] ${label}: skip (${decision.reason})`);
          return {
            status: "cached",
            file_id: (existing as any)?.file_id ?? null,
            source_url: (existing as any)?.source_url ?? null,
            is_oem_domain: (existing as any)?.is_oem_domain ?? null,
            doc_kind: (existing as any)?.doc_kind ?? null,
            reason: decision.reason,
          };
        }
      }

      // ── 1. Discovery (Firecrawl search — no new scraper) ──────
      const queries = buildManualQueries(args.year, args.make, args.model);
      if (queries.length === 0) return await fail("bad_vehicle_args");

      const found: Array<{ url: string; title?: string | null }> = [];
      for (const query of queries) {
        const results = await searchAndFetch(query, 5);
        for (const r of results) found.push({ url: r.url, title: r.title });
        // Stop early once an OEM PDF is in hand — each query costs credits.
        const ranked = rankManualCandidates(found, args);
        if (ranked.length > 0 && ranked[0].is_oem_domain && ranked[0].is_pdf) break;
      }

      // Candidates already read and found wrong for THIS vehicle. Retrying one
      // costs a multi-MB download plus an upload plus an extraction to reach
      // the same verdict, so a rejection has to actually remove it from play.
      const rejectedUrls = new Set<string>(((existing as any)?.rejected_urls ?? []) as string[]);
      const candidates = rankManualCandidates(found, args)
        .filter((c) => c.is_pdf)
        .filter((c) => !rejectedUrls.has(c.url));
      if (rejectedUrls.size > 0) {
        console.log(
          `[manual-library] ${label}: skipping ${rejectedUrls.size} previously-rejected candidate(s)`,
        );
      }
      if (candidates.length === 0) {
        return await fail(
          `no_pdf_candidates(searched=${found.length}, rejected=${rejectedUrls.size})`,
        );
      }

      // ── 2. Download the best candidate (then the runner-up) ───
      let lastReason = "unknown";
      for (const candidate of candidates.slice(0, 3)) {
        const meta = {
          url: candidate.url,
          source_domain: candidate.source_domain,
          is_oem_domain: candidate.is_oem_domain,
          doc_kind: candidate.doc_kind,
        };

        let bytes: Uint8Array | null = null;
        try {
          const res = await fetch(candidate.url, {
            headers: { Accept: "application/pdf,*/*" },
            signal: AbortSignal.timeout(PDF_DOWNLOAD_TIMEOUT_MS),
          });
          if (!res.ok) {
            lastReason = `download_${res.status}`;
            continue;
          }
          const declared = Number(res.headers.get("content-length") ?? "");
          if (Number.isFinite(declared) && declared > MAX_MANUAL_BYTES) {
            lastReason = `too_large_declared_${declared}`;
            continue;
          }
          bytes = new Uint8Array(await res.arrayBuffer());
        } catch (e) {
          lastReason = `download_error:${String(e).slice(0, 120)}`;
          continue;
        }

        if (bytes.length > MAX_MANUAL_BYTES) {
          lastReason = `too_large_${bytes.length}`;
          continue;
        }
        if (bytes.length < MIN_MANUAL_BYTES) {
          lastReason = `too_small_${bytes.length}`;
          continue;
        }
        if (!looksLikePdfBytes(bytes)) {
          // An HTML error page wearing a .pdf URL. Never upload it.
          lastReason = "not_a_pdf_body";
          continue;
        }

        // ── 3. Upload to the Anthropic Files API ────────────────
        const upload = await uploadPdfToFilesApi(bytes, manualFileName(args, candidate.doc_kind));
        if (!upload.ok) {
          lastReason = upload.reason;
          continue;
        }

        await ctx.runMutation(selfApi().upsertManualRow, {
          make: args.make,
          model: args.model,
          year: args.year,
          source_url: candidate.url,
          source_domain: candidate.source_domain,
          is_oem_domain: candidate.is_oem_domain,
          doc_kind: candidate.doc_kind,
          file_id: upload.result.file_id,
          file_bytes: upload.result.bytes,
          page_count: upload.result.page_count ?? undefined,
          expires_at: Date.now() + MANUAL_REFRESH_DAYS * DAY_MS,
        });

        console.log(
          `[manual-library] ${label}: uploaded ${upload.result.file_id} ` +
            `(${(upload.result.bytes / 1024 / 1024).toFixed(2)} MB, ` +
            `pages≈${upload.result.page_count ?? "?"}, oem=${candidate.is_oem_domain}, ` +
            `kind=${candidate.doc_kind}) from ${candidate.url}`,
        );

        return {
          status: "uploaded",
          file_id: upload.result.file_id,
          source_url: candidate.url,
          is_oem_domain: candidate.is_oem_domain,
          doc_kind: candidate.doc_kind,
          reason: "ok",
        };
      }

      return await fail(lastReason, {
        url: candidates[0].url,
        source_domain: candidates[0].source_domain,
        is_oem_domain: candidates[0].is_oem_domain,
        doc_kind: candidates[0].doc_kind,
      });
    } catch (e) {
      // Belt-and-braces: the contract is "never throws".
      console.warn(`[manual-library] ${label}: unexpected error`, e);
      return {
        status: "failed",
        file_id: null,
        source_url: null,
        is_oem_domain: null,
        doc_kind: null,
        reason: `unexpected:${String(e).slice(0, 200)}`,
      };
    }
  },
});

const EXTRACTION_TOOL_NAME = "record_maintenance_schedule";

/**
 * Extract this config's maintenance schedule from its stored manual PDF.
 *
 * Sends a NATIVE PDF document block referencing the Files API `file_id` with
 * `citations: {enabled: true}` — no markdown conversion, no re-download — plus
 * the batchSchemas-style schema as a forced tool call (see the header for why
 * the schema is a tool rather than `output_config.format`).
 */
export const extractIntervalsFromManual = internalAction({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (
    ctx,
    args,
  ): Promise<{ status: "ok" | "skipped" | "failed"; written: number; skipped: number; reason: string }> => {
    const none = (status: "skipped" | "failed", reason: string) => ({
      status,
      written: 0,
      skipped: 0,
      reason,
    });

    try {
      const context = await ctx.runQuery(selfApi().getManualExtractionContext, {
        vehicleConfigId: args.vehicleConfigId,
      });
      if (!context) return none("skipped", "config_not_resolvable");

      const label = `${context.year} ${context.make} ${context.model}`;
      const fileId = context.manual?.file_id ?? null;
      if (!fileId) return none("skipped", "no_manual_file");

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return none("failed", "no_anthropic_api_key");

      const model = resolveExtractionModel(process.env as Record<string, string | undefined>);
      const body = {
        model,
        max_tokens: 8000,
        tools: [
          {
            name: EXTRACTION_TOOL_NAME,
            description:
              "Record the factory maintenance schedule exactly as published in the attached manual. Every reported interval must be quotable from the document.",
            input_schema: buildManualExtractionSchema(),
          },
        ],
        tool_choice: { type: "tool", name: EXTRACTION_TOOL_NAME },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: { type: "file", file_id: fileId },
                title: `${label} ${context.manual?.doc_kind ?? "manual"}`,
                citations: { enabled: true },
              },
              { type: "text", text: buildManualExtractionPrompt(context) },
            ],
          },
        ],
      };

      let json: any;
      try {
        const res = await fetch(`${ANTHROPIC_API_BASE}/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
            "anthropic-beta": FILES_API_BETA,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(EXTRACTION_TIMEOUT_MS),
        });
        if (!res.ok) {
          const detail = (await res.text().catch(() => "")).slice(0, 300);
          return none("failed", `messages_${res.status}:${detail}`);
        }
        json = await res.json();
      } catch (e) {
        return none("failed", `messages_error:${String(e).slice(0, 200)}`);
      }

      if (json?.stop_reason === "refusal") return none("failed", "refusal");

      const payload = extractToolPayload(json, EXTRACTION_TOOL_NAME);
      if (!payload) return none("failed", "no_tool_payload");

      const rows = dedupeIntervalsByService(parseManualIntervals(payload));
      const citations = collectCitationSpans(json);
      if (rows.length === 0) {
        const notes = String(payload.notes ?? "").slice(0, 300);
        console.log(
          `[manual-library] ${label}: no storable intervals (schedule_found=${payload.schedule_found}, notes=${notes.slice(0, 160)})`,
        );
        // The extractor has just READ the document and reported that it carries
        // no maintenance schedule. That verdict is the most authoritative signal
        // available about whether this PDF was the right one — and it used to be
        // discarded, leaving a `file_id` on the row so shouldSkipManualLookup
        // read `fresh_manual` and skipped the vehicle for 180 days.
        //
        // Reject the document so the next resolve tries a different candidate.
        // Bounded by MANUAL_MAX_REJECTIONS: a vehicle whose every candidate is
        // wrong must stop costing uploads, and at that point an honest gap beats
        // burning the budget forever.
        if (payload.schedule_found === false) {
          const priorRejections = ((context.manual as any)?.rejected_urls ?? []).length;
          if (priorRejections < MANUAL_MAX_REJECTIONS) {
            try {
              await ctx.runMutation(selfApi().rejectManualRow, {
                make: context.make,
                model: context.model,
                year: context.year,
                reason: notes || "schedule_found=false",
              });
            } catch (e) {
              console.warn(`[manual-library] ${label}: could not record rejection:`, e);
            }
          } else {
            console.warn(
              `[manual-library] ${label}: ${priorRejections} candidate(s) already rejected — ` +
                `not rejecting again, leaving an honest gap`,
            );
          }
        }
        return none("skipped", "no_intervals_extracted");
      }

      const result = await ctx.runMutation(selfApi()._writeManualIntervals, {
        vehicleConfigId: args.vehicleConfigId,
        source_url: context.manual?.source_url,
        rows: rows.map((r) => ({
          service_slug: r.service_slug,
          interval_miles: r.interval_miles,
          interval_months: r.interval_months,
          display_string: r.display_string,
          quoted_text: r.quoted_text,
        })),
      });

      console.log(
        `[manual-library] ${label}: extracted ${rows.length} interval(s) from ${context.manual?.source_url} ` +
          `(oem=${context.manual?.is_oem_domain}); wrote ${result.written}, skipped ${result.skipped}; ` +
          `citations=${citations.length}`,
      );

      return { status: "ok", written: result.written, skipped: result.skipped, reason: "ok" };
    } catch (e) {
      console.warn("[manual-library] extractIntervalsFromManual failed:", e);
      return none("failed", `unexpected:${String(e).slice(0, 200)}`);
    }
  },
});

/**
 * Fleet backfill: find configs missing months on core services and schedule
 * resolve → extract for each, staggered.
 *
 * `dryRun` reports the matched configs without spending a cent — use it before
 * ever raising the limit. Never throws.
 */
export const backfillManualIntervals = internalAction({
  args: {
    limit: v.optional(v.float64()),
    dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    matched: number;
    scheduled: number;
    dryRun: boolean;
    cursor: string | null;
    isDone: boolean;
    sample: string[];
  }> => {
    try {
      const envLimit = Number(process.env.MANUAL_LIBRARY_DAILY_LIMIT ?? "");
      const configured = Number.isFinite(envLimit) && envLimit >= 0 ? envLimit : DEFAULT_BACKFILL_LIMIT;
      const limit = Math.max(0, Math.trunc(args.limit ?? configured));
      const dryRun = args.dryRun === true;

      if (limit === 0) {
        console.log("[manual-library] backfill disabled (limit 0)");
        return { matched: 0, scheduled: 0, dryRun, cursor: args.cursor ?? null, isDone: false, sample: [] };
      }

      const page = await ctx.runQuery(selfApi().manualBackfillPage, {
        limit,
        cursor: args.cursor ?? null,
      });

      const sample = page.matches.map(
        (m: any) => `${m.year} ${m.make} ${m.model} [missing: ${m.missing.join(",")}]`,
      );

      if (dryRun) {
        console.log(
          `[manual-library] backfill DRY RUN: ${page.matches.length} config(s) would run ` +
            `(scanned ${page.scanned}) — ${sample.join(" | ")}`,
        );
        return {
          matched: page.matches.length,
          scheduled: 0,
          dryRun: true,
          cursor: page.cursor,
          isDone: page.isDone,
          sample,
        };
      }

      let scheduled = 0;
      for (let i = 0; i < page.matches.length; i++) {
        const m = page.matches[i];
        const delay = i * BACKFILL_STAGGER_MS;
        await ctx.scheduler.runAfter(delay, selfApi().resolveManualForVehicle, {
          make: m.make,
          model: m.model,
          year: m.year,
        });
        // Extraction runs after the upload has had time to land. If the
        // resolve failed there is simply no file_id and extract no-ops.
        await ctx.scheduler.runAfter(delay + BACKFILL_STAGGER_MS / 2, selfApi().extractIntervalsFromManual, {
          vehicleConfigId: m.vehicle_config_id,
        });
        scheduled++;
      }

      console.log(
        `[manual-library] backfill: scheduled ${scheduled} config(s) (scanned ${page.scanned}, isDone=${page.isDone})`,
      );
      return {
        matched: page.matches.length,
        scheduled,
        dryRun: false,
        cursor: page.cursor,
        isDone: page.isDone,
        sample,
      };
    } catch (e) {
      console.warn("[manual-library] backfillManualIntervals failed:", e);
      return { matched: 0, scheduled: 0, dryRun: args.dryRun === true, cursor: null, isDone: false, sample: [] };
    }
  },
});
