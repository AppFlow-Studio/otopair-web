/**
 * getJobDetail is the single query that feeds the post-job survey on every
 * completion path (mechanic dashboard + owner booking panel). Two lifecycle
 * disconnects were fixed here:
 *
 *  1. Labor: a prejob/mid-job labor edit lands on booking_approvals.labor_hours.
 *     getJobDetail used to return the stale booking.estimated_labor_minutes, so
 *     the post-job Labor step showed the catalog time. It now derives from the
 *     same agreed approval row it already uses for parts.
 *  2. Layover: mid-job notes/photos (job_actuals.in_progress_*) must survive to
 *     the post-job — surfaced via jobActuals.inProgress* and NOT cleared on
 *     completion.
 */
import { describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import {
  identityFor,
  makeT,
  seedConfirmedBooking,
  type SeedResult,
} from "./helpers";

async function startJob(
  t: ReturnType<typeof makeT>,
  seed: SeedResult,
  jobActualExtra: Record<string, any> = {},
) {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.patch(seed.bookingId, { status: "in_progress" });
    await ctx.db.insert("job_actuals", {
      booking_id: seed.bookingId,
      mechanic_id: seed.mechanicId,
      started_at: now,
      created_at: now,
      updated_at: now,
      ...jobActualExtra,
    } as any);
  });
}

/** Insert an *agreed* approval carrying a labor edit — mirrors the shape
 *  submitPreJobEstimate / submitMidJobChange write. parts_snapshot +
 *  parts_subtotal_cents are what qualifies it as the agreed row in getJobDetail. */
async function agreeLabor(
  t: ReturnType<typeof makeT>,
  seed: SeedResult,
  cycle: "pre_job" | "mid_job",
  laborHours: number,
  submittedAtMs: number,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("booking_approvals", {
      booking_id: seed.bookingId,
      cycle,
      mechanic_set_price_cents: 10_000,
      parts_subtotal_cents: 0,
      parts_snapshot: [],
      labor_hours: laborHours,
      prior_ceiling_cents: 100_000,
      submitted_at_ms: submittedAtMs,
      decision: "approved",
      decided_at_ms: submittedAtMs,
    } as any);
  });
}

function detailFor(t: ReturnType<typeof makeT>, seed: SeedResult) {
  return t
    .withIdentity(identityFor(seed.ownerClerkId))
    .query(api.bookings.getJobDetail, { bookingId: seed.bookingId });
}

describe("getJobDetail — labor edits + layover carry-forward", () => {
  test("labor falls back to the booking estimate when nothing is agreed", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t, { estimatedLaborMinutes: 60 });
    await startJob(t, seed);
    const detail = await detailFor(t, seed);
    expect(detail?.estimatedLaborMinutes).toBe(60);
  });

  test("labor reflects the agreed pre_job edit, then the later mid_job edit", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t, { estimatedLaborMinutes: 60 });
    await startJob(t, seed);

    await agreeLabor(t, seed, "pre_job", 2, 1_000);
    expect((await detailFor(t, seed))?.estimatedLaborMinutes).toBe(120);

    // A later mid-job edit outranks the pre-job one (cycle rank, then recency).
    await agreeLabor(t, seed, "mid_job", 3, 2_000);
    expect((await detailFor(t, seed))?.estimatedLaborMinutes).toBe(180);
  });

  test("surfaces mid-job layover notes and photos through jobActuals", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t, { estimatedLaborMinutes: 60 });
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["photo-bytes"], { type: "image/jpeg" })),
    );
    await startJob(t, seed, {
      in_progress_notes: "Drain plug worn\nCustomer prefers Mobil 1",
      in_progress_photos: [
        { storage_id: storageId, caption: "leak", taken_at: 123 },
      ],
    });
    const detail = await detailFor(t, seed);
    expect(detail?.jobActuals?.inProgressNotes).toContain("Drain plug worn");
    expect(detail?.jobActuals?.inProgressPhotos).toHaveLength(1);
    expect(detail?.jobActuals?.inProgressPhotos?.[0]?.takenAt).toBe(123);
  });
});
