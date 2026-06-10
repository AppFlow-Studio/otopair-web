import test from "node:test";
import assert from "node:assert/strict";

import {
  getTrustedSavedOnboardingStep,
  shouldRunStartupRedirect,
  shouldRedirectCompletedOnboardingToHome,
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

test("shouldRunStartupRedirect waits for root navigation readiness", () => {
  assert.equal(
    shouldRunStartupRedirect({
      authLoaded: true,
      hasNavigated: false,
      rootNavigationReady: false,
    }),
    false,
  );
});

test("shouldRunStartupRedirect allows routing when auth and navigation are ready", () => {
  assert.equal(
    shouldRunStartupRedirect({
      authLoaded: true,
      hasNavigated: false,
      rootNavigationReady: true,
    }),
    true,
  );
});

test("shouldRedirectCompletedOnboardingToHome redirects fully completed onboarding", () => {
  assert.equal(
    shouldRedirectCompletedOnboardingToHome({
      isSignedIn: true,
      onboardingCompleted: true,
      essentialOnboardingCompleted: false,
    }),
    true,
  );
});

test("shouldRedirectCompletedOnboardingToHome redirects essential-complete onboarding", () => {
  assert.equal(
    shouldRedirectCompletedOnboardingToHome({
      isSignedIn: true,
      onboardingCompleted: false,
      essentialOnboardingCompleted: true,
    }),
    true,
  );
});

test("shouldRedirectCompletedOnboardingToHome ignores signed-out users", () => {
  assert.equal(
    shouldRedirectCompletedOnboardingToHome({
      isSignedIn: false,
      onboardingCompleted: true,
      essentialOnboardingCompleted: true,
    }),
    false,
  );
});

test("getTrustedSavedOnboardingStep ignores stale saved steps that are no longer incomplete", () => {
  assert.equal(
    getTrustedSavedOnboardingStep("phone", ["profilePhoto", "zipCode"]),
    null,
  );
});

test("getTrustedSavedOnboardingStep keeps saved steps that are still incomplete", () => {
  assert.equal(
    getTrustedSavedOnboardingStep("phone", ["phone", "profilePhoto"]),
    "phone",
  );
});

test("getTrustedSavedOnboardingStep ignores missing saved steps", () => {
  assert.equal(getTrustedSavedOnboardingStep(null, ["phone"]), null);
});
