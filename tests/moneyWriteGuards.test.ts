/**
 * Write-side money guards.
 *
 *  - A part the shop is CHARGING for must have a name (#331): an unnamed $0.01
 *    manual part reached the customer's card-hold as a blank row. The estimate
 *    submit used to drop it silently, which billed less than the shop's own
 *    total showed; now it is refused with a message the shop can act on.
 *  - A declined request is not the price: the set price rolls back to the last
 *    agreed ceiling, as SLA expiry and "continue at original scope" already do.
 */
import { describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import {
  identityFor,
  makeT,
  seedConfirmedBooking,
  type SeedResult,
} from "./helpers";

async function inProgress(
  t: ReturnType<typeof makeT>,
  seed: SeedResult,
  extra: Record<string, unknown> = {},
) {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.patch(seed.bookingId, {
      status: "in_progress",
      disclosed_range_low_cents: 5_000,
      disclosed_range_high_cents: 10_000,
      ...extra,
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

const named = { part_name: "Oil Filter", oem_number: "04892339BE", cost: 9.36, quantity: 1 };

describe("an unnamed part with a price is refused (#331)", () => {
  test("mid-job estimate with a blank-named $0.01 part throws", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    await inProgress(t, seed);
    await expect(
      t.withIdentity(identityFor(seed.ownerClerkId)).mutation(
        api.booking_approvals.submitMidJobChange,
        {
          bookingId: seed.bookingId,
          parts: [named, { part_name: "  ", oem_number: "", cost: 0.01, quantity: 1 }],
          laborHours: 0.5,
          laborRateCents: 15_000,
        },
      ),
    ).rejects.toThrow("Every part with a price needs a name");
  });

  test("blank rows that charge nothing are just dropped", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    await inProgress(t, seed);
    await t.withIdentity(identityFor(seed.ownerClerkId)).mutation(
      api.booking_approvals.submitMidJobChange,
      {
        bookingId: seed.bookingId,
        parts: [
          named,
          { part_name: "", oem_number: "", cost: 0, quantity: 1 },
          { part_name: "", oem_number: "", cost: 5, quantity: 1, not_used: true },
          { part_name: "", oem_number: "", cost: 5, quantity: 1, supplied_by: "customer" },
        ],
        laborHours: 0.5,
        laborRateCents: 15_000,
      },
    );
    const row: any = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("booking_approvals")
          .withIndex("by_booking_and_cycle", (q: any) => q.eq("booking_id", seed.bookingId))
          .collect()
      )[0],
    );
    expect(row.parts_snapshot.map((p: any) => p.part_name)).toEqual(["Oil Filter"]);
  });
});

describe("a declined request is not the price", () => {
  test("declining a mid-job change rolls the set price back to the agreed ceiling", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    await inProgress(t, seed, {
      running_approved_ceiling_cents: 8_000,
      mechanic_set_price_cents: 8_000,
      payment_approval_state: "in_range",
    });
    // $600 of labor on an $80 agreement → out of range, waits on the customer.
    await t.withIdentity(identityFor(seed.ownerClerkId)).mutation(
      api.booking_approvals.submitMidJobChange,
      { bookingId: seed.bookingId, parts: [], laborHours: 4, laborRateCents: 15_000 },
    );
    const pending: any = await t.run((ctx) => ctx.db.get(seed.bookingId));
    expect(pending.mechanic_set_price_cents).toBeGreaterThan(8_000);

    await t.withIdentity(identityFor(seed.customerClerkId)).mutation(
      api.booking_approvals.applyApprovalDecision,
      { bookingId: seed.bookingId, decision: "declined" },
    );
    const after: any = await t.run((ctx) => ctx.db.get(seed.bookingId));
    expect(after.payment_approval_state).toBe("mid_job_declined");
    expect(after.mechanic_set_price_cents).toBe(8_000);
  });
});
