import { mutation, internalMutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Store a freshly-generated 2FA code, replacing any prior code for this
 * user+method. Called only from the send action (never the client).
 */
export const _storeCode = internalMutation({
  args: {
    clerkUserId: v.string(),
    method: v.string(),
    code: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("two_factor_codes")
      .withIndex("by_user_method", (q) =>
        q.eq("clerkUserId", args.clerkUserId).eq("method", args.method),
      )
      .collect();
    for (const row of existing) await ctx.db.delete(row._id);
    await ctx.db.insert("two_factor_codes", {
      clerkUserId: args.clerkUserId,
      method: args.method,
      code: args.code,
      expiresAt: args.expiresAt,
      attempts: 0,
    });
  },
});

/**
 * Verify an entered 2FA code for the signed-in user. Consumes the code on
 * success; enforces a 5-minute expiry and a 5-attempt limit.
 */
export const verifyCode = mutation({
  args: { method: v.string(), code: v.string() },
  handler: async (ctx, { method, code }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return { ok: false as const, error: "You must be signed in." };

    const row = await ctx.db
      .query("two_factor_codes")
      .withIndex("by_user_method", (q) =>
        q.eq("clerkUserId", identity.subject).eq("method", method),
      )
      .first();

    if (!row) return { ok: false as const, error: "No code found. Please resend." };
    if (Date.now() > row.expiresAt) {
      await ctx.db.delete(row._id);
      return { ok: false as const, error: "Code expired. Please request a new one." };
    }
    if (row.attempts >= 5) {
      await ctx.db.delete(row._id);
      return { ok: false as const, error: "Too many attempts. Please request a new one." };
    }
    if (row.code !== code.trim()) {
      await ctx.db.patch(row._id, { attempts: row.attempts + 1 });
      return { ok: false as const, error: "Incorrect code. Please check and try again." };
    }
    await ctx.db.delete(row._id);
    return { ok: true as const };
  },
});
