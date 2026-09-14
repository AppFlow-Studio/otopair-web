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
 */

import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";

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

// The agent's scripted opening line — not part of any answer.
const GREETING = /^Hi, I'?m Oto from Otopair/i;
const REPLY_TIMEOUT_MS = 60_000;
const SETTLE_MS = 5_000;

const browser = await chromium.launch();
const results = [];
let next = 0;

async function ask(q) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  let credentialStatus = null;
  page.on("response", (r) => {
    if (r.url().includes("/api/elevenlabs/signed-url")) credentialStatus = r.status();
  });
  const started = Date.now();
  try {
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.waitForLoadState("load").catch(() => {});
    await page.waitForTimeout(1500);

    const input = page.locator('input[aria-label="Message Oto"]:visible, textarea[aria-label="Message Oto"]:visible').first();
    await input.click();
    await input.fill(q.question);
    await page.getByRole("button", { name: "Send" }).first().click();

    // Read Oto's bubbles in the desktop chat panel until the answer stops changing.
    let answer = "";
    let stableSince = 0;
    while (Date.now() - started < REPLY_TIMEOUT_MS) {
      await page.waitForTimeout(1000);
      const bubbles = await page.evaluate(() =>
        [...document.querySelectorAll(".lg\\:order-1 div.flex.justify-start > p")]
          .map((p) => p.textContent.trim())
          .filter(Boolean)
      );
      const current = bubbles.filter((t) => !GREETING.test(t)).join("\n");
      if (current && current === answer) {
        stableSince ||= Date.now();
        if (Date.now() - stableSince >= SETTLE_MS) break;
      } else {
        stableSince = 0;
        answer = current;
      }
    }

    const card = await page
      .locator(".order-3 div.rounded-\\[20px\\] h3")
      .first()
      .textContent({ timeout: 1500 })
      .catch(() => null);
    const lower = answer.toLowerCase();
    const violations = (q.must_not_say ?? []).filter((p) => p && lower.includes(String(p).toLowerCase()));
    // The same paragraph shown twice in a row (a repeated agent reply).
    const answerBubbles = answer.split("\n");
    const repeated = answerBubbles.some((b, i) => i > 0 && b && answerBubbles[i - 1] && b.startsWith(answerBubbles[i - 1]));

    return {
      set: q.set,
      source: q.source,
      question: q.question,
      expected: q.expected,
      answer,
      card: card?.trim() ?? null,
      live: credentialStatus === 200,
      must_not_say_hits: violations,
      repeated_bubble: repeated,
      seconds: Math.round((Date.now() - started) / 1000),
    };
  } catch (e) {
    return { set: q.set, source: q.source, question: q.question, expected: q.expected, error: String(e.message ?? e).slice(0, 200) };
  } finally {
    await context.close();
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
