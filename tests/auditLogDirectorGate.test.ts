/**
 * Review fix from the Jun-10 IDOR sweep verification: audit_log was still
 * world-readable. Rows carry director names/ids for every review action and
 * the failed-login rows embed raw director email addresses — anyone with
 * the deployment URL could harvest them and read the full review trail.
 *
 * Contract: listByEntity / listRecent validate a director session token
 * server-side (shared requireDirector in convex/directorGate.ts).
 */
import { describe, test, expect } from "vitest";
import { api } from "../convex/_generated/api";
import { makeT } from "./helpers";

const HOUR = 60 * 60 * 1000;
const VALID_TOKEN = "tok_valid_0123456789abcdef";
const EXPIRED_TOKEN = "tok_expired_0123456789abcd";

async function seedAuditWorld(t: ReturnType<typeof makeT>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const directorId = await ctx.db.insert("director_users", {
      name: "Real Director",
      role: "super_admin",
      totp_secret: "JBSWY3DPEHPK3PXP",
      created_at: now,
    });
    await ctx.db.insert("director_sessions", {
      user_id: directorId,
      token: VALID_TOKEN,
      created_at: now,
      expires_at: now + 12 * HOUR,
    });
    await ctx.db.insert("director_sessions", {
      user_id: directorId,
      token: EXPIRED_TOKEN,
      created_at: now - 24 * HOUR,
      expires_at: now - 12 * HOUR,
    });
    await ctx.db.insert("audit_log", {
      entity_type: "oto_feedback",
      entity_id: "fb_test_1",
      action: "status_change",
      actor: "Real Director",
      actor_id: directorId,
      detail: "new → reviewed",
      created_at: now,
    });
    return { directorId };
  });
}

describe("audit_log director token gate", () => {
  test("listByEntity rejects invalid and expired tokens", async () => {
    const t = makeT();
    await seedAuditWorld(t);

    await expect(
      t.query(api.audit_log.listByEntity, {
        entity_type: "oto_feedback",
        entity_id: "fb_test_1",
        token: "bogus",
      } as any),
    ).rejects.toThrow(/unauthorized/);

    await expect(
      t.query(api.audit_log.listByEntity, {
        entity_type: "oto_feedback",
        entity_id: "fb_test_1",
        token: EXPIRED_TOKEN,
      } as any),
    ).rejects.toThrow(/unauthorized/);
  });

  test("listRecent rejects an invalid token", async () => {
    const t = makeT();
    await seedAuditWorld(t);
    await expect(
      t.query(api.audit_log.listRecent, { token: "bogus" } as any),
    ).rejects.toThrow(/unauthorized/);
  });

  test("valid token reads the trail", async () => {
    const t = makeT();
    await seedAuditWorld(t);

    const rows = await t.query(api.audit_log.listByEntity, {
      entity_type: "oto_feedback",
      entity_id: "fb_test_1",
      token: VALID_TOKEN,
    } as any);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe("Real Director");

    const recent = await t.query(api.audit_log.listRecent, {
      token: VALID_TOKEN,
    } as any);
    expect(recent).toHaveLength(1);
  });
});
