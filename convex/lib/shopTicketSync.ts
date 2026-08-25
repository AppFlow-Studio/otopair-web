// =============================================================================
// shopTicketSync — keep Message Shop tickets truthful about triggered flows.
//
// When a shop reply drove an existing rail (reschedule proposal, mid-job
// approval), the ticket message carries an `action` rider stamped "pending".
// This helper patches that rider when the customer later accepts / declines /
// lets it expire through the existing overlay/banner, so the thread doesn't
// read "pending" forever. Dependency-free (only ctx.db) so bookings.ts and
// booking_approvals.ts can import it without an import cycle.
// =============================================================================
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

export async function syncTicketActionStatus(
  ctx: MutationCtx,
  opts: {
    bookingId: Id<"bookings">;
    kind: string; // propose_reschedule | request_approval | …
    status: string; // accepted | declined | expired | applied
    autoResolve?: boolean; // resolve the ticket when the flow ends positively
  },
): Promise<void> {
  const rows = await ctx.db
    .query("shop_ticket_messages")
    .withIndex("by_booking_id", (q) => q.eq("booking_id", opts.bookingId))
    .collect();
  const pending = rows
    .filter(
      (m) =>
        m.action != null &&
        m.action.kind === opts.kind &&
        (m.action.status ?? "pending") === "pending",
    )
    .sort((a, b) => b.timestamp - a.timestamp);
  if (pending.length === 0) return;

  const now = Date.now();
  for (const m of pending) {
    await ctx.db.patch(m._id, {
      action: { ...m.action!, status: opts.status, resolved_at: now },
    });
    if (opts.autoResolve) {
      const ticket = await ctx.db.get(m.ticket_id);
      if (
        ticket &&
        ticket.status !== "closed" &&
        ticket.status !== "resolved"
      ) {
        await ctx.db.patch(m.ticket_id, {
          status: "resolved",
          resolved_at: now,
          updated_at: now,
        });
      }
    }
  }
}
