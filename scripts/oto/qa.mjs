/**
 * Ask Oto questions through the real website chat and record what it says and
 * shows — the live check that the site's marketing agent answers the way the
 * website does.
 *
 *   node scripts/oto/qa.mjs --questions a.json[,b.json] --out results.json
 *                           [--base http://localhost:3000] [--concurrency 3] [--only 5]
 *
 * Questions: [{ "question", "expected", "source", "must_not_say": [] }]
 * Each question runs in a fresh browser context, so a fresh conversation.
 * Needs the dev server and a reachable agent (the private signed-url route or a
 * public agent id). Every question is one real ElevenLabs conversation.
 * Multi-turn conversations live in chat-sim.mjs; both drive the page through
 * site-chat.mjs, which keeps launch-list sign-ups from leaving the browser.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { agentRepeated, checkCredits, launchBrowser, openChat, repeatsVerbatim } from "./site-chat.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = arg("base", "http://localhost:3000");
const OUT = arg("out", null);
const CONCURRENCY = Number(arg("concurrency", "3"));
const ONLY = Number(arg("only", "0"));
const files = (arg("questions", "") || "").split(",").filter(Boolean);
if (!OUT || !files.length) {
  console.error("usage: node scripts/oto/qa.mjs --questions a.json[,b.json] --out results.json");
  process.exit(1);
}

let questions = files.flatMap((f) =>
  JSON.parse(readFileSync(f, "utf8")).map((q) => ({ ...q, set: f.replace(/^.*[\\/]/, "").replace(/\.json$/, "") }))
);
if (ONLY > 0) questions = questions.slice(0, ONLY);

await checkCredits();
const browser = await launchBrowser();
const results = [];
let next = 0;

async function ask(q) {
  let chat = null;
  try {
    chat = await openChat(browser, BASE);
    const turn = await chat.say(q.question);
    const lower = turn.answer.toLowerCase();
    return {
      set: q.set,
      source: q.source,
      question: q.question,
      expected: q.expected,
      answer: turn.answer,
      card: turn.card,
      tools: turn.tools.map((t) => t.name),
      // A session credential AND words from the agent: a refused session still
      // gets a 200 from the route, then the site's scripted demo answers.
      live: chat.log.credentialStatus === 200 && turn.agentTexts.length > 0,
      must_not_say_hits: (q.must_not_say ?? []).filter((p) => p && lower.includes(String(p).toLowerCase())),
      // On screen: the same paragraph shown twice in a row.
      repeated_bubble: repeatsVerbatim(turn.bubbles),
      // From the socket: the agent itself said the same thing twice this turn
      // (the chat merges these, so they no longer show on screen).
      agent_repeated: agentRepeated(turn.agentTexts),
      first_reply_ms: turn.firstReplyMs,
      first_tool_ms: turn.firstToolMs,
      seconds: turn.seconds,
    };
  } catch (e) {
    return { set: q.set, source: q.source, question: q.question, expected: q.expected, error: String(e.message ?? e).slice(0, 200) };
  } finally {
    await chat?.close();
  }
}

async function worker() {
  while (next < questions.length) {
    const i = next++;
    const r = await ask(questions[i]);
    results[i] = r;
    const flag = r.error ? "✖ error" : !r.live ? "✖ not live" : r.must_not_say_hits.length ? "✖ said forbidden" : r.answer ? "·" : "✖ no answer";
    console.log(`${flag} [${r.set}] ${r.question}${r.card ? `  → card: ${r.card}` : ""}`);
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await browser.close();
writeFileSync(OUT, JSON.stringify(results, null, 2));
const bad = results.filter((r) => r.error || !r.live || !r.answer || r.must_not_say_hits?.length).length;
console.log(`\n${results.length - bad}/${results.length} answered live without forbidden phrases → ${OUT}`);
