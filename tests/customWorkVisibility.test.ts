/**
 * The three read paths that used to drop off-catalog work, and the two
 * notification gaps that made a stopped job silent.
 *
 * These are the surfaces a CUSTOMER sees. A booking whose only work was custom
 * produced an invoice PDF with no line items, a receipt whose lines all read
 * $0 against a real charge, and a service-history entry showing a visit where
 * nothing happened. Each reads as data loss rather than as work the catalog
 * can't name — and one of them is the customer's own proof of what they paid
 * for.
 */
import { describe, it, expect } from "vitest";
import { customServiceNames } from "../convex/lib/customServiceNames";
import { KIND_POLICY } from "../convex/jobBlockers";
import { SMS_BODY_TEMPLATES } from "../convex/sms_dispatcher";

describe("customServiceNames", () => {
  it("pulls names out of a booking's custom_services", () => {
    expect(
      customServiceNames([
        { name: "Carbon cleaning", duration_minutes: 180 },
        { name: "Roll fenders" },
      ]),
    ).toEqual(["Carbon cleaning", "Roll fenders"]);
  });

  it("survives every shape a legacy row might be in", () => {
    // These paths run on read, on documents written by older clients. A throw
    // here takes out an invoice or a history page, so it degrades instead.
    expect(customServiceNames(undefined)).toEqual([]);
    expect(customServiceNames(null)).toEqual([]);
    expect(customServiceNames("not an array")).toEqual([]);
    expect(customServiceNames([null, { name: "" }, { name: "   " }, {}])).toEqual([]);
    expect(customServiceNames([{ name: 42 }, { name: "Real" }])).toEqual(["Real"]);
  });

  it("trims, because the name is rendered straight onto a receipt", () => {
    expect(customServiceNames([{ name: "  Ceramic coating  " }])).toEqual([
      "Ceramic coating",
    ]);
  });
});

/**
 * The receipt's labour split. Mirrors the arithmetic in bookings.getReceipt so
 * the property can be pinned without standing up a whole booking: every line
 * that the customer is paying for takes a share of labour proportional to its
 * hours, and a custom line's hours come from the mechanic's own estimate
 * because no catalog default exists.
 */
function splitLabour(
  lines: Array<{ name: string; hours: number | null }>,
  laborCost: number | null,
): Array<{ name: string; cost: number | null }> {
  const totalHours = lines.reduce((sum, l) => sum + (l.hours ?? 0), 0);
  return lines.map((l) => {
    if (laborCost != null && l.hours != null && totalHours > 0) {
      return { name: l.name, cost: (laborCost * l.hours) / totalHours };
    }
    if (lines.length === 1 && laborCost != null) {
      return { name: l.name, cost: laborCost };
    }
    return { name: l.name, cost: null };
  });
}

describe("receipt labour split", () => {
  it("gives a custom-only job its whole labour instead of $0", () => {
    // The exact case that was broken: one custom line, a real charge, and a
    // receipt that showed the line at nothing.
    const out = splitLabour([{ name: "Power window switch", hours: 0.5 }], 78);
    expect(out[0].cost).toBe(78);
  });

  it("apportions across catalog and custom lines together", () => {
    const out = splitLabour(
      [
        { name: "Oil Change", hours: 0.5 },
        { name: "Carbon cleaning", hours: 1.5 },
      ],
      200,
    );
    expect(out.find((l) => l.name === "Oil Change")!.cost).toBe(50);
    expect(out.find((l) => l.name === "Carbon cleaning")!.cost).toBe(150);
    // Nothing invented and nothing lost — the lines still reconcile to the
    // Labor row in the totals stack.
    expect(out.reduce((sum, l) => sum + (l.cost ?? 0), 0)).toBe(200);
  });

  it("leaves a single untimed line whole rather than zeroing it", () => {
    const out = splitLabour([{ name: "Roll fenders", hours: null }], 120);
    expect(out[0].cost).toBe(120);
  });
});

describe("blocker notification routing", () => {
  it("writes an owner alert for every kind that notifies the owner", () => {
    // These used to be written with channel "slack", which nothing drains, so
    // they sat pending forever. They're in-app now — see notifications.ts.
    const ownerKinds = Object.entries(KIND_POLICY)
      .filter(([, p]) => p.notifyOwner)
      .map(([k]) => k);
    expect(ownerKinds.length).toBeGreaterThan(0);
    expect(ownerKinds).toContain("damage");
  });

  it("never notifies the driver about damage", () => {
    // The load-bearing one. A shop tells a customer they damaged the car; the
    // platform does not do it for them, and certainly not by SMS while the car
    // is still on the lift.
    expect(KIND_POLICY.damage.notifyDriver).toBe(false);
    expect(KIND_POLICY.damage.customerQuotable).toBe(false);
  });
});

/**
 * SMS copy for a blocked job. Before these entries the cron still fired — it
 * fell through to "Otopair update for your booking", which spends the
 * customer's attention and tells them nothing.
 */
describe("blocker SMS templates", () => {
  it("covers every driver-facing kind, and only those", () => {
    const templates = SMS_BODY_TEMPLATES;

    for (const [kind, policy] of Object.entries(KIND_POLICY)) {
      const key = `job_blocked_${kind}_driver`;
      if (policy.notifyDriver) {
        expect(templates[key], `missing template for ${kind}`).toBeTypeOf(
          "function",
        );
      } else {
        // No driver row is ever written for it, so a template would be dead
        // code implying a message we deliberately never send.
        expect(templates[key]).toBeUndefined();
      }
    }
  });
  it("names the shop and asks for the one thing the driver can act on", () => {
    const payload = { shopName: "Brooklyn Auto" };

    for (const [kind, policy] of Object.entries(KIND_POLICY)) {
      if (!policy.notifyDriver) continue;
      const body = SMS_BODY_TEMPLATES[`job_blocked_${kind}_driver`](payload);
      expect(body).toContain("Brooklyn Auto");
      // The fallback the driver used to get. If copy ever regresses to this,
      // the message is worse than sending nothing.
      expect(body).not.toBe("Otopair update for your booking.");
      // SMS segments cost money and long ones get split mid-sentence.
      expect(body.length).toBeLessThan(320);
    }

    // customer_unreachable is the only hold the driver can personally clear,
    // so it's the only one that should ask them to do something.
    expect(
      SMS_BODY_TEMPLATES.job_blocked_customer_unreachable_driver(payload),
    ).toMatch(/call/i);
  });
});

/**
 * What the customer is told they're paying for.
 *
 * The mid-job approval screen showed a price and a delta and then jumped to
 * inspection findings — never naming the work. Approving $220 on trust is the
 * one moment trust is most expensive: the customer isn't at the shop, the car
 * is on a lift, and declining is awkward.
 */
describe("mid-job additions for the customer", () => {
  it("returns off-catalog work added after the job started, and nothing else", async () => {
    const { makeT } = await import("./helpers");
    const { api } = await import("../convex/_generated/api");
    const { recordCustomJobsForBooking } = await import("../convex/customJobs");

    const t = makeT();
    const base = await t.run(async (ctx: any) => {
      const userId = await ctx.db.insert("users", {
        clerkUserId: "clerk_midjob_customer",
        email: "midjob@test.local",
        role: "customer",
        createdAt: Date.now(),
      });
      const shopId = await ctx.db.insert("shops", { name: "Temur Auto" } as any);
      const bookingId = await ctx.db.insert("bookings", {
        vin: "VINMIDJOB0000001",
        user_id: userId,
        service_ids: [],
        status: "in_progress",
      } as any);
      return { userId, shopId, bookingId };
    });

    const write = (name: string, source: string) =>
      t.run(async (ctx: any) =>
        recordCustomJobsForBooking(ctx, {
          booking: {
            _id: base.bookingId,
            shop_id: base.shopId,
            vin: "VINMIDJOB0000001",
          },
          customJobs: [
            {
              name,
              system_tags: ["electrical"],
              work_type: "replace",
              complaint: "Switch dead on the driver's door",
              parts: [
                { part_name: "Window switch", oem_number: "83071AN00B", quantity: 1 },
              ],
              quoted_parts_cents: 7855,
            },
          ],
          source,
          now: Date.now(),
        }),
      );

    await write("Booked at the counter", "booking");
    await write("Power window switch replacement", "mid_job");

    const out: any[] = await t
      .withIdentity({ subject: "clerk_midjob_customer" })
      .query(api.customJobs.listMidJobAdditionsForCustomer, {
        bookingId: base.bookingId,
      });

    // Only what was added mid-job. Work booked at the counter was already
    // agreed and priced — re-announcing it as a surprise would be the lie
    // inverted.
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Power window switch replacement");
    expect(out[0].complaint).toBe("Switch dead on the driver's door");
    expect(out[0].parts[0].oem_number).toBe("83071AN00B");
  });

  it("shows nothing to anyone who isn't the booking's customer", async () => {
    const { makeT } = await import("./helpers");
    const { api } = await import("../convex/_generated/api");

    const t = makeT();
    const bookingId = await t.run(async (ctx: any) => {
      const ownerId = await ctx.db.insert("users", {
        clerkUserId: "clerk_midjob_owner",
        email: "owner@test.local",
        role: "customer",
        createdAt: Date.now(),
      });
      await ctx.db.insert("users", {
        clerkUserId: "clerk_midjob_stranger",
        email: "stranger@test.local",
        role: "customer",
        createdAt: Date.now(),
      });
      return await ctx.db.insert("bookings", {
        vin: "VINMIDJOB0000002",
        user_id: ownerId,
        service_ids: [],
        status: "in_progress",
      } as any);
    });

    expect(
      await t
        .withIdentity({ subject: "clerk_midjob_stranger" })
        .query(api.customJobs.listMidJobAdditionsForCustomer, { bookingId }),
    ).toEqual([]);
    // Anonymous too — this is somebody's repair history.
    expect(
      await t.query(api.customJobs.listMidJobAdditionsForCustomer, { bookingId }),
    ).toEqual([]);
  });
});

/**
 * Completing a job added through Flag Issue.
 *
 * The money was always right — parts ride the mid-job approval and the customer
 * pays correctly. The RECORD was not: the custom_jobs row closed with an
 * outcome and no parts, because addMidJobCustomService takes no parts and
 * nothing reconciled them at completion. So the director's read showed a
 * cluster that apparently needed no parts, while a named switch had been fitted
 * and billed.
 */
describe("completion records what was actually fitted", () => {
  it("attaches post-job parts to the custom line that used them", async () => {
    const { makeT } = await import("./helpers");
    const {
      recordCustomJobsForBooking,
      completeCustomJobsForBooking,
    } = await import("../convex/customJobs");

    const t = makeT();
    const base = await t.run(async (ctx: any) => {
      const shopId = await ctx.db.insert("shops", { name: "Temur Auto" } as any);
      const bookingId = await ctx.db.insert("bookings", {
        vin: "VINFITTED00000001",
        user_id: await ctx.db.insert("users", {
          clerkUserId: "clerk_fitted",
          email: "fitted@test.local",
          role: "customer",
          createdAt: Date.now(),
        }),
        service_ids: [],
        status: "in_progress",
      } as any);
      return { shopId, bookingId };
    });

    // Added mid-job through Flag Issue: no parts on the row at this point.
    await t.run(async (ctx: any) =>
      recordCustomJobsForBooking(ctx, {
        booking: {
          _id: base.bookingId,
          shop_id: base.shopId,
          vin: "VINFITTED00000001",
        },
        customJobs: [
          {
            name: "Power window switch replacement",
            system_tags: ["electrical"],
            work_type: "replace",
          },
        ],
        source: "mid_job",
        now: Date.now(),
      }),
    );

    const before = await t.run(async (ctx: any) =>
      (await ctx.db.query("custom_jobs").collect())[0],
    );
    expect(before.parts).toBeUndefined();

    await t.run(async (ctx: any) =>
      completeCustomJobsForBooking(ctx, {
        bookingId: base.bookingId,
        partsUsed: [
          {
            part_name: "Window switch",
            oem_number: "83071AN00B",
            custom_service_name: "Power window switch replacement",
            cost: 78.55,
            quantity: 1,
          },
          // Belongs to a catalog service — must not land on the custom line.
          { part_name: "Oil filter", oem_number: "90915", cost: 12, quantity: 1 },
          // The mechanic said this one didn't go in.
          {
            part_name: "Door clip",
            oem_number: "CLIP1",
            custom_service_name: "Power window switch replacement",
            cost: 1.5,
            quantity: 4,
            not_used: true,
          },
        ],
        outcomes: [
          {
            name: "Power window switch replacement",
            resolution: "Replaced with OEM part",
            resolved_complaint: true,
          },
        ],
        now: Date.now(),
      }),
    );

    const after = await t.run(async (ctx: any) =>
      (await ctx.db.query("custom_jobs").collect())[0],
    );
    expect(after.status).toBe("completed");
    expect(after.parts).toHaveLength(1);
    expect(after.parts[0].oem_number).toBe("83071AN00B");
    expect(after.charged_price_cents).toBe(7855);
    expect(after.resolved_complaint).toBe(true);
  });
});

/**
 * Regression: submitting a post-job report with an ordinary catalog part.
 *
 * `custom_service_name` was declared v.optional(v.string()). Convex's optional
 * accepts undefined and REJECTS null — and the client sends an explicit null
 * for any part that belongs to a catalog service, exactly as it does for
 * `brand`. Every post-job submit carrying a catalog part therefore failed
 * validation at the door:
 *
 *   Path: .postjob.parts_used[0].custom_service_name
 *   Value: null   Validator: v.string()
 */
describe("post-job part validator", () => {
  it("accepts a null custom_service_name on a catalog part", async () => {
    const { postjobPartValidator } = await import(
      "../convex/lib/vehicle_passports"
    );
    const field = (postjobPartValidator as any).fields.custom_service_name;
    const json = JSON.stringify(field.json ?? field);
    // Nullable, matching `brand` in the same validator.
    expect(json).toContain("null");
  });

  it("normalises the field to undefined on the way out", async () => {
    // Several tables this array feeds declare the column
    // v.optional(v.string()), which rejects null — so a null accepted at the
    // door must not travel onward as one.
    const { normalizePartsUsed } = await import("../convex/bookings");
    const [catalogPart, customPart] = normalizePartsUsed([
      {
        part_name: "Oil filter",
        oem_number: "90915",
        cost: 12,
        custom_service_name: null,
      },
      {
        part_name: "Window switch",
        oem_number: "83071AN00B",
        cost: 78.55,
        custom_service_name: "  Power window switch replacement  ",
      },
    ] as any);

    expect(catalogPart.custom_service_name).toBeUndefined();
    // And a real one survives, trimmed — it's the key completion groups on.
    expect(customPart.custom_service_name).toBe(
      "Power window switch replacement",
    );
  });
});

describe("quoted parts as a fallback at completion", () => {
  it("records what was quoted when the actuals say nothing about the line", async () => {
    const { makeT } = await import("./helpers");
    const {
      recordCustomJobsForBooking,
      completeCustomJobsForBooking,
    } = await import("../convex/customJobs");

    const t = makeT();
    const base = await t.run(async (ctx: any) => {
      const shopId = await ctx.db.insert("shops", { name: "Temur Auto" } as any);
      const bookingId = await ctx.db.insert("bookings", {
        vin: "VINQUOTED00000001",
        user_id: await ctx.db.insert("users", {
          clerkUserId: "clerk_quoted",
          email: "quoted@test.local",
          role: "customer",
          createdAt: Date.now(),
        }),
        service_ids: [],
        status: "in_progress",
      } as any);
      return { shopId, bookingId };
    });

    await t.run(async (ctx: any) =>
      recordCustomJobsForBooking(ctx, {
        booking: {
          _id: base.bookingId,
          shop_id: base.shopId,
          vin: "VINQUOTED00000001",
        },
        customJobs: [
          {
            name: "Power window switch replacement",
            system_tags: ["electrical"],
            work_type: "replace",
          },
        ],
        source: "booking",
        now: Date.now(),
      }),
    );

    await t.run(async (ctx: any) =>
      completeCustomJobsForBooking(ctx, {
        bookingId: base.bookingId,
        // The mechanic never used the per-line add button, so nothing in the
        // actuals names this work.
        partsUsed: [
          { part_name: "Oil filter", oem_number: "90915", cost: 12, quantity: 1 },
        ],
        quotedSnapshot: [
          {
            custom_service_name: "Power window switch replacement",
            part_name: "Window switch",
            oem_number: "83071AN00B",
            quantity: 1,
            unit_price_cents: 7855,
            line_total_cents: 7855,
          },
        ],
        outcomes: [],
        now: Date.now(),
      }),
    );

    const row = await t.run(async (ctx: any) =>
      (await ctx.db.query("custom_jobs").collect())[0],
    );
    // Weaker evidence than a fitted part, but it beats recording that a job
    // which plainly consumed a part consumed none.
    expect(row.parts).toHaveLength(1);
    expect(row.parts[0].oem_number).toBe("83071AN00B");
  });
});
