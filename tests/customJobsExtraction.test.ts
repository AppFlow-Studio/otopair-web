/**
 * custom_jobs — the extraction spine for off-catalog work (Off-Catalog Work
 * spec, §7).
 *
 * What's being protected here is mostly *joinability*. Labor minutes and prices
 * already land in the snapshot tables; the reason this table exists is the
 * complaint → resolution → did-it-work triple, and a triple is worthless if the
 * three parts can end up attached to different jobs. So the tests lean on the
 * matching rules: outcomes match by normalised name (never array index), and
 * re-entry patches instead of duplicating.
 */
import { describe, it, expect } from "vitest";
import { makeT } from "./helpers";
import {
  recordCustomJobsForBooking,
  completeCustomJobsForBooking,
  bumpPendingServiceSubmission,
} from "../convex/customJobs";

async function seedBooking(t: ReturnType<typeof makeT>, vin: string, tag: string) {
  return t.run(async (ctx: any) => {
    const userId = await ctx.db.insert("users", {
      clerkUserId: `c_cj_${tag}`,
      email: `cj_${tag}@test.local`,
      role: "customer",
      createdAt: Date.now(),
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
      status: "in_progress",
    } as any);
    return { shopId, mechanicId, bookingId, vin };
  });
}

describe("recording off-catalog work", () => {
  it("captures the complaint and opens a ledger row", async () => {
    const t = makeT();
    const base = await seedBooking(t, "VINCJ001", "record");

    await t.run(async (ctx: any) =>
      recordCustomJobsForBooking(ctx, {
        booking: { _id: base.bookingId, shop_id: base.shopId, vin: base.vin },
        mechanicId: base.mechanicId,
        customJobs: [
          {
            name: "Carbon cleaning (walnut blast)",
            complaint: "Rough idle, intake valves coked at 78k",
            estimated_minutes: 180,
          },
        ],
        source: "booking",
        now: Date.now(),
      }),
    );

    const { jobs, ledger } = await t.run(async (ctx: any) => ({
      jobs: await ctx.db.query("custom_jobs").collect(),
      ledger: await ctx.db.query("pending_service_submissions").collect(),
    }));

    expect(jobs).toHaveLength(1);
    expect(jobs[0].complaint).toBe("Rough idle, intake valves coked at 78k");
    expect(jobs[0].status).toBe("planned");
    expect(jobs[0].estimated_minutes).toBe(180);
    // Both normalised forms are stored — they serve different lookups.
    expect(jobs[0].normalized_name).toBe("carbon cleaning (walnut blast)");
    expect(jobs[0].match_key).not.toContain("(");

    // The catalog-gap ledger saw it, and the job points back at that row.
    expect(ledger).toHaveLength(1);
    expect(ledger[0].appearance_count).toBe(1);
    expect(jobs[0].pending_service_submission_id).toBe(ledger[0]._id);
  });

  it("re-recording the same booking patches instead of duplicating", async () => {
    // A booking edit must not inflate the cluster count that drives the roadmap
    // read, or one shop editing a booking twice looks like demand.
    const t = makeT();
    const base = await seedBooking(t, "VINCJ002", "patch");
    const booking = { _id: base.bookingId, shop_id: base.shopId, vin: base.vin };

    await t.run(async (ctx: any) =>
      recordCustomJobsForBooking(ctx, {
        booking,
        mechanicId: base.mechanicId,
        customJobs: [{ name: "Roll fenders", estimated_minutes: 90 }],
        source: "booking",
        now: Date.now(),
      }),
    );
    await t.run(async (ctx: any) =>
      recordCustomJobsForBooking(ctx, {
        booking,
        mechanicId: base.mechanicId,
        customJobs: [
          { name: "Roll fenders", estimated_minutes: 120, complaint: "Tyre rub" },
        ],
        source: "booking",
        now: Date.now(),
      }),
    );

    const { jobs, ledger } = await t.run(async (ctx: any) => ({
      jobs: await ctx.db.query("custom_jobs").collect(),
      ledger: await ctx.db.query("pending_service_submissions").collect(),
    }));

    expect(jobs).toHaveLength(1);
    expect(jobs[0].estimated_minutes).toBe(120);
    expect(jobs[0].complaint).toBe("Tyre rub");
    // Critically: the ledger did NOT get bumped a second time.
    expect(ledger[0].appearance_count).toBe(1);
  });

  it("scopes to the vehicle config when the VIN resolves to one", async () => {
    const t = makeT();
    const base = await seedBooking(t, "VINCJ003", "config");
    const configId = await t.run(async (ctx: any) => {
      const makeId = await ctx.db.insert("makes", { name: "BMW" } as any);
      const modelId = await ctx.db.insert("models", {
        name: "430i",
        make_id: makeId,
      } as any);
      const configId = await ctx.db.insert("vehicle_configs", {
        config_key: "2019_bmw_430i_2_0l_4cyl",
        year: 2019,
        make_id: makeId,
        model_id: modelId,
      } as any);
      await ctx.db.insert("vehicles", {
        vin: "VINCJ003",
        vehicle_config_id: configId,
      } as any);
      return configId;
    });

    await t.run(async (ctx: any) =>
      recordCustomJobsForBooking(ctx, {
        booking: { _id: base.bookingId, shop_id: base.shopId, vin: base.vin },
        mechanicId: base.mechanicId,
        customJobs: [{ name: "Carbon cleaning" }],
        source: "booking",
        now: Date.now(),
      }),
    );

    const jobs = await t.run(async (ctx: any) =>
      ctx.db.query("custom_jobs").collect(),
    );
    // Without this, labor and price evidence is unscoped and therefore anecdote.
    expect(jobs[0].vehicle_config_id).toBe(configId);
  });

  it("a pseudo-VIN walk-in records the work but has no config to scope it", async () => {
    const t = makeT();
    const base = await seedBooking(t, "OTOPSEUDO0000001", "pseudo");
    await t.run(async (ctx: any) =>
      recordCustomJobsForBooking(ctx, {
        booking: { _id: base.bookingId, shop_id: base.shopId, vin: base.vin },
        mechanicId: base.mechanicId,
        customJobs: [{ name: "Ceramic coating" }],
        source: "booking",
        now: Date.now(),
      }),
    );
    const jobs = await t.run(async (ctx: any) =>
      ctx.db.query("custom_jobs").collect(),
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].vehicle_config_id).toBeUndefined();
  });
});

describe("closing off-catalog work", () => {
  it("matches outcomes by name, not by array order", async () => {
    // The mechanic may reorder, add or drop lines between booking and
    // completion. Index-matching would write one job's outcome onto another —
    // which corrupts the exact triple the table exists to capture.
    const t = makeT();
    const base = await seedBooking(t, "VINCJ004", "order");
    await t.run(async (ctx: any) =>
      recordCustomJobsForBooking(ctx, {
        booking: { _id: base.bookingId, shop_id: base.shopId, vin: base.vin },
        mechanicId: base.mechanicId,
        customJobs: [
          { name: "Carbon cleaning", complaint: "Rough idle" },
          { name: "Roll fenders", complaint: "Tyre rub" },
        ],
        source: "booking",
        now: Date.now(),
      }),
    );

    await t.run(async (ctx: any) =>
      completeCustomJobsForBooking(ctx, {
        bookingId: base.bookingId,
        // Deliberately reversed relative to how they were recorded.
        outcomes: [
          { name: "Roll fenders", resolution: "Rolled both rears", resolved_complaint: true },
          {
            name: "Carbon cleaning",
            resolution: "Walnut blasted, idle smooth",
            resolved_complaint: true,
          },
        ],
        now: Date.now(),
      }),
    );

    const jobs = await t.run(async (ctx: any) =>
      ctx.db.query("custom_jobs").collect(),
    );
    const byName = Object.fromEntries(jobs.map((j: any) => [j.name, j]));
    expect(byName["Carbon cleaning"].resolution).toBe(
      "Walnut blasted, idle smooth",
    );
    expect(byName["Roll fenders"].resolution).toBe("Rolled both rears");
  });

  it("matches through re-phrasing, because the key is normalised", async () => {
    const t = makeT();
    const base = await seedBooking(t, "VINCJ005", "rephrase");
    await t.run(async (ctx: any) =>
      recordCustomJobsForBooking(ctx, {
        booking: { _id: base.bookingId, shop_id: base.shopId, vin: base.vin },
        mechanicId: base.mechanicId,
        customJobs: [{ name: "Roll Fenders" }],
        source: "booking",
        now: Date.now(),
      }),
    );
    const touched = await t.run(async (ctx: any) =>
      completeCustomJobsForBooking(ctx, {
        bookingId: base.bookingId,
        outcomes: [{ name: "roll fender", resolution: "Done" }],
        now: Date.now(),
      }),
    );
    expect(touched).toBe(1);
  });

  it("a line with no reported outcome still closes, with nothing recorded", async () => {
    // "Completed, no outcome recorded" and "still open" mean different things to
    // the director view, so an unanswered line must not be left at planned.
    const t = makeT();
    const base = await seedBooking(t, "VINCJ006", "silent");
    await t.run(async (ctx: any) =>
      recordCustomJobsForBooking(ctx, {
        booking: { _id: base.bookingId, shop_id: base.shopId, vin: base.vin },
        mechanicId: base.mechanicId,
        customJobs: [{ name: "Ceramic coating" }, { name: "Roll fenders" }],
        source: "booking",
        now: Date.now(),
      }),
    );

    await t.run(async (ctx: any) =>
      completeCustomJobsForBooking(ctx, {
        bookingId: base.bookingId,
        outcomes: [{ name: "Ceramic coating", resolution: "Two coats" }],
        now: Date.now(),
      }),
    );

    const jobs = await t.run(async (ctx: any) =>
      ctx.db.query("custom_jobs").collect(),
    );
    expect(jobs.every((j: any) => j.status === "completed")).toBe(true);
    const silent = jobs.find((j: any) => j.name === "Roll fenders");
    expect(silent.resolution).toBeUndefined();
    expect(silent.resolved_complaint).toBeUndefined();
  });

  it("an outcome for a line that isn't on the booking is ignored", async () => {
    const t = makeT();
    const base = await seedBooking(t, "VINCJ007", "unknown");
    await t.run(async (ctx: any) =>
      recordCustomJobsForBooking(ctx, {
        booking: { _id: base.bookingId, shop_id: base.shopId, vin: base.vin },
        mechanicId: base.mechanicId,
        customJobs: [{ name: "Ceramic coating" }],
        source: "booking",
        now: Date.now(),
      }),
    );
    const touched = await t.run(async (ctx: any) =>
      completeCustomJobsForBooking(ctx, {
        bookingId: base.bookingId,
        outcomes: [{ name: "Something else entirely", resolution: "?" }],
        now: Date.now(),
      }),
    );
    expect(touched).toBe(0);
  });
});

describe("the catalog-gap ledger is shared", () => {
  it("the same name from two shops lands on one cluster row", async () => {
    // Recommendations and performed work feed one counter. Splitting them would
    // understate every cluster in the roadmap read.
    const t = makeT();
    const a = await seedBooking(t, "VINCJ008", "shopA");
    const b = await seedBooking(t, "VINCJ009", "shopB");

    await t.run(async (ctx: any) => {
      await bumpPendingServiceSubmission(ctx, {
        name: "Carbon Cleaning",
        mechanicId: a.mechanicId,
        bookingId: a.bookingId,
        vin: a.vin,
        now: Date.now(),
      });
      await bumpPendingServiceSubmission(ctx, {
        name: "  carbon   cleaning  ",
        mechanicId: b.mechanicId,
        bookingId: b.bookingId,
        vin: b.vin,
        now: Date.now(),
      });
    });

    const ledger = await t.run(async (ctx: any) =>
      ctx.db.query("pending_service_submissions").collect(),
    );
    expect(ledger).toHaveLength(1);
    expect(ledger[0].appearance_count).toBe(2);
  });
});
