/**
 * devOnly/deployProbe.ts — deployment-drift probe (Aug 2026).
 *
 * The dev:third-bird-914 deployment is fed by TWO sources: the main
 * checkout's long-running `npx convex dev` watcher and ad-hoc worktree
 * `npx convex dev --once` pushes. When they diverge, the watcher can clobber
 * a worktree push minutes later (observed live Aug 8: the services-rescue
 * deploy was reverted before its canaries' batch-2 collection ran, so the
 * runs executed pre-fix code with no rescue markers and no verdict suffix).
 *
 * This probe exists ONLY in trees that carry the rescue commit — if
 * `npx convex run devOnly/deployProbe:version` starts failing with
 * "function not found" after a worktree push, the watcher has re-synced the
 * deployment from a tree that lacks the commit.
 */
import { internalQuery } from "../_generated/server";

export const version = internalQuery({
  args: {},
  handler: async () => ({
    marker: "services-rescue-70b952e",
    deployedFrom: "worktree cranky-proskuriakova-910519",
  }),
});
