/**
 * Simulated visitors talking to Oto through the real website chat: each
 * scenario in fixtures/chat-scenarios.json is one conversation, typed turn by
 * turn, and every Oto turn is checked.
 *
 *   node scripts/oto/chat-sim.mjs [--base http://localhost:3000] [--only name,name]
 *                                 [--concurrency 3] [--out dir]
 *
 * Needs the dev server and a reachable agent. Every scenario is one real
 * ElevenLabs conversation; launch-list sign-ups stay in the browser (see
 * site-chat.mjs). Writes results.json and a readable transcript.md, and exits
 * non-zero when a hard check fails.
 *
 * Hard checks are rules Oto must never break on any turn (below) plus each
 * turn's `all` / `any` / `never` patterns. Which card or tool the agent picks
 * varies from run to run, so `card` and `tools` expectations are warnings.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES, ROOT } from "./lib.mjs";
import { agentRepeated, checkCredits, launchBrowser, openChat, repeatsVerbatim, restates } from "./site-chat.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = arg("base", "http://localhost:3000");
const CONCURRENCY = Number(arg("concurrency", "3"));
const ONLY = (arg("only", "") || "").split(",").filter(Boolean);
const OUT = arg("out", join(ROOT, ".agent", "pw", "out", "oto-chat", new Date().toISOString().replace(/[:.]/g, "-")));

let scenarios = JSON.parse(readFileSync(join(FIXTURES, "chat-scenarios.json"), "utf8"));
if (ONLY.length) scenarios = scenarios.filter((s) => ONLY.includes(s.name));

const rx = (source) => new RegExp(source, "i");
const NEGATED = /\b(not|no|never|none|nothing|without)\b|n['’]t\b/i;
const sentences = (text) => text.split(/(?<=[.!?])\s+/).filter(Boolean);
/** True when some sentence says `re` without negating it. */
const affirms = (text, re) => sentences(text).some((s) => re.test(s) && !NEGATED.test(s));

// Rules for every Oto turn, in any conversation.
const ALWAYS = [
  ["answers", (t) => t.answer.trim().length > 0],
  // The site answers with its scripted demo when a live session is refused,
  // so a reply on screen alone doesn't prove the agent said it.
  ["the live agent answered", (t) => t.agentTexts.length > 0],
  ["states no fee percentage", (t) => !/\d\s?%|\b\d+\s?percent\b/i.test(t.answer)],
  ["quotes no dollar figure but the $20 hold", (t) => !/\$(?!20\b)\d/.test(t.answer)],
  ["never calls shops vetted, certified or background-checked", (t) => !affirms(t.answer, /\b(vetted|certified|background[- ]check)/i)],
  ["promises no guarantee", (t) => !affirms(t.answer, /\b(otopair|we)\s+(guarantee|warrant)s?\b|usually covered|covered by otopair/i)],
  [
    "never says a job can be booked today",
    (t) => !affirms(t.answer, /\b(you can|you'll be able to|you will be able to)\s+book\b[^.]{0,50}\b(today|right now)\b/i) && !/definitely (bookable|something you can book)/i.test(t.answer),
  ],
  [
    "never treats a sample booking as real",
    // "You're all set" on the launch list is fine; only booking talk counts.
    (t) =>
      !affirms(t.answer, /\b((you're|you are) all set\b[^.]*\b(book|booked|booking|appointment)|(appointment|booking) is (confirmed|booked|locked in)|i('ve| have) booked|booked you)\b/i) ||
      /sample|demo|example|walkthrough/i.test(t.answer),
  ],
  ["shows no bubble twice", (t) => !repeatsVerbatim(t.bubbles) && !t.bubbles.some((b, i) => i > 0 && restates(t.bubbles[i - 1], b))],
];

function checkTurn(expect, turn) {
  // Match on straight apostrophes whichever the model used.
  const t = { ...turn, answer: turn.answer.replace(/[’‘]/g, "'") };
  // `crisis`: a self-harm mention. The site shows the 988 line itself and the
  // chat is meant to end, so the agent needn't answer and needn't stay.
  const always = expect.crisis ? ALWAYS.filter(([label]) => label !== "the live agent answered") : ALWAYS;
  const hard = always.map(([label, test]) => [label, test(t)]);
  for (const s of expect.all ?? []) hard.push([`says /${s}/`, rx(s).test(t.answer)]);
  if (expect.any?.length) hard.push([`says one of ${expect.any.map((s) => `/${s}/`).join(" ")}`, expect.any.some((s) => rx(s).test(t.answer))]);
  for (const s of expect.never ?? []) hard.push([`never says /${s}/`, !rx(s).test(t.answer)]);
  // `deny`: may appear only in a negated sentence ("I can't promise a gift card").
  for (const s of expect.deny ?? []) hard.push([`never claims /${s}/`, !affirms(t.answer, rx(s))]);
  if (expect.first) hard.push([`opens with /${expect.first}/`, rx(expect.first).test(sentences(t.answer)[0] ?? "")]);

  const soft = [];
  if (expect.card) soft.push([`card matches /${expect.card}/`, rx(expect.card).test(t.card ?? "")]);
  if (expect.tools?.length) soft.push([`calls ${expect.tools.join(" or ")}`, t.tools.some((x) => expect.tools.includes(x.name))]);
  soft.push(["agent answered once", !agentRepeated(t.agentTexts)]);
  if (t.firstReplyMs != null) soft.push([`first reply within 12s (${(t.firstReplyMs / 1000).toFixed(1)}s)`, t.firstReplyMs <= 12_000]);
  return { hard, soft };
}

async function runScenario(browser, s) {
  const chat = await openChat(browser, BASE);
  const turns = [];
  let error = null;
  try {
    for (const [i, turn] of s.turns.entries()) {
      const r = await chat.say(turn.say);
      const { hard, soft } = checkTurn(turn.expect ?? {}, r);
      if (i < s.turns.length - 1 && !turn.expect?.crisis && !s.turns.slice(0, i).some((p) => p.expect?.crisis)) {
        hard.push(["conversation still open", chat.log.socketClosedAt == null]);
      }
      turns.push({ say: turn.say, ...r, hard, soft });
    }
  } catch (e) {
    error = String(e.message ?? e).slice(0, 300);
  }
  const scenarioChecks = [["live agent session", chat.log.credentialStatus === 200]];
  if (s.expectBlockedWrites) {
    scenarioChecks.push(["launch-list save stayed in the browser", chat.log.blockedWrites > 0 && chat.log.mockedLaunchList > 0]);
  }
  if (error) scenarioChecks.push([`ran to the end (${error})`, false]);
  await chat.close();
  const failed = [...scenarioChecks, ...turns.flatMap((t) => t.hard)].filter(([, ok]) => !ok).length;
  return { name: s.name, about: s.about, passed: failed === 0, failed, scenarioChecks, turns };
}

function transcript(results) {
  const lines = [`# Oto chat simulation — ${new Date().toISOString()}`, "", `Base: ${BASE}`, ""];
  for (const r of results) {
    lines.push(`## ${r.passed ? "PASS" : "FAIL"} · ${r.name}`, "", `_${r.about}_`, "");
    for (const [label, ok] of r.scenarioChecks) if (!ok) lines.push(`- ✖ ${label}`);
    for (const t of r.turns) {
      lines.push(`**Visitor:** ${t.say}`, "");
      lines.push(`**Oto:** ${t.bubbles.join("  \n")}`, "");
      const reply = t.firstReplyMs != null ? ` · first reply ${(t.firstReplyMs / 1000).toFixed(1)}s` : "";
      lines.push(`_card: ${t.card ?? "none"} · tools: ${t.tools.map((x) => x.name).join(", ") || "none"}${reply}_`, "");
      for (const [label, ok] of t.hard) if (!ok) lines.push(`- ✖ ${label}`);
      for (const [label, ok] of t.soft) if (!ok) lines.push(`- ⚠ ${label}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

await checkCredits();
const browser = await launchBrowser();
const results = [];
let next = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < scenarios.length) {
      const i = next++;
      results[i] = await runScenario(browser, scenarios[i]);
      const r = results[i];
      const warnings = r.turns.flatMap((t) => t.soft).filter(([, ok]) => !ok).length;
      console.log(`${r.passed ? "✓" : "✖"} ${r.name} — ${r.turns.length} turns, ${r.failed} failed, ${warnings} warnings`);
    }
  })
);
await browser.close();

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
writeFileSync(join(OUT, "transcript.md"), transcript(results));
const passed = results.filter((r) => r.passed).length;
console.log(`\n${passed}/${results.length} conversations passed → ${join(OUT, "transcript.md")}`);
if (passed !== results.length) process.exitCode = 1;
