/**
 * The Oto improvement loop.
 *
 *   npm run oto:loop            both halves, diffed against the last run
 *   npm run oto:loop -- --sim   agent only
 *   npm run oto:loop -- --ui    screen only
 *   npm run oto:loop -- --baseline   record without judging it a regression
 *   npm run oto:loop -- --repeat 3   run each persona 3x (agent output varies)
 *
 * Every run is written to docs/oto/runs and compared against the previous one.
 * A criterion whose pass rate drops, a newly-violated absolute, a tool
 * assertion that starts failing, or a new UI contract finding all exit non-zero
 * — that is what makes this a loop and not a report.
 */

import {
  AGENT_ID,
  credits,
  latestRun,
  saveRun,
  delta,
  bar,
  stamp,
  fixture,
} from "./lib.mjs";
import { runSim } from "./sim.mjs";
import { runUi } from "./ui.mjs";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (f, d) => {
  const i = argv.indexOf(f);
  return i === -1 ? d : argv[i + 1];
};

const doSim = has("--sim") || !has("--ui");
const doUi = has("--ui") || !has("--sim");
const isBaseline = has("--baseline");
const repeat = Number(arg("--repeat", 1));

const now = new Date();
const runStamp = stamp(now);

console.log("Oto improvement loop");
console.log(`  agent   ${AGENT_ID ?? "(none configured)"}`);
console.log(`  halves  ${[doSim && "agent", doUi && "screen"].filter(Boolean).join(" + ")}`);
console.log(`  run     ${runStamp}${isBaseline ? "  (baseline)" : ""}\n`);

const run = { stamp: runStamp, at: now.toISOString(), agentId: AGENT_ID ?? null, repeat };

/* ---------------- agent half ---------------- */
if (doSim) {
  console.log("── agent ──");
  // Spending check before spending. An exhausted allowance does not just fail
  // the run — it takes the live site's agent down with it.
  const c = await credits();
  if (c) {
    run.credits = c;
    const personaCount = fixture("personas.json").personas.length;
    console.log(
      `  plan ${c.tier} · ${c.remaining.toLocaleString()} of ${c.limit.toLocaleString()} characters left` +
        (c.resets ? ` · resets ${c.resets}` : "")
    );
    console.log(`  this run: ${personaCount} personas x ${repeat} = ${personaCount * repeat} multi-turn conversations`);
    if (c.remaining === 0) {
      console.log("\n  ✖ NO CREDITS LEFT. Skipping the agent half.");
      console.log("    While the allowance is exhausted the live site cannot reach the agent");
      console.log("    either — it falls back to the scripted demo with no sign to the visitor.");
      run.sim = { skipped: true, reason: "no credits" };
    } else if (c.remaining < 2000) {
      console.log("\n  ⚠ Low balance. This run may exhaust it and take the live agent down.");
    }
  }
  if (!run.sim?.skipped) {
    try {
      run.sim = await runSim({ repeat });
    } catch (e) {
      console.log(`  agent half failed: ${String(e.message).slice(0, 200)}`);
      run.sim = { error: String(e.message).slice(0, 400) };
    }
  }
  console.log("");
}

/* ---------------- screen half ---------------- */
if (doUi) {
  console.log("── screen ──");
  try {
    run.ui = await runUi({ keepShots: has("--keep-shots") });
    if (!run.ui.skipped) {
      console.log(
        `  ${run.ui.checked}/${run.ui.cards} cards checked · ` +
          `${run.ui.findings.length} contract finding${run.ui.findings.length === 1 ? "" : "s"}` +
          (run.ui.heights ? ` · heights ${run.ui.heights.min}–${run.ui.heights.max}px` : "")
      );
    }
  } catch (e) {
    console.log(`  screen half failed: ${String(e.message).slice(0, 200)}`);
    run.ui = { error: String(e.message).slice(0, 400) };
  }
  console.log("");
}

/* ---------------- score it against last time ---------------- */
const prev = latestRun();
const regressions = [];

console.log("── scorecard ──");
if (prev) console.log(`  vs ${prev.data.stamp}\n`);
else console.log("  no previous run — this becomes the baseline\n");

if (run.sim?.byCriterion) {
  const groups = { funnel: "the job", helpfulness: "still useful", guardrail: "never do" };
  for (const g of Object.keys(groups)) {
    const entries = Object.entries(run.sim.byCriterion).filter(([, v]) => v.group === g);
    if (!entries.length) continue;
    console.log(`  ${groups[g]}`);
    for (const [id, v] of entries) {
      const was = prev?.data?.sim?.byCriterion?.[id];
      if (v.rate === null) {
        // Never judged in this run: the criterion did not apply anywhere.
        console.log(`    ${id.padEnd(20)} ${"·".repeat(12)}  n/a        (${v.unknown} not applicable)`);
        continue;
      }
      const d = delta(v.rate, was?.rate ?? null);
      console.log(
        `    ${id.padEnd(20)} ${bar(v.pass, v.of)} ${String(v.pass).padStart(2)}/${v.of}` +
          ` ${String(v.rate).padStart(3)}% ${d}` +
          (v.unknown ? `   (${v.unknown} n/a)` : "")
      );
      // At repeat=1 a single persona flipping moves a 10-item rate by 10-20
      // points, so a judged-criterion delta is not attributable — one run is a
      // sample of one. ElevenLabs' own testing guidance says the same thing and
      // offers repeat_count 2-20 for exactly this. Absolutes and tool
      // assertions are still counted below: those are literal matches, not
      // judgements, and a copy lock violated once is violated.
      if (was && was.rate !== null && v.rate < was.rate && repeat >= 2) {
        regressions.push(`criterion ${id}: ${was.rate}% → ${v.rate}%`);
      }
    }
    console.log("");
  }

  const prevAbs = new Set((prev?.data?.sim?.absoluteHits ?? []).map((h) => h.id));
  if (run.sim.absoluteHits.length) {
    console.log("  ABSOLUTES VIOLATED");
    const seen = new Set();
    for (const h of run.sim.absoluteHits) {
      const key = `${h.id}:${h.persona}`;
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`    ${h.persona.padEnd(18)} ${h.desc}`);
      console.log(`      "${h.match}"`);
      if (!prevAbs.has(h.id)) regressions.push(`new absolute violated: ${h.id} (${h.persona})`);
    }
    console.log("");
  } else {
    console.log("  ABSOLUTES        all clear\n");
  }

  if (run.sim.toolFailures.length) {
    console.log("  TOOL ASSERTIONS");
    const prevTools = new Set((prev?.data?.sim?.toolFailures ?? []).map((f) => `${f.persona}:${f.kind}:${f.tool}`));
    for (const f of run.sim.toolFailures) {
      console.log(`    ${f.persona.padEnd(18)} ${f.kind === "missing" ? "never called" : "called but forbidden"}: ${f.tool}`);
      const key = `${f.persona}:${f.kind}:${f.tool}`;
      if (!prevTools.has(key)) regressions.push(`new tool failure: ${f.persona} ${f.kind} ${f.tool}`);
    }
    console.log("");
  }
}

if (run.ui && !run.ui.skipped && !run.ui.error) {
  const prevByRule = prev?.data?.ui?.byRule ?? {};
  const rules = new Set([...Object.keys(run.ui.byRule), ...Object.keys(prevByRule)]);
  console.log("  screen contract");
  if (!rules.size) console.log("    every card holds the contract");
  for (const r of [...rules].sort()) {
    const nowN = run.ui.byRule[r] ?? 0;
    const wasN = prevByRule[r];
    console.log(`    ${r.padEnd(20)} ${String(nowN).padStart(3)} breach${nowN === 1 ? "" : "es"} ${delta(nowN, wasN)}`);
    if (wasN !== undefined && nowN > wasN) regressions.push(`ui ${r}: ${wasN} → ${nowN} breaches`);
    if (wasN === undefined && nowN > 0 && prev) regressions.push(`ui ${r}: ${nowN} new breaches`);
  }
  console.log("");
  if (run.ui.findings.length) {
    console.log("  worst first");
    const order = ["holds_selection", "renders", "no_silent_clip", "has_title", "has_icon", "title_size", "fills_panel"];
    [...run.ui.findings]
      .sort((a, b) => order.indexOf(a.rule) - order.indexOf(b.rule))
      .slice(0, 12)
      .forEach((f) => console.log(`    ${f.rule.padEnd(16)} ${f.card.padEnd(20)} ${f.detail}`));
    if (run.ui.findings.length > 12) console.log(`    … and ${run.ui.findings.length - 12} more (full list in the run file)`);
    console.log("");
  }
}

/* ---------------- what to do next ---------------- */
console.log("── next ──");
const todo = [];
if (run.sim?.absoluteHits?.length) {
  todo.push(`Fix ${new Set(run.sim.absoluteHits.map((h) => h.id)).size} absolute violation(s) — these are copy locks, not preferences.`);
}
if (run.sim?.byCriterion) {
  const worst = Object.entries(run.sim.byCriterion)
    .filter(([, v]) => v.group === "funnel" && v.rate !== null)
    .sort((a, b) => a[1].rate - b[1].rate)[0];
  if (worst && worst[1].rate < 80) {
    todo.push(`Weakest funnel rung: ${worst[0]} at ${worst[1].rate}%. The prompt is where this moves.`);
  }
}
if (run.ui && !run.ui.skipped && run.ui.findings?.length) {
  const top = Object.entries(run.ui.byRule).sort((a, b) => b[1] - a[1])[0];
  todo.push(`Screen: ${top[1]} card(s) breach "${top[0]}".`);
}
if (!todo.length) todo.push("Nothing failing. Add a persona for whatever surprised you in a real conversation.");
todo.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));

const file = saveRun(run, runStamp);
console.log(`\nrun saved  docs/oto/runs/${file}`);

if (regressions.length && !isBaseline) {
  console.log("\nREGRESSIONS vs the last run:");
  regressions.forEach((r) => console.log(`  · ${r}`));
  process.exit(1);
}
if (isBaseline) console.log("\nbaseline recorded — the next run is judged against it");
