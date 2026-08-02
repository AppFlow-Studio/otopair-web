/**
 * two_factor_node.ts — Node-only action to email a 2FA code. Lives in a
 * "use node" module because it sends via Resend (email/send.ts).
 */
"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { sendTwoFactorEmail } from "../email/send";

const CODE_TTL_MS = 5 * 60 * 1000;

/**
 * Generate a 6-digit code, store it, and email it to the signed-in user.
 * Email only for now — SMS is pending a paid provider (Telnyx).
 */
export const sendCode = action({
  args: { method: v.string() },
  handler: async (ctx, { method }) => {
    if (method !== "email") {
      return {
        ok: false as const,
        error: "Only email verification is available right now.",
      };
    }
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return { ok: false as const, error: "You must be signed in." };

    const me: any = await ctx.runQuery(api.users.getMe, {});
    const to: string | undefined =
      me?.email ?? (typeof identity.email === "string" ? identity.email : undefined);
    if (!to) return { ok: false as const, error: "No email found on your profile." };
    const name =
      [me?.first_name, me?.last_name].filter(Boolean).join(" ") ||
      (typeof identity.name === "string" ? identity.name : undefined);

    const code = String(Math.floor(100000 + Math.random() * 900000));
    await ctx.runMutation(internal.two_factor._storeCode, {
      clerkUserId: identity.subject,
      method,
      code,
      expiresAt: Date.now() + CODE_TTL_MS,
    });

    const result = await sendTwoFactorEmail({ to, code, name });
    return result.success
      ? { ok: true as const, to }
      : {
          ok: false as const,
          error: String((result as any).error ?? "Failed to send code."),
        };
  },
});
