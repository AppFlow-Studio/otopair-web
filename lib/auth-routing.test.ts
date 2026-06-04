import test from "node:test";
import assert from "node:assert/strict";

import {
  shouldRedirectSignedOutFromMainTabs,
  shouldUseInitialHomeBack,
} from "./auth-routing.ts";

test("shouldUseInitialHomeBack keeps login back navigation inside onboarding", () => {
  assert.equal(shouldUseInitialHomeBack("login", true), false);
});

test("shouldUseInitialHomeBack preserves resume-to-home for setup steps", () => {
  assert.equal(shouldUseInitialHomeBack("name", true), true);
});

test("shouldUseInitialHomeBack is disabled when the flow was not launched from home", () => {
  assert.equal(shouldUseInitialHomeBack("name", false), false);
});

test("shouldRedirectSignedOutFromMainTabs waits for Clerk to load", () => {
  assert.equal(shouldRedirectSignedOutFromMainTabs(false, false), false);
});

test("shouldRedirectSignedOutFromMainTabs redirects signed-out users after Clerk loads", () => {
  assert.equal(shouldRedirectSignedOutFromMainTabs(true, false), true);
});

test("shouldRedirectSignedOutFromMainTabs allows signed-in users", () => {
  assert.equal(shouldRedirectSignedOutFromMainTabs(true, true), false);
});
