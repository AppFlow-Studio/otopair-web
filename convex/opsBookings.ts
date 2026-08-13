// =============================================================================
// Ops · Bookings board / list / detail — read-only for P0 (no status mutations
// yet; status flows from the shop portal / app). Every query is token-gated via
// requireDirector and reads through indexed windows only:
//   - board:  bookings.by_status .take(50) per measured status column
//   - list:   bookings.by_created_at (or by_status) paginated
//   - detail: single booking + by_booking_id joins (payments, status history)
// Wraps the data shape of director.ts bookingDetail without touching that file.
// =============================================================================
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { query, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireDirector } from "./directorGate";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { resolveVehicleDisplay, userDisplayName } from "./lib/bookingEnrichment";

/** cents → dollars, null-safe. */
const centsToDollars = (c: number | null | undefined): number | null =>
  c == null ? null : c / 100;

/** cents → "$X.XX" string, null-safe. */
const fmtCents = (c: number | null | undefined): string =>
  c == null ? "—" : `$${(c / 100).toFixed(2)}`;

/** MEASURED status set on this deployment (NOT confirmed/in_progress). */
export const BOOKING_STATUSES = [
  "pending",
  "pending_quote",
  "quotes_ready",
  "vehicle_at_shop",
  "completed",
  "cancelled",
  "no_show",
] as const;

// ---------------------------------------------------------------------------
// Shared row shape (board cards + list rows)
// ---------------------------------------------------------------------------
async function bookingRow(ctx: QueryCtx, b: Doc<"bookings">) {
  const [user, shop, vehicle] = await Promise.all([
    ctx.db.get(b.user_id),
    b.shop_id ? ctx.db.get(b.shop_id) : null,
    resolveVehicleDisplay(ctx, b.vin),
  ]);
  const serviceNames = await Promise.all(
    b.service_ids.map(async (sid) => {
      const s = await ctx.db.get(sid);
      return s?.name ?? "—";
    }),
  );
  return {
    id: b._id,
    userId: b.user_id,
    user: user
      ? `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim() || user.email || "Unknown"
      : "Unknown",
    shopId: b.shop_id ?? null,
    shop: shop?.name ?? "—",
    vin: b.vin,
    vehicleYmm: vehicle.ymm,
    services: serviceNames,
    scheduledDate: b.scheduled_date ?? null,
    scheduledTime: b.scheduled_time ?? null,
    createdAt: b.created_at ?? b._creationTime,
    status: b.status,
    liveStage: b.live_stage ?? null,
    total: b.total_cost ?? null,
    // Quote band for quote-stage bookings (total_cost is null pre-payment).
    // Gives pending_quote / quotes_ready cards a real number to show instead
    // of a bare "—". All dollars.
    quote: {
      low: centsToDollars(b.disclosed_range_low_cents),
      high: centsToDollars(b.disclosed_range_high_cents),
      setPrice: centsToDollars(b.quoted_set_price_cents),
      isFixed: b.is_fixed_price ?? false,
    },
  };
}

/** Board view: one column per measured status; each column is a
 *  by_status window of the 50 most recent bookings + header count
 *  (capped — `more` is true when the window filled up). */
export const board = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireDirector(ctx, token);
    const columns = await Promise.all(
      BOOKING_STATUSES.map(async (status) => {
        const rows = await ctx.db
          .query("bookings")
          .withIndex("by_status", (q) => q.eq("status", status))
          .order("desc")
          .take(50);
        const cards = await Promise.all(rows.map((b) => bookingRow(ctx, b)));
        return { status, count: cards.length, more: cards.length === 50, cards };
      }),
    );
    return columns;
  },
});

/** List view: recent bookings via by_created_at desc, or a single-status
 *  window via by_status when a filter is set. Paginated. */
export const list = query({
  args: {
    token: v.string(),
    status: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { token, status, paginationOpts }) => {
    await requireDirector(ctx, token);
    const page = status
      ? await ctx.db
          .query("bookings")
          .withIndex("by_status", (q) => q.eq("status", status))
          .order("desc")
          .paginate(paginationOpts)
      : await ctx.db
          .query("bookings")
          .withIndex("by_created_at")
          .order("desc")
          .paginate(paginationOpts);
    return {
      ...page,
      page: await Promise.all(page.page.map((b) => bookingRow(ctx, b))),
    };
  },
});

type AwaitingSettlementRow = Awaited<ReturnType<typeof bookingRow>> & {
  settlementShortfallCents: number;
  settlementReason: string | null;
  awaitingSinceMs: number | null;
  escalatedAtMs: number | null;
  paymentApprovalState: string | null;
};
type AwaitingSettlementResult = {
  rows: AwaitingSettlementRow[];
  count: number;
  totalShortfallCents: number;
  truncated: boolean;
};

/** Completed jobs still owed money — the reconciliation cron flags these
 *  `settlement_state = "awaiting_settlement"` when the hold couldn't cover the
 *  final total (reauth pending, capture failed, no set price). Oldest shortfall
 *  first so ops chase the most stale. Bounded window; token-gated. */
export const awaitingSettlementBookings = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<AwaitingSettlementResult> => {
    await requireDirector(ctx, token);
    const LIMIT = 200;
    const found = await ctx.db
      .query("bookings")
      .withIndex("by_settlement_state", (q) =>
        q.eq("settlement_state", "awaiting_settlement"),
      )
      .take(LIMIT + 1);
    const truncated = found.length > LIMIT;
    const window = truncated ? found.slice(0, LIMIT) : found;
    const rows: AwaitingSettlementRow[] = await Promise.all(
      window.map(async (b) => ({
        ...(await bookingRow(ctx, b)),
        settlementShortfallCents: b.settlement_shortfall_cents ?? 0,
        settlementReason: b.settlement_reason ?? null,
        awaitingSinceMs: b.awaiting_settlement_since_ms ?? null,
        escalatedAtMs: b.settlement_escalated_at_ms ?? null,
        paymentApprovalState: b.payment_approval_state ?? null,
      })),
    );
    rows.sort((a, b) => (a.awaitingSinceMs ?? 0) - (b.awaitingSinceMs ?? 0));
    const totalShortfallCents = rows.reduce(
      (sum, r) => sum + (r.settlementShortfallCents ?? 0),
      0,
    );
    return { rows, count: rows.length, totalShortfallCents, truncated };
  },
});

/** Ops "retry capture now" — the reconciliation cron already retries every
 *  30 min; this lets a director force an immediate attempt from the Settlement
 *  tab. Schedules the same capture-at-ceiling path (idempotent: skips if the
 *  payment is already captured). Token-gated. */
export const retrySettlement = mutation({
  args: { token: v.string(), id: v.id("bookings") },
  handler: async (ctx, { token, id }): Promise<{ queued: boolean }> => {
    await requireDirector(ctx, token);
    const booking = await ctx.db.get(id);
    if (!booking) throw new Error("Booking not found.");
    await ctx.scheduler.runAfter(
      0,
      internal.payments_stripe.finalizeAndChargeForBooking,
      { bookingId: id, forceCaptureAtCeiling: true },
    );
    return { queued: true };
  },
});

/** Booking detail — wraps the director.ts bookingDetail shape (own gated
 *  query; that file is shared and must not change): booking fields + shop +
 *  user + mechanic + ALL payments for the booking (payments.by_booking_id) +
 *  status-history timeline + time slot + review. */
export const detail = query({
  args: { token: v.string(), id: v.id("bookings") },
  handler: async (ctx, { token, id }) => {
    await requireDirector(ctx, token);
    const booking = await ctx.db.get(id);
    if (!booking) return null;

    const [user, shop, mechanic, timeSlot] = await Promise.all([
      ctx.db.get(booking.user_id),
      booking.shop_id ? ctx.db.get(booking.shop_id) : null,
      booking.mechanic_id ? ctx.db.get(booking.mechanic_id) : null,
      booking.time_slot_id ? ctx.db.get(booking.time_slot_id) : null,
    ]);

    const services = await Promise.all(
      booking.service_ids.map(async (sid) => {
        const s = await ctx.db.get(sid);
        return { id: sid, name: s?.name ?? "—", slug: s?.slug ?? null };
      }),
    );

    // Vehicle year/make/model so support recognizes the car, not just the VIN.
    const vehicle = await resolveVehicleDisplay(ctx, booking.vin);
    const vehicleYmm = vehicle.ymm;

    // Per-service name map so each priced-part line can name its service.
    const serviceNameById = new Map(services.map((s) => [String(s.id), s.name]));

    const [statusHistory, payments, review] = await Promise.all([
      ctx.db
        .query("booking_status_history")
        .withIndex("by_booking_id", (q) => q.eq("booking_id", id))
        .order("asc")
        .collect(),
      ctx.db
        .query("payments")
        .withIndex("by_booking_id", (q) => q.eq("booking_id", id))
        .collect(),
      ctx.db
        .query("reviews")
        .withIndex("by_booking_id", (q) => q.eq("booking_id", id))
        .first(),
    ]);

    return {
      id: booking._id,
      status: booking.status,
      liveStage: booking.live_stage ?? null,
      createdAt: booking.created_at ?? booking._creationTime,
      scheduledDate: booking.scheduled_date ?? null,
      scheduledTime: booking.scheduled_time ?? null,
      invoiceNumber: booking.invoice_number ?? null,
      vin: booking.vin,
      vehicleYmm,
      customerNotes: booking.customer_notes ?? null,
      refundReason: booking.refund_reason ?? null,

      // Money (dollars; optional on the doc)
      laborCost: booking.labor_cost ?? null,
      partsCost: booking.parts_cost ?? null,
      totalCost: booking.total_cost ?? null,
      estimatedLaborMinutes: booking.estimated_labor_minutes ?? null,

      // Quote band + itemized breakdown so ops can see the price the customer
      // was shown, not just the top-line total. All dollars.
      isFixedPrice: booking.is_fixed_price ?? false,
      disclosedLow: centsToDollars(booking.disclosed_range_low_cents),
      disclosedHigh: centsToDollars(booking.disclosed_range_high_cents),
      quotedSetPrice: centsToDollars(booking.quoted_set_price_cents),
      disclosedBreakdown: booking.disclosed_breakdown
        ? {
            partsLow: centsToDollars(booking.disclosed_breakdown.parts_low_cents),
            partsHigh: centsToDollars(booking.disclosed_breakdown.parts_high_cents),
            labor: centsToDollars(booking.disclosed_breakdown.labor_cents),
            taxLow: centsToDollars(booking.disclosed_breakdown.tax_low_cents),
            taxHigh: centsToDollars(booking.disclosed_breakdown.tax_high_cents),
            serviceFeeLow: centsToDollars(booking.disclosed_breakdown.service_fee_low_cents),
            serviceFeeHigh: centsToDollars(booking.disclosed_breakdown.service_fee_high_cents),
          }
        : null,
      quotedBreakdown: booking.quoted_breakdown
        ? {
            parts: centsToDollars(booking.quoted_breakdown.parts_cents),
            labor: centsToDollars(booking.quoted_breakdown.labor_cents),
            tax: centsToDollars(booking.quoted_breakdown.tax_cents),
            serviceFee: centsToDollars(booking.quoted_breakdown.service_fee_cents),
          }
        : null,
      // Itemized parts the customer saw on Review & Pay. Dollars per line.
      pricedParts: (booking.priced_parts_snapshot ?? []).map((p) => ({
        serviceName: serviceNameById.get(String(p.service_id)) ?? "—",
        partName: p.part_name,
        oemNumber: p.oem_number,
        brand: p.brand ?? null,
        tier: p.part_tier ?? null,
        quantity: p.quantity,
        unitPrice: centsToDollars(p.unit_price_cents),
        lineTotal: centsToDollars(p.line_total_cents),
        priceUnknown: p.price_unknown ?? false,
        priceStale: p.price_stale ?? false,
      })),

      user: user
        ? {
            id: booking.user_id,
            name:
              `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim() ||
              user.email ||
              "Unknown",
            email: user.email ?? null,
            phone: user.phone ?? null,
          }
        : { id: booking.user_id, name: "Unknown", email: null, phone: null },
      shop: shop
        ? {
            id: booking.shop_id,
            name: shop.name,
            address: shop.address ?? null,
            phone: shop.phone ?? null,
            email: shop.email ?? null,
          }
        : null,
      mechanic: mechanic
        ? {
            id: booking.mechanic_id,
            name: `${mechanic.first_name} ${mechanic.last_name}`.trim(),
            title: mechanic.title ?? null,
          }
        : null,
      timeSlot: timeSlot
        ? {
            date: timeSlot.date,
            startTime: timeSlot.start_time,
            endTime: timeSlot.end_time,
          }
        : null,

      services,

      statusHistory: statusHistory.map((h) => ({
        status: h.new_status,
        changedAt: h.changed_at,
        changedBy: h.changed_by,
        reason: h.reason ?? null,
      })),

      payments: payments.map((p) => ({
        id: p._id,
        amount: p.amount, // dollars
        capturedAmountCents: p.captured_amount_cents ?? null,
        holdAmountCents: p.hold_amount_cents ?? null,
        status: p.status,
        paymentMethod: p.payment_method ?? null,
        stripePaymentIntentId: p.stripe_payment_intent_id ?? null,
        createdAt: p.created_at ?? p._creationTime,
      })),

      review: review ? { rating: review.rating, comment: review.comment ?? null } : null,
    };
  },
});

// ---------------------------------------------------------------------------
// auditTimeline — director-gated, fully-merged booking audit trail. Unions
// every lifecycle source into one chronological, actor-resolved feed:
//   status transitions · estimate submissions + decisions (booking_approvals)
//   · part edits · labor edits · payment status history · customer disputes
//   · Stripe payment disputes · director audit_log rows.
// booking_activity.getBookingActivityLog builds a subset of this but is
// customer/shop-gated; this is the /ops-native equivalent (+ labor edits,
// payment history, disputes, audit_log).
// ---------------------------------------------------------------------------
export type BookingAuditEvent = {
  at: number;
  kind:
    | "status"
    | "estimate_submitted"
    | "estimate_decision"
    | "part_edit"
    | "labor_edit"
    | "payment_status"
    | "dispute_filed"
    | "dispute_resolved"
    | "payment_dispute"
    | "audit";
  actor: string | null;
  title: string;
  detail: string | null;
};

export const auditTimeline = query({
  args: { token: v.string(), id: v.id("bookings") },
  handler: async (ctx, { token, id }): Promise<{ events: BookingAuditEvent[] } | null> => {
    await requireDirector(ctx, token);
    const booking = await ctx.db.get(id);
    if (!booking) return null;

    // Actor resolver — cache user-id → display name; pass sentinels through.
    const actorCache = new Map<string, string | null>();
    const resolveActor = async (
      raw: string | Id<"users"> | null | undefined,
    ): Promise<string | null> => {
      if (raw == null) return null;
      const s = String(raw);
      if (s === "system" || s === "stripe_webhook") return s;
      if (actorCache.has(s)) return actorCache.get(s)!;
      let name: string | null = s;
      try {
        name = userDisplayName(await ctx.db.get(s as Id<"users">));
      } catch {
        name = s;
      }
      actorCache.set(s, name);
      return name;
    };

    const events: BookingAuditEvent[] = [];

    // 1. Status transitions.
    const statusRows = await ctx.db
      .query("booking_status_history")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", id))
      .collect();
    for (const h of statusRows) {
      events.push({
        at: h.changed_at,
        kind: "status",
        actor: await resolveActor(h.changed_by),
        title: h.old_status
          ? `${h.old_status.replace(/_/g, " ")} → ${h.new_status.replace(/_/g, " ")}`
          : `created (${h.new_status.replace(/_/g, " ")})`,
        detail: h.reason ?? null,
      });
    }

    // 2. Estimate submissions + decisions (approval cycles).
    const approvals = await ctx.db
      .query("booking_approvals")
      .withIndex("by_booking_and_cycle", (q) => q.eq("booking_id", id))
      .collect();
    for (const a of approvals) {
      const over = a.mechanic_set_price_cents > a.prior_ceiling_cents;
      events.push({
        at: a.submitted_at_ms,
        kind: "estimate_submitted",
        actor: await resolveActor(a.submitted_by_user_id),
        title: `${a.cycle.replace(/_/g, " ")} estimate — ${fmtCents(a.mechanic_set_price_cents)}`,
        detail: `ceiling ${fmtCents(a.prior_ceiling_cents)} · ${over ? "OVER ceiling" : "in range"}`,
      });
      if (a.decision) {
        events.push({
          at: a.decided_at_ms ?? a.submitted_at_ms,
          kind: "estimate_decision",
          actor: await resolveActor(a.decided_by_user_id ?? a.decision_actor),
          title: `${a.cycle.replace(/_/g, " ")} estimate ${a.decision.replace(/_/g, " ")}`,
          detail:
            [
              a.ceiling_after_decision_cents != null
                ? `new ceiling ${fmtCents(a.ceiling_after_decision_cents)}`
                : null,
              a.stripe_action ? a.stripe_action.replace(/_/g, " ") : null,
            ]
              .filter(Boolean)
              .join(" · ") || null,
        });
      }
    }

    // 3. Part edits.
    const partEdits = await ctx.db
      .query("job_actual_part_edits")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", id))
      .collect();
    for (const e of partEdits) {
      events.push({
        at: e.edited_at,
        kind: "part_edit",
        actor: await resolveActor(e.edited_by_user_id),
        title: `part ${e.edit_type.replace(/_/g, " ")} — ${e.part_name_snapshot ?? e.part_key}`,
        detail:
          [
            e.oem_number_snapshot ? `OEM ${e.oem_number_snapshot}` : null,
            e.old_value != null || e.new_value != null
              ? `${e.old_value ?? "—"} → ${e.new_value ?? "—"}`
              : null,
          ]
            .filter(Boolean)
            .join(" · ") || null,
      });
    }

    // 4. Labor edits.
    const laborEdits = await ctx.db
      .query("job_actual_labor_edits")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", id))
      .collect();
    for (const e of laborEdits) {
      events.push({
        at: e.edited_at,
        kind: "labor_edit",
        actor: await resolveActor(e.edited_by_user_id),
        title: "labor time edited",
        detail: `${e.old_minutes ?? "—"} → ${e.new_minutes ?? "—"} min`,
      });
    }

    // 5. Payment status history (across all of the booking's payments).
    const payments = await ctx.db
      .query("payments")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", id))
      .collect();
    for (const p of payments) {
      const ph = await ctx.db
        .query("payment_status_history")
        .withIndex("by_payment_id", (q) => q.eq("payment_id", p._id))
        .collect();
      for (const h of ph) {
        events.push({
          at: h.changed_at,
          kind: "payment_status",
          actor: null,
          title: `payment ${h.old_status ?? "—"} → ${h.new_status}`,
          detail: h.error_message ?? h.error_code ?? null,
        });
      }
    }

    // 6. Customer disputes.
    const bDisputes = await ctx.db
      .query("booking_disputes")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", id))
      .collect();
    for (const d of bDisputes) {
      events.push({
        at: d.filed_at_ms,
        kind: "dispute_filed",
        actor: await resolveActor(d.user_id),
        title: `dispute filed — ${d.reason.replace(/_/g, " ")}`,
        detail: d.notes ?? null,
      });
      if (d.resolved_at_ms) {
        events.push({
          at: d.resolved_at_ms,
          kind: "dispute_resolved",
          actor: await resolveActor(d.resolved_by_user_id),
          title: `dispute ${d.status.replace(/_/g, " ")}`,
          detail:
            [
              d.resolution ? d.resolution.replace(/_/g, " ") : null,
              d.resolution_refund_cents
                ? `refund ${fmtCents(d.resolution_refund_cents)}`
                : null,
            ]
              .filter(Boolean)
              .join(" · ") || null,
        });
      }
    }

    // 7. Stripe payment disputes (chargebacks).
    const pDisputes = await ctx.db
      .query("payment_disputes")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", id))
      .collect();
    for (const d of pDisputes) {
      events.push({
        at: d.opened_at_ms,
        kind: "payment_dispute",
        actor: "stripe_webhook",
        title: `Stripe dispute opened (${d.status})`,
        detail: `${fmtCents(d.amount_cents)}${d.reason ? ` · ${d.reason}` : ""}`,
      });
      if (d.closed_at_ms) {
        events.push({
          at: d.closed_at_ms,
          kind: "payment_dispute",
          actor: "stripe_webhook",
          title: `Stripe dispute closed (${d.status})`,
          detail: null,
        });
      }
    }

    // 8. Director audit_log rows for this booking (e.g. refund tags).
    const auditRows = await ctx.db
      .query("audit_log")
      .withIndex("by_entity", (q) =>
        q.eq("entity_type", "booking").eq("entity_id", String(id)),
      )
      .collect();
    for (const a of auditRows) {
      events.push({
        at: a.created_at,
        kind: "audit",
        actor: a.actor ?? null,
        title: a.action.replace(/_/g, " "),
        detail: a.detail ?? null,
      });
    }

    events.sort((x, y) => x.at - y.at);
    return { events };
  },
});

// ---------------------------------------------------------------------------
// completion — the "what actually happened" tab: job_actuals (labor/parts
// actuals, odometer, findings, photos) + diagnostics + arrival/completion
// timestamps + recommendation. Latest job_actual read directly (the shop-gated
// job_actuals.getByBookingId throws on completed jobs, so we don't reuse it).
// ---------------------------------------------------------------------------
export const completion = query({
  args: { token: v.string(), id: v.id("bookings") },
  handler: async (ctx, { token, id }) => {
    await requireDirector(ctx, token);
    const booking = await ctx.db.get(id);
    if (!booking) return null;

    const ja = await ctx.db
      .query("job_actuals")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", id))
      .order("desc")
      .first();

    let recommendedServiceName: string | null = null;
    if (booking.recommended_service_id) {
      const s = await ctx.db.get(booking.recommended_service_id);
      recommendedServiceName = s?.name ?? null;
    }

    let jobActual: {
      startedAt: number | null;
      completedAtMs: number | null;
      finalizedAtMs: number | null;
      finalizedBy: string | null;
      actualLaborMinutes: number | null;
      actualPartsCost: number | null;
      difficultyRating: number | null;
      technicianNotes: string | null;
      mechanicFindings: string | null;
      additionalObservations: string | null;
      odometerIn: number | null;
      completionMileage: number | null;
      inProgressNotes: string | null;
      inProgressPhotos: { url: string; caption: string | null; takenAt: number }[];
      hasPrejobReport: boolean;
      hasPostjobReport: boolean;
    } | null = null;

    if (ja) {
      const rawPhotos = (ja.in_progress_photos ?? []) as {
        storage_id: Id<"_storage">;
        caption?: string | null;
        taken_at: number;
      }[];
      const photos = await Promise.all(
        rawPhotos.map(async (p) => ({
          url: await ctx.storage.getUrl(p.storage_id),
          caption: p.caption ?? null,
          takenAt: p.taken_at,
        })),
      );
      jobActual = {
        startedAt: ja.started_at ?? null,
        completedAtMs: ja.completed_at_ms ?? null,
        finalizedAtMs: ja.finalized_at_ms ?? null,
        finalizedBy: ja.finalized_by_user_id
          ? userDisplayName(await ctx.db.get(ja.finalized_by_user_id))
          : null,
        actualLaborMinutes: ja.actual_labor_minutes ?? null,
        actualPartsCost: ja.actual_parts_cost ?? null,
        difficultyRating: ja.difficulty_rating ?? null,
        technicianNotes: ja.technician_notes ?? null,
        mechanicFindings: ja.mechanic_findings ?? null,
        additionalObservations: ja.additional_observations ?? null,
        odometerIn: ja.odometer_in ?? null,
        completionMileage: ja.completion_mileage ?? null,
        inProgressNotes: ja.in_progress_notes ?? null,
        inProgressPhotos: photos.filter((p): p is { url: string; caption: string | null; takenAt: number } => p.url != null),
        hasPrejobReport: ja.prejob_report != null,
        hasPostjobReport: ja.postjob_report != null,
      };
    }

    // Structured post-job recommendations logged by the mechanic.
    const recRows = await ctx.db
      .query("job_recommendations")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", id))
      .collect();
    const recommendations = await Promise.all(
      recRows
        .sort((a, b) => b.created_at - a.created_at)
        .map(async (r) => {
          let serviceName: string | null = null;
          if (r.recommended_service_id) {
            const s = await ctx.db.get(r.recommended_service_id);
            serviceName = s?.name ?? null;
          }
          return {
            id: String(r._id),
            service: serviceName,
            freeformText: r.freeform_text ?? null,
            urgency: r.urgency,
            status: r.status,
            reason: r.reason ?? null,
            authorLabel: r.author_label ?? null,
            targetMileage: r.target_mileage ?? null,
            visibleToDriver: r.visible_to_driver,
            createdAt: r.created_at,
          };
        }),
    );

    return {
      arrivedAtMs: booking.vehicle_arrived_at_ms ?? null,
      completedAtMs: booking.completed_at_ms ?? null,
      estimatedLaborMinutes: booking.estimated_labor_minutes ?? null,
      diagnosticSystem: booking.diagnostic_system ?? null,
      diagnosticFindingsNote: booking.diagnostic_findings_note ?? null,
      diagnosticChecklistCompletedAtMs: booking.diagnostic_checklist_completed_at_ms ?? null,
      diagnosticChecklist: (booking.diagnostic_checklist ?? []).map((c) => ({
        label: c.label,
        status: c.status,
        mechanicNote: c.mechanic_note ?? null,
        skipReason: c.skip_reason ?? null,
      })),
      recommendationState: booking.recommendation_state ?? null,
      recommendedServiceName,
      recommendationSentAtMs: booking.recommendation_sent_at_ms ?? null,
      recommendationDecidedAtMs: booking.recommendation_decided_at_ms ?? null,
      recommendations,
      jobActual,
    };
  },
});

// ---------------------------------------------------------------------------
// moneyDetail — the approval + quote + dispute money trail. Every approval
// cycle (submit + decision, actor-resolved), running ceiling / final capture,
// mechanic-vs-catalog quote, and both dispute tables. Pairs with detail's
// disclosed/quoted breakdown + priced parts (Money & approvals tab).
// ---------------------------------------------------------------------------
export const moneyDetail = query({
  args: { token: v.string(), id: v.id("bookings") },
  handler: async (ctx, { token, id }) => {
    await requireDirector(ctx, token);
    const booking = await ctx.db.get(id);
    if (!booking) return null;

    const approvalRows = await ctx.db
      .query("booking_approvals")
      .withIndex("by_booking_and_cycle", (q) => q.eq("booking_id", id))
      .collect();
    approvalRows.sort((a, b) => a.submitted_at_ms - b.submitted_at_ms);
    const approvals = await Promise.all(
      approvalRows.map(async (a) => ({
        cycle: a.cycle,
        submittedAtMs: a.submitted_at_ms,
        submittedBy: a.submitted_by_user_id
          ? userDisplayName(await ctx.db.get(a.submitted_by_user_id))
          : null,
        mechanicSetPrice: centsToDollars(a.mechanic_set_price_cents),
        priorCeiling: centsToDollars(a.prior_ceiling_cents),
        over: a.mechanic_set_price_cents > a.prior_ceiling_cents,
        parts: centsToDollars(a.parts_subtotal_cents),
        labor: centsToDollars(a.labor_cents),
        tax: centsToDollars(a.tax_cents),
        serviceFee: centsToDollars(a.service_fee_cents),
        decision: a.decision ?? null,
        decidedAtMs: a.decided_at_ms ?? null,
        decidedBy: a.decided_by_user_id
          ? userDisplayName(await ctx.db.get(a.decided_by_user_id))
          : a.decision_actor ?? null,
        ceilingAfter: centsToDollars(a.ceiling_after_decision_cents),
        slaExpiresAtMs: a.sla_expires_at_ms ?? null,
        stripeAction: a.stripe_action ?? null,
        notes: a.notes ?? null,
      })),
    );

    const [bDisputes, pDisputes, tireRows, rotorRows, dismissalRows] = await Promise.all([
      ctx.db
        .query("booking_disputes")
        .withIndex("by_booking_id", (q) => q.eq("booking_id", id))
        .collect(),
      ctx.db
        .query("payment_disputes")
        .withIndex("by_booking_id", (q) => q.eq("booking_id", id))
        .collect(),
      ctx.db
        .query("tire_quote_responses")
        .withIndex("by_booking_id", (q) => q.eq("booking_id", id))
        .collect(),
      ctx.db
        .query("rotor_quote_responses")
        .withIndex("by_booking_id", (q) => q.eq("booking_id", id))
        .collect(),
      ctx.db
        .query("quote_request_dismissals")
        .withIndex("by_booking_id", (q) => q.eq("booking_id", id))
        .collect(),
    ]);

    // Shop-name cache for the quote responses / dismissals.
    const shopName = new Map<string, string | null>();
    const nameOfShop = async (sid: Id<"shops">): Promise<string | null> => {
      const key = String(sid);
      if (!shopName.has(key)) {
        const s = await ctx.db.get(sid);
        shopName.set(key, (s as { name?: string } | null)?.name ?? null);
      }
      return shopName.get(key) ?? null;
    };
    const tireQuotes = await Promise.all(
      tireRows.map(async (t) => ({
        id: String(t._id),
        shop: await nameOfShop(t.shop_id),
        brand: t.tire_brand,
        model: t.tire_model ?? null,
        perUnit: t.per_tire_price,
        quantity: t.quantity,
        labor: t.labor_cost,
        total: t.total,
        availability: t.availability ? `${t.availability.date} ${t.availability.time}` : null,
        expiresAtMs: t.expires_at ?? null,
        superseded: t.superseded_at != null,
      })),
    );
    const rotorQuotes = await Promise.all(
      rotorRows.map(async (r) => ({
        id: String(r._id),
        shop: await nameOfShop(r.shop_id),
        brand: r.rotor_brand,
        model: r.rotor_model ?? null,
        perUnit: r.per_rotor_price,
        quantity: r.quantity,
        labor: r.labor_cost,
        total: r.total,
        padBrand: r.pad_brand ?? null,
        availability: r.availability ? `${r.availability.date} ${r.availability.time}` : null,
        expiresAtMs: r.expires_at ?? null,
        superseded: r.superseded_at != null,
      })),
    );
    const dismissals = await Promise.all(
      dismissalRows.map(async (d) => ({
        id: String(d._id),
        shop: await nameOfShop(d.shop_id),
        kind: d.kind,
        dismissedAtMs: d.dismissed_at,
      })),
    );

    return {
      approvalState: booking.payment_approval_state ?? null,
      runningApprovedCeiling: centsToDollars(booking.running_approved_ceiling_cents),
      mechanicSetPrice: centsToDollars(booking.mechanic_set_price_cents),
      finalTotal: centsToDollars(booking.final_total_cents),
      finalCaptureAmount: centsToDollars(booking.final_capture_amount_cents),
      slaExpiresAtMs: booking.sla_expires_at_ms ?? null,
      // Settlement tracking (completed jobs still owed money).
      settlementState: booking.settlement_state ?? null,
      settlementShortfall: centsToDollars(booking.settlement_shortfall_cents),
      settlementReason: booking.settlement_reason ?? null,
      awaitingSettlementSinceMs: booking.awaiting_settlement_since_ms ?? null,
      // Walk-in baselines (dollars on the row).
      mechanicQuotedPrice: booking.mechanic_quoted_price ?? null,
      catalogQuotedPrice: booking.catalog_quoted_price ?? null,
      mechanicEstimatedMinutes: booking.mechanic_estimated_minutes ?? null,
      catalogEstimatedMinutes: booking.catalog_estimated_minutes ?? null,
      quoteFlags: booking.quote_flags ?? [],
      lowConfidenceParts: booking.low_confidence_parts ?? false,
      serviceQuoteFlagCount: (booking.service_quote_flags ?? []).reduce(
        (n, s) => n + (s.flags?.length ?? 0),
        0,
      ),
      approvals,
      bookingDisputes: bDisputes.map((d) => ({
        id: String(d._id),
        reason: d.reason,
        status: d.status,
        notes: d.notes ?? null,
        disputedPartKeys: d.disputed_part_keys ?? [],
        filedAtMs: d.filed_at_ms,
        resolvedAtMs: d.resolved_at_ms ?? null,
        resolution: d.resolution ?? null,
        resolutionRefund: centsToDollars(d.resolution_refund_cents),
        resolutionNotes: d.resolution_notes ?? null,
      })),
      paymentDisputes: pDisputes.map((d) => ({
        id: String(d._id),
        stripeDisputeId: d.stripe_dispute_id,
        amount: centsToDollars(d.amount_cents),
        reason: d.reason ?? null,
        status: d.status,
        openedAtMs: d.opened_at_ms,
        closedAtMs: d.closed_at_ms ?? null,
        evidenceDueByMs: d.evidence_due_by_ms ?? null,
      })),
      // Shop responses to quote-stage tire/rotor requests + dismissals.
      tireQuotes,
      rotorQuotes,
      dismissals,
    };
  },
});
