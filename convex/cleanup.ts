import { internalMutation, internalAction, internalQuery } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";

/**
 * INTERNAL MUTATION: getExpiredDeletions
 * Finds users whose account deletion grace period (30 days) has expired.
 */
export const getExpiredDeletions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    
    const expiredUsers = await ctx.db
      .query("users")
      .withIndex("by_isPendingDeletion", (q) => q.eq("isPendingDeletion", true))
      .filter((q) => q.lt(q.field("deletionRequestedAt"), thirtyDaysAgo))
      .collect();

    return expiredUsers.map(u => ({ id: u._id, clerkUserId: u.clerkUserId }));
  },
});

/**
 * INTERNAL MUTATION: deleteUserRecord
 * Permanently deletes a user record from Convex.
 */
export const deleteUserRecord = internalMutation({
  args: { id: v.id("users") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});

/**
 * ACTION: cleanupExpiredAccounts
 * Orchestrates the permanent deletion of accounts that have passed the 30-day grace period.
 * This should be called by a cron job.
 */
export const cleanupExpiredAccounts = internalAction({
  args: {},
  handler: async (ctx) => {
    const expiredUsers = await ctx.runMutation(internal.cleanup.getExpiredDeletions);
    
    for (const user of expiredUsers) {
      try {
        console.log(`Permanently deleting user ${user.id} (Clerk: ${user.clerkUserId})`);
        
        // 1. Delete from Clerk via Backend API
        // NOTE: This requires CLERK_SECRET_KEY to be set in Convex environment variables.
        const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
        if (CLERK_SECRET_KEY) {
          const response = await fetch(`https://api.clerk.com/v1/users/${user.clerkUserId}`, {
            method: 'DELETE',
            headers: {
              'Authorization': `Bearer ${CLERK_SECRET_KEY}`,
              'Content-Type': 'application/json',
            },
          });
          
          if (!response.ok) {
            const error = await response.json();
            console.error(`Failed to delete user from Clerk: ${JSON.stringify(error)}`);
            // We continue anyway to clean up Convex, or you might want to skip.
          }
        } else {
          console.warn("CLERK_SECRET_KEY not set in Convex environment variables. Skipping Clerk deletion.");
        }

        // 2. Delete from Convex
        await ctx.runMutation(internal.cleanup.deleteUserRecord, { id: user.id });
        
      } catch (error) {
        console.error(`Error cleaning up user ${user.id}:`, error);
      }
    }
  },
});

// ─── Task 24: Duplicate Makes Cleanup ──────────────────────────────────
/**
 * Re-point all references from a duplicate make to the canonical (seeded) make,
 * then delete the duplicate. Affects: models, engines, transmissions,
 * vehicle_configs, oem_parts, source_registry, scrape_cache.
 */
export const mergeDuplicateMake = internalMutation({
  args: {
    duplicate_id: v.id("makes"),
    canonical_id: v.id("makes"),
  },
  handler: async (ctx, args) => {
    let repointed = 0;

    // 1. models
    for (const doc of await ctx.db.query("models").withIndex("by_make_id", (q) => q.eq("make_id", args.duplicate_id)).collect()) {
      await ctx.db.patch(doc._id, { make_id: args.canonical_id });
      repointed++;
    }

    // 2. engines (make_id is optional)
    for (const doc of await ctx.db.query("engines").collect()) {
      if (doc.make_id === args.duplicate_id) {
        await ctx.db.patch(doc._id, { make_id: args.canonical_id });
        repointed++;
      }
    }

    // 3. transmissions (make_id is optional — no index, scan)
    for (const doc of await ctx.db.query("transmissions").collect()) {
      if ((doc as any).make_id === args.duplicate_id) {
        await ctx.db.patch(doc._id, { make_id: args.canonical_id });
        repointed++;
      }
    }

    // 4. vehicle_configs
    for (const doc of await ctx.db.query("vehicle_configs").collect()) {
      if (doc.make_id === args.duplicate_id) {
        await ctx.db.patch(doc._id, { make_id: args.canonical_id });
        repointed++;
      }
    }

    // 5. oem_parts (make_id is optional)
    for (const doc of await ctx.db.query("oem_parts").collect()) {
      if ((doc as any).make_id === args.duplicate_id) {
        await ctx.db.patch(doc._id, { make_id: args.canonical_id });
        repointed++;
      }
    }

    // 6. source_registry
    for (const doc of await ctx.db.query("source_registry").collect()) {
      if (doc.make_id === args.duplicate_id) {
        await ctx.db.patch(doc._id, { make_id: args.canonical_id });
        repointed++;
      }
    }

    // 7. scrape_cache (make_id is optional)
    for (const doc of await ctx.db.query("scrape_cache").collect()) {
      if ((doc as any).make_id === args.duplicate_id) {
        await ctx.db.patch(doc._id, { make_id: args.canonical_id });
        repointed++;
      }
    }

    // Delete the duplicate make
    await ctx.db.delete(args.duplicate_id);

    console.log(`[cleanup] Merged make ${args.duplicate_id} → ${args.canonical_id}: ${repointed} references re-pointed`);
    return { repointed };
  },
});

/**
 * Action to merge all known duplicate makes. Run once after deploy.
 */
export const mergeAllDuplicateMakes = internalAction({
  args: {},
  handler: async (ctx) => {
    // Find duplicates by scanning for makes without a slug (pipeline-created)
    // and matching them to seeded makes by slug derivation
    const allMakes: any[] = await ctx.runQuery(internal.cleanup.listAllMakes, {});

    const seeded = allMakes.filter((m: any) => m.slug);
    const duplicates = allMakes.filter((m: any) => !m.slug);

    let totalRepointed = 0;

    for (const dup of duplicates) {
      const slug = dup.name.toLowerCase().replace(/\s+/g, "-");
      const canonical = seeded.find((s: any) => s.slug === slug);

      if (canonical) {
        console.log(`[cleanup] Merging "${dup.name}" (${dup._id}) → "${canonical.name}" (${canonical._id})`);
        const result = await ctx.runMutation(internal.cleanup.mergeDuplicateMake, {
          duplicate_id: dup._id,
          canonical_id: canonical._id,
        });
        totalRepointed += result.repointed;
      } else {
        console.warn(`[cleanup] No canonical match for "${dup.name}" — skipping`);
      }
    }

    console.log(`[cleanup] Done: merged ${duplicates.length} duplicate makes, ${totalRepointed} total references re-pointed`);
    return { mergedCount: duplicates.length, totalRepointed };
  },
});

export const listAllMakes = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("makes").collect();
  },
});

