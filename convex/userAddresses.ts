/**
 * userAddresses.ts — Saved-Addresses CRUD.
 *
 * Backs the Saved Addresses settings page (UberEats-style list of
 * Home / Work / Other addresses the user reuses for bookings). Each
 * user can have one address flagged `is_primary` at a time — the
 * `add`/`update` mutations enforce the mutex by clearing the flag on
 * other rows before setting it on the target.
 */

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

const TYPE_VALIDATOR = v.union(
  v.literal("home"),
  v.literal("work"),
  v.literal("other"),
);

/**
 * Internal helper — ensures only `targetId` has `is_primary: true`
 * across all of `userId`'s saved addresses.
 */
async function makeExclusivelyPrimary(
  ctx: MutationCtx,
  userId: Id<"users">,
  targetId: Id<"user_saved_addresses">,
) {
  const rows = await ctx.db
    .query("user_saved_addresses")
    .withIndex("by_user_id", (q) => q.eq("user_id", userId))
    .collect();
  for (const row of rows) {
    if (row._id === targetId) continue;
    if (row.is_primary) {
      await ctx.db.patch(row._id, { is_primary: false });
    }
  }
  await ctx.db.patch(targetId, { is_primary: true });
}

export const list = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("user_saved_addresses")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .collect();
    // Primary first, then by creation order (oldest first).
    return rows.sort((a, b) => {
      if ((a.is_primary ? 1 : 0) !== (b.is_primary ? 1 : 0)) {
        return (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0);
      }
      return (a.created_at ?? 0) - (b.created_at ?? 0);
    });
  },
});

export const add = mutation({
  args: {
    userId: v.id("users"),
    type: TYPE_VALIDATOR,
    label: v.string(),
    address: v.string(),
    notes: v.optional(v.string()),
    makePrimary: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("user_saved_addresses")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .collect();
    // First-ever address is implicitly primary.
    const shouldPromote = args.makePrimary || existing.length === 0;
    const id = await ctx.db.insert("user_saved_addresses", {
      user_id: args.userId,
      type: args.type,
      label: args.label.trim() || defaultLabelForType(args.type),
      address: args.address.trim(),
      notes: args.notes?.trim() || undefined,
      is_primary: shouldPromote,
      created_at: now,
      updated_at: now,
    });
    if (shouldPromote) {
      await makeExclusivelyPrimary(ctx, args.userId, id);
    }
    return id;
  },
});

export const update = mutation({
  args: {
    id: v.id("user_saved_addresses"),
    type: v.optional(TYPE_VALIDATOR),
    label: v.optional(v.string()),
    address: v.optional(v.string()),
    notes: v.optional(v.string()),
    makePrimary: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Address not found");
    const patch: Partial<{
      type: "home" | "work" | "other";
      label: string;
      address: string;
      notes: string | undefined;
      updated_at: number;
    }> = { updated_at: Date.now() };
    if (args.type !== undefined) patch.type = args.type;
    if (args.label !== undefined) {
      patch.label =
        args.label.trim() ||
        defaultLabelForType(args.type ?? existing.type);
    }
    if (args.address !== undefined) patch.address = args.address.trim();
    if (args.notes !== undefined) patch.notes = args.notes.trim() || undefined;
    await ctx.db.patch(args.id, patch);
    if (args.makePrimary) {
      await makeExclusivelyPrimary(ctx, existing.user_id, args.id);
    }
    return args.id;
  },
});

export const remove = mutation({
  args: { id: v.id("user_saved_addresses") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) return;
    const wasPrimary = existing.is_primary === true;
    const userId = existing.user_id;
    await ctx.db.delete(args.id);
    if (wasPrimary) {
      // Promote the next-most-recent remaining row to primary so the
      // user always has a default when they have at least one address.
      const remaining = await ctx.db
        .query("user_saved_addresses")
        .withIndex("by_user_id", (q) => q.eq("user_id", userId))
        .collect();
      if (remaining.length > 0) {
        const next = remaining.sort(
          (a, b) => (b.created_at ?? 0) - (a.created_at ?? 0),
        )[0];
        await ctx.db.patch(next._id, { is_primary: true });
      }
    }
  },
});

function defaultLabelForType(type: "home" | "work" | "other"): string {
  if (type === "home") return "Home";
  if (type === "work") return "Work";
  return "Other";
}
