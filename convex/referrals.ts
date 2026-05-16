/**
 * referrals.ts — Referral submission + status queries.
 *
 * The referee enters the referrer's code during onboarding. We
 * recompute every user's deterministic code and find the match
 * (small at MVP scale; revisit with a denormalized `users.referral_code`
 * field if user count grows). The actual $15-per-side credit payout
 * fires from `rewards.maybeFulfillReferralOnFirstService` when the
 * referee's first booking transitions to `completed`.
 *
 * Per Rewards Framework v3 §8 — $15/side at MVP, $25/side at V1,
 * referrer capped at 5 successful referrals.
 */

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Mirrors `components/shared-ui/ReferralUtils.ts` exactly. Convex
// can't import from `components/` so we duplicate. Keep these in
// sync — anytime one changes, change the other.
function stableShortHash(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) {
    h = (h * 31 + input.charCodeAt(i)) >>> 0;
  }
  return String(h % 1000000).padStart(6, "0");
}

function buildReferralCode(profile: {
  email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}): string {
  const base =
    (profile.email ?? "").split("@")[0]?.trim() ||
    `${(profile.first_name ?? "").trim()}${(profile.last_name ?? "").trim()}`.trim() ||
    "user";

  const normalized = base.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 14) || "user";
  return `otopair-${normalized}${stableShortHash(normalized)}`;
}

/**
 * Called from onboarding (HeardAboutStep) when the referee enters a
 * referral code. Inserts a `pending` referral row that the booking
 * complete trigger later fulfills.
 */
export const submitCode = mutation({
  args: {
    refereeUserId: v.id("users"),
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const code = args.code.trim().toLowerCase();
    if (!code) return { success: false, reason: "empty_code" } as const;

    // Reject if this referee already submitted a code (only one
    // referral per new user).
    const existing = await ctx.db
      .query("referrals")
      .withIndex("by_referee", (q) => q.eq("referee_user_id", args.refereeUserId))
      .first();
    if (existing) return { success: false, reason: "already_submitted" } as const;

    // Reverse-resolve: iterate users, recompute code, find match. OK
    // at MVP scale; add `users.referral_code` index if scan cost
    // becomes a problem.
    const allUsers = await ctx.db.query("users").collect();
    let referrer: (typeof allUsers)[number] | null = null;
    for (const u of allUsers) {
      if (u._id === args.refereeUserId) continue; // can't refer self
      const c = buildReferralCode({
        email: u.email,
        first_name: u.first_name,
        last_name: u.last_name,
      });
      if (c === code) {
        referrer = u;
        break;
      }
    }
    if (!referrer) return { success: false, reason: "code_not_found" } as const;

    await ctx.db.insert("referrals", {
      referrer_user_id: referrer._id,
      referee_user_id: args.refereeUserId,
      code_used: code,
      status: "pending",
      created_at: Date.now(),
    });

    return { success: true } as const;
  },
});

/**
 * Status of the current user's outgoing referrals — used by the
 * Refer-a-Friend settings screen to show "successful referrals" and
 * remaining slots out of the 5-cap.
 */
export const getMyReferralStatus = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("referrals")
      .withIndex("by_referrer", (q) => q.eq("referrer_user_id", args.userId))
      .collect();
    const credited = all.filter((r) => r.status === "credited").length;
    const pending = all.filter((r) => r.status === "pending").length;
    return {
      credited,
      pending,
      remainingSlots: Math.max(0, 5 - credited),
    };
  },
});
