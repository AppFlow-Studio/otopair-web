# Stripe Lifecycle Runbook — Pre-Job Approval Flow

End-to-end verification for the booking-payment lifecycle. Walk these
scenarios before any production cutover; they exercise every branch in
`convex/payments_stripe.ts` and `convex/http.ts`.

## Prerequisites

1. Convex dev running: `npx convex dev`
2. Next.js dev: `npm run dev`
3. Stripe CLI forwarder: `./scripts/stripe-dev-listen.sh` — copy the printed
   `whsec_...` and set it via `npx convex env set STRIPE_WEBHOOK_SECRET ...`.
4. Test customer signed in via Clerk dev tenant; vehicle + shop seeded.

Each step lists the **action**, the **expected Convex state**, and the
**expected webhook event(s)**. Verify with the Convex dashboard's
data tab (or `bunx convex run` for read-only queries).

---

## 1. Happy path — in-range capture

| Step | Action | Expected Convex state | Expected webhooks |
|---|---|---|---|
| 1.1 | Book a service; pay with `4242 4242 4242 4242` | `payments.status: "processing"`, `hold_amount_cents: 2000`, `booking.payment_approval_state: undefined` | `payment_intent.amount_capturable_updated` (initial $20) |
| 1.2 | Mechanic submits estimate ≤ disclosed_range_high | `booking.payment_approval_state: "in_range"`, `payments.incremented_total_cents: ~set price`, latest `booking_approvals.stripe_action: "increment_authorization"` | `payment_intent.amount_capturable_updated` (lifted to set price) |
| 1.3 | Mechanic flips status → "in_progress" → "completed" | `booking.payment_approval_state: "captured"`, `payments.status: "completed"`, `payments.captured_amount_cents: finalCents` | `payment_intent.succeeded` |

---

## 2. SCA required — reauth_required flip

| Step | Action | Expected state | Webhook |
|---|---|---|---|
| 2.1 | Book with `4000 0027 6000 3184` (SCA-required) — confirm 3DS challenge at PaymentSheet | `payments.status: "processing"`, hold landed via SCA flow | `payment_intent.succeeded` (post-3DS) on initial $20 |
| 2.2 | Mechanic submits estimate > $20 → triggers `incrementAuthorization`, card requires SCA again | `booking.payment_approval_state: "reauth_required"`, push row in `notification_outbox` (`category: "reauth_required"`) | `payment_intent.requires_action` |
| 2.3 | Customer-side reauth confirm | Returns to normal flow; resume at step 1.2 | `payment_intent.amount_capturable_updated` |

Dashboard verification: mechanic dashboard should show "Hold reauthorization
needed" badge on the booking row, and the post-job survey dialog should show
the rose-coloured "Card reauthorization needed" card.

---

## 3. Incremental-auth-not-supported — reauthFlow path

Some test cards (and most real cards on non-Visa networks) don't support
incremental authorization. Stripe rejects `incrementAuthorization` with
`incremental_authorization_not_supported`, and `payments_stripe.reauthFlow`
voids + recreates the PI.

| Step | Action | Expected state | Webhook |
|---|---|---|---|
| 3.1 | Book with card lacking incremental auth (e.g. `4111 1111 1111 1111`) | hold landed | `payment_intent.amount_capturable_updated` |
| 3.2 | Mechanic submits in-range estimate | Original PI **cancelled**; `payments.reauth_payment_intent_id` set to new PI; `payments.stripe_payment_intent_id` updated to new PI; latest `booking_approvals.stripe_action: "reauth"` | `payment_intent.canceled` (original) + `payment_intent.amount_capturable_updated` (new) |
| 3.3 | Complete → capture | Capture **targets the new PI** (regression check for B1) | `payment_intent.succeeded` on new PI |

---

## 4. Over-range estimate — pre-job approval SLA

| Step | Action | Expected state | Webhook |
|---|---|---|---|
| 4.1 | Mechanic submits estimate **above** disclosed_range_high | `booking.payment_approval_state: "pre_job_pending"`, `booking_approvals.sla_expires_at_ms` = now + 24h, push row enqueued | none |
| 4.2a | Customer approves via mobile app | `payment_approval_state: "pre_job_approved"`, hold incremented | `payment_intent.amount_capturable_updated` |
| 4.2b | OR customer declines | `payment_approval_state: "pre_job_declined"` | none — booking awaits mechanic revise |
| 4.2c | OR SLA timer expires (cron) | `payment_approval_state: "sla_expired"`, $20 deposit captured | `payment_intent.succeeded` (on deposit amount only) |

---

## 5. Post-job re-approval (actuals > approved set price)

| Step | Action | Expected state | Webhook |
|---|---|---|---|
| 5.1 | Mechanic completes the booking; final parts pushed `total_cents > mechanic_set_price_cents` | `booking.payment_approval_state: "post_job_pending"`; new `booking_approvals` row with `cycle: "post_job"`; **no double-row** if completion is retriggered (regression check for B4) | none |
| 5.2a | Customer approves | `payment_approval_state: "post_job_approved"`, capture at new ceiling | `payment_intent.succeeded` |
| 5.2b | Customer declines | `payment_approval_state: "post_job_declined"` → finalize captures at **prior approved ceiling** (regression check for B2 — no loop) | `payment_intent.succeeded` (capture amount = prior ceiling) |

---

## 6. Dispute lifecycle

| Step | Action | Expected state | Webhook |
|---|---|---|---|
| 6.1 | After a captured booking: `stripe trigger charge.dispute.created` | `payment_disputes` row inserted, `payments.status: "disputed"`, shop receives push (`category: "payment_dispute_opened"`) | `charge.dispute.created` |
| 6.2 | `stripe trigger charge.dispute.updated` (evidence period extended) | Same dispute row patched with new status / evidence_due_by_ms | `charge.dispute.updated` |
| 6.3 | `stripe trigger charge.dispute.closed` (won) | `payment_disputes.status: "won"`, `payments.status: "completed"` | `charge.dispute.closed` |

---

## 7. Refund

| Step | Action | Expected state | Webhook |
|---|---|---|---|
| 7.1 | Admin triggers `refundPaymentForBooking` on a completed booking | Refund created against the **active PI** (`reauth_payment_intent_id` if reauth occurred — regression check for B1), `payments.status: "refunded"` (optimistic patch) | `charge.refunded` |
| 7.2 | Webhook lands | Invoice PDF regenerated + re-emailed to customer | — |

---

## 8. Cancellation pre-capture (no-show / declined)

| Step | Action | Expected state | Webhook |
|---|---|---|---|
| 8.1 | Mechanic flips status to "no_show" / "cancelled" before capture | Hold released via `cancelPaymentIntentForBooking`, `payments.status: "cancelled"`, `booking.stripe_authorization_voided_at_ms` stamped | `payment_intent.canceled` |

---

## Regression checklist for B-series fixes

After running scenarios 1–8, verify each B-fix from the plan:

- **B1**: In scenario 3 + 7, capture/refund must target the new PI when
  `reauth_payment_intent_id` is set. Check `payment_intent.succeeded` /
  `charge.refunded` event reference matches the new PI id.
- **B2**: In scenario 5.2b, finalize must NOT create a second post-job
  approval row. Query `booking_approvals` filtered by booking_id — should be
  exactly one post_job row.
- **B3**: Force a non-reauth-able increment failure (e.g. inject a Stripe
  test card that returns `processing_error`). Expected: booking flips to
  `reauth_required`, push row enqueued.
- **B4**: Manually call `internal.payments_stripe.finalizeAndChargeForBooking`
  twice on the same booking via Convex dashboard. Expected: only one new
  approval row.
- **B5**: After scenario 1.2, manually patch `payments.incremented_total_cents`
  to a wrong value, then trigger another `amount_capturable_updated` event.
  Expected: value snaps back to `pi.amount_capturable`.
- **B6**: Force `mechanic_set_price_cents = 0` on a non-legacy booking,
  trigger finalize. Expected: console.error logged, capture clamped to
  `running_approved_ceiling_cents`.

---

## Stripe test card reference

| Number | Behaviour |
|---|---|
| `4242 4242 4242 4242` | Always succeeds |
| `4000 0027 6000 3184` | SCA required (3DS) |
| `4000 0000 0000 0341` | Attach succeeds, charge fails |
| `4111 1111 1111 1111` | No incremental auth support → forces reauthFlow |
| `4000 0000 0000 0259` | Disputed as fraudulent |
| `4000 0000 0000 1976` | Disputed as product not received |
