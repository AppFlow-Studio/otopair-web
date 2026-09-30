/**
 * bookingMoney — THE money statement for a booking.
 *
 * Every surface that shows a price for a booking — the shop card, the Timeline,
 * the completion screen, the customer's card-hold, the receipt, the PDF — and
 * the capture itself read from `buildBookingMoney`. Before this existed each of
 * them picked its own record and did its own math: six different rules for
 * "which approval is the agreed one", three tax/fee formulas (one of them a
 * leftover plug), labor lines whose hours didn't add up to the hours billed, and
 * a capture that recomputed the price from the pre-job row and under-charged
 * every job with approved extra labor (bug #334).
 *
 * It is DERIVED ON READ from records that already exist — the agreed
 * booking_approvals row, the booking's create-time quote, an accepted
 * tire/rotor quote response, and the payments rows. Nothing new is stored, so
 * there is no second copy to drift.
 *
 * Invariants (tests/bookingMoney.test.ts), by construction:
 *   Σ part lines + Σ service lines + adjustment  = subtotal
 *   subtotal + tax + fee                          = total
 *   basis "approval"  ⇒  total = that approval's mechanic_set_price_cents
 * Rounding happens once, here, in integer cents.
 *
 * Pure: no ctx, no db. The loader (convex/bookingMoney.ts) does the reads.
 */

import { computeBookingTax } from "../../lib/tax";
import { computePlatformFeeDollars } from "../../lib/platformFee";
import { billablePart, isTireRow, partDisplayName } from "./parts";
import {
  resolveAgreedLaborLines,
  type LaborAllocation,
  type ResolvedLaborLine,
} from "./laborBreakdown";
import { serviceMatchKey } from "./serviceMatch";
import { authorizedCentsOrNull, capturedCentsOrNull } from "./money";

// ─────────────────────────────────────────────────────────────────────────────
// Which approval is the agreed one
// ─────────────────────────────────────────────────────────────────────────────

/** The only decisions that mean "the customer agreed to this price". Everything
 *  else — declined, withdrawn, sla_expired, a still-open row — is not an
 *  agreement and must never drive a price, a receipt, or a capture. */
export const AGREED_DECISIONS: ReadonlySet<string> = new Set([
  "approved",
  "auto_approved_within_range",
]);

export function isAgreedDecision(decision: string | null | undefined): boolean {
  return AGREED_DECISIONS.has(decision ?? "");
}

/**
 * Approval rows, genuinely newest-first.
 *
 * `.order("desc")` on `by_booking_and_cycle` does NOT give you this. That index
 * is ["booking_id", "cycle"], so descending sorts by the CYCLE STRING:
 *
 *     "pre_job"  >  "post_job"  >  "mid_job"
 *
 * so "the first row" was always the pre-job one, whatever had happened since.
 * That is exactly how the capture path billed a mid-job-approved job at its
 * pre-job labor (#334). Sort by when the customer actually answered;
 * `_creationTime` covers rows written before `decided_at_ms` existed.
 */
export function approvalsNewestFirst<
  T extends { decided_at_ms?: number | null; _creationTime?: number },
>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      (b.decided_at_ms ?? b._creationTime ?? 0) -
      (a.decided_at_ms ?? a._creationTime ?? 0),
  );
}

/** THE rule for the agreed approval: the newest row the customer agreed to.
 *  Never reads `booking.mechanic_set_price_cents` — that field is written when
 *  an estimate is REQUESTED and survives a decline. */
export function selectAgreedApproval<
  T extends {
    decision?: string | null;
    decided_at_ms?: number | null;
    _creationTime?: number;
  },
>(rows: T[]): T | null {
  return approvalsNewestFirst(rows).find((r) => isAgreedDecision(r.decision)) ?? null;
}

/** Newest row by SUBMIT time, whatever its decision — the row a Stripe action
 *  (increment / reauth / capture) belongs to. */
export function latestSubmittedApproval<
  T extends { submitted_at_ms?: number | null; _creationTime?: number },
>(rows: T[]): T | null {
  let best: T | null = null;
  for (const r of rows) {
    const t = r.submitted_at_ms ?? r._creationTime ?? 0;
    const bt = best ? (best.submitted_at_ms ?? best._creationTime ?? 0) : -1;
    if (best == null || t > bt) best = r;
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tax + fee — the shared helpers, in integer cents
// ─────────────────────────────────────────────────────────────────────────────

export type TaxLocation = { state: string | null; zip: string | null };

export function taxLocationForShop(shop: any): TaxLocation {
  return {
    state: (shop?.address_state ?? shop?.state ?? null) as string | null,
    zip: (shop?.address_zip ?? shop?.zip ?? null) as string | null,
  };
}

/** Sales tax in cents on a labor + parts basis (the state's rule decides which
 *  part is taxable). A flat-priced service is taxed on the PARTS basis. */
export function taxCentsFor(
  laborCents: number,
  partsCents: number,
  loc: TaxLocation,
): number {
  const res = computeBookingTax({
    laborDollars: laborCents / 100,
    partsDollars: partsCents / 100,
    state: loc.state,
    zip: loc.zip,
  });
  return Math.round((res.taxDollars ?? 0) * 100);
}

/** Otopair service fee in cents on the pre-tax subtotal (7%, $4.99 floor). */
export function feeCentsFor(subtotalCents: number): number {
  return Math.max(
    0,
    Math.round(computePlatformFeeDollars(subtotalCents / 100) * 100),
  );
}

/**
 * All-in (price + tax + fee) cents for a shop-priced amount whose labor is
 * folded into the flat line. The one forward function a shop-set band, a
 * set-price line, and its decomposition all share, so they reconcile.
 */
export function shopLineAllInCents(args: {
  partsCents: number;
  shopState: string | null;
  shopZip: string | null;
}): number {
  const loc = { state: args.shopState, zip: args.shopZip };
  return (
    args.partsCents +
    taxCentsFor(0, args.partsCents, loc) +
    feeCentsFor(args.partsCents)
  );
}

/**
 * Split an ALL-IN shop-set amount back into price + tax + fee using the same
 * forward function that built it (never a "tax = leftover" plug). Finds the
 * largest pre-tax price whose all-in fits; any 1–2¢ rounding residue stays in
 * the price, so tax and fee are always real computations.
 */
export function decomposeAllInCents(
  allInCents: number,
  loc: TaxLocation,
): { priceCents: number; taxCents: number; feeCents: number } {
  const total = Math.max(0, Math.round(allInCents));
  if (total === 0) return { priceCents: 0, taxCents: 0, feeCents: 0 };
  const allInOf = (p: number) =>
    shopLineAllInCents({ partsCents: p, shopState: loc.state, shopZip: loc.zip });
  let lo = 0;
  let hi = total;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (allInOf(mid) <= total) lo = mid;
    else hi = mid - 1;
  }
  const taxCents = lo > 0 ? taxCentsFor(0, lo, loc) : 0;
  const feeCents = lo > 0 ? feeCentsFor(lo) : 0;
  return { priceCents: total - taxCents - feeCents, taxCents, feeCents };
}

/**
 * Distribute an integer `total` across lines in proportion to `weights`,
 * largest remainder first, so the parts sum to `total` EXACTLY. Zero/invalid
 * weights everywhere → an even split.
 */
export function splitByWeights(total: number, weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const sign = total < 0 ? -1 : 1;
  const whole = Math.abs(Math.round(total));
  const w = weights.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  const sumW = w.reduce((a, b) => a + b, 0);
  const shares = sumW > 0 ? w.map((x) => x / sumW) : w.map(() => 1 / n);
  const exact = shares.map((s) => s * whole);
  const out = exact.map((e) => Math.floor(e));
  let remainder = whole - out.reduce((a, b) => a + b, 0);
  const order = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; remainder > 0 && k < order.length; k++, remainder--) {
    out[order[k].i] += 1;
  }
  return out.map((x) => x * sign);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────

export type MoneyBasis =
  /** The customer agreed to a mechanic estimate (pre-job / mid-job / post-job). */
  | "approval"
  /** No estimate yet — the create-time quote the booking was made at. */
  | "estimate"
  /** An accepted tire/rotor shop quote. */
  | "quote"
  /** Predates every structured price record. */
  | "legacy";

export type MoneyPartLine = {
  name: string;
  partNumber: string | null;
  brand: string | null;
  quantity: number;
  unitCents: number;
  lineCents: number;
  serviceId: string | null;
  customServiceName: string | null;
  isTire: boolean;
  fromQuote: boolean;
  justification: string | null;
  /** A create-time snapshot row the integrity sweep flagged (likely the wrong
   *  part for this vehicle). Still priced into the quote, so it's a line —
   *  customer-facing itemizations may hide it; the shop should see it. */
  unverified: boolean;
};

export type MoneyExcludedPart = {
  name: string;
  partNumber: string | null;
  quantity: number;
  reason: "not_used" | "customer_supplied";
};

export type MoneyServiceLine = {
  key: string;
  name: string;
  /** "labor" = billed on hours × rate; "set_price" = a shop flat price. */
  kind: "labor" | "set_price";
  /** Billed labor minutes (labor lines). Σ over lines = the billed minutes. */
  minutes: number | null;
  /** The labor rate this line was billed at, cents/hr. */
  rateCents: number | null;
  laborCents: number;
  /** Pre-tax flat price (set_price lines). */
  setPriceCents: number;
  amountCents: number;
};

export type MoneyHistoryEntry = {
  kind: "booked" | "quote" | "pre_job" | "mid_job" | "post_job";
  totalCents: number;
  atMs: number | null;
  approvalId: string | null;
};

export type MoneyPayment = {
  /** The live authorization on the card (latest payment row). */
  authorizedCents: number | null;
  /** What was actually captured, summed across every payment row. */
  capturedCents: number | null;
  capturedAtMs: number | null;
  cardBrand: string | null;
  cardLast4: string | null;
  status: string | null;
  paymentCount: number;
  settlementState: string | null;
  shortfallCents: number | null;
};

export type BookingMoney = {
  version: 1;
  basis: MoneyBasis;
  isShopSet: boolean;
  agreedApprovalId: string | null;
  agreedCycle: string | null;
  services: MoneyServiceLine[];
  parts: MoneyPartLine[];
  /** Parts whose cost is folded into a set price — installed, not billed apart. */
  setPriceParts: MoneyPartLine[];
  /** Not-used and customer-supplied rows: shown, never summed. */
  excludedParts: MoneyExcludedPart[];
  totals: {
    partsCents: number;
    laborCents: number;
    setPriceCents: number;
    /** An explicit, labelled line — only for legacy rows whose frozen totals
     *  can't be matched by their own lines. Never folded into tax. */
    adjustmentCents: number;
    subtotalCents: number;
    taxCents: number;
    feeCents: number;
    totalCents: number;
    /** Σ labor minutes over the labor lines. */
    laborMinutes: number | null;
  };
  counts: { services: number; parts: number };
  /** The disclosed price band while the booking is still an estimate. */
  range: { lowCents: number; highCents: number } | null;
  history: MoneyHistoryEntry[];
  originalQuoteCents: number | null;
  /** The last total the customer agreed to BEFORE the current one (#350). */
  previousAgreedTotalCents: number | null;
  /** What that previous total was: the booked quote or an earlier estimate. */
  previousAgreedKind: MoneyHistoryEntry["kind"] | null;
  /** What approving / confirming the current hold authorizes on the card —
   *  the same max(set, ceiling) approveAndAuthorizeHold uses. */
  holdTargetCents: number;
  payment: MoneyPayment;
  /** Diagnostics: reconciliations the builder had to make. Empty when the
   *  records agree. Logged by the loader, never shown to customers. */
  warnings: string[];
};

// ── Inputs ──────────────────────────────────────────────────────────────────

export type ApprovalLike = {
  _id?: unknown;
  _creationTime?: number;
  cycle?: string | null;
  decision?: string | null;
  decided_at_ms?: number | null;
  submitted_at_ms?: number | null;
  mechanic_set_price_cents?: number | null;
  parts_subtotal_cents?: number | null;
  labor_cents?: number | null;
  tax_cents?: number | null;
  service_fee_cents?: number | null;
  parts_snapshot?: any[] | null;
  labor_hours?: number | null;
  labor_rate_cents?: number | null;
  labor_allocations?: LaborAllocation[] | null;
};

export type CustomJobLike = {
  _id: unknown;
  name: string;
  match_key?: string | null;
  status?: string | null;
  quoted_price_cents?: number | null;
  estimated_minutes?: number | null;
  created_at?: number | null;
  introduced_by_approval_id?: unknown;
};

export type PaymentRowLike = {
  _creationTime?: number;
  created_at?: number | null;
  status?: string;
  amount?: number | null;
  hold_amount_cents?: number | null;
  incremented_total_cents?: number | null;
  captured_amount_cents?: number | null;
  captured_at_ms?: number | null;
  card_brand?: string | null;
  card_last4?: string | null;
};

export type QuotePartLineInput = {
  part_name: string;
  oem_number: string;
  cost: number;
  quantity: number;
  service_id?: any;
  is_tire?: boolean;
  from_quote: true;
  tire_size?: string | null;
  tire_brand?: string | null;
  tire_model?: string | null;
  tire_position?: string | null;
};

/** Front/rear tire counts for a quote: the customer's chosen positions when
 *  present, else an even split (front takes the odd one). */
export function tireAxleQuantities(
  positions: string[] | null | undefined,
  totalQty: number,
): { front: number; rear: number } {
  if (Array.isArray(positions) && positions.length > 0) {
    let front = 0;
    let rear = 0;
    for (const p of positions) {
      if (p === "FL" || p === "FR") front += 1;
      else if (p === "RL" || p === "RR") rear += 1;
    }
    if (front + rear > 0) return { front, rear };
  }
  const front = Math.ceil(totalQty / 2);
  return { front, rear: totalQty - front };
}

/**
 * The part lines of an accepted tire/rotor quote response. ONE builder shared by
 * the post-job prefill (job_actuals.quotePrefillLinesForService) and the money
 * statement, so the parts the mechanic confirms are the parts the customer was
 * billed. Pads bill `pad_price × (pad_quantity ?? quantity)` — what
 * acceptRotorQuote stores as parts_cost and what Review & Pay showed.
 */
export function quoteResponsePartLines(args: {
  kind: "tire" | "rotor";
  response: any;
  booking: any;
  serviceId: any;
}): QuotePartLineInput[] {
  const { kind, response: q, booking, serviceId } = args;
  if (!q) return [];
  if (kind === "tire") {
    const totalQty = q.quantity ?? booking?.tire_specs?.quantity ?? 4;
    const size = booking?.tire_specs?.size ?? null;
    const brand = q.tire_brand ?? null;
    const model = q.tire_model ?? null;
    const brandModel = [brand, model].filter(Boolean).join(" ");
    const oem = size ? `TIRE-${size}` : "";
    const { front, rear } = tireAxleQuantities(booking?.tire_specs?.positions, totalQty);
    const lines: QuotePartLineInput[] = [];
    for (const [position, axleQty] of [
      ["front", front],
      ["rear", rear],
    ] as const) {
      if (axleQty <= 0) continue;
      lines.push({
        part_name: brandModel ? `Tires — ${brandModel} (x${axleQty})` : `Tires (x${axleQty})`,
        oem_number: oem,
        cost: q.per_tire_price ?? 0,
        quantity: axleQty,
        service_id: serviceId,
        is_tire: true,
        from_quote: true,
        tire_size: size,
        tire_brand: brand,
        tire_model: model,
        tire_position: position,
      });
    }
    return lines;
  }
  const lines: QuotePartLineInput[] = [];
  const rotorQty = q.quantity ?? 2;
  const rotorBrandModel = [q.rotor_brand, q.rotor_model].filter(Boolean).join(" ");
  // Axle-neutral name so the dialog's off-axle pruning (partNameAxle) never
  // drops it — the quote gives a total count, not a per-axle split.
  lines.push({
    part_name: rotorBrandModel ? `Rotors — ${rotorBrandModel} (x${rotorQty})` : `Rotors (x${rotorQty})`,
    oem_number: "",
    cost: q.per_rotor_price ?? 0,
    quantity: rotorQty,
    service_id: serviceId,
    from_quote: true,
  });
  if (q.pad_price != null || q.pad_brand) {
    const padQty = q.pad_quantity ?? q.quantity ?? 1;
    const padName = [q.pad_brand, q.pad_type].filter(Boolean).join(" ");
    lines.push({
      part_name: padName ? `Brake Pads — ${padName} (x${padQty})` : `Brake Pads (x${padQty})`,
      oem_number: "",
      cost: q.pad_price ?? 0,
      quantity: padQty,
      service_id: serviceId,
      from_quote: true,
    });
  }
  return lines;
}

export type MoneyInputs = {
  booking: any;
  approvals: ApprovalLike[];
  customJobs: CustomJobLike[];
  payments: PaymentRowLike[];
  shop: any;
  /** booking.service_ids resolved: name + catalog default hours. */
  baseServices: Array<{ serviceId: string; name: string; catalogHours: number | null }>;
  /** Accepted tire/rotor quote, when this is a quote booking. */
  quote: {
    kind: "tire" | "rotor";
    laborCents: number;
    totalCents: number;
    durationMinutes: number | null;
    serviceName: string;
    partLines: QuotePartLineInput[];
  } | null;
  /** Rate for estimate-basis minutes (tier-aware when the loader knows it). */
  estimateRateCents?: number | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Builder
// ─────────────────────────────────────────────────────────────────────────────

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

function approvalPartLine(p: any): MoneyPartLine {
  const quantity = Math.max(0, Number(p?.quantity ?? 1) || 0);
  const unitDollars = Number(p?.cost) || 0;
  return {
    name: partDisplayName(p ?? {}),
    partNumber: (p?.oem_number ?? "").trim() || null,
    brand: p?.brand ?? null,
    quantity,
    unitCents: Math.round(unitDollars * 100),
    // The exact per-line rounding partsSubtotalCents (booking_approvals.ts)
    // bills, so the lines reproduce the frozen parts subtotal to the cent.
    lineCents: Math.round(unitDollars * quantity * 100),
    serviceId: p?.service_id != null ? String(p.service_id) : null,
    customServiceName: (p?.custom_service_name ?? "").trim() || null,
    isTire: isTireRow(p ?? {}),
    fromQuote: p?.from_quote === true,
    justification: p?.justification_text ?? null,
    unverified: false,
  };
}

function snapshotPartLine(p: any): MoneyPartLine {
  const quantity = Math.max(0, Number(p?.quantity ?? 1) || 0);
  const unitCents = Math.round(Number(p?.unit_price_cents) || 0);
  return {
    name: partDisplayName(p ?? {}),
    partNumber: (p?.oem_number ?? "").trim() || null,
    brand: p?.brand ?? null,
    quantity,
    unitCents,
    lineCents: Math.round(
      typeof p?.line_total_cents === "number" ? p.line_total_cents : unitCents * quantity,
    ),
    serviceId: p?.service_id != null ? String(p.service_id) : null,
    customServiceName: null,
    isTire: isTireRow(p ?? {}),
    fromQuote: false,
    justification: null,
    unverified: p?.integrity_flag != null,
  };
}

function excludedFrom(p: any): MoneyExcludedPart | null {
  if (p?.not_used === true) {
    return {
      name: partDisplayName(p),
      partNumber: (p?.oem_number ?? "").trim() || null,
      quantity: Math.max(0, Number(p?.quantity ?? 1) || 0),
      reason: "not_used",
    };
  }
  if (p?.supplied_by === "customer") {
    return {
      name: partDisplayName(p),
      partNumber: (p?.oem_number ?? "").trim() || null,
      quantity: Math.max(0, Number(p?.quantity ?? 1) || 0),
      reason: "customer_supplied",
    };
  }
  return null;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function paymentSummary(booking: any, rows: PaymentRowLike[]): MoneyPayment {
  const byNewest = [...rows].sort(
    (a, b) =>
      (b.created_at ?? b._creationTime ?? 0) - (a.created_at ?? a._creationTime ?? 0),
  );
  const latest = byNewest[0] ?? null;
  let captured: number | null = null;
  let capturedAtMs: number | null = null;
  let capturedRow: PaymentRowLike | null = null;
  for (const r of rows) {
    const c = capturedCentsOrNull(r as any);
    if (c == null) continue;
    captured = (captured ?? 0) + c;
    if (r.captured_at_ms != null && (capturedAtMs == null || r.captured_at_ms > capturedAtMs)) {
      capturedAtMs = r.captured_at_ms;
    }
    capturedRow = capturedRow ?? r;
  }
  const cardRow = capturedRow ?? latest;
  return {
    authorizedCents: latest ? authorizedCentsOrNull(latest as any) : null,
    capturedCents: captured,
    capturedAtMs,
    cardBrand: cardRow?.card_brand ?? null,
    cardLast4: cardRow?.card_last4 ?? null,
    status: latest?.status ?? null,
    paymentCount: rows.length,
    settlementState: booking?.settlement_state ?? null,
    shortfallCents:
      typeof booking?.settlement_shortfall_cents === "number"
        ? booking.settlement_shortfall_cents
        : null,
  };
}

/** Per-line labor for the booked services + added lines, WITHOUT the lines a
 *  flat price covers. Weights come from the shared agreed-labor reader. */
function laborLineSource(
  input: MoneyInputs,
  allocations: LaborAllocation[] | null | undefined,
  exclude: { shopPricedServiceIds: Set<string>; flatMatchKeys: Set<string> },
  /** Only lines that existed when the agreed estimate was submitted share its
   *  labor — a line drafted afterwards isn't part of what was agreed. */
  asOfMs: number | null = null,
): { labor: ResolvedLaborLine[]; setPriced: ResolvedLaborLine[] } {
  const booking = input.booking;
  const skipKeys = new Set(
    input.customJobs
      .filter(
        (c) =>
          c.status === "declined" ||
          c.status === "cancelled" ||
          (asOfMs != null && (c.created_at ?? 0) > asOfMs),
      )
      .map((c) => c.match_key ?? serviceMatchKey(String(c.name))),
  );
  const customServices = Array.isArray(booking?.custom_services)
    ? (booking.custom_services as any[])
        // Staged "Add to this job" lines aren't sent to the customer yet.
        .filter((c) => c?.pending_confirmation !== true)
        .map((c) => ({
          name: typeof c?.name === "string" ? c.name.trim() : "",
          durationMinutes:
            typeof c?.duration_minutes === "number" ? c.duration_minutes : null,
        }))
        .filter((c) => c.name && !skipKeys.has(serviceMatchKey(c.name)))
    : [];
  const { lines } = resolveAgreedLaborLines({
    baseServices: input.baseServices,
    customServices,
    customJobs: input.customJobs as any,
    allocations: allocations ?? null,
    laborSubtotalDollars: null,
  });
  const labor: ResolvedLaborLine[] = [];
  const setPriced: ResolvedLaborLine[] = [];
  for (const l of lines) {
    const flat =
      (l.lineKind === "booked" &&
        l.serviceId != null &&
        exclude.shopPricedServiceIds.has(l.serviceId)) ||
      (l.lineKind === "custom" &&
        l.matchKey != null &&
        exclude.flatMatchKeys.has(l.matchKey));
    (flat ? setPriced : labor).push(l);
  }
  return { labor, setPriced };
}

/** Labor lines whose minutes sum to the billed minutes and whose cents sum to
 *  the billed labor, each at the billed rate (#335). */
function buildLaborLines(
  source: ResolvedLaborLine[],
  laborCents: number,
  rateCents: number | null,
  fallbackMinutes: number | null,
): MoneyServiceLine[] {
  const rows =
    source.length > 0
      ? source
      : laborCents > 0
        ? [
            {
              name: "Labor",
              rawHours: null,
              lineKind: "booked",
              serviceId: null,
              customJobId: null,
              matchKey: null,
            } as unknown as ResolvedLaborLine,
          ]
        : [];
  if (rows.length === 0) return [];
  const billedMinutes =
    rateCents != null && rateCents > 0
      ? Math.round((laborCents * 60) / rateCents)
      : fallbackMinutes;
  const weights = rows.map((r) => r.rawHours ?? 0);
  const minutes = billedMinutes != null ? splitByWeights(billedMinutes, weights) : null;
  const cents = splitByWeights(laborCents, minutes ?? weights);
  return rows.map((r, i) => ({
    key:
      r.lineKind === "custom"
        ? r.customJobId
          ? `job:${r.customJobId}`
          : `custom:${r.matchKey ?? norm(r.name)}`
        : r.serviceId
          ? `svc:${r.serviceId}`
          : `labor:${i}`,
    name: r.name,
    kind: "labor" as const,
    minutes: minutes ? minutes[i] : null,
    rateCents,
    laborCents: cents[i],
    setPriceCents: 0,
    amountCents: cents[i],
  }));
}

function setPriceLines(
  lines: Array<{ key: string; name: string; weight: number }>,
  priceCents: number,
): MoneyServiceLine[] {
  const split = splitByWeights(priceCents, lines.map((l) => l.weight));
  return lines.map((l, i) => ({
    key: l.key,
    name: l.name,
    kind: "set_price" as const,
    minutes: null,
    rateCents: null,
    laborCents: 0,
    setPriceCents: split[i],
    amountCents: split[i],
  }));
}

function assemble(args: {
  base: Omit<
    BookingMoney,
    "totals" | "counts" | "version" | "warnings" | "payment" | "holdTargetCents"
  >;
  input: MoneyInputs;
  taxCents: number;
  feeCents: number;
  adjustmentCents: number;
  /** When set, the total the records say was agreed; any gap is surfaced. */
  expectedTotalCents: number | null;
  warnings: string[];
}): BookingMoney {
  const { base, input, warnings } = args;
  const partsCents = sum(base.parts.map((p) => p.lineCents));
  const laborCents = sum(
    base.services.filter((s) => s.kind === "labor").map((s) => s.laborCents),
  );
  const setPriceCents = sum(
    base.services.filter((s) => s.kind === "set_price").map((s) => s.setPriceCents),
  );
  let adjustmentCents = args.adjustmentCents;
  let subtotalCents = partsCents + laborCents + setPriceCents + adjustmentCents;
  let totalCents = subtotalCents + args.taxCents + args.feeCents;
  if (args.expectedTotalCents != null && totalCents !== args.expectedTotalCents) {
    const gap = args.expectedTotalCents - totalCents;
    warnings.push(`total_gap:${gap}`);
    adjustmentCents += gap;
    subtotalCents += gap;
    totalCents += gap;
  }
  const laborMinutesList = base.services
    .filter((s) => s.kind === "labor")
    .map((s) => s.minutes);
  const booking = input.booking;
  return {
    version: 1,
    ...base,
    totals: {
      partsCents,
      laborCents,
      setPriceCents,
      adjustmentCents,
      subtotalCents,
      taxCents: args.taxCents,
      feeCents: args.feeCents,
      totalCents,
      laborMinutes: laborMinutesList.every((m) => m != null)
        ? sum(laborMinutesList as number[])
        : null,
    },
    counts: {
      services: base.services.length,
      parts: base.parts.length + base.setPriceParts.length,
    },
    holdTargetCents: Math.max(
      booking?.mechanic_set_price_cents ?? 0,
      booking?.running_approved_ceiling_cents ?? 0,
    ),
    payment: paymentSummary(booking, input.payments),
    warnings,
  };
}

function history(input: MoneyInputs, quoteTotalCents: number | null): MoneyHistoryEntry[] {
  const booking = input.booking;
  const out: MoneyHistoryEntry[] = [];
  if (typeof booking?.quoted_set_price_cents === "number") {
    out.push({
      kind: "booked",
      totalCents: booking.quoted_set_price_cents,
      atMs: booking.created_at ?? booking._creationTime ?? null,
      approvalId: null,
    });
  } else if (quoteTotalCents != null) {
    out.push({ kind: "quote", totalCents: quoteTotalCents, atMs: null, approvalId: null });
  }
  const agreed = approvalsNewestFirst(
    input.approvals.filter((a) => isAgreedDecision(a.decision)),
  ).reverse();
  for (const a of agreed) {
    const cycle = a.cycle === "mid_job" || a.cycle === "post_job" ? a.cycle : "pre_job";
    out.push({
      kind: cycle,
      totalCents: a.mechanic_set_price_cents ?? 0,
      atMs: a.decided_at_ms ?? a._creationTime ?? null,
      approvalId: a._id != null ? String(a._id) : null,
    });
  }
  return out;
}

function historyFields(entries: MoneyHistoryEntry[], basis: MoneyBasis) {
  const first = entries[0];
  const previous =
    basis === "approval" && entries.length >= 2 ? entries[entries.length - 2] : null;
  return {
    history: entries,
    originalQuoteCents:
      first && (first.kind === "booked" || first.kind === "quote") ? first.totalCents : null,
    previousAgreedTotalCents: previous?.totalCents ?? null,
    previousAgreedKind: previous?.kind ?? null,
  };
}

/** Accepted tire/rotor quote lines, as billed part lines. */
function quotePartLines(q: NonNullable<MoneyInputs["quote"]>): MoneyPartLine[] {
  return q.partLines.map((p) => {
    const quantity = Math.max(0, Number(p.quantity) || 0);
    const unitDollars = Number(p.cost) || 0;
    return {
      name: partDisplayName(p as any),
      partNumber: (p.oem_number ?? "").trim() || null,
      brand: p.tire_brand ?? null,
      quantity,
      unitCents: Math.round(unitDollars * 100),
      lineCents: Math.round(unitDollars * quantity * 100),
      serviceId: p.service_id != null ? String(p.service_id) : null,
      customServiceName: null,
      isTire: p.is_tire === true || isTireRow(p as any),
      fromQuote: true,
      justification: null,
      unverified: false,
    };
  });
}

/**
 * Total of an accepted quote exactly the way Review & Pay computes it
 * (otopair payment.tsx `quoteBreakdown`): tax on the shop's labor + parts,
 * the service fee on labor + parts, both added to the shop's quoted total.
 */
export function quoteAllInCents(args: {
  laborCents: number;
  partsCents: number;
  quoteTotalCents: number;
  loc: TaxLocation;
}): { taxCents: number; feeCents: number; totalCents: number } {
  const taxCents = taxCentsFor(args.laborCents, args.partsCents, args.loc);
  const feeCents = feeCentsFor(args.laborCents + args.partsCents);
  return {
    taxCents,
    feeCents,
    totalCents: args.quoteTotalCents + taxCents + feeCents,
  };
}

/**
 * The labor / parts / total a NEW booking row stores (bookings.createBatchImpl).
 *
 * A shop-priced service (fixed or range) bills at the shop's price — the
 * midpoint of its band, the same number behind quoted_set_price_cents — not the
 * phone's engine estimate, which is $0 labor for a shop-priced service. Storing
 * the phone's numbers made a fixed-price Tire Rotation a $0.00 booking in the
 * shop portal while the customer saw $169.50 (#390). Dynamic services keep the
 * (server-validated) client values. Returns null when nothing is shop-priced:
 * the caller stores the client sums exactly as before.
 */
export function storedMoneyForCreate(args: {
  services: Array<{ service_id: unknown; labor_cost: number; parts_cost: number }>;
  fixedPriceLines: Array<{
    service_id: unknown;
    price_low_cents: number;
    price_high_cents: number;
  }>;
  loc: TaxLocation;
}): { laborCost: number; partsCost: number; totalCost: number } | null {
  const shopPriced = new Map<string, number>(
    args.fixedPriceLines.map((l) => [
      String(l.service_id),
      Math.round((l.price_low_cents + l.price_high_cents) / 2),
    ]),
  );
  if (shopPriced.size === 0) return null;
  let laborCents = 0;
  let partsCents = 0;
  for (const s of args.services) {
    const priceCents = shopPriced.get(String(s.service_id));
    if (priceCents != null) {
      // A flat price is taxed on the PARTS basis (priceWithFlat / shopLineAllInCents).
      partsCents += priceCents;
    } else {
      laborCents += Math.round((s.labor_cost ?? 0) * 100);
      partsCents += Math.round((s.parts_cost ?? 0) * 100);
    }
  }
  const taxCents = taxCentsFor(laborCents, partsCents, args.loc);
  const feeCents = feeCentsFor(laborCents + partsCents);
  return {
    laborCost: laborCents / 100,
    partsCost: partsCents / 100,
    totalCost: (laborCents + partsCents + taxCents + feeCents) / 100,
  };
}

/**
 * What completion should capture, when the price is agreed.
 *
 * Billing is locked at completion (the post-job parts step is read-only for
 * every non-walk-in job), so the agreed statement IS the final bill. The old
 * finalize recomputed a total from job_actuals + a mis-picked approval and
 * captured min(recomputed, agreed) — which under-charged every job with approved
 * mid-job labor (#334) and a fixed-price job with no estimate by nearly all of
 * it. Returns null when nothing is agreed yet (a range booking with no chosen
 * price, legacy rows): the caller keeps its ceiling-capped fallback for those.
 */
export function agreedCaptureFor(
  money: BookingMoney | null | undefined,
): { captureCents: number; feeCents: number; source: MoneyBasis } | null {
  if (!money || !(money.totals.totalCents > 0)) return null;
  const fullyFixed =
    money.basis === "estimate" &&
    money.isShopSet &&
    money.parts.length === 0 &&
    money.services.length > 0 &&
    money.services.every((s) => s.kind === "set_price") &&
    money.range != null &&
    money.range.lowCents === money.range.highCents;
  if (money.basis === "approval" || money.basis === "quote" || fullyFixed) {
    return {
      captureCents: money.totals.totalCents,
      feeCents: money.totals.feeCents,
      source: money.basis,
    };
  }
  return null;
}

export function buildBookingMoney(input: MoneyInputs): BookingMoney {
  const booking = input.booking ?? {};
  const loc = taxLocationForShop(input.shop);
  const warnings: string[] = [];
  const agreed = selectAgreedApproval(input.approvals);

  const fixedLines: Array<{
    service_id: unknown;
    price_low_cents: number;
    price_high_cents: number;
  }> = Array.isArray(booking.fixed_price_lines) ? booking.fixed_price_lines : [];
  const fixedIds = new Set(fixedLines.map((l) => String(l.service_id)));
  const fixedMid = new Map(
    fixedLines.map((l) => [
      String(l.service_id),
      Math.round((l.price_low_cents + l.price_high_cents) / 2),
    ]),
  );
  const range =
    typeof booking.disclosed_range_low_cents === "number" &&
    typeof booking.disclosed_range_high_cents === "number"
      ? {
          lowCents: booking.disclosed_range_low_cents,
          highCents: booking.disclosed_range_high_cents,
        }
      : null;

  // ── 1. An agreed estimate: its frozen breakdown IS the price ─────────────
  if (agreed) {
    const a = agreed;
    const hasBreakdown =
      a.parts_subtotal_cents != null &&
      a.labor_cents != null &&
      a.tax_cents != null &&
      a.service_fee_cents != null;
    const setTotal = Math.round(a.mechanic_set_price_cents ?? 0);
    const frozenSum = hasBreakdown
      ? a.parts_subtotal_cents! + a.labor_cents! + a.tax_cents! + a.service_fee_cents!
      : null;
    // performSubmission prices a non-shop-set estimate as parts + labor + tax +
    // fee EXACTLY, and a shop-set one as the ALL-IN base + that on-top stack —
    // so the gap between the total and its frozen stack is the shop-set base.
    let baseAllIn = frozenSum != null ? setTotal - frozenSum : 0;
    if (baseAllIn < 0) {
      warnings.push(`negative_base:${baseAllIn}`);
      baseAllIn = 0;
    }
    const isShopSet = baseAllIn > 0;
    // Which booked services the set price covers — only when this estimate was
    // actually priced shop-set (otherwise their parts/labor were billed on the
    // estimate itself). A booking that never stamped its fixed lines is a pure
    // shop-set booking, so all of them.
    const shopPricedIds: Set<string> =
      baseAllIn <= 0
        ? new Set<string>()
        : fixedIds.size > 0
          ? fixedIds
          : new Set<string>(
              ((booking.service_ids ?? []) as unknown[]).map((s) => String(s)),
            );

    // Added lines the shop flat-prices, as they stood when this estimate was
    // submitted (performSubmission's readFlatAddedLines, frozen by time).
    const submittedAt = a.submitted_at_ms ?? a._creationTime ?? Number.MAX_SAFE_INTEGER;
    const flatJobs = input.customJobs.filter(
      (c) =>
        typeof c.quoted_price_cents === "number" &&
        c.quoted_price_cents > 0 &&
        c.status !== "cancelled" &&
        c.status !== "declined" &&
        (c.created_at ?? 0) <= submittedAt,
    );
    const flatNames = new Set(flatJobs.map((c) => norm(c.name)));
    const flatMatchKeys = new Set(
      flatJobs.map((c) => c.match_key ?? serviceMatchKey(String(c.name))),
    );
    const flatCents = sum(flatJobs.map((c) => c.quoted_price_cents as number));

    const snapshot = Array.isArray(a.parts_snapshot) ? a.parts_snapshot : [];
    const isBasePart = (p: any) =>
      shopPricedIds.size > 0 &&
      !(p?.custom_service_name ?? "").trim() &&
      p?.service_id != null &&
      shopPricedIds.has(String(p.service_id));
    const isFlatPart = (p: any) => flatNames.has(norm(p?.custom_service_name));
    const strict = snapshot.filter((p) => billablePart(p) && !isBasePart(p) && !isFlatPart(p));
    // Pre-Sep-24 estimates billed blank-name rows; their frozen subtotal
    // includes them, so a line set that reproduces it must too.
    const loose = snapshot.filter(
      (p) =>
        p?.not_used !== true &&
        p?.supplied_by !== "customer" &&
        !isBasePart(p) &&
        !isFlatPart(p),
    );
    const lineSum = (rows: any[]) => sum(rows.map((p) => approvalPartLine(p).lineCents));
    let chosen = strict;
    let adjustment = 0;
    if (hasBreakdown) {
      const target = a.parts_subtotal_cents! - flatCents;
      if (lineSum(strict) !== target) {
        if (lineSum(loose) === target) {
          chosen = loose;
        } else {
          adjustment = target - lineSum(strict);
          warnings.push(`parts_gap:${adjustment}`);
        }
      }
    }
    const parts = chosen.map(approvalPartLine);
    const setPriceParts = snapshot
      .filter((p) => billablePart(p) && (isBasePart(p) || isFlatPart(p)))
      .map(approvalPartLine);
    const excludedParts = snapshot
      .map(excludedFrom)
      .filter((x): x is MoneyExcludedPart => x != null);

    // Labor: the approval's billed labor at its rate, split over the lines.
    const rate =
      typeof a.labor_rate_cents === "number" && a.labor_rate_cents > 0
        ? a.labor_rate_cents
        : null;
    let laborCents: number;
    if (a.labor_cents != null) {
      laborCents = a.labor_cents;
    } else if (a.labor_hours != null && rate != null) {
      laborCents = Math.round(a.labor_hours * rate);
    } else {
      laborCents = Math.round((booking.labor_cost ?? 0) * 100);
    }
    const src = laborLineSource(
      input,
      a.labor_allocations,
      { shopPricedServiceIds: shopPricedIds, flatMatchKeys },
      submittedAt,
    );
    const laborLines = buildLaborLines(
      src.labor,
      laborCents,
      rate,
      a.labor_hours != null ? Math.round(a.labor_hours * 60) : null,
    );

    // Set-price lines: the booked services the base covers + flat added lines.
    const base = baseAllIn > 0 ? decomposeAllInCents(baseAllIn, loc) : null;
    const baseLineDefs = src.setPriced
      .filter((l) => l.lineKind === "booked")
      .map((l) => ({
        key: `svc:${l.serviceId}`,
        name: l.name,
        weight: fixedMid.get(String(l.serviceId)) ?? 1,
      }));
    const baseLines = base
      ? setPriceLines(
          baseLineDefs.length > 0 ? baseLineDefs : [{ key: "set:base", name: "Set price", weight: 1 }],
          base.priceCents,
        )
      : [];
    const flatLines: MoneyServiceLine[] = flatJobs.map((c) => ({
      key: `job:${String(c._id)}`,
      name: String(c.name).trim() || "Added service",
      kind: "set_price",
      minutes: null,
      rateCents: null,
      laborCents: 0,
      setPriceCents: c.quoted_price_cents as number,
      amountCents: c.quoted_price_cents as number,
    }));

    let taxCents: number;
    let feeCents: number;
    let expected: number | null = setTotal;
    if (hasBreakdown) {
      taxCents = a.tax_cents! + (base?.taxCents ?? 0);
      feeCents = a.service_fee_cents! + (base?.feeCents ?? 0);
    } else {
      // Legacy row without a frozen stack: real tax/fee on its own lines; the
      // assembler surfaces any gap to the agreed total as an explicit line.
      warnings.push("approval_without_breakdown");
      const partsBasis = sum(parts.map((p) => p.lineCents)) + flatCents;
      taxCents = taxCentsFor(laborCents, partsBasis, loc);
      feeCents = feeCentsFor(partsBasis + laborCents);
    }
    const entries = history(input, null);
    return assemble({
      base: {
        basis: "approval",
        isShopSet,
        agreedApprovalId: a._id != null ? String(a._id) : null,
        agreedCycle: a.cycle ?? null,
        services: [...baseLines, ...laborLines, ...flatLines],
        parts,
        setPriceParts,
        excludedParts,
        range,
        ...historyFields(entries, "approval"),
      },
      input,
      taxCents,
      feeCents,
      adjustmentCents: adjustment,
      expectedTotalCents: expected,
      warnings,
    });
  }

  // ── 2. An accepted tire / rotor quote ────────────────────────────────────
  if (input.quote) {
    const q = input.quote;
    const parts = quotePartLines(q);
    const partsCents = sum(parts.map((p) => p.lineCents));
    const laborLines: MoneyServiceLine[] = [
      {
        key: "quote:labor",
        name: q.serviceName,
        kind: "labor",
        minutes: q.durationMinutes,
        rateCents:
          q.durationMinutes && q.durationMinutes > 0
            ? Math.round((q.laborCents * 60) / q.durationMinutes)
            : null,
        laborCents: q.laborCents,
        setPriceCents: 0,
        amountCents: q.laborCents,
      },
    ];
    // The shop typed a total; it should be parts + labor. If it isn't, show
    // the difference as its own line rather than hiding it in tax. Tax and fee
    // follow Review & Pay exactly (on labor + parts), so this total is the one
    // the customer authorized.
    const adjustment = q.totalCents - (partsCents + q.laborCents);
    if (adjustment !== 0) warnings.push(`quote_total_gap:${adjustment}`);
    const allIn = quoteAllInCents({
      laborCents: q.laborCents,
      partsCents,
      quoteTotalCents: q.totalCents,
      loc,
    });
    const taxCents = allIn.taxCents;
    const feeCents = allIn.feeCents;
    const entries = history(input, allIn.totalCents);
    return assemble({
      base: {
        basis: "quote",
        isShopSet: false,
        agreedApprovalId: null,
        agreedCycle: null,
        services: laborLines,
        parts,
        setPriceParts: [],
        excludedParts: [],
        range,
        ...historyFields(entries, "quote"),
      },
      input,
      taxCents,
      feeCents,
      adjustmentCents: adjustment,
      expectedTotalCents: null,
      warnings,
    });
  }

  // ── 3. Still an estimate: the create-time quote ──────────────────────────
  const qb = booking.quoted_breakdown as
    | { parts_cents: number; labor_cents: number; tax_cents: number; service_fee_cents: number }
    | undefined;
  if (qb) {
    const snapshot: any[] = Array.isArray(booking.priced_parts_snapshot)
      ? booking.priced_parts_snapshot
      : [];
    // A fixed-price booking created before its fixed lines were stored: the
    // flag is there but not the lines, so — like the approval path — the
    // booked services ARE the fixed ones, and their price is the quote's parts
    // figure (computeQuotedSetPrice put the flat price there).
    const legacyFixed =
      fixedIds.size === 0 &&
      booking.is_fixed_price === true &&
      booking.has_shop_price_range !== true;
    const estimateFixedIds: Set<string> = legacyFixed
      ? new Set<string>(((booking.service_ids ?? []) as unknown[]).map((s) => String(s)))
      : fixedIds;
    // Integrity-flagged rows stay: the quote was priced from them, so hiding
    // them turned their cost into an unexplained adjustment. They're marked
    // `unverified` for surfaces that shouldn't itemize them.
    const parts = snapshot
      .filter((p) => !estimateFixedIds.has(String(p?.service_id)))
      .map(snapshotPartLine);
    const setPriceParts = snapshot
      .filter((p) => estimateFixedIds.has(String(p?.service_id)))
      .map(snapshotPartLine);
    const src = laborLineSource(input, null, {
      shopPricedServiceIds: estimateFixedIds,
      flatMatchKeys: new Set(),
    });
    const rate =
      typeof input.estimateRateCents === "number" && input.estimateRateCents > 0
        ? input.estimateRateCents
        : null;
    const laborLines = buildLaborLines(src.labor, qb.labor_cents, rate, null);
    const partsLines = sum(parts.map((p) => p.lineCents));
    const fixedDefs = src.setPriced
      .filter((l) => l.lineKind === "booked")
      .map((l) => ({
        key: `svc:${l.serviceId}`,
        name: l.name,
        weight: legacyFixed
          ? (l.rawHours ?? 1)
          : (fixedMid.get(String(l.serviceId)) ?? 0),
      }));
    const fixedServiceLines = setPriceLines(
      fixedDefs,
      legacyFixed ? qb.parts_cents - partsLines : sum([...fixedMid.values()]),
    );
    const setPrice = sum(fixedServiceLines.map((s) => s.setPriceCents));
    const adjustment = qb.parts_cents - (partsLines + setPrice);
    if (adjustment !== 0) warnings.push(`estimate_parts_gap:${adjustment}`);
    const entries = history(input, null);
    return assemble({
      base: {
        basis: "estimate",
        isShopSet: estimateFixedIds.size > 0,
        agreedApprovalId: null,
        agreedCycle: null,
        services: [...fixedServiceLines, ...laborLines],
        parts,
        setPriceParts,
        excludedParts: [],
        range,
        ...historyFields(entries, "estimate"),
      },
      input,
      taxCents: qb.tax_cents,
      feeCents: qb.service_fee_cents,
      adjustmentCents: adjustment,
      expectedTotalCents:
        typeof booking.quoted_set_price_cents === "number"
          ? booking.quoted_set_price_cents
          : null,
      warnings,
    });
  }

  // ── 4. Legacy: only the booking's own dollar fields ──────────────────────
  const laborCents = Math.round((booking.labor_cost ?? 0) * 100);
  const partsCents = Math.round((booking.parts_cost ?? 0) * 100);
  const snapshot: any[] = Array.isArray(booking.priced_parts_snapshot)
    ? booking.priced_parts_snapshot
    : [];
  // Legacy rows have no structured quote — `parts_cost` is the figure, and
  // integrity-flagged snapshot rows were never part of it.
  const parts = snapshot.filter((p) => p?.integrity_flag == null).map(snapshotPartLine);
  const src = laborLineSource(input, null, {
    shopPricedServiceIds: new Set(),
    flatMatchKeys: new Set(),
  });
  const laborLines = buildLaborLines(src.labor, laborCents, null, null);
  const adjustment = partsCents - sum(parts.map((p) => p.lineCents));
  // A shop-created / walk-in bill stores total = labor + parts: the shop's own
  // bill, no sales tax and no Otopair fee. Don't invent them.
  const storedTotalCents =
    typeof booking.total_cost === "number" ? Math.round(booking.total_cost * 100) : null;
  const shopBill =
    storedTotalCents != null && Math.abs(storedTotalCents - (laborCents + partsCents)) <= 1;
  const taxCents = shopBill ? 0 : taxCentsFor(laborCents, partsCents, loc);
  const feeCents = shopBill ? 0 : feeCentsFor(laborCents + partsCents);
  if (adjustment !== 0) warnings.push(`legacy_parts_gap:${adjustment}`);
  const entries = history(input, null);
  return assemble({
    base: {
      basis: "legacy",
      isShopSet: false,
      agreedApprovalId: null,
      agreedCycle: null,
      services: laborLines,
      parts,
      setPriceParts: [],
      excludedParts: [],
      range,
      ...historyFields(entries, "legacy"),
    },
    input,
    taxCents,
    feeCents,
    adjustmentCents: adjustment,
    expectedTotalCents:
      typeof booking.total_cost === "number" && booking.total_cost > 0
        ? Math.round(booking.total_cost * 100)
        : null,
    warnings,
  });
}
