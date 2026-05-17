/**
 * sms-provider.ts — Provider-agnostic SMS dispatch shim.
 *
 * Real Twilio / Yassin's vendor integration lands later. For now the
 * function signature is locked, the call is observable via
 * `sms_delivery_log`, and the rest of the system can rely on a single
 * entry point that won't change when the provider gets wired up.
 *
 * TODO(sms-provider): replace the stub body in `sendSms` with the real
 * HTTP call. Keep the input shape stable so callers don't need to change.
 */
"use node";

import { v } from "convex/values";
import { internalAction } from "../_generated/server";

export const sendSms = internalAction({
  args: {
    to: v.string(),
    body: v.string(),
    bookingId: v.optional(v.id("bookings")),
    shopId: v.optional(v.id("shops")),
    outboxId: v.optional(v.id("notification_outbox")),
  },
  handler: async (ctx, args) => {
    // ── PSEUDOCODE — real provider integration goes here ──
    // const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
    // const message = await client.messages.create({
    //   to: args.to,
    //   from: process.env.TWILIO_FROM_NUMBER,
    //   body: args.body,
    // });
    // return { providerMessageId: message.sid, status: "sent" };
    // ──────────────────────────────────────────────────────

    return {
      providerMessageId: null as string | null,
      status: "stubbed" as const,
      to: args.to,
      body: args.body,
      stubbedAt: Date.now(),
    };
  },
});
