// =============================================================================
// sourceAdapters/brembo.ts — Brembo disc-catalogue adapter (rotor thickness).
//
// Family: aftermarket_catalog. Attests the four rotor-thickness fields:
//   rotor_{front,rear}_min_thickness_mm      (Brembo's "Min. thickness")
//   rotor_{front,rear}_nominal_thickness_mm  (Brembo's "Thickness (TH)")
//
// FETCH PATH (verified live 2026-07-30 against 2020 Toyota Camry 2.5 and
// 2019 Ford F-150 5.0): bremboparts.com is server-rendered ASP.NET. Part pages
// are stable, plain-fetchable URLs:
//
//   https://www.bremboparts.com/europe/en/catalogue/disc/{part}   e.g. 09-9554-10
//
// with an explicit spec table:  <div class="label">Min. thickness</div>
//                               <div class="detail">19<span class="unit">mm</span></div>
// plus "Thickness (TH)" (nominal), "Axle" (Front/Rear), "Diameter Ø".
//
// Vehicle DISCOVERY is the site's own JSON search API (found in App.routes of
// the served HTML — no headless browser needed), guarded by the standard
// ASP.NET antiforgery pair: GET any page → `aft` cookie + hidden
// `__RequestVerificationToken` input, then POST JSON with header
// `RequestVerificationToken: {token}` and the cookie. Missing token → the
// endpoints 404. Verified cascade (region "europe"; "north-america" is NOT a
// valid region — the region list is europe/america/asiapacific/africa):
//
//   POST /europe/en/catalogue/search/getsearchbrands {vehicleType:"Car"}
//     → [{brandName:"TOYOTA", brandCode:"000111"}, {brandName:"FORD USA", ...}]
//   POST .../getsearchmodels {brandCode, vehicleType:"Car"}
//     → [{modelName:"CAMRY (_V7_, _VA7_, _VH7_)", modelCode:"38154",
//         modelDateStart:"06/17", modelDateEnd:">"}]
//   POST .../getsearchtypes {brandCode, modelCode, vehicleType:"Car"}
//     → [{typeName:"2.5 (ASV70_, ASV70R)", typeCodeAndVehicleType:"000130701-1",
//         typeDateStart:"08/17", typeDateEnd:">", kw, cv}]
//   POST .../searchtype {brandCode, modelCode, typeCodeAndVehicleType}
//     → {url:"/europe/en/catalogue/toyota-camry-.../000130701-1"}
//   GET that url → hrefs "/europe/en/catalogue/disc/{part}" → GET each part page.
//
// US vehicles live in the TecDoc-style catalogue under their European brand
// entries ("TOYOTA" carries ASV70R Camrys; F-150 lives under "FORD USA").
//
// AMBIGUITY LAW (present-but-wrong is forbidden): Y/M/M+displacement can match
// several catalogue applications (cab styles, 2WD/4WD, open-ended date rows of
// a prior generation). All matched applications' discs are pooled and a field
// is emitted ONLY when every disc for that axle agrees on one value — a value
// that survives is true regardless of which variant the actual vehicle is.
//
// REAL DATA QUIRKS seen live and guarded here (fixture disc-08-D418-11.html):
//   - decimal commas: "10,5mm" → 10.5;
//   - a bogus "Thickness (TH) 112mm" on the rear Camry disc (out of any
//     plausible nominal band) — implausible values are DROPPED, and a nominal
//     that does not exceed its own page's minimum discards both.
//
// NOTE: Brembo's "Min. thickness" is the discard spec for THEIR disc and can
// differ from the OEM rotor's stamped minimum (e.g. Camry XV70 front: Brembo
// 25mm vs Toyota 26mm). It is one aftermarket_catalog voice for the ledger,
// never overriding consensus.
// =============================================================================

import type {
  AdapterResult,
  AdapterVehicle,
  Claim,
  SourceAdapter,
} from "./types";
import { labelSupportsKind, ROTOR_MIN_BANDS } from "../rotorThickness";

const ADAPTER_NAME = "brembo";
const BASE = "https://www.bremboparts.com";
const REGION_PATH = "/europe/en";
const SOURCE_DOMAIN = "bremboparts.com";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export const BREMBO_FIELDS = [
  "rotor_front_min_thickness_mm",
  "rotor_rear_min_thickness_mm",
  "rotor_front_nominal_thickness_mm",
  "rotor_rear_nominal_thickness_mm",
] as const;

/** Nominal (new) disc thickness plausibility band, mm — mirrors the
 *  THICKNESS_MM guard in rotorThickness.ts (module-private there). */
const NOMINAL_VALID_MM = { low: 5, high: 60 };

// Fetch budget — the cascade fans out across catalogue variants; these caps
// bound worst-case network cost while covering the observed 2–4 discs per axle.
const MAX_BRAND_CANDIDATES = 2;
const MAX_MODEL_CANDIDATES = 6;
const MAX_TYPE_CANDIDATES = 4;
const MAX_DISC_PAGES = 6;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure parsers — string in, Claims out, NEVER throw (fail open).
// ─────────────────────────────────────────────────────────────────────────────

function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type SpecItem = { label: string; text: string };

/** Every <div class="label">…</div><div class="detail">…</div> pair. */
function extractSpecItems(html: string): SpecItem[] {
  const out: SpecItem[] = [];
  const re =
    /<div class="label">([\s\S]*?)<\/div>\s*<div class="detail"[^>]*>([\s\S]*?)<\/div>/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const label = stripTags(m[1]);
    const text = stripTags(m[2]).replace(/\s+/g, "");
    if (label !== "") out.push({ label, text });
  }
  return out;
}

/** "19mm" / "10,5mm" → millimetres. Anything without an explicit trailing
 *  mm unit (counts, torque "108Nm", EANs) is refused — missing beats guessed. */
function mmValue(text: string): number | null {
  const m = /^(\d{1,3}(?:[.,]\d{1,2})?)mm$/i.exec(text);
  if (!m) return null;
  const mm = parseFloat(m[1].replace(",", "."));
  return Number.isFinite(mm) ? round2(mm) : null;
}

function canonicalUrl(html: string): string | null {
  const m = /<link\s+rel="canonical"\s+href="([^"]+)"/i.exec(html);
  return m ? m[1] : null;
}

type Axle = "front" | "rear";

/**
 * Parse ONE Brembo disc part page into rotor-thickness Claims.
 *
 * Guarantees:
 *   - no "Axle" field on the page → NO claims (axle can never be guessed);
 *   - a value is used only under a label that labelSupportsKind() accepts for
 *     its kind ("Min. thickness" → discard_min, "Thickness (TH)" → nominal);
 *   - values outside the plausibility bands are dropped, and a page whose
 *     nominal does not exceed its minimum yields neither (inconsistent page);
 *   - two same-kind labels with different values on one page → that kind is
 *     dropped (page ambiguity);
 *   - malformed input → [].
 */
export function parseBremboDiscPage(
  html: string | null | undefined,
  opts?: { source_url?: string; observed_at?: number },
): Claim[] {
  try {
    if (!html) return [];
    const items = extractSpecItems(html);
    if (items.length === 0) return [];

    const axleItem = items.find((i) => /^axle$/i.test(i.label));
    if (!axleItem) return [];
    const axleText = axleItem.text.toLowerCase();
    const axle: Axle | null =
      axleText === "front" ? "front" : axleText === "rear" ? "rear" : null;
    if (!axle) return [];

    type Reading = { label: string; raw: string; mm: number };
    const mins: Reading[] = [];
    const nominals: Reading[] = [];
    for (const item of items) {
      const mm = mmValue(item.text);
      if (mm === null) continue;
      if (labelSupportsKind(item.label, "discard_min")) {
        const band = ROTOR_MIN_BANDS[axle];
        if (mm < band.validLow || mm > band.validHigh) continue;
        mins.push({ label: item.label, raw: item.text, mm });
      } else if (labelSupportsKind(item.label, "nominal")) {
        if (mm < NOMINAL_VALID_MM.low || mm > NOMINAL_VALID_MM.high) continue;
        nominals.push({ label: item.label, raw: item.text, mm });
      }
    }

    let min = mins.length > 0 ? mins[0] : null;
    if (mins.some((r) => r.mm !== mins[0].mm)) min = null;
    let nominal = nominals.length > 0 ? nominals[0] : null;
    if (nominals.some((r) => r.mm !== nominals[0].mm)) nominal = null;

    // A nominal that does not exceed the same page's minimum means at least
    // one of the two is mislabeled — trust neither.
    if (min && nominal && nominal.mm <= min.mm) {
      min = null;
      nominal = null;
    }

    const sourceUrl =
      opts?.source_url ?? canonicalUrl(html) ?? `${BASE}${REGION_PATH}`;
    const observedAt = opts?.observed_at ?? Date.now();
    const base = {
      source_family: "aftermarket_catalog" as const,
      source_domain: SOURCE_DOMAIN,
      source_url: sourceUrl,
      method: "deterministic_parse" as const,
      observed_at: observedAt,
    };

    const claims: Claim[] = [];
    if (min) {
      claims.push({
        field_key: `rotor_${axle}_min_thickness_mm`,
        value: String(min.mm),
        value_raw: min.raw,
        observed_label: min.label,
        ...base,
      });
    }
    if (nominal) {
      claims.push({
        field_key: `rotor_${axle}_nominal_thickness_mm`,
        value: String(nominal.mm),
        value_raw: nominal.raw,
        observed_label: nominal.label,
        ...base,
      });
    }
    return claims;
  } catch {
    return [];
  }
}

/** Disc part-page paths ("/{region}/{lang}/catalogue/disc/{part}") from an
 *  application results page. Pads/kits/drums are excluded by the URL family.
 *  Order-preserving dedup; malformed input → []. */
export function extractDiscLinks(html: string | null | undefined): string[] {
  try {
    if (!html) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    const re = /href="((?:\/[a-z-]+\/[a-z]+)?\/catalogue\/disc\/[A-Za-z0-9._-]+)"/g;
    for (let m = re.exec(html); m; m = re.exec(html)) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        out.push(m[1]);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Cross-variant agreement: pool the per-page claims from every disc that the
 * catalogue offered for the matched applications, and keep a field ONLY when
 * every disc attesting it printed the same value. One claim survives per
 * field; conflicts (different brake packages, mixed generations) emit nothing.
 */
export function reconcileDiscClaims(claims: Claim[]): Claim[] {
  const byField = new Map<string, Claim[]>();
  for (const c of claims) {
    const list = byField.get(c.field_key) ?? [];
    list.push(c);
    byField.set(c.field_key, list);
  }
  const out: Claim[] = [];
  for (const list of byField.values()) {
    const distinct = new Set(list.map((c) => c.value));
    if (distinct.size === 1) out.push(list[0]);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Catalogue matching helpers (pure, exported for tests).
// ─────────────────────────────────────────────────────────────────────────────

function tokensOf(name: string): string[] {
  return (name ?? "")
    .replace(/\([^)]*\)/g, " ") // "(_V7_, _VA7_)" chassis codes are noise
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

/** Token-prefix match: "F-150" matches "F-150 Crew Cab Pickup"; "Camry"
 *  matches "CAMRY (_V7_, _VA7_, _VH7_)" but never "COROLLA". Deliberately
 *  admits body-style siblings — the year filter plus the cross-variant
 *  agreement rule make inclusion safe, exclusion lossy. */
export function modelNameMatches(target: string, candidate: string): boolean {
  const t = tokensOf(target);
  const c = tokensOf(candidate);
  if (t.length === 0 || c.length < t.length) return false;
  return t.every((tok, i) => c[i] === tok);
}

function yearOfDateToken(token: string | null | undefined): number | null {
  const m = /(\d{2})\s*$/.exec((token ?? "").trim());
  if (!m || !/\d{1,2}\/\d{2}$/.test((token ?? "").trim())) return null;
  const yy = parseInt(m[1], 10);
  return yy >= 50 ? 1900 + yy : 2000 + yy;
}

/** TecDoc-style "06/17".."10/01"/">" range check, calendar-year granularity.
 *  Unparseable ends are treated as open (the type/agreement layers guard). */
export function dateRangeContainsYear(
  start: string | null | undefined,
  end: string | null | undefined,
  year: number,
): boolean {
  const s = yearOfDateToken(start);
  const e = yearOfDateToken(end);
  if (s !== null && year < s) return false;
  if (e !== null && year > e) return false;
  return true;
}

/** Leading litres in a typeName ("2.5 (ASV70_)" → 2.5) vs the vehicle's
 *  displacement. Unparseable / non-litre leads (Mercedes "C 220 CDI") cannot
 *  be verified and are KEPT — the agreement rule absorbs them. */
export function displacementMatches(
  typeName: string | null | undefined,
  displacementL: number | null | undefined,
): boolean {
  if (displacementL == null) return true;
  const m = /^\s*(\d+(?:[.,]\d+)?)/.exec(typeName ?? "");
  if (!m) return true;
  const lead = parseFloat(m[1].replace(",", "."));
  if (!Number.isFinite(lead) || lead > 9.9) return true;
  return Math.abs(lead - displacementL) < 0.06;
}

/** Uppercase alphanumerics only, for brand equality ("F-150" ≡ "F150"). */
function normName(s: string): string {
  return (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch plumbing.
// ─────────────────────────────────────────────────────────────────────────────

type FetchOutcome = { status: number; body: string; cookies: string };

function collectCookies(res: Response): string {
  const h = res.headers as unknown as { getSetCookie?: () => string[] };
  let raw: string[] = [];
  if (typeof h.getSetCookie === "function") {
    raw = h.getSetCookie();
  } else {
    const single = res.headers.get("set-cookie");
    // Fold-split only at what looks like the start of a new cookie pair.
    if (single) raw = single.split(/,(?=\s*[A-Za-z0-9_.!#$%&'*+^`|~-]+=)/);
  }
  return raw
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

async function fetchPage(url: string, cookie: string): Promise<FetchOutcome> {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.text();
  return { status: res.status, body, cookies: collectCookies(res) };
}

type Session = { token: string; cookie: string };

async function postSearch(
  path: string,
  payload: Record<string, string>,
  session: Session,
): Promise<FetchOutcome> {
  const res = await fetch(`${BASE}${REGION_PATH}/catalogue/${path}`, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      RequestVerificationToken: session.token,
      ...(session.cookie ? { Cookie: session.cookie } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.text();
  return { status: res.status, body, cookies: collectCookies(res) };
}

function looksBlocked(outcome: FetchOutcome): boolean {
  if (outcome.status === 403 || outcome.status === 429) return true;
  return /captcha|access denied|cloudflare|akamai|are you a robot/i.test(
    outcome.body.slice(0, 3000),
  );
}

function extractAntiforgeryToken(html: string): string | null {
  const m =
    /name="__RequestVerificationToken"[^>]*\bvalue="([^"]+)"/.exec(html) ??
    /\bvalue="([^"]+)"[^>]*name="__RequestVerificationToken"/.exec(html);
  return m ? m[1] : null;
}

function parseJsonArray(body: string): Array<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (row): row is Record<string, unknown> =>
        row !== null && typeof row === "object",
    );
  } catch {
    return [];
  }
}

function str(row: Record<string, unknown>, key: string): string | null {
  const v = row[key];
  return typeof v === "string" && v !== "" ? v : null;
}

function fail(error: string, needsHeadless = false): AdapterResult {
  return {
    adapter: ADAPTER_NAME,
    ok: false,
    claims: [],
    ...(needsHeadless ? { needs_headless: true } : {}),
    error,
  };
}

/** Successful lookup that found nothing claimable — diagnostic preserved. */
function empty(note: string): AdapterResult {
  return { adapter: ADAPTER_NAME, ok: true, claims: [], error: note };
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter.
// ─────────────────────────────────────────────────────────────────────────────

async function lookupBrembo(vehicle: AdapterVehicle): Promise<AdapterResult> {
  try {
    // 0) Bootstrap the antiforgery pair: aft cookie + hidden token input.
    const boot = await fetchPage(`${BASE}${REGION_PATH}`, "");
    if (looksBlocked(boot)) {
      return fail(`blocked at bootstrap (HTTP ${boot.status})`, true);
    }
    if (boot.status !== 200) return fail(`bootstrap HTTP ${boot.status}`);
    const token = extractAntiforgeryToken(boot.body);
    if (!token) {
      return fail("antiforgery token not found on bootstrap page — layout changed");
    }
    const session: Session = { token, cookie: boot.cookies };

    // 1) Brand. US makes may live under a "{MAKE} USA" brand entry.
    const brandsRes = await postSearch(
      "search/getsearchbrands",
      { vehicleType: "Car" },
      session,
    );
    if (looksBlocked(brandsRes)) {
      return fail(`blocked at brands lookup (HTTP ${brandsRes.status})`, true);
    }
    const brands = parseJsonArray(brandsRes.body);
    if (brands.length === 0) {
      return fail(
        `brands lookup returned no data (HTTP ${brandsRes.status}) — antiforgery handshake may have changed`,
      );
    }
    const wanted = new Set([
      normName(vehicle.make),
      normName(`${vehicle.make} USA`),
    ]);
    const brandHits = brands
      .filter((b) => wanted.has(normName(str(b, "brandName") ?? "")))
      .slice(0, MAX_BRAND_CANDIDATES);
    if (brandHits.length === 0) {
      return empty(`make "${vehicle.make}" not in Brembo catalogue`);
    }

    // 2) Models: name token-prefix + year-range filter.
    const modelHits: Array<{ brandCode: string; modelCode: string }> = [];
    for (const b of brandHits) {
      const brandCode = str(b, "brandCode");
      if (!brandCode) continue;
      const res = await postSearch(
        "search/getsearchmodels",
        { brandCode, vehicleType: "Car" },
        session,
      );
      if (looksBlocked(res)) {
        return fail(`blocked at models lookup (HTTP ${res.status})`, true);
      }
      for (const m of parseJsonArray(res.body)) {
        const modelName = str(m, "modelName");
        const modelCode = str(m, "modelCode");
        if (!modelName || !modelCode) continue;
        if (!modelNameMatches(vehicle.model, modelName)) continue;
        if (
          !dateRangeContainsYear(
            str(m, "modelDateStart"),
            str(m, "modelDateEnd"),
            vehicle.year,
          )
        ) {
          continue;
        }
        modelHits.push({ brandCode, modelCode });
        if (modelHits.length >= MAX_MODEL_CANDIDATES) break;
      }
      if (modelHits.length >= MAX_MODEL_CANDIDATES) break;
    }
    if (modelHits.length === 0) {
      return empty(
        `no ${vehicle.year} ${vehicle.make} ${vehicle.model} in Brembo catalogue`,
      );
    }

    // 3) Engine types: year-range + displacement filter.
    const typeHits: Array<{
      brandCode: string;
      modelCode: string;
      typeCodeAndVehicleType: string;
    }> = [];
    for (const mh of modelHits) {
      if (typeHits.length >= MAX_TYPE_CANDIDATES) break;
      const res = await postSearch(
        "search/getsearchtypes",
        { brandCode: mh.brandCode, modelCode: mh.modelCode, vehicleType: "Car" },
        session,
      );
      if (looksBlocked(res)) {
        return fail(`blocked at types lookup (HTTP ${res.status})`, true);
      }
      for (const t of parseJsonArray(res.body)) {
        const tcv = str(t, "typeCodeAndVehicleType");
        if (!tcv) continue;
        if (
          !dateRangeContainsYear(
            str(t, "typeDateStart"),
            str(t, "typeDateEnd"),
            vehicle.year,
          )
        ) {
          continue;
        }
        if (!displacementMatches(str(t, "typeName"), vehicle.displacement_l)) {
          continue;
        }
        typeHits.push({ ...mh, typeCodeAndVehicleType: tcv });
        if (typeHits.length >= MAX_TYPE_CANDIDATES) break;
      }
    }
    if (typeHits.length === 0) {
      return empty(
        `no engine-type match for ${vehicle.year} ${vehicle.make} ${vehicle.model}` +
          (vehicle.displacement_l != null ? ` ${vehicle.displacement_l}L` : ""),
      );
    }

    // 4) Application pages → disc part links.
    const discPaths = new Set<string>();
    for (const th of typeHits) {
      const sRes = await postSearch("search/searchtype", th, session);
      if (looksBlocked(sRes)) {
        return fail(`blocked at searchtype (HTTP ${sRes.status})`, true);
      }
      let appUrl: string | null = null;
      try {
        const parsed = JSON.parse(sRes.body) as { url?: unknown };
        if (typeof parsed.url === "string" && parsed.url.startsWith("/")) {
          appUrl = parsed.url;
        }
      } catch {
        appUrl = null;
      }
      if (!appUrl) continue;
      const listRes = await fetchPage(`${BASE}${appUrl}`, session.cookie);
      if (looksBlocked(listRes)) {
        return fail(`blocked at application page (HTTP ${listRes.status})`, true);
      }
      if (listRes.status !== 200) continue;
      for (const p of extractDiscLinks(listRes.body)) discPaths.add(p);
    }
    if (discPaths.size === 0) {
      return empty(
        `application matched but no catalogue discs listed for ${vehicle.year} ${vehicle.make} ${vehicle.model}`,
      );
    }

    // 5) Disc part pages → per-page claims → cross-variant agreement.
    const pooled: Claim[] = [];
    for (const path of [...discPaths].slice(0, MAX_DISC_PAGES)) {
      const url = `${BASE}${path}`;
      const dRes = await fetchPage(url, session.cookie);
      if (looksBlocked(dRes)) {
        return fail(`blocked at disc page ${path} (HTTP ${dRes.status})`, true);
      }
      if (dRes.status !== 200) continue;
      pooled.push(...parseBremboDiscPage(dRes.body, { source_url: url }));
    }
    const claims = reconcileDiscClaims(pooled);
    if (claims.length === 0) {
      return empty(
        `disc pages yielded no consistent thickness data (${discPaths.size} discs pooled)`,
      );
    }
    return { adapter: ADAPTER_NAME, ok: true, claims };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export const bremboAdapter: SourceAdapter = {
  name: ADAPTER_NAME,
  family: "aftermarket_catalog",
  fields: BREMBO_FIELDS,
  lookup: lookupBrembo,
};
