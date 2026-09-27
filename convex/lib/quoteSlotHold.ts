/* eslint-disable @typescript-eslint/no-explicit-any */
// ============================================================================
// Shop-side quote slot holds.
//
// While a shop owner fills out a tire/rotor quote, the quote dialog holds the
// chosen mechanic+window through `slotHolds.holdSlot` (15-min TTL) so a
// customer can't book it from the app mid-form. On submit, the quote mutation
// validates that hold, ignores it in the availability check (it's ours), and
// deletes it in the same mutation that writes the response — the response then
// becomes the quote hold, so the window is never unprotected.
//
// Conflicts are rethrown as `ConvexError({ code: "SLOT_UNAVAILABLE" })` so the
// dialog can deselect the slot and show a friendly "just got booked" notice
// instead of a stack trace. The shared availability helpers keep throwing plain
// `Error` — the mobile app's callers are unaffected.
// ============================================================================
import { ConvexError } from "convex/values";
import { assertMechanicAvailableForWindow } from "./timeSlotAvailability";
import {
  resolveSlotHoldForConsume,
  deleteConsumedSlotHold,
} from "../slotHolds";

export const SLOT_UNAVAILABLE = "SLOT_UNAVAILABLE";

export async function assertQuoteSlotAvailable(
  ctx: any,
  args: {
    shopId: any;
    mechanicId: any;
    date: string;
    startTime: string;
    durationMinutes: number;
    holdId?: any;
    sessionId?: string;
    excludeTireQuoteResponseId?: string;
    excludeRotorQuoteResponseId?: string;
  },
): Promise<{ consumeHoldId: any | null }> {
  // Never throws — an invalid/expired hold just means no exclusion, and the
  // full availability assert below is the backstop.
  const held = await resolveSlotHoldForConsume(ctx, {
    holdId: args.holdId,
    sessionId: args.sessionId,
    shopId: args.shopId,
    date: args.date,
    startTime: args.startTime,
  });
  const holdIsForThisMechanic =
    held.consumeHoldId != null &&
    String(held.pinnedMechanicId) === String(args.mechanicId);

  try {
    await assertMechanicAvailableForWindow(ctx, {
      shopId: args.shopId,
      mechanicId: args.mechanicId,
      date: args.date,
      startTime: args.startTime,
      durationMinutes: args.durationMinutes,
      excludeTireQuoteResponseId: args.excludeTireQuoteResponseId,
      excludeRotorQuoteResponseId: args.excludeRotorQuoteResponseId,
      excludeSessionId: holdIsForThisMechanic ? held.excludeSessionId : undefined,
    });
  } catch (e) {
    throw new ConvexError({
      code: SLOT_UNAVAILABLE,
      message:
        e instanceof Error && e.message
          ? e.message
          : "That time is no longer available.",
    });
  }

  return { consumeHoldId: holdIsForThisMechanic ? held.consumeHoldId : null };
}

export async function consumeQuoteSlotHold(ctx: any, holdId: any | null) {
  await deleteConsumedSlotHold(ctx, holdId);
}
