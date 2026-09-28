/**
 * walkin_phone_verify.ts — SMS verification for the walk-in claim flow.
 *
 * The customer has no account yet, so the only identity they carry is the
 * tracker/claim token in the link the shop handed them. Everything here is
 * scoped to that token: it authenticates the request, it selects the phone,
 * and the code is never sent to a number the caller supplies.
 *
 * WHY THE CALLER NEVER SUPPLIES THE NUMBER
 * The screen shows the number MASKED and asks "is this your number?" — it is
 * read from the booking the shop already created. If the client could pass a
 * number, anyone holding a tracker link (they are shareable by design) could
 * point a verification code at a phone of their choosing and claim the job.
 * The token picks the number; the customer only confirms it.
 *
 * Verifying is deliberately NOT a gate. The tracker keeps updating either way
 * — that is the promise the enter-code screen makes in its footer — so every
 * failure path here degrades to "not verified", never to "you lost your job".
 */

import { v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
} from "./_generated/server";
import { internal } from "./_generated/api";

/** Codes are short-lived. Long enough to switch apps and read a text. */
const CODE_TTL_MS = 10 * 60 * 1000;
/** Wrong guesses before the code is burned and a new one is needed. */
const MAX_ATTEMPTS = 5;
/** Resend cooldown — the screen counts this down. */
const RESEND_COOLDOWN_MS = 30 * 1000;
/** Hard cap on codes per token, so a shared link can't be turned into an
 *  SMS pump aimed at someone else's phone. Telnyx bills per message. */
const MAX_SENDS_PER_TOKEN = 5;

/**
 * SHA-256, hex. Available in Convex's default runtime via Web Crypto — no
 * "use node" needed, which keeps the verify mutation transactional.
 */
async function hashCode(code: string, token: string): Promise<string> {
  // Salted with the token so the same 6 digits under two different links do
  // not produce the same hash.
  const data = new TextEncoder().encode(`${token}:${code}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function sixDigitCode(): string {
  // Rejection-free: take 4 random bytes, mod into [0, 900000) and offset, so
  // every value is 6 digits. Math.random() is not used for a credential.
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const n =
    ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  return String(100000 + (n % 900000));
}

/** Masked for display and for the action's return value — the full number is
 *  never handed back to a client that did not already have it. */
function maskPhone(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  const last4 = digits.slice(-4);
  return last4 ? `··· ··· ${last4}` : "your number on file";
}

// ─────────────────────────────────────────────────────────────────────────
// Internal plumbing
// ─────────────────────────────────────────────────────────────────────────

export const _phoneForToken = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    // Same two token shapes resolveClaimToken accepts: a booking's
    // tracker_token, or a user's claim_token.
    const booking = await ctx.db
      .query("bookings")
      .withIndex("by_tracker_token", (q: any) =>
        q.eq("tracker_token", args.token),
      )
      .first();
    let userId: any = null;
    if (booking) {
      const exp = (booking as any).tracker_token_expires_at as number | undefined;
      if (exp && exp <= now) return { expired: true as const };
      userId = (booking as any).user_id ?? null;
    } else {
      const user = await ctx.db
        .query("users")
        .withIndex("by_claim_token", (q: any) => q.eq("claim_token", args.token))
        .first();
      if (!user) return null;
      const exp = (user as any).claim_token_expires_at as number | undefined;
      if (exp && exp <= now) return { expired: true as const };
      userId = user._id;
    }
    if (!userId) return null;
    const user = await ctx.db.get(userId);
    const phone = (user as any)?.phone as string | undefined;
    if (!phone) return { noPhone: true as const };
    return { phone, userId };
  },
});

export const _readCodeRow = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, args) =>
    await ctx.db
      .query("walkin_phone_codes")
      .withIndex("by_token", (q: any) => q.eq("token", args.token))
      .first(),
});

export const _storeCode = internalMutation({
  args: {
    token: v.string(),
    phone: v.string(),
    codeHash: v.string(),
    expiresAtMs: v.number(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("walkin_phone_codes")
      .withIndex("by_token", (q: any) => q.eq("token", args.token))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        phone: args.phone,
        code_hash: args.codeHash,
        expires_at_ms: args.expiresAtMs,
        // A fresh code resets the guess budget — the old one is gone, so
        // holding failures against the new one would punish the wrong thing.
        attempts: 0,
        last_sent_at_ms: now,
        sends: (existing.sends ?? 0) + 1,
        consumed_at_ms: undefined,
      });
      return existing._id;
    }
    return await ctx.db.insert("walkin_phone_codes", {
      token: args.token,
      phone: args.phone,
      code_hash: args.codeHash,
      expires_at_ms: args.expiresAtMs,
      attempts: 0,
      last_sent_at_ms: now,
      sends: 1,
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────
// Public
// ─────────────────────────────────────────────────────────────────────────

/**
 * Send (or resend) a code to the number on file for this token.
 *
 * Returns the MASKED number so the screen can say where it went without the
 * client ever learning the full one.
 */
export const sendCode = action({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<
    | { ok: true; maskedPhone: string; resendAfterMs: number; stubbed: boolean }
    | { ok: false; reason: string; message: string }
  > => {
    const target = await ctx.runQuery(
      internal.walkin_phone_verify._phoneForToken,
      { token: args.token },
    );
    if (!target) {
      return {
        ok: false as const,
        reason: "unknown_token",
        message: "That link isn't valid any more.",
      };
    }
    if ("expired" in target) {
      return {
        ok: false as const,
        reason: "expired_token",
        message: "That link has expired. Ask the shop for a new one.",
      };
    }
    if ("noPhone" in target) {
      return {
        ok: false as const,
        reason: "no_phone",
        message:
          "The shop doesn't have a phone number on file for this job. You can still track it here.",
      };
    }

    const now = Date.now();
    const existing = await ctx.runQuery(
      internal.walkin_phone_verify._readCodeRow,
      { token: args.token },
    );
    if (existing) {
      const since = now - (existing.last_sent_at_ms ?? 0);
      if (since < RESEND_COOLDOWN_MS) {
        return {
          ok: false as const,
          reason: "cooldown",
          message: `Hang on a moment before asking for another code.`,
        };
      }
      if ((existing.sends ?? 0) >= MAX_SENDS_PER_TOKEN) {
        return {
          ok: false as const,
          reason: "send_limit",
          message:
            "We've sent as many codes as we can for this job. Ask the shop if you still need to verify.",
        };
      }
    }

    const code = sixDigitCode();
    await ctx.runMutation(internal.walkin_phone_verify._storeCode, {
      token: args.token,
      phone: target.phone,
      codeHash: await hashCode(code, args.token),
      expiresAtMs: now + CODE_TTL_MS,
    });

    // The message names Otopair and says what the code is for. An unlabelled
    // 6-digit text is indistinguishable from a phishing attempt, and this one
    // arrives while the person is standing at a service counter.
    const result: any = await ctx.runAction(
      internal.lib.sms_provider.sendSms,
      {
        to: target.phone,
        body: `${code} is your Otopair verification code. It expires in 10 minutes. We'll never ask you for it.`,
      },
    );

    return {
      ok: true as const,
      maskedPhone: maskPhone(target.phone),
      resendAfterMs: RESEND_COOLDOWN_MS,
      // True when Telnyx isn't configured on this deployment and nothing was
      // actually sent. Surfaced so a tester can tell "no text arrived because
      // SMS is off" from "no text arrived because it's broken".
      stubbed: result?.status === "stubbed",
    };
  },
});

/**
 * Check a code. On success the row is consumed and the user's phone is marked
 * verified.
 */
export const verifyCode = mutation({
  args: { token: v.string(), code: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("walkin_phone_codes")
      .withIndex("by_token", (q: any) => q.eq("token", args.token))
      .first();
    if (!row || row.consumed_at_ms != null) {
      return {
        ok: false as const,
        reason: "no_code",
        message: "Ask for a new code and try again.",
      };
    }
    const now = Date.now();
    if (row.expires_at_ms <= now) {
      return {
        ok: false as const,
        reason: "expired",
        message: "That code has expired. Ask for a new one.",
      };
    }
    if (row.attempts >= MAX_ATTEMPTS) {
      return {
        ok: false as const,
        reason: "too_many_attempts",
        message: "Too many tries. Ask for a new code.",
      };
    }

    const supplied = args.code.replace(/\D/g, "");
    const expected = row.code_hash;
    const actual = await hashCode(supplied, args.token);
    if (actual !== expected) {
      await ctx.db.patch(row._id, { attempts: row.attempts + 1 });
      const left = MAX_ATTEMPTS - (row.attempts + 1);
      return {
        ok: false as const,
        reason: "wrong_code",
        message:
          left > 0
            ? "That code doesn't match. Check the text and try again."
            : "Too many tries. Ask for a new code.",
        attemptsLeft: Math.max(0, left),
      };
    }

    await ctx.db.patch(row._id, { consumed_at_ms: now });

    // Stamp the user the token resolves to. Resolved inline rather than via
    // the internal query so the consume and the stamp are one transaction —
    // a code must never be burned without the verification it bought.
    const booking = await ctx.db
      .query("bookings")
      .withIndex("by_tracker_token", (q: any) =>
        q.eq("tracker_token", args.token),
      )
      .first();
    const userId = booking
      ? ((booking as any).user_id ?? null)
      : ((
          await ctx.db
            .query("users")
            .withIndex("by_claim_token", (q: any) =>
              q.eq("claim_token", args.token),
            )
            .first()
        )?._id ?? null);
    if (userId) {
      await ctx.db.patch(userId, { phone_verified_at_ms: now } as any);
    }
    return { ok: true as const };
  },
});
