// =============================================================================
// shop_tickets — Message Shop, USER side (mobile).
//
// A ticket is a booking-scoped support thread the customer opens with a
// quick action (category) or free-text ("open_chat"). The shop answers from
// otopair-web (see shop_tickets_web.ts). Mirrors the ai_conversations →
// ai_messages owner-gating pattern: identity comes from ctx.auth, never from
// args. Read-tracking + preview live denormalized on the shop_tickets row.
// =============================================================================
import { query, mutation } from "./_generated/server";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { enqueueNotificationOutbox, resolveMechanicUserId } from "./bookings";
import {
  isValidTicketCategory,
  ticketSubject,
  ticketSeedText,
  SHOP_TICKET_NOTIF,
} from "./lib/shopTicketConstants";

// ---------------------------------------------------------------------------
// Auth + small helpers
// ---------------------------------------------------------------------------

/** Resolve the authed caller's users row (throws if unauth / not found). */
async function requireUser(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("unauthenticated");
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject))
    .unique();
  if (!user) throw new Error("user not found");
  return user;
}

/** Throw unless the authed caller owns `ticketId`; returns { user, ticket }. */
async function requireTicketOwner(
  ctx: QueryCtx | MutationCtx,
  ticketId: Id<"shop_tickets">,
) {
  const user = await requireUser(ctx);
  const ticket = await ctx.db.get(ticketId);
  if (!ticket) throw new Error("ticket not found");
  if (ticket.user_id !== user._id) throw new Error("not authorized");
  return { user, ticket };
}

const PREVIEW_MAX = 140;
export function ticketPreview(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > PREVIEW_MAX ? `${t.slice(0, PREVIEW_MAX - 1)}…` : t;
}

/**
 * Resolve still-open notification_outbox rows for a ticket, scoped by
 * dedupe-key prefix so marking ONE ticket read doesn't clear another's feed.
 * (resolveBookingNotifications in bookings.ts is by-booking, too broad here.)
 */
export async function resolveTicketOutbox(
  ctx: MutationCtx,
  bookingId: Id<"bookings">,
  keyPrefix: string,
  reason: string,
): Promise<number> {
  const rows = await ctx.db
    .query("notification_outbox")
    .withIndex("by_booking_id", (q) => q.eq("booking_id", bookingId))
    .collect();
  const now = Date.now();
  let resolved = 0;
  for (const row of rows) {
    if ((row as any).resolved_at != null) continue;
    if (!String((row as any).dedupe_key ?? "").startsWith(keyPrefix)) continue;
    await ctx.db.patch(row._id, {
      status: "resolved",
      resolved_at: now,
      resolved_reason: reason,
      processed_at: now,
      updated_at: now,
    } as any);
    resolved += 1;
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Notification enqueue (shared with the web reply path)
// ---------------------------------------------------------------------------

/**
 * Notify the shop that a customer opened/updated a ticket: an in-app
 * front_desk row (shop-wide inbox, never hits Expo) plus a push to the
 * assigned mechanic's platform user when the mechanic is linked.
 */
export async function enqueueTicketNotifToShop(
  ctx: MutationCtx,
  ticketId: Id<"shop_tickets">,
  category: string,
  messageId: Id<"shop_ticket_messages">,
  body: string,
) {
  const ticket = await ctx.db.get(ticketId);
  if (!ticket) return;
  const dedupeKey =
    category === SHOP_TICKET_NOTIF.newTicketToShop
      ? `ticket:${ticketId}:new` // one open row per ticket until resolved
      : `ticket:${ticketId}:cust:${messageId}`;
  const payload = {
    title: ticket.subject ?? "New message",
    body: ticketPreview(body) || "New customer message",
    data: {
      type: "shop_ticket",
      ticketId: String(ticketId),
      bookingId: String(ticket.booking_id),
    },
  };
  await enqueueNotificationOutbox(ctx, {
    shopId: ticket.shop_id,
    bookingId: ticket.booking_id,
    mechanicId: ticket.mechanic_id ?? undefined,
    channel: "front_desk",
    category,
    dedupeKey,
    payload,
  });
  const mechUserId = await resolveMechanicUserId(
    ctx,
    ticket.shop_id,
    ticket.mechanic_id,
  );
  if (mechUserId) {
    await enqueueNotificationOutbox(ctx, {
      userId: mechUserId,
      shopId: ticket.shop_id,
      bookingId: ticket.booking_id,
      mechanicId: ticket.mechanic_id ?? undefined,
      channel: "push",
      category,
      dedupeKey: `${dedupeKey}:push`,
      payload,
    });
  }
}

/** Notify the customer that the shop replied (push). */
export async function enqueueTicketNotifToCustomer(
  ctx: MutationCtx,
  ticketId: Id<"shop_tickets">,
  messageId: Id<"shop_ticket_messages">,
  body: string,
) {
  const ticket = await ctx.db.get(ticketId);
  if (!ticket) return;
  const payload = {
    title: ticket.subject ?? "Message from the shop",
    body: ticketPreview(body) || "The shop replied to your message",
    data: {
      type: "shop_ticket",
      ticketId: String(ticketId),
      bookingId: String(ticket.booking_id),
    },
  };
  await enqueueNotificationOutbox(ctx, {
    userId: ticket.user_id,
    shopId: ticket.shop_id,
    bookingId: ticket.booking_id,
    channel: "push",
    category: SHOP_TICKET_NOTIF.shopReplyToCustomer,
    dedupeKey: `ticket:${ticketId}:shop:${messageId}`,
    payload,
  });
}

// ---------------------------------------------------------------------------
// User-facing queries
// ---------------------------------------------------------------------------

export const listMyTicketsForBooking = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const tickets = await ctx.db
      .query("shop_tickets")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", args.bookingId))
      .collect();
    return tickets
      .filter((t) => t.user_id === user._id)
      .sort(
        (a, b) =>
          (b.last_message_at ?? b.started_at) -
          (a.last_message_at ?? a.started_at),
      );
  },
});

export const getMyTicketThread = query({
  args: { ticketId: v.id("shop_tickets") },
  handler: async (ctx, args) => {
    const { ticket } = await requireTicketOwner(ctx, args.ticketId);
    const messages = await ctx.db
      .query("shop_ticket_messages")
      .withIndex("by_ticket_id", (q) => q.eq("ticket_id", args.ticketId))
      .collect();
    messages.sort((a, b) => a.timestamp - b.timestamp);
    return { ticket, messages };
  },
});

// ---------------------------------------------------------------------------
// User-facing mutations
// ---------------------------------------------------------------------------

export const createTicket = mutation({
  args: {
    bookingId: v.id("bookings"),
    category: v.string(),
    text: v.optional(v.string()),
    render: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (!isValidTicketCategory(args.category)) {
      throw new Error(`invalid ticket category: ${args.category}`);
    }
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("booking not found");
    if (booking.user_id !== user._id) throw new Error("not authorized");
    if (!booking.shop_id) throw new Error("no shop assigned to this booking yet");

    const now = Date.now();
    const body = (args.text ?? "").trim() || ticketSeedText(args.category);
    if (!body) throw new Error("a message is required");

    // Idempotency: reuse an existing live ticket for the same (booking,
    // category) instead of stacking duplicates. Resolved/closed tickets do
    // NOT block a fresh one.
    const existing = await ctx.db
      .query("shop_tickets")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", args.bookingId))
      .collect();
    const reusable = existing.find(
      (t) =>
        t.user_id === user._id &&
        t.category === args.category &&
        (t.status === "open" || t.status === "shop_responded"),
    );

    let ticketId: Id<"shop_tickets">;
    if (reusable) {
      ticketId = reusable._id;
    } else {
      ticketId = await ctx.db.insert("shop_tickets", {
        booking_id: args.bookingId,
        user_id: user._id,
        shop_id: booking.shop_id,
        mechanic_id: booking.mechanic_id ?? undefined,
        category: args.category,
        status: "open",
        subject: ticketSubject(args.category),
        message_count: 0,
        customer_unread_count: 0,
        shop_unread_count: 0,
        started_at: now,
        updated_at: now,
      });
    }

    const messageId = await ctx.db.insert("shop_ticket_messages", {
      ticket_id: ticketId,
      booking_id: args.bookingId,
      sender_role: "customer",
      author_user_id: user._id,
      content: body,
      render: args.render,
      timestamp: now,
    });

    const ticket = (await ctx.db.get(ticketId))!;
    await ctx.db.patch(ticketId, {
      status: "open", // a new customer message always needs shop attention
      last_message_preview: ticketPreview(body),
      last_message_at: now,
      last_sender_role: "customer",
      message_count: (ticket.message_count ?? 0) + 1,
      shop_unread_count: (ticket.shop_unread_count ?? 0) + 1,
      updated_at: now,
    });

    await enqueueTicketNotifToShop(
      ctx,
      ticketId,
      reusable
        ? SHOP_TICKET_NOTIF.customerReplyToShop
        : SHOP_TICKET_NOTIF.newTicketToShop,
      messageId,
      body,
    );

    return { ticketId, messageId };
  },
});

export const sendMyMessage = mutation({
  args: {
    ticketId: v.id("shop_tickets"),
    text: v.string(),
    render: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const { user, ticket } = await requireTicketOwner(ctx, args.ticketId);
    if (ticket.status === "closed") throw new Error("ticket is closed");
    const body = args.text.trim();
    if (!body) throw new Error("empty message");

    const now = Date.now();
    const messageId = await ctx.db.insert("shop_ticket_messages", {
      ticket_id: args.ticketId,
      booking_id: ticket.booking_id,
      sender_role: "customer",
      author_user_id: user._id,
      content: body,
      render: args.render,
      timestamp: now,
    });
    await ctx.db.patch(args.ticketId, {
      status: "open", // customer replied → back in the shop's queue
      last_message_preview: ticketPreview(body),
      last_message_at: now,
      last_sender_role: "customer",
      message_count: (ticket.message_count ?? 0) + 1,
      shop_unread_count: (ticket.shop_unread_count ?? 0) + 1,
      updated_at: now,
    });
    await enqueueTicketNotifToShop(
      ctx,
      args.ticketId,
      SHOP_TICKET_NOTIF.customerReplyToShop,
      messageId,
      body,
    );
    return { messageId };
  },
});

export const markTicketReadByCustomer = mutation({
  args: { ticketId: v.id("shop_tickets") },
  handler: async (ctx, args) => {
    const { ticket } = await requireTicketOwner(ctx, args.ticketId);
    const now = Date.now();
    await ctx.db.patch(args.ticketId, {
      customer_last_read_at: now,
      customer_unread_count: 0,
      updated_at: now,
    });
    // Clear the shop→customer push rows for THIS ticket from the feed.
    await resolveTicketOutbox(
      ctx,
      ticket.booking_id,
      `ticket:${args.ticketId}:shop:`,
      "user_action",
    );
    return null;
  },
});

export const closeMyTicket = mutation({
  args: { ticketId: v.id("shop_tickets") },
  handler: async (ctx, args) => {
    const { user, ticket } = await requireTicketOwner(ctx, args.ticketId);
    const now = Date.now();
    await ctx.db.patch(args.ticketId, {
      status: "closed",
      resolved_at: now,
      resolved_by_user_id: user._id,
      updated_at: now,
    });
    await resolveTicketOutbox(
      ctx,
      ticket.booking_id,
      `ticket:${args.ticketId}:`,
      "user_action",
    );
    return null;
  },
});
