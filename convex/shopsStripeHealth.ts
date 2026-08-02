// Shops · Stripe Connect Health — /shops/stripe (Shops Atlas T2, §4.7).
// Read-only mirror of webhook-synced Connect status. One row per shop with a
// derived status pill (connected / incomplete / no-account) plus the most
// recent stripe_webhook_events grouped per connected account.
//
// SECURITY: never returns secrets or full tokens. The Connect account id is
// masked server-side to "acct_…XXXX" (prefix + last 4) before leaving Convex.

import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireDirector } from "./directorGate";

/** Mask a Stripe Connect account id to prefix + last 4 characters. */
function maskAccountId(id: string): string {
  const last4 = id.slice(-4);
  return `acct_…${last4}`;
}

export const connectHealth = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireDirector(ctx, token);

    // Small table (9 rows measured) — collect is fine.
    const shops = await ctx.db.query("shops").collect();

    // stripe_webhook_events has no per-account index, so take a bounded
    // window of the most recent events and group them by account id here.
    const recentEvents = await ctx.db
      .query("stripe_webhook_events")
      .withIndex("by_received_at")
      .order("desc")
      .take(100);

    const eventsByAccount = new Map<
      string,
      { eventType: string; livemode: boolean | null; receivedAt: number; processedAt: number | null }[]
    >();
    for (const e of recentEvents) {
      if (!e.stripe_account_id) continue;
      const list = eventsByAccount.get(e.stripe_account_id) ?? [];
      if (list.length < 15) {
        list.push({
          eventType: e.event_type,
          livemode: e.livemode ?? null,
          receivedAt: e.received_at,
          processedAt: e.processed_at ?? null,
        });
      }
      eventsByAccount.set(e.stripe_account_id, list);
    }

    const rows = shops.map((s) => {
      const acct = s.stripe_connect_account_id ?? null;
      const chargesEnabled = s.stripe_charges_enabled ?? false;
      const payoutsEnabled = s.stripe_payouts_enabled ?? false;
      const status: "connected" | "incomplete" | "no-account" =
        acct === null || acct === ""
          ? "no-account"
          : chargesEnabled && payoutsEnabled
            ? "connected"
            : "incomplete";
      return {
        id: s._id as string,
        name: s.name,
        city: s.city ?? null,
        accountIdMasked: acct ? maskAccountId(acct) : null,
        status,
        chargesEnabled: acct ? chargesEnabled : null,
        payoutsEnabled: acct ? payoutsEnabled : null,
        requirementsDue: s.stripe_requirements_currently_due ?? [],
        onboardingCompletedAt: s.stripe_onboarding_completed_at ?? null,
        recentEvents: acct ? (eventsByAccount.get(acct) ?? []) : [],
      };
    });

    // Problems first (spec default filter: "anything not fully green"),
    // then alphabetical within each status band.
    const rank = { incomplete: 0, "no-account": 1, connected: 2 } as const;
    rows.sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));

    // Platform-level (no account id) recent events, for context in the UI.
    const platformEvents = recentEvents
      .filter((e) => !e.stripe_account_id)
      .slice(0, 15)
      .map((e) => ({
        eventType: e.event_type,
        livemode: e.livemode ?? null,
        receivedAt: e.received_at,
        processedAt: e.processed_at ?? null,
      }));

    return {
      rows,
      platformEvents,
      eventsWindow: recentEvents.length, // how many recent events were scanned
    };
  },
});
