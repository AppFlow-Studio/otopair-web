import test from "node:test";
import assert from "node:assert/strict";

import {
  isValidEmailAddress,
  isValidPhoneNumber,
} from "./contact-validation.ts";

test("isValidEmailAddress matches onboarding email entry rules", () => {
  assert.equal(isValidEmailAddress("sam@example.com"), true);
  assert.equal(isValidEmailAddress(" sam.lee+test@example.co "), true);
  assert.equal(isValidEmailAddress(""), false);
  assert.equal(isValidEmailAddress("sam"), false);
  assert.equal(isValidEmailAddress("sam@example"), false);
  assert.equal(isValidEmailAddress("sam @example.com"), false);
});

test("isValidPhoneNumber requires ten national digits for NANP numbers", () => {
  assert.equal(isValidPhoneNumber("3475550107", "1"), true);
  assert.equal(isValidPhoneNumber("(347) 555-0107", "1"), true);
  assert.equal(isValidPhoneNumber("5550107", "1"), false);
  assert.equal(isValidPhoneNumber("13475550107", "1"), false);
});

test("isValidPhoneNumber accepts plausible E.164 lengths for non-NANP numbers", () => {
  assert.equal(isValidPhoneNumber("7911123456", "44"), true);
  assert.equal(isValidPhoneNumber("123", "44"), false);
  assert.equal(isValidPhoneNumber("123456789012345", "44"), false);
});
