/**
 * onboarding_questions_answers - Store user onboarding Q&A as JSON
 *
 * Single table per user: questions_and_answers is an array of { question, answer }
 * for the data intelligence track.
 */

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const saveQuestionAnswer = mutation({
  args: {
    question: v.string(),
    answer: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const clerkUserId = identity.subject;
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", clerkUserId))
      .unique();

    if (!user) {
      throw new Error("User not found");
    }

    const existing = await ctx.db
      .query("onboarding_questions_answers")
      .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
      .unique();

    const newEntry = { question: args.question, answer: args.answer };
    const now = Date.now();

    if (existing) {
      const qa = existing.questions_and_answers.filter(
        (e) => e.question !== args.question
      );
      qa.push(newEntry);
      await ctx.db.patch(existing._id, {
        questions_and_answers: qa,
        last_updated: now,
      });
      return existing._id;
    }

    return await ctx.db.insert("onboarding_questions_answers", {
      user_id: user._id,
      questions_and_answers: [newEntry],
      last_updated: now,
    });
  },
});

export const saveCarKnowledgeLevel = mutation({
  args: {
    level: v.number(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const clerkUserId = identity.subject;
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", clerkUserId))
      .unique();

    if (!user) {
      throw new Error("User not found");
    }

    const existing = await ctx.db
      .query("onboarding_questions_answers")
      .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
      .unique();

    const now = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        car_knowledge_level: args.level,
        last_updated: now,
      });
      return existing._id;
    }

    return await ctx.db.insert("onboarding_questions_answers", {
      user_id: user._id,
      questions_and_answers: [],
      car_knowledge_level: args.level,
      last_updated: now,
    });
  },
});

export const saveUserIntentions = mutation({
  args: {
    question: v.string(),
    intentions: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const clerkUserId = identity.subject;
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", clerkUserId))
      .unique();

    if (!user) {
      throw new Error("User not found");
    }

    const existing = await ctx.db
      .query("onboarding_questions_answers")
      .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
      .unique();

    const now = Date.now();
    const user_intentions = { question: args.question, intentions: args.intentions };

    if (existing) {
      await ctx.db.patch(existing._id, {
        user_intentions,
        last_updated: now,
      });
      return existing._id;
    }

    return await ctx.db.insert("onboarding_questions_answers", {
      user_id: user._id,
      questions_and_answers: [],
      user_intentions,
      last_updated: now,
    });
  },
});

export const getMyQuestionsAndAnswers = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const clerkUserId = identity.subject;
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", clerkUserId))
      .unique();

    if (!user) return null;

    return await ctx.db
      .query("onboarding_questions_answers")
      .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
      .unique();
  },
});
