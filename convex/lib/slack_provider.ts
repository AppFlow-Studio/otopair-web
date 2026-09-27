/**
 * slack_provider.ts — Slack send shim for ops alerts.
 *
 * Two transports, tried in order (mirrors sms-provider's multi-env tolerance):
 *   1. SLACK_WEBHOOK_URL    — an Incoming Webhook. One URL → one fixed channel.
 *      Simplest: no scopes, no channel ids, no bot invite. The default.
 *   2. SLACK_BOT_TOKEN + SLACK_ALERT_CHANNEL — chat.postMessage. Use when the
 *      workspace disallows incoming webhooks or you want the bot to post to a
 *      channel by id/name. Needs the `chat:write` scope and the bot invited to
 *      the channel.
 *
 * Falls back to a `stubbed` status (logged, outbox row resolved) when NEITHER
 * is configured — so an unconfigured deployment drains its queue instead of
 * looping failures, and enabling the integration is purely an env change.
 *
 * Returns { status: "sent" | "failed" | "stubbed", error? } — the shape the
 * dispatcher records. No ret/ry here; a failed row is marked failed and left.
 */
"use node";

import { v } from "convex/values";
import { internalAction } from "../_generated/server";

const POST_MESSAGE_ENDPOINT = "https://slack.com/api/chat.postMessage";

export const sendSlack = internalAction({
  args: {
    /** Plain-text fallback / notification text. Always set. */
    text: v.string(),
    /** Optional Block Kit blocks for richer formatting. */
    blocks: v.optional(v.any()),
    /** For logs only — the outbox category that produced this message. */
    category: v.optional(v.string()),
    outboxId: v.optional(v.id("notification_outbox")),
  },
  handler: async (_ctx, args) => {
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    const botToken = process.env.SLACK_BOT_TOKEN;
    const channel = process.env.SLACK_ALERT_CHANNEL;

    if (!webhookUrl && !(botToken && channel)) {
      console.warn(
        "[slack_provider] Slack not configured. Set SLACK_WEBHOOK_URL, or " +
          "SLACK_BOT_TOKEN + SLACK_ALERT_CHANNEL. Falling back to stub.",
        { hasWebhook: !!webhookUrl, hasBotToken: !!botToken, hasChannel: !!channel },
      );
      return { status: "stubbed" as const, stubbedAt: Date.now() };
    }

    try {
      // ── Transport 1: Incoming Webhook ──────────────────────────────────────
      // A webhook returns the literal body "ok" (not JSON) on success.
      if (webhookUrl) {
        const res = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: args.text, ...(args.blocks ? { blocks: args.blocks } : {}) }),
        });
        const bodyText = await res.text().catch(() => "");
        if (res.ok && bodyText.trim() === "ok") {
          return { status: "sent" as const };
        }
        console.error("[slack_provider] webhook rejected:", { httpStatus: res.status, bodyText });
        return {
          status: "failed" as const,
          error: `webhook ${res.status}: ${bodyText.slice(0, 200) || "no body"}`,
        };
      }

      // ── Transport 2: chat.postMessage (bot token) ──────────────────────────
      const res = await fetch(POST_MESSAGE_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${botToken}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          channel,
          text: args.text,
          ...(args.blocks ? { blocks: args.blocks } : {}),
        }),
      });
      let json: any = {};
      try {
        json = await res.json();
      } catch {
        json = {};
      }
      if (res.ok && json?.ok === true) {
        return { status: "sent" as const, ts: json.ts ?? null };
      }
      const errorDetail = json?.error ?? `HTTP ${res.status}`;
      console.error("[slack_provider] chat.postMessage rejected:", { httpStatus: res.status, error: errorDetail });
      return { status: "failed" as const, error: String(errorDetail) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[slack_provider] fetch threw:", message);
      return { status: "failed" as const, error: message };
    }
  },
});
