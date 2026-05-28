import { expect, test } from "vitest";

import { findNextAvailableSlot } from "../lib/findNextAvailableSlot.ts";

const shopHours = [
  { dayOfWeek: 2, openTime: "09:00", closeTime: "10:00", isClosed: false },
  { dayOfWeek: 3, openTime: "09:00", closeTime: "10:00", isClosed: false },
];

test("findNextAvailableSlot skips closed days", () => {
  const slot = findNextAvailableSlot({
    now: new Date("2026-05-26T08:00:00"),
    shopHours: [{ ...shopHours[0], isClosed: true }, shopHours[1]],
    mechanics: [{ _id: "mech-1" }],
    bookings: [],
    durationMinutes: 30,
  });

  expect(slot).toEqual({
    date: "2026-05-27",
    time: "09:00",
    mechanicId: "mech-1",
    durationMinutes: 30,
  });
});

test("findNextAvailableSlot skips the rest of today when no slot can fit", () => {
  const slot = findNextAvailableSlot({
    now: new Date("2026-05-26T09:45:00"),
    shopHours,
    mechanics: [{ _id: "mech-1" }],
    bookings: [],
    durationMinutes: 30,
  });

  expect(slot?.date).toBe("2026-05-27");
  expect(slot?.time).toBe("09:00");
});

test("findNextAvailableSlot skips manually blocked slots", () => {
  const slot = findNextAvailableSlot({
    now: new Date("2026-05-26T08:00:00"),
    shopHours,
    mechanics: [{ _id: "mech-1" }],
    bookings: [],
    blockedSlots: [
      {
        _id: "blocked-1",
        date: "2026-05-26",
        startTime: "09:00",
        endTime: "10:00",
        mechanicId: "mech-1",
      },
    ],
    durationMinutes: 30,
  });

  expect(slot?.date).toBe("2026-05-27");
  expect(slot?.time).toBe("09:00");
});
