/**
 * One pending ask at a time.
 *
 * performSubmission is the single funnel for all three approval cycles, but its
 * only duplicate protection was scoped to `post_job` (idempotent reuse, so a
 * double finalize can't open two rows). `pre_job` and `mid_job` had none — the
 * "you can't act while an approval is pending" rule lived entirely in the UI,
 * as a greyed-out button in the booking detail panel.
 *
 * Anything reaching the mutation without that UI inserted a SECOND open row,
 * overwrote payment_approval_state, and left two live SLA timers. The expiry
 * sweeper reverts a ceiling per row, so the first could roll back a ceiling the
 * customer had already approved past on the second.
 *
 * Withdraw is the escape hatch and already shipped — these tests pin that
 * withdraw-then-resubmit works, so the guard is a redirect and not a dead end.
 */
import { describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import {
  identityFor,
  makeT,
  seedConfirmedBooking,
  type SeedResult,
} from "./helpers";

const PENDING = "There's already a change waiting on the customer";

/** Put the booking in progress with a disclosed range, so a mid-job re-quote is
 *  legal and a big enough number lands out of range (pending, not auto-approved). */
async function inProgressWithRange(
  t: ReturnType<typeof makeT>,
  seed: SeedResult,
) {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.patch(seed.bookingId, {
      status: "in_progress",
      disclosed_range_low_cents: 5_000,
      disclosed_range_high_cents: 10_000,
    } as any);
    await ctx.db.insert("job_actuals", {
      booking_id: seed.bookingId,
      mechanic_id: seed.mechanicId,
      started_at: now,
      created_at: now,
      updated_at: now,
    } as any);
  });
}

function asOwner(t: ReturnType<typeof makeT>, seed: SeedResult) {
  return t.withIdentity(identityFor(seed.ownerClerkId));
}

/** Out of the disclosed range, so it lands pending rather than auto-approving. */
function outOfRangeChange(seed: SeedResult, laborHours: number) {
  return {
    bookingId: seed.bookingId,
    parts: [],
    laborHours,
    laborRateCents: 15_000,
  };
}

describe("open-approval guard", () => {
  test("a second mid-job re-quote is refused while one is pending", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    await inProgressWithRange(t, seed);
    const owner = asOwner(t, seed);

    await owner.mutation(
      api.booking_approvals.submitMidJobChange,
      outOfRangeChange(seed, 4),
    );

    await expect(
      owner.mutation(
        api.booking_approvals.submitMidJobChange,
        outOfRangeChange(seed, 5),
      ),
    ).rejects.toThrow(PENDING);

    // And only the first row exists — the refusal is not a partial write.
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("booking_approvals")
        .withIndex("by_booking_and_cycle", (q: any) =>
          q.eq("booking_id", seed.bookingId),
        )
        .collect(),
    );
    expect(rows).toHaveLength(1);
  });

  test("withdrawing releases the lock so the updated ask can be sent", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    await inProgressWithRange(t, seed);
    const owner = asOwner(t, seed);

    await owner.mutation(
      api.booking_approvals.submitMidJobChange,
      outOfRangeChange(seed, 4),
    );
    await owner.mutation(api.booking_approvals.withdrawPendingApproval, {
      bookingId: seed.bookingId,
    });

    // The whole point of the guard being a redirect rather than a wall.
    await expect(
      owner.mutation(
        api.booking_approvals.submitMidJobChange,
        outOfRangeChange(seed, 5),
      ),
    ).resolves.toBeTruthy();
  });

  test("an in-range change is refused too while a bigger ask is pending", async () => {
    // Accepted consequence of the strict rule: in-range normally auto-approves
    // and pushes "Service confirmed at $X — work is starting now". That must not
    // fire while the customer is looking at a different number.
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    await inProgressWithRange(t, seed);
    const owner = asOwner(t, seed);

    await owner.mutation(
      api.booking_approvals.submitMidJobChange,
      outOfRangeChange(seed, 4),
    );

    await expect(
      owner.mutation(api.booking_approvals.submitMidJobChange, {
        bookingId: seed.bookingId,
        parts: [],
        laborHours: 0.25,
        laborRateCents: 15_000,
      }),
    ).rejects.toThrow(PENDING);
  });

  test("a decided approval does not block the next one", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    await inProgressWithRange(t, seed);
    const owner = asOwner(t, seed);

    // Seed a settled row directly — any terminal decision should free the lock.
    await t.run(async (ctx) =>
      ctx.db.insert("booking_approvals", {
        booking_id: seed.bookingId,
        cycle: "mid_job",
        mechanic_set_price_cents: 20_000,
        parts_subtotal_cents: 0,
        labor_cents: 20_000,
        tax_cents: 0,
        service_fee_cents: 0,
        parts_snapshot: [],
        prior_ceiling_cents: 10_000,
        submitted_at_ms: 1_000,
        decision: "declined",
        decided_at_ms: 2_000,
      } as any),
    );

    await expect(
      owner.mutation(
        api.booking_approvals.submitMidJobChange,
        outOfRangeChange(seed, 4),
      ),
    ).resolves.toBeTruthy();
  });
});
