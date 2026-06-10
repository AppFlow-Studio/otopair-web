// =============================================================================
// Shared director-session gate for token-gated panel functions.
//
// The director panel authenticates with email+TOTP and stores a session
// token (localStorage `otopair_director_token`). Every Convex function the
// panel calls must validate that token SERVER-SIDE — Next.js middleware is
// not a security boundary for direct Convex calls. This is the same gate as
// convex/directorConfigActions.ts; extracted (Jun-10) once ai_feedback and
// audit_log needed their own copies.
//
// Queries and mutations both have ctx.db, so the lookup is direct and
// transactional. Actions should use api.director_auth.validateSession
// instead (no ctx.db there).
// =============================================================================
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

/** Validate the director session and return the audit actor. Throws on a
 *  missing/expired session. */
export async function requireDirector(
  ctx: QueryCtx | MutationCtx,
  token: string,
): Promise<{ name: string; userId: Id<"director_users"> }> {
  if (token) {
    const s = await ctx.db
      .query("director_sessions")
      .withIndex("by_token", (q) => q.eq("token", token))
      .first();
    if (s && s.expires_at >= Date.now()) {
      const u = await ctx.db.get(s.user_id);
      if (u) return { name: u.name, userId: u._id };
    }
  }
  throw new Error("unauthorized: invalid or expired director session");
}
