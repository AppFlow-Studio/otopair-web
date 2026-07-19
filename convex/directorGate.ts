// =============================================================================
// Shared director-session gate for token-gated panel functions.
//
// The director panel and the /ops, /shops, /data portals authenticate with
// email+TOTP and store a session token (localStorage
// `otopair_director_token`). Every Convex function those surfaces call must
// validate that token SERVER-SIDE — Next.js middleware is not a security
// boundary for direct Convex calls. This is the same gate as
// convex/directorConfigActions.ts; extracted (Jun-10) once ai_feedback and
// audit_log needed their own copies.
//
// Jul-12: capability enforcement added (portal decision #2). Pass a
// capability as the third argument on every WRITE surface; read-only
// functions may keep the two-argument form. `lib/portal/capabilities.ts`
// mirrors CAPABILITIES for client-side `can()` checks — keep the two in sync.
//
// Queries and mutations both have ctx.db, so the lookup is direct and
// transactional. Actions should use api.director_auth.validateSession
// instead (no ctx.db there).
// =============================================================================
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

export type DirectorRole =
  | "super_admin"
  | "ops_admin"
  | "support"
  | "readonly"
  | "data_admin"
  | "shop_success";

export type Capability =
  | "users.write"
  | "money.write"
  | "shops.write"
  | "data.write"
  | "data.trigger"
  | "admin.manage"
  | "ai.write";

/** Legacy → portal role mapping. Only migrations/directorRoles.ts should
 *  need this — the schema validator no longer admits the legacy names. */
export const LEGACY_ROLE_MAP: Record<string, DirectorRole> = {
  superadmin: "super_admin",
  admin: "ops_admin",
  viewer: "readonly",
};

const ALL: Capability[] = [
  "users.write",
  "money.write",
  "shops.write",
  "data.write",
  "data.trigger",
  "admin.manage",
  "ai.write",
];

/** Role → allowed write capabilities. Every role can read everything its
 *  portal surfaces; capabilities gate WRITES only. */
export const CAPABILITIES: Record<DirectorRole, readonly Capability[]> = {
  super_admin: ALL,
  ops_admin: ["users.write", "money.write", "shops.write", "ai.write"],
  support: ["users.write"],
  readonly: [],
  data_admin: ["data.write", "data.trigger", "ai.write"],
  shop_success: ["shops.write"],
};

export function roleHasCapability(role: DirectorRole, capability: Capability): boolean {
  return (CAPABILITIES[role] ?? []).includes(capability);
}

export type DirectorActor = {
  name: string;
  userId: Id<"director_users">;
  role: DirectorRole;
};

/** Validate the director session and return the audit actor. Throws on a
 *  missing/expired session, and on a missing capability when one is given. */
export async function requireDirector(
  ctx: QueryCtx | MutationCtx,
  token: string,
  capability?: Capability,
): Promise<DirectorActor> {
  if (token) {
    const s = await ctx.db
      .query("director_sessions")
      .withIndex("by_token", (q) => q.eq("token", token))
      .first();
    if (s && s.expires_at >= Date.now()) {
      const u = await ctx.db.get(s.user_id);
      if (u) {
        const role = u.role as DirectorRole;
        if (capability && !roleHasCapability(role, capability)) {
          throw new Error(`forbidden: role '${role}' lacks capability '${capability}'`);
        }
        return { name: u.name, userId: u._id, role };
      }
    }
  }
  throw new Error("unauthorized: invalid or expired director session");
}

/** Insert the standard audit row for a portal/panel write. Call inside the
 *  same mutation as the write so the two are atomic. */
export async function logAudit(
  ctx: MutationCtx,
  actor: Pick<DirectorActor, "name" | "userId">,
  entry: { entity_type: string; entity_id: string; action: string; detail?: string },
): Promise<void> {
  await ctx.db.insert("audit_log", {
    entity_type: entry.entity_type,
    entity_id: entry.entity_id,
    action: entry.action,
    actor: actor.name,
    actor_id: actor.userId,
    detail: entry.detail,
    created_at: Date.now(),
  });
}
