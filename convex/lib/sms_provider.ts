/**
 * sms-provider.ts — Telnyx send shim.
 *
 * Sends via POST https://api.telnyx.com/v2/messages with Bearer auth.
 * Supports both routing modes:
 *   • `from` (a phone number bound to a messaging profile), or
 *   • `messaging_profile_id` (the profile picks the sender automatically)
 *
 * If both env vars are set, `from` wins (matches the working pattern
 * from sibling projects). Accepts either env-var naming convention so
 * existing deployments don't have to rename keys:
 *   TELNYX_API_KEY        | TELNYX_MESSAGING_KEY
 *   TELNYX_FROM_NUMBER    | TELNYX_NUMBER
 *   TELNYX_MESSAGING_PROFILE_ID
 *
 * Falls back to a `stubbed` status (still logged in sms_delivery_log)
 * when no API key is configured, so local dev doesn't crash.
 */
"use node";

import { v } from "convex/values";
import { internalAction } from "../_generated/server";

const TELNYX_ENDPOINT = "https://api.telnyx.com/v2/messages";

export const sendSms = internalAction({
  args: {
    to: v.string(),
    body: v.string(),
    bookingId: v.optional(v.id("bookings")),
    shopId: v.optional(v.id("shops")),
    outboxId: v.optional(v.id("notification_outbox")),
    /**
     * Force the stub path even when Telnyx IS configured.
     *
     * Configuring Telnyx is one switch for the whole app: the same shim backs
     * walk-in verification AND the twelve notification templates in
     * sms_dispatcher, which have been silently stubbing since they were
     * written. Turning the key on would put all of them on real handsets in
     * the same minute. This lets one caller go live while the rest keep
     * behaving exactly as they do today — same logging, same result shape, no
     * queue building up to flood later.
     */
    stubOnly: v.optional(v.boolean()),
  },
  handler: async (_ctx, args) => {
    const apiKey = args.stubOnly
      ? undefined
      : (process.env.TELNYX_API_KEY ?? process.env.TELNYX_MESSAGING_KEY);
    const fromNumber =
      process.env.TELNYX_FROM_NUMBER ?? process.env.TELNYX_NUMBER;
    const profileId = process.env.TELNYX_MESSAGING_PROFILE_ID;

    if (!apiKey || (!fromNumber && !profileId)) {
      if (args.stubOnly) {
        console.info(
          "[sms_provider] Held by stubOnly — not sending. Flip SMS_NOTIFICATIONS_ENABLED=true to go live.",
          { to: args.to, outboxId: args.outboxId },
        );
        return {
          providerMessageId: null as string | null,
          status: "stubbed" as const,
          to: args.to,
          body: args.body,
          stubbedAt: Date.now(),
        };
      }
      console.warn(
        "[sms_provider] Telnyx not configured. Need TELNYX_API_KEY plus either TELNYX_FROM_NUMBER or TELNYX_MESSAGING_PROFILE_ID. Falling back to stub.",
        {
          hasKey: !!apiKey,
          hasFromNumber: !!fromNumber,
          hasProfileId: !!profileId,
        },
      );
      return {
        providerMessageId: null as string | null,
        status: "stubbed" as const,
        to: args.to,
        body: args.body,
        stubbedAt: Date.now(),
      };
    }

    // `from` takes precedence — matches the working pattern. If you
    // need to route via a specific profile when both are set, drop
    // TELNYX_FROM_NUMBER from the env.
    const telnyxBody: Record<string, unknown> = {
      to: args.to,
      text: args.body,
    };
    if (fromNumber) telnyxBody.from = fromNumber;
    else if (profileId) telnyxBody.messaging_profile_id = profileId;

    try {
      const res = await fetch(TELNYX_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(telnyxBody),
      });

      let json: any = {};
      try {
        json = await res.json();
      } catch {
        json = {};
      }

      const data = json?.data;
      const firstError = json?.errors?.[0];
      const providerStatus: string | undefined = data?.status;
      const providerMessageId: string | null = data?.id ?? null;

      // Success criteria mirror the working pattern: HTTP OK + a real
      // message id + status is not one of the failure markers.
      const ok =
        res.ok &&
        !!providerMessageId &&
        providerStatus !== "sending_failed" &&
        providerStatus !== "delivery_failed";

      if (!ok) {
        const errorDetail =
          firstError?.detail ??
          firstError?.title ??
          providerStatus ??
          `HTTP ${res.status}`;
        console.error("[sms_provider] Telnyx rejected the send:", {
          httpStatus: res.status,
          providerStatus,
          firstError,
          to: args.to,
        });
        return {
          providerMessageId,
          status: "failed" as const,
          error: String(errorDetail),
          providerStatus: providerStatus ?? null,
        };
      }

      return {
        providerMessageId,
        status: "sent" as const,
        providerStatus: providerStatus ?? "queued",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[sms_provider] Telnyx fetch threw:", message);
      return {
        providerMessageId: null as string | null,
        status: "failed" as const,
        error: message,
      };
    }
  },
});
