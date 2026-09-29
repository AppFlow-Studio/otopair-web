/**
 * mintWalkinLink.ts — DEV ONLY. Mint a walk-in tracker link for testing.
 *
 * The walk-in claim flow is only reachable through `otopair://claim/<token>`,
 * and the token is normally minted by shop staff from the web portal
 * (`walkin_claims.mintForBooking`, which requires a shop-staff session). That
 * makes the flow awkward to test from the app side, and since SMS verification
 * now sends a REAL text, the token also has to resolve to a phone you own —
 * otherwise testing means messaging someone else's handset.
 *
 * `internalMutation`, so nothing in the app can reach it. Run from the CLI:
 *
 *   npx convex run devOnly/mintWalkinLink:forBooking '{"bookingId":"j57…"}'
 *
 * Prints the deep link to open on the simulator/device.
 */

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

const TTL_MS = 90 * 24 * 60 * 60 * 1000;

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const forBooking = internalMutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const booking: any = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("No such booking.");

    const userId = booking.user_id;
    const user: any = userId ? await ctx.db.get(userId) : null;
    const phone = user?.phone ?? null;

    const now = Date.now();
    const token =
      booking.tracker_token &&
      booking.tracker_token_expires_at > now
        ? booking.tracker_token
        : randomToken();

    await ctx.db.patch(args.bookingId, {
      tracker_token: token,
      tracker_token_expires_at: now + TTL_MS,
    });

    return {
      token,
      deepLink: `otopair://claim/${token}`,
      // What the verification step will actually text, so it's obvious before
      // you tap whether a real message is about to leave.
      willTextPhone: phone,
      bookingStatus: booking.status,
      note: phone
        ? "Tapping 'Text me a code' WILL send a real SMS to this number."
        : "This booking's customer has no phone — sendCode will return no_phone and send nothing.",
    };
  },
});
