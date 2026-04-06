/**
 * Convex HTTP Router
 * 
 * Exposes webhook endpoints for external services.
 * Supports both v2 (schedule-based) and v3 (signal-based) Smartcar webhooks.
 * 
 * Webhook URL to register in Smartcar dashboard:
 *   https://<your-deployment>.convex.site/smartcar/webhook
 */

import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

// ============================================
// Smartcar Webhook Endpoint
// ============================================

http.route({
  path: "/smartcar/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      // Read the raw body text FIRST (needed for signature verification)
      const rawBody = await request.text();
      const body = JSON.parse(rawBody);
      const signature = request.headers.get("sc-signature");

      // ── Detect event type early (VERIFY skips signature check) ──
      const eventType = body.eventType || body.type;
      // v4 puts vehicleId at data.vehicle.id, v2 at body.vehicleId
      const vehicleId = body.vehicleId || body.data?.vehicle?.id;

      // ── Verify webhook signature (skip for VERIFY events) ──
      const managementToken = process.env.SMARTCAR_MANAGEMENT_TOKEN;
      if (eventType !== "VERIFY" && managementToken && signature) {
        const isValid = await verifySignature(rawBody, signature, managementToken);
        if (!isValid) {
          console.error("[Webhook] Invalid signature — rejecting request");
          return new Response(
            JSON.stringify({ error: "Invalid signature" }),
            { status: 401, headers: { "Content-Type": "application/json" } }
          );
        }
      }

      console.log(`[Webhook] Received: eventType=${eventType || "unknown"}, vehicleId=${vehicleId || "N/A"}, eventId=${body.eventId || "N/A"}, version=${body.meta?.version || "?"}, signalCount=${body.data?.signals?.length ?? 0}`);

      // ── Handle VERIFY event (v3 webhooks) ──
      if (eventType === "VERIFY") {
        const challenge = body.data?.challenge;
        if (!challenge) {
          return new Response(
            JSON.stringify({ error: "Missing challenge" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
        // Hash the challenge with the management token
        if (!managementToken) {
          console.error("[Webhook] SMARTCAR_MANAGEMENT_TOKEN not set — cannot verify");
          return new Response(
            JSON.stringify({ error: "Server not configured for verification" }),
            { status: 500, headers: { "Content-Type": "application/json" } }
          );
        }
        const hashedChallenge = await hashChallenge(managementToken, challenge);
        console.log("[Webhook] VERIFY challenge responded");
        return new Response(
          JSON.stringify({ challenge: hashedChallenge }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      // ── Handle VEHICLE_STATE event (v3 signals webhook) ──
      if (eventType === "VEHICLE_STATE" && body.data?.signals) {
        if (!vehicleId) {
          console.error("[Webhook] VEHICLE_STATE missing vehicleId");
          return new Response(
            JSON.stringify({ error: "Missing vehicleId" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }

        // Extract signals from the payload
        const signals = body.data.signals as WebhookSignal[];
        const signalCodes = signals.map((s) => `${s.code}${s.status?.error ? "(ERR)" : ""}`).join(", ");
        console.log(`[Webhook] VEHICLE_STATE: ${signals.length} signals for vehicle=${vehicleId}: [${signalCodes}]`);

        // Dispatch to internal action for processing signals directly
        await ctx.runAction(internal.smartcar.processWebhookSignals, {
          smartcarVehicleId: vehicleId,
          signals: signals.map((s) => ({
            code: s.code,
            name: s.name,
            group: s.group,
            body: s.body || null,
            hasError: !!s.status?.error,
          })),
          eventId: body.eventId || "",
        });

        return new Response(
          JSON.stringify({ received: true }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      // ── Handle VEHICLE_ERROR event (v3) ──
      if (eventType === "VEHICLE_ERROR") {
        console.log(`[Webhook] VEHICLE_ERROR for vehicle=${vehicleId}:`, JSON.stringify(body.data)?.slice(0, 300));
        return new Response(
          JSON.stringify({ received: true }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      // ── Handle v2 schedule-based webhooks (legacy) ──
      if (vehicleId) {
        await ctx.runAction(internal.smartcar.syncVehicleFromWebhook, {
          smartcarVehicleId: vehicleId,
          eventType: eventType || "unknown",
        });

        console.log(`[Webhook] Dispatched v2 sync for vehicleId=${vehicleId}`);
      } else {
        console.error("[Webhook] Missing vehicleId in payload");
      }

      return new Response(
        JSON.stringify({ received: true }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    } catch (error) {
      // Always return 200 on internal errors to prevent Smartcar from retrying
      console.error("[Webhook] Error processing webhook:", error);
      return new Response(
        JSON.stringify({ received: true, warning: "Processing error logged" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
  }),
});

// ============================================
// Types
// ============================================

interface WebhookSignal {
  code: string;
  name: string;
  group: string;
  body?: any;
  status?: { error?: { code: string; type: string }; value?: string };
  meta?: { oemUpdatedAt?: number; fetchedAt?: number };
}

// ============================================
// Smartcar Webhook Signature Verification
// ============================================

async function verifySignature(
  rawBody: string,
  signature: string,
  managementToken: string
): Promise<boolean> {
  if (!signature || !managementToken) return false;
  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(managementToken),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
    const expected = Array.from(new Uint8Array(signed))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return expected === signature;
  } catch (err) {
    console.error("[Webhook] Signature verification error:", err);
    return false;
  }
}

// ============================================
// VERIFY Challenge Hash
// ============================================

async function hashChallenge(
  managementToken: string,
  challenge: string
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(managementToken),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(challenge));
  return Array.from(new Uint8Array(signed))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

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

// ---- CORS OPTIONS for all /mcp/* routes ----
const mcpPaths = [
  "/mcp/schema", "/mcp/table/read", "/mcp/table/count", "/mcp/table/stats",
  "/mcp/doc", "/mcp/table/query",
  "/mcp/doc/insert", "/mcp/doc/update", "/mcp/doc/replace", "/mcp/doc/delete",
  "/mcp/table/bulk-insert", "/mcp/doc/bulk-delete",
];
for (const path of mcpPaths) {
  http.route({ path, method: "OPTIONS", handler: httpAction(async () => corsOptions()) });
}

export default http;
