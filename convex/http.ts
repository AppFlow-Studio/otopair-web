/**
 * Convex HTTP Router
 *
 * Exposes webhook endpoints for external services (Stripe + MCP API).
 */

import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import type { ApiScope, KeyAuth } from "./dataApi";
import { ENRICH_DAILY_QUOTA, IMAGE_LIVE_FETCH_DAILY_CAP } from "./dataApi";
import Stripe from "stripe";

const http = httpRouter();
const STRIPE_API_VERSION = Stripe.API_VERSION;

let stripeClient: Stripe | null = null;

function getStripeForWebhook() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error("Missing STRIPE_SECRET_KEY.");
  }

  if (!stripeClient) {
    stripeClient = new Stripe(secretKey, {
      apiVersion: STRIPE_API_VERSION,
    });
  }

  return stripeClient;
}

function getStripeWebhookSecrets() {
  const secrets = [
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET,
    process.env.STRIPE_WEBHOOK_SECRET,
  ].filter((secret): secret is string => Boolean(secret));
  return Array.from(new Set(secrets));
}

async function constructStripeWebhookEvent(rawBody: string, signature: string) {
  const secrets = getStripeWebhookSecrets();
  if (secrets.length === 0) {
    throw new Error("Missing Stripe webhook signing secret.");
  }

  const stripe = getStripeForWebhook();
  let lastError: unknown = null;

  for (const secret of secrets) {
    try {
      return await stripe.webhooks.constructEventAsync(rawBody, signature, secret);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Invalid Stripe webhook signature.");
}

function getStripeAccountRequirements(account: Stripe.Account): string[] {
  return account.requirements?.currently_due ?? [];
}

async function syncStripeConnectedAccountFromEvent(
  ctx: ActionCtx,
  event: Stripe.Event,
  account: Stripe.Account
) {
  return await ctx.runMutation(internal.stripe_webhook_events.syncConnectedAccount, {
    eventId: event.id,
    eventType: event.type,
    livemode: event.livemode,
    stripeAccountId: account.id,
    stripeChargesEnabled: account.charges_enabled,
    stripePayoutsEnabled: account.payouts_enabled,
    stripeRequirementsCurrentlyDue: getStripeAccountRequirements(account),
  });
}

async function handleStripeWebhook(ctx: ActionCtx, request: Request) {
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return new Response("Missing Stripe signature", { status: 400 });
  }

  const rawBody = await request.text();
  let event: Stripe.Event;

  try {
    event = await constructStripeWebhookEvent(rawBody, signature);
  } catch (error) {
    console.error("[Stripe Webhook] Signature verification failed:", error);
    return new Response("Invalid signature", { status: 400 });
  }

  try {
    if (event.type === "account.updated") {
      await syncStripeConnectedAccountFromEvent(
        ctx,
        event,
        event.data.object as Stripe.Account
      );
      return new Response("ok", { status: 200 });
    }

    // ── Payment lifecycle events ────────────────────────────────────────
    if (
      event.type === "payment_intent.succeeded" ||
      event.type === "payment_intent.payment_failed" ||
      event.type === "payment_intent.canceled" ||
      event.type === "payment_intent.amount_capturable_updated" ||
      event.type === "payment_intent.requires_action"
    ) {
      const pi = event.data.object as Stripe.PaymentIntent;
      const mapped =
        event.type === "payment_intent.succeeded"
          ? "completed"
          : event.type === "payment_intent.payment_failed"
            ? "failed"
            : event.type === "payment_intent.canceled"
              ? "cancelled"
              : null;
      if (mapped) {
        // On a successful charge, resolve the card network + last-4 from the
        // charge's payment_method_details so ops can show "Visa ···· 4242"
        // (works for wallet payments too — the underlying network card is
        // reported). Best-effort: a retrieval failure must not fail the
        // webhook, so we swallow and let the backfill fill it later.
        let cardBrand: string | undefined;
        let cardLast4: string | undefined;
        // Settlement facts for the merchant invoice, read off the same charge
        // retrieval. The expansions are free here and are the only way to know
        // what Stripe actually took rather than what our formulas predicted —
        // see the header of convex/shopInvoices.ts.
        let settlement: {
          chargeId: string;
          balanceTransactionId?: string;
          applicationFeeCents?: number;
          processingFeeCents?: number;
          transferCents?: number;
          capturedCents?: number;
          receiptUrl?: string;
          currency?: string;
        } | null = null;

        if (event.type === "payment_intent.succeeded") {
          try {
            const chargeId =
              typeof pi.latest_charge === "string"
                ? pi.latest_charge
                : pi.latest_charge?.id;
            if (chargeId) {
              const charge = await getStripeForWebhook().charges.retrieve(
                chargeId,
                { expand: ["balance_transaction", "transfer"] },
              );
              const card = charge.payment_method_details?.card;
              cardBrand = card?.brand ?? undefined;
              cardLast4 = card?.last4 ?? undefined;

              const bt =
                charge.balance_transaction &&
                typeof charge.balance_transaction !== "string"
                  ? charge.balance_transaction
                  : null;
              const transfer =
                charge.transfer && typeof charge.transfer !== "string"
                  ? charge.transfer
                  : null;
              settlement = {
                chargeId: charge.id,
                balanceTransactionId: bt?.id,
                applicationFeeCents: charge.application_fee_amount ?? undefined,
                processingFeeCents: bt?.fee ?? undefined,
                // For a destination charge this is what the connected account
                // actually received — better than any arithmetic of ours.
                transferCents: transfer?.amount ?? undefined,
                capturedCents: charge.amount_captured ?? undefined,
                receiptUrl: charge.receipt_url ?? undefined,
                currency: charge.currency ?? undefined,
              };
            }
          } catch (error) {
            console.error(
              "[Stripe Webhook] charge/settlement retrieval failed:",
              error,
            );
          }
        }
        await ctx.runMutation(
          internal.payments_stripe.handlePaymentIntentEvent,
          {
            stripeEventId: event.id,
            eventType: event.type,
            paymentIntentId: pi.id,
            bookingId:
              (pi.metadata && (pi.metadata as any).bookingId) || undefined,
            newStatus: mapped,
            errorCode: pi.last_payment_error?.code ?? undefined,
            errorMessage: pi.last_payment_error?.message?.slice(0, 500) ?? undefined,
            amountReceived: pi.amount_received ?? undefined,
            cardBrand,
            cardLast4,
            livemode: event.livemode,
            stripeAccountId:
              typeof event.account === "string" ? event.account : undefined,
          },
        );

        // After the status transition, so the payments row exists. Separate
        // from handlePaymentIntentEvent because that mutation de-dupes on the
        // event id and returns early on replay — settlement should still land
        // if a later replay is the first time we manage to read the charge.
        if (settlement) {
          await ctx.runMutation(internal.shopInvoices._recordStripeSettlement, {
            stripePaymentIntentId: pi.id,
            ...settlement,
          });
        }
      } else if (event.type === "payment_intent.amount_capturable_updated") {
        // Pre-Job Approval flow: an incrementAuthorization or reauth just
        // raised the capturable amount on this PI. Reconcile by stamping
        // the event id on the latest booking_approvals row tied to this PI.
        // Idempotent — replays no-op.
        await ctx.runMutation(
          internal.booking_approvals._reconcileAmountCapturableUpdated,
          {
            stripePaymentIntentId: pi.id,
            stripeEventId: event.id,
            amountCapturable: pi.amount_capturable ?? undefined,
          },
        );
        // Reauth fallback: when the customer completed 3DS async on mobile
        // (`ReauthView` → `resumeReauthFromMobile` returned `requires_action`
        // → `handleNextAction` succeeded), the action couldn't clear
        // `reauth_required` synchronously. This event is the proof the PI
        // is now in `requires_capture`, so flip the booking state here.
        // Idempotent on booking state (the clear mutation no-ops when state
        // isn't `reauth_required`).
        const bookingIdMeta =
          (pi.metadata && (pi.metadata as any).bookingId) || undefined;
        if (bookingIdMeta) {
          await ctx.runMutation(
            internal.payments_stripe._clearReauthRequiredAfterSuccess,
            { bookingId: bookingIdMeta as any },
          );
        }
        await ctx.runMutation(internal.stripe_webhook_events.record, {
          eventId: event.id,
          eventType: event.type,
          livemode: event.livemode,
          stripeAccountId:
            typeof event.account === "string" ? event.account : undefined,
        });
      } else if (event.type === "payment_intent.requires_action") {
        // Card needs SCA / customer intervention. Flip the booking to
        // reauth_required and push the customer to act.
        const bookingId =
          (pi.metadata && (pi.metadata as any).bookingId) || undefined;
        if (bookingId) {
          await ctx.runMutation(
            internal.payments_stripe._revertBookingToPendingForReauth,
            { bookingId: bookingId as any },
          );
        }
        await ctx.runMutation(internal.stripe_webhook_events.record, {
          eventId: event.id,
          eventType: event.type,
          livemode: event.livemode,
          stripeAccountId:
            typeof event.account === "string" ? event.account : undefined,
        });
      }
      return new Response("ok", { status: 200 });
    }

    // Refunds — partial-aware.
    //
    // This used to map ANY charge.refunded to newStatus "refunded", which meant
    // a $5 partial refund on a $400 job marked the payment fully refunded. And
    // because "refunded" is terminal in payment_status_history's FSM, the row
    // then froze: every later transition silently no-ops, and the customer got
    // emailed a receipt saying the whole job was refunded.
    //
    // charge.refund.updated is handled too — without it a refund the bank later
    // rejects stays counted and refunded_amount_cents is overstated forever.
    if (event.type === "charge.refunded" || event.type === "charge.refund.updated") {
      const stripe = getStripeForWebhook();

      // charge.refunded carries the Charge; charge.refund.updated carries the
      // Refund, so the charge has to be fetched.
      let charge: Stripe.Charge | null = null;
      if (event.type === "charge.refunded") {
        charge = event.data.object as Stripe.Charge;
      } else {
        const refund = event.data.object as Stripe.Refund;
        const chargeId =
          typeof refund.charge === "string" ? refund.charge : refund.charge?.id;
        if (chargeId) charge = await stripe.charges.retrieve(chargeId);
      }

      if (!charge) {
        await ctx.runMutation(internal.stripe_webhook_events.record, {
          eventId: event.id,
          eventType: event.type,
          livemode: event.livemode,
        });
        return new Response("ok", { status: 200 });
      }

      const piId =
        typeof charge.payment_intent === "string"
          ? charge.payment_intent
          : charge.payment_intent?.id;

      const amountCaptured = charge.amount_captured ?? charge.amount ?? 0;
      const amountRefunded = charge.amount_refunded ?? 0;
      const fullyRefunded =
        charge.refunded === true ||
        (amountCaptured > 0 && amountRefunded >= amountCaptured);

      // Page the refunds explicitly — the list embedded in the webhook payload
      // can be truncated, and a missed refund understates the total.
      const refundList = await stripe.refunds.list({ charge: charge.id, limit: 100 });

      await ctx.runMutation(internal.shopPaymentRefunds._reconcileChargeRefund, {
        stripeEventId: event.id,
        eventType: event.type,
        stripePaymentIntentId: piId,
        stripeChargeId: charge.id,
        amountRefundedCents: amountRefunded,
        amountCapturedCents: amountCaptured,
        fullyRefunded,
        refunds: refundList.data.map((r) => ({
          id: r.id,
          amountCents: r.amount,
          status: r.status ?? "succeeded",
          reason: r.reason ?? null,
          createdMs: r.created * 1000,
        })),
        livemode: event.livemode,
        stripeAccountId:
          typeof event.account === "string" ? event.account : undefined,
      });
      return new Response("ok", { status: 200 });
    }

    if (event.type === "setup_intent.succeeded") {
      await ctx.runMutation(internal.stripe_webhook_events.record, {
        eventId: event.id,
        eventType: event.type,
        livemode: event.livemode,
        stripeAccountId:
          typeof event.account === "string" ? event.account : undefined,
      });
      return new Response("ok", { status: 200 });
    }

    if (
      event.type === "charge.dispute.created" ||
      event.type === "charge.dispute.updated"
    ) {
      const dispute = event.data.object as Stripe.Dispute;
      const chargeId =
        typeof dispute.charge === "string"
          ? dispute.charge
          : dispute.charge?.id;
      const piId =
        typeof dispute.payment_intent === "string"
          ? dispute.payment_intent
          : dispute.payment_intent?.id;
      await ctx.runMutation(internal.payment_disputes._openDispute, {
        stripeChargeId: chargeId ?? undefined,
        stripePaymentIntentId: piId ?? undefined,
        stripeDisputeId: dispute.id,
        amountCents: dispute.amount ?? 0,
        currency: dispute.currency ?? undefined,
        reason: dispute.reason ?? undefined,
        status: dispute.status ?? "needs_response",
        evidenceDueByMs:
          dispute.evidence_details?.due_by != null
            ? dispute.evidence_details.due_by * 1000
            : undefined,
      });
      await ctx.runMutation(internal.stripe_webhook_events.record, {
        eventId: event.id,
        eventType: event.type,
        livemode: event.livemode,
        stripeAccountId:
          typeof event.account === "string" ? event.account : undefined,
      });
      return new Response("ok", { status: 200 });
    }

    if (event.type === "charge.dispute.closed") {
      const dispute = event.data.object as Stripe.Dispute;
      await ctx.runMutation(internal.payment_disputes._closeDispute, {
        stripeDisputeId: dispute.id,
        status: dispute.status ?? "lost",
      });
      await ctx.runMutation(internal.stripe_webhook_events.record, {
        eventId: event.id,
        eventType: event.type,
        livemode: event.livemode,
        stripeAccountId:
          typeof event.account === "string" ? event.account : undefined,
      });
      return new Response("ok", { status: 200 });
    }

    if (
      event.type === "account.external_account.updated" ||
      event.type === "capability.updated"
    ) {
      const accountId =
        typeof event.account === "string"
          ? event.account
          : typeof (event.data.object as { account?: unknown }).account === "string"
            ? ((event.data.object as { account: string }).account)
            : null;

      if (accountId) {
        const account = await getStripeForWebhook().accounts.retrieve(accountId);
        await syncStripeConnectedAccountFromEvent(ctx, event, account);
      } else {
        await ctx.runMutation(internal.stripe_webhook_events.record, {
          eventId: event.id,
          eventType: event.type,
          livemode: event.livemode,
        });
      }

      return new Response("ok", { status: 200 });
    }

    await ctx.runMutation(internal.stripe_webhook_events.record, {
      eventId: event.id,
      eventType: event.type,
      livemode: event.livemode,
      stripeAccountId:
        typeof event.account === "string" ? event.account : undefined,
    });

    return new Response("ok", { status: 200 });
  } catch (error) {
    console.error("[Stripe Webhook] Processing failed:", error);
    return new Response("Webhook processing failed", { status: 500 });
  }
}

// ============================================
// Stripe Webhook Endpoints
// ============================================

http.route({
  path: "/stripe/webhook",
  method: "POST",
  handler: httpAction(handleStripeWebhook),
});

http.route({
  path: "/stripe/connect-webhook",
  method: "POST",
  handler: httpAction(handleStripeWebhook),
});


// ============================================
// Telnyx Messaging Webhook
// Configure in Mission Control Portal → Messaging Profile → Webhook URL.
// Failover URL can point at the same path on a backup deployment.
// ============================================

http.route({
  path: "/telnyx/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const rawBody = await request.text();
    const signature = request.headers.get("telnyx-signature-ed25519") ?? undefined;
    const timestamp = request.headers.get("telnyx-timestamp") ?? undefined;

    try {
      const result: any = await ctx.runAction(
        (internal as any).lib.telnyx_webhook.processWebhook,
        { rawBody, signature, timestamp },
      );

      if (!result?.ok) {
        const reason: string = result?.reason ?? "unknown";
        if (reason === "invalid_signature" || reason === "missing_signature_headers") {
          return new Response("Invalid signature", { status: 401 });
        }
        return new Response(`Bad request: ${reason}`, { status: 400 });
      }

      return new Response("ok", { status: 200 });
    } catch (error) {
      console.error("[Telnyx Webhook] Processing failed:", error);
      return new Response("Webhook processing failed", { status: 500 });
    }
  }),
});


// ============================================
// MCP API Endpoints
// Auth via Bearer token or ?token= query param
// Wired to internal functions in mcp_api.ts
// ============================================

const MCP_TOKEN = process.env.MCP_AUTH_TOKEN;

function checkMcpAuth(request: Request): boolean {
  // Fail CLOSED when the token is unconfigured (Jun-10 sweep review fix).
  // These routes reach internal.mcp_api.* generic table read/write — with
  // the old fail-open default, an unset env var silently exposed every
  // table (transcripts, users, semantic memory) to anonymous HTTP callers.
  // MCP_AUTH_TOKEN is set on the dev deployment; keep it set everywhere.
  if (!MCP_TOKEN) return false;
  const authHeader = request.headers.get("Authorization") || "";
  const bearerToken = authHeader.replace(/^Bearer\s+/i, "");
  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token") || "";
  return bearerToken === MCP_TOKEN || queryToken === MCP_TOKEN;
}

function unauthorized() {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401, headers: { "Content-Type": "application/json" },
  });
}

const corsHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

function corsOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
    },
  });
}

// ---- GET /mcp/schema — full schema with every table, field, index ----
http.route({
  path: "/mcp/schema",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    if (!checkMcpAuth(request)) return unauthorized();
    const result = await ctx.runQuery(internal.mcp_api.getSchema, {});
    return new Response(JSON.stringify(result, null, 2), { headers: corsHeaders });
  }),
});

// ---- POST /mcp/table/read — read documents from a table ----
// Body: { "table": "makes", "limit": 50 }
http.route({
  path: "/mcp/table/read",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!checkMcpAuth(request)) return unauthorized();
    try {
      const { table, limit } = (await request.json()) as { table: string; limit?: number };
      if (!table) return new Response(JSON.stringify({ error: "Missing 'table'" }), { status: 400, headers: corsHeaders });
      const result = await ctx.runQuery(internal.mcp_api.readTable, { table, limit });
      return new Response(JSON.stringify(result, null, 2), { headers: corsHeaders });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }),
});

// ---- POST /mcp/table/count — count documents in a table ----
// Body: { "table": "makes" }
http.route({
  path: "/mcp/table/count",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!checkMcpAuth(request)) return unauthorized();
    try {
      const { table } = (await request.json()) as { table: string };
      if (!table) return new Response(JSON.stringify({ error: "Missing 'table'" }), { status: 400, headers: corsHeaders });
      const result = await ctx.runQuery(internal.mcp_api.countTable, { table });
      return new Response(JSON.stringify(result, null, 2), { headers: corsHeaders });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }),
});

// ---- POST /mcp/table/stats — get document counts for multiple tables ----
// Body: { "tables": ["makes", "models"] } or {} for all tables
http.route({
  path: "/mcp/table/stats",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!checkMcpAuth(request)) return unauthorized();
    try {
      const { tables } = (await request.json()) as { tables?: string[] };
      const result = await ctx.runQuery(internal.mcp_api.getTableStats, { tables });
      return new Response(JSON.stringify(result, null, 2), { headers: corsHeaders });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }),
});

// ---- POST /mcp/doc — get a single document by Convex ID ----
// Body: { "id": "k57..." }
http.route({
  path: "/mcp/doc",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!checkMcpAuth(request)) return unauthorized();
    try {
      const { id } = (await request.json()) as { id: string };
      if (!id) return new Response(JSON.stringify({ error: "Missing 'id'" }), { status: 400, headers: corsHeaders });
      const result = await ctx.runQuery(internal.mcp_api.getById, { id });
      if (!result) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: corsHeaders });
      return new Response(JSON.stringify(result, null, 2), { headers: corsHeaders });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }),
});

// ---- POST /mcp/table/query — search a table by index ----
// Body: { "table": "models", "index": "by_make_id", "value": "k57...", "limit": 50 }
http.route({
  path: "/mcp/table/query",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!checkMcpAuth(request)) return unauthorized();
    try {
      const { table, index, value, limit } = (await request.json()) as {
        table: string; index: string; value: any; limit?: number;
      };
      if (!table || !index) return new Response(JSON.stringify({ error: "Missing 'table' or 'index'" }), { status: 400, headers: corsHeaders });
      const result = await ctx.runQuery(internal.mcp_api.queryByIndex, { table, index, value, limit });
      return new Response(JSON.stringify(result, null, 2), { headers: corsHeaders });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }),
});

// ============================================
// MCP Write Endpoints
// ============================================

// ---- POST /mcp/doc/insert — insert a document into a table ----
// Body: { "table": "makes", "doc": { "name": "Toyota", "slug": "toyota" } }
http.route({
  path: "/mcp/doc/insert",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!checkMcpAuth(request)) return unauthorized();
    try {
      const { table, doc } = (await request.json()) as { table: string; doc: any };
      if (!table || !doc) return new Response(JSON.stringify({ error: "Missing 'table' or 'doc'" }), { status: 400, headers: corsHeaders });
      const result = await ctx.runMutation(internal.mcp_api.insertDoc, { table, doc });
      return new Response(JSON.stringify(result, null, 2), { status: 201, headers: corsHeaders });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }),
});

// ---- POST /mcp/doc/update — patch fields on a document ----
// Body: { "id": "k57...", "fields": { "name": "Updated Name" } }
http.route({
  path: "/mcp/doc/update",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!checkMcpAuth(request)) return unauthorized();
    try {
      const { id, fields } = (await request.json()) as { id: string; fields: any };
      if (!id || !fields) return new Response(JSON.stringify({ error: "Missing 'id' or 'fields'" }), { status: 400, headers: corsHeaders });
      const result = await ctx.runMutation(internal.mcp_api.updateDoc, { id, fields });
      return new Response(JSON.stringify(result, null, 2), { headers: corsHeaders });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }),
});

// ---- POST /mcp/doc/replace — replace a document entirely ----
// Body: { "id": "k57...", "doc": { "name": "Toyota", "slug": "toyota", ... } }
http.route({
  path: "/mcp/doc/replace",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!checkMcpAuth(request)) return unauthorized();
    try {
      const { id, doc } = (await request.json()) as { id: string; doc: any };
      if (!id || !doc) return new Response(JSON.stringify({ error: "Missing 'id' or 'doc'" }), { status: 400, headers: corsHeaders });
      const result = await ctx.runMutation(internal.mcp_api.replaceDoc, { id, doc });
      return new Response(JSON.stringify(result, null, 2), { headers: corsHeaders });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }),
});

// ---- POST /mcp/doc/delete — delete a document by ID ----
// Body: { "id": "k57..." }
http.route({
  path: "/mcp/doc/delete",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!checkMcpAuth(request)) return unauthorized();
    try {
      const { id } = (await request.json()) as { id: string };
      if (!id) return new Response(JSON.stringify({ error: "Missing 'id'" }), { status: 400, headers: corsHeaders });
      const result = await ctx.runMutation(internal.mcp_api.deleteDoc, { id });
      return new Response(JSON.stringify(result, null, 2), { headers: corsHeaders });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }),
});

// ---- POST /mcp/table/bulk-insert — insert multiple documents at once ----
// Body: { "table": "makes", "docs": [{ "name": "Toyota" }, { "name": "Honda" }] }
http.route({
  path: "/mcp/table/bulk-insert",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!checkMcpAuth(request)) return unauthorized();
    try {
      const { table, docs } = (await request.json()) as { table: string; docs: any[] };
      if (!table || !docs) return new Response(JSON.stringify({ error: "Missing 'table' or 'docs'" }), { status: 400, headers: corsHeaders });
      const result = await ctx.runMutation(internal.mcp_api.bulkInsert, { table, docs });
      return new Response(JSON.stringify(result, null, 2), { status: 201, headers: corsHeaders });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }),
});

// ---- POST /mcp/doc/bulk-delete — delete multiple documents by IDs ----
// Body: { "ids": ["k57...", "k58..."] }
http.route({
  path: "/mcp/doc/bulk-delete",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!checkMcpAuth(request)) return unauthorized();
    try {
      const { ids } = (await request.json()) as { ids: string[] };
      if (!ids || !Array.isArray(ids)) return new Response(JSON.stringify({ error: "Missing 'ids' array" }), { status: 400, headers: corsHeaders });
      const result = await ctx.runMutation(internal.mcp_api.bulkDelete, { ids });
      return new Response(JSON.stringify(result, null, 2), { headers: corsHeaders });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }),
});

// ---- POST /mcp/action/run — execute any internal action by function path ----
// Body: { "functionPath": "vehicleEnrichment/v3pipeline:enrichVehicleBatchV3", "args": { ... } }
http.route({
  path: "/mcp/action/run",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!checkMcpAuth(request)) return unauthorized();
    try {
      const { functionPath, args } = (await request.json()) as { functionPath: string; args?: any };
      if (!functionPath) return new Response(JSON.stringify({ error: "Missing 'functionPath'" }), { status: 400, headers: corsHeaders });

      // Resolve the function reference from the internal API tree
      // Path format: "module/file:exportName" e.g. "vehicleEnrichment/v3pipeline:enrichVehicleBatchV3"
      const [modulePath, exportName] = functionPath.includes(":")
        ? functionPath.split(":")
        : [functionPath, "default"];

      const segments = modulePath.split("/");
      let ref: any = internal;
      for (const seg of segments) {
        ref = ref?.[seg];
        if (!ref) {
          return new Response(
            JSON.stringify({ error: `Function not found: ${functionPath} (failed at segment '${seg}')` }),
            { status: 404, headers: corsHeaders },
          );
        }
      }

      const fn = ref[exportName];
      if (!fn) {
        return new Response(
          JSON.stringify({ error: `Export '${exportName}' not found in module '${modulePath}'` }),
          { status: 404, headers: corsHeaders },
        );
      }

      const result = await ctx.runAction(fn, args ?? {});
      return new Response(JSON.stringify(result ?? { status: "ok" }, null, 2), { headers: corsHeaders });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }),
});


// ---- CORS OPTIONS for all /mcp/* routes ----
const mcpPaths = [
  "/mcp/schema", "/mcp/table/read", "/mcp/table/count", "/mcp/table/stats",
  "/mcp/doc", "/mcp/table/query",
  "/mcp/doc/insert", "/mcp/doc/update", "/mcp/doc/replace", "/mcp/doc/delete",
  "/mcp/table/bulk-insert", "/mcp/doc/bulk-delete",
  "/mcp/action/run",
];
for (const path of mcpPaths) {
  http.route({ path, method: "OPTIONS", handler: httpAction(async () => corsOptions()) });
}

// ════════════════════════════════════════════════════════════════════════════
// External Data API v0 (Data spec §12) — key-authed, layer-gated, metered.
// See convex/dataApi.ts for assembly + the A+D+E sellability gate.
// ════════════════════════════════════════════════════════════════════════════

function apiJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Shared auth + rate-limit wrapper for the /v0 endpoints. Handlers get the
 *  authenticated key as a second arg for per-key quota checks (enrich/image). */
async function withApiKey(
  ctx: ActionCtx,
  request: Request,
  endpoint: string,
  scope: ApiScope,
  handler: (
    params: URLSearchParams,
    key: KeyAuth,
  ) => Promise<{ status: number; body: unknown; config_key?: string }>,
): Promise<Response> {
  const auth = request.headers.get("Authorization");
  const rawKey = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : request.headers.get("x-api-key")?.trim();
  if (!rawKey || !rawKey.startsWith("otp_")) {
    return apiJson(401, {
      error: "missing_api_key",
      message: "Pass your key as 'Authorization: Bearer otp_live_…' or 'x-api-key'.",
    });
  }

  const key = await ctx.runQuery(internal.dataApi.lookupKeyByHash, { key_hash: await sha256Hex(rawKey) });
  if (!key) return apiJson(401, { error: "invalid_api_key", message: "Unknown API key." });
  if (key.revoked) return apiJson(401, { error: "revoked_api_key", message: "This key has been revoked." });
  if (!key.scopes.includes(scope)) {
    await ctx.runMutation(internal.dataApi.recordUsage, { api_key_id: key.keyId, endpoint, status: 403 });
    return apiJson(403, { error: "insufficient_scope", message: `This key lacks the '${scope}' scope.` });
  }

  const usedLastMinute = await ctx.runQuery(internal.dataApi.countRecentUsage, {
    api_key_id: key.keyId,
    since: Date.now() - 60_000,
  });
  if (usedLastMinute >= key.rate_limit_per_min) {
    await ctx.runMutation(internal.dataApi.recordUsage, { api_key_id: key.keyId, endpoint, status: 429 });
    return apiJson(429, {
      error: "rate_limited",
      message: `Limit is ${key.rate_limit_per_min} requests/minute for this key.`,
    });
  }

  const result = await handler(new URL(request.url).searchParams, key);
  await ctx.runMutation(internal.dataApi.recordUsage, {
    api_key_id: key.keyId,
    endpoint,
    status: result.status,
    config_key: result.config_key,
  });
  return apiJson(result.status, result.body);
}

http.route({
  path: "/v0/maintenance",
  method: "GET",
  handler: httpAction(async (ctx, request) =>
    withApiKey(ctx, request, "/v0/maintenance", "maintenance:read", async (params) => {
      const config_key = params.get("config_key") ?? undefined;
      const vin = params.get("vin") ?? undefined;
      if (!config_key && !vin) {
        return { status: 400, body: { error: "missing_param", message: "Pass ?config_key=… or ?vin=…" } };
      }
      const data = await ctx.runQuery(internal.dataApi.assembleMaintenance, { config_key, vin });
      if (!data) {
        return {
          status: 404,
          body: { error: "not_found", message: "No enriched vehicle config matches that identifier." },
          config_key,
        };
      }
      return { status: 200, body: data, config_key: data.config.config_key ?? config_key };
    }),
  ),
});

http.route({
  path: "/v0/labor",
  method: "GET",
  handler: httpAction(async (ctx, request) =>
    withApiKey(ctx, request, "/v0/labor", "labor:read", async (params) => {
      const config_key = params.get("config_key") ?? undefined;
      const vin = params.get("vin") ?? undefined;
      const service = params.get("service") ?? undefined;
      if (!config_key && !vin) {
        return { status: 400, body: { error: "missing_param", message: "Pass ?config_key=… or ?vin=…" } };
      }
      const data = await ctx.runQuery(internal.dataApi.assembleLabor, { config_key, vin, service });
      if (!data) {
        return {
          status: 404,
          body: { error: "not_found", message: "No enriched vehicle config matches that identifier." },
          config_key,
        };
      }
      return { status: 200, body: data, config_key: data.config_key ?? config_key };
    }),
  ),
});

// The flagship endpoint: everything we hold on one vehicle. Accepts
// config_key, vin, OR year+make+model[+trim] — YMMT resolves against the
// config_key prefix and returns a multiple_matches disambiguation (409) when
// more than one config fits.
http.route({
  path: "/v0/vehicle",
  method: "GET",
  handler: httpAction(async (ctx, request) =>
    withApiKey(ctx, request, "/v0/vehicle", "maintenance:read", async (params) => {
      const config_key = params.get("config_key") ?? undefined;
      const vin = params.get("vin") ?? undefined;
      const yearRaw = params.get("year");
      const year = yearRaw ? Number(yearRaw) : undefined;
      const make = params.get("make") ?? undefined;
      const model = params.get("model") ?? undefined;
      const trim = params.get("trim") ?? undefined;
      const hasYmmt = year !== undefined && !Number.isNaN(year) && make && model;
      if (!config_key && !vin && !hasYmmt) {
        return {
          status: 400,
          body: {
            error: "missing_param",
            message: "Pass ?vin=… OR ?year=&make=&model=[&trim=] OR ?config_key=…",
          },
        };
      }
      const data = await ctx.runQuery(internal.dataApi.assembleVehicle, {
        config_key,
        vin,
        year: hasYmmt ? year : undefined,
        make,
        model,
        trim,
      });
      if (!data) {
        return {
          status: 404,
          body: { error: "not_found", message: "No enriched vehicle matches that identifier." },
          config_key,
        };
      }
      if (data.object === "multiple_matches") {
        return {
          status: 409,
          body: {
            error: "multiple_matches",
            message: "More than one config matches — retry with ?config_key= from the list (or add &trim=).",
            matches: data.matches,
          },
        };
      }
      return { status: 200, body: data, config_key: data.config.config_key ?? config_key };
    }),
  ),
});

// Vehicle media (scope media:read) — cached VD/EVOX render per config; URLs
// flip to self-hosted storage when the licensed VD image folder lands.
// Cache-first; on a miss spends ONE live VDB fetch (metered as the pseudo-
// endpoint "/v0/vehicle-image:vdb_fetch", capped per key per day), persists
// first-fetched-wins, and re-assembles so the response shape never changes.
http.route({
  path: "/v0/vehicle-image",
  method: "GET",
  handler: httpAction(async (ctx, request) =>
    withApiKey(ctx, request, "/v0/vehicle-image", "media:read", async (params, key) => {
      const config_key = params.get("config_key") ?? undefined;
      const vin = params.get("vin") ?? undefined;
      const yearRaw = params.get("year");
      const year = yearRaw ? Number(yearRaw) : undefined;
      const make = params.get("make") ?? undefined;
      const model = params.get("model") ?? undefined;
      const trim = params.get("trim") ?? undefined;
      const hasYmmt = year !== undefined && !Number.isNaN(year) && make && model;
      if (!config_key && !vin && !hasYmmt) {
        return {
          status: 400,
          body: {
            error: "missing_param",
            message: "Pass ?vin=… OR ?year=&make=&model=[&trim=] OR ?config_key=…",
          },
        };
      }
      const data = await ctx.runQuery(internal.dataApi.assembleVehicleImage, {
        config_key,
        vin,
        year: hasYmmt ? year : undefined,
        make,
        model,
        trim,
      });
      if (!data) {
        return {
          status: 404,
          body: { error: "not_found", message: "No vehicle matches that identifier." },
          config_key,
        };
      }
      if (data.object === "multiple_matches") {
        return {
          status: 409,
          body: {
            error: "multiple_matches",
            message: "More than one config matches — retry with ?config_key= from the list (or add &trim=).",
            matches: data.matches,
          },
        };
      }
      if (data.image === null) {
        const resolvedKey = data.config.config_key ?? config_key ?? null;
        const fetchesToday = await ctx.runQuery(internal.dataApi.countUsageForEndpointSince, {
          api_key_id: key.keyId,
          endpoint: "/v0/vehicle-image:vdb_fetch",
          since: Date.now() - 24 * 60 * 60 * 1000,
        });
        if (fetchesToday >= IMAGE_LIVE_FETCH_DAILY_CAP) {
          return {
            status: 404,
            body: {
              error: "no_image",
              message:
                `Vehicle resolved but no image is cached, and this key's live-fetch cap ` +
                `(${IMAGE_LIVE_FETCH_DAILY_CAP}/day) is reached. Cached lookups remain unlimited.`,
              config_key: resolvedKey,
            },
            config_key: resolvedKey ?? undefined,
          };
        }
        // Live VDB fetch (~6s worst case) — persists onto vehicles/config rows
        // via resolveVehicleImage, so the next call is a cache hit. A sibling
        // VIN of the config drives the reliable VDB VIN endpoint (its YMMT
        // endpoint wants VDB's own verbose trim names and rarely matches).
        const cfg = resolvedKey
          ? await ctx.runQuery(internal.dataApi.configForImageFetch, { config_key: resolvedKey })
          : null;
        const cfgMake = data.config.make !== "?" ? data.config.make : undefined;
        const cfgModel = data.config.model !== "?" ? data.config.model : undefined;
        const url = await ctx.runAction(internal.lib.vehicle_image.resolveVehicleImage, {
          vin: vin ?? cfg?.sibling_vin ?? undefined,
          year: hasYmmt ? year : data.config.year,
          make: make ?? cfgMake,
          model: model ?? cfgModel,
          trim: trim ?? data.config.trim ?? undefined,
          vehicle_config_id: cfg?.id ?? undefined,
        });
        await ctx.runMutation(internal.dataApi.recordUsage, {
          api_key_id: key.keyId,
          endpoint: "/v0/vehicle-image:vdb_fetch",
          status: url ? 200 : 404,
          config_key: resolvedKey ?? undefined,
        });
        if (url) {
          const refreshed = await ctx.runQuery(internal.dataApi.assembleVehicleImage, {
            config_key: resolvedKey ?? undefined,
            vin,
          });
          if (refreshed && refreshed.object === "vehicle_image" && refreshed.image !== null) {
            return { status: 200, body: refreshed, config_key: resolvedKey ?? undefined };
          }
        }
        return {
          status: 404,
          body: {
            error: "no_image",
            message: "Vehicle resolved but no image could be fetched for it.",
            config_key: resolvedKey,
          },
          config_key: resolvedKey ?? undefined,
        };
      }
      return { status: 200, body: data, config_key: data.config.config_key ?? config_key };
    }),
  ),
});

// ── /v0/enrich (scope enrich:write) — grow-the-dataset trigger. ─────────────
// POST {vin}: fresh cache hit (complete/verified within 180d) → 200, free;
// already in-flight → 200, free; otherwise decode + schedule the v3 batch
// pipeline (7-40 min) → 202 — the ONLY response that consumes the daily
// quota (metered off api_usage status=202 rows). GET is the free status poll.

const ENRICH_FRESH_MS = 180 * 24 * 60 * 60 * 1000; // mirrors confirmVehicleForUser's staleness window

/** Coarse public status for a config's enrichment_status. */
function publicEnrichStatus(s: string | null): "complete" | "enriching" | "failed" | "incomplete" {
  if (s === "complete" || s === "verified") return "complete";
  if (s === "enriching" || s === "pending") return "enriching";
  if (s === "failed") return "failed";
  return "incomplete"; // partial / null / anything the pipeline adds later
}

http.route({
  path: "/v0/enrich",
  method: "POST",
  handler: httpAction(async (ctx, request) =>
    withApiKey(ctx, request, "/v0/enrich", "enrich:write", async (params, key) => {
      const body = (await request.json().catch(() => ({}))) as { vin?: unknown };
      const vinRaw = typeof body.vin === "string" ? body.vin : params.get("vin");
      const vin = vinRaw?.trim().toUpperCase();
      if (!vin) {
        return {
          status: 400,
          body: { error: "missing_param", message: 'Pass {"vin":"…"} in the JSON body (or ?vin=…).' },
        };
      }
      if (vin.length !== 17) {
        return { status: 400, body: { error: "invalid_vin", message: "A VIN is exactly 17 characters." } };
      }

      const existing = await ctx.runQuery(internal.dataApi.getEnrichStatusByVin, { vin });
      const fresh =
        existing != null &&
        (existing.enrichment_status === "complete" || existing.enrichment_status === "verified") &&
        existing.last_enriched_at != null &&
        existing.last_enriched_at >= Date.now() - ENRICH_FRESH_MS;
      if (existing && fresh) {
        return {
          status: 200,
          body: {
            object: "enrichment",
            status: "complete",
            config: {
              config_key: existing.config_key,
              year: existing.year,
              make: existing.make,
              model: existing.model,
              trim: existing.trim,
            },
            enrichment_status: existing.enrichment_status,
            fill_rate: existing.fill_rate,
            note: "Cache hit — already enriched (free, no quota). Fetch the full payload via GET /v0/vehicle?vin=…",
          },
          config_key: existing.config_key ?? undefined,
        };
      }
      if (existing && (existing.enrichment_status === "enriching" || existing.enrichment_status === "pending")) {
        return {
          status: 200,
          body: {
            object: "enrichment",
            status: "enriching",
            config_key: existing.config_key,
            poll: { method: "GET", url: `/v0/enrich?vin=${vin}`, interval_seconds: 60 },
          },
          config_key: existing.config_key ?? undefined,
        };
      }

      const scheduledToday = await ctx.runQuery(internal.dataApi.countUsageForEndpointSince, {
        api_key_id: key.keyId,
        endpoint: "/v0/enrich",
        since: Date.now() - 24 * 60 * 60 * 1000,
        status: 202,
      });
      if (scheduledToday >= ENRICH_DAILY_QUOTA) {
        return {
          status: 429,
          body: {
            error: "quota_exceeded",
            message: `Daily enrichment quota (${ENRICH_DAILY_QUOTA} scheduled runs/day/key) reached. Cache hits stay free and unlimited.`,
          },
        };
      }

      const result = await ctx.runAction(internal.dataApiEnrich.triggerEnrichForVin, { vin });
      if (result.status === "decode_failed") {
        return {
          status: 400,
          body: { error: "vin_decode_failed", message: "The VIN did not decode against Vehicle Databases or NHTSA." },
        };
      }
      if (result.status === "no_engine_code") {
        return {
          status: 422,
          body: {
            error: "unsupported_vehicle",
            message: "The VIN decoded but no engine code could be resolved — this vehicle cannot be enriched.",
          },
        };
      }
      if (result.status === "vehicle_upsert_failed") {
        return { status: 500, body: { error: "internal_error", message: "Vehicle row creation failed — retry later." } };
      }
      return {
        status: 202,
        body: {
          object: "enrichment",
          status: "queued",
          vin,
          poll: {
            method: "GET",
            url: `/v0/enrich?vin=${vin}`,
            interval_seconds: 60,
            note: "Enrichment typically completes in 7-40 minutes. Fetch the full payload via GET /v0/vehicle?vin=… once complete.",
          },
        },
      };
    }),
  ),
});

http.route({
  path: "/v0/enrich",
  method: "GET",
  handler: httpAction(async (ctx, request) =>
    withApiKey(ctx, request, "/v0/enrich", "enrich:write", async (params) => {
      const vin = params.get("vin") ?? undefined;
      const config_key = params.get("config_key") ?? undefined;
      if (!vin && !config_key) {
        return { status: 400, body: { error: "missing_param", message: "Pass ?vin=… or ?config_key=…" } };
      }
      const s = await ctx.runQuery(internal.dataApi.getEnrichStatusByVin, { vin, config_key });
      if (!s) {
        return {
          status: 404,
          body: {
            error: "not_found",
            message: "Nothing is known for that identifier — POST /v0/enrich {vin} to enrich it.",
          },
          config_key,
        };
      }
      return {
        status: 200,
        body: {
          object: "enrichment_status",
          status: publicEnrichStatus(s.enrichment_status),
          config_key: s.config_key,
          enrichment_status: s.enrichment_status,
          last_enriched_at: s.last_enriched_at,
          fill_rate: s.fill_rate,
        },
        config_key: s.config_key ?? undefined,
      };
    }),
  ),
});

// ── /v0/service-history (scope service_history:read) — sanitized records ────
// Carfax-style per-VIN history: dates, mileage, services, parts. No PII, no
// costs, no shop identity, no free-text notes (see dataApi.assembleServiceHistory).
http.route({
  path: "/v0/service-history",
  method: "GET",
  handler: httpAction(async (ctx, request) =>
    withApiKey(ctx, request, "/v0/service-history", "service_history:read", async (params) => {
      const vin = params.get("vin");
      if (!vin) {
        return { status: 400, body: { error: "missing_param", message: "Pass ?vin=…" } };
      }
      const data = await ctx.runQuery(internal.dataApi.assembleServiceHistory, { vin });
      if (!data) {
        return {
          status: 404,
          body: { error: "not_found", message: "No vehicle or service records are known for that VIN." },
        };
      }
      return { status: 200, body: data };
    }),
  ),
});

for (const path of [
  "/v0/maintenance",
  "/v0/labor",
  "/v0/vehicle",
  "/v0/vehicle-image",
  "/v0/enrich",
  "/v0/service-history",
]) {
  http.route({ path, method: "OPTIONS", handler: httpAction(async () => corsOptions()) });
}

export default http;
