import test from "node:test";
import assert from "node:assert/strict";

import {
  buildBookingCalendarEvent,
  formatBookingReference,
} from "./booking-calendar.ts";

test("buildBookingCalendarEvent titles the event with service and shop", () => {
  const event = buildBookingCalendarEvent({
    shopName: "Broadway Auto",
    serviceNames: ["Oil Change"],
    date: "2026-06-15",
    time: "9:30 AM",
  });

  assert.equal(event?.title, "Oil Change at Broadway Auto");
  assert.equal(event?.startDate.getFullYear(), 2026);
  assert.equal(event?.startDate.getMonth(), 5);
  assert.equal(event?.startDate.getDate(), 15);
  assert.equal(event?.startDate.getHours(), 9);
  assert.equal(event?.startDate.getMinutes(), 30);
  assert.equal(event?.endDate.getHours(), 10);
  assert.equal(event?.endDate.getMinutes(), 30);
});

test("buildBookingCalendarEvent includes booking reference and details in notes", () => {
  const event = buildBookingCalendarEvent({
    shopName: "Broadway Auto",
    serviceNames: ["Brake Pads", "Rotor Replacement"],
    date: "2026-06-15",
    time: "2:00 PM",
    location: "123 Main St, New York, NY",
    mechanicName: "Sam Rivera",
    bookingReference: "ABC123",
    vehicleDisplay: "2020 Honda Accord",
    durationMinutes: 90,
  });

  assert.equal(event?.title, "Brake Pads + 1 more at Broadway Auto");
  assert.equal(event?.location, "123 Main St, New York, NY");
  assert.equal(
    event?.notes,
    [
      "Service: Brake Pads + 1 more",
      "Appointment with Sam",
      "Vehicle: 2020 Honda Accord",
      "Booking reference: ABC123",
    ].join("\n"),
  );
  assert.equal(event?.endDate.getHours(), 15);
  assert.equal(event?.endDate.getMinutes(), 30);
});

test("buildBookingCalendarEvent uses only the mechanic first name in notes", () => {
  const event = buildBookingCalendarEvent({
    shopName: "Broadway Auto",
    serviceNames: ["State Inspection"],
    date: "2026-06-15",
    time: "2:00 PM",
    mechanicName: "James Bond",
  });

  assert.match(event?.notes ?? "", /Appointment with James$/);
  assert.doesNotMatch(event?.notes ?? "", /James Bond/);
});

test("buildBookingCalendarEvent returns null for invalid date or time", () => {
  assert.equal(
    buildBookingCalendarEvent({
      shopName: "Broadway Auto",
      date: "",
      time: "9:30 AM",
    }),
    null,
  );
  assert.equal(
    buildBookingCalendarEvent({
      shopName: "Broadway Auto",
      date: "2026-06-15",
      time: "soon",
    }),
    null,
  );
});

test("formatBookingReference displays the last six uppercase characters", () => {
  assert.equal(formatBookingReference("jx7123abc9z0"), "ABC9Z0");
  assert.equal(formatBookingReference(""), null);
});
