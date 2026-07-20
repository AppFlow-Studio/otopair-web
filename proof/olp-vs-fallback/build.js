/**
 * build.js — join the DB tier-fallback dump with the OLP raw files and compute
 * the fallback-vs-OLP labor-hours comparison (plus current-book-hours-vs-OLP as
 * a reference baseline).  READ-ONLY analysis; writes only proof/olp-vs-fallback/data.json.
 *
 * Run:  node proof/olp-vs-fallback/build.js
 *
 * Inputs:
 *   - <repo>/proof_dump.json                : output of devOnly/fallbackVsOlp:dump
 *       (per enriched config: tier + per-service {labor_category, labor_mult,
 *        current_book_hours, current_source, db camry_hours[empty here]})
 *   - <repo>/proof/olp/raw/<config_key>.json: per-config OLP probe (services[].olp_hours, status, our_hours)
 *
 * Camry anchor note: the dev deployment flippant-mink-750 has NO seeded Camry
 * baseline config (camry_present=false, 0 vdb_camry_baseline labor_times rows).
 * So computeTierFloor would return null on this deployment today. The fallback
 * hours are therefore reconstructed from the DOCUMENTED GROUND-TRUTH Camry FWD
 * book_hours (convex/seeds/seedCamryBaseline.ts CAMRY_LABOR_HOURS, per the task
 * spec) × the DB-read v2 labor multiplier (pricing_labor_multipliers, which DID
 * match GROUND TRUTH exactly). Services NOT present in CAMRY_LABOR_HOURS have NO
 * anchor -> fallback unavailable (rotor_replacement, timing_belt, power_steering_flush).
 */
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");
// db_dump.json = output of `npx convex run devOnly/fallbackVsOlp:dump` (kept in-dir).
const dump = JSON.parse(fs.readFileSync(path.join(__dirname, "db_dump.json"), "utf8"));
const RAW_DIR = path.join(REPO, "proof", "olp", "raw");

// GROUND TRUTH Camry FWD book_hours (seedCamryBaseline.ts CAMRY_LABOR_HOURS).
// Only services with an OLP-comparable labor mapping are listed; absence => no anchor.
const CAMRY_HOURS = {
  oil_change: 0.5,
  filter_replacement: 0.3,
  spark_plugs: 1.15, // midpoint 0.9-1.4
  coolant_flush: 1.0,
  transmission_service: 1.5, // midpoint 1.4-1.6
  brake_fluid_flush: 0.7,
  battery_replacement: 0.4,
  differential_service: 1.15, // midpoint 1.0-1.3
  wheel_alignment: 1.0,
  brake_pad_replacement: 1.4, // front midpoint 1.1-1.7
  // NOT anchored in CAMRY_LABOR_HOURS -> fallback unavailable:
  //   rotor_replacement (brakes), timing_belt (engine_access), power_steering_flush (routine)
};

const SERVICE_CATEGORY = {
  oil_change: "routine",
  filter_replacement: "routine",
  brake_fluid_flush: "routine",
  battery_replacement: "routine",
  coolant_flush: "routine",
  transmission_service: "routine",
  differential_service: "routine",
  wheel_alignment: "routine",
  power_steering_flush: "routine",
  spark_plugs: "engine_access",
  timing_belt: "engine_access",
  brake_pad_replacement: "brakes",
  rotor_replacement: "brakes",
};

// Scope-mismatch flags (from OLP shape read): services where OLP/fallback compare
// across different work scopes.
const SCOPE_NOTE = {
  oil_change: "OLP row = synthetic drain-fill only; ours bundles filter (structural -40..-50%)",
  rotor_replacement: "OLP front-pair vs unstated-axle; combo rows present",
  differential_service: "OLP full-service vs fluid-change; FWD cars have no diff",
  transmission_service: "OLP may include pan/filter; ours fluid-only",
  timing_belt: "n tiny; chain engines correctly have no OLP row",
};

const round = (x) => Math.round(x);
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function r1(x) {
  return x == null ? null : Math.round(x * 10) / 10;
}

// ── per-config DB lookup ───────────────────────────────────────────────────
const cfgByKey = new Map(dump.configs.map((c) => [c.config_key, c]));
const matrix = dump.labor_matrix_db;

const rows = []; // every comparison row (both fallback and olp present)
const allConfigKeys = [];

for (const file of fs.readdirSync(RAW_DIR)) {
  if (!file.endsWith(".json")) continue;
  const raw = JSON.parse(fs.readFileSync(path.join(RAW_DIR, file), "utf8"));
  const ck = raw.config_key;
  if (String(ck).includes("evaltest")) continue; // fixture, not on OLP
  allConfigKeys.push(ck);
  const dbCfg = cfgByKey.get(ck);
  const tier = dbCfg ? dbCfg.tier : null;

  const olpBySlug = new Map();
  for (const s of raw.services || []) olpBySlug.set(s.slug, s);

  for (const [slug, category] of Object.entries(SERVICE_CATEGORY)) {
    const olp = olpBySlug.get(slug);
    const olp_hours = olp && olp.olp_hours != null ? olp.olp_hours : null;
    const status = olp ? olp.status : "missing";
    const our_hours_olpfile = olp && olp.our_hours != null ? olp.our_hours : null;

    const camry = CAMRY_HOURS[slug];
    const mult = tier != null && matrix[category] ? matrix[category][tier] ?? null : null;
    const fallback =
      camry != null && mult != null ? Math.round(camry * mult * 1000) / 1000 : null;

    // DB current book_hours (cross-check vs OLP file's our_hours)
    let db_current = null,
      db_source = null;
    if (dbCfg) {
      const svc = dbCfg.services.find((x) => x.slug === slug);
      if (svc) {
        db_current = svc.current_book_hours;
        db_source = svc.current_source;
      }
    }

    const fb_delta =
      fallback != null && olp_hours != null && olp_hours !== 0
        ? round(((fallback - olp_hours) / olp_hours) * 100)
        : null;
    const cur_delta =
      our_hours_olpfile != null && olp_hours != null && olp_hours !== 0
        ? round(((our_hours_olpfile - olp_hours) / olp_hours) * 100)
        : null;

    rows.push({
      config_key: ck,
      tier,
      service: slug,
      labor_category: category,
      camry_hours: camry ?? null,
      labor_mult: mult,
      fallback_hours: fallback,
      current_book_hours: our_hours_olpfile, // value the OLP probe measured (live labor_times)
      current_book_hours_db: db_current, // DB cross-check (this deployment)
      current_source: db_source,
      olp_hours,
      olp_status: status,
      fallback_vs_olp_delta_pct: fb_delta,
      current_vs_olp_delta_pct: cur_delta,
      scope_note: SCOPE_NOTE[slug] || null,
      fallback_available: fallback != null,
      comparable: fallback != null && olp_hours != null, // a fallback-vs-OLP comparison row
    });
  }
}

// ── aggregate stats helper ─────────────────────────────────────────────────
function stats(deltas) {
  const d = deltas.filter((x) => x != null);
  if (!d.length)
    return { n: 0, median: null, mean: null, median_abs: null, within_25_pct: null, gt: 0, lt: 0, eq: 0 };
  const abs = d.map(Math.abs);
  const within = d.filter((x) => Math.abs(x) <= 25).length;
  return {
    n: d.length,
    median: median(d),
    mean: Math.round(mean(d) * 10) / 10,
    median_abs: median(abs),
    within_25_pct: Math.round((within / d.length) * 1000) / 10,
    gt: d.filter((x) => x > 0).length, // fallback/current > OLP
    lt: d.filter((x) => x < 0).length,
    eq: d.filter((x) => x === 0).length,
  };
}

const compRows = rows.filter((r) => r.comparable);
const fbDeltas = compRows.map((r) => r.fallback_vs_olp_delta_pct);
// current-vs-OLP: use the SAME row set where fallback is comparable AND current present,
// AND also the full current-vs-OLP set for reference.
const curDeltasSameRows = compRows
  .filter((r) => r.current_vs_olp_delta_pct != null)
  .map((r) => r.current_vs_olp_delta_pct);
const curDeltasAll = rows
  .filter((r) => r.current_vs_olp_delta_pct != null && r.olp_hours != null)
  .map((r) => r.current_vs_olp_delta_pct);

const headline = {
  fallback_vs_olp: stats(fbDeltas),
  current_vs_olp_same_rows: stats(curDeltasSameRows),
  current_vs_olp_all: stats(curDeltasAll),
};

// ── per-service breakdown ──────────────────────────────────────────────────
const perService = [];
for (const slug of Object.keys(SERVICE_CATEGORY)) {
  const sr = rows.filter((r) => r.service === slug);
  const comp = sr.filter((r) => r.comparable);
  const fb = comp.map((r) => r.fallback_vs_olp_delta_pct);
  const cur = sr.filter((r) => r.current_vs_olp_delta_pct != null && r.olp_hours != null).map((r) => r.current_vs_olp_delta_pct);
  const olpVals = sr.filter((r) => r.olp_hours != null).map((r) => r.olp_hours);
  const fbVals = comp.map((r) => r.fallback_hours);
  perService.push({
    service: slug,
    labor_category: SERVICE_CATEGORY[slug],
    camry_hours: CAMRY_HOURS[slug] ?? null,
    n: comp.length, // comparison rows (fallback & olp present)
    n_olp: olpVals.length,
    fallback_median_h: r1(median(fbVals)),
    olp_median_h: r1(median(olpVals)),
    median_delta_pct: median(fb),
    fb_stats: stats(fb),
    current_vs_olp_stats: stats(cur),
    note:
      CAMRY_HOURS[slug] == null
        ? "NO Camry anchor in seedCamryBaseline -> fallback UNAVAILABLE for this service"
        : SCOPE_NOTE[slug] || "",
  });
}

// ── per-tier breakdown ─────────────────────────────────────────────────────
const tierSet = [...new Set(compRows.map((r) => r.tier).filter(Boolean))].sort();
const perTier = [];
for (const t of tierSet) {
  const tr = compRows.filter((r) => r.tier === t);
  const fb = tr.map((r) => r.fallback_vs_olp_delta_pct);
  const st = stats(fb);
  const nConfigs = new Set(tr.map((r) => r.config_key)).size;
  perTier.push({
    tier: t,
    n: st.n,
    n_configs: nConfigs,
    median_delta_pct: st.median,
    mean_delta_pct: st.mean,
    within_25_pct: st.within_25_pct,
    note: `${nConfigs} config(s); fallback>OLP ${st.gt}, <OLP ${st.lt}`,
  });
}

// ── notable rows: biggest signed over/under shoots (fallback vs OLP) ────────
const sortedByDelta = [...compRows].sort(
  (a, b) => a.fallback_vs_olp_delta_pct - b.fallback_vs_olp_delta_pct,
);

const out = {
  generated_at: new Date().toISOString(),
  method: {
    camry_anchor_present_in_db: dump.camry_present,
    camry_hours_source: "GROUND TRUTH seedCamryBaseline.ts CAMRY_LABOR_HOURS (DB had no Camry config)",
    labor_multiplier_source: "DB pricing_labor_multipliers (read live; matches GROUND TRUTH matrix)",
    olp_source: "proof/olp/raw/<config_key>.json services[].olp_hours",
    current_book_hours_source: "OLP raw file our_hours (live labor_times the probe measured)",
  },
  labor_matrix_db: matrix,
  camry_hours_used: CAMRY_HOURS,
  config_count: allConfigKeys.length,
  comparison_rows: compRows.length,
  headline,
  per_service: perService,
  per_tier: perTier,
  rows,
};

const OUT = path.join(__dirname, "data.json");
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

// ── console summary ────────────────────────────────────────────────────────
console.log("=== fallback-vs-OLP ===");
console.log("configs:", allConfigKeys.length, " comparison rows:", compRows.length);
console.log("FALLBACK vs OLP:", JSON.stringify(headline.fallback_vs_olp));
console.log("CURRENT(same rows) vs OLP:", JSON.stringify(headline.current_vs_olp_same_rows));
console.log("CURRENT(all) vs OLP:", JSON.stringify(headline.current_vs_olp_all));
console.log("\n--- per service (fallback vs OLP) ---");
for (const s of perService) {
  console.log(
    `${s.service.padEnd(22)} cat=${s.labor_category.padEnd(13)} camry=${String(s.camry_hours).padEnd(5)} n=${String(s.n).padEnd(3)} fb_med=${String(s.fallback_median_h).padEnd(5)} olp_med=${String(s.olp_median_h).padEnd(5)} medΔ=${s.median_delta_pct}%  ${s.note ? "[" + s.note.slice(0, 40) + "]" : ""}`,
  );
}
console.log("\n--- per tier ---");
for (const t of perTier) console.log(JSON.stringify(t));
console.log("\n--- 6 biggest UNDERshoots (fallback << OLP) ---");
for (const r of sortedByDelta.slice(0, 6))
  console.log(`${r.config_key} | ${r.service} | tier=${r.tier} fb=${r.fallback_hours} olp=${r.olp_hours} Δ=${r.fallback_vs_olp_delta_pct}%`);
console.log("\n--- 6 biggest OVERshoots (fallback >> OLP) ---");
for (const r of sortedByDelta.slice(-6).reverse())
  console.log(`${r.config_key} | ${r.service} | tier=${r.tier} fb=${r.fallback_hours} olp=${r.olp_hours} Δ=${r.fallback_vs_olp_delta_pct}%`);
console.log("\nwrote", OUT);
