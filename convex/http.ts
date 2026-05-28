/**
 * Convex HTTP Router
 *
 * Exposes webhook endpoints for external services (Stripe + MCP API).
 */

import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
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
            livemode: event.livemode,
            stripeAccountId:
              typeof event.account === "string" ? event.account : undefined,
          },
        );
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

    if (event.type === "charge.refunded") {
      const charge = event.data.object as Stripe.Charge;
      const piId =
        typeof charge.payment_intent === "string"
          ? charge.payment_intent
          : charge.payment_intent?.id;
      if (piId) {
        const pi = await getStripeForWebhook().paymentIntents.retrieve(piId);
        await ctx.runMutation(
          internal.payments_stripe.handlePaymentIntentEvent,
          {
            stripeEventId: event.id,
            eventType: event.type,
            paymentIntentId: piId,
            bookingId:
              (pi.metadata && (pi.metadata as any).bookingId) || undefined,
            newStatus: "refunded",
            livemode: event.livemode,
            stripeAccountId:
              typeof event.account === "string" ? event.account : undefined,
          },
        );
      } else {
        await ctx.runMutation(internal.stripe_webhook_events.record, {
          eventId: event.id,
          eventType: event.type,
          livemode: event.livemode,
        });
      }
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
  if (!MCP_TOKEN) return true;
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
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

export default http;
