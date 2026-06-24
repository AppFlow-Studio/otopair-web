import { describe, it, expect } from "vitest";
import { makeT } from "./helpers";
import { api } from "../convex/_generated/api";

describe("applyVehicleTruth", () => {
  async function seed(t: any) {
    return await t.run(async (ctx: any) => {
      const userId = await ctx.db.insert("users", { clerkUserId: "clerk_vt", email: "vt@test.local", role: "user", createdAt: 1 });
      const vehicleId = await ctx.db.insert("vehicles", { vin: "VTVIN0000000000001" } as any);
      const ownerId = await ctx.db.insert("vehicle_owners", {
        vin: "VTVIN0000000000001", user_id: userId, status: "active", mileage: 40000, preOnboardingComplete: true,
      } as any);
      const serviceId = await ctx.db.insert("services", { name: "Oil Change", slug: "oil_change" } as any);
      return { userId, vehicleId, ownerId, serviceId };
    });
  }
  const ident = { subject: "clerk_vt", tokenIdentifier: "clerk_vt" };

  it("writes a plausible mileage + provenance", async () => {
    const t = makeT(); const s = await seed(t);
    const res = await t.withIdentity(ident).mutation(api.vehicleTruth.applyVehicleTruth, { vehicle_id: s.vehicleId, mileage: 46796 });
    expect(res.needsReconfirm).toBeFalsy();
    const owner = await t.run((ctx: any) => ctx.db.get(s.ownerId));
    expect(owner.mileage).toBe(46796);
    expect(owner.mileage_source).toBe("chat_self_reported");
    expect(typeof owner.mileage_updated_at).toBe("number");
  });
  it("refuses a backward odometer (needsReconfirm), no write", async () => {
    const t = makeT(); const s = await seed(t);
    const res = await t.withIdentity(ident).mutation(api.vehicleTruth.applyVehicleTruth, { vehicle_id: s.vehicleId, mileage: 30000 });
    expect(res.needsReconfirm).toBe(true);
    expect(res.reason).toBe("backward");
    const owner = await t.run((ctx: any) => ctx.db.get(s.ownerId));
    expect(owner.mileage).toBe(40000);
  });
  it("adds the service warning-light code to knownIssues from a maintenance-reminder claim", async () => {
    const t = makeT(); const s = await seed(t);
    await t.withIdentity(ident).mutation(api.vehicleTruth.applyVehicleTruth, {
      vehicle_id: s.vehicleId, service_claims: [{ service_slug: "oil_change", kind: "light_on" }],
    });
    const owner = await t.run((ctx: any) => ctx.db.get(s.ownerId));
    expect((owner.knownIssues ?? []).includes("oil_pressure")).toBe(true);
  });
  it("appends a fault light to knownIssues", async () => {
    const t = makeT(); const s = await seed(t);
    await t.withIdentity(ident).mutation(api.vehicleTruth.applyVehicleTruth, { vehicle_id: s.vehicleId, fault_lights: ["check_engine"] });
    const owner = await t.run((ctx: any) => ctx.db.get(s.ownerId));
    expect((owner.knownIssues ?? []).includes("check_engine")).toBe(true);
  });
});
