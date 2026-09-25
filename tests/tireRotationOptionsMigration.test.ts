import { describe, expect, test } from "vitest";

import { api } from "../convex/_generated/api";
import { makeT } from "./helpers";

describe("migrations.retireTireRotationOptions", () => {
  test("retires obsolete Tire Rotation choices so it can be booked directly", async () => {
    const t = makeT();
    const serviceId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("services", {
        name: "Tire Rotation",
        slug: "tire-rotation",
        has_options: true,
      });
      await ctx.db.insert("service_options", {
        service_id: id,
        option_label: "Front 2 only",
        option_type: "tire_set",
      });
      await ctx.db.insert("service_options", {
        service_id: id,
        option_label: "All 4 tires + balance",
        option_type: "tire_set",
      });
      return id;
    });

    await t.mutation(api.migrations.retireTireRotationOptions, {});

    const { options, service } = await t.run(async (ctx) => ({
      service: await ctx.db.get(serviceId),
      options: await ctx.db
        .query("service_options")
        .withIndex("by_service_id", (q) => q.eq("service_id", serviceId))
        .collect(),
    }));

    expect(service?.has_options).toBe(false);
    expect(options).toEqual([]);
  });
});
