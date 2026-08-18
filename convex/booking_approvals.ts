/**
 * booking_approvals.ts — Pre-Job / Mid-Job / Post-Job approval loop
 *
 * Mechanic submits a singular set-price (parts + labor) via
 * post-job-survey-dialog. The mutation re-computes the all-in total
 * server-side (tax + platform fee), then classifies against the customer's
 * disclosed range (pre-job) or running approved ceiling (mid/post-job).
 *
 *   in-range  → auto-approve: increment Stripe hold to the new total
 *               silently and push the customer a confirmation.
 *   over      → open an approval cycle (24h SLA), push the customer.
 *
 * Every submission inserts a `booking_approvals` row. Decisions land via
 * `applyApprovalDecision` (customer auth). SLA expiry on pre-job captures
 * the $20 deposit forfeit; SLA expiry on mid-job holds work at the prior
 * ceiling.
 *
 * Auth boundaries:
 *   - submit* mutations require shop membership matching booking.shop_id.
 *   - applyApprovalDecision requires booking.user_id === caller.
 *   - expireApprovals + submitPostJobReapproval are internal (cron / action).
 */

import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { postjobPartValidator } from "./lib/vehicle_passports";
import { computeBookingTax } from "../lib/tax";
import { computePlatformFeeDollars } from "../lib/platformFee";
import { BOOKING_DEPOSIT_CENTS } from "./lib/payment_constants";
import {
  buildCustomerInspectionSnapshot,
  type CustomerInspectionSnapshot,
} from "../lib/inspection-measurements";

const SLA_MS = 24 * 60 * 60 * 1000;
const MIN_MANUAL_JUSTIFICATION_LEN = 12;

// ─────────────────────────────────────────────────────────────────────────
// Auth helpers (local copies — mirror convex/bookings.ts pattern)
// ─────────────────────────────────────────────────────────────────────────

async function getCurrentUserOrNull(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) =>
      q.eq("clerkUserId", identity.subject),
    )
    .unique();
}

/** Asserts the caller is a member of the booking's shop. Used by every
 *  mechanic-facing submit*. Returns the loaded booking + caller user. */
async function requireShopStaffForBooking(
  ctx: any,
  bookingId: Id<"bookings">,
) {
  const user = await getCurrentUserOrNull(ctx);
  if (!user) throw new Error("Your session has expired. Please sign in again.");
  const booking = await ctx.db.get(bookingId);
  if (!booking) throw new Error("Booking not found.");
  if (!booking.shop_id) throw new Error("Booking has no shop assigned.");

  const membership = await ctx.db
    .query("shop_users")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", user._id))
    .filter((q: any) => q.eq(q.field("is_active"), true))
    .first();

  const ownedShop = await ctx.db
    .query("shops")
    .withIndex("by_owner_user_id", (q: any) => q.eq("owner_user_id", user._id))
    .first();

  const isMember =
    (membership && String(membership.shop_id) === String(booking.shop_id)) ||
    (ownedShop && String(ownedShop._id) === String(booking.shop_id));

  if (!isMember) throw new Error("You are not assigned to this booking.");
  return { user, booking };
}

// ─────────────────────────────────────────────────────────────────────────
// Pricing helpers
// ─────────────────────────────────────────────────────────────────────────

type SubmittedPart = {
  part_name: string;
  brand?: string | null;
  oem_number: string;
  cost: number;
  quantity?: number;
  supplied_by?: string;
  part_tier?: string;
  service_id?: Id<"services">;
  source?: "catalog" | "manual";
  swap_from_oem_number?: string;
  not_used?: boolean;
  justification_text?: string;
  evidence_photo_ids?: Id<"_storage">[];
  verified_against_catalog_median_cents?: number;
};

function partsSubtotalCents(parts: SubmittedPart[]): number {
  let total = 0;
  for (const p of parts) {
    if (p.not_used) continue;
    if (p.supplied_by === "customer") continue;
    const qty = Math.max(0, p.quantity ?? 1);
    total += Math.round((p.cost ?? 0) * qty * 100);
  }
  return total;
}

/** Validates parts gate: manual parts need a justification of ≥12 chars.
 *  UI is expected to enforce the catalog-median cap; this is a server-side
 *  defense (justification only — the median cap requires loading the part
 *  catalog and is the dialog's responsibility). */
function validatePartsForApproval(parts: SubmittedPart[]): void {
  for (const p of parts) {
    if (p.not_used) continue;
    if (p.supplied_by === "customer") continue;
    if (p.source === "manual") {
      const j = (p.justification_text ?? "").trim();
      if (j.length < MIN_MANUAL_JUSTIFICATION_LEN) {
        throw new Error(
          `Manual part "${p.part_name}" requires a justification of at least ${MIN_MANUAL_JUSTIFICATION_LEN} characters.`,
        );
      }
    }
  }
}

type SetPriceComputed = {
  parts_subtotal_cents: number;
  labor_cents: number;
  tax_cents: number;
  service_fee_cents: number;
  total_cents: number;
};

/** Recompute the all-in mechanic set price server-side. Tax + platform fee
 *  are server-authoritative — the dialog only sends parts + labor inputs. */
async function computeMechanicSetPrice(
  ctx: any,
  args: {
    booking: any;
    parts: SubmittedPart[];
    laborHours: number | undefined;
    laborRateCents: number | undefined;
  },
): Promise<SetPriceComputed> {
  const { booking, parts, laborHours, laborRateCents } = args;

  const partsSubCents = partsSubtotalCents(parts);
  // Fall back to the booking's stored labor when the dialog didn't override.
  const laborDollarsFallback = booking.labor_cost ?? 0;
  const laborCents =
    laborHours != null && laborRateCents != null
      ? Math.round(laborHours * laborRateCents)
      : Math.round(laborDollarsFallback * 100);

  const subtotalCents = partsSubCents + laborCents;
  const subtotalDollars = subtotalCents / 100;

  // Shop state for tax: best-effort. Without a state, computeBookingTax
  // returns its default rule (0% / no-tax) — acceptable for the approval
  // recompute since the disclosed range was snapshotted at booking time.
  const shop = booking.shop_id ? await ctx.db.get(booking.shop_id) : null;
  const shopState =
    (shop?.address_state as string | undefined) ??
    (shop?.state as string | undefined) ??
    null;
  const shopZip =
    (shop?.address_zip as string | undefined) ??
    (shop?.zip as string | undefined) ??
    null;

  const taxResult = computeBookingTax({
    laborDollars: laborCents / 100,
    partsDollars: partsSubCents / 100,
    state: shopState ?? null,
    zip: shopZip ?? null,
  });
  const taxCents = Math.round((taxResult.taxDollars ?? 0) * 100);

  const feeDollars = computePlatformFeeDollars(subtotalDollars);
  const feeCents = Math.max(0, Math.round(feeDollars * 100));

  return {
    parts_subtotal_cents: partsSubCents,
    labor_cents: laborCents,
    tax_cents: taxCents,
    service_fee_cents: feeCents,
    total_cents: subtotalCents + taxCents + feeCents,
  };
}

function ceilingForCycle(booking: any, cycle: string): number {
  if (cycle === "pre_job") {
    return booking.disclosed_range_high_cents ?? 0;
  }
  // mid_job / post_job evaluate against the latest approved ceiling
  return (
    booking.running_approved_ceiling_cents ??
    booking.disclosed_range_high_cents ??
    0
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Shared submission handler (used by pre-job + mid-job mutations and the
// post-job internal mutation)
// ─────────────────────────────────────────────────────────────────────────

type SubmitArgs = {
  bookingId: Id<"bookings">;
  cycle: "pre_job" | "mid_job" | "post_job";
  parts: SubmittedPart[];
  laborHours?: number;
  laborRateCents?: number;
  notes?: string;
  submittedByUserId?: Id<"users">;
};

async function getInspectionSnapshotForBooking(
  ctx: any,
  bookingId: Id<"bookings">,
): Promise<CustomerInspectionSnapshot | null> {
  const actual = await ctx.db
    .query("job_actuals")
    .withIndex("by_booking_id", (q: any) => q.eq("booking_id", bookingId))
    .order("desc")
    .first();
  return buildCustomerInspectionSnapshot({
    tire_tread: actual?.prejob_report?.tire_tread,
    brakes: actual?.prejob_report?.brakes,
  });
}

async function performSubmission(
  ctx: any,
  args: SubmitArgs,
): Promise<{
  approvalId: Id<"booking_approvals">;
  state: string;
  totalCents: number;
  ceilingCents: number;
}> {
  const booking: any = await ctx.db.get(args.bookingId);
  if (!booking) throw new Error("Booking not found.");

  validatePartsForApproval(args.parts);

  const priced = await computeMechanicSetPrice(ctx, {
    booking,
    parts: args.parts,
    laborHours: args.laborHours,
    laborRateCents: args.laborRateCents,
  });
  const inspectionSnapshot = await getInspectionSnapshotForBooking(
    ctx,
    args.bookingId,
  );

  // Fixed-price bookings: parts/labor updates are audit-only. Customer
  // agreed to a flat price (shop_service_fixed_prices); mechanic edits get
  // logged on booking_approvals but never alter the booking total, never
  // trip a Stripe authorization adjust, and never push the customer an
  // approval prompt. Path returns early after the audit insert.
  const isFixedPrice = booking.is_fixed_price === true;
  if (isFixedPrice) {
    return performFixedPriceInformationalSubmission(ctx, {
      bookingId: args.bookingId,
      cycle: args.cycle,
      parts: args.parts,
      laborHours: args.laborHours,
      laborRateCents: args.laborRateCents,
      notes: args.notes,
      submittedByUserId: args.submittedByUserId,
      priced,
      inspectionSnapshot,
    });
  }

  const ceiling = ceilingForCycle(booking, args.cycle);
  // Pre-feature bookings (no disclosed range): there's no approval contract
  // — fall back to legacy behavior at capture time. Reject submission here.
  if (args.cycle === "pre_job" && ceiling <= 0) {
    throw new Error(
      "This booking pre-dates the pre-job approval flow and cannot be re-estimated.",
    );
  }

  // Idempotency: if a booking moves to "completed" twice in quick succession
  // (or finalize is rescheduled) we'd otherwise insert a second open
  // post-job approval row. Reuse the existing open row instead.
  if (args.cycle === "post_job") {
    const existing = await ctx.db
      .query("booking_approvals")
      .withIndex("by_booking_and_cycle", (q: any) =>
        q.eq("booking_id", args.bookingId).eq("cycle", "post_job"),
      )
      .order("desc")
      .collect();
    const openPostJob = existing.find((r: any) => r.decision == null);
    if (openPostJob) {
      return {
        approvalId: openPostJob._id,
        state:
          (booking.payment_approval_state as string | undefined) ??
          "post_job_pending",
        totalCents: openPostJob.mechanic_set_price_cents,
        ceilingCents: openPostJob.prior_ceiling_cents,
      };
    }
  }

  const inRange = priced.total_cents <= ceiling;
  const now = Date.now();

  // Payment intent linkage for the audit row.
  const payment = await ctx.db
    .query("payments")
    .withIndex("by_booking_id", (q: any) => q.eq("booking_id", args.bookingId))
    .unique();
  const piId = payment?.stripe_payment_intent_id ?? undefined;

  const approvalId = await ctx.db.insert("booking_approvals", {
    booking_id: args.bookingId,
    cycle: args.cycle,
    mechanic_set_price_cents: priced.total_cents,
    parts_subtotal_cents: priced.parts_subtotal_cents,
    labor_cents: priced.labor_cents,
    tax_cents: priced.tax_cents,
    service_fee_cents: priced.service_fee_cents,
    parts_snapshot: args.parts as any,
    labor_hours: args.laborHours,
    labor_rate_cents: args.laborRateCents,
    notes: args.notes,
    inspection_snapshot: inspectionSnapshot ?? undefined,
    prior_ceiling_cents: ceiling,
    ceiling_after_decision_cents: inRange ? priced.total_cents : undefined,
    sla_expires_at_ms: inRange ? undefined : now + SLA_MS,
    submitted_at_ms: now,
    submitted_by_user_id: args.submittedByUserId,
    decision: inRange ? "auto_approved_within_range" : undefined,
    decided_at_ms: inRange ? now : undefined,
    decision_actor: inRange ? "system" : undefined,
    stripe_payment_intent_id: piId,
    stripe_action: inRange ? "auto_approved_within_range" : undefined,
  });

  const newState = inRange
    ? "in_range"
    : args.cycle === "pre_job"
      ? "pre_job_pending"
      : args.cycle === "mid_job"
        ? "mid_job_pending"
        : "post_job_pending";

  const bookingPatch: any = {
    payment_approval_state: newState,
    mechanic_set_price_cents: priced.total_cents,
    updated_at: now,
  };
  if (inRange) {
    bookingPatch.running_approved_ceiling_cents = priced.total_cents;
    bookingPatch.estimate_approved_at_ms = now;
    bookingPatch.sla_expires_at_ms = undefined;
    // Auto-approved within range → the re-quote is agreed. Sync the booking's
    // stored totals so every surface (lists, detail panel, invoices) shows the
    // agreed amount instead of the original estimate. (Out-of-range stays
    // pending; totals are synced on customer approval in applyApprovalDecision.)
    bookingPatch.total_cost = priced.total_cents / 100;
    bookingPatch.parts_cost = priced.parts_subtotal_cents / 100;
    bookingPatch.labor_cost = priced.labor_cents / 100;
  } else {
    bookingPatch.sla_expires_at_ms = now + SLA_MS;
  }
  await ctx.db.patch(args.bookingId, bookingPatch);

  // Side effects (deferred so the mutation stays transactional):
  //   - in-range: increment the Stripe hold + push the customer a
  //     confirmation.
  //   - out-of-range: push the customer the approval prompt.
  if (inRange) {
    if (ctx.scheduler?.runAfter) {
      await ctx.scheduler.runAfter(
        0,
        internal.payments_stripe.adjustAuthorization,
        { bookingId: args.bookingId },
      );
    }
    await enqueueCustomerApprovalPush(ctx, {
      booking,
      bookingId: args.bookingId,
      category: "booking_estimate_in_range",
      title: "Service confirmed",
      body: `Your mechanic confirmed the work at $${(priced.total_cents / 100).toFixed(2)}. Work is starting now.`,
      deepLink: `otopair://booking/${String(args.bookingId)}`,
      dedupeSuffix: `${args.cycle}:${approvalId}`,
    });
  } else {
    await enqueueCustomerApprovalPush(ctx, {
      booking,
      bookingId: args.bookingId,
      category: `booking_${args.cycle}_pending`,
      title:
        args.cycle === "pre_job"
          ? "Your car requires more than we expected"
          : args.cycle === "mid_job"
            ? "Update from your mechanic"
            : "Final breakdown — please confirm",
      body: "Tap to review your mechanic's updated estimate.",
      deepLink: `otopair://booking/${String(args.bookingId)}/approve-estimate`,
      dedupeSuffix: `${args.cycle}:${approvalId}`,
    });
  }

  return {
    approvalId,
    state: newState,
    totalCents: priced.total_cents,
    ceilingCents: ceiling,
  };
}

/** Fixed-price submission path — log the mechanic's edited parts/labor on
 *  booking_approvals for audit, but do NOT touch the booking total,
 *  payment_approval_state, Stripe authorization, or the customer. The
 *  customer's contracted price came from shop_service_fixed_prices and
 *  stays locked. */
async function performFixedPriceInformationalSubmission(
  ctx: any,
  args: {
    bookingId: Id<"bookings">;
    cycle: "pre_job" | "mid_job" | "post_job";
    parts: SubmittedPart[];
    laborHours: number | undefined;
    laborRateCents: number | undefined;
    notes: string | undefined;
    submittedByUserId: Id<"users"> | undefined;
    priced: SetPriceComputed;
    inspectionSnapshot: CustomerInspectionSnapshot | null;
  },
): Promise<{
  approvalId: Id<"booking_approvals">;
  state: string;
  totalCents: number;
  ceilingCents: number;
}> {
  const now = Date.now();
  // Snapshot the customer-locked price as the "ceiling" on the audit row so
  // the activity log can compare mechanic-computed vs locked side-by-side.
  const bookingRow: any = await ctx.db.get(args.bookingId);
  const lockedCents =
    bookingRow?.mechanic_set_price_cents ??
    Math.round((bookingRow?.total_cost ?? 0) * 100);
  const approvalId = await ctx.db.insert("booking_approvals", {
    booking_id: args.bookingId,
    cycle: args.cycle,
    mechanic_set_price_cents: args.priced.total_cents,
    parts_subtotal_cents: args.priced.parts_subtotal_cents,
    labor_cents: args.priced.labor_cents,
    tax_cents: args.priced.tax_cents,
    service_fee_cents: args.priced.service_fee_cents,
    parts_snapshot: args.parts as any,
    labor_hours: args.laborHours,
    labor_rate_cents: args.laborRateCents,
    notes: args.notes,
    inspection_snapshot: args.inspectionSnapshot ?? undefined,
    prior_ceiling_cents: lockedCents,
    ceiling_after_decision_cents: lockedCents,
    submitted_at_ms: now,
    submitted_by_user_id: args.submittedByUserId,
    decision: "fixed_price_informational",
    decided_at_ms: now,
    decision_actor: "system",
  });
  return {
    approvalId,
    state: "fixed_price_locked",
    totalCents: lockedCents,
    ceilingCents: lockedCents,
  };
}

async function enqueueCustomerApprovalPush(
  ctx: any,
  args: {
    booking: any;
    bookingId: Id<"bookings">;
    category: string;
    title: string;
    body: string;
    deepLink: string;
    dedupeSuffix: string;
  },
) {
  const userId = args.booking.user_id;
  if (!userId) return;
  const dedupeKey = `${args.category}:${String(args.bookingId)}:${args.dedupeSuffix}`;
  await ctx.db.insert("notification_outbox", {
    user_id: userId,
    booking_id: args.bookingId,
    shop_id: args.booking.shop_id,
    channel: "push",
    category: args.category,
    status: "pending",
    dedupe_key: dedupeKey,
    payload: {
      title: args.title,
      body: args.body,
      data: { deepLink: args.deepLink, bookingId: String(args.bookingId) },
    },
    created_at: Date.now(),
    updated_at: Date.now(),
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Public mutations
// ─────────────────────────────────────────────────────────────────────────

export const submitPreJobEstimate = mutation({
  args: {
    bookingId: v.id("bookings"),
    parts: v.array(postjobPartValidator),
    laborHours: v.optional(v.number()),
    laborRateCents: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireShopStaffForBooking(ctx, args.bookingId);
    return await performSubmission(ctx, {
      bookingId: args.bookingId,
      cycle: "pre_job",
      parts: args.parts as SubmittedPart[],
      laborHours: args.laborHours,
      laborRateCents: args.laborRateCents,
      notes: args.notes,
      submittedByUserId: user._id,
    });
  },
});

export const submitMidJobChange = mutation({
  args: {
    bookingId: v.id("bookings"),
    parts: v.array(postjobPartValidator),
    laborHours: v.optional(v.number()),
    laborRateCents: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user, booking } = await requireShopStaffForBooking(
      ctx,
      args.bookingId,
    );
    if (booking.status !== "in_progress") {
      throw new Error(
        "Mid-job changes can only be submitted while the booking is in progress.",
      );
    }
    return await performSubmission(ctx, {
      bookingId: args.bookingId,
      cycle: "mid_job",
      parts: args.parts as SubmittedPart[],
      laborHours: args.laborHours,
      laborRateCents: args.laborRateCents,
      notes: args.notes,
      submittedByUserId: user._id,
    });
  },
});

/** Invoked by finalizeAndChargeForBooking when the captured actuals exceed
 *  the last approved ceiling. Not customer-callable. */
export const submitPostJobReapproval = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    parts: v.array(postjobPartValidator),
    laborHours: v.optional(v.number()),
    laborRateCents: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await performSubmission(ctx, {
      bookingId: args.bookingId,
      cycle: "post_job",
      parts: args.parts as SubmittedPart[],
      laborHours: args.laborHours,
      laborRateCents: args.laborRateCents,
      notes: args.notes,
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────
// Customer decision
// ─────────────────────────────────────────────────────────────────────────

export const applyApprovalDecision = mutation({
  args: {
    bookingId: v.id("bookings"),
    decision: v.union(v.literal("approved"), v.literal("declined")),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) throw new Error("Your session has expired. Please sign in again.");

    const booking: any = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found.");
    if (String(booking.user_id) !== String(user._id)) {
      throw new Error("Not your booking.");
    }

    // Latest open approval row (decision null). Convex indexes don't
    // support eq(undefined), so we paginate by booking_id descending and
    // pick the first row whose decision hasn't been set yet.
    const candidates = await ctx.db
      .query("booking_approvals")
      .withIndex("by_booking_and_cycle", (q: any) =>
        q.eq("booking_id", args.bookingId),
      )
      .order("desc")
      .collect();
    const open = candidates.find((r: any) => r.decision == null);

    if (!open) {
      throw new Error("No estimate is waiting for your decision.");
    }

    const now = Date.now();
    const cycle = open.cycle as "pre_job" | "mid_job" | "post_job";

    if (args.decision === "approved") {
      const newCeiling = open.mechanic_set_price_cents;
      await ctx.db.patch(open._id, {
        decision: "approved",
        decided_at_ms: now,
        decided_by_user_id: user._id,
        ceiling_after_decision_cents: newCeiling,
      });
      await ctx.db.patch(args.bookingId, {
        payment_approval_state:
          cycle === "pre_job"
            ? "pre_job_approved"
            : cycle === "mid_job"
              ? "mid_job_approved"
              : "post_job_approved",
        running_approved_ceiling_cents: newCeiling,
        estimate_approved_at_ms: now,
        estimate_decided_by_user_id: user._id,
        sla_expires_at_ms: undefined,
        // Customer approved the re-quote → it's the agreed price. Sync the
        // booking's stored totals from the approved breakdown so every surface
        // shows the agreed amount, not the original estimate.
        total_cost: (open.mechanic_set_price_cents ?? 0) / 100,
        parts_cost: (open.parts_subtotal_cents ?? 0) / 100,
        labor_cost: (open.labor_cents ?? 0) / 100,
        updated_at: now,
      });
      if (ctx.scheduler?.runAfter) {
        await ctx.scheduler.runAfter(
          0,
          internal.payments_stripe.adjustAuthorization,
          { bookingId: args.bookingId },
        );
        if (cycle === "post_job") {
          // Final actuals already > approved ceiling. Approved → finalize
          // capture against the new ceiling.
          await ctx.scheduler.runAfter(
            0,
            internal.payments_stripe.finalizeAndChargeForBooking,
            { bookingId: args.bookingId },
          );
        }
      }
      return { ok: true, state: "approved", ceilingCents: newCeiling };
    }

    // Declined branch
    await ctx.db.patch(open._id, {
      decision: "declined",
      decided_at_ms: now,
      decided_by_user_id: user._id,
      ceiling_after_decision_cents:
        booking.running_approved_ceiling_cents ??
        booking.disclosed_range_high_cents ??
        undefined,
    });
    const declinedState =
      cycle === "pre_job"
        ? "pre_job_declined"
        : cycle === "mid_job"
          ? "mid_job_declined"
          : "post_job_declined";
    await ctx.db.patch(args.bookingId, {
      payment_approval_state: declinedState,
      estimate_decided_by_user_id: user._id,
      sla_expires_at_ms: undefined,
      updated_at: now,
    });
    if (cycle === "post_job" && ctx.scheduler?.runAfter) {
      // Capture at the prior approved ceiling. finalizeAndChargeForBooking
      // honors min(approved_ceiling, actuals) when forceCaptureAtCeiling is
      // set — without the flag it'd see final > mechanic_set and reopen
      // another post-job re-approval cycle indefinitely.
      await ctx.scheduler.runAfter(
        0,
        internal.payments_stripe.finalizeAndChargeForBooking,
        { bookingId: args.bookingId, forceCaptureAtCeiling: true },
      );
    }
    return { ok: true, state: declinedState };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// Query: open approval for a booking (customer side)
// ─────────────────────────────────────────────────────────────────────────

export const getOpenApprovalForBooking = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return null;
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) return null;
    if (String((booking as any).user_id) !== String(user._id)) return null;

    const candidates = await ctx.db
      .query("booking_approvals")
      .withIndex("by_booking_and_cycle", (q: any) =>
        q.eq("booking_id", args.bookingId),
      )
      .order("desc")
      .collect();
    const open = candidates.find((r: any) => r.decision == null);
    if (!open) return null;

    return {
      _id: open._id,
      cycle: open.cycle,
      mechanic_set_price_cents: open.mechanic_set_price_cents,
      prior_ceiling_cents: open.prior_ceiling_cents,
      parts_snapshot: open.parts_snapshot,
      labor_hours: open.labor_hours,
      labor_rate_cents: open.labor_rate_cents,
      notes: open.notes,
      inspection_snapshot: open.inspection_snapshot,
      submitted_at_ms: open.submitted_at_ms,
      sla_expires_at_ms: open.sla_expires_at_ms,
      disclosed_range_low_cents: (booking as any).disclosed_range_low_cents,
      disclosed_range_high_cents: (booking as any).disclosed_range_high_cents,
    };
  },
});

/**
 * Shop-facing: the EFFECTIVE agreed quote for a booking — the latest approved
 * mechanic adjustment (pre/mid-job) if any, with its frozen breakdown. Drives
 * the read-only post-job confirmation so it shows the price the customer
 * actually agreed to (parts → labor → tax/fee → total), all from one source so
 * the numbers reconcile. Returns null when no adjustment was approved (the
 * caller then falls back to the booking's original quote).
 */
/**
 * Approval rows, genuinely newest-first.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * `.order("desc")` on `by_booking_and_cycle` does NOT give you this. That index
 * is ["booking_id", "cycle"], so descending sorts by the CYCLE STRING:
 *
 *     "pre_job"  >  "post_job"  >  "mid_job"
 *
 * So "the first row" was always the pre-job one, whatever had happened since.
 * Three separate reads took that first row as "latest" — including the
 * customer-facing receipt — which meant a mid-job change the customer had
 * approved and paid for was invisible downstream: the post-job confirmation
 * showed the original parts list and the original total, short by exactly the
 * work that had just been added.
 *
 * Sort by when the customer actually answered. `_creationTime` covers rows
 * written before `decided_at_ms` existed.
 */
function approvalsNewestFirst<T extends { decided_at_ms?: number; _creationTime?: number }>(
  rows: T[],
): T[] {
  return [...rows].sort(
    (a, b) =>
      (b.decided_at_ms ?? b._creationTime ?? 0) -
      (a.decided_at_ms ?? a._creationTime ?? 0),
  );
}

export const getEffectiveQuoteForBooking = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return null;
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) return null;
    // Soft shop-staff check. Must authorize the same viewers as requireShopStaff
    // (which gates the panel): shop_users members AND the shop OWNER. The owner
    // often has no shop_users row, so a shop_users-only check would return null
    // for them and the read-only post-job dialog would silently fall back to the
    // pre-approval snapshot (stale $0 parts) instead of the agreed quote.
    // (The assigned mechanic is covered by the shop_users branch: their
    // membership row is what links user → mechanics roster in the first place.)
    const membership = await ctx.db
      .query("shop_users")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", user._id))
      .collect();
    let inShop = membership.some(
      (m: any) => String(m.shop_id) === String((booking as any).shop_id),
    );
    if (!inShop) {
      const shop = await ctx.db.get((booking as any).shop_id);
      if (shop && String((shop as any).owner_user_id) === String(user._id)) {
        inShop = true;
      }
    }
    if (!inShop) return null;

    const rows = await ctx.db
      .query("booking_approvals")
      .withIndex("by_booking_and_cycle", (q: any) =>
        q.eq("booking_id", args.bookingId),
      )
      .order("desc")
      .collect();

    const APPROVED = new Set([
      "approved",
      "auto_approved_within_range",
    ]);
    // ─── ORDER BY TIME, NOT BY INDEX ──────────────────────────────────────
    // `by_booking_and_cycle` is ["booking_id", "cycle"], so `.order("desc")`
    // sorts by the CYCLE STRING — not by recency, whatever the previous
    // comment here claimed. Descending that reads
    // "pre_job" > "post_job" > "mid_job", so the first approved row found was
    // always the PRE-JOB one.
    //
    // The effect: every mid-job change the customer approved was invisible to
    // the post-job confirmation. The mechanic confirmed against the original
    // quote — the extra work missing from the parts list and the total short
    // by whatever had been added — while the booking itself carried the
    // correct, higher figure. Two numbers for one job, and the wrong one in
    // front of the person signing it off.
    const eff = approvalsNewestFirst(rows as any[]).find(
      (r: any) =>
        APPROVED.has(r.decision ?? "") &&
        r.parts_subtotal_cents != null &&
        r.labor_cents != null,
    );
    if (!eff) return null;

    const partsCents = eff.parts_subtotal_cents ?? 0;
    const laborCents = eff.labor_cents ?? 0;
    const taxCents = eff.tax_cents ?? 0;
    const feeCents = eff.service_fee_cents ?? 0;
    return {
      cycle: eff.cycle as string,
      totalCents: eff.mechanic_set_price_cents,
      partsCents,
      laborCents,
      taxCents,
      feeCents,
      partsSnapshot: eff.parts_snapshot ?? [],
    };
  },
});

/**
 * Customer-facing twin of `getEffectiveQuoteForBooking`. Drives the itemized
 * breakdown on the card-hold re-authorization screen (`ReauthView`) so the
 * customer sees what parts/labor make up the hold they're confirming.
 *
 * Source priority, both normalized into ONE cents-based shape so the client
 * has a single render path:
 *   1. The latest APPROVED approval row (the estimate that set the running
 *      ceiling). `parts_snapshot` is the post-job validator shape where `cost`
 *      is in DOLLARS — converted to cents here.
 *   2. Fallback: the booking's original frozen quote (`quoted_breakdown` +
 *      `priced_parts_snapshot`, already cents-based) when no adjustment was
 *      ever approved — the in-range reauth case.
 * Returns null only when neither source has usable data; the client then
 * keeps its total-only layout.
 */
export const getReauthBreakdownForBooking = query({
  args: { bookingId: v.id("bookings") },
  returns: v.union(
    v.null(),
    v.object({
      source: v.union(v.literal("approved"), v.literal("quote")),
      cycle: v.union(v.string(), v.null()),
      totalCents: v.number(),
      partsCents: v.number(),
      laborCents: v.number(),
      taxCents: v.number(),
      feeCents: v.number(),
      laborHours: v.union(v.number(), v.null()),
      notes: v.union(v.string(), v.null()),
      parts: v.array(
        v.object({
          part_name: v.string(),
          oem_number: v.optional(v.string()),
          brand: v.optional(v.string()),
          quantity: v.number(),
          unit_price_cents: v.number(),
          line_total_cents: v.number(),
          justification_text: v.optional(v.string()),
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return null;
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) return null;
    if (String((booking as any).user_id) !== String(user._id)) return null;

    // ── Primary: latest approved approval row ────────────────────────────
    const rows = await ctx.db
      .query("booking_approvals")
      .withIndex("by_booking_and_cycle", (q: any) =>
        q.eq("booking_id", args.bookingId),
      )
      .order("desc")
      .collect();
    const APPROVED = new Set(["approved", "auto_approved_within_range"]);
    // Newest by decision time — see approvalsNewestFirst. This one is the
    // customer's own view, so picking the pre-job row showed them a receipt
    // for work they'd already agreed to change.
    const eff = approvalsNewestFirst(rows as any[]).find(
      (r: any) =>
        APPROVED.has(r.decision ?? "") &&
        r.parts_subtotal_cents != null &&
        r.labor_cents != null,
    );

    if (eff) {
      const parts = ((eff.parts_snapshot ?? []) as any[])
        .filter((p) => !p?.not_used && p?.supplied_by !== "customer")
        .map((p) => {
          const quantity = Math.max(0, p?.quantity ?? 1);
          const unitPriceCents = Math.round((p?.cost ?? 0) * 100);
          return {
            part_name: (p?.part_name ?? "Part") as string,
            ...(p?.oem_number ? { oem_number: p.oem_number as string } : {}),
            ...(p?.brand ? { brand: p.brand as string } : {}),
            quantity,
            unit_price_cents: unitPriceCents,
            line_total_cents: Math.round((p?.cost ?? 0) * quantity * 100),
            ...(p?.justification_text
              ? { justification_text: p.justification_text as string }
              : {}),
          };
        });
      return {
        source: "approved" as const,
        cycle: (eff.cycle ?? null) as string | null,
        totalCents: eff.mechanic_set_price_cents as number,
        partsCents: (eff.parts_subtotal_cents ?? 0) as number,
        laborCents: (eff.labor_cents ?? 0) as number,
        taxCents: (eff.tax_cents ?? 0) as number,
        feeCents: (eff.service_fee_cents ?? 0) as number,
        laborHours: (eff.labor_hours ?? null) as number | null,
        notes: (eff.notes ?? null) as string | null,
        parts,
      };
    }

    // ── Fallback: booking's original frozen quote ────────────────────────
    const qb = (booking as any).quoted_breakdown as
      | {
          parts_cents: number;
          labor_cents: number;
          tax_cents: number;
          service_fee_cents: number;
        }
      | undefined;
    const snapshot = ((booking as any).priced_parts_snapshot ?? []) as any[];
    if (!qb && snapshot.length === 0) return null;

    const partsCents = qb?.parts_cents ?? 0;
    const laborCents = qb?.labor_cents ?? 0;
    const taxCents = qb?.tax_cents ?? 0;
    const feeCents = qb?.service_fee_cents ?? 0;
    // Rows the snapshotRevalidation sweep stamped as cross-make contaminated
    // are hidden from the itemization; the frozen totals above stay the
    // contract, so lines may sum to less than parts_cents — accepted.
    const parts = snapshot.filter((p) => p?.integrity_flag == null).map((p) => ({
      part_name: (p?.part_name ?? "Part") as string,
      ...(p?.oem_number ? { oem_number: p.oem_number as string } : {}),
      ...(p?.brand ? { brand: p.brand as string } : {}),
      quantity: Math.max(0, p?.quantity ?? 1),
      unit_price_cents: (p?.unit_price_cents ?? 0) as number,
      line_total_cents: (p?.line_total_cents ?? 0) as number,
    }));
    return {
      source: "quote" as const,
      cycle: null,
      totalCents: partsCents + laborCents + taxCents + feeCents,
      partsCents,
      laborCents,
      taxCents,
      feeCents,
      laborHours: null,
      notes: null,
      parts,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// SLA expiry (cron-triggered)
// ─────────────────────────────────────────────────────────────────────────

export const _listExpiredOpenApprovals = internalQuery({
  args: { nowMs: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("booking_approvals")
      .withIndex("by_sla_expires_at", (q: any) =>
        q.lt("sla_expires_at_ms", args.nowMs),
      )
      .collect();
    return rows
      .filter((r: any) => r.decision == null && r.sla_expires_at_ms != null)
      .map((r: any) => ({
        bookingId: r.booking_id as Id<"bookings">,
        cycle: r.cycle as string,
      }));
  },
});

export const expireApprovals = internalAction({
  args: {},
  handler: async (ctx): Promise<{ processed: number }> => {
    const now = Date.now();
    const expired: Array<{ bookingId: Id<"bookings">; cycle: string }> =
      await ctx.runQuery(
        internal.booking_approvals._listExpiredOpenApprovals,
        { nowMs: now },
      );
    let processed = 0;
    for (const row of expired) {
      await ctx.runMutation(internal.booking_approvals._markApprovalExpired, {
        bookingId: row.bookingId,
      });
      if (row.cycle === "pre_job") {
        // Customer never approved the initial estimate — forfeit the $20
        // deposit so the mechanic is paid for the inspection. Scheduled so a
        // single bad Stripe call doesn't poison the batch.
        await ctx.scheduler.runAfter(
          0,
          internal.payments_stripe.captureDepositForfeit,
          { bookingId: row.bookingId },
        );
      } else if (row.cycle === "mid_job") {
        // A mid-job scope increase the customer let lapse. performSubmission
        // optimistically bumped mechanic_set_price_cents at request time, so
        // roll it back to the last approved ceiling — otherwise completion
        // would capture an increase the customer never approved.
        await ctx.runMutation(
          internal.booking_approvals._revertToPriorCeilingAfterExpiry,
          { bookingId: row.bookingId },
        );
      } else if (row.cycle === "post_job") {
        // Legacy rows only — Wave 4 stopped creating post_job cycles. The
        // customer already agreed to the prior ceiling before the job started,
        // so capture that rather than let a completed job go uncaptured on a
        // lapsed prompt. captureAtAmount caps at the live hold + flags any
        // shortfall for the reconciliation cron.
        await ctx.scheduler.runAfter(
          0,
          internal.payments_stripe.finalizeAndChargeForBooking,
          { bookingId: row.bookingId, forceCaptureAtCeiling: true },
        );
      }
      processed += 1;
    }
    return { processed };
  },
});

/** Webhook reconciler — called by the `amount_capturable_updated` handler.
 *  Finds the latest approval row matching the PI and stamps the event id.
 *  Also patches payments.incremented_total_cents from Stripe's authoritative
 *  amount_capturable when it differs from our DB (covers the case where the
 *  incrementAuthorization mutation crashed mid-flight but the Stripe-side
 *  change landed). Idempotent on event id. */
export const _reconcileAmountCapturableUpdated = internalMutation({
  args: {
    stripePaymentIntentId: v.string(),
    stripeEventId: v.string(),
    amountCapturable: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Find the most recent approval row tied to this PI. Both the original
    // PI (from booking confirm) and a reauth-replacement PI should match.
    const rows = await ctx.db.query("booking_approvals").collect();
    const candidate = rows
      .filter(
        (r: any) => r.stripe_payment_intent_id === args.stripePaymentIntentId,
      )
      .sort((a: any, b: any) => b.submitted_at_ms - a.submitted_at_ms)[0];

    // Drift reconciliation: patch the payment row to match Stripe's view.
    if (args.amountCapturable != null) {
      const payment = await ctx.db
        .query("payments")
        .withIndex("by_stripe_payment_intent_id", (q: any) =>
          q.eq("stripe_payment_intent_id", args.stripePaymentIntentId),
        )
        .unique();
      if (
        payment &&
        payment.incremented_total_cents !== args.amountCapturable
      ) {
        await ctx.db.patch(payment._id, {
          incremented_total_cents: args.amountCapturable,
          updated_at: Date.now(),
        });
      }
    }

    if (!candidate) return { status: "no_match" };
    if (candidate.stripe_event_id === args.stripeEventId) {
      return { status: "already_reconciled" };
    }
    await ctx.db.patch(candidate._id, { stripe_event_id: args.stripeEventId });
    return { status: "ok", approvalId: candidate._id };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// Mechanic-side slim query + withdraw mutation
//
// `getOpenApprovalForBooking` above is customer-auth gated — a mechanic
// gets null. The estimate dialog needs a mechanic-auth query that surfaces
// the booking's approval state WITHOUT leaking the customer's disclosed
// range (anti-anchoring). This is that query.
// ─────────────────────────────────────────────────────────────────────────

export const getBookingApprovalState = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    // Mirrors `requireShopStaffForBooking` but as a soft check — queries
    // can't throw cleanly, so we return null when the caller isn't staff.
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return null;
    const booking = await ctx.db.get(args.bookingId);
    if (!booking || !(booking as any).shop_id) return null;

    const membership = await ctx.db
      .query("shop_users")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", user._id))
      .filter((q: any) => q.eq(q.field("is_active"), true))
      .first();
    const ownedShop = await ctx.db
      .query("shops")
      .withIndex("by_owner_user_id", (q: any) =>
        q.eq("owner_user_id", user._id),
      )
      .first();
    const isStaff =
      (membership &&
        String(membership.shop_id) === String((booking as any).shop_id)) ||
      (ownedShop && String(ownedShop._id) === String((booking as any).shop_id));
    if (!isStaff) return null;

    const rows = await ctx.db
      .query("booking_approvals")
      .withIndex("by_booking_and_cycle", (q: any) =>
        q.eq("booking_id", args.bookingId),
      )
      .order("desc")
      .collect();
    const byTime = approvalsNewestFirst(rows as any[]);
    const latest = byTime[0] ?? null;
    const open = byTime.find((r: any) => r.decision == null) ?? null;

    return {
      booking_status: (booking as any).status as string,
      payment_approval_state:
        ((booking as any).payment_approval_state as string | undefined) ??
        "none",
      mechanic_set_price_cents:
        ((booking as any).mechanic_set_price_cents as number | undefined) ??
        null,
      sla_expires_at_ms:
        ((booking as any).sla_expires_at_ms as number | undefined) ?? null,
      last_cycle: (latest?.cycle as string | undefined) ?? null,
      last_decision: (latest?.decision as string | undefined) ?? null,
      submitted_at_ms: (latest?.submitted_at_ms as number | undefined) ?? null,
      has_open_approval: !!open,
    };
  },
});

/** Mechanic withdraws a pending estimate before the customer decides.
 *  Marks the open approval row `withdrawn`, reverts the booking's approval
 *  state, and pushes the customer that the shop is revising the quote. */
export const withdrawPendingApproval = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const { user, booking } = await requireShopStaffForBooking(
      ctx,
      args.bookingId,
    );

    const candidates = await ctx.db
      .query("booking_approvals")
      .withIndex("by_booking_and_cycle", (q: any) =>
        q.eq("booking_id", args.bookingId),
      )
      .order("desc")
      .collect();
    const open = candidates.find((r: any) => r.decision == null);
    if (!open) {
      throw new Error("No pending estimate to withdraw.");
    }

    const now = Date.now();
    await ctx.db.patch(open._id, {
      decision: "withdrawn",
      decided_at_ms: now,
      decided_by_user_id: user._id,
    });

    // Revert booking state. If a prior cycle had approved a ceiling, we
    // keep that ceiling; otherwise drop back to "none" so the booking can
    // accept a fresh submission.
    const priorState =
      (booking as any).running_approved_ceiling_cents != null
        ? "pre_job_approved"
        : "none";
    await ctx.db.patch(args.bookingId, {
      payment_approval_state: priorState,
      sla_expires_at_ms: undefined,
      mechanic_set_price_cents: undefined,
      updated_at: now,
    });

    await enqueueCustomerApprovalPush(ctx, {
      booking,
      bookingId: args.bookingId,
      category: "booking_estimate_withdrawn",
      title: "Shop is revising the quote",
      body: "Your mechanic withdrew the previous estimate and will send an updated one.",
      deepLink: `otopair://booking/${String(args.bookingId)}`,
      dedupeSuffix: `withdrawn:${open._id}`,
    });

    return { ok: true, approvalId: open._id, state: priorState };
  },
});

export const _markApprovalExpired = internalMutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const candidates = await ctx.db
      .query("booking_approvals")
      .withIndex("by_booking_and_cycle", (q: any) =>
        q.eq("booking_id", args.bookingId),
      )
      .order("desc")
      .collect();
    const open = candidates.find((r: any) => r.decision == null);
    if (!open) return;
    const now = Date.now();
    await ctx.db.patch(open._id, {
      decision: "sla_expired",
      decided_at_ms: now,
      decision_actor: "system",
      ceiling_after_decision_cents: undefined,
    });
    await ctx.db.patch(args.bookingId, {
      payment_approval_state: "sla_expired",
      sla_expires_at_ms: undefined,
      updated_at: now,
    });
  },
});

/** Mid-job expiry recovery. performSubmission bumps mechanic_set_price_cents to
 *  the requested amount at REQUEST time (before approval), so a mid-job scope
 *  increase the customer lets lapse would otherwise be captured at completion
 *  even though it was never approved. Roll mechanic_set back to the last
 *  approved ceiling and restore an approved state so the job completes and
 *  captures only the agreed price. Called by expireApprovals for the mid_job
 *  branch, immediately after _markApprovalExpired. */
export const _revertToPriorCeilingAfterExpiry = internalMutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const booking: any = await ctx.db.get(args.bookingId);
    if (!booking) return;
    const ceiling = booking.running_approved_ceiling_cents as
      | number
      | undefined;
    const now = Date.now();
    const patch: any = {
      // There is a standing approved ceiling → the job proceeds at it; if none
      // exists fall back to "none" (legacy) rather than the dead-end sla_expired.
      payment_approval_state: ceiling != null ? "pre_job_approved" : "none",
      updated_at: now,
    };
    if (ceiling != null) patch.mechanic_set_price_cents = ceiling;
    await ctx.db.patch(args.bookingId, patch);
  },
});
