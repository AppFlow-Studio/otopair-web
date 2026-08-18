import { describe, it, expect } from "vitest";
import { api } from "../convex/_generated/api";
import { makeT, identityFor } from "./helpers";

// Smoke test for attachRealVinToManualVehicle: correcting a manually-added
// car's placeholder VIN to a real one, in place, must (a) move the VIN on the
// two identity rows + the VIN-string-keyed children and (b) leave everything
// keyed on the owner _id / vehicle _id exactly where it is.

const REAL_VIN = "1HGCM82633A004352"; // valid 17-char VIN (no I/O/Q)
const MANUAL_VIN = "MANUAL-1700000000-abc12345";
const CLERK = "clerk_attach_vin_user";

async function seedManualCar(t: any) {
  return await t.run(async (ctx: any) => {
    const now = 1700000000000;
    const userId = await ctx.db.insert("users", {
      clerkUserId: CLERK,
      email: "u@test.local",
      role: "user",
      createdAt: now,
    });
    const vehicleId = await ctx.db.insert("vehicles", {
      vin: MANUAL_VIN,
      year: 2020,
      metadata: { make: "Toyota", model: "Camry" },
      enriched_engine_config_id: "stale-manual-config", // should be cleared
      created_at: now,
      updated_at: now,
    });
    const ownerId = await ctx.db.insert("vehicle_owners", {
      vin: MANUAL_VIN,
      user_id: userId,
      status: "active",
      mileage: 42000,
      preOnboardingComplete: true,
    });
    // owner-scoped children — MUST stay on ownerId (owner _id never changes).
    const maintId = await ctx.db.insert("maintenance_records", {
      vehicleOwnerId: ownerId,
      type: "oil_change",
    });
    const classId = await ctx.db.insert("vehicle_classifications", {
      vehicle_owner_id: ownerId,
      vehicle_mode: "commuter",
    });
    // vehicle-scoped child — MUST stay on vehicleId.
    const convoId = await ctx.db.insert("ai_conversations", {
      user_id: userId,
      vehicle_id: vehicleId,
      started_at: now,
    });
    // VIN-string children — MUST move to REAL_VIN.
    const bookingId = await ctx.db.insert("bookings", {
      user_id: userId,
      vin: MANUAL_VIN,
      service_ids: [],
      status: "completed",
    });
    const hpId = await ctx.db.insert("vehicle_health_points", {
      vin: MANUAL_VIN,
      user_id: userId,
      points: 12,
      updated_at: now,
    });
    return { userId, vehicleId, ownerId, maintId, classId, convoId, bookingId, hpId };
  });
}

describe("attachRealVinToManualVehicle", () => {
  it("corrects the VIN in place and transfers all history", async () => {
    const t = makeT();
    const seed = await seedManualCar(t);

    const res: any = await t
      .withIdentity(identityFor(CLERK))
      .mutation(api.vehicles.attachRealVinToManualVehicle, {
        manualVehicleOwnerId: seed.ownerId,
        realVin: REAL_VIN,
        year: 2020,
        make: "Toyota",
        model: "Camry",
      });

    expect(res.success).toBe(true);
    expect(res.vin).toBe(REAL_VIN);
    expect(res.vehicleOwnerId).toBe(seed.ownerId); // same identity, not a new one

    await t.run(async (ctx: any) => {
      const owner = await ctx.db.get(seed.ownerId);
      expect(owner.vin).toBe(REAL_VIN);
      expect(owner.mileage).toBe(42000); // context preserved (same row)
      expect(owner.preOnboardingComplete).toBe(true);

      const veh = await ctx.db.get(seed.vehicleId);
      expect(veh.vin).toBe(REAL_VIN);
      expect(veh.enriched_engine_config_id).toBeUndefined(); // config reset for re-enrich

      // VIN-string children moved.
      const booking = await ctx.db.get(seed.bookingId);
      expect(booking.vin).toBe(REAL_VIN);
      const hp = await ctx.db.get(seed.hpId);
      expect(hp.vin).toBe(REAL_VIN);

      // owner-scoped children untouched.
      const maint = await ctx.db.get(seed.maintId);
      expect(maint.vehicleOwnerId).toBe(seed.ownerId);
      const cls = await ctx.db.get(seed.classId);
      expect(cls.vehicle_owner_id).toBe(seed.ownerId);

      // vehicle-scoped child untouched.
      const convo = await ctx.db.get(seed.convoId);
      expect(convo.vehicle_id).toBe(seed.vehicleId);
    });
  });

  it("is idempotent on a retry once the VIN is already real", async () => {
    const t = makeT();
    const seed = await seedManualCar(t);
    const id = identityFor(CLERK);
    const args = {
      manualVehicleOwnerId: seed.ownerId,
      realVin: REAL_VIN,
      make: "Toyota",
      model: "Camry",
    };
    await t.withIdentity(id).mutation(api.vehicles.attachRealVinToManualVehicle, args);
    const res2: any = await t
      .withIdentity(id)
      .mutation(api.vehicles.attachRealVinToManualVehicle, args);
    expect(res2.alreadyReal).toBe(true);
  });

  it("refuses when the user already owns that VIN as another car", async () => {
    const t = makeT();
    const seed = await seedManualCar(t);
    await t.run(async (ctx: any) => {
      await ctx.db.insert("vehicle_owners", {
        vin: REAL_VIN,
        user_id: seed.userId,
        status: "active",
      });
    });
    await expect(
      t.withIdentity(identityFor(CLERK)).mutation(
        api.vehicles.attachRealVinToManualVehicle,
        { manualVehicleOwnerId: seed.ownerId, realVin: REAL_VIN, make: "Toyota", model: "Camry" },
      ),
    ).rejects.toThrow(/already have this VIN/i);
  });
});
