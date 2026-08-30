/* eslint-disable @typescript-eslint/no-explicit-any */
import { ConvexError, Infer, v } from "convex/values";

export const quoteHoldContextValidator = v.union(
  v.object({
    quote_type: v.literal("tire"),
    response_id: v.id("tire_quote_responses"),
    revision: v.optional(v.number()),
  }),
  v.object({
    quote_type: v.literal("rotor"),
    response_id: v.id("rotor_quote_responses"),
    revision: v.optional(v.number()),
  }),
);

export type QuoteHoldContext = Infer<typeof quoteHoldContextValidator>;

export const QUOTE_HOLD_DURATION_MS = 10 * 60 * 1000;

type QuoteHoldTiming = {
  created_at: number;
  expires_at?: number;
  superseded_at?: number;
  cancelled_at?: number;
  revision?: number;
};

export type CustomerQuoteLifecycleStatus =
  | "pending"
  | "ready"
  | "expired"
  | "cancelled";

type QuoteLifecycleCandidate = QuoteHoldTiming & {
  checkout_hold_expires_at?: number;
};

export type CustomerQuoteLifecycle = {
  status: CustomerQuoteLifecycleStatus;
  expiresAt: number | null;
};

export type QuoteUnavailableReason =
  | "expired"
  | "cancelled"
  | "modified"
  | "unavailable";

export function getQuoteRevision(response: QuoteHoldTiming): number {
  return response.revision ?? 1;
}

export function getQuoteAvailability(
  response: QuoteHoldTiming,
  options: { expectedRevision?: number; now?: number } = {},
): { available: true } | { available: false; reason: QuoteUnavailableReason } {
  const now = options.now ?? Date.now();
  if (response.cancelled_at != null) return { available: false, reason: "cancelled" };
  if (response.superseded_at != null) return { available: false, reason: "unavailable" };
  if (
    options.expectedRevision != null &&
    getQuoteRevision(response) !== options.expectedRevision
  ) {
    return { available: false, reason: "modified" };
  }
  if (getQuoteHoldExpiresAt(response) <= now) {
    return { available: false, reason: "expired" };
  }
  return { available: true };
}

export function summarizeQuoteLifecycle(
  responses: QuoteLifecycleCandidate[],
  now = Date.now(),
): CustomerQuoteLifecycle {
  const current = responses.filter((response) => response.superseded_at == null);
  if (current.length === 0) return { status: "pending", expiresAt: null };

  const nonCancelled = current.filter((response) => response.cancelled_at == null);
  if (nonCancelled.length === 0) return { status: "cancelled", expiresAt: null };

  const effectiveExpiries = nonCancelled.map((response) =>
    Math.max(
      getQuoteHoldExpiresAt(response),
      response.checkout_hold_expires_at ?? 0,
    ),
  );
  const expiresAt = Math.max(...effectiveExpiries);
  return expiresAt > now
    ? { status: "ready", expiresAt }
    : { status: "expired", expiresAt };
}

export function throwQuoteUnavailable(reason: QuoteUnavailableReason): never {
  throw new ConvexError({ code: "QUOTE_UNAVAILABLE", reason });
}

export async function requireQuoteShopAccess(ctx: any, shopId: any) {
  const user = await getAuthenticatedQuoteUser(ctx);
  if (!user) throw new Error("Authentication required.");
  const [shop, membership] = await Promise.all([
    ctx.db.get(shopId),
    ctx.db
      .query("shop_users")
      .withIndex("by_user_and_shop", (q: any) =>
        q.eq("user_id", user._id).eq("shop_id", shopId),
      )
      .first(),
  ]);
  const isOwner = shop && String(shop.owner_user_id) === String(user._id);
  const isStaff = membership && membership.is_active !== false;
  if (!isOwner && !isStaff) throw new Error("You don't have access to this quote.");
  return user;
}

export async function getActiveQuoteCheckoutHold(
  ctx: any,
  quoteType: "tire" | "rotor",
  responseId: any,
  revision: number,
  now = Date.now(),
) {
  const rows = await ctx.db
    .query("slot_holds")
    .withIndex(
      quoteType === "tire"
        ? "by_tire_quote_response"
        : "by_rotor_quote_response",
      (q: any) =>
        q.eq(
          quoteType === "tire"
            ? "tire_quote_response_id"
            : "rotor_quote_response_id",
          responseId,
        ),
    )
    .collect();
  return (
    rows.find(
      (hold: any) =>
        hold.status === "active" &&
        hold.expires_at > now &&
        hold.quote_type === quoteType &&
        hold.quote_revision === revision,
    ) ?? null
  );
}

export async function getBookingQuoteLifecycle(ctx: any, booking: any) {
  const quoteType = booking.rotor_specs != null ? "rotor" : booking.tire_specs != null ? "tire" : null;
  if (!quoteType) return null;
  const responses = await ctx.db
    .query(quoteType === "tire" ? "tire_quote_responses" : "rotor_quote_responses")
    .withIndex("by_booking_id", (q: any) => q.eq("booking_id", booking._id))
    .collect();
  const now = Date.now();
  const candidates = await Promise.all(
    responses.map(async (response: any) => {
      if (response.superseded_at != null || response.cancelled_at != null) return response;
      const hold = await getActiveQuoteCheckoutHold(
        ctx,
        quoteType,
        response._id,
        getQuoteRevision(response),
        now,
      );
      return {
        ...response,
        checkout_hold_expires_at: hold?.expires_at,
      };
    }),
  );
  return summarizeQuoteLifecycle(candidates, now);
}

export async function assertQuoteNotHeldForCheckout(
  ctx: any,
  quoteType: "tire" | "rotor",
  responseId: any,
  revision: number,
) {
  const hold = await getActiveQuoteCheckoutHold(
    ctx,
    quoteType,
    responseId,
    revision,
  );
  if (hold) {
    throw new ConvexError({
      code: "QUOTE_HELD",
      expiresAt: hold.expires_at,
    });
  }
}

export async function buildShopQuoteDetail(
  ctx: any,
  quoteType: "tire" | "rotor",
  response: any,
) {
  await requireQuoteShopAccess(ctx, response.shop_id);
  const booking = await ctx.db.get(response.booking_id);
  if (!booking) return null;
  const [mechanic, vehicle] = await Promise.all([
    response.mechanic_id ? ctx.db.get(response.mechanic_id) : null,
    ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q: any) => q.eq("vin", booking.vin))
      .first(),
  ]);
  const now = Date.now();
  const revision = getQuoteRevision(response);
  const checkoutHold = await getActiveQuoteCheckoutHold(
    ctx,
    quoteType,
    response._id,
    revision,
    now,
  );
  const quoteStatus =
    response.cancelled_at != null
      ? "cancelled"
      : checkoutHold != null
        ? "pending"
        : getQuoteHoldExpiresAt(response) <= now
        ? "expired"
        : "pending";
  const metadata = vehicle?.metadata as
    | { make?: string; model?: string }
    | undefined;
  return {
    response,
    booking: {
      _id: booking._id,
      vin: booking.vin,
      tire_specs: booking.tire_specs ?? null,
      rotor_specs: booking.rotor_specs ?? null,
      status: booking.status,
      submitted_at: booking.created_at ?? booking._creationTime,
    },
    vehicle: vehicle
      ? {
          year: vehicle.year ?? null,
          make: metadata?.make ?? null,
          model: metadata?.model ?? null,
        }
      : null,
    mechanic: mechanic
      ? {
          _id: mechanic._id,
          name: `${mechanic.first_name ?? ""} ${mechanic.last_name ?? ""}`.trim(),
        }
      : null,
    quote_status: quoteStatus,
    checkout_held: checkoutHold != null,
    checkout_hold_expires_at: checkoutHold?.expires_at ?? null,
  };
}

export function getQuoteHoldExpiresAt(response: QuoteHoldTiming): number {
  return response.expires_at ?? response.created_at + QUOTE_HOLD_DURATION_MS;
}

export function isQuoteHoldActive(
  response: QuoteHoldTiming,
  now = Date.now(),
): boolean {
  return getQuoteAvailability(response, { now }).available;
}

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
  options: { throwOnUnavailable?: boolean } = {},
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

  const availability = getQuoteAvailability(response, {
    expectedRevision: context.revision ?? 1,
  });
  if (!availability.available) {
    if (options.throwOnUnavailable !== false) throwQuoteUnavailable(availability.reason);
    return {};
  }

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
