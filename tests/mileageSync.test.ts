/**
 * End-to-end mileage sync across the two stores.
 *
 * `mileageResolution.test.ts` covers the pure `resolveVehicleMileage` decision.
 * This file covers the wiring that makes every surface USE it: the shared
 * `getResolvedMileageForVin` / `resolveMileageForOwner` loaders (Part A), and the
 * write-side timestamp discipline on the driver's app-entry path (Part B) that
 * keeps the resolver's recency comparison honest.
 */
import { describe, expect, it } from "vitest";
import { makeT } from "./helpers";
import { api } from "../convex/_generated/api";
import {
  getResolvedMileageForVin,
  resolveMileageForOwner,
} from "../convex/lib/mileage";

const T = 1_700_000_000_000;
const DAY = 86_400_000;
const VIN = "1HGCM82633A004352";

async function seedUser(ctx: any, email = "driver@test.local") {
  return await ctx.db.insert("users", {
    clerkUserId: `clerk_${email}_${Math.random().toString(36).slice(2)}`,
    email,
    first_name: "Driver",
    role: "user",
    createdAt: T,
  });
}

describe("getResolvedMileageForVin", () => {
  it("hands back the driver's newer app entry over a stale shop passport", async () => {
    const t = makeT();
    const out = await t.run(async (ctx) => {
      const userId = await seedUser(ctx);
      await ctx.db.insert("vehicle_passports", {
        vin: VIN,
        mileage: 37_376,
        last_reported_at: T - 30 * DAY,
      });
      await ctx.db.insert("vehicle_owners", {
        vin: VIN,
        user_id: userId,
        status: "active",
        is_primary: true,
        mileage: 49_350,
        mileage_updated_at: T,
      } as any);
      // Lowercase input must still resolve — the helper normalizes the VIN.
      return await getResolvedMileageForVin(ctx, VIN.toLowerCase());
    });
    expect(out).toEqual({ mileage: 49_350, from: "owner" });
  });

  it("keeps the shop passport when it is the newer of the two", async () => {
    const t = makeT();
    const out = await t.run(async (ctx) => {
      const userId = await seedUser(ctx);
      await ctx.db.insert("vehicle_passports", {
        vin: VIN,
        mileage: 51_000,
        last_reported_at: T,
      });
      await ctx.db.insert("vehicle_owners", {
        vin: VIN,
        user_id: userId,
        status: "active",
        is_primary: true,
        mileage: 49_000,
        mileage_updated_at: T - DAY,
      } as any);
      return await getResolvedMileageForVin(ctx, VIN);
    });
    expect(out).toEqual({ mileage: 51_000, from: "passport" });
  });

  it("prefers the active + primary owner row when several exist", async () => {
    const t = makeT();
    const out = await t.run(async (ctx) => {
      const u1 = await seedUser(ctx, "a@test.local");
      const u2 = await seedUser(ctx, "b@test.local");
      // An inactive row with a wilder number must be ignored.
      await ctx.db.insert("vehicle_owners", {
        vin: VIN,
        user_id: u1,
        status: "inactive",
        mileage: 999_999,
        mileage_updated_at: T,
      } as any);
      await ctx.db.insert("vehicle_owners", {
        vin: VIN,
        user_id: u2,
        status: "active",
        is_primary: true,
        mileage: 49_350,
        mileage_updated_at: T,
      } as any);
      return await getResolvedMileageForVin(ctx, VIN);
    });
    expect(out).toEqual({ mileage: 49_350, from: "owner" });
  });

  it("returns empty when the VIN has neither store", async () => {
    const t = makeT();
    const out = await t.run((ctx) => getResolvedMileageForVin(ctx, VIN));
    expect(out).toEqual({ mileage: null, from: null });
  });
});

describe("resolveMileageForOwner", () => {
  it("resolves the given owner against its VIN's passport", async () => {
    const t = makeT();
    const out = await t.run(async (ctx) => {
      const userId = await seedUser(ctx);
      await ctx.db.insert("vehicle_passports", {
        vin: VIN,
        mileage: 37_376,
        last_reported_at: T - 30 * DAY,
      });
      const ownerId = await ctx.db.insert("vehicle_owners", {
        vin: VIN,
        user_id: userId,
        status: "active",
        mileage: 49_350,
        mileage_updated_at: T,
      } as any);
      const owner = await ctx.db.get(ownerId);
      return await resolveMileageForOwner(ctx, owner);
    });
    expect(out).toEqual({ mileage: 49_350, from: "owner" });
  });

  it("returns the owner value when there is no passport for the VIN", async () => {
    const t = makeT();
    const out = await t.run(async (ctx) => {
      const userId = await seedUser(ctx);
      const ownerId = await ctx.db.insert("vehicle_owners", {
        vin: VIN,
        user_id: userId,
        status: "active",
        mileage: 42_000,
        mileage_updated_at: T,
      } as any);
      const owner = await ctx.db.get(ownerId);
      return await resolveMileageForOwner(ctx, owner);
    });
    expect(out).toEqual({ mileage: 42_000, from: "owner" });
  });
});

describe("vehicles.updateMileage write coherence", () => {
  it("stamps mileage_updated_at + source so the resolver can rank it by recency", async () => {
    const t = makeT();
    const { userId, ownerId } = await t.run(async (ctx) => {
      const userId = await seedUser(ctx);
      const ownerId = await ctx.db.insert("vehicle_owners", {
        vin: VIN,
        user_id: userId,
        status: "active",
        is_primary: true,
        mileage: 40_000,
        preOnboardingComplete: true,
      } as any);
      return { userId, ownerId };
    });

    await t.mutation(api.vehicles.updateMileage, {
      vin: VIN,
      userId,
      mileage: 49_350,
    });

    const owner = await t.run((ctx) => ctx.db.get(ownerId));
    expect(owner?.mileage).toBe(49_350);
    expect(owner?.mileage_source).toBe("app_self_reported");
    expect(typeof owner?.mileage_updated_at).toBe("number");

    // And the value the shop reads now follows the driver's entry.
    const resolved = await t.run((ctx) => getResolvedMileageForVin(ctx, VIN));
    expect(resolved.mileage).toBe(49_350);
  });
});
