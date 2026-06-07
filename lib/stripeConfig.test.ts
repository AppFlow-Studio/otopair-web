import test from "node:test";
import assert from "node:assert/strict";

import { resolveStripePublishableKey } from "./stripeConfig.ts";

test("Stripe publishable key falls back to the server hint when Expo env is missing", () => {
  assert.equal(resolveStripePublishableKey("", "pk_test_from_server"), "pk_test_from_server");
});

test("Stripe publishable key rejects blank configuration", () => {
  assert.equal(resolveStripePublishableKey("   ", null), null);
  assert.equal(resolveStripePublishableKey(undefined, "   "), null);
});
