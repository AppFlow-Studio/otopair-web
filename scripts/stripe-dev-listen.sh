#!/usr/bin/env bash
# stripe-dev-listen.sh — forward Stripe test-mode webhooks to the local Convex
# dev deployment so the full lifecycle (intent created → succeeded → refund →
# dispute) hits handleStripeWebhook in convex/http.ts.
#
# Usage:
#   ./scripts/stripe-dev-listen.sh
#
# Requires:
#   - Stripe CLI installed + logged in (`stripe login`)
#   - NEXT_PUBLIC_CONVEX_URL set in .env.local
#
# The signing secret printed below must be set as STRIPE_WEBHOOK_SECRET in the
# Convex dev deployment (`npx convex env set STRIPE_WEBHOOK_SECRET whsec_...`).
# Re-run `npx convex env set` if the CLI rotates the secret on a new session.
#
# NOTE: charge.refund.updated must also be enabled on the real webhook endpoints
# in the Stripe dashboard, not just here. Without it a refund the bank later
# rejects stays counted and payments.refunded_amount_cents is overstated.

set -euo pipefail

if [[ -z "${NEXT_PUBLIC_CONVEX_URL:-}" ]]; then
  # shellcheck disable=SC1091
  if [[ -f ".env.local" ]]; then
    set -a
    source .env.local
    set +a
  fi
fi

if [[ -z "${NEXT_PUBLIC_CONVEX_URL:-}" ]]; then
  echo "NEXT_PUBLIC_CONVEX_URL is not set. Add it to .env.local first." >&2
  exit 1
fi

# Convex client URL has form https://<deployment>.convex.cloud — the HTTP
# router lives on the same host under /stripe/webhook (see convex/http.ts).
WEBHOOK_URL="${NEXT_PUBLIC_CONVEX_URL%/}/stripe/webhook"

echo "Forwarding Stripe webhooks → ${WEBHOOK_URL}"
echo "Copy the 'whsec_...' the CLI prints next and run:"
echo "  npx convex env set STRIPE_WEBHOOK_SECRET <whsec_...>"
echo

exec stripe listen \
  --forward-to "${WEBHOOK_URL}" \
  --events \
"payment_intent.succeeded,\
payment_intent.payment_failed,\
payment_intent.canceled,\
payment_intent.amount_capturable_updated,\
payment_intent.requires_action,\
charge.refunded,\
charge.refund.updated,\
charge.dispute.created,\
charge.dispute.updated,\
charge.dispute.closed,\
setup_intent.succeeded,\
account.updated,\
account.external_account.updated,\
capability.updated"
