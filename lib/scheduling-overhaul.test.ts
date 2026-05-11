import test from "node:test";
import assert from "node:assert/strict";

import {
  getCustomerLateReminderOffsets,
  getDefaultOverrunExtensionMinutes,
} from "./scheduling-overhaul.ts";

test("customer-late reminder offsets follow configured thresholds", () => {
  assert.deepEqual(getCustomerLateReminderOffsets(15), {
    pushMinutes: 5,
    smsMinutes: 10,
    thresholdMinutes: 15,
  });
  assert.deepEqual(getCustomerLateReminderOffsets(30), {
    pushMinutes: 10,
    smsMinutes: 20,
    thresholdMinutes: 30,
  });
  assert.deepEqual(getCustomerLateReminderOffsets(45), {
    pushMinutes: 10,
    smsMinutes: 20,
    thresholdMinutes: 45,
  });
  assert.deepEqual(getCustomerLateReminderOffsets(60), {
    pushMinutes: 10,
    smsMinutes: 20,
    thresholdMinutes: 60,
  });
});

test("customer-late thresholds clamp to the supported range", () => {
  assert.equal(getCustomerLateReminderOffsets(5).thresholdMinutes, 15);
  assert.equal(getCustomerLateReminderOffsets(90).thresholdMinutes, 60);
});

test("default overrun extension uses max of percent and floor", () => {
  assert.equal(getDefaultOverrunExtensionMinutes(60), 15);
  assert.equal(getDefaultOverrunExtensionMinutes(120), 30);
  assert.equal(
    getDefaultOverrunExtensionMinutes(60, { percent: 50, floorMinutes: 10 }),
    30
  );
});
