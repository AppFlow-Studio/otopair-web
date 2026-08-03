// OLP labor probe driver — loops all enriched configs through
// devOnly/olpProbe:probeConfig, writes proof/olp/raw/<config_key>.json and
// assembles proof/olp/SUMMARY.md. Read-only against Convex + OLP.
// Usage: node scripts/olp-probe.mjs [--limit N]
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const LIMIT = (() => {
  const i = process.argv.indexOf("--limit");
  return i >= 0 ? Number(process.argv[i + 1]) : Infinity;
})();

const NPX = process.platform === "win32" ? "npx.cmd" : "npx";
const run = (fn, argsJson) => {
  const argv = ["convex", "run", fn];
  if (argsJson) {
    // On Windows, shell:true passes args through cmd.exe which strips bare
    // double-quotes. Escape them so cmd.exe sees \" and passes them through.
    const raw = JSON.stringify(argsJson);
    argv.push(process.platform === "win32" ? raw.replace(/"/g, '\\"') : raw);
  }
  const out = execFileSync(NPX, argv, {
    encoding: "utf8",
    shell: process.platform === "win32", // npx.cmd needs a shell on win32
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const fmt = (x, d = 1) => (x == null ? "—" : Number(x).toFixed(d));

mkdirSync("proof/olp/raw", { recursive: true });

const { buildId } = run("devOnly/olpProbe:resolveBuildId");
if (!buildId) throw new Error("could not resolve OLP buildId — is the site up?");
console.log("buildId:", buildId);

const configs = run("devOnly/olpProbe:_listEnrichedConfigs").slice(0, LIMIT);
console.log(`probing ${configs.length} configs…`);

const results = [];
for (const [i, c] of configs.entries()) {
  let r;
  try {
    r = run("devOnly/olpProbe:probeConfig", {
      vehicleConfigId: c.id,
      buildId,
    });
  } catch (e) {
    r = { config_key: c.config_key, resolved: false, error: String(e.message ?? e).slice(0, 300) };
  }
  results.push(r);
  writeFileSync(
    `proof/olp/raw/${c.config_key}.json`,
    JSON.stringify(r, null, 2),
  );
  console.log(
    `[${i + 1}/${configs.length}] ${c.config_key} → ` +
      (r.resolved
        ? `OK (${r.services.filter((s) => s.status === "matched").length} matched)`
        : `FAIL: ${r.error}`),
  );
  await sleep(500); // be polite to OLP
}

// ---------------- SUMMARY.md ----------------
const resolved = results.filter((r) => r.resolved);
const allSvc = resolved.flatMap((r) =>
  r.services.map((s) => ({ ...s, config_key: r.config_key })),
);
const matched = allSvc.filter((s) => s.status === "matched");
const deltas = matched.filter((s) => s.delta_pct != null).map((s) => Math.abs(s.delta_pct));
const within25 = deltas.filter((d) => d <= 25).length;

const svcSlugs = [...new Set(allSvc.map((s) => s.slug))].sort();
const perService = svcSlugs.map((slug) => {
  const rows = matched.filter((s) => s.slug === slug);
  return {
    slug,
    n: rows.length,
    olp_median: median(rows.map((s) => s.olp_hours)),
    ours_median: median(rows.map((s) => s.our_hours)),
    delta_median: median(rows.map((s) => s.delta_pct)),
  };
});

const lines = [];
lines.push(`# OLP Labor Probe — Results (${new Date().toISOString().slice(0, 10)})`);
lines.push("");
lines.push(`Source: openlaborproject.com Next.js data routes (buildId \`${buildId}\`). Read-only probe — no DB writes. Spec: \`docs/superpowers/specs/2026-06-12-olp-labor-probe-design.md\`.`);
lines.push("");
lines.push("## Headline");
lines.push("");
lines.push(`- Configs probed: **${results.length}** — resolved on OLP: **${resolved.length}** (${Math.round((resolved.length / Math.max(results.length, 1)) * 100)}%)`);
lines.push(`- Service comparisons with both sides present: **${matched.length}**`);
lines.push(`- Median |Δ| OLP vs our book_hours: **${fmt(median(deltas), 0)}%** — within ±25%: **${matched.length ? Math.round((within25 / matched.length) * 100) : 0}%**`);
lines.push(`- OLP-has / we-don't: **${allSvc.filter((s) => s.status === "no_our_data").length}** · we-have / OLP-doesn't: **${allSvc.filter((s) => s.status === "no_olp_job").length}**`);
lines.push("");
lines.push("## Resolution per config");
lines.push("");
lines.push("| Config | OLP vehicle | Labor entries | Services matched |");
lines.push("|---|---|---|---|");
for (const r of results) {
  if (r.resolved) {
    const m = r.services.filter((s) => s.status === "matched").length;
    lines.push(`| \`${r.config_key}\` | [${r.olp_vehicle.displayYear} ${r.olp_vehicle.engine}](${r.olp_url}) | ${r.olp_labor_count} | ${m}/${r.services.length} |`);
  } else {
    lines.push(`| \`${r.config_key}\` | — | — | ✗ ${r.error} |`);
  }
}
lines.push("");
lines.push("## Per-service medians (matched rows)");
lines.push("");
lines.push("| Service | n | Our median h | OLP median h | Median Δ% |");
lines.push("|---|---|---|---|---|");
for (const p of perService) {
  lines.push(`| ${p.slug} | ${p.n} | ${fmt(p.ours_median)} | ${fmt(p.olp_median)} | ${p.delta_median == null ? "—" : p.delta_median + "%"} |`);
}
lines.push("");
lines.push("## Full comparison (config × service)");
lines.push("");
lines.push("| Config | Service | Ours h | RP obs h | OLP h | Δ% | Status |");
lines.push("|---|---|---|---|---|---|---|");
for (const s of allSvc) {
  lines.push(`| \`${s.config_key}\` | ${s.slug} | ${fmt(s.our_hours)} | ${fmt(s.estimator_hours)} | ${fmt(s.olp_hours)} | ${s.delta_pct == null ? "—" : s.delta_pct + "%"} | ${s.status} |`);
}
lines.push("");
lines.push("## Gaps");
lines.push("");
const unresolved = results.filter((r) => !r.resolved);
lines.push(`**Cars OLP couldn't resolve (${unresolved.length}):** ${unresolved.map((r) => `\`${r.config_key}\``).join(", ") || "none"}`);
lines.push("");
const noOlp = svcSlugs.filter((slug) =>
  allSvc.filter((s) => s.slug === slug).every((s) => s.olp_hours == null),
);
lines.push(`**Services with zero OLP coverage across all cars:** ${noOlp.join(", ") || "none"}`);
lines.push("");

writeFileSync("proof/olp/SUMMARY.md", lines.join("\n"));
console.log(`\nwrote proof/olp/SUMMARY.md (${resolved.length}/${results.length} resolved, ${matched.length} matched comparisons)`);
