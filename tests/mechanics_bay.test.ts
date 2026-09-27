import { describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import { identityFor, makeT } from "./helpers";

type T = ReturnType<typeof makeT>;

/** Seed a user + shop + owner-role membership; returns ids and the Clerk subject. */
async function seedShopWithOwner(t: T, tag: string) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const ownerClerkId = `clerk_bay_owner_${tag}_${now}`;
    const ownerId = await ctx.db.insert("users", {
      clerkUserId: ownerClerkId,
      email: `${tag}-owner@test.local`,
      first_name: "Owner",
      role: "shop_owner",
      createdAt: now,
    });
    const shopId = await ctx.db.insert("shops", {
      name: `Bay Shop ${tag}`,
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

describe("mechanics.createManaged / updateManaged — bay entity type", () => {
  test("a bay only needs a name; a mechanic's last name is optional too", async () => {
    const t = makeT();
    const { ownerClerkId, shopId } = await seedShopWithOwner(t, "a");
    const asOwner = t.withIdentity(identityFor(ownerClerkId));

    const bayId = await asOwner.mutation(api.mechanics.createManaged, {
      shopId,
      firstName: "Heavy Lifting Bay",
      lastName: "",
      entityType: "bay",
    });

    const rows = await asOwner.query(api.mechanics.getManagedByShop, { shopId });
    const bayRow = rows.find((r: any) => r._id === bayId);
    expect(bayRow?.entityType).toBe("bay");
    expect(bayRow?.firstName).toBe("Heavy Lifting Bay");
    expect(bayRow?.lastName).toBe("");

    await expect(
      asOwner.mutation(api.mechanics.createManaged, {
        shopId,
        firstName: "",
        lastName: "",
        entityType: "bay",
      }),
    ).rejects.toThrow("Enter a bay name.");

    await expect(
      asOwner.mutation(api.mechanics.createManaged, {
        shopId,
        firstName: "",
        lastName: "",
      }),
    ).rejects.toThrow("Enter a first name.");

    const janeId = await asOwner.mutation(api.mechanics.createManaged, {
      shopId,
      firstName: "Jane",
      lastName: "",
    });
    const withJane = await asOwner.query(api.mechanics.getManagedByShop, { shopId });
    const janeRow = withJane.find((r: any) => r._id === janeId);
    expect(janeRow?.entityType).toBe("mechanic");
    expect(janeRow?.firstName).toBe("Jane");
    expect(janeRow?.lastName).toBe("");

    await asOwner.mutation(api.mechanics.updateManaged, {
      mechanicId: bayId,
      firstName: "Outside Bay",
      lastName: "",
      entityType: "bay",
    });
    const updatedRows = await asOwner.query(api.mechanics.getManagedByShop, { shopId });
    const updatedBay = updatedRows.find((r: any) => r._id === bayId);
    expect(updatedBay?.firstName).toBe("Outside Bay");
    expect(updatedBay?.entityType).toBe("bay");
  });
});
