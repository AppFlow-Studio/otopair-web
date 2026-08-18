/**
 * evalJudge.ts — DEV ONLY, not part of any product surface.
 *
 * LLM judge for the behavioral eval runner (scripts/eval/behavioral_runner.mjs).
 * Pass H diagnosed a class of golden-case failures as ASSERTION-TOO-NARROW:
 * text_contains literals like "book"/"oil"/"icon" fail on responses that are
 * behaviorally correct but phrased differently. A substring can't express
 * "acknowledges the request and points at the right screen" — a judge can.
 *
 * Contract (mirrors the case JSON's `text_judge` field):
 *   judge({ criteria, text }) → { pass: boolean, reason: string }
 *
 * The judge model gets ONLY the assistant text and the criteria — no
 * conversation history — so criteria must be self-contained. Temperature 0,
 * forced verdict-first output, tiny max_tokens. Uses the same deployment
 * ANTHROPIC_API_KEY as the chat loop.
 */
import { v } from "convex/values";
import { internalAction } from "../_generated/server";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const JUDGE_MODEL = "claude-haiku-4-5-20251001";

export const judge = internalAction({
  args: { criteria: v.string(), text: v.string() },
  handler: async (_ctx, args): Promise<{ pass: boolean; reason: string }> => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY env var not set");

    const resp = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: JUDGE_MODEL,
        max_tokens: 150,
        temperature: 0,
        system:
          "You are a strict QA judge for a car-service chat assistant. You are given a CRITERIA " +
          "and the assistant's RESPONSE TEXT. Decide whether the response satisfies the criteria. " +
          "Judge the behavior described by the criteria, not phrasing — synonyms and different " +
          "wording that accomplish the same thing PASS. Missing behavior, contradicting behavior, " +
          "or content the criteria forbids FAILS. Output EXACTLY one line: 'PASS: <short reason>' " +
          "or 'FAIL: <short reason>'. No other text.",
        messages: [
          {
            role: "user",
            content: `CRITERIA:\n${args.criteria}\n\nRESPONSE TEXT:\n${args.text || "(empty response)"}`,
          },
        ],
      }),
    });
    if (!resp.ok) {
      throw new Error(`anthropic judge call failed: ${resp.status} ${await resp.text()}`);
    }
    const data = (await resp.json()) as {
      content?: { type: string; text?: string }[];
    };
    const out = (data.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
      .trim();
    const pass = /^PASS\b/i.test(out);
    if (!pass && !/^FAIL\b/i.test(out)) {
      // Malformed verdict — surface loudly rather than silently failing the case.
      throw new Error(`judge returned malformed verdict: ${out.slice(0, 200)}`);
    }
    return { pass, reason: out.replace(/^(PASS|FAIL):\s*/i, "").slice(0, 300) };
  },
});
