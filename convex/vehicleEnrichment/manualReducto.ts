/**
 * vehicleEnrichment/manualReducto.ts — THE OVERSIZE MANUAL PATH
 *
 * WHY THIS EXISTS
 * ---------------
 * The Anthropic Messages API caps a request at 32 MB and 600 pages. Real OEM
 * owner's manuals routinely exceed both — the 2020 Accord OM is 38.7 MB, the
 * 2017 Mazda3 is 57 MB, the 2019 F-150 runs 644 pages — so the very documents
 * with the richest specification chapters were the ones manualLibrary recorded
 * as `too_large_*` and never read. Those vehicles were not partially enriched;
 * they were structurally unreachable.
 *
 * Reducto is already a dependency of this codebase (vehicleDocuments_node.ts
 * runs user-uploaded service receipts through /classify + /extract), so the
 * oversize path reuses a vendor, an API key and a calling convention that are
 * already in production rather than introducing a new one.
 *
 * WHERE IT SITS
 * -------------
 * This is a FALLBACK, never a default. The Anthropic path stays preferred for
 * everything that fits, because it returns page-level citations that make an
 * `oem_manual` interval auditable, and Reducto's per-field confidence is not
 * the same evidence. Routing happens once, at download time, from the byte
 * count (`extractorForBytes`) — not here.
 *
 * WHAT IT SHARES
 * --------------
 * Everything that decides truth. Reducto is an EXTRACTOR swap, not a pipeline
 * fork. Both routes here import their contracts rather than restating them:
 *
 *   INTERVALS — keys, parser, dedupe and write precedence come from
 *   manualLibrary; the write is the same `_writeManualIntervals` mutation, so
 *   a Reducto interval obeys the same rules (never downgrade a
 *   `deterministic`/`oem_manual` row, never touch a mechanic-verified one).
 *
 *   SPECS — field contract, identity guard, quote requirement, engine-
 *   qualifier rule and normalization come from manualSpecs.parseSpecPayload,
 *   and the OEM-vs-mirror family decision from manualSpecs.familyForManual.
 *   Results are filed as claims, so the reconciler weighs them and nothing
 *   here can overwrite a stored value.
 *
 * The one thing each route states for itself is its adapter id
 * (`manual_specs_reducto`), because the ledger is a provenance record and an
 * audit must be able to see which instrument read the document — and retract
 * one extractor's output without destroying the other's.
 *
 * PIPELINE LAW
 * ------------
 * FAIL OPEN: every path returns a diagnostic and never throws.
 * PRESENT-BUT-WRONG IS FORBIDDEN: the same identity guard the Anthropic passes
 * use applies here — the extractor must affirmatively confirm the document is
 * this vehicle, or nothing is written.
 *
 * Wire-in points — both are delegated to, never selected directly. The routing
 * decision belongs to the size check made once at download time:
 *   - internal.vehicleEnrichment.manualReducto.extractIntervalsViaReducto
 *     (from manualLibrary.extractIntervalsFromManual)
 *   - internal.vehicleEnrichment.manualReducto.extractSpecsViaReducto
 *     (from manualSpecs.extractSpecsFromManual)
 */

import { v } from "convex/values";
import { internalAction, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  dedupeIntervalsByService,
  EXTRACTOR_REDUCTO,
  MANUAL_INTERVAL_ORDER,
  MANUAL_MAX_REJECTIONS,
  normalizeMakeKey,
  parseManualIntervals,
} from "./manualLibrary";
import {
  billedPageCount,
  pageCountOf,
  pageIndexIsFresh,
  specsPageRanges,
  toReductoPageRange,
  type ManualPageIndex,
} from "./manualPageIndex";
import {
  familyForManual,
  parseSpecPayload,
  ROTOR_QUOTE_RULE,
  SPECS_ADAPTER_REDUCTO,
  SPEC_FIELDS,
  SPEC_FIELD_KEYS,
} from "./manualSpecs";

const selfApi = () => (internal as any).vehicleEnrichment.manualReducto;
const libApi = () => (internal as any).vehicleEnrichment.manualLibrary;
const specsApi = () => (internal as any).vehicleEnrichment.manualSpecs;
const claimApi = () => (internal as any).vehicleEnrichment.claimGathering;

const REDUCTO_BASE = "https://platform.reducto.ai";

/**
 * COST CONTROL. Reducto bills per PAGE, and `settings.page_range` defaults to
 * the ENTIRE document — so every oversize manual we hand it is a 400-page
 * charge to recover about ten interval rows and eighteen specs that live on a
 * handful of pages. Measured Aug 18 2026: three manuals cost roughly $50, i.e.
 * ~$16.67 each, ~$0.042/page against the 395-page Acadia. At that rate a
 * thousand vehicles is ~$17k, which is not a pipeline, it is a bill.
 *
 * Two bounds until page-range selection lands:
 *   PARTS_REDUCTO=off      hard kill switch, no calls at all.
 *   REDUCTO_MAX_PAGES      refuse a document larger than this (default 250).
 *                          A refusal is an honest gap; a silent $16 charge for
 *                          a document we may not even be able to use is not.
 */
export function reductoEnabled(): boolean {
  return process.env.PARTS_REDUCTO !== "off";
}

/** Page ceiling above which a document is too expensive to send whole. */
export function reductoMaxPages(): number {
  const n = parseInt(process.env.REDUCTO_MAX_PAGES ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 250;
}

/** Is this document within the page budget? Unknown page count passes — the
 *  ceiling exists to stop known-huge documents, not to block on missing data. */
export function withinReductoPageBudget(pageCount: number | null | undefined): boolean {
  if (typeof pageCount !== "number" || !Number.isFinite(pageCount) || pageCount <= 0) return true;
  return pageCount <= reductoMaxPages();
}
/** A 600-page manual takes Reducto meaningfully longer than a receipt. */
const REDUCTO_TIMEOUT_MS = 300_000;

// ============================================================================
// Extraction schema
// ============================================================================

/**
 * The schema Reducto fills.
 *
 * Deliberately the same SHAPE as manualLibrary's Anthropic tool schema, so the
 * payload can go straight into `parseManualIntervals` and inherit every
 * fail-closed rule it already enforces (unknown key dropped, non-positive
 * numbers nulled, an entry with neither miles nor months dropped).
 *
 * One divergence: no `anyOf`-nullable leaves. Reducto's extractor is a JSON
 * Schema consumer, not a tool-use model, and plain optional typed fields are
 * what its docs describe; the parser treats absent and null identically, so
 * nothing downstream can tell the difference.
 */
export const REDUCTO_INTERVAL_SCHEMA: Record<string, any> = {
  type: "object",
  properties: {
    document_matches_vehicle: {
      type: "boolean",
      description:
        "False ONLY if this document names a DIFFERENT model or model year than the one asked about. True when it matches — or when the document does not clearly identify a specific model/year (generic covers are common and are not a mismatch).",
    },
    document_vehicle_text: {
      type: "string",
      description: "Verbatim vehicle/model-year text from the cover or title page.",
    },
    schedule_found: {
      type: "boolean",
      description: "True if this document contains a factory maintenance schedule.",
    },
    services: {
      type: "array",
      description: "One entry per scheduled maintenance service found.",
      items: {
        type: "object",
        properties: {
          service_key: {
            type: "string",
            enum: [...MANUAL_INTERVAL_ORDER],
            description: "Which service this interval is for.",
          },
          interval_miles: {
            type: "number",
            description:
              "NORMAL-schedule recurrence in miles (the smallest repeating step, not the first column). Omit if not stated.",
          },
          interval_months: {
            type: "number",
            description: "NORMAL-schedule recurrence in months. Omit if not stated.",
          },
          severe_miles: {
            type: "number",
            description: "Severe/special operating conditions schedule, miles. Omit if none published.",
          },
          severe_months: {
            type: "number",
            description: "Severe/special operating conditions schedule, months. Omit if none published.",
          },
          quoted_text: {
            type: "string",
            description: "Verbatim span from the document stating this interval.",
          },
          page_number: { type: "number", description: "Page the interval appears on." },
        },
        required: ["service_key"],
      },
    },
    notes: { type: "string" },
  },
  required: ["document_matches_vehicle", "schedule_found", "services"],
};

export function buildReductoInstructions(vehicle: {
  year: number;
  make: string;
  model: string;
}): string {
  return [
    `This document is manufacturer documentation. The vehicle in question is the ${vehicle.year} ${vehicle.make} ${vehicle.model}.`,
    // Contradiction-only mismatch (Aug 9 2026): Hyundai prints a generic
    // "HYUNDAI OWNER'S MANUAL" cover with no model name, and the old
    // "confirm the exact vehicle" wording made Reducto report a mismatch for
    // the CORRECT 2022 Palisade manual. Unidentified must fail OPEN — the
    // same semantics as the Anthropic-path prompt.
    "First read the cover or title page and copy its vehicle identification verbatim into document_vehicle_text. Set document_matches_vehicle to false ONLY when the document names a DIFFERENT model or a different model year than the vehicle in question. If it matches, or the document does not clearly identify a specific model or year, set it to true.",
    "Then find the factory MAINTENANCE SCHEDULE and report each service's interval.",
    "Report only intervals printed in this document — never infer, average, or fill from general knowledge.",
    "interval_miles/interval_months are the NORMAL schedule; severe_* is the severe-conditions schedule if one is published.",
    "If the schedule is a repeating table (5,000 / 10,000 / 15,000 miles), report the RECURRENCE — the smallest repeating step for that item — not the first column.",
    "If the vehicle uses a condition-based reminder system (Honda Maintenance Minder, GM Oil Life) with no fixed mileage, omit the mileage and say so in notes.",
    "Wear-based items (brake pads, rotors, tires-by-tread, battery replacement) have no factory replacement interval and no service_key — NEVER convert an 'inspect …' row into a replacement interval. battery_inspection is the battery/terminal CHECK cadence; wiper_blades only when the schedule explicitly says REPLACE them; tire_max_age only when the document states a maximum tire age regardless of tread, reported as months.",
    "Every reported interval needs a verbatim quoted_text from the document.",
  ].join(" ");
}

// ============================================================================
// Specifications schema (oversize route for manualSpecs)
// ============================================================================

/**
 * The specs schema Reducto fills.
 *
 * `value` is a STRING for every field, including the numeric ones. That is
 * deliberate: a `number | string` union is exactly the kind of shape a JSON
 * Schema consumer is most likely to handle badly, and we do not need it —
 * `normalizeSpecValue` already accepts strings on both branches (numStr parses
 * "4.8", textStr uppercases "0W-20"). Asking for one consistent type removes a
 * class of extractor confusion for nothing.
 *
 * The result parses with manualSpecs' OWN `parseSpecPayload`, so the identity
 * guard, the quote requirement, the engine-qualifier rule, the normalization
 * and the duplicate handling are all inherited rather than rewritten.
 */
export const REDUCTO_SPECS_SCHEMA: Record<string, any> = {
  type: "object",
  properties: {
    document_matches_vehicle: {
      type: "boolean",
      description:
        "False ONLY if this document names a DIFFERENT model or model year than the one asked about. True when it matches — or when the document does not clearly identify a specific model/year (generic covers are common and are not a mismatch).",
    },
    document_vehicle_text: {
      type: "string",
      description: "Verbatim vehicle/model-year text from the cover or title page.",
    },
    specs: {
      type: "array",
      description: "One entry per specification found. Omit anything not printed in the document.",
      items: {
        type: "object",
        properties: {
          field_key: {
            type: "string",
            enum: [...SPEC_FIELD_KEYS],
            description: "Which specification this is.",
          },
          value: {
            type: "string",
            description:
              "The value. For numeric fields give the bare number as text (e.g. \"4.8\", \"35\"); for text fields the value as printed (e.g. \"0W-20\", \"DOT 4\").",
          },
          unit_as_printed: {
            type: "string",
            description: "Units exactly as the document printed them, e.g. \"US qts\", \"psi\".",
          },
          engine_qualifier: {
            type: "string",
            description:
              "Verbatim engine/trim label for this row when the table is split by engine. Omit when the spec is stated once for the whole vehicle.",
          },
          quoted_text: {
            type: "string",
            description: "Verbatim span from the document stating this value.",
          },
          page_number: { type: "number", description: "Page the value appears on." },
        },
        required: ["field_key", "value", "quoted_text"],
      },
    },
    notes: { type: "string" },
  },
  required: ["document_matches_vehicle", "specs"],
};

export function buildReductoSpecsInstructions(vehicle: {
  year: number;
  make: string;
  model: string;
  engine_label?: string | null;
}): string {
  const fields = SPEC_FIELDS.map((f) => `${f.key} (${f.unit}): ${f.hint}`).join("; ");
  return [
    `This document is manufacturer documentation. The vehicle in question is the ${vehicle.year} ${vehicle.make} ${vehicle.model}` +
      (vehicle.engine_label ? ` with the ${vehicle.engine_label} engine.` : "."),
    "First read the cover or title page and copy its vehicle identification verbatim into document_vehicle_text. Set document_matches_vehicle to false ONLY when the document names a DIFFERENT model or model year; if it matches, or does not clearly identify a specific model/year, set it to true.",
    "Then find the SPECIFICATIONS section (often titled Specifications, Vehicle Data, Technical Data, or Capacities) and report these values:",
    fields + ".",
    "Report only values printed in this document — never infer, convert from a similar model, or fill from general knowledge.",
    "Capacities marked (qts) must be US quarts: if the document prints litres alongside US quarts, use the US quart figure. Pressures are psi, torque ft-lbs, wiper lengths inches.",
    "Engine oil capacity means DRAIN AND REFILL WITH FILTER CHANGE — not the dry-fill total and not the without-filter figure. Transmission fluid means the drain-and-fill service quantity, not the total.",
    "If a value is split by engine or trim, report the row for the engine named above and copy that row's label verbatim into engine_qualifier; if you cannot tell which row applies, omit that field entirely.",
    "Omit anything the vehicle does not have. Every reported value needs a verbatim quoted_text.",
    ROTOR_QUOTE_RULE,
  ].join(" ");
}

// ============================================================================
// Response handling
// ============================================================================

type ReductoWrapped = { value: unknown; citations?: unknown };

function isWrapped(v: unknown): v is ReductoWrapped {
  return (
    typeof v === "object" &&
    v !== null &&
    "value" in (v as Record<string, unknown>) &&
    "citations" in (v as Record<string, unknown>)
  );
}

/**
 * Unwrap Reducto's citation envelope.
 *
 * With `settings.citations.enabled` every leaf comes back as
 * `{ value, citations[] }` rather than the bare value, so a payload handed
 * straight to a parser looks like a tree of objects where numbers were
 * expected. Mirrors the unwrap in vehicleDocuments_node.ts; kept local because
 * that module is `"use node"` and this one is not.
 */
export function unwrapReducto(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(unwrapReducto);
  if (isWrapped(node)) return unwrapReducto(node.value);
  if (typeof node === "object" && node !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(node as Record<string, unknown>)) {
      out[k] = unwrapReducto(val);
    }
    return out;
  }
  return node;
}

/** Pull the extraction object out of a /extract response body. */
export function extractReductoResult(body: unknown): Record<string, any> | null {
  const result = (body as any)?.result;
  const first = Array.isArray(result) ? result[0] : result;
  if (!first || typeof first !== "object") return null;
  const unwrapped = unwrapReducto(first);
  return unwrapped && typeof unwrapped === "object" ? (unwrapped as Record<string, any>) : null;
}

// ============================================================================
// Data layer
// ============================================================================

/** The config's identity plus its manual row's storage handle. */
export const getReductoContext = internalQuery({
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
    if (!manual) return null;

    // Prefer our stored copy (original hosts are frequently slow — Ford's
    // CDN timed out at 60 s in the July research). REFERENCE-ONLY rows
    // (Aug 9 2026) have no stored bytes at all: manuals past the ~20 MB
    // action-runtime ceiling can never be downloaded in-action, so the
    // resolver stores just the source_url and Reducto — which fetches its
    // input itself, server-side — reads the public PDF directly (the 39 MB
    // carmans CX-30 manual).
    const storageUrl = manual.storage_id ? await ctx.storage.getUrl(manual.storage_id) : null;
    const directPdfUrl =
      !storageUrl &&
      typeof manual.source_url === "string" &&
      /\.pdf(?:[?#]|$)/i.test(manual.source_url)
        ? manual.source_url
        : null;
    if (!storageUrl && !directPdfUrl) return null;

    return {
      year: cfg.year as number,
      make: make as string,
      model: model as string,
      source_url: manual.source_url,
      doc_kind: manual.doc_kind,
      file_bytes: manual.file_bytes ?? null,
      // Reducto bills per page, so the page count is a COST figure, not
      // metadata. Carried here so the budget gate can refuse a 395-page
      // document before it becomes a ~$16 charge.
      page_count: (manual as any).page_count ?? null,
      /** Which pages to actually bill for. See manualPageIndex. */
      page_index: ((manual as any).page_index ?? null) as ManualPageIndex | null,
      // A signed, unguessable URL Reducto can fetch — or, for reference-only
      // rows, the public source PDF itself.
      url: storageUrl ?? directPdfUrl,
    };
  },
});

// ============================================================================
// Action
// ============================================================================

/**
 * Read an oversize manual with Reducto and write its intervals.
 *
 * Reaches the document through a Convex storage URL, which is why the bytes
 * had to be kept in the first place: the original host is frequently slow
 * (Ford's CDN timed out at 60 s during the July research) and re-downloading a
 * 57 MB PDF on every extraction would be its own failure mode.
 */
export const extractIntervalsViaReducto = internalAction({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (
    ctx,
    args,
  ): Promise<{ status: "ok" | "skipped" | "failed"; written: number; skipped: number; reason: string }> => {
    // A `failed` here used to return its reason to a caller that discarded it,
    // so the whole rung was invisible: the four Aug-14 proxied manuals all
    // routed to Reducto, all got `reducto_401: Invalid access token`, and the
    // runs simply recorded zero intervals. The read looked like "these manuals
    // had no schedule" when the truth was an expired credential. A dead
    // fallback that says nothing is worse than no fallback at all — it costs
    // the round trip AND hides the reason.
    const none = (status: "skipped" | "failed", reason: string) => {
      if (status === "failed") {
        console.error(`[manual-reducto] FAILED: ${reason.slice(0, 300)}`);
      } else {
        console.warn(`[manual-reducto] skipped: ${reason.slice(0, 200)}`);
      }
      return { status, written: 0, skipped: 0, reason };
    };

    try {
      if (!reductoEnabled()) return none("skipped", "reducto_disabled");
      const apiKey = process.env.REDUCTO_API_KEY;
      if (!apiKey) return none("failed", "no_reducto_api_key");

      const context = await ctx.runQuery(selfApi().getReductoContext, {
        vehicleConfigId: args.vehicleConfigId,
      });
      if (!context) return none("skipped", "no_stored_manual");
      // Budget judges the BILLED pages, not the document. A 395-page manual
      // narrowed to 15 is a 15-page charge and must not be refused; an
      // unindexed one is still a 395-page charge and must be.

      if (!context.url) return none("failed", "storage_url_unavailable");

      const label = `${context.year} ${context.make} ${context.model}`;

      // Narrow to the maintenance-schedule pages when the manual has been
      // indexed. This is what turns a ~$16 call into a ~$0.60 one.
      //
      // Index ON DEMAND when it is missing: the scan is local, free and about
      // 1.5 s, against a per-page bill that is three orders of magnitude
      // larger. Doing it here rather than at download time means every manual
      // already in the library gets narrowed on its next extraction instead of
      // needing a backfill.
      let ivIdxLive = ((context as any).page_index ?? null) as ManualPageIndex | null;
      if (!pageIndexIsFresh(ivIdxLive)) {
        try {
          await ctx.runAction(
            (internal as any).vehicleEnrichment.manualPageIndex_node.indexManualPages,
            { make: context.make, model: context.model, year: context.year },
          );
          const re: any = await ctx.runQuery(selfApi().getReductoContext, {
            vehicleConfigId: args.vehicleConfigId,
          });
          ivIdxLive = (re?.page_index ?? null) as ManualPageIndex | null;
        } catch (e) {
          // Fail open — an unindexed manual still extracts, at full price.
          console.warn(`[manual-reducto] ${label}: page indexing failed, sending whole document:`, e);
        }
      }
      const ivIndex = ivIdxLive;
      // Budget judges the BILLED pages, and it must run AFTER indexing: gating
      // on the raw document size first would refuse the 395-page manuals this
      // narrowing exists for, before they ever got narrowed.
      // billedPageCount, not pageCountOf: a fresh index with NO interval pages
      // narrows nothing and therefore bills the whole document — see its
      // header. Passing the empty list's 0 here approved exactly that.
      const ivBilled = pageIndexIsFresh(ivIndex)
        ? billedPageCount(ivIndex!.intervals, context.page_count)
        : context.page_count;
      if (!withinReductoPageBudget(ivBilled)) {
        return none("skipped", `page_budget_exceeded:${ivBilled}>${reductoMaxPages()}`);
      }
      const ivPageRange = pageIndexIsFresh(ivIndex)
        ? toReductoPageRange(ivIndex!.intervals)
        : null;
      if (ivPageRange) {
        console.log(
          `[manual-reducto] ${label}: intervals narrowed to ` +
            `${pageCountOf(ivIndex!.intervals)}/${ivIndex!.total_pages} pages ` +
            `(${ivIndex!.intervals.map((r) => `${r.start}-${r.end}`).join(",")})`,
        );
      }

      let body: any;
      try {
        const res = await fetch(`${REDUCTO_BASE}/extract`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          // The schema MUST ride in `instructions.schema`. A top-level
          // `schema` is silently ignored: the API answers 200 and falls back
          // to generic auto-extraction, so every one of our keys comes back
          // empty and the failure looks like "the manual had no schedule".
          // This cost real debugging time on the receipt path — see
          // vehicleDocuments_node.ts.
          body: JSON.stringify({
            input: context.url,
            instructions: {
              schema: REDUCTO_INTERVAL_SCHEMA,
              prompt: buildReductoInstructions(context),
            },
            settings: {
              citations: { enabled: true },
              // THE COST LEVER. Omitting this bills the whole document —
              // ~395 pages to recover ten interval rows. Null when the manual
              // was never indexed, which restores the previous behaviour
              // rather than silently narrowing to nothing.
              ...(ivPageRange ? { page_range: ivPageRange } : {}),
            },
          }),
          signal: AbortSignal.timeout(REDUCTO_TIMEOUT_MS),
        });
        if (!res.ok) {
          const detail = (await res.text().catch(() => "")).slice(0, 300);
          return none("failed", `reducto_${res.status}:${detail}`);
        }
        body = await res.json();
      } catch (e) {
        return none("failed", `reducto_error:${String(e).slice(0, 200)}`);
      }

      const payload = extractReductoResult(body);
      if (!payload) return none("failed", "no_reducto_result");

      // Same identity guard as the Anthropic passes. An oversize document is
      // no more likely to be the right one, and a spec table from the wrong
      // model reads as a perfectly good answer.
      if (payload.document_matches_vehicle !== true) {
        const saw = String(payload.document_vehicle_text ?? "").slice(0, 160);
        console.warn(`[manual-reducto] ${label}: document mismatch${saw ? ` — saw "${saw}"` : ""}`);
        return none("skipped", "document_vehicle_mismatch");
      }

      const rows = dedupeIntervalsByService(parseManualIntervals(payload));
      if (rows.length === 0) {
        console.log(
          `[manual-reducto] ${label}: no storable intervals (schedule_found=${payload.schedule_found})`,
        );
        // Mirror the Anthropic path's rejection (Aug 9 2026): a document the
        // reader says carries NO schedule is the wrong document, and without
        // this the row sat "fresh" for 180 days — the CX-30's 27 MB
        // NAVIGATION manual would have blocked its real manual for six
        // months. Same MANUAL_MAX_REJECTIONS bound as the Anthropic branch.
        if (payload.schedule_found === false) {
          try {
            const manualRow: any = await ctx.runQuery(libApi().getStoredManual, {
              make: context.make,
              model: context.model,
              year: context.year,
            });
            const priorRejections = (manualRow?.rejected_urls ?? []).length;
            if (priorRejections < MANUAL_MAX_REJECTIONS) {
              await ctx.runMutation(libApi().rejectManualRow, {
                make: context.make,
                model: context.model,
                year: context.year,
                reason: "reducto: schedule_found=false",
              });
            }
          } catch (e) {
            console.warn(`[manual-reducto] ${label}: could not record rejection:`, e);
          }
        }
        if (ivIndex?.defers_to?.length) {
          // NOT a failed extraction. The document told us where the schedule
          // actually lives, so report the title rather than a generic miss —
          // one of those is actionable and the other looks like a dead end.
          const d = ivIndex.defers_to[0];
          console.warn(
            `[manual-reducto] ${label}: no schedule here — the manual defers to ` +
              `"${d.title}"${d.region ? ` (${d.region})` : ""} on p${d.pages[0]}. ` +
              `Fetch that document; this one will never carry intervals.`,
          );
          return none("skipped", `defers_to:${d.title}`);
        }
        return none("skipped", "no_intervals_extracted");
      }

      // The SAME write path as the Anthropic extractor — precedence, the
      // mechanic-verified shield and the months-provenance rule all live
      // there and must not be duplicated here.
      const result = await ctx.runMutation(libApi()._writeManualIntervals, {
        vehicleConfigId: args.vehicleConfigId,
        source_url: context.source_url,
        rows: rows.map((r) => ({
          service_slug: r.service_slug,
          interval_miles: r.interval_miles,
          interval_months: r.interval_months,
          display_string: r.display_string,
          quoted_text: r.quoted_text,
        })),
      });

      console.log(
        `[manual-reducto] ${label}: extracted ${rows.length} interval(s) from a ` +
          `${context.file_bytes ? (context.file_bytes / 1024 / 1024).toFixed(1) : "?"} MB document; ` +
          `wrote ${result.written}, skipped ${result.skipped}`,
      );

      return { status: "ok", written: result.written, skipped: result.skipped, reason: EXTRACTOR_REDUCTO };
    } catch (e) {
      console.warn("[manual-reducto] extractIntervalsViaReducto failed:", e);
      return none("failed", `unexpected:${String(e).slice(0, 200)}`);
    }
  },
});

/**
 * Read an oversize manual's SPECIFICATIONS with Reducto and file them as claims.
 *
 * The specs counterpart to extractIntervalsViaReducto, and the piece that
 * closes `oversize_no_specs_path`: before this, a manual too large for the
 * Messages API yielded intervals but never capacities, viscosities or
 * pressures — the fields its specification chapter is densest in.
 *
 * Everything that decides truth is imported, not reimplemented:
 *   - identity guard, quote requirement, engine matching, normalization and
 *     duplicate handling come from manualSpecs.parseSpecPayload;
 *   - the OEM-vs-mirror family rule comes from manualSpecs.familyForManual;
 *   - the write is the shared claim ledger, so nothing here can overwrite a
 *     stored value or outrank a mechanic.
 *
 * Never throws.
 */
export const extractSpecsViaReducto = internalAction({
  args: {
    vehicleConfigId: v.id("vehicle_configs"),
    runId: v.optional(v.id("enrichment_runs")),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ status: "ok" | "skipped" | "failed"; claims: number; dropped: number; reason: string }> => {
    // Logged for the same reason the interval side is: a reason returned to a
    // caller that discards it is a rung that fails in total silence. This path
    // now carries all 18 spec fields for every oversize manual, so a quiet
    // failure here loses more than the interval one did.
    const none = (status: "skipped" | "failed", reason: string) => {
      if (status === "failed") {
        console.error(`[manual-reducto] specs FAILED: ${reason.slice(0, 300)}`);
      } else {
        console.warn(`[manual-reducto] specs skipped: ${reason.slice(0, 200)}`);
      }
      return { status, claims: 0, dropped: 0, reason };
    };

    try {
      if (!reductoEnabled()) return none("skipped", "reducto_disabled");
      const apiKey = process.env.REDUCTO_API_KEY;
      if (!apiKey) return none("failed", "no_reducto_api_key");

      // Same context query the Anthropic specs pass uses — one place resolves
      // identity and engine, so the qualifier rule cannot drift between the
      // two extractors.
      const context = await ctx.runQuery(specsApi().getSpecExtractionContext, {
        vehicleConfigId: args.vehicleConfigId,
      });
      if (!context) return none("skipped", "config_not_resolvable");
      if (!context.manual?.storage_id) return none("skipped", "no_stored_manual");
      if (!context.manual?.url) return none("failed", "storage_url_unavailable");


      const label = `${context.year} ${context.make} ${context.model}`;

      let spIdxLive = ((context.manual as any)?.page_index ?? null) as ManualPageIndex | null;
      if (!pageIndexIsFresh(spIdxLive)) {
        try {
          await ctx.runAction(
            (internal as any).vehicleEnrichment.manualPageIndex_node.indexManualPages,
            { make: context.make, model: context.model, year: context.year },
          );
          const re: any = await ctx.runQuery(specsApi().getSpecExtractionContext, {
            vehicleConfigId: args.vehicleConfigId,
          });
          spIdxLive = ((re?.manual as any)?.page_index ?? null) as ManualPageIndex | null;
        } catch (e) {
          console.warn(`[manual-reducto] ${label}: page indexing failed, sending whole document:`, e);
        }
      }
      const spIndex = spIdxLive;
      // Capacities AND brake limits — this pass asks for rotor minimums, so it
      // has to be sent the brake pages too. `specsPageRanges` merges the two
      // lists so an overlap is billed once. See BRAKE SIGNALS in
      // manualPageIndex.ts.
      const spRanges = pageIndexIsFresh(spIndex) ? specsPageRanges(spIndex) : [];
      const spBilled = pageIndexIsFresh(spIndex)
        ? billedPageCount(spRanges, (context.manual as any)?.page_count)
        : (context.manual as any)?.page_count;
      if (!withinReductoPageBudget(spBilled)) {
        return none("skipped", `page_budget_exceeded:${spBilled}>${reductoMaxPages()}`);
      }
      const spPageRange = pageIndexIsFresh(spIndex) ? toReductoPageRange(spRanges) : null;
      if (spPageRange) {
        console.log(
          `[manual-reducto] ${label}: specs narrowed to ` +
            `${pageCountOf(spRanges)}/${spIndex!.total_pages} pages ` +
            `(${spRanges.map((r) => `${r.start}-${r.end}`).join(",")}) ` +
            `[specs ${spIndex!.specs.length} + brakes ${spIndex!.brakes?.length ?? 0} ranges]`,
        );
      }

      let body: any;
      try {
        const res = await fetch(`${REDUCTO_BASE}/extract`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          // instructions.schema — NOT a top-level `schema`, which is silently
          // ignored and yields generic auto-extraction. See the interval call.
          body: JSON.stringify({
            input: context.manual.url,
            instructions: {
              schema: REDUCTO_SPECS_SCHEMA,
              prompt: buildReductoSpecsInstructions(context),
            },
            settings: {
              citations: { enabled: true },
              ...(spPageRange ? { page_range: spPageRange } : {}),
            },
          }),
          signal: AbortSignal.timeout(REDUCTO_TIMEOUT_MS),
        });
        if (!res.ok) {
          const detail = (await res.text().catch(() => "")).slice(0, 300);
          return none("failed", `reducto_${res.status}:${detail}`);
        }
        body = await res.json();
      } catch (e) {
        return none("failed", `reducto_error:${String(e).slice(0, 200)}`);
      }

      const payload = extractReductoResult(body);
      if (!payload) return none("failed", "no_reducto_result");

      const parsed = parseSpecPayload(payload, context.engine);
      if (parsed.rejected) {
        console.warn(`[manual-reducto/specs] ${label}: ${parsed.rejected}`);
        return none("skipped", parsed.rejected);
      }
      if (parsed.specs.length === 0) {
        console.log(
          `[manual-reducto/specs] ${label}: no storable specs (dropped ${parsed.dropped.length})`,
        );
        return none("skipped", "no_specs_extracted");
      }

      const family = familyForManual(context.manual.source_url, context.make);
      const observedAt = Date.now();
      const claims = parsed.specs.map((s) => ({
        field_key: s.field_key,
        value: s.value,
        value_raw: s.value_raw,
        source_family: family,
        source_domain: context.manual!.source_domain,
        source_url: context.manual!.source_url,
        method: "llm_extraction",
        // Distinct from the Anthropic adapter id: same document, different
        // instrument, and the ledger records which one spoke.
        adapter: SPECS_ADAPTER_REDUCTO,
        observed_label: s.page_number
          ? `p.${s.page_number}: ${s.quoted_text}`.slice(0, 600)
          : s.quoted_text,
        observed_at: observedAt,
      }));

      const result = await ctx.runMutation(claimApi()._writeClaims, {
        vehicleConfigId: args.vehicleConfigId,
        runId: args.runId,
        claims,
      });

      console.log(
        `[manual-reducto/specs] ${label}: filed ${result.written} claim(s) as ${family} ` +
          `(${parsed.specs.map((s) => s.field_key).join(", ")})` +
          (parsed.dropped.length > 0
            ? ` — dropped ${parsed.dropped.map((d) => `${d.field_key}:${d.reason}`).join(", ")}`
            : ""),
      );

      return {
        status: "ok",
        claims: result.written,
        dropped: parsed.dropped.length,
        reason: EXTRACTOR_REDUCTO,
      };
    } catch (e) {
      console.warn("[manual-reducto/specs] extractSpecsViaReducto failed:", e);
      return none("failed", `unexpected:${String(e).slice(0, 200)}`);
    }
  },
});
