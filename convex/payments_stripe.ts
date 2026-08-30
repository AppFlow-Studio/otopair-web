/**
 * payments_stripe.ts — Stripe-facing actions and webhook-routed mutations
 * for the customer ↔ mechanic payment flow.
 *
 * Charge model: destination charges with manual capture.
 *   - Auth on booking confirm → PaymentIntent with capture_method=manual,
 *     transfer_data.destination = shop.stripe_connect_account_id,
 *     application_fee_amount = rate × subtotal (from platform_settings).
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
  query,
} from "./_generated/server";
import { api, internal } from "./_generated/api";
import { getStripe } from "../lib/stripe";
import { validateTransition, isTerminal } from "./payment_status_history";
import { BOOKING_DEPOSIT_CENTS } from "./lib/payment_constants";
import { computeBookingTax } from "../lib/tax";
import { computePlatformFeeDollars } from "../lib/platformFee";

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

const STRIPE_API_VERSION = "2026-04-22.dahlia" as const;
const APPLICATION_FEE_FLOOR_CENTS = 499; // $4.99 floor
const APPLICATION_FEE_RATE = 0.07; // 7%
/** Drift band before finalizeAndChargeForBooking falls back to opening a
 *  post-job re-approval cycle. Covers Math.round rounding on the tax/fee
 *  recompute and legacy approval rows whose labor_cents was never frozen.
 *  Anything beyond $1 implies a real actuals divergence — let the customer
 *  approve it. */
const FINALIZE_DRIFT_TOLERANCE_CENTS = 100;

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

export const _getShopForPayment = internalQuery({
  args: { shopId: v.id("shops") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.shopId);
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

/** Reactive query for the customer-side reauth screen to learn how the
 *  active payment was originated. The reauth UI branches on this: card
 *  → re-confirm with a saved PM; wallet → re-prompt PlatformPay to mint
 *  a fresh one-time token (the original wallet PM is gone after first
 *  use). Returns null when no payment row exists yet (booking still in
 *  pre-PI state). Caller must own the booking. */
export const getPaymentOriginForBooking = query({
  args: { bookingId: v.id("bookings") },
  handler: async (
    ctx,
    args,
  ): Promise<"card" | "apple_pay" | "google_pay" | null> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const me = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject))
      .unique();
    if (!me) throw new Error("User record not found.");
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) return null;
    if (booking.user_id !== me._id) throw new Error("Not your booking.");
    const payment = await ctx.db
      .query("payments")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", args.bookingId))
      .unique();
    return (payment?.payment_origin as "card" | "apple_pay" | "google_pay" | undefined) ?? null;
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
 * Flip `users.has_saved_payment_method` — flag consumed by the home-page
 * "Finish setup" card to reactively mark the payment-method tile as
 * complete without a Stripe round-trip on every home visit. Called by
 * the setup_intent.succeeded webhook (attach) and payment_method.detached
 * cleanup path.
 */
export const _setUserHasSavedPaymentMethodByCustomerId = internalMutation({
  args: { stripeCustomerId: v.string(), value: v.boolean() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .filter((q) =>
        q.eq(q.field("stripe_customer_id"), args.stripeCustomerId),
      )
      .first();
    if (!user) return;
    if (user.has_saved_payment_method === args.value) return;
    await ctx.db.patch(user._id, { has_saved_payment_method: args.value });
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
    /** Initial hold amount in cents — for the Pre-Job Approval flow this is
     *  always BOOKING_DEPOSIT_CENTS ($20); legacy bookings hold the full
     *  total. Persists on payments.hold_amount_cents for downstream
     *  increment/capture decisions. */
    holdAmountCents: v.optional(v.number()),
    /** Where the payment came from (saved card vs. wallet). Required for
     *  routing the reauth fallback: card → silent server-side reauth;
     *  wallet → re-prompt customer via PlatformPay. */
    paymentOrigin: v.optional(
      v.union(
        v.literal("card"),
        v.literal("apple_pay"),
        v.literal("google_pay"),
      ),
    ),
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
        ...(args.holdAmountCents != null
          ? { hold_amount_cents: args.holdAmountCents }
          : {}),
        ...(args.paymentOrigin != null
          ? { payment_origin: args.paymentOrigin }
          : {}),
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
      hold_amount_cents: args.holdAmountCents,
      ...(args.paymentOrigin != null
        ? { payment_origin: args.paymentOrigin }
        : {}),
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
 * confirm). Flips the payments row to `failed` so the user can retry with a
 * different card without leaking a pending booking. Availability is inferred
 * from bookings, so there is no positive slot inventory to release.
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
    // Stripe's authoritative captured amount — pulled from PI.amount_received
    // on payment_intent.succeeded. We persist it here so the payments row
    // reflects reality even if the action-side _patchBookingCaptured didn't
    // run (e.g. capture call retried, webhook landed first).
    amountReceived: v.optional(v.number()),
    // Card network + last-4 pulled from the charge's payment_method_details
    // on payment_intent.succeeded — persisted so ops can show "Visa ···· 4242".
    cardBrand: v.optional(v.string()),
    cardLast4: v.optional(v.string()),
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

    // Persist card brand/last4 as soon as we have it (payment_intent.succeeded),
    // independent of the status transition below — the action-side capture may
    // have already moved the row to `completed`, which would short-circuit the
    // no-op guard before we ever stamp the card. Only write when missing so
    // replays and later events don't churn the row.
    if (
      (args.cardBrand != null || args.cardLast4 != null) &&
      payment.card_last4 == null &&
      payment.card_brand == null
    ) {
      await ctx.db.patch(payment._id, {
        ...(args.cardBrand != null ? { card_brand: args.cardBrand } : {}),
        ...(args.cardLast4 != null ? { card_last4: args.cardLast4 } : {}),
      });
    }

    // Idempotent no-op on same-state.
    if (payment.status === args.newStatus) return { matched: true, noop: true };

    // Refuse invalid transitions silently (webhook may arrive after a manual
    // refund / cancel has already moved the row to a terminal state).
    if (isTerminal(payment.status)) return { matched: true, terminal: true };
    const err = validateTransition(payment.status, args.newStatus);
    if (err) return { matched: true, skipped: err };

    const paymentPatch: any = {
      status: args.newStatus,
      updated_at: Date.now(),
    };
    // Reconcile captured_amount_cents against Stripe's amount_received when the
    // capture webhook lands — fills the gap if the action-side patch was
    // skipped (capture retry, action crash after Stripe-side success).
    if (
      args.newStatus === "completed" &&
      args.amountReceived != null &&
      payment.captured_amount_cents !== args.amountReceived
    ) {
      paymentPatch.captured_amount_cents = args.amountReceived;
    }
    await ctx.db.patch(payment._id, paymentPatch);
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
      // Invoice PDF — render, store, email. Idempotent via storage-id check
      // inside the action so webhook replays are safe.
      await ctx.scheduler.runAfter(
        0,
        (internal as any).invoices_node.generateAndEmail,
        { bookingId: payment.booking_id },
      );
    } else if (args.newStatus === "refunded") {
      // Drop the cached PDF so the next render reflects the refund, then
      // re-render + re-email the customer with an updated invoice.
      await ctx.scheduler.runAfter(
        0,
        (internal as any).invoices.regenerateInvoice,
        { bookingId: payment.booking_id },
      );
      await ctx.scheduler.runAfter(
        100,
        (internal as any).invoices_node.generateAndEmail,
        { bookingId: payment.booking_id },
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

function assertShopReadyForPayments(shop: any) {
  if (!shop?.stripe_connect_account_id) {
    throw new Error("Shop is not ready to accept payments yet.");
  }
  if (shop.stripe_charges_enabled !== true) {
    throw new Error("Shop is not ready to accept payments yet.");
  }
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

    // Reconcile `users.has_saved_payment_method` against what Stripe just
    // told us. The webhook (setup_intent.succeeded / payment_method.detached)
    // is still the fast path, but it silently no-ops whenever the endpoint
    // isn't reachable — which is every local dev session without `stripe
    // listen` forwarding, leaving accounts with a real card stuck showing
    // the "Payment Method" tile as incomplete. This runs on every home
    // visit (StripePaymentMethodsSync is mounted at the root), so a missed
    // webhook self-heals on the next app open instead of needing a manual
    // DB patch. The internal mutation early-returns when the value already
    // matches, so the steady state is a read, not a write.
    const cardCount = list.data.filter((pm) => pm.card).length;
    if (user.has_saved_payment_method !== (cardCount > 0)) {
      await ctx.runMutation(
        internal.payments_stripe._setUserHasSavedPaymentMethodByCustomerId,
        { stripeCustomerId: user.stripe_customer_id, value: cardCount > 0 },
      );
    }

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

export const preauthorizePaymentForBooking = action({
  args: {
    shopId: v.id("shops"),
    paymentMethodId: v.string(),
    confirmationAttemptId: v.string(),
    paymentOrigin: v.optional(
      v.union(
        v.literal("card"),
        v.literal("apple_pay"),
        v.literal("google_pay"),
      ),
    ),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    paymentIntentId: string;
    clientSecret: string;
    status: string;
    requiresAction: boolean;
    idempotencyKey: string;
    holdAmountCents: number;
  }> => {
    const { user } = await requireAuthedUser(ctx);
    const shop: any = await ctx.runQuery(
      internal.payments_stripe._getShopForPayment,
      { shopId: args.shopId },
    );
    if (!shop) throw new Error("Booking has no shop assigned.");
    assertShopReadyForPayments(shop);

    if (!user.stripe_customer_id) {
      // Wallet payments (Apple Pay / Google Pay) mint a one-time PaymentMethod
      // on-device and don't require a saved card, so a first-time customer may
      // not have a Stripe customer yet. Create one lazily instead of blocking
      // the booking — the PaymentIntent still needs a customer to attach the
      // charge to. Idempotent; persists stripe_customer_id on the user row.
      user.stripe_customer_id = await ctx.runAction(
        internal.payments_stripe._getOrCreateStripeCustomer,
        { userId: user._id },
      );
    }

    const stripe = getStripe();
    const pm = await stripe.paymentMethods.retrieve(args.paymentMethodId);
    if (pm.customer != null && pm.customer !== user.stripe_customer_id) {
      throw new Error("This card doesn't belong to you.");
    }

    const idempotencyKey = `booking_preauth:${args.confirmationAttemptId}`;
    const pi = await stripe.paymentIntents.create(
      {
        amount: BOOKING_DEPOSIT_CENTS,
        currency: "usd",
        customer: user.stripe_customer_id,
        payment_method: args.paymentMethodId,
        confirm: true,
        off_session: false,
        capture_method: "manual",
        application_fee_amount: 0,
        transfer_data: { destination: shop.stripe_connect_account_id },
        automatic_payment_methods: { enabled: true, allow_redirects: "never" },
        metadata: {
          prebooking: "true",
          userId: String(user._id),
          shopId: String(shop._id),
          confirmationAttemptId: args.confirmationAttemptId,
        },
      },
      { idempotencyKey },
    );

    return {
      paymentIntentId: pi.id,
      clientSecret: pi.client_secret!,
      status: pi.status,
      requiresAction: pi.status === "requires_action",
      idempotencyKey,
      holdAmountCents: BOOKING_DEPOSIT_CENTS,
    };
  },
});

export const cancelPreauthorizedPaymentIntent = action({
  args: { paymentIntentId: v.string() },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const { user } = await requireAuthedUser(ctx);
    const stripe = getStripe();
    const pi = await stripe.paymentIntents.retrieve(args.paymentIntentId);
    if (pi.metadata?.userId !== String(user._id)) {
      throw new Error("Not your payment authorization.");
    }
    if (
      pi.status !== "canceled" &&
      pi.status !== "succeeded" &&
      pi.status !== "processing"
    ) {
      await stripe.paymentIntents.cancel(args.paymentIntentId);
    }
    return { ok: true };
  },
});

/**
 * Authorizes a charge against the customer's saved card for the booking
 * total. Uses manual capture so funds aren't moved until the shop accepts.
 * Idempotent by bookingId — re-running returns the existing PI.
 */
export const createPaymentIntentForBooking = action({
  args: {
    bookingId: v.id("bookings"),
    paymentMethodId: v.string(),
    /** Optional origin tag for the payment. Mobile passes 'apple_pay' or
     *  'google_pay' for wallet flows so the reauth screen later knows to
     *  re-prompt via PlatformPay instead of silently re-using a saved card.
     *  Defaults are persisted by `_recordPaymentIntent`; omitting leaves
     *  `payment_origin` unset on the row. */
    paymentOrigin: v.optional(
      v.union(
        v.literal("card"),
        v.literal("apple_pay"),
        v.literal("google_pay"),
      ),
    ),
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
    assertShopReadyForPayments(shop);

    const totalDollars = booking.total_cost ?? 0;
    if (!(totalDollars > 0)) {
      throw new Error("Booking total is missing or zero.");
    }

    // Pre-Job Approval flow: hold a fixed $20 deposit at booking time, NOT
    // the full estimated total. The hold is incremented to the mechanic's
    // confirmed set price after inspection. Legacy bookings (created
    // before the disclosed-range fields were added) fall through to the
    // original total-cost hold so they capture cleanly on completion.
    const usesDeposit = booking.disclosed_range_high_cents != null;
    const amountCents = usesDeposit
      ? BOOKING_DEPOSIT_CENTS
      : Math.round(totalDollars * 100);

    // Platform fee comes from the admin-managed singleton config
    // (`platform_settings`). The booking row itself doesn't carry a
    // platform_fee — that field was unreliable across creation paths and
    // didn't match the system's actual rate. Seed-on-read keeps the row
    // present even on a fresh deploy.
    const settings: any = await ctx.runMutation(
      internal.platform_settings._getOrCreate,
      {},
    );
    const subtotal = (booking.labor_cost ?? 0) + (booking.parts_cost ?? 0);
    const platformFeeDollars =
      subtotal > 0
        ? Math.max(
            subtotal * settings.platform_fee_rate,
            settings.platform_fee_floor_dollars,
          )
        : 0;
    // Floor at zero, cap at amountCents to satisfy Stripe's constraint.
    // On the deposit path, application_fee on the initial $20 auth is 0 —
    // the fee is applied on the captured final amount via update at
    // capture time (see finalizeAndChargeForBooking in Phase 2).
    const platformFeeCents = usesDeposit
      ? 0
      : Math.min(
          amountCents,
          Math.max(0, Math.round(platformFeeDollars * 100)),
        );

    if (!user.stripe_customer_id) {
      // Wallet payments (Apple Pay / Google Pay) mint a one-time PaymentMethod
      // on-device and don't require a saved card, so a first-time customer may
      // not have a Stripe customer yet. Create one lazily instead of blocking
      // the booking — the PaymentIntent still needs a customer to attach the
      // charge to. Idempotent; persists stripe_customer_id on the user row.
      user.stripe_customer_id = await ctx.runAction(
        internal.payments_stripe._getOrCreateStripeCustomer,
        { userId: user._id },
      );
    }

    // Verify ownership of the payment method. Saved cards are attached to
    // the user's Stripe customer (pm.customer === user.stripe_customer_id).
    // Wallet-minted PMs (Apple Pay / Google Pay via
    // `createPlatformPayPaymentMethod`) come back unattached
    // (pm.customer == null) — that's expected and safe: the wallet sheet
    // authorization on the device is itself the authentication signal, and
    // unattached PM ids are not enumerable. Reject only when the PM is
    // attached to a *different* customer.
    const stripe = getStripe();
    const pm = await stripe.paymentMethods.retrieve(args.paymentMethodId);
    if (pm.customer != null && pm.customer !== user.stripe_customer_id) {
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
          // NOTE: `payment_method_options.card.request_incremental_authorization`
          // would let Stripe lift the hold via `incrementAuthorization`
          // instead of cancelling + recreating the PI, but it requires the
          // platform Stripe account to be enrolled in Flexible Payments.
          // Until that account capability is enabled, omit the opt-in;
          // `adjustAuthorization` already handles the "increment not
          // supported" fallback by running the reauth flow.
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
      holdAmountCents: amountCents,
      ...(args.paymentOrigin != null
        ? { paymentOrigin: args.paymentOrigin }
        : {}),
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

// ─────────────────────────────────────────────────────────────────────────
// Pre-Job Approval: authorization adjustment + final capture
// ─────────────────────────────────────────────────────────────────────────

/** Stamps `payments.incremented_total_cents` after a successful
 *  incrementAuthorization or reauth flow. Also persists the new PI id when
 *  the reauth path replaced the original. */
export const _recordAuthorizationAdjustment = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    incrementedTotalCents: v.number(),
    reauthPaymentIntentId: v.optional(v.string()),
    /** Optional override of payment_origin. Set when a reauth swaps the
     *  active PM (e.g., customer reauths with Apple Pay after the original
     *  card flow); the row's origin must update so subsequent reauth UX
     *  branches on the new wallet origin rather than the stale card. */
    paymentOrigin: v.optional(
      v.union(
        v.literal("card"),
        v.literal("apple_pay"),
        v.literal("google_pay"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const payment = await ctx.db
      .query("payments")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", args.bookingId))
      .unique();
    if (!payment) return;
    const patch: any = {
      incremented_total_cents: args.incrementedTotalCents,
      updated_at: Date.now(),
    };
    if (args.reauthPaymentIntentId) {
      patch.reauth_payment_intent_id = args.reauthPaymentIntentId;
      patch.stripe_payment_intent_id = args.reauthPaymentIntentId;
    }
    if (args.paymentOrigin != null) {
      patch.payment_origin = args.paymentOrigin;
    }
    await ctx.db.patch(payment._id, patch);
  },
});

/** Stamps the last stripe_action on the most-recent booking_approvals row
 *  for the given booking. Updates audit linkage without touching the
 *  decision column. */
export const _stampApprovalStripeAction = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    stripeAction: v.string(),
    stripePaymentIntentId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const candidates = await ctx.db
      .query("booking_approvals")
      .withIndex("by_booking_and_cycle", (q: any) =>
        q.eq("booking_id", args.bookingId),
      )
      .order("desc")
      .collect();
    const target = candidates[0];
    if (!target) return;
    await ctx.db.patch(target._id, {
      stripe_action: args.stripeAction,
      ...(args.stripePaymentIntentId
        ? { stripe_payment_intent_id: args.stripePaymentIntentId }
        : {}),
    });
  },
});

/** Reverts the booking back to `pre_job_pending` after a reauth failure so
 *  the customer can update their payment method. Also pushes them. */
export const _revertBookingToPendingForReauth = internalMutation({
  // v.string() + normalizeId for the same reason as
  // _clearReauthRequiredAfterSuccess: the `requires_action` webhook passes an
  // untrusted `metadata.bookingId` that may belong to another deployment sharing
  // this Stripe account. A foreign/malformed id no-ops here instead of throwing
  // and 500-ing the webhook.
  args: { bookingId: v.string() },
  handler: async (ctx, args) => {
    const bookingId = ctx.db.normalizeId("bookings", args.bookingId);
    if (!bookingId) return;
    const booking: any = await ctx.db.get(bookingId);
    if (!booking) return;
    const now = Date.now();
    await ctx.db.patch(bookingId, {
      payment_approval_state: "reauth_required",
      updated_at: now,
    });
    // Push the customer to update their card.
    await ctx.db.insert("notification_outbox", {
      user_id: booking.user_id,
      booking_id: bookingId,
      shop_id: booking.shop_id,
      channel: "push",
      category: "booking_reauth_required",
      status: "pending",
      dedupe_key: `reauth_required:${String(bookingId)}:${now}`,
      payload: {
        title: "Confirm new hold on your card",
        body: "Your bank needs to verify the updated hold. Tap to confirm — you may be asked to authenticate.",
        data: {
          // Deep-links the customer into the reauth flow on mobile
          // (`app/booking/approve-estimate/[id].tsx` → ReauthView). The
          // NotificationsSheet parses this via `parseOtopairDeepLink` →
          // kind: "reauth" → approve-estimate with `mode=reauth`.
          deepLink: `otopair://booking/${String(bookingId)}/reauth`,
          bookingId: String(bookingId),
        },
      },
      created_at: now,
      updated_at: now,
    });
  },
});

/** Clears `payment_approval_state = "reauth_required"` after a successful
 *  customer-confirmed reauth. Restores the booking to `pre_job_approved`
 *  (matching the `withdrawPendingApproval` convention at line 851) when a
 *  running ceiling exists, else "none". Idempotent — no-op when state is
 *  not currently `reauth_required`. Safe to call from both the mobile-
 *  initiated action AND the `amount_capturable_updated` webhook fallback.
 */
export const _clearReauthRequiredAfterSuccess = internalMutation({
  // v.string() (not v.id("bookings")): the `amount_capturable_updated` webhook
  // passes an UNTRUSTED `metadata.bookingId`. The Stripe test account is shared
  // across Convex deployments (see convex/CARDATA_BILLING_SPEC.md), so an event
  // can carry a booking id minted by another deployment. A strict v.id()
  // validator rejects a foreign id and throws — the webhook's outer catch turns
  // that into a 500, and Stripe then retries the event indefinitely. normalizeId
  // returns null for a foreign/malformed id so we no-op instead. Internal
  // callers pass a real Id<"bookings">, which normalizeId resolves unchanged.
  args: { bookingId: v.string() },
  handler: async (ctx, args) => {
    const bookingId = ctx.db.normalizeId("bookings", args.bookingId);
    if (!bookingId) return { status: "foreign_id" };
    const booking: any = await ctx.db.get(bookingId);
    if (!booking) return { status: "no_booking" };
    if (booking.payment_approval_state !== "reauth_required") {
      return { status: "skipped" };
    }
    const priorState =
      booking.running_approved_ceiling_cents != null
        ? "pre_job_approved"
        : "none";
    await ctx.db.patch(bookingId, {
      payment_approval_state: priorState,
      updated_at: Date.now(),
    });
    return { status: "cleared", priorState };
  },
});

/**
 * Mobile-initiated reauth resume. Called by the customer-facing
 * `ReauthView` (mobile `app/booking/approve-estimate/[id].tsx`) when the
 * booking is in `payment_approval_state = "reauth_required"`.
 *
 * Why a separate action (vs. reusing `createPaymentIntentForBooking`):
 * the public booking action short-circuits when a PI already exists for
 * the booking and just retrieves the existing one — appropriate for a
 * retry from the `/confirming` flow, useless here because the existing
 * PI is the stale $20 deposit. Reauth needs to *replace* the PI with a
 * fresh one at the higher ceiling.
 *
 * Flow:
 *   1. Verify the booking is reauth_required and the caller owns it.
 *   2. Cancel the old PI (releases the prior hold).
 *   3. Create + confirm a new PI ON-SESSION with the customer's chosen
 *      PaymentMethod. On-session lets Stripe surface 3DS via
 *      `requires_action` for the client to drive with `handleNextAction`.
 *   4. Store `reauth_payment_intent_id` and swap `stripe_payment_intent_id`
 *      so subsequent capture targets the new PI.
 *   5. If status is already `requires_capture`/`succeeded`, clear the
 *      reauth state synchronously. Otherwise the `amount_capturable_updated`
 *      webhook clears it once 3DS completes.
 */
export const resumeReauthFromMobile = action({
  args: {
    bookingId: v.id("bookings"),
    paymentMethodId: v.string(),
    /** Origin of the *new* payment method for this reauth. Wallets always
     *  mint a fresh one-time PM, so this should be passed when the customer
     *  re-authorizes via Apple Pay / Google Pay. Used to stamp the payments
     *  row so any future reauth on this booking re-uses the right UX. */
    paymentOrigin: v.optional(
      v.union(
        v.literal("card"),
        v.literal("apple_pay"),
        v.literal("google_pay"),
      ),
    ),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    paymentIntentId: string;
    clientSecret: string;
    status: string;
    requiresAction: boolean;
    targetCents: number;
  }> => {
    const { user } = await requireAuthedUser(ctx);
    const result: any = await ctx.runQuery(
      internal.payments_stripe._getBookingForPayment,
      { bookingId: args.bookingId },
    );
    if (!result?.booking) throw new Error("Booking not found.");
    const { booking, shop } = result;
    if (booking.user_id !== user._id) throw new Error("Not your booking.");
    if (booking.payment_approval_state !== "reauth_required") {
      throw new Error("This booking is not waiting on a new card hold.");
    }
    if (!shop?.stripe_connect_account_id) {
      throw new Error("Shop is not ready to accept payments yet.");
    }
    if (!user.stripe_customer_id) {
      // Wallet payments (Apple Pay / Google Pay) mint a one-time PaymentMethod
      // on-device and don't require a saved card, so a first-time customer may
      // not have a Stripe customer yet. Create one lazily instead of blocking
      // the booking — the PaymentIntent still needs a customer to attach the
      // charge to. Idempotent; persists stripe_customer_id on the user row.
      user.stripe_customer_id = await ctx.runAction(
        internal.payments_stripe._getOrCreateStripeCustomer,
        { userId: user._id },
      );
    }

    const payment: any = await ctx.runQuery(
      internal.payments_stripe._getPaymentByBookingId,
      { bookingId: args.bookingId },
    );
    if (!payment) {
      throw new Error("No payment row found for this booking.");
    }

    const targetCents = Math.max(
      booking.mechanic_set_price_cents ?? 0,
      booking.running_approved_ceiling_cents ?? 0,
    );
    if (!(targetCents > 0)) {
      throw new Error("Booking has no approved hold amount to re-authorize.");
    }

    const stripe = getStripe();

    // PM-ownership check (mirrors createPaymentIntentForBooking). Unattached
    // PMs are wallet-minted one-time tokens — accept them; the wallet sheet
    // authorization is the auth signal.
    const pm = await stripe.paymentMethods.retrieve(args.paymentMethodId);
    if (pm.customer != null && pm.customer !== user.stripe_customer_id) {
      throw new Error("This card doesn't belong to you.");
    }

    // Step 1: cancel the old PI (releases stale auth). Tolerate "already
    // cancelled / captured / etc." — those are fine, we'll create a new
    // PI either way.
    const oldPiId = payment.stripe_payment_intent_id;
    if (oldPiId) {
      try {
        await stripe.paymentIntents.cancel(oldPiId);
      } catch {
        // ignore — PI may already be in a terminal state.
      }
    }

    // Step 2: create + confirm the new PI ON-SESSION so 3DS can surface to
    // the mobile client (which drives it via `handleNextAction`).
    let newPi;
    try {
      newPi = await stripe.paymentIntents.create({
        amount: targetCents,
        currency: "usd",
        customer: user.stripe_customer_id,
        payment_method: args.paymentMethodId,
        confirm: true,
        off_session: false,
        capture_method: "manual",
        transfer_data: { destination: shop.stripe_connect_account_id },
        automatic_payment_methods: { enabled: true, allow_redirects: "never" },
        // See note in createPaymentIntentForBooking: incremental auth opt-in
        // is gated on platform Flexible Payments — omit until enabled.
        metadata: {
          bookingId: String(args.bookingId),
          userId: String(user._id),
          shopId: String(shop._id),
          reauthOf: oldPiId ?? "",
        },
      });
    } catch (err: any) {
      throw new Error(err?.message ?? "Card authorization failed.");
    }

    // Step 3: record the new PI on the payments row (swaps the active PI
    // id so capture/refund target the replacement).
    await ctx.runMutation(
      internal.payments_stripe._recordAuthorizationAdjustment,
      {
        bookingId: args.bookingId,
        incrementedTotalCents: targetCents,
        reauthPaymentIntentId: newPi.id,
        ...(args.paymentOrigin != null
          ? { paymentOrigin: args.paymentOrigin }
          : {}),
      },
    );
    await ctx.runMutation(internal.payments_stripe._stampApprovalStripeAction, {
      bookingId: args.bookingId,
      stripeAction: "reauth_from_mobile",
      stripePaymentIntentId: newPi.id,
    });

    // Step 4: clear reauth state synchronously when Stripe already gave us
    // a confirmed auth (no SCA needed). The webhook is the fallback when
    // 3DS is required and the client completes it async.
    if (
      newPi.status === "requires_capture" ||
      newPi.status === "succeeded"
    ) {
      await ctx.runMutation(
        internal.payments_stripe._clearReauthRequiredAfterSuccess,
        { bookingId: args.bookingId },
      );
    }

    return {
      paymentIntentId: newPi.id,
      clientSecret: newPi.client_secret!,
      status: newPi.status,
      requiresAction: newPi.status === "requires_action",
      targetCents,
    };
  },
});

/**
 * Approve an over-range pre/mid-job estimate AND place the new hold on the
 * customer's CHOSEN payment method in one on-session call. Backs the merged
 * approve-and-hold screen so the picked method (a switched card, Apple Pay, or
 * Google Pay) is always the one authorized — unlike the async
 * `applyApprovalDecision` path, whose `adjustAuthorization` can silently raise
 * the hold on the original card before any switch applies.
 *
 * Records the approval (parks the booking in `reauth_required`), then cancels
 * the stale hold and creates + confirms a fresh manual-capture PI at the
 * approved ceiling with `paymentMethodId`. Wallet callers mint the one-time PM
 * client-side first and pass `paymentOrigin`. Returns `requiresAction` +
 * `clientSecret` for the client to drive 3DS inline; the
 * `amount_capturable_updated` webhook clears `reauth_required` once it lands.
 * On an immediate `requires_capture`/`succeeded` we clear it synchronously.
 */
export const approveAndAuthorizeHold = action({
  args: {
    bookingId: v.id("bookings"),
    paymentMethodId: v.string(),
    /** Origin of the chosen method. Wallets mint a fresh one-time PM client-
     *  side and pass this so the payments row records the right origin. */
    paymentOrigin: v.optional(
      v.union(
        v.literal("card"),
        v.literal("apple_pay"),
        v.literal("google_pay"),
      ),
    ),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    paymentIntentId: string;
    clientSecret: string;
    status: string;
    requiresAction: boolean;
    targetCents: number;
  }> => {
    const { user } = await requireAuthedUser(ctx);
    const result: any = await ctx.runQuery(
      internal.payments_stripe._getBookingForPayment,
      { bookingId: args.bookingId },
    );
    if (!result?.booking) throw new Error("Booking not found.");
    const { booking, shop } = result;
    if (booking.user_id !== user._id) throw new Error("Not your booking.");
    if (!shop?.stripe_connect_account_id) {
      throw new Error("Shop is not ready to accept payments yet.");
    }
    if (!user.stripe_customer_id) {
      // Wallet payments (Apple Pay / Google Pay) mint a one-time PaymentMethod
      // on-device and don't require a saved card, so a first-time customer may
      // not have a Stripe customer yet. Create one lazily instead of blocking
      // the booking — the PaymentIntent still needs a customer to attach the
      // charge to. Idempotent; persists stripe_customer_id on the user row.
      user.stripe_customer_id = await ctx.runAction(
        internal.payments_stripe._getOrCreateStripeCustomer,
        { userId: user._id },
      );
    }

    // Record the approval and park the booking in `reauth_required`. Throws for
    // post-job (stays on the capture path) or when no estimate is open.
    await ctx.runMutation(internal.booking_approvals._recordApprovalApproved, {
      bookingId: args.bookingId,
      userId: user._id,
    });

    // Re-read to pick up the freshly-set approved ceiling.
    const afterResult: any = await ctx.runQuery(
      internal.payments_stripe._getBookingForPayment,
      { bookingId: args.bookingId },
    );
    const afterBooking = afterResult?.booking ?? booking;
    const payment: any = await ctx.runQuery(
      internal.payments_stripe._getPaymentByBookingId,
      { bookingId: args.bookingId },
    );
    if (!payment) throw new Error("No payment row found for this booking.");

    const targetCents = Math.max(
      afterBooking.mechanic_set_price_cents ?? 0,
      afterBooking.running_approved_ceiling_cents ?? 0,
    );
    if (!(targetCents > 0)) {
      throw new Error("Booking has no approved hold amount to authorize.");
    }

    const stripe = getStripe();

    // PM-ownership check (mirrors resumeReauthFromMobile). Unattached PMs are
    // wallet-minted one-time tokens — accept them.
    const pm = await stripe.paymentMethods.retrieve(args.paymentMethodId);
    if (pm.customer != null && pm.customer !== user.stripe_customer_id) {
      throw new Error("This card doesn't belong to you.");
    }

    // Cancel the stale hold (tolerate an already-terminal PI).
    const oldPiId = payment.stripe_payment_intent_id;
    if (oldPiId) {
      try {
        await stripe.paymentIntents.cancel(oldPiId);
      } catch {
        // ignore — PI may already be in a terminal state.
      }
    }

    // Create + confirm the new PI ON-SESSION so 3DS can surface to the client.
    let newPi;
    try {
      newPi = await stripe.paymentIntents.create({
        amount: targetCents,
        currency: "usd",
        customer: user.stripe_customer_id,
        payment_method: args.paymentMethodId,
        confirm: true,
        off_session: false,
        capture_method: "manual",
        transfer_data: { destination: shop.stripe_connect_account_id },
        automatic_payment_methods: { enabled: true, allow_redirects: "never" },
        metadata: {
          bookingId: String(args.bookingId),
          userId: String(user._id),
          shopId: String(shop._id),
          reauthOf: oldPiId ?? "",
        },
      });
    } catch (err: any) {
      throw new Error(err?.message ?? "Card authorization failed.");
    }

    await ctx.runMutation(
      internal.payments_stripe._recordAuthorizationAdjustment,
      {
        bookingId: args.bookingId,
        incrementedTotalCents: targetCents,
        reauthPaymentIntentId: newPi.id,
        ...(args.paymentOrigin != null
          ? { paymentOrigin: args.paymentOrigin }
          : {}),
      },
    );
    await ctx.runMutation(internal.payments_stripe._stampApprovalStripeAction, {
      bookingId: args.bookingId,
      stripeAction: "approve_and_hold",
      stripePaymentIntentId: newPi.id,
    });

    if (
      newPi.status === "requires_capture" ||
      newPi.status === "succeeded"
    ) {
      await ctx.runMutation(
        internal.payments_stripe._clearReauthRequiredAfterSuccess,
        { bookingId: args.bookingId },
      );
    }

    return {
      paymentIntentId: newPi.id,
      clientSecret: newPi.client_secret!,
      status: newPi.status,
      requiresAction: newPi.status === "requires_action",
      targetCents,
    };
  },
});

/** Snapshots the captured parts list + amount onto the booking, flips state
 *  to `captured`, and transitions the payments row. */
export const _patchBookingCaptured = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    finalTotalCents: v.number(),
    finalCaptureAmountCents: v.number(),
    partsSnapshot: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const patch: any = {
      final_total_cents: args.finalTotalCents,
      final_capture_amount_cents: args.finalCaptureAmountCents,
      payment_approval_state: "captured",
      updated_at: now,
    };
    if (args.partsSnapshot) {
      patch.final_parts_used_at_capture = args.partsSnapshot;
    }
    await ctx.db.patch(args.bookingId, patch);

    const payment = await ctx.db
      .query("payments")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", args.bookingId))
      .unique();
    if (payment) {
      await ctx.db.patch(payment._id, {
        captured_amount_cents: args.finalCaptureAmountCents,
        status: "completed",
        updated_at: now,
      });
    }
  },
});

/** Settlement marker (Option A). Completion never blocks on payment; instead we
 *  record whether the final total was fully captured. A shortfall (hold
 *  couldn't be raised, capture failed, or reauth is pending) flags the booking
 *  `awaiting_settlement` with the outstanding cents so the reconciliation cron +
 *  ops can chase the rest. A near-full capture (within the drift tolerance)
 *  counts as settled and clears any prior awaiting flag. First-seen timestamp is
 *  preserved so the cron can age the shortfall. */
export const _stampSettlement = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    capturedCents: v.number(),
    finalCents: v.number(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const shortfall = Math.max(
      0,
      Math.round(args.finalCents) - Math.round(args.capturedCents),
    );
    if (shortfall <= FINALIZE_DRIFT_TOLERANCE_CENTS) {
      await ctx.db.patch(args.bookingId, {
        settlement_state: "settled",
        settlement_shortfall_cents: 0,
        settlement_reason: undefined,
        awaiting_settlement_since_ms: undefined,
        updated_at: now,
      });
      return { state: "settled" as const };
    }
    const existing: any = await ctx.db.get(args.bookingId);
    await ctx.db.patch(args.bookingId, {
      settlement_state: "awaiting_settlement",
      settlement_shortfall_cents: shortfall,
      settlement_reason: args.reason,
      awaiting_settlement_since_ms:
        existing?.awaiting_settlement_since_ms ?? now,
      updated_at: now,
    });
    return { state: "awaiting_settlement" as const, shortfall };
  },
});

/** Increments the manual-capture authorization to the booking's current
 *  `mechanic_set_price_cents` (or `running_approved_ceiling_cents`, whichever
 *  is larger). Falls through to a reauth flow when Stripe rejects the
 *  increment (card brand doesn't support incremental auth, or the card was
 *  later declined). Idempotent — skips when the hold already matches. */
export const adjustAuthorization = internalAction({
  args: { bookingId: v.id("bookings") },
  handler: async (
    ctx,
    args,
  ): Promise<{ status: string; targetCents?: number; reason?: string }> => {
    const result: any = await ctx.runQuery(
      internal.payments_stripe._getBookingForPayment,
      { bookingId: args.bookingId },
    );
    const booking = result?.booking;
    if (!booking) return { status: "skipped", reason: "no booking" };

    const payment: any = await ctx.runQuery(
      internal.payments_stripe._getPaymentByBookingId,
      { bookingId: args.bookingId },
    );
    const activePiId = resolveActivePaymentIntentId(payment);
    if (!activePiId) {
      return { status: "skipped", reason: "no payment intent" };
    }

    const currentHold =
      payment.incremented_total_cents ??
      payment.hold_amount_cents ??
      Math.round((payment.amount ?? 0) * 100);

    const target = Math.max(
      booking.mechanic_set_price_cents ?? 0,
      booking.running_approved_ceiling_cents ?? 0,
    );

    if (target <= currentHold) {
      return { status: "skipped", reason: "hold already covers target" };
    }

    const stripe = getStripe();
    try {
      await stripe.paymentIntents.incrementAuthorization(activePiId, {
        amount: target,
      });
      await ctx.runMutation(
        internal.payments_stripe._recordAuthorizationAdjustment,
        { bookingId: args.bookingId, incrementedTotalCents: target },
      );
      await ctx.runMutation(internal.payments_stripe._stampApprovalStripeAction, {
        bookingId: args.bookingId,
        stripeAction: "increment_authorization",
      });
      return { status: "ok", targetCents: target };
    } catch (err: any) {
      const code = err?.code ?? err?.raw?.code ?? "";
      const isReauthable =
        code === "incremental_authorization_not_supported" ||
        code === "card_declined" ||
        code === "payment_intent_unexpected_state";
      if (!isReauthable) {
        // Surface the failure instead of letting the booking sit with a stale
        // hold while the mechanic thinks they're approved. Same exit as a
        // failed reauth: revert to reauth_required + push the customer.
        await ctx.runMutation(
          internal.payments_stripe._stampApprovalStripeAction,
          { bookingId: args.bookingId, stripeAction: "increment_failed" },
        );
        await ctx.runMutation(
          internal.payments_stripe._revertBookingToPendingForReauth,
          { bookingId: args.bookingId },
        );
        return { status: "reauth_required", reason: err?.message };
      }
      // Reauth fallback: void the current $20 PI and create a fresh PI for
      // the target amount, off-session against the saved PaymentMethod.
      return await reauthFlow(ctx, {
        booking,
        payment,
        targetCents: target,
        stripe,
      });
    }
  },
});

async function reauthFlow(
  ctx: any,
  args: {
    booking: any;
    payment: any;
    targetCents: number;
    stripe: any;
  },
): Promise<{ status: string; targetCents?: number; reason?: string }> {
  const { booking, payment, targetCents, stripe } = args;
  // Wallet-origin bookings cannot silently reauth — the original PM was a
  // one-time wallet token and any saved card on file is not the customer's
  // chosen payment for this booking. Push them through the customer-driven
  // reauth flow (mobile screen presents a fresh wallet sheet) instead.
  if (
    payment?.payment_origin === "apple_pay" ||
    payment?.payment_origin === "google_pay"
  ) {
    await ctx.runMutation(
      internal.payments_stripe._revertBookingToPendingForReauth,
      { bookingId: booking._id },
    );
    return { status: "reauth_failed", reason: "wallet origin requires user re-prompt" };
  }
  try {
    // Step 1: cancel the existing PI (releases the $20 hold).
    try {
      await stripe.paymentIntents.cancel(payment.stripe_payment_intent_id);
    } catch {
      // ignore — PI may already be cancelled or in a terminal state.
    }

    // Step 2: pull the saved PM. If we don't have one stored, abandon and
    // push the customer to update their card.
    const customer = await ctx.runQuery(
      internal.payments_stripe._getBookingForPayment,
      { bookingId: booking._id },
    );
    const user: any = await ctx.runQuery(
      internal.payments_stripe._getUserForPayment,
      { userId: booking.user_id },
    );
    if (!user?.stripe_customer_id) {
      await ctx.runMutation(
        internal.payments_stripe._revertBookingToPendingForReauth,
        { bookingId: booking._id },
      );
      return { status: "reauth_failed", reason: "no stripe customer" };
    }
    const methods = await stripe.paymentMethods.list({
      customer: user.stripe_customer_id,
      type: "card",
      limit: 1,
    });
    const pm = methods.data[0];
    if (!pm) {
      await ctx.runMutation(
        internal.payments_stripe._revertBookingToPendingForReauth,
        { bookingId: booking._id },
      );
      return { status: "reauth_failed", reason: "no saved payment method" };
    }

    // Step 3: create + confirm a new PI off-session at the target amount.
    const newPi = await stripe.paymentIntents.create({
      amount: targetCents,
      currency: "usd",
      customer: user.stripe_customer_id,
      payment_method: pm.id,
      confirm: true,
      off_session: true,
      capture_method: "manual",
      transfer_data: customer?.shop?.stripe_connect_account_id
        ? { destination: customer.shop.stripe_connect_account_id }
        : undefined,
      metadata: {
        bookingId: String(booking._id),
        reauthOf: payment.stripe_payment_intent_id ?? "",
      },
    });

    if (
      newPi.status !== "requires_capture" &&
      newPi.status !== "succeeded"
    ) {
      await ctx.runMutation(
        internal.payments_stripe._revertBookingToPendingForReauth,
        { bookingId: booking._id },
      );
      return { status: "reauth_failed", reason: `pi status ${newPi.status}` };
    }

    await ctx.runMutation(
      internal.payments_stripe._recordAuthorizationAdjustment,
      {
        bookingId: booking._id,
        incrementedTotalCents: targetCents,
        reauthPaymentIntentId: newPi.id,
      },
    );
    await ctx.runMutation(internal.payments_stripe._stampApprovalStripeAction, {
      bookingId: booking._id,
      stripeAction: "reauth",
      stripePaymentIntentId: newPi.id,
    });
    return { status: "reauth_ok", targetCents };
  } catch (err: any) {
    await ctx.runMutation(
      internal.payments_stripe._revertBookingToPendingForReauth,
      { bookingId: booking._id },
    );
    return { status: "reauth_failed", reason: err?.message };
  }
}

export const _getUserForPayment = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.userId);
  },
});

/** Captures the $20 deposit forfeit when a pre-job approval SLA expires
 *  without a customer response. Idempotent — skips if the payment is
 *  already terminal. */
export const captureDepositForfeit = internalAction({
  args: { bookingId: v.id("bookings") },
  handler: async (
    ctx,
    args,
  ): Promise<{ status: string; reason?: string }> => {
    const payment: any = await ctx.runQuery(
      internal.payments_stripe._getPaymentByBookingId,
      { bookingId: args.bookingId },
    );
    if (!payment?.stripe_payment_intent_id) {
      return { status: "skipped", reason: "no payment intent" };
    }
    if (
      payment.status === "completed" ||
      payment.status === "cancelled" ||
      payment.status === "refunded"
    ) {
      return { status: "skipped", reason: `payment is ${payment.status}` };
    }
    const stripe = getStripe();
    try {
      const pi = await stripe.paymentIntents.capture(
        payment.stripe_payment_intent_id,
        { amount_to_capture: BOOKING_DEPOSIT_CENTS },
      );
      await ctx.runMutation(internal.payments_stripe._stampApprovalStripeAction, {
        bookingId: args.bookingId,
        stripeAction: "capture_deposit_forfeit",
      });
      await ctx.runMutation(internal.payments_stripe._patchBookingCaptured, {
        bookingId: args.bookingId,
        finalTotalCents: BOOKING_DEPOSIT_CENTS,
        finalCaptureAmountCents: BOOKING_DEPOSIT_CENTS,
      });
      return { status: pi.status };
    } catch (err: any) {
      return { status: "failed", reason: err?.message };
    }
  },
});

/**
 * Charge a late-cancellation / no-show fee by PARTIAL-capturing the existing
 * manual-capture hold. Stripe releases the uncaptured remainder automatically,
 * so this both charges the fee and frees the rest of the customer's hold.
 *
 * The fee is capped at the current authorization — you cannot capture more
 * than is held — so pre-inspection the ceiling is the $20 deposit. A zero fee
 * (free cancel) falls through to a plain void. Scheduled from
 * applyBookingStatusTransition when a booking goes cancelled/no_show with a fee;
 * mirrors captureDepositForfeit's guards so re-invocation is safe.
 */
export const captureCancellationFee = internalAction({
  args: {
    bookingId: v.id("bookings"),
    feeCents: v.number(),
    kind: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ status: string; capturedCents?: number; reason?: string }> => {
    const payment: any = await ctx.runQuery(
      internal.payments_stripe._getPaymentByBookingId,
      { bookingId: args.bookingId },
    );
    if (!payment?.stripe_payment_intent_id) {
      return { status: "skipped", reason: "no payment intent" };
    }
    if (
      payment.status === "completed" ||
      payment.status === "cancelled" ||
      payment.status === "refunded"
    ) {
      return { status: "skipped", reason: `payment is ${payment.status}` };
    }

    // Never attempt to capture more than the live hold authorizes.
    const holdCents: number =
      payment.incremented_total_cents ??
      payment.hold_amount_cents ??
      BOOKING_DEPOSIT_CENTS;
    const captureCents = Math.min(Math.max(0, Math.round(args.feeCents)), holdCents);

    // Zero fee → just void the hold (delegate to the existing void path).
    if (captureCents <= 0) {
      return await ctx.runAction(
        internal.payments_stripe.cancelPaymentIntentForBooking,
        { bookingId: args.bookingId },
      );
    }

    const stripe = getStripe();
    try {
      const pi = await stripe.paymentIntents.capture(
        payment.stripe_payment_intent_id,
        { amount_to_capture: captureCents },
      );
      await ctx.runMutation(internal.payments_stripe._stampApprovalStripeAction, {
        bookingId: args.bookingId,
        stripeAction: `capture_${args.kind}_fee`,
      });
      await ctx.runMutation(internal.payments_stripe._patchBookingCaptured, {
        bookingId: args.bookingId,
        finalTotalCents: captureCents,
        finalCaptureAmountCents: captureCents,
      });
      return { status: pi.status, capturedCents: captureCents };
    } catch (err: any) {
      // Fee capture failing must NOT block the cancellation itself — mark the
      // payment row failed for ops/retry and let the status transition stand.
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

/** Compute the actual final total from job_actuals + booking. Returns
 *  cents. Mirrors computeMechanicSetPrice from booking_approvals.ts but
 *  reads from the persisted post-job data instead of dialog inputs. */
export const _computeFinalTotalForBooking = internalQuery({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const booking: any = await ctx.db.get(args.bookingId);
    if (!booking) return null;
    const actual = await ctx.db
      .query("job_actuals")
      .withIndex("by_booking_id", (q: any) =>
        q.eq("booking_id", args.bookingId),
      )
      .first();

    const parts: any[] = Array.isArray(actual?.parts_used)
      ? actual!.parts_used
      : [];

    let partsCents = 0;
    for (const p of parts) {
      if (p?.not_used) continue;
      if (p?.supplied_by === "customer") continue;
      const qty = Math.max(0, p?.quantity ?? 1);
      partsCents += Math.round((p?.cost ?? 0) * qty * 100);
    }

    // Labor source: prefer the latest approved booking_approvals row's
    // frozen labor_cents. The pre/mid-job dialog can override labor via
    // laborHours × laborRateCents — that override goes into the approval row
    // and into mechanic_set_price_cents, but it's never propagated back to
    // booking.labor_cost. Reading from the approval row here keeps finalize
    // aligned with the labor that fed mechanic_set, so a labor change in
    // pre-job doesn't drift finalCents past mechanic_set and spuriously trip
    // a post-job re-approval. Falls back to booking.labor_cost on legacy
    // rows that lack the breakdown.
    const approvals = await ctx.db
      .query("booking_approvals")
      .withIndex("by_booking_and_cycle", (q: any) =>
        q.eq("booking_id", args.bookingId),
      )
      .order("desc")
      .collect();
    const latestApproved = approvals.find(
      (r: any) =>
        r.decision === "approved" ||
        r.decision === "auto_approved_within_range" ||
        r.decision === "fixed_price_informational",
    );
    const laborCents =
      latestApproved?.labor_cents != null
        ? (latestApproved.labor_cents as number)
        : Math.round((booking.labor_cost ?? 0) * 100);

    return {
      booking,
      partsSnapshot: parts,
      partsSubtotalCents: partsCents,
      laborCents,
      // Caller will recompute tax + fee.
    };
  },
});

/** Replaces the legacy capturePaymentIntentForBooking call site. Runs on
 *  `applyBookingStatusTransition` when status flips to "completed".
 *
 *  Behavior:
 *   - Backwards-compat: pre-feature bookings (no disclosed range, state
 *     "none") fall through to the original capture path.
 *   - final ≤ mechanic_set_price_cents → capture at `final` and flip to
 *     "captured".
 *   - final > mechanic_set_price_cents → open a post-job re-approval
 *     cycle. Don't capture yet; capture lands when the customer decides.
 */
export const finalizeAndChargeForBooking = internalAction({
  args: {
    bookingId: v.id("bookings"),
    // Called from booking_approvals.applyApprovalDecision (declined branch)
    // for post_job: capture at the prior approved ceiling without recomputing
    // against actuals. Without this, finalize sees final > mechanic_set and
    // reopens another post-job approval cycle — an infinite loop.
    forceCaptureAtCeiling: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ status: string; reason?: string }> => {
    const computed: any = await ctx.runQuery(
      internal.payments_stripe._computeFinalTotalForBooking,
      { bookingId: args.bookingId },
    );
    if (!computed?.booking) {
      return { status: "skipped", reason: "booking not found" };
    }
    const { booking, partsSnapshot, partsSubtotalCents, laborCents } = computed;

    // Decline branch (or explicit flag): capture at the approved ceiling and
    // skip the actuals comparison. Honors min(ceiling, finalCents) so we
    // never charge MORE than what the parts/labor sum actually came to.
    const declinedFinalize =
      args.forceCaptureAtCeiling === true ||
      (booking.payment_approval_state as string | undefined) === "post_job_declined";
    if (declinedFinalize) {
      const ceiling =
        booking.running_approved_ceiling_cents ??
        booking.disclosed_range_high_cents ??
        0;
      if (ceiling <= 0) {
        return { status: "skipped", reason: "no approved ceiling to capture against" };
      }
      const subtotalCents = partsSubtotalCents + laborCents;
      const shop = booking.shop_id
        ? await ctx.runQuery(internal.payments_stripe._getShopForFinalize, {
            shopId: booking.shop_id,
          })
        : null;
      const tax = computeBookingTax({
        laborDollars: laborCents / 100,
        partsDollars: partsSubtotalCents / 100,
        state: shop?.state ?? null,
        zip: shop?.zip ?? null,
      });
      const taxCents = Math.round((tax.taxDollars ?? 0) * 100);
      const feeCents = Math.round(
        computePlatformFeeDollars(subtotalCents / 100) * 100,
      );
      const finalCents = subtotalCents + taxCents + feeCents;
      const captureCents = Math.min(ceiling, finalCents);
      return await captureAtAmount(
        ctx,
        args.bookingId,
        captureCents,
        finalCents,
        partsSnapshot,
        feeCents,
      );
    }

    // Backwards-compat: bookings created before the disclosed-range fields
    // were added (Phase 1) keep the legacy capture path. payment_approval_state
    // defaults to undefined/"none" for those rows.
    const state = booking.payment_approval_state as string | undefined;
    const isLegacy =
      booking.disclosed_range_high_cents == null && (state == null || state === "none");
    if (isLegacy) {
      return await ctx.runAction(
        internal.payments_stripe.capturePaymentIntentForBooking,
        { bookingId: args.bookingId },
      );
    }

    // Server-authoritative tax + platform fee on the *actual* parts.
    const subtotalCents = partsSubtotalCents + laborCents;
    const shop = booking.shop_id
      ? await ctx.runQuery(internal.payments_stripe._getShopForFinalize, {
          shopId: booking.shop_id,
        })
      : null;
    const tax = computeBookingTax({
      laborDollars: laborCents / 100,
      partsDollars: partsSubtotalCents / 100,
      state: shop?.state ?? null,
      zip: shop?.zip ?? null,
    });
    const taxCents = Math.round((tax.taxDollars ?? 0) * 100);
    const feeCents = Math.round(
      computePlatformFeeDollars(subtotalCents / 100) * 100,
    );
    const finalCents = subtotalCents + taxCents + feeCents;

    const mechanicSet = booking.mechanic_set_price_cents ?? 0;
    if (mechanicSet <= 0) {
      // Should never happen on a non-legacy booking — the pre-job submit is a
      // prerequisite for marking complete. Log loudly so we catch the
      // upstream miss instead of silently capturing.
      console.error(
        `[finalizeAndChargeForBooking] mechanic_set_price_cents missing on non-legacy booking ${String(args.bookingId)}; capturing at approved ceiling`,
      );
      const safeCap =
        booking.running_approved_ceiling_cents ??
        booking.disclosed_range_high_cents ??
        0;
      if (safeCap <= 0) {
        // Completed job we genuinely can't charge (no set price, no ceiling).
        // Flag it so it surfaces for ops instead of vanishing.
        await ctx.runMutation(internal.payments_stripe._stampSettlement, {
          bookingId: args.bookingId,
          capturedCents: 0,
          finalCents,
          reason: "no_ceiling_or_set_price",
        });
        return { status: "skipped", reason: "no ceiling and no mechanic set price" };
      }
      // Capture at min(actuals, ceiling) — never above what the customer
      // implicitly authorized via the disclosed range.
      const capCents = Math.min(finalCents, safeCap);
      return await captureAtAmount(
        ctx,
        args.bookingId,
        capCents,
        finalCents,
        partsSnapshot,
        feeCents,
      );
    }

    // Fixed price: the customer pays the agreed flat total (base + any approved
    // added scope), full stop — never a reconciliation against actual parts/
    // labor. Reconciling would UNDER-charge when actuals land below the flat
    // rate (its whole point is the shop eats that spread) and needlessly probe a
    // re-approval when they land above. Capture the agreed amount, exactly like
    // the over-actuals branch below already does for every booking.
    if (booking.is_fixed_price === true) {
      return await captureAtAmount(
        ctx,
        args.bookingId,
        mechanicSet,
        mechanicSet,
        partsSnapshot,
        feeCents,
      );
    }

    // Tolerance: tax/fee recompute can drift by a cent due to Math.round, and
    // legacy approval rows without frozen labor_cents fall back to
    // booking.labor_cost which may diverge from the submitted labor inputs.
    // Within this band we capture at the approved ceiling instead of opening
    // a spurious post-job re-approval cycle the customer would never see a
    // reason to confirm.
    if (finalCents <= mechanicSet + FINALIZE_DRIFT_TOLERANCE_CENTS) {
      const captureCents = Math.min(finalCents, mechanicSet);
      return await captureAtAmount(
        ctx,
        args.bookingId,
        captureCents,
        finalCents,
        partsSnapshot,
        feeCents,
      );
    }

    // Actuals exceeded the pre-agreed set price. The customer approved the
    // price BEFORE the job started (pre-job approval, plus any mid-job "found
    // extra work" approvals granted during it), so we do NOT reopen a post-job
    // negotiation with a decline the customer could use to walk away from
    // finished work. Capture the agreed price and settle. Any excess beyond
    // what was agreed is absorbed — never charged without the customer's prior
    // consent (the mid-job approval is the consented path to raise the price
    // while the work is still in progress).
    return await captureAtAmount(
      ctx,
      args.bookingId,
      mechanicSet, // charge the agreed price, not the higher raw actuals
      mechanicSet, // owed == agreed price → no false "shortfall" to chase
      partsSnapshot,
      feeCents,
    );
  },
});

/** When reauthFlow voids the original PI and creates a replacement, the live
 *  hold lives on payment.reauth_payment_intent_id. Capture/refund must target
 *  that PI — the original is cancelled and capturing it would 400.
 *
 *  Exported for convex/shopPaymentRefunds.ts (the shop-owner refund path) —
 *  plain helper, not a registered Convex function. */
export function resolveActivePaymentIntentId(payment: any): string | undefined {
  return payment?.reauth_payment_intent_id ?? payment?.stripe_payment_intent_id;
}

async function captureAtAmount(
  ctx: any,
  bookingId: any,
  captureCents: number,
  finalCents: number,
  partsSnapshot: any,
  applicationFeeCents?: number,
): Promise<{ status: string; reason?: string }> {
  const payment: any = await ctx.runQuery(
    internal.payments_stripe._getPaymentByBookingId,
    { bookingId },
  );
  const activePiId = resolveActivePaymentIntentId(payment);
  if (!activePiId) {
    return { status: "skipped", reason: "no payment intent" };
  }
  if (payment.status === "completed") {
    return { status: "skipped", reason: "already completed" };
  }
  const stripe = getStripe();
  // Never ask Stripe to capture more than the live hold authorizes — an over-
  // capture 400s and would otherwise strand the whole charge. Cap at what the
  // authorization actually covers (Option A: capture the ceiling, never $0);
  // any shortfall vs the final total is flagged for settlement below.
  const holdCents: number =
    payment.incremented_total_cents ??
    payment.hold_amount_cents ??
    BOOKING_DEPOSIT_CENTS;
  const amountToCapture = Math.max(
    1,
    Math.min(Math.round(captureCents), Math.round(holdCents)),
  );
  const captureParams: Record<string, number> = {
    amount_to_capture: amountToCapture,
  };
  // Reauth-minted PIs (wallet path) are created with no application_fee_amount
  // — passing it at capture keeps the platform cut from leaking to the shop.
  // Cap at amount_to_capture; Stripe rejects fees larger than the captured
  // amount.
  if (applicationFeeCents != null) {
    captureParams.application_fee_amount = Math.max(
      0,
      Math.min(Math.round(applicationFeeCents), amountToCapture),
    );
  }
  try {
    const pi = await stripe.paymentIntents.capture(activePiId, captureParams);
    await ctx.runMutation(internal.payments_stripe._patchBookingCaptured, {
      bookingId,
      finalTotalCents: finalCents,
      // What we actually captured (capped at the hold), not the requested total.
      finalCaptureAmountCents: amountToCapture,
      partsSnapshot,
    });
    await ctx.runMutation(internal.payments_stripe._stampApprovalStripeAction, {
      bookingId,
      stripeAction: "capture_final",
    });
    // Flag any shortfall: the hold couldn't cover the full final total, so the
    // job is captured-at-ceiling and the remainder is chased via settlement.
    await ctx.runMutation(internal.payments_stripe._stampSettlement, {
      bookingId,
      capturedCents: amountToCapture,
      finalCents,
      reason:
        amountToCapture < finalCents ? "hold_below_final_total" : undefined,
    });
    return { status: pi.status };
  } catch (err: any) {
    // Capture is impossible right now (PI not capturable — e.g. reauth pending /
    // requires_action). Surface it on the payment row AND flag the completed job
    // for settlement so the reconciliation cron + ops chase it — never leave it
    // silently uncaptured with nobody watching.
    console.error(
      `[captureAtAmount] capture failed booking=${String(bookingId)} pi=${activePiId} amount=${amountToCapture}: ${err?.message ?? err}`,
    );
    if (payment?._id) {
      await ctx.runMutation(internal.payments_stripe._transitionPayment, {
        paymentId: payment._id,
        newStatus: "failed",
        errorCode: err?.code,
        errorMessage: err?.message?.slice(0, 500),
      });
    }
    await ctx.runMutation(internal.payments_stripe._stampSettlement, {
      bookingId,
      capturedCents: 0,
      finalCents,
      reason: `capture_failed:${err?.code ?? "unknown"}`,
    });
    return { status: "failed", reason: err?.message };
  }
}

export const _getShopForFinalize = internalQuery({
  args: { shopId: v.id("shops") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.shopId);
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
    const activePiId = resolveActivePaymentIntentId(payment);
    if (!activePiId) {
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
      payment_intent: activePiId,
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
