/**
 * payments_stripe.ts — Stripe-facing actions and webhook-routed mutations
 * for the customer ↔ mechanic payment flow.
 *
 * Charge model: destination charges with manual capture.
 *   - Auth on booking confirm → PaymentIntent with capture_method=manual,
 *     transfer_data.destination = shop.stripe_connect_account_id,
 *     application_fee_amount = booking.platform_fee (cents).
 *   - Capture on shop accept (booking transition → "confirmed").
 *   - Void on no_show / decline / pre-capture cancel.
 *   - Refund with reverse_transfer + refund_application_fee on post-capture
 *     cancellation.
 *
 * Idempotency: paymentIntents.create uses bookingId as the idempotency key
 * and the local `payments.idempotency_key` mirrors it. Webhook handlers are
 * de-duplicated by event_id in `stripe_webhook_events`.
 */

import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { api, internal } from "./_generated/api";
import { getStripe } from "../lib/stripe";

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

const STRIPE_API_VERSION = "2026-04-22.dahlia" as const;
const APPLICATION_FEE_FLOOR_CENTS = 499; // $4.99 floor
const APPLICATION_FEE_RATE = 0.07; // 7%

// ─────────────────────────────────────────────────────────────
// Internal queries (auth + lookups)
// ─────────────────────────────────────────────────────────────

export const _getMeByClerkSubject = internalQuery({
  args: { clerkUserId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", args.clerkUserId))
      .unique();
  },
});

export const _getBookingForPayment = internalQuery({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) return null;
    const shop = booking.shop_id ? await ctx.db.get(booking.shop_id) : null;
    return { booking, shop };
  },
});

export const _getPaymentByBookingId = internalQuery({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("payments")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", args.bookingId))
      .unique();
  },
});

// ─────────────────────────────────────────────────────────────
// Internal mutations (state writes)
// ─────────────────────────────────────────────────────────────

export const _setUserStripeCustomerId = internalMutation({
  args: { userId: v.id("users"), stripeCustomerId: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, {
      stripe_customer_id: args.stripeCustomerId,
    });
  },
});

/**
 * Pre-creates a payments row in `pending` BEFORE the Stripe API call so the
 * downstream FSM hooks (capture / void) can always find a row to act on
 * even if the Stripe call or the post-PI patch fails. Idempotent by
 * booking_id — re-running returns the existing row.
 */
export const _reservePaymentRow = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    userId: v.id("users"),
    shopId: v.id("shops"),
    amount: v.number(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("payments")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", args.bookingId))
      .unique();
    if (existing) return existing._id;

    const now = Date.now();
    const paymentId = await ctx.db.insert("payments", {
      booking_id: args.bookingId,
      user_id: args.userId,
      shop_id: args.shopId,
      amount: args.amount,
      payment_method: "card",
      status: "pending",
      idempotency_key: args.idempotencyKey,
      created_at: now,
      updated_at: now,
    });
    await ctx.scheduler.runAfter(0, internal.payment_status_history.log, {
      payment_id: paymentId,
      old_status: undefined,
      new_status: "pending",
    });
    return paymentId;
  },
});

export const _recordPaymentIntent = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    userId: v.id("users"),
    shopId: v.id("shops"),
    amount: v.number(),
    stripePaymentIntentId: v.string(),
    status: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("payments")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", args.bookingId))
      .unique();

    const now = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        stripe_payment_intent_id: args.stripePaymentIntentId,
        status: args.status,
        amount: args.amount,
        idempotency_key: args.idempotencyKey,
        updated_at: now,
      });
      // Log the status change to history if it actually changed.
      if (existing.status !== args.status) {
        await ctx.scheduler.runAfter(0, internal.payment_status_history.log, {
          payment_id: existing._id,
          old_status: existing.status,
          new_status: args.status,
        });
      }
      return existing._id;
    }

    const paymentId = await ctx.db.insert("payments", {
      booking_id: args.bookingId,
      user_id: args.userId,
      shop_id: args.shopId,
      amount: args.amount,
      payment_method: "card",
      status: args.status,
      stripe_payment_intent_id: args.stripePaymentIntentId,
      idempotency_key: args.idempotencyKey,
      created_at: now,
      updated_at: now,
    });
    await ctx.scheduler.runAfter(0, internal.payment_status_history.log, {
      payment_id: paymentId,
      old_status: undefined,
      new_status: args.status,
    });
    return paymentId;
  },
});

/**
 * Cleans up an orphaned booking + payments row when the PaymentIntent
 * couldn't be created (e.g. card declined immediately, network error before
 * confirm). Releases the time slot and flips the payments row to `failed`
 * so the user can retry with a different card without leaking a pending
 * booking.
 */
export const _cancelBookingForPaymentFailure = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) return;
    if (booking.status !== "pending" && booking.status !== "pending_shop_acceptance") {
      // Only roll back pre-acceptance bookings — anything past that is the
      // shop's responsibility to resolve.
      return;
    }
    await ctx.db.patch(args.bookingId, {
      status: "cancelled",
      updated_at: Date.now(),
    });
    if (booking.time_slot_id) {
      const slot = await ctx.db.get(booking.time_slot_id);
      if (slot) {
        await ctx.db.patch(booking.time_slot_id, { is_available: true });
      }
    }

    const payment = await ctx.db
      .query("payments")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", args.bookingId))
      .unique();
    if (payment && payment.status === "pending") {
      await ctx.db.patch(payment._id, {
        status: "failed",
        updated_at: Date.now(),
      });
      // payments has no error_message column — the reason lives in the
      // append-only audit log.
      await ctx.scheduler.runAfter(0, internal.payment_status_history.log, {
        payment_id: payment._id,
        old_status: "pending",
        new_status: "failed",
        error_message: args.reason?.slice(0, 500),
      });
    }
  },
});

/**
 * Idempotent webhook router → transitions payments row, or no-ops if the
 * Stripe event is replayed. Looks up the row by metadata.bookingId
 * (preferred — set on PI create) or by stripe_payment_intent_id.
 */
export const handlePaymentIntentEvent = internalMutation({
  args: {
    stripeEventId: v.string(),
    eventType: v.string(),
    paymentIntentId: v.string(),
    bookingId: v.optional(v.string()),
    newStatus: v.string(),
    errorCode: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    livemode: v.optional(v.boolean()),
    stripeAccountId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // De-dupe via stripe_webhook_events.
    const dupe = await ctx.db
      .query("stripe_webhook_events")
      .withIndex("by_event_id", (q) => q.eq("event_id", args.stripeEventId))
      .first();
    if (dupe) return { duplicate: true };

    await ctx.db.insert("stripe_webhook_events", {
      event_id: args.stripeEventId,
      event_type: args.eventType,
      livemode: args.livemode,
      stripe_account_id: args.stripeAccountId,
      received_at: Date.now(),
      processed_at: Date.now(),
    });

    // Locate the payments row.
    let payment = null as any;
    if (args.bookingId) {
      payment = await ctx.db
        .query("payments")
        .withIndex("by_booking_id", (q) =>
          q.eq("booking_id", args.bookingId as any),
        )
        .unique();
    }
    if (!payment) {
      payment = await ctx.db
        .query("payments")
        .withIndex("by_stripe_payment_intent_id", (q) =>
          q.eq("stripe_payment_intent_id", args.paymentIntentId),
        )
        .unique();
    }
    if (!payment) return { matched: false };

    const { validateTransition, isTerminal } = await import(
      "./payment_status_history"
    );

    // Idempotent no-op on same-state.
    if (payment.status === args.newStatus) return { matched: true, noop: true };

    // Refuse invalid transitions silently (webhook may arrive after a manual
    // refund / cancel has already moved the row to a terminal state).
    if (isTerminal(payment.status)) return { matched: true, terminal: true };
    const err = validateTransition(payment.status, args.newStatus);
    if (err) return { matched: true, skipped: err };

    await ctx.db.patch(payment._id, {
      status: args.newStatus,
      updated_at: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.payment_status_history.log, {
      payment_id: payment._id,
      old_status: payment.status,
      new_status: args.newStatus,
      error_code: args.errorCode,
      error_message: args.errorMessage,
    });

    if (args.newStatus === "completed") {
      await ctx.scheduler.runAfter(0, internal.transactions.createFromPayment, {
        payment_id: payment._id,
      });
      // Stripe Tax: record the captured booking as a filing transaction.
      // No-ops when STRIPE_TAX_ENABLED isn't set (see convex/lib/stripeTax.ts).
      await ctx.scheduler.runAfter(
        0,
        (internal as any).lib.stripeTax.recordTaxTransactionForBooking,
        { bookingId: payment.booking_id, paymentId: payment._id },
      );
    }

    return { matched: true, transitioned: true };
  },
});

export const _transitionPayment = internalMutation({
  args: {
    paymentId: v.id("payments"),
    newStatus: v.string(),
    errorCode: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const payment = await ctx.db.get(args.paymentId);
    if (!payment) return;

    const { validateTransition, isTerminal } = await import(
      "./payment_status_history"
    );

    if (payment.status === args.newStatus) return;
    if (isTerminal(payment.status)) return;
    const err = validateTransition(payment.status, args.newStatus);
    if (err) return;

    await ctx.db.patch(args.paymentId, {
      status: args.newStatus,
      updated_at: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.payment_status_history.log, {
      payment_id: args.paymentId,
      old_status: payment.status,
      new_status: args.newStatus,
      error_code: args.errorCode,
      error_message: args.errorMessage,
    });

    if (args.newStatus === "completed") {
      await ctx.scheduler.runAfter(0, internal.transactions.createFromPayment, {
        payment_id: args.paymentId,
      });
      const completedPayment = await ctx.db.get(args.paymentId);
      if (completedPayment) {
        await ctx.scheduler.runAfter(
          0,
          (internal as any).lib.stripeTax.recordTaxTransactionForBooking,
          {
            bookingId: completedPayment.booking_id,
            paymentId: args.paymentId,
          },
        );
      }
    }
  },
});

export const _patchBookingAuthorizationVoided = internalMutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.bookingId, {
      stripe_authorization_voided_at_ms: Date.now(),
    });
  },
});

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

async function requireAuthedUser(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");
  const user = await ctx.runQuery(
    internal.payments_stripe._getMeByClerkSubject,
    { clerkUserId: identity.subject },
  );
  if (!user) throw new Error("User record not found.");
  return { identity, user };
}

function computeApplicationFeeCents(subtotalCents: number): number {
  return Math.max(
    Math.round(subtotalCents * APPLICATION_FEE_RATE),
    APPLICATION_FEE_FLOOR_CENTS,
  );
}

// ─────────────────────────────────────────────────────────────
// PUBLIC ACTIONS
// ─────────────────────────────────────────────────────────────

/**
 * Returns the user's Stripe Customer id, creating one on Stripe if missing
 * and persisting it on the users row. Idempotent.
 */
export const _getOrCreateStripeCustomer = internalAction({
  args: { userId: v.id("users") },
  handler: async (ctx, args): Promise<string> => {
    const user: any = await ctx.runQuery(api.users.getById, { id: args.userId });
    if (!user) throw new Error("User not found.");
    if (user.stripe_customer_id) return user.stripe_customer_id;

    const stripe = getStripe();
    const customer = await stripe.customers.create({
      email: user.email,
      name:
        [user.first_name, user.last_name].filter(Boolean).join(" ").trim() ||
        undefined,
      metadata: { convexUserId: String(args.userId) },
    });

    await ctx.runMutation(internal.payments_stripe._setUserStripeCustomerId, {
      userId: args.userId,
      stripeCustomerId: customer.id,
    });
    return customer.id;
  },
});

/**
 * Sets up a SetupIntent + EphemeralKey for the mobile PaymentSheet so the
 * user can save a card. Returns secrets the client passes to
 * `initPaymentSheet`.
 */
export const createSetupIntent = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    setupIntentClientSecret: string;
    customerId: string;
    ephemeralKeySecret: string;
    publishableKeyHint: string | null;
  }> => {
    const { user } = await requireAuthedUser(ctx);
    const customerId: string = await ctx.runAction(
      internal.payments_stripe._getOrCreateStripeCustomer,
      { userId: user._id },
    );

    const stripe = getStripe();
    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customerId },
      { apiVersion: STRIPE_API_VERSION },
    );
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ["card"],
      usage: "off_session",
    });

    return {
      setupIntentClientSecret: setupIntent.client_secret!,
      customerId,
      ephemeralKeySecret: ephemeralKey.secret!,
      publishableKeyHint: process.env.STRIPE_PUBLISHABLE_KEY ?? null,
    };
  },
});

/**
 * Returns the user's saved card payment methods. Stripe is the source of
 * truth — no caching in Convex.
 */
export const listPaymentMethods = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<
    Array<{
      id: string;
      brand: string;
      last4: string;
      expMonth: number;
      expYear: number;
      isDefault: boolean;
    }>
  > => {
    const { user } = await requireAuthedUser(ctx);
    if (!user.stripe_customer_id) return [];

    const stripe = getStripe();
    const [list, customer] = await Promise.all([
      stripe.paymentMethods.list({
        customer: user.stripe_customer_id,
        type: "card",
        limit: 50,
      }),
      stripe.customers.retrieve(user.stripe_customer_id),
    ]);

    const defaultPm =
      typeof customer !== "string" && !customer.deleted
        ? customer.invoice_settings?.default_payment_method
        : null;
    const defaultPmId =
      typeof defaultPm === "string" ? defaultPm : (defaultPm as any)?.id ?? null;

    return list.data
      .filter((pm) => pm.card)
      .map((pm) => ({
        id: pm.id,
        brand: pm.card!.brand,
        last4: pm.card!.last4,
        expMonth: pm.card!.exp_month,
        expYear: pm.card!.exp_year,
        isDefault: pm.id === defaultPmId,
      }));
  },
});

export const detachPaymentMethod = action({
  args: { paymentMethodId: v.string() },
  handler: async (ctx, args): Promise<{ detached: boolean }> => {
    const { user } = await requireAuthedUser(ctx);
    if (!user.stripe_customer_id) throw new Error("No payment methods saved.");

    const stripe = getStripe();
    const pm = await stripe.paymentMethods.retrieve(args.paymentMethodId);
    if (pm.customer !== user.stripe_customer_id) {
      throw new Error("This card doesn't belong to you.");
    }
    await stripe.paymentMethods.detach(args.paymentMethodId);
    return { detached: true };
  },
});

export const setDefaultPaymentMethod = action({
  args: { paymentMethodId: v.string() },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const { user } = await requireAuthedUser(ctx);
    if (!user.stripe_customer_id) throw new Error("No payment methods saved.");

    const stripe = getStripe();
    const pm = await stripe.paymentMethods.retrieve(args.paymentMethodId);
    if (pm.customer !== user.stripe_customer_id) {
      throw new Error("This card doesn't belong to you.");
    }
    await stripe.customers.update(user.stripe_customer_id, {
      invoice_settings: { default_payment_method: args.paymentMethodId },
    });
    return { ok: true };
  },
});

// ─────────────────────────────────────────────────────────────
// PaymentIntent — authorize on booking confirm
// ─────────────────────────────────────────────────────────────

/**
 * Authorizes a charge against the customer's saved card for the booking
 * total. Uses manual capture so funds aren't moved until the shop accepts.
 * Idempotent by bookingId — re-running returns the existing PI.
 */
export const createPaymentIntentForBooking = action({
  args: {
    bookingId: v.id("bookings"),
    paymentMethodId: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    paymentIntentId: string;
    clientSecret: string;
    status: string;
    requiresAction: boolean;
  }> => {
    const { user } = await requireAuthedUser(ctx);
    const result: any = await ctx.runQuery(
      internal.payments_stripe._getBookingForPayment,
      { bookingId: args.bookingId },
    );
    if (!result?.booking) throw new Error("Booking not found.");
    const { booking, shop } = result;

    if (booking.user_id !== user._id) {
      throw new Error("Not your booking.");
    }
    if (!shop) throw new Error("Booking has no shop assigned.");
    if (!shop.stripe_connect_account_id) {
      throw new Error("Shop is not ready to accept payments yet.");
    }
    if (shop.stripe_charges_enabled !== true) {
      throw new Error("Shop is not ready to accept payments yet.");
    }

    const totalDollars = booking.total_cost ?? 0;
    if (!(totalDollars > 0)) {
      throw new Error("Booking total is missing or zero.");
    }
    const amountCents = Math.round(totalDollars * 100);

    // The customer was shown `booking.platform_fee` on the review screen as
    // "Otopair Service Fee — 7%". We MUST collect exactly that — anything
    // else creates a fee-on-fee bug (charging 7% on a total that already
    // contains the 7% fee). If the booking row is missing this field, the
    // upstream booking author has a bug; refuse to charge rather than
    // silently overcollecting.
    if (
      booking.platform_fee == null ||
      typeof booking.platform_fee !== "number" ||
      booking.platform_fee < 0
    ) {
      throw new Error(
        "Booking is missing its platform_fee — cannot create PaymentIntent.",
      );
    }
    const platformFeeCents = Math.round(booking.platform_fee * 100);

    if (!user.stripe_customer_id) {
      throw new Error("Add a payment method before confirming.");
    }

    // Verify ownership of the payment method.
    const stripe = getStripe();
    const pm = await stripe.paymentMethods.retrieve(args.paymentMethodId);
    if (pm.customer !== user.stripe_customer_id) {
      throw new Error("This card doesn't belong to you.");
    }

    const idempotencyKey = `booking_pi:${args.bookingId}`;

    // If a PI was already created for this booking, retrieve + return it
    // (covers retries from /confirming after a transient failure).
    const existing: any = await ctx.runQuery(
      internal.payments_stripe._getPaymentByBookingId,
      { bookingId: args.bookingId },
    );
    if (existing?.stripe_payment_intent_id) {
      const pi = await stripe.paymentIntents.retrieve(
        existing.stripe_payment_intent_id,
      );
      return {
        paymentIntentId: pi.id,
        clientSecret: pi.client_secret!,
        status: pi.status,
        requiresAction: pi.status === "requires_action",
      };
    }

    // Reserve the payments row in `pending` BEFORE the Stripe call. If the
    // Stripe call fails (network drop / card declined immediately / Convex
    // transient), the FSM hooks downstream can still find this row and the
    // cleanup mutation can transition it to `failed` deterministically.
    await ctx.runMutation(internal.payments_stripe._reservePaymentRow, {
      bookingId: args.bookingId,
      userId: user._id,
      shopId: shop._id,
      amount: totalDollars,
      idempotencyKey,
    });

    let pi;
    try {
      pi = await stripe.paymentIntents.create(
        {
          amount: amountCents,
          currency: "usd",
          customer: user.stripe_customer_id,
          payment_method: args.paymentMethodId,
          confirm: true,
          off_session: false,
          capture_method: "manual",
          application_fee_amount: platformFeeCents,
          transfer_data: {
            destination: shop.stripe_connect_account_id,
          },
          automatic_payment_methods: { enabled: true, allow_redirects: "never" },
          metadata: {
            bookingId: String(args.bookingId),
            userId: String(user._id),
            shopId: String(shop._id),
          },
        },
        { idempotencyKey },
      );
    } catch (err: any) {
      // Card declined / Stripe error before any auth could land — cancel
      // the booking, release the time slot, mark payment failed, surface
      // a clean error to the user.
      await ctx.runMutation(
        internal.payments_stripe._cancelBookingForPaymentFailure,
        { bookingId: args.bookingId, reason: err?.message ?? "Stripe error" },
      );
      throw new Error(err?.message ?? "Card authorization failed.");
    }

    const mapped =
      pi.status === "requires_capture" || pi.status === "succeeded"
        ? "processing"
        : pi.status === "requires_action"
          ? "processing"
          : pi.status === "canceled"
            ? "cancelled"
            : "pending";

    await ctx.runMutation(internal.payments_stripe._recordPaymentIntent, {
      bookingId: args.bookingId,
      userId: user._id,
      shopId: shop._id,
      amount: totalDollars,
      stripePaymentIntentId: pi.id,
      status: mapped,
      idempotencyKey,
    });

    return {
      paymentIntentId: pi.id,
      clientSecret: pi.client_secret!,
      status: pi.status,
      requiresAction: pi.status === "requires_action",
    };
  },
});

// ─────────────────────────────────────────────────────────────
// Capture / Void / Refund — server-driven from booking FSM
// ─────────────────────────────────────────────────────────────

/**
 * Captures the held authorization for a booking. Scheduled by
 * `applyBookingStatusTransition` on the transition into `completed` (the
 * mechanic marking the job done — NOT on shop accept). Idempotent: skips
 * if the payments row is already completed / cancelled / refunded.
 *
 * Trade-off: the authorization is held for the full booking lifetime,
 * which can be days. Stripe card auths typically expire after 7 days, so
 * bookings whose appointment + service spans that window need an auth
 * top-up (future cron) before capture is attempted.
 */
export const capturePaymentIntentForBooking = internalAction({
  args: { bookingId: v.id("bookings") },
  handler: async (
    ctx,
    args,
  ): Promise<{ status: string; reason?: string }> => {
    const payment: any = await ctx.runQuery(
      internal.payments_stripe._getPaymentByBookingId,
      { bookingId: args.bookingId },
    );
    if (!payment) return { status: "skipped", reason: "no payment row" };
    if (!payment.stripe_payment_intent_id) {
      return { status: "skipped", reason: "no payment intent" };
    }
    if (payment.status === "completed") {
      return { status: "skipped", reason: "already completed" };
    }
    if (payment.status === "cancelled" || payment.status === "refunded") {
      return { status: "skipped", reason: `payment is ${payment.status}` };
    }

    const stripe = getStripe();
    try {
      const pi = await stripe.paymentIntents.capture(
        payment.stripe_payment_intent_id,
      );
      return { status: pi.status };
    } catch (err: any) {
      // Webhook will deliver payment_intent.payment_failed if applicable; we
      // also mark the row so the UI sees the failure quickly.
      await ctx.runMutation(internal.payments_stripe._transitionPayment, {
        paymentId: payment._id,
        newStatus: "failed",
        errorCode: err?.code,
        errorMessage: err?.message?.slice(0, 500),
      });
      return { status: "failed", reason: err?.message };
    }
  },
});

/**
 * Cancels (voids) the authorization. Scheduled on no_show / declined /
 * pre-capture cancelled. Patches booking.stripe_authorization_voided_at_ms
 * and transitions the payments row → cancelled.
 */
export const cancelPaymentIntentForBooking = internalAction({
  args: { bookingId: v.id("bookings") },
  handler: async (
    ctx,
    args,
  ): Promise<{ status: string; reason?: string }> => {
    const payment: any = await ctx.runQuery(
      internal.payments_stripe._getPaymentByBookingId,
      { bookingId: args.bookingId },
    );
    if (!payment) return { status: "skipped", reason: "no payment row" };
    if (!payment.stripe_payment_intent_id) {
      return { status: "skipped", reason: "no payment intent" };
    }
    if (payment.status === "completed") {
      return {
        status: "skipped",
        reason: "payment already captured — use refund",
      };
    }
    if (payment.status === "cancelled") return { status: "skipped" };

    const stripe = getStripe();
    try {
      const pi = await stripe.paymentIntents.cancel(
        payment.stripe_payment_intent_id,
      );
      await ctx.runMutation(internal.payments_stripe._transitionPayment, {
        paymentId: payment._id,
        newStatus: "cancelled",
      });
      await ctx.runMutation(
        internal.payments_stripe._patchBookingAuthorizationVoided,
        { bookingId: args.bookingId },
      );
      return { status: pi.status };
    } catch (err: any) {
      return { status: "error", reason: err?.message };
    }
  },
});

/**
 * Refunds a captured payment. Reverses the transfer and refunds the
 * application fee so the platform and shop are made whole in lockstep.
 *
 * **internalAction** — not customer-callable. Refund policy lives in the
 * shop dashboard / admin tooling: pull funds back from the shop's Connect
 * account only with their consent (or via a documented cancel-window
 * policy). The mobile app should NEVER invoke this directly.
 */
export const refundPaymentForBooking = internalAction({
  args: { bookingId: v.id("bookings") },
  handler: async (
    ctx,
    args,
  ): Promise<{ status: string; refundId?: string; reason?: string }> => {
    const payment: any = await ctx.runQuery(
      internal.payments_stripe._getPaymentByBookingId,
      { bookingId: args.bookingId },
    );
    if (!payment?.stripe_payment_intent_id) {
      return { status: "skipped", reason: "no payment intent" };
    }
    if (payment.status !== "completed") {
      return {
        status: "skipped",
        reason: `cannot refund payment in status ${payment.status}`,
      };
    }

    const stripe = getStripe();
    const refund = await stripe.refunds.create({
      payment_intent: payment.stripe_payment_intent_id,
      reverse_transfer: true,
      refund_application_fee: true,
    });
    // Webhook charge.refunded will also flip the row; we patch optimistically.
    await ctx.runMutation(internal.payments_stripe._transitionPayment, {
      paymentId: payment._id,
      newStatus: "refunded",
    });
    return { status: refund.status ?? "pending", refundId: refund.id };
  },
});
