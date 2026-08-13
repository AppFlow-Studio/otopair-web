import { makeFunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";

import { api } from "../convex/_generated/api";
import { identityFor, makeT, seedConfirmedBooking } from "./helpers";

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
