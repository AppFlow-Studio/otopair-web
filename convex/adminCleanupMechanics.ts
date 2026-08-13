/**
 * adminCleanupMechanics
 *
 * One-time admin helpers for collapsing duplicate rows in the `mechanics`
 * table — created when seed.ts (1424-1491) was re-run and inserted the
 * same {shop, name} pair twice. The mobile picker masks this with a
 * client-side dedupe in `hooks/useMechanicsFromConvex.ts`, but the
 * shared Convex deployment still has the dupes, which is visible in
 * otopair-web's schedule, in bookings tied to the wrong mechanic row, etc.
 *
 * USAGE
 *   1. Preview the duplicate groups (read-only):
 *        npx convex run adminCleanupMechanics:findDuplicateMechanics
 *
 *   2. Run the cleanup — repoints every FK in 14 referencing tables
 *      from the duplicate row(s) to the oldest row in each group, then
 *      deletes the duplicates. Requires an explicit confirm arg so it
 *      can't fire by accident:
 *        npx convex run adminCleanupMechanics:dedupeMechanics \
 *          '{"confirm":"YES_DEDUPE_MECHANICS"}'
 *
 * SAFETY
 *   - "Canonical" = the row with the smallest `_creationTime` per
 *     (shop_id, lower(trim(first_name)) + " " + lower(trim(last_name))).
 *   - Every referencing FK is patched to point at the canonical row
 *     before the duplicate is deleted, so no rows are orphaned.
 *   - Run inside a single mutation → atomic; either every change
 *     lands or none do.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

function normalizeName(s: string | undefined | null): string {
  return (s ?? "").trim().toLowerCase();
}

function dedupeKey(m: Doc<"mechanics">): string {
  return `${String(m.shop_id)}::${normalizeName(m.first_name)} ${normalizeName(m.last_name)}`;
}

/**
 * Group every mechanic by (shop_id, normalized full name). Return only
 * groups with more than one row — these are the duplicates.
 */
export const findDuplicateMechanics = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("mechanics").collect();
    const groups = new Map<string, Doc<"mechanics">[]>();
    for (const m of all) {
      const key = dedupeKey(m);
      const arr = groups.get(key) ?? [];
      arr.push(m);
      groups.set(key, arr);
    }

    const dupes: Array<{
      shop_id: string;
      name: string;
      canonical: { _id: string; created_at: number };
      duplicates: Array<{ _id: string; created_at: number }>;
    }> = [];

    for (const [, group] of groups) {
      if (group.length <= 1) continue;
      group.sort((a, b) => a._creationTime - b._creationTime);
      const [canonical, ...rest] = group;
      dupes.push({
        shop_id: String(canonical.shop_id),
        name: `${canonical.first_name ?? ""} ${canonical.last_name ?? ""}`.trim(),
        canonical: { _id: String(canonical._id), created_at: canonical._creationTime },
        duplicates: rest.map((r) => ({ _id: String(r._id), created_at: r._creationTime })),
      });
    }

    return {
      totalMechanics: all.length,
      duplicateGroups: dupes.length,
      rowsToDelete: dupes.reduce((n, g) => n + g.duplicates.length, 0),
      groups: dupes,
    };
  },
});

/**
 * Repoint every `mechanic_id` FK from `fromId` to `toId` across the 14
 * referencing tables (12 top-level fields + 2 nested in
 * `late_start_reviews.proposals`), then delete the `fromId` row.
 */
async function repointAndDelete(
  ctx: { db: any },
  fromId: Id<"mechanics">,
  toId: Id<"mechanics">,
): Promise<number> {
  let count = 0;

  const patchSimple = async (
    table:
      | "mechanic_verifications"
      | "user_mechanic_preferences"
      | "time_slots"
      | "job_actuals"
      | "job_overrun_checkins",
  ) => {
    const rows = await ctx.db
      .query(table)
      .filter((q: any) => q.eq(q.field("mechanic_id"), fromId))
      .collect();
    for (const r of rows) {
      await ctx.db.patch(r._id, { mechanic_id: toId });
      count++;
    }
  };

  const patchOptional = async (
    table:
      | "shop_users"
      | "shop_invitations"
      | "reviews"
      | "overrun_checkins"
      | "notification_outbox",
  ) => {
    const rows = await ctx.db
      .query(table)
      .filter((q: any) => q.eq(q.field("mechanic_id"), fromId))
      .collect();
    for (const r of rows) {
      await ctx.db.patch(r._id, { mechanic_id: toId });
      count++;
    }
  };

  await patchSimple("mechanic_verifications");
  await patchSimple("user_mechanic_preferences");
  await patchSimple("time_slots");
  await patchSimple("job_actuals");
  await patchSimple("job_overrun_checkins");

  await patchOptional("shop_users");
  await patchOptional("shop_invitations");
  await patchOptional("reviews");
  await patchOptional("overrun_checkins");
  await patchOptional("notification_outbox");

  // bookings has TWO fields that can reference mechanic_id:
  //   - mechanic_id (current assignment)
  //   - previous_mechanic_id (reschedule history)
  const bookingsByCurrent = await ctx.db
    .query("bookings")
    .filter((q: any) => q.eq(q.field("mechanic_id"), fromId))
    .collect();
  for (const b of bookingsByCurrent) {
    await ctx.db.patch(b._id, { mechanic_id: toId });
    count++;
  }
  const bookingsByPrevious = await ctx.db
    .query("bookings")
    .filter((q: any) => q.eq(q.field("previous_mechanic_id"), fromId))
    .collect();
  for (const b of bookingsByPrevious) {
    await ctx.db.patch(b._id, { previous_mechanic_id: toId });
    count++;
  }

  // late_start_reviews has nested `proposals[]` with optional
  // original_mechanic_id / proposed_mechanic_id. No index for these
  // fields — scan and rewrite the proposals array when affected.
  const lsr = await ctx.db.query("late_start_reviews").collect();
  for (const row of lsr) {
    let touched = false;
    const next = (row.proposals ?? []).map((p: any) => {
      const out: any = { ...p };
      if (p.original_mechanic_id === fromId) {
        out.original_mechanic_id = toId;
        touched = true;
      }
      if (p.proposed_mechanic_id === fromId) {
        out.proposed_mechanic_id = toId;
        touched = true;
      }
      return out;
    });
    if (touched) {
      await ctx.db.patch(row._id, { proposals: next });
      count++;
    }
  }

  // All references repointed — safe to drop the duplicate row.
  await ctx.db.delete(fromId);
  return count;
}

/**
 * Collapse duplicate mechanic rows. Runs in a single transaction.
 * Returns a report of what was repointed and deleted.
 */
export const dedupeMechanics = mutation({
  args: { confirm: v.literal("YES_DEDUPE_MECHANICS") },
  handler: async (ctx, _args) => {
    const all = await ctx.db.query("mechanics").collect();
    const groups = new Map<string, Doc<"mechanics">[]>();
    for (const m of all) {
      const key = dedupeKey(m);
      const arr = groups.get(key) ?? [];
      arr.push(m);
      groups.set(key, arr);
    }

    const report: Array<{
      name: string;
      canonical: string;
      deleted: string[];
      repointedRows: number;
    }> = [];

    for (const [, group] of groups) {
      if (group.length <= 1) continue;
      group.sort((a, b) => a._creationTime - b._creationTime);
      const [canonical, ...duplicates] = group;
      const entry = {
        name: `${canonical.first_name ?? ""} ${canonical.last_name ?? ""}`.trim(),
        canonical: String(canonical._id),
        deleted: [] as string[],
        repointedRows: 0,
      };
      for (const dupe of duplicates) {
        const moved = await repointAndDelete(
          ctx,
          dupe._id,
          canonical._id,
        );
        entry.deleted.push(String(dupe._id));
        entry.repointedRows += moved;
      }
      report.push(entry);
    }

    return {
      totalGroups: report.length,
      totalRowsDeleted: report.reduce((n, g) => n + g.deleted.length, 0),
      totalRowsRepointed: report.reduce((n, g) => n + g.repointedRows, 0),
      groups: report,
    };
  },
});
