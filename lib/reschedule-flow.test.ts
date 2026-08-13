import test from "node:test";
import assert from "node:assert/strict";

import {
  BOOKING_RESCHEDULE_CONFIRMATION_BODY,
  BOOKING_RESCHEDULE_CONFIRMATION_TITLE,
  BOOKING_RESCHEDULE_TOAST_BODY,
  BOOKING_RESCHEDULE_TOAST_TITLE,
  getBookingCompletionCopy,
  getBookingConfirmingCopy,
  isBookingRescheduleMode,
} from "./reschedule-flow.ts";

test("booking reschedule mode recognizes route params", () => {
  assert.equal(isBookingRescheduleMode("reschedule"), true);
  assert.equal(isBookingRescheduleMode(["reschedule"]), true);
  assert.equal(isBookingRescheduleMode("booking"), false);
  assert.equal(isBookingRescheduleMode(undefined), false);
});

test("booking confirming copy hides payment language for reschedules", () => {
  assert.deepEqual(getBookingConfirmingCopy(true), {
    title: "Confirming your reschedule",
    subtitle: "Sending your new time request to the shop",
    sheetTitle: "Confirming your reschedule...",
    primaryCta: "Reschedule Booking",
    showPaymentSummary: false,
  });

  assert.equal(getBookingConfirmingCopy(false).showPaymentSummary, true);
});

test("booking completion copy switches to shop-confirmation reschedule language", () => {
  assert.deepEqual(getBookingCompletionCopy(true, "Dean at Chela Service Center"), {
    subtitle: BOOKING_RESCHEDULE_CONFIRMATION_BODY,
    toastTitle: BOOKING_RESCHEDULE_TOAST_TITLE,
    toastBody: BOOKING_RESCHEDULE_TOAST_BODY,
  });

  assert.equal(BOOKING_RESCHEDULE_CONFIRMATION_TITLE, "You're all set!");
  assert.equal(
    getBookingCompletionCopy(false, "Dean at Chela Service Center").subtitle,
    "Your appointment with Dean at Chela Service Center is confirmed.",
  );
});
