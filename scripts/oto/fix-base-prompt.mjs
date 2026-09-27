/**
 * Surgical repair of the ONE clause in the live agent's base prompt that names
 * the platform-fee rate.
 *
 *   node scripts/oto/fix-base-prompt.mjs            # dry run, prints the diff
 *   node scripts/oto/fix-base-prompt.mjs --apply    # writes it
 *
 * Why this is its own script rather than part of setup-oto-agent.mjs: that
 * script owns only the text between its <<<OTOPAIR_GUIDANCE>>> markers and
 * deliberately preserves everything else. The fee rate sits OUTSIDE those
 * markers, in the Guardrails block, which was authored in the ElevenLabs
 * dashboard. It reached 7 real conversations and 4 of 10 simulated personas
 * ("seven percent") months after the same number was scrubbed from the site.
 *
 * The change is one clause. Everything else in the prompt is preserved
 * byte-for-byte, the prior prompt is written to disk first, and --apply is
 * required, because this agent is serving real visitors right now.
 *
 * Longer term this belongs in the repo entirely (the whole prompt, diffable,
 * one writer). This is the stop-the-bleeding step, not that.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { AGENT_ID, el, ROOT } from "./lib.mjs";

const APPLY = process.argv.includes("--apply");

// The clause, verbatim as it stands live, and its replacement. Naming both in
// full means this script can never half-match something it did not intend to.
const FROM =
  "explain HOW pricing works (every charge itemized, including the 7% platform fee, locked when the booking is confirmed)";
const TO =
  "explain HOW pricing works (every charge itemized, and the total locked when the booking is confirmed)";

const agent = await el(`/v1/convai/agents/${AGENT_ID}`);
const promptCfg = agent?.conversation_config?.agent?.prompt ?? {};
const before = promptCfg.prompt ?? "";

const dir = join(ROOT, "docs", "oto");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "prompt-before-fee-scrub.txt"), before);

if (!before.includes(FROM)) {
  const stillLeaks = /\b\d{1,2}\s?%\s*(platform|service)?\s*fee|seven percent/i.exec(before);
  if (stillLeaks) {
    console.log("The exact clause is not present, but the prompt STILL names a fee rate:");
    console.log(`  "${stillLeaks[0]}"`);
    console.log("Someone has edited this text. Re-read it and update FROM/TO before running again.");
    process.exit(1);
  }
  console.log("Nothing to do — the base prompt no longer names a fee rate.");
  process.exit(0);
}

const after = before.split(FROM).join(TO);

console.log(`Agent: ${AGENT_ID}`);
console.log(`Prompt: ${before.length} chars -> ${after.length} chars (one clause)\n`);
console.log("- " + FROM);
console.log("+ " + TO + "\n");
console.log(`Prior prompt saved to docs/oto/prompt-before-fee-scrub.txt`);

if (!APPLY) {
  console.log("\nDry run. Nothing written. Re-run with --apply to write it.");
  process.exit(0);
}

await el(`/v1/convai/agents/${AGENT_ID}`, {
  method: "PATCH",
  body: JSON.stringify({
    conversation_config: { agent: { prompt: { prompt: after } } },
  }),
});

const check = await el(`/v1/convai/agents/${AGENT_ID}`);
const live = check?.conversation_config?.agent?.prompt?.prompt ?? "";
const leaks = /\b\d{1,2}\s?%\s*(platform|service)?\s*fee|seven percent/i.test(live);
console.log(`\nWritten. Live prompt is now ${live.length} chars.`);
console.log(leaks ? "  ✖ a fee rate is STILL present — inspect it" : "  ✓ no fee rate remains in the base prompt");
console.log("\nRun `npm run oto:loop -- --sim` to confirm the absolutes come back clean.");
