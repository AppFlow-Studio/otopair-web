"use node";
/**
 * vehicleEnrichment/manualPageIndex_node.ts — build the page index for a manual.
 *
 * Node-only because it reads PDF text with `unpdf` (a serverless-oriented
 * pdfjs build, no native dependencies). Split from manualPageIndex.ts so the
 * scoring stays pure and unit-testable, and so nothing that merely wants to
 * READ an index has to pull a PDF parser into its bundle.
 *
 * COST SHAPE. This is the cheap half of the pipeline and it is why the
 * expensive half can be narrowed: the bytes are already in Convex storage (we
 * paid to fetch them once), the scan is local, and it took ~1.5 s for a
 * 393-page manual in testing. One local second replaces roughly $16 of
 * per-page extraction billing.
 */
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  BRAKE_PICK_OPTIONS,
  detectScheduleDeferral,
  PAGE_INDEX_VERSION,
  pageCountOf,
  pickPageRanges,
  scoreManualPages,
  type ManualPageIndex,
} from "./manualPageIndex";

const idxApi = () => (internal as any).vehicleEnrichment.manualPageIndex;
const libApi = () => (internal as any).vehicleEnrichment.manualLibrary;

/** Guard: a manual far larger than any real owner's manual is not worth
 *  parsing in an action, and pdfjs would hold it all in memory. */
const MAX_INDEX_BYTES = 60 * 1024 * 1024;

export const indexManualPages = internalAction({
  args: {
    make: v.string(),
    model: v.string(),
    year: v.float64(),
    /** Recompute even when a fresh index already exists. */
    force: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    status: "ok" | "skipped" | "failed";
    reason: string;
    total_pages?: number;
    selected_pages?: number;
    intervals?: number;
    specs?: number;
    brakes?: number;
    defers_to?: string[];
  }> => {
    const label = `${args.year} ${args.make} ${args.model}`;
    try {
      const row: any = await ctx.runQuery(libApi().getManualRow, {
        make: args.make,
        model: args.model,
        year: args.year,
      });
      if (!row) return { status: "skipped", reason: "no_manual_row" };
      if (!args.force && row.page_index?.version === PAGE_INDEX_VERSION) {
        return { status: "skipped", reason: "index_fresh" };
      }
      if (!row.storage_id) return { status: "skipped", reason: "no_stored_bytes" };

      const blob = await ctx.storage.get(row.storage_id);
      if (!blob) return { status: "skipped", reason: "storage_object_missing" };
      const buf = new Uint8Array(await blob.arrayBuffer());
      if (buf.byteLength > MAX_INDEX_BYTES) {
        return { status: "skipped", reason: `too_large_${buf.byteLength}` };
      }

      const { extractText, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(buf);
      const { totalPages, text } = await extractText(pdf, { mergePages: false });

      const scores = scoreManualPages(text as string[]);
      const intervals = pickPageRanges(scores, "interval");
      const specs = pickPageRanges(scores, "spec");
      // Rotor discard minimums. Scored and stored separately from `specs` —
      // see BRAKE SIGNALS in manualPageIndex.ts — and unioned with them only
      // at extraction time, so a manual that carries brake limits but no
      // capacities table still gets its brake pages sent.
      const brakes = pickPageRanges(scores, "brakes", BRAKE_PICK_OPTIONS);
      // Free — the page text is already in hand. A manual that names another
      // document is the difference between "extraction failed" and "the answer
      // is in a booklet we have not fetched".
      const defersTo = detectScheduleDeferral(text as string[]);
      if (defersTo.length > 0) {
        console.log(
          `[page-index] ${label}: DEFERS to ${defersTo
            .map((d) => `"${d.title}"${d.region ? ` (${d.region})` : ""} p${d.pages[0]}`)
            .join(", ")}`,
        );
      }

      // Nothing found is a REAL answer, and it must not be stored as if it were
      // a narrowing — a caller that read `{intervals: [], specs: []}` as "send
      // these zero pages" would extract nothing from a document we already paid
      // to fetch. Report it and leave the row unindexed so the caller falls
      // back to whole-document behaviour (and its page budget).
      if (
        intervals.length === 0 &&
        specs.length === 0 &&
        brakes.length === 0 &&
        defersTo.length === 0
      ) {
        console.warn(
          `[page-index] ${label}: no maintenance, specification or brake pages scored above ` +
            `threshold across ${totalPages} pages — leaving unindexed`,
        );
        return { status: "skipped", reason: "no_pages_matched", total_pages: totalPages };
      }

      const index: ManualPageIndex = {
        version: PAGE_INDEX_VERSION,
        total_pages: totalPages,
        intervals,
        specs,
        brakes,
        computed_at: Date.now(),
        ...(defersTo.length > 0 ? { defers_to: defersTo } : {}),
      };
      await ctx.runMutation(idxApi()._storePageIndex, {
        make: args.make,
        model: args.model,
        year: args.year,
        page_index: index,
      });

      const selected = pageCountOf([...intervals, ...specs, ...brakes]);
      console.log(
        `[page-index] ${label}: ${selected}/${totalPages} pages ` +
          `(${((100 * selected) / Math.max(totalPages, 1)).toFixed(1)}%) — ` +
          `intervals ${intervals.map((r) => `${r.start}-${r.end}`).join(",") || "none"} | ` +
          `specs ${specs.map((r) => `${r.start}-${r.end}`).join(",") || "none"} | ` +
          `brakes ${brakes.map((r) => `${r.start}-${r.end}`).join(",") || "none"}`,
      );
      return {
        status: "ok",
        reason: "indexed",
        total_pages: totalPages,
        selected_pages: selected,
        intervals: intervals.length,
        specs: specs.length,
        brakes: brakes.length,
        defers_to: defersTo.map((d) => d.title),
      };
    } catch (e) {
      // Fail open: an unindexed manual still works, it just costs full price.
      console.error(`[page-index] ${label} failed:`, e);
      return { status: "failed", reason: `index_error:${String(e).slice(0, 200)}` };
    }
  },
});
