import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireDirector, logAudit } from "./directorGate";

// Public customer support / charge-dispute intake. The web /support form posts
// to /api/support/submit, which validates fields and calls `submit` below. The
// director "Disputes" tab reads and triages these rows (alongside the mobile
// booking_disputes and Stripe payment_disputes) via convex/directorDisputes.ts.
//
// Auth model (mirrors shopApplications.ts + the plan):
//   - submit: PUBLIC (no session) — anyone can file.
//   - listByStatus / get: any director (two-arg requireDirector).
//   - triage writes (setStatus/assign/addNote/linkToBooking): "users.write", so
//     the `support` director role can triage. The actual refund lives in
//     directorRefunds.ts behind "money.write" (separation of duties).

const ALLOWED_CATEGORIES = new Set([
  "charge_dispute",
  "service_quality",
  "other",
]);

const ALLOWED_STATUSES = new Set(["new", "in_review", "resolved", "closed"]);

// A second identical "new" ticket from the same email within this window is a
// double-submit / retry, not a distinct request.
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

export const submit = mutation({
  args: {
    customer_email: v.string(),
    customer_name: v.string(),
    customer_phone: v.optional(v.string()),
    category: v.string(),
    subject: v.string(),
    description: v.string(),
    order_reference: v.optional(v.string()),
    shop_name_text: v.optional(v.string()),
    source: v.optional(v.string()),
    user_agent: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Normalize once more (defense in depth — the route already did this).
    const email = args.customer_email.trim().toLowerCase();
    const category = args.category.trim();
    const subject = args.subject.trim();
    const description = args.description.trim();

    if (!ALLOWED_CATEGORIES.has(category)) {
      throw new Error("Please choose a valid category.");
    }
    if (!email || !subject || !description) {
      throw new Error("Missing required fields.");
    }

    // Duplicate-recent guard: same email + subject, still "new", filed moments
    // ago. Mirrors shopApplications.submit's duplicate-pending guard.
    const now = Date.now();
    const recent = await ctx.db
      .query("support_requests")
      .withIndex("by_customer_email", (q) => q.eq("customer_email", email))
      .filter((q) => q.eq(q.field("status"), "new"))
      .collect();
    const dup = recent.find(
      (r) =>
        r.subject.trim().toLowerCase() === subject.toLowerCase() &&
        now - r.created_at < DUPLICATE_WINDOW_MS,
    );
    if (dup) throw new Error("DUPLICATE_RECENT_SUPPORT_REQUEST"); // route → 409

    return await ctx.db.insert("support_requests", {
      customer_email: email,
      customer_name: args.customer_name.trim(),
      customer_phone: args.customer_phone?.trim() || undefined,
      category,
      subject,
      description,
      order_reference: args.order_reference?.trim() || undefined,
      shop_name_text: args.shop_name_text?.trim() || undefined,
      status: "new",
      source: args.source,
      user_agent: args.user_agent,
      created_at: now,
      updated_at: now,
    });
  },
});

// ---- Director reads (session-gated; these expose customer PII) ----

export const listByStatus = query({
  args: { token: v.string(), status: v.string() },
  handler: async (ctx, args) => {
    await requireDirector(ctx, args.token);
    return ctx.db
      .query("support_requests")
      .withIndex("by_status", (q) => q.eq("status", args.status))
      .order("desc")
      .collect();
  },
});

export const get = query({
  args: { token: v.string(), id: v.id("support_requests") },
  handler: async (ctx, args) => {
    await requireDirector(ctx, args.token);
    return ctx.db.get(args.id);
  },
});

// ---- Director triage writes (gated "users.write") ----

export const setStatus = mutation({
  args: {
    token: v.string(),
    id: v.id("support_requests"),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    const actor = await requireDirector(ctx, args.token, "users.write");
    if (!ALLOWED_STATUSES.has(args.status)) {
      throw new Error("Invalid status.");
    }
    const row = await ctx.db.get(args.id);
    if (!row) throw new Error("Support request not found.");

    await ctx.db.patch(args.id, {
      status: args.status,
      // Stamp the resolver name once it reaches a terminal state.
      ...(args.status === "resolved" || args.status === "closed"
        ? { reviewed_by_name: actor.name }
        : {}),
      updated_at: Date.now(),
    });
    await logAudit(ctx, actor, {
      entity_type: "support_request",
      entity_id: String(args.id),
      action: "status_changed",
      detail: `${row.status} → ${args.status}`,
    });
    return { ok: true as const };
  },
});

export const assign = mutation({
  args: { token: v.string(), id: v.id("support_requests") },
  handler: async (ctx, args) => {
    const actor = await requireDirector(ctx, args.token, "users.write");
    const row = await ctx.db.get(args.id);
    if (!row) throw new Error("Support request not found.");

    await ctx.db.patch(args.id, {
      assigned_to_id: actor.userId,
      assigned_to_name: actor.name,
      updated_at: Date.now(),
    });
    await logAudit(ctx, actor, {
      entity_type: "support_request",
      entity_id: String(args.id),
      action: "assigned",
      detail: `Assigned to ${actor.name}.`,
    });
    return { ok: true as const };
  },
});

export const addNote = mutation({
  args: {
    token: v.string(),
    id: v.id("support_requests"),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    const actor = await requireDirector(ctx, args.token, "users.write");
    const text = args.text.trim();
    if (!text) throw new Error("Note cannot be empty.");
    const row = await ctx.db.get(args.id);
    if (!row) throw new Error("Support request not found.");

    const notes = [...(row.internal_notes ?? [])];
    notes.push({ text, author: actor.name, at: Date.now() });

    await ctx.db.patch(args.id, {
      internal_notes: notes,
      updated_at: Date.now(),
    });
    await logAudit(ctx, actor, {
      entity_type: "support_request",
      entity_id: String(args.id),
      action: "note_added",
    });
    return { ok: true as const };
  },
});

// Attach a web submission to a real booking. The director supplies the resolved
// booking id (from the resolver in directorDisputes.resolveBookingRef); we derive
// the customer + shop ids SERVER-SIDE from the booking so they cannot be spoofed.
// Linking is what unlocks the refund seam (directorRefunds.resolveDisputeWithRefund).
export const linkToBooking = mutation({
  args: {
    token: v.string(),
    id: v.id("support_requests"),
    bookingId: v.id("bookings"),
  },
  handler: async (ctx, args) => {
    const actor = await requireDirector(ctx, args.token, "users.write");
    const row = await ctx.db.get(args.id);
    if (!row) throw new Error("Support request not found.");
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found.");

    await ctx.db.patch(args.id, {
      linked_booking_id: args.bookingId,
      linked_user_id: booking.user_id,
      linked_shop_id: booking.shop_id, // optional on bookings; may be undefined
      status: row.status === "new" ? "in_review" : row.status,
      updated_at: Date.now(),
    });
    await logAudit(ctx, actor, {
      entity_type: "support_request",
      entity_id: String(args.id),
      action: "linked_to_booking",
      detail: `Linked to booking ${String(args.bookingId)}.`,
    });
    return { ok: true as const };
  },
});
