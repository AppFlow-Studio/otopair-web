/**
 * customJobs.suggestKnownNames — "other shops call it…".
 *
 * The feature exists because clustering is a naming problem: "carbon cleaning",
 * "walnut blast" and "intake decarbon" are one job and three clusters, and
 * nothing downstream can recover a convergence that never happened at the
 * keyboard.
 *
 * Two properties matter and pull against each other. It has to be loose enough
 * to catch a half-typed or misspelled name, and disciplined enough that it
 * never leaks who the other shops are or suggests unrelated work.
 */
import { describe, it, expect } from "vitest";
import { api } from "../convex/_generated/api";
import { makeT } from "./helpers";
import { recordCustomJobsForBooking } from "../convex/customJobs";

/** The band only renders inside an authenticated shop surface, and the query
 *  refuses anonymous callers — cross-shop naming data is not public. */
const asStaff = (t: ReturnType<typeof makeT>) =>
  t.withIdentity({ subject: "c_kn_viewer" });

async function seedShopJob(
  t: ReturnType<typeof makeT>,
  opts: {
    tag: string;
    shopName: string;
    jobName: string;
    systemTags?: string[];
    workType?: string;
  },
) {
  return t.run(async (ctx: any) => {
    const userId = await ctx.db.insert("users", {
      clerkUserId: `c_kn_${opts.tag}`,
      email: `kn_${opts.tag}@test.local`,
      role: "customer",
      createdAt: Date.now(),
    });
    const shopId = await ctx.db.insert("shops", { name: opts.shopName } as any);
    const mechanicId = await ctx.db.insert("mechanics", {
      shop_id: shopId,
      first_name: "M",
      last_name: opts.tag,
    } as any);
    const bookingId = await ctx.db.insert("bookings", {
      vin: `VINKN${opts.tag}`,
      user_id: userId,
      service_ids: [],
      status: "in_progress",
    } as any);
    await recordCustomJobsForBooking(ctx, {
      booking: { _id: bookingId, shop_id: shopId, vin: `VINKN${opts.tag}` },
      mechanicId,
      customJobs: [
        {
          name: opts.jobName,
          system_tags: opts.systemTags ?? ["engine"],
          work_type: opts.workType ?? "service",
        },
      ],
      source: "booking",
      now: Date.now(),
    });
    return { shopId };
  });
}

describe("suggestKnownNames", () => {
  it("surfaces a name another shop already used, through a typo", async () => {
    const t = makeT();
    await seedShopJob(t, {
      tag: "a",
      shopName: "Shop A",
      jobName: "Carbon cleaning",
    });

    const out: any[] = await asStaff(t).query(api.customJobs.suggestKnownNames, {
      name: "carbon cleening",
    });
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Carbon cleaning");
    expect(out[0].shops).toBe(1);
  });

  it("carries the cluster's taxonomy so it isn't re-answered", async () => {
    const t = makeT();
    await seedShopJob(t, {
      tag: "b",
      shopName: "Shop B",
      jobName: "Walnut blasting",
      systemTags: ["engine", "exhaust_emissions"],
      workType: "service",
    });

    const out: any[] = await asStaff(t).query(api.customJobs.suggestKnownNames, {
      name: "walnut blast",
    });
    expect(out[0].system_tags).toContain("engine");
    expect(out[0].work_type).toBe("service");
  });

  it("counts distinct shops and never names them", async () => {
    const t = makeT();
    await seedShopJob(t, { tag: "c1", shopName: "Shop C", jobName: "Roll fenders" });
    await seedShopJob(t, { tag: "c2", shopName: "Shop D", jobName: "Roll fenders" });

    const out: any[] = await asStaff(t).query(api.customJobs.suggestKnownNames, {
      name: "rolling fender",
    });
    expect(out[0].shops).toBe(2);
    expect(out[0].jobs).toBe(2);
    // Breadth is the useful signal; identity is somebody else's business.
    expect(JSON.stringify(out[0])).not.toContain("Shop C");
    expect(Object.keys(out[0])).not.toContain("shop_id");
  });

  it("drops a name only this shop has used — it's already in their own chips", async () => {
    const t = makeT();
    const { shopId } = await seedShopJob(t, {
      tag: "d",
      shopName: "Shop E",
      jobName: "Ceramic coating",
    });

    const mine: any[] = await asStaff(t).query(api.customJobs.suggestKnownNames, {
      name: "ceramic coat",
      shopId,
    });
    expect(mine).toHaveLength(0);

    // Same name, asked without a shop scope — still known work.
    const anyone: any[] = await asStaff(t).query(api.customJobs.suggestKnownNames, {
      name: "ceramic coat",
    });
    expect(anyone).toHaveLength(1);
  });

  it("does not suggest unrelated work", async () => {
    const t = makeT();
    await seedShopJob(t, {
      tag: "e",
      shopName: "Shop F",
      jobName: "Rear wiper motor replacement",
    });

    const out: any[] = await asStaff(t).query(api.customJobs.suggestKnownNames, {
      name: "Power window switch replacement",
    });
    expect(out).toHaveLength(0);
  });

  it("stays quiet until there is something to match on", async () => {
    const t = makeT();
    await seedShopJob(t, { tag: "f", shopName: "Shop G", jobName: "Carbon cleaning" });

    // Two characters is noise — it would match half the table.
    expect(
      await asStaff(t).query(api.customJobs.suggestKnownNames, { name: "ca" }),
    ).toEqual([]);
  });

  it("does not echo back exactly what was typed", async () => {
    const t = makeT();
    await seedShopJob(t, { tag: "g", shopName: "Shop H", jobName: "Carbon cleaning" });

    const out: any[] = await asStaff(t).query(api.customJobs.suggestKnownNames, {
      name: "carbon cleaning",
    });
    expect(out).toHaveLength(0);
  });
});

describe("suggestKnownNames access", () => {
  it("returns nothing to an anonymous caller", async () => {
    const t = makeT();
    await seedShopJob(t, { tag: "h", shopName: "Shop I", jobName: "Carbon cleaning" });

    // Coarse and anonymised is still cross-shop data — it does not belong on an
    // unauthenticated endpoint where the whole ledger could be enumerated.
    expect(
      await t.query(api.customJobs.suggestKnownNames, { name: "carbon clean" }),
    ).toEqual([]);
  });
});
