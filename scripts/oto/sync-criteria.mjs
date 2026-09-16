/**
 * Push fixtures/criteria.json onto the live agent's post-call analysis, so a
 * simulated score and a production score mean the same thing.
 *
 *   node scripts/oto/sync-criteria.mjs           # dry run, prints the diff
 *   node scripts/oto/sync-criteria.mjs --apply   # writes it
 *
 * This changes what is MEASURED, never what the agent says — it cannot affect
 * a visitor's experience. What it fixes is the dashboard, which currently
 * reports 0% success on 305 real conversations because one criterion
 * ("App Mentioned Naturally", at most once) is failed by the agent's own
 * mandatory greeting on turn one. A scoreboard that always reads failure is
 * the same as no scoreboard, and it is why none of the real problems were
 * visible.
 *
 * The funnel criteria are added here too, because production is where they
 * actually matter: the simulation says what Oto does under a scripted
 * visitor, this says what it does with real ones.
 */

import { AGENT_ID, el, fixture } from "./lib.mjs";

const APPLY = process.argv.includes("--apply");
const { criteria } = fixture("criteria.json");

// Extra data points, so the funnel is legible per-conversation and not only in
// aggregate. `vin_provided` already exists; an email equivalent never did,
// which is part of why nobody noticed save_presignup had fired zero times.
const DATA_POINTS = {
  email_captured: {
    type: "boolean",
    description:
      "Whether the assistant obtained the visitor's email address so their car and request could be saved for the app.",
  },
  vehicle_identified: {
    type: "boolean",
    description:
      "Whether the assistant established the visitor's specific vehicle, by VIN or by year/make/model.",
  },
  app_handoff_offered: {
    type: "boolean",
    description:
      "Whether the assistant gave a concrete reason to continue in the Otopair app — that their car or request would be waiting there.",
  },
};

const agent = await el(`/v1/convai/agents/${AGENT_ID}`);
const live = agent?.platform_settings?.evaluation?.criteria ?? [];
const liveData = agent?.platform_settings?.data_collection ?? {};

const next = criteria.map((c) => ({
  id: c.id,
  name: c.id,
  type: "prompt",
  conversation_goal_prompt: c.goal,
  use_knowledge_base: false,
}));

const liveIds = new Set(live.map((c) => c.id));
const nextIds = new Set(next.map((c) => c.id));

console.log(`Agent: ${AGENT_ID}\n`);
console.log("evaluation criteria");
for (const c of live) {
  if (!nextIds.has(c.id)) console.log(`  - ${c.id}   REMOVED`);
}
for (const c of next) {
  console.log(`  ${liveIds.has(c.id) ? "~" : "+"} ${c.id}${liveIds.has(c.id) ? "   (prompt refreshed)" : "   NEW"}`);
}

console.log("\ndata collection");
for (const k of Object.keys(DATA_POINTS)) {
  console.log(`  ${liveData[k] ? "~" : "+"} ${k}${liveData[k] ? "" : "   NEW"}`);
}
for (const k of Object.keys(liveData)) {
  if (!DATA_POINTS[k]) console.log(`  = ${k}   (kept)`);
}

if (!APPLY) {
  console.log("\nDry run. Nothing written. Re-run with --apply to write it.");
  process.exit(0);
}

await el(`/v1/convai/agents/${AGENT_ID}`, {
  method: "PATCH",
  body: JSON.stringify({
    platform_settings: {
      evaluation: { criteria: next },
      // Merge rather than replace: the existing points (driver_concern_type,
      // issue_summary, ...) are useful and someone else may rely on them.
      data_collection: { ...liveData, ...DATA_POINTS },
    },
  }),
});

const check = await el(`/v1/convai/agents/${AGENT_ID}`);
const now = check?.platform_settings?.evaluation?.criteria ?? [];
const nowData = Object.keys(check?.platform_settings?.data_collection ?? {});
console.log(`\nWritten. ${now.length} criteria, ${nowData.length} data points.`);
console.log(`  criteria: ${now.map((c) => c.id).join(", ")}`);
console.log("\nNew conversations are scored against these. Past ones keep their old scores.");
