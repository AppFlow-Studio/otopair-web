# Otopair Internal Portals — P0 Implementation Plan
**Date:** 2026-07-11 · **Synthesized from:** agent1 (cartographer), agent2 (schema/deployment reality), agent3 (counters), agent4 (auth/shell), agent5 (gap & scope) — full evidence files under `scratchpad/evidence/` of this run.

> **Deployment note (per team decision):** `dev:third-bird-914` — the default deployment at the repo root — is treated as the authoritative deployment for all data claims in this document; it plays the role the specs call "ahmad." The Convex project's `--prod` deployment was probed read-only and confirmed near-empty (shops 0, bookings 0, service_categories 7 — agent2 §2 CONFIRMED). Every count below labeled CONFIRMED was measured on third-bird-914 on 2026-07-11 unless explicitly labeled `--prod`.

---

## 1. Feasibility verdict

### OPS — **GREEN** (build now; foundations are sprint-1 tickets, not spec revisions)
The director panel already IS a proto-Ops portal: 19 tabs, ~12k lines, working TOTP auth, working write-ceremony + audit pattern (agent1 §1, CONFIRMED). Ops P0 is ~60% REGROUP/EXTEND. The three numbers: **95 bookings / 49 payments / 22 users** (agent3, CONFIRMED via countTable) — consumer tables are tiny, so realtime tiles are plain indexed window queries; **26+** `requireDirector` call sites already enforce the session boundary (agent4 §1a, CONFIRMED); **0 missing indexes** on any P0-cited table (agent2 §1a, CONFIRMED). Two build-time caveats, neither a spec revision: the existing Overview backend is full-table `.collect()` and must be rewritten (agent3 §0.1, CONFIRMED — it violates ops-v2's own DoD at :772), and the bookings board columns must come from the **measured** status set, not the spec's fictional enum (agent2 §1c, CONFIRMED).

### SHOPS — **AMBER** (build now, demo later; pre-task = decision #1)
Code-wise, Shops P0 is EXTEND (TabShops 582 ln, all six detail-tab data sources queryable today — agent1 §4). The blocker is data, not code: the spec was validated against a network of **38 shops / 87 mechanics / 41 shop_users**; third-bird-914 holds **9 shops (8 synthetic "Spec V2 Validation Shop") / 4 mechanics / 2 shop_users** (agent2 §2, agent4 §1d, CONFIRMED). The P0 exit test ("new shop created→bookable via portal alone") builds fine against synthetic data but cannot be *demonstrated meaningfully* until decision #1 resolves where the real network lives. Pre-tasks: (a) locate the 38-shop deployment (ardent-crab-641 or a true daniel/ahmad deployment), (b) design the ID-remapping selective seeder (does not exist; clone script is wholesale + destructive — agent2 §3).

### DATA — **AMBER** (build after two schema pre-tasks; spec numbers stale but architecture sound)
The enrichment side is where third-bird-914 is rich: **enrichment_evidence 28,420 rows** (the count run fired Convex's 32k read-limit warning — agent3 §0.3, CONFIRMED), part_fitments 4,638, vin_queue 936, enrichment_runs 412. Pre-tasks before page work: (1) `portal_stats` cron materialization (decision #3) — any `.collect()`-based SLO/asset counter over evidence is weeks from hard failure; (2) the `review_queue` table (decision #4) — it does not exist; the thing named `manual_review_queue` is a deprecated shim doing an unbounded collect over enrichment_runs (agent1 §3, CONFIRMED manual_review_queue.ts:5-14). Also net-new: vin_queue has **zero** query functions (agent1 §3, CONFIRMED) despite 4 ready indexes. Not RED because all four review streams exist and are queryable today, and the three director trigger mutations exist (needing per-VIN + ceremony + cooldown extension per data-v2.1:803).

---

## 2. The five decisions, armed

### Decision #1 — Deployment topology & prod seeding
**Evidence:** third-bird-914 was cloned from `dev:ardent-crab-641` (scripts/clone-convex-deployment.sh defaults, CONFIRMED) — the deployment diagnoseVin.ts:6 calls "the BUGGED deployment." It does **not** contain the 38-shop network (9/4/27/2 measured vs 38/87/874/41 specced — CONFIRMED, agent2 §2). `--prod` is near-empty but **already holds 7 service_categories with prod-local IDs** (CONFIRMED) and **0 director_users / 0 shop_users** (CONFIRMED, agent4 §1d) — cutover starts from an empty auth surface and a naive catalog import would conflict.
**Recommendation:** (a) This week, off the critical path: identify which deployment actually holds the 38-shop network; (b) build a selective, ID-remapping seeder (the clone script is dev→dev and destructive — unusable for prod); (c) bundle the 7→4 category rewrite INTO the prod seeding migration, not after it (INFERRED from measured prod state, agent2 §3); (d) treat all Shops demos on third-bird-914 as synthetic-data demos until then.
**Unblocks:** Shops P0 exit test, prod cutover plan. Does NOT block any page construction.

### Decision #2 — Internal admin auth
**Evidence:** The specs' "Clerk organization roles, enforced twice" is fiction — zero Clerk org API usage, and the six spec role names appear nowhere in app/, convex/, or lib/ (agent4 §1b, CONFIRMED grep). Real auth is director_* email+TOTP sessions gated server-side by `requireDirector` (directorGate.ts:20-35) on 26+ call sites; `/director` is public in middleware (middleware.ts:17). **Critical gap: `requireDirector` never reads `role` — a `viewer` session can invoke any director mutation today** (agent4 §1a, CONFIRMED).
**Recommendation (adopt agent4's plan wholesale):** KEEP director_* sessions as the internal backbone; widen `director_users.role` to the six spec roles with a one-shot mapping migration (superadmin→super_admin, admin→ops_admin, viewer→readonly); add a capability parameter to `requireDirector` + a `directorMutation` write-ceremony wrapper + a UI `can()` helper. Middleware stays UX-only (matching directorGate.ts's own doctrine). Retire the hollow `(admin)` Clerk stub (3 placeholder pages, zero Convex calls — agent1 §1, CONFIRMED). Clerk stays customer/shop-staff identity, untouched.
**Unblocks:** every write surface (rate ceremony, deletion queue, data triggers), the shell, and closes a live security hole.

### Decision #3 — KPI counter architecture
**Evidence:** Existing overview layer = full-table `.collect()` over 7 tables per render (directorOverview.ts:46-146, director.ts:6-66 — CONFIRMED), violating ops-v2:772's own DoD. Consumer tables are tiny (95/49/22); enrichment_evidence at 28,420 already fired the read-limit warning. `@convex-dev/aggregate` is NOT installed and would force a codebase-wide customMutation pattern (CONFIRMED zero convex-helpers hits); 14 active cron jobs prove the materialization pattern (crons.ts:75-199, CONFIRMED).
**Recommendation (agent3's split, adopted by agent5):** **R1** — realtime KPIs = plain indexed window queries (all needed indexes CONFIRMED present); **R2** — unbounded/lifetime aggregates = `portal_stats` table + paginated cron summarizer (5-15 min for SLO tiles, daily for asset counters), Slack breach push via notification_outbox; **R3** — rewrite the existing collect() overview onto R1+R2. Defer the aggregate component until any single window read exceeds ~5-10k docs. Total ≈ 24-42h (agent3 §3 cost table).
**Unblocks:** all three Overviews, sidebar badges, Data SLO tiles.

### Decision #4 — review_queue materialization
**Evidence:** No `review_queue` table exists (CONFIRMED). All four feeder streams exist and are queryable: consensus needs_review (enrichment_evidence/enrichment_runs), mechanic corrections (mechanic_verifications 15 + part edits 20 + labor edits 6 rows live), fact_reports (table + writer + resolver exist, **0 rows**), spec_confirmations/variances (tables + queries exist, **0 rows**) — agent2 §5, all CONFIRMED with file:line.
**Recommendation:** Materialize the thin table exactly per data-v2.1:756-759 (source_stream enum consensus|correction|report|survey, entity refs, priority/status/assignee, indexes by_status/by_source_stream/by_assignee) + 4 idempotent per-stream backfills keyed on source doc IDs. Day-1 volume is consensus + corrections only (streams 3-4 are empty). One trivial new query needed: fact_reports list-open (by_disposition index ready).
**Unblocks:** Data Review Queue page + the D3 SLO tile. Nothing else waits on it.

### Decision #5 — 7→4 service category mapping
**Evidence:** Dev has **8** categories (a phantom "Maintenance", display_order 99, **0 services** — CONFIRMED); prod has exactly 7 (CONFIRMED `--prod`). The 4 target names exist **nowhere** — Jun 22 locked the count and the 23-service set, not the names (CONFIRMED grep of all four spec texts + repo). Four code sites hard-code the 7: oto/tools.ts:116-124 & :1001-1009, maintenance_pipeline.ts:158, seeds/seedServices.ts (CONFIRMED).
**Recommendation:** Adopt agent2's mechanical strawman (Appendix C): Diagnostics & Inspections / Maintenance & Fluids / Tires & Wheels / Brakes — 5 services flagged for Yassin (battery_test, battery_replacement, brake_fluid_flush, timing_belt, pre_purchase_inspection). Delete the phantom 8th. **The only hard dependency is Yassin naming the 4 — chase this Monday.** Execute bundled with prod seeding (decision #1).
**Unblocks:** prod catalog seeding, P1 migration workspace. Blocks no P0 page (P0 renders whatever categories exist).

---

## 3. Scope summary

**P0 grand total ≈ 315-540h → a 6-9 week program for 3 people, not a sprint** (agent5 §4). Per portal: Shell 87-150h (agent4 §4) · Ops ≈ 58-98h pages · Shops ≈ 54-94h pages · Data ≈ 94-156h pages, plus non-page seeder (16-32h) + 7→4 migration (12-20h).

**Per owner (after agent5's rebalance — chips moved off Daniel, review_queue/Network Overview stay Waleed):** Temur ≈ 104-170h · Waleed ≈ 88-158h · Daniel ≈ 123-210h pre-rebalance → ~100-175h each post-rebalance. Daniel was overloaded 25-40% in the raw assignment (agent5 §4); the sprint tables below encode the rebalance.

**What fits in the first two sprint cycles (Mon–Thu, Thu–Mon ≈ 7 working days ≈ 150-170 person-hours):** all foundations (route skeleton, role enforcement, portal_stats, review_queue table), shell primitives (ceremony, sidebar/switcher, env banner), ⌘K, the Ops Overview backend rewrite, and the Deletion queue. **What does not fit:** every L page — Users detail, Bookings board, Payments regroup, all Shops pages, Control Room, Catalog workspace, Labor CC, Data SLO Overview, Review Queue UI — these are backlog-P0, weeks 3-9.

**Critical path (ordered):**
1. F2 Route skeleton (12-20h, Temur) — blocks every page.
2. F1 Role enforcement / decision #2 (16-24h, Temur) — blocks every write surface.
3. F3 portal_stats / decision #3 (10-18h, Waleed, parallel with F1) — blocks Overviews/badges only.
4. Ops exit-test chain: → Users Detail (20-32) ∥ Bookings (16-28) ∥ Payments (8-14) → Deletion queue ≈ **52-84h serial**.
5. Shops chain: → wrappers → Detail tabs 1-6 ≈ **58-94h serial** (+decision-#1 demonstrability risk).
6. Data chain: → wrapper layer → Catalog badges ∥ Labor ladder ∥ Control Room ≈ **48-80h serial**.
7. F4 review_queue anytime before Review Queue UI; F5/F6 are decision-procurement (Yassin's names, network location) — chase immediately, they gate seeding, not code.

**Decide before page work starts:** the styling system — Tailwind-v4 unification vs the director CSS-var system. The director panel is inline-style, not Tailwind (agent1 finding #2, CONFIRMED); this silently prices every REGROUP row.

---

## 4. Sprint 1 & 2 proposal

Machine-readable version: `reports/tickets.json`. Sizes S ≤4h · M ≤2d · L ≤1wk. Sprint cycles are short (Mon–Thu / Thu–Mon); L tickets marked * are expected to span both cycles.

### Sprint 1 (Mon–Thu)
| Title | Portal | Class | Size | Owner | Depends on | Exit check |
|---|---|---|---|---|---|---|
| Shell route skeleton and session provider | shell | EXTEND | M | Temur | — | /ops, /shops, /data App-Router routes render behind director TOTP session; legacy /director untouched |
| Role enforcement and capability gate * | shell | EXTEND | L | Temur | — (decision #2 signed Monday) | readonly session gets `forbidden` from a money mutation in a test; role-mapping migration applied on dev; zero call sites left on the role-less gate |
| portal_stats KPI infrastructure | shell | NET-NEW | M | Waleed | — (decision #3 signed Monday) | portal_stats rows for users-total and evidence-count refresh on cron; summarizer paginates enrichment_evidence without read-limit warning |
| Environment banner | shell | NET-NEW | S | Daniel | — | Banner shows deployment slug + color from NEXT_PUBLIC_CONVEX_URL on every portal page |
| Command palette and cross-entity search * | shell | NET-NEW | L | Daniel | Shell route skeleton and session provider | ⌘K finds a user by email, shop by name, booking by id and navigates to its detail route |

### Sprint 2 (Thu–Mon)
| Title | Portal | Class | Size | Owner | Depends on | Exit check |
|---|---|---|---|---|---|---|
| Write ceremony and audit drawer primitive | shell | EXTEND | M | Temur | Role enforcement and capability gate | softDeleteUser flows through shared ceremony (reason required) and the resulting audit_log row renders in the drawer |
| Sidebar, portal switcher, and badges | shell | EXTEND | M | Temur | Shell route skeleton and session provider; portal_stats KPI infrastructure | 240px sidebar with 3 nav trees; badge counts from indexed reads/portal_stats, zero .collect() |
| Ops Overview backend rewrite | ops | EXTEND | M | Daniel | portal_stats KPI infrastructure; Shell route skeleton and session provider | Overview tiles served by indexed window queries + portal_stats; directorOverview collect() scans retired |
| Deletion queue page | ops | NET-NEW | S | Daniel | Shell route skeleton and session provider | Pending-deletion users listed via by_isPendingDeletion with oldest-age pill; restore runs through ceremony |
| review_queue table and stream backfills * | data | NET-NEW | L | Waleed | — (decision #4 signed Monday) | Table populated from consensus + correction streams; re-running any backfill inserts zero duplicates |

### Backlog-P0 (weeks 3+, ordered by critical path)
Users list and detail (L, Daniel) · Bookings board/list/detail (L, Daniel — requires status-set sign-off with Waleed) · Payments + detail (M, Daniel) · Entity chips (M, Daniel) · Shops directory + detail tabs 1-6 (L, Daniel) · Stripe health read view (M, Daniel) · Shops network overview (L, Waleed) · Data SLO overview + Slack (M, Waleed) · Pipeline control room (L, Temur) · Catalog + config workspace with layer badges (L, Temur) · Labor command center (M, Temur) · Locate real network + prod seeding plan (M, Waleed, decision #1) · 7-to-4 category migration (M, Waleed, decision #5 + Yassin's names). Full rows in `tickets.json`.

---

## 5. Risk register

| # | Risk | Likelihood/Impact | Mitigation |
|---|---|---|---|
| R1 | **The 38-shop network may not exist anywhere current** — third-bird-914 was cloned from the "BUGGED" ardent-crab-641 and holds 9 shops (CONFIRMED). Shops portal could ship with nothing real to show. | Med / High | Resolve deployment archaeology in week 1 (non-code task); build Shops pages against synthetic data; hold exit-test demo until seeder lands. |
| R2 | **Live security gap until F1 lands:** any `viewer` director session can invoke any mutation today (CONFIRMED, agent4 §1a). | Certain (exists now) / High | Role enforcement is sprint-1; interim: audit director_users membership (2 rows incl. an undeleted Bootstrap superadmin — flag for cleanup). |
| R3 | **Counter refactor blast radius:** the collect() overview layer is load-bearing for the legacy panel; rewriting it while 18 legacy tabs still consume it risks regressions. | Med / Med | R3 rewrite lands behind new ops module; legacy tabs keep old queries until each tab is re-housed; enrichment_evidence (28,420, warning fired) is the deadline clock. |
| R4 | **Seeding production is destructive-by-default:** the only existing mechanism (clone script) wipes its target; prod already has 7 categories with prod-local IDs; Convex IDs are deployment-specific (CONFIRMED/INFERRED, agent2 §3). | Med / High | Build the selective ID-remapping seeder as its own reviewed ticket; bundle 7→4; never point the clone script at prod. |
| R5 | **Schema drift between deployments:** dev has a phantom 8th category prod lacks; spec live-numbers (vin_queue 584, labor_observations 91) are stale vs measured (936; labor_times 2,688). | High / Med | Treat third-bird-914 as sole source of truth per team decision; re-measure before seeding; delete phantom category in the 7→4 migration. |
| R6 | **Hash-SPA→routes conversion tax** hidden in the route skeleton + 18-tab migration (agent4 S1/S8) — estimates could balloon. | Med / Med | Tabs survive as "legacy" under /ops initially (agent4 S8); convert per-page as each P0 page lands. |
| R7 | **bookings.status is an unvalidated v.string()** with a status set that contradicts the spec; board built on the wrong columns would need rework. | Med / Med | Status-set sign-off with Waleed before board ticket starts; derive columns from measured set + bookings.ts state machine; enum validator is a follow-up, not P0. |
| R8 | **Styling-system split** (Tailwind v4 app vs inline CSS-var director panel) reprices every REGROUP row if decided late. | High / Med | Decide Monday alongside the five gating decisions. |
| R9 | **Daniel overload** (123-210h raw vs ~100-170h peers). | High / Med | Rebalance encoded in sprint plan (chips deferred, Hours/Calendar tabs candidate to shift to Waleed). |
| R10 | **OBSERVATION — `.env.local` contains live-looking secrets in the working tree** (Clerk keys, deployment URLs; agent2 §2 read it for topology evidence). It is untracked/ignored by convention but sits in a repo directory multiple agents and scripts read. | — / High if leaked | Rotate any key that is production-scoped; confirm .gitignore coverage; move deploy keys to a secrets manager before cutover work begins. |
| R11 | **⌘K has no backing query anywhere** — cross-entity search is invented from scratch; scope creep magnet. | Med / Low | Constrain P0 to id/email/name exact-ish lookups over existing indexes; defer fuzzy/search-index work. |

---

## 6. Spec errata (corrections required to keep the v2 documents truthful)

1. **ops-v2 §2 (:87-89):** replace "roles live in Clerk as organization roles… enforced twice" with the director_* session model + capability gate (decision #2). The six role names exist nowhere in code (CONFIRMED).
2. **ops-v2 bookings sections (~:296-300):** replace the assumed status enum (confirmed/in_progress/…) with the measured set: pending, pending_quote, quotes_ready, vehicle_at_shop, completed, cancelled, no_show (CONFIRMED, 95 rows).
3. **ops-v2 §7 + shops-v2 §6 proposed tables:** annotate that `admin_audit_log`/`admin_notes` duplicate existing `audit_log`/`director_notes` (extend, don't duplicate); `stripe_account_status` is derivable from stripe_webhook_events + shops fields (CONFIRMED absent/partial per agent2 §1b).
4. **ops-v2 DoD (:772):** note that the existing overview layer it inherits violates it (directorOverview.ts collect() scans) — rewrite is in-scope, not optional.
5. **shops-v2 Appendix A.1 (:552-553):** the "ahmad holds 38/87/874/41" measurement does not describe third-bird-914 (9/4/27/2 CONFIRMED); the network's location is an open question (decision #1).
6. **ops-v2 migration table (:744-747):** shop-staff roles are Clerk user publicMetadata + shop_users rows, not org roles.
7. **data-v2.1 (:297):** vin_queue "584 live" → 936 measured; "labor_observations 91" conflates two tables — labor_times (2,688) is the ladder table.
8. **data-v2.1 review-queue sections:** `manual_review_queue` is a deprecated shim (unbounded collect over enrichment_runs), not an existing queue table.
9. **Category sections (all specs):** dev holds 8 categories (phantom "Maintenance", 0 services); prod holds 7; the 4 target names were never chosen — Jun 22 locked count + 23 services only.
10. **audit_log index name:** spec's `by_actor` is deployed as `by_actor_id` (CONFIRMED); shops-v2's `by_shop` cites map to `by_shop_id` variants.
11. **data-v2.1 trigger DoD (:803):** the three existing trigger mutations are per-config with no ceremony/cooldown — spec should say "extend," not "exists."
12. **Cutover sections:** prod is not cleanly empty (7 categories, prod-local IDs) and has zero director_users/shop_users — cutover plans must start from an empty auth surface and a conflicting catalog.

---

# Appendices

## Appendix A — Full page-by-page verdict table (agent5 §1, verbatim adoption)

Sizes: S ≤4h · M ≤2d · L ≤1wk. "Blocked by" = gating decision #.

| Page | Portal | Class | Missing queries | Missing indexes | Missing schema | Blocked by | Size | Owner |
|---|---|---|---|---|---|---|---|---|
| Shell: route skeleton + layout + session provider | all | EXTEND | none | none | none | #2 | M (12-20h) | Temur |
| Shell: sidebar 240px + switcher + badges | all | EXTEND | sidebarCounts rewrite off `.collect()` | none | none | #3 | M (8-14h) | Temur |
| Shell: ⌘K palette + cross-entity search | all | NET-NEW | cross-entity search (nothing exists) | possibly search indexes | none | — | L (16-28h) | Daniel |
| Shell: entity chips + hover preview | all | NET-NEW | light per-entity summaries | none | none | — | M (8-14h) | Daniel |
| Shell: write-ceremony + audit drawer primitive | all | EXTEND | none | none | audit_log field extension | #2 | M (8-12h) | Temur |
| Shell: role enforcement (capability map + gate ext + can()) | all | EXTEND | none | none | director_users.role widening + migration | #2 | L (16-24h; 26+ call sites/6 files) | Temur |
| Shell: env banner | all | NET-NEW | none | none | none | — | S (3-6h) | Daniel |
| Shell: KPI infra (portal_stats + summarizer + crons + Slack) | all | NET-NEW | summarizer internalMutation | new-table by_key | portal_stats | #3 | M (10-18h) | Waleed |
| Overview | ops | EXTEND (backend REWRITE) | replace collect scans w/ R1 windows + portal_stats | none | portal_stats | #3 | M (10-16h) | Daniel |
| Users list + detail (4 tabs) | ops | EXTEND | Money-tab join (payments/transactions queries exist) | none | none | — | L (20-32h) | Daniel |
| Bookings board/list/detail | ops | EXTEND | board columns per measured status set | none | none | status sign-off | L (16-28h) | Daniel |
| Payments + detail | ops | REGROUP | none (directorStripe ×5 exist) | none | none | — | M (8-14h) | Daniel |
| Deletion queue | ops | NET-NEW | listPendingDeletions (index ready) | none | none | — | S-M (4-8h) | Daniel |
| Network Overview | shops | NET-NEW | full network KPI module | none | portal_stats; shop_onboarding rule deferred P2 | #3, #1 | L (16-30h) | Waleed |
| Directory + Shop Detail tabs 1-6 | shops | EXTEND | director-gated wrappers; rate ceremony | none | defer shops.owner_* (read via shop_users) | #1 (exit test), #2 | L (30-50h) | Daniel |
| Stripe Health read view | shops | REGROUP | none | none | stripe_account_status NOT needed | — | M (8-14h) | Daniel |
| Overview: 5 SLO tiles + Slack | data | NET-NEW | D1-D5 in summarizer; outbox producer | none | portal_stats; review_queue (D3) | #3, #4 | M (10-18h) | Waleed |
| Pipeline Control Room | data | EXTEND | wrappers over internalQueries; vin_queue queries (zero exist) | none | none | — | L (24-40h) | Temur |
| Catalog + config workspace w/ layer badges | data | REGROUP/EXTEND | per-field provenance/badge query (index exists) | none | none | #3 (fill stats only) | L (24-40h) | Temur |
| Review Queue (materialized) | data | NET-NEW | list/claim/resolve + fact_reports list-open + 4 backfills | new-table indexes | review_queue table | #4 | L (24-40h) | Waleed |
| Labor Command Center | data | EXTEND | ladder effective-value query; verify labor_times.source tagging (OPEN CHECK) | none | possible source backfill | — | M-L (12-20h) | Temur |

**Printed disagreements (both positions preserved):**
- **Ops Overview:** agent1 = REGROUP ("7 queries exist") vs agent3 = those queries collect entire tables and violate ops-v2:772's DoD. Agent5 and this plan side with agent3: EXTEND with mandatory backend rewrite.
- **Data triggers:** agent1 = "AS-IS" vs data-v2.1:803 DoD requiring per-VIN + ceremony + cooldown; existing mutations are per-config with neither. This plan sides with EXTEND.
- **Shops Directory:** EXTEND at the code layer (agent1) AND undemonstrable at the data layer (agent2) — both true; decision #1 blocks the exit test, not the build.

## Appendix B — Index verification table (agent2 §1a; ALL PRESENT, CONFIRMED)

schema.ts: 4,777 lines, **142 tables, 439 indexes** (CONFIRMED mechanical extraction). Schema↔deployment sync INFERRED from function-spec (1,374 functions incl. current-repo-only ones). **Zero missing indexes on existing tables → no add-index migration is a P0 pre-task.**

| Table | P0-relevant indexes (all CONFIRMED in schema.ts) |
|---|---|
| bookings | by_status, by_shop_and_status, by_scheduled_date, by_created_at, by_user_id, by_shop_id, by_shop_and_date, by_user_and_status, by_payment_approval_state, by_sla_expires_at |
| payments | by_status, by_idempotency_key, by_booking_id, by_user_id, by_stripe_payment_intent_id, by_created_at, by_receipt_token |
| time_slots | by_shop_and_date, by_availability, by_shop_id, by_mechanic_id, by_series_id |
| follow_ups | by_status_and_scheduled |
| enrichment_evidence | by_entity_field |
| part_fitments | by_vehicle_config, by_part, by_config_service, by_config_service_package |
| vin_queue | by_vin, by_status, by_source_status, by_year |
| users | by_clerkUserId, by_isPendingDeletion, by_email, by_claim_token |
| transactions | by_user_id_created_at, by_user_id_type, by_user_id_type_created_at, by_payment_id |
| shop_services / mechanics / shops_hours / shop_users / shop_invitations | by_shop_id families + by_user_and_shop, by_shop_and_role, by_token, by_email |
| conversion_funnels / analytics_events / client_logs | by_funnel_type, by_stage, by_event_type, by_timestamp, by_level |
| reviews / vehicle_owners / oem_parts | by_rating, by_user_status, by_part_number |
| audit_log | by_entity, by_created_at, **by_actor_id** (spec says by_actor — errata #10) |
| ai_conversations / ai_messages | by_session_id, by_started_at, by_conversation_id |

New-table indexes needed only for net-new tables: portal_stats (by_key), review_queue (by_status, by_source_stream, by_assignee).

## Appendix C — 7→4 category mapping proposal (agent2 §4, strawman for Yassin)

Measured reality (CONFIRMED): dev 8 categories (7 + phantom "Maintenance", 0 services, display_order 99); prod 7; 23 services across 7 in-use categories; the 4 target names exist nowhere.

| New (proposed name) | Absorbs | Services (n) |
|---|---|---|
| 1. Diagnostics & Inspections | Diagnostics + Compliance | diagnostic_scan, pre_purchase_inspection, check_engine_light, state_inspection, emissions_test (5) |
| 2. Maintenance & Fluids | Routine Maintenance + Fluids + Battery(part) | oil_change, filter_replacement, spark_plugs, timing_belt, coolant_flush, transmission_service, power_steering_flush, differential_service, fuel_system_cleaning, battery_replacement (10) |
| 3. Tires & Wheels | Tires | tire_rotation, tire_balance, wheel_alignment, tire_replacement (4) |
| 4. Brakes | Brakes | brake_pad_replacement, rotor_replacement, brake_fluid_flush (3) |
| (delete) | phantom "Maintenance" (0 services); Battery (emptied) | battery_test → proposed Diagnostics & Inspections (1) |

Flagged for Yassin: battery_test, battery_replacement, brake_fluid_flush, timing_belt, pre_purchase_inspection. Code sites to change with the migration (CONFIRMED): convex/oto/tools.ts:116-124 & :1001-1009, convex/maintenance_pipeline.ts:158, convex/seeds/seedServices.ts. Execution bundles into prod seeding (prod holds 7 rows with prod-local IDs — INFERRED conflict risk, agent2 §3).

## Appendix D — Counter-metric inventory (agent3 §1, ~40 aggregates)

Freshness: RT realtime · MIN minutes · DAY daily. Architecture column applies the R1/R2 split.

**Ops (O1-O17):** Bookings today (RT, R1 by_created_at) · GMV today (RT, R1) · Platform revenue today (RT, R1) · Active users 7d (MIN, R2) · Failed payments 24h (RT, R1 by_status) · Pending deletions (RT, R1 by_isPendingDeletion) · Live activity feed (RT, R1 merged histories) · Needs-attention ×4 (MIN, R2) · Funnel 7d (MIN, R2) · Users count pill (MIN, **R2** — unbounded) · Per-user vehicle/booking counts (RT, R1 per-row) · Deletion queue pill+age (RT, R1) · Board column counts (RT, R1 by_status) · Follow-ups strip (MIN, R2, P1) · Oto AI strip (MIN, R2, P1) · Reconciliation mismatches (MIN, R2, P1) · Error sparkline (MIN, R2, P2).

**Shops (S1-S15):** Active shops/mechanics (RT, R1 — tables of 9/4) · Bookings wk (RT, R1) · Network GMV wk (RT, R1) · Avg rating lifetime (MIN, **R2**) · Slot utilization 7d (MIN, R2 network / R1 per-shop) · League table 7d (MIN, R2) · Needs-attention ×5 (MIN, R2; stalled-onboarding rule deferred P2 — needs shop_onboarding table) · Directory per-shop stats (MIN, R1 bounded) · Header quick stats (RT, R1) · Onboarding pipeline (RT, deferred with table) · Mechanic cards (MIN, R1) · Capacity heatmap 14d (MIN, R2) · Integrity checks (MIN, R2 join sweep) · Offerings matrix (RT, R1 — 23×9 tiny) · Data-feedback badges (MIN, R1).

**Data (D1-D17):** D1 success rate 7d (MIN, R2; 412 runs cheap) · D2 avg confidence (MIN-DAY, **R2 mandatory** — 28,420 rows, read-limit warning fired) · D3 queue depth (RT, R1 on new review_queue index) · D4 variance rate (MIN, R2) · D5 confirmation rate (MIN, R2) · D6 asset counters (DAY, **R2 mandatory**) · D7 pipeline strip (MIN, R2) · D8 vin_queue backlog/histogram (RT-MIN, R1 by_status + R2 histogram) · D9 attention list (MIN, R2) · D10 review throughput (MIN, R2) · D11 fill rings (DAY, R2) · D12 source registry (MIN, R1 — already denormalized per-row) · D13 cache hit-rate (DAY, R2) · D14 labor ledger (MIN, R2) · D15 coverage matrix (DAY, R2) · D16 blast-radius (RT, R1 bounded per part) · D17 costs (DAY, R2).

Measured base counts (CONFIRMED via countTable/overviewMetrics, 2026-07-11): bookings 95 · payments 49 · transactions 43 · users 22 · shops 9 · mechanics 4 · reviews 24 · analytics_events 81 · time_slots 7,369 · vin_queue 936 · enrichment_runs 412 · vehicle_configs 384 · labor_times 2,688 · part_fitments 4,638 · **enrichment_evidence 28,420 (warning fired at 32k cap)**. overviewMetrics CLI round-trip 3.085s.

## Appendix E — Auth evidence matrix (agent4)

| Surface | Mechanism | Enforced where | Role enforced? | Evidence |
|---|---|---|---|---|
| /director (internal admin) | director_* email+TOTP → 8h session token in localStorage | Server-side per Convex fn: requireDirector (directorGate.ts:20-35), 26+ call sites/6 files; middleware.ts:17 marks route PUBLIC | **NO** — role stored (superadmin/admin/viewer) but never read by the gate | CONFIRMED file:line throughout agent4 §1a |
| /admin (Clerk stub) | Clerk sessionClaims.metadata.role === "admin" | Middleware only; pages are hollow stubs, zero Convex calls | Middleware-only | CONFIRMED middleware.ts:58,128-131; agent1 §1 |
| Shop portal | Clerk user publicMetadata roles (shop_owner/shop_mechanic/mechanic/front_desk/admin) + shop_users membership | Middleware route matrices + server-side requireShopStaff (bookings.ts:4003+, ~20+ uses) | Yes (route + membership) | CONFIRMED agent4 §1b/1c |
| Clerk org roles (spec model) | — | — | — | **DOES NOT EXIST**: zero org API usage; six spec role names appear nowhere (CONFIRMED grep) |

Row realities (CONFIRMED): director_users dev = 2 (incl. stale Bootstrap superadmin); shop_users dev = 2; `--prod` director_users = 0, shop_users = 0. Spec role → today mapping: super_admin↔superadmin (unenforced), ops_admin↔admin, readonly↔viewer, support/data_admin/shop_success = absent.

---

**Effort traceability:** every hour range above originates in agent3 §3 (counter costs), agent4 §4 (shell tickets S1-S8), or agent5 §1/§4 (page table + owner loads); classifications from agent1 §4 as amended by agent5's printed disagreements.
