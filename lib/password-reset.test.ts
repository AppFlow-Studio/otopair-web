import test from "node:test";
import assert from "node:assert/strict";

import {
  getPasswordResetAttempt,
  getPasswordResetBackTarget,
  getPasswordResetIdentifierLabel,
  getPasswordResetStrategy,
  validateResetPassword,
} from "./password-reset.ts";

test("getPasswordResetStrategy maps reset methods to Clerk strategies", () => {
  assert.equal(getPasswordResetStrategy("email"), "reset_password_email_code");
  assert.equal(getPasswordResetStrategy("phone"), "reset_password_phone_code");
});

test("getPasswordResetAttempt includes the matching strategy, code, and password", () => {
  assert.deepEqual(getPasswordResetAttempt("email", "123456", "fresh-password"), {
    strategy: "reset_password_email_code",
    code: "123456",
    password: "fresh-password",
  });
});

test("getPasswordResetIdentifierLabel formats the selected destination for copy", () => {
  assert.equal(getPasswordResetIdentifierLabel("email", "sam@example.com"), "sam@example.com");
  assert.equal(getPasswordResetIdentifierLabel("phone", "+15551234567"), "+15551234567");
});

test("validateResetPassword rejects short passwords", () => {
  assert.deepEqual(validateResetPassword("short", "short"), {
    isLongEnough: false,
    passwordsMatch: true,
    canSubmit: false,
  });
});

test("validateResetPassword rejects mismatched passwords", () => {
  assert.deepEqual(validateResetPassword("long-enough", "different"), {
    isLongEnough: true,
    passwordsMatch: false,
    canSubmit: false,
  });
});

test("validateResetPassword accepts matching passwords with at least 8 characters", () => {
  assert.deepEqual(validateResetPassword("long-enough", "long-enough"), {
    isLongEnough: true,
    passwordsMatch: true,
    canSubmit: true,
  });
});

test("getPasswordResetBackTarget sends the new password step back to login", () => {
  assert.equal(getPasswordResetBackTarget("password", "email"), "login");
});

test("getPasswordResetBackTarget sends code entry back to the selected method", () => {
  assert.equal(getPasswordResetBackTarget("code", "email"), "email");
  assert.equal(getPasswordResetBackTarget("code", "phone"), "phone");
});
