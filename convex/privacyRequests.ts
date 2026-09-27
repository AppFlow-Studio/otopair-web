import { mutation } from "./_generated/server";
import { v } from "convex/values";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * MUTATION: submit
 * Records an opt-out or account-deletion request from the website forms
 * (/privacy-choices, /delete-account; app/api/privacy-requests/route.ts).
 *
 * It only records. Opting out needs no verification under Privacy Policy
 * v6.1, but deleting an account does, and this is a public endpoint — so the
 * team acts on the row, not the form. The return value never says whether
 * an account exists for the email, so the form can't be used to find out.
 */
export const submit = mutation({
  args: {
    kind: v.union(v.literal("opt_out_vehicle_history"), v.literal("delete_account")),
    email: v.string(),
    gpc: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase();
    if (email.length > 254 || !EMAIL.test(email)) {
      throw new Error("A valid email is required.");
    }
    const now = Date.now();

    // A second submit of the same request refreshes the open row instead of
    // queueing the same work twice.
    const open = await ctx.db
      .query("privacy_requests")
      .withIndex("by_email_kind_status", (q) =>
        q.eq("email", email).eq("kind", args.kind).eq("status", "open"),
      )
      .first();
    if (open) {
      await ctx.db.patch(open._id, {
        last_submitted_at: now,
        ...(args.gpc ? { gpc: true } : {}),
      });
      return { ok: true as const };
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();

    await ctx.db.insert("privacy_requests", {
      kind: args.kind,
      email,
      ...(user ? { user_id: user._id } : {}),
      ...(args.gpc ? { gpc: true } : {}),
      source: "website",
      status: "open",
      created_at: now,
      last_submitted_at: now,
    });
    return { ok: true as const };
  },
});
