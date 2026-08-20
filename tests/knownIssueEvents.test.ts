import { describe, expect, it } from "vitest";
import { makeT } from "./helpers";
import { logKnownIssueEvents } from "../convex/lib/knownIssueEvents";

async function seedOwner(t: ReturnType<typeof makeT>) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      clerkUserId: "clerk_kie",
      email: "kie@test.local",
      role: "user",
      createdAt: 1,
    });
    const ownerId = await ctx.db.insert("vehicle_owners", {
      vin: "KIEVIN00000000001",
      user_id: userId,
      status: "active",
      knownIssues: [],
      preOnboardingComplete: true,
    } as any);
    return ownerId;
  });
}

describe("logKnownIssueEvents — provenance log for knownIssues", () => {
  it("logs one 'added' event per newly-added code", async () => {
    const t = makeT();
    const ownerId = await seedOwner(t);
    await t.run(async (ctx) => {
      await logKnownIssueEvents(ctx, {
        vehicleOwnerId: ownerId,
        before: [],
        after: ["oil_pressure", "abs"],
        source: "check_in",
        sourceDetail: "checkin_123",
        now: 1000,
      });
    });
    const rows = await t.run((ctx) =>
      ctx.db
        .query("known_issue_events")
        .withIndex("by_vehicle_owner_id", (q) => q.eq("vehicle_owner_id", ownerId))
        .collect(),
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.action === "added" && r.source === "check_in")).toBe(true);
    expect(new Set(rows.map((r) => r.code))).toEqual(new Set(["oil_pressure", "abs"]));
    expect(rows[0].source_detail).toBe("checkin_123");
    expect(rows[0].created_at).toBe(1000);
  });

  it("logs one 'cleared' event per removed code, and none for unchanged codes", async () => {
    const t = makeT();
    const ownerId = await seedOwner(t);
    await t.run(async (ctx) => {
      await logKnownIssueEvents(ctx, {
        vehicleOwnerId: ownerId,
        before: ["oil_pressure", "abs", "check_engine"],
        after: ["abs"],
        source: "service_completion",
        sourceDetail: "booking_456",
        now: 2000,
      });
    });
    const rows = await t.run((ctx) =>
      ctx.db
        .query("known_issue_events")
        .withIndex("by_vehicle_owner_id", (q) => q.eq("vehicle_owner_id", ownerId))
        .collect(),
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.action === "cleared")).toBe(true);
    expect(new Set(rows.map((r) => r.code))).toEqual(new Set(["oil_pressure", "check_engine"]));
    // "abs" is unchanged (present before and after) — no event for it.
    expect(rows.some((r) => r.code === "abs")).toBe(false);
  });

  it("logs both adds and clears from a single mixed diff", async () => {
    const t = makeT();
    const ownerId = await seedOwner(t);
    await t.run(async (ctx) => {
      await logKnownIssueEvents(ctx, {
        vehicleOwnerId: ownerId,
        before: ["oil_pressure"],
        after: ["tpms"],
        source: "oto",
        now: 3000,
      });
    });
    const rows = await t.run((ctx) =>
      ctx.db
        .query("known_issue_events")
        .withIndex("by_vehicle_owner_id", (q) => q.eq("vehicle_owner_id", ownerId))
        .collect(),
    );
    expect(rows).toHaveLength(2);
    const byCode = Object.fromEntries(rows.map((r) => [r.code, r.action]));
    expect(byCode).toEqual({ oil_pressure: "cleared", tpms: "added" });
    // Oto had no sourceDetail — confirm it's genuinely absent, not a stray string.
    expect(rows.every((r) => r.source_detail === undefined)).toBe(true);
  });

  it("a no-op diff (identical before/after) writes nothing", async () => {
    const t = makeT();
    const ownerId = await seedOwner(t);
    await t.run(async (ctx) => {
      await logKnownIssueEvents(ctx, {
        vehicleOwnerId: ownerId,
        before: ["abs", "tpms"],
        after: ["tpms", "abs"], // same set, different order
        source: "mechanic_inspection",
        sourceDetail: "ExpressAuto",
        now: 4000,
      });
    });
    const rows = await t.run((ctx) =>
      ctx.db
        .query("known_issue_events")
        .withIndex("by_vehicle_owner_id", (q) => q.eq("vehicle_owner_id", ownerId))
        .collect(),
    );
    expect(rows).toHaveLength(0);
  });

  it("events for different vehicle owners never mix", async () => {
    const t = makeT();
    const ownerA = await seedOwner(t);
    const ownerB = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        clerkUserId: "clerk_kie_b",
        email: "kie-b@test.local",
        role: "user",
        createdAt: 1,
      });
      return await ctx.db.insert("vehicle_owners", {
        vin: "KIEVIN00000000002",
        user_id: userId,
        status: "active",
        knownIssues: [],
        preOnboardingComplete: true,
      } as any);
    });
    await t.run(async (ctx) => {
      await logKnownIssueEvents(ctx, {
        vehicleOwnerId: ownerA,
        before: [],
        after: ["abs"],
        source: "check_in",
        now: 1,
      });
      await logKnownIssueEvents(ctx, {
        vehicleOwnerId: ownerB,
        before: [],
        after: ["tpms"],
        source: "check_in",
        now: 1,
      });
    });
    const rowsA = await t.run((ctx) =>
      ctx.db
        .query("known_issue_events")
        .withIndex("by_vehicle_owner_id", (q) => q.eq("vehicle_owner_id", ownerA))
        .collect(),
    );
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0].code).toBe("abs");
  });
});
