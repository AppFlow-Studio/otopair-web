// One-shot migration: legacy director roles → the six portal roles
// (portal decision #2). Idempotent — rows already on a portal role are
// skipped. Run manually:
//   npx convex run migrations/directorRoles:migrateLegacyRoles
//
// NOTE (Jul 13): the schema validator has been narrowed to the six portal
// roles, so this schema will REFUSE to push to a deployment that still holds
// legacy-role rows ("superadmin"/"admin"/"viewer"). On such a deployment,
// run this migration from a pre-narrowing checkout (or patch the rows from
// the Convex dashboard) first, then push. third-bird-914 was migrated
// Jul 12 (2/2); the prod deployment has zero director_users.
import { internalMutation } from "../_generated/server";
import { LEGACY_ROLE_MAP } from "../directorGate";

export const migrateLegacyRoles = internalMutation({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("director_users").collect();
    let migrated = 0;
    for (const u of users) {
      const mapped = LEGACY_ROLE_MAP[u.role];
      if (mapped) {
        await ctx.db.patch(u._id, { role: mapped });
        await ctx.db.insert("audit_log", {
          entity_type: "director_user",
          entity_id: u._id,
          action: "role_migrated",
          actor: "system:directorRoles-migration",
          detail: `${u.role} -> ${mapped}`,
          created_at: Date.now(),
        });
        migrated++;
      }
    }
    return { total: users.length, migrated };
  },
});
