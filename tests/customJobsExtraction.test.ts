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
  customPartsFromSnapshot,
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
            system_tags: ["engine"],
            work_type: "repair",
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
        customJobs: [{ system_tags: ["engine"], work_type: "repair", name: "Roll fenders", estimated_minutes: 90 }],
        source: "booking",
        now: Date.now(),
      }),
    );
    await t.run(async (ctx: any) =>
      recordCustomJobsForBooking(ctx, {
        booking,
        mechanicId: base.mechanicId,
        customJobs: [
          { system_tags: ["engine"], work_type: "repair", name: "Roll fenders", estimated_minutes: 120, complaint: "Tyre rub" },
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
        customJobs: [{ system_tags: ["engine"], work_type: "repair", name: "Carbon cleaning" }],
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
        customJobs: [{ system_tags: ["engine"], work_type: "repair", name: "Ceramic coating" }],
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
          { system_tags: ["engine"], work_type: "repair", name: "Carbon cleaning", complaint: "Rough idle" },
          { system_tags: ["engine"], work_type: "repair", name: "Roll fenders", complaint: "Tyre rub" },
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
        customJobs: [{ system_tags: ["engine"], work_type: "repair", name: "Roll Fenders" }],
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
        customJobs: [{ system_tags: ["engine"], work_type: "repair", name: "Ceramic coating" }, { system_tags: ["engine"], work_type: "repair", name: "Roll fenders" }],
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
        customJobs: [{ system_tags: ["engine"], work_type: "repair", name: "Ceramic coating" }],
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

/**
 * The descriptive taxonomy (lib/custom-job-taxonomy.ts).
 *
 * The old `category_id` field pointed at service_categories — the catalog's
 * merchandising taxonomy, which describes what a driver can BOOK. Off-catalog
 * work is by definition work that taxonomy can't name, which is how a
 * power-window switch replacement ended up filed under "Inspections".
 *
 * These tests protect the two properties that make the replacement worth
 * having: it cannot be skipped, and it cannot be filled with junk. A field
 * that's mandatory but accepts anything is a slower way to store nothing.
 */
describe("custom job taxonomy", () => {
  it("refuses a line with no system", async () => {
    const t = makeT();
    const base = await seedBooking(t, "VINCJTAX1", "tax_nosys");

    await expect(
      t.run(async (ctx: any) =>
        recordCustomJobsForBooking(ctx, {
          booking: { _id: base.bookingId, shop_id: base.shopId, vin: base.vin },
          mechanicId: base.mechanicId,
          customJobs: [{ name: "Roll fenders", work_type: "repair" }],
          source: "booking",
          now: Date.now(),
        }),
      ),
    ).rejects.toThrow(/at least one system/i);
  });

  it("refuses a line with no work type", async () => {
    const t = makeT();
    const base = await seedBooking(t, "VINCJTAX2", "tax_nowt");

    await expect(
      t.run(async (ctx: any) =>
        recordCustomJobsForBooking(ctx, {
          booking: { _id: base.bookingId, shop_id: base.shopId, vin: base.vin },
          mechanicId: base.mechanicId,
          customJobs: [{ name: "Roll fenders", system_tags: ["body_interior"] }],
          source: "booking",
          now: Date.now(),
        }),
      ),
    ).rejects.toThrow(/kind of work/i);
  });

  it("names the offending line, so a multi-line submit is actionable", async () => {
    const t = makeT();
    const base = await seedBooking(t, "VINCJTAX3", "tax_which");

    await expect(
      t.run(async (ctx: any) =>
        recordCustomJobsForBooking(ctx, {
          booking: { _id: base.bookingId, shop_id: base.shopId, vin: base.vin },
          mechanicId: base.mechanicId,
          customJobs: [
            {
              name: "Ceramic coating",
              system_tags: ["body_interior"],
              work_type: "service",
            },
            { name: "Roll fenders", system_tags: ["body_interior"] },
          ],
          source: "booking",
          now: Date.now(),
        }),
      ),
    ).rejects.toThrow(/Roll fenders/);
  });

  it("drops junk slugs rather than storing them", async () => {
    const t = makeT();
    const base = await seedBooking(t, "VINCJTAX4", "tax_junk");

    await t.run(async (ctx: any) =>
      recordCustomJobsForBooking(ctx, {
        booking: { _id: base.bookingId, shop_id: base.shopId, vin: base.vin },
        mechanicId: base.mechanicId,
        customJobs: [
          {
            name: "Roll fenders",
            // "suspension" is not a slug — "suspension_steering" is. An unknown
            // value must not survive into the column, or the aggregate reads
            // silently grow a category nothing can render.
            system_tags: ["suspension", "body_interior"],
            work_type: "repair",
          },
        ],
        source: "booking",
        now: Date.now(),
      }),
    );

    const row = await t.run(async (ctx: any) => {
      const rows = await ctx.db.query("custom_jobs").collect();
      return rows[0];
    });
    expect(row.system_tags).toEqual(["body_interior"]);
    expect(row.work_type).toBe("repair");
  });

  it("caps the stack at three and keeps the first pick primary", async () => {
    const t = makeT();
    const base = await seedBooking(t, "VINCJTAX5", "tax_cap");

    await t.run(async (ctx: any) =>
      recordCustomJobsForBooking(ctx, {
        booking: { _id: base.bookingId, shop_id: base.shopId, vin: base.vin },
        mechanicId: base.mechanicId,
        customJobs: [
          {
            name: "Heater core replacement",
            system_tags: [
              "climate",
              "engine",
              "electrical",
              "body_interior",
              "climate",
            ],
            work_type: "replace",
          },
        ],
        source: "booking",
        now: Date.now(),
      }),
    );

    const row = await t.run(async (ctx: any) => {
      const rows = await ctx.db.query("custom_jobs").collect();
      return rows[0];
    });
    // Deduped, capped, order preserved — the clustering read groups on [0].
    expect(row.system_tags).toEqual(["climate", "engine", "electrical"]);
  });

  it("carries the taxonomy through a re-entry patch", async () => {
    const t = makeT();
    const base = await seedBooking(t, "VINCJTAX6", "tax_patch");

    const write = (tags: string[], workType: string) =>
      t.run(async (ctx: any) =>
        recordCustomJobsForBooking(ctx, {
          booking: { _id: base.bookingId, shop_id: base.shopId, vin: base.vin },
          mechanicId: base.mechanicId,
          customJobs: [
            { name: "Roll fenders", system_tags: tags, work_type: workType },
          ],
          source: "booking",
          now: Date.now(),
        }),
      );

    await write(["body_interior"], "repair");
    // A booking edit that corrects the tagging must move the row, not fork it.
    await write(["suspension_steering"], "adjust");

    const rows = await t.run(async (ctx: any) =>
      ctx.db.query("custom_jobs").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].system_tags).toEqual(["suspension_steering"]);
    expect(rows[0].work_type).toBe("adjust");
  });
});

/**
 * Parts quoted against a custom line.
 *
 * Before this, the parts editor bucketed strictly by service_id, so a custom
 * line had nowhere to put them: an $78 window switch existed only as prose in
 * the post-job resolution text, invisible to the booking total, the receipt and
 * every catalog-gap read. Parts now ride the existing priced_parts_snapshot
 * (which keeps owning the money) and are denormalised onto custom_jobs so the
 * extraction reads — which never load the booking — can see them.
 */
describe("parts on custom jobs", () => {
  it("groups snapshot rows onto the line they belong to", () => {
    const grouped = customPartsFromSnapshot([
      // A catalog part: no custom_service_name, must not be picked up.
      {
        service_id: "svc_1",
        part_name: "Oil filter",
        quantity: 1,
        line_total_cents: 1200,
      },
      {
        custom_service_name: "Power window switch replacement",
        part_name: "Window switch",
        oem_number: "83071AN00B",
        quantity: 1,
        unit_price_cents: 7855,
        line_total_cents: 7855,
      },
      {
        custom_service_name: "Power Window Switch Replacement",
        part_name: "Door clip",
        quantity: 4,
        unit_price_cents: 150,
        line_total_cents: 600,
      },
    ]);

    expect(grouped.size).toBe(1);
    // Both rows land on one line despite the casing difference — grouping is by
    // serviceMatchKey, the same key custom_jobs itself is keyed on.
    const bucket = [...grouped.values()][0];
    expect(bucket.parts).toHaveLength(2);
    expect(bucket.totalCents).toBe(8455);
  });

  it("attaches them to the row and freezes the quoted total", async () => {
    const t = makeT();
    const base = await seedBooking(t, "VINCJPARTS1", "parts_attach");

    await t.run(async (ctx: any) =>
      recordCustomJobsForBooking(ctx, {
        booking: { _id: base.bookingId, shop_id: base.shopId, vin: base.vin },
        mechanicId: base.mechanicId,
        customJobs: [
          {
            name: "Power window switch replacement",
            system_tags: ["electrical"],
            work_type: "replace",
            parts: [
              {
                part_name: "Window switch",
                oem_number: "83071AN00B",
                quantity: 1,
                unit_price_cents: 7855,
                line_total_cents: 7855,
              },
            ],
            quoted_parts_cents: 7855,
          },
        ],
        source: "booking",
        now: Date.now(),
      }),
    );

    const row = await t.run(async (ctx: any) => {
      const rows = await ctx.db.query("custom_jobs").collect();
      return rows[0];
    });
    expect(row.parts).toHaveLength(1);
    expect(row.parts[0].oem_number).toBe("83071AN00B");
    expect(row.quoted_parts_cents).toBe(7855);
  });

  it("keeps the parts when a booking edit re-sends the line without them", async () => {
    const t = makeT();
    const base = await seedBooking(t, "VINCJPARTS2", "parts_keep");

    const write = (parts: any[] | null, cents: number | null) =>
      t.run(async (ctx: any) =>
        recordCustomJobsForBooking(ctx, {
          booking: { _id: base.bookingId, shop_id: base.shopId, vin: base.vin },
          mechanicId: base.mechanicId,
          customJobs: [
            {
              name: "Power window switch replacement",
              system_tags: ["electrical"],
              work_type: "replace",
              parts,
              quoted_parts_cents: cents,
            },
          ],
          source: "booking",
          now: Date.now(),
        }),
      );

    await write(
      [{ part_name: "Window switch", quantity: 1, line_total_cents: 7855 }],
      7855,
    );
    // A re-entry that carries no parts (e.g. an edit to the time only) must not
    // erase what was already quoted — that would silently drop money off the job.
    await write(null, null);

    const row = await t.run(async (ctx: any) => {
      const rows = await ctx.db.query("custom_jobs").collect();
      return rows[0];
    });
    expect(row.parts).toHaveLength(1);
    expect(row.quoted_parts_cents).toBe(7855);
  });
});
