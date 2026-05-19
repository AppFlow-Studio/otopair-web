// Filters staging export to: 3 temur users (+ shop customers), Temur Auto & Motor
// shop and everything tied to it, ALL catalog + vehicle data passes through.
//
// Usage: node tmp/filter.mjs
// Reads:  tmp/staging/<table>/documents.jsonl
// Writes: tmp/filtered/<table>/documents.jsonl

import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const SRC = "tmp/staging";
const DST = "tmp/filtered";

// --- Seed sets ---------------------------------------------------------------
const TEMUR_USERS = new Set([
  "md719vjp3sjm77wcq3sg8s0b1h80be9n", // temur@appflowstudio.io
  "md7ajzcexe45gwt4s1948t8a5n817269", // temurbeksayfutdinov@gmail.com (shop_owner)
  "md7dxdavzz11d5v63x8eq25tt586fnt6", // temursayfutdinov3@gmail.com (shop_mechanic)
]);

// Helpers ---------------------------------------------------------------------
function readJsonl(table) {
  const p = join(SRC, table, "documents.jsonl");
  if (!existsSync(p)) return [];
  const raw = readFileSync(p, "utf8");
  if (!raw.trim()) return [];
  // Return both parsed object and original line text — we write the original
  // line on keep to preserve float vs int encoding (Convex distinguishes
  // v.float64() from v.int64() at import).
  return raw.split("\n").filter(Boolean).map((line) => ({ line, doc: JSON.parse(line) }));
}
function writeTable(table, items) {
  mkdirSync(join(DST, table), { recursive: true });
  const gs = join(SRC, table, "generated_schema.jsonl");
  if (existsSync(gs)) copyFileSync(gs, join(DST, table, "generated_schema.jsonl"));
  writeFileSync(
    join(DST, table, "documents.jsonl"),
    items.map((i) => i.line).join("\n") + (items.length ? "\n" : ""),
  );
}

// --- Derive KEEP sets --------------------------------------------------------
const shops = readJsonl("shops").map((i) => i.doc);
const KEEP_SHOPS = new Set(
  shops.filter((s) => TEMUR_USERS.has(s.owner_user_id)).map((s) => s._id),
);

const bookingsAll = readJsonl("bookings").map((i) => i.doc);
const CUSTOMER_USER_IDS = new Set();
for (const b of bookingsAll) {
  if (KEEP_SHOPS.has(b.shop_id) && b.user_id) CUSTOMER_USER_IDS.add(b.user_id);
}
const KEEP_USERS = new Set([...TEMUR_USERS, ...CUSTOMER_USER_IDS]);

const KEEP_BOOKINGS = new Set(
  bookingsAll
    .filter((b) => KEEP_SHOPS.has(b.shop_id) || KEEP_USERS.has(b.user_id))
    .map((b) => b._id),
);

const mechanicsAll = readJsonl("mechanics").map((i) => i.doc);
const KEEP_MECHANICS = new Set(
  mechanicsAll.filter((m) => KEEP_SHOPS.has(m.shop_id)).map((m) => m._id),
);

const vehicleOwnersAll = readJsonl("vehicle_owners").map((i) => i.doc);
const KEEP_VEHICLE_OWNERS = new Set(
  vehicleOwnersAll.filter((vo) => KEEP_USERS.has(vo.user_id)).map((vo) => vo._id),
);
const KEEP_VINS = new Set(
  vehicleOwnersAll.filter((vo) => KEEP_USERS.has(vo.user_id)).map((vo) => vo.vin),
);

const aiConvsAll = readJsonl("ai_conversations").map((i) => i.doc);
const KEEP_AI_CONVS = new Set(
  aiConvsAll.filter((c) => KEEP_USERS.has(c.user_id)).map((c) => c._id),
);

const paymentsAll = readJsonl("payments").map((i) => i.doc);
const KEEP_PAYMENTS = new Set(
  paymentsAll
    .filter((p) => KEEP_BOOKINGS.has(p.booking_id) || KEEP_USERS.has(p.user_id))
    .map((p) => p._id),
);

console.log(JSON.stringify({
  KEEP_USERS: KEEP_USERS.size,
  KEEP_SHOPS: KEEP_SHOPS.size,
  KEEP_MECHANICS: KEEP_MECHANICS.size,
  KEEP_BOOKINGS: KEEP_BOOKINGS.size,
  KEEP_VEHICLE_OWNERS: KEEP_VEHICLE_OWNERS.size,
  KEEP_VINS: KEEP_VINS.size,
  KEEP_AI_CONVS: KEEP_AI_CONVS.size,
  KEEP_PAYMENTS: KEEP_PAYMENTS.size,
}, null, 2));

// --- Filter rules per table --------------------------------------------------
// Default behavior: pass through. Tables listed here override.
const SCOPE = {
  users:                      (r) => KEEP_USERS.has(r._id),
  shops:                      (r) => KEEP_SHOPS.has(r._id),
  shop_users:                 (r) => KEEP_SHOPS.has(r.shop_id) && KEEP_USERS.has(r.user_id),
  shops_hours:                (r) => KEEP_SHOPS.has(r.shop_id),
  shop_services:              (r) => KEEP_SHOPS.has(r.shop_id),
  shop_portfolio:             (r) => KEEP_SHOPS.has(r.shop_id),
  shop_invitations:           (r) => KEEP_SHOPS.has(r.shop_id),
  shop_part_preferences:      (r) => KEEP_SHOPS.has(r.shop_id),
  block_time_types:           (r) => KEEP_SHOPS.has(r.shop_id),
  mechanics:                  (r) => KEEP_MECHANICS.has(r._id),
  time_slots:                 (r) => KEEP_SHOPS.has(r.shop_id),
  bookings:                   (r) => KEEP_BOOKINGS.has(r._id),
  booking_status_history:     (r) => KEEP_BOOKINGS.has(r.booking_id),
  job_actuals:                (r) => KEEP_BOOKINGS.has(r.booking_id),
  tire_quote_responses:       (r) => !r.booking_id || KEEP_BOOKINGS.has(r.booking_id),
  labor_quote_snapshots:      (r) => !r.booking_id || KEEP_BOOKINGS.has(r.booking_id),
  part_snapshots:             (r) => !r.booking_id || KEEP_BOOKINGS.has(r.booking_id),
  payments:                   (r) => KEEP_PAYMENTS.has(r._id),
  payment_status_history:     (r) => KEEP_PAYMENTS.has(r.payment_id),
  transactions:               (r) => !r.user_id || KEEP_USERS.has(r.user_id),
  ownership_credit_transactions: (r) => !r.user_id || KEEP_USERS.has(r.user_id),
  reviews:                    (r) =>
    (!r.user_id || KEEP_USERS.has(r.user_id)) &&
    (!r.shop_id || KEEP_SHOPS.has(r.shop_id)) &&
    (!r.mechanic_id || KEEP_MECHANICS.has(r.mechanic_id)) &&
    (!r.booking_id || KEEP_BOOKINGS.has(r.booking_id)),
  vehicle_owners:             (r) => KEEP_VEHICLE_OWNERS.has(r._id),
  vehicle_owner_specs:        (r) => KEEP_VEHICLE_OWNERS.has(r.vehicle_owner_id),
  // vehicle_passports is keyed by vin and has no user/shop FK — pass through (catalog-like)
  vehicle_driving_profiles:   (r) => KEEP_VEHICLE_OWNERS.has(r.vehicle_owner_id),
  vehicle_checkins:           (r) => KEEP_VEHICLE_OWNERS.has(r.vehicle_owner_id),
  vehicle_service_states:     (r) => !r.vehicle_owner_id || KEEP_VEHICLE_OWNERS.has(r.vehicle_owner_id),
  vehicle_health_snapshots:   (r) => !r.user_id || KEEP_USERS.has(r.user_id),
  maintenance_records:        (r) => KEEP_VEHICLE_OWNERS.has(r.vehicleOwnerId),
  spec_confirmations:         (r) => !r.user_id || KEEP_USERS.has(r.user_id),
  spec_variances:             (r) => !r.user_id || KEEP_USERS.has(r.user_id),
  follow_ups:                 (r) => !r.user_id || KEEP_USERS.has(r.user_id),
  notifications:              (r) => !r.user_id || KEEP_USERS.has(r.user_id),
  notification_outbox:        (r) =>
    (!r.user_id || KEEP_USERS.has(r.user_id)) &&
    (!r.booking_id || KEEP_BOOKINGS.has(r.booking_id)) &&
    (!r.shop_id || KEEP_SHOPS.has(r.shop_id)),
  preferences:                (r) => !r.user_id || KEEP_USERS.has(r.user_id),
  user_settings_preferences:  (r) => KEEP_USERS.has(r.user_id),
  user_saved_addresses:       (r) => KEEP_USERS.has(r.user_id),
  user_mechanic_preferences:  (r) => KEEP_USERS.has(r.user_id) && (!r.mechanic_id || KEEP_MECHANICS.has(r.mechanic_id)),
  user_contribution_claims:   (r) => KEEP_USERS.has(r.user_id),
  user_reward_wallets:        (r) => KEEP_USERS.has(r.user_id),
  user_semantic_facts:        (r) => !r.user_id || KEEP_USERS.has(r.user_id),
  onboarding_questions_answers: (r) => KEEP_USERS.has(r.user_id),
  onboarding_question_answers:  (r) => KEEP_USERS.has(r.user_id),
  referrals:                  (r) => KEEP_USERS.has(r.referrer_user_id) && KEEP_USERS.has(r.referee_user_id),
  ai_conversations:           (r) => KEEP_AI_CONVS.has(r._id),
  ai_messages:                (r) => KEEP_AI_CONVS.has(r.conversation_id),
  ai_feedback:                (r) => !r.user_id || KEEP_USERS.has(r.user_id),
  analytics_events:           (r) => !r.user_id || KEEP_USERS.has(r.user_id),
  conversion_funnels:         (r) => !r.user_id || KEEP_USERS.has(r.user_id),
  app_feedback:               (r) => !r.user_id || KEEP_USERS.has(r.user_id),
  bugs:                       (r) => !r.user_id || KEEP_USERS.has(r.user_id),
  client_logs:                (r) => !r.user_id || KEEP_USERS.has(r.user_id),
  customer_late_alerts:       (r) => !r.booking_id || KEEP_BOOKINGS.has(r.booking_id),
  customer_late_monitors:     (r) => !r.booking_id || KEEP_BOOKINGS.has(r.booking_id),
  late_start_monitors:        (r) => !r.booking_id || KEEP_BOOKINGS.has(r.booking_id),
  overrun_checkins:           (r) => !r.booking_id || KEEP_BOOKINGS.has(r.booking_id),
  job_overrun_checkins:       (r) => !r.booking_id || KEEP_BOOKINGS.has(r.booking_id),
  jobs:                       (r) => (!r.user_id || KEEP_USERS.has(r.user_id)) && (!r.shop_id || KEEP_SHOPS.has(r.shop_id)),
  jobRecommendations:         (r) => !r.user_id || KEEP_USERS.has(r.user_id),
  pending_service_submissions:(r) => !r.user_id || KEEP_USERS.has(r.user_id),
  smartcar_connections:       (r) => !r.user_id || KEEP_USERS.has(r.user_id),
  audit_log:                  (r) => !r.user_id || KEEP_USERS.has(r.user_id),
  stripe_webhook_events:      () => false, // drop — staging-specific
  reward_deals:               () => true,  // catalog
  odometer_history:           (r) => !r.user_id || KEEP_USERS.has(r.user_id),
};

// --- Process every table folder ---------------------------------------------
if (existsSync(DST)) rmSync(DST, { recursive: true, force: true });
mkdirSync(DST, { recursive: true });

// copy top-level files (README.md, _tables/)
for (const entry of readdirSync(SRC, { withFileTypes: true })) {
  if (entry.isFile()) {
    copyFileSync(join(SRC, entry.name), join(DST, entry.name));
  }
}

const tables = readdirSync(SRC, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

const report = [];
for (const table of tables) {
  const items = readJsonl(table);
  const before = items.length;
  let kept;
  if (table === "_tables") {
    kept = items;
  } else if (SCOPE[table]) {
    kept = items.filter((i) => SCOPE[table](i.doc));
  } else {
    kept = items;
  }
  writeTable(table, kept);
  if (before !== kept.length || before > 0) {
    report.push({ table, before, after: kept.length });
  }
}

// Print non-trivial filtered tables
console.log("\nFiltered tables (rows changed or non-empty):");
for (const r of report.sort((a, b) => b.before - a.before)) {
  const tag = r.before !== r.after ? "FILTERED" : "passthru";
  console.log(`  [${tag}] ${r.table.padEnd(32)} ${r.before} -> ${r.after}`);
}

// --- Orphan-FK detector ------------------------------------------------------
// Scan every kept row for fields ending in _id/Id/Ids that look like Convex IDs.
// If a value matches an ID format and is missing from the kept-id index, flag.

console.log("\nBuilding kept-ID index for orphan check...");
const KEPT_IDS_BY_TABLE = {};
for (const table of tables) {
  if (table === "_tables") continue;
  const docs = readJsonl(table)
    .filter((i) => (SCOPE[table] ? SCOPE[table](i.doc) : true))
    .map((i) => i.doc);
  KEPT_IDS_BY_TABLE[table] = new Set(docs.map((d) => d._id));
}
const ALL_KEPT_IDS = new Set();
for (const s of Object.values(KEPT_IDS_BY_TABLE)) for (const id of s) ALL_KEPT_IDS.add(id);

// Tight Convex ID heuristic: lowercase alphanumeric, exactly 32 chars.
const idLike = (v) => typeof v === "string" && v.length === 32 && /^[a-z0-9]+$/.test(v);
const fkFieldName = (k) => /_id$|Id$|_ids$|Ids$/.test(k);

const orphans = {};
for (const table of tables) {
  if (table === "_tables") continue;
  const docs = readJsonl(table)
    .filter((i) => (SCOPE[table] ? SCOPE[table](i.doc) : true))
    .map((i) => i.doc);
  for (const row of docs) {
    for (const [k, v] of Object.entries(row)) {
      if (k === "_id" || k === "_creationTime") continue;
      if (!fkFieldName(k)) continue;
      const vals = Array.isArray(v) ? v : [v];
      for (const val of vals) {
        if (idLike(val) && !ALL_KEPT_IDS.has(val)) {
          orphans[table] ||= {};
          orphans[table][k] = (orphans[table][k] || 0) + 1;
          break;
        }
      }
    }
  }
}

if (Object.keys(orphans).length === 0) {
  console.log("\nOrphan-FK check: PASS — no kept rows reference dropped IDs.");
} else {
  console.log("\nOrphan-FK check: found references in kept rows to IDs not in any kept table:");
  for (const [table, fields] of Object.entries(orphans)) {
    for (const [field, count] of Object.entries(fields)) {
      console.log(`  ${table.padEnd(32)} ${field.padEnd(28)} ${count} row(s) with orphan ref`);
    }
  }
}
