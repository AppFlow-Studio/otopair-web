# Shop Service Price Ranges Design

## Goal

Allow a shop to choose either a fixed total or a minimum/maximum total for each offered catalog service and vehicle group. Customer-facing Otopair surfaces must use the shop-authored endpoints, while existing standard quote ranges and the existing $20 booking hold remain unchanged.

## Confirmed Decisions

- Pricing mode is selected once per service, not once per vehicle group.
- The four existing shop-facing vehicle groups remain unchanged and continue mapping to the seven internal vehicle tiers.
- Switching modes before Save preserves both drafts in browser state.
- Saving persists only the active mode and deletes the inactive mode's stored values.
- A range group is either completely blank or has both minimum and maximum values.
- Save rejects an incomplete pair and rejects `minimum > maximum`.
- Equal range endpoints are allowed. They remain editable under Price range in Settings but resolve everywhere else as a fixed price and display as one amount.
- Blank groups fall back to the existing standard quote range.
- Tax and platform fees are calculated on top of the shop-entered labor-plus-parts endpoints.
- The existing $20 authorization is unchanged for fixed prices, shop ranges, and standard ranges.
- No per-group fixed/range toggle, new dependency, or new pricing table will be added.

## Existing Range Systems and Why They Are Not the Storage Target

The codebase already has several range representations, but each has a different owner and lifecycle:

- `service_options.parts_cost_low/high` and `service_vehicle_specs.parts_cost_low/high` are platform-generated parts-only bands.
- `pricing_baselines.base_price_low/high` are director-managed global pricing-engine inputs.
- `ccb_absolute_prices.price_low/high` are global carbon-ceramic-brake bands.
- `bookings.disclosed_range_low/high` is the immutable customer contract produced after service prices, taxes, and fees are combined.
- Tire and rotor quote ranges are one-off booking quotes.

None is a reusable shop-authored, per-service, per-vehicle-tier override. `shop_service_fixed_prices` already has that ownership, indexing, authorization, audit logging, tier mapping, and quote-engine precedence. Extending it is the smallest coherent change.

## Data Model

Keep the legacy table name `shop_service_fixed_prices` for compatibility. Add a prominent schema and module comment explaining that the table now stores both fixed prices and shop-authored ranges despite its historical name.

Each row remains keyed by `(shop_id, service_id, tier)` and contains exactly one active representation:

- Fixed: `price_cents` is present.
- Range: `price_low_cents` and `price_high_cents` are present.

All money is stored as integer cents. The schema makes the three price fields optional for rollout compatibility, while server mutations enforce the valid row shapes. Existing rows containing required `price_cents` remain valid without migration.

Do not add `pricing_mode` to `shop_services`. The editor infers the active service mode from saved rows: any saved low/high row means Price range; otherwise any fixed row means Fixed price; a service with no custom pricing defaults to Fixed price. Consequently, saving an entirely blank Price range mode clears custom pricing and later reopens in Fixed price mode; both states use the same standard quote behavior.

## Persistence API

Retain existing fixed-price queries/mutations during rollout so older mobile builds and shop onboarding continue to work.

Add a richer settings query that returns, per service and tier, the stored representation and normalized endpoints. Add one replacement settings mutation accepting:

- shop and service IDs;
- active mode (`fixed` or `range`);
- a complete per-tier snapshot where each tier is either null or normalized `{ low_cents, high_cents }`.

The mutation validates authorization, declined tiers, money rails, complete pairs, and `low <= high`. In one transaction it deletes all existing pricing rows for that shop/service and inserts only nonblank rows in the active representation. Fixed-mode normalized endpoints must be equal and are stored as `price_cents`; range-mode endpoints are stored as low/high even when equal. Audit detail records the selected mode and applied endpoints.

Add an additive booking query returning normalized `{ low_cents, high_cents }` per requested service for the customer's resolved vehicle tier. Keep the legacy fixed-price booking query returning only true fixed rows for older clients.

## Shared Resolution Rules

Create one small backend helper that normalizes a row to `{ lowCents, highCents, isFixed }`:

- legacy/new fixed row: low = high = `price_cents`;
- range row: low = `price_low_cents`, high = `price_high_cents`;
- equal range endpoints: `isFixed = true`;
- malformed/partial row: no override, allowing the standard quote path to run.

Use the helper in every direct consumer of `shop_service_fixed_prices`, including:

- quote-engine service pricing;
- disclosed booking-range computation;
- booking quoted-set-price reconciliation;
- custom catalog jobs;
- shop directory/director pricing summaries;
- mobile booking lookup.

This prevents each caller from inventing its own legacy/range branching.

## Quote and Booking Behavior

For a resolved shop override, the entered endpoints represent the full pre-tax service total, including labor and parts. The standard labor and parts contributions for that service are removed to prevent double billing, then the normalized endpoints are added to the booking's low/high totals. Taxes and platform fees are recomputed independently at both endpoints.

The quote engine returns the normalized low/high values. Equal endpoints retain the existing fixed-price flag and label. Unequal endpoints receive a shop-range override flag and range label.

Generalize the existing per-service fixed-price line metadata used by `computeDisclosedRange` and `computeQuotedSetPrice` into shop-price override metadata carrying both endpoints. Quoted-set-price calculation excludes raw OEM snapshot totals for every overridden service and uses the override midpoint; for equal endpoints this is the fixed amount. The resulting quoted set price must remain at or below the disclosed maximum.

Preserve the existing `is_fixed_price` behavior for equal-endpoint overrides and add an optional `has_shop_price_range` booking flag when at least one unequal shop-authored range contributed. Existing booking range snapshots remain the monetary source of truth after creation; the boolean is display metadata only.

## Shop Portal UI

Under Offered Services, replace the current Fixed prices button with the draft's two-option service-level control:

- Fixed price
- Price range

Opening the active control reveals the existing four vehicle groups. Fixed mode shows one currency input per group. Range mode shows Min and Max currency inputs per group plus concise copy that the exact total cannot exceed the saved maximum without further approval. The copy must continue to state that tax and fees are added at checkout and that only a $20 hold is placed at booking.

Draft state keeps separate fixed and range values for the current editing session. Switching modes does not discard either draft. Save validates all active range pairs before calling the backend; failed validation leaves the save manager dirty and focuses or identifies the invalid group. Reset restores the last server snapshot.

Badges summarize the active saved/draft state as fixed groups or range groups. Declined vehicle groups remain disabled exactly as they are today.

Shop onboarding may keep its current fixed-price-only editor. Its existing API remains supported; this request changes Offered Services in Settings.

## Mobile App Behavior

Replace the fixed-only booking hook with a shop-service-pricing hook returning a map of normalized `{ low, high, isFixed }` dollar values.

All current fixed-price consumers must use the normalized endpoints:

- shop selection cards and shop pages;
- booking service sheet footer;
- Review & Pay sheet;
- full payment screen;
- booking confirmation state.

For each overridden service:

- equal endpoints show one amount and fixed-price treatment;
- unequal endpoints show `$low – $high` and shop-range treatment;
- OEM parts may still be listed, but their raw prices do not add to the overridden service total;
- labor is not added again because the shop-entered endpoints already include labor and parts.

Mixed bookings sum each line's endpoints. Fixed lines contribute the same value to both totals, shop ranges contribute their saved endpoints, and services without overrides retain the existing generated range. Existing labor-only handling remains the fallback only when no shop override exists.

The Convex schema and backend files remain byte-synchronized between `otopair-web` and `otopair`; mobile-only hooks and React Native surfaces change only in `otopair`.

## Error Handling and Compatibility

- Server validation is authoritative even though the portal validates before submission.
- Prices must remain within the existing $1–$100,000 rails at both endpoints.
- Declined tiers cannot receive an override.
- Partial or malformed legacy rows are ignored rather than producing a zero price.
- Old fixed rows work without migration.
- Older mobile builds continue receiving fixed rows through the legacy query and simply do not consume new range rows.
- Saving a service in one mode atomically removes the other mode, preventing mixed persisted representations.
- The existing payment authorization, cancellation, approval-ceiling, and final-capture flows are not changed.

## Testing and Verification

Use test-driven development for each behavior:

- Conversion/validation tests for fixed values, complete ranges, partial ranges, `low > high`, blank groups, and equal endpoints.
- Backend resolver tests covering legacy fixed, unequal range, equal range, malformed rows, and standard fallback.
- Quote/disclosed-range tests proving labor and OEM parts are not double-counted and mixed bookings aggregate endpoints correctly.
- Quoted-set-price tests proving override midpoint behavior stays below the disclosed maximum.
- Portal component/helper tests for mode switching, draft preservation, save-time inactive-mode clearing, and validation messages.
- Mobile range/label tests for fixed, shop range, standard range, mixed bookings, and labor-only precedence.
- Source/integration checks ensuring every former fixed-only callsite consumes normalized pricing.

Before completion, run targeted tests, full Vitest suites in both repositories, lint/type checks for touched files, Convex validation/code generation, and the repository Convex drift checks. Re-read both working trees immediately before edits and before final verification because the shared backend is synced between repositories.
