// VDB provider comparison driver — decodes each test vehicle through VDB /
// MarketCheck / CarAPI / NHTSA via devOnly/vdbCompare:compareVin, writes raw
// responses to proof/vdb/raw/<vin>.<provider>.json and assembles
// proof/vdb/SCORECARD.md. Read-only — no DB writes.
//
// Usage:
//   node scripts/vdb-compare.mjs                 # FLEET + 5 real VINs (default)
//   node scripts/vdb-compare.mjs --fleet         # FLEET only
//   node scripts/vdb-compare.mjs --wave 1        # FLEET wave 1 only
//   node scripts/vdb-compare.mjs --real 8        # FLEET + 8 real VINs
//   node scripts/vdb-compare.mjs --vins VIN1,VIN2
//
// Prereq (keys live on the deployment, NOT .env.local):
//   npx convex env set MARKETCHECK_API_KEY <v>
//   npx convex env set CAR_API_TOKEN <v>
//   npx convex env set CAR_API_SECRET <v>

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, openSync, closeSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── args ──
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const onlyFleet = flag("--fleet");
const wave = opt("--wave", null);
const realN = Number(opt("--real", onlyFleet ? 0 : 5));
const vinsArg = opt("--vins", null);

const NPX = process.platform === "win32" ? "npx.cmd" : "npx";
let _runSeq = 0;
const run = (fn, args) => {
  const a = ["convex", "run", fn];
  if (args) {
    const raw = JSON.stringify(args);
    a.push(process.platform === "win32" ? raw.replace(/"/g, '\\"') : raw);
  }
  // Write the child's stdout STRAIGHT to a temp file descriptor. Capturing a
  // large convex-run payload through execFileSync's parent pipe corrupts it at
  // buffer boundaries; a file fd sidesteps the pipe entirely. stderr (action
  // console.log) is discarded so it can't interleave.
  const tmp = join(tmpdir(), `vdbcmp_${process.pid}_${_runSeq++}.json`);
  const fd = openSync(tmp, "w");
  try {
    execFileSync(NPX, a, {
      shell: process.platform === "win32",
      stdio: ["ignore", fd, "ignore"],
    });
  } finally {
    closeSync(fd);
  }
  const txt = readFileSync(tmp, "utf8");
  unlinkSync(tmp);
  return JSON.parse(txt);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── provider + field catalogue (mirrors convex/lib/vdbCompareTypes.ts) ──
const PROVIDERS = [
  { key: "vdb", label: "VDB (current)" },
  { key: "marketcheck", label: "MarketCheck" },
  { key: "carapi", label: "CarAPI (2015–2020)" },
  { key: "nhtsa", label: "NHTSA (baseline)" },
];
const HIGH_VALUE = [
  ["trim", "Trim"],
  ["engineCode", "Engine code"],
  ["chassisCode", "Chassis code"],
  ["packages", "Packages/options"],
];
// Third element = where this field is ACTUALLY sourced in production today, so
// the reader can tell "does dropping VDB lose this?". Tire size/PSI come from
// the wheel-size.com API (VDB's tire fields are extracted but never persisted);
// rotor thickness (the spec that matters) comes from enrichment/mechanic, not
// VDB's rotor diameter. VDB uniquely feeds only CCA, brake tier, steering.
const DEEP_SPEC = [
  ["cylinders", "Cylinders", "identity (NHTSA+VDB)"],
  ["displacement", "Displacement (L)", "identity (NHTSA+VDB)"],
  ["cylindersConfiguration", "Cyl config", "identity"],
  ["drivetrain", "Drivetrain", "identity (NHTSA+VDB)"],
  ["horsepower", "Horsepower", "VDB (review only)"],
  ["fuelType", "Fuel type", "identity (NHTSA)"],
  ["bodyType", "Body type", "NHTSA"],
  ["transType", "Trans type", "identity (NHTSA+VDB)"],
  ["transSpeeds", "Trans speeds", "identity (NHTSA+VDB)"],
  ["frontTireSize", "Front tire", "**wheel-size.com**"],
  ["rearTireSize", "Rear tire", "**wheel-size.com**"],
  ["frontTirePressure", "Front PSI", "**wheel-size.com**"],
  ["rearTirePressure", "Rear PSI", "**wheel-size.com**"],
  ["cca", "Battery CCA", "**VDB only**"],
  ["frontRotorDia", "Front rotor Ø", "VDB (unused; prod=thickness)"],
  ["rearRotorDia", "Rear rotor Ø", "VDB (unused; prod=thickness)"],
  ["brakeType", "Brake type", "NHTSA/VDB"],
  ["brakeSystemType", "Brake tier", "**VDB only**"],
  ["steeringType", "Steering", "**VDB only**"],
];

// ── trims-parity mode (--trims): YMMT trims-catalog comparison ──
if (flag("--trims")) {
  mkdirSync("proof/vdb/raw", { recursive: true });
  const targets = run("devOnly/vdbCompare:listTrimsTargets");
  console.log(`trims-parity across ${targets.length} YMMs…`);
  const rows = [];
  for (const [i, t] of targets.entries()) {
    let r;
    try {
      r = run("devOnly/vdbCompare:trimsParity", t);
    } catch (e) {
      r = { ...t, error: String(e.message ?? e).slice(0, 300) };
    }
    rows.push(r);
    const c = r.providers?.carapi;
    const m = r.providers?.marketcheck;
    console.log(
      `[${i + 1}/${targets.length}] ${t.year} ${t.make} ${t.model} → CarAPI ${c?.trimsCount ?? "?"} trims / ${c?.enginesCount ?? "?"} engines · MC ${m?.trimsCount ?? "?"} market trims`,
    );
    await sleep(500);
  }
  writeFileSync("proof/vdb/raw/trims-parity.json", JSON.stringify(rows, null, 2));

  const T = [];
  const today = new Date().toISOString().slice(0, 10);
  T.push(`# Trims / YMMT Parity — VDB vs MarketCheck vs CarAPI (${today})`);
  T.push("");
  T.push(
    "Do the candidates offer a **YMMT trims catalog** at parity with VDB? IMPORTANT: in our plan **VDB has no YMMT trims endpoint** (`ymm-specs` 400s even on its own doc example) — VDB's \"trims options\" come embedded **per-VIN** in `advanced-vin-decode`. So this measures the candidates' YMMT catalogs against a VDB baseline that is itself per-VIN-only.",
  );
  T.push("");
  T.push("## Trims enumerated per YMM (no VIN)");
  T.push("");
  T.push("| YMM | VDB | CarAPI `/trims/v2` | MarketCheck (inventory facets) |");
  T.push("|---|---|---|---|");
  for (const r of rows) {
    if (r.error) {
      T.push(`| ${r.year} ${r.make} ${r.model} | — | ERROR | ${r.error} |`);
      continue;
    }
    const p = r.providers;
    T.push(
      `| ${r.year} ${r.make} ${r.model} | per-VIN only | **${p.carapi.trimsCount}** trims · ${p.carapi.enginesCount} engines · ${p.carapi.bodiesCount} bodies | ${p.marketcheck.trimsCount} market trims |`,
    );
  }
  T.push("");
  T.push("## Sample trims returned");
  T.push("");
  for (const r of rows) {
    if (r.error) continue;
    T.push(`**${r.year} ${r.make} ${r.model}**`);
    T.push(`- CarAPI: ${r.providers.carapi.sampleTrims.join(" · ") || "—"}`);
    T.push(`- MarketCheck: ${r.providers.marketcheck.sampleTrims.join(" · ") || "—"}`);
    T.push("");
  }
  const engFields = new Set();
  for (const r of rows) if (!r.error) for (const f of r.providers.carapi.engineSpecFields) engFields.add(f);
  T.push("## Capability parity matrix");
  T.push("");
  T.push("| Capability | VDB (current) | CarAPI | MarketCheck |");
  T.push("|---|---|---|---|");
  T.push("| Enumerate all trims for a YMM (no VIN) | ❌ per-VIN only | ✅ OEM catalog | ⚠️ market facets |");
  T.push(`| Engine specs per trim (YMM) | ❌ per-VIN only | ✅ (${[...engFields].join(", ") || "—"}) | ❌ per-VIN (NeoVIN) |`);
  T.push("| Body dims per trim (YMM) | ❌ | ✅ `/bodies/v2` | ❌ |");
  T.push("| Installed options / packages | ✅ per-VIN (decode) | ⚠️ limited | ✅ per-VIN (NeoVIN) |");
  T.push("| OEM engine code | ⚠️ unreliable (STDEN) | ❌ | ❌ |");
  T.push("| Free-tier YMM coverage | n/a (paid) | 2015–2020 only | all years (inventory) |");
  T.push("");
  writeFileSync("proof/vdb/TRIMS_PARITY.md", T.join("\n"));
  console.log("\nwrote proof/vdb/TRIMS_PARITY.md");
  process.exit(0);
}

// ── build VIN work-list ──
let targets = []; // { vin, label }
if (vinsArg) {
  targets = vinsArg.split(",").map((v) => ({ vin: v.trim(), label: v.trim() }));
} else {
  const fleet = run("devOnly/vdbCompare:listFleet", wave ? { wave: Number(wave) } : undefined);
  targets = fleet.map((f) => ({ vin: f.vin, label: f.label }));
  if (realN > 0) {
    const real = run("devOnly/vdbCompare:_sampleRealVins", { limit: realN });
    for (const r of real) {
      const lbl = [r.ymmt?.year, r.ymmt?.make, r.ymmt?.model].filter(Boolean).join(" ") || r.vin;
      targets.push({ vin: r.vin, label: `${lbl} (real)` });
    }
  }
}
// dedupe by vin
const byVin = new Map();
for (const t of targets) if (!byVin.has(t.vin)) byVin.set(t.vin, t);
targets = [...byVin.values()];

mkdirSync("proof/vdb/raw", { recursive: true });
console.log(`comparing ${targets.length} vehicles across ${PROVIDERS.length} providers…`);

// ── decode loop (one VIN per convex run — avoids CLI/action timeout) ──
const results = [];
for (const [i, t] of targets.entries()) {
  let r;
  try {
    r = run("devOnly/vdbCompare:compareVin", { vin: t.vin });
  } catch (e) {
    r = { vin: t.vin, label: t.label, error: String(e.message ?? e).slice(0, 400) };
  }
  results.push(r);
  // per-provider raw + score
  if (r.providers) {
    for (const p of PROVIDERS) {
      writeFileSync(
        `proof/vdb/raw/${t.vin}.${p.key}.json`,
        JSON.stringify(r.providers[p.key]?.rawSample ?? null, null, 2),
      );
    }
  }
  writeFileSync(`proof/vdb/raw/${t.vin}.result.json`, JSON.stringify(r, null, 2));
  const okCount = r.score
    ? PROVIDERS.filter((p) => r.score.perProvider[p.key]?.ok).length
    : 0;
  console.log(`[${i + 1}/${targets.length}] ${t.vin} ${t.label} → ${okCount}/${PROVIDERS.length} providers ok`);
  await sleep(500); // politeness (MarketCheck free-plan rate limits)
}

// ── aggregation ──
const scored = results.filter((r) => r.score);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const pct = (x) => (x == null ? "—" : `${Math.round(x)}%`);

function providerAgg(pk) {
  const applic = scored.filter((r) => r.score.perProvider[pk]?.applicable !== false);
  const hv = mean(applic.map((r) => r.score.perProvider[pk]?.highValue.pct ?? 0));
  const ds = mean(applic.map((r) => r.score.perProvider[pk]?.deepSpec.pct ?? 0));
  const full = mean(applic.map((r) => r.score.perProvider[pk]?.full.pct ?? 0));
  const okCount = scored.filter((r) => r.score.perProvider[pk]?.ok).length;
  // engine-code match rate over fleet vehicles with ground truth + provider applicable
  const gt = scored.filter(
    (r) => r.inFleet && r.score.perProvider[pk]?.engineCode !== "no_ground_truth" && r.score.perProvider[pk]?.applicable !== false,
  );
  const matches = gt.filter((r) => r.score.perProvider[pk]?.engineCode === "match").length;
  const inRange = scored.filter((r) => r.score.perProvider[pk]?.applicable !== false).length;
  return { hv, ds, full, okCount, matches, gtTotal: gt.length, applicCount: applic.length, inRange };
}
const agg = Object.fromEntries(PROVIDERS.map((p) => [p.key, providerAgg(p.key)]));

// value cell for a canonical field
function cell(r, pk, key) {
  const pp = r.score?.perProvider?.[pk];
  if (pp && pp.applicable === false) return "n/a";
  const canon = r.providers?.[pk]?.canonical;
  if (!canon) return "—";
  const val = canon[key];
  if (val == null || val === "" || (Array.isArray(val) && val.length === 0)) return "—";
  if (Array.isArray(val)) return `${val.length}`;
  return String(val).replace(/\|/g, "/").slice(0, 22);
}
function engineCell(r, pk) {
  const pp = r.score?.perProvider?.[pk];
  if (pp && pp.applicable === false) return "n/a";
  const canon = r.providers?.[pk]?.canonical;
  const val = canon?.engineCode;
  const base = val ? String(val).slice(0, 16) : "—";
  if (!r.inFleet || !pp || pp.engineCode === "no_ground_truth") return base;
  if (pp.engineCode === "match") return `${base} ✓`;
  if (pp.engineCode === "mismatch") return `${base} ✗`;
  return base; // absent
}

// ── SCORECARD.md ──
const L = [];
const today = new Date().toISOString().slice(0, 10);
L.push(`# VDB Provider Comparison — Scorecard (${today})`);
L.push("");
L.push(
  "Read-only evaluation of **MarketCheck** and **CarAPI** as replacements for the paid **Vehicle Databases (VDB)** VIN decode, vs the free **NHTSA** baseline. " +
    "Harness: `convex/devOnly/vdbCompare.ts`. No DB writes. CarAPI free dataset = model years **2015–2020** (out-of-range vehicles shown `n/a`).",
);
L.push("");

// auth visibility
const authNote = (pk) => {
  const anyUnset = results.some((r) => {
    const reason = r.providers?.[pk]?.reason ?? "";
    return /not set|no key|keys unset|auth failed/i.test(reason);
  });
  const anyOk = scored.some((r) => r.score.perProvider[pk]?.ok);
  return anyOk ? "reachable" : anyUnset ? "**KEY NOT SET / auth failed**" : "no data";
};

L.push("## 1. Headline");
L.push("");
L.push(`- Vehicles probed: **${results.length}** (FLEET + real + YMMT). Decode errors: **${results.filter((r) => r.error).length}**.`);
for (const p of PROVIDERS) {
  const a = agg[p.key];
  const ecr = a.gtTotal ? `${a.matches}/${a.gtTotal} engine-code match` : "no ground-truth VINs";
  L.push(`- **${p.label}** — ${authNote(p.key)}; high-value ${pct(a.hv)}, deep-spec ${pct(a.ds)}; ${ecr}.`);
}
L.push("");

L.push("## 2. Provider coverage matrix");
L.push("");
L.push("| Provider | High-value % | Deep-spec % | Full % | Engine-code match | Vehicles OK |");
L.push("|---|---|---|---|---|---|");
for (const p of PROVIDERS) {
  const a = agg[p.key];
  const range = p.key === "carapi" ? ` (${a.applicCount}/${scored.length} in range)` : "";
  const ecr = a.gtTotal ? `${a.matches}/${a.gtTotal}` : "—";
  L.push(
    `| ${p.label}${range} | ${pct(a.hv)} | ${pct(a.ds)} | ${pct(a.full)} | ${ecr} | ${a.okCount}/${scored.length} |`,
  );
}
L.push("");
L.push("_High-value = engine code · chassis code · trim · packages. Deep-spec = 19 physical/mechanical specs (see §4 for which are actually sourced from VDB in prod vs wheel-size.com/enrichment)._");
L.push("");

L.push("## 3. High-value fields, per vehicle");
L.push("");
L.push(`| Vehicle | Field | ${PROVIDERS.map((p) => p.label).join(" | ")} |`);
L.push(`|---|---|${PROVIDERS.map(() => "---").join("|")}|`);
for (const r of scored) {
  for (const [key, lbl] of HIGH_VALUE) {
    const cells = PROVIDERS.map((p) => (key === "engineCode" ? engineCell(r, p.key) : cell(r, p.key, key)));
    L.push(`| ${r.label.slice(0, 28)} | ${lbl} | ${cells.join(" | ")} |`);
  }
}
L.push("");
L.push("_`✓/✗` on engine code = agreement with FLEET ground truth. `—` absent, `n/a` out of CarAPI free range, package cells show the count returned._");
L.push("");

L.push("## 4. Deep-spec coverage (share of vehicles where each provider returned the field)");
L.push("");
L.push(
  "**Prod source** = where this field is ACTUALLY sourced today. Tire size/PSI come from the **wheel-size.com** API (VDB's tire fields are extracted but never persisted), and the rotor spec that matters (thickness) comes from enrichment/mechanic — so a candidate scoring 0% on those rows does NOT mean lost data. The fields VDB **uniquely** feeds prod are Battery CCA, Brake tier, Steering (+ engine code & packages above).",
);
L.push("");
L.push(`| Deep spec | Prod source | ${PROVIDERS.map((p) => p.label).join(" | ")} |`);
L.push(`|---|---|${PROVIDERS.map(() => "---").join("|")}|`);
for (const [key, lbl, prodSrc] of DEEP_SPEC) {
  const cells = PROVIDERS.map((p) => {
    const applic = scored.filter((r) => r.score.perProvider[p.key]?.applicable !== false);
    if (!applic.length) return "—";
    const present = applic.filter((r) => r.score.perProvider[p.key]?.fields?.[key] === "present").length;
    return `${Math.round((present / applic.length) * 100)}%`;
  });
  L.push(`| ${lbl} | ${prodSrc} | ${cells.join(" | ")} |`);
}
L.push("");

L.push("## 5. Gaps & outliers");
L.push("");
// fields no candidate (marketcheck/carapi) ever returned
const candidateKeys = ["marketcheck", "carapi"];
const neverByCandidates = [...HIGH_VALUE, ...DEEP_SPEC].filter(([key]) =>
  candidateKeys.every((pk) => {
    const applic = scored.filter((r) => r.score.perProvider[pk]?.applicable !== false);
    return applic.every((r) => r.score.perProvider[pk]?.fields?.[key] !== "present");
  }),
);
L.push(
  `**Fields NO candidate (MarketCheck/CarAPI) returned for any vehicle:** ${
    neverByCandidates.map(([, lbl]) => lbl).join(", ") || "none"
  }`,
);
L.push("");
// auth / error surface
const errored = results.filter((r) => r.error);
if (errored.length) {
  L.push(`**Decode errors:** ${errored.map((r) => `\`${r.vin}\`: ${r.error}`).join("; ")}`);
  L.push("");
}
for (const p of PROVIDERS) {
  const reasons = new Set(
    results
      .map((r) => r.providers?.[p.key]?.reason)
      .filter((x) => x && !/out_of_free_dataset/.test(x)),
  );
  if (reasons.size) L.push(`- **${p.label}** non-ok reasons: ${[...reasons].slice(0, 5).join(" · ")}`);
}
L.push("");
// a few cross-provider disagreements
const disagreements = [];
for (const r of scored) for (const d of r.score.disagreements ?? []) disagreements.push({ vin: r.label, ...d });
if (disagreements.length) {
  L.push("**Cross-provider disagreements (accuracy proxy):**");
  L.push("");
  for (const d of disagreements.slice(0, 15)) {
    const vals = Object.entries(d.values)
      .map(([pk, val]) => `${pk}=${val}`)
      .join(", ");
    L.push(`- ${d.vin} · ${d.field}: ${vals}`);
  }
  L.push("");
}

writeFileSync("proof/vdb/SCORECARD.md", L.join("\n"));
console.log(`\nwrote proof/vdb/SCORECARD.md (${scored.length} scored, raw in proof/vdb/raw/)`);
