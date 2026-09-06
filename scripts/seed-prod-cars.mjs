/**
 * seed-prod-cars.mjs — copy fully-enriched, priced "cars" from the dev
 * deployments into prod (mellow-cat-431), WITHOUT wiping prod.
 *
 * Pairs with convex/seedCatalog.ts (deployed to every deployment below). It
 * reads qualifying vehicle_configs (enrichment_status complete/verified,
 * fill_rate ≥ min-fill, ≥1 priced part) from each source and re-links them
 * onto prod by natural key. Idempotent: a config_key already on prod is left
 * untouched.
 *
 * ── PREREQUISITES ──────────────────────────────────────────────────────────
 *  1. Deploy convex/seedCatalog.ts to ALL THREE deployments (sources + dest).
 *       # dev sources (env-swap; see scripts/clone-convex-deployment.sh):
 *       #   point .env.local CONVEX_DEPLOYMENT at each, then `npx convex dev --once`
 *       # prod dest:
 *       #   CONVEX_DEPLOY_KEY=<prod key> npx convex deploy
 *  2. Set the shared secret on ALL THREE (same value everywhere):
 *       npx convex env set SEED_SECRET <value>        # per deployment
 *  3. Export SEED_SECRET locally (or pass --secret / put it in .env.local):
 *       export SEED_SECRET=<value>
 *
 * ── USAGE ──────────────────────────────────────────────────────────────────
 *   node scripts/seed-prod-cars.mjs                 # DRY RUN (default): count only
 *   node scripts/seed-prod-cars.mjs --execute       # write to prod (asks to confirm)
 *   node scripts/seed-prod-cars.mjs --execute --yes  # no confirmation prompt
 *
 *   --dest <name>       destination deployment      (default: mellow-cat-431)
 *   --source <a,b>      comma-list of sources        (default: ardent-crab-641,third-bird-914)
 *   --min-fill <n>      fill_rate threshold          (default: 85)
 *   --limit <n>         cap number of cars imported  (default: all)
 *   --secret <s>        SEED_SECRET                  (default: env / .env.local)
 *
 * Deployment name → URL is derived as https://<name>.convex.cloud (any
 * "dev:"/"prod:" prefix is stripped). NOTE: memory records the local dev
 * deployment as `third-bird-914` (the prompt said 913) — override with
 * --source if that's wrong.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── function references (name-based; no generated api import needed) ────────
const LIST = makeFunctionReference("seedCatalog:listQualifyingConfigs");
const EXPORT = makeFunctionReference("seedCatalog:exportConfigBundle");
const PEEK = makeFunctionReference("seedCatalog:peekConfigKeys");
const IMPORT = makeFunctionReference("seedCatalog:importConfigBundle");

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};

const EXECUTE = flag("--execute");
const AUTO_YES = flag("--yes");
const MIN_FILL = Number(opt("--min-fill", "85"));
const LIMIT = opt("--limit", null) ? Number(opt("--limit", null)) : Infinity;
const DEST = stripPrefix(opt("--dest", "mellow-cat-431"));
const SOURCES = String(opt("--source", "ardent-crab-641,third-bird-914"))
  .split(",")
  .map((s) => stripPrefix(s.trim()))
  .filter(Boolean);

const SECRET = opt("--secret", null) ?? process.env.SEED_SECRET ?? loadEnvSecret();
if (!SECRET) {
  fail(
    "No secret. Pass --secret, export SEED_SECRET, or add SEED_SECRET to .env.local.",
  );
}

function stripPrefix(name) {
  return String(name).includes(":") ? name.split(":").pop() : name;
}
function urlFor(name) {
  return `https://${name}.convex.cloud`;
}
function fail(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}
function loadEnvSecret() {
  try {
    const raw = readFileSync(join(ROOT, ".env.local"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (line.trimStart().startsWith("#")) continue;
      const m = line.match(/^\s*SEED_SECRET\s*=\s*(.*)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* ignore */
  }
  return null;
}

// ── source scan: unique qualifying config_keys per deployment ───────────────
async function collectCandidateKeys(client, name) {
  const keys = new Map(); // config_key → {fill_rate, source}
  let cursor = null;
  for (;;) {
    const res = await client.query(LIST, {
      secret: SECRET,
      min_fill: MIN_FILL,
      cursor,
      num_items: 200,
    });
    for (const row of res.rows) {
      const prev = keys.get(row.config_key);
      if (!prev || (row.fill_rate ?? 0) > (prev.fill_rate ?? 0)) {
        keys.set(row.config_key, { fill_rate: row.fill_rate, source: name });
      }
    }
    if (res.is_done) break;
    cursor = res.cursor;
  }
  return keys;
}

async function main() {
  console.log("=== Seed prod with enriched cars ===");
  console.log(`  Destination : ${DEST}  (${urlFor(DEST)})`);
  console.log(`  Sources     : ${SOURCES.join(", ")}`);
  console.log(`  min fill    : ${MIN_FILL}`);
  console.log(`  limit       : ${LIMIT === Infinity ? "all" : LIMIT}`);
  console.log(`  mode        : ${EXECUTE ? "EXECUTE (writes to prod)" : "DRY RUN"}`);
  console.log("");

  const destClient = new ConvexHttpClient(urlFor(DEST));

  // 1. Gather candidates from every source, dedupe by config_key (higher fill wins).
  const best = new Map(); // config_key → {source, fill_rate}
  for (const name of SOURCES) {
    const client = new ConvexHttpClient(urlFor(name));
    process.stdout.write(`Scanning ${name} … `);
    let found;
    try {
      found = await collectCandidateKeys(client, name);
    } catch (e) {
      console.log("");
      fail(`query failed on ${name}: ${e.message ?? e}`);
    }
    console.log(`${found.size} candidate config_keys (fill ≥ ${MIN_FILL})`);
    for (const [key, meta] of found) {
      const prev = best.get(key);
      if (!prev || (meta.fill_rate ?? 0) > (prev.fill_rate ?? 0)) {
        best.set(key, meta);
      }
    }
  }
  console.log(`\nUnique candidate cars across sources: ${best.size}`);

  // 2. Export bundles (from the winning source) and keep the ones that qualify
  //    (a candidate can fail the priced-parts leg, which LIST can't see).
  const bundles = [];
  const sourceClients = new Map(
    SOURCES.map((n) => [n, new ConvexHttpClient(urlFor(n))]),
  );
  let scanned = 0;
  for (const [key, meta] of best) {
    if (bundles.length >= LIMIT) break;
    scanned++;
    const client = sourceClients.get(meta.source);
    const bundle = await client.query(EXPORT, { secret: SECRET, config_key: key });
    if (!bundle?.found) continue;
    if (!bundle.qualifies) continue;
    bundles.push(bundle);
    if (scanned % 25 === 0) {
      process.stdout.write(`  exported ${bundles.length} qualifying … \r`);
    }
  }
  console.log(`\nQualifying cars (enriched ≥${MIN_FILL} AND priced parts): ${bundles.length}`);

  if (bundles.length === 0) {
    console.log("Nothing to seed. Done.");
    return;
  }

  // 3. Which are already on prod? Best-effort: if the dest isn't reachable
  //    (functions not deployed / secret unset yet), a DRY RUN still reports the
  //    qualifying count without touching prod. import is idempotent, so even in
  //    --execute mode a missed peek only means already-present cars get skipped
  //    server-side rather than filtered here.
  const keys = bundles.map((b) => b.config_key);
  let already = new Set();
  try {
    const peek = await destClient.query(PEEK, { secret: SECRET, config_keys: keys });
    already = new Set(peek.existing);
    console.log(`Already on ${DEST}: ${already.size}.`);
  } catch (e) {
    console.log(
      `⚠︎ Could not check ${DEST} (${e.message ?? e}). ` +
        `Treating all as new — import is idempotent and skips any that already exist.`,
    );
  }
  const toCreate = bundles.filter((b) => !already.has(b.config_key));
  console.log(`New to import: ${toCreate.length}.`);

  // Sample preview
  console.log("\nSample (first 10 new):");
  for (const b of toCreate.slice(0, 10)) {
    console.log(
      `  • ${b.config_key}  (fill ${b.fill_rate}, ${b.priced_part_count} priced parts, ${b.fitment_count} fitments)`,
    );
  }

  if (!EXECUTE) {
    console.log(
      `\nDRY RUN — no writes. Re-run with --execute to import ${toCreate.length} cars into ${DEST}.`,
    );
    return;
  }

  // 4. Confirm, then import.
  if (!AUTO_YES) {
    const rl = createInterface({ input: stdin, output: stdout });
    const answer = await rl.question(
      `\nType "${DEST}" to import ${toCreate.length} cars into PROD: `,
    );
    rl.close();
    if (answer.trim() !== DEST) fail("Confirmation mismatch. Aborting.");
  }

  console.log("");
  let created = 0;
  let skipped = 0;
  let failed = 0;
  for (let i = 0; i < toCreate.length; i++) {
    const b = toCreate[i];
    try {
      const res = await destClient.mutation(IMPORT, { secret: SECRET, bundle: b });
      if (res.status === "created") created++;
      else skipped++;
      console.log(
        `  [${i + 1}/${toCreate.length}] ${res.status}  ${b.config_key}` +
          (res.status === "created"
            ? `  (parts ${res.parts}, prices ${res.price_rows})`
            : ""),
      );
    } catch (e) {
      failed++;
      console.log(`  [${i + 1}/${toCreate.length}] FAILED  ${b.config_key}: ${e.message ?? e}`);
    }
  }

  console.log(
    `\n=== Done === created ${created}, skipped ${skipped}, failed ${failed} on ${DEST}.`,
  );
}

main().catch((e) => fail(e.stack ?? e.message ?? String(e)));
