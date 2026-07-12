// One-shot migration: legacy director roles → the six portal roles
// (portal decision #2). Idempotent — rows already on a portal role are
// skipped. Run manually on dev:
//   npx convex run migrations/directorRoles:migrateLegacyRoles
// After every deployment has run it, narrow the schema validator to the six
// portal roles and drop LEGACY_ROLE_MAP.
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
