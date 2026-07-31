/**
 * export.ts — CSV builders for the payments page.
 *
 * The transactions export deliberately does NOT serialize what's on screen.
 * The table holds one page (50 rows); exporting that would hand someone a file
 * that looks like their filtered set and silently isn't. `fetchAllTransactions`
 * pages the same Convex query to the end, and every export carries a header
 * block naming the window and filters it was taken under — a CSV that outlives
 * the screen it came from needs to say what it is.
 */

import type { ConvexReactClient } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  MAX_EXPORT_ROWS,
  type DateWindow,
  type PayoutsOverview,
  type PaymentFilters,
  type ShopPaymentInsights,
  type ShopTxnListItem,
  type ShopTxnListResult,
} from "./types";

/* ------------------------------------------------------------------ */
/*  CSV plumbing                                                       */
/* ------------------------------------------------------------------ */

/** Quotes every field. Also guards CSV injection: a leading =, +, - or @ makes
 *  Excel treat the cell as a formula, and these files carry customer-supplied
 *  names and notes. */
function cell(v: unknown): string {
  const s = v == null ? "" : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

function row(values: unknown[]): string {
  return values.map(cell).join(",");
}

/** CENTS → a bare decimal a spreadsheet will treat as a number. */
function amount(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "";
  return (cents / 100).toFixed(2);
}

/** DOLLARS → the same. Named apart from `amount` so the unit is never guessed. */
function amountFromDollars(dollars: number | null | undefined): string {
  if (dollars == null || !Number.isFinite(dollars)) return "";
  return dollars.toFixed(2);
}

function isoDate(ms: number | null | undefined): string {
  if (!ms) return "";
  return new Date(ms).toISOString();
}

function header(
  title: string,
  shopName: string,
  window: DateWindow,
  extra: string[][] = [],
): string[] {
  return [
    row([title]),
    row(["Shop", shopName]),
    row(["Range", isoDate(window.startMs), isoDate(window.endMs)]),
    row(["Generated", new Date().toISOString()]),
    ...extra.map((e) => row(e)),
    "",
  ];
}

export function downloadCsv(filename: string, lines: string[]): void {
  // BOM so Excel opens UTF-8 names (accents, ñ) correctly instead of mojibake.
  const blob = new Blob(["﻿" + lines.join("\r\n")], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function csvFilename(prefix: string, window: DateWindow): string {
  const d = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return `otopair-${prefix}-${d(window.startMs)}-to-${d(window.endMs)}.csv`;
}

/* ------------------------------------------------------------------ */
/*  Fetch the whole filtered set                                       */
/* ------------------------------------------------------------------ */

export type ExportFetchResult = {
  rows: ShopTxnListItem[];
  /** True when we stopped at MAX_EXPORT_ROWS, or the server capped its own
   *  scan. Either way the file is not the complete set and must say so. */
  truncated: boolean;
  undatedExcluded: number;
};

/**
 * Pages listTransactions to completion.
 *
 * Search and mechanic filters take the server's bounded-scan path, which
 * returns everything it found in one response with isDone true — so the loop
 * ends after a single call for those, and `truncated` carries the server's own
 * verdict rather than being recomputed here.
 */
export async function fetchAllTransactions(
  convex: ConvexReactClient,
  window: DateWindow,
  filters: PaymentFilters,
  onProgress?: (count: number) => void,
): Promise<ExportFetchResult> {
  const rows: ShopTxnListItem[] = [];
  let cursor: string | null = null;
  let truncated = false;
  let undatedExcluded = 0;
  // Hard stop: pages are capped at 50 server-side, so this bounds the loop
  // even if a cursor ever failed to advance.
  const maxPages = Math.ceil(MAX_EXPORT_ROWS / 50) + 2;

  for (let page = 0; page < maxPages; page += 1) {
    // Annotated: without it TS can't resolve the query's return type through
    // the api barrel while `cursor` is assigned from it, and infers `any`.
    const res: ShopTxnListResult = await convex.query(
      api.shopPayments.listTransactions,
      {
        paginationOpts: { numItems: 50, cursor },
        status: filters.status,
        startMs: window.startMs,
        endMs: window.endMs,
        ...(filters.mechanicId !== "all"
          ? { mechanicId: filters.mechanicId as Id<"mechanics"> }
          : {}),
        ...(filters.search.trim() ? { search: filters.search.trim() } : {}),
      },
    );

    rows.push(...res.page);
    undatedExcluded = res.undatedExcluded;
    if (res.truncated) truncated = true;
    onProgress?.(rows.length);

    if (res.isDone || !res.continueCursor) break;
    if (rows.length >= MAX_EXPORT_ROWS) {
      truncated = true;
      break;
    }
    cursor = res.continueCursor;
  }

  return { rows: rows.slice(0, MAX_EXPORT_ROWS), truncated, undatedExcluded };
}

/* ------------------------------------------------------------------ */
/*  Builders                                                           */
/* ------------------------------------------------------------------ */

export function buildTransactionsCsv(
  result: ExportFetchResult,
  shopName: string,
  window: DateWindow,
  filters: PaymentFilters,
): string[] {
  const notes: string[][] = [];
  if (filters.status !== "all") notes.push(["Status filter", filters.status]);
  if (filters.mechanicId !== "all") notes.push(["Mechanic filter", "applied"]);
  if (filters.search.trim()) notes.push(["Search", filters.search.trim()]);
  if (result.undatedExcluded > 0) {
    notes.push([
      "Excluded",
      `${result.undatedExcluded} payments with no recorded date fall outside any date range`,
    ]);
  }
  if (result.truncated) {
    notes.push([
      "INCOMPLETE",
      `Capped at ${result.rows.length} rows. Narrow the range to export the rest.`,
    ]);
  }

  const lines = header("Otopair payments", shopName, window, notes);

  lines.push(
    row([
      "Date",
      "Invoice",
      "Customer",
      "Service",
      "Vehicle",
      "Mechanic",
      "Status",
      "Method",
      "Card",
      "Captured (USD)",
      "Otopair fee (USD)",
      "Refunded (USD)",
      "Net to shop (USD)",
      "Fee basis",
      "Booking ID",
      "Payment ID",
    ]),
  );

  for (const r of result.rows) {
    lines.push(
      row([
        isoDate(r.createdAtMs),
        r.invoiceNumber,
        r.customerName,
        r.serviceSummary,
        r.vehicleYmm,
        r.mechanicName,
        r.displayStatus,
        r.method,
        r.cardBrand && r.cardLast4 ? `${r.cardBrand} ····${r.cardLast4}` : "",
        amount(r.capturedCents),
        amount(r.platformFeeCents),
        amount(r.refundedCents),
        amount(r.netToShopCents),
        // Carried so a blank net is explainable rather than looking like a bug.
        r.feeBasis,
        String(r.bookingId),
        String(r.id),
      ]),
    );
  }

  const capturedTotal = result.rows.reduce((s, r) => s + (r.capturedCents ?? 0), 0);
  const feeTotal = result.rows.reduce((s, r) => s + (r.platformFeeCents ?? 0), 0);
  const refundTotal = result.rows.reduce((s, r) => s + r.refundedCents, 0);
  const netTotal = result.rows.reduce((s, r) => s + (r.netToShopCents ?? 0), 0);

  lines.push("");
  lines.push(
    row([
      `Totals (${result.rows.length} payments)`,
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      amount(capturedTotal),
      amount(feeTotal),
      amount(refundTotal),
      amount(netTotal),
    ]),
  );

  return lines;
}

export function buildInsightsCsv(
  insights: ShopPaymentInsights,
  shopName: string,
  window: DateWindow,
): string[] {
  const notes: string[][] = [];
  if (insights.coverage.uncapturedRowsSkipped > 0) {
    notes.push([
      "Excluded",
      `${insights.coverage.uncapturedRowsSkipped} authorized-but-uncaptured payments — no money taken yet`,
    ]);
  }
  if (insights.coverage.truncated) {
    notes.push([
      "INCOMPLETE",
      `Scan capped at ${insights.coverage.scanned} payments. Narrow the range.`,
    ]);
  }

  const lines = header("Otopair revenue summary", shopName, window, notes);

  lines.push(row(["Totals"]));
  lines.push(row(["Metric", "Value (USD)"]));
  lines.push(row(["Captured", amount(insights.totals.capturedCents)]));
  lines.push(row(["Refunded", amount(insights.totals.refundedCents)]));
  lines.push(row(["Net of refunds", amount(insights.totals.netCapturedCents)]));
  lines.push(row(["Otopair fees", amount(insights.totals.platformFeeCents)]));
  lines.push(row(["Net to shop", amount(insights.totals.netToShopCents)]));
  lines.push(row(["Payments", insights.totals.txnCount]));
  lines.push(row(["Average ticket", amount(insights.totals.avgTicketCents)]));

  lines.push("");
  lines.push(row(["Payment methods"]));
  lines.push(row(["Method", "Payments", "Captured (USD)", "Share %"]));
  for (const m of insights.methodMix) {
    lines.push(
      row([m.label, m.count, amount(m.capturedCents), (m.sharePctBps / 100).toFixed(1)]),
    );
  }

  lines.push("");
  lines.push(row(["Revenue by service"]));
  lines.push(row(["Service", "Jobs", "Captured (USD)", "Allocation"]));
  for (const s of insights.revenueByService) {
    // "even_split" is load-bearing: multi-service jobs have no per-service
    // price in the data, so the number is an allocation, not a measurement.
    lines.push(row([s.name, s.jobCount, amount(s.capturedCents), s.allocation]));
  }

  lines.push("");
  lines.push(row(["Revenue by mechanic"]));
  lines.push(row(["Mechanic", "Jobs", "Captured (USD)", "Avg ticket (USD)"]));
  for (const m of insights.revenueByMechanic) {
    lines.push(
      row([m.name, m.jobCount, amount(m.capturedCents), amount(m.avgTicketCents)]),
    );
  }

  lines.push("");
  lines.push(row(["New vs returning customers"]));
  lines.push(row(["Cohort", "Payments", "Captured (USD)"]));
  lines.push(
    row([
      "New",
      insights.customerSplit.newCount,
      amount(insights.customerSplit.newCapturedCents),
    ]),
  );
  lines.push(
    row([
      "Returning",
      insights.customerSplit.returningCount,
      amount(insights.customerSplit.returningCapturedCents),
    ]),
  );
  if (insights.customerSplit.unknownCount > 0) {
    lines.push(row(["Unclassified", insights.customerSplit.unknownCount, ""]));
  }

  lines.push("");
  lines.push(row(["Daily"]));
  lines.push(row(["Date", "Payments", "Captured (USD)", "Refunded (USD)"]));
  for (const d of insights.dailySeries) {
    lines.push(
      row([d.date, d.txnCount, amount(d.capturedCents), amount(d.refundedCents)]),
    );
  }

  return lines;
}

export function buildPayoutsCsv(
  overview: PayoutsOverview,
  shopName: string,
  window: DateWindow,
): string[] {
  const lines = header("Otopair payouts", shopName, window, [
    [
      "Note",
      "Payouts come from Stripe and are not limited to the selected range.",
    ],
  ]);

  lines.push(
    row([
      "Arrival date",
      "Created",
      "Amount (USD)",
      "Status",
      "Method",
      "Type",
      "Failure",
      "Payout ID",
    ]),
  );

  for (const p of overview.payouts) {
    lines.push(
      row([
        isoDate(p.arrivalDate * 1000),
        isoDate(p.created * 1000),
        // The Stripe route already divided by 100 — these are DOLLARS.
        amountFromDollars(p.amount),
        p.status,
        p.method,
        p.type,
        p.failureMessage,
        p.id,
      ]),
    );
  }

  lines.push("");
  lines.push(row(["Available balance (USD)", amountFromDollars(overview.balance.available)]));
  lines.push(row(["Pending balance (USD)", amountFromDollars(overview.balance.pending)]));

  return lines;
}
