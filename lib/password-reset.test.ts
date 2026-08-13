import test from "node:test";
import assert from "node:assert/strict";

import {
  distributePasswordResetCodeInput,
  getPasswordResetTimeRemaining,
  getPasswordResetErrorMessage,
  getPasswordResetAttempt,
  getPasswordResetBackTarget,
  getPasswordResetIdentifierLabel,
  getPasswordResetStrategy,
  isValidResetEmail,
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

test("isValidResetEmail accepts syntactically valid email addresses", () => {
  assert.equal(isValidResetEmail("sam@example.com"), true);
  assert.equal(isValidResetEmail(" sam.lee+test@example.co "), true);
});

test("isValidResetEmail rejects empty or malformed email addresses", () => {
  assert.equal(isValidResetEmail(""), false);
  assert.equal(isValidResetEmail("sam"), false);
  assert.equal(isValidResetEmail("sam@example"), false);
  assert.equal(isValidResetEmail("sam @example.com"), false);
});

test("getPasswordResetErrorMessage normalizes unknown email identifiers", () => {
  assert.equal(
    getPasswordResetErrorMessage(
      { errors: [{ code: "form_identifier_not_found", message: "not found" }] },
      "fallback",
      { method: "email", phase: "send" }
    ),
    "We couldn't find an account with that email."
  );
});

test("getPasswordResetErrorMessage normalizes unknown phone identifiers", () => {
  assert.equal(
    getPasswordResetErrorMessage(
      { errors: [{ code: "form_identifier_not_found", message: "not found" }] },
      "fallback",
      { method: "phone", phase: "send" }
    ),
    "We couldn't find an account with that phone number."
  );
});

test("getPasswordResetErrorMessage normalizes wrong and expired codes", () => {
  assert.equal(
    getPasswordResetErrorMessage(
      { errors: [{ code: "form_code_incorrect", message: "Incorrect code" }] },
      "fallback",
      { method: "email", phase: "verify" }
    ),
    "That code didn't match. Try again."
  );
  assert.equal(
    getPasswordResetErrorMessage(
      { errors: [{ code: "verification_expired", message: "Code has expired" }] },
      "fallback",
      { method: "email", phase: "verify" }
    ),
    "This code expired. Send a new one."
  );
});

test("getPasswordResetErrorMessage normalizes network failures", () => {
  assert.equal(
    getPasswordResetErrorMessage(new TypeError("Network request failed"), "fallback"),
    "Network error. Check your connection and try again."
  );
});

test("getPasswordResetErrorMessage preserves raw Clerk details as fallback", () => {
  assert.equal(
    getPasswordResetErrorMessage(
      { errors: [{ message: "Password is too common." }] },
      "fallback"
    ),
    "Password is too common."
  );
});

test("distributePasswordResetCodeInput handles single digits and pasted codes", () => {
  assert.deepEqual(
    distributePasswordResetCodeInput(["", "", "", "", "", ""], "4", 0),
    {
      code: ["4", "", "", "", "", ""],
      nextFocusIndex: 1,
      fullCode: "4",
    }
  );
  assert.deepEqual(
    distributePasswordResetCodeInput(["", "", "", "", "", ""], "123456", 0),
    {
      code: ["1", "2", "3", "4", "5", "6"],
      nextFocusIndex: 5,
      fullCode: "123456",
    }
  );
});

test("getPasswordResetTimeRemaining derives seconds from an absolute deadline", () => {
  assert.equal(getPasswordResetTimeRemaining(null, 1000), 0);
  assert.equal(getPasswordResetTimeRemaining(900, 1000), 0);
  assert.equal(getPasswordResetTimeRemaining(2000, 1000), 1);
  assert.equal(getPasswordResetTimeRemaining(2500, 1000), 2);
});
