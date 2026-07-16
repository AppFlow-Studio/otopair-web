import { describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import { identityFor, makeT } from "./helpers";

type T = ReturnType<typeof makeT>;

/** Seed a user + shop + owner-role membership; returns ids and the Clerk subject. */
async function seedShopWithOwner(t: T, tag: string) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const ownerClerkId = `clerk_logo_owner_${tag}_${now}`;
    const ownerId = await ctx.db.insert("users", {
      clerkUserId: ownerClerkId,
      email: `${tag}-owner@test.local`,
      first_name: "Owner",
      role: "shop_owner",
      createdAt: now,
    });
    const shopId = await ctx.db.insert("shops", {
      name: `Logo Shop ${tag}`,
      owner_user_id: ownerId,
      is_active: true,
    });
    await ctx.db.insert("shop_users", {
      user_id: ownerId,
      shop_id: shopId,
      role: "owner",
      is_active: true,
    });
    return { ownerClerkId, ownerId, shopId };
  });
}

/** Store fake image bytes in convex-test's in-memory storage; returns a real storageId. */
async function storeFakeImage(t: T) {
  return await t.run(async (ctx) =>
    ctx.storage.store(new Blob(["fake-png-bytes"], { type: "image/png" })),
  );
}

describe("shop logo mutations (ported from otopair-1)", () => {
  test("owner can set, see (via getMyShops logoUrl), and clear the logo", async () => {
    const t = makeT();
    const { ownerClerkId, shopId } = await seedShopWithOwner(t, "a");
    const asOwner = t.withIdentity(identityFor(ownerClerkId));

    // Before any upload, getMyShops resolves logoUrl to null.
    const before = await asOwner.query(api.shops.getMyShops, {});
    expect(before).toHaveLength(1);
    expect(before[0]!.logoUrl).toBeNull();

    const storageId = await storeFakeImage(t);
    await asOwner.mutation(api.shops.setShopLogo, { shopId, storageId });

    const after = await asOwner.query(api.shops.getMyShops, {});
    expect(typeof after[0]!.logoUrl).toBe("string");
    expect(after[0]!.logoUrl).toBeTruthy();

    await asOwner.mutation(api.shops.clearShopLogo, { shopId });
    const cleared = await asOwner.query(api.shops.getMyShops, {});
    expect(cleared[0]!.logoUrl).toBeNull();
  });

  test("a signed-in user with no membership cannot set or clear the logo", async () => {
    const t = makeT();
    const { shopId } = await seedShopWithOwner(t, "b");
    const randoClerkId = `clerk_logo_rando_${Date.now()}`;
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        clerkUserId: randoClerkId,
        email: "rando@test.local",
        first_name: "Rando",
        role: "user",
        createdAt: Date.now(),
      });
    });
    const asRando = t.withIdentity(identityFor(randoClerkId));
    const storageId = await storeFakeImage(t);

    await expect(
      asRando.mutation(api.shops.setShopLogo, { shopId, storageId }),
    ).rejects.toThrow("Not authorized");
    await expect(
      asRando.mutation(api.shops.clearShopLogo, { shopId }),
    ).rejects.toThrow("Not authorized");
    await expect(
      asRando.mutation(api.shops.generateShopLogoUploadUrl, { shopId }),
    ).rejects.toThrow("Not authorized");
  });

  test("a storageId already used by another shop is rejected", async () => {
    const t = makeT();
    const shopA = await seedShopWithOwner(t, "c1");
    const shopB = await seedShopWithOwner(t, "c2");
    const storageId = await storeFakeImage(t);

    const asOwnerA = t.withIdentity(identityFor(shopA.ownerClerkId));
    await asOwnerA.mutation(api.shops.setShopLogo, { shopId: shopA.shopId, storageId });

    const asOwnerB = t.withIdentity(identityFor(shopB.ownerClerkId));
    await expect(
      asOwnerB.mutation(api.shops.setShopLogo, { shopId: shopB.shopId, storageId }),
    ).rejects.toThrow("already in use by another shop");

    // Re-setting the SAME shop's own storageId stays idempotent (no self-conflict).
    await asOwnerA.mutation(api.shops.setShopLogo, { shopId: shopA.shopId, storageId });
  });

  test("owner gets an upload URL", async () => {
    const t = makeT();
    const { ownerClerkId, shopId } = await seedShopWithOwner(t, "d");
    const asOwner = t.withIdentity(identityFor(ownerClerkId));
    const url = await asOwner.mutation(api.shops.generateShopLogoUploadUrl, { shopId });
    expect(typeof url).toBe("string");
    expect(url.length).toBeGreaterThan(0);
  });

  test("owner_user_id fallback authorizes an owner with no shop_users membership", async () => {
    const t = makeT();
    // Deliberately NO shop_users row: authorization must come from the
    // `owner_user_id` fallback branch in requireShopOwner, not membership.
    const { ownerClerkId, shopId } = await t.run(async (ctx) => {
      const now = Date.now();
      const ownerClerkId = `clerk_logo_fallback_owner_${now}`;
      const ownerId = await ctx.db.insert("users", {
        clerkUserId: ownerClerkId,
        email: "e-owner@test.local",
        first_name: "Fallback",
        role: "shop_owner",
        createdAt: now,
      });
      const shopId = await ctx.db.insert("shops", {
        name: "Logo Shop e",
        owner_user_id: ownerId,
        is_active: true,
      });
      return { ownerClerkId, shopId };
    });
    const asOwner = t.withIdentity(identityFor(ownerClerkId));
    const storageId = await storeFakeImage(t);

    // Membership-less owners don't appear in getMyShops (known/accepted),
    // so call the mutations directly and verify against the db.
    await asOwner.mutation(api.shops.setShopLogo, { shopId, storageId });
    const afterSet = await t.run(async (ctx) => ctx.db.get(shopId));
    expect(afterSet!.logo_storage_id).toBe(storageId);

    await asOwner.mutation(api.shops.clearShopLogo, { shopId });
    const afterClear = await t.run(async (ctx) => ctx.db.get(shopId));
    expect(afterClear!.logo_storage_id).toBeUndefined();
  });

  test("an unauthenticated caller is rejected", async () => {
    const t = makeT();
    const { shopId } = await seedShopWithOwner(t, "f");
    const storageId = await storeFakeImage(t);

    await expect(
      t.mutation(api.shops.setShopLogo, { shopId, storageId }),
    ).rejects.toThrow("Not authenticated");
  });
});
