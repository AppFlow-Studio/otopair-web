/**
 * D1 Fix B — a recommendation for work this visit actually did must never
 * reach the customer report.
 *
 * deriveSuggestedRecommendations is a pure function of inspection state, so it
 * emits "Wiper Blade Replacement / soon" off a red `wipe` reading and has no
 * idea the wipers were fitted an hour ago. Abdul hit it twice on Aug 20 — once
 * on wipers, once on a tire he'd already replaced.
 *
 * The 2-hour deferred reveal was built for exactly this ("a problem fixed in
 * the same visit never surfaces a stale recommendation") but only ever deferred
 * the reveal; it never re-checked. These tests pin the re-check, and pin the
 * two cases where suppression must NOT happen.
 */
import { describe, expect, it } from "vitest";
import {
  collectPerformedWork,
  EMPTY_PERFORMED_WORK,
  recommendationWasPerformed,
  type PerformedWork,
} from "../convex/lib/performedWork";
import { makeT } from "./helpers";
import { serviceMatchKey } from "../convex/lib/serviceMatch";

function performed(opts: {
  serviceIds?: string[];
  slugs?: string[];
  names?: string[];
}): PerformedWork {
  return {
    serviceIds: new Set(opts.serviceIds ?? []),
    slugs: new Set(opts.slugs ?? []),
    matchKeys: new Set((opts.names ?? []).map(serviceMatchKey)),
  };
}

describe("recommendationWasPerformed", () => {
  it("suppresses a catalog rec whose service was on the job", () => {
    expect(
      recommendationWasPerformed(
        { recommended_service_id: "svc_tires" },
        performed({ serviceIds: ["svc_tires"] }),
      ),
    ).toBe(true);
  });

  it("keeps a catalog rec for a service this visit did not touch", () => {
    expect(
      recommendationWasPerformed(
        { recommended_service_id: "svc_brakes" },
        performed({ serviceIds: ["svc_tires"] }),
      ),
    ).toBe(false);
  });

  it("suppresses the wiper advisory when a wiper line was completed", () => {
    // The exact session case: freeform rec (no catalog service), matched by
    // name against the off-catalog line the mechanic actually did.
    expect(
      recommendationWasPerformed(
        { freeform_text: "Wiper Blade Replacement" },
        performed({ names: ["Replace wiper blades"] }),
      ),
    ).toBe(true);
  });

  it("clears the oil top-off when the visit changed the oil", () => {
    // Per spec: "an oil change clears the oil top-off. Never recommend both."
    // These two share no useful tokens, so it needs the explicit pairing.
    expect(
      recommendationWasPerformed(
        { freeform_text: "Oil Top-Off" },
        performed({ slugs: ["oil_change"] }),
      ),
    ).toBe(true);
  });

  it("does not clear the oil top-off from an unrelated service", () => {
    expect(
      recommendationWasPerformed(
        { freeform_text: "Oil Top-Off" },
        performed({ slugs: ["tire_replacement"] }),
      ),
    ).toBe(false);
  });

  it("keeps everything when nothing was performed", () => {
    // EMPTY_PERFORMED_WORK is what a cancelled / no-show booking yields. A
    // swallowed finding on a car nobody touched is the dangerous direction.
    expect(
      recommendationWasPerformed(
        { recommended_service_id: "svc_tires" },
        EMPTY_PERFORMED_WORK,
      ),
    ).toBe(false);
    expect(
      recommendationWasPerformed(
        { freeform_text: "Wiper Blade Replacement" },
        EMPTY_PERFORMED_WORK,
      ),
    ).toBe(false);
  });

  it("ignores a blank freeform label rather than matching everything", () => {
    expect(
      recommendationWasPerformed(
        { freeform_text: "   " },
        performed({ names: ["Oil Change"] }),
      ),
    ).toBe(false);
  });
});

// #428 (from #206 / #340): the same-visit suppression covered the services that
// were booked and missed the ones added mid-job. An oil change added mid-job
// was recorded by name only, so the slug override never saw it and "Oil
// Top-Off" was revealed to the driver after the oil had been changed.
describe("collectPerformedWork — added scope counts like booked scope", () => {
  it("a mid-job catalog line contributes its service id and slug", async () => {
    const t = makeT();
    const result = await t.run(async (ctx: any) => {
      const userId = await ctx.db.insert("users", {
        clerkUserId: "c_perf",
        email: "perf@test.local",
        role: "customer",
        createdAt: Date.now(),
      });
      const shopId = await ctx.db.insert("shops", {
        name: "Test Shop",
        owner_user_id: userId,
        is_active: true,
        timezone: "America/New_York",
        no_show_threshold_minutes: 30,
        overrun_default_extension_percent: 25,
        overrun_extension_floor_minutes: 5,
        max_bookings_per_mechanic_rolling_hour: 2,
        entity_label_mode: "mechanic",
      });
      const oil = await ctx.db.insert("services", { name: "Oil Change", slug: "oil_change" });
      const bookingId = await ctx.db.insert("bookings", {
        vin: "VINPERF",
        user_id: userId,
        service_ids: [],
        status: "completed",
      });
      for (const [name, status, catalog] of [
        ["Oil Change", "completed", oil],
        ["Weld exhaust bracket", "completed", undefined],
        ["Cabin Filter", "declined", undefined],
      ] as const) {
        await ctx.db.insert("custom_jobs", {
          booking_id: bookingId,
          shop_id: shopId,
          vehicle_vin: "VINPERF",
          name,
          normalized_name: name.toLowerCase(),
          match_key: serviceMatchKey(name),
          system_tags: ["engine"],
          work_type: "service",
          ...(catalog ? { catalog_service_id: catalog } : {}),
          source: "mid_job",
          status,
          created_at: Date.now(),
        });
      }
      const booking = await ctx.db.get(bookingId);
      const work = await collectPerformedWork(ctx, booking);
      // Sets don't cross the convex-test boundary; carry them as arrays.
      return {
        serviceIds: [...work.serviceIds],
        slugs: [...work.slugs],
        matchKeys: [...work.matchKeys],
        oil: String(oil),
      };
    });
    const work: PerformedWork = {
      serviceIds: new Set(result.serviceIds),
      slugs: new Set(result.slugs),
      matchKeys: new Set(result.matchKeys),
    };

    expect(work.slugs.has("oil_change")).toBe(true);
    expect(work.serviceIds.has(result.oil)).toBe(true);
    expect(
      recommendationWasPerformed({ freeform_text: "Oil Top-Off" }, work),
    ).toBe(true);
    // Off-catalog and declined lines stay name-only / excluded, as before.
    expect(work.matchKeys.has(serviceMatchKey("Weld exhaust bracket"))).toBe(true);
    expect(work.matchKeys.has(serviceMatchKey("Cabin Filter"))).toBe(false);
  });
});
