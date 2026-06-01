/**
 * quotes.ts — Convex query surface for the Pricing v2 quote engine.
 *
 * Read-only and reactive. Wraps lib/quoteEngine.buildQuote so callers (mobile
 * quote screen, mechanic UI, validation runner) get a consistent shape.
 *
 * The bookings.ts and invoices.ts call sites still read flat `shop.labor_rate`
 * today — they will be cut over to buildQuote in a follow-up PR.
 */

import { v } from "convex/values";
import { query } from "./_generated/server";
import { buildQuote } from "./lib/quoteEngine";

export const build = query({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
    service_id: v.id("services"),
    shop_id: v.id("shops"),
  },
  handler: async (ctx, args) => {
    return await buildQuote(ctx, args);
  },
});
