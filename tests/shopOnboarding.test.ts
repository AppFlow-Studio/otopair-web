import { describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import { identityFor, makeT } from "./helpers";

async function seedReadyShopWithoutMechanics(t: ReturnType<typeof makeT>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const ownerClerkId = `clerk_shop_owner_${now}_${Math.random()
      .toString(36)
      .slice(2)}`;
    const ownerId = await ctx.db.insert("users", {
      clerkUserId: ownerClerkId,
      email: "owner@test.local",
      first_name: "Owner",
      role: "shop_owner",
      onboardingCompleted: false,
      createdAt: now,
    });

    const shopId = await ctx.db.insert("shops", {
      name: "No Mechanic Auto",
      owner_user_id: ownerId,
      is_active: true,
      timezone: "America/New_York",
      stripe_connect_account_id: "acct_ready_no_mechanics",
      stripe_charges_enabled: true,
      stripe_payouts_enabled: true,
      stripe_requirements_currently_due: [],
      stripe_onboarding_completed_at: now,
    });

    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    for (let day = 0; day < 7; day += 1) {
      await ctx.db.insert("shops_hours", {
        shop_id: shopId,
        day_of_week: day,
        day_name: dayNames[day],
        open_time: "08:00",
        close_time: "17:00",
        is_closed: false,
      });
    }

    return { ownerClerkId, ownerId, shopId };
  });
}

describe("shop onboarding", () => {
  test("allows finishing setup without mechanics", async () => {
    const t = makeT();
    const seed = await seedReadyShopWithoutMechanics(t);

    await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .mutation(api.shops.completeOnboarding, {});

    const { shop, owner } = await t.run(async (ctx) => ({
      shop: await ctx.db.get(seed.shopId),
      owner: await ctx.db.get(seed.ownerId),
    }));

    expect(shop?.onboarding_complete).toBe(true);
    expect(owner?.onboardingCompleted).toBe(true);
  });
});
