# Otopair — Waleed Work Status

**Owner:** Waleed Mansour (Notion accounts: `mrdogsog@gmail.com` + `mansourwaleed06@gmail.com` — both yours)
**Last updated:** 2026-06-09
**Branch:** `waleed-flagship`
**Scope:** everything done on the `otopair-web` side (web app + Convex backend). Mobile-app items are flagged as out-of-repo.

This doc is the single source of truth for: ✅ done · 🟡 partial · ⬜ not started — and for the partial/not-started items, *what's left and who owns it*. It cross-references the Notion "Otopair" board so stale statuses can be corrected.

---

## ✅ DONE (this branch, committed + verified)

### 1. Parts pricing — deterministic extractor + cross-source median
`convex/vehicleEnrichment/priceParser.ts`, `part_prices.ts`, `lib/robustStats.ts`
- Reads the real sale price from raw HTML structured data (JSON-LD → microdata → per-domain DOM), killing the "You Save $X" bug. Validated to-the-cent against live pages.
- Quote-time median behind `PARTS_PRICE_SOURCE=median` (default `average`, reversible).
- **Verified live:** repricing a 2020 BMW oil change lifted the filter from unpriced → $17.66.

### 2. Service-time / labor — VDB de-throned, robust median
`convex/lib/labor_aggregation.ts`, `labor_observations` table, cron `recompute-recent-labor`
- VDB is now one low-weight vote; `book_hours` = robust median across observations; post-job actuals override at ≥3 samples.
- **Caveat → see Partial §A:** the new `labor_observations` table is empty until enrichment re-runs; the data isn't flowing yet.

### 3. Service Parts Reference — per-role resolution + full fluid pricing  *(commit `9025ad0`)*
`convex/lib/servicePartsReference.ts`, `lib/partRoleQuantity.ts`, `serviceParts.ts`, `booking_quotes.ts`
- The 23-service PDF is encoded; selection now runs **per part role** (oil + filter + washer each priced) instead of one-winner-per-service — fixed a real under-pricing bug.
- Fluids multiply by capacity (oil 4.5qt → 5 bottles) with an auditable `quantity_basis`.
- 8 labor-only services can never bill parts; universal consumables (grease/washers/DOT4) seeded.
- 42 new unit tests; adversarial review (5 findings, all fixed).

### 4. Director per-config backfill buttons  *(commit `98bf93f`)*
`convex/directorConfigBackfills.ts`, `TabVehicleConfigs.tsx`
- Three buttons on each vehicle config: **Re-enrich entire car** / **Backfill parts only** / **Reprice parts only**.
- **Verified live** on dev.

### 5. In-app Oto — beta-feedback behavior fixes  *(validated live via the new simulation)*
`convex/oto/prompt/stable.ts` (v0.27) + `volatile.ts` (v0.18), `envelope.ts`, `chat.ts`
- **Wrong-car / "who is this Lexus?"** — `pickActiveVehicleRow` no longer silently defaults to the newest car; the locked conversation anchor wins, an unmatched picker VIN refuses to guess (asks instead). (Schema-precedence regression from the first attempt was caught in review and fixed.)
- **Over-interrogation guardrail** — counter is now server-derived (was model-self-tagged and never firing); threshold 6 → 4; booking-offer turns don't inflate it.
- **Talk less / one question per turn** + **prefer tappable chips over essays**.
- **Always-available "Just book a mechanic" chip** during narrowing.
- **Breakdown / no-tow expectation set early.**
- **Plain-language jargon** ("turn over" → "does it try to start?", "trouble codes" → "reads what the car logged").
- **Close-the-loop-after-booking** rule.
- **Knowledge-level adaptation** — onboarding `car_knowledge_level` now flows into the `<user>` envelope and scales answer complexity (beginner ↔ experienced).
- **Live proof (Waleed = beginner):**
  - "broke down on the highway, won't start" → set no-tow expectation up front, plain language, answer-first.
  - "brakes squealing when I slow down" → **one** question + chips ["Mostly at first", "Throughout the stop", "It varies", **"Just book a mechanic"**].

### 6. Oto authenticated simulation harness  *(new — unblocks testing)*
`convex/oto/simulate.ts` (`internalAction simulateOtoMessage`)
- Drives a full, real Oto turn as any user by fabricating that user's identity, calling the same `sendMessageHandlerCore` production uses. Callable from Convex MCP / scripts / a future director test panel. Internal-only (never public) since it impersonates by design.

### 7. Parts price re-extraction — domain-agnostic two-tier + poison-exclusion median  *(2026-06-09, dev-verified)*
`convex/vehicleEnrichment/priceReextract.ts` (new), `priceParser.ts`, `part_prices.ts`, `convex/lib/priceTypes.ts` (new), `directorConfigBackfills.ts`, `v3pipeline.ts`, `prompts/batch2Prompt.ts`, `devOnly/verifyParts.ts`
- **The fix for the remaining wrong prices.** §1's deterministic parser only covered sites with structured data (~19/35 on the test Jetta); the rest stayed `online_discount` (captured MSRP / "was" / "You Save"). New `reextractPartPrice` = Tier 1 `parsePartPrices` → **Tier 2 LLM** (`callClaudeExtractOnly` on the page's own markdown, prompted to reject MSRP/was/struck/"You Save", + guardrails: price>0, price<msrp, OEM match, [0.3×,3×] cross-source median). **NO per-domain rules.**
- **Reprice action** now two-pass (build cross-source median, then re-extract each row): verified → `sale`, unverifiable → **`unverified`** (excluded from the median, kept for audit — the chosen Tier-3 policy).
- **Aggregation guardrail:** `summarizePartPrices` (pure `summarizePriceRows`) excludes poison types (`online_discount`/`you_save`/`unverified`), keeps `sale`/`llm_estimate`/`manual_seed`/legacy-untyped — so a wrong row can no longer pollute any quote.
- **Batch-2** routes itemized prices through the same helper behind **`PARTS_REEXTRACT_BATCH2=on`** (off by default; one fetch per itemized part) + unconditional Batch-2 prompt hardening.
- **16 unit tests** (`tests/priceReextract.test.ts`, `tests/partPriceAggregation.test.ts`); `npx tsc -p convex` clean.
- **Verified live (Jetta):** `online_discount` **16 → 0** (4 recovered to `sale`, 12 → `unverified`), `sale` 19 → 23. Per-row, not per-domain.

---

## 🟡 PARTIAL — started, with a clear remaining list

### A. Labor-time validation + "data-good" signal  *(Notion: In progress — correct)*
**Done:** robust-median aggregation system built (§2).
**Left:**
- [ ] Re-run enrichment so `labor_observations` actually populates (currently 0 rows).
- [ ] Validate labor times against KBB + other sources on the known-vehicle set.
- [ ] Emit the "data is good" signal that gates cross-validation with Temur's pricing engine.
- **Owner:** Waleed. Feeds Temur's "Pricing — build strictly to spec."

### B. Parts/pricing rollout (deploy + backfill)
**Done:** all code + flags + reversible backfills, verified on dev. Plus (§7) the two-tier re-extraction that corrects `online_discount` rows in place + the poison-exclusion median — dev-verified on the Jetta (`online_discount` 16 → 0).
**Left (in order):**
- [ ] Run live backfills on `temurbek`/prod: orphan-fitment delete → service-role stamp → position fix.
- [ ] Run the per-config **reprice** across the catalog so the two-tier fix corrects every `online_discount` row (4→sale / rest→unverified), and re-enrich so the 16 new fluid/part fields populate.
- [ ] Flip `PARTS_PRICE_SOURCE=median` after shadow-diff sign-off.
- [ ] **(optional) `PARTS_REEXTRACT_BATCH2=on`** to also verify fresh-enrichment prices at the source (adds a fetch per itemized part).
- [ ] **(optional) Retire/reroute `diagnoseVin.ts`'s 4 `online_discount` writers** — dead from the pipeline (CLI-only) but a foot-gun that would re-mint poison if run.
- [ ] **(data-quality) Re-discover product `source_url`s** for the ~5 parts stuck `unverified` on `shop.advanceautoparts.com` etc. (their stored URLs look like category/anti-bot pages).
- [ ] Deploy to `temurbek`/prod.

### C. Oto guided-experience  *(Notion: "Not started" — STALE, the logic half is done)*
**Done (Waleed/logic):** one-question-per-turn, chips-by-default, persistent "Just book a mechanic" escape (§5) — all live-verified.
**Left (Ahmad/UI, mobile):**
- [ ] Pin the recommended service as the top card with a one-line reason.
- [ ] Mobile renderer for the quick-reply chips + escape button (the `quickReplies` payload is already returned by the backend).
- **Action:** flip this Notion card to **In progress** (logic shipped) — UI remains.

### D. Onboarding knowledge → Oto  ✅ *(Notion: now flipped to **Done**)*
**Done:** `car_knowledge_level` piped into Oto's prompt; answer complexity scales by level; verified live (Waleed = beginner). `convex/oto/onboarding_questions_answers.ts:getCarKnowledgeLevelForUser` + envelope + prompt rule.
**Scale CONFIRMED 1–3** from temurbek production data (not assumed): `1` = "I prefer things explained to me" → beginner, `2` = "I know some stuff" → intermediate, `3` = "I'm car-savvy" → experienced. The `knowledgeLabel` mapping was already correct; comment locked to the confirmed scale.
**Left (not Waleed/Oto):** AB ensures onboarding writes the level for all users (4 have it on temurbek so far).

### E. 11 Labs Flagship Landing Page  *(Notion: In progress — correct)*
**Done:** the conversational hero exists and is committed (`app/(marketing)`, `components/flagship/*`).
**Left:** AB owns the 11 Labs voice integration + deep-link handoff; Waleed's read-only Convex MCP exposure is built.

---

## ⬜ NOT DONE — and where it actually lives

### F. Oto — mechanic-chat impersonation (P0 trust)  🟡 *(Oto-side SHIPPED; Notion → In progress)*
**Clarified with you:** the real bug was a "Chat with a mechanic" button that seeded the chat, and Oto then **impersonated the mechanic**. The `role` field already exists (user/assistant), so this is a behavior fix, not a schema change.
**Done + verified live (this session):** new hard prompt rule — Oto is **always Oto**, never role-plays/speaks as a mechanic or shop, even when asked to "chat with a mechanic." One short honest line, **no soft-deny**, then pivots to a real action. Test: *"I want to chat with my mechanic about my brakes"* → *"You're talking to Oto, Otopair's assistant — I'm not the shop, but I can get you booked…"* Commit `f9ef474`.
**Left (app-side, not otopair-web):**
- [ ] Remove the "Chat with a mechanic" button (app team).
- [ ] Mobile labeled-sender "Oto · Otopair Assistant" bubble treatment.

### G. Health-score "fake tips" loading screen  *(P0 from beta)*
- **Not in otopair-web.** No tip array / factoid generator anywhere in `convex/`, `app/`, or `components/`. The strings are a mobile UI list.
- **Fix (mobile):** replace generic tips with what we're actually doing for the user's car, or cut them.

### H. Per-service "?" explanation sheet  *(Notion: Not started — Ahmad)*
- Mobile bottom-sheet term explainer; pre-filled content (Daniel) + Oto fallback. Not a web task.

---

## Direct answers

- **"Is the Oto stuff almost done?"** — The **logic/backend** Oto work (the part that's yours and lives in this repo) is in strong shape and live-verified: conversation behavior, car-binding, guardrail, no-tow, jargon, knowledge-level adaptation, plus a simulation harness to keep testing it. What remains is (1) the **mobile UI** for chips/pinned card/labeled-sender bubbles (Ahmad), (2) the **impersonation** fix (cross-cutting, partly mobile), and (3) deploy. So: backend ~done, end-to-end "done" needs the mobile half + the impersonation work.
- **"Did we finish anything?"** — Yes: items 1–6 above are done and verified. The two clearest Notion stale-status fixes are *Oto guided-experience* (logic shipped) and *Oto AI Backend* (built & live) both marked "Not started," plus *Onboarding→Oto* now mostly done.

---

## Notion sync — ✅ APPLIED (Jun 8 2026, via the connected Notion plugin, as Waleed)
Each card was updated with a status change **and** a detailed progress note (commit refs + live-test evidence).
| Notion card | Was | Now |
|---|---|---|
| Feed onboarding knowledge level into Oto | Not started | ✅ **Done** (wired, scale-confirmed 1–3, verified) |
| Oto — Guided quick-replies / one-question / escape hatch | Not started | 🟡 **In progress** (logic shipped; mobile UI left) |
| Oto AI — Backend + Frontend | Not started | 🟡 **In progress** (backend live) |
| Oto — mechanic-chat impersonation | Bugs / Stuck | 🟡 **In progress** (Oto-side fix shipped; app-side UI left) |
| Labor-time validation + data-good signal | In progress | kept (accurate) |

**Notion read limitation (still true):** even with the plugin connected, the available Notion tools have **no bulk row-query** — only semantic search (capped) + per-page fetch. So a full whole-board count requires enumerating page-by-page; the updates above target the specific items verified this session.

> **Notion tooling caveat:** the available Notion integration this session has no row-query/SQL tool and can't bulk-filter the board by assignee — only semantic search (capped) + per-page fetch. So this list covers the items I could positively identify, not a guaranteed-complete board audit. A filtered "Waleed — by Status" view can be created in Notion to see the full set directly.
