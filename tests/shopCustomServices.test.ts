/**
 * Shop shortcuts for off-catalog work (Off-Catalog Work spec, §3, §4).
 *
 * The shortcut isn't a convenience feature with a data side-effect — the data IS
 * the point. Pressing a button instead of retyping turns forty spellings into one
 * key pressed forty times, which is what makes repeat counts exact and labor
 * distributions real.
 *
 * Two things therefore need protecting, and they pull in opposite directions:
 *   - a shortcut must never quietly encode a canonical service, because that
 *     mistake is replayed on every press (hence the STRICT blocking gate)
 *   - a shortcut must never silently split its own history (hence idempotency,
 *     revive-on-recreate, and the refusal to support rename)
 */
import { describe, it, expect } from "vitest";
import { makeT, identityFor } from "./helpers";
import { api } from "../convex/_generated/api";
import {
  recordShortcutUse,
  recordShortcutActual,
  shortcutMinutesStats,
} from "../convex/shopCustomServices";
import {
  recordCustomJobsForBooking,
  completeCustomJobsForBooking,
} from "../convex/customJobs";

const OWNER_CLERK = "clerk_shortcut_owner";

/** A shop owned by an authenticated user, plus a mechanic. */
async function seedShop(t: ReturnType<typeof makeT>) {
  return t.run(async (ctx: any) => {
    const ownerId = await ctx.db.insert("users", {
      clerkUserId: OWNER_CLERK,
      email: "owner@test.local",
      role: "shop_owner",
      createdAt: Date.now(),
    });
    const shopId = await ctx.db.insert("shops", {
      name: "Brooklyn Auto",
      owner_user_id: ownerId,
    } as any);
    const mechanicId = await ctx.db.insert("mechanics", {
      shop_id: shopId,
      first_name: "Mike",
      last_name: "Reyes",
    } as any);
    return { ownerId, shopId, mechanicId };
  });
}

describe("the strict creation gate", () => {
  it("refuses a shortcut whose name is really a catalog service", async () => {
    const t = makeT();
    const { shopId } = await seedShop(t);
    const serviceId = await t.run(async (ctx: any) =>
      ctx.db.insert("services", { name: "Oil Change", slug: "oil_change" }),
    );

    const res: any = await t
      .withIdentity(identityFor(OWNER_CLERK))
      .mutation(api.shopCustomServices.create, {
        shopId,
        name: "Change the oil",
      });

    // Blocking, not advising: this button would otherwise deny maintenance
    // credit every single time it was pressed.
    expect(res.ok).toBe(false);
    expect(res.blocked).toBe("canonical_match");
    expect(res.suggestion?.serviceId).toBe(String(serviceId));

    const rows = await t.run(async (ctx: any) =>
      ctx.db.query("shop_custom_services").collect(),
    );
    expect(rows).toHaveLength(0);
  });

  it("lets the mechanic insist once they've seen the suggestion", async () => {
    const t = makeT();
    const { shopId } = await seedShop(t);
    await t.run(async (ctx: any) =>
      ctx.db.insert("services", { name: "Oil Change", slug: "oil_change" }),
    );

    const res: any = await t
      .withIdentity(identityFor(OWNER_CLERK))
      .mutation(api.shopCustomServices.create, {
        shopId,
        name: "Change the oil",
        confirmedCustom: true,
      });
    expect(res.ok).toBe(true);
  });

  it("does not block on a merely plausible match", async () => {
    // "medium" confidence is a guess. Blocking on guesses trains mechanics to
    // click straight through the warning, which costs us the real ones.
    const t = makeT();
    const { shopId } = await seedShop(t);
    await t.run(async (ctx: any) =>
      ctx.db.insert("services", {
        name: "Fuel System Cleaning",
        slug: "fuel_system_cleaning",
      }),
    );

    const res: any = await t
      .withIdentity(identityFor(OWNER_CLERK))
      .mutation(api.shopCustomServices.create, {
        shopId,
        name: "Carbon cleaning (walnut blast)",
      });
    expect(res.ok).toBe(true);
  });

  it("requires shop authorisation", async () => {
    const t = makeT();
    const { shopId } = await seedShop(t);
    await t.run(async (ctx: any) =>
      ctx.db.insert("users", {
        clerkUserId: "clerk_outsider",
        email: "outsider@test.local",
        role: "shop_owner",
        createdAt: Date.now(),
      }),
    );
    await expect(
      t
        .withIdentity(identityFor("clerk_outsider"))
        .mutation(api.shopCustomServices.create, {
          shopId,
          name: "Ceramic coating",
        }),
    ).rejects.toThrow(/Not authorized/);
  });
});

describe("a shortcut never splits its own history", () => {
  it("recreating the same name returns the existing shortcut", async () => {
    const t = makeT();
    const { shopId } = await seedShop(t);
    const asOwner = t.withIdentity(identityFor(OWNER_CLERK));

    const first: any = await asOwner.mutation(api.shopCustomServices.create, {
      shopId,
      name: "Carbon cleaning",
      defaultMinutes: 180,
    });
    // Re-phrased, but the same work — the match key is order-insensitive.
    const second: any = await asOwner.mutation(api.shopCustomServices.create, {
      shopId,
      name: "cleaning carbon",
      defaultMinutes: 200,
    });

    expect(second.created).toBe(false);
    expect(String(second.id)).toBe(String(first.id));

    const rows = await t.run(async (ctx: any) =>
      ctx.db.query("shop_custom_services").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].default_minutes).toBe(200);
    // The original name is preserved — a shortcut is never renamed by re-entry.
    expect(rows[0].name).toBe("Carbon cleaning");
  });

  it("recreating a retired shortcut revives it rather than forking the key", async () => {
    const t = makeT();
    const { shopId } = await seedShop(t);
    const asOwner = t.withIdentity(identityFor(OWNER_CLERK));

    const created: any = await asOwner.mutation(api.shopCustomServices.create, {
      shopId,
      name: "Ceramic coating",
    });
    await asOwner.mutation(api.shopCustomServices.retire, { id: created.id });
    const again: any = await asOwner.mutation(api.shopCustomServices.create, {
      shopId,
      name: "Ceramic coating",
    });

    expect(String(again.id)).toBe(String(created.id));
    const rows = await t.run(async (ctx: any) =>
      ctx.db.query("shop_custom_services").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].retired_at).toBeUndefined();
  });

  it("retiring hides it from the picker but keeps the row", async () => {
    const t = makeT();
    const { shopId } = await seedShop(t);
    const asOwner = t.withIdentity(identityFor(OWNER_CLERK));

    const created: any = await asOwner.mutation(api.shopCustomServices.create, {
      shopId,
      name: "Underbody rustproofing",
    });
    await asOwner.mutation(api.shopCustomServices.retire, { id: created.id });

    const listed = await asOwner.query(api.shopCustomServices.listForShop, {
      shopId,
    });
    expect(listed).toHaveLength(0);
    // Past custom_jobs rows still point here, so the row must survive.
    const row = await t.run(async (ctx: any) => ctx.db.get(created.id));
    expect(row).not.toBeNull();
  });

  it("updateDefaults cannot rename", async () => {
    // Renaming a shortcut with history retroactively changes what past jobs were
    // called. The mutation simply has no name argument — this asserts that stays
    // true if someone adds one carelessly.
    const t = makeT();
    const { shopId } = await seedShop(t);
    const asOwner = t.withIdentity(identityFor(OWNER_CLERK));
    const created: any = await asOwner.mutation(api.shopCustomServices.create, {
      shopId,
      name: "Roll fenders",
      defaultMinutes: 90,
    });

    await asOwner.mutation(api.shopCustomServices.updateDefaults, {
      id: created.id,
      defaultMinutes: 120,
    });

    const row = await t.run(async (ctx: any) => ctx.db.get(created.id));
    expect((row as any).name).toBe("Roll fenders");
    expect((row as any).default_minutes).toBe(120);
    expect((row as any).match_key).toBe("fender roll");
  });

  it("orders the picker by use, so last week's work is at hand", async () => {
    const t = makeT();
    const { shopId } = await seedShop(t);
    const asOwner = t.withIdentity(identityFor(OWNER_CLERK));
    const rare: any = await asOwner.mutation(api.shopCustomServices.create, {
      shopId,
      name: "Roll fenders",
    });
    const common: any = await asOwner.mutation(api.shopCustomServices.create, {
      shopId,
      name: "Carbon cleaning",
    });

    await t.run(async (ctx: any) => {
      for (let i = 0; i < 3; i++) {
        await recordShortcutUse(ctx, {
          shortcutId: common.id,
          now: Date.now(),
        });
      }
      await recordShortcutUse(ctx, { shortcutId: rare.id, now: Date.now() });
    });

    const listed = await asOwner.query(api.shopCustomServices.listForShop, {
      shopId,
    });
    expect(listed[0].name).toBe("Carbon cleaning");
    expect(listed[0].use_count).toBe(3);
  });
});

describe("drift is measured, not prevented", () => {
  it("accumulates a labor distribution without storing every sample", async () => {
    const t = makeT();
    const { shopId } = await seedShop(t);
    const created: any = await t
      .withIdentity(identityFor(OWNER_CLERK))
      .mutation(api.shopCustomServices.create, {
        shopId,
        name: "Carbon cleaning",
        defaultMinutes: 180,
      });

    await t.run(async (ctx: any) => {
      for (const minutes of [170, 180, 190]) {
        await recordShortcutActual(ctx, {
          shortcutId: created.id,
          actualMinutes: minutes,
          now: Date.now(),
        });
      }
    });

    const row: any = await t.run(async (ctx: any) => ctx.db.get(created.id));
    const stats = shortcutMinutesStats(row);
    expect(stats.samples).toBe(3);
    expect(stats.mean).toBeCloseTo(180, 5);
    // Tight cluster → low coefficient of variation. This shortcut is healthy.
    expect(stats.cv).toBeLessThan(0.1);
    expect(row.deviation_count ?? 0).toBe(0);
  });

  it("flags the button being pressed for genuinely different jobs", async () => {
    // The §3 failure mode: one key covering three kinds of work gives a bimodal
    // distribution that looks trustworthy. We can't tell drift from
    // config-dependence automatically, so we flag and let the complaint texts
    // settle it.
    const t = makeT();
    const { shopId } = await seedShop(t);
    const created: any = await t
      .withIdentity(identityFor(OWNER_CLERK))
      .mutation(api.shopCustomServices.create, {
        shopId,
        name: "Brake job custom",
        defaultMinutes: 60,
        confirmedCustom: true,
      });

    await t.run(async (ctx: any) => {
      for (const minutes of [60, 65, 240, 300]) {
        await recordShortcutActual(ctx, {
          shortcutId: created.id,
          actualMinutes: minutes,
          now: Date.now(),
        });
      }
    });

    const row: any = await t.run(async (ctx: any) => ctx.db.get(created.id));
    expect(row.deviation_count).toBe(2);
    expect(shortcutMinutesStats(row).cv).toBeGreaterThan(0.5);
  });

  it("reports no variance from a single sample rather than a fake zero", async () => {
    const t = makeT();
    const { shopId } = await seedShop(t);
    const created: any = await t
      .withIdentity(identityFor(OWNER_CLERK))
      .mutation(api.shopCustomServices.create, {
        shopId,
        name: "Ceramic coating",
      });
    await t.run(async (ctx: any) =>
      recordShortcutActual(ctx, {
        shortcutId: created.id,
        actualMinutes: 120,
        now: Date.now(),
      }),
    );
    const row: any = await t.run(async (ctx: any) => ctx.db.get(created.id));
    const stats = shortcutMinutesStats(row);
    expect(stats.samples).toBe(1);
    expect(stats.cv).toBeNull();
  });
});

describe("shortcut ↔ custom job wiring", () => {
  it("pressing a shortcut bumps its use count and feeds back its actuals", async () => {
    const t = makeT();
    const { shopId, mechanicId } = await seedShop(t);
    const created: any = await t
      .withIdentity(identityFor(OWNER_CLERK))
      .mutation(api.shopCustomServices.create, {
        shopId,
        name: "Carbon cleaning",
        defaultMinutes: 180,
      });

    const bookingId = await t.run(async (ctx: any) => {
      const userId = await ctx.db.insert("users", {
        clerkUserId: "clerk_cust_sc",
        email: "cust@test.local",
        role: "customer",
        createdAt: Date.now(),
      });
      return ctx.db.insert("bookings", {
        vin: "VINSC0001",
        user_id: userId,
        service_ids: [],
        status: "in_progress",
      } as any);
    });

    await t.run(async (ctx: any) =>
      recordCustomJobsForBooking(ctx, {
        booking: { _id: bookingId, shop_id: shopId, vin: "VINSC0001" },
        mechanicId,
        customJobs: [
          {
            name: "Carbon cleaning",
            complaint: "Rough idle",
            shop_custom_service_id: created.id,
          },
        ],
        source: "booking",
        now: Date.now(),
      }),
    );

    let row: any = await t.run(async (ctx: any) => ctx.db.get(created.id));
    expect(row.use_count).toBe(1);
    expect(row.last_complaint).toBe("Rough idle");

    await t.run(async (ctx: any) =>
      completeCustomJobsForBooking(ctx, {
        bookingId,
        outcomes: [
          {
            name: "Carbon cleaning",
            actual_minutes: 200,
            resolution: "Walnut blasted",
            resolved_complaint: true,
          },
        ],
        now: Date.now(),
      }),
    );

    row = await t.run(async (ctx: any) => ctx.db.get(created.id));
    expect(row.minutes_samples).toBe(1);
    expect(row.minutes_sum).toBe(200);
  });
});

describe("mid-job add", () => {
  async function seedInProgress(t: ReturnType<typeof makeT>, status: string) {
    const { shopId, mechanicId, ownerId } = await seedShop(t);
    const bookingId = await t.run(async (ctx: any) => {
      const userId = await ctx.db.insert("users", {
        clerkUserId: "clerk_cust_mid",
        email: "midcust@test.local",
        role: "customer",
        createdAt: Date.now(),
      });
      return ctx.db.insert("bookings", {
        vin: "VINMID001",
        user_id: userId,
        shop_id: shopId,
        mechanic_id: mechanicId,
        service_ids: [],
        status,
      } as any);
    });
    return { shopId, mechanicId, ownerId, bookingId };
  }

  it("appends the line and records the structured row", async () => {
    const t = makeT();
    const { bookingId } = await seedInProgress(t, "in_progress");

    const res: any = await t
      .withIdentity(identityFor(OWNER_CLERK))
      .mutation(api.customJobs.addMidJobCustomService, {
        bookingId,
        name: "Replace cracked intake hose",
        complaint: "Found split hose while doing the oil change",
        estimatedMinutes: 45,
      });

    expect(res.ok).toBe(true);
    expect(res.addedLine).toBe(true);
    // Money is untouched — the existing mid-job approval cycle owns re-quoting.
    expect(res.requiresApproval).toBe(true);

    const { booking, jobs } = await t.run(async (ctx: any) => ({
      booking: await ctx.db.get(bookingId),
      jobs: await ctx.db.query("custom_jobs").collect(),
    }));
    expect((booking as any).custom_services).toHaveLength(1);
    expect((booking as any).custom_services[0].duration_minutes).toBe(45);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].source).toBe("mid_job");
    expect(jobs[0].complaint).toBe(
      "Found split hose while doing the oil change",
    );
  });

  it("a double-tap does not duplicate the line or the row", async () => {
    const t = makeT();
    const { bookingId } = await seedInProgress(t, "in_progress");
    const asOwner = t.withIdentity(identityFor(OWNER_CLERK));

    await asOwner.mutation(api.customJobs.addMidJobCustomService, {
      bookingId,
      name: "Roll fenders",
      estimatedMinutes: 90,
    });
    const second: any = await asOwner.mutation(
      api.customJobs.addMidJobCustomService,
      { bookingId, name: "roll fender", estimatedMinutes: 90 },
    );

    expect(second.addedLine).toBe(false);
    const { booking, jobs } = await t.run(async (ctx: any) => ({
      booking: await ctx.db.get(bookingId),
      jobs: await ctx.db.query("custom_jobs").collect(),
    }));
    expect((booking as any).custom_services).toHaveLength(1);
    expect(jobs).toHaveLength(1);
  });

  it("refuses when the job isn't running", async () => {
    // Adding work to a booking nobody is standing at would land money on a job
    // that can't be approved — the same gate submitMidJobChange enforces.
    const t = makeT();
    const { bookingId } = await seedInProgress(t, "confirmed");
    await expect(
      t
        .withIdentity(identityFor(OWNER_CLERK))
        .mutation(api.customJobs.addMidJobCustomService, {
          bookingId,
          name: "Roll fenders",
        }),
    ).rejects.toThrow(/in progress/);
  });

  it("refuses a caller who isn't shop staff", async () => {
    const t = makeT();
    const { bookingId } = await seedInProgress(t, "in_progress");
    await t.run(async (ctx: any) =>
      ctx.db.insert("users", {
        clerkUserId: "clerk_outsider_mid",
        email: "outsider2@test.local",
        role: "user",
        createdAt: Date.now(),
      }),
    );
    await expect(
      t
        .withIdentity(identityFor("clerk_outsider_mid"))
        .mutation(api.customJobs.addMidJobCustomService, {
          bookingId,
          name: "Roll fenders",
        }),
    ).rejects.toThrow(/Not authorized/);
  });
});
