/**
 * telnyx.ts — Persistence layer for Telnyx messaging webhooks.
 *
 * Inbound SMS/MMS (`message.received`) lands in `telnyx_inbound_messages`.
 * Outbound delivery events (`message.sent`, `message.finalized`) land in
 * `telnyx_message_events`. Both tables are deduped by Telnyx's event `id`
 * so retries from Telnyx never double-write.
 *
 * The HTTP edge (see `convex/http.ts` → `/telnyx/webhook`) verifies the
 * Ed25519 signature inside a node action (`convex/lib/telnyx_webhook.ts`)
 * and then calls one of these mutations.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

export const findInboundByEventId = internalQuery({
  args: { eventId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("telnyx_inbound_messages")
      .withIndex("by_event_id", (q) => q.eq("event_id", args.eventId))
      .first();
  },
});

export const findEventByEventId = internalQuery({
  args: { eventId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("telnyx_message_events")
      .withIndex("by_event_id", (q) => q.eq("event_id", args.eventId))
      .first();
  },
});

export const recordInboundMessage = internalMutation({
  args: {
    eventId: v.string(),
    telnyxMessageId: v.string(),
    fromPhone: v.string(),
    toPhone: v.string(),
    text: v.optional(v.string()),
    messageType: v.optional(v.string()),
    media: v.optional(v.array(v.any())),
    occurredAtMs: v.number(),
    rawPayload: v.any(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("telnyx_inbound_messages")
      .withIndex("by_event_id", (q) => q.eq("event_id", args.eventId))
      .first();
    if (existing) return { deduped: true, id: existing._id };

    const id = await ctx.db.insert("telnyx_inbound_messages", {
      event_id: args.eventId,
      telnyx_message_id: args.telnyxMessageId,
      from_phone: args.fromPhone,
      to_phone: args.toPhone,
      text: args.text,
      message_type: args.messageType,
      media: args.media,
      occurred_at_ms: args.occurredAtMs,
      raw_payload: args.rawPayload,
      received_at_ms: Date.now(),
    });
    return { deduped: false, id };
  },
});

export const recordMessageEvent = internalMutation({
  args: {
    eventId: v.string(),
    eventType: v.string(),
    telnyxMessageId: v.string(),
    direction: v.optional(v.string()),
    fromPhone: v.optional(v.string()),
    toPhone: v.optional(v.string()),
    status: v.optional(v.string()),
    errors: v.optional(v.array(v.any())),
    occurredAtMs: v.number(),
    rawPayload: v.any(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("telnyx_message_events")
      .withIndex("by_event_id", (q) => q.eq("event_id", args.eventId))
      .first();
    if (existing) return { deduped: true, id: existing._id };

    const id = await ctx.db.insert("telnyx_message_events", {
      event_id: args.eventId,
      event_type: args.eventType,
      telnyx_message_id: args.telnyxMessageId,
      direction: args.direction,
      from_phone: args.fromPhone,
      to_phone: args.toPhone,
      status: args.status,
      errors: args.errors,
      occurred_at_ms: args.occurredAtMs,
      raw_payload: args.rawPayload,
      received_at_ms: Date.now(),
    });
    return { deduped: false, id };
  },
});
