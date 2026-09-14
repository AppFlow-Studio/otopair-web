import { expect, test } from "vitest";
import type { Id } from "../convex/_generated/dataModel";

import {
  getQuoteAvailability,
  resolveOwnedQuoteHoldExclusion,
} from "../convex/lib/quoteHoldOwnership";

type Row = Record<string, unknown>;

function makeCtx(seed: Record<string, Row[]>, clerkUserId?: string) {
  const rows = Object.values(seed).flat();
  return {
    auth: {
      async getUserIdentity() {
        return clerkUserId ? { subject: clerkUserId } : null;
      },
    },
    db: {
      query(table: string) {
        const tableRows = seed[table] ?? [];
        return {
          withIndex(_name: string, callback: (query: { eq: (field: string, value: unknown) => unknown }) => unknown) {
            let field = "";
            let value: unknown;
            callback({
              eq(nextField, nextValue) {
                field = nextField;
                value = nextValue;
                return this;
              },
            });
            return {
              async unique() {
                return tableRows.find((row) => String(row[field]) === String(value)) ?? null;
              },
            };
          },
        };
      },
      async get(id: string) {
        return rows.find((row) => String(row._id) === String(id)) ?? null;
      },
    },
  };
}

const seed = {
  users: [
    { _id: "user-1", clerkUserId: "clerk-owner" },
    { _id: "user-2", clerkUserId: "clerk-other" },
  ],
  bookings: [{ _id: "booking-1", user_id: "user-1" }],
  tire_quote_responses: [{ _id: "tire-response-1", booking_id: "booking-1" }],
  rotor_quote_responses: [{ _id: "rotor-response-1", booking_id: "booking-1" }],
};

test("booking owner receives the matching quote-response exclusion", async () => {
  const ctx = makeCtx(seed, "clerk-owner");

  await expect(
    resolveOwnedQuoteHoldExclusion(ctx, {
      quote_type: "tire",
      response_id: "tire-response-1" as Id<"tire_quote_responses">,
    }),
  ).resolves.toEqual({ excludeTireQuoteResponseId: "tire-response-1" });
  await expect(
    resolveOwnedQuoteHoldExclusion(ctx, {
      quote_type: "rotor",
      response_id: "rotor-response-1" as Id<"rotor_quote_responses">,
    }),
  ).resolves.toEqual({ excludeRotorQuoteResponseId: "rotor-response-1" });
});

test("another user cannot exclude the booking owner's quote hold", async () => {
  const ctx = makeCtx(seed, "clerk-other");

  await expect(
    resolveOwnedQuoteHoldExclusion(ctx, {
      quote_type: "tire",
      response_id: "tire-response-1" as Id<"tire_quote_responses">,
    }),
  ).resolves.toEqual({});
});

test("cancelled and modified quote revisions are unavailable without exposing revisions", () => {
  const now = Date.now();

  expect(
    getQuoteAvailability(
      {
        created_at: now,
        expires_at: now + 60_000,
        cancelled_at: now,
        revision: 1,
      },
      { expectedRevision: 1, now },
    ),
  ).toEqual({ available: false, reason: "cancelled" });

  expect(
    getQuoteAvailability(
      {
        created_at: now,
        expires_at: now + 60_000,
        revision: 2,
      },
      { expectedRevision: 1, now },
    ),
  ).toEqual({ available: false, reason: "modified" });
});

test("availability browsing can omit a stale quote exclusion without throwing", async () => {
  const now = Date.now();
  const ctx = makeCtx(
    {
      ...seed,
      tire_quote_responses: [
        {
          _id: "tire-response-1",
          booking_id: "booking-1",
          created_at: now,
          expires_at: now + 60_000,
          revision: 2,
        },
      ],
    },
    "clerk-owner",
  );

  await expect(
    resolveOwnedQuoteHoldExclusion(
      ctx,
      {
        quote_type: "tire",
        response_id: "tire-response-1" as Id<"tire_quote_responses">,
        revision: 1,
      },
      { throwOnUnavailable: false },
    ),
  ).resolves.toEqual({});
});
