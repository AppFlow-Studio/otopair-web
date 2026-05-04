import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

export const record = internalMutation({
  args: {
    eventId: v.string(),
    eventType: v.string(),
    livemode: v.optional(v.boolean()),
    stripeAccountId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("stripe_webhook_events")
      .withIndex("by_event_id", (q) => q.eq("event_id", args.eventId))
      .first();

    if (existing) {
      return { duplicate: true };
    }

    await ctx.db.insert("stripe_webhook_events", {
      event_id: args.eventId,
      event_type: args.eventType,
      livemode: args.livemode,
      stripe_account_id: args.stripeAccountId,
      received_at: Date.now(),
      processed_at: Date.now(),
    });

    return { duplicate: false };
  },
});

export const syncConnectedAccount = internalMutation({
  args: {
    eventId: v.string(),
    eventType: v.string(),
    livemode: v.optional(v.boolean()),
    stripeAccountId: v.string(),
    stripeChargesEnabled: v.boolean(),
    stripePayoutsEnabled: v.boolean(),
    stripeRequirementsCurrentlyDue: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("stripe_webhook_events")
      .withIndex("by_event_id", (q) => q.eq("event_id", args.eventId))
      .first();

    if (existing) {
      return { duplicate: true, shopId: null, ready: false };
    }

    await ctx.db.insert("stripe_webhook_events", {
      event_id: args.eventId,
      event_type: args.eventType,
      livemode: args.livemode,
      stripe_account_id: args.stripeAccountId,
      received_at: Date.now(),
      processed_at: Date.now(),
    });

    const shop = await ctx.db
      .query("shops")
      .withIndex("by_stripe_connect_account_id", (q) =>
        q.eq("stripe_connect_account_id", args.stripeAccountId)
      )
      .first();

    if (!shop) {
      return { duplicate: false, shopId: null, ready: false };
    }

    const ready =
      args.stripeChargesEnabled &&
      args.stripePayoutsEnabled &&
      args.stripeRequirementsCurrentlyDue.length === 0;

    await ctx.db.patch(shop._id, {
      stripe_charges_enabled: args.stripeChargesEnabled,
      stripe_payouts_enabled: args.stripePayoutsEnabled,
      stripe_requirements_currently_due: args.stripeRequirementsCurrentlyDue,
      stripe_onboarding_completed_at: ready
        ? shop.stripe_onboarding_completed_at ?? Date.now()
        : shop.stripe_onboarding_completed_at,
    });

    return { duplicate: false, shopId: shop._id, ready };
  },
});
