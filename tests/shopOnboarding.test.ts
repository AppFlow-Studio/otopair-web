import { describe, expect, test } from "vitest";
import { api, internal } from "../convex/_generated/api";
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

// Bug #354: Step 0 saves carry the pin from the same Google place as the
// address; an address change without one clears the old pin; a mistyped
// state's automatic timezone is re-derived when the state is corrected.
const JERICHO = {
  address: "350 Jericho Turnpike",
  city: "Jericho",
  state: "NY",
  zipCode: "11753",
  lat: 40.7918,
  lng: -73.5397,
};

async function seedOwnedShop(
  t: ReturnType<typeof makeT>,
  shop: {
    address?: string;
    city?: string;
    state?: string;
    zip?: string;
    lat?: number;
    lng?: number;
    timezone?: string;
    status?: string;
    slug?: string;
  }
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const ownerClerkId = `clerk_shop_owner_${now}_${Math.random().toString(36).slice(2)}`;
    const ownerId = await ctx.db.insert("users", {
      clerkUserId: ownerClerkId,
      email: "owner@test.local",
      first_name: "Owner",
      role: "shop_owner",
      onboardingCompleted: false,
      createdAt: now,
    });
    const shopId = await ctx.db.insert("shops", {
      name: "Jericho Auto",
      owner_user_id: ownerId,
      is_active: true,
      ...shop,
    });
    await ctx.db.insert("shop_users", {
      shop_id: shopId,
      user_id: ownerId,
      role: "shop_owner",
      is_active: true,
      invited_at: now,
      accepted_at: now,
      created_at: now,
      updated_at: now,
    });
    return { ownerClerkId, shopId };
  });
}

function saveStepZero(
  t: ReturnType<typeof makeT>,
  ownerClerkId: string,
  args: {
    address: string;
    city: string;
    state: string;
    zipCode: string;
    lat?: number;
    lng?: number;
  }
) {
  return t.withIdentity(identityFor(ownerClerkId)).mutation(api.shops.upsertOnboardingShopDetails, {
    name: "Jericho Auto",
    slug: "jericho-auto",
    phone: "(516) 555-0199",
    ...args,
  });
}

describe("upsertOnboardingShopDetails location (bug #354)", () => {
  test("an invite-created shop's one-line address is replaced by one checked place with its pin", async () => {
    const t = makeT();
    // What approveApplication creates: the application's one line, nothing else.
    const seed = await seedOwnedShop(t, { address: "Jericho, NY", status: "active" });

    await saveStepZero(t, seed.ownerClerkId, JERICHO);

    const shop = await t.run(async (ctx) => await ctx.db.get(seed.shopId));
    expect(shop).toMatchObject({
      address: "350 Jericho Turnpike",
      city: "Jericho",
      state: "NY",
      zip: "11753",
      lat: 40.7918,
      lng: -73.5397,
      timezone: "America/New_York",
    });
  });

  test("a brand-new shop is inserted with its pin", async () => {
    const t = makeT();
    const ownerClerkId = `clerk_new_owner_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const shopId = await saveStepZero(t, ownerClerkId, JERICHO);

    const shop = await t.run(async (ctx) => await ctx.db.get(shopId));
    expect(shop).toMatchObject({ lat: 40.7918, lng: -73.5397, zip: "11753" });
  });

  test("an address change without coordinates clears the old pin", async () => {
    const t = makeT();
    const seed = await seedOwnedShop(t, {
      address: JERICHO.address,
      city: JERICHO.city,
      state: JERICHO.state,
      zip: JERICHO.zipCode,
      lat: JERICHO.lat,
      lng: JERICHO.lng,
      timezone: "America/New_York",
    });

    // An older portal build: no lat/lng, different ZIP.
    await saveStepZero(t, seed.ownerClerkId, {
      address: JERICHO.address,
      city: JERICHO.city,
      state: JERICHO.state,
      zipCode: "11791",
    });

    const shop = await t.run(async (ctx) => await ctx.db.get(seed.shopId));
    expect(shop?.zip).toBe("11791");
    expect(shop?.lat).toBeUndefined();
    expect(shop?.lng).toBeUndefined();
  });

  test("an unchanged address saved without coordinates keeps its pin", async () => {
    const t = makeT();
    const seed = await seedOwnedShop(t, {
      address: JERICHO.address,
      city: JERICHO.city,
      state: JERICHO.state,
      zip: JERICHO.zipCode,
      lat: JERICHO.lat,
      lng: JERICHO.lng,
    });

    await saveStepZero(t, seed.ownerClerkId, {
      address: JERICHO.address,
      city: JERICHO.city,
      state: JERICHO.state,
      zipCode: JERICHO.zipCode,
    });

    const shop = await t.run(async (ctx) => await ctx.db.get(seed.shopId));
    expect(shop).toMatchObject({ lat: JERICHO.lat, lng: JERICHO.lng });
  });

  test("coordinates sent with an unchanged address are written (backfill)", async () => {
    const t = makeT();
    // A coherent legacy shop saved before pins were stored.
    const seed = await seedOwnedShop(t, {
      address: JERICHO.address,
      city: JERICHO.city,
      state: JERICHO.state,
      zip: JERICHO.zipCode,
    });

    await saveStepZero(t, seed.ownerClerkId, JERICHO);

    const shop = await t.run(async (ctx) => await ctx.db.get(seed.shopId));
    expect(shop).toMatchObject({ lat: JERICHO.lat, lng: JERICHO.lng });
  });

  test("half a coordinate pair or an impossible value is refused", async () => {
    const t = makeT();
    const seed = await seedOwnedShop(t, { address: "Jericho, NY" });

    await expect(
      saveStepZero(t, seed.ownerClerkId, { ...JERICHO, lng: undefined })
    ).rejects.toThrow(/map location/);
    await expect(
      saveStepZero(t, seed.ownerClerkId, { ...JERICHO, lat: 140 })
    ).rejects.toThrow(/map location/);

    const shop = await t.run(async (ctx) => await ctx.db.get(seed.shopId));
    expect(shop?.address).toBe("Jericho, NY");
  });

  test("correcting the state re-derives the automatic timezone it left behind", async () => {
    const t = makeT();
    // First save had the placeholder state: TX → America/Chicago automatically.
    const seed = await seedOwnedShop(t, {
      address: "Jericho, NY",
      city: "Austin",
      state: "TX",
      zip: "78701",
      timezone: "America/Chicago",
    });

    await saveStepZero(t, seed.ownerClerkId, JERICHO);

    const shop = await t.run(async (ctx) => await ctx.db.get(seed.shopId));
    expect(shop?.timezone).toBe("America/New_York");
  });

  test("a manually-set timezone survives a state change", async () => {
    const t = makeT();
    const seed = await seedOwnedShop(t, {
      address: "Jericho, NY",
      city: "Austin",
      state: "TX",
      zip: "78701",
      timezone: "America/Denver",
    });

    await saveStepZero(t, seed.ownerClerkId, JERICHO);

    const shop = await t.run(async (ctx) => await ctx.db.get(seed.shopId));
    expect(shop?.timezone).toBe("America/Denver");
  });

  test("the same state keeps whatever timezone is stored", async () => {
    const t = makeT();
    const seed = await seedOwnedShop(t, {
      address: JERICHO.address,
      city: JERICHO.city,
      state: "NY",
      zip: JERICHO.zipCode,
      timezone: "America/Chicago",
    });

    await saveStepZero(t, seed.ownerClerkId, JERICHO);

    const shop = await t.run(async (ctx) => await ctx.db.get(seed.shopId));
    expect(shop?.timezone).toBe("America/Chicago");
  });
});

describe("shop address repair migration (bug #354)", () => {
  test("report flags the mixed record and the address-only shop, not a coherent pinned one", async () => {
    const t = makeT();
    const mixed = await seedOwnedShop(t, {
      address: "39 Cameron Ave, Staten Island, NY 10305",
      city: "Autsin",
      state: "TX",
      zip: "23123",
      timezone: "America/Chicago",
    });
    const addressOnly = await seedOwnedShop(t, { address: "86th St, Brooklyn, NY" });
    const coherent = await seedOwnedShop(t, {
      address: JERICHO.address,
      city: JERICHO.city,
      state: JERICHO.state,
      zip: JERICHO.zipCode,
      lat: JERICHO.lat,
      lng: JERICHO.lng,
    });

    const result = await t.query(internal.migrations.shopAddressRepair.report, {});
    const byId = new Map(result.flagged.map((row) => [String(row.shopId), row]));

    expect(byId.get(String(mixed.shopId))?.issues).toEqual([
      "address_includes_city_state",
      "address_state_mismatch",
      "address_zip_mismatch",
      "missing_coordinates",
    ]);
    expect(byId.get(String(mixed.shopId))?.stateTimezone).toBe("America/Chicago");
    expect(byId.get(String(addressOnly.shopId))?.issues).toEqual([
      "address_includes_city_state",
      "missing_city",
      "missing_state",
      "missing_zip",
      "missing_coordinates",
    ]);
    expect(byId.has(String(coherent.shopId))).toBe(false);
  });

  test("repairShopAddress dry-runs first, then writes the confirmed address and pin", async () => {
    const t = makeT();
    const seed = await seedOwnedShop(t, {
      address: "Jericho, NY",
      city: "Austin",
      state: "TX",
      zip: "78701",
      timezone: "America/Chicago",
    });
    const args = {
      shopId: seed.shopId,
      address: JERICHO.address,
      city: JERICHO.city,
      state: "ny",
      zipCode: JERICHO.zipCode,
      lat: JERICHO.lat,
      lng: JERICHO.lng,
    };

    const preview = await t.mutation(internal.migrations.shopAddressRepair.repairShopAddress, {
      ...args,
      dryRun: true,
    });
    expect(preview.after).toMatchObject({ state: "NY", lat: JERICHO.lat, timezone: "America/Chicago" });
    expect(preview.stateTimezone).toBe("America/New_York");
    const untouched = await t.run(async (ctx) => await ctx.db.get(seed.shopId));
    expect(untouched?.city).toBe("Austin");

    await t.mutation(internal.migrations.shopAddressRepair.repairShopAddress, {
      ...args,
      timezone: "America/New_York",
      dryRun: false,
    });
    const repaired = await t.run(async (ctx) => await ctx.db.get(seed.shopId));
    expect(repaired).toMatchObject({
      address: JERICHO.address,
      city: "Jericho",
      state: "NY",
      zip: "11753",
      lat: JERICHO.lat,
      lng: JERICHO.lng,
      timezone: "America/New_York",
    });
  });

  test("repairShopAddress refuses an address line that still carries city/state/ZIP", async () => {
    const t = makeT();
    const seed = await seedOwnedShop(t, { address: "39 Cameron Ave, Staten Island, NY 10305" });

    await expect(
      t.mutation(internal.migrations.shopAddressRepair.repairShopAddress, {
        shopId: seed.shopId,
        address: "39 Cameron Ave, Staten Island, NY 10305",
        city: "Staten Island",
        state: "NY",
        zipCode: "10305",
        dryRun: true,
      })
    ).rejects.toThrow(/street line/);
  });
});
