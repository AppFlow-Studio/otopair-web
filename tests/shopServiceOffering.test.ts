// Bug #404 — a service the shop switched OFF in Settings → Services stayed
// bookable. These pin the one offering predicate (lib/shopServiceOffering.ts)
// and every place that now reads or writes it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import {
  offeringState,
  serviceNotOfferedMessage,
  setShopServiceOffered,
} from "../convex/lib/shopServiceOffering";
import {
  linkClickLeavesPage,
  unsavedChangesPrompt,
} from "../components/settings/save-manager";
import { identityFor, makeT } from "./helpers";

const VIN = "1HGCM82633A004352";
const MONDAY = "2026-11-02";

type T = ReturnType<typeof makeT>;

async function seedShop() {
  const t = makeT();
  const seed = await t.run(async (ctx) => {
    const now = Date.now();
    const ownerClerkId = "offering_owner";
    const customerClerkId = "offering_customer";
    const strangerClerkId = "offering_stranger";
    const ownerId = await ctx.db.insert("users", {
      clerkUserId: ownerClerkId,
      email: "offering-owner@test.local",
      first_name: "Owner",
      role: "shop_owner",
    } as never);
    const customerId = await ctx.db.insert("users", {
      clerkUserId: customerClerkId,
      email: "offering-customer@test.local",
      first_name: "Customer",
      role: "user",
    } as never);
    await ctx.db.insert("users", {
      clerkUserId: strangerClerkId,
      email: "offering-stranger@test.local",
      first_name: "Stranger",
      role: "shop_owner",
    } as never);
    const shopId = await ctx.db.insert("shops", {
      name: "Anesa Shop",
      owner_user_id: ownerId,
      is_active: true,
    } as never);
    const otherShopId = await ctx.db.insert("shops", {
      name: "Other Shop",
      is_active: true,
    } as never);
    const mechanicId = await ctx.db.insert("mechanics", {
      shop_id: shopId,
      first_name: "Dean",
      last_name: "Martin",
      is_active: true,
    });
    await ctx.db.insert("shops_hours", {
      shop_id: shopId,
      day_of_week: 1,
      day_name: "Mon",
      open_time: "08:00",
      close_time: "17:00",
      is_closed: false,
    });
    const flushId = await ctx.db.insert("services", {
      name: "Brake Fluid Flush",
      slug: "brake_fluid_flush",
      default_labor_hours: 0.5,
      created_at: now,
    } as never);
    const oilId = await ctx.db.insert("services", {
      name: "Oil Change",
      slug: "oil_change",
      default_labor_hours: 0.5,
      created_at: now,
    } as never);
    const retiredId = await ctx.db.insert("services", {
      name: "Multi Point Inspection",
      slug: "multi_point_inspection",
      default_labor_hours: 0.5,
      is_bookable: false,
      created_at: now,
    } as never);
    await ctx.db.insert("vehicles", { vin: VIN, created_at: now });
    await ctx.db.insert("vehicle_owners", {
      vin: VIN,
      user_id: customerId,
      status: "active",
    });
    return {
      ownerClerkId,
      customerClerkId,
      strangerClerkId,
      ownerId,
      customerId,
      shopId,
      otherShopId,
      mechanicId,
      flushId,
      oilId,
      retiredId,
    };
  });
  return { t, seed };
}

type Seed = Awaited<ReturnType<typeof seedShop>>["seed"];

async function setRows(
  t: T,
  shopId: Id<"shops">,
  serviceId: Id<"services">,
  values: boolean[],
) {
  await t.run(async (ctx) => {
    for (const is_offered of values) {
      await ctx.db.insert("shop_services", {
        shop_id: shopId,
        service_id: serviceId,
        is_offered,
      });
    }
  });
}

async function rowsFor(t: T, shopId: Id<"shops">, serviceId: Id<"services">) {
  return await t.run(async (ctx) =>
    (
      await ctx.db
        .query("shop_services")
        .withIndex("by_shop_and_service", (q) =>
          q.eq("shop_id", shopId).eq("service_id", serviceId),
        )
        .collect()
    ).map((row) => row.is_offered),
  );
}

function createBatch(
  t: T,
  seed: Seed,
  serviceIds: Id<"services">[],
  extra: Record<string, unknown> = {},
) {
  return t.withIdentity(identityFor(seed.customerClerkId)).mutation(api.bookings.createBatch, {
    user_id: seed.customerId,
    vin: VIN,
    shop_id: seed.shopId,
    mechanic_id: seed.mechanicId,
    scheduled_date: MONDAY,
    scheduled_time: "09:00",
    services: serviceIds.map((service_id) => ({
      service_id,
      labor_cost: 80,
      parts_cost: 20,
      labor_hours: 0.5,
    })),
    ...extra,
  } as never);
}

// ─── Pure predicate + copy ───────────────────────────────────────────────────

describe("offeringState", () => {
  test("ANY true row offers the service; no row / all false / retired / missing do not", () => {
    expect(offeringState({ is_bookable: undefined }, [{ is_offered: true }])).toBe("offered");
    expect(
      offeringState({ is_bookable: true }, [{ is_offered: false }, { is_offered: true }]),
    ).toBe("offered");
    expect(offeringState({ is_bookable: undefined }, [])).toBe("no_row");
    expect(
      offeringState({ is_bookable: undefined }, [{ is_offered: false }, { is_offered: false }]),
    ).toBe("off");
    expect(offeringState({ is_bookable: false }, [{ is_offered: true }])).toBe("retired");
    expect(offeringState(null, [{ is_offered: true }])).toBe("missing");
  });

  test("customer copy names the shop and every blocked service", () => {
    expect(serviceNotOfferedMessage("Anesa Shop", ["Brake Fluid Flush"])).toBe(
      "Anesa Shop no longer offers Brake Fluid Flush. Remove it from your booking or pick another shop.",
    );
    expect(serviceNotOfferedMessage("Anesa Shop", ["Brake Fluid Flush", "Oil Change"])).toBe(
      "Anesa Shop no longer offers Brake Fluid Flush and Oil Change. Remove them from your booking or pick another shop.",
    );
    expect(serviceNotOfferedMessage(null, [])).toMatch(/^This shop no longer offers/);
  });
});

// ─── createBatch guard ───────────────────────────────────────────────────────

describe("createBatch re-reads the shop's offering at commit time", () => {
  test("rejects a service the shop switched OFF", async () => {
    const { t, seed } = await seedShop();
    await setRows(t, seed.shopId, seed.flushId, [false]);
    await setRows(t, seed.shopId, seed.oilId, [true]);

    await expect(createBatch(t, seed, [seed.oilId, seed.flushId])).rejects.toMatchObject({
      data: {
        code: "SERVICE_NOT_OFFERED",
        shopId: String(seed.shopId),
        serviceIds: [String(seed.flushId)],
        serviceNames: ["Brake Fluid Flush"],
        message:
          "Anesa Shop no longer offers Brake Fluid Flush. Remove it from your booking or pick another shop.",
      },
    });
    const bookings = await t.run((ctx) => ctx.db.query("bookings").collect());
    expect(bookings).toHaveLength(0);
  });

  test("rejects a service the shop has no row for (fail closed)", async () => {
    const { t, seed } = await seedShop();
    await expect(createBatch(t, seed, [seed.flushId])).rejects.toMatchObject({
      data: { code: "SERVICE_NOT_OFFERED", serviceIds: [String(seed.flushId)] },
    });
  });

  test("rejects a retired catalog service even with an offered row", async () => {
    const { t, seed } = await seedShop();
    await setRows(t, seed.shopId, seed.retiredId, [true]);
    await expect(createBatch(t, seed, [seed.retiredId])).rejects.toMatchObject({
      data: { code: "SERVICE_NOT_OFFERED" },
    });
  });

  test("passes the guard when ANY duplicate row is true (what the portal checkbox shows)", async () => {
    const { t, seed } = await seedShop();
    await setRows(t, seed.shopId, seed.flushId, [false, true]);
    const ids = await createBatch(t, seed, [seed.flushId]);
    expect(ids).toHaveLength(1);
    const booking = await t.run((ctx) => ctx.db.get(ids[0] as Id<"bookings">));
    expect(booking?.shop_id).toBe(seed.shopId);
  });

  test("a service the SAME shop recommended for this car is exempt; another shop's is not", async () => {
    const { t, seed } = await seedShop();
    await setRows(t, seed.shopId, seed.flushId, [false]);
    const recs = await t.run(async (ctx) => {
      const now = Date.now();
      const bookingId = await ctx.db.insert("bookings", {
        user_id: seed.customerId,
        vin: VIN,
        shop_id: seed.shopId,
        service_ids: [],
        status: "completed",
        created_at: now,
        updated_at: now,
      } as never);
      const jobActualId = await ctx.db.insert("job_actuals", {
        booking_id: bookingId,
        mechanic_id: seed.mechanicId,
        started_at: now,
        created_at: now,
        updated_at: now,
      } as never);
      const base = {
        booking_id: bookingId,
        job_actual_id: jobActualId,
        mechanic_id: seed.mechanicId,
        vehicle_vin: VIN,
        recommended_service_id: seed.flushId,
        urgency: "soon" as const,
        visible_to_driver: true,
        status: "open" as const,
        created_at: now,
      };
      return {
        own: await ctx.db.insert("job_recommendations", { ...base, shop_id: seed.shopId } as never),
        foreign: await ctx.db.insert("job_recommendations", {
          ...base,
          shop_id: seed.otherShopId,
        } as never),
        otherCar: await ctx.db.insert("job_recommendations", {
          ...base,
          shop_id: seed.shopId,
          vehicle_vin: "2T1BURHE0JC000000",
        } as never),
      };
    });

    const own = await createBatch(t, seed, [seed.flushId], {
      source_recommendation_id: recs.own,
    });
    expect(own).toHaveLength(1);

    await expect(
      createBatch(t, seed, [seed.flushId], { source_recommendation_id: recs.foreign }),
    ).rejects.toMatchObject({ data: { code: "SERVICE_NOT_OFFERED" } });
    await expect(
      createBatch(t, seed, [seed.flushId], { source_recommendation_id: recs.otherCar }),
    ).rejects.toMatchObject({ data: { code: "SERVICE_NOT_OFFERED" } });
  });
});

describe("bookings.create (legacy single-service path)", () => {
  function createArgs(seed: Seed) {
    return {
      user_id: seed.customerId,
      vin: VIN,
      shop_id: seed.shopId,
      mechanic_id: seed.mechanicId,
      service_id: seed.flushId,
      scheduled_date: MONDAY,
      scheduled_time: "09:00",
      labor_cost: 80,
      parts_cost: 20,
      total_cost: 100,
    };
  }

  test("requires the booking's own signed-in customer", async () => {
    const { t, seed } = await seedShop();
    await setRows(t, seed.shopId, seed.flushId, [true]);
    await expect(t.mutation(api.bookings.create, createArgs(seed) as never)).rejects.toThrow(
      "Not authenticated",
    );
    await expect(
      t
        .withIdentity(identityFor(seed.strangerClerkId))
        .mutation(api.bookings.create, createArgs(seed) as never),
    ).rejects.toThrow("Cannot create another user's booking.");
  });

  test("refuses a switched-off service", async () => {
    const { t, seed } = await seedShop();
    await setRows(t, seed.shopId, seed.flushId, [false]);
    await expect(
      t
        .withIdentity(identityFor(seed.customerClerkId))
        .mutation(api.bookings.create, createArgs(seed) as never),
    ).rejects.toMatchObject({ data: { code: "SERVICE_NOT_OFFERED" } });
  });
});

// ─── Tire / rotor quote accepts ──────────────────────────────────────────────

async function seedQuoteAccept(quoteType: "tire" | "rotor", rows: boolean[]) {
  const { t, seed } = await seedShop();
  const quote = await t.run(async (ctx) => {
    const now = Date.now();
    const serviceId = await ctx.db.insert("services", {
      name: quoteType === "tire" ? "Tire Replacement" : "Rotor Replacement",
      slug: quoteType === "tire" ? "tire-replacement" : "rotor-replacement",
      default_labor_hours: 0.5,
      created_at: now,
    } as never);
    for (const is_offered of rows) {
      await ctx.db.insert("shop_services", {
        shop_id: seed.shopId,
        service_id: serviceId,
        is_offered,
      });
    }
    const bookingId = await ctx.db.insert("bookings", {
      user_id: seed.customerId,
      vin: VIN,
      service_ids: [],
      status: "quotes_ready",
      created_at: now,
      updated_at: now,
    } as never);
    const common = {
      booking_id: bookingId,
      shop_id: seed.shopId,
      mechanic_id: seed.mechanicId,
      quantity: quoteType === "tire" ? 4 : 2,
      labor_cost: 150,
      total: quoteType === "tire" ? 590 : 410,
      availability: { date: "2026-06-01", time: "09:00" },
      estimated_duration_minutes: 30,
      created_at: now,
    };
    const responseId =
      quoteType === "tire"
        ? await ctx.db.insert("tire_quote_responses", {
            ...common,
            tire_brand: "Michelin",
            per_tire_price: 110,
          })
        : await ctx.db.insert("rotor_quote_responses", {
            ...common,
            rotor_brand: "Brembo",
            per_rotor_price: 130,
          });
    const sessionId = `${quoteType}-offering-session`;
    const holdId = await ctx.db.insert("slot_holds", {
      shop_id: seed.shopId,
      mechanic_id: seed.mechanicId,
      date: "2026-06-01",
      start_time: "09:00",
      end_time: "09:30",
      duration_minutes: 30,
      held_by: seed.customerId,
      session_id: sessionId,
      expires_at: now + 15 * 60 * 1000,
      status: "active",
      created_at: now,
      quote_type: quoteType,
      quote_revision: 1,
      ...(quoteType === "tire"
        ? { tire_quote_response_id: responseId }
        : { rotor_quote_response_id: responseId }),
    } as never);
    return { serviceId, bookingId, responseId, holdId, sessionId };
  });

  const accept = () => {
    const args = {
      booking_id: quote.bookingId,
      response_id: quote.responseId,
      scheduled_date: "2026-06-01",
      scheduled_time: "09:00",
      hold_id: quote.holdId,
      session_id: quote.sessionId,
      quote_revision: 1,
    };
    const customer = t.withIdentity(identityFor(seed.customerClerkId));
    return quoteType === "tire"
      ? customer.mutation(api.bookings.acceptTireQuote, args as never)
      : customer.mutation(api.bookings.acceptRotorQuote, args as never);
  };
  return { t, seed, quote, accept };
}

for (const quoteType of ["tire", "rotor"] as const) {
  describe(`${quoteType} quote accept`, () => {
    test("never flips an explicit OFF back on — it refuses the accept", async () => {
      const { t, seed, quote, accept } = await seedQuoteAccept(quoteType, [false]);
      await expect(accept()).rejects.toMatchObject({
        data: { code: "SERVICE_NOT_OFFERED", serviceIds: [String(quote.serviceId)] },
      });
      expect(await rowsFor(t, seed.shopId, quote.serviceId)).toEqual([false]);
      const booking = await t.run((ctx) => ctx.db.get(quote.bookingId));
      expect(booking?.status).toBe("quotes_ready");
    });

    test("a shop with no row can still be booked on its quote, and gets the row", async () => {
      const { t, seed, quote, accept } = await seedQuoteAccept(quoteType, []);
      await accept();
      expect(await rowsFor(t, seed.shopId, quote.serviceId)).toEqual([true]);
      const booking = await t.run((ctx) => ctx.db.get(quote.bookingId));
      expect(booking?.status).toBe("confirmed");
    });

    test("leaves duplicate rows alone when any is on", async () => {
      const { t, seed, quote, accept } = await seedQuoteAccept(quoteType, [false, true]);
      await accept();
      expect(await rowsFor(t, seed.shopId, quote.serviceId)).toEqual([false, true]);
    });
  });
}

test("bookings.ts has no raw shop_services writes left (only the shared helpers write)", () => {
  const source = readFileSync(join(__dirname, "../convex/bookings.ts"), "utf8");
  expect(source).not.toMatch(/insert\(\s*["']shop_services["']/);
  expect(source).not.toMatch(/patch\([^)]*is_offered/);
});

// ─── Writers ─────────────────────────────────────────────────────────────────

describe("setShopServiceOffered", () => {
  test("patches EVERY duplicate row, and inserts when there is none", async () => {
    const { t, seed } = await seedShop();
    await setRows(t, seed.shopId, seed.flushId, [true, true, false]);

    const off = await t.run((ctx) => setShopServiceOffered(ctx, seed.shopId, seed.flushId, false));
    expect(off).toEqual({ wasOffered: true, changed: true });
    expect(await rowsFor(t, seed.shopId, seed.flushId)).toEqual([false, false, false]);

    const on = await t.run((ctx) => setShopServiceOffered(ctx, seed.shopId, seed.oilId, true));
    expect(on).toEqual({ wasOffered: false, changed: true });
    expect(await rowsFor(t, seed.shopId, seed.oilId)).toEqual([true]);
  });

  test("updateShopOfferedServices replaces the full set and audits what flipped", async () => {
    const { t, seed } = await seedShop();
    await setRows(t, seed.shopId, seed.flushId, [true, true]);
    await setRows(t, seed.shopId, seed.oilId, [false]);

    await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .mutation(api.shops.updateShopOfferedServices, { serviceIds: [seed.oilId] });

    expect(await rowsFor(t, seed.shopId, seed.flushId)).toEqual([false, false]);
    expect(await rowsFor(t, seed.shopId, seed.oilId)).toEqual([true]);
    const audit = await t.run((ctx) =>
      ctx.db
        .query("audit_log")
        .filter((q) => q.eq(q.field("action"), "shop_services_offered_changed"))
        .collect(),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].entity_id).toBe(String(seed.shopId));
    const detail = JSON.parse(audit[0].detail ?? "{}");
    expect(detail.source).toBe("settings");
    expect(detail.turned_on.map((s: any) => s.slug)).toEqual(["oil_change"]);
    expect(detail.turned_off.map((s: any) => s.slug)).toEqual(["brake_fluid_flush"]);

    // Saving the same set again flips nothing and writes no audit row.
    await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .mutation(api.shops.updateShopOfferedServices, { serviceIds: [seed.oilId] });
    const again = await t.run((ctx) =>
      ctx.db
        .query("audit_log")
        .filter((q) => q.eq(q.field("action"), "shop_services_offered_changed"))
        .collect(),
    );
    expect(again).toHaveLength(1);
  });
});

// ─── Listing + live checkout query ───────────────────────────────────────────

describe("shop_services.list", () => {
  test("returns only offered, bookable pairs, one per (shop, service)", async () => {
    const { t, seed } = await seedShop();
    await setRows(t, seed.shopId, seed.flushId, [false]);
    await setRows(t, seed.shopId, seed.oilId, [false, true, true]);
    await setRows(t, seed.shopId, seed.retiredId, [true]);

    const rows = await t.query(api.shop_services.list, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].service_id).toBe(seed.oilId);
    expect(rows[0].is_offered).toBe(true);
    expect(rows[0].service?.slug).toBe("oil_change");
    expect(rows[0].shop?.name).toBe("Anesa Shop");
  });
});

describe("shop_services.validateCheckoutServices", () => {
  test("ok when every service is offered", async () => {
    const { t, seed } = await seedShop();
    await setRows(t, seed.shopId, seed.oilId, [true]);
    const result = await t.query(api.shop_services.validateCheckoutServices, {
      shop_id: String(seed.shopId),
      service_ids: [String(seed.oilId)],
    });
    expect(result).toEqual({ ok: true, blocked: [], message: null });
  });

  test("lists each blocked service with the same reason the guard would use", async () => {
    const { t, seed } = await seedShop();
    await setRows(t, seed.shopId, seed.oilId, [true]);
    await setRows(t, seed.shopId, seed.flushId, [false]);
    await setRows(t, seed.shopId, seed.retiredId, [true]);

    const result = await t.query(api.shop_services.validateCheckoutServices, {
      shop_id: String(seed.shopId),
      service_ids: [String(seed.oilId), String(seed.flushId), String(seed.retiredId), "not-an-id"],
    });
    expect(result.ok).toBe(false);
    expect(result.blocked).toEqual([
      { serviceId: "not-an-id", name: "", reason: "missing" },
      { serviceId: String(seed.flushId), name: "Brake Fluid Flush", reason: "not_offered" },
      { serviceId: String(seed.retiredId), name: "Multi Point Inspection", reason: "retired" },
    ]);
    expect(result.message).toMatch(/^Anesa Shop no longer offers Brake Fluid Flush/);
  });

  test("an unknown shop blocks the whole cart instead of throwing", async () => {
    const { t, seed } = await seedShop();
    const result = await t.query(api.shop_services.validateCheckoutServices, {
      shop_id: "not-a-shop",
      service_ids: [String(seed.oilId)],
    });
    expect(result.ok).toBe(false);
    expect(result.blocked).toEqual([
      { serviceId: String(seed.oilId), name: "Oil Change", reason: "not_offered" },
    ]);
  });
});

// ─── Shop-side quote submit ──────────────────────────────────────────────────

async function seedQuoteSubmit(quoteType: "tire" | "rotor", rows: boolean[]) {
  const { t, seed } = await seedShop();
  const bookingId = await t.run(async (ctx) => {
    const now = Date.now();
    const serviceId = await ctx.db.insert("services", {
      name: quoteType === "tire" ? "Tire Replacement" : "Rotor Replacement",
      slug: quoteType === "tire" ? "tire-replacement" : "rotor-replacement",
      default_labor_hours: 0.5,
      created_at: now,
    } as never);
    for (const is_offered of rows) {
      await ctx.db.insert("shop_services", {
        shop_id: seed.shopId,
        service_id: serviceId,
        is_offered,
      });
    }
    return await ctx.db.insert("bookings", {
      user_id: seed.customerId,
      vin: VIN,
      service_ids: [],
      status: "quotes_ready",
      created_at: now,
      updated_at: now,
    } as never);
  });
  const args =
    quoteType === "tire"
      ? {
          booking_id: bookingId,
          shop_id: seed.shopId,
          mechanic_id: seed.mechanicId,
          tire_brand: "Michelin",
          per_tire_price: 100,
          quantity: 4,
          labor_cost: 100,
          total: 500,
          availability: { date: MONDAY, time: "09:00" },
          estimated_duration_minutes: 30,
        }
      : {
          booking_id: bookingId,
          shop_id: seed.shopId,
          mechanic_id: seed.mechanicId,
          rotor_brand: "Brembo",
          per_rotor_price: 120,
          quantity: 2,
          labor_cost: 150,
          total: 390,
          availability: { date: MONDAY, time: "10:00" },
          estimated_duration_minutes: 30,
        };
  const submit = (who: ReturnType<T["withIdentity"]> | T) =>
    quoteType === "tire"
      ? who.mutation(api.tire_quote_responses.create, args as never)
      : who.mutation(api.rotor_quote_responses.create, args as never);
  return { t, seed, submit };
}

for (const quoteType of ["tire", "rotor"] as const) {
  describe(`${quoteType}_quote_responses.create`, () => {
    test("requires the shop's own staff", async () => {
      const { t, seed, submit } = await seedQuoteSubmit(quoteType, [true]);
      await expect(submit(t)).rejects.toThrow("Authentication required.");
      await expect(submit(t.withIdentity(identityFor(seed.strangerClerkId)))).rejects.toThrow(
        "You don't have access to this quote.",
      );
      await expect(submit(t.withIdentity(identityFor(seed.ownerClerkId)))).resolves.toBeTruthy();
    });

    test("refuses only when the shop EXPLICITLY switched the service off", async () => {
      const off = await seedQuoteSubmit(quoteType, [false]);
      await expect(
        off.submit(off.t.withIdentity(identityFor(off.seed.ownerClerkId))),
      ).rejects.toMatchObject({
        data: {
          code: "SERVICE_NOT_OFFERED",
          message: `Turn on ${quoteType === "tire" ? "Tire" : "Rotor"} Replacement in Settings → Services to send quotes.`,
        },
      });

      const missing = await seedQuoteSubmit(quoteType, []);
      await expect(
        missing.submit(missing.t.withIdentity(identityFor(missing.seed.ownerClerkId))),
      ).resolves.toBeTruthy();
    });
  });
}

// ─── Portal save bar: don't lose an unsaved switch-off ───────────────────────

describe("settings save-manager navigation guard", () => {
  const click = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
  };
  const link = (href: string, extra: Partial<{ target: string; download: boolean }> = {}) => ({
    href,
    target: "",
    download: false,
    ...extra,
  });
  const here = { href: "https://portal.test/settings?tab=services" };

  test("a plain click to another in-app page leaves; same page / new tab / off-site don't", () => {
    expect(linkClickLeavesPage(click, link("/dashboard"), here)).toBe(true);
    expect(linkClickLeavesPage(click, link("/settings?tab=hours"), here)).toBe(true);
    expect(linkClickLeavesPage(click, link("/settings?tab=services#pricing"), here)).toBe(false);
    expect(linkClickLeavesPage({ ...click, metaKey: true }, link("/dashboard"), here)).toBe(false);
    expect(linkClickLeavesPage({ ...click, button: 1 }, link("/dashboard"), here)).toBe(false);
    expect(linkClickLeavesPage(click, link("/dashboard", { target: "_blank" }), here)).toBe(false);
    expect(linkClickLeavesPage(click, link("/export.csv", { download: true }), here)).toBe(false);
    expect(linkClickLeavesPage(click, link("https://stripe.com/"), here)).toBe(false);
  });

  test("prompt names the unsaved sections", () => {
    expect(unsavedChangesPrompt([])).toBe("You have unsaved changes. Leave without saving?");
    expect(unsavedChangesPrompt(["Services"])).toBe(
      "You have unsaved changes in Services. Leave without saving?",
    );
    expect(unsavedChangesPrompt(["Services", "Hours", "Pricing"])).toBe(
      "You have unsaved changes in Services, Hours and Pricing. Leave without saving?",
    );
  });
});
