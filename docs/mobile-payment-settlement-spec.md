# Mobile spec — payment settlement + cancel/reschedule policy

Status: backend shipped on `temur-dev` (Waves 1–4). This spec covers the
**mobile app (customer)** changes needed to match the new Convex contract. The
web repo needs no change for the customer flows (they're mobile-only).

Backend model in one line: **the price is agreed before the job (pre-job
approval) and raised only with consent during it (mid-job "found extra work"
approval). A completed job has nothing left to negotiate — it's captured at the
agreed price and shown as a receipt.**

---

## 1. Post-completion "final breakdown" → receipt, no Decline (REQUIRED)

**What changed on the server:** completion no longer opens a `post_job`
re-approval cycle. `finalizeAndChargeForBooking` captures the agreed price and
settles. Therefore **`getOpenApprovalForBooking` returns `null` after
completion** — the old screen that rendered "Your final breakdown" with
**Approve / Decline** will simply stop appearing if it's driven off an open
approval.

**What to build:** render the post-completion breakdown as an **informational
receipt** driven off `getCustomerBookingActions`, with **no Decline button and
no approve/decline decision**.

Read `api.bookings.getCustomerBookingActions({ bookingId })`. New field:

```ts
completion: {
  requiresDecision: false,          // always false — do NOT show approve/decline
  finalTotalCents: number | null,   // what was (or will be) charged
  settlementState: "settled" | "awaiting_settlement" | string,
  settlementShortfallCents: number, // 0 when fully settled
} | null                             // null unless booking.status === "completed"
```

UI:
- When `completion != null`, show the final breakdown screen as a receipt.
  Keep the line items (pull from the existing receipt/invoice source —
  `final_parts_used_at_capture` / the receipt endpoint you already use for the
  emailed receipt / `/receipts/[bookingId]`). Totals come from
  `completion.finalTotalCents`.
- **Remove the Decline button entirely.** The single action is a neutral
  dismiss ("Done" / "Close"). There is no server decision to send.
- Do **not** call `applyApprovalDecision` for a completed booking anymore.
- If `settlementState === "awaiting_settlement"` (hold couldn't be captured yet
  — e.g. the customer needs to re-authorize), show a soft "Payment pending —
  confirm your card" prompt that routes into the re-auth view (see §4), instead
  of a receipt. `settlementShortfallCents` is the outstanding amount.

`applyApprovalDecision` remains valid ONLY for `pre_job` and `mid_job` cycles
(before/during the job). Post-job decisions are gone.

---

## 2. Cancel — read the policy, never assume free (REQUIRED)

Cancellation is now phase-gated with real fees. Drive the cancel UI entirely
off `getCustomerBookingActions`:

```ts
canCancel: boolean
cancelKind: "free" | "late_cancel" | "request_shop"
feeCentsIfCancelledNow: number      // disclose this before confirming
freeUntilMs: number | null          // "free to cancel until <time>"
blockedReason: string | null        // e.g. "work_in_progress", "already_completed"
```

- `cancelKind === "free"` → confirm, then call
  `api.bookings.cancelBooking({ bookingId, reason?, feeAcknowledgedCents: 0 })`.
- `cancelKind === "late_cancel"` → **disclose `feeCentsIfCancelledNow`** in the
  confirm sheet, then call `cancelBooking({ bookingId, reason?,
  feeAcknowledgedCents: feeCentsIfCancelledNow })`. The server recomputes the
  fee; if it rose past what was acknowledged (customer crossed the cutoff
  mid-flow) the call throws — re-fetch actions, re-disclose, retry.
- `cancelKind === "request_shop"` (car is at the shop, `status ===
  "vehicle_at_shop"`) → do NOT call `cancelBooking`; call
  `api.bookings.requestCancellationAtShop({ bookingId, reason? })`. This
  notifies the front desk and does not change status. Show "cancellation
  requested — the shop will confirm."
- `canCancel === false` (`blockedReason` `work_in_progress` / `already_*`) →
  hide the cancel action; show the reason.

`cancelBooking` returns `{ cancelled, feeCents, kind }`. **A completed or
in-progress booking can no longer be cancelled by the customer** — the server
rejects it. Remove any client path that assumed otherwise.

---

## 3. Reschedule — limit-aware (REQUIRED if reschedule exists on mobile)

```ts
canReschedule: boolean
rescheduleKind: "free" | "limited"
rescheduleFreeUntilMs: number | null
reschedulesUsed: number
maxFreeReschedules: number
```

- `rescheduleKind === "free"` → proceed via `customerRequestReschedule`.
- `rescheduleKind === "limited"` (max reached or within cutoff) → route the
  customer to contact the shop; don't offer self-serve reschedule.

---

## 4. Re-auth after completion (REQUIRED)

When the agreed price couldn't be captured (card needs re-authorization), the
booking sits `settlement_state = "awaiting_settlement"` and the reconciliation
cron re-sends a push (category `booking_reauth_required`, deep link
`otopair://booking/<id>/reauth`) once/day until resolved.

- The existing `ReauthView` / `resumeReauthFromMobile` flow still applies —
  make sure it works on a booking whose `status === "completed"` (previously
  reauth was mostly a pre-job concern). Completing the re-auth confirms the
  hold; the cron then captures it on its next tick and flips the booking to
  `settled`. Nothing else for the app to do post-reauth.

---

## 5. Do NOT call `bookings.updateStatus` (REQUIRED if used)

`bookings.updateStatus` is now shop-staff-only and refuses terminal states.
If the mobile customer app calls it for anything, migrate:
- cancel → `cancelBooking` / `requestCancellationAtShop`
- approve/decline estimate → `applyApprovalDecision` (pre/mid-job only)
- reschedule → `customerRequestReschedule`

---

## Contract summary (customer-callable)

| Purpose | Function | Key args | Returns |
|---|---|---|---|
| What can I do + cost | `bookings.getCustomerBookingActions` (query) | `bookingId` | actions + `completion` block |
| Cancel | `bookings.cancelBooking` | `bookingId, reason?, feeAcknowledgedCents?` | `{cancelled, feeCents, kind}` |
| Cancel at shop | `bookings.requestCancellationAtShop` | `bookingId, reason?` | `{requested}` |
| Reschedule | `bookings.customerRequestReschedule` | (existing) | (existing) |
| Approve/decline estimate | `booking_approvals.applyApprovalDecision` | `bookingId, decision` | pre/mid-job ONLY |
| Resume re-auth | `payments_stripe.resumeReauthFromMobile` | (existing) | (existing) |

No breaking change to `applyApprovalDecision` for pre/mid-job. The only removed
customer capability is the **post-job decline** (the price is already agreed).
