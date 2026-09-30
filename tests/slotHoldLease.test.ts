// Bug #393 — checkout holds that outlive the app. Covers the server-side
// answers in convex/slotHolds.ts + schedule.getActiveSlotHolds:
//   - held_by comes from auth, never the client's word for it
//   - per-customer supersede (only that customer's non-quote holds)
//   - the opt-in liveness lease + touchSlotHold heartbeat
//   - quote-accept holds exempt from the lease
//   - releaseSlotHold by the signed-in owner after a lost session id
//   - typed availability failures (SLOT_UNAVAILABLE wrap, QUOTE_UNAVAILABLE
//     passes through)
//   - getActiveSlotHolds `kind` / `hardExpiresAt`
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { SLOT_HOLD_LEASE_MS } from "../convex/slotHolds";
import { identityFor, makeT } from "./helpers";

const NOW = new Date("2026-10-01T12:00:00-04:00").getTime();
// A Monday (day_of_week 1) inside the seeded shop hours.
const DATE = "2026-10-05";
const TTL_MS = 15 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

async function seed() {
  const t = makeT();
  const ids = await t.run(async (ctx) => {
    const mkUser = (clerkUserId: string, role: string) =>
      ctx.db.insert("users", {
        clerkUserId,
        email: `${clerkUserId}@test.local`,
        first_name: clerkUserId,
        role,
      } as never);
    const ownerId = await mkUser("lease_owner", "shop_owner");
    const customerId = await mkUser("lease_customer", "user");
    const otherCustomerId = await mkUser("lease_other", "user");
    const shopId = await ctx.db.insert("shops", {
      name: "Lease Shop",
      owner_user_id: ownerId,
      is_active: true,
    } as never);
    const mechanicId = await ctx.db.insert("mechanics", {
      shop_id: shopId,
      first_name: "Dean",
      last_name: "Martin",
      is_active: true,
    });
    await ctx.db.insert("shops_hours", {
      shop_id: shopId,
      day_of_week: 1,
      day_name: "Mon",
      open_time: "08:00",
      close_time: "17:00",
      is_closed: false,
    });
    return { ownerId, customerId, otherCustomerId, shopId, mechanicId };
  });
  const customer = t.withIdentity(identityFor("lease_customer"));
  const other = t.withIdentity(identityFor("lease_other"));
  const owner = t.withIdentity(identityFor("lease_owner"));
  return { t, ids, customer, other, owner };
}

function holdArgs(
  ids: { shopId: Id<"shops">; mechanicId: Id<"mechanics"> },
  extra: Record<string, unknown>,
) {
  return {
    shop_id: ids.shopId,
    mechanic_id: ids.mechanicId,
    date: DATE,
    start_time: "09:00",
    duration_minutes: 60,
    ...extra,
  } as never;
}

async function insertTireQuote(
  t: ReturnType<typeof makeT>,
  ids: { customerId: Id<"users">; shopId: Id<"shops">; mechanicId: Id<"mechanics"> },
  opts: { expiresAt?: number } = {},
) {
  return t.run(async (ctx) => {
    const bookingId = await ctx.db.insert("bookings", {
      user_id: ids.customerId,
      vin: "1HGCM82633A004352",
      service_ids: [],
      status: "quotes_ready",
      created_at: NOW,
      updated_at: NOW,
    } as never);
    const responseId = await ctx.db.insert("tire_quote_responses", {
      booking_id: bookingId,
      shop_id: ids.shopId,
      mechanic_id: ids.mechanicId,
      quantity: 4,
      labor_cost: 150,
      total: 590,
      availability: { date: DATE, time: "13:00" },
      estimated_duration_minutes: 60,
      created_at: NOW,
      tire_brand: "Michelin",
      per_tire_price: 110,
      ...(opts.expiresAt != null ? { expires_at: opts.expiresAt } : {}),
    } as never);
    return { bookingId, responseId };
  });
}

describe("holdSlot ownership (bug #393)", () => {
  test("held_by is the signed-in customer, whatever the client sent", async () => {
    const { t, ids, customer } = await seed();
    const res = await customer.mutation(
      api.slotHolds.holdSlot,
      holdArgs(ids, { session_id: "s1", held_by: ids.otherCustomerId }),
    );
    const hold = await t.run((ctx) => ctx.db.get(res.holdId as Id<"slot_holds">));
    expect(hold?.held_by).toBe(ids.customerId);
  });

  test("a staff hold (no held_by) stays unowned", async () => {
    const { t, ids, owner } = await seed();
    const res = await owner.mutation(
      api.slotHolds.holdSlot,
      holdArgs(ids, { session_id: "drawer-1" }),
    );
    const hold = await t.run((ctx) => ctx.db.get(res.holdId as Id<"slot_holds">));
    expect(hold?.held_by).toBeUndefined();
  });

  test("a relaunched app's new hold supersedes only that customer's non-quote holds", async () => {
    const { t, ids, customer, other, owner } = await seed();
    // The killed session's hold on 09:00.
    const ghost = await customer.mutation(
      api.slotHolds.holdSlot,
      holdArgs(ids, { session_id: "killed", held_by: ids.customerId }),
    );
    // Untouchables: a staff drawer hold, another customer's hold, and this
    // customer's own quote-accept hold.
    const staff = await owner.mutation(
      api.slotHolds.holdSlot,
      holdArgs(ids, { session_id: "drawer", start_time: "11:00" }),
    );
    const others = await other.mutation(
      api.slotHolds.holdSlot,
      holdArgs(ids, {
        session_id: "other-app",
        held_by: ids.otherCustomerId,
        start_time: "14:30",
      }),
    );
    const { responseId } = await insertTireQuote(t, ids);
    const quote = await customer.mutation(
      api.slotHolds.holdSlot,
      holdArgs(ids, {
        session_id: "quote-checkout",
        held_by: ids.customerId,
        start_time: "13:00",
        quote_context: { quote_type: "tire", response_id: responseId },
      }),
    );

    // Relaunch: new session, same slot. Without the supersede the ghost would
    // block this very customer.
    const fresh = await customer.mutation(
      api.slotHolds.holdSlot,
      holdArgs(ids, { session_id: "relaunched", held_by: ids.customerId }),
    );
    expect(fresh.holdId).not.toBeNull();

    const rows = await t.run(async (ctx) => ({
      ghost: await ctx.db.get(ghost.holdId as Id<"slot_holds">),
      staff: await ctx.db.get(staff.holdId as Id<"slot_holds">),
      others: await ctx.db.get(others.holdId as Id<"slot_holds">),
      quote: await ctx.db.get(quote.holdId as Id<"slot_holds">),
      fresh: await ctx.db.get(fresh.holdId as Id<"slot_holds">),
    }));
    expect(rows.ghost).toBeNull();
    expect(rows.staff?.status).toBe("active");
    expect(rows.others?.status).toBe("active");
    expect(rows.quote?.status).toBe("active");
    expect(rows.quote?.quote_type).toBe("tire");
    expect(rows.fresh?.session_id).toBe("relaunched");
  });

  test("a staff caller never supersedes their own other holds", async () => {
    const { t, ids, owner } = await seed();
    const a = await owner.mutation(
      api.slotHolds.holdSlot,
      holdArgs(ids, { session_id: "tab-1" }),
    );
    const b = await owner.mutation(
      api.slotHolds.holdSlot,
      holdArgs(ids, { session_id: "tab-2", start_time: "11:00" }),
    );
    const rows = await t.run(async (ctx) => [
      await ctx.db.get(a.holdId as Id<"slot_holds">),
      await ctx.db.get(b.holdId as Id<"slot_holds">),
    ]);
    expect(rows.map((r) => r?.status)).toEqual(["active", "active"]);
  });

  test("a conflicting hold fails as typed SLOT_UNAVAILABLE", async () => {
    const { ids, customer, other } = await seed();
    await other.mutation(
      api.slotHolds.holdSlot,
      holdArgs(ids, { session_id: "other-app", held_by: ids.otherCustomerId }),
    );
    await expect(
      customer.mutation(
        api.slotHolds.holdSlot,
        holdArgs(ids, { session_id: "mine", held_by: ids.customerId }),
      ),
    ).rejects.toMatchObject({ data: { code: "SLOT_UNAVAILABLE" } });
  });

  test("QUOTE_UNAVAILABLE passes through untouched", async () => {
    const { t, ids, customer } = await seed();
    const { responseId } = await insertTireQuote(t, ids, { expiresAt: NOW - 1_000 });
    await expect(
      customer.mutation(
        api.slotHolds.holdSlot,
        holdArgs(ids, {
          session_id: "quote-checkout",
          held_by: ids.customerId,
          start_time: "13:00",
          quote_context: { quote_type: "tire", response_id: responseId },
        }),
      ),
    ).rejects.toMatchObject({ data: { code: "QUOTE_UNAVAILABLE" } });
  });

  test("the signed-in owner can release a hold after losing the session id", async () => {
    const { ids, customer, other } = await seed();
    const res = await customer.mutation(
      api.slotHolds.holdSlot,
      holdArgs(ids, { session_id: "killed", held_by: ids.customerId }),
    );
    const holdId = res.holdId as Id<"slot_holds">;
    // Another customer can't, even knowing the id.
    expect(
      await other.mutation(api.slotHolds.releaseSlotHold, {
        holdId,
        session_id: "guess",
      }),
    ).toEqual({ released: false });
    expect(
      await customer.mutation(api.slotHolds.releaseSlotHold, {
        holdId,
        session_id: "relaunched",
      }),
    ).toEqual({ released: true });
  });
});

describe("liveness lease (bug #393)", () => {
  test("lease: true lives one lease, capped by the Director TTL", async () => {
    const { t, ids, customer } = await seed();
    const res = await customer.mutation(
      api.slotHolds.holdSlot,
      holdArgs(ids, { session_id: "s1", held_by: ids.customerId, lease: true }),
    );
    expect(res.expiresAt).toBe(NOW + SLOT_HOLD_LEASE_MS);
    expect(res.hardExpiresAt).toBe(NOW + TTL_MS);
    expect(res.leaseMs).toBe(SLOT_HOLD_LEASE_MS);
    const hold = await t.run((ctx) => ctx.db.get(res.holdId as Id<"slot_holds">));
    expect(hold?.expires_at).toBe(NOW + SLOT_HOLD_LEASE_MS);
    expect(hold?.hard_expires_at).toBe(NOW + TTL_MS);
    expect(hold?.lease_ms).toBe(SLOT_HOLD_LEASE_MS);
  });

  test("a legacy hold (no lease) keeps the full TTL", async () => {
    const { ids, customer } = await seed();
    const res = await customer.mutation(
      api.slotHolds.holdSlot,
      holdArgs(ids, { session_id: "s1", held_by: ids.customerId }),
    );
    expect(res.expiresAt).toBe(NOW + TTL_MS);
    expect(res.leaseMs).toBeNull();
  });

  test("touch extends only past half the lease, and never beyond the cap", async () => {
    const { t, ids, customer } = await seed();
    const res = await customer.mutation(
      api.slotHolds.holdSlot,
      holdArgs(ids, { session_id: "s1", held_by: ids.customerId, lease: true }),
    );
    const holdId = res.holdId as Id<"slot_holds">;

    // 30s in: 60s of 90s left — more than half, so no write.
    vi.setSystemTime(NOW + 30_000);
    const early = await customer.mutation(api.slotHolds.touchSlotHold, {
      holdId,
      session_id: "s1",
    });
    expect(early.expiresAt).toBe(NOW + SLOT_HOLD_LEASE_MS);

    // 60s in: 30s left — extend to now + lease.
    vi.setSystemTime(NOW + 60_000);
    const extended = await customer.mutation(api.slotHolds.touchSlotHold, {
      holdId,
      session_id: "s1",
    });
    expect(extended.expiresAt).toBe(NOW + 60_000 + SLOT_HOLD_LEASE_MS);
    expect(extended.hardExpiresAt).toBe(NOW + TTL_MS);
    const row = await t.run((ctx) => ctx.db.get(holdId));
    expect(row?.expires_at).toBe(NOW + 60_000 + SLOT_HOLD_LEASE_MS);

    // Near the cap the extension stops at hard_expires_at. Keep the lease
    // alive up to there with touches every 60s.
    let at = NOW + 60_000;
    while (at + 60_000 < NOW + TTL_MS - 30_000) {
      at += 60_000;
      vi.setSystemTime(at);
      await customer.mutation(api.slotHolds.touchSlotHold, { holdId, session_id: "s1" });
    }
    vi.setSystemTime(NOW + TTL_MS - 20_000);
    const capped = await customer.mutation(api.slotHolds.touchSlotHold, {
      holdId,
      session_id: "s1",
    });
    expect(capped.expiresAt).toBe(NOW + TTL_MS);
  });

  test("a lapsed lease stops blocking and touch reports SLOT_HOLD_EXPIRED", async () => {
    const { ids, customer, other } = await seed();
    const res = await customer.mutation(
      api.slotHolds.holdSlot,
      holdArgs(ids, { session_id: "s1", held_by: ids.customerId, lease: true }),
    );
    const holdId = res.holdId as Id<"slot_holds">;

    // The app died: no heartbeat for more than one lease.
    vi.setSystemTime(NOW + SLOT_HOLD_LEASE_MS + 1_000);
    await expect(
      customer.mutation(api.slotHolds.touchSlotHold, { holdId, session_id: "s1" }),
    ).rejects.toMatchObject({ data: { code: "SLOT_HOLD_EXPIRED" } });

    // …and another customer can take the slot well before the 15-min TTL.
    const theirs = await other.mutation(
      api.slotHolds.holdSlot,
      holdArgs(ids, { session_id: "other-app", held_by: ids.otherCustomerId }),
    );
    expect(theirs.holdId).not.toBeNull();
  });

  test("touch from another session or another customer is SLOT_HOLD_EXPIRED", async () => {
    const { ids, customer, other } = await seed();
    const res = await customer.mutation(
      api.slotHolds.holdSlot,
      holdArgs(ids, { session_id: "s1", held_by: ids.customerId, lease: true }),
    );
    const holdId = res.holdId as Id<"slot_holds">;
    await expect(
      customer.mutation(api.slotHolds.touchSlotHold, { holdId, session_id: "s2" }),
    ).rejects.toMatchObject({ data: { code: "SLOT_HOLD_EXPIRED" } });
    await expect(
      other.mutation(api.slotHolds.touchSlotHold, { holdId, session_id: "s1" }),
    ).rejects.toMatchObject({ data: { code: "SLOT_HOLD_EXPIRED" } });
  });

  test("a re-hold on a leased session stays leased", async () => {
    const { ids, customer } = await seed();
    await customer.mutation(
      api.slotHolds.holdSlot,
      holdArgs(ids, { session_id: "s1", held_by: ids.customerId, lease: true }),
    );
    vi.setSystemTime(NOW + 10_000);
    const moved = await customer.mutation(
      api.slotHolds.holdSlot,
      holdArgs(ids, { session_id: "s1", held_by: ids.customerId, start_time: "10:30" }),
    );
    expect(moved.leaseMs).toBe(SLOT_HOLD_LEASE_MS);
    expect(moved.expiresAt).toBe(NOW + 10_000 + SLOT_HOLD_LEASE_MS);
  });

  test("quote-accept holds are exempt from the lease", async () => {
    const { t, ids, customer } = await seed();
    const { responseId } = await insertTireQuote(t, ids);
    const res = await customer.mutation(
      api.slotHolds.holdSlot,
      holdArgs(ids, {
        session_id: "quote-checkout",
        held_by: ids.customerId,
        start_time: "13:00",
        lease: true,
        quote_context: { quote_type: "tire", response_id: responseId },
      }),
    );
    expect(res.expiresAt).toBe(NOW + TTL_MS);
    expect(res.leaseMs).toBeNull();
    const hold = await t.run((ctx) => ctx.db.get(res.holdId as Id<"slot_holds">));
    expect(hold?.lease_ms).toBeUndefined();
  });
});

describe("schedule.getActiveSlotHolds kind (bug #393)", () => {
  test("labels customer, quote and staff holds and carries hardExpiresAt", async () => {
    const { t, ids, customer, other, owner } = await seed();
    await owner.mutation(
      api.slotHolds.holdSlot,
      holdArgs(ids, { session_id: "drawer", start_time: "11:00" }),
    );
    await other.mutation(
      api.slotHolds.holdSlot,
      holdArgs(ids, {
        session_id: "other-app",
        held_by: ids.otherCustomerId,
        lease: true,
      }),
    );
    const { responseId } = await insertTireQuote(t, ids);
    await customer.mutation(
      api.slotHolds.holdSlot,
      holdArgs(ids, {
        session_id: "quote-checkout",
        held_by: ids.customerId,
        start_time: "13:00",
        quote_context: { quote_type: "tire", response_id: responseId },
      }),
    );

    const holds = await owner.query(api.schedule.getActiveSlotHolds, {
      dateFrom: DATE,
      dateTo: DATE,
    });
    const byStart = Object.fromEntries(holds.map((h) => [h.startTime, h]));
    expect(byStart["11:00"]).toMatchObject({
      kind: "staff",
      expiresAt: NOW + TTL_MS,
      hardExpiresAt: NOW + TTL_MS,
    });
    expect(byStart["09:00"]).toMatchObject({
      kind: "customer_checkout",
      expiresAt: NOW + SLOT_HOLD_LEASE_MS,
      hardExpiresAt: NOW + TTL_MS,
    });
    expect(byStart["13:00"]).toMatchObject({ kind: "quote_checkout" });

    // The lapsed lease drops off the grid at its expiresAt.
    vi.setSystemTime(NOW + SLOT_HOLD_LEASE_MS + 1);
    const later = await owner.query(api.schedule.getActiveSlotHolds, {
      dateFrom: DATE,
      dateTo: DATE,
    });
    expect(later.map((h) => h.startTime).sort()).toEqual(["11:00", "13:00"]);
  });
});
