import { expect, test } from "vitest";

import {
  isMechanicAvailableForWindow,
  resolveAvailableMechanicForWindow,
} from "../convex/lib/timeSlotAvailability";

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;
type EqBuilder = { eq(field: string, value: unknown): EqBuilder };
type FilterBuilder = {
  field(name: string): string;
  eq(field: string, value: unknown): Predicate;
};

function makeCtx(seed: Record<string, Row[]>) {
  const tables = new Map(Object.entries(seed));
  const allRows = () => [...tables.values()].flat();

  function query(table: string) {
    const rows = tables.get(table) ?? [];
    const predicates: Predicate[] = [];

    const chain = {
      withIndex(_name: string, cb: (q: EqBuilder) => unknown) {
        const builder: EqBuilder = {
          eq(field: string, value: unknown) {
            predicates.push((row) => String(row[field]) === String(value));
            return builder;
          },
        };
        cb(builder);
        return chain;
      },
      filter(cb: (q: FilterBuilder) => Predicate) {
        const builder: FilterBuilder = {
          field(name: string) {
            return name;
          },
          eq(field: string, value: unknown) {
            return (row) => row[field] === value;
          },
        };
        predicates.push(cb(builder));
        return chain;
      },
      async collect() {
        return rows.filter((row) => predicates.every((predicate) => predicate(row)));
      },
    };
    return chain;
  }

  return {
    db: {
      query,
      async get(id: string) {
        return allRows().find((row) => String(row._id) === String(id)) ?? null;
      },
    },
  };
}

function baseSeed(overrides: Partial<Record<string, Row[]>> = {}) {
  return {
    shops: [{ _id: "shop-1", buffer_minutes: 10 }],
    shops_hours: [
      {
        _id: "hours-1",
        shop_id: "shop-1",
        day_of_week: 1,
        open_time: "09:00",
        close_time: "17:00",
        is_closed: false,
      },
    ],
    mechanics: [
      { _id: "mech-1", shop_id: "shop-1", is_active: true },
      { _id: "mech-2", shop_id: "shop-1", is_active: true },
    ],
    bookings: [],
    time_slots: [],
    tire_quote_responses: [],
    ...overrides,
  };
}

test("mechanic is available when shop is open and no conflicts exist", async () => {
  const ctx = makeCtx(baseSeed());

  const available = await isMechanicAvailableForWindow(ctx, {
    shopId: "shop-1",
    mechanicId: "mech-1",
    date: "2026-06-01",
    startTime: "10:00",
    durationMinutes: 60,
  });

  expect(available).toBe(true);
});

test("mechanic is unavailable when inactive or shop is closed", async () => {
  const inactiveCtx = makeCtx(
    baseSeed({
      mechanics: [{ _id: "mech-1", shop_id: "shop-1", is_active: false }],
    }),
  );
  expect(
    await isMechanicAvailableForWindow(inactiveCtx, {
      shopId: "shop-1",
      mechanicId: "mech-1",
      date: "2026-06-01",
      startTime: "10:00",
      durationMinutes: 60,
    }),
  ).toBe(false);

  const closedCtx = makeCtx(
    baseSeed({
      shops_hours: [
        {
          _id: "hours-1",
          shop_id: "shop-1",
          day_of_week: 1,
          is_closed: true,
        },
      ],
    }),
  );
  expect(
    await isMechanicAvailableForWindow(closedCtx, {
      shopId: "shop-1",
      mechanicId: "mech-1",
      date: "2026-06-01",
      startTime: "10:00",
      durationMinutes: 60,
    }),
  ).toBe(false);
});

test("booking, blocked slot, and tire quote holds each block availability", async () => {
  const bookingCtx = makeCtx(
    baseSeed({
      bookings: [
        {
          _id: "booking-1",
          shop_id: "shop-1",
          mechanic_id: "mech-1",
          scheduled_date: "2026-06-01",
          scheduled_time: "10:30",
          estimated_labor_minutes: 60,
          status: "confirmed",
        },
      ],
    }),
  );
  expect(
    await isMechanicAvailableForWindow(bookingCtx, {
      shopId: "shop-1",
      mechanicId: "mech-1",
      date: "2026-06-01",
      startTime: "10:00",
      durationMinutes: 60,
    }),
  ).toBe(false);

  const blockedCtx = makeCtx(
    baseSeed({
      time_slots: [
        {
          _id: "block-1",
          shop_id: "shop-1",
          mechanic_id: "mech-1",
          date: "2026-06-01",
          start_time: "10:15",
          end_time: "10:45",
          is_available: false,
          block_kind: "manual",
        },
      ],
    }),
  );
  expect(
    await isMechanicAvailableForWindow(blockedCtx, {
      shopId: "shop-1",
      mechanicId: "mech-1",
      date: "2026-06-01",
      startTime: "10:00",
      durationMinutes: 60,
    }),
  ).toBe(false);

  const tireHoldCtx = makeCtx(
    baseSeed({
      bookings: [
        {
          _id: "quote-booking-1",
          shop_id: undefined,
          status: "quotes_ready",
        },
      ],
      tire_quote_responses: [
        {
          _id: "response-1",
          booking_id: "quote-booking-1",
          shop_id: "shop-1",
          mechanic_id: "mech-1",
          availability: { date: "2026-06-01", time: "10:30" },
          estimated_duration_minutes: 30,
        },
      ],
    }),
  );
  expect(
    await isMechanicAvailableForWindow(tireHoldCtx, {
      shopId: "shop-1",
      mechanicId: "mech-1",
      date: "2026-06-01",
      startTime: "10:00",
      durationMinutes: 60,
    }),
  ).toBe(false);
});

test("any-mechanic assignment chooses the lowest same-day workload", async () => {
  const ctx = makeCtx(
    baseSeed({
      bookings: [
        {
          _id: "booking-1",
          shop_id: "shop-1",
          mechanic_id: "mech-1",
          scheduled_date: "2026-06-01",
          scheduled_time: "09:00",
          estimated_labor_minutes: 30,
          status: "confirmed",
        },
      ],
    }),
  );

  const mechanicId = await resolveAvailableMechanicForWindow(ctx, {
    shopId: "shop-1",
    date: "2026-06-01",
    startTime: "15:00",
    durationMinutes: 60,
  });

  expect(mechanicId).toBe("mech-2");
});

test("any-mechanic tie-breaks by scheduled minutes and stable mechanic id", async () => {
  const sameCountCtx = makeCtx(
    baseSeed({
      bookings: [
        {
          _id: "booking-1",
          shop_id: "shop-1",
          mechanic_id: "mech-1",
          scheduled_date: "2026-06-01",
          scheduled_time: "09:00",
          estimated_labor_minutes: 30,
          status: "confirmed",
        },
        {
          _id: "booking-2",
          shop_id: "shop-1",
          mechanic_id: "mech-2",
          scheduled_date: "2026-06-01",
          scheduled_time: "09:00",
          estimated_labor_minutes: 90,
          status: "confirmed",
        },
      ],
    }),
  );

  expect(
    await resolveAvailableMechanicForWindow(sameCountCtx, {
      shopId: "shop-1",
      date: "2026-06-01",
      startTime: "15:00",
      durationMinutes: 60,
    }),
  ).toBe("mech-1");

  const noWorkloadCtx = makeCtx(baseSeed());
  expect(
    await resolveAvailableMechanicForWindow(noWorkloadCtx, {
      shopId: "shop-1",
      date: "2026-06-01",
      startTime: "15:00",
      durationMinutes: 60,
    }),
  ).toBe("mech-1");
});

test("any-mechanic workload includes live tire quote holds", async () => {
  const ctx = makeCtx(
    baseSeed({
      bookings: [
        {
          _id: "quote-booking-1",
          status: "quotes_ready",
        },
      ],
      tire_quote_responses: [
        {
          _id: "response-1",
          booking_id: "quote-booking-1",
          shop_id: "shop-1",
          mechanic_id: "mech-1",
          availability: { date: "2026-06-01", time: "09:00" },
          estimated_duration_minutes: 30,
        },
      ],
    }),
  );

  const mechanicId = await resolveAvailableMechanicForWindow(ctx, {
    shopId: "shop-1",
    date: "2026-06-01",
    startTime: "15:00",
    durationMinutes: 60,
  });

  expect(mechanicId).toBe("mech-2");
});
