import test from "node:test";
import assert from "node:assert/strict";

import {
  assignmentPreferenceFromRequestedMechanic,
  getCustomerLateReminderOffsetsMs,
  getDefaultOverrunExtensionMinutes,
  normalizeAssignmentPreference,
  normalizeNoShowThresholdMinutes,
  validateNoShowThresholdMinutes,
} from "./scheduling-overhaul.ts";

test("customer-late reminders follow threshold fractions and caps", () => {
  assert.deepEqual(getCustomerLateReminderOffsetsMs(15), {
    pushOffsetMs: 5 * 60 * 1000,
    smsOffsetMs: 10 * 60 * 1000,
    thresholdOffsetMs: 15 * 60 * 1000,
  });
  assert.deepEqual(getCustomerLateReminderOffsetsMs(30), {
    pushOffsetMs: 10 * 60 * 1000,
    smsOffsetMs: 20 * 60 * 1000,
    thresholdOffsetMs: 30 * 60 * 1000,
  });
  assert.deepEqual(getCustomerLateReminderOffsetsMs(45), {
    pushOffsetMs: 10 * 60 * 1000,
    smsOffsetMs: 20 * 60 * 1000,
    thresholdOffsetMs: 45 * 60 * 1000,
  });
  assert.deepEqual(getCustomerLateReminderOffsetsMs(60), {
    pushOffsetMs: 10 * 60 * 1000,
    smsOffsetMs: 20 * 60 * 1000,
    thresholdOffsetMs: 60 * 60 * 1000,
  });
});

test("no-show threshold normalizes and validates allowed range", () => {
  assert.equal(normalizeNoShowThresholdMinutes(undefined), 30);
  assert.equal(normalizeNoShowThresholdMinutes(4), 15);
  assert.equal(normalizeNoShowThresholdMinutes(90), 60);
  assert.doesNotThrow(() => validateNoShowThresholdMinutes(45));
  assert.throws(() => validateNoShowThresholdMinutes(14));
  assert.throws(() => validateNoShowThresholdMinutes(61));
});

test("default overrun extension applies percent, floor, and quarter rounding", () => {
  assert.equal(
    getDefaultOverrunExtensionMinutes({ estimatedMinutes: 60, percent: 25, floorMinutes: 15 }),
    15,
  );
  assert.equal(
    getDefaultOverrunExtensionMinutes({ estimatedMinutes: 90, percent: 25, floorMinutes: 15 }),
    30,
  );
  assert.equal(
    getDefaultOverrunExtensionMinutes({ estimatedMinutes: 30, percent: 25, floorMinutes: 15 }),
    15,
  );
});

test("assignment preference defaults to any", () => {
  assert.equal(normalizeAssignmentPreference(undefined), "any");
  assert.equal(normalizeAssignmentPreference("any"), "any");
  assert.equal(normalizeAssignmentPreference("specific_mechanic"), "specific_mechanic");
});

test("booking create preference follows the requested mechanic, not the resolved assignee", () => {
  assert.equal(assignmentPreferenceFromRequestedMechanic(null), "any");
  assert.equal(assignmentPreferenceFromRequestedMechanic(undefined), "any");
  assert.equal(assignmentPreferenceFromRequestedMechanic("mech_123"), "specific_mechanic");
});
