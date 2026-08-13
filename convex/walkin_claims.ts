/**
 * walkin_claims.ts — Token-based deep links for mechanic-created walk-in
 * clients to claim their pre-built Otopair account.
 *
 * mintClaimToken is a plain helper callable from inside other Convex
 * mutations (e.g. enqueueWalkinClientUpdate in bookings.ts) — it is
 * idempotent: if the user already has an unexpired token, that token is
 * reused so the same URL keeps working across multiple SMS/email sends.
 *
 * resolveClaimToken is the public query the /claim/[token] landing page
 * calls to render shop + vehicle context before handing the user off to
 * Clerk SignUp.
 */

import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

const CLAIM_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

function randomToken(): string {
  // 24 random bytes → 32-char base64url (no padding).
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Idempotent: returns the existing valid token if one is set, else mints
 * a new one and patches the user row. Callable from inside any mutation
 * that has a writable ctx (no auth check — caller is responsible).
 */
export async function mintClaimToken(
  ctx: any,
  userId: Id<"users">,
): Promise<string | null> {
  const user = (await ctx.db.get(userId)) as Doc<"users"> | null;
  if (!user) return null;
  // Don't mint for already-claimed users — caller should suppress.
  if (user.walkInClaimedAt) return null;

  const now = Date.now();
  const existing = (user as any).claim_token as string | undefined;
  const expiresAt = (user as any).claim_token_expires_at as number | undefined;
  if (existing && expiresAt && expiresAt > now) {
    return existing;
  }

  const token = randomToken();
  await ctx.db.patch(userId, {
    claim_token: token,
    claim_token_expires_at: now + CLAIM_TOKEN_TTL_MS,
  } as any);
  return token;
}

export const resolveClaimToken = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    if (!args.token) return null;
    const user = await ctx.db
      .query("users")
      .withIndex("by_claim_token", (q: any) => q.eq("claim_token", args.token))
      .first();
    if (!user) return null;

    const expiresAt = (user as any).claim_token_expires_at as number | undefined;
    if (!expiresAt || expiresAt < Date.now()) {
      return { expired: true } as const;
    }

    if ((user as any).walkInClaimedAt) {
      return { alreadyClaimed: true } as const;
    }

    // Pull the most recent walk-in booking for shop + vehicle context.
    const recentBookings = await ctx.db
      .query("bookings")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", user._id))
      .order("desc")
      .take(5);

    const walkin = recentBookings.find(
      (b: any) => b.source === "mechanic_walk_in",
    );

    let shopName: string | null = null;
    if (walkin?.shop_id) {
      const shop = await ctx.db.get(walkin.shop_id);
      shopName = (shop as any)?.name ?? null;
    }

    let vehicleSummary: string | null = null;
    if (walkin?.vin) {
      const vehicle = await ctx.db
        .query("vehicles")
        .withIndex("by_vin", (q: any) => q.eq("vin", walkin.vin))
        .first();
      if (vehicle) {
        const v: any = vehicle;
        const parts = [
          v.year,
          v.metadata?.make,
          v.metadata?.model,
          v.metadata?.trim,
        ].filter(Boolean);
        if (parts.length) vehicleSummary = parts.join(" ");
      }
    }

    return {
      email: (user as any).email ?? null,
      firstName: (user as any).first_name ?? null,
      lastName: (user as any).last_name ?? null,
      shopName,
      vehicleSummary,
    };
  },
});
