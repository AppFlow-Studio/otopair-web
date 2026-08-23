import { makeFunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";

import { api } from "../convex/_generated/api";
import { identityFor, makeT, seedConfirmedBooking } from "./helpers";
import { INSPECTION_TEMPLATE_VERSION } from "../lib/inspection-template";

const deleteInspectionPhoto = makeFunctionReference<"mutation">(
  "inspections:deleteInspectionPhoto",
);
const attachInspectionPhoto = makeFunctionReference<"mutation">(
  "inspections:attachInspectionPhoto",
);
const prepareInspectionPhotoUpload = makeFunctionReference<"mutation">(
  "inspections:prepareInspectionPhotoUpload",
);

describe("inspection photos", () => {
  it("resolves saved previews and permanently deletes an authorized photo", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    const storageId = await t.run((ctx) =>
      ctx.storage.store(new Blob(["inspection"], { type: "image/jpeg" })),
    );
    await t.run((ctx) =>
      ctx.db.insert("vehicle_inspections", {
        booking_id: seed.bookingId,
        vin: "1HGCM82633A004352",
        shop_id: seed.shopId,
        mechanic_id: seed.mechanicId,
        template_version: "mpi-v1",
        zones: [
          {
            zone_id: "FL",
            done: true,
            photo_ids: [storageId],
          },
        ],
        findings_attention: [],
        findings_monitor: [],
        created_at: Date.now(),
        updated_at: Date.now(),
      }),
    );

    const owner = t.withIdentity(identityFor(seed.ownerClerkId));
    const saved = await owner.query(api.inspections.getByBooking, {
      bookingId: seed.bookingId,
    });
    expect(saved?.photo_urls?.[storageId]).toMatch(/^https?:/);

    await expect(
      t
        .withIdentity(identityFor(seed.customerClerkId))
        .mutation(deleteInspectionPhoto, {
          bookingId: seed.bookingId,
          storageId,
        }),
    ).rejects.toThrow("Not authorized");

    await owner.mutation(deleteInspectionPhoto, {
      bookingId: seed.bookingId,
      storageId,
    });

    const reopened = await owner.query(api.inspections.getByBooking, {
      bookingId: seed.bookingId,
    });
    expect(reopened?.zones[0]?.photo_ids).toEqual([]);
    expect(await t.run((ctx) => ctx.storage.getUrl(storageId))).toBeNull();
  });

  it("rejects deletion through a different booking and supports secure staging", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    const otherBookingId = await t.run((ctx) =>
      ctx.db.insert("bookings", {
        user_id: seed.customerId,
        shop_id: seed.shopId,
        mechanic_id: seed.mechanicId,
        vin: "1HGCM82633A004352",
        service_ids: [],
        scheduled_date: "2026-05-18",
        scheduled_time: "14:00",
        status: "confirmed",
        created_at: Date.now(),
        updated_at: Date.now(),
      }),
    );
    const oldUnassociatedStorageId = await t.run((ctx) =>
      ctx.storage.store(new Blob(["older"], { type: "image/jpeg" })),
    );
    const owner = t.withIdentity(identityFor(seed.ownerClerkId));
    const uploadToken = "test-upload-token";
    await owner.mutation(prepareInspectionPhotoUpload, {
      bookingId: otherBookingId,
      zoneId: "FR",
      uploadToken,
    });
    await expect(
      owner.mutation(attachInspectionPhoto, {
        bookingId: otherBookingId,
        zoneId: "FR",
        storageId: oldUnassociatedStorageId,
        uploadToken,
      }),
    ).rejects.toThrow("not authorized");
    const storageId = await t.run((ctx) =>
      ctx.storage.store(new Blob(["staged"], { type: "image/jpeg" })),
    );

    await owner.mutation(attachInspectionPhoto, {
      bookingId: otherBookingId,
      zoneId: "FR",
      storageId,
      uploadToken,
    });
    await expect(
      owner.mutation(deleteInspectionPhoto, {
        bookingId: seed.bookingId,
        storageId,
      }),
    ).rejects.toThrow("does not belong");
    expect(await t.run((ctx) => ctx.storage.getUrl(storageId))).not.toBeNull();

    await owner.mutation(deleteInspectionPhoto, {
      bookingId: otherBookingId,
      storageId,
    });
    expect(await t.run((ctx) => ctx.storage.getUrl(storageId))).toBeNull();
  });
});

describe("zone checkpoints", () => {
  // Abdul, Aug 20: "I wish you did checkpoints — how quick I'm spending on each
  // section." Successive completed_at values are what make that measurable.
  const prejob = {
    mileage: 42_000,
    front_tire_condition: null,
    rear_tire_condition: null,
  } as any;

  function inspectionWith(done: boolean) {
    return {
      template_version: INSPECTION_TEMPLATE_VERSION,
      odometer: 42_000,
      zones: [
        {
          zone_id: "FL",
          done,
          measures: { tread: "8", psi: "35" },
          tri: { wear: "g", brake_visual: "g" },
          text: { tire_brand: "Michelin", tire_model: "Defender", tire_size: "225/45R17" },
          select: { run_flat: "no", tire_type: "All-Season" },
        },
      ],
      findings_attention: [],
      findings_monitor: [],
    } as any;
  }

  async function readCompletedAt(t: ReturnType<typeof makeT>, bookingId: any) {
    return t.run(async (ctx) => {
      const row = await ctx.db
        .query("vehicle_inspections")
        .withIndex("by_booking", (q: any) => q.eq("booking_id", bookingId))
        .first();
      return (row?.zones ?? []).find((z: any) => z.zone_id === "FL")
        ?.completed_at as number | undefined;
    });
  }

  it("stamps a zone the first time it is marked done and never moves it after", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t, { status: "vehicle_at_shop" });
    const owner = t.withIdentity(identityFor(seed.ownerClerkId));

    // Draft with the zone still open — nothing to stamp yet.
    await owner.mutation(api.bookings.savePrejob, {
      bookingId: seed.bookingId,
      prejob,
      inspection: inspectionWith(false),
    });
    // Convex serialises undefined to null across the t.run boundary.
    expect(await readCompletedAt(t, seed.bookingId)).toBeFalsy();

    // Marked complete — stamped.
    await owner.mutation(api.bookings.savePrejob, {
      bookingId: seed.bookingId,
      prejob,
      inspection: inspectionWith(true),
    });
    const first = await readCompletedAt(t, seed.bookingId);
    expect(typeof first).toBe("number");

    // Re-saved (mechanic reopened the zone to fix a reading). The clock must
    // not restart, or a correction reads as time spent inspecting.
    await owner.mutation(api.bookings.savePrejob, {
      bookingId: seed.bookingId,
      prejob,
      inspection: inspectionWith(true),
    });
    expect(await readCompletedAt(t, seed.bookingId)).toBe(first);
  });
});

describe("unaddressed findings", () => {
  // The list the mechanic overlay offers "Add to this job" from. A finding can
  // already be handled four ways by the time the job is running; re-offering one
  // that was is how the system starts reading as if it isn't following along.
  async function seedFlaggedWipers(t: ReturnType<typeof makeT>, seed: any) {
    await t.run(async (ctx) => {
      await ctx.db.insert("vehicle_inspections", {
        booking_id: seed.bookingId,
        vin: "1HGCM82633A004352",
        shop_id: seed.shopId,
        mechanic_id: seed.mechanicId,
        template_version: INSPECTION_TEMPLATE_VERSION,
        zones: [
          { zone_id: "FRT", done: true, tri: { wipe: "r" } },
        ],
        findings_attention: [],
        findings_monitor: [],
        created_at: Date.now(),
        updated_at: Date.now(),
      } as any);
    });
  }

  function findingsFor(t: ReturnType<typeof makeT>, seed: any) {
    return t
      .withIdentity(identityFor(seed.ownerClerkId))
      .query(api.inspections.getUnaddressedFindingsForBooking, {
        bookingId: seed.bookingId,
      });
  }

  it("offers a flagged finding nothing has acted on", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    await seedFlaggedWipers(t, seed);

    const out = await findingsFor(t, seed);
    expect(out.map((f: any) => f.label)).toContain("Wiper Blade Replacement");
  });

  it("drops it once an off-catalog line covers it", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    await seedFlaggedWipers(t, seed);
    await t.run(async (ctx) => {
      await ctx.db.insert("custom_jobs", {
        booking_id: seed.bookingId,
        shop_id: seed.shopId,
        vehicle_vin: "1HGCM82633A004352",
        name: "Replace wiper blades",
        normalized_name: "replace wiper blades",
        match_key: "blades replace wiper",
        source: "mid_job",
        status: "planned",
        created_at: Date.now(),
      } as any);
    });

    const out = await findingsFor(t, seed);
    expect(out.map((f: any) => f.label)).not.toContain("Wiper Blade Replacement");
  });

  it("keeps it when the customer DECLINED that line", async () => {
    // The tire the customer turned down is still worn. Arguably they need
    // telling more than anyone.
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    await seedFlaggedWipers(t, seed);
    await t.run(async (ctx) => {
      await ctx.db.insert("custom_jobs", {
        booking_id: seed.bookingId,
        shop_id: seed.shopId,
        vehicle_vin: "1HGCM82633A004352",
        name: "Replace wiper blades",
        normalized_name: "replace wiper blades",
        match_key: "blades replace wiper",
        source: "mid_job",
        status: "declined",
        created_at: Date.now(),
      } as any);
    });

    const out = await findingsFor(t, seed);
    expect(out.map((f: any) => f.label)).toContain("Wiper Blade Replacement");
  });

  it("drops it once it was filed as a recommendation instead", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    await seedFlaggedWipers(t, seed);
    const jobActualId = await t.run(async (ctx) =>
      ctx.db.insert("job_actuals", {
        booking_id: seed.bookingId,
        mechanic_id: seed.mechanicId,
        created_at: Date.now(),
        updated_at: Date.now(),
      } as any),
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("job_recommendations", {
        booking_id: seed.bookingId,
        job_actual_id: jobActualId,
        shop_id: seed.shopId,
        mechanic_id: seed.mechanicId,
        vehicle_vin: "1HGCM82633A004352",
        freeform_text: "Wiper Blade Replacement",
        urgency: "soon",
        visible_to_driver: false,
        status: "open",
        source: "inspection",
        created_at: Date.now(),
      } as any);
    });

    const out = await findingsFor(t, seed);
    expect(out.map((f: any) => f.label)).not.toContain("Wiper Blade Replacement");
  });
});
