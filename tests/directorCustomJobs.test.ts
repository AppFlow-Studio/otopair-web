/**
 * Director pattern view + exposure alert (Off-Catalog Work spec, §8).
 *
 * Three things here are easy to get subtly wrong, and each has a test that fails
 * loudly if it regresses:
 *
 *   1. RANKING. Distinct shops must beat raw occurrences, or the roadmap read
 *      just surfaces whichever single garage is most enthusiastic.
 *
 *   2. THE BAND MUST BE ABLE TO EMPTY. Aliasing a cluster makes it match the
 *      catalog *more* strongly, so a naive implementation ranks it straight back
 *      to the top of its own to-do list and the band never clears. Resolved
 *      keys have to be excluded.
 *
 *   3. EXPOSURE, NOT QUEUE DEPTH. The alert has to count vehicles — drivers
 *      losing maintenance credit — not rows waiting.
 */
import { describe, it, expect } from "vitest";
import { makeT, identityFor } from "./helpers";
import { api, internal } from "../convex/_generated/api";
import {
  likelyCanonicalClusters,
  exposureFromClusters,
} from "../convex/directorCustomJobs";
import { recordCustomJobsForBooking } from "../convex/customJobs";

const DIRECTOR_TOKEN = "tok_director_cj";

async function seedDirector(t: ReturnType<typeof makeT>) {
  return t.run(async (ctx: any) => {
    const userId = await ctx.db.insert("director_users", {
      name: "Ops",
      role: "super_admin",
      totp_secret: "JBSWY3DPEHPK3PXP",
      created_at: Date.now(),
    } as any);
    await ctx.db.insert("director_sessions", {
      user_id: userId,
      token: DIRECTOR_TOKEN,
      expires_at: Date.now() + 60 * 60 * 1000,
      created_at: Date.now(),
    } as any);
    return userId;
  });
}

/** A shop with a booking, ready to hang custom jobs off. */
async function seedShop(t: ReturnType<typeof makeT>, tag: string, vin: string) {
  return t.run(async (ctx: any) => {
    const userId = await ctx.db.insert("users", {
      clerkUserId: `clerk_${tag}`,
      email: `${tag}@test.local`,
      role: "customer",
      createdAt: Date.now(),
    });
    const shopId = await ctx.db.insert("shops", { name: `Shop ${tag}` } as any);
    const mechanicId = await ctx.db.insert("mechanics", {
      shop_id: shopId,
      first_name: "M",
      last_name: tag,
    } as any);
    const bookingId = await ctx.db.insert("bookings", {
      vin,
      user_id: userId,
      shop_id: shopId,
      service_ids: [],
      status: "completed",
    } as any);
    return { shopId, mechanicId, bookingId, vin };
  });
}

async function addJob(
  t: ReturnType<typeof makeT>,
  base: { shopId: any; mechanicId: any; bookingId: any; vin: string },
  job: { name: string; complaint?: string; charged?: number; minutes?: number },
) {
  await t.run(async (ctx: any) => {
    await recordCustomJobsForBooking(ctx, {
      booking: { _id: base.bookingId, shop_id: base.shopId, vin: base.vin },
      mechanicId: base.mechanicId,
      customJobs: [{ system_tags: ["engine"], work_type: "repair", name: job.name, complaint: job.complaint ?? null }],
      source: "booking",
      now: Date.now(),
    });
    // Patch the outcome fields directly — completion is covered elsewhere.
    const rows = await ctx.db.query("custom_jobs").collect();
    const row = rows[rows.length - 1];
    await ctx.db.patch(row._id, {
      charged_price_cents: job.charged,
      actual_minutes: job.minutes,
      status: "completed",
    });
  });
}

describe("ranking", () => {
  it("breadth across shops beats one enthusiastic garage", async () => {
    const t = makeT();
    await seedDirector(t);

    // One shop, six repetitions — a specialty.
    const busy = await seedShop(t, "busy", "VINDCJ001");
    for (let i = 0; i < 6; i++) {
      await addJob(t, busy, { name: `Ceramic coating ${i}` });
    }
    // Three different shops, one each — a category we're missing.
    for (const tag of ["a", "b", "c"]) {
      const s = await seedShop(t, `shop${tag}`, `VINDCJ00${tag}`);
      await addJob(t, s, { name: "Roll fenders" });
    }

    const view: any = await t.query(api.directorCustomJobs.patternView, {
      token: DIRECTOR_TOKEN,
    });

    // "Roll fenders" has 3 distinct shops and 3 jobs; the specialty has 1 shop
    // and 6. Distinct shops must win.
    expect(view.clusters[0].name).toBe("Roll fenders");
    expect(view.clusters[0].distinct_shops).toBe(3);
  });
});

describe("the correctness band", () => {
  it("flags a cluster that names a service we already offer", async () => {
    const t = makeT();
    await seedDirector(t);
    await t.run(async (ctx: any) =>
      ctx.db.insert("services", { name: "Oil Change", slug: "oil_change" }),
    );
    const shop = await seedShop(t, "mislabel", "VINDCJ010");
    await addJob(t, shop, { name: "Change the oil", complaint: "Due service" });

    const view: any = await t.query(api.directorCustomJobs.patternView, {
      token: DIRECTOR_TOKEN,
    });

    expect(view.likelyCanonical).toHaveLength(1);
    expect(view.likelyCanonical[0].canonical_suggestion.service_name).toBe(
      "Oil Change",
    );
    // And it is NOT double-counted into the roadmap read.
    expect(view.clusters.map((c: any) => c.name)).not.toContain(
      "Change the oil",
    );
  });

  it("aliasing a cluster clears it from the band", async () => {
    // The trap: an alias makes the name match the catalog MORE strongly, so a
    // naive implementation would rank it right back to the top and the band
    // could never empty.
    const t = makeT();
    await seedDirector(t);
    const serviceId = await t.run(async (ctx: any) =>
      ctx.db.insert("services", { name: "Oil Change", slug: "oil_change" }),
    );
    const shop = await seedShop(t, "aliased", "VINDCJ011");
    await addJob(t, shop, { name: "Change the oil" });

    const before: any = await t.query(api.directorCustomJobs.patternView, {
      token: DIRECTOR_TOKEN,
    });
    expect(before.likelyCanonical).toHaveLength(1);

    await t.mutation(api.serviceMatch.linkAlias, {
      token: DIRECTOR_TOKEN,
      alias: "Change the oil",
      serviceId,
    });

    const after: any = await t.query(api.directorCustomJobs.patternView, {
      token: DIRECTOR_TOKEN,
    });
    expect(after.likelyCanonical).toHaveLength(0);
    expect(after.totals.exposed_vehicles).toBe(0);
    // The work itself is still visible — aliasing explains it, it doesn't hide it.
    expect(after.clusters.map((c: any) => c.name)).toContain("Change the oil");
  });

  it("ranks by vehicles affected, because that's who's being harmed", async () => {
    const t = makeT();
    await seedDirector(t);
    await t.run(async (ctx: any) => {
      await ctx.db.insert("services", { name: "Oil Change", slug: "oil_change" });
      await ctx.db.insert("services", {
        name: "Tire Rotation",
        slug: "tire_rotation",
      });
    });

    // One vehicle for the oil mislabel...
    const one = await seedShop(t, "one", "VINDCJ020");
    await addJob(t, one, { name: "Change the oil" });
    // ...three for the tire one.
    for (const tag of ["x", "y", "z"]) {
      const s = await seedShop(t, `tire${tag}`, `VINDCJ02${tag}`);
      await addJob(t, s, { name: "Rotate the tires" });
    }

    const view: any = await t.query(api.directorCustomJobs.patternView, {
      token: DIRECTOR_TOKEN,
    });
    // "Rotate the tires" only scores MEDIUM against "Tire Rotation" (rotate vs
    // rotation share no prefix), so the match gate would merely ask rather than
    // pre-select. The band still has to surface it — otherwise those three
    // drivers stay silently mis-scored and nobody is ever told.
    expect(view.likelyCanonical[0].name).toBe("Rotate the tires");
    expect(view.likelyCanonical[0].canonical_suggestion.confidence).toBe("medium");
    expect(view.totals.exposed_vehicles).toBe(4);
  });
});

describe("exposure is vehicles, not rows", () => {
  it("counts distinct vehicles across clusters", async () => {
    expect(
      exposureFromClusters([
        { distinct_vehicles: 3 },
        { distinct_vehicles: 1 },
      ]),
    ).toBe(4);
  });

  it("ten jobs on one car is exposure of one", async () => {
    // Queue depth would read ten. Only one driver is actually affected, and the
    // alert must not overstate harm.
    const t = makeT();
    await seedDirector(t);
    await t.run(async (ctx: any) =>
      ctx.db.insert("services", { name: "Oil Change", slug: "oil_change" }),
    );
    const shop = await seedShop(t, "repeat", "VINDCJ030");
    for (let i = 0; i < 10; i++) {
      await t.run(async (ctx: any) => {
        await ctx.db.insert("custom_jobs", {
          booking_id: shop.bookingId,
          shop_id: shop.shopId,
          vehicle_vin: shop.vin,
          name: "Change the oil",
          normalized_name: "change the oil",
          match_key: "oil",
          source: "booking",
          status: "completed",
          created_at: Date.now(),
        } as any);
      });
    }

    const clusters = await t.run(async (ctx: any) =>
      likelyCanonicalClusters(ctx, Date.now()),
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0].occurrences).toBe(10);
    expect(exposureFromClusters(clusters)).toBe(1);
  });
});

describe("aggregation", () => {
  it("reports medians, ranges and the resolution rate", async () => {
    const t = makeT();
    await seedDirector(t);
    const shops = await Promise.all([
      seedShop(t, "agg1", "VINDCJ040"),
      seedShop(t, "agg2", "VINDCJ041"),
      seedShop(t, "agg3", "VINDCJ042"),
    ]);
    const charged = [10000, 20000, 30000];
    const minutes = [60, 120, 180];
    for (let i = 0; i < 3; i++) {
      await addJob(t, shops[i], {
        name: "Carbon cleaning",
        complaint: `Rough idle ${i}`,
        charged: charged[i],
        minutes: minutes[i],
      });
    }
    // Two of three fixed the complaint.
    await t.run(async (ctx: any) => {
      const rows = await ctx.db.query("custom_jobs").collect();
      await ctx.db.patch(rows[0]._id, { resolved_complaint: true });
      await ctx.db.patch(rows[1]._id, { resolved_complaint: true });
      await ctx.db.patch(rows[2]._id, { resolved_complaint: false });
    });

    const view: any = await t.query(api.directorCustomJobs.patternView, {
      token: DIRECTOR_TOKEN,
    });
    const cluster = view.clusters.find((c: any) => c.name === "Carbon cleaning");
    expect(cluster.median_charged_cents).toBe(20000);
    expect(cluster.min_charged_cents).toBe(10000);
    expect(cluster.max_charged_cents).toBe(30000);
    expect(cluster.median_minutes).toBe(120);
    expect(cluster.resolution_rate).toBeCloseTo(2 / 3, 5);
    expect(cluster.outcomes_recorded).toBe(3);
    // The complaints are the point — a name alone tells a reviewer nothing.
    expect(cluster.sample_complaints.length).toBeGreaterThan(0);
  });

  it("requires a director session", async () => {
    const t = makeT();
    await expect(
      t.query(api.directorCustomJobs.patternView, { token: "bogus" }),
    ).rejects.toThrow(/unauthorized/);
  });
});

describe("the review-queue stream", () => {
  it("opens one high-priority row per affected cluster, idempotently", async () => {
    const t = makeT();
    await seedDirector(t);
    await t.run(async (ctx: any) =>
      ctx.db.insert("services", { name: "Oil Change", slug: "oil_change" }),
    );
    for (const tag of ["q1", "q2"]) {
      const s = await seedShop(t, tag, `VINDCJ05${tag}`);
      await addJob(t, s, { name: "Change the oil" });
    }

    const first: any = await t.mutation(
      internal.reviewQueue.backfillAliases,
      {},
    );
    expect(first.inserted).toBe(1);

    // Re-running must not duplicate — the sweep is a cron.
    const second: any = await t.mutation(
      internal.reviewQueue.backfillAliases,
      {},
    );
    expect(second.inserted).toBe(0);

    const rows = await t.run(async (ctx: any) =>
      ctx.db
        .query("review_queue")
        .filter((q: any) => q.eq(q.field("source_stream"), "alias"))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    // Two vehicles affected → this is harm in progress, not a backlog item.
    expect(rows[0].priority).toBe("high");
    expect(rows[0].title).toContain("Oil Change");
  });
});

describe("the immediate shortcut override alert", () => {
  it("fires when a mechanic overrides the gate to make a shortcut", async () => {
    // A one-off mislabelled line is one bad row. A SHORTCUT will be pressed
    // again tomorrow, so this is the case that can't wait for a daily digest.
    const t = makeT();
    const { shopId } = await t.run(async (ctx: any) => {
      const ownerId = await ctx.db.insert("users", {
        clerkUserId: "clerk_override_owner",
        email: "ov@test.local",
        role: "shop_owner",
        createdAt: Date.now(),
      });
      const shopId = await ctx.db.insert("shops", {
        name: "Brooklyn Auto",
        owner_user_id: ownerId,
      } as any);
      await ctx.db.insert("services", {
        name: "Oil Change",
        slug: "oil_change",
      });
      return { shopId };
    });

    await t
      .withIdentity(identityFor("clerk_override_owner"))
      .mutation(api.shopCustomServices.create, {
        systemTags: ["engine"],
        workType: "repair",
        shopId,
        name: "Change the oil",
        confirmedCustom: true,
      });

    const outbox = await t.run(async (ctx: any) =>
      ctx.db.query("notification_outbox").collect(),
    );
    expect(outbox).toHaveLength(1);
    expect(outbox[0].category).toBe("custom_shortcut_override");
    expect(outbox[0].channel).toBe("slack");
    expect(outbox[0].payload.looks_like).toBe("Oil Change");
  });

  it("does not fire for genuinely custom work", async () => {
    const t = makeT();
    const { shopId } = await t.run(async (ctx: any) => {
      const ownerId = await ctx.db.insert("users", {
        clerkUserId: "clerk_clean_owner",
        email: "clean@test.local",
        role: "shop_owner",
        createdAt: Date.now(),
      });
      const shopId = await ctx.db.insert("shops", {
        name: "Brooklyn Auto",
        owner_user_id: ownerId,
      } as any);
      await ctx.db.insert("services", {
        name: "Oil Change",
        slug: "oil_change",
      });
      return { shopId };
    });

    await t
      .withIdentity(identityFor("clerk_clean_owner"))
      .mutation(api.shopCustomServices.create, {
        systemTags: ["engine"],
        workType: "repair",
        shopId,
        name: "Underbody rustproofing",
      });

    const outbox = await t.run(async (ctx: any) =>
      ctx.db.query("notification_outbox").collect(),
    );
    expect(outbox).toHaveLength(0);
  });

  it("deduplicates so a shop cannot page us twice for one button", async () => {
    const t = makeT();
    const { shopId } = await t.run(async (ctx: any) => {
      const ownerId = await ctx.db.insert("users", {
        clerkUserId: "clerk_dupe_owner",
        email: "dupe@test.local",
        role: "shop_owner",
        createdAt: Date.now(),
      });
      const shopId = await ctx.db.insert("shops", {
        name: "Brooklyn Auto",
        owner_user_id: ownerId,
      } as any);
      await ctx.db.insert("services", {
        name: "Oil Change",
        slug: "oil_change",
      });
      return { shopId };
    });
    const asOwner = t.withIdentity(identityFor("clerk_dupe_owner"));

    await asOwner.mutation(api.shopCustomServices.create, {
      systemTags: ["engine"],
      workType: "repair",
      shopId,
      name: "Change the oil",
      confirmedCustom: true,
    });
    await asOwner.mutation(api.shopCustomServices.create, {
      systemTags: ["engine"],
      workType: "repair",
      shopId,
      name: "Change the oil",
      confirmedCustom: true,
    });

    const outbox = await t.run(async (ctx: any) =>
      ctx.db.query("notification_outbox").collect(),
    );
    expect(outbox).toHaveLength(1);
  });
});

/**
 * clusterParts.
 *
 * It used to read parts_quote_snapshots filtered by custom_service_name, which
 * could never return anything: that table exists to measure CATALOG accuracy —
 * mechanic edit versus what the catalog predicted — and a custom line has no
 * prediction, so custom rows are deliberately never written there. The query
 * was dead by construction, and the drawer showed "none" for work that plainly
 * consumed a part.
 */
describe("clusterParts", () => {
  it("counts parts recorded on the custom job", async () => {
    const t = makeT();
    await seedDirector(t);
    const shop = await seedShop(t, "cp1", "VINCP1000000000A");
    await addJob(t, shop, { name: "Power window switch replacement" });
    const matchKey = await t.run(async (ctx: any) =>
      (await ctx.db.query("custom_jobs").collect())[0].match_key,
    );

    await t.run(async (ctx: any) => {
      const rows = await ctx.db.query("custom_jobs").collect();
      await ctx.db.patch(rows[0]._id, {
        parts: [
          {
            part_name: "Window switch",
            oem_number: "83071AN00B",
            quantity: 1,
            line_total_cents: 7855,
          },
        ],
      });
    });

    const out: any = await t.query(api.directorCustomJobs.clusterParts, {
      token: DIRECTOR_TOKEN,
      matchKey,
    });

    expect(out.parts).toHaveLength(1);
    expect(out.parts[0].oem_number).toBe("83071AN00B");
    expect(out.parts[0].total_cents).toBe(7855);
    expect(out.unattributed_jobs).toBe(0);
  });

  it("falls back to the mechanic's confirmed parts when the row has none", async () => {
    const t = makeT();
    await seedDirector(t);
    const shop = await seedShop(t, "cp2", "VINCP2000000000A");
    await addJob(t, shop, { name: "Power window switch replacement" });
    const matchKey = await t.run(async (ctx: any) =>
      (await ctx.db.query("custom_jobs").collect())[0].match_key,
    );

    await t.run(async (ctx: any) => {
      const job = (await ctx.db.query("custom_jobs").collect())[0];
      await ctx.db.insert("job_actuals", {
        booking_id: job.booking_id,
        mechanic_id: job.mechanic_id,
        parts_used: [
          {
            part_name: "Window switch",
            oem_number: "83071AN00B",
            custom_service_name: job.name,
            cost: 78.55,
            quantity: 1,
          },
          // A catalog part on the same booking — must not be counted here.
          { part_name: "Oil filter", oem_number: "90915", cost: 12, quantity: 1, service_id: undefined },
        ],
      } as any);
    });

    const out: any = await t.query(api.directorCustomJobs.clusterParts, {
      token: DIRECTOR_TOKEN,
      matchKey,
    });
    expect(out.parts).toHaveLength(1);
    expect(out.parts[0].name).toBe("Window switch");
  });

  it("reports jobs whose parts name no line rather than claiming them", async () => {
    const t = makeT();
    await seedDirector(t);
    const shop = await seedShop(t, "cp3", "VINCP3000000000A");
    await addJob(t, shop, { name: "Power window switch replacement" });
    const matchKey = await t.run(async (ctx: any) =>
      (await ctx.db.query("custom_jobs").collect())[0].match_key,
    );

    await t.run(async (ctx: any) => {
      const job = (await ctx.db.query("custom_jobs").collect())[0];
      await ctx.db.insert("job_actuals", {
        booking_id: job.booking_id,
        mechanic_id: job.mechanic_id,
        // Completed before per-line attribution existed.
        parts_used: [
          { part_name: "Window switch", oem_number: "83071AN00B", cost: 78.55, quantity: 1 },
        ],
      } as any);
    });

    const out: any = await t.query(api.directorCustomJobs.clusterParts, {
      token: DIRECTOR_TOKEN,
      matchKey,
    });
    // Counted as unknown, not attributed to this work — that would be a guess.
    expect(out.parts).toHaveLength(0);
    expect(out.unattributed_jobs).toBe(1);
  });
});
