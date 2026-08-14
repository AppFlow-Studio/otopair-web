// =============================================================================
// routeSources/intervals.ts — OEM service intervals from a route walk.
//
// The specs path (./ingest.ts) emits claims and lets the ledger reconcile them.
// Intervals do not work that way: `service_intervals` is a single row per
// (vehicle_config_id, service_id) written by both pipelines, arbitrated by
// `shouldOverwriteInterval` on `data_quality`. So this module produces rows for
// `_writeManualIntervals` and carries the provenance stamp that keeps a cheap
// HTML read from ever outranking the factory PDF. See ./provenance.ts for why
// that stamp is never `oem_manual`.
//
// PARSING IS SHARED, PROMPTING IS NOT
// -----------------------------------
// `parseManualIntervals`, `MANUAL_INTERVAL_TO_SERVICE` and
// `dedupeIntervalsByService` are reused verbatim from manualLibrary — the
// service-key vocabulary and the wear-item exclusions are hard-won and must not
// fork. The PROMPT is rewritten because manualLibrary's says "the attached
// PDF", and because `page_number` has no meaning here: a route citation is the
// chapter URL the quote was found on, resolved by search rather than asserted
// by the model.
//
// THE IDENTITY GATE IS NOT OPTIONAL
// ---------------------------------
// It is inherited from the PDF path, where a 2015 Sierra 3500HD manual was
// stored for a 2019 Sierra 1500 and would have written `oem_manual` at 0.95 for
// the wrong car. A route walk has its own version of that failure — landing on
// an adjacent generation when `pickGeneration` has a boundary year to resolve —
// so the model is asked to identify the vehicle the text is for, and a mismatch
// discards the whole extraction.
// =============================================================================

import { callClaudeExtractOnly } from "../utils/claudeClient";
import {
  dedupeIntervalsByService,
  MANUAL_INTERVAL_ORDER,
  parseManualIntervals,
  type ParsedManualInterval,
} from "../manualLibrary";
import type { AdapterVehicle } from "../sourceAdapters/types";
import { assembleRouteDocument, locateQuote } from "./assemble";
import { routeIntervalProvenance, type RouteIntervalProvenance } from "./provenance";
import type { RouteSource } from "./types";
import { walkRouteSource, type WalkDeps } from "./walk";

const EXTRACTION_SYSTEM =
  "You extract factory maintenance schedules from owner's manual text. You only " +
  "report intervals that appear in the supplied text, and you never fill gaps from " +
  "general knowledge.";

/**
 * Chapter relevance for INTERVAL extraction.
 *
 * Same philosophy as the per-source spec scorer: manufacturer taxonomies share
 * no vocabulary, so score on the words that actually turn up in chapter slugs
 * rather than hardcoding a chapter name. Deliberately generic — it has to work
 * on a site nobody has walked yet, which is the whole reason the walk is
 * manifest-driven.
 *
 * Note `technical-?data|specification` is absent: those chapters carry
 * capacities, not schedules, and pulling them here would spend the page budget
 * on text the specs walk already reads.
 *
 * NO WEAK CATCH-ALL RULE — and that is the point of this comment.
 * The spec scorer carries a `/care|mobility/` rule worth 2, which is harmless
 * there because genuinely relevant chapters always outscore it. Copying it here
 * was a real defect, caught on the first live walk (2022 BMW 3 Series, Aug 13
 * 2026): BMW prefixes EVERY chapter `mobility--`, so the rule matched the whole
 * manual, and with only one true maintenance chapter to find, the remaining
 * three page slots filled with `mobility`, `mobility--breakdown-assistance` and
 * `mobility--care` — 45 KB of roadside-assistance and car-washing text pushed
 * into the extraction context.
 *
 * A scorer for a scarce target must return NOTHING rather than the next best
 * thing. Fetching one right chapter beats fetching one right and three wrong.
 */
export const INTERVAL_SECTION_KEYWORDS: ReadonlyArray<{ re: RegExp; score: number }> = [
  { re: /maintenance-?schedule|service-?schedule|scheduled-?maintenance/i, score: 12 },
  { re: /maintenance|servicing/i, score: 8 },
  { re: /\bservice\b|inspection/i, score: 6 },
  { re: /warranty|owner-?information/i, score: 4 },
];

export function scoreIntervalSection(slug: string): number {
  let score = 0;
  for (const k of INTERVAL_SECTION_KEYWORDS) if (k.re.test(slug)) score += k.score;
  return score;
}

/**
 * Interval-extraction prompt for supplied TEXT.
 *
 * Rules 1–7 are manualLibrary's, kept word for word where they still apply:
 * they encode the recurrence-not-first-column rule, the condition-based-
 * reminder rule, and the wear-item prohibition, each of which exists because it
 * was violated in production.
 */
export function buildRouteIntervalPrompt(
  vehicle: { year: number; make: string; model: string },
  documentText: string,
): string {
  return [
    `Below are chapters from the manufacturer's owner's manual for the ${vehicle.year} ${vehicle.make} ${vehicle.model}, republished as text.`,
    "",
    "STEP 0 — VERIFY THE TEXT FIRST. From headings, titles, or model/year statements in the text, identify which vehicle it is actually for, and copy that identification VERBATIM into `document_vehicle_text`. Set `document_matches_vehicle` to false when the text names a DIFFERENT model year or a different model/series. When it matches — or the text genuinely does not identify a year/model — set it to true. If it is false, still fill the remaining fields honestly, but expect the caller to discard the extraction.",
    "",
    "Find the MAINTENANCE SCHEDULE (often titled 'Maintenance Schedule', 'Scheduled Maintenance', 'Maintenance Log', or inside a Warranty & Maintenance Guide) and report the factory service intervals.",
    "",
    "Rules — these override any instinct to be helpful:",
    "1. Report ONLY intervals stated in THIS text. Never infer, average, or fill from general knowledge. A missing value is `null`.",
    "2. `interval_miles` / `interval_months` are the NORMAL (standard) schedule. `severe_miles` / `severe_months` are the severe/special operating-conditions schedule if the text publishes one, else null.",
    "3. `quoted_text` must be a VERBATIM span copied from the text below that states the interval. If you cannot quote it, the interval does not belong in your answer. A quote that does not appear in the text is discarded.",
    "4. If the schedule is expressed as a repeating table (e.g. columns at 5,000 / 10,000 / 15,000 miles), report the RECURRENCE (the smallest repeating step for that item), not the first column.",
    "5. If the vehicle uses a condition-based reminder system (Honda Maintenance Minder, GM Oil Life) with no fixed mileage, set the mileage to null and say so in `notes` — do not substitute a typical value.",
    "6. Omit any service the text does not schedule. An empty `services` array is a correct answer.",
    "7. Wear-based items — brake pads, rotors, tires-by-tread, battery REPLACEMENT — have no factory replacement interval, which is why they have no service_key. NEVER convert an 'inspect …' schedule row into a replacement interval for anything. The only wear-adjacent keys: `battery_inspection` is the battery/terminal CHECK cadence; `wiper_blades` only when the schedule explicitly says REPLACE wiper blades; `tire_max_age` only when the text states a maximum tire age regardless of tread (report it as months; e.g. 'replace tires over six years old' → interval_months 72).",
    "8. `page_number` is not available for this source. Always report it as null.",
    "",
    `Allowed \`service_key\` values: ${MANUAL_INTERVAL_ORDER.join(", ")}.`,
    "",
    'Respond with ONLY a JSON object: {"document_matches_vehicle":true,"document_vehicle_text":"...","schedule_found":true,"schedule_kind":"...","services":[{"service_key":"...","interval_miles":null,"interval_months":null,"severe_miles":null,"severe_months":null,"quoted_text":"...","page_number":null}],"notes":null}',
    "",
    documentText,
  ].join("\n");
}

/** An interval row plus the chapter its quote was actually found on. */
export type RouteIntervalRow = ParsedManualInterval & { source_url: string };

export type RouteIntervalOutcome = {
  source: string;
  ok: boolean;
  rows: RouteIntervalRow[];
  /** The stamp these rows must be written under. Never `oem_manual`. */
  provenance: RouteIntervalProvenance;
  visited: string[];
  reason?: string;
  /** The extraction named a different vehicle — everything was discarded. */
  identityRejected?: boolean;
  blocked?: boolean;
};

function outcome(
  source: RouteSource,
  ok: boolean,
  rows: RouteIntervalRow[],
  visited: string[],
  extra: Partial<RouteIntervalOutcome> = {},
): RouteIntervalOutcome {
  return {
    source: source.id,
    ok,
    rows,
    provenance: routeIntervalProvenance(source.tier),
    visited,
    ...extra,
  };
}

/**
 * Walk a route source and return maintenance intervals for one vehicle.
 *
 * Never throws. An honest absence is `ok:true` with no rows; a site that
 * refused us is `ok:false` so the caller can retry rather than cache a gap.
 */
export async function ingestRouteIntervals(
  source: RouteSource,
  vehicle: AdapterVehicle,
  deps: Partial<WalkDeps> = {},
): Promise<RouteIntervalOutcome> {
  try {
    const walk = await walkRouteSource(source, vehicle, deps, {
      score: (link) => scoreIntervalSection(link.slug),
    });
    if (!walk.ok) {
      return outcome(source, false, [], walk.visited, {
        reason: walk.reason ?? "walk failed",
        blocked: walk.blocked === true,
      });
    }
    if (walk.sections.length === 0) {
      return outcome(source, true, [], walk.visited, { reason: walk.reason ?? "no sections" });
    }

    const doc = assembleRouteDocument(walk.sections);

    let data: Record<string, any> = {};
    try {
      const res = await callClaudeExtractOnly({
        system: EXTRACTION_SYSTEM,
        userPrompt: buildRouteIntervalPrompt(vehicle, doc.text),
        maxTokens: 4096,
        temperature: 0,
        estimatedInputTokens: Math.ceil(doc.text.length / 3) + 1500,
      });
      data = res.data ?? {};
    } catch (e) {
      return outcome(source, false, [], walk.visited, {
        reason: `extraction failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    // Identity gate, before anything is parsed into writable rows.
    if (data?.document_matches_vehicle === false) {
      const named =
        typeof data?.document_vehicle_text === "string" ? data.document_vehicle_text.slice(0, 200) : "";
      return outcome(source, true, [], walk.visited, {
        identityRejected: true,
        reason: `text identifies a different vehicle${named ? `: ${named}` : ""}`,
      });
    }

    const parsed = dedupeIntervalsByService(parseManualIntervals(data));
    if (parsed.length === 0) {
      return outcome(source, true, [], walk.visited, { reason: "no intervals in text" });
    }

    // Same rule as the specs path: a quote we cannot find in the text we
    // supplied is not evidence, and an interval written without evidence would
    // land in the same row a real manual competes for.
    const rows: RouteIntervalRow[] = [];
    const dropped: string[] = [];
    for (const row of parsed) {
      const loc = row.quoted_text ? locateQuote(doc, row.quoted_text) : null;
      if (!loc) {
        dropped.push(`${row.service_key}:quote not found in source text`);
        continue;
      }
      rows.push({ ...row, source_url: loc.url });
    }

    if (rows.length === 0) {
      return outcome(source, true, [], walk.visited, {
        reason: `every interval dropped [${dropped.join(", ")}]`,
      });
    }

    return outcome(source, true, rows, walk.visited, {
      ...(dropped.length > 0 ? { reason: `dropped: ${dropped.join(", ")}` } : {}),
    });
  } catch (e) {
    return outcome(source, false, [], [], {
      reason: e instanceof Error ? e.message : String(e),
    });
  }
}
