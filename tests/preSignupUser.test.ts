import { describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import { makeT } from "./helpers";

const HONDA = { vin: "1HGCM82633A004352", year: 2003, make: "HONDA", model: "Accord", trim: "EX" };

async function everything(t: ReturnType<typeof makeT>) {
  return t.run(async (ctx) => ({
    users: await ctx.db.query("users").collect(),
    vehicles: await ctx.db.query("vehicles").collect(),
    owners: await ctx.db.query("vehicle_owners").collect(),
  }));
}

describe("preSignups.createStub — every website sign-up is a user", () => {
  test("a sign-up becomes a user with no Clerk login, holding the name, email and car", async () => {
    const t = makeT();
    await t.mutation(api.preSignups.createStub, {
      email: "Jane.Doe@Example.com",
      firstName: "Jane",
      lastName: "van Dyke",
      ...HONDA,
    });

    const { users, vehicles, owners } = await everything(t);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ email: "jane.doe@example.com", first_name: "Jane", last_name: "van Dyke" });
    expect(users[0].clerkUserId).toMatch(/^presignup-/);
    expect(vehicles.map((v) => v.vin)).toEqual([HONDA.vin]);
    expect(owners).toMatchObject([{ vin: HONDA.vin, user_id: users[0]._id, is_primary: true }]);
  });

  test("an email-only sign-up is still a user", async () => {
    const t = makeT();
    await t.mutation(api.preSignups.createStub, { email: "bk@example.com" });
    const { users, owners } = await everything(t);
    expect(users).toMatchObject([{ email: "bk@example.com" }]);
    expect(users[0].clerkUserId).toMatch(/^presignup-/);
    expect(owners).toHaveLength(0);
  });

  test("signing up again fills in the same user rather than making a second one", async () => {
    const t = makeT();
    await t.mutation(api.preSignups.createStub, { email: "sam@example.com" });
    await t.mutation(api.preSignups.createStub, { email: "SAM@example.com", firstName: "Sam", ...HONDA });
    await t.mutation(api.preSignups.createStub, { email: "sam@example.com", ...HONDA });

    const { users, vehicles, owners } = await everything(t);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ email: "sam@example.com", first_name: "Sam" });
    expect(vehicles).toHaveLength(1);
    expect(owners).toHaveLength(1);
  });
});
