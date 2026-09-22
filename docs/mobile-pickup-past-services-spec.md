# Mobile spec — pickup / cancellation in past services + timeline

Status: backend shipped on `temur-dev`. This spec covers the **mobile app
(customer + mechanic)** changes needed to match the new Convex contract. The web
shop portal is already updated; these customer/mechanic surfaces are mobile-only.

**Problem this fixes:** when a customer requests to pick up their car early
("Request to cancel & pick up car"), the shop releases it, the booking flips to
`cancelled`, and the **$20 deposit is captured as a pickup / late-cancel fee**
(or waived). Today that booking surfaces in **Past Services** as a normal
completed service — the screenshot showed **"Diagnostic Scan · 20.00"**, which
reads like a $20 diagnostic scan. It should read **"Cancelled — picked up
early · $20 pickup fee"**. The fee flows 100% to the shop/mechanic (destination
charge, `application_fee_amount: 0`); there is no charge levied *on* the mechanic.

Backend model in one line: **a cancelled-with-pickup booking keeps its original
service ids, but its captured amount is a forfeit fee, not a service bill — the
backend now labels it so the app can render it as a cancellation, not a service.**

---

## 1. Past Services / History row (REQUIRED)

**Source:** `api.bookings.getByUserIdWithDetails({ userId })` (the "My Bookings"
query that backs Live Tracker / Upcoming / History). New fields on each row:

```ts
// Derived classification — only set for terminal (history) bookings; null while
// the booking is still pending/confirmed/in_progress.
historyOutcome:
  | "completed"          // a real service — show the service name + amount
  | "cancelled_pickup"   // customer requested pickup; released with (or without) a fee
  | "cancelled"          // cancelled/declined for another reason
  | "no_show"            // customer never showed; forfeit fee
  | null

// The amount to render on the row, already resolved to the right source:
//   completed        → final captured service total
//   cancelled/no_show→ the cancellation fee in cents (0 when waived)
historyAmountCents: number | null

// Raw fee context (also available if you want to format it yourself):
cancellation_fee_cents: number | null   // 0 = waived
cancellation_kind: "free" | "late_cancel" | "no_show" | null

// Already present (pickup round-trip):
pickupRequestedAtMs: number | null
pickupResponse: "acknowledged" | "bringing_out" | "declined" | null
pickupRespondedAtMs: number | null
```

**What to build** — branch the row on `historyOutcome`:

| `historyOutcome`   | Title                         | Subtitle / detail                | Amount                                        | Style |
|--------------------|-------------------------------|----------------------------------|-----------------------------------------------|-------|
| `completed`        | service name (as today)       | date · vehicle · shop            | `$` + `historyAmountCents / 100`              | normal |
| `cancelled_pickup` | **"Cancelled — picked up early"** | "You requested pickup"      | `historyAmountCents > 0` → **"$20 pickup fee"**, else **"No fee"** | muted / rose |
| `cancelled`        | **"Cancelled"**               | date · vehicle · shop            | fee or **"No fee"**                           | muted |
| `no_show`          | **"Missed appointment"**      | date · vehicle · shop            | fee or **"No fee"**                           | muted |

Rules:
- **Do NOT show the original service name** (e.g. "Diagnostic Scan") as the row
  title for anything other than `completed`. Use the outcome label above.
- **Do NOT render `historyAmountCents` as a service price** for non-`completed`
  rows — it is a fee. Prefix/label it ("pickup fee", "cancellation fee").
- A `cancelled_pickup` with `historyAmountCents === 0` was waived → show
  **"No fee"**, not "$0.00".
- Visually distinguish non-`completed` rows (muted text / a small "Cancelled"
  chip) so they don't read as revenue-generating services.

---

## 2. Completion vs. release screen (REQUIRED)

The **"Your GLE-Class was serviced"** completion screen ("You paid $X — Labor,
parts, fee and tax", star rating, "Book here again") is for **`completed` only**.

For a `cancelled_pickup` booking, show a **"Vehicle released / picked up early"**
screen instead:
- Headline: "You picked up your GLE-Class early" (or shop's release note if any).
- One fee line: **"$20 pickup fee"** or **"Fee waived — no charge"** (from
  `cancellation_fee_cents`).
- The pickup timeline (see §4) if you surface activity on this screen.
- No "serviced" language, no work-performed list, no labor/odometer block.

Gate the screen on `historyOutcome` (or `booking.status === "completed"`), not on
the mere presence of a captured amount — a captured amount now also appears on
cancelled bookings (it's the fee).

---

## 3. Receipt breakdown (REQUIRED if you show receipts for cancelled bookings)

**Source:** `api.invoices.getReceiptForBooking({ bookingId, ... })`. New fields on
the assembled receipt:

```ts
receiptKind: "service" | "cancellation_fee"
cancellationFeeCents: number | null   // set when receiptKind === "cancellation_fee"
```

When `receiptKind === "cancellation_fee"` the backend already collapses the
breakdown to a single fee line:
- `services: ["Pickup / cancellation fee"]`
- `parts: []`, `laborCents: 0`, `partsTotalCents: 0`
- `subtotalCents === totalCents === cancellationFeeCents`
- `taxCents: 0`, `platformFeeCents: 0`

So a receipt renderer that reads `services` + `subtotal/tax/fee/total` already
renders correctly — just **don't** print a "Labor, parts, fee and tax" caption
for a `cancellation_fee` receipt; print **"Pickup / cancellation fee"**.

---

## 4. Booking timeline (OPTIONAL — if the app renders the activity log)

**Source:** `api.booking_activity.getBookingActivityLog({ bookingId })`. The event
union gained two event types and a discriminator (mirror of the web timeline):

```ts
// New events (synthesized from the booking's own fields — latest round only):
| { type: "pickup_requested"; at; actor; data: { reason: string | null } }
| { type: "pickup_response";  at; actor;
    data: { response: "acknowledged" | "bringing_out" | "declined"; note: string | null } }

// payment_captured gained a `kind`:
| { type: "payment_captured"; at; actor;
    data: { amountCents; cardBrand; last4;
            kind: "service" | "cancellation_fee" } }
```

Render:
- `pickup_requested` → "Pickup requested" (+ the customer's reason).
- `pickup_response` → "Shop acknowledged pickup" / "Bringing the car out" /
  "Pickup declined" (+ note).
- The release itself is a `status_change` to `cancelled` with
  `reason: "shop_released_pickup"` (fee charged) or `"shop_released_fee_waived"`
  (waived) → title it **"Vehicle released for pickup"**; for the waived reason
  show "Pickup fee waived — no charge".
- `payment_captured` with `kind === "cancellation_fee"` → **"Cancellation fee
  collected — $20.00"** (not "Payment collected"); the neighbouring "Vehicle
  released for pickup" entry supplies the pickup context. This is also the line
  that shows the **shop/mechanic collected** the fee.

**Limitation:** the booking stores only the *latest* pickup request/response
pair, so the timeline shows the most recent round faithfully but not multiple
re-request cycles. A dedicated `pickup_events` log table would be needed for full
multi-round history — not built (out of scope).
