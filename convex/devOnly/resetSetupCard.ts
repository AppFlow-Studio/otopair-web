/**
 * resetSetupCard.ts — DEV ONLY, not part of any product surface.
 *
 * Re-arms the Home "Finish setup" account card so its completion animation
 * can be played again (demos, QA, design review).
 *
 * The card is a one-shot by design: once every step is done it plays its
 * send-off on Home and then persists users.setupCardDismissed = true, so it
 * never returns. That makes it impossible to show twice without clearing the
 * flag, which is all this does.
 *
 * Usage:
 *   npx convex run devOnly/resetSetupCard:reset '{"email":"you@example.com"}'
 *
 * The return value reports each of the four steps, because the animation only
 * fires when ALL of them are complete — if one is false the card comes back in
 * its unfinished state and just sits there, which looks like the reset failed.
 *
 * To actually see it: open Home and swipe the action-card carousel to the
 * account card. The sequence is gated on that card being the visible one
 * (isVisible in FinishAccountSetupCard), so it waits for you rather than
 * playing to an empty screen.
 */
import { internalMutation } from "../_generated/server";
import { v } from "convex/values";

export const reset = internalMutation({
  args: {
    email: v.optional(v.string()),
    userId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const user = args.userId
      ? await ctx.db.get(args.userId)
      : args.email
        ? await ctx.db
            .query("users")
            .filter((q) => q.eq(q.field("email"), args.email))
            .first()
        : null;

    if (!user) return { ok: false, reason: "no user matched email/userId" };

    await ctx.db.patch(user._id, { setupCardDismissed: undefined });

    const vehicles = await ctx.db
      .query("vehicle_owners")
      .filter((q) => q.eq(q.field("user_id"), user._id))
      .collect();

    const steps = {
      createAccount: user.onboardingCompleted === true,
      aboutYou: user.tellUsAboutCompleted === true,
      addCar: vehicles.length > 0,
      payment: user.has_saved_payment_method === true,
    };

    return {
      ok: true,
      userId: user._id,
      steps,
      willAnimate: Object.values(steps).every(Boolean),
    };
  },
});
