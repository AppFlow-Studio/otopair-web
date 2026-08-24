// =============================================================================
// shop_tickets_web — Message Shop, SHOP / WEB side (otopair-web console).
//
// Reactive reads (inbox, thread) are plain queries gated by ctx.auth +
// STAFF-level shop_users membership (any active role, or the registered owner —
// broader than the owner gate so mechanics/front-desk can answer). Replying is
// an ACTION so it can drive existing app rails via ctx.runMutation
// (proposeReschedule / submitMidJobChange / respondToPickupRequest) — a
// mutation cannot call another mutation. The action records the shop message +
// an `action` rider through an internal mutation.
// =============================================================================
import {
  query,
  mutation,
  action,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
  resolveTicketOutbox,
  enqueueTicketNotifToCustomer,
  ticketPreview,
} from "./shop_tickets";

// ---------------------------------------------------------------------------
// Staff auth (staff-level — mirrors requireShopStaffForBooking membership)
// ---------------------------------------------------------------------------

async function userByClerk(ctx: any, clerkUserId: string) {
  return await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) => q.eq("clerkUserId", clerkUserId))
    .unique();
}

async function currentUser(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return await userByClerk(ctx, identity.subject);
}

/**
 * Staff membership for a shop: ANY active shop_users role, or the registered
 * owner. Returns { role, mechanicId } or null. Broader than OWNER_ROLES on
 * purpose — the assigned mechanic / front desk answers tickets.
 */
async function staffContextForShop(
  ctx: any,
  user: any,
  shopId: Id<"shops">,
): Promise<{ role: string; mechanicId: Id<"mechanics"> | null } | null> {
  if (!user) return null;
  const membership = await ctx.db
    .query("shop_users")
    .withIndex("by_user_and_shop", (q: any) =>
      q.eq("user_id", user._id).eq("shop_id", shopId),
    )
    .filter((q: any) => q.eq(q.field("is_active"), true))
    .first();
  if (membership) {
    return { role: membership.role, mechanicId: membership.mechanic_id ?? null };
  }
  const shop = await ctx.db.get(shopId);
  if (shop && String(shop.owner_user_id ?? "") === String(user._id)) {
    return { role: "owner", mechanicId: null };
  }
  return null;
}

/** The caller's primary shop when the client didn't pass one explicitly. */
async function resolveCallerShopId(
  ctx: any,
  user: any,
): Promise<Id<"shops"> | null> {
  const membership = await ctx.db
    .query("shop_users")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", user._id))
    .filter((q: any) => q.eq(q.field("is_active"), true))
    .first();
  if (membership) return membership.shop_id;
  const ownedShop = await ctx.db
    .query("shops")
    .withIndex("by_owner_user_id", (q: any) => q.eq("owner_user_id", user._id))
    .first();
  return ownedShop?._id ?? null;
}

// Action kinds whose triggered rail already notifies the customer — skip the
// ticket-reply push for these to avoid a double notification.
const RAIL_NOTIFIES = new Set([
  "propose_reschedule",
  "request_approval",
  "pickup_response",
]);

// ---------------------------------------------------------------------------
// Reactive reads (queries render an empty state on auth failure, per convention)
// ---------------------------------------------------------------------------

export const listShopInbox = query({
  args: {
    shopId: v.optional(v.id("shops")),
    statusFilter: v.optional(v.string()),
    categoryFilter: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    if (!user) return [];
    const shopId = args.shopId ?? (await resolveCallerShopId(ctx, user));
    if (!shopId) return [];
    const staff = await staffContextForShop(ctx, user, shopId);
    if (!staff) return [];

    let tickets;
    if (args.statusFilter) {
      tickets = await ctx.db
        .query("shop_tickets")
        .withIndex("by_shop_and_status", (q: any) =>
          q.eq("shop_id", shopId).eq("status", args.statusFilter),
        )
        .collect();
    } else {
      tickets = await ctx.db
        .query("shop_tickets")
        .withIndex("by_shop_and_updated", (q: any) => q.eq("shop_id", shopId))
        .collect();
    }
    if (args.categoryFilter) {
      tickets = tickets.filter((t: any) => t.category === args.categoryFilter);
    }
    // Unread-first, then newest activity.
    tickets.sort((a: any, b: any) => {
      const au = (a.shop_unread_count ?? 0) > 0 ? 1 : 0;
      const bu = (b.shop_unread_count ?? 0) > 0 ? 1 : 0;
      if (au !== bu) return bu - au;
      return (
        (b.last_message_at ?? b.started_at) - (a.last_message_at ?? a.started_at)
      );
    });
    return tickets;
  },
});

export const getShopTicketThread = query({
  args: { ticketId: v.id("shop_tickets") },
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    if (!user) return null;
    const ticket = await ctx.db.get(args.ticketId);
    if (!ticket) return null;
    const staff = await staffContextForShop(ctx, user, ticket.shop_id);
    if (!staff) return null;
    const messages = await ctx.db
      .query("shop_ticket_messages")
      .withIndex("by_ticket_id", (q: any) => q.eq("ticket_id", args.ticketId))
      .collect();
    messages.sort((a: any, b: any) => a.timestamp - b.timestamp);
    return { ticket, messages };
  },
});

// ---------------------------------------------------------------------------
// Simple shop-side mutations (ctx.auth gated)
// ---------------------------------------------------------------------------

export const markTicketReadByShop = mutation({
  args: { ticketId: v.id("shop_tickets") },
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    if (!user) throw new Error("unauthenticated");
    const ticket = await ctx.db.get(args.ticketId);
    if (!ticket) throw new Error("ticket not found");
    const staff = await staffContextForShop(ctx, user, ticket.shop_id);
    if (!staff) throw new Error("not authorized");
    const now = Date.now();
    await ctx.db.patch(args.ticketId, {
      shop_last_read_at: now,
      shop_unread_count: 0,
      updated_at: now,
    });
    // Clear the shop-facing feed rows (new + customer replies) for this ticket.
    await resolveTicketOutbox(
      ctx,
      ticket.booking_id,
      `ticket:${args.ticketId}:new`,
      "user_action",
    );
    await resolveTicketOutbox(
      ctx,
      ticket.booking_id,
      `ticket:${args.ticketId}:cust:`,
      "user_action",
    );
    return null;
  },
});

export const resolveTicket = mutation({
  args: { ticketId: v.id("shop_tickets"), resolution: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    if (!user) throw new Error("unauthenticated");
    const ticket = await ctx.db.get(args.ticketId);
    if (!ticket) throw new Error("ticket not found");
    const staff = await staffContextForShop(ctx, user, ticket.shop_id);
    if (!staff) throw new Error("not authorized");
    const now = Date.now();
    await ctx.db.patch(args.ticketId, {
      status: "resolved",
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

export const closeTicketShop = mutation({
  args: { ticketId: v.id("shop_tickets") },
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    if (!user) throw new Error("unauthenticated");
    const ticket = await ctx.db.get(args.ticketId);
    if (!ticket) throw new Error("ticket not found");
    const staff = await staffContextForShop(ctx, user, ticket.shop_id);
    if (!staff) throw new Error("not authorized");
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

// ---------------------------------------------------------------------------
// Reply (action + internal mutation) — the "trigger existing flow" seam
// ---------------------------------------------------------------------------

export const _getTicketInternal = internalQuery({
  args: { ticketId: v.id("shop_tickets") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.ticketId);
  },
});

/** Insert the shop reply + patch ticket denorm + notify customer. Gated by
 *  the resolved subject (staff membership), NOT ctx.auth — it's called via
 *  runMutation from the reply action. */
export const _recordShopReply = internalMutation({
  args: {
    subject: v.string(),
    ticketId: v.id("shop_tickets"),
    text: v.string(),
    action: v.optional(
      v.object({
        kind: v.string(),
        status: v.optional(v.string()),
        booking_approval_id: v.optional(v.id("booking_approvals")),
        params: v.optional(v.any()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const user = await userByClerk(ctx, args.subject);
    if (!user) throw new Error("user not found");
    const ticket = await ctx.db.get(args.ticketId);
    if (!ticket) throw new Error("ticket not found");
    const staff = await staffContextForShop(ctx, user, ticket.shop_id);
    if (!staff) throw new Error("not authorized");

    const now = Date.now();
    // "mechanic" when the replier is the booking's assigned mechanic, else "shop".
    const senderRole =
      staff.mechanicId &&
      ticket.mechanic_id &&
      String(staff.mechanicId) === String(ticket.mechanic_id)
        ? "mechanic"
        : "shop";
    const body = args.text.trim();

    const messageId = await ctx.db.insert("shop_ticket_messages", {
      ticket_id: args.ticketId,
      booking_id: ticket.booking_id,
      sender_role: senderRole,
      author_user_id: user._id,
      content: body,
      action: args.action
        ? { ...args.action, status: args.action.status ?? "pending" }
        : undefined,
      timestamp: now,
    });

    await ctx.db.patch(args.ticketId, {
      status: "shop_responded",
      last_message_preview: ticketPreview(body) || "Shop responded",
      last_message_at: now,
      last_sender_role: senderRole,
      message_count: (ticket.message_count ?? 0) + 1,
      customer_unread_count: (ticket.customer_unread_count ?? 0) + 1,
      shop_unread_count: 0, // the shop just acted
      shop_last_read_at: now,
      updated_at: now,
    });

    // Notify the customer — unless a structured action fired whose own rail
    // already pushes (reschedule proposed / approval pending / pickup answer).
    const railNotifies = args.action
      ? RAIL_NOTIFIES.has(args.action.kind)
      : false;
    if (!railNotifies) {
      await enqueueTicketNotifToCustomer(ctx, args.ticketId, messageId, body);
    }
    return { messageId };
  },
});

export const replyToTicket = action({
  args: {
    ticketId: v.id("shop_tickets"),
    text: v.optional(v.string()),
    action: v.optional(
      v.object({
        kind: v.string(),
        params: v.optional(v.any()),
      }),
    ),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    messageId: Id<"shop_ticket_messages">;
    triggered?: { kind: string };
  }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("unauthenticated");
    const subject = identity.subject;

    const ticket = await ctx.runQuery(
      internal.shop_tickets_web._getTicketInternal,
      { ticketId: args.ticketId },
    );
    if (!ticket) throw new Error("ticket not found");

    let triggered: { kind: string } | undefined;
    let actionRider:
      | {
          kind: string;
          status?: string;
          booking_approval_id?: Id<"booking_approvals">;
          params?: any;
        }
      | undefined;

    if (args.action) {
      const kind = args.action.kind;
      const p = args.action.params ?? {};
      if (kind === "propose_reschedule") {
        // Sets booking → pending_customer_acceptance and pushes its own
        // "reschedule proposed" notification; the reschedule-decision overlay
        // fires on the customer's device.
        await ctx.runMutation(api.bookings.proposeReschedule, {
          bookingId: ticket.booking_id,
          newScheduledDate: String(p.newScheduledDate),
          newScheduledTime: String(p.newScheduledTime),
          ...(p.newMechanicId ? { newMechanicId: p.newMechanicId } : {}),
        });
        actionRider = {
          kind,
          status: "pending",
          params: {
            newScheduledDate: p.newScheduledDate,
            newScheduledTime: p.newScheduledTime,
          },
        };
        triggered = { kind };
      } else if (kind === "request_approval") {
        // Opens a mid-job approval → ApprovalBanner / approve-estimate rail.
        // The web console supplies the parts/labor payload.
        await ctx.runMutation(api.booking_approvals.submitMidJobChange, {
          bookingId: ticket.booking_id,
          parts: p.parts ?? [],
          laborHours: p.laborHours,
          laborRateCents: p.laborRateCents,
          notes: p.notes,
          scopePhotoIds: p.scopePhotoIds,
        });
        actionRider = { kind, status: "pending", params: p };
        triggered = { kind };
      } else if (kind === "pickup_response") {
        await ctx.runMutation(api.bookings.respondToPickupRequest, {
          bookingId: ticket.booking_id,
          response: p.response,
          note: p.note,
        });
        actionRider = { kind, status: "applied", params: p };
        triggered = { kind };
      } else if (kind === "send_eta") {
        // v1: no booking field — the ETA lives on the thread message only.
        actionRider = { kind, status: "applied", params: p };
        triggered = { kind };
      } else {
        throw new Error(`unknown action kind: ${kind}`);
      }
    }

    const res = await ctx.runMutation(
      internal.shop_tickets_web._recordShopReply,
      {
        subject,
        ticketId: args.ticketId,
        text: (args.text ?? "").trim(),
        action: actionRider,
      },
    );
    return { messageId: res.messageId, triggered };
  },
});
