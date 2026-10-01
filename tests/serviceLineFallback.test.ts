/**
 * Bug #408: a schedule block with no service name.
 *
 * The shop-facing service-line resolvers read only `service_ids` and
 * `custom_services`, so a booking whose work lived anywhere else — an accepted
 * tire/rotor quote whose catalog slug didn't resolve, a diagnostic, a typed-in
 * line removed after its parts were priced — or a booking with no work at all
 * (Create booking / Log past job submitted with no service) rendered a blank
 * service line on its schedule block, /jobs row and dashboards.
 *
 * Server: impliedServiceNames fills in the work the other fields imply, only
 * when catalog + custom labels are empty. Client: formatServiceLine prints a
 * "No services listed" placeholder, display-only, when there's still nothing.
 */
import { describe, expect, it } from "vitest";

import { api } from "../convex/_generated/api";
import {
  DIAGNOSTIC_SYSTEM_LABELS,
  impliedServiceNames,
} from "../convex/lib/customServiceNames";
import { formatServiceLine, NO_SERVICES_LABEL } from "../lib/service-catalog";
import { identityFor, makeT, seedConfirmedBooking } from "./helpers";

const TIRE_SPECS = { size: "225/45R17", type: "all_season", tier: "mid", quantity: 4 };
const ROTOR_SPECS = { brake_system_type: "standard", axle: "front", include_pads: true };

describe("impliedServiceNames", () => {
  it("names tire and rotor quote bookings like their tentative quote blocks", () => {
    expect(impliedServiceNames({ tire_specs: TIRE_SPECS })).toEqual(["Tire Replacement"]);
    expect(impliedServiceNames({ rotor_specs: ROTOR_SPECS })).toEqual(["Rotor Replacement"]);
  });

  it("names a diagnostic by its system, or plain Diagnostic when it names none", () => {
    expect(impliedServiceNames({ diagnostic_system: "brakes" })).toEqual([
      "Diagnostic — Brakes",
    ]);
    expect(impliedServiceNames({ diagnostic_system: "battery_electrical" })).toEqual([
      `Diagnostic — ${DIAGNOSTIC_SYSTEM_LABELS.battery_electrical}`,
    ]);
    expect(impliedServiceNames({ diagnostic_system: "not_sure" })).toEqual(["Diagnostic"]);
    expect(impliedServiceNames({ diagnostic_system: "something_new" })).toEqual([
      "Diagnostic",
    ]);
  });

  it("falls back to the distinct custom-line names on the parts snapshot", () => {
    expect(
      impliedServiceNames({
        priced_parts_snapshot: [
          { custom_service_name: "Power window switch", part_name: "Switch" },
          { custom_service_name: " Power window switch ", part_name: "Clip" },
          { service_id: "svc_1", part_name: "Filter" },
          { custom_service_name: "Roll fenders" },
        ],
      }),
    ).toEqual(["Power window switch", "Roll fenders"]);
  });

  it("prefers the structured specs over the parts snapshot", () => {
    expect(
      impliedServiceNames({
        tire_specs: TIRE_SPECS,
        priced_parts_snapshot: [{ custom_service_name: "Roll fenders" }],
      }),
    ).toEqual(["Tire Replacement"]);
  });

  it("returns [] for a booking with no recorded work and never throws on legacy rows", () => {
    expect(impliedServiceNames({ service_ids: [] })).toEqual([]);
    expect(impliedServiceNames(undefined)).toEqual([]);
    expect(impliedServiceNames(null)).toEqual([]);
    expect(impliedServiceNames("booking")).toEqual([]);
    expect(
      impliedServiceNames({
        tire_specs: "225/45R17",
        rotor_specs: null,
        diagnostic_system: 42,
        priced_parts_snapshot: [null, 7, { custom_service_name: "   " }, { custom_service_name: 5 }],
      }),
    ).toEqual([]);
    expect(impliedServiceNames({ priced_parts_snapshot: "not an array" })).toEqual([]);
  });
});

describe("formatServiceLine", () => {
  it("prints a placeholder instead of a blank service line", () => {
    expect(formatServiceLine([])).toBe(NO_SERVICES_LABEL);
    expect(formatServiceLine(undefined)).toBe(NO_SERVICES_LABEL);
    expect(formatServiceLine(null)).toBe(NO_SERVICES_LABEL);
    expect(formatServiceLine(["", null])).toBe(NO_SERVICES_LABEL);
    expect(NO_SERVICES_LABEL).toBe("No services listed");
  });

  it("still maps display names and joins real lines", () => {
    expect(formatServiceLine(["timing_belt"])).toBe("Drive Belt");
    expect(formatServiceLine(["Oil Change", "", "Tire Rotation"])).toBe(
      "Oil Change, Tire Rotation",
    );
    expect(formatServiceLine(["Oil Change", "Tire Rotation"], " · ")).toBe(
      "Oil Change · Tire Rotation",
    );
  });
});

describe("shop-facing service lines (getBookingsForRange / listForMyShop)", () => {
  const DATE = "2026-05-17";

  async function seedShapes() {
    const t = makeT();
    const seed = await seedConfirmedBooking(t, { scheduledDate: DATE });
    const ids = await t.run(async (ctx) => {
      const base = {
        user_id: seed.customerId,
        shop_id: seed.shopId,
        mechanic_id: seed.mechanicId,
        vin: "1HGCM82633A004352",
        scheduled_date: DATE,
        status: "confirmed",
        estimated_labor_minutes: 60,
        created_at: Date.now(),
        updated_at: Date.now(),
      };
      const blankNameServiceId = await ctx.db.insert("services", {
        name: "   ",
        created_at: Date.now(),
      } as never);
      const tireServiceId = await ctx.db.insert("services", {
        name: "Tire Replacement",
        created_at: Date.now(),
      } as never);
      return {
        noWork: await ctx.db.insert("bookings", {
          ...base,
          service_ids: [],
          scheduled_time: "08:00",
        } as never),
        tireOnly: await ctx.db.insert("bookings", {
          ...base,
          service_ids: [],
          tire_specs: TIRE_SPECS,
          scheduled_time: "09:00",
        } as never),
        rotorOnly: await ctx.db.insert("bookings", {
          ...base,
          service_ids: [],
          rotor_specs: ROTOR_SPECS,
          scheduled_time: "10:00",
        } as never),
        customOnly: await ctx.db.insert("bookings", {
          ...base,
          service_ids: [],
          custom_services: [{ name: "Carbon cleaning" }],
          tire_specs: TIRE_SPECS,
          scheduled_time: "11:00",
        } as never),
        catalogTire: await ctx.db.insert("bookings", {
          ...base,
          service_ids: [tireServiceId],
          tire_specs: TIRE_SPECS,
          scheduled_time: "12:00",
        } as never),
        blankName: await ctx.db.insert("bookings", {
          ...base,
          service_ids: [blankNameServiceId],
          scheduled_time: "13:00",
        } as never),
      };
    });
    return { t, seed, ids };
  }

  it("fills schedule blocks from the booking's other work fields, only when empty", async () => {
    const { t, seed, ids } = await seedShapes();
    const events = await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .query(api.schedule.getBookingsForRange, { dateFrom: DATE, dateTo: DATE });
    const byId = new Map(events.map((e) => [String(e._id), e.serviceNames]));

    // No work anywhere: the server stays honest ([]) and the client prints the
    // placeholder — never a blank line.
    expect(byId.get(String(ids.noWork))).toEqual([]);
    expect(formatServiceLine(byId.get(String(ids.noWork)))).toBe(NO_SERVICES_LABEL);
    expect(byId.get(String(ids.tireOnly))).toEqual(["Tire Replacement"]);
    expect(byId.get(String(ids.rotorOnly))).toEqual(["Rotor Replacement"]);
    // Real lines win: the implied name is a fallback, never merged in.
    expect(byId.get(String(ids.customOnly))).toEqual(["Carbon cleaning"]);
    expect(byId.get(String(ids.catalogTire))).toEqual(["Tire Replacement"]);
    expect(byId.get(String(ids.blankName))).toEqual(["Unknown Service"]);
    expect(byId.get(String(seed.bookingId))).toEqual(["Test service"]);
  });

  it("gives /jobs the same fallback", async () => {
    const { t, seed, ids } = await seedShapes();
    const jobs = await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .query(api.bookings.listForMyShop, {});
    const byId = new Map(jobs.map((j) => [String(j._id), j.serviceNames]));

    expect(byId.get(String(ids.noWork))).toEqual([]);
    expect(byId.get(String(ids.tireOnly))).toEqual(["Tire Replacement"]);
    expect(byId.get(String(ids.rotorOnly))).toEqual(["Rotor Replacement"]);
    expect(byId.get(String(ids.customOnly))).toEqual(["Carbon cleaning"]);
    expect(byId.get(String(ids.blankName))).toEqual(["Unknown Service"]);
  });

  it("gives the customer job history the same fallback", async () => {
    const { t, seed, ids } = await seedShapes();
    const detail = await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .query(api.shopCustomers.getShopCustomerDetail, { customerId: seed.customerId });
    const byId = new Map(
      (detail?.jobs ?? []).map((j) => [j.bookingId, j.serviceNames]),
    );

    expect(byId.get(String(ids.noWork))).toEqual([]);
    expect(byId.get(String(ids.tireOnly))).toEqual(["Tire Replacement"]);
    expect(byId.get(String(ids.rotorOnly))).toEqual(["Rotor Replacement"]);
  });

  it("names the booking in the detail panel the way its schedule block does", async () => {
    const { t, seed, ids } = await seedShapes();
    const owner = t.withIdentity(identityFor(seed.ownerClerkId));
    const detail = (bookingId: (typeof ids)[keyof typeof ids]) =>
      owner.query(api.bookings.getJobDetail, { bookingId });

    const tire = await detail(ids.tireOnly);
    expect(tire?.serviceLineNames).toEqual(["Tire Replacement"]);
    // `serviceNames` stays the recorded lines: the MPI and diagnostic flags
    // read it, so the display fallback must never leak into it.
    expect(tire?.serviceNames).toEqual([]);
    expect((await detail(ids.rotorOnly))?.serviceLineNames).toEqual([
      "Rotor Replacement",
    ]);
    const custom = await detail(ids.customOnly);
    expect(custom?.serviceLineNames).toEqual(["Carbon cleaning"]);
    expect(custom?.serviceNames).toEqual(["Carbon cleaning"]);
    const noWork = await detail(ids.noWork);
    expect(noWork?.serviceLineNames).toEqual([]);
    expect(formatServiceLine(noWork?.serviceLineNames)).toBe(NO_SERVICES_LABEL);
  });
});
