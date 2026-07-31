// =============================================================================
// sourceAdapters/amsoil.ts — AMSOIL vehicle-lookup adapter.
//
// Family: aggregator — AMSOIL aggregates OEM service specs independently of
// dealer storefronts, so its agreement with an oem_catalog source is real
// corroboration under the family-diversity math.
//
// FETCH PATH (verified live 2026-07-30 against 2020 Toyota Camry 2.5L A25A-FKS
// and 2019 Ford F-150 5.0L): the Y/M/M/E cascade on
// amsoil.com/lookup/auto-and-light-truck/ is driven by a plain-GET JSON API
// (endpoints lifted from the site's own lookupVehicle_ddl.js):
//
//   https://api-1.amsoil.com/api/Fitment/GetYears?lookupCode=autoandlighttruck
//   …/GetMakes?lookupCode&year                       → [{id,value}]
//   …/GetModels?lookupCode&year&equipmentMakeId      → [{id,value}]
//   …/GetEngines?lookupCode&year&equipmentMakeId&equipmentModelId
//                                                    → [{id,value}]  (value e.g.
//                                            "2.5L 4 -cyl Engine Code A25A-FKS B")
//   …/GetVehicleDetails?equipmentUnitId              → {url, lookupCode, …}
//
// api-1.amsoil.com answers plain fetch with a bare browser User-Agent — the
// whole cascade is deterministic JSON. The final vehicle page
// (www.amsoil.com/lookup/auto-and-light-truck/{url}) sits behind Cloudflare
// bot management that fingerprints the TLS stack: identical headers pass via
// curl (Chrome-profile header set, verified 200 repeatedly) but draw a hard
// 403 via Node's fetch/undici regardless of headers. Any challenge/403 is
// reported as needs_headless WITH the resolved page URL in the error, so the
// headless tier can fetch just that page and feed parseAmsoilVehiclePage.
//
// WHAT THE PAGE ACTUALLY CARRIES (probed, not assumed): server-rendered
// per-section spec tables (<table id="notes_…">) under h3 section headings:
//   Engine Oil → Viscosity / Capacity / Torque("30 ft/lbs (Oil Drain Plug)…")
//   Coolant    → Capacity ("7.3 quarts.")
// The modern site has NO spark-plug, wiper, or cabin-filter sections, and its
// filter listings carry only AMSOIL/WIX SKUs — no OE cross-reference numbers.
// So this adapter emits SPEC fields only:
//   oil_viscosity, oil_capacity_qts, coolant_capacity_qts,
//   drain_plug_torque_ft_lbs (planned Phase-0 key, not yet in V4_FIELD_KEYS).
//
// AMBIGUITY LAW (present-but-wrong is forbidden):
//   - Engine resolution must be unique after displacement/cylinder/engine-code
//     filters; two surviving candidates (e.g. A25A-FKS gas vs A25A-FXS hybrid
//     when no engine_code is supplied) → no lookup, never a guess.
//   - Multi-band viscosity charts ("10W-30 (Above 0°F) 5W-30 (Below 32°F)")
//     are emitted ONLY when one grade is marked (All TEMPS) or the cell holds
//     a single distinct grade.
//   - ATF capacities ("Total Fill 13.1" vs "5.1 Initial Fill") and axle-variant
//     diff/transfer-case capacities are deliberately NOT emitted — AMSOIL's
//     fill labels don't map cleanly onto the drain-and-fill contract.
// =============================================================================

import type {
  AdapterResult,
  AdapterVehicle,
  Claim,
  SourceAdapter,
} from "./types";

const ADAPTER_NAME = "amsoil";
const SOURCE_DOMAIN = "amsoil.com";
const API_ROOT = "https://api-1.amsoil.com/api/Fitment/";
const PAGE_ROOT = "https://www.amsoil.com/lookup/auto-and-light-truck/";
const LOOKUP_CODE = "autoandlighttruck";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Full Chrome navigation profile — required to pass www.amsoil.com's
 *  Cloudflare managed challenge on plain fetch (verified: sparse headers get
 *  the interstitial, this set gets HTTP 200 consistently). */
const PAGE_HEADERS: Record<string, string> = {
  "User-Agent": USER_AGENT,
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "sec-ch-ua": '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Upgrade-Insecure-Requests": "1",
};

export const AMSOIL_FIELDS: readonly string[] = [
  "oil_viscosity",
  "oil_capacity_qts",
  "coolant_capacity_qts",
  // Planned Phase-0 field — not in V4_FIELD_KEYS yet; emitted by agreement.
  "drain_plug_torque_ft_lbs",
];

// ─────────────────────────────────────────────────────────────────────────────
// Small text utilities.
// ─────────────────────────────────────────────────────────────────────────────

/** Uppercase alphanumerics only — "F-150" ≡ "F150", "Mercedes-Benz" ≡
 *  "Mercedes Benz". */
function normName(s: string): string {
  return (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Strip tags, decode the entities AMSOIL actually uses, collapse whitespace. */
function cleanHtmlText(fragment: string): string {
  return fragment
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, " ")
    .trim();
}

/** Canonical number-as-string ("4.80" → "4.8"). */
function numStr(raw: string): string | null {
  const n = Number(raw);
  return Number.isFinite(n) ? String(n) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure parsers — string in, structures out, NEVER throw (fail open).
// ─────────────────────────────────────────────────────────────────────────────

export type IdValueOption = { id: string; value: string };

/** Parse a GetYears/GetMakes/GetModels/GetEngines response. Malformed → []. */
export function parseIdValueOptions(json: string): IdValueOption[] {
  try {
    const arr = JSON.parse(json) as unknown;
    if (!Array.isArray(arr)) return [];
    const out: IdValueOption[] = [];
    for (const row of arr) {
      if (row == null || typeof row !== "object") continue;
      const id = (row as { id?: unknown }).id;
      const value = (row as { value?: unknown }).value;
      if (typeof id !== "string" && typeof id !== "number") continue;
      if (typeof value !== "string" && typeof value !== "number") continue;
      out.push({ id: String(id), value: String(value).trim() });
    }
    return out;
  } catch {
    return [];
  }
}

/** Resolve a make: exact normalized match, else UNIQUE containment either way
 *  ("Nissan" → "Nissan/Datsun"). Multiple containment hits → null, no guess. */
export function pickMake(
  options: IdValueOption[],
  make: string,
): IdValueOption | null {
  const m = normName(make);
  if (m === "") return null;
  const exact = options.filter((o) => normName(o.value) === m);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const contains = options.filter((o) => {
    const c = normName(o.value);
    return c.includes(m) || m.includes(c);
  });
  return contains.length === 1 ? contains[0] : null;
}

/** Resolve a model: exact normalized match, else "{model} PICKUP" (AMSOIL's
 *  truck naming: "F150 PICKUP"), else UNIQUE prefix match. Ambiguity → null. */
export function pickModel(
  options: IdValueOption[],
  model: string,
): IdValueOption | null {
  const m = normName(model);
  if (m === "") return null;
  const exact = options.filter((o) => normName(o.value) === m);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const pickup = options.filter((o) => normName(o.value) === `${m}PICKUP`);
  if (pickup.length === 1) return pickup[0];
  const prefix = options.filter((o) => normName(o.value).startsWith(m));
  return prefix.length === 1 ? prefix[0] : null;
}

/** Parse "2.5L 4 -cyl Engine Code A25A-FKS B" style engine strings. */
function engineFacets(value: string): {
  displacementL: number | null;
  cylinders: number | null;
} {
  const disp = /(\d+(?:\.\d+)?)\s*L\b/i.exec(value);
  const cyl = /(\d+)\s*-?\s*cyl/i.exec(value);
  return {
    displacementL: disp ? Number(disp[1]) : null,
    cylinders: cyl ? Number(cyl[1]) : null,
  };
}

/**
 * Resolve the engine option for a vehicle. Displacement is a HARD filter
 * (wrong displacement is a different vehicle); cylinders and engine_code are
 * soft filters (skipped when they'd empty the list — AMSOIL's code notation,
 * e.g. "[5] 5 Flex", doesn't always contain the pipeline's code). The result
 * must be UNIQUE after filtering; anything else → null (guessing between
 * A25A-FKS and its FXS hybrid sibling is forbidden).
 */
export function pickEngine(
  options: IdValueOption[],
  vehicle: Pick<
    AdapterVehicle,
    "engine_code" | "displacement_l" | "cylinders"
  >,
): IdValueOption | null {
  let cands = options.map((o) => ({
    o,
    ...engineFacets(o.value),
    norm: normName(o.value),
  }));
  if (vehicle.displacement_l != null) {
    const want = vehicle.displacement_l;
    cands = cands.filter(
      (c) => c.displacementL != null && Math.abs(c.displacementL - want) < 0.05,
    );
  }
  if (vehicle.cylinders != null) {
    const f = cands.filter((c) => c.cylinders === vehicle.cylinders);
    if (f.length > 0) cands = f;
  }
  if (vehicle.engine_code) {
    const code = normName(vehicle.engine_code);
    if (code.length >= 3) {
      const f = cands.filter((c) => c.norm.includes(code));
      if (f.length > 0) cands = f;
    }
  }
  return cands.length === 1 ? cands[0].o : null;
}

/** Parse a GetVehicleDetails response → vehicle-page path ("2020/toyota/…/").
 *  Anything malformed or off-catalog → null. */
export function parseVehicleDetailsUrl(json: string): string | null {
  try {
    const obj = JSON.parse(json) as {
      url?: unknown;
      lookupCode?: unknown;
    };
    if (obj.lookupCode !== LOOKUP_CODE) return null;
    if (typeof obj.url !== "string" || obj.url.trim() === "") return null;
    return obj.url.trim().replace(/^\/+/, "");
  } catch {
    return null;
  }
}

// ── Vehicle-page parser ──────────────────────────────────────────────────────

const SECTION_ENGINE_OIL = "ENGINE OIL";
const SECTION_COOLANT = "COOLANT";

type SpecRow = { header: string; text: string };

/** Extract {header,text} rows from one notes_* table's inner HTML. */
function tableRows(inner: string): SpecRow[] {
  const rows: SpecRow[] = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(inner)) !== null) {
    const th = /<th[^>]*>([\s\S]*?)<\/th>/i.exec(m[1]);
    const td = /<td[^>]*>([\s\S]*?)<\/td>/i.exec(m[1]);
    if (!th || !td) continue;
    const header = cleanHtmlText(th[1]).replace(/:$/, "").trim();
    const text = cleanHtmlText(td[1]);
    if (header !== "" && text !== "") rows.push({ header, text });
  }
  return rows;
}

/**
 * Parse an AMSOIL auto/light-truck vehicle page into Claims.
 *
 * The page is server-rendered; each section (h2/h3 heading) may carry a
 * `<table id="notes_…">` spec table. Tables are attributed to the NEAREST
 * PRECEDING h1–h3 heading, and only the Engine Oil and Coolant sections are
 * read — ATF/diff/transfer-case fill figures are variant-ambiguous on this
 * source and must never leak into capacity fields. Malformed input → [].
 */
export function parseAmsoilVehiclePage(
  html: string,
  opts?: { source_url?: string; observed_at?: number },
): Claim[] {
  try {
    if (typeof html !== "string" || html === "") return [];
    const observedAt = opts?.observed_at ?? Date.now();
    const sourceUrl = opts?.source_url ?? PAGE_ROOT;

    // Section headings in document order (h4 product-card titles are NOT
    // section boundaries — spec tables sit directly under their h2/h3).
    const headings: { pos: number; text: string }[] = [];
    const hRe = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi;
    let hm: RegExpExecArray | null;
    while ((hm = hRe.exec(html)) !== null) {
      const text = cleanHtmlText(hm[2]).toUpperCase();
      if (text !== "") headings.push({ pos: hm.index, text });
    }

    const mkClaim = (
      field_key: string,
      value: string,
      value_raw: string,
      observed_label?: string,
    ): Claim => ({
      field_key,
      value,
      value_raw,
      source_family: "aggregator",
      source_domain: SOURCE_DOMAIN,
      source_url: sourceUrl,
      method: "deterministic_parse",
      ...(observed_label ? { observed_label } : {}),
      observed_at: observedAt,
    });

    const claims: Claim[] = [];
    const seen = new Set<string>();
    const push = (c: Claim | null) => {
      if (c && !seen.has(c.field_key)) {
        seen.add(c.field_key);
        claims.push(c);
      }
    };

    const tRe = /<table[^>]*id="notes_\d+"[^>]*>([\s\S]*?)<\/table>/gi;
    let tm: RegExpExecArray | null;
    while ((tm = tRe.exec(html)) !== null) {
      let section = "";
      for (const h of headings) {
        if (h.pos < tm.index) section = h.text;
        else break;
      }
      if (section !== SECTION_ENGINE_OIL && section !== SECTION_COOLANT) {
        continue;
      }

      for (const row of tableRows(tm[1])) {
        const header = row.header.toUpperCase();

        if (section === SECTION_ENGINE_OIL && header.startsWith("VISCOSITY")) {
          // Emit only an unambiguous primary grade: the cell must OPEN with a
          // viscosity token, and that token must either be the cell's only
          // distinct grade or be explicitly marked "(All TEMPS)" (fallback
          // grades like "0W-20 may be used" then ride along in value_raw).
          const first = /^(\d{1,2}W-\d{1,3})\b/.exec(row.text);
          if (!first) continue;
          const grade = first[1].toUpperCase();
          const tokens = row.text.match(/\b\d{1,2}W-\d{1,3}\b/g) ?? [];
          const distinct = new Set(tokens.map((t) => t.toUpperCase()));
          const allTemps = new RegExp(
            `^${grade}\\s*\\(ALL TEMPS\\)`,
            "i",
          ).test(row.text);
          if (distinct.size === 1 || allTemps) {
            push(mkClaim("oil_viscosity", grade, row.text));
          }
        } else if (
          section === SECTION_ENGINE_OIL &&
          header.startsWith("CAPACITY")
        ) {
          // Exactly one "N quarts" figure, sane range — else skip.
          const matches = row.text.match(/\d+(?:\.\d+)?(?=\s*quarts?\b)/gi);
          if (!matches || matches.length !== 1) continue;
          const value = numStr(matches[0]);
          if (value === null) continue;
          const n = Number(value);
          if (n <= 1 || n >= 20) continue;
          push(mkClaim("oil_capacity_qts", value, row.text));
        } else if (
          section === SECTION_ENGINE_OIL &&
          header.startsWith("TORQUE")
        ) {
          // Only the figure explicitly qualified as the oil drain plug's.
          const m = /(\d+(?:\.\d+)?)\s*ft[\s/.-]*lbs?\.?\s*\(([^)]*)\)/i.exec(
            row.text,
          );
          if (!m || !/drain\s*plug/i.test(m[2])) continue;
          const value = numStr(m[1]);
          if (value === null) continue;
          const n = Number(value);
          if (n < 5 || n > 100) continue;
          push(
            mkClaim("drain_plug_torque_ft_lbs", value, row.text, m[0].trim()),
          );
        } else if (section === SECTION_COOLANT && header.startsWith("CAPACITY")) {
          // Coolant capacity must be a bare "N quarts." cell — qualified
          // variants ("with rear heat …") are trim-ambiguous, skip them.
          const m = /^(\d+(?:\.\d+)?)\s*quarts?\.?$/i.exec(row.text);
          if (!m) continue;
          const value = numStr(m[1]);
          if (value === null) continue;
          const n = Number(value);
          if (n <= 1 || n >= 40) continue;
          push(mkClaim("coolant_capacity_qts", value, row.text));
        }
      }
    }
    return claims;
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch plumbing.
// ─────────────────────────────────────────────────────────────────────────────

type FetchOutcome = { status: number; body: string };

async function fetchApi(
  endpoint: string,
  params: Record<string, string>,
): Promise<{ url: string; outcome: FetchOutcome }> {
  const qs = new URLSearchParams(params);
  const url = `${API_ROOT}${endpoint}?${qs.toString()}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      Origin: "https://www.amsoil.com",
      Referer: "https://www.amsoil.com/",
    },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.text();
  return { url, outcome: { status: res.status, body } };
}

async function fetchVehiclePage(
  path: string,
): Promise<{ url: string; outcome: FetchOutcome }> {
  const url = `${PAGE_ROOT}${path}`;
  const res = await fetch(url, {
    method: "GET",
    headers: PAGE_HEADERS,
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.text();
  return { url, outcome: { status: res.status, body } };
}

/** Cloudflare challenge / anti-bot detection. */
function looksBlocked(outcome: FetchOutcome): boolean {
  if (
    outcome.status === 403 ||
    outcome.status === 429 ||
    outcome.status === 503
  ) {
    return true;
  }
  return /Just a moment|_cf_chl_opt|challenge-platform|cf-chl/i.test(
    outcome.body.slice(0, 4000),
  );
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

async function lookupAmsoil(vehicle: AdapterVehicle): Promise<AdapterResult> {
  try {
    const year = String(vehicle.year);

    // 1) make
    const makesRes = await fetchApi("GetMakes", {
      lookupCode: LOOKUP_CODE,
      year,
    });
    if (looksBlocked(makesRes.outcome)) {
      return fail(`blocked at GetMakes (HTTP ${makesRes.outcome.status})`, true);
    }
    const makes = parseIdValueOptions(makesRes.outcome.body);
    if (makes.length === 0) {
      return fail(`no makes for ${year} (HTTP ${makesRes.outcome.status})`);
    }
    const make = pickMake(makes, vehicle.make);
    if (!make) return empty(`make "${vehicle.make}" not resolvable for ${year}`);

    // 2) model
    const modelsRes = await fetchApi("GetModels", {
      lookupCode: LOOKUP_CODE,
      year,
      equipmentMakeId: make.id,
    });
    if (looksBlocked(modelsRes.outcome)) {
      return fail(
        `blocked at GetModels (HTTP ${modelsRes.outcome.status})`,
        true,
      );
    }
    const models = parseIdValueOptions(modelsRes.outcome.body);
    const model = pickModel(models, vehicle.model);
    if (!model) {
      return empty(
        `model "${vehicle.model}" not uniquely resolvable for ${year} ${make.value}`,
      );
    }

    // 3) engine — must resolve uniquely; guessing between engine variants
    //    (gas vs hybrid sibling) is forbidden.
    const enginesRes = await fetchApi("GetEngines", {
      lookupCode: LOOKUP_CODE,
      year,
      equipmentMakeId: make.id,
      equipmentModelId: model.id,
    });
    if (looksBlocked(enginesRes.outcome)) {
      return fail(
        `blocked at GetEngines (HTTP ${enginesRes.outcome.status})`,
        true,
      );
    }
    const engines = parseIdValueOptions(enginesRes.outcome.body);
    if (engines.length === 0) {
      return empty(`no engines for ${year} ${make.value} ${model.value}`);
    }
    const engine = pickEngine(engines, vehicle);
    if (!engine) {
      return empty(
        `engine not uniquely resolvable for ${year} ${make.value} ${model.value} ` +
          `(candidates: ${engines.map((e) => e.value).join(" | ")})`,
      );
    }

    // 4) vehicle-page path
    const detailsRes = await fetchApi("GetVehicleDetails", {
      equipmentUnitId: engine.id,
    });
    if (looksBlocked(detailsRes.outcome)) {
      return fail(
        `blocked at GetVehicleDetails (HTTP ${detailsRes.outcome.status})`,
        true,
      );
    }
    const pagePath = parseVehicleDetailsUrl(detailsRes.outcome.body);
    if (pagePath === null) {
      return fail(
        `GetVehicleDetails returned no usable url for unit ${engine.id}`,
      );
    }

    // 5) the spec page itself (Cloudflare-fronted)
    const pageRes = await fetchVehiclePage(pagePath);
    if (looksBlocked(pageRes.outcome)) {
      // Cloudflare fingerprints the TLS stack here: the same headers pass via
      // curl but 403 via undici/fetch. The URL is included so the headless
      // tier can go straight to the page and feed parseAmsoilVehiclePage.
      return fail(
        `blocked at vehicle page (HTTP ${pageRes.outcome.status}): ${pageRes.url}`,
        true,
      );
    }
    if (pageRes.outcome.status !== 200) {
      return fail(`vehicle page HTTP ${pageRes.outcome.status} (${pageRes.url})`);
    }

    const claims = parseAmsoilVehiclePage(pageRes.outcome.body, {
      source_url: pageRes.url,
      observed_at: Date.now(),
    });
    if (claims.length === 0) {
      return empty(`vehicle page yielded no unambiguous spec rows (${pageRes.url})`);
    }
    return { adapter: ADAPTER_NAME, ok: true, claims };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export const amsoilAdapter: SourceAdapter = {
  name: ADAPTER_NAME,
  family: "aggregator",
  fields: AMSOIL_FIELDS,
  lookup: lookupAmsoil,
};
