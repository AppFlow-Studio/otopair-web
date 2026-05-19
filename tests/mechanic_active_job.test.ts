import { describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import {
  identityFor,
  makeT,
  seedConfirmedBooking,
  seedInProgressBooking,
} from "./helpers";

/**
 * getActiveJobsForHeader (convex/bookings.ts:1307) is the query that powers
 * <ActiveJobStrip /> + the now-working overlay. Behavior depends on caller:
 *   - mechanic-membered user → { kind: "mechanic", job: { ... } | null }
 *   - owner/staff user       → { kind: "owner", count, firstBookingId }
 *   - signed-out / no shop   → null
 */

async function attachMechanicMembership(
  t: ReturnType<typeof makeT>,
  opts: {
    shopId: any;
    mechanicId: any;
    email?: string;
  },
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const mechanicClerkId = `clerk_mechanic_${now}_${Math.random().toString(36).slice(2)}`;
    const userId = await ctx.db.insert("users", {
      clerkUserId: mechanicClerkId,
      email: opts.email ?? "mechanic@test.local",
      first_name: "Bob",
      last_name: "Mechanic",
      role: "shop_mechanic",
      createdAt: now,
    } as any);
    await ctx.db.insert("shop_users", {
      user_id: userId,
      shop_id: opts.shopId,
      role: "shop_mechanic",
      mechanic_id: opts.mechanicId,
      is_active: true,
      created_at: now,
      updated_at: now,
    } as any);
    return { userId, mechanicClerkId };
  });
}

describe("MECH-* mechanic active job flow", () => {
  test("MECH-01: signed-in mechanic with running job sees mechanic shape + bookingId", async () => {
    const t = makeT();
    const seed = await seedInProgressBooking(t, {
      scheduledDate: "2026-05-18",
      scheduledTime: "10:00",
    });
    const mech = await attachMechanicMembership(t, {
      shopId: seed.shopId,
      mechanicId: seed.mechanicId,
    });

    const result = await t
      .withIdentity(identityFor(mech.mechanicClerkId))
      .query(api.bookings.getActiveJobsForHeader, {});

    expect(result).not.toBeNull();
    expect((result as any).kind).toBe("mechanic");
    expect((result as any).job).toMatchObject({
      bookingId: seed.bookingId,
    });
    expect((result as any).job.startedAtMs).toBeTypeOf("number");
  });

  test("MECH-02: mechanic with no active job → mechanic shape + job: null", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t); // confirmed, NOT in_progress
    const mech = await attachMechanicMembership(t, {
      shopId: seed.shopId,
      mechanicId: seed.mechanicId,
    });

    const result = await t
      .withIdentity(identityFor(mech.mechanicClerkId))
      .query(api.bookings.getActiveJobsForHeader, {});

    expect((result as any).kind).toBe("mechanic");
    expect((result as any).job).toBeNull();
  });

  test("MECH-03: owner identity returns owner-shape with count", async () => {
    const t = makeT();
    const seed = await seedInProgressBooking(t);

    const result = await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .query(api.bookings.getActiveJobsForHeader, {});

    expect((result as any).kind).toBe("owner");
    expect((result as any).count).toBeGreaterThanOrEqual(1);
    expect((result as any).firstBookingId).toBe(seed.bookingId);
  });

  test("MECH auth: anonymous caller returns null", async () => {
    const t = makeT();
    await seedInProgressBooking(t);

    const result = await t.query(api.bookings.getActiveJobsForHeader, {});
    expect(result).toBeNull();
  });

  test("MECH-01 isolation: another mechanic's in_progress booking does NOT surface for this mechanic", async () => {
    const t = makeT();
    const seedA = await seedInProgressBooking(t);
    // Seed a second in_progress booking under a different shop / mechanic.
    const seedB = await seedInProgressBooking(t);

    const mechA = await attachMechanicMembership(t, {
      shopId: seedA.shopId,
      mechanicId: seedA.mechanicId,
      email: "mechA@test.local",
    });

    const result = await t
      .withIdentity(identityFor(mechA.mechanicClerkId))
      .query(api.bookings.getActiveJobsForHeader, {});

    expect((result as any).kind).toBe("mechanic");
    expect((result as any).job?.bookingId).toBe(seedA.bookingId);
    // Mech A must NOT see Mech B's booking — different shop entirely.
    expect((result as any).job?.bookingId).not.toBe(seedB.bookingId);
  });
});
