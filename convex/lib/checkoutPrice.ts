// ============================================================================
// checkoutPrice.ts — "is this still the price the customer agreed to?" (#390)
//
// createBatch prices every booking from LIVE rows at commit: computeDisclosedRange
// reads shop_service_fixed_prices inside the create transaction. The phone
// rebuilds its createBatch payload from live subscriptions at tap time, and a
// shop set price never reaches that payload at all (the engine hands the phone
// $0 labor for a shop-priced line). So a price the shop edited while the
// customer sat on Review & Pay committed silently: Tire Rotation shown at $85,
// booked at $150 (bug #390).
//
// New app builds send `expected_price` — a snapshot of what Review & Pay
// rendered at the moment the customer tapped Authorize — and createBatchImpl
// compares it, in the same transaction as the insert, against what it is about
// to commit. The shop's price edit and this read touch the same
// shop_service_fixed_prices row, so a save that lands mid-create forces a
// retry that sees the new price and rejects.
//
// What is compared, and what deliberately is not:
//   - Shop-priced lines: exact cents. Review & Pay renders the same
//     shop_service_fixed_prices row (shopServiceFixedPrices.getPricingForBooking)
//     the server reads, so any difference is a real edit.
//   - A line that switched basis (the set price was removed, or one was added):
//     always a change — the customer saw a different kind of price.
//   - Estimate lines: labor only, within max(8%, $1) — the same ±8% band
//     assertLaborCostMatchesDuration uses. Compared against both the engine's
//     per-line labor at commit (what a fresh Review & Pay would show) and the
//     labor this booking will actually bill for the line.
//   - NOT estimate parts and NOT totals. Review & Pay's parts/total math
//     (getEffectiveParts + deriveDisclosedRange) and the commit math
//     (resolvePartsBandForService, computeQuotedSetPrice over the server's
//     parts snapshot) differ by design, so a hard compare would reject
//     ordinary bookings. Totals only feed the error payload.
//
// Absent `expected_price` (every build in the field today) there is no hard
// check — those bookings commit exactly as before.
//
// The same bug class lives in estimate approvals: the customer approved
// whichever open estimate was newest, so a withdraw-and-resubmit between view
// and tap approved a price they never saw. `approvalDecisionConflict` below is
// the matching guard for applyApprovalDecision / _recordApprovalApproved.
//
// No Convex runtime imports (only `v` and the error contract), so the app can
// reuse `diffCheckoutPrice` for an advisory pre-check. The mutation stays the
// authority.
// ============================================================================
import { v, type ConvexError, type Value } from "convex/values";
import { formatServiceDisplayName } from "../../utils/serviceDisplayName";
import { bookingError, type BookingErrorData } from "./bookingErrors";
import { formatCentsForMessage } from "./money";

// ----------------------------------------------------------------------------
// Wire shape
// ----------------------------------------------------------------------------

/**
 * `createBatch({ expected_price })` — what the customer saw, per line, at the
 * moment they tapped Authorize. Never recompute it at submit time: a snapshot
 * rebuilt from live data equals the new price and defeats the check.
 *
 *   - `basis: "shop_price"` — the shop's set price or range for that line,
 *     pre-tax cents, exactly as getPricingForBooking returned them.
 *   - `basis: "estimate"` — the line's displayed range; `labor_cents` is the
 *     per-line labor shown (the same figure the payload sends as that line's
 *     `labor_cost`, in cents). Without `labor_cents` the line is not checked.
 *   - `total_*` — the all-in range the confirm sheet showed. Informational.
 */
export const expectedCheckoutPriceValidator = v.object({
  version: v.literal(1),
  lines: v.array(
    v.object({
      service_id: v.id("services"),
      basis: v.union(v.literal("shop_price"), v.literal("estimate")),
      low_cents: v.number(),
      high_cents: v.number(),
      labor_cents: v.optional(v.number()),
    }),
  ),
  total_low_cents: v.number(),
  total_high_cents: v.number(),
});

export type CheckoutPriceBasis = "shop_price" | "estimate";

export type ExpectedCheckoutLine = {
  service_id: string;
  basis: CheckoutPriceBasis;
  low_cents: number;
  high_cents: number;
  labor_cents?: number;
};

export type ExpectedCheckoutPrice = {
  version: 1;
  lines: ExpectedCheckoutLine[];
  total_low_cents: number;
  total_high_cents: number;
};

/** What the create is about to commit for one booked service. */
export type ServerCheckoutLine = {
  serviceId: string;
  /** The shop's set price/range read at commit, or null when the line prices
   *  as an estimate. */
  shopPrice: { lowCents: number; highCents: number } | null;
  /** Labor this booking bills for the line — the checkout's own per-line
   *  `labor_cost` (storedMoneyForCreate / the disclosed range use it). */
  billedLaborCents: number;
  /** The checkout's own per-line `parts_cost`. Only describes "after" when a
   *  set price was removed and the engine couldn't price the line. */
  billedPartsCents: number;
  /** The quote engine's per-line billed labor at commit (resolveQuoteSeries
   *  quotes[i].labor.cost — the figure Review & Pay renders). Null when the
   *  engine didn't price the line. */
  engineLaborCents: number | null;
  /** The engine's per-line range at commit, when it priced the line. */
  engineLowCents: number | null;
  engineHighCents: number | null;
};

export type CheckoutPriceSide = {
  basis: CheckoutPriceBasis;
  lowCents: number;
  highCents: number;
  laborCents?: number;
};

export type CheckoutPriceChangeReason =
  /** Shop price → a different shop price. */
  | "shop_price_changed"
  /** Shop price shown, but the shop removed it (now an estimate). */
  | "shop_price_removed"
  /** Estimate shown, but the shop now has a set price for it. */
  | "now_shop_priced"
  /** Estimate shown; its labor moved beyond max(8%, $1). */
  | "labor_changed";

export type CheckoutPriceChange = {
  serviceId: string;
  reason: CheckoutPriceChangeReason;
  before: CheckoutPriceSide;
  after: CheckoutPriceSide;
};

// ----------------------------------------------------------------------------
// Pure comparison
// ----------------------------------------------------------------------------

const toCents = (dollars: number | null | undefined): number =>
  typeof dollars === "number" && Number.isFinite(dollars)
    ? Math.round(dollars * 100)
    : 0;

/** Labor may drift this far from what was shown before it counts as a change:
 *  the ±8% band assertLaborCostMatchesDuration already tolerates, with a $1
 *  floor so rounding on a small line never trips it. */
export function laborToleranceCents(shownCents: number): number {
  return Math.max(Math.round(Math.abs(shownCents) * 0.08), 100);
}

type EngineLineQuote =
  | {
      ok: boolean;
      low?: number;
      high?: number;
      labor?: { cost?: number };
    }
  | null
  | undefined;

/**
 * Project the create's commit-time numbers into one line per booked service.
 * `engineQuotes` is resolveQuoteSeries(...).quotes in `services` order (null
 * when the vehicle has no config, so the engine never ran).
 */
export function buildServerCheckoutLines(args: {
  services: ReadonlyArray<{ service_id: string; labor_cost: number; parts_cost: number }>;
  fixedPriceLines: ReadonlyArray<{
    service_id: string;
    price_low_cents: number;
    price_high_cents: number;
  }>;
  engineQuotes: ReadonlyArray<EngineLineQuote> | null;
}): ServerCheckoutLine[] {
  const fixedById = new Map<string, { lowCents: number; highCents: number }>();
  for (const line of args.fixedPriceLines) {
    const id = String(line.service_id);
    if (!fixedById.has(id)) {
      fixedById.set(id, { lowCents: line.price_low_cents, highCents: line.price_high_cents });
    }
  }
  return args.services.map((svc, i) => {
    const q = args.engineQuotes?.[i];
    const priced = !!q && q.ok === true;
    return {
      serviceId: String(svc.service_id),
      shopPrice: fixedById.get(String(svc.service_id)) ?? null,
      billedLaborCents: toCents(svc.labor_cost),
      billedPartsCents: toCents(svc.parts_cost),
      engineLaborCents: priced ? toCents(q!.labor?.cost) : null,
      engineLowCents: priced && typeof q!.low === "number" ? toCents(q!.low) : null,
      engineHighCents: priced && typeof q!.high === "number" ? toCents(q!.high) : null,
    };
  });
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** The line's price as an estimate when the set price is gone: the engine's
 *  range when it priced the line, else what this checkout is billing. */
function estimateSideFor(line: ServerCheckoutLine): CheckoutPriceSide {
  const labor = line.engineLaborCents ?? line.billedLaborCents;
  if (line.engineLowCents != null && line.engineHighCents != null) {
    return {
      basis: "estimate",
      lowCents: line.engineLowCents,
      highCents: line.engineHighCents,
      laborCents: labor,
    };
  }
  const point = line.billedLaborCents + line.billedPartsCents;
  return { basis: "estimate", lowCents: point, highCents: point, laborCents: labor };
}

/**
 * Lines whose price moved since the customer saw it. Empty = commit as shown.
 * Expected lines for services the booking doesn't carry, and booked services
 * with no expected line, are skipped (nothing to compare), as is any line
 * whose shown numbers aren't finite.
 */
export function diffCheckoutPrice(
  expected: ExpectedCheckoutPrice,
  server: ReadonlyArray<ServerCheckoutLine>,
): CheckoutPriceChange[] {
  const serverById = new Map<string, ServerCheckoutLine>();
  for (const line of server) {
    if (!serverById.has(line.serviceId)) serverById.set(line.serviceId, line);
  }

  const changes: CheckoutPriceChange[] = [];
  const seen = new Set<string>();
  for (const shown of expected.lines) {
    const serviceId = String(shown.service_id);
    if (seen.has(serviceId)) continue;
    seen.add(serviceId);
    const line = serverById.get(serviceId);
    if (!line) continue;
    if (!finite(shown.low_cents) || !finite(shown.high_cents)) continue;

    const shownLabor = finite(shown.labor_cents) ? Math.round(shown.labor_cents) : undefined;
    const before: CheckoutPriceSide = {
      basis: shown.basis,
      lowCents: Math.round(shown.low_cents),
      highCents: Math.round(shown.high_cents),
      ...(shownLabor != null && shown.basis === "estimate" ? { laborCents: shownLabor } : {}),
    };

    if (shown.basis === "shop_price") {
      if (!line.shopPrice) {
        changes.push({ serviceId, reason: "shop_price_removed", before, after: estimateSideFor(line) });
      } else if (
        line.shopPrice.lowCents !== before.lowCents ||
        line.shopPrice.highCents !== before.highCents
      ) {
        changes.push({
          serviceId,
          reason: "shop_price_changed",
          before,
          after: {
            basis: "shop_price",
            lowCents: line.shopPrice.lowCents,
            highCents: line.shopPrice.highCents,
          },
        });
      }
      continue;
    }

    // Shown as an estimate.
    if (line.shopPrice) {
      changes.push({
        serviceId,
        reason: "now_shop_priced",
        before,
        after: {
          basis: "shop_price",
          lowCents: line.shopPrice.lowCents,
          highCents: line.shopPrice.highCents,
        },
      });
      continue;
    }
    if (shownLabor == null) continue;
    const tolerance = laborToleranceCents(shownLabor);
    // The engine first (the shop's current rates — what a fresh Review & Pay
    // shows), then what this booking would actually bill.
    const moved = [line.engineLaborCents, line.billedLaborCents].find(
      (cents): cents is number => cents != null && Math.abs(cents - shownLabor) > tolerance,
    );
    if (moved == null) continue;
    const delta = moved - shownLabor;
    changes.push({
      serviceId,
      reason: "labor_changed",
      before,
      after: {
        basis: "estimate",
        lowCents: Math.max(0, before.lowCents + delta),
        highCents: Math.max(0, before.highCents + delta),
        laborCents: moved,
      },
    });
  }
  return changes;
}

// ----------------------------------------------------------------------------
// Copy + typed error
// ----------------------------------------------------------------------------

function formatSide(side: { lowCents: number; highCents: number }): string {
  return side.lowCents === side.highCents
    ? formatCentsForMessage(side.lowCents)
    : `${formatCentsForMessage(side.lowCents)}–${formatCentsForMessage(side.highCents)}`;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const UNNAMED_SERVICE = "This service";

/** One sentence for the person at checkout. */
export function priceChangedMessage(
  changes: ReadonlyArray<CheckoutPriceChange>,
  nameOf: (serviceId: string) => string | null | undefined,
): string {
  const name = (id: string) => nameOf(id)?.trim() || UNNAMED_SERVICE;
  if (changes.length === 0) {
    return "The price changed since you last looked. Review the new price to continue.";
  }
  if (changes.length > 1) {
    const names = Array.from(new Set(changes.map((c) => name(c.serviceId))));
    return names.length > 1
      ? `Prices changed for ${joinNames(names)}.`
      : `The price of ${names[0]} changed. Review the new price to continue.`;
  }
  const [c] = changes;
  const n = name(c.serviceId);
  switch (c.reason) {
    case "shop_price_changed":
      return `${n} is now ${formatSide(c.after)} (was ${formatSide(c.before)}).`;
    case "now_shop_priced":
      return `${n} is now ${formatSide(c.after)} (was estimated at ${formatSide(c.before)}).`;
    case "shop_price_removed":
      return `${n} no longer has a set price (it was ${formatSide(c.before)}). Review the new estimate to continue.`;
    case "labor_changed":
      return `Labor for ${n} is now ${formatCentsForMessage(c.after.laborCents ?? 0)} (was ${formatCentsForMessage(c.before.laborCents ?? 0)}).`;
  }
}

function sideValue(side: CheckoutPriceSide): Record<string, Value> {
  return {
    basis: side.basis,
    lowCents: side.lowCents,
    highCents: side.highCents,
    ...(side.laborCents != null ? { laborCents: side.laborCents } : {}),
  };
}

/**
 * PRICE_CHANGED for a checkout: `{ lines: [{ serviceId, serviceName, reason,
 * before: {basis, lowCents, highCents, laborCents?}, after: {…} }],
 * previousTotalLowCents, previousTotalHighCents, newTotalLowCents,
 * newTotalHighCents }`. "previous" totals are the ones the customer was shown;
 * "new" are the all-in range this booking would have been created with.
 */
export function checkoutPriceChangedError(args: {
  changes: ReadonlyArray<CheckoutPriceChange>;
  serviceNames: ReadonlyMap<string, string>;
  expected: ExpectedCheckoutPrice;
  newTotalLowCents: number;
  newTotalHighCents: number;
}): ConvexError<BookingErrorData> {
  const nameOf = (id: string) => args.serviceNames.get(id) || UNNAMED_SERVICE;
  return bookingError("PRICE_CHANGED", priceChangedMessage(args.changes, nameOf), {
    lines: args.changes.map((c) => ({
      serviceId: c.serviceId,
      serviceName: nameOf(c.serviceId),
      reason: c.reason,
      before: sideValue(c.before),
      after: sideValue(c.after),
    })),
    previousTotalLowCents: finite(args.expected.total_low_cents)
      ? Math.round(args.expected.total_low_cents)
      : undefined,
    previousTotalHighCents: finite(args.expected.total_high_cents)
      ? Math.round(args.expected.total_high_cents)
      : undefined,
    newTotalLowCents: args.newTotalLowCents,
    newTotalHighCents: args.newTotalHighCents,
  });
}

/**
 * The labor guard (assertLaborCostMatchesDuration) as the customer should
 * read it. It fires when the checkout's labor sits more than 8% below what the
 * shop's rates price today — a rate edit racing the checkout, or a stale
 * screen. Old builds reach it too, so the sentence stands on its own.
 */
export function laborPriceChangedError(args: {
  previousLaborCents: number;
  newLaborCents: number;
}): ConvexError<BookingErrorData> {
  return bookingError(
    "PRICE_CHANGED",
    "The shop's labor price changed while you were checking out. Review the new price and try again.",
    {
      reason: "labor_changed",
      lines: [],
      previousLaborCents: args.previousLaborCents,
      newLaborCents: args.newLaborCents,
    },
  );
}

/** Customer-facing names for the changed lines ("Timing Belt" reads as
 *  "Drive Belt" — formatServiceDisplayName). Reads only `services` rows. */
export async function loadServiceNames(
  ctx: { db: { get: (id: any) => Promise<any> } },
  serviceIds: ReadonlyArray<string>,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const id of new Set(serviceIds)) {
    const doc = await ctx.db.get(id);
    const name = formatServiceDisplayName(doc?.name ?? null);
    if (name) names.set(id, name);
  }
  return names;
}

// ----------------------------------------------------------------------------
// Estimate approvals — the same "approve what you saw" contract
// ----------------------------------------------------------------------------

type ApprovalBooking = {
  _id: unknown;
  status?: string | null;
  cancelled_by_role?: string | null;
};

type OpenApproval = {
  _id: unknown;
  cycle?: string | null;
  mechanic_set_price_cents?: number | null;
} | null;

function cancelledCopy(actor: string | null): string {
  if (actor === "shop") return "The shop cancelled this booking, so this estimate no longer applies.";
  if (actor === "customer") return "You cancelled this booking, so this estimate no longer applies.";
  return "This booking was cancelled, so this estimate no longer applies.";
}

/**
 * Commit-time check for a customer's estimate decision. Returns the typed
 * error to throw, or null to proceed. Order: the booking closed (terminal) →
 * nothing open to decide → the open estimate isn't the one the customer saw.
 *
 * `expectedApprovalId` / `expectedTotalCents` are what the approve screen
 * rendered (getOpenApprovalForBooking `_id` / `mechanic_set_price_cents`).
 * Either may be absent (older builds send neither); only what was sent is
 * compared.
 *
 * A completed booking still accepts a decision on an open POST-JOB estimate:
 * that cycle is raised after completion (finalizeAndChargeForBooking) and its
 * approval is what triggers the final capture.
 */
export function approvalDecisionConflict(args: {
  booking: ApprovalBooking;
  open: OpenApproval;
  decision: "approved" | "declined";
  expectedApprovalId?: string;
  expectedTotalCents?: number;
}): ConvexError<BookingErrorData> | null {
  const { booking, open } = args;
  const bookingId = String(booking._id);
  const status = booking.status ?? null;
  const attemptedAction = args.decision === "approved" ? "approve_estimate" : "decline_estimate";

  if (status === "cancelled" || status === "declined") {
    const actor = booking.cancelled_by_role ?? null;
    return bookingError("BOOKING_ALREADY_CANCELLED", cancelledCopy(actor), {
      bookingId,
      currentStatus: status,
      attemptedAction,
      actorRole:
        actor === "shop" || actor === "customer" || actor === "system" ? actor : null,
    });
  }
  if (status === "no_show") {
    return bookingError(
      "BOOKING_STATE_CHANGED",
      "This booking was marked as a no-show, so this estimate no longer applies.",
      { bookingId, currentStatus: status, attemptedAction },
    );
  }
  if (status === "completed" && open?.cycle !== "post_job") {
    return bookingError("BOOKING_STATE_CHANGED", "This booking is already completed.", {
      bookingId,
      currentStatus: status,
      attemptedAction,
    });
  }

  if (!open) {
    return bookingError("BOOKING_STATE_CHANGED", "This estimate was already handled.", {
      bookingId,
      currentStatus: status ?? undefined,
      attemptedAction,
    });
  }

  const idMoved =
    typeof args.expectedApprovalId === "string" &&
    args.expectedApprovalId.length > 0 &&
    args.expectedApprovalId !== String(open._id);
  const openTotal = open.mechanic_set_price_cents ?? null;
  const amountMoved =
    finite(args.expectedTotalCents) &&
    openTotal != null &&
    Math.round(args.expectedTotalCents) !== Math.round(openTotal);
  if (idMoved || amountMoved) {
    return bookingError("PRICE_CHANGED", "The shop updated this estimate — review the new total.", {
      bookingId,
      attemptedAction,
      approvalId: String(open._id),
      expectedApprovalId: args.expectedApprovalId,
      previousTotalCents: finite(args.expectedTotalCents)
        ? Math.round(args.expectedTotalCents)
        : undefined,
      newTotalCents: openTotal ?? undefined,
    });
  }
  return null;
}
