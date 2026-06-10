/**
 * B-P5 (OTO_HANDOFF.md): the un-isolated getCarKnowledgeLevelForUser read.
 *
 * The save mutations (saveCarKnowledgeLevel / saveUserIntentions) each
 * check-then-insert onboarding_questions_answers with no uniqueness
 * guarantee, so a race can leave a user with TWO rows. The chat envelope
 * reads the knowledge level every turn via getCarKnowledgeLevelForUser,
 * which used .unique() — and .unique() THROWS on more than one row, taking
 * down the entire Oto turn for that user. A read must degrade, not crash:
 * switched to .first().
 */
import { describe, test, expect } from "vitest";
import { api } from "../convex/_generated/api";
import { makeT } from "./helpers";

async function seedUser(t: ReturnType<typeof makeT>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("users", {
      clerkUserId: `clerk_onb_${now}`,
      email: "onb@test.local",
      first_name: "Onb",
      role: "user",
      createdAt: now,
    });
  });
}

describe("getCarKnowledgeLevelForUser", () => {
  test("returns null when the user has no onboarding row", async () => {
    const t = makeT();
    const userId = await seedUser(t);
    const level = await t.query(
      api.onboarding_questions_answers.getCarKnowledgeLevelForUser,
      { user_id: userId },
    );
    expect(level).toBeNull();
  });

  test("returns the level for a single row", async () => {
    const t = makeT();
    const userId = await seedUser(t);
    await t.run(async (ctx) =>
      ctx.db.insert("onboarding_questions_answers", {
        user_id: userId,
        questions_and_answers: [],
        car_knowledge_level: 2,
        last_updated: Date.now(),
      }),
    );
    const level = await t.query(
      api.onboarding_questions_answers.getCarKnowledgeLevelForUser,
      { user_id: userId },
    );
    expect(level).toBe(2);
  });

  test("DOES NOT THROW when the user has duplicate rows (the turn-outage bug)", async () => {
    const t = makeT();
    const userId = await seedUser(t);
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("onboarding_questions_answers", {
        user_id: userId,
        questions_and_answers: [],
        car_knowledge_level: 1,
        last_updated: now,
      });
      await ctx.db.insert("onboarding_questions_answers", {
        user_id: userId,
        questions_and_answers: [],
        car_knowledge_level: 3,
        last_updated: now + 1,
      });
    });

    // Previously threw "unique() query returned more than one result",
    // crashing the chat turn. Now returns a value (the first row).
    const level = await t.query(
      api.onboarding_questions_answers.getCarKnowledgeLevelForUser,
      { user_id: userId },
    );
    expect(level === 1 || level === 3).toBe(true);
  });
});
