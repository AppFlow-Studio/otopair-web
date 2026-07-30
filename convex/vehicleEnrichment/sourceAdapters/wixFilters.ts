// =============================================================================
// sourceAdapters/wixFilters.ts — WIX Filters OE cross-reference adapter.
//
// Family: aftermarket_catalog. Fields: oil_filter_oem, air_filter_oem,
// cabin_filter_oem. WIX part numbers are AFTERMARKET numbers and are NEVER
// emitted as field values — what this adapter emits is the OE numbers WIX's
// own interchange database says each WIX part replaces. The WIX number rides
// along in observed_label ("WIX 51394 OE cross-reference (TOYOTA)").
//
// FETCH PATH (verified live 2026-07-30 against 2020 Toyota Camry LE 2.5L and
// 2019 Ford F-150 5.0L; server-rendered ASP.NET/MVC, plain fetch, no bot
// wall). The mobile site m.wixfilters.com exposes the whole catalog as JSON:
//
//   1. /search/YearMakes2?vehicleYear={y}&section=1        → [{ID,Description}]
//   2. /search/MakeModels2?vehicleYear&section=1&make      → [{ID,Description}]
//   3. /search/MakeEngines2?…&make&model                   → [{ID,Description}]
//      (ID 0 = "All Engines" pseudo-entry, excluded)
//   4. /search/SearchPartsByVehicle3?…&engine              → the vehicle's WIX
//      parts: [{PartNumber, PartID, FilterType:"Oil"|"Air"|" C Air"|"Fuel"…,
//      Comments, …}] — placeholder numbers NS/NA/NR/MT mean "no filter".
//   5. /Search/InterchangeSearch?partNumber={q}            → interchange DB
//      rows [{PartNumber, Manufacturer, ChildPartNumber, Status, …}] where
//      PartNumber is a COMPETITOR/OE number, ChildPartNumber the WIX part
//      that replaces it. The match is a substring scan over the competitor
//      column ("90915" → 117 rows, "FL" → 2060 rows; no auth, no cap hit).
//
// DIRECTION INVERSION: WIX publishes only the OE→WIX direction; there is no
// per-part OE list on any wixfilters.com page (www2 PartDetails.aspx carries
// specs + applications only — verified). So the adapter ENUMERATES the OE
// side: each make's OE filter numbers share known catalog prefixes (Toyota
// oil 90915/04152, Motorcraft oil FL…, seeded below). Querying the prefix
// and keeping rows where ChildPartNumber EQUALS one of the vehicle's WIX
// parts (and Manufacturer is that make's OE brand, and the OE number STARTS
// WITH the prefix) recovers "WIX {part} replaces OE {number}" losslessly.
//
// AMBIGUITY LAW (present-but-wrong is forbidden):
//   - Unseeded make → no claims (missing beats guessed).
//   - Several engine rows can match a Y/M/M/E query (Camry 2.5L gas vs
//     hybrid). Parts are fetched for EVERY matching engine and a filter type
//     is used only when all engines agree on the same WIX part set.
//
// ── THE LAW THIS FILE EXISTS TO ENFORCE ────────────────────────────────────
//
// A WIX part's OE cross-reference list belongs to ONE AFTERMARKET PART. It is
// WIX's list of the OEM numbers its single filter replaces, spanning every
// vehicle that filter fits — supersessions, market variants, and sibling
// platforms alike. It is NOT a set of numbers interchangeable ON THIS VEHICLE.
//
// Emitting all of them as claims asserts that one vehicle's oil filter is
// simultaneously ten mutually exclusive numbers. Observed live on the 2016
// CR-V SE: 16 rival values on `cabin_filter_oem` and 10 on `oil_filter_oem`.
// The ledger's strictly-more-families rule then returns `conflict_tie`, so no
// wrong value is written — but nothing right is either: every rival sits in
// one family at one weight, so the top bucket always holds several clusters.
// WIX could never corroborate anything, and worse, it BURIED the pipeline's
// own (lower-weight, web_search) claim under a tie it manufactured itself.
//
// So: this adapter emits a claim ONLY for a number the pipeline already holds
// for that field, and only when that number appears in the cross-reference set
// of a WIX part WIX's own fitment cascade says fits this vehicle. That is a
// genuinely strong independent voice — "the filter that fits this car replaces
// this OE number" — and it is corroboration, never substitution. The remaining
// numbers are kept as `siblings` metadata for supersession-aware price search
// and never become claims. Same law as rockauto.ts, same reason.
//
// DELIBERATELY REJECTED: proposing when the candidate set collapses to exactly
// ONE number. A singleton is not certainty — it is equally the shape of an
// interchange row WIX simply never recorded for the sibling platform, and the
// one number left standing may be the SIBLING's. One WIX filter serves a CR-V
// and a Civic; publishing the Civic's number into the CR-V's slot is precisely
// the present-but-wrong this pipeline forbids. WIX rows carry no vehicle
// qualifier (PartNumber / Manufacturer / ChildPartNumber / Status only), so
// there is no disambiguation available at any set size.
//
// CONSEQUENCE: with no known filter numbers on file this adapter is inert and
// skips its fetches, exactly as rockauto is. That costs nothing — its previous
// output on those fields was ties, which are worth less than silence.
// =============================================================================

import type {
  AdapterKnownPart,
  AdapterResult,
  AdapterVehicle,
  Claim,
  SourceAdapter,
} from "./types";
import { normalizeOemNumber } from "../priceParser";

const ADAPTER_NAME = "wix_filters";
const HOST = "m.wixfilters.com";
const SOURCE_DOMAIN = "m.wixfilters.com";
const BASE = `https://${HOST}`;
/** Pass Car / Light Truck catalog section. */
const SECTION = "1";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export const WIX_FILTER_FIELDS = [
  "oil_filter_oem",
  "air_filter_oem",
  "cabin_filter_oem",
] as const;

type WixFieldKey = (typeof WIX_FILTER_FIELDS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// OE enumeration seeds. `prefixes` are the catalog prefixes the make's OE
// numbers START with (used both as the InterchangeSearch query and as an
// anchor filter on the returned number); `manufacturers` are the exact
// Manufacturer strings WIX's interchange DB uses for that make's OE brand
// (verified live: TOYOTA, MOTORCRAFT / "MOTORCRAFT AIO", HONDA, NISSAN,
// HYUNDAI, KIA, SUBARU). Coverage grows by seeding — correctness never
// depends on it, because every emitted row passed Manufacturer + child
// equality + prefix anchoring.
// ─────────────────────────────────────────────────────────────────────────────
type OeSeed = {
  manufacturers: readonly string[];
  prefixes: Record<WixFieldKey, readonly string[]>;
};

const TOYOTA_SEED: OeSeed = {
  manufacturers: ["TOYOTA", "LEXUS", "SCION"],
  prefixes: {
    oil_filter_oem: ["90915", "04152"],
    air_filter_oem: ["17801"],
    cabin_filter_oem: ["87139", "88568"],
  },
};

const FORD_SEED: OeSeed = {
  // Motorcraft is Ford's OE service brand; Ford engineering numbers that
  // happen to carry the same prefixes (FL3Z…) come back under "FORD".
  manufacturers: ["MOTORCRAFT", "MOTORCRAFT AIO", "FORD", "LINCOLN"],
  prefixes: {
    oil_filter_oem: ["FL"],
    air_filter_oem: ["FA"],
    cabin_filter_oem: ["FP"],
  },
};

const HONDA_SEED: OeSeed = {
  manufacturers: ["HONDA", "ACURA"],
  prefixes: {
    oil_filter_oem: ["15400"],
    air_filter_oem: ["17220"],
    cabin_filter_oem: ["80292"],
  },
};

const NISSAN_SEED: OeSeed = {
  manufacturers: ["NISSAN", "INFINITI"],
  prefixes: {
    oil_filter_oem: ["15208"],
    air_filter_oem: ["16546"],
    cabin_filter_oem: ["27277", "B7277"],
  },
};

const HYUNDAI_SEED: OeSeed = {
  manufacturers: ["HYUNDAI", "KIA"],
  prefixes: {
    oil_filter_oem: ["26300"],
    air_filter_oem: ["28113"],
    cabin_filter_oem: ["97133"],
  },
};

const SUBARU_SEED: OeSeed = {
  manufacturers: ["SUBARU"],
  prefixes: {
    oil_filter_oem: ["15208AA"],
    air_filter_oem: ["16546AA"],
    cabin_filter_oem: ["72880"],
  },
};

/** Vehicle make (normalized) → OE seed. Unlisted make → adapter emits nothing. */
export const WIX_OE_SEEDS: Record<string, OeSeed> = {
  TOYOTA: TOYOTA_SEED,
  LEXUS: TOYOTA_SEED,
  SCION: TOYOTA_SEED,
  FORD: FORD_SEED,
  LINCOLN: FORD_SEED,
  HONDA: HONDA_SEED,
  ACURA: HONDA_SEED,
  NISSAN: NISSAN_SEED,
  INFINITI: NISSAN_SEED,
  HYUNDAI: HYUNDAI_SEED,
  KIA: HYUNDAI_SEED,
  SUBARU: SUBARU_SEED,
};

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers + parsers — string in, structures out, NEVER throw (fail open).
// ─────────────────────────────────────────────────────────────────────────────

/** Uppercase alphanumerics only — "F-150" ≡ "F150". */
function normName(s: string): string {
  return (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

type CascadeOption = { id: number; description: string };

/** Parse a YearMakes2 / MakeModels2 / MakeEngines2 response. Malformed → []. */
export function parseCascadeOptions(json: string): CascadeOption[] {
  try {
    const arr = JSON.parse(json) as unknown;
    if (!Array.isArray(arr)) return [];
    const out: CascadeOption[] = [];
    for (const row of arr) {
      if (row == null || typeof row !== "object") continue;
      const id = (row as { ID?: unknown }).ID;
      const desc = (row as { Description?: unknown }).Description;
      if (typeof id !== "number" || typeof desc !== "string") continue;
      out.push({ id, description: desc.trim() });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Resolve a make/model name against WIX's option list. Exact normalized
 * equality wins; otherwise a UNIQUE option containing the name ("F150" ⊆
 * "PICKUP F150 ALL", "GMC" ⊆ "GMC LIGHT TRUCKS"). Zero or several
 * containment hits → null: never guess a sibling.
 */
export function matchOption(
  options: readonly CascadeOption[],
  name: string,
): CascadeOption | null {
  const target = normName(name);
  if (target === "") return null;
  const exact = options.find((o) => normName(o.description) === target);
  if (exact) return exact;
  const contains = options.filter((o) =>
    normName(o.description).includes(target),
  );
  return contains.length === 1 ? contains[0] : null;
}

export type EngineOption = CascadeOption & {
  cylinders: number | null;
  displacementL: number | null;
};

/** Pull "V8 5.0L …" config + displacement out of an engine description. */
function engineAttrs(description: string): {
  cylinders: number | null;
  displacementL: number | null;
} {
  const cyl = /^\s*([LVHI])\s*(\d{1,2})\b/i.exec(description);
  const disp = /(\d{1,2}\.\d)\s*L\b/i.exec(description);
  return {
    cylinders: cyl ? Number(cyl[2]) : null,
    displacementL: disp ? Number(disp[1]) : null,
  };
}

/**
 * Engine rows compatible with the vehicle. Filters only EXCLUDE on a
 * POSITIVE mismatch (an unparseable attribute never disqualifies — dropping
 * the true engine could leave a wrong unique match standing). A provided
 * engine_code narrows to rows containing it when any do (the Camry hybrid's
 * "A25A-FXS" appears verbatim in WIX's description). Callers must treat
 * MULTIPLE survivors as ambiguity to resolve by agreement, never by choice.
 */
export function matchEngines(
  engines: readonly CascadeOption[],
  vehicle: Pick<AdapterVehicle, "engine_code" | "displacement_l" | "cylinders">,
): EngineOption[] {
  let candidates: EngineOption[] = engines
    .filter((e) => e.id !== 0) // "All Engines" pseudo-entry
    .map((e) => ({ ...e, ...engineAttrs(e.description) }));

  const code = normName(vehicle.engine_code ?? "");
  if (code !== "") {
    const hits = candidates.filter((c) =>
      normName(c.description).includes(code),
    );
    if (hits.length > 0) candidates = hits;
  }
  if (vehicle.displacement_l != null) {
    candidates = candidates.filter(
      (c) =>
        c.displacementL == null ||
        Math.abs(c.displacementL - vehicle.displacement_l!) < 0.05,
    );
  }
  if (vehicle.cylinders != null) {
    candidates = candidates.filter(
      (c) => c.cylinders == null || c.cylinders === vehicle.cylinders,
    );
  }
  return candidates;
}

/** FilterType → field key. Unknown/unhandled types (Fuel, Trans…) → null. */
export function filterTypeFieldKey(filterType: string): WixFieldKey | null {
  const t = (filterType ?? "").trim().toUpperCase();
  if (t === "OIL") return "oil_filter_oem";
  if (t === "AIR") return "air_filter_oem";
  if (t === "C AIR" || t === "CABIN AIR" || t === "CABIN") {
    return "cabin_filter_oem";
  }
  return null;
}

/** Placeholder "part numbers" meaning no serviceable filter exists. */
const NON_PARTS = new Set(["NS", "NA", "NR", "MT"]);

export type WixVehiclePart = { fieldKey: WixFieldKey; partNumber: string };

/**
 * Parse a SearchPartsByVehicle3 response into the vehicle's WIX parts for
 * the three filter fields. Placeholder rows and non-filter types are
 * dropped. Malformed input → [].
 */
export function parseVehicleParts(json: string): WixVehiclePart[] {
  try {
    const arr = JSON.parse(json) as unknown;
    if (!Array.isArray(arr)) return [];
    const out: WixVehiclePart[] = [];
    for (const row of arr) {
      if (row == null || typeof row !== "object") continue;
      const pn = (row as { PartNumber?: unknown }).PartNumber;
      const ft = (row as { FilterType?: unknown }).FilterType;
      if (typeof pn !== "string" || typeof ft !== "string") continue;
      const partNumber = pn.trim();
      if (partNumber === "" || NON_PARTS.has(normalizeOemNumber(partNumber))) {
        continue;
      }
      const fieldKey = filterTypeFieldKey(ft);
      if (!fieldKey) continue;
      out.push({ fieldKey, partNumber });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Part sets per field on which EVERY engine's parts list agrees. A field
 * where any two engines disagree (normalized set inequality) is dropped —
 * the Y/M/M/E cascade cannot tell which variant the actual vehicle is.
 */
export function agreedPartsByField(
  partsPerEngine: readonly (readonly WixVehiclePart[])[],
): Map<WixFieldKey, string[]> {
  const agreed = new Map<WixFieldKey, string[]>();
  if (partsPerEngine.length === 0) return agreed;
  const setsOf = (parts: readonly WixVehiclePart[]) => {
    const m = new Map<WixFieldKey, Map<string, string>>();
    for (const p of parts) {
      const inner = m.get(p.fieldKey) ?? new Map<string, string>();
      inner.set(normalizeOemNumber(p.partNumber), p.partNumber);
      m.set(p.fieldKey, inner);
    }
    return m;
  };
  const all = partsPerEngine.map(setsOf);
  const [first, ...rest] = all;
  for (const [fieldKey, inner] of first) {
    const key = [...inner.keys()].sort().join("|");
    const everyAgrees = rest.every((m) => {
      const other = m.get(fieldKey);
      if (!other) return false;
      return [...other.keys()].sort().join("|") === key;
    });
    if (everyAgrees) agreed.set(fieldKey, [...inner.values()]);
  }
  return agreed;
}

/**
 * The CANDIDATE ENUMERATOR: one InterchangeSearch response → the OE numbers
 * this vehicle's WIX part(s) replace, in Claim shape, for one field.
 *
 * NOT the claim boundary. Every row here is a member of one aftermarket part's
 * cross-reference set, and those members are mutually exclusive as values of a
 * single vehicle's field — see THE LAW at the top of this file. Enumerating
 * them is correct and useful; ASSERTING them is not. `applyInterchangeLaw`
 * turns this list into the at-most-one claim per field that may be emitted.
 *
 * A row is enumerated only when ALL of:
 *   - Manufacturer is one of the make's OE brand strings,
 *   - ChildPartNumber equals (normalized) one of the vehicle's WIX parts
 *     for this field,
 *   - the OE number starts (normalized) with a seeded prefix — anchors out
 *     legacy concatenations like "0060290915005" that merely CONTAIN it,
 *   - Status is "A" (active listing).
 * Distinct normalized OE values are deduped across children (51394 and
 * 51394XP replace the same OE numbers). Malformed input → [].
 */
export function parseInterchangeClaims(
  json: string,
  opts: {
    fieldKey: WixFieldKey;
    /** The vehicle's WIX part numbers for this field (verbatim). */
    wixPartNumbers: readonly string[];
    /** Normalized-anchored OE prefixes for this make + field. */
    oePrefixes: readonly string[];
    /** Exact Manufacturer strings accepted as the make's OE brand. */
    manufacturers: readonly string[];
    sourceUrl?: string;
    observedAt?: number;
  },
): Claim[] {
  try {
    const arr = JSON.parse(json) as unknown;
    if (!Array.isArray(arr)) return [];

    const children = new Map<string, string>(); // normalized → verbatim WIX part
    for (const pn of opts.wixPartNumbers) {
      const n = normalizeOemNumber(pn);
      if (n !== "") children.set(n, pn.trim());
    }
    const brands = new Set(
      opts.manufacturers.map((m) => m.trim().toUpperCase()),
    );
    const prefixes = opts.oePrefixes
      .map((p) => normalizeOemNumber(p))
      .filter((p) => p !== "");
    if (children.size === 0 || brands.size === 0 || prefixes.length === 0) {
      return [];
    }

    const observedAt = opts.observedAt ?? Date.now();
    const sourceUrl = opts.sourceUrl ?? `${BASE}/Search/ByVehicles`;

    const claims: Claim[] = [];
    const seen = new Set<string>();
    for (const row of arr) {
      if (row == null || typeof row !== "object") continue;
      const oeRaw = (row as { PartNumber?: unknown }).PartNumber;
      const man = (row as { Manufacturer?: unknown }).Manufacturer;
      const child = (row as { ChildPartNumber?: unknown }).ChildPartNumber;
      const status = (row as { Status?: unknown }).Status;
      if (
        typeof oeRaw !== "string" ||
        typeof man !== "string" ||
        typeof child !== "string"
      ) {
        continue;
      }
      if (status !== "A") continue;
      if (!brands.has(man.trim().toUpperCase())) continue;
      const wixPart = children.get(normalizeOemNumber(child));
      if (wixPart === undefined) continue;
      const value = normalizeOemNumber(oeRaw);
      if (value === "" || !prefixes.some((p) => value.startsWith(p))) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      claims.push({
        field_key: opts.fieldKey,
        value,
        value_raw: oeRaw.trim(),
        source_family: "aftermarket_catalog",
        source_domain: SOURCE_DOMAIN,
        source_url: sourceUrl,
        method: "deterministic_parse",
        observed_label: `WIX ${wixPart} OE cross-reference (${man.trim()})`,
        observed_at: observedAt,
      });
    }
    return claims.sort((a, b) => (a.value < b.value ? -1 : 1));
  } catch {
    return [];
  }
}

/** What the cross-reference set said about one field, after the law. */
export type WixInterchange = {
  field_key: string;
  /** Our own number, when WIX's cross set for this vehicle contains it. */
  corroborated: string | null;
  /**
   * The other OE numbers the vehicle's WIX part replaces, EXCLUDING ours.
   *
   * Supersession candidates for PRICE SEARCH only. They are numbers one filter
   * replaces across many vehicles, so they are not fitment-equivalent here and
   * must never be written into a field.
   */
  siblings: string[];
};

/**
 * THE CLAIM BOUNDARY: candidate cross-references + the numbers the pipeline
 * already holds → at most ONE claim per field.
 *
 * A candidate becomes a claim only by matching a known part number for the
 * same field. The claim's value is therefore our own number, carrying WIX's
 * verbatim `observed_label` ("WIX 51394 OE cross-reference (TOYOTA)") as the
 * context it was confirmed under — an independent aftermarket catalogue
 * agreeing with what we already believe, which is exactly what the ledger
 * needs to lift a field from single_source to multi-family consensus.
 *
 * Everything else is returned as `siblings` and never claimed. Pure, total,
 * order-independent; a field with no known number yields no claim rather than
 * the set's first or shortest member.
 */
export function applyInterchangeLaw(
  candidates: readonly Claim[],
  knownParts: readonly AdapterKnownPart[],
): { claims: Claim[]; interchange: WixInterchange[] } {
  // field → the normalized numbers we already hold for it. A Set because the
  // caller's shape does not forbid two rows on one field, and picking one of
  // them would be a choice this function has no basis to make.
  const wanted = new Map<string, Set<string>>();
  for (const p of knownParts) {
    const n = normalizeOemNumber(p.part_number ?? "");
    if (n === "") continue;
    const set = wanted.get(p.field_key) ?? new Set<string>();
    set.add(n);
    wanted.set(p.field_key, set);
  }

  const claims: Claim[] = [];
  const byField = new Map<string, WixInterchange>();
  for (const c of candidates) {
    const entry = byField.get(c.field_key) ?? {
      field_key: c.field_key,
      corroborated: null,
      siblings: [],
    };
    if (wanted.get(c.field_key)?.has(c.value)) {
      // Guard against a duplicate candidate emitting a second identical claim:
      // one source confirming one number once is one voice, not two.
      if (entry.corroborated === null) {
        entry.corroborated = c.value;
        claims.push(c);
      }
    } else if (!entry.siblings.includes(c.value)) {
      entry.siblings.push(c.value);
    }
    byField.set(c.field_key, entry);
  }

  const order = (a: { field_key: string }, b: { field_key: string }) =>
    a.field_key < b.field_key ? -1 : a.field_key > b.field_key ? 1 : 0;
  return {
    claims: claims.sort(order),
    interchange: [...byField.values()]
      .map((e) => ({ ...e, siblings: [...e.siblings].sort() }))
      .sort(order),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch plumbing.
// ─────────────────────────────────────────────────────────────────────────────

type FetchOutcome = { url: string; status: number; body: string };

async function getJson(
  path: string,
  params: Record<string, string>,
): Promise<FetchOutcome> {
  const url = `${BASE}${path}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json, text/javascript, */*; q=0.01",
      "Accept-Language": "en-US,en;q=0.9",
      "X-Requested-With": "XMLHttpRequest",
    },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.text();
  return { url, status: res.status, body };
}

/** Anti-bot detection: status or an HTML challenge where JSON belongs. */
function looksBlocked(o: FetchOutcome): boolean {
  if (o.status === 403 || o.status === 429 || o.status === 503) return true;
  return /captcha|access denied|cloudflare|akamai|incapsula/i.test(
    o.body.slice(0, 2000),
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

/** Successful lookup that found nothing to claim — diagnostic preserved. */
function empty(note: string): AdapterResult {
  return { adapter: ADAPTER_NAME, ok: true, claims: [], error: note };
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter.
// ─────────────────────────────────────────────────────────────────────────────

/** Most engine ambiguity is 2-way (gas vs hybrid); beyond this it's noise. */
const MAX_ENGINE_CANDIDATES = 3;

async function lookupWixFilters(
  vehicle: AdapterVehicle,
): Promise<AdapterResult> {
  try {
    // Corroboration-only (THE LAW): without a number to confirm, every fetch
    // below can only enumerate a candidate set nothing may be claimed from.
    // Checked before the cascade so the inert case costs no requests at all.
    const known = (vehicle.known_parts ?? []).filter((p) =>
      (WIX_FILTER_FIELDS as readonly string[]).includes(p.field_key),
    );
    if (known.length === 0) {
      return empty(
        `no known filter part numbers supplied — a WIX cross-reference set can ` +
          `CONFIRM one of our numbers but cannot pick one of its own (see THE ` +
          `LAW), so the adapter is inert without them`,
      );
    }
    const knownFields = new Set(known.map((p) => p.field_key));

    const seed = WIX_OE_SEEDS[normName(vehicle.make)];
    if (!seed) {
      return empty(
        `make "${vehicle.make}" has no OE prefix seeds — WIX only serves the ` +
          `OE→WIX direction, so unseeded makes yield nothing (missing beats guessed)`,
      );
    }
    const year = String(vehicle.year);

    // 1) make ID
    const makesRes = await getJson("/search/YearMakes2", {
      vehicleYear: year,
      section: SECTION,
    });
    if (looksBlocked(makesRes)) {
      return fail(`blocked at YearMakes2 (HTTP ${makesRes.status})`, true);
    }
    const makes = parseCascadeOptions(makesRes.body);
    if (makes.length === 0) {
      return fail(`no makes for ${year} (HTTP ${makesRes.status})`);
    }
    const make = matchOption(makes, vehicle.make);
    if (!make) return empty(`make "${vehicle.make}" not in WIX catalog for ${year}`);

    // 2) model ID
    const modelsRes = await getJson("/search/MakeModels2", {
      vehicleYear: year,
      section: SECTION,
      make: String(make.id),
    });
    if (looksBlocked(modelsRes)) {
      return fail(`blocked at MakeModels2 (HTTP ${modelsRes.status})`, true);
    }
    const model = matchOption(parseCascadeOptions(modelsRes.body), vehicle.model);
    if (!model) {
      return empty(
        `model "${vehicle.model}" not matched in WIX catalog for ${year} ${make.description}`,
      );
    }

    // 3) engine candidates
    const enginesRes = await getJson("/search/MakeEngines2", {
      vehicleYear: year,
      section: SECTION,
      make: String(make.id),
      model: String(model.id),
    });
    if (looksBlocked(enginesRes)) {
      return fail(`blocked at MakeEngines2 (HTTP ${enginesRes.status})`, true);
    }
    const engines = matchEngines(parseCascadeOptions(enginesRes.body), vehicle);
    if (engines.length === 0) {
      return empty(
        `no engine match for ${year} ${make.description} ${model.description}`,
      );
    }
    if (engines.length > MAX_ENGINE_CANDIDATES) {
      return empty(
        `${engines.length} engine candidates for ${year} ${make.description} ` +
          `${model.description} — too ambiguous to pin parts`,
      );
    }

    // 4) parts per candidate engine → fields where all candidates agree
    const partsPerEngine: WixVehiclePart[][] = [];
    for (const engine of engines) {
      const partsRes = await getJson("/search/SearchPartsByVehicle3", {
        vehicleYear: year,
        section: SECTION,
        make: String(make.id),
        model: String(model.id),
        engine: String(engine.id),
      });
      if (looksBlocked(partsRes)) {
        return fail(`blocked at SearchPartsByVehicle3 (HTTP ${partsRes.status})`, true);
      }
      partsPerEngine.push(parseVehicleParts(partsRes.body));
    }
    const agreed = agreedPartsByField(partsPerEngine);
    if (agreed.size === 0) {
      return empty(
        `no filter field agreed across ${engines.length} engine candidate(s) ` +
          `for ${year} ${make.description} ${model.description}`,
      );
    }

    // 5) OE enumeration per field via interchange prefix queries. Only fields
    //    we hold a number for are queried — the rest can produce nothing
    //    claimable, so paying for their prefix scans would be pure waste.
    const candidates: Claim[] = [];
    for (const fieldKey of WIX_FILTER_FIELDS) {
      if (!knownFields.has(fieldKey)) continue;
      const wixParts = agreed.get(fieldKey);
      if (!wixParts || wixParts.length === 0) continue;
      for (const prefix of seed.prefixes[fieldKey]) {
        const interRes = await getJson("/Search/InterchangeSearch", {
          partNumber: prefix,
        });
        if (looksBlocked(interRes)) {
          return fail(`blocked at InterchangeSearch (HTTP ${interRes.status})`, true);
        }
        candidates.push(
          ...parseInterchangeClaims(interRes.body, {
            fieldKey,
            wixPartNumbers: wixParts,
            oePrefixes: [prefix],
            manufacturers: seed.manufacturers,
            sourceUrl: interRes.url,
            observedAt: Date.now(),
          }),
        );
      }
    }
    if (candidates.length === 0) {
      return empty(
        `WIX parts found (${[...agreed.values()].flat().join(", ")}) but no OE ` +
          `cross-references under the seeded prefixes`,
      );
    }

    // 6) THE LAW: a cross-reference set confirms our number or says nothing.
    const { claims, interchange } = applyInterchangeLaw(candidates, known);
    const siblings = interchange.reduce((n, e) => n + e.siblings.length, 0);
    if (claims.length === 0) {
      return empty(
        `${candidates.length} OE cross-reference(s) enumerated across ` +
          `${interchange.map((e) => e.field_key).join(", ")} but none matched ` +
          `the number(s) on file (${known
            .map((p) => `${p.field_key}=${p.part_number}`)
            .join(", ")}) — a cross-reference set is one aftermarket part's ` +
          `replacement list, not this vehicle's options, so enumeration alone ` +
          `is never a claim`,
      );
    }
    return {
      adapter: ADAPTER_NAME,
      ok: true,
      claims,
      // Suppression is reported, never silent: a shrunken claim count must be
      // readable as the law working rather than as the source going quiet.
      error:
        `corroborated ${claims.length}/${candidates.length} enumerated OE ` +
        `number(s); ${siblings} sibling(s) kept as interchange metadata, not claims`,
    };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export const wixFiltersAdapter: SourceAdapter = {
  name: ADAPTER_NAME,
  family: "aftermarket_catalog",
  fields: WIX_FILTER_FIELDS,
  lookup: lookupWixFilters,
};
