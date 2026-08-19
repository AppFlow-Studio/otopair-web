/**
 * convex/directorIntegrations.ts — the company's third-party service registry.
 *
 * A small, director-managed list of the SaaS tools we pay for (Convex, Slack,
 * Firecrawl, Anthropic, Fly.io, Reducto, Stripe, App Store Connect, Google
 * Play, …). It exists so there's one place that answers "what do we use, whose
 * account is it under, where do I go to manage it, and what does it cost us a
 * month". Not wired into any billing logic — pure bookkeeping.
 *
 * Every write is audit-logged (entity_type "director_integration") just like
 * the rest of the director surface.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const billingType = v.union(
  v.literal("subscription"),
  v.literal("pay_as_you_go"),
  v.literal("free"),
);

// Prepend https:// when the user pastes a bare host ("dashboard.convex.dev").
function normalizeUrl(raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  if (/^https?:\/\//i.test(t)) return t;
  return `https://${t}`;
}

// Non-negative dollars, rounded to the cent; anything invalid → undefined.
function cleanCost(n: number | undefined): number | undefined {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 100) / 100;
}

async function logAudit(
  ctx: any,
  id: string,
  action: string,
  detail: string,
  actorName?: string,
  actorId?: any,
) {
  await ctx.db.insert("audit_log", {
    entity_type: "director_integration",
    entity_id: id,
    action,
    actor: actorName ?? "Director",
    actor_id: actorId,
    detail,
    created_at: Date.now(),
  });
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("director_integrations")
      .withIndex("by_created_at")
      .collect();
    return rows
      .filter((r) => !r.archived)
      .sort(
        (a, b) =>
          (a.sort_order ?? Number.MAX_SAFE_INTEGER) -
            (b.sort_order ?? Number.MAX_SAFE_INTEGER) ||
          a.created_at - b.created_at,
      );
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    url: v.string(),
    logo_url: v.optional(v.string()),
    category: v.optional(v.string()),
    account: v.optional(v.string()),
    notes: v.optional(v.string()),
    billing_type: billingType,
    monthly_cost: v.optional(v.number()),
    actorName: v.optional(v.string()),
    actorId: v.optional(v.id("director_users")),
  },
  handler: async (ctx, args) => {
    const name = args.name.trim();
    if (!name) throw new Error("Name is required.");
    const now = Date.now();
    const id = await ctx.db.insert("director_integrations", {
      name,
      url: normalizeUrl(args.url),
      logo_url: args.logo_url?.trim() || undefined,
      category: args.category?.trim() || undefined,
      account: args.account?.trim() || undefined,
      notes: args.notes?.trim() || undefined,
      billing_type: args.billing_type,
      monthly_cost: cleanCost(args.monthly_cost),
      created_at: now,
      updated_at: now,
      updated_by_user_id: args.actorId,
    });
    await logAudit(ctx, id, "shop_created", `Added service “${name}”`, args.actorName, args.actorId);
    return id;
  },
});

export const update = mutation({
  args: {
    id: v.id("director_integrations"),
    name: v.optional(v.string()),
    url: v.optional(v.string()),
    logo_url: v.optional(v.string()),
    category: v.optional(v.string()),
    account: v.optional(v.string()),
    notes: v.optional(v.string()),
    billing_type: v.optional(billingType),
    monthly_cost: v.optional(v.number()),
    // Sentinel to clear monthly_cost (undefined arg = "leave unchanged").
    clear_monthly_cost: v.optional(v.boolean()),
    actorName: v.optional(v.string()),
    actorId: v.optional(v.id("director_users")),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Service not found.");

    const patch: Record<string, unknown> = {
      updated_at: Date.now(),
      updated_by_user_id: args.actorId,
    };
    if (args.name !== undefined) {
      const n = args.name.trim();
      if (!n) throw new Error("Name cannot be empty.");
      patch.name = n;
    }
    if (args.url !== undefined) patch.url = normalizeUrl(args.url);
    if (args.logo_url !== undefined) patch.logo_url = args.logo_url.trim() || undefined;
    if (args.category !== undefined) patch.category = args.category.trim() || undefined;
    if (args.account !== undefined) patch.account = args.account.trim() || undefined;
    if (args.notes !== undefined) patch.notes = args.notes.trim() || undefined;
    if (args.billing_type !== undefined) patch.billing_type = args.billing_type;
    if (args.clear_monthly_cost) patch.monthly_cost = undefined;
    else if (args.monthly_cost !== undefined) patch.monthly_cost = cleanCost(args.monthly_cost);

    await ctx.db.patch(args.id, patch);
    await logAudit(
      ctx,
      args.id,
      "field_edit",
      `Edited service “${(patch.name as string) ?? existing.name}”`,
      args.actorName,
      args.actorId,
    );
    return { ok: true };
  },
});

export const remove = mutation({
  args: {
    id: v.id("director_integrations"),
    actorName: v.optional(v.string()),
    actorId: v.optional(v.id("director_users")),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) return { ok: true };
    await ctx.db.delete(args.id);
    await logAudit(
      ctx,
      args.id,
      "field_edit",
      `Removed service “${existing.name}”`,
      args.actorName,
      args.actorId,
    );
    return { ok: true };
  },
});

// One-click starter set — the tools we already know we use. Idempotent: only
// inserts a service whose name isn't already present, so it's safe to press
// again after adding some by hand.
const STARTER_SERVICES: Array<{
  name: string;
  url: string;
  category: string;
  billing_type: "subscription" | "pay_as_you_go" | "free";
  account?: string;
  notes?: string;
}> = [
  { name: "Convex", url: "https://dashboard.convex.dev", category: "Backend", billing_type: "pay_as_you_go" },
  { name: "Slack", url: "https://slack.com", category: "Communication", billing_type: "subscription" },
  { name: "Firecrawl", url: "https://www.firecrawl.dev/app", category: "Data / Scraping", billing_type: "pay_as_you_go" },
  { name: "Anthropic (Claude Code API)", url: "https://console.anthropic.com", category: "AI", billing_type: "pay_as_you_go", notes: "Claude Code / API usage dashboard" },
  { name: "Fly.io", url: "https://fly.io/dashboard", category: "Infrastructure", billing_type: "pay_as_you_go" },
  { name: "Reducto", url: "https://app.reducto.ai", category: "AI / Documents", billing_type: "pay_as_you_go", notes: "Billed per page — see devOnly/reductoUsage" },
  { name: "Stripe", url: "https://dashboard.stripe.com", category: "Payments", billing_type: "pay_as_you_go", notes: "Per-transaction processing fees" },
  { name: "App Store Connect", url: "https://appstoreconnect.apple.com", category: "Distribution", billing_type: "subscription", notes: "$99/year Apple Developer Program" },
  { name: "Google Play Console", url: "https://play.google.com/console", category: "Distribution", billing_type: "free", notes: "$25 one-time registration" },
];

export const seedDefaults = mutation({
  args: {
    actorName: v.optional(v.string()),
    actorId: v.optional(v.id("director_users")),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("director_integrations").collect();
    const have = new Set(existing.map((r) => r.name.trim().toLowerCase()));
    const now = Date.now();
    let inserted = 0;
    for (let i = 0; i < STARTER_SERVICES.length; i++) {
      const s = STARTER_SERVICES[i];
      if (have.has(s.name.toLowerCase())) continue;
      await ctx.db.insert("director_integrations", {
        name: s.name,
        url: s.url,
        category: s.category,
        billing_type: s.billing_type,
        account: s.account,
        notes: s.notes,
        sort_order: (existing.length + inserted) * 10,
        created_at: now + i, // keep insertion order stable
        updated_at: now + i,
        updated_by_user_id: args.actorId,
      });
      inserted++;
    }
    if (inserted > 0) {
      await logAudit(
        ctx,
        "seed",
        "shop_created",
        `Seeded ${inserted} starter service(s)`,
        args.actorName,
        args.actorId,
      );
    }
    return { inserted };
  },
});
