// =============================================================================
// Otofacts Car Data API — Stripe billing + write-access entitlements.
// Spec: convex/CARDATA_BILLING_SPEC.md.
//
// The LIVE source of truth for what a self-serve dev key may do. A key resolves
//   api_keys.owner_user_id → api_entitlements  (see dataApi.withApiKey)
// on every request, so a plan change takes effect instantly with no re-mint.
//
// Billing subject = one Clerk user (users row). Shared Stripe account with the
// booking product — EVERY object here is namespaced metadata.app="otofacts" and
// the webhook ignores anything else (entitlementFromSubscription returns null).
//
// Enrich (write) billing: included monthly credits per tier, then metered
// overage (Stripe Billing Meter "otofacts.enrich") up to a user spend cap.
// Credits move through enrich_ledger as reserve → commit | refund, so a failed
// enrich is never charged (settled by reconcileEnrichLedger, a 5-min cron).
// =============================================================================
import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getStripe } from "../lib/stripe";
import { billingPeriodKey } from "./dataApi";

// ── Constants ────────────────────────────────────────────────────────────────

/** Per-enrich price once a plan's included credits are used up. Set this from
 *  the real cost basis: median enrichment_runs.estimated_cost_usd × margin. */
export const ENRICH_OVERAGE_UNIT_CENTS = 25;
/** A reserved credit whose run never terminalizes is refunded after this. */
export const ENRICH_RESERVE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

const ALL_SCOPES = [
  "maintenance:read",
  "labor:read",
  "media:read",
  "enrich:write",
  "service_history:read",
] as const;
type Scope = (typeof ALL_SCOPES)[number];
const isScope = (s: string): s is Scope => (ALL_SCOPES as readonly string[]).includes(s);

const PLANS = ["free", "pro", "scale", "enterprise"] as const;
type PlanId = (typeof PLANS)[number];
const asPlan = (s: string | undefined): PlanId =>
  (PLANS as readonly string[]).includes(s ?? "") ? (s as PlanId) : "pro";

export const FREE_SCOPES: Scope[] = [
  "maintenance:read",
  "labor:read",
  "media:read",
  "service_history:read",
];

/** Normalized entitlement view — the ONE shape resolveEntitlement returns, so
 *  callers never branch on free-vs-paid field presence. */
export type EntitlementView = {
  plan: PlanId;
  status: string;
  scopes: Scope[];
  rate_limit_per_min: number;
  monthly_read_quota: number;
  enrich_credits_remaining: number;
  enrich_monthly_grant: number;
  metered_overage: boolean;
  spend_cap_cents: number | null;
  overage_spent_cents_this_period: number;
};

export const FREE_ENTITLEMENT: EntitlementView = {
  plan: "free",
  status: "active",
  scopes: FREE_SCOPES,
  rate_limit_per_min: 60,
  monthly_read_quota: 10_000,
  enrich_credits_remaining: 0,
  enrich_monthly_grant: 0,
  metered_overage: false,
  spend_cap_cents: null,
  overage_spent_cents_this_period: 0,
};

// Safety net only — real limits come from Stripe price.metadata. Keyed by
// lookup_key. Keep in sync with the Otofacts /pricing plans module.
const PLAN_FALLBACK: Record<
  string,
  { plan: PlanId; scopes: Scope[]; rate_limit_per_min: number; monthly_read_quota: number; enrich_monthly_grant: number }
> = {
  otofacts_pro_monthly: {
    plan: "pro",
    scopes: [...FREE_SCOPES, "enrich:write"],
    rate_limit_per_min: 300,
    monthly_read_quota: 250_000,
    enrich_monthly_grant: 100,
  },
  otofacts_scale_monthly: {
    plan: "scale",
    scopes: [...FREE_SCOPES, "enrich:write"],
    rate_limit_per_min: 1000,
    monthly_read_quota: 2_000_000,
    enrich_monthly_grant: 1000,
  },
};

// ── Stripe subscription → entitlement mapping ────────────────────────────────

type ParsedPlan = {
  plan: PlanId;
  scopes: Scope[];
  rate_limit_per_min: number;
  monthly_read_quota: number;
  enrich_monthly_grant: number;
  metered_overage: boolean;
  lookup_key: string | undefined;
  period_start: number;
  period_end: number;
};

/** Parse a Stripe subscription's tier item into our entitlement shape. Returns
 *  null for anything that isn't an Otofacts subscription (the shared-account
 *  guard — booking subs, if any, and other products fall through untouched). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function entitlementFromSubscription(sub: any): ParsedPlan | null {
  const items = sub?.items?.data ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tierItem = items.find((it: any) => it?.price?.recurring?.usage_type !== "metered");
  const price = tierItem?.price;
  if (!price || price?.metadata?.app !== "otofacts") return null; // ← guard
  const md = price.metadata ?? {};
  const lookup_key: string | undefined = price.lookup_key ?? undefined;
  const fb = lookup_key ? PLAN_FALLBACK[lookup_key] : undefined;
  const csv = (s?: string): Scope[] | undefined =>
    s ? s.split(",").map((x) => x.trim()).filter(isScope) : undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const metered_overage = items.some(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (it: any) => it?.price?.recurring?.usage_type === "metered" && it?.price?.metadata?.app === "otofacts",
  );
  return {
    plan: asPlan(md.plan ?? fb?.plan),
    scopes: csv(md.scopes) ?? fb?.scopes ?? [...FREE_SCOPES, "enrich:write"],
    rate_limit_per_min: Number(md.rate_limit_per_min) || fb?.rate_limit_per_min || 300,
    monthly_read_quota: Number(md.monthly_read_quota) || fb?.monthly_read_quota || 250_000,
    enrich_monthly_grant: Number(md.enrich_monthly_grant) || fb?.enrich_monthly_grant || 100,
    metered_overage,
    lookup_key,
    // Stripe moved period bounds onto items in recent API versions (dahlia);
    // read the subscription-level field if present, else the tier item's.
    period_start: (sub.current_period_start ?? tierItem?.current_period_start ?? 0) * 1000,
    period_end: (sub.current_period_end ?? tierItem?.current_period_end ?? 0) * 1000,
  };
}

// ── Live resolution (hot path — used by dataApi.withApiKey) ──────────────────

/** Never throws — worst case returns the free tier. */
export const resolveEntitlement = internalQuery({
  args: { owner_user_id: v.optional(v.id("users")) },
  handler: async (ctx, { owner_user_id }): Promise<EntitlementView> => {
    if (!owner_user_id) return FREE_ENTITLEMENT;
    const ent = await ctx.db
      .query("api_entitlements")
      .withIndex("by_user", (q) => q.eq("owner_user_id", owner_user_id))
      .first();
    if (!ent) return FREE_ENTITLEMENT;
    const entitled = ent.status === "active" || ent.status === "trialing";
    if (!entitled) return FREE_ENTITLEMENT;
    return {
      plan: ent.plan,
      status: ent.status,
      scopes: ent.scopes,
      rate_limit_per_min: ent.rate_limit_per_min,
      monthly_read_quota: ent.monthly_read_quota,
      enrich_credits_remaining: ent.enrich_credits_remaining,
      enrich_monthly_grant: ent.enrich_monthly_grant,
      metered_overage: ent.metered_overage,
      spend_cap_cents: ent.spend_cap_cents ?? null,
      overage_spent_cents_this_period: ent.overage_spent_cents_this_period,
    };
  },
});

// ── Dashboard reads ──────────────────────────────────────────────────────────

/** Powers the Otofacts dashboard plan card. */
export const myEntitlement = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject))
      .first();
    if (!user) return { ...FREE_ENTITLEMENT, read_requests_this_period: 0 };

    const pk = billingPeriodKey(Date.now());
    const counter = await ctx.db
      .query("api_usage_counters")
      .withIndex("by_user_period", (q) => q.eq("owner_user_id", user._id).eq("period_key", pk))
      .first();
    const read_requests_this_period = counter?.read_requests ?? 0;

    const ent = await ctx.db
      .query("api_entitlements")
      .withIndex("by_user", (q) => q.eq("owner_user_id", user._id))
      .first();
    if (!ent) return { ...FREE_ENTITLEMENT, read_requests_this_period };

    return {
      plan: ent.plan,
      status: ent.status,
      scopes: ent.scopes,
      rate_limit_per_min: ent.rate_limit_per_min,
      monthly_read_quota: ent.monthly_read_quota,
      enrich_credits_remaining: ent.enrich_credits_remaining,
      enrich_monthly_grant: ent.enrich_monthly_grant,
      metered_overage: ent.metered_overage,
      spend_cap_cents: ent.spend_cap_cents ?? null,
      overage_spent_cents_this_period: ent.overage_spent_cents_this_period,
      current_period_end: ent.current_period_end ?? null,
      read_requests_this_period,
    };
  },
});

/** User sets their own metered-overage ceiling. */
export const setSpendCap = mutation({
  args: { capCents: v.number() },
  handler: async (ctx, { capCents }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Sign in first.");
    if (!Number.isFinite(capCents) || capCents < 0) throw new Error("Invalid spend cap.");
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject))
      .first();
    if (!user) throw new Error("No account yet.");
    const ent = await ctx.db
      .query("api_entitlements")
      .withIndex("by_user", (q) => q.eq("owner_user_id", user._id))
      .first();
    if (!ent) throw new Error("No active plan to cap.");
    await ctx.db.patch(ent._id, { spend_cap_cents: Math.round(capCents), updated_at: Date.now() });
    return { ok: true as const };
  },
});

// ── Checkout / portal (actions — call Stripe) ────────────────────────────────

export const createCheckoutSession = action({
  args: { lookupKey: v.string(), successUrl: v.string(), cancelUrl: v.string() },
  handler: async (ctx, { lookupKey, successUrl, cancelUrl }): Promise<{ url: string | null }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Sign in first.");
    const userId: Id<"users"> = await ctx.runMutation(internal.devPortal._getOrCreateUserForIdentity, {
      clerkUserId: identity.subject,
      email: identity.email ?? undefined,
    });
    const customerId: string = await ctx.runAction(internal.payments_stripe._getOrCreateStripeCustomer, {
      userId,
    });

    const stripe = getStripe();
    const prices = await stripe.prices.list({
      lookup_keys: [lookupKey, "otofacts_enrich_overage"],
      active: true,
    });
    const tier = prices.data.find((p) => p.lookup_key === lookupKey);
    const overage = prices.data.find((p) => p.lookup_key === "otofacts_enrich_overage");
    if (!tier) throw new Error(`Unknown plan: ${lookupKey}`);

    const line_items = [
      { price: tier.id, quantity: 1 },
      ...(overage ? [{ price: overage.id }] : []),
    ];

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items,
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
      metadata: { app: "otofacts", clerk_user_id: identity.subject, convex_user_id: String(userId) },
      subscription_data: { metadata: { app: "otofacts", clerk_user_id: identity.subject } },
    });
    return { url: session.url };
  },
});

export const createPortalSession = action({
  args: { returnUrl: v.string() },
  handler: async (ctx, { returnUrl }): Promise<{ url: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Sign in first.");
    const user = await ctx.runQuery(internal.dataApiBilling._userByClerkId, {
      clerkUserId: identity.subject,
    });
    if (!user?.stripe_customer_id) throw new Error("No billing account yet — upgrade first.");
    const stripe = getStripe();
    const portal = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: returnUrl,
    });
    return { url: portal.url };
  },
});

export const _userByClerkId = internalQuery({
  args: { clerkUserId: v.string() },
  handler: async (ctx, { clerkUserId }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", clerkUserId))
      .first();
    if (!user) return null;
    return { _id: user._id, stripe_customer_id: user.stripe_customer_id ?? null };
  },
});

// ── Webhook-driven entitlement sync ──────────────────────────────────────────

export const syncSubscriptionFromStripe = internalAction({
  args: { subscriptionId: v.string() },
  handler: async (ctx, { subscriptionId }): Promise<void> => {
    const stripe = getStripe();
    const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["items.data.price"] });
    const parsed = entitlementFromSubscription(sub);
    if (!parsed) return; // not an Otofacts sub → ignore (shared-account guard)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = sub as any;
    const clerkUserId: string | undefined = s.metadata?.clerk_user_id ?? undefined;
    const customerId: string = typeof s.customer === "string" ? s.customer : s.customer?.id;
    await ctx.runMutation(internal.dataApiBilling.upsertEntitlement, {
      clerkUserId,
      stripeCustomerId: customerId,
      stripeSubscriptionId: s.id,
      status: s.status,
      plan: parsed.plan,
      scopes: parsed.scopes,
      rate_limit_per_min: parsed.rate_limit_per_min,
      monthly_read_quota: parsed.monthly_read_quota,
      enrich_monthly_grant: parsed.enrich_monthly_grant,
      metered_overage: parsed.metered_overage,
      lookup_key: parsed.lookup_key,
      period_start: parsed.period_start,
      period_end: parsed.period_end,
    });
  },
});

export const onInvoice = internalAction({
  args: { subscriptionId: v.string(), paid: v.boolean() },
  handler: async (ctx, { subscriptionId, paid }): Promise<void> => {
    if (paid) {
      // A paid invoice advances the period → syncSubscription resets credits.
      await ctx.runAction(internal.dataApiBilling.syncSubscriptionFromStripe, { subscriptionId });
    } else {
      await ctx.runMutation(internal.dataApiBilling.setSubscriptionStatus, {
        stripeSubscriptionId: subscriptionId,
        status: "past_due",
      });
    }
  },
});

export const setSubscriptionStatus = internalMutation({
  args: { stripeSubscriptionId: v.string(), status: v.string() },
  handler: async (ctx, { stripeSubscriptionId, status }) => {
    const ent = await ctx.db
      .query("api_entitlements")
      .withIndex("by_stripe_subscription", (q) => q.eq("stripe_subscription_id", stripeSubscriptionId))
      .first();
    if (ent) await ctx.db.patch(ent._id, { status, updated_at: Date.now() });
  },
});

export const upsertEntitlement = internalMutation({
  args: {
    clerkUserId: v.optional(v.string()),
    stripeCustomerId: v.string(),
    stripeSubscriptionId: v.string(),
    status: v.string(),
    plan: v.union(v.literal("free"), v.literal("pro"), v.literal("scale"), v.literal("enterprise")),
    scopes: v.array(
      v.union(
        v.literal("maintenance:read"),
        v.literal("labor:read"),
        v.literal("media:read"),
        v.literal("enrich:write"),
        v.literal("service_history:read"),
      ),
    ),
    rate_limit_per_min: v.number(),
    monthly_read_quota: v.number(),
    enrich_monthly_grant: v.number(),
    metered_overage: v.boolean(),
    lookup_key: v.optional(v.string()),
    period_start: v.number(),
    period_end: v.number(),
  },
  handler: async (ctx, a) => {
    // Resolve the billing subject.
    let ownerUserId: Id<"users"> | null = null;
    if (a.clerkUserId) {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", a.clerkUserId!))
        .first();
      ownerUserId = user?._id ?? (await ctx.db.insert("users", { clerkUserId: a.clerkUserId }));
    } else {
      const byCustomer = await ctx.db
        .query("api_entitlements")
        .withIndex("by_stripe_customer", (q) => q.eq("stripe_customer_id", a.stripeCustomerId))
        .first();
      ownerUserId = byCustomer?.owner_user_id ?? null;
    }
    if (!ownerUserId) {
      console.warn(`[dataApiBilling] upsertEntitlement: cannot map customer ${a.stripeCustomerId} to a user`);
      return;
    }

    // Keep users.stripe_customer_id populated (shared with booking payments).
    const user = await ctx.db.get(ownerUserId);
    if (user && !user.stripe_customer_id) {
      await ctx.db.patch(ownerUserId, { stripe_customer_id: a.stripeCustomerId });
    }

    const existing = await ctx.db
      .query("api_entitlements")
      .withIndex("by_user", (q) => q.eq("owner_user_id", ownerUserId!))
      .first();

    // Fresh period / first activation → reset included credits + overage.
    const freshPeriod =
      !existing ||
      existing.stripe_subscription_id !== a.stripeSubscriptionId ||
      (existing.current_period_start ?? 0) < a.period_start;

    const base = {
      owner_user_id: ownerUserId,
      plan: a.plan,
      status: a.status,
      scopes: a.scopes,
      rate_limit_per_min: a.rate_limit_per_min,
      monthly_read_quota: a.monthly_read_quota,
      enrich_monthly_grant: a.enrich_monthly_grant,
      metered_overage: a.metered_overage,
      stripe_customer_id: a.stripeCustomerId,
      stripe_subscription_id: a.stripeSubscriptionId,
      stripe_price_lookup_key: a.lookup_key,
      current_period_start: a.period_start,
      current_period_end: a.period_end,
      updated_at: Date.now(),
    };

    if (!existing) {
      const id = await ctx.db.insert("api_entitlements", {
        ...base,
        enrich_credits_remaining: a.enrich_monthly_grant,
        overage_spent_cents_this_period: 0,
        spend_cap_cents: undefined,
      });
      if (a.enrich_monthly_grant > 0) {
        await ctx.db.insert("enrich_ledger", {
          owner_user_id: ownerUserId,
          api_key_id: undefined,
          kind: "grant",
          credit_delta: a.enrich_monthly_grant,
          billable: false,
          settlement: "na",
          created_at: Date.now(),
        });
      }
      return id;
    }

    await ctx.db.patch(existing._id, {
      ...base,
      ...(freshPeriod
        ? { enrich_credits_remaining: a.enrich_monthly_grant, overage_spent_cents_this_period: 0 }
        : {}),
    });
    if (freshPeriod && a.enrich_monthly_grant > 0) {
      await ctx.db.insert("enrich_ledger", {
        owner_user_id: ownerUserId,
        api_key_id: undefined,
        kind: "grant",
        credit_delta: a.enrich_monthly_grant,
        billable: false,
        settlement: "na",
        created_at: Date.now(),
      });
    }
    return existing._id;
  },
});

// ── Enrich credit reserve / commit / refund ──────────────────────────────────

export const reserveEnrichCredit = internalMutation({
  args: { owner_user_id: v.id("users"), api_key_id: v.id("api_keys"), vin: v.optional(v.string()) },
  handler: async (
    ctx,
    a,
  ): Promise<
    | { status: "ok"; ledgerId: Id<"enrich_ledger">; creditsRemaining: number }
    | { status: "no_credits" }
    | { status: "cap_reached" }
  > => {
    const ent = await ctx.db
      .query("api_entitlements")
      .withIndex("by_user", (q) => q.eq("owner_user_id", a.owner_user_id))
      .first();
    if (!ent) return { status: "no_credits" };

    // Path 1: spend an included credit (atomic — mutations are serializable).
    if (ent.enrich_credits_remaining > 0) {
      await ctx.db.patch(ent._id, {
        enrich_credits_remaining: ent.enrich_credits_remaining - 1,
        updated_at: Date.now(),
      });
      const ledgerId = await ctx.db.insert("enrich_ledger", {
        owner_user_id: a.owner_user_id,
        api_key_id: a.api_key_id,
        vin: a.vin,
        stripe_customer_id: ent.stripe_customer_id,
        kind: "reserve",
        credit_delta: -1,
        billable: false,
        settlement: "pending",
        created_at: Date.now(),
      });
      return { status: "ok", ledgerId, creditsRemaining: ent.enrich_credits_remaining - 1 };
    }

    // Path 2: metered overage, if enabled and under the spend cap.
    if (ent.metered_overage) {
      const unit = ENRICH_OVERAGE_UNIT_CENTS;
      const projected = ent.overage_spent_cents_this_period + unit;
      if (ent.spend_cap_cents != null && projected > ent.spend_cap_cents) {
        return { status: "cap_reached" };
      }
      await ctx.db.patch(ent._id, { overage_spent_cents_this_period: projected, updated_at: Date.now() });
      const ledgerId = await ctx.db.insert("enrich_ledger", {
        owner_user_id: a.owner_user_id,
        api_key_id: a.api_key_id,
        vin: a.vin,
        stripe_customer_id: ent.stripe_customer_id,
        kind: "reserve",
        credit_delta: 0,
        billable: true,
        billed_cents: unit,
        settlement: "pending",
        created_at: Date.now(),
      });
      return { status: "ok", ledgerId, creditsRemaining: 0 };
    }

    return { status: "no_credits" };
  },
});

export const refundReservation = internalMutation({
  args: { ledgerId: v.id("enrich_ledger") },
  handler: async (ctx, { ledgerId }) => {
    const row = await ctx.db.get(ledgerId);
    if (!row || row.settlement !== "pending") return; // idempotent
    const ent = await ctx.db
      .query("api_entitlements")
      .withIndex("by_user", (q) => q.eq("owner_user_id", row.owner_user_id))
      .first();
    if (ent) {
      if (row.credit_delta === -1) {
        await ctx.db.patch(ent._id, {
          enrich_credits_remaining: ent.enrich_credits_remaining + 1,
          updated_at: Date.now(),
        });
      } else if (row.billable && row.billed_cents) {
        await ctx.db.patch(ent._id, {
          overage_spent_cents_this_period: Math.max(0, ent.overage_spent_cents_this_period - row.billed_cents),
          updated_at: Date.now(),
        });
      }
    }
    await ctx.db.patch(ledgerId, { settlement: "refunded", settled_at: Date.now() });
  },
});

export const commitReservation = internalMutation({
  args: { ledgerId: v.id("enrich_ledger"), meterEventId: v.optional(v.string()) },
  handler: async (ctx, { ledgerId, meterEventId }) => {
    const row = await ctx.db.get(ledgerId);
    if (!row || row.settlement !== "pending") return; // idempotent
    await ctx.db.patch(ledgerId, {
      settlement: "committed",
      settled_at: Date.now(),
      stripe_meter_event_id: meterEventId,
    });
  },
});

export const listPendingReservations = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, { limit }) => {
    const rows = await ctx.db
      .query("enrich_ledger")
      .withIndex("by_settlement", (q) => q.eq("settlement", "pending"))
      .take(limit);
    return rows.map((r) => ({
      _id: r._id,
      vin: r.vin ?? undefined,
      config_key: r.config_key ?? undefined,
      billable: r.billable,
      stripe_customer_id: r.stripe_customer_id ?? undefined,
      created_at: r.created_at,
    }));
  },
});

/** Cron (every 5 min): settle reserved enrich credits against run outcome.
 *  complete/verified → commit (+ report meter for overage); failed or timed
 *  out → refund. See crons.ts. */
export const reconcileEnrichLedger = internalAction({
  args: {},
  handler: async (ctx): Promise<{ committed: number; refunded: number; pending: number }> => {
    const pending = await ctx.runQuery(internal.dataApiBilling.listPendingReservations, { limit: 200 });
    let committed = 0;
    let refunded = 0;
    let stillPending = 0;
    for (const row of pending) {
      const st = await ctx.runQuery(internal.dataApi.getEnrichStatusByVin, {
        vin: row.vin,
        config_key: row.config_key,
      });
      const status = st?.enrichment_status ?? null;
      if (status === "complete" || status === "verified") {
        let meterEventId: string | undefined;
        if (row.billable && row.stripe_customer_id) {
          try {
            const stripe = getStripe();
            const evt = await stripe.billing.meterEvents.create({
              event_name: "otofacts.enrich",
              identifier: row._id, // idempotency — one meter event per ledger row
              payload: { value: "1", stripe_customer_id: row.stripe_customer_id },
            });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            meterEventId = (evt as any).identifier ?? row._id;
          } catch (e) {
            console.error(`[dataApiBilling] meter report failed for ${row._id}:`, e);
            continue; // leave pending; retry next tick
          }
        }
        await ctx.runMutation(internal.dataApiBilling.commitReservation, { ledgerId: row._id, meterEventId });
        committed++;
      } else if (status === "failed") {
        await ctx.runMutation(internal.dataApiBilling.refundReservation, { ledgerId: row._id });
        refunded++;
      } else if (Date.now() - row.created_at > ENRICH_RESERVE_TIMEOUT_MS) {
        await ctx.runMutation(internal.dataApiBilling.refundReservation, { ledgerId: row._id });
        refunded++;
      } else {
        stillPending++;
      }
    }
    return { committed, refunded, pending: stillPending };
  },
});
