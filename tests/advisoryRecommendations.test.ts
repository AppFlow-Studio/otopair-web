/**
 * Advisory recommendations (Off-Catalog Work spec, §6).
 *
 * The bug these lock down: both driver-facing queries filtered on
 * `recommended_service_id`, so a mechanic could tick "visible to driver" on a
 * freeform recommendation and it would reach nobody — no card, no reminder, no
 * trace. The mechanic believed they'd told the customer; the customer never
 * heard it.
 *
 * Advisories now deliver, but as a different kind of object: attributed, not
 * bookable, never expiring, and (guaranteed in customJobHealthIsolation.test.ts)
 * with no effect on the health score.
 */
import { describe, it, expect } from "vitest";
import { makeT } from "./helpers";
import { api, internal } from "../convex/_generated/api";

const DAY = 24 * 60 * 60 * 1000;

/** Shop + mechanic + booking + owner for one VIN. */
async function seed(
  t: ReturnType<typeof makeT>,
  vin: string,
  suffix: string,
) {
  return t.run(async (ctx: any) => {
    const userId = await ctx.db.insert("users", {
      clerkUserId: `c_adv_${suffix}`,
      email: `adv_${suffix}@test.local`,
      role: "customer",
      createdAt: Date.now(),
    });
    await ctx.db.insert("vehicle_owners", {
      vin,
      user_id: userId,
      status: "active",
      preOnboardingComplete: true,
    });
    const shopId = await ctx.db.insert("shops", { name: "Brooklyn Auto" } as any);
    const mechanicId = await ctx.db.insert("mechanics", {
      shop_id: shopId,
      first_name: "Mike",
      last_name: "Reyes",
    } as any);
    const bookingId = await ctx.db.insert("bookings", {
      vin,
      user_id: userId,
      service_ids: [],
      status: "completed",
    } as any);
    const jobActualId = await ctx.db.insert("job_actuals", {
      booking_id: bookingId,
      mechanic_id: mechanicId,
    } as any);
    return { userId, shopId, mechanicId, bookingId, jobActualId };
  });
}

async function insertRec(
  t: ReturnType<typeof makeT>,
  base: any,
  overrides: Record<string, unknown>,
) {
  return t.run(async (ctx: any) =>
    ctx.db.insert("job_recommendations", {
      booking_id: base.bookingId,
      job_actual_id: base.jobActualId,
      shop_id: base.shopId,
      mechanic_id: base.mechanicId,
      urgency: "soon",
      visible_to_driver: true,
      status: "open",
      created_at: Date.now(),
      ...overrides,
    } as any),
  );
}

describe("advisories reach the driver", () => {
  it("a freeform rec is returned, flagged advisory and not bookable", async () => {
    const t = makeT();
    const base = await seed(t, "VINADV001", "reach");
    await insertRec(t, base, {
      vehicle_vin: "VINADV001",
      freeform_text: "Carbon cleaning (walnut blast)",
      reason: "Intake valves heavily coked at 78k",
    });

    const recs = await t.query(
      api.jobRecommendations.getDriverVisibleRecsForVehicle,
      { vin: "VINADV001" },
    );

    expect(recs).toHaveLength(1);
    expect(recs[0].kind).toBe("advisory");
    expect(recs[0].bookable).toBe(false);
    expect(recs[0].service_id).toBeNull();
    // The typed name is what the driver reads — not "Unspecified".
    expect(recs[0].service_name).toBe("Carbon cleaning (walnut blast)");
    expect(recs[0].disclaimer).toContain("not an Otopair estimate");
  });

  it("attribution leads with the person, not the platform", async () => {
    const t = makeT();
    const base = await seed(t, "VINADV002", "attr");
    await insertRec(t, base, {
      vehicle_vin: "VINADV002",
      freeform_text: "Ceramic coating",
    });

    const recs = await t.query(
      api.jobRecommendations.getDriverVisibleRecsForVehicle,
      { vin: "VINADV002" },
    );
    expect(recs[0].author_label).toBe("Mike Reyes at Brooklyn Auto suggests");
  });

  it("a canonical rec is still bookable and unchanged", async () => {
    const t = makeT();
    const base = await seed(t, "VINADV003", "canon");
    const serviceId = await t.run(async (ctx: any) =>
      ctx.db.insert("services", { name: "Oil Change", slug: "oil_change" }),
    );
    await insertRec(t, base, {
      vehicle_vin: "VINADV003",
      recommended_service_id: serviceId,
    });

    const recs = await t.query(
      api.jobRecommendations.getDriverVisibleRecsForVehicle,
      { vin: "VINADV003" },
    );
    expect(recs[0].kind).toBe("canonical");
    expect(recs[0].bookable).toBe(true);
    expect(recs[0].disclaimer).toBeNull();
    expect(recs[0].service_name).toBe("Oil Change");
  });

  it("advisories appear in history too", async () => {
    const t = makeT();
    const base = await seed(t, "VINADV004", "hist");
    await insertRec(t, base, {
      vehicle_vin: "VINADV004",
      freeform_text: "Underbody rustproofing",
      status: "dismissed",
      dismissed_reason: "not_needed",
    });

    const history = await t.query(
      api.jobRecommendations.getRecHistoryForVehicle,
      { vin: "VINADV004" },
    );
    expect(history).toHaveLength(1);
    expect(history[0].kind).toBe("advisory");
    expect(history[0].service_name).toBe("Underbody rustproofing");
  });

  it("an invisible advisory stays invisible", async () => {
    const t = makeT();
    const base = await seed(t, "VINADV005", "hidden");
    await insertRec(t, base, {
      vehicle_vin: "VINADV005",
      freeform_text: "Shop-internal note thing",
      visible_to_driver: false,
    });

    const recs = await t.query(
      api.jobRecommendations.getDriverVisibleRecsForVehicle,
      { vin: "VINADV005" },
    );
    expect(recs).toHaveLength(0);
  });
});

describe("advisories age rather than expire", () => {
  it("the 12-month cron expires canonical recs and spares advisories", async () => {
    const t = makeT();
    const base = await seed(t, "VINADV006", "expiry");
    const serviceId = await t.run(async (ctx: any) =>
      ctx.db.insert("services", { name: "Oil Change", slug: "oil_change" }),
    );
    const old = Date.now() - 400 * DAY;

    const advisoryId = await insertRec(t, base, {
      vehicle_vin: "VINADV006",
      freeform_text: "Carbon cleaning",
      created_at: old,
    });
    const canonicalId = await insertRec(t, base, {
      vehicle_vin: "VINADV006",
      recommended_service_id: serviceId,
      created_at: old,
    });

    const result = await t.mutation(
      internal.jobRecommendations.expireOlderThan12Months,
      {},
    );
    expect(result.expired).toBe(1);
    expect(result.advisoriesSpared).toBe(1);

    const { advisory, canonical } = await t.run(async (ctx: any) => ({
      advisory: await ctx.db.get(advisoryId),
      canonical: await ctx.db.get(canonicalId),
    }));
    expect((advisory as any).status).toBe("open");
    expect((canonical as any).status).toBe("expired");
  });

  it("an over-a-year-old advisory is marked aged but still delivered", async () => {
    const t = makeT();
    const base = await seed(t, "VINADV007", "aged");
    await insertRec(t, base, {
      vehicle_vin: "VINADV007",
      freeform_text: "Carbon cleaning",
      created_at: Date.now() - 400 * DAY,
    });
    await insertRec(t, base, {
      vehicle_vin: "VINADV007",
      freeform_text: "Ceramic coating",
      created_at: Date.now() - 10 * DAY,
    });

    const recs = await t.query(
      api.jobRecommendations.getDriverVisibleRecsForVehicle,
      { vin: "VINADV007" },
    );
    const byName = Object.fromEntries(
      recs.map((r: any) => [r.service_name, r]),
    );
    // Still returned — never silently deleted — but flagged so the client can
    // collapse it out of the primary list.
    expect(byName["Carbon cleaning"].aged).toBe(true);
    expect(byName["Ceramic coating"].aged).toBe(false);
  });
});
