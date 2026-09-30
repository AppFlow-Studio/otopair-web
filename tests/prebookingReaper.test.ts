// Bug #393 — orphan $20 checkout authorizations. The Stripe half of the
// reaper runs in an action and isn't exercised here; these cover the
// transactional handshake it depends on (convex/lib/prebookingAuthorization.ts
// + the internal mutations in convex/payments_stripe.ts + the booking commit
// in bookings.recordPreauthorizedQuoteDeposit / createBatchImpl).
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import {
  PREBOOKING_CANCEL_RETRY_AFTER_MS,
  PREBOOKING_CANCEL_RETRY_WINDOW_MS,
  PREBOOKING_REAP_AFTER_MS,
  PREBOOKING_STALE_CLAIM_MS,
  prebookingReapDecision,
} from "../convex/lib/prebookingAuthorization";
import { identityFor, makeT } from "./helpers";

const NOW = new Date("2026-05-30T12:00:00-04:00").getTime();
const QUOTE_DATE = "2026-06-01"; // Monday, inside seeded hours
const PI = "pi_prebooking_test";

beforeEach(() => {
  // Fake timers keep the reaper actions these mutations schedule from ever
  // running (they would call Stripe).
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

async function seed() {
  const t = makeT();
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const customerId = await ctx.db.insert("users", {
      clerkUserId: "prebook_customer",
      email: "prebook@test.local",
      first_name: "Customer",
      role: "user",
    } as never);
    const shopId = await ctx.db.insert("shops", {
      name: "Prebook Shop",
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
    await ctx.db.insert("services", {
      name: "Tire Replacement",
      slug: "tire-replacement",
      default_labor_hours: 0.5,
      created_at: now,
    } as never);
    const bookingId = await ctx.db.insert("bookings", {
      user_id: customerId,
      vin: "1HGCM82633A004352",
      service_ids: [],
      status: "quotes_ready",
      created_at: now,
      updated_at: now,
    } as never);
    const responseId = await ctx.db.insert("tire_quote_responses", {
      booking_id: bookingId,
      shop_id: shopId,
      mechanic_id: mechanicId,
      quantity: 4,
      labor_cost: 150,
      total: 590,
      availability: { date: QUOTE_DATE, time: "09:00" },
      estimated_duration_minutes: 30,
      created_at: now,
      tire_brand: "Michelin",
      per_tire_price: 110,
    } as never);
    const sessionId = "tire-checkout-session";
    const holdId = await ctx.db.insert("slot_holds", {
      shop_id: shopId,
      mechanic_id: mechanicId,
      date: QUOTE_DATE,
      start_time: "09:00",
      end_time: "09:30",
      duration_minutes: 30,
      held_by: customerId,
      session_id: sessionId,
      expires_at: now + 15 * 60 * 1000,
      status: "active",
      created_at: now,
      quote_type: "tire",
      quote_revision: 1,
      tire_quote_response_id: responseId,
    } as never);
    return { customerId, shopId, mechanicId, bookingId, responseId, holdId, sessionId };
  });
  return { t, ids };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

function acceptWithPreauth({ t, ids }: Seeded) {
  return t.withIdentity(identityFor("prebook_customer")).mutation(
    api.bookings.acceptTireQuote,
    {
      booking_id: ids.bookingId,
      response_id: ids.responseId,
      scheduled_date: QUOTE_DATE,
      scheduled_time: "09:00",
      hold_id: ids.holdId,
      session_id: ids.sessionId,
      quote_revision: 1,
      preauthorized_payment: {
        stripe_payment_intent_id: PI,
        idempotency_key: "idem-prebook",
        hold_amount_cents: 2000,
        payment_origin: "card",
      },
    } as never,
  );
}

async function recordAuthorization({ t, ids }: Seeded) {
  return (await t.mutation(internal.payments_stripe._recordPrebookingAuthorization, {
    paymentIntentId: PI,
    userId: ids.customerId,
    shopId: ids.shopId,
    attemptId: "attempt-1",
  })) as Id<"prebooking_authorizations">;
}

async function readRow(t: Seeded["t"], id: Id<"prebooking_authorizations">) {
  return await t.run((ctx) => ctx.db.get(id));
}

describe("prebookingReapDecision", () => {
  const base = { reap_after_ms: NOW - 1, updated_at: NOW - 1 };

  test("a payments row wins: link an authorizing row, skip anything else", () => {
    expect(
      prebookingReapDecision({ ...base, state: "authorizing" }, { hasPaymentRow: true, now: NOW }),
    ).toBe("link");
    expect(
      prebookingReapDecision({ ...base, state: "linked" }, { hasPaymentRow: true, now: NOW }),
    ).toBe("skip");
  });

  test("claims an unlinked authorization only once it is due", () => {
    expect(
      prebookingReapDecision(
        { ...base, state: "authorizing", reap_after_ms: NOW + 1 },
        { hasPaymentRow: false, now: NOW },
      ),
    ).toBe("skip");
    expect(
      prebookingReapDecision({ ...base, state: "authorizing" }, { hasPaymentRow: false, now: NOW }),
    ).toBe("claim");
    expect(
      prebookingReapDecision({ ...base, state: "linked" }, { hasPaymentRow: false, now: NOW }),
    ).toBe("skip");
    expect(
      prebookingReapDecision({ ...base, state: "cancelled" }, { hasPaymentRow: false, now: NOW }),
    ).toBe("skip");
  });

  test("re-claims a stale reaping claim, and retries failed cancels inside the window", () => {
    expect(
      prebookingReapDecision({ ...base, state: "reaping" }, { hasPaymentRow: false, now: NOW }),
    ).toBe("skip");
    expect(
      prebookingReapDecision(
        { ...base, state: "reaping", updated_at: NOW - PREBOOKING_STALE_CLAIM_MS },
        { hasPaymentRow: false, now: NOW },
      ),
    ).toBe("claim");
    expect(
      prebookingReapDecision(
        { ...base, state: "cancel_failed", updated_at: NOW - PREBOOKING_CANCEL_RETRY_AFTER_MS },
        { hasPaymentRow: false, now: NOW },
      ),
    ).toBe("claim");
    expect(
      prebookingReapDecision(
        {
          state: "cancel_failed",
          reap_after_ms: NOW - PREBOOKING_CANCEL_RETRY_WINDOW_MS - 1,
          updated_at: NOW - PREBOOKING_CANCEL_RETRY_AFTER_MS,
        },
        { hasPaymentRow: false, now: NOW },
      ),
    ).toBe("skip");
  });
});

describe("prebooking authorization handshake (bug #393)", () => {
  test("recording a PI is idempotent and due 30 minutes out", async () => {
    const s = await seed();
    const id = await recordAuthorization(s);
    expect(await recordAuthorization(s)).toBe(id);
    const row = await readRow(s.t, id);
    expect(row).toMatchObject({
      payment_intent_id: PI,
      user_id: s.ids.customerId,
      shop_id: s.ids.shopId,
      attempt_id: "attempt-1",
      state: "authorizing",
      reap_after_ms: NOW + PREBOOKING_REAP_AFTER_MS,
    });
    const count = await s.t.run(
      async (ctx) => (await ctx.db.query("prebooking_authorizations").collect()).length,
    );
    expect(count).toBe(1);
  });

  test("the claim is refused before reap_after", async () => {
    const s = await seed();
    const id = await recordAuthorization(s);
    const claimed = await s.t.mutation(internal.payments_stripe._claimPrebookingForReap, {
      paymentIntentId: PI,
    });
    expect(claimed).toBe(false);
    expect((await readRow(s.t, id))?.state).toBe("authorizing");
  });

  test("the claim returns false and links when a payments row already uses the PI", async () => {
    const s = await seed();
    const id = await recordAuthorization(s);
    await s.t.run((ctx) =>
      ctx.db.insert("payments", {
        booking_id: s.ids.bookingId,
        user_id: s.ids.customerId,
        shop_id: s.ids.shopId,
        amount: 20,
        status: "processing",
        stripe_payment_intent_id: PI,
      }),
    );
    vi.setSystemTime(NOW + PREBOOKING_REAP_AFTER_MS + 1);
    const claimed = await s.t.mutation(internal.payments_stripe._claimPrebookingForReap, {
      paymentIntentId: PI,
    });
    expect(claimed).toBe(false);
    expect(await readRow(s.t, id)).toMatchObject({
      state: "linked",
      linked_booking_id: s.ids.bookingId,
    });
  });

  test("an orphan is claimed once, then finished as cancelled", async () => {
    const s = await seed();
    const id = await recordAuthorization(s);
    vi.setSystemTime(NOW + PREBOOKING_REAP_AFTER_MS + 1);
    expect(
      await s.t.mutation(internal.payments_stripe._claimPrebookingForReap, { paymentIntentId: PI }),
    ).toBe(true);
    expect((await readRow(s.t, id))?.state).toBe("reaping");
    // A second (duplicate-scheduled) reaper doesn't also claim it.
    expect(
      await s.t.mutation(internal.payments_stripe._claimPrebookingForReap, { paymentIntentId: PI }),
    ).toBe(false);
    await s.t.mutation(internal.payments_stripe._finishPrebookingReap, {
      paymentIntentId: PI,
      outcome: "cancelled",
    });
    expect((await readRow(s.t, id))?.state).toBe("cancelled");
  });

  test("a booking commit on a reaped authorization is CHECKOUT_EXPIRED and rolls back", async () => {
    const s = await seed();
    const id = await recordAuthorization(s);
    // Make it due without moving the clock (the quote and its checkout hold
    // would expire first and mask the reaper refusal).
    await s.t.run((ctx) => ctx.db.patch(id, { reap_after_ms: NOW - 1 }));
    expect(
      await s.t.mutation(internal.payments_stripe._claimPrebookingForReap, { paymentIntentId: PI }),
    ).toBe(true);

    await expect(acceptWithPreauth(s)).rejects.toMatchObject({
      data: { code: "CHECKOUT_EXPIRED" },
    });

    const after = await s.t.run(async (ctx) => ({
      booking: await ctx.db.get(s.ids.bookingId),
      payments: await ctx.db
        .query("payments")
        .withIndex("by_booking_id", (q) => q.eq("booking_id", s.ids.bookingId))
        .collect(),
      row: await ctx.db.get(id),
    }));
    // The whole accept rolled back: no confirmed booking on a cancelled PI.
    expect(after.booking?.status).toBe("quotes_ready");
    expect(after.payments).toHaveLength(0);
    expect(after.row?.state).toBe("reaping");
  });

  test("a booking commit links an authorizing row, and the reaper then skips it", async () => {
    const s = await seed();
    const id = await recordAuthorization(s);
    await acceptWithPreauth(s);

    expect(await readRow(s.t, id)).toMatchObject({
      state: "linked",
      linked_booking_id: s.ids.bookingId,
    });
    vi.setSystemTime(NOW + PREBOOKING_REAP_AFTER_MS + 1);
    expect(
      await s.t.mutation(internal.payments_stripe._claimPrebookingForReap, { paymentIntentId: PI }),
    ).toBe(false);
    expect((await readRow(s.t, id))?.state).toBe("linked");
  });

  test("a PI with no row (older flows) books exactly as before", async () => {
    const s = await seed();
    await acceptWithPreauth(s);
    const payments = await s.t.run((ctx) =>
      ctx.db
        .query("payments")
        .withIndex("by_booking_id", (q) => q.eq("booking_id", s.ids.bookingId))
        .collect(),
    );
    expect(payments).toHaveLength(1);
    expect(payments[0].stripe_payment_intent_id).toBe(PI);
  });

  test("the safety sweep re-queues only due orphans", async () => {
    const s = await seed();
    await s.t.run(async (ctx) => {
      const row = (state: string, reapAfter: number, updatedAt = NOW) =>
        ctx.db.insert("prebooking_authorizations", {
          payment_intent_id: `pi_${state}_${reapAfter}`,
          user_id: s.ids.customerId,
          state,
          reap_after_ms: reapAfter,
          created_at: NOW - PREBOOKING_REAP_AFTER_MS,
          updated_at: updatedAt,
        } as never);
      await row("authorizing", NOW - 60_000); // missed by the scheduler → due
      await row("authorizing", NOW + 60_000); // not yet due
      await row("linked", NOW - 60_000);
      await row("cancelled", NOW - 60_000);
      await row("reaping", NOW - 60_000, NOW - 1_000); // live claim
      await row("reaping", NOW - 60_000, NOW - PREBOOKING_STALE_CLAIM_MS); // dead reaper → due
    });
    const result = await s.t.mutation(
      internal.payments_stripe.sweepPrebookingAuthorizations,
      {},
    );
    expect(result).toEqual({ scheduled: 2 });
  });
});
