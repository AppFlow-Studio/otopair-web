/**
 * payoutsExport.test.ts — CSV export correctness.
 *
 * Two properties worth locking down:
 *   1. Formula injection. These files carry customer names and refund notes
 *      typed by strangers; a leading = + - or @ makes Excel execute the cell.
 *   2. The cents/dollars split. Convex rows are CENTS, the Stripe payout route
 *      returns DOLLARS, and both end up in exports — a swap here is a
 *      hundred-fold error in an accounting file.
 */

import { describe, expect, test } from "vitest";
import {
  buildInsightsCsv,
  buildPayoutsCsv,
  buildTransactionsCsv,
  csvFilename,
} from "../components/payouts/export";
import type {
  DateWindow,
  PaymentFilters,
  PayoutsOverview,
  ShopPaymentInsights,
  ShopTxnListItem,
} from "../components/payouts/types";

const WINDOW: DateWindow = {
  startMs: Date.UTC(2026, 6, 1),
  endMs: Date.UTC(2026, 6, 31),
  days: 30,
};

const FILTERS: PaymentFilters = {
  status: "all",
  mechanicId: "all",
  search: "",
};

function txn(over: Partial<ShopTxnListItem> = {}): ShopTxnListItem {
  return {
    id: "pay_1" as any,
    bookingId: "bk_1" as any,
    createdAtMs: Date.UTC(2026, 6, 15),
    status: "completed",
    displayStatus: "captured",
    authorizedCents: 2000,
    capturedCents: 18_000,
    estimateCents: 25_000,
    refundedCents: 0,
    platformFeeCents: 1260,
    netToShopCents: 16_740,
    feeBasis: "capture_time",
    method: "card",
    cardBrand: "Visa",
    cardLast4: "4242",
    customerId: "u_1" as any,
    customerName: "Casey Customer",
    vehicleYmm: "2019 Honda Civic",
    serviceSummary: "Brake pads",
    mechanicId: "m_1" as any,
    mechanicName: "Alice Wrench",
    invoiceNumber: "INV-2026-000123",
    hasOpenDispute: false,
    isBackfilled: false,
    ...over,
  };
}

describe("transactions CSV", () => {
  test("neutralizes a formula-injection payload in a customer name", () => {
    const lines = buildTransactionsCsv(
      {
        rows: [txn({ customerName: `=cmd|'/c calc'!A1` })],
        truncated: false,
        undatedExcluded: 0,
      },
      "Cameron Auto",
      WINDOW,
      FILTERS,
    );
    const body = lines.join("\n");
    // Prefixed with an apostrophe so Excel treats it as text, and the whole
    // field is still quoted.
    expect(body).toContain(`"'=cmd|'/c calc'!A1"`);
    expect(body).not.toContain(`"=cmd`);
  });

  test("escapes embedded quotes rather than breaking the row", () => {
    const lines = buildTransactionsCsv(
      {
        rows: [txn({ serviceSummary: 'Brake "premium" pads' })],
        truncated: false,
        undatedExcluded: 0,
      },
      "Cameron Auto",
      WINDOW,
      FILTERS,
    );
    expect(lines.join("\n")).toContain(`"Brake ""premium"" pads"`);
  });

  test("writes CENTS as decimal dollars", () => {
    const lines = buildTransactionsCsv(
      { rows: [txn()], truncated: false, undatedExcluded: 0 },
      "Cameron Auto",
      WINDOW,
      FILTERS,
    );
    const body = lines.join("\n");
    expect(body).toContain(`"180.00"`); // 18_000 cents
    expect(body).toContain(`"12.60"`); // 1_260 cents
    expect(body).toContain(`"167.40"`); // 16_740 cents
    // The pre-job estimate must not appear as money in an accounting export.
    expect(body).not.toContain(`"250.00"`);
  });

  test("an uncaptured payment exports blank, never the estimate", () => {
    const lines = buildTransactionsCsv(
      {
        rows: [txn({ capturedCents: null, netToShopCents: null })],
        truncated: false,
        undatedExcluded: 0,
      },
      "Cameron Auto",
      WINDOW,
      FILTERS,
    );
    const dataRow = lines.find((l) => l.includes("Casey Customer"))!;
    expect(dataRow).toContain(`"","12.60"`); // captured blank, fee still known
  });

  test("says so when the export was capped", () => {
    const lines = buildTransactionsCsv(
      { rows: [txn()], truncated: true, undatedExcluded: 3 },
      "Cameron Auto",
      WINDOW,
      FILTERS,
    );
    const body = lines.join("\n");
    expect(body).toContain("INCOMPLETE");
    expect(body).toContain("3 payments with no recorded date");
  });

  test("totals the rows it actually wrote", () => {
    const lines = buildTransactionsCsv(
      { rows: [txn(), txn({ capturedCents: 5_000 })], truncated: false, undatedExcluded: 0 },
      "Cameron Auto",
      WINDOW,
      FILTERS,
    );
    const totals = lines.find((l) => l.includes("Totals (2 payments)"))!;
    expect(totals).toContain(`"230.00"`); // 18_000 + 5_000
  });
});

describe("payouts CSV", () => {
  test("treats the Stripe route's DOLLARS as dollars, not cents", () => {
    const overview = {
      windowDays: 30,
      seriesTruncated: false,
      currency: "usd",
      balance: { available: 4287.5, pending: 1842 },
      payoutSchedule: null,
      externalAccount: null,
      payouts: [
        {
          id: "po_1",
          amount: 1247.3,
          currency: "usd",
          status: "paid",
          method: "standard",
          type: "bank_account",
          arrivalDate: 1785000000,
          created: 1784900000,
          description: null,
          failureMessage: null,
        },
      ],
      series: [],
    } as PayoutsOverview;

    const body = buildPayoutsCsv(overview, "Cameron Auto", WINDOW).join("\n");
    expect(body).toContain(`"1247.30"`);
    expect(body).toContain(`"4287.50"`);
    // A cents/dollars swap would render these as 124730.00 / 428750.00.
    expect(body).not.toContain(`"124730.00"`);
  });
});

describe("summary CSV", () => {
  const insights = {
    window: { startMs: WINDOW.startMs, endMs: WINDOW.endMs, days: 30 },
    totals: {
      capturedCents: 28_415_62,
      refundedCents: 0,
      netCapturedCents: 28_415_62,
      platformFeeCents: 198_909,
      netToShopCents: 26_426_53,
      txnCount: 47,
      avgTicketCents: 60_459,
    },
    methodMix: [
      { key: "card" as const, label: "Card", count: 40, capturedCents: 25_000_00, sharePctBps: 8800 },
    ],
    cardBrandMix: [],
    revenueByService: [
      {
        serviceId: null,
        name: "Brake pads",
        capturedCents: 12_000_00,
        jobCount: 10,
        allocation: "even_split" as const,
      },
    ],
    revenueByMechanic: [],
    customerSplit: {
      newCount: 12,
      returningCount: 35,
      newCapturedCents: 5_000_00,
      returningCapturedCents: 23_415_62,
      unknownCount: 0,
    },
    weeklyCustomerSplit: [],
    dailySeries: [{ date: "2026-07-15", capturedCents: 100_000, refundedCents: 0, txnCount: 3 }],
    coverage: {
      scanned: 47,
      truncated: false,
      undatedExcluded: 0,
      uncapturedRowsSkipped: 2,
    },
  } as ShopPaymentInsights;

  test("carries the even_split allocation tag so the number isn't read as measured", () => {
    const body = buildInsightsCsv(insights, "Cameron Auto", WINDOW).join("\n");
    expect(body).toContain("even_split");
  });

  test("declares the uncaptured payments it excluded", () => {
    const body = buildInsightsCsv(insights, "Cameron Auto", WINDOW).join("\n");
    expect(body).toContain("2 authorized-but-uncaptured payments");
  });
});

describe("filenames", () => {
  test("carry the window so two exports don't collide", () => {
    expect(csvFilename("payments", WINDOW)).toBe(
      "otopair-payments-2026-07-01-to-2026-07-31.csv",
    );
  });
});
