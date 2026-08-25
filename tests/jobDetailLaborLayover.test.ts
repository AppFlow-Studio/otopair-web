/**
 * getJobDetail is the single query that feeds the post-job survey on every
 * completion path (mechanic dashboard + owner booking panel). Two lifecycle
 * disconnects were fixed here:
 *
 *  1. Labor: a prejob/mid-job labor edit lands on the agreed approval row. The
 *     post-job Labor step seeds the BASE line from it — but the row also carries
 *     `labor_hours`, the whole-approval TOTAL (base service PLUS every custom job
 *     in scope). Seeding the base from that total folded custom-job labor into
 *     the base and the step then re-listed each custom job, DOUBLE-COUNTING it.
 *     getJobDetail now seeds the base from the recorded per-line breakdown
 *     (`labor_allocations["base"]`) — base-only by construction — and falls back
 *     to the booking's base estimate for legacy rows (never the conflated total).
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
 *  parts_subtotal_cents are what qualifies it as the agreed row in getJobDetail.
 *
 *  `laborHours` is the whole-approval TOTAL (what the scalar `labor_hours`
 *  holds). `baseHours` — when given — is the recorded per-line breakdown's base
 *  entry; omit it to simulate a LEGACY row written before the breakdown existed.
 *  `customHours` are extra custom-job lines in the breakdown (their sum, with
 *  base, should equal `laborHours`); they don't affect base derivation but make
 *  the fixture realistic. */
async function agreeLabor(
  t: ReturnType<typeof makeT>,
  seed: SeedResult,
  cycle: "pre_job" | "mid_job",
  {
    laborHours,
    baseHours,
    customHours = [],
    customAllocations,
    submittedAtMs,
  }: {
    laborHours: number;
    baseHours?: number;
    customHours?: number[];
    /** Explicit custom-line entries keyed by real custom-job id. Takes
     *  precedence over `customHours` (synthetic keys) when the test needs the
     *  breakdown to point at a specific custom_jobs row. */
    customAllocations?: Array<{ line_key: string; hours: number }>;
    submittedAtMs: number;
  },
) {
  const laborAllocations =
    baseHours !== undefined
      ? [
          { line_key: "base", hours: baseHours },
          ...(customAllocations ??
            customHours.map((hours, i) => ({
              line_key: `custom_${i}`,
              hours,
            }))),
        ]
      : undefined;
  await t.run(async (ctx) => {
    await ctx.db.insert("booking_approvals", {
      booking_id: seed.bookingId,
      cycle,
      mechanic_set_price_cents: 10_000,
      parts_subtotal_cents: 0,
      parts_snapshot: [],
      labor_hours: laborHours,
      ...(laborAllocations ? { labor_allocations: laborAllocations } : {}),
      prior_ceiling_cents: 100_000,
      submitted_at_ms: submittedAtMs,
      decision: "approved",
      decided_at_ms: submittedAtMs,
    } as any);
  });
}

/** Insert a custom_jobs line with a chosen estimate and update time. `updatedAt`
 *  is the lever the guard reads: <= the approval's submitted_at_ms means "as
 *  agreed" (recorded breakdown wins); greater means a later found-work edit
 *  (the live estimate wins). */
async function addCustomJob(
  t: ReturnType<typeof makeT>,
  seed: SeedResult,
  { estimatedMinutes, updatedAt }: { estimatedMinutes: number; updatedAt: number },
): Promise<string> {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("custom_jobs", {
      booking_id: seed.bookingId,
      shop_id: seed.shopId,
      vehicle_vin: "1HGCM82633A004352",
      name: "Coolant Flush",
      normalized_name: "coolant flush",
      match_key: "coolant flush",
      source: "mid_job",
      status: "planned",
      estimated_minutes: estimatedMinutes,
      created_at: updatedAt,
      updated_at: updatedAt,
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

  test("base line reflects the agreed pre_job edit, then the later mid_job edit", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t, { estimatedLaborMinutes: 60 });
    await startJob(t, seed);

    // Base-labor edit is recorded in the breakdown's "base" entry; the base
    // line carries it (here the approval is base-only, so total == base).
    await agreeLabor(t, seed, "pre_job", {
      laborHours: 2,
      baseHours: 2,
      submittedAtMs: 1_000,
    });
    expect((await detailFor(t, seed))?.estimatedLaborMinutes).toBe(120);

    // A later mid-job edit outranks the pre-job one (cycle rank, then recency).
    await agreeLabor(t, seed, "mid_job", {
      laborHours: 3,
      baseHours: 3,
      submittedAtMs: 2_000,
    });
    expect((await detailFor(t, seed))?.estimatedLaborMinutes).toBe(180);
  });

  test("base line is base-only, NOT the whole-approval total (double-count fix)", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t, { estimatedLaborMinutes: 48 });
    await startJob(t, seed);

    // The reported bug: an agreed approval added a custom job, so its TOTAL
    // labor_hours (1.3h = 0.8 base + 0.5 custom) exceeds the base. Seeding the
    // base line from the total double-counted the custom's 0.5h once the Labor
    // step re-listed it. The base line must show the recorded base (0.8h = 48m).
    await agreeLabor(t, seed, "mid_job", {
      laborHours: 1.3,
      baseHours: 0.8,
      customHours: [0.5],
      submittedAtMs: 1_000,
    });
    expect((await detailFor(t, seed))?.estimatedLaborMinutes).toBe(48);
  });

  test("legacy row without a breakdown falls back to the booking estimate, never the total", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t, { estimatedLaborMinutes: 60 });
    await startJob(t, seed);

    // A pre-breakdown approval only has the conflated scalar total (3h). With no
    // recorded per-line base, the base line must fall back to the booking's own
    // base estimate (60m) rather than billing the total as the base.
    await agreeLabor(t, seed, "mid_job", {
      laborHours: 3,
      submittedAtMs: 1_000,
    });
    expect((await detailFor(t, seed))?.estimatedLaborMinutes).toBe(60);
  });

  test("custom line seeds from the agreed breakdown when untouched since the agreement", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t, { estimatedLaborMinutes: 48 });
    await startJob(t, seed);

    // The line's stored estimate is 30m, but the mechanic set 0.7h (42m) for it
    // in the Labor step — recorded in the breakdown, never written back to the
    // row. It hasn't been touched since (updated_at 500 <= submitted_at 1000),
    // so the post-job step must seed from the agreed 0.7h.
    const jobId = await addCustomJob(t, seed, {
      estimatedMinutes: 30,
      updatedAt: 500,
    });
    await agreeLabor(t, seed, "mid_job", {
      laborHours: 1.5,
      baseHours: 0.8,
      customAllocations: [{ line_key: String(jobId), hours: 0.7 }],
      submittedAtMs: 1_000,
    });

    const detail = await detailFor(t, seed);
    expect(detail?.customLaborOverridesMinutes?.[String(jobId)]).toBe(42);
  });

  test("custom line edited AFTER the agreement keeps its live estimate (carryover wins)", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t, { estimatedLaborMinutes: 48 });
    await startJob(t, seed);

    // Same recorded 0.7h, but the mechanic re-set this line's labor in the
    // post-job found-work step (updated_at 2000 > submitted_at 1000). That live
    // edit must win, so the breakdown does NOT override it.
    const jobId = await addCustomJob(t, seed, {
      estimatedMinutes: 36,
      updatedAt: 2_000,
    });
    await agreeLabor(t, seed, "mid_job", {
      laborHours: 1.5,
      baseHours: 0.8,
      customAllocations: [{ line_key: String(jobId), hours: 0.7 }],
      submittedAtMs: 1_000,
    });

    const detail = await detailFor(t, seed);
    expect(detail?.customLaborOverridesMinutes?.[String(jobId)]).toBeUndefined();
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
