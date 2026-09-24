/**
 * devOnly/backfillBlankParts.ts — one-time cleanup for legacy blank-name part
 * rows already stored before the write-boundary guards shipped (the blank-"test
 * part" bug). Two actions per row:
 *
 *   • COALESCE — a row that was billed (has a price) or carries an OEM number
 *     but no name gets part_name = partDisplayName(row) ("Unnamed part" /
 *     "Part <oem>" / "Tires (<size>)"). NEVER deletes a billed row: rewriting
 *     the name preserves the ledger, deleting it would change an already-frozen
 *     parts_subtotal_cents / captured total.
 *   • DROP — a pure-noise row (no name AND no price AND no oem) contributes $0
 *     to every total, so removing it changes nothing and is safe.
 *
 * Idempotent: after a coalesce part_name is non-empty, so isNamedPart is true
 * and a re-run touches nothing. DRY-RUN BY DEFAULT — pass "dryRun":false to
 * actually write. Paginated per table; run each table to isDone, feeding back
 * the returned cursor. Run against the deployment that holds the data (the
 * Oyelade backlog is on ardent-crab-641):
 *
 *   npx convex run devOnly/backfillBlankParts:backfill '{"table":"bookings"}'
 *   npx convex run devOnly/backfillBlankParts:backfill \
 *     '{"table":"bookings","cursor":"<continueCursor>"}'
 *   # ...then table:"job_actuals", "booking_approvals", "custom_jobs".
 *   # Verify with devOnly/blankPartScan:scanAll, then re-run with "dryRun":false.
 */

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { isNamedPart, partDisplayName } from "../lib/parts";

function hasPrice(p: any): boolean {
  return (
    (Number(p?.cost) || 0) > 0 ||
    (Number(p?.unit_price_cents) || 0) > 0 ||
    (Number(p?.line_total_cents) || 0) > 0
  );
}

function hasOem(p: any): boolean {
  return (p?.oem_number ?? "").trim().length > 0;
}

type FixResult = {
  next: any[];
  coalesces: { index: number; from: unknown; to: string }[];
  drops: { index: number; price: unknown; oem: unknown }[];
};

/** Return the rewritten array + a change log, or null when nothing changed. */
function fixArray(arr: unknown): FixResult | null {
  if (!Array.isArray(arr)) return null;
  const next: any[] = [];
  const coalesces: FixResult["coalesces"] = [];
  const drops: FixResult["drops"] = [];

  arr.forEach((p: any, index: number) => {
    if (isNamedPart(p)) {
      next.push(p);
      return;
    }
    // Unnamed row. Pure noise (no money, no identity) → drop; otherwise keep it
    // (it was billed / has an OEM) and give it a real display name.
    if (!hasPrice(p) && !hasOem(p)) {
      drops.push({ index, price: p?.cost ?? p?.unit_price_cents ?? null, oem: p?.oem_number ?? null });
      return;
    }
    const to = partDisplayName(p);
    coalesces.push({ index, from: p?.part_name ?? null, to });
    next.push({ ...p, part_name: to });
  });

  return coalesces.length > 0 || drops.length > 0
    ? { next, coalesces, drops }
    : null;
}

const PART_FIELDS: Record<string, string[]> = {
  bookings: ["priced_parts_snapshot", "final_parts_used_at_capture"],
  job_actuals: ["parts_used"],
  booking_approvals: ["parts_snapshot"],
  custom_jobs: ["parts"],
};

export const backfill = internalMutation({
  args: {
    table: v.union(
      v.literal("bookings"),
      v.literal("job_actuals"),
      v.literal("booking_approvals"),
      v.literal("custom_jobs"),
    ),
    cursor: v.optional(v.union(v.string(), v.null())),
    batchSize: v.optional(v.number()),
    /** Defaults to TRUE — nothing is written unless you pass dryRun:false. */
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx: any, args) => {
    const batchSize = args.batchSize ?? 100;
    const dryRun = args.dryRun !== false;
    const fields = PART_FIELDS[args.table];

    // Dynamic table read — kept in a switch so the query stays typed.
    const opts = { numItems: batchSize, cursor: args.cursor ?? null };
    const page =
      args.table === "bookings"
        ? await ctx.db.query("bookings").paginate(opts)
        : args.table === "job_actuals"
          ? await ctx.db.query("job_actuals").paginate(opts)
          : args.table === "booking_approvals"
            ? await ctx.db.query("booking_approvals").paginate(opts)
            : await ctx.db.query("custom_jobs").paginate(opts);

    let docsChanged = 0;
    let namesCoalesced = 0;
    let noiseRowsDropped = 0;
    const samples: any[] = [];

    for (const doc of page.page) {
      const patch: Record<string, any> = {};
      let docChanged = false;

      for (const field of fields) {
        const res = fixArray((doc as any)[field]);
        if (!res) continue;
        patch[field] = res.next;
        namesCoalesced += res.coalesces.length;
        noiseRowsDropped += res.drops.length;
        docChanged = true;
        if (samples.length < 25) {
          samples.push({
            id: String(doc._id),
            field,
            coalesces: res.coalesces,
            drops: res.drops,
          });
        }
      }

      if (docChanged) {
        docsChanged += 1;
        if (!dryRun) await ctx.db.patch(doc._id, patch);
      }
    }

    return {
      table: args.table,
      dryRun,
      scanned: page.page.length,
      docsChanged,
      namesCoalesced,
      noiseRowsDropped,
      samples,
      isDone: page.isDone,
      cursor: page.continueCursor,
    };
  },
});
