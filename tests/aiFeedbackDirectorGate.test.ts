/**
 * P1 IDOR sweep, part 3 — the ai_feedback director-panel surface.
 *
 * getConversationForFeedback was the worst PII leak in the review (full
 * transcript + email + phone for anyone with the deployment URL and a
 * feedback id); listByStatus dumped every user's name/email; updateStatus
 * and archive wrote audit_log rows with caller-supplied actorName/actorId
 * (forgeable attribution).
 *
 * Contract under test (mirrors tests/directorConfigActionsAuth.test.ts):
 * every director-facing function validates a director session token
 * SERVER-SIDE and derives the audit actor FROM the session. The caller-less
 * listRecent/openCount are internal. submit (the end-user write) stays
 * public and ctx.auth-gated.
 */
import { describe, test, expect } from "vitest";
import { api } from "../convex/_generated/api";
import { makeT } from "./helpers";

import * as aiFeedback from "../convex/ai_feedback";

const HOUR = 60 * 60 * 1000;
const VALID_TOKEN = "tok_valid_0123456789abcdef";
const EXPIRED_TOKEN = "tok_expired_0123456789abcd";

async function seedFeedbackWorld(t: ReturnType<typeof makeT>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const directorId = await ctx.db.insert("director_users", {
      name: "Real Director",
      role: "superadmin",
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

    const userId = await ctx.db.insert("users", {
      clerkUserId: `clerk_fb_${now}`,
      email: "fbuser@test.local",
      phone: "+15555550100",
      first_name: "Feedback",
      role: "user",
      createdAt: now,
    });
    const conversationId = await ctx.db.insert("ai_conversations", {
      user_id: userId,
      session_id: `sess_fb_${now}`,
      started_at: now,
      led_to_booking: false,
      message_count: 1,
    });
    await ctx.db.insert("ai_messages", {
      conversation_id: conversationId,
      role: "assistant",
      content: "Sounds like worn pads.",
      timestamp: now,
    });
    const feedbackId = await ctx.db.insert("ai_feedback", {
      user_id: userId,
      conversation_id: conversationId,
      rating: "thumbs_down",
      comment: "wrong diagnosis",
      message_content_snapshot: "Sounds like worn pads.",
      submitted_at: now,
    });
    return { directorId, userId, conversationId, feedbackId };
  });
}

describe("ai_feedback — registration visibility", () => {
  test("listRecent and openCount are internal (no panel callers)", () => {
    for (const name of ["listRecent", "openCount"] as const) {
      const fn = (aiFeedback as Record<string, unknown>)[name] as {
        isPublic?: boolean;
        isInternal?: boolean;
      };
      expect(fn.isPublic, `${name} must NOT be public`).not.toBe(true);
      expect(fn.isInternal, `${name} must be internal`).toBe(true);
    }
  });

  test("submit stays public (the end-user write path)", () => {
    const fn = (aiFeedback as Record<string, unknown>).submit as {
      isPublic?: boolean;
    };
    expect(fn.isPublic).toBe(true);
  });
});

describe("ai_feedback director token gate", () => {
  test("every director surface rejects an invalid token", async () => {
    const t = makeT();
    const seed = await seedFeedbackWorld(t);

    const calls: Array<[string, () => Promise<unknown>]> = [
      ["listByStatus", () =>
        t.query(api.ai_feedback.listByStatus, { token: "bogus" } as any)],
      ["getConversationForFeedback", () =>
        t.query(api.ai_feedback.getConversationForFeedback, {
          feedbackId: seed.feedbackId,
          token: "bogus",
        } as any)],
      ["updateStatus", () =>
        t.mutation(api.ai_feedback.updateStatus, {
          id: seed.feedbackId,
          status: "reviewed",
          token: "bogus",
        } as any)],
      ["archive", () =>
        t.mutation(api.ai_feedback.archive, {
          id: seed.feedbackId,
          archived: true,
          token: "bogus",
        } as any)],
    ];
    for (const [name, call] of calls) {
      await expect(call(), `${name} must reject an invalid token`).rejects.toThrow(
        /unauthorized/,
      );
    }

    // Nothing was written.
    const fb = await t.run(async (ctx) => ctx.db.get(seed.feedbackId));
    expect(fb!.review_status).toBeUndefined();
    expect(fb!.archived).toBeUndefined();
  });

  test("an expired session is rejected", async () => {
    const t = makeT();
    const seed = await seedFeedbackWorld(t);
    await expect(
      t.mutation(api.ai_feedback.updateStatus, {
        id: seed.feedbackId,
        status: "reviewed",
        token: EXPIRED_TOKEN,
      } as any),
    ).rejects.toThrow(/unauthorized/);
  });

  test("caller-supplied actorName is no longer an accepted argument", async () => {
    const t = makeT();
    const seed = await seedFeedbackWorld(t);
    await expect(
      t.mutation(api.ai_feedback.updateStatus, {
        id: seed.feedbackId,
        status: "reviewed",
        token: VALID_TOKEN,
        actorName: "Forged Admin",
      } as any),
    ).rejects.toThrow(); // unknown arg → validator error
  });

  test("valid token: updateStatus patches and stamps the SESSION actor on the audit row", async () => {
    const t = makeT();
    const seed = await seedFeedbackWorld(t);

    await t.mutation(api.ai_feedback.updateStatus, {
      id: seed.feedbackId,
      status: "actionable",
      token: VALID_TOKEN,
    } as any);

    const { fb, audit } = await t.run(async (ctx) => ({
      fb: await ctx.db.get(seed.feedbackId),
      audit: await ctx.db.query("audit_log").collect(),
    }));
    expect(fb!.review_status).toBe("actionable");
    expect(audit).toHaveLength(1);
    expect(audit[0].actor).toBe("Real Director");
    expect(audit[0].actor_id).toBe(seed.directorId);
    expect(audit[0].detail).toBe("new → actionable");
  });

  test("valid token: getConversationForFeedback returns the thread", async () => {
    const t = makeT();
    const seed = await seedFeedbackWorld(t);

    const detail = await t.query(api.ai_feedback.getConversationForFeedback, {
      feedbackId: seed.feedbackId,
      token: VALID_TOKEN,
    } as any);
    expect(detail).not.toBeNull();
    expect(detail!.messages).toHaveLength(1);
    expect(detail!.user?.email).toBe("fbuser@test.local");
  });

  test("valid token: listByStatus groups the feedback", async () => {
    const t = makeT();
    await seedFeedbackWorld(t);

    const grouped = await t.query(api.ai_feedback.listByStatus, {
      token: VALID_TOKEN,
    } as any);
    expect(grouped.new).toHaveLength(1);
    expect(grouped.new[0].userEmail).toBe("fbuser@test.local");
  });
});
