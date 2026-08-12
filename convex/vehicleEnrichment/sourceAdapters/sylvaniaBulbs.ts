// =============================================================================
// sourceAdapters/sylvaniaBulbs.ts — Sylvania bulb-chart adapter.
//
// Family: aftermarket_catalog. Supplies the NEW bulb_{position} field family
// (these keys are NOT in V4_FIELD_KEYS yet — this adapter is the data supply
// for that expansion).
//
// FETCH PATH (verified live 2026-07-30 against 2020 Toyota Camry + 2019 Ford
// F-150): sylvania-automotive.com is a Salesforce Commerce Cloud (Demandware)
// site whose bulb finder is driven by ONE JSON controller:
//
//   /on/demandware.store/Sites-sylvaniaautomotive-Site/en_US/BulbFinder-GetDropdownValues
//
// with a lookupType cascade (parameter names lifted from the site's own
// createRequest() in main.js):
//
//   1. lookupType=makes   &constructionYear={year}                 → [{id,name}]
//   2. lookupType=models  &constructionYear&manufacturerId         → [{id,name}]
//   3. lookupType=car_id  &constructionYear&manufacturerId&modelId
//                         &makeName&modelName                      → [{id}]  (carId)
//   4. lookupType=bulbs   &carId&oepn={non-empty; value ignored}   → the FULL
//      bulb chart: [{pos_name, use_id, use_name, oepn, note}, ...] — every
//      position in one response. (The server requires a non-empty `oepn`
//      param but returns the complete chart regardless of its value.)
//
// The `oepn` field on each row is the bulb TRADE NUMBER for that position
// (e.g. "H11", "9005", "7444NA", "168") — or the literal "LED" when the
// factory unit is a non-replaceable LED assembly. "LED" is emitted as a
// value: "this position has no user-replaceable bulb" is real data.
//
// AMBIGUITY LAW (present-but-wrong is forbidden): many positions carry
// variant rows ("with Factory Halogen Headlights" vs "with LED Headlights",
// "Bulb Option 1/2"). The Y/M/M cascade cannot tell which variant a specific
// VIN has, so a position is emitted ONLY when every variant row agrees on a
// single normalized value. Conflicting variants → no claim for that position.
// =============================================================================

import type {
  AdapterResult,
  AdapterVehicle,
  Claim,
  SourceAdapter,
} from "./types";
import { normalizeOemNumber } from "../priceParser";

const ADAPTER_NAME = "sylvania_bulbs";
const HOST = "www.sylvania-automotive.com";
const SOURCE_DOMAIN = "sylvania-automotive.com";
const ENDPOINT = `https://${HOST}/on/demandware.store/Sites-sylvaniaautomotive-Site/en_US/BulbFinder-GetDropdownValues`;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// ─────────────────────────────────────────────────────────────────────────────
// Position → field slug. Curated for every use_name observed in probing plus
// common neighbors; canonical names follow the pipeline's convention
// (front/rear prefixed, "Back Up" → reverse_light). Unknown names fall back
// to a mechanical slug so new Sylvania positions still produce stable keys.
// ─────────────────────────────────────────────────────────────────────────────
const POSITION_SLUGS: Record<string, string> = {
  "Headlight Bulb Low Beam": "headlight_low_beam",
  "Headlight Bulb High Beam": "headlight_high_beam",
  "Turn Signal Light Bulb Front": "front_turn_signal",
  "Turn Signal Light Bulb Rear": "rear_turn_signal",
  "Brake Light Bulb": "brake_light",
  "Back Up Light Bulb": "reverse_light",
  "License Plate Light Bulb": "license_plate",
  "Center High Mount Stop Light Bulb": "center_high_mount_stop",
  "Daytime Running Light Bulb": "daytime_running_light",
  "Parking Light Bulb": "parking_light",
  "Side Marker Light Bulb Front": "front_side_marker",
  "Side Marker Light Bulb Rear": "rear_side_marker",
  "Tail Light Bulb": "tail_light",
  "Fog Light Bulb Front": "front_fog_light",
  "Fog Light Bulb Rear": "rear_fog_light",
  "Cornering Light Bulb": "cornering_light",
  "Dome Light Bulb": "dome_light",
  "Map Light Bulb": "map_light",
  "Trunk Light Bulb": "trunk_light",
  "Trunk or Cargo Area Light": "cargo_area_light",
  "Interior Door Light Bulb": "interior_door_light",
  "Door Mirror Illumination Light Bulb": "door_mirror_light",
  "Glove Box Light Bulb": "glove_box_light",
  "Instrument Panel Light Bulb": "instrument_panel_light",
  "Vanity Mirror Light Bulb": "vanity_mirror_light",
  "Courtesy Light Bulb": "courtesy_light",
};

/** Fields this adapter can attest (curated set; fallback slugs are extra). */
export const SYLVANIA_BULB_FIELDS: readonly string[] = [
  ...new Set(Object.values(POSITION_SLUGS)),
].map((s) => `bulb_${s}`);

/** Map a Sylvania position use_name to its bulb_{position} field key. */
export function positionFieldKey(useName: string): string {
  const clean = (useName ?? "").trim().replace(/\s+/g, " ");
  const mapped = POSITION_SLUGS[clean];
  if (mapped) return `bulb_${mapped}`;
  // Mechanical fallback: drop the word "Bulb", move a trailing Front/Rear to
  // the front (matches the curated convention), snake_case the rest.
  let words = clean.split(" ").filter((w) => w.toLowerCase() !== "bulb");
  const last = words[words.length - 1]?.toLowerCase();
  if (words.length > 1 && (last === "front" || last === "rear")) {
    words = [words[words.length - 1], ...words.slice(0, -1)];
  }
  const slug = words
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `bulb_${slug || "unknown"}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure parsers — string in, structures out, NEVER throw (fail open).
// ─────────────────────────────────────────────────────────────────────────────

type DropdownOption = { id: string; name: string };

/** Parse a makes/models/car_id GetDropdownValues response. Malformed → []. */
export function parseDropdownOptions(json: string): DropdownOption[] {
  try {
    const obj = JSON.parse(json) as {
      success?: unknown;
      response?: unknown;
    };
    if (obj.success === false || !Array.isArray(obj.response)) return [];
    const out: DropdownOption[] = [];
    for (const row of obj.response) {
      if (row == null || typeof row !== "object") continue;
      const id = (row as { id?: unknown }).id;
      const name = (row as { name?: unknown }).name;
      if (typeof id !== "string" && typeof id !== "number") continue;
      out.push({
        id: String(id),
        name: typeof name === "string" ? name.trim() : String(id),
      });
    }
    return out;
  } catch {
    return [];
  }
}

type BulbRow = { use_name: string; oepn: string; note: string };

/** Values that mean "no data" rather than a real trade number. */
function isEmptyOepn(raw: string): boolean {
  const n = normalizeOemNumber(raw);
  return n === "" || n === "NA";
}

/**
 * Parse a lookupType=bulbs response (the full vehicle bulb chart) into
 * Claims. One claim per position, and ONLY when every variant row for that
 * position agrees on one normalized value — conflicting trim/technology
 * variants are unresolvable from Y/M/M, so they are skipped entirely
 * (present-but-wrong is forbidden). Malformed input → [].
 */
export function parseBulbChart(
  json: string,
  opts?: { source_url?: string; observed_at?: number },
): Claim[] {
  try {
    const obj = JSON.parse(json) as {
      success?: unknown;
      response?: unknown;
    };
    if (obj.success === false || !Array.isArray(obj.response)) return [];

    // Group rows by position (use_name).
    const byPosition = new Map<string, BulbRow[]>();
    for (const raw of obj.response) {
      if (raw == null || typeof raw !== "object") continue;
      const useName = (raw as { use_name?: unknown }).use_name;
      const oepn = (raw as { oepn?: unknown }).oepn;
      if (typeof useName !== "string" || typeof oepn !== "string") continue;
      const note = (raw as { note?: unknown }).note;
      const key = useName.trim().replace(/\s+/g, " ");
      if (key === "") continue;
      const rows = byPosition.get(key) ?? [];
      rows.push({
        use_name: key,
        oepn: oepn.trim(),
        note: typeof note === "string" ? note.trim() : "",
      });
      byPosition.set(key, rows);
    }

    const observedAt = opts?.observed_at ?? Date.now();
    const sourceUrl = opts?.source_url ?? `https://${HOST}/bulb-finder.html`;

    const claims: Claim[] = [];
    for (const [useName, rows] of byPosition) {
      const withValue = rows.filter((r) => !isEmptyOepn(r.oepn));
      if (withValue.length === 0) continue;
      const distinct = new Set(withValue.map((r) => normalizeOemNumber(r.oepn)));
      if (distinct.size !== 1) continue; // variant conflict → no claim
      const winner = withValue[0];
      // Only attach the note when it is the position's ONLY row — a note on
      // one of several agreeing variants is variant context, not the label
      // the value holds under.
      const label =
        withValue.length === 1 && winner.note !== ""
          ? `${useName} (${winner.note})`
          : useName;
      claims.push({
        field_key: positionFieldKey(useName),
        value: normalizeOemNumber(winner.oepn),
        value_raw: winner.oepn,
        source_family: "aftermarket_catalog",
        source_domain: SOURCE_DOMAIN,
        source_url: sourceUrl,
        method: "deterministic_parse",
        observed_label: label,
        observed_at: observedAt,
      });
    }
    return claims;
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch plumbing.
// ─────────────────────────────────────────────────────────────────────────────

/** Uppercase alphanumerics only — makes "F-150" ≡ "F150", "MERCEDES-BENZ" ≡
 *  "Mercedes-Benz". Exact match ONLY: never guess a sibling model. */
function normName(s: string): string {
  return (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function requestId(): string {
  const rand = () => Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
  return `${rand()}|${rand()}`;
}

type FetchOutcome = { status: number; body: string };

async function fetchDropdown(
  params: Record<string, string>,
): Promise<{ url: string; outcome: FetchOutcome }> {
  const qs = new URLSearchParams({ ...params, requestID: requestId() });
  const url = `${ENDPOINT}?${qs.toString()}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json, text/javascript, */*; q=0.01",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.text();
  return { url, outcome: { status: res.status, body } };
}

/** Anti-bot / captcha detection on a response. */
function looksBlocked(outcome: FetchOutcome): boolean {
  if (outcome.status === 403 || outcome.status === 429) return true;
  if (/captcha|access denied|cloudflare|akamai/i.test(outcome.body.slice(0, 2000))) {
    // The controller itself flags captcha via a showCaptcha field.
    try {
      const obj = JSON.parse(outcome.body) as { showCaptcha?: unknown };
      return Boolean(obj.showCaptcha);
    } catch {
      return true;
    }
  }
  return false;
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

/** Successful lookup that found nothing to claim — diagnostic preserved. */
function empty(note: string): AdapterResult {
  return { adapter: ADAPTER_NAME, ok: true, claims: [], error: note };
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter.
// ─────────────────────────────────────────────────────────────────────────────

async function lookupSylvaniaBulbs(
  vehicle: AdapterVehicle,
): Promise<AdapterResult> {
  try {
    const year = String(vehicle.year);

    // 1) makes for year → manufacturerId
    const makesRes = await fetchDropdown({
      lookupType: "makes",
      constructionYear: year,
    });
    if (looksBlocked(makesRes.outcome)) {
      return fail(`blocked at makes lookup (HTTP ${makesRes.outcome.status})`, true);
    }
    const makes = parseDropdownOptions(makesRes.outcome.body);
    if (makes.length === 0) {
      return fail(`no makes for year ${year} (HTTP ${makesRes.outcome.status})`);
    }
    const make = makes.find((m) => normName(m.name) === normName(vehicle.make));
    if (!make) return empty(`make "${vehicle.make}" not in Sylvania catalog for ${year}`);

    // 2) models for year+make → modelId (exact normalized match only)
    const modelsRes = await fetchDropdown({
      lookupType: "models",
      constructionYear: year,
      manufacturerId: make.id,
    });
    if (looksBlocked(modelsRes.outcome)) {
      return fail(`blocked at models lookup (HTTP ${modelsRes.outcome.status})`, true);
    }
    const models = parseDropdownOptions(modelsRes.outcome.body);
    const model = models.find(
      (m) => normName(m.name) === normName(vehicle.model),
    );
    if (!model) {
      return empty(
        `model "${vehicle.model}" not in Sylvania catalog for ${year} ${make.name}`,
      );
    }

    // 3) car_id — must resolve to exactly one id; multiple would mean the
    //    Y/M/M no longer pins the chart, and guessing is forbidden.
    const carIdRes = await fetchDropdown({
      lookupType: "car_id",
      constructionYear: year,
      manufacturerId: make.id,
      modelId: model.id,
      makeName: make.name,
      modelName: model.name,
    });
    if (looksBlocked(carIdRes.outcome)) {
      return fail(`blocked at car_id lookup (HTTP ${carIdRes.outcome.status})`, true);
    }
    const carIds = parseDropdownOptions(carIdRes.outcome.body);
    if (carIds.length === 0) {
      return empty(`no carId for ${year} ${make.name} ${model.name}`);
    }
    if (carIds.length > 1) {
      return empty(
        `ambiguous carIds (${carIds.map((c) => c.id).join(",")}) for ${year} ${make.name} ${model.name}`,
      );
    }
    const carId = carIds[0].id;

    // 4) full bulb chart. The server requires a non-empty `oepn` parameter
    //    but ignores its value and returns every position (verified live).
    const bulbsRes = await fetchDropdown({
      lookupType: "bulbs",
      carId,
      oepn: "all",
    });
    if (looksBlocked(bulbsRes.outcome)) {
      return fail(`blocked at bulbs lookup (HTTP ${bulbsRes.outcome.status})`, true);
    }
    if (bulbsRes.outcome.status !== 200) {
      return fail(`bulbs lookup HTTP ${bulbsRes.outcome.status} for carId ${carId}`);
    }

    const claims = parseBulbChart(bulbsRes.outcome.body, {
      source_url: bulbsRes.url,
      observed_at: Date.now(),
    });
    if (claims.length === 0) {
      return empty(`bulb chart for carId ${carId} yielded no unambiguous positions`);
    }
    return { adapter: ADAPTER_NAME, ok: true, claims };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export const sylvaniaBulbsAdapter: SourceAdapter = {
  name: ADAPTER_NAME,
  family: "aftermarket_catalog",
  fields: SYLVANIA_BULB_FIELDS,
  lookup: lookupSylvaniaBulbs,
};
