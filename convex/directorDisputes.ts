import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireDirector } from "./directorGate";

// The director "Disputes" inbox. One normalized feed over three sources that
// never converge on their own:
//   - support_requests  — the public web intake form (this repo)
//   - booking_disputes  — filed from the mobile app by a logged-in customer
//   - payment_disputes  — Stripe chargebacks, ingested by the webhook
// TabDisputes.tsx renders the normalized rows; the refund seam lives in
// directorRefunds.ts (behind money.write).

// Bounds so the join stays cheap on an admin-only surface. Volumes are low
// early; revisit if the inbox grows.
const SUPPORT_TAKE = 150;
const PER_STATUS_TAKE = 60;
const RESOLVER_SCAN = 500;

const BD_STATUSES = [
  "open",
  "in_review",
  "resolved_refund",
  "resolved_no_refund",
  "withdrawn",
] as const;

// Stripe dispute lifecycle strings we ingest.
const PD_STATUSES = [
  "needs_response",
  "warning_needs_response",
  "won",
  "lost",
  "warning_closed",
] as const;

export type UnifiedDispute = {
  kind: "web_support" | "app_dispute" | "stripe_chargeback";
  id: string;
  status: "new" | "in_review" | "resolved" | "closed";
  raw_status: string;
  filed_at: number;
  customer: { name: string; email: string | null };
  shop: { name: string | null; id: string | null };
  amount_cents: number | null;
  summary: string;
  // Extra freeform context shown in the drawer without a second fetch.
  // web_support fetches its full record separately; this carries the app
  // dispute's customer note.
  detail: string | null;
  category: string | null;
  booking_id: string | null;
  needs_link: boolean;
  evidence_due_by_ms: number | null;
};

function userName(user: any): string {
  if (!user) return "Unknown";
  const full = `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim();
  return full || user.email || "Unknown";
}

function humanizeReason(reason: string | undefined): string {
  if (!reason) return "—";
  return reason.replace(/_/g, " ");
}

function mapBookingDisputeStatus(s: string): UnifiedDispute["status"] {
  if (s === "in_review") return "in_review";
  if (s === "resolved_refund" || s === "resolved_no_refund") return "resolved";
  if (s === "withdrawn") return "closed";
  return "new"; // "open"
}

function mapChargebackStatus(s: string): UnifiedDispute["status"] {
  if (s === "needs_response" || s === "warning_needs_response") return "new";
  if (s === "warning_closed") return "closed";
  return "resolved"; // won | lost
}

export const listUnifiedDisputes = query({
  args: {
    token: v.string(),
    // Optional client-driven filters; the tab also filters locally.
    source: v.optional(v.string()),
    status: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<UnifiedDispute[]> => {
    await requireDirector(ctx, args.token); // read-only: any director

    // Small caches so a shared user/shop/booking is fetched once.
    const userCache = new Map<string, any>();
    const shopCache = new Map<string, any>();
    const bookingCache = new Map<string, any>();
    const getUser = async (id?: Id<"users"> | null) => {
      if (!id) return null;
      const k = String(id);
      if (!userCache.has(k)) userCache.set(k, await ctx.db.get(id));
      return userCache.get(k);
    };
    const getShop = async (id?: Id<"shops"> | null) => {
      if (!id) return null;
      const k = String(id);
      if (!shopCache.has(k)) shopCache.set(k, await ctx.db.get(id));
      return shopCache.get(k);
    };
    const getBooking = async (id?: Id<"bookings"> | null) => {
      if (!id) return null;
      const k = String(id);
      if (!bookingCache.has(k)) bookingCache.set(k, await ctx.db.get(id));
      return bookingCache.get(k);
    };

    const out: UnifiedDispute[] = [];

    // 1) Web support requests (newest across statuses).
    const support = await ctx.db
      .query("support_requests")
      .withIndex("by_created_at")
      .order("desc")
      .take(SUPPORT_TAKE);
    for (const r of support) {
      const linkedShop = await getShop(r.linked_shop_id ?? null);
      out.push({
        kind: "web_support",
        id: String(r._id),
        status: (r.status as UnifiedDispute["status"]) ?? "new",
        raw_status: r.status,
        filed_at: r.created_at,
        customer: { name: r.customer_name, email: r.customer_email },
        shop: {
          name: linkedShop?.name ?? r.shop_name_text ?? null,
          id: r.linked_shop_id ? String(r.linked_shop_id) : null,
        },
        amount_cents: null,
        summary: r.subject,
        detail: null, // full description fetched on demand via supportRequests.get
        category: r.category,
        booking_id: r.linked_booking_id ? String(r.linked_booking_id) : null,
        needs_link: !r.linked_booking_id,
        evidence_due_by_ms: null,
      });
    }

    // 2) App-filed booking disputes.
    const bdGroups = await Promise.all(
      BD_STATUSES.map((s) =>
        ctx.db
          .query("booking_disputes")
          .withIndex("by_status", (q) => q.eq("status", s))
          .take(PER_STATUS_TAKE),
      ),
    );
    for (const d of bdGroups.flat()) {
      const booking = await getBooking(d.booking_id);
      const user = await getUser(d.user_id);
      const shop = await getShop(booking?.shop_id ?? null);
      out.push({
        kind: "app_dispute",
        id: String(d._id),
        status: mapBookingDisputeStatus(d.status),
        raw_status: d.status,
        filed_at: d.filed_at_ms,
        customer: { name: userName(user), email: user?.email ?? null },
        shop: { name: shop?.name ?? null, id: shop ? String(shop._id) : null },
        amount_cents:
          booking?.total_cost != null
            ? Math.round(booking.total_cost * 100)
            : null,
        summary: humanizeReason(d.reason),
        detail: d.notes ?? null,
        category: null,
        booking_id: String(d.booking_id),
        needs_link: false,
        evidence_due_by_ms: null,
      });
    }

    // 3) Stripe chargebacks.
    const pdGroups = await Promise.all(
      PD_STATUSES.map((s) =>
        ctx.db
          .query("payment_disputes")
          .withIndex("by_status", (q) => q.eq("status", s))
          .take(PER_STATUS_TAKE),
      ),
    );
    for (const p of pdGroups.flat()) {
      const booking = await getBooking(p.booking_id ?? null);
      const user = await getUser(booking?.user_id ?? null);
      const shop = await getShop(p.shop_id ?? booking?.shop_id ?? null);
      out.push({
        kind: "stripe_chargeback",
        id: String(p._id),
        status: mapChargebackStatus(p.status),
        raw_status: p.status,
        filed_at: p.opened_at_ms,
        customer: { name: userName(user), email: user?.email ?? null },
        shop: { name: shop?.name ?? null, id: shop ? String(shop._id) : null },
        amount_cents: p.amount_cents,
        summary: p.reason ?? "chargeback",
        detail: null,
        category: null,
        booking_id: p.booking_id ? String(p.booking_id) : null,
        needs_link: false,
        evidence_due_by_ms: p.evidence_due_by_ms ?? null,
      });
    }

    // Optional server-side filters (the tab also filters locally).
    let rows = out;
    if (args.source) rows = rows.filter((r) => r.kind === args.source);
    if (args.status) rows = rows.filter((r) => r.status === args.status);

    rows.sort((a, b) => b.filed_at - a.filed_at);
    return rows;
  },
});

// Resolve a customer's free-text order reference into a real booking so the
// director can link a web submission. Accepts a full booking id, an invoice
// number, or the last-6-of-id display fallback. invoice_number is UNINDEXED on
// both bookings and payments, so this is a bounded recent-window scan, not an
// index read.
export const resolveBookingRef = query({
  args: { token: v.string(), query: v.string() },
  handler: async (ctx, args) => {
    await requireDirector(ctx, args.token);
    const raw = args.query.trim();
    if (!raw) return [];
    const lower = raw.toLowerCase();
    // Customers type whatever the receipt shows: the INV-YYYY-NNNNNN invoice
    // number, the synthetic OTP-<code> booking number (last 8 of the id), a
    // shop's own invoice number, or just the last few digits of any of them.
    // Strip the synthetic prefixes + separators, then match tolerantly.
    const core = lower.replace(/^(otp|inv)[-\s]*/, "").replace(/[#\s-]/g, "");
    const hasLetters = /[a-z]/.test(core); // an id/OTP code vs. a numeric fragment
    const idNeedle = core; // alphanumeric tail of a booking id
    const qDigits = core.replace(/\D/g, ""); // trailing digits of an invoice number
    const invDigits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");

    const results: Array<{
      bookingId: string;
      shopName: string | null;
      customerName: string;
      vin: string;
      date: number;
      totalCents: number | null;
    }> = [];
    const seen = new Set<string>();

    const push = async (booking: any) => {
      if (!booking || seen.has(String(booking._id))) return;
      seen.add(String(booking._id));
      const user = await ctx.db.get(booking.user_id);
      const shop = booking.shop_id ? await ctx.db.get(booking.shop_id) : null;
      results.push({
        bookingId: String(booking._id),
        shopName: (shop as any)?.name ?? null,
        customerName: userName(user),
        vin: booking.vin,
        date: booking.created_at ?? booking._creationTime,
        totalCents:
          booking.total_cost != null
            ? Math.round(booking.total_cost * 100)
            : null,
      });
    };

    // 1) The full Convex booking id, pasted.
    const asId = ctx.db.normalizeId("bookings", raw);
    if (asId) await push(await ctx.db.get(asId));

    // Bounded recent windows (invoice_number is UNINDEXED on both tables, so
    // this is a scan, not an index read). Pulled once and reused across passes.
    const payments = await ctx.db
      .query("payments")
      .withIndex("by_created_at")
      .order("desc")
      .take(RESOLVER_SCAN);
    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_created_at")
      .order("desc")
      .take(RESOLVER_SCAN);

    // 2) Exact matches first — the full invoice number (INV-YYYY-NNNNNN on the
    //    payment) or the full OTP-<last8> booking code shown on the receipt.
    for (const p of payments) {
      if (results.length >= 10) break;
      if (p.invoice_number && p.invoice_number.toLowerCase() === lower) {
        await push(await ctx.db.get(p.booking_id));
      }
    }
    for (const b of bookings) {
      if (results.length >= 10) break;
      const idStr = String(b._id).toLowerCase();
      const invExact = !!b.invoice_number && b.invoice_number.toLowerCase() === lower;
      const otpCode = idNeedle.length >= 6 && idStr.slice(-8) === idNeedle;
      if (invExact || otpCode) await push(b);
    }

    // 3) Partial fill — a few trailing digits of the invoice number, or a tail
    //    of the id. Length-guarded so a stray "1" can't match everything.
    if (results.length < 10) {
      if (!hasLetters && qDigits.length >= 3) {
        for (const p of payments) {
          if (results.length >= 10) break;
          if (invDigits(p.invoice_number).endsWith(qDigits)) {
            await push(await ctx.db.get(p.booking_id));
          }
        }
      }
      for (const b of bookings) {
        if (results.length >= 10) break;
        const idStr = String(b._id).toLowerCase();
        const invTail =
          !hasLetters && qDigits.length >= 3 && invDigits(b.invoice_number).endsWith(qDigits);
        const idTail = idNeedle.length >= 4 && idStr.endsWith(idNeedle);
        if (invTail || idTail) await push(b);
      }
    }

    return results;
  },
});

/**
 * The lifecycle timeline for one dispute, shown in the detail drawer. Merges the
 * director-action audit_log (status changes, assignment, notes, link, resolve /
 * refund — all written via logAudit) with the synthetic lifecycle events the
 * source rows carry as bare timestamps (a web request being filed, a chargeback
 * opening/closing, a legacy app-side resolution). Newest first. The client
 * formats `at` and renders it with AuditLogCompact.
 */
export const disputeTimeline = query({
  args: { token: v.string(), kind: v.string(), id: v.string() },
  handler: async (ctx, args) => {
    await requireDirector(ctx, args.token);

    const events: Array<{ action: string; actor: string; detail: string; at: number }> = [];

    const pushAuditFor = async (entityType: string, entityId: string) => {
      const rows = await ctx.db
        .query("audit_log")
        .withIndex("by_entity", (q) =>
          q.eq("entity_type", entityType).eq("entity_id", entityId),
        )
        .collect();
      for (const r of rows) {
        events.push({
          action: r.action,
          actor: r.actor,
          detail: r.detail ?? "",
          at: r.created_at,
        });
      }
    };

    const dollars = (cents?: number | null) =>
      cents != null ? ` ($${(cents / 100).toFixed(2)})` : "";

    if (args.kind === "web_support") {
      const id = ctx.db.normalizeId("support_requests", args.id);
      if (!id) return [];
      const row = await ctx.db.get(id);
      if (!row) return [];
      events.push({
        action: "created",
        actor: row.customer_name || "Customer",
        detail: `Request submitted via the web form — ${row.subject}`,
        at: row.created_at,
      });
      await pushAuditFor("support_request", String(id));
    } else if (args.kind === "app_dispute") {
      const id = ctx.db.normalizeId("booking_disputes", args.id);
      if (!id) return [];
      const row = await ctx.db.get(id);
      if (!row) return [];
      const user = await ctx.db.get(row.user_id);
      events.push({
        action: "filed",
        actor: user ? userName(user) : "Customer",
        detail: `Dispute filed — ${humanizeReason(row.reason)}${row.notes ? `: ${row.notes}` : ""}`,
        at: row.filed_at_ms,
      });
      await pushAuditFor("booking_dispute", String(id));
      // A legacy / app-side resolution that never wrote an audit row — synthesize
      // it from the stored timestamp, but only if the audit didn't already cover it.
      const hasResolutionAudit = events.some(
        (e) => e.action === "dispute_refund" || e.action === "resolved_no_refund",
      );
      if (row.resolved_at_ms && !hasResolutionAudit) {
        const noRefund = row.resolution === "no_refund";
        events.push({
          action: noRefund ? "resolved_no_refund" : "dispute_refund",
          actor: "Ops",
          detail: row.resolution
            ? `Resolved — ${row.resolution.replace(/_/g, " ")}${dollars(row.resolution_refund_cents)}`
            : "Resolved",
          at: row.resolved_at_ms,
        });
      }
    } else if (args.kind === "stripe_chargeback") {
      const id = ctx.db.normalizeId("payment_disputes", args.id);
      if (!id) return [];
      const row = await ctx.db.get(id);
      if (!row) return [];
      events.push({
        action: "chargeback_opened",
        actor: "Stripe",
        detail: `Chargeback opened${row.reason ? ` — ${row.reason}` : ""}${dollars(row.amount_cents)}`,
        at: row.opened_at_ms,
      });
      if (row.evidence_due_by_ms) {
        events.push({
          action: "evidence_due",
          actor: "Stripe",
          detail: "Evidence is due by this date to contest the chargeback.",
          at: row.evidence_due_by_ms,
        });
      }
      if (row.closed_at_ms) {
        events.push({
          action: "chargeback_closed",
          actor: "Stripe",
          detail: `Chargeback closed — ${row.status}`,
          at: row.closed_at_ms,
        });
      }
    } else {
      return [];
    }

    events.sort((a, b) => b.at - a.at); // newest first
    return events;
  },
});
