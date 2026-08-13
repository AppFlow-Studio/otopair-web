/**
 * telnyx_webhook.ts — Verifies Telnyx Ed25519 signatures and routes events.
 *
 * Runs in the Node runtime because Ed25519 verification uses `node:crypto`.
 * The httpAction at `/telnyx/webhook` (convex/http.ts) hands us the raw
 * body + headers; we verify, parse, and dispatch to the persistence
 * mutations in `convex/telnyx.ts`.
 *
 * Env vars required:
 *   - TELNYX_PUBLIC_KEY: base64-encoded Ed25519 public key from the
 *     Mission Control Portal → Account → API Keys → Webhook signing key.
 *
 * The signed payload format Telnyx uses is: `${timestamp}|${rawBody}`.
 * Reject anything with a timestamp older than 5 minutes to block replays.
 */
"use node";

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import crypto from "node:crypto";

const MAX_AGE_SECONDS = 5 * 60;

function verifySignature(
  rawBody: string,
  signatureB64: string,
  timestamp: string,
  publicKeyB64: string,
): boolean {
  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > MAX_AGE_SECONDS) {
    return false;
  }

  const signedPayload = Buffer.from(`${timestamp}|${rawBody}`, "utf8");
  const signature = Buffer.from(signatureB64, "base64");
  const publicKeyDer = Buffer.concat([
    // SubjectPublicKeyInfo prefix for Ed25519 (RFC 8410)
    Buffer.from("302a300506032b6570032100", "hex"),
    Buffer.from(publicKeyB64, "base64"),
  ]);
  const publicKey = crypto.createPublicKey({
    key: publicKeyDer,
    format: "der",
    type: "spki",
  });

  try {
    return crypto.verify(null, signedPayload, publicKey, signature);
  } catch {
    return false;
  }
}

async function handleWebhook(ctx: any, args: {
  rawBody: string;
  signature?: string;
  timestamp?: string;
}): Promise<{ ok: boolean; reason?: string; eventType?: string; ignored?: boolean }> {
  const publicKey = process.env.TELNYX_PUBLIC_KEY;
  if (!publicKey) {
    throw new Error("Missing TELNYX_PUBLIC_KEY env var");
  }
  if (!args.signature || !args.timestamp) {
    return { ok: false, reason: "missing_signature_headers" };
  }
  if (!verifySignature(args.rawBody, args.signature, args.timestamp, publicKey)) {
    return { ok: false, reason: "invalid_signature" };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(args.rawBody);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }

  const data = parsed?.data;
  if (!data || typeof data !== "object") {
    return { ok: false, reason: "missing_data" };
  }

  const eventId: string | undefined = data.id;
  const eventType: string | undefined = data.event_type;
  const occurredAt: string | undefined = data.occurred_at;
  const payload = data.payload ?? {};

  if (!eventId || !eventType) {
    return { ok: false, reason: "missing_event_fields" };
  }

  const occurredAtMs = occurredAt ? Date.parse(occurredAt) : Date.now();
  const telnyxMessageId: string = payload?.id ?? "";

  if (eventType === "message.received") {
    const fromPhone: string = payload?.from?.phone_number ?? "";
    const toEntries: Array<any> = Array.isArray(payload?.to) ? payload.to : [];
    const toPhone: string = toEntries[0]?.phone_number ?? "";

    await ctx.runMutation((internal as any).telnyx.recordInboundMessage, {
      eventId,
      telnyxMessageId,
      fromPhone,
      toPhone,
      text: typeof payload?.text === "string" ? payload.text : undefined,
      messageType: typeof payload?.type === "string" ? payload.type : undefined,
      media: Array.isArray(payload?.media) ? payload.media : undefined,
      occurredAtMs,
      rawPayload: parsed,
    });

    return { ok: true, eventType };
  }

  if (eventType === "message.sent" || eventType === "message.finalized") {
    const direction: string | undefined = payload?.direction;
    const fromPhone: string | undefined = payload?.from?.phone_number;
    const toEntries: Array<any> = Array.isArray(payload?.to) ? payload.to : [];
    const firstTo = toEntries[0] ?? {};
    const toPhone: string | undefined = firstTo?.phone_number;
    const status: string | undefined = firstTo?.status;
    const errors = Array.isArray(payload?.errors) ? payload.errors : undefined;

    await ctx.runMutation((internal as any).telnyx.recordMessageEvent, {
      eventId,
      eventType,
      telnyxMessageId,
      direction,
      fromPhone,
      toPhone,
      status,
      errors,
      occurredAtMs,
      rawPayload: parsed,
    });

    return { ok: true, eventType };
  }

  // Unknown event type — still ack so Telnyx stops retrying, but record it.
  await ctx.runMutation((internal as any).telnyx.recordMessageEvent, {
    eventId,
    eventType,
    telnyxMessageId,
    occurredAtMs,
    rawPayload: parsed,
  });

  return { ok: true, eventType, ignored: true };
}

export const processWebhook = (internalAction as any)({
  args: {
    rawBody: v.string(),
    signature: v.optional(v.string()),
    timestamp: v.optional(v.string()),
  },
  handler: handleWebhook,
});
