import test from "node:test";
import assert from "node:assert/strict";

import {
  getMechanicAssignmentConflict,
  overlapsMechanicBooking,
  shouldConfirmMechanicChange,
} from "./schedule-overlap.ts";

test("overlapsMechanicBooking ignores the booking being reassigned", () => {
  const hasOverlap = overlapsMechanicBooking(
    "mech-1",
    "2026-04-02",
    "09:00",
    "10:00",
    [
      {
        _id: "booking-1",
        scheduledDate: "2026-04-02",
        scheduledTime: "09:00",
        estimatedMinutes: 60,
        status: "confirmed",
        mechanicId: "mech-1",
      },
    ],
    "booking-1"
  );

  assert.equal(hasOverlap, false);
});

test("getMechanicAssignmentConflict detects booking overlaps", () => {
  const conflict = getMechanicAssignmentConflict(
    {
      _id: "booking-1",
      scheduledDate: "2026-04-02",
      scheduledTime: "09:00",
      estimatedMinutes: 60,
    },
    "mech-2",
    [
      {
        _id: "booking-2",
        scheduledDate: "2026-04-02",
        scheduledTime: "09:30",
        estimatedMinutes: 60,
        status: "confirmed",
        mechanicId: "mech-2",
      },
    ],
    []
  );

  assert.equal(conflict, "booking");
});

test("overlapsMechanicBooking ignores no-show bookings", () => {
  const hasOverlap = overlapsMechanicBooking(
    "mech-2",
    "2026-04-02",
    "09:00",
    "10:00",
    [
      {
        _id: "booking-2",
        scheduledDate: "2026-04-02",
        scheduledTime: "09:15",
        estimatedMinutes: 60,
        status: "no_show",
        mechanicId: "mech-2",
      },
    ],
  );

  assert.equal(hasOverlap, false);
});

test("getMechanicAssignmentConflict detects blocked-slot overlaps", () => {
  const conflict = getMechanicAssignmentConflict(
    {
      _id: "booking-1",
      scheduledDate: "2026-04-02",
      scheduledTime: "09:00",
      estimatedMinutes: 60,
    },
    "mech-2",
    [],
    [
      {
        _id: "slot-1",
        date: "2026-04-02",
        startTime: "09:15",
        endTime: "10:15",
        mechanicId: "mech-2",
      },
    ]
  );

  assert.equal(conflict, "blocked");
});

test("shouldConfirmMechanicChange prompts for any change to a different mechanic", () => {
  assert.equal(shouldConfirmMechanicChange(null, "mech-2"), true);
  assert.equal(shouldConfirmMechanicChange(undefined, "mech-2"), true);
  assert.equal(shouldConfirmMechanicChange("mech-1", "mech-1"), false);
  assert.equal(shouldConfirmMechanicChange("mech-1", "mech-2"), true);
});
