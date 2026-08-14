// =============================================================================
// routeSources/ingest.ts — walked text → claims, for any route source.
//
// The extraction contract is manualSpecs' SPEC_FIELDS, unchanged, so a claim
// from a route source clusters against a manual-PDF claim on identical field
// keys and the ledger reconciles them without knowing where either came from.
//
// Generalized from myCarUserManual.ts's buildExtractionPrompt/parseExtraction,
// which were never host-specific — they only ever read SPEC_FIELDS.
//
// WHAT CHANGED IN THE MOVE
// ------------------------
// Two gates the single-host version did not have:
//
//   1. EVERY QUOTE IS LOCATED. The old code accepted any non-empty
//      `quoted_text` and then stamped the claim with the FIRST section's URL
//      regardless of origin. Here the quote is searched for in the assembled
//      document; a value whose quote cannot be found is dropped, and one that
//      is found cites the page it was actually found on.
//
//   2. DUPLICATE FIELDS ARE RESOLVED, NOT FIRST-WON. Unchanged in effect (the
//      first row still wins) but now recorded — `dropped` explains every row
//      that did not become a claim, so an empty result is diagnosable without
//      a re-run.
// =============================================================================

import { callClaudeExtractOnly } from "../utils/claudeClient";
import { normalizeSpecValue, SPEC_FIELDS, SPEC_FIELD_KEYS } from "../manualSpecs";
import type { AdapterResult, AdapterVehicle, Claim } from "../sourceAdapters/types";
import { assembleRouteDocument, locateQuote, type RouteDocument } from "./assemble";
import { walkRouteSource, type WalkDeps } from "./walk";
import type { RouteSource } from "./types";

const EXTRACTION_SYSTEM =
  "You extract vehicle specifications from owner's manual text. You only report " +
  "values that appear verbatim in the supplied text, and you never fill gaps from " +
  "general knowledge.";

/**
 * Build the extraction prompt.
 *
 * `documentText` MUST be `RouteDocument.text` rather than a re-join of the
 * sections: locateQuote maps offsets into that exact string, and a prompt built
 * from a different concatenation would resolve quotes to the wrong page.
 */
export function buildRouteExtractionPrompt(
  vehicle: { year: number; make: string; model: string },
  documentText: string,
): string {
  const fieldLines = SPEC_FIELDS.map((f) => `- ${f.key} (${f.unit}): ${f.hint}`);
  return [
    `Below are chapters from the owner's manual for the ${vehicle.year} ${vehicle.make} ${vehicle.model}, republished as text.`,
    "",
    "Extract these specifications:",
    ...fieldLines,
    "",
    "Rules:",
    "1. Report ONLY values stated in the text below. Never infer, convert from a similar model, or fill from general knowledge. Omit anything absent.",
    "2. Every value needs `quoted_text`: a verbatim span from the text below stating it, copied exactly. No quote, no value — and a quote that does not appear in the text is discarded.",
    "3. Capacities marked (qts) must be US quarts; pressures psi; torque ft-lbs; wiper lengths inches. Put the bare number in `value`.",
    "4. Engine oil capacity = DRAIN AND REFILL WITH FILTER, not dry fill. Transmission = drain-and-fill service quantity, not total.",
    "5. If a value is split by engine or trim, copy that row's label verbatim into `engine_qualifier`; if you cannot tell which applies, omit the field.",
    "6. Omit anything the vehicle does not have. An absent field is a correct answer; a zero is not.",
    "",
    'Respond with ONLY a JSON object: {"specs":[{"field_key":"...","value":...,"unit_as_printed":"...","engine_qualifier":null,"quoted_text":"..."}]}',
    "",
    documentText,
  ].join("\n");
}

export type ExtractedSpecRow = {
  field_key: string;
  value: string;
  value_raw: string;
  quoted_text: string;
};

export type ParseRouteOutcome = {
  rows: ExtractedSpecRow[];
  /** `${field_key}:${reason}` for every row that did not survive. */
  dropped: string[];
};

/** Parse the model's JSON into claims-ready rows. Fails closed per row. */
export function parseRouteExtraction(parsed: unknown): ParseRouteOutcome {
  const raw = (parsed as any)?.specs;
  const dropped: string[] = [];
  if (!Array.isArray(raw)) return { rows: [], dropped: ["*:no specs array"] };

  const rows: ExtractedSpecRow[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    const key = typeof item?.field_key === "string" ? item.field_key.trim() : "";
    if (!SPEC_FIELD_KEYS.includes(key)) {
      dropped.push(`${key || "?"}:unknown field`);
      continue;
    }
    if (seen.has(key)) {
      dropped.push(`${key}:duplicate`);
      continue;
    }

    const value = normalizeSpecValue(key, item?.value);
    if (value == null) {
      dropped.push(`${key}:unnormalizable value`);
      continue;
    }

    const quoted =
      typeof item?.quoted_text === "string" && item.quoted_text.trim().length > 0
        ? item.quoted_text.trim().slice(0, 600)
        : null;
    // Same rule as the PDF path: an unquotable value is not evidence.
    if (!quoted) {
      dropped.push(`${key}:no quote`);
      continue;
    }

    const printed =
      typeof item?.unit_as_printed === "string" ? item.unit_as_printed.trim().slice(0, 40) : "";
    const rawVal =
      typeof item?.value === "number" || typeof item?.value === "string"
        ? String(item.value)
        : value;

    seen.add(key);
    rows.push({
      field_key: key,
      value,
      value_raw: printed ? `${rawVal} ${printed}`.trim() : rawVal,
      quoted_text: quoted,
    });
  }

  return { rows, dropped };
}

/**
 * Turn parsed rows into claims, citing the page each quote was found on.
 *
 * A row whose quote cannot be located in the assembled document is DROPPED, not
 * downgraded. See the header in assemble.ts: a span we cannot find in the text
 * we supplied is not evidence, and citing the document root instead would
 * reintroduce exactly the defect this replaces.
 */
export function claimsFromRows(
  source: RouteSource,
  doc: RouteDocument,
  rows: readonly ExtractedSpecRow[],
  observedAt: number,
): { claims: Claim[]; dropped: string[] } {
  const claims: Claim[] = [];
  const dropped: string[] = [];

  for (const r of rows) {
    const loc = locateQuote(doc, r.quoted_text);
    if (!loc) {
      dropped.push(`${r.field_key}:quote not found in source text`);
      continue;
    }
    claims.push({
      field_key: r.field_key,
      value: r.value,
      value_raw: r.value_raw,
      source_family: source.family,
      source_domain: source.host,
      source_url: loc.url,
      method: "llm_extraction",
      observed_label: r.quoted_text,
      observed_at: observedAt,
    });
  }

  return { claims, dropped };
}

/** Ran fine, found nothing to claim — a normal, non-error outcome. */
function empty(source: RouteSource, note: string): AdapterResult {
  return { adapter: source.id, ok: true, claims: [], error: note };
}

function failed(source: RouteSource, note: string, needsHeadless = false): AdapterResult {
  return {
    adapter: source.id,
    ok: false,
    claims: [],
    error: note,
    ...(needsHeadless ? { needs_headless: true } : {}),
  };
}

/**
 * Walk a route source for one vehicle and return spec claims.
 *
 * Never throws — the pipeline law. A walk that finds nothing is `ok:true` with
 * no claims; a walk the site refused is `ok:false` so the caller can retry or
 * escalate.
 */
export async function ingestRouteSpecs(
  source: RouteSource,
  vehicle: AdapterVehicle,
  deps: Partial<WalkDeps> = {},
): Promise<AdapterResult> {
  try {
    const walk = await walkRouteSource(source, vehicle, deps);
    if (!walk.ok) return failed(source, walk.reason ?? "walk failed", walk.blocked === true);
    if (walk.sections.length === 0) return empty(source, walk.reason ?? "no sections");

    const doc = assembleRouteDocument(walk.sections);

    let data: Record<string, any> = {};
    try {
      const res = await callClaudeExtractOnly({
        system: EXTRACTION_SYSTEM,
        userPrompt: buildRouteExtractionPrompt(vehicle, doc.text),
        maxTokens: 4096,
        temperature: 0,
        // ~3 chars/token for the document, plus headroom for the field list.
        estimatedInputTokens: Math.ceil(doc.text.length / 3) + 1500,
      });
      data = res.data ?? {};
    } catch (e) {
      return failed(source, `extraction failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    const parsed = parseRouteExtraction(data);
    if (parsed.rows.length === 0) {
      return empty(source, `extraction produced no usable specs [${parsed.dropped.join(", ")}]`);
    }

    const { claims, dropped } = claimsFromRows(source, doc, parsed.rows, Date.now());
    const allDropped = [...parsed.dropped, ...dropped];
    if (claims.length === 0) {
      return empty(source, `every value dropped [${allDropped.join(", ")}]`);
    }

    return {
      adapter: source.id,
      ok: true,
      claims,
      ...(allDropped.length > 0 ? { error: `dropped: ${allDropped.join(", ")}` } : {}),
    };
  } catch (e) {
    return failed(source, e instanceof Error ? e.message : String(e));
  }
}
