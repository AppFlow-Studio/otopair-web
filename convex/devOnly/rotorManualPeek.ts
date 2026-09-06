"use node";
/**
 * devOnly/rotorManualPeek.ts — dump the TEXT of chosen manual pages.
 *
 * Node-only (unpdf), and a Node file may export only actions — which is why
 * this is not folded into rotorManualProbe.ts, whose survey is a query.
 *
 * This is the last free check before the paid extraction: it answers "is the
 * discard minimum even printed in this document?" by reading the page, rather
 * than paying an extractor to discover that it is not. Owner's manuals often
 * do NOT carry brake service limits — that lives in the service manual — and
 * finding that out costs nothing here.
 *
 * Delete after the Aug 2026 validation.
 */
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  parseRotorThickness,
  ROTOR_THICKNESS_LABEL_PATTERNS,
} from "../vehicleEnrichment/rotorThickness";
import { scoreManualPages } from "../vehicleEnrichment/manualPageIndex";

export const peek = internalAction({
  args: {
    make: v.string(),
    model: v.string(),
    year: v.float64(),
    pages: v.array(v.float64()),
    chars: v.optional(v.float64()),
  },
  handler: async (ctx, args): Promise<any> => {
    const row: any = await ctx.runQuery(
      (internal as any).vehicleEnrichment.manualLibrary.getManualRow,
      { make: args.make, model: args.model, year: args.year },
    );
    if (!row?.storage_id) return { error: "no_stored_bytes" };
    const blob = await ctx.storage.get(row.storage_id);
    if (!blob) return { error: "storage_object_missing" };
    const buf = new Uint8Array(await blob.arrayBuffer());
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(buf);
    const { text } = await extractText(pdf, { mergePages: false });
    const cap = Math.max(200, Math.trunc(args.chars ?? 2200));
    return Object.fromEntries(
      args.pages.map((n) => [
        `p${n}`,
        String((text as string[])[n - 1] ?? "").replace(/\s+/g, " ").slice(0, cap),
      ]),
    );
  },
});

/**
 * Run the REAL rotor parser over every page and report what it finds.
 *
 * The decisive test for the whole manual→rotor tier on a given document: it
 * answers "is a discard minimum printed anywhere in here?" using the exact
 * code that would consume it, not a proxy. A document that yields nothing is
 * telling us this document class does not carry the spec — which is a finding,
 * not a failure.
 *
 * Also reports the brake SCORE per page so the scorer can be judged against
 * what the parser actually found.
 */
export const scan = internalAction({
  args: { make: v.string(), model: v.string(), year: v.float64() },
  handler: async (ctx, args): Promise<any> => {
    const row: any = await ctx.runQuery(
      (internal as any).vehicleEnrichment.manualLibrary.getManualRow,
      { make: args.make, model: args.model, year: args.year },
    );
    if (!row?.storage_id) return { error: "no_stored_bytes" };
    const blob = await ctx.storage.get(row.storage_id);
    if (!blob) return { error: "storage_object_missing" };
    const buf = new Uint8Array(await blob.arrayBuffer());
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(buf);
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    const pages = text as string[];
    const scores = scoreManualPages(pages);

    const labelRes = ROTOR_THICKNESS_LABEL_PATTERNS.map(
      (re) => new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"),
    );

    const hits: any[] = [];
    const topScored: any[] = [];
    pages.forEach((raw, i) => {
      const t = String(raw ?? "").replace(/\s+/g, " ");
      const readings = parseRotorThickness(t);
      if (readings.length > 0) {
        hits.push({
          page: i + 1,
          brakeScore: scores[i].brakes,
          readings: readings.slice(0, 6).map((r) => `${r.kind}=${r.valueMm}mm "${r.observedLabel}"`),
        });
      }
      if (scores[i].brakes > 0) {
        topScored.push({
          page: i + 1,
          brakes: scores[i].brakes,
          labelHits: labelRes.reduce((n, re) => n + (t.match(re) || []).length, 0),
          parserReadings: readings.length,
        });
      }
    });
    topScored.sort((a, b) => b.brakes - a.brakes);

    return {
      totalPages,
      pagesWithParserReadings: hits.length,
      hits: hits.slice(0, 25),
      topBrakeScored: topScored.slice(0, 12),
    };
  },
});
