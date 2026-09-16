# Shop Service Price Ranges Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let shops configure either fixed prices or min/max price ranges per offered service and vehicle group, while customers see and pay against the normalized range and the existing $20 booking hold remains unchanged.

**Architecture:** Extend the existing `shop_service_fixed_prices` rows additively with optional low/high cent fields and normalize legacy fixed rows through one shared helper. Offered Services gets a replacement-save API and dual local drafts; onboarding retains the legacy fixed mutation. Quote computation and mobile consumers receive normalized `{ lowCents, highCents, isFixed }` values so equal endpoints behave exactly like fixed prices.

**Tech Stack:** Convex, TypeScript, Next.js 16/React 19, Expo/React Native, Vitest, Tailwind CSS.

---

### Task 1: Normalize persisted shop pricing

**Files:**
- Create: `convex/lib/shopServicePricing.ts`
- Create: `tests/shopServicePricing.test.ts`
- Modify: `convex/schema.ts`
- Modify: `convex/shopServiceFixedPrices.ts`

- [ ] Write failing tests for legacy fixed rows, unequal ranges, equal ranges, malformed partial ranges, and min-greater-than-max ranges.
- [ ] Run `npm test -- tests/shopServicePricing.test.ts` and confirm the new module is missing or tests fail.
- [ ] Add `normalizeShopServicePrice(row)` returning `{ lowCents, highCents, isFixed } | null` with strict integer-cent and bounds checks.
- [ ] Make `price_cents` optional and add optional `price_low_cents` / `price_high_cents`, with a comment explaining the legacy table name now covers both modes.
- [ ] Add `listPricingForShop`, `replacePricingForService`, and `getPricingForBooking`; preserve `listForShop`, `setFixedPricesForService`, and `getForBooking` for fixed-only callers.
- [ ] Validate full range pairs, reject minimums above maximums, permit equal endpoints, clear old rows on replacement save, and keep declined-tier rails and audit logging.
- [ ] Re-run the focused test and Convex typecheck.

### Task 2: Apply normalized ranges to quotes and directory data

**Files:**
- Modify: `convex/lib/quoteEngine.ts`
- Modify: `convex/booking_quotes.ts`
- Modify: `convex/customJobs.ts`
- Modify: `convex/shopsDirectory.ts`
- Modify: `lib/disclosedRange.ts`
- Modify: `lib/shopPriceLabel.ts`
- Create or modify focused tests under `tests/`

- [ ] Add failing unit tests for fixed, range, equal-range, mixed-service, and fallback calculations.
- [ ] Replace direct `price_cents` reads with `normalizeShopServicePrice`.
- [ ] Generalize disclosed override lines from one price to low/high endpoints, subtract generated labor/parts for overridden services, and add the configured endpoints.
- [ ] Use the midpoint only where a single provisional quoted set price is required; retain `is_fixed_price` for equal endpoints and expose range metadata without changing the $20 authorization.
- [ ] Format equal endpoints as one price and unequal endpoints as a range in directory/label helpers.
- [ ] Run focused tests and Convex typecheck.

### Task 3: Build the Offered Services price-mode editor

**Files:**
- Create: `components/shop/service-price-tier-strip.tsx`
- Modify: `app/(portal)/settings/services-editor.tsx`
- Modify: `components/shop/fixed-price-tier-strip.tsx` only for shared exports if necessary
- Create: `tests/servicePriceTierStrip.test.ts`

- [ ] Write failing pure-function tests for draft conversion, dirty detection, incomplete pairs, min/max validation, and equal range endpoints.
- [ ] Build an accessible segmented Fixed price / Price range control using the current portal typography, colors, focus styles, and responsive layout.
- [ ] Keep separate fixed and range drafts per service so toggling before Save never loses input.
- [ ] Show four shop-facing vehicle groups; use one currency input for fixed mode and Minimum/Maximum inputs for range mode.
- [ ] Reject invalid/incomplete range pairs before writes, leave blank groups on standard estimates, and summarize saved equal ranges as a single price.
- [ ] Save through the replacement mutation so inactive persisted fields are removed; reset to the server baseline.
- [ ] Run focused tests, ESLint for touched portal files, and TypeScript checking.

### Task 4: Surface normalized prices throughout the mobile booking flow

**Files:**
- Create: `G:/GitHub/otopair/lib/shopServicePricing.ts`
- Modify: `G:/GitHub/otopair/hooks/useShopFixedPricesForServices.ts`
- Modify callers in `G:/GitHub/otopair/components/booking-flow/ShopPage.tsx`, `app/(booking-flow)/choose-mechanic.tsx`, `components/booking/sheets/ShopCard.tsx`, `components/booking/ServiceBottomSheet.tsx`, `components/booking/sheets/ReviewPayContent.tsx`, and `app/booking/mechanic/[id]/payment.tsx`
- Modify: `G:/GitHub/otopair/lib/disclosedRange.ts`
- Modify: `G:/GitHub/otopair/lib/shopPriceLabel.ts`
- Create focused mobile tests under `G:/GitHub/otopair/tests/`

- [ ] Write failing tests for normalized hook conversion and mobile amount/range formatting and aggregation.
- [ ] Rename/generalize the hook contract to service pricing while keeping a compatibility export if useful.
- [ ] Display a single amount and Fixed price treatment for equal endpoints; display `$low–$high` for unequal endpoints.
- [ ] Ensure shop overrides replace generated service math in lists, sheets, review, and payment totals, including mixed fixed/range/fallback selections.
- [ ] Confirm the payment flow still authorizes exactly $20 and does not authorize the range maximum.
- [ ] Run mobile focused tests, lint/typecheck relevant files.

### Task 5: Synchronize shared Convex code and verify both applications

**Files:**
- Synchronize applicable `convex/` files from web to `G:/GitHub/otopair/convex/`
- Review generated API typings in both repositories

- [ ] Use the repository sync workflow or a scoped patch so shared Convex source is byte-identical without overwriting mobile-only `convex/oto` work.
- [ ] Regenerate Convex types if needed and inspect generated diffs before retaining them.
- [ ] Run full web tests/lint/typecheck and mobile tests/lint/typecheck; run targeted builds if feasible.
- [ ] Compare shared Convex directories for drift and explicitly verify `convex/oto` remains identical.
- [ ] Review `git diff --check`, both worktree statuses, and the final diff for unrelated changes.

## Execution Results

- Implemented all five tasks in `otopair-web` and `otopair`.
- Added 18 focused passing web assertions and 3 focused passing mobile assertions.
- Touched-file ESLint passes without errors; existing warnings remain in older files.
- Shared changed Convex files and `convex/oto` are byte-identical between repositories.
- Convex typechecking reaches the synchronized pre-existing `convex/oto/vehicleHealth.ts` error (`currentOdometer` is not in `BuildMergedMaintenanceInput`) with no pricing errors reported.
- Full suites remain red from unrelated baseline failures: web has 62 failures across 17 files; mobile has 39 failures across 11 files plus one teardown error.
