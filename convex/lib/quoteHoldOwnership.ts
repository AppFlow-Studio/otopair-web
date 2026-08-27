/* eslint-disable @typescript-eslint/no-explicit-any */
import { Infer, v } from "convex/values";

export const quoteHoldContextValidator = v.union(
  v.object({
    quote_type: v.literal("tire"),
    response_id: v.id("tire_quote_responses"),
  }),
  v.object({
    quote_type: v.literal("rotor"),
    response_id: v.id("rotor_quote_responses"),
  }),
);

export type QuoteHoldContext = Infer<typeof quoteHoldContextValidator>;

export async function getAuthenticatedQuoteUser(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) => q.eq("clerkUserId", identity.subject))
    .unique();
}

export async function resolveOwnedQuoteHoldExclusion(
  ctx: any,
  context?: QuoteHoldContext,
): Promise<{
  excludeTireQuoteResponseId?: string;
  excludeRotorQuoteResponseId?: string;
}> {
  if (!context) return {};
  const user = await getAuthenticatedQuoteUser(ctx);
  if (!user) return {};

  const response = await ctx.db.get(context.response_id);
  if (!response) return {};
  const booking = await ctx.db.get(response.booking_id);
  if (!booking || String(booking.user_id) !== String(user._id)) return {};

  return context.quote_type === "tire"
    ? { excludeTireQuoteResponseId: String(context.response_id) }
    : { excludeRotorQuoteResponseId: String(context.response_id) };
}

export async function requireOwnedQuoteBooking(ctx: any, bookingId: any) {
  const user = await getAuthenticatedQuoteUser(ctx);
  if (!user) throw new Error("Authentication required.");
  const booking = await ctx.db.get(bookingId);
  if (!booking || String(booking.user_id) !== String(user._id)) {
    throw new Error("Booking not found.");
  }
  return { user, booking };
}
