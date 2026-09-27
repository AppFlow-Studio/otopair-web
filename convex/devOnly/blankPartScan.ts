/**
 * devOnly/blankPartScan.ts — READ-ONLY investigation for the blank-"test part"
 * bug (a manually-added part with an empty part_name reached the customer: a
 * blank "$0.01 · Qty 1" card-hold / receipt line, plus a count-vs-billed
 * mismatch). Nothing here writes — it only locates and reports offending rows so
 * the fix can be verified against live data.
 *
 * A "blank" row is one that fails isNamedPart (convex/lib/parts.ts) — the exact
 * predicate the write boundaries now enforce. Tire rows are never counted (their
 * name is synthesized).
 *
 *   # Find the Oyelade booking(s) and their blank rows (run per deployment):
 *   npx convex run devOnly/blankPartScan:findByLastName '{"lastName":"Oyelade"}'
 *
 *   # Fleet-wide sweep — every booking with a blank-name part row:
 *   npx convex run devOnly/blankPartScan:scanAll '{"limit":200}'
 *
 * The Oyelade booking is on ardent-crab-641; add --prod / the deployment flag
 * as appropriate. `npx convex run` may time out client-side while the query
 * keeps running server-side.
 */

import { internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { isNamedPart } from "../lib/parts";

type BlankRow = {
  source:
    | "priced_parts_snapshot"
    | "booking_approvals.parts_snapshot"
    | "job_actuals.parts_used"
    | "final_parts_used_at_capture";
  index: number;
  part_name: unknown;
  oem_number: unknown;
  quantity: unknown;
  /** Whatever price field the store carries (dollars or cents — verbatim). */
  price: unknown;
};

function priceOf(p: any): unknown {
  return p?.cost ?? p?.unit_price_cents ?? p?.line_total_cents ?? null;
}

/** Scan one part array; return the rows that fail isNamedPart. */
function blanksIn(
  arr: unknown,
  source: BlankRow["source"],
): BlankRow[] {
  if (!Array.isArray(arr)) return [];
  const out: BlankRow[] = [];
  arr.forEach((p: any, index: number) => {
    if (!isNamedPart(p)) {
      out.push({
        source,
        index,
        part_name: p?.part_name ?? null,
        oem_number: p?.oem_number ?? null,
        quantity: p?.quantity ?? null,
        price: priceOf(p),
      });
    }
  });
  return out;
}

/** Gather every blank row across all four stores for a single booking. */
async function auditBooking(ctx: any, booking: any) {
  const blanks: BlankRow[] = [
    ...blanksIn(booking.priced_parts_snapshot, "priced_parts_snapshot"),
    ...blanksIn(
      booking.final_parts_used_at_capture,
      "final_parts_used_at_capture",
    ),
  ];

  // Latest job_actuals for this booking.
  const ja = await ctx.db
    .query("job_actuals")
    .withIndex("by_booking_id", (q: any) => q.eq("booking_id", booking._id))
    .order("desc")
    .first();
  if (ja) blanks.push(...blanksIn(ja.parts_used, "job_actuals.parts_used"));

  // Every approval row (each carries its own frozen parts_snapshot).
  const approvals = await ctx.db
    .query("booking_approvals")
    .withIndex("by_booking_and_cycle", (q: any) =>
      q.eq("booking_id", booking._id),
    )
    .collect();
  for (const a of approvals) {
    blanks.push(
      ...blanksIn(a.parts_snapshot, "booking_approvals.parts_snapshot"),
    );
  }

  return blanks;
}

/** Locate bookings for a customer LAST NAME and report their blank-name rows.
 *  Case-insensitive exact match on users.last_name (no index — full scan, fine
 *  for a dev one-off). */
export const findByLastName = internalQuery({
  args: { lastName: v.string() },
  handler: async (ctx, args) => {
    const target = args.lastName.trim().toLowerCase();
    const users = await ctx.db.query("users").collect();
    const matched = users.filter(
      (u: any) => (u.last_name ?? "").trim().toLowerCase() === target,
    );

    const out: any[] = [];
    for (const u of matched) {
      const bookings = await ctx.db
        .query("bookings")
        .withIndex("by_user_id", (q: any) => q.eq("user_id", u._id))
        .collect();
      for (const b of bookings) {
        const blanks = await auditBooking(ctx, b);
        out.push({
          booking_id: String(b._id),
          customer: `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim(),
          email: u.email ?? null,
          status: b.status ?? null,
          created_at: b.created_at ?? b._creationTime,
          parts_cost: b.parts_cost ?? null,
          total_cost: b.total_cost ?? null,
          blank_count: blanks.length,
          blanks,
        });
      }
    }
    return {
      lastName: args.lastName,
      matched_users: matched.length,
      bookings: out.length,
      bookings_with_blanks: out.filter((r) => r.blank_count > 0).length,
      results: out,
    };
  },
});

/** Fleet-wide read-only sweep: every booking carrying a blank-name part row in
 *  any of the four stores. Capped so the payload stays sane. */
export const scanAll = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const cap = args.limit ?? 200;
    const bookings = await ctx.db.query("bookings").collect();

    let scanned = 0;
    let flagged = 0;
    let truncated = false;
    const results: any[] = [];
    for (const b of bookings) {
      scanned++;
      const blanks = await auditBooking(ctx, b);
      if (blanks.length === 0) continue;
      flagged++;
      if (results.length < cap) {
        const u: any = b.user_id ? await ctx.db.get(b.user_id) : null;
        results.push({
          booking_id: String(b._id),
          customer: u
            ? `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim()
            : null,
          email: u?.email ?? null,
          status: b.status ?? null,
          blank_count: blanks.length,
          blanks,
        });
      } else {
        truncated = true;
      }
    }
    return {
      scanned,
      bookings_with_blanks: flagged,
      returned: results.length,
      truncated,
      results,
    };
  },
});
