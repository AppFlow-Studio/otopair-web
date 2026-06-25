import { describe, it, expect } from "vitest";
import { makeT } from "./helpers";
import { api } from "../convex/_generated/api";
describe("upsertRecord clears the warning-light code", () => {
  it("removes the symptom from knownIssues when the service is recorded", async () => {
    const t = makeT();
    const ownerId = await t.run(async (ctx: any) => {
      const userId = await ctx.db.insert("users", { clerkUserId: "c_clr", email: "c@t.local", role: "user", createdAt: 1 });
      const oid = await ctx.db.insert("vehicle_owners", { vin: "CLRVIN000000000001", user_id: userId, status: "active", preOnboardingComplete: true, knownIssues: ["oil_pressure", "check_engine"] } as any);
      // seed an EXISTING record so upsertRecord UPDATES (isNewRecord=false → skips reward calls)
      await ctx.db.insert("maintenance_records", { vehicleOwnerId: oid, type: "oil", createdAt: 1, updatedAt: 1 } as any);
      return oid;
    });
    await t.mutation(api.maintenance.upsertRecord, { vehicleOwnerId: ownerId, type: "oil", lastServiceMileage: 50000 });
    const owner = await t.run((ctx: any) => ctx.db.get(ownerId));
    expect((owner.knownIssues ?? []).includes("oil_pressure")).toBe(false); // cleared
    expect((owner.knownIssues ?? []).includes("check_engine")).toBe(true);  // untouched
  });
});
