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
 * fork: the interval keys, the parser, the dedupe, and above all the write
 * precedence come from manualLibrary and are imported, not reimplemented. A
 * Reducto-sourced interval passes through the same `_writeManualIntervals`
 * mutation and therefore obeys the same rules — never downgrade a
 * `deterministic`/`oem_manual` row, never touch a mechanic-verified one.
 *
 * PIPELINE LAW
 * ------------
 * FAIL OPEN: every path returns a diagnostic and never throws.
 * PRESENT-BUT-WRONG IS FORBIDDEN: the same identity guard the Anthropic passes
 * use applies here — the extractor must affirmatively confirm the document is
 * this vehicle, or nothing is written.
 *
 * Wire-in points:
 *   - internal.vehicleEnrichment.manualReducto.extractIntervalsViaReducto
 *     (called by manualLibrary.extractIntervalsFromManual when the row is
 *      routed to this extractor — callers should not choose it directly)
 */

import { v } from "convex/values";
import { internalAction, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  dedupeIntervalsByService,
  EXTRACTOR_REDUCTO,
  MANUAL_INTERVAL_ORDER,
  normalizeMakeKey,
  parseManualIntervals,
} from "./manualLibrary";

const selfApi = () => (internal as any).vehicleEnrichment.manualReducto;
const libApi = () => (internal as any).vehicleEnrichment.manualLibrary;

const REDUCTO_BASE = "https://platform.reducto.ai";
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
        "True ONLY if this document covers the exact year, make and model asked about. If it covers a different model or model year, false.",
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
    "First confirm the document covers that exact vehicle and model year by reading its cover or title page; if it covers something else, set document_matches_vehicle false and return no services.",
    "Then find the factory MAINTENANCE SCHEDULE and report each service's interval.",
    "Report only intervals printed in this document — never infer, average, or fill from general knowledge.",
    "interval_miles/interval_months are the NORMAL schedule; severe_* is the severe-conditions schedule if one is published.",
    "If the schedule is a repeating table (5,000 / 10,000 / 15,000 miles), report the RECURRENCE — the smallest repeating step for that item — not the first column.",
    "If the vehicle uses a condition-based reminder system (Honda Maintenance Minder, GM Oil Life) with no fixed mileage, omit the mileage and say so in notes.",
    "Every reported interval needs a verbatim quoted_text from the document.",
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
    if (!manual?.storage_id) return null;

    return {
      year: cfg.year as number,
      make: make as string,
      model: model as string,
      source_url: manual.source_url,
      doc_kind: manual.doc_kind,
      file_bytes: manual.file_bytes ?? null,
      // A signed, unguessable URL Reducto can fetch. Generated per call rather
      // than stored, so nothing long-lived points at the bytes.
      url: await ctx.storage.getUrl(manual.storage_id),
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
    const none = (status: "skipped" | "failed", reason: string) => ({
      status,
      written: 0,
      skipped: 0,
      reason,
    });

    try {
      const apiKey = process.env.REDUCTO_API_KEY;
      if (!apiKey) return none("failed", "no_reducto_api_key");

      const context = await ctx.runQuery(selfApi().getReductoContext, {
        vehicleConfigId: args.vehicleConfigId,
      });
      if (!context) return none("skipped", "no_stored_manual");
      if (!context.url) return none("failed", "storage_url_unavailable");

      const label = `${context.year} ${context.make} ${context.model}`;

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
            settings: { citations: { enabled: true } },
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
