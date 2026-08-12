/**
 * support_requests_node.ts — Node-only actions for customer support mail.
 * Lives in a "use node" module because the Resend SDK (via email/send.ts)
 * is not Convex-V8-compatible.
 */
"use node";

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { api } from "./_generated/api";
import { sendContactSupportEmail, sendFeedbackEmail } from "../email/send";

/**
 * Contact Support form (Settings → Contact Us). Emails the request to
 * support@otopair.com with reply-to set to the customer's profile email,
 * so ops can just hit Reply.
 */
export const submitContactRequest = action({
  args: {
    topic: v.string(),
    subject: v.string(),
    description: v.string(),
    attachmentCount: v.optional(v.number()),
  },
  handler: async (ctx, { topic, subject, description, attachmentCount }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return { ok: false as const, error: "You must be signed in to contact support." };
    }

    const me: any = await ctx.runQuery(api.users.getMe, {});
    const customerEmail: string = me?.email ?? identity.email ?? "";
    if (!customerEmail) {
      return { ok: false as const, error: "No email found on your profile." };
    }
    const customerName =
      [me?.first_name, me?.last_name].filter(Boolean).join(" ") ||
      identity.name ||
      undefined;

    const result = await sendContactSupportEmail({
      topic,
      subject,
      description,
      customerEmail,
      customerName,
      attachmentCount,
    });

    return result.success
      ? { ok: true as const }
      : { ok: false as const, error: String((result as any).error ?? "Failed to send.") };
  },
});

/**
 * Emails an app-feedback note to support@otopair.com. Scheduled from the
 * `app_feedback.submit` mutation so the feedback still saves to the DB and
 * a copy lands in the support inbox.
 */
export const emailAppFeedback = internalAction({
  args: {
    text: v.string(),
    source: v.optional(v.string()),
    customerEmail: v.optional(v.string()),
    customerName: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    await sendFeedbackEmail(args);
    return null;
  },
});
