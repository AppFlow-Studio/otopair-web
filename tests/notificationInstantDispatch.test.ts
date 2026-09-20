import { describe, it, expect } from "vitest";
import { internal } from "../convex/_generated/api";
import { makeT } from "./helpers";

/**
 * Instant-dispatch hardening (see convex/lib/notificationOutbox.ts +
 * convex/lib/push_dispatcher.ts):
 *   - all three claim mutations skip rows whose scheduled_for_ms is in the future
 *   - the deferred inspection-health job enqueues a "health score ready" push
 *   - resetStuckDispatching recovers rows stranded in `dispatching`
 *   - the receipt path promotes `dispatched` → `delivered`
 *
 * These drive the claim/record mutations directly (never the Expo-hitting
 * actions), mirroring how the existing outbox suites test delivery.
 */

const MIN = 60 * 1000;

function outboxRow(overrides: Record<string, any>) {
  const now = Date.now();
  return {
    channel: "push",
    category: "test",
    status: "pending",
    dedupe_key: `k_${now}_${Math.random().toString(36).slice(2)}`,
    payload: { title: "T", body: "B" },
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe("scheduled_for_ms gating in the claim mutations", () => {
  it("push claim skips future-dated rows and claims due ones", async () => {
    const t = makeT();
    const now = Date.now();

    const { dueId, futureId } = await t.run(async (ctx: any) => {
      const userId = await ctx.db.insert("users", {
        clerkUserId: `c_${now}`,
        email: "u@test.local",
        role: "user",
        createdAt: now,
        push_token: "ExponentPushToken[abc]",
      });
      const dueId = await ctx.db.insert(
        "notification_outbox",
        outboxRow({ user_id: userId, scheduled_for_ms: now - 1000 }),
      );
      const futureId = await ctx.db.insert(
        "notification_outbox",
        outboxRow({ user_id: userId, scheduled_for_ms: now + 10 * MIN }),
      );
      return { dueId, futureId };
    });

    const claimed: any[] = await t.mutation(
      internal.lib.push_dispatcher._claimPendingPushRows,
      {},
    );

    expect(claimed.map((c) => String(c.outboxId))).toEqual([String(dueId)]);

    const { due, future } = await t.run(async (ctx: any) => ({
      due: await ctx.db.get(dueId),
      future: await ctx.db.get(futureId),
    }));
    expect(due.status).toBe("dispatching"); // claimed
    expect(future.status).toBe("pending"); // left for later
  });

  it("sms and email claims skip future-dated rows", async () => {
    const t = makeT();
    const now = Date.now();

    const ids = await t.run(async (ctx: any) => {
      const smsDue = await ctx.db.insert(
        "notification_outbox",
        outboxRow({ channel: "sms", scheduled_for_ms: now - 1000 }),
      );
      const smsFuture = await ctx.db.insert(
        "notification_outbox",
        outboxRow({ channel: "sms", scheduled_for_ms: now + 10 * MIN }),
      );
      const emailDue = await ctx.db.insert(
        "notification_outbox",
        outboxRow({ channel: "email", scheduled_for_ms: now - 1000 }),
      );
      const emailFuture = await ctx.db.insert(
        "notification_outbox",
        outboxRow({ channel: "email", scheduled_for_ms: now + 10 * MIN }),
      );
      return { smsDue, smsFuture, emailDue, emailFuture };
    });

    const sms: any[] = await t.mutation(
      internal.sms_dispatcher.claimPendingSmsRows,
      {},
    );
    const email: any[] = await t.mutation(
      internal.email_dispatcher.claimPendingEmailRows,
      {},
    );

    expect(sms.map((c) => String(c.outboxId))).toEqual([String(ids.smsDue)]);
    expect(email.map((c) => String(c.outboxId))).toEqual([
      String(ids.emailDue),
    ]);
  });
});

describe("resetStuckDispatching", () => {
  it("re-queues rows stuck in dispatching, leaves fresh ones", async () => {
    const t = makeT();
    const now = Date.now();

    const { staleId, freshId } = await t.run(async (ctx: any) => {
      const staleId = await ctx.db.insert(
        "notification_outbox",
        outboxRow({ status: "dispatching", updated_at: now - 20 * MIN }),
      );
      const freshId = await ctx.db.insert(
        "notification_outbox",
        outboxRow({ status: "dispatching", updated_at: now }),
      );
      return { staleId, freshId };
    });

    const res = await t.mutation(
      internal.lib.push_dispatcher.resetStuckDispatching,
      {},
    );
    expect(res.reset).toBe(1);

    const { stale, fresh } = await t.run(async (ctx: any) => ({
      stale: await ctx.db.get(staleId),
      fresh: await ctx.db.get(freshId),
    }));
    expect(stale.status).toBe("pending");
    expect(fresh.status).toBe("dispatching");
  });
});

describe("push delivery receipts", () => {
  it("claims aged dispatched+ticket rows and promotes to delivered", async () => {
    const t = makeT();
    const now = Date.now();

    const { agedId, freshId } = await t.run(async (ctx: any) => {
      const agedId = await ctx.db.insert(
        "notification_outbox",
        outboxRow({
          status: "dispatched",
          push_ticket_id: "ticket-aged",
          processed_at: now - 5 * MIN,
        }),
      );
      // too fresh (< RECEIPT_MIN_AGE_MS) — not yet a candidate
      const freshId = await ctx.db.insert(
        "notification_outbox",
        outboxRow({
          status: "dispatched",
          push_ticket_id: "ticket-fresh",
          processed_at: now,
        }),
      );
      return { agedId, freshId };
    });

    const candidates: any[] = await t.mutation(
      internal.lib.push_dispatcher._claimReceiptCandidates,
      {},
    );
    expect(candidates.map((c) => String(c.outboxId))).toEqual([
      String(agedId),
    ]);

    await t.mutation(internal.lib.push_dispatcher._recordReceiptResults, {
      results: [{ outboxId: agedId, status: "delivered" }],
    });

    const { aged, fresh } = await t.run(async (ctx: any) => ({
      aged: await ctx.db.get(agedId),
      fresh: await ctx.db.get(freshId),
    }));
    expect(aged.status).toBe("delivered");
    expect(fresh.status).toBe("dispatched"); // untouched
  });
});

describe("deferred inspection-health push", () => {
  async function seed(t: ReturnType<typeof makeT>) {
    return await t.run(async (ctx: any) => {
      const now = Date.now();
      const userId = await ctx.db.insert("users", {
        clerkUserId: `c_health_${now}`,
        email: "health@test.local",
        role: "user",
        createdAt: now,
        push_token: "ExponentPushToken[health]",
      });
      const ownerId = await ctx.db.insert("vehicle_owners", {
        vin: "VINHEALTHTEST",
        user_id: userId,
        status: "active",
        mileage: 40000,
        knownIssues: [],
      });
      const bookingId = await ctx.db.insert("bookings", {
        vin: "VINHEALTHTEST",
        user_id: userId,
        service_ids: [],
        status: "completed",
        actual_duration_minutes: 60,
      });
      return { userId, ownerId, bookingId };
    });
  }

  it("enqueues a health-score push once, deduped on re-run", async () => {
    const t = makeT();
    const { userId, bookingId } = await seed(t);

    await t.mutation(
      internal.inspectionHealthDeferred.applyDeferredInspectionHealth,
      { bookingId },
    );

    const afterFirst = await t.run(async (ctx: any) =>
      ctx.db
        .query("notification_outbox")
        .withIndex("by_dedupe_key", (q: any) =>
          q.eq("dedupe_key", `health_ready:${String(bookingId)}`),
        )
        .collect(),
    );
    expect(afterFirst.length).toBe(1);
    expect(afterFirst[0].channel).toBe("push");
    expect(afterFirst[0].category).toBe("vehicle_health_score_ready");
    expect(String(afterFirst[0].user_id)).toBe(String(userId));

    // Re-run (booking reopened → completed again): still exactly one open row.
    await t.mutation(
      internal.inspectionHealthDeferred.applyDeferredInspectionHealth,
      { bookingId },
    );
    const afterSecond = await t.run(async (ctx: any) =>
      ctx.db
        .query("notification_outbox")
        .withIndex("by_dedupe_key", (q: any) =>
          q.eq("dedupe_key", `health_ready:${String(bookingId)}`),
        )
        .collect(),
    );
    expect(afterSecond.length).toBe(1);
  });
});
