// =============================================================================
// Shops portal · Onboarding Pipeline — /shops/pipeline (Shops spec §4.3).
// No shop_onboarding table exists — every stage is DERIVED from real checks
// ("auto-verified against the tables, not a checkbox of vibes"). The kanban
// is honest: a shop advances the moment the facts change, and each checklist
// item names the check that proved it. Read-only.
// Stages: Lead → Agreed → Stripe → Configured → Staffed → Test run → Live.
// =============================================================================
import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireDirector } from "./directorGate";
import { userDisplayName } from "./lib/bookingEnrichment";

const DAY = 24 * 60 * 60 * 1000;

export const STAGES = [
  "Lead",
  "Agreed",
  "Stripe",
  "Configured",
  "Staffed",
  "Test run",
  "Live",
] as const;
export type Stage = (typeof STAGES)[number];

// --- Authored return types (see dataOverview.ts header) -----------------------

export type ChecklistItem = { label: string; proof: string; passed: boolean };
export type PipelineCard = {
  shop_id: string;
  name: string;
  city: string | null;
  phone: string | null;
  owner: string | null;
  owner_id: string | null;
  bookings_30d: number;
  revenue_30d: number;
  stage: Stage;
  stage_index: number;
  age_days: number | null; // since shop creation — honest proxy, no stage timestamps exist
  checklist: ChecklistItem[];
  next_item: string | null;
};
export type PipelineResult = {
  columns: { stage: Stage; cards: PipelineCard[] }[];
  live_count: number;
};

export const board = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<PipelineResult> => {
    await requireDirector(ctx, token);
    const shops = await ctx.db.query("shops").collect(); // 9 rows measured
    const cards: PipelineCard[] = [];

    // 30d bookings + completed revenue per shop, one indexed window for all.
    const since30d = Date.now() - 30 * DAY;
    const recent = await ctx.db
      .query("bookings")
      .withIndex("by_created_at", (q) => q.gte("created_at", since30d))
      .collect();
    const shopStats = new Map<string, { bookings: number; revenue: number }>();
    for (const b of recent) {
      if (!b.shop_id) continue;
      const key = String(b.shop_id);
      const agg = shopStats.get(key) ?? { bookings: 0, revenue: 0 };
      agg.bookings += 1;
      if (b.status === "completed") agg.revenue += b.total_cost ?? 0;
      shopStats.set(key, agg);
    }

    for (const s of shops) {
      // ── The auto-verified checks, in stage order ──
      const owner = await ctx.db
        .query("shop_users")
        .withIndex("by_shop_and_role", (q) => q.eq("shop_id", s._id).eq("role", "shop_owner"))
        .first();
      // Resolve the owner's display name + id for the card (owner may be a
      // shop_users row pointing at a real user, or null pre-agreement).
      const ownerUser = owner ? await ctx.db.get(owner.user_id) : null;
      const acceptedInvite = owner
        ? null
        : (
            await ctx.db
              .query("shop_invitations")
              .withIndex("by_shop_id", (q) => q.eq("shop_id", s._id))
              .take(20)
          ).find((i) => i.status === "accepted") ?? null;
      const agreed = owner != null || acceptedInvite != null;

      const stripeReady = s.stripe_charges_enabled === true && s.stripe_payouts_enabled === true;

      const hours = await ctx.db
        .query("shops_hours")
        .withIndex("by_shop_id", (q) => q.eq("shop_id", s._id))
        .take(10);
      const offerings = await ctx.db
        .query("shop_services")
        .withIndex("by_shop_id", (q) => q.eq("shop_id", s._id))
        .take(50);
      const offered = offerings.filter((o) => o.is_offered !== false);
      const configured = hours.length >= 7 && offered.length > 0 && s.labor_rate != null;

      const mechanics = await ctx.db
        .query("mechanics")
        .withIndex("by_shop_id", (q) => q.eq("shop_id", s._id))
        .take(30);
      const staffed = mechanics.some((m) => m.is_active !== false);

      const firstBooking = await ctx.db
        .query("bookings")
        .withIndex("by_shop_id", (q) => q.eq("shop_id", s._id))
        .first();
      const tested = firstBooking != null;

      const live = s.is_active === true && s.is_verified === true && s.onboarding_complete === true;

      const checklist: ChecklistItem[] = [
        { label: "Shop record created", proof: "shops row exists", passed: true },
        {
          label: "Owner on the platform",
          proof: owner
            ? "shop_users role=shop_owner"
            : acceptedInvite
              ? "shop_invitations status=accepted"
              : "no owner shop_user / accepted invite",
          passed: agreed,
        },
        {
          label: "Stripe charges + payouts enabled",
          proof: `stripe_charges_enabled=${s.stripe_charges_enabled ?? "—"} · payouts=${s.stripe_payouts_enabled ?? "—"}`,
          passed: stripeReady,
        },
        {
          label: "Hours 7/7 · ≥1 service · labor rate",
          proof: `hours ${hours.length}/7 · offered ${offered.length} · rate ${s.labor_rate != null ? `$${s.labor_rate}/hr` : "—"}`,
          passed: configured,
        },
        {
          label: "≥1 active mechanic",
          proof: `${mechanics.filter((m) => m.is_active !== false).length} active of ${mechanics.length}`,
          passed: staffed,
        },
        {
          label: "First booking exists",
          proof: firstBooking ? "bookings.by_shop_id ≥1" : "no bookings yet",
          passed: tested,
        },
        {
          label: "Active + verified + onboarding_complete",
          proof: `active=${s.is_active ?? "—"} · verified=${s.is_verified ?? "—"} · complete=${s.onboarding_complete ?? "—"}`,
          passed: live,
        },
      ];

      // Stage = first failing gate (Lead is index 0; passing everything = Live).
      const gates = [true, agreed, stripeReady, configured, staffed, tested, live];
      let stageIndex = 0;
      for (let i = gates.length - 1; i >= 0; i--) {
        if (gates.slice(0, i + 1).every(Boolean)) {
          stageIndex = i;
          break;
        }
      }
      const nextFailing = checklist.find((c) => !c.passed);

      const stats = shopStats.get(String(s._id));
      cards.push({
        shop_id: String(s._id),
        name: s.name,
        city: s.city ?? null,
        phone: s.phone ?? null,
        owner: ownerUser ? userDisplayName(ownerUser) : null,
        owner_id: ownerUser ? String(ownerUser._id) : null,
        bookings_30d: stats?.bookings ?? 0,
        revenue_30d: stats?.revenue ?? 0,
        stage: STAGES[stageIndex],
        stage_index: stageIndex,
        age_days: Math.floor((Date.now() - s._creationTime) / (24 * 60 * 60 * 1000)),
        checklist,
        next_item: nextFailing?.label ?? null,
      });
    }

    return {
      columns: STAGES.map((stage, i) => ({
        stage,
        cards: cards.filter((c) => c.stage_index === i).sort((a, b) => (b.age_days ?? 0) - (a.age_days ?? 0)),
      })),
      live_count: cards.filter((c) => c.stage === "Live").length,
    };
  },
});
