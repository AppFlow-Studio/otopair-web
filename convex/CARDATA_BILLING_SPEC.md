# Car Data API — Stripe billing & write-access spec

> Status: **DRAFT / proposal** (authored 2026-08-27). Not yet implemented.
> Scope: the Otopair backend changes that let the **Otofacts** developer portal
> sell paid tiers of the public Car Data API and gate the write endpoint
> (`POST /v0/enrich`) behind a subscription + enrich credits.
>
> Companion frontend work lives in the `Otofacts` repo (pure client — pricing
> page, plan card, upgrade/portal buttons). This doc is backend-only.

## 0. Decisions locked

| Decision | Choice |
|---|---|
| Enrich billing | **Included credits per tier + metered overage** with a user-set spend cap |
| Billing subject | **Per Clerk user** (`users` row). Orgs deferred. |
| Entitlement source of truth | A new `api_entitlements` row, resolved **live** on every API request — not a snapshot baked into the key |
| Stripe account | **Shared** with Otopair booking payments — every Otofacts object is namespaced `metadata.app = "otofacts"` and the webhook ignores anything else |

## 1. What already exists (do not rebuild)

The public API and its key system are live. The billing layer bolts on top.

| Concern | Where | Notes |
|---|---|---|
| Key table | `schema.ts` `api_keys` | `key_hash`, `prefix`, `scopes[]`, `rate_limit_per_min`, `owner_user_id?`, `created_by?`, `request_count`, `revoked_at?`. Indexes: `by_key_hash`, `by_owner`, `by_created_at`. |
| Per-request log | `schema.ts` `api_usage` | `api_key_id`, `endpoint`, `status`, `config_key?`, `created_at`. Indexes: `by_key_and_time`, `by_created_at`. |
| User identity | `schema.ts` `users` | `clerkUserId`, `email?`, **`stripe_customer_id?` already present**. |
| Request auth + gating | `http.ts` `withApiKey(ctx, req, endpoint, scope, handler)` (~L863) | Hashes bearer → `lookupKeyByHash` → scope check (403 `insufficient_scope`) → per-min rate limit via `countRecentUsage` (429 `rate_limited`) → runs handler → `recordUsage`. |
| Key lookup | `dataApi.ts` `lookupKeyByHash` / `KeyAuth` (L80) | Returns `{ keyId, name, scopes, rate_limit_per_min, revoked }`. **Does not currently return `owner_user_id` — we must add it.** |
| Scopes | `dataApi.ts` `API_SCOPES` + `scopeValidator` (L46) | `maintenance:read`, `labor:read`, `media:read`, `enrich:write`, `service_history:read`. |
| Enrich endpoint | `http.ts` `POST /v0/enrich` (L1150) | Cache-fresh short-circuit (free), "already enriching" short-circuit, then a **daily quota** (`ENRICH_DAILY_QUOTA = 5`, counted from `api_usage` 202 rows) before `dataApiEnrich.triggerEnrichForVin`. |
| Enrich cost basis | `schema.ts` `enrichment_runs` | `estimated_cost_usd`, `total_firecrawl_credits`, `total_tokens_*`, `status`, `completed_at`. **Real per-run cost — anchor credit price above this.** |
| Self-serve minting | `devPortal.ts` `mintKey` / `_insertDevKey` (L129) | Hardcodes the 4 read scopes, 60 rpm, one live key per user. `enrich:write` deliberately absent. |
| Stripe client | `lib/stripe.ts` `getStripe()` | Singleton, `apiVersion = Stripe.API_VERSION`. Reads `process.env.STRIPE_SECRET_KEY`. |
| Customer bootstrap | `payments_stripe.ts` `_getOrCreateStripeCustomer` (L567) → `_setUserStripeCustomerId` | Creates a Customer with `metadata.convexUserId`, writes `users.stripe_customer_id`. **Reuse verbatim.** |
| Webhook | `http.ts` `handleStripeWebhook` (L86), `constructStripeWebhookEvent` (L44) | Verifies against **both** `STRIPE_CONNECT_WEBHOOK_SECRET` and `STRIPE_WEBHOOK_SECRET`; long `if (event.type === …)` chain; unknown events fall through to `stripe_webhook_events.record` + 200 (L454). Routes `/stripe/webhook` + `/stripe/connect-webhook` both hit it. |
| Webhook idempotency | `stripe_webhook_events.record` | Dedupe by `event_id`. Reuse. |

**Key architectural consequence:** the existing webhook already no-ops unknown
event types safely, so adding subscription branches is additive and cannot break
booking payments — provided each new branch guards on `metadata.app === "otofacts"`.

## 2. Stripe dashboard setup (one-time, test then live)

All objects carry `metadata.app = "otofacts"`. Address prices by **`lookup_key`**,
never by raw price id (test/live ids differ).

```
Product  "Otofacts API — Pro"     metadata.app=otofacts
  Price  recurring monthly  lookup_key=otofacts_pro_monthly
         metadata: { app:otofacts, plan:pro,   scopes:"maintenance:read,labor:read,media:read,service_history:read,enrich:write",
                     rate_limit_per_min:"300",  monthly_read_quota:"250000", enrich_monthly_grant:"100" }
Product  "Otofacts API — Scale"   metadata.app=otofacts
  Price  recurring monthly  lookup_key=otofacts_scale_monthly
         metadata: { app:otofacts, plan:scale, scopes:"…,enrich:write",
                     rate_limit_per_min:"1000", monthly_read_quota:"2000000", enrich_monthly_grant:"1000" }
Product  "Otofacts Enrich (overage)"  metadata.app=otofacts
  Price  metered, per-unit, billed monthly  lookup_key=otofacts_enrich_overage
         recurring.usage_type=metered, linked Meter event_name="otofacts.enrich"
Meter    display_name "Otofacts enrich runs"  event_name="otofacts.enrich"
         default_aggregation=sum  value_settings.event_payload_key="value"
         customer_mapping.event_payload_key="stripe_customer_id"
```

**Why metadata-on-price:** the webhook reads plan entitlements straight off
`subscription.items[].price.metadata`. Changing a plan's limits is a dashboard
edit — no deploy. The `PLAN_FALLBACK` map in §4 is only a safety net for prices
missing metadata.

A paid subscription = one Stripe Subscription with **two items**: the flat tier
price (`otofacts_pro_monthly`) + the metered overage price
(`otofacts_enrich_overage`). Included credits are tracked by us (see §5), overage
is reported to the meter.

Env (already declared in Otofacts `.env.example`, must exist on the Convex
deployment too): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`. No new env needed.

## 3. Schema changes (`schema.ts`)

Two new tables. No change to `api_keys` / `api_usage` shape (we add a rollup
counter table rather than mutate the hot log).

```ts
// ── Otofacts Car Data API billing ──────────────────────────────────────────

// One row per billing subject (Clerk user). The LIVE source of truth for what a
// self-serve key may do. Absent row = free tier (see FREE_ENTITLEMENT in §4).
api_entitlements: defineTable({
  owner_user_id: v.id("users"),
  plan: v.union(
    v.literal("free"),
    v.literal("pro"),
    v.literal("scale"),
    v.literal("enterprise"),
  ),
  // Mirrors Stripe subscription.status; "active"|"trialing" are entitled.
  status: v.string(),
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
  // Included enrich runs this period + what a fresh period resets to.
  enrich_credits_remaining: v.number(),
  enrich_monthly_grant: v.number(),
  // Past included credits: allow metered pay-as-you-go up to the cap.
  metered_overage: v.boolean(),
  spend_cap_cents: v.optional(v.number()), // null = no cap (dangerous; UI defaults it)
  overage_spent_cents_this_period: v.number(),
  // Stripe linkage.
  stripe_customer_id: v.optional(v.string()),
  stripe_subscription_id: v.optional(v.string()),
  stripe_price_lookup_key: v.optional(v.string()),
  current_period_start: v.optional(v.number()),
  current_period_end: v.optional(v.number()),
  updated_at: v.number(),
})
  .index("by_user", ["owner_user_id"])
  .index("by_stripe_customer", ["stripe_customer_id"])
  .index("by_stripe_subscription", ["stripe_subscription_id"]),

// Auditable ledger of every enrich credit movement. Also the reserve→commit
// state machine that guarantees a failed enrich is never charged.
enrich_ledger: defineTable({
  owner_user_id: v.id("users"),
  api_key_id: v.id("api_keys"),
  vin: v.optional(v.string()),
  config_key: v.optional(v.string()),
  // Which enrichment_runs / vehicle this reservation is settling against.
  vehicle_config_id: v.optional(v.id("vehicle_configs")),
  kind: v.union(
    v.literal("reserve"),   // credit (or overage slot) held at POST time
    v.literal("commit"),    // enrich completed → consumption finalized
    v.literal("refund"),    // enrich failed/timed-out → reservation returned
    v.literal("grant"),     // monthly reset / manual grant
    v.literal("topup"),     // one-off credit pack purchase (future)
  ),
  // +N grant/refund, -N reserve/commit. Overage rows use billable=true, delta 0.
  credit_delta: v.number(),
  billable: v.boolean(),        // true → this run is metered overage, report to Stripe
  billed_cents: v.optional(v.number()),
  // Set on the reserve row; flipped when reconciled.
  settlement: v.union(
    v.literal("pending"),
    v.literal("committed"),
    v.literal("refunded"),
    v.literal("na"),           // grant/topup rows
  ),
  stripe_meter_event_id: v.optional(v.string()), // idempotency for meter reporting
  created_at: v.number(),
  settled_at: v.optional(v.number()),
})
  .index("by_user", ["owner_user_id"])
  .index("by_settlement", ["settlement"])
  .index("by_vehicle_config", ["vehicle_config_id"]),

// Monthly read-quota counter. api_usage is a per-request log — counting 2M rows
// with .take() does not scale, so quota reads a rolled-up counter instead.
api_usage_counters: defineTable({
  owner_user_id: v.id("users"),
  period_key: v.string(),      // "2026-08" (billing month) — cheap to derive, no cross-period scan
  read_requests: v.number(),
  enrich_scheduled: v.number(),
  updated_at: v.number(),
})
  .index("by_user_period", ["owner_user_id", "period_key"]),
```

> `users.stripe_customer_id` already exists and is shared with booking payments —
> **reuse it**, don't add a second customer field. A user has exactly one Stripe
> Customer; subscriptions and payment_intents are distinguished by object type +
> `metadata.app`, not by separate customers.

## 4. Plan → entitlement mapping (`dataApiBilling.ts`, new module)

```ts
// convex/dataApiBilling.ts
import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import { getStripe } from "../lib/stripe";

export const FREE_SCOPES = [
  "maintenance:read", "labor:read", "media:read", "service_history:read",
] as const;

export const FREE_ENTITLEMENT = {
  plan: "free" as const,
  status: "active",
  scopes: [...FREE_SCOPES],
  rate_limit_per_min: 60,
  monthly_read_quota: 10_000,
  enrich_credits_remaining: 0,
  enrich_monthly_grant: 0,
  metered_overage: false,
  overage_spent_cents_this_period: 0,
};

// Safety net only — real limits come from price.metadata. Keyed by lookup_key.
export const PLAN_FALLBACK: Record<string, {
  plan: "pro" | "scale"; scopes: string[]; rate_limit_per_min: number;
  monthly_read_quota: number; enrich_monthly_grant: number;
}> = {
  otofacts_pro_monthly: {
    plan: "pro",
    scopes: [...FREE_SCOPES, "enrich:write"],
    rate_limit_per_min: 300, monthly_read_quota: 250_000, enrich_monthly_grant: 100,
  },
  otofacts_scale_monthly: {
    plan: "scale",
    scopes: [...FREE_SCOPES, "enrich:write"],
    rate_limit_per_min: 1000, monthly_read_quota: 2_000_000, enrich_monthly_grant: 1000,
  },
};

// Parse a Stripe subscription's tier item into our entitlement shape. Prefers
// price.metadata; falls back to PLAN_FALLBACK[lookup_key].
export function entitlementFromSubscription(sub: any): {
  plan: string; scopes: string[]; rate_limit_per_min: number;
  monthly_read_quota: number; enrich_monthly_grant: number; metered_overage: boolean;
  lookup_key: string | undefined; period_start: number; period_end: number;
} | null {
  const items = sub.items?.data ?? [];
  const tierItem = items.find((it: any) => it.price?.recurring?.usage_type !== "metered");
  if (!tierItem) return null;
  const price = tierItem.price;
  if (price?.metadata?.app !== "otofacts") return null; // ← shared-account guard
  const md = price.metadata ?? {};
  const lookup_key = price.lookup_key ?? undefined;
  const fb = lookup_key ? PLAN_FALLBACK[lookup_key] : undefined;
  const csv = (s?: string) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined);
  const metered_overage = items.some(
    (it: any) => it.price?.recurring?.usage_type === "metered" && it.price?.metadata?.app === "otofacts",
  );
  return {
    plan: md.plan ?? fb?.plan ?? "pro",
    scopes: csv(md.scopes) ?? fb?.scopes ?? [...FREE_SCOPES, "enrich:write"],
    rate_limit_per_min: Number(md.rate_limit_per_min) || fb?.rate_limit_per_min || 300,
    monthly_read_quota: Number(md.monthly_read_quota) || fb?.monthly_read_quota || 250_000,
    enrich_monthly_grant: Number(md.enrich_monthly_grant) || fb?.enrich_monthly_grant || 100,
    metered_overage,
    lookup_key,
    period_start: (sub.current_period_start ?? 0) * 1000,
    period_end: (sub.current_period_end ?? 0) * 1000,
  };
}
```

### Effective entitlement resolver (the hot path)

```ts
// Live resolution used by withApiKey. Never throws — worst case returns free.
export const resolveEntitlement = internalQuery({
  args: { owner_user_id: v.optional(v.id("users")) },
  handler: async (ctx, { owner_user_id }) => {
    if (!owner_user_id) return FREE_ENTITLEMENT;
    const ent = await ctx.db
      .query("api_entitlements")
      .withIndex("by_user", (q) => q.eq("owner_user_id", owner_user_id))
      .first();
    if (!ent) return FREE_ENTITLEMENT;
    // A canceled/past-due sub (after grace) collapses to free.
    const entitled = ent.status === "active" || ent.status === "trialing";
    if (!entitled) return { ...FREE_ENTITLEMENT };
    return {
      plan: ent.plan, status: ent.status, scopes: ent.scopes,
      rate_limit_per_min: ent.rate_limit_per_min,
      monthly_read_quota: ent.monthly_read_quota,
      enrich_credits_remaining: ent.enrich_credits_remaining,
      enrich_monthly_grant: ent.enrich_monthly_grant,
      metered_overage: ent.metered_overage,
      spend_cap_cents: ent.spend_cap_cents,
      overage_spent_cents_this_period: ent.overage_spent_cents_this_period,
    };
  },
});
```

## 5. Request-path changes

### 5.1 `dataApi.ts` — carry owner + created_by through auth

`KeyAuth` must expose who owns the key so `withApiKey` can resolve entitlement,
and whether it's a director-minted internal key (which bypass entitlement).

```ts
// dataApi.ts — KeyAuth (L72) gains two fields
export type KeyAuth = {
  keyId: Id<"api_keys">;
  name: string;
  scopes: string[];                 // still returned; used only for internal keys
  rate_limit_per_min: number;
  revoked: boolean;
  ownerUserId: Id<"users"> | null;  // ← NEW
  isInternal: boolean;              // ← NEW (created_by != null)
};

// lookupKeyByHash (L80) — add to the returned object:
//   ownerUserId: key.owner_user_id ?? null,
//   isInternal: key.created_by != null,
```

Add a monthly read-quota counter mutation + a period-count query (backs quota
without scanning `api_usage`):

```ts
export const bumpUsageCounter = internalMutation({
  args: { owner_user_id: v.id("users"), period_key: v.string(), read: v.number(), enrich: v.number() },
  handler: async (ctx, a) => {
    const row = await ctx.db.query("api_usage_counters")
      .withIndex("by_user_period", (q) => q.eq("owner_user_id", a.owner_user_id).eq("period_key", a.period_key))
      .first();
    if (!row) {
      await ctx.db.insert("api_usage_counters", {
        owner_user_id: a.owner_user_id, period_key: a.period_key,
        read_requests: a.read, enrich_scheduled: a.enrich, updated_at: Date.now(),
      });
    } else {
      await ctx.db.patch(row._id, {
        read_requests: row.read_requests + a.read,
        enrich_scheduled: row.enrich_scheduled + a.enrich,
        updated_at: Date.now(),
      });
    }
  },
});

export const readCountThisPeriod = internalQuery({
  args: { owner_user_id: v.id("users"), period_key: v.string() },
  handler: async (ctx, { owner_user_id, period_key }) => {
    const row = await ctx.db.query("api_usage_counters")
      .withIndex("by_user_period", (q) => q.eq("owner_user_id", owner_user_id).eq("period_key", period_key))
      .first();
    return row?.read_requests ?? 0;
  },
});
```

### 5.2 `http.ts` — `withApiKey` resolves entitlement live

Replace the parts of `withApiKey` that read `key.scopes` / `key.rate_limit_per_min`
with entitlement-derived values. **Internal (director) keys keep their explicit
scopes** and skip entitlement + quota entirely — they're trusted.

```ts
// inside withApiKey, after lookupKeyByHash returns `key` (KeyAuth) and revoked check:

let effScopes = key.scopes;
let effRate = key.rate_limit_per_min;
let ent: any = null;

if (!key.isInternal) {
  ent = await ctx.runQuery(internal.dataApiBilling.resolveEntitlement, {
    owner_user_id: key.ownerUserId ?? undefined,
  });
  effScopes = ent.scopes;
  effRate = ent.rate_limit_per_min;
}

// scope check now uses effScopes
if (!effScopes.includes(scope)) {
  await ctx.runMutation(internal.dataApi.recordUsage, { api_key_id: key.keyId, endpoint, status: 403 });
  return apiJson(403, {
    error: "insufficient_scope",
    message: `This key lacks the '${scope}' scope.`,
    // NEW: turn the 403 into a conversion surface
    upgrade_url: scope === "enrich:write" ? "https://otofacts.com/pricing" : undefined,
  });
}

// per-minute rate limit uses effRate (unchanged mechanism, countRecentUsage)
// … existing 429 block, but compare against effRate …

// NEW: monthly read quota (skip for internal keys and for the write endpoint,
// which is metered by credits not reads)
if (!key.isInternal && key.ownerUserId && scope !== "enrich:write") {
  const periodKey = billingPeriodKey(Date.now());       // "YYYY-MM" — helper below
  const used = await ctx.runQuery(internal.dataApi.readCountThisPeriod, {
    owner_user_id: key.ownerUserId, period_key: periodKey,
  });
  if (used >= ent.monthly_read_quota) {
    await ctx.runMutation(internal.dataApi.recordUsage, { api_key_id: key.keyId, endpoint, status: 429 });
    return apiJson(429, {
      error: "quota_exceeded",
      message: `Monthly request quota (${ent.monthly_read_quota}) reached. Upgrade at otofacts.com/pricing.`,
    });
  }
}
```

After a successful non-enrich call, also bump the read counter (once), next to the
existing `recordUsage` call:

```ts
if (!key.isInternal && key.ownerUserId && scope !== "enrich:write" && result.status < 400) {
  await ctx.runMutation(internal.dataApi.bumpUsageCounter, {
    owner_user_id: key.ownerUserId, period_key: billingPeriodKey(Date.now()), read: 1, enrich: 0,
  });
}
```

> `billingPeriodKey(ms)` returns `"YYYY-MM"` from the entitlement's
> `current_period_start` if you want quotas to track the true Stripe billing
> anchor; a plain calendar month is fine for v1 and simpler. Document the choice.

### 5.3 `http.ts` — the enrich gate (`POST /v0/enrich`, L1150)

Keep the existing **cache-fresh** and **already-enriching** short-circuits (they
stay free and must run *before* any credit check). Replace the `ENRICH_DAILY_QUOTA`
block with the reserve step, and add commit/refund via the reconciler (§6).

```ts
// … after the `fresh` short-circuit (200, free) and the `enriching` short-circuit …

// enrich:write scope was already enforced by withApiKey. Now spend a credit.
const reserve = await ctx.runMutation(internal.dataApiBilling.reserveEnrichCredit, {
  owner_user_id: key.ownerUserId!,   // enrich:write is never on a keyless/internal path in practice
  api_key_id: key.keyId,
  vin,
});
if (reserve.status === "no_credits") {
  return { status: 402, body: {
    error: "no_enrich_credits",
    message: "Out of enrich credits and metered overage is off (or the spend cap is reached).",
    topup_url: "https://otofacts.com/dashboard/billing",
  }};
}
if (reserve.status === "cap_reached") {
  return { status: 402, body: {
    error: "spend_cap_reached",
    message: "Monthly enrich spend cap reached. Raise it in the dashboard to continue.",
  }};
}

// A hard safety cap survives even for paid keys (runaway/abuse backstop).
const scheduledToday = await ctx.runQuery(internal.dataApi.countUsageForEndpointSince, {
  api_key_id: key.keyId, endpoint: "/v0/enrich", since: Date.now() - 24 * 60 * 60 * 1000, status: 202,
});
if (scheduledToday >= ENRICH_HARD_DAILY_CAP) {           // e.g. 500 — see §9
  await ctx.runMutation(internal.dataApiBilling.refundReservation, { ledgerId: reserve.ledgerId });
  return { status: 429, body: { error: "daily_cap", message: "Daily enrich safety cap reached; contact support to raise it." } };
}

const result = await ctx.runAction(internal.dataApiEnrich.triggerEnrichForVin, { vin });

// Any non-scheduled outcome = refund the reservation immediately (never charge
// for a decode failure / unsupported vehicle / upsert failure).
if (result.status !== "scheduled") {
  await ctx.runMutation(internal.dataApiBilling.refundReservation, { ledgerId: reserve.ledgerId });
  // … return the existing 400/422/500 bodies unchanged …
}

// Link the reservation to the run target so the reconciler can settle it.
await ctx.runMutation(internal.dataApiBilling.attachReservationTarget, {
  ledgerId: reserve.ledgerId, vin,
});
return { status: 202, body: { /* existing queued body */ credits_remaining: reserve.creditsRemaining } };
```

`reserveEnrichCredit` (atomic — Convex mutations are serializable, so the
check-and-decrement cannot race):

```ts
export const reserveEnrichCredit = internalMutation({
  args: { owner_user_id: v.id("users"), api_key_id: v.id("api_keys"), vin: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const ent = await ctx.db.query("api_entitlements")
      .withIndex("by_user", (q) => q.eq("owner_user_id", a.owner_user_id)).first();
    if (!ent) return { status: "no_credits" as const };

    // Path 1: spend an included credit.
    if (ent.enrich_credits_remaining > 0) {
      await ctx.db.patch(ent._id, { enrich_credits_remaining: ent.enrich_credits_remaining - 1, updated_at: Date.now() });
      const ledgerId = await ctx.db.insert("enrich_ledger", {
        owner_user_id: a.owner_user_id, api_key_id: a.api_key_id, vin: a.vin,
        kind: "reserve", credit_delta: -1, billable: false, settlement: "pending", created_at: Date.now(),
      });
      return { status: "ok" as const, ledgerId, creditsRemaining: ent.enrich_credits_remaining - 1 };
    }

    // Path 2: metered overage, if enabled and under the spend cap.
    if (ent.metered_overage) {
      const unit = ENRICH_OVERAGE_UNIT_CENTS;                 // e.g. 25
      const projected = ent.overage_spent_cents_this_period + unit;
      if (ent.spend_cap_cents != null && projected > ent.spend_cap_cents) {
        return { status: "cap_reached" as const };
      }
      await ctx.db.patch(ent._id, { overage_spent_cents_this_period: projected, updated_at: Date.now() });
      const ledgerId = await ctx.db.insert("enrich_ledger", {
        owner_user_id: a.owner_user_id, api_key_id: a.api_key_id, vin: a.vin,
        kind: "reserve", credit_delta: 0, billable: true, billed_cents: unit,
        settlement: "pending", created_at: Date.now(),
      });
      return { status: "ok" as const, ledgerId, creditsRemaining: 0 };
    }

    return { status: "no_credits" as const };
  },
});
```

`refundReservation` reverses whichever path was taken (credit or overage) and
marks the ledger row `refunded`. `attachReservationTarget` stores the vin/config
so §6 can find it.

## 6. Settlement reconciler (`crons.ts` + `dataApiBilling.ts`)

The enrich pipeline (`vehicleEnrichment.v3pipeline`) is shared with the consumer
flow and must **not** learn about API credits. So settlement is a poller, not a
pipeline hook — matching the existing `crons.ts` style.

```ts
// runs every 5 min
export const reconcileEnrichLedger = internalAction({
  args: {},
  handler: async (ctx) => {
    const pending = await ctx.runQuery(internal.dataApiBilling.listPendingReservations, { limit: 200 });
    for (const row of pending) {
      const st = await ctx.runQuery(internal.dataApi.getEnrichStatusByVin, { vin: row.vin, config_key: row.config_key });
      const status = st?.enrichment_status;
      if (status === "complete" || status === "verified") {
        // Commit. If billable overage → report to Stripe meter (idempotent).
        if (row.billable) {
          const stripe = getStripe();
          const evt = await stripe.billing.meterEvents.create({
            event_name: "otofacts.enrich",
            identifier: row._id,                              // idempotency
            payload: { value: "1", stripe_customer_id: row.stripe_customer_id },
          });
          await ctx.runMutation(internal.dataApiBilling.commitReservation, { ledgerId: row._id, meterEventId: evt.identifier });
        } else {
          await ctx.runMutation(internal.dataApiBilling.commitReservation, { ledgerId: row._id });
        }
      } else if (status === "failed") {
        await ctx.runMutation(internal.dataApiBilling.refundReservation, { ledgerId: row._id });
      } else if (Date.now() - row.created_at > ENRICH_RESERVE_TIMEOUT_MS) {  // e.g. 2h
        await ctx.runMutation(internal.dataApiBilling.refundReservation, { ledgerId: row._id }); // stuck run → refund
      }
      // else still enriching — leave pending
    }
  },
});
```

Register in `crons.ts`:

```ts
crons.interval("otofacts enrich reconcile", { minutes: 5 }, internal.dataApiBilling.reconcileEnrichLedger, {});
```

**Design note (accept or reject):** this is the "never charge for a failed
enrich" model the pricing decision implies. If you'd rather charge at schedule
time (simpler, no reconciler), drop §6 and mark the reserve row `committed`
immediately — but then a decode/pipeline failure costs the caller a credit.
Recommend keeping the reconciler; the enrich cost you're protecting is real
(`enrichment_runs.estimated_cost_usd`).

## 7. Webhook extension (`http.ts` `handleStripeWebhook`)

Add three branches to the existing `if (event.type === …)` chain, **before** the
L454 fallthrough. Every branch guards on Otofacts ownership and then delegates to
`dataApiBilling` internal mutations. Nothing here touches booking payments.

```ts
if (event.type === "checkout.session.completed") {
  const s = event.data.object as Stripe.CheckoutSession;
  if (s.metadata?.app === "otofacts" && s.mode === "subscription") {
    await ctx.runAction(internal.dataApiBilling.syncSubscriptionFromStripe, {
      subscriptionId: typeof s.subscription === "string" ? s.subscription : s.subscription!.id,
    });
  }
  await ctx.runMutation(internal.stripe_webhook_events.record, { eventId: event.id, eventType: event.type, livemode: event.livemode });
  return new Response("ok", { status: 200 });
}

if (
  event.type === "customer.subscription.created" ||
  event.type === "customer.subscription.updated" ||
  event.type === "customer.subscription.deleted"
) {
  const sub = event.data.object as Stripe.Subscription;
  // syncSubscriptionFromStripe re-reads the sub, applies the app=otofacts guard
  // (via entitlementFromSubscription → null for non-otofacts), and upserts/clears
  // the entitlement. Non-otofacts subs become a safe no-op.
  await ctx.runAction(internal.dataApiBilling.syncSubscriptionFromStripe, { subscriptionId: sub.id });
  await ctx.runMutation(internal.stripe_webhook_events.record, { eventId: event.id, eventType: event.type, livemode: event.livemode });
  return new Response("ok", { status: 200 });
}

if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
  const inv = event.data.object as Stripe.Invoice;
  const subId = typeof inv.subscription === "string" ? inv.subscription : inv.subscription?.id;
  if (subId) {
    await ctx.runAction(internal.dataApiBilling.onInvoice, {
      subscriptionId: subId, paid: event.type === "invoice.paid",
    });
  }
  await ctx.runMutation(internal.stripe_webhook_events.record, { eventId: event.id, eventType: event.type, livemode: event.livemode });
  return new Response("ok", { status: 200 });
}
```

`syncSubscriptionFromStripe` (internalAction — needs the Stripe SDK to expand the
sub, then writes via a mutation):

```ts
export const syncSubscriptionFromStripe = internalAction({
  args: { subscriptionId: v.string() },
  handler: async (ctx, { subscriptionId }) => {
    const stripe = getStripe();
    const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["items.data.price"] });
    const parsed = entitlementFromSubscription(sub);
    if (!parsed) return; // not an Otofacts sub → ignore (shared-account guard)
    const clerkUserId = (sub.metadata?.clerk_user_id as string) ?? undefined;
    const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
    await ctx.runMutation(internal.dataApiBilling.upsertEntitlement, {
      clerkUserId, stripeCustomerId: customerId, stripeSubscriptionId: sub.id,
      status: sub.status, ...parsed,
    });
  },
});
```

`upsertEntitlement` resolves `owner_user_id` (by `clerk_user_id` metadata, else by
`stripe_customer_id` → `users`), writes the `api_entitlements` row, and — on a
**new period or first activation** — inserts a `grant` ledger row and sets
`enrich_credits_remaining = enrich_monthly_grant`, `overage_spent_cents_this_period = 0`.
`onInvoice({paid:true})` triggers the monthly credit reset; `{paid:false}` sets
`status = "past_due"` (grace) — the resolver already collapses non-active to free.

`customer.subscription.deleted` → `upsertEntitlement` with `status:"canceled"`,
which the resolver treats as free. Optionally hard-delete the row.

## 8. Checkout / portal / entitlement read (`dataApiBilling.ts`)

Public actions the Otofacts client calls by string reference (like it already
calls `devPortal.mintKey`):

```ts
export const createCheckoutSession = action({
  args: { lookupKey: v.string(), successUrl: v.string(), cancelUrl: v.string() },
  handler: async (ctx, { lookupKey, successUrl, cancelUrl }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Sign in first.");
    const userId = await ctx.runMutation(internal.devPortal._getOrCreateUserForIdentity, {
      clerkUserId: identity.subject, email: identity.email ?? undefined,
    });
    const customerId = await ctx.runAction(internal.payments_stripe._getOrCreateStripeCustomer, { userId });

    const stripe = getStripe();
    const prices = await stripe.prices.list({ lookup_keys: [lookupKey, "otofacts_enrich_overage"], active: true });
    const tier = prices.data.find((p) => p.lookup_key === lookupKey);
    const overage = prices.data.find((p) => p.lookup_key === "otofacts_enrich_overage");
    if (!tier) throw new Error(`Unknown plan: ${lookupKey}`);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [
        { price: tier.id, quantity: 1 },
        ...(overage ? [{ price: overage.id }] : []),   // metered item, no quantity
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { app: "otofacts", clerk_user_id: identity.subject, convex_user_id: String(userId) },
      subscription_data: { metadata: { app: "otofacts", clerk_user_id: identity.subject } },
    });
    return { url: session.url };
  },
});

export const createPortalSession = action({
  args: { returnUrl: v.string() },
  handler: async (ctx, { returnUrl }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Sign in first.");
    const user = await ctx.runQuery(internal.dataApiBilling._userByClerkId, { clerkUserId: identity.subject });
    if (!user?.stripe_customer_id) throw new Error("No billing account yet.");
    const stripe = getStripe();
    const portal = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id, return_url: returnUrl,
    });
    return { url: portal.url };
  },
});

// Powers the dashboard plan card (plan, credits, quota usage, spend cap).
export const myEntitlement = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const user = await ctx.db.query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject)).first();
    if (!user) return { plan: "free", ...FREE_ENTITLEMENT };
    const ent = await ctx.db.query("api_entitlements")
      .withIndex("by_user", (q) => q.eq("owner_user_id", user._id)).first();
    // + join api_usage_counters for read usage this period
    return ent ?? { plan: "free", ...FREE_ENTITLEMENT };
  },
});

export const setSpendCap = action({ /* args: capCents; patch entitlement */ });
```

`_getOrCreateStripeCustomer` (payments_stripe L567) is reused **verbatim** — it
already sets `users.stripe_customer_id`. No second customer path.

## 9. Constants

```ts
// dataApiBilling.ts
export const ENRICH_OVERAGE_UNIT_CENTS = 25;      // price ABOVE enrichment_runs.estimated_cost_usd
export const ENRICH_RESERVE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const ENRICH_HARD_DAILY_CAP = 500;         // abuse backstop, all plans
// dataApi.ts — ENRICH_DAILY_QUOTA (=5) stays as the FREE-only ceiling if you keep
// a trial of enrich on free; otherwise remove now that credits gate paid usage.
```

Set `ENRICH_OVERAGE_UNIT_CENTS` from real data: query the median
`enrichment_runs.estimated_cost_usd` over a recent window × your margin. That
column is the ground truth for what a run costs you.

## 10. `devPortal.ts` touch-ups

- `_insertDevKey` (L129) — no longer needs to encode entitlement scopes, since
  `withApiKey` resolves them live. Keep writing the 4 read scopes as a harmless
  default/cache. **Do not add `enrich:write` here** — it comes from entitlement.
- `myKey` (L51) — optionally join `api_entitlements` so the dashboard shows the
  *effective* scopes/rate limit (what the key can actually do today), not the
  frozen mint-time list. Or let the Otofacts client call `myEntitlement`
  separately (cleaner separation; recommended).
- Mint no longer needs a plan check — a free user mints a read-only-effective key;
  upgrading flips entitlement and the same key gains `enrich:write` instantly.

## 11. Rollout order

1. **Schema** — add `api_entitlements`, `enrich_ledger`, `api_usage_counters`. Deploy (additive, safe).
2. **Stripe** — create products/prices/meter in **test mode** with metadata + lookup_keys.
3. **`dataApiBilling.ts`** — mapping, resolver, reserve/commit/refund, checkout/portal/myEntitlement, reconciler.
4. **`dataApi.ts`** — extend `KeyAuth` + `lookupKeyByHash`; add counter query/mutation.
5. **`http.ts`** — `withApiKey` live entitlement + read quota; enrich gate; three webhook branches.
6. **`crons.ts`** — register `reconcileEnrichLedger`.
7. **Backfill** — one internal mutation: for every `users` row with a live
   self-serve key but no entitlement, insert a `free` `api_entitlements` row
   (optional — resolver already defaults to free, so this is cosmetic).
8. **Otofacts frontend** — pricing page, plan card (`myEntitlement`), upgrade
   (`createCheckoutSession`) / manage (`createPortalSession`) buttons,
   `/billing/success` + `/billing/cancel` routes, spend-cap control.
9. **Flip live** — create live-mode Stripe objects, point the live webhook at
   `/stripe/webhook`, set live env on the Convex deployment.

## 12. Testing

- **Webhook guard:** replay an Otopair booking `payment_intent.succeeded` and a
  non-otofacts subscription event — assert **zero** writes to `api_entitlements`.
- **Upgrade→instant unlock:** free key 403s on `POST /v0/enrich`; complete
  Checkout (test card `4242…`); without re-minting, the **same key** now 202s.
- **Credit lifecycle:** exhaust included credits → 402 `no_enrich_credits` with
  overage off; enable overage → 202 + a `billable` ledger row → reconciler reports
  one `otofacts.enrich` meter event; verify the invoice line.
- **Never-charge-on-failure:** enrich a bogus VIN → reservation refunded, credits
  unchanged, no meter event.
- **Idempotency:** deliver the same subscription event twice → one entitlement
  state, deduped via `stripe_webhook_events`. Run the reconciler twice over one
  completed run → one meter event (identifier = ledger id).
- **Spend cap:** set cap below unit price → 402 `spend_cap_reached`.
- **Downgrade/dunning:** `invoice.payment_failed` → `past_due` → resolver serves
  free → `enrich:write` 403s again after grace.
- **Read quota:** drive `api_usage_counters` past `monthly_read_quota` → 429
  `quota_exceeded` on reads while enrich (credit-gated) still works.

## 13. Open questions

1. **Quota period** — calendar month (simple) vs Stripe billing anchor
   (`current_period_start`, accurate). Recommend anchor; needs `billingPeriodKey`
   to read the entitlement's period.
2. **Free-tier enrich trial** — keep a tiny `ENRICH_DAILY_QUOTA` taste on free
   (drives conversion) or make enrich strictly paid? Currently free keys lack the
   scope entirely, so "strictly paid" is the zero-work default.
3. **Overage unit price** — pending a query over `enrichment_runs.estimated_cost_usd`.
4. **Credit packs (`topup`)** — ledger + Stripe one-time price are stubbed for a
   future PR; not needed for v1 (included + metered covers it).
5. **Orgs** — billing subject is per-user now; moving to Clerk orgs later means
   re-keying `api_entitlements`/`enrich_ledger` on an `org_id`. Keep the resolver
   as the single indirection point so that migration is contained.
</content>
</invoke>
