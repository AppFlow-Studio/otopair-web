# Money source of truth — the booking money statement

Status: backend + shop portal shipped on `temur-dev` (Sep 29 2026). Closes
#331, #334, #350, #417 (with the mobile fixes below), #445 and the shop half of
#390. This doc is the contract for the **mobile** screens that still do money
math on the phone.

Backend model in one line: **every price the shop, the customer or Stripe sees
for a booking comes from one statement, built on the server from the records
that already exist. The phone renders it; it never recomputes it.**

---

## 1. The statement

`convex/lib/bookingMoney.ts` → `buildBookingMoney(...)`, loaded by
`convex/bookingMoney.ts` → `loadBookingMoney(ctx, booking)`. Derived on read —
nothing new is stored.

Customer query: `api.bookingMoney.getForCustomer({ bookingId })` (booking owner
only). Shop query: `api.bookingMoney.getForShop({ bookingId })`. The shop portal
also gets it as `getJobDetail(...).money`.

```ts
type BookingMoney = {
  basis: "approval" | "estimate" | "quote" | "legacy";
  isShopSet: boolean;
  agreedApprovalId: string | null;   // the booking_approvals row the price comes from
  agreedCycle: string | null;        // "pre_job" | "mid_job" | "post_job"
  services: Array<{
    key: string;
    name: string;
    kind: "labor" | "set_price";
    minutes: number | null;          // billed minutes (labor lines)
    rateCents: number | null;        // billed rate, cents/hr — minutes × rate = laborCents
    laborCents: number;
    setPriceCents: number;           // shop flat price, pre-tax (set_price lines)
    amountCents: number;
  }>;
  parts: Array<{                     // billable lines only; name is NEVER blank
    name: string; partNumber: string | null; brand: string | null;
    quantity: number; unitCents: number; lineCents: number;
    serviceId: string | null; customServiceName: string | null;
    isTire: boolean; fromQuote: boolean; justification: string | null;
  }>;
  setPriceParts: MoneyPartLine[];    // installed, cost folded into a set price
  excludedParts: Array<{ name; partNumber; quantity; reason: "not_used" | "customer_supplied" }>;
  totals: {
    partsCents; laborCents; setPriceCents;
    adjustmentCents;                 // explicit line, legacy rows only; never inside tax
    subtotalCents; taxCents; feeCents; totalCents;
    laborMinutes: number | null;
  };
  counts: { services: number; parts: number };   // = the line arrays — never a different rule
  range: { lowCents; highCents } | null;          // disclosed band (estimate basis)
  history: Array<{ kind: "booked" | "quote" | "pre_job" | "mid_job" | "post_job"; totalCents; atMs; approvalId }>;
  originalQuoteCents: number | null;              // the create-time quote
  previousAgreedTotalCents: number | null;        // the last total the customer confirmed before this one
  previousAgreedKind: "booked" | "quote" | "pre_job" | "mid_job" | "post_job" | null;
  holdTargetCents: number;                        // what confirming the current hold authorizes
  payment: {
    authorizedCents; capturedCents;               // captured = summed across payment rows
    capturedAtMs; cardBrand; cardLast4; status; paymentCount;
    settlementState; shortfallCents;
  };
  warnings: string[];                             // diagnostics; never show to customers
};
```

**Invariants (tests/bookingMoney.test.ts):**

- Σ part lines + Σ service lines + adjustment = `subtotalCents`.
- `subtotalCents + taxCents + feeCents` = `totalCents`.
- basis `"approval"` ⇒ `totalCents` = that approval's `mechanic_set_price_cents`.

**The agreed approval** is the newest row the customer agreed to
(`approved` / `auto_approved_within_range`), by decision time. It is **never**
`booking.mechanic_set_price_cents`: that field is written when an estimate is
*requested*.

**Tire/rotor quote bookings:** the total is the shop's quote **plus tax and the
service fee**, computed exactly as Review & Pay shows it (`quoteAllInCents`).
That all-in amount is now also the booking's disclosed band, so a pre-job
estimate at the quote lands in range.

---

## 2. What already renders from it (no app release needed)

These server responses kept their shapes and now fill from the statement:

| Screen | Query | What changed |
|---|---|---|
| Receipt sheet | `bookings.getReceipt` | Lines/totals from the statement; each service line adds `labor_minutes`, `labor_rate`, `kind`; `shop.labor_rate` = the billed rate; `payment.amount` = captured; `totals` adds `set_price_subtotal`, `adjustment`, `labor_minutes`, `captured`. Set-price lines render under LABOR (folded into `labor_subtotal`); an adjustment is a PARTS line named "Adjustment". |
| Receipt PDF (Share) | `invoices.getInvoicePdfUrl` / `requestInvoiceGeneration` | Tax and fee are the confirmed ones (#417). Per-service labor lines. A PDF stored before this change reports as absent and re-renders on the next Share (render-only, no email). |
| Card-hold | `booking_approvals.getReauthBreakdownForBooking` | Rows/totals from the statement. Adds `holdTargetCents`, `setPriceCents` and `adjustmentCents`. `laborCents` includes set prices and `partsCents` includes any adjustment, so the four-row stack sums. |
| "What changed" | `booking_approvals.getOpenApprovalForBooking` | Adds `parts_subtotal_cents`, `labor_cents`, `tax_cents` and `service_fee_cents` (the frozen breakdown the total was priced from); `parts_snapshot[].part_name` is never blank. |

Capture: `finalizeAndChargeForBooking` now captures the statement's total
whenever the price is agreed (approval, accepted quote, or a fixed price). It
used to recompute from the pre-job row, which under-charged jobs with
approved extra labor (#334).

---

## 3. Mobile changes shipped with this (temur-dev, otopair repo)

- `app/booking/mechanic/[id]/payment.tsx` — the live Review & Pay labor row
  reads "Includes labor (…)". The #322 fix had landed only in the unused
  `ReviewPayContent.tsx`.
- `components/receipts/ReceiptContent.tsx` — the labor caption uses the line's
  `labor_minutes` @ `labor_rate` ("28 MIN @ $150.00/HR" next to $70.00), with
  "SET PRICE" for flat-priced lines.
- `hooks/useConfirmHold.ts` — the hold shown is `max(set, ceiling)`, the exact
  amount the server authorizes (= `holdTargetCents`).
- `approve-estimate/[id].tsx`, `PaymentBreakdown.tsx` — blank part names fall
  back to "Part" (`||`, not `??`).

---

## 4. Still to do on mobile (Ahmad)

1. **"What changed" (approve-estimate ApprovalDecisionView)** — stop deriving
   parts/labor/"Taxes & Fees" on the phone (`[id].tsx` ~448-466). Render
   `parts_subtotal_cents`, `labor_cents`, `tax_cents` and `service_fee_cents`
   from `getOpenApprovalForBooking`. Today a flat-priced added line is counted
   in the server's parts subtotal but not in `parts_snapshot`, so the phone's
   remainder puts it under "Taxes & Fees".
2. **Review & Pay** — the numbers are still computed on the phone with the
   shared `lib/tax.ts` + `lib/platformFee.ts`. Moving it onto the statement
   needs a money block on `quotes.previewForBookingQuery` (not built yet). Ask
   for it when you pick this up.
3. **#390 customer half** — iOS books at a changed shop price without warning.
   Proposed contract: `createBatch` / `confirmPreauthorizedBatch` accept an
   optional `expected_total_cents`. The server throws `PRICE_CHANGED`
   (old/new) when its fixed-price total differs, and the app shows "The price
   changed from $85 to $150. Continue?". Not built; say the word.
4. **Booking Details range** — `BookingDetailsSheet.tsx` ~1547 recomputes the
   range on the phone with `deriveDisclosedRange`. Read
   `getForCustomer(...).totals.totalCents` / `.range` instead.
