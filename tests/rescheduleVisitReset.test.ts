import { describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import type { Doc } from "../convex/_generated/dataModel";
import { identityFor, makeT, seedConfirmedBooking } from "./helpers";

async function seedVisitDraft(t: ReturnType<typeof makeT>, seed: Awaited<ReturnType<typeof seedConfirmedBooking>>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const photoId = await ctx.storage.store(
      new Blob(["prior visit"], { type: "image/jpeg" }),
    );
    await ctx.db.patch(seed.bookingId, {
      vehicle_arrived_at_ms: now - 5_000,
      vehicle_arrived_by_user_id: seed.ownerId,
      diagnostic_checklist: [{ label: "Check battery", status: "checked" }],
      diagnostic_checklist_completed_at_ms: now - 1_000,
      diagnostic_findings_note: "Battery tested",
      diagnostic_followup_state: "resolved",
    });
    const jobActualId = await ctx.db.insert("job_actuals", {
      booking_id: seed.bookingId,
      mechanic_id: seed.mechanicId,
      prejob_report: {
        mileage: 14_570,
        front_tire_condition: null,
        rear_tire_condition: null,
      },
      mpi_started_at: now,
      mpi_completed_at: now + 1_000,
      created_at: now,
      updated_at: now,
    });
    const inspectionId = await ctx.db.insert("vehicle_inspections", {
      booking_id: seed.bookingId,
      job_actual_id: jobActualId,
      vin: "1HGCM82633A004352",
      shop_id: seed.shopId,
      mechanic_id: seed.mechanicId,
      template_version: "mpi-v1",
      odometer: 14_570,
      zones: [
        {
          zone_id: "FL",
          done: true,
          done_phase: "pre",
          photo_ids: [photoId],
        },
      ],
      findings_attention: [],
      findings_monitor: [],
      created_at: now,
      updated_at: now,
    });
    return { jobActualId, inspectionId, photoId };
  });
}

describe("accepted reschedule visit reset", () => {
  test("manual reschedule starts with a fresh inspection and pre-job report", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t, {
      scheduledDate: "2026-05-19",
      scheduledTime: "14:00",
      status: "vehicle_at_shop",
      seedWideOpenHours: true,
    });
    const draft = await seedVisitDraft(t, seed);

    await t.withIdentity(identityFor(seed.ownerClerkId)).mutation(api.bookings.proposeReschedule, {
      bookingId: seed.bookingId,
      newScheduledDate: "2026-05-20",
      newScheduledTime: "10:00",
    });
    await t.withIdentity(identityFor(seed.customerClerkId)).mutation(
      api.bookings.customerApproveReschedule,
      { bookingId: seed.bookingId },
    );

    const state = await t.run(async (ctx) => ({
      inspection: (await ctx.db.get(draft.inspectionId)) as Doc<"vehicle_inspections"> | null,
      actual: (await ctx.db.get(draft.jobActualId)) as Doc<"job_actuals"> | null,
      booking: (await ctx.db.get(seed.bookingId)) as Doc<"bookings"> | null,
      photo: await ctx.db.system.get("_storage", draft.photoId),
    }));
    expect(state.inspection).toBeNull();
    expect(state.photo).toBeNull();
    expect(state.actual?.prejob_report).toBeUndefined();
    expect(state.actual?.mpi_started_at).toBeUndefined();
    expect(state.actual?.mpi_completed_at).toBeUndefined();
    expect(state.booking?.vehicle_arrived_at_ms).toBeUndefined();
    expect(state.booking?.vehicle_arrived_by_user_id).toBeUndefined();
    expect(state.booking?.diagnostic_checklist).toBeUndefined();
    expect(state.booking?.diagnostic_checklist_completed_at_ms).toBeUndefined();
    expect(state.booking?.diagnostic_findings_note).toBeUndefined();
    expect(state.booking?.diagnostic_followup_state).toBeUndefined();
  });

  test("forced-delay acceptance preserves an onsite inspection", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t, {
      scheduledDate: "2026-05-19",
      scheduledTime: "14:00",
      status: "vehicle_at_shop",
      seedWideOpenHours: true,
    });
    const draft = await seedVisitDraft(t, seed);

    await t.withIdentity(identityFor(seed.ownerClerkId)).mutation(api.bookings.proposeReschedule, {
      bookingId: seed.bookingId,
      newScheduledDate: "2026-05-19",
      newScheduledTime: "15:00",
      mode: "forced_delay",
      customerCanRestoreOriginal: false,
    });
    await t.withIdentity(identityFor(seed.customerClerkId)).mutation(
      api.bookings.customerApproveReschedule,
      { bookingId: seed.bookingId },
    );

    const state = await t.run(async (ctx) => ({
      inspection: (await ctx.db.get(draft.inspectionId)) as Doc<"vehicle_inspections"> | null,
      actual: (await ctx.db.get(draft.jobActualId)) as Doc<"job_actuals"> | null,
      booking: (await ctx.db.get(seed.bookingId)) as Doc<"bookings"> | null,
      photo: await ctx.db.system.get("_storage", draft.photoId),
    }));
    expect(state.inspection).not.toBeNull();
    expect(state.photo).not.toBeNull();
    expect(state.actual?.prejob_report).toEqual({
      mileage: 14_570,
      front_tire_condition: null,
      rear_tire_condition: null,
    });
    expect(state.booking?.vehicle_arrived_at_ms).toBeTypeOf("number");
    expect(state.booking?.diagnostic_checklist).toEqual([
      { label: "Check battery", status: "checked" },
    ]);
  });
});
