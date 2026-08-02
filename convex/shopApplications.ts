import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// Public intake (Step 1 of the invite-based shop onboarding flow). The API
// route has already validated fields, lowercased the email, and confirmed no
// registered user owns this email. This mutation normalizes once more (defense
// in depth) and is the last line of defense against a duplicate *pending*
// application (double-submit / retry). Mirrors invitations.create's
// by_email + status guard.
export const submit = mutation({
  args: {
    shop_legal_name: v.string(),
    owner_full_name: v.string(),
    business_email: v.string(),
    phone: v.string(),
    street_address: v.string(),
    source: v.optional(v.string()),
    user_agent: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const email = args.business_email.trim().toLowerCase();

    const existing = await ctx.db
      .query("shop_applications")
      .withIndex("by_business_email", (q) => q.eq("business_email", email))
      .filter((q) => q.eq(q.field("status"), "pending_review"))
      .first();
    if (existing) throw new Error("DUPLICATE_PENDING_APPLICATION"); // route → 409

    const now = Date.now();
    return await ctx.db.insert("shop_applications", {
      shop_legal_name: args.shop_legal_name.trim(),
      owner_full_name: args.owner_full_name.trim(),
      business_email: email,
      phone: args.phone,
      street_address: args.street_address.trim(),
      status: "pending_review",
      source: args.source,
      user_agent: args.user_agent,
      created_at: now,
      updated_at: now,
    });
  },
});

// Reserved for Step 2 (admin queue / dedupe reads).
export const getByEmail = query({
  args: { business_email: v.string() },
  handler: async (ctx, args) =>
    ctx.db
      .query("shop_applications")
      .withIndex("by_business_email", (q) =>
        q.eq("business_email", args.business_email.trim().toLowerCase()),
      )
      .first(),
});

export const listByStatus = query({
  args: { status: v.string() },
  handler: async (ctx, args) =>
    ctx.db
      .query("shop_applications")
      .withIndex("by_status", (q) => q.eq("status", args.status))
      .order("desc")
      .collect(),
});
