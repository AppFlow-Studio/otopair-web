// =============================================================================
// Self-serve developer portal — backs the public /developers dashboard.
//
// External developers sign up with Clerk and mint their OWN Data-API key:
// no director session, no admin.manage, no out-of-band key handoff. Every
// function here is gated on ctx.auth (the Clerk identity) and touches only
// rows owned by that identity (api_keys.owner_user_id).
//
// Free-tier defaults, deliberately locked down: ONE live key per account
// (re-mint revokes the old one — same pattern as the directors' personal
// keys), the four read scopes, 60 req/min. enrich:write (POST /v0/enrich —
// costs a paid VDB decode + an Anthropic batch per run) is NOT on free keys;
// it's mintable only via the director createKey path. Paid tiers/billing
// ride the existing api_usage metering later (customer_data_product_plan §5.4).
// =============================================================================
import { v } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx, MutationCtx } from "./_generated/server";

const DEV_RATE_LIMIT_PER_MIN = 60;
const DAY = 24 * 60 * 60 * 1000;

/** Resolve the calling Clerk identity to a users row (null when signed out
 *  or the row hasn't been provisioned yet). */
async function currentUser(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject))
    .first();
}

// --- Authored return types (see dataOverview.ts header) -----------------------

export type DevKeyInfo = {
  id: string;
  prefix: string;
  scopes: string[];
  rate_limit_per_min: number;
  created_at: number;
  last_used_at: number | null;
  request_count: number;
  requests_24h: number;
} | null;

/** The caller's live dev key (prefix only — plaintext is shown exactly once
 *  at mint time and cannot be recovered). Null when signed out or keyless. */
export const myKey = query({
  args: {},
  handler: async (ctx): Promise<DevKeyInfo> => {
    const user = await currentUser(ctx);
    if (!user) return null;
    const keys = await ctx.db
      .query("api_keys")
      .withIndex("by_owner", (q) => q.eq("owner_user_id", user._id))
      .take(20);
    const live = keys.find((k) => k.revoked_at == null);
    if (!live) return null;
    const recent = await ctx.db
      .query("api_usage")
      .withIndex("by_key_and_time", (q) =>
        q.eq("api_key_id", live._id).gte("created_at", Date.now() - DAY),
      )
      .take(1000);
    return {
      id: String(live._id),
      prefix: live.prefix,
      scopes: live.scopes,
      rate_limit_per_min: live.rate_limit_per_min,
      created_at: live.created_at,
      last_used_at: live.last_used_at ?? null,
      request_count: live.request_count,
      requests_24h: recent.length,
    };
  },
});

export type DevUsageDay = { date: string; requests: number; errors: number };

/** Daily usage buckets for the caller's own key (30d). */
export const myUsageSeries = query({
  args: {},
  handler: async (ctx): Promise<DevUsageDay[]> => {
    const user = await currentUser(ctx);
    if (!user) return [];
    const keys = await ctx.db
      .query("api_keys")
      .withIndex("by_owner", (q) => q.eq("owner_user_id", user._id))
      .take(20);
    const live = keys.find((k) => k.revoked_at == null);
    if (!live) return [];
    const rows = await ctx.db
      .query("api_usage")
      .withIndex("by_key_and_time", (q) =>
        q.eq("api_key_id", live._id).gte("created_at", Date.now() - 30 * DAY),
      )
      .take(2000);
    const buckets = new Map<string, DevUsageDay>();
    for (const r of rows) {
      const date = new Date(r.created_at).toISOString().slice(0, 10);
      const b = buckets.get(date) ?? { date, requests: 0, errors: 0 };
      b.requests++;
      if (r.status >= 400) b.errors++;
      buckets.set(date, b);
    }
    return [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
  },
});

export type DevEnrichRun = {
  id: string;
  vin: string;
  status: "queued" | "enriching" | "complete" | "failed";
  config_key: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  fill_rate: number | null;
  error: string | null;
  queued_at: number;
  completed_at: number | null;
};

/** The caller's enrichment runs (most recent first), for the dashboard's live
 *  "Enrichment runs" card. Reactive — Convex re-runs it as the reconcile cron
 *  flips statuses, so active runs animate queued → enriching → complete with no
 *  client polling. Bounded to the last 25. */
export const myEnrichRuns = query({
  args: {},
  handler: async (ctx): Promise<DevEnrichRun[]> => {
    const user = await currentUser(ctx);
    if (!user) return [];
    const rows = await ctx.db
      .query("data_api_enrich_runs")
      .withIndex("by_owner", (q) => q.eq("owner_user_id", user._id))
      .order("desc")
      .take(25);
    return rows.map((r) => ({
      id: String(r._id),
      vin: r.vin,
      status: r.status,
      config_key: r.config_key ?? null,
      year: r.year ?? null,
      make: r.make ?? null,
      model: r.model ?? null,
      trim: r.trim ?? null,
      fill_rate: r.fill_rate ?? null,
      error: r.error ?? null,
      queued_at: r.queued_at,
      completed_at: r.completed_at ?? null,
    }));
  },
});

// --- Mint / revoke -------------------------------------------------------------

export const _getOrCreateUserForIdentity = internalMutation({
  args: { clerkUserId: v.string(), email: v.optional(v.string()) },
  handler: async (ctx, { clerkUserId, email }): Promise<Id<"users">> => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", clerkUserId))
      .first();
    if (existing) return existing._id;
    // Brand-new Clerk signup whose webhook-provisioned row hasn't landed yet
    // (or a dev-only account) — a minimal row is enough to own a key.
    return await ctx.db.insert("users", { clerkUserId, email });
  },
});

export const _insertDevKey = internalMutation({
  args: {
    key_hash: v.string(),
    prefix: v.string(),
    owner_user_id: v.id("users"),
    label: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"api_keys">> => {
    // One live key per account: re-mint revokes the prior one.
    const existing = await ctx.db
      .query("api_keys")
      .withIndex("by_owner", (q) => q.eq("owner_user_id", args.owner_user_id))
      .take(20);
    for (const k of existing) {
      if (k.revoked_at == null) await ctx.db.patch(k._id, { revoked_at: Date.now() });
    }
    return await ctx.db.insert("api_keys", {
      name: `dev: ${args.label}`,
      key_hash: args.key_hash,
      prefix: args.prefix,
      // enrich:write deliberately absent — see file header.
      scopes: ["maintenance:read", "labor:read", "media:read", "service_history:read"],
      rate_limit_per_min: DEV_RATE_LIMIT_PER_MIN,
      owner_user_id: args.owner_user_id,
      created_at: Date.now(),
      request_count: 0,
    });
  },
});

/** One-shot post-deploy backfill: append service_history:read to every LIVE
 *  self-serve dev key so existing developers get the new endpoint without
 *  rotating (re-minting) their key.
 *  Run once: npx convex run devPortal:backfillDevKeyScopes */
export const backfillDevKeyScopes = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ updated: number }> => {
    const keys = await ctx.db.query("api_keys").withIndex("by_created_at").take(1000);
    let updated = 0;
    for (const k of keys) {
      if (k.owner_user_id == null || k.revoked_at != null) continue;
      if (k.scopes.includes("service_history:read")) continue;
      await ctx.db.patch(k._id, { scopes: [...k.scopes, "service_history:read"] });
      updated++;
    }
    return { updated };
  },
});

/** Mint (or rotate) the caller's dev key. Returns the plaintext EXACTLY ONCE. */
export const mintKey = action({
  args: {},
  handler: async (ctx): Promise<{ key: string; prefix: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Sign in to mint an API key.");
    const userId = await ctx.runMutation(internal.devPortal._getOrCreateUserForIdentity, {
      clerkUserId: identity.subject,
      email: identity.email ?? undefined,
    });

    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    const key = `otp_live_${hex}`;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
    const key_hash = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    await ctx.runMutation(internal.devPortal._insertDevKey, {
      key_hash,
      prefix: key.slice(0, 12),
      owner_user_id: userId,
      label: identity.email ?? identity.subject.slice(0, 12),
    });
    return { key, prefix: key.slice(0, 12) };
  },
});

export const revokeMyKey = mutation({
  args: {},
  handler: async (ctx): Promise<{ ok: true }> => {
    const user = await currentUser(ctx);
    if (!user) throw new Error("Sign in first.");
    const keys = await ctx.db
      .query("api_keys")
      .withIndex("by_owner", (q) => q.eq("owner_user_id", user._id))
      .take(20);
    const live = keys.find((k) => k.revoked_at == null);
    if (!live) throw new Error("No live key to revoke.");
    await ctx.db.patch(live._id, { revoked_at: Date.now() });
    return { ok: true };
  },
});
