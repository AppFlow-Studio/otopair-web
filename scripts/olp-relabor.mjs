// Backfill OLP labor observations over all enriched configs.
// Usage: node scripts/olp-relabor.mjs [--limit N]
import { execFileSync } from "node:child_process";
const LIMIT = (() => { const i = process.argv.indexOf("--limit"); return i >= 0 ? Number(process.argv[i + 1]) : Infinity; })();
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";
const run = (fn, args) => {
  const argv = ["convex", "run", fn];
  if (args) { const raw = JSON.stringify(args); argv.push(process.platform === "win32" ? raw.replace(/"/g, '\\"') : raw); }
  return JSON.parse(execFileSync(NPX, argv, { encoding: "utf8", shell: process.platform === "win32", maxBuffer: 64 * 1024 * 1024 }));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { buildId } = run("vehicleEnrichment/olpLaborScrape:resolveBuildId");
if (!buildId) throw new Error("no OLP buildId");
console.log("buildId:", buildId);
const configs = run("devOnly/olpProbe:_listEnrichedConfigs").slice(0, LIMIT);
let ok = 0, wrote = 0;
for (const [i, c] of configs.entries()) {
  let r;
  try { r = run("vehicleEnrichment/olpRelabor:olpRelaborConfig", { vehicleConfigId: c.id, buildId }); }
  catch (e) { r = { resolved: false, error: String(e.message ?? e).slice(0, 200) }; }
  if (r.resolved) { ok++; wrote += r.written; }
  console.log(`[${i + 1}/${configs.length}] ${c.config_key} -> ${r.resolved ? `OK (${r.written} obs)` : "FAIL: " + r.error}`);
  await sleep(500);
}
console.log(`\nresolved ${ok}/${configs.length} configs, wrote ${wrote} olp_labor observations`);
