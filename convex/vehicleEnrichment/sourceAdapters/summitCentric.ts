// =============================================================================
// sourceAdapters/summitCentric.ts — Centric rotor specs via Summit Racing.
//
// Summit Racing (summitracing.com) mirrors Centric's spec sheets on
// server-rendered part pages at /parts/ceb-{sku}, including the two numbers we
// want, under explicit labels:
//
//   "Nominal Thickness (mm):"  → new-rotor thickness
//   "Discard Thickness (mm):"  → THE replace-at minimum
//
// Discovery is Summit's faceted fitment search (also server-rendered):
//
//   /search/part-type/brake-rotors/year/{y}/make/{make}/model/{model}
//     /brand/centric-parts/rotor-position/{front|rear}
//
// Segment order matters: `year` MUST precede `make` (verified 2026-07-30 —
// year-after-model 302s to a URL with the fitment stripped). When a facet
// combination has zero matches Summit SILENTLY DROPS segments and serves the
// remainder (e.g. 2020 Camry + Centric → the all-years Centric rotor list).
// The parser therefore refuses any listing whose H1 does not carry the
// requested year+make — without that guard this adapter would attribute a
// random vintage Centric rotor to the wrong vehicle (law: present-but-wrong
// is forbidden; missing is fine).
//
// Fetchability (probed 2026-07-30): plain fetch — curl with a full browser UA
// and WebFetch alike — receives an Imperva/Incapsula challenge interstitial
// ("Pardon Our Interruption", reese84) with HTTP 200 and ~6 KB of challenge
// script. A real browser passes and gets plain server-rendered HTML. So
// lookup() fails open with needs_headless:true, and the parsers below are the
// deliverable: they run unchanged on headless-fetched HTML and are tested
// against fixtures captured through a real browser.
// =============================================================================

import type {
  AdapterResult,
  AdapterVehicle,
  Claim,
  SourceAdapter,
} from "./types";
import {
  classifyThicknessLabel,
  labelSupportsKind,
  ROTOR_MIN_BANDS,
} from "../rotorThickness";

const ADAPTER_NAME = "summit_centric_rotor_specs";
const BASE = "https://www.summitracing.com";
const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Plausible nominal (new) thickness band, mm — wider than the min bands. */
const NOMINAL_BAND_MM = { low: 5, high: 60 };

export type RotorPosition = "front" | "rear";

const FIELDS = [
  "rotor_front_min_thickness_mm",
  "rotor_rear_min_thickness_mm",
  "rotor_front_nominal_thickness_mm",
  "rotor_rear_nominal_thickness_mm",
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// URL construction
// ─────────────────────────────────────────────────────────────────────────────

/** Summit's path slugs: lowercase, runs of non-alphanumerics become one "-".
 *  "MX-5 Miata" → "mx-5-miata", "F-150" → "f-150". */
export function summitSlug(s: string): string {
  return (s ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Position-scoped Centric rotor listing for one vehicle. Year BEFORE make. */
export function summitSearchUrl(
  vehicle: { year: number; make: string; model: string },
  position: RotorPosition,
): string {
  return (
    `${BASE}/search/part-type/brake-rotors` +
    `/year/${vehicle.year}` +
    `/make/${summitSlug(vehicle.make)}` +
    `/model/${summitSlug(vehicle.model)}` +
    `/brand/centric-parts` +
    `/rotor-position/${position}`
  );
}

export function summitPartUrl(sku: string): string {
  return `${BASE}/parts/${sku}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Anti-bot detection
// ─────────────────────────────────────────────────────────────────────────────

/** True when the HTML is Imperva's challenge interstitial, not real content.
 *  Real Summit pages embed the reese84 sensor too, so the marker alone is not
 *  enough — the interstitial is the marker WITHOUT any page <h1>. */
export function isBotChallenge(html: string): boolean {
  if (!html) return false;
  if (/pardon our interruption/i.test(html)) return true;
  return /imperva|incapsula|reese84/i.test(html) && !/<h1[\s>]/i.test(html);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure parser #1 — fitment listing → Centric SKUs (with the segment-drop guard)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a Summit fitment-search listing into the Centric ("ceb-") SKUs it
 * shows. `verified` is false — and skus therefore empty — unless the page H1
 * names BOTH the expected year and make: Summit silently strips unmatched
 * facet segments, so an unverified page is some OTHER vehicle's (or every
 * vehicle's) listing and must yield nothing.
 */
export function parseSummitFitmentListing(
  html: string | null | undefined,
  expected: { year: number; make: string },
): { verified: boolean; skus: string[] } {
  try {
    if (!html || typeof html !== "string") return { verified: false, skus: [] };
    if (isBotChallenge(html)) return { verified: false, skus: [] };

    const h1Match =
      html.match(/<h1[^>]*id="default-results-title"[^>]*>([\s\S]*?)<\/h1>/i) ??
      html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const h1 = (h1Match?.[1] ?? "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const yearOk = h1.includes(String(expected.year));
    const makeOk = h1
      .toUpperCase()
      .includes((expected.make ?? "").trim().toUpperCase());
    if (!h1 || !yearOk || !makeOk) return { verified: false, skus: [] };

    const skus: string[] = [];
    const seen = new Set<string>();
    const re = /\/parts\/(ceb-[a-z0-9-]+)/gi;
    for (let m = re.exec(html); m; m = re.exec(html)) {
      const sku = m[1].toLowerCase();
      if (!seen.has(sku)) {
        seen.add(sku);
        skus.push(sku);
      }
    }
    return { verified: true, skus };
  } catch {
    return { verified: false, skus: [] };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure parser #2 — part page → thickness Claims
// ─────────────────────────────────────────────────────────────────────────────

type ThicknessRow = {
  /** Verbatim label text as printed, e.g. "Discard Thickness (mm):". */
  label: string;
  /** Verbatim numeric cell text, e.g. "16.00". */
  raw: string;
  valueMm: number;
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "summitracing.com";
  }
}

function mmToValue(mm: number): string {
  return String(Math.round(mm * 100) / 100);
}

/**
 * Extract per-position rotor thickness claims from one Summit part page.
 *
 * Guards (each one earns its keep against "present-but-wrong"):
 *   - bot interstitial or non-rotor part page (Part Type ≠ Brake Rotors) → [];
 *   - a label must classify via classifyThicknessLabel; only a
 *     discard-supporting label (labelSupportsKind) may feed a *_min_* field —
 *     "Minimum Machining Thickness" classifies machine_to and is dropped;
 *   - the label must carry an explicit unit "(mm)" or "(in.)" — no unit, no
 *     claim (missing beats guessed); inches are converted to mm;
 *   - values outside the physical bands are dropped;
 *   - conflicting duplicate rows for the same kind → that kind is dropped;
 *   - discard ≥ nominal is physically impossible → BOTH are dropped.
 *
 * Position is not printed on the part page; it comes from the caller, who
 * reached this page through a rotor-position-scoped search URL.
 */
export function parseSummitRotorSpecClaims(
  html: string | null | undefined,
  ctx: { position: RotorPosition; sourceUrl: string; observedAt?: number },
): Claim[] {
  try {
    if (!html || typeof html !== "string") return [];
    if (isBotChallenge(html)) return [];
    if (ctx?.position !== "front" && ctx?.position !== "rear") return [];
    // Only a brake-rotor part page may attest rotor thickness.
    if (!/Part Type:?\s*<\/strong>[\s\S]{0,400}?Brake Rotors/i.test(html)) {
      return [];
    }

    // Attribute rows are label/value div pairs:
    //   <strong>Discard Thickness (mm):</strong></div><div ...>16.00</div>
    // The value cell must be a bare number — "9.24 in." (diameter) and
    // "4 x 100.00mm" (bolt pattern) fail that shape on top of failing the
    // label filter.
    const rowRe =
      /<strong>\s*([^<]*thickness[^<]*?)\s*<\/strong>\s*<\/div>\s*<div[^>]*>\s*([0-9]+(?:\.[0-9]+)?)\s*<\/div>/gi;

    const discard: ThicknessRow[] = [];
    const nominal: ThicknessRow[] = [];
    for (let m = rowRe.exec(html); m; m = rowRe.exec(html)) {
      const label = m[1].trim();
      const raw = m[2];
      const kind = classifyThicknessLabel(label);
      if (kind !== "discard_min" && kind !== "nominal") continue;

      // Unit lives in the label — "(mm)" / "(in.)". No unit → no claim.
      let valueMm: number;
      if (/\(\s*mm\s*\)/i.test(label)) {
        valueMm = parseFloat(raw);
      } else if (/\(\s*in\.?\s*\)/i.test(label)) {
        valueMm = Math.round(parseFloat(raw) * 25.4 * 100) / 100;
      } else {
        continue;
      }
      if (!Number.isFinite(valueMm)) continue;

      if (kind === "discard_min") {
        // The structural guard, reused verbatim from rotorThickness.ts.
        if (!labelSupportsKind(label, "discard_min")) continue;
        const band = ROTOR_MIN_BANDS[ctx.position];
        if (valueMm < band.validLow || valueMm > band.validHigh) continue;
        discard.push({ label, raw, valueMm });
      } else {
        if (valueMm < NOMINAL_BAND_MM.low || valueMm > NOMINAL_BAND_MM.high) {
          continue;
        }
        nominal.push({ label, raw, valueMm });
      }
    }

    // Conflicting duplicates for a kind → refuse that kind.
    const distinct = (rows: ThicknessRow[]) =>
      new Set(rows.map((r) => r.valueMm)).size;
    let min: ThicknessRow | null =
      discard.length > 0 && distinct(discard) === 1 ? discard[0] : null;
    let nom: ThicknessRow | null =
      nominal.length > 0 && distinct(nominal) === 1 ? nominal[0] : null;

    // A discard minimum at or above the new thickness is nonsense — the page
    // (or our read of it) is wrong, so neither number can be trusted.
    if (min && nom && min.valueMm >= nom.valueMm) {
      min = null;
      nom = null;
    }

    const sourceDomain = hostOf(ctx.sourceUrl);
    const observedAt = ctx.observedAt ?? Date.now();
    const claims: Claim[] = [];
    if (min) {
      claims.push({
        field_key: `rotor_${ctx.position}_min_thickness_mm`,
        value: mmToValue(min.valueMm),
        value_raw: min.raw,
        source_family: "aftermarket_catalog",
        source_domain: sourceDomain,
        source_url: ctx.sourceUrl,
        method: "deterministic_parse",
        observed_label: min.label,
        observed_at: observedAt,
      });
    }
    if (nom) {
      claims.push({
        field_key: `rotor_${ctx.position}_nominal_thickness_mm`,
        value: mmToValue(nom.valueMm),
        value_raw: nom.raw,
        source_family: "aftermarket_catalog",
        source_domain: sourceDomain,
        source_url: ctx.sourceUrl,
        method: "deterministic_parse",
        observed_label: nom.label,
        observed_at: observedAt,
      });
    }
    return claims;
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch + adapter
// ─────────────────────────────────────────────────────────────────────────────

type FetchOutcome = {
  finalUrl: string;
  text: string;
  /** Anti-bot wall (HTTP 403/429 or the Imperva interstitial). */
  blocked: boolean;
};

async function fetchText(url: string): Promise<FetchOutcome> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "follow",
    headers: {
      "User-Agent": USER_AGENT,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  const text = await res.text();
  if (res.status === 403 || res.status === 429 || isBotChallenge(text)) {
    return { finalUrl: res.url || url, text, blocked: true };
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return { finalUrl: res.url || url, text, blocked: false };
}

async function lookup(vehicle: AdapterVehicle): Promise<AdapterResult> {
  try {
    const claims: Claim[] = [];
    for (const position of ["front", "rear"] as const) {
      const searchUrl = summitSearchUrl(vehicle, position);
      const search = await fetchText(searchUrl);
      if (search.blocked) {
        return {
          adapter: ADAPTER_NAME,
          ok: false,
          claims: [],
          needs_headless: true,
          error:
            "summitracing.com serves an Imperva challenge to plain fetch " +
            "(verified 2026-07-30); parsers are headless-ready",
        };
      }
      // Zero-match facet combinations 302 to a URL with the fitment segments
      // stripped — that page lists OTHER vehicles' parts. Skip the position.
      if (!/\/year\//.test(search.finalUrl)) continue;
      const listing = parseSummitFitmentListing(search.text, {
        year: vehicle.year,
        make: vehicle.make,
      });
      if (!listing.verified || listing.skus.length === 0) continue;

      const part = await fetchText(summitPartUrl(listing.skus[0]));
      if (part.blocked) {
        return {
          adapter: ADAPTER_NAME,
          ok: false,
          claims: [],
          needs_headless: true,
          error:
            "summitracing.com serves an Imperva challenge to plain fetch " +
            "(verified 2026-07-30); parsers are headless-ready",
        };
      }
      claims.push(
        ...parseSummitRotorSpecClaims(part.text, {
          position,
          sourceUrl: part.finalUrl,
        }),
      );
    }
    return { adapter: ADAPTER_NAME, ok: true, claims };
  } catch (e) {
    return {
      adapter: ADAPTER_NAME,
      ok: false,
      claims: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export const summitCentricAdapter: SourceAdapter = {
  name: ADAPTER_NAME,
  family: "aftermarket_catalog",
  fields: FIELDS,
  lookup,
};
