# Parts real-primary — endpoint as an averaged per-unit fallback point Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Price a service's parts off REAL per-config data — per role, prefer gathered SKU prices, fall back to the RepairPal endpoint average, and fall back to Camry×multiplier only when a role has neither — gated behind a default-off flag so nothing changes prod until flipped + shadow-diff-reviewed.

**Architecture:** The endpoint parts (already in `repairpal_endpoint_estimates`) are written into `part_prices` as **per-unit POINTS** (`price = total_price_avg ÷ quantity`, `source_domain="repairpal_endpoint"`, a distinct `price_type` that the existing pooled aggregator EXCLUDES so booking_quotes / serviceParts / job_actuals are untouched). `resolvePartsCost` gains a flag-gated real-band block (after CCB, before Camry): for each CORE fitment it POOLS the gathered SKU per-unit prices WITH the endpoint per-unit point (peers — the endpoint is appended to the role's price pool), multiplies the pooled `[min,max]` by the config's resolved quantity (`resolveRoleQuantity`), and sums to a per-config TOTAL band. A role is reliable when it has SKU prices (≥ threshold) OR the endpoint point; only when a core role has NEITHER does the whole service fall back to the Camry×multiplier path. `buildQuote` bypasses unit-scaling for that band (it's already a per-config total, like CCB).

**Tech Stack:** Convex (TypeScript queries/mutations/actions), vitest (pure helpers) + convex-test (db functions), direct `fetch` already done upstream. Flag read via `process.env` (mirrors `quoteUnitPrice`'s `PARTS_PRICE_SOURCE`).

---

## Design decisions locked for v1 (confirm before building)

1. **Endpoint price is a total-for-quantity, NOT per-unit.** `repairpal_endpoint_estimates.parts[].price_low/high` comes from RepairPal `total_price` (e.g. `{low:52.44, high:206.4}` for `quantity:6` plugs). `part_prices.price` is per-SKU-unit. So we store `average ÷ quantity` as the per-unit point. `resolvePartsCost` then re-multiplies by the CONFIG's resolved quantity — which auto-corrects engine-sibling cylinder mismatches.
2. **Per role, SKU prices and the endpoint point are POOLED as peers** (the endpoint is "appended to the average"): the role's price band spans the gathered SKU prices + the endpoint per-unit point. When a role has no SKU prices, the endpoint point stands alone (the safety net). A service is "real-quotable" iff EVERY core fitment has at least one real price (SKU or endpoint); otherwise the whole service falls back to Camry×multiplier (never mix real + fallback within one service).
3. **Write is contained, not gated.** Endpoint rows carry `price_type="repairpal_endpoint"`, excluded from `summarizePriceRows`' pooled aggregate, so booking_quotes / serviceParts / job_actuals are unaffected by the write. Only `resolvePartsCost`'s new gated block reads them. (The rows MUST exist before the shadow-diff can run, which is why the write is not behind the consumption flag.)
4. **Consumption is gated:** `PARTS_SOURCE_REAL_PRIMARY` (default OFF, `=== "on"`). When OFF, `resolvePartsCost` output is byte-identical to today (the `parts_fallback_multiplier` flag is only added when the flag is ON), so the LOCKED Pricing-Spec-v2 behavior is untouched until flip.
5. **v1 scope = consumables; brakes/per_axle deferred.** `resolvePartsCost` skips the real path for `brake_pad_replacement` / `rotor_replacement` and any `parts_kind === "per_axle"` service (front-only endpoint + booking-position scaling don't compose with the bypass-scale model). They keep the multiplier — and the proof shows the multiplier UNDER-calls brakes, so fallback is the conservative choice. Easy to add in v2.
6. **Only CORE fitments count** toward the real band (core = on every invoice; `as_needed`/`kit` are discovery/variant — excluded, matching servicePartsReference semantics). Universal-consumable core roles carry a `manual_seed` SKU price, so they resolve via SKU.

**Open risk to validate in the shadow-diff (Task 9):** the quantity round-trip (`÷ endpoint.quantity` at write, `× resolveRoleQuantity` at read). For `per_cylinder` and `fluid` roles these should agree closely; fixed-n roles are exact. The shadow-diff must spot-check spark_plugs, coolant_flush, filter_replacement, oil_change totals against the endpoint totals.

---

## File Structure

- `convex/vehicleEnrichment/repairpalEndpointMatch.ts` — ADD pure `endpointRoleToSubcategory(role, position)` (endpoint vocab → `oem_parts.subcategory`/roleKey). Used ONLY by the write.
- `convex/lib/partsBand.ts` — REWRITE `aggregatePartsBand` to the per-role precedence + per-config-total model. Pure; re-unit-tested.
- `convex/lib/priceTypes.ts` — ADD `REPAIRPAL_ENDPOINT_PRICE_TYPE` + a NON-POOLED exclusion the aggregator respects.
- `convex/part_prices.ts` — `summarizePriceRows` EXCLUDES non-pooled price types (one-line guard; no behavior change for existing rows).
- `convex/vehicleEnrichment/endpointPartPriceMutations.ts` — NEW: `upsertEndpointPartPrice` internalMutation (idempotent by `(part_id, source_domain)`).
- `convex/devOnly/endpointPartPriceBackfill.ts` — NEW: dev driver that reads `repairpal_endpoint_estimates` + writes the per-unit points (mirrors `endpointBackfill.ts`).
- `convex/lib/quoteEngine.ts` — `resolvePartsCost` real-band block (gated) + `partsRealPrimaryEnabled` helper; `buildQuote` bypass-scale for `source==="real_parts"`.
- `convex/schema.ts` — UPDATE the `repairpal_endpoint_estimates` comment (parts now also project to `part_prices` as endpoint fallback points).
- `convex/directorRepairpal.ts` + `app/(director-panel)/director/components/tabs/TabRepairPalLabor.tsx` — ADD a parts band (real vs multiplier) column for the shadow-diff.
- Tests: `tests/repairpalEndpointMatch.test.ts` (extend), `tests/partsBand.test.ts` (rewrite), `tests/partPriceAggregation.test.ts` (extend), `tests/endpointPartPriceUpsert.test.ts` (new), `tests/resolvePartsCost.test.ts` (new).

**Commit discipline (every task):** explicit pathspecs only — `git commit -m "..." -- <files>` (a user-owned file is pre-staged in the index; NEVER `git commit -am`/bare `-m`). Verify each commit with `git show --name-only --format="%h %s" HEAD`. Co-author trailer on every commit:
```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```
**Off-limits failing tests (do not touch/“fix”):** `customer_late`, `timeSlotAvailability`, `partSelector`. **Do NOT touch** the staged `docs/superpowers/handoffs/2026-06-15-labor-sources-handoff.md`.

---

## Task 1: Endpoint-role → subcategory roleKey mapper (pure)

**Files:**
- Modify: `convex/vehicleEnrichment/repairpalEndpointMatch.ts`
- Test: `tests/repairpalEndpointMatch.test.ts`

`endpointPartCategory` emits `brake_pad`/`brake_rotor`/`transmission_filter`; the canonical `oem_parts.subcategory`/roleKey uses `front_brake_pad`/`rear_brake_pad`/`front_rotor`/`rear_rotor`/`trans_filter`. The write needs to bridge them. Consumable categories pass through unchanged.

- [ ] **Step 1: Write the failing test** (append to `tests/repairpalEndpointMatch.test.ts`)

```ts
import { endpointRoleToSubcategory } from "../convex/vehicleEnrichment/repairpalEndpointMatch";

describe("endpointRoleToSubcategory — endpoint vocab → oem_parts.subcategory roleKey", () => {
  it("passes consumable roles through unchanged", () => {
    expect(endpointRoleToSubcategory("oil_filter")).toBe("oil_filter");
    expect(endpointRoleToSubcategory("air_filter")).toBe("air_filter");
    expect(endpointRoleToSubcategory("cabin_filter")).toBe("cabin_filter");
    expect(endpointRoleToSubcategory("spark_plug")).toBe("spark_plug");
    expect(endpointRoleToSubcategory("coolant")).toBe("coolant");
    expect(endpointRoleToSubcategory("battery")).toBe("battery");
  });
  it("maps transmission_filter to the roleKey trans_filter", () => {
    expect(endpointRoleToSubcategory("transmission_filter")).toBe("trans_filter");
  });
  it("maps brakes to the front/rear roleKey using position", () => {
    expect(endpointRoleToSubcategory("brake_pad", "front")).toBe("front_brake_pad");
    expect(endpointRoleToSubcategory("brake_pad", "rear")).toBe("rear_brake_pad");
    expect(endpointRoleToSubcategory("brake_rotor", "front")).toBe("front_rotor");
    expect(endpointRoleToSubcategory("brake_rotor", "rear")).toBe("rear_rotor");
  });
  it("returns null for a position-less brake role (cannot place it) and unknown roles", () => {
    expect(endpointRoleToSubcategory("brake_pad")).toBeNull();
    expect(endpointRoleToSubcategory("brake_rotor")).toBeNull();
    expect(endpointRoleToSubcategory(undefined)).toBeNull();
    expect(endpointRoleToSubcategory("mystery")).toBeNull();
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

Run: `npx vitest run tests/repairpalEndpointMatch.test.ts`
Expected: FAIL — `endpointRoleToSubcategory` is not exported.

- [ ] **Step 3: Implement** (append to `convex/vehicleEnrichment/repairpalEndpointMatch.ts`)

```ts
/**
 * Map an endpoint part role (endpointPartCategory output) onto the canonical
 * oem_parts.subcategory / servicePartsReference roleKey, so the endpoint price
 * can be attached to the fitment we already gathered. Consumables pass through;
 * brakes/rotors require a position to choose the front/rear roleKey. Returns
 * null when it cannot be placed (caller skips that part).
 */
export function endpointRoleToSubcategory(
  role: string | null | undefined,
  position?: string | null,
): string | null {
  if (!role) return null;
  const pos = position === "front" || position === "rear" ? position : null;
  switch (role) {
    case "brake_pad":
      return pos ? `${pos}_brake_pad` : null;
    case "brake_rotor":
      return pos ? `${pos}_rotor` : null;
    case "transmission_filter":
      return "trans_filter";
    case "oil_filter":
    case "air_filter":
    case "cabin_filter":
    case "spark_plug":
    case "coolant":
    case "battery":
      return role;
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run — verify PASS** (`npx vitest run tests/repairpalEndpointMatch.test.ts`) — all green.
- [ ] **Step 5: Commit**

```bash
git commit -m "feat(repairpal): endpoint-role -> oem_parts.subcategory roleKey mapper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- convex/vehicleEnrichment/repairpalEndpointMatch.ts tests/repairpalEndpointMatch.test.ts
```
Then: `git show --name-only --format="%h %s" HEAD` — verify ONLY those two files.

---

## Task 2: Rewrite `aggregatePartsBand` → SKU+endpoint peers pooled, per-config total (pure)

**Files:**
- Modify: `convex/lib/partsBand.ts`
- Test: `tests/partsBand.test.ts` (replace the body)

New model: each role carries `quantity` + `skuPrices` (per-unit, pre-vetted) + optional `endpointUnitPrice` (per-unit). Per role the SKU prices and the endpoint point are POOLED as peers (the endpoint is appended to the pool); the role band = `[min,max]` of the pooled points × `quantity`. A role is reliable when it has `≥ minSkuSources` SKU prices OR the endpoint point. Service reliable iff EVERY role is reliable; band = Σ role totals.

- [ ] **Step 1: Replace the test file** `tests/partsBand.test.ts` with:

```ts
import { describe, it, expect } from "vitest";
import { aggregatePartsBand } from "../convex/lib/partsBand";

describe("aggregatePartsBand — SKU + endpoint pooled as peers, per-config total", () => {
  it("pools SKU prices WITH the endpoint point × quantity (endpoint appended to the band)", () => {
    const r = aggregatePartsBand([
      { role: "spark_plug", quantity: 6, skuPrices: [8, 10], endpointUnitPrice: 12 },
    ]);
    // pooled per-unit [8,10,12] → [min,max]=[8,12] × 6 = [48,72]; endpoint widens the band.
    expect(r).toMatchObject({ reliable: true, source: "real_parts", low: 48, high: 72 });
  });

  it("uses the endpoint per-unit point alone × quantity when a role has no SKU (safety net)", () => {
    const r = aggregatePartsBand([
      { role: "spark_plug", quantity: 6, skuPrices: [], endpointUnitPrice: 9 },
    ]);
    expect(r).toMatchObject({ reliable: true, source: "real_parts", low: 54, high: 54 }); // 9×6
  });

  it("SKU stands alone when there is no endpoint", () => {
    const r = aggregatePartsBand([
      { role: "spark_plug", quantity: 6, skuPrices: [8, 10], endpointUnitPrice: null },
    ]);
    expect(r).toMatchObject({ reliable: true, low: 48, high: 60 }); // [8,10]×6
  });

  it("sums multiple roles (mixed SKU + endpoint) into a per-config total", () => {
    const r = aggregatePartsBand([
      { role: "engine_oil", quantity: 6, skuPrices: [7, 9], endpointUnitPrice: null }, // [42,54]
      { role: "oil_filter", quantity: 1, skuPrices: [], endpointUnitPrice: 12 },        // [12,12]
    ]);
    expect(r).toMatchObject({ reliable: true, low: 54, high: 66 });
  });

  it("is UNreliable (whole-service fallback) when any role has neither SKU nor endpoint", () => {
    const r = aggregatePartsBand([
      { role: "engine_oil", quantity: 5, skuPrices: [8], endpointUnitPrice: null },
      { role: "oil_filter", quantity: 1, skuPrices: [], endpointUnitPrice: null },
    ]);
    expect(r).toMatchObject({ reliable: false, source: "fallback", reliableRoles: 1, totalRoles: 2 });
  });

  it("falls back for an empty role list", () => {
    expect(aggregatePartsBand([])).toMatchObject({ reliable: false, source: "fallback", low: 0, high: 0, totalRoles: 0 });
  });

  it("respects minSkuSources but still pools a sub-threshold SKU with the endpoint", () => {
    // 1 SKU below the threshold of 2, but the endpoint makes the role reliable;
    // both points are pooled into the band.
    const r = aggregatePartsBand([{ role: "battery", quantity: 1, skuPrices: [120], endpointUnitPrice: 150 }], { minSkuSources: 2 });
    expect(r).toMatchObject({ reliable: true, low: 120, high: 150 });
  });

  it("is UNreliable when SKU is below threshold AND there is no endpoint", () => {
    const r = aggregatePartsBand([{ role: "battery", quantity: 1, skuPrices: [120], endpointUnitPrice: null }], { minSkuSources: 2 });
    expect(r).toMatchObject({ reliable: false, source: "fallback" });
  });
});
```

- [ ] **Step 2: Run — verify FAIL** (`npx vitest run tests/partsBand.test.ts`) — new shape not implemented.

- [ ] **Step 3: Replace `convex/lib/partsBand.ts` with:**

```ts
/**
 * partsBand.ts — PURE aggregation of real per-config parts prices into a quote
 * band. No Convex imports (unit-tested: tests/partsBand.test.ts).
 *
 * Policy (handoff 2026-06-23, user's chosen design): per role, POOL the gathered
 * SKU prices WITH the RepairPal endpoint averaged per-unit POINT as peers (the
 * endpoint is appended to the role's price pool). When a role has no SKU prices
 * the endpoint point stands alone (the safety net). If a role has neither, the
 * whole service is unreliable and the caller uses the Camry × tier-multiplier
 * fallback (never mix real + fallback within a service).
 *
 * The band returned is the PER-CONFIG TOTAL (Σ over roles of pooled-per-unit
 * [min,max] × the config's resolved quantity), so the caller must NOT re-apply
 * unit-scaling.
 */

export type PartsRoleInput = {
  /** part role (oem_parts.subcategory / roleKey) — for labeling. */
  role: string;
  /** config's resolved quantity for this role (resolveRoleQuantity). */
  quantity: number;
  /** gathered per-SKU per-unit prices (excl. the endpoint source), pre-vetted. */
  skuPrices: number[];
  /** RepairPal endpoint averaged PER-UNIT point (avg ÷ endpoint.quantity), if any. */
  endpointUnitPrice?: number | null;
};

export type PartsBandResult = {
  reliable: boolean;
  low: number;
  high: number;
  source: "real_parts" | "fallback";
  reliableRoles: number;
  totalRoles: number;
};

/** opts.minSkuSources: SKU-reliability threshold (default 1; raise for binding-quote safety). */
export function aggregatePartsBand(
  roles: PartsRoleInput[],
  opts?: { minSkuSources?: number },
): PartsBandResult {
  const minSku = opts?.minSkuSources ?? 1;
  const totalRoles = roles.length;
  let reliableRoles = 0;
  let low = 0;
  let high = 0;

  for (const r of roles) {
    const qty = r.quantity > 0 ? r.quantity : 1;
    const skus = (r.skuPrices ?? []).filter((n) => typeof n === "number" && n > 0);
    const hasEndpoint = typeof r.endpointUnitPrice === "number" && r.endpointUnitPrice > 0;

    // Reliable when SKU clears the threshold OR the endpoint point exists.
    if (skus.length < minSku && !hasEndpoint) continue; // no real evidence → forces fallback

    // Pool SKU points WITH the endpoint point (peers). When only the endpoint
    // exists, it is the whole pool (the safety net).
    const pooled = hasEndpoint ? [...skus, r.endpointUnitPrice as number] : skus;
    reliableRoles++;
    low += Math.min(...pooled) * qty;
    high += Math.max(...pooled) * qty;
  }

  const reliable = totalRoles > 0 && reliableRoles === totalRoles;
  return reliable
    ? { reliable: true, low, high, source: "real_parts", reliableRoles, totalRoles }
    : { reliable: false, low: 0, high: 0, source: "fallback", reliableRoles, totalRoles };
}
```

- [ ] **Step 4: Run — verify PASS** (`npx vitest run tests/partsBand.test.ts`) — all green.
- [ ] **Step 5: Commit**

```bash
git commit -m "refactor(parts): partsBand — SKU-first, endpoint per-unit fallback, per-config total

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- convex/lib/partsBand.ts tests/partsBand.test.ts
```
Then verify with `git show --name-only --format="%h %s" HEAD`.

---

## Task 3: price_type for endpoint points + exclude from the pooled aggregate

**Files:**
- Modify: `convex/lib/priceTypes.ts`
- Modify: `convex/part_prices.ts` (`summarizePriceRows` — one-line guard)
- Test: `tests/partPriceAggregation.test.ts`

Endpoint points must NOT enter the pooled SKU aggregate (else booking_quotes / serviceParts / job_actuals shift the moment they're written). They're VALID market signals reserved as per-part fallbacks — a separate concept from POISON (wrong data).

- [ ] **Step 1: Write the failing test** (append to `tests/partPriceAggregation.test.ts`)

```ts
import { summarizePriceRows } from "../convex/part_prices";
import { REPAIRPAL_ENDPOINT_PRICE_TYPE } from "../convex/lib/priceTypes";

describe("summarizePriceRows — endpoint fallback points are excluded from the pooled aggregate", () => {
  it("ignores repairpal_endpoint rows so existing consumers are unchanged", () => {
    const partId = "x" as any;
    const withEndpoint = summarizePriceRows(partId, [
      { price: 10, price_type: "sale", source_domain: "rockauto.com" },
      { price: 14, price_type: "sale", source_domain: "partsgeek.com" },
      { price: 999, price_type: REPAIRPAL_ENDPOINT_PRICE_TYPE, source_domain: "repairpal_endpoint" },
    ]);
    const withoutEndpoint = summarizePriceRows(partId, [
      { price: 10, price_type: "sale", source_domain: "rockauto.com" },
      { price: 14, price_type: "sale", source_domain: "partsgeek.com" },
    ]);
    expect(withEndpoint.sample_size).toBe(2);
    expect(withEndpoint.average).toBe(withoutEndpoint.average);
    expect(withEndpoint.max).toBe(14); // 999 never counted
  });
});
```

- [ ] **Step 2: Run — verify FAIL** (`npx vitest run tests/partPriceAggregation.test.ts`) — `REPAIRPAL_ENDPOINT_PRICE_TYPE` not exported / 999 leaks in.

- [ ] **Step 3a: Implement in `convex/lib/priceTypes.ts`** (append after `isPoisonPriceType`)

```ts
/** Valid market signals that are RESERVED as per-part fallbacks (not poison),
 *  excluded from the pooled SKU aggregate. The RepairPal endpoint averaged
 *  per-unit point is the first member — only resolvePartsCost's gated real-band
 *  block reads it; summarizePriceRows (booking_quotes/serviceParts/job_actuals)
 *  must not. */
export const REPAIRPAL_ENDPOINT_PRICE_TYPE = "repairpal_endpoint";

export const NON_POOLED_PRICE_TYPES = new Set<string>([REPAIRPAL_ENDPOINT_PRICE_TYPE]);

/** True when a row is valid but must NOT enter the pooled per-part aggregate. */
export function isNonPooledPriceType(priceType: string | null | undefined): boolean {
  return priceType != null && NON_POOLED_PRICE_TYPES.has(priceType);
}
```

- [ ] **Step 3b: Implement in `convex/part_prices.ts`** — update the import and the `validRows` filter ONLY:

Change the import line:
```ts
import { isPoisonPriceType } from "./lib/priceTypes";
```
to:
```ts
import { isPoisonPriceType, isNonPooledPriceType } from "./lib/priceTypes";
```

Change the `validRows` filter from:
```ts
  const validRows = rows.filter(
    (r) =>
      !isPoisonPriceType(r.price_type) &&
      typeof r.price === "number" &&
      Number.isFinite(r.price) &&
      (r.price as number) > 0,
  );
```
to:
```ts
  const validRows = rows.filter(
    (r) =>
      !isPoisonPriceType(r.price_type) &&
      !isNonPooledPriceType(r.price_type) &&
      typeof r.price === "number" &&
      Number.isFinite(r.price) &&
      (r.price as number) > 0,
  );
```

- [ ] **Step 4: Run — verify PASS** + no regression: `npx vitest run tests/partPriceAggregation.test.ts` — all green (existing assertions unchanged because no existing row carries the new type).
- [ ] **Step 5: Commit**

```bash
git commit -m "feat(parts): repairpal_endpoint price_type excluded from pooled aggregate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- convex/lib/priceTypes.ts convex/part_prices.ts tests/partPriceAggregation.test.ts
```
Then verify with `git show --name-only --format="%h %s" HEAD`.

---

## Task 4: Upsert mutation — endpoint average → `part_prices` per-unit point

**Files:**
- Create: `convex/vehicleEnrichment/endpointPartPriceMutations.ts`
- Test: `tests/endpointPartPriceUpsert.test.ts` (convex-test)

Idempotent by `(part_id, source_domain)` via the `by_part_source` index — re-running overwrites the prior endpoint point, not appends.

- [ ] **Step 1: Write the failing test** `tests/endpointPartPriceUpsert.test.ts`

```ts
import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import { REPAIRPAL_ENDPOINT_PRICE_TYPE } from "../convex/lib/priceTypes";

describe("upsertEndpointPartPrice", () => {
  it("inserts then updates one repairpal_endpoint row per part", async () => {
    const t = convexTest(schema);
    const partId = await t.run((ctx) =>
      ctx.db.insert("oem_parts", { oem_part_number: "P1", subcategory: "spark_plug" } as any),
    );
    await t.mutation(internal.vehicleEnrichment.endpointPartPriceMutations.upsertEndpointPartPrice, {
      part_id: partId, price: 9, source_url: "https://repairpal.com/x", refreshed_at: 1,
    });
    await t.mutation(internal.vehicleEnrichment.endpointPartPriceMutations.upsertEndpointPartPrice, {
      part_id: partId, price: 11, source_url: "https://repairpal.com/x", refreshed_at: 2,
    });
    const rows = await t.run((ctx) =>
      ctx.db.query("part_prices").withIndex("by_part_source", (q) =>
        q.eq("part_id", partId).eq("source_domain", "repairpal_endpoint")).collect());
    expect(rows.length).toBe(1);
    expect(rows[0].price).toBe(11);
    expect(rows[0].price_type).toBe(REPAIRPAL_ENDPOINT_PRICE_TYPE);
  });
});
```

- [ ] **Step 2: Run — verify FAIL** (`npx vitest run tests/endpointPartPriceUpsert.test.ts`) — mutation undefined.

- [ ] **Step 3: Implement** `convex/vehicleEnrichment/endpointPartPriceMutations.ts`

```ts
import { internalMutation } from "../_generated/server";
import { v } from "convex/values";
import { REPAIRPAL_ENDPOINT_PRICE_TYPE } from "../lib/priceTypes";

const SOURCE_DOMAIN = "repairpal_endpoint";

/** Idempotent upsert of the RepairPal endpoint averaged per-unit point for a
 *  part (one row per part, source_domain="repairpal_endpoint"). Excluded from
 *  the pooled SKU aggregate (price_type), so it only feeds resolvePartsCost's
 *  gated real-band block. */
export const upsertEndpointPartPrice = internalMutation({
  args: {
    part_id: v.id("oem_parts"),
    price: v.number(),
    source_url: v.optional(v.string()),
    refreshed_at: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("part_prices")
      .withIndex("by_part_source", (q) =>
        q.eq("part_id", args.part_id).eq("source_domain", SOURCE_DOMAIN))
      .first();
    const fields = {
      part_id: args.part_id,
      price: args.price,
      price_type: REPAIRPAL_ENDPOINT_PRICE_TYPE,
      source_domain: SOURCE_DOMAIN,
      source_url: args.source_url,
      refreshed_at: args.refreshed_at,
    };
    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return existing._id;
    }
    return await ctx.db.insert("part_prices", { ...fields, created_at: args.refreshed_at });
  },
});
```

- [ ] **Step 4: Run — verify PASS** (`npx vitest run tests/endpointPartPriceUpsert.test.ts`).
- [ ] **Step 5: Typecheck** `npx convex dev --once` — compiles, no type errors.
- [ ] **Step 6: Commit**

```bash
git commit -m "feat(parts): idempotent upsert of endpoint averaged per-unit point into part_prices

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- convex/vehicleEnrichment/endpointPartPriceMutations.ts tests/endpointPartPriceUpsert.test.ts
```
Then verify with `git show --name-only --format="%h %s" HEAD`.

---

## Task 5: Backfill driver — `repairpal_endpoint_estimates` → per-unit points

**Files:**
- Create: `convex/devOnly/endpointPartPriceBackfill.ts`
- Test: convex-test in `tests/endpointPartPriceUpsert.test.ts` (add a join-path test that exercises the resolver query)

The backfill is an `internalAction` mirroring `devOnly/endpointBackfill.ts`. For each `repairpal_endpoint_estimates` row, for each part: skip if no `role`/`price_low`/`price_high`/`quantity`; map `endpointRoleToSubcategory(role, position)` → subcategory; find the config's fitment for `(vehicle_config_id, service_type=service.slug)` whose part's `subcategory` matches (+ position handled by the subcategory itself for brakes); compute `price = ((low+high)/2) ÷ quantity`; call `upsertEndpointPartPrice`. The matching query is a small `internalQuery` so it's convex-testable.

- [ ] **Step 1: Add the failing join test** (append to `tests/endpointPartPriceUpsert.test.ts`)

```ts
import { endpointRoleToSubcategory } from "../convex/vehicleEnrichment/repairpalEndpointMatch";

describe("endpoint→fitment join (matchFitmentForEndpointPart)", () => {
  it("matches an endpoint part to the config fitment by subcategory and writes avg/quantity", async () => {
    const t = convexTest(schema);
    const { configId, serviceId, partId } = await t.run(async (ctx) => {
      const partId = await ctx.db.insert("oem_parts", { oem_part_number: "SP1", subcategory: "spark_plug" } as any);
      const configId = await ctx.db.insert("vehicle_configs", { year: 2021 } as any);
      const serviceId = await ctx.db.insert("services", { slug: "spark_plugs" } as any);
      await ctx.db.insert("part_fitments", { part_id: partId, vehicle_config_id: configId, service_type: "spark_plugs", quantity_needed: 6 } as any);
      await ctx.db.insert("repairpal_endpoint_estimates", {
        vehicle_config_id: configId, service_id: serviceId, base_vehicle_id: 1, fetched_at: 1,
        parts: [{ role: "spark_plug", name: "Spark Plug", quantity: 6, price_low: 52.44, price_high: 71.56 }],
      } as any);
      return { configId, serviceId, partId };
    });
    await t.action(internal.devOnly.endpointPartPriceBackfill.backfill, { configIds: [configId] });
    const rows = await t.run((ctx) =>
      ctx.db.query("part_prices").withIndex("by_part_source", (q) =>
        q.eq("part_id", partId).eq("source_domain", "repairpal_endpoint")).collect());
    expect(rows.length).toBe(1);
    // avg = (52.44+71.56)/2 = 62; per-unit = 62/6 ≈ 10.3333
    expect(rows[0].price).toBeCloseTo(62 / 6, 3);
  });
});
```

- [ ] **Step 2: Run — verify FAIL** (`npx vitest run tests/endpointPartPriceUpsert.test.ts`) — backfill undefined.

- [ ] **Step 3: Implement** `convex/devOnly/endpointPartPriceBackfill.ts`

```ts
/**
 * endpointPartPriceBackfill.ts — DEV-ONLY driver: reads repairpal_endpoint_estimates
 * and writes each endpoint part's averaged PER-UNIT point into part_prices
 * (source_domain="repairpal_endpoint"), joined to the config's fitment by role.
 * Inert to existing consumers (price_type excluded from the pooled aggregate);
 * only resolvePartsCost's gated real-band block reads them. Not prod wiring.
 *
 *   npx convex run devOnly/endpointPartPriceBackfill:backfill
 *   npx convex run devOnly/endpointPartPriceBackfill:backfill '{"configIds":["xd7.."]}'
 */
import { internalAction, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { endpointRoleToSubcategory } from "../vehicleEnrichment/repairpalEndpointMatch";

/** Resolve the (config, service slug, endpoint part) → part_id by subcategory. */
export const matchFitmentForEndpointPart = internalQuery({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
    service_slug: v.string(),
    subcategory: v.string(),
  },
  handler: async (ctx, args) => {
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_config_service", (q) =>
        q.eq("vehicle_config_id", args.vehicle_config_id).eq("service_type", args.service_slug))
      .collect();
    for (const f of fitments) {
      const part = await ctx.db.get(f.part_id);
      if ((part as any)?.subcategory === args.subcategory) {
        return { part_id: f.part_id, quantity_needed: f.quantity_needed ?? null };
      }
    }
    return null;
  },
});

export const backfill = internalAction({
  args: { configIds: v.optional(v.array(v.id("vehicle_configs"))) },
  handler: async (ctx, args): Promise<any> => {
    const rows: any[] = await ctx.runQuery(
      internal.devOnly.endpointPartPriceBackfill.listEndpointRows,
      { configIds: args.configIds },
    );
    let written = 0;
    let skipped = 0;
    for (const row of rows) {
      const slug = row.serviceSlug as string | null;
      if (!slug) { skipped++; continue; }
      for (const p of row.parts ?? []) {
        const sub = endpointRoleToSubcategory(p.role, p.position);
        const qty = typeof p.quantity === "number" && p.quantity > 0 ? p.quantity : null;
        if (!sub || qty == null || typeof p.price_low !== "number" || typeof p.price_high !== "number") {
          skipped++; continue;
        }
        const match: any = await ctx.runQuery(
          internal.devOnly.endpointPartPriceBackfill.matchFitmentForEndpointPart,
          { vehicle_config_id: row.vehicle_config_id, service_slug: slug, subcategory: sub },
        );
        if (!match) { skipped++; continue; }
        const avg = (p.price_low + p.price_high) / 2;
        await ctx.runMutation(
          internal.vehicleEnrichment.endpointPartPriceMutations.upsertEndpointPartPrice,
          { part_id: match.part_id, price: avg / qty, source_url: "https://repairpal.com/estimator", refreshed_at: row.fetched_at },
        );
        written++;
      }
    }
    return { rows: rows.length, written, skipped };
  },
});

/** Join the endpoint rows to their service slug (the estimates table stores
 *  service_id, but the fitment match keys on the slug). */
export const listEndpointRows = internalQuery({
  args: { configIds: v.optional(v.array(v.id("vehicle_configs"))) },
  handler: async (ctx, args) => {
    const all = args.configIds
      ? (await Promise.all(args.configIds.map((id) =>
          ctx.db.query("repairpal_endpoint_estimates").withIndex("by_config", (q) =>
            q.eq("vehicle_config_id", id)).collect()))).flat()
      : await ctx.db.query("repairpal_endpoint_estimates").collect();
    const out: any[] = [];
    for (const row of all) {
      const service = await ctx.db.get(row.service_id);
      out.push({
        vehicle_config_id: row.vehicle_config_id,
        serviceSlug: (service as any)?.slug ?? null,
        parts: row.parts ?? [],
        fetched_at: row.fetched_at,
      });
    }
    return out;
  },
});
```

- [ ] **Step 4: Run — verify PASS** (`npx vitest run tests/endpointPartPriceUpsert.test.ts`).
- [ ] **Step 5: Typecheck** `npx convex dev --once`.
- [ ] **Step 6: Commit**

```bash
git commit -m "feat(parts): dev backfill — endpoint estimates -> part_prices per-unit points

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- convex/devOnly/endpointPartPriceBackfill.ts tests/endpointPartPriceUpsert.test.ts
```
Then verify with `git show --name-only --format="%h %s" HEAD`.

---

## Task 6: `resolvePartsCost` real-band block (gated) + `partsRealPrimaryEnabled`

**Files:**
- Modify: `convex/lib/quoteEngine.ts`
- Test: `tests/resolvePartsCost.test.ts` (convex-test)

Insert AFTER the CCB carve-out block (ends ~line 417, keep FIRST) and BEFORE the `getCamryFwdConfig` baseline lookup. Skip the real path for brake/per_axle services. When the flag is OFF, output is byte-identical to today (no flag pushed). When ON but the band is unreliable, fall through to the multiplier and tag `parts_fallback_multiplier`.

- [ ] **Step 1: Write the failing test** `tests/resolvePartsCost.test.ts`

```ts
import { convexTest } from "convex-test";
import { describe, it, expect, afterEach } from "vitest";
import schema from "../convex/schema";
import { resolvePartsCost } from "../convex/lib/quoteEngine";
import { REPAIRPAL_ENDPOINT_PRICE_TYPE } from "../convex/lib/priceTypes";

afterEach(() => { delete process.env.PARTS_SOURCE_REAL_PRIMARY; });

/** Seed a spark_plugs config: 1 core fitment (spark_plug, 6 cyl), SKU prices,
 *  + an endpoint per-unit point. Returns ids. */
async function seedSparkPlugs(t: any, opts: { sku: number[]; endpoint?: number }) {
  return await t.run(async (ctx: any) => {
    const partId = await ctx.db.insert("oem_parts", { oem_part_number: "SP", subcategory: "spark_plug" });
    const engineId = await ctx.db.insert("engines", { cylinders: 6, spark_plug_quantity: 6 });
    const configId = await ctx.db.insert("vehicle_configs", { year: 2021, engine_id: engineId, pricing_tier: "T2a" });
    const serviceId = await ctx.db.insert("services", {
      slug: "spark_plugs", parts_kind: "per_cylinder", parts_multiplier_category_id: undefined,
    });
    await ctx.db.insert("part_fitments", { part_id: partId, vehicle_config_id: configId, service_type: "spark_plugs", quantity_needed: 6, service_role: "core" });
    for (const price of opts.sku) await ctx.db.insert("part_prices", { part_id: partId, price, price_type: "sale", source_domain: "rockauto.com" });
    if (opts.endpoint != null) await ctx.db.insert("part_prices", { part_id: partId, price: opts.endpoint, price_type: REPAIRPAL_ENDPOINT_PRICE_TYPE, source_domain: "repairpal_endpoint" });
    return { configId, serviceId };
  });
}

describe("resolvePartsCost — real band primary (gated)", () => {
  it("flag OFF: ignores real data (no real_parts source)", async () => {
    const t = convexTest(schema);
    const { configId, serviceId } = await seedSparkPlugs(t, { sku: [8, 10] });
    const res = await t.run((ctx: any) => resolvePartsCost(ctx, { vehicle_config_id: configId, service_id: serviceId, vehicle_tier: "T2a" }));
    expect((res as any).source).not.toBe("real_parts");
  });

  it("flag ON: pools the SKU prices WITH the endpoint point × quantity as real_parts", async () => {
    process.env.PARTS_SOURCE_REAL_PRIMARY = "on";
    const t = convexTest(schema);
    const { configId, serviceId } = await seedSparkPlugs(t, { sku: [8, 10], endpoint: 12 });
    const res = await t.run((ctx: any) => resolvePartsCost(ctx, { vehicle_config_id: configId, service_id: serviceId, vehicle_tier: "T2a" }));
    expect(res).toMatchObject({ ok: true, source: "real_parts", low: 48, high: 72 }); // pooled [8,10,12]×6
  });

  it("flag ON, no SKU: falls back to the endpoint per-unit point × quantity", async () => {
    process.env.PARTS_SOURCE_REAL_PRIMARY = "on";
    const t = convexTest(schema);
    const { configId, serviceId } = await seedSparkPlugs(t, { sku: [], endpoint: 9 });
    const res = await t.run((ctx: any) => resolvePartsCost(ctx, { vehicle_config_id: configId, service_id: serviceId, vehicle_tier: "T2a" }));
    expect(res).toMatchObject({ ok: true, source: "real_parts", low: 54, high: 54 }); // 9×6
  });

  it("flag ON, no real evidence: falls back to multiplier with parts_fallback_multiplier flag", async () => {
    process.env.PARTS_SOURCE_REAL_PRIMARY = "on";
    const t = convexTest(schema);
    // seed a multiplier-priced service with a core fitment that has NO prices
    const { configId, serviceId } = await t.run(async (ctx: any) => {
      const catId = await ctx.db.insert("pricing_parts_categories", { code: "ignition" });
      const partId = await ctx.db.insert("oem_parts", { oem_part_number: "SP", subcategory: "spark_plug" });
      const engineId = await ctx.db.insert("engines", { cylinders: 4, spark_plug_quantity: 4 });
      const camryEngineId = await ctx.db.insert("engines", { cylinders: 4 });
      const configId = await ctx.db.insert("vehicle_configs", { year: 2021, engine_id: engineId, pricing_tier: "T2a" });
      // Camry baseline anchor
      await ctx.db.insert("app_singletons", { key: "camry_fwd_config", value: { engine_id: camryEngineId } } as any);
      const serviceId = await ctx.db.insert("services", { slug: "spark_plugs", parts_kind: "per_cylinder", parts_multiplier_category_id: catId });
      await ctx.db.insert("service_vehicle_specs", { engine_id: camryEngineId, service_id: serviceId, parts_cost_low: 20, parts_cost_high: 30 });
      await ctx.db.insert("pricing_parts_multipliers", { parts_category_id: catId, tier: "T2a", multiplier: 1.3 });
      await ctx.db.insert("part_fitments", { part_id: partId, vehicle_config_id: configId, service_type: "spark_plugs", quantity_needed: 4, service_role: "core" });
      return { configId, serviceId };
    });
    const res = await t.run((ctx: any) => resolvePartsCost(ctx, { vehicle_config_id: configId, service_id: serviceId, vehicle_tier: "T2a" }));
    expect((res as any).ok).toBe(true);
    expect((res as any).source).toContain("multiplier");
    expect((res as any).flags).toContain("parts_fallback_multiplier");
  });
});
```

> NOTE for the implementer: the exact Camry-baseline seeding (`app_singletons`/`getCamryFwdConfig`) must match how `getCamryFwdConfig` reads the anchor — read `getCamryFwdConfig` in `quoteEngine.ts` and mirror its lookup in the seed. Adjust the 4th test's seed to whatever `getCamryFwdConfig` expects; the assertion (multiplier source + `parts_fallback_multiplier` flag) is the contract.

- [ ] **Step 2: Run — verify FAIL** (`npx vitest run tests/resolvePartsCost.test.ts`).

- [ ] **Step 3a: Add the flag helper** near the top of `convex/lib/quoteEngine.ts` (after imports):

```ts
/** PARTS_SOURCE_REAL_PRIMARY gates the real per-config parts band in
 *  resolvePartsCost. Default OFF — when unset, resolvePartsCost output is
 *  byte-identical to the locked Pricing-Spec-v2 multiplier path. */
export function partsRealPrimaryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PARTS_SOURCE_REAL_PRIMARY === "on";
}
```

- [ ] **Step 3b: Add imports** at the top of `quoteEngine.ts`:

```ts
import { aggregatePartsBand, type PartsRoleInput } from "./partsBand";
import { resolveRoleQuantity, type VehicleSpecBundle } from "./partRoleQuantity";
import { roleForSubcategory } from "./servicePartsReference";
import { isNonPooledPriceType, isPoisonPriceType, REPAIRPAL_ENDPOINT_PRICE_TYPE } from "./priceTypes";
```

- [ ] **Step 3c: Insert the real-band block** in `resolvePartsCost`, immediately AFTER the CCB `if (isBrakeService) { ... }` block (after ~line 417) and BEFORE `if (!service.parts_multiplier_category_id)`:

```ts
  // ── Real per-config parts band (gated; default OFF) ─────────────────────
  // Per role: SKU pool first → RepairPal endpoint per-unit point → unresolved.
  // Skip brake/per_axle services in v1 (front-only endpoint + booking-position
  // scaling don't compose with the bypass-scale model — they keep the multiplier).
  const isPerAxle = service.parts_kind === "per_axle";
  if (partsRealPrimaryEnabled() && !isBrakeService && !isPerAxle) {
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_config_service", (q) =>
        q.eq("vehicle_config_id", args.vehicle_config_id).eq("service_type", slug))
      .collect();

    if (fitments.length > 0) {
      // Spec bundle for resolveRoleQuantity (fail-open; missing data → qty 1).
      const engine = cfg.engine_id ? await ctx.db.get(cfg.engine_id) : null;
      const bundle: VehicleSpecBundle = {
        config: {
          brake_fluid_capacity_oz: (cfg as any).brake_fluid_capacity_oz ?? null,
          ps_fluid_capacity_oz: (cfg as any).ps_fluid_capacity_oz ?? null,
          has_brake_pad_sensor: (cfg as any).has_brake_pad_sensor ?? null,
        },
        engine: engine
          ? {
              oil_capacity_qts: (engine as any).oil_capacity_qts ?? null,
              coolant_capacity_qts: (engine as any).coolant_capacity_qts ?? null,
              spark_plug_quantity: (engine as any).spark_plug_quantity ?? null,
              cylinders: (engine as any).cylinders ?? null,
            }
          : null,
      };

      const roles: PartsRoleInput[] = [];
      for (const f of fitments) {
        const part = await ctx.db.get(f.part_id);
        const sub = (part as any)?.subcategory ?? null;
        const roleSpec = roleForSubcategory(slug, sub, (part as any)?.category);
        // Only CORE roles bind the real band (as_needed/kit are discovery/variant).
        if ((f.service_role ?? roleSpec?.serviceRole) !== "core") continue;

        const prices = await ctx.db
          .query("part_prices")
          .withIndex("by_part", (q) => q.eq("part_id", f.part_id))
          .collect();
        const skuPrices = prices
          .filter((p) => !isPoisonPriceType(p.price_type) && !isNonPooledPriceType(p.price_type))
          .map((p) => p.price)
          .filter((n): n is number => typeof n === "number" && n > 0);
        const endpointRow = prices.find(
          (p) => p.price_type === REPAIRPAL_ENDPOINT_PRICE_TYPE && typeof p.price === "number" && p.price > 0,
        );
        const { quantity } = resolveRoleQuantity(roleSpec, bundle, f.quantity_needed);
        roles.push({
          role: sub ?? f.part_id,
          quantity,
          skuPrices,
          endpointUnitPrice: endpointRow?.price ?? null,
        });
      }

      if (roles.length > 0) {
        const band = aggregatePartsBand(roles);
        if (band.reliable) {
          return { ok: true, low: band.low, high: band.high, source: "real_parts", flags: ["real_parts_band"] };
        }
      }
    }
  }
```

- [ ] **Step 3d: Tag the multiplier fallback** — at the FINAL `return { ok: true, low: spec.parts_cost_low * mult, ... }` in `resolvePartsCost`, add `parts_fallback_multiplier` to `flags` ONLY when the flag is on (so flag-off output is unchanged). Just before that return:

```ts
  if (partsRealPrimaryEnabled()) flags.push("parts_fallback_multiplier");
```

- [ ] **Step 4: Run — verify PASS** (`npx vitest run tests/resolvePartsCost.test.ts`) + full pure suite green: `npx vitest run tests/partsBand.test.ts tests/partPriceAggregation.test.ts tests/repairpalEndpointMatch.test.ts`.
- [ ] **Step 5: Typecheck** `npx convex dev --once`.
- [ ] **Step 6: Commit**

```bash
git commit -m "feat(quote): resolvePartsCost real parts band primary, Camry x multiplier strict fallback (flag-gated)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- convex/lib/quoteEngine.ts tests/resolvePartsCost.test.ts
```
Then verify with `git show --name-only --format="%h %s" HEAD`.

---

## Task 7: `buildQuote` — bypass unit-scaling for `real_parts`

**Files:**
- Modify: `convex/lib/quoteEngine.ts` (`buildQuote`, ~line 715)
- Test: extend `tests/resolvePartsCost.test.ts` (or a `tests/buildQuote.test.ts`) — assert a `real_parts` quote's parts total equals the band (NOT re-scaled).

The real band is already a per-config TOTAL. `buildQuote` must NOT re-scale it — mirror the existing `ccb_absolute` bypass.

- [ ] **Step 1: Write the failing test** (append to `tests/resolvePartsCost.test.ts`)

```ts
import { buildQuote } from "../convex/lib/quoteEngine";

it("buildQuote does not re-scale a real_parts band by unit count", async () => {
  process.env.PARTS_SOURCE_REAL_PRIMARY = "on";
  const t = convexTest(schema);
  const { configId, serviceId } = await seedSparkPlugs(t, { sku: [8, 10], endpoint: 9 });
  // a shop with a labor rate for the tier
  const shopId = await t.run((ctx: any) => ctx.db.insert("shops", {
    name: "S", labor_rate_t2a: 100,
  } as any));
  const q: any = await t.run((ctx: any) => buildQuote(ctx, { vehicle_config_id: configId, service_id: serviceId, shop_id: shopId }));
  // parts band [48,60] must NOT be multiplied again by 6/baseline.
  expect(q.parts.low).toBe(48);
  expect(q.parts.high).toBe(60);
});
```

> NOTE: align the shop labor-rate field with `resolveLaborRate` (read it in `quoteEngine.ts`) and seed whatever `resolveLaborHours` needs for spark_plugs, or assert only `q.parts.low/high` after confirming `q.ok === true`. The contract under test is purely: parts band is not re-scaled.

- [ ] **Step 2: Run — verify FAIL** (parts re-scaled by unitScale).

- [ ] **Step 3: Implement** — in `buildQuote`, change:

```ts
  const isCcbAbsolute = partsRes.source === "ccb_absolute";
  const scale = isCcbAbsolute ? 1 : unitScale(unitRes);
```
to:
```ts
  // ccb_absolute and real_parts bands are already per-config totals — don't re-scale.
  const bypassUnitScale = partsRes.source === "ccb_absolute" || partsRes.source === "real_parts";
  const scale = bypassUnitScale ? 1 : unitScale(unitRes);
```

Then replace each subsequent `isCcbAbsolute ? A : B` in the `parts:` metadata block with `bypassUnitScale ? A : B` (the `unit_count`, `baseline_count`, `unit_label`, `unit_count_estimated`, and the `if (unitRes.is_estimate && !isCcbAbsolute)` guard → `!bypassUnitScale`).

- [ ] **Step 4: Run — verify PASS** + the full vitest + convex-test parts suites green.
- [ ] **Step 5: Typecheck** `npx convex dev --once`.
- [ ] **Step 6: Commit**

```bash
git commit -m "feat(quote): buildQuote bypasses unit-scaling for the per-config real_parts band

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- convex/lib/quoteEngine.ts tests/resolvePartsCost.test.ts
```
Then verify with `git show --name-only --format="%h %s" HEAD`.

---

## Task 8: Schema comment + director shadow-diff column

**Files:**
- Modify: `convex/schema.ts` (the `repairpal_endpoint_estimates` comment ~line 447-453)
- Modify: `convex/directorRepairpal.ts` (add a per-config real-vs-multiplier parts band to the existing query)
- Modify: `app/(director-panel)/director/components/tabs/TabRepairPalLabor.tsx` (render the parts columns next to the labor columns)

- [ ] **Step 1: Update the schema comment** — replace the stale "per-role parts ranges here are read at quote/recompute time and joined ... via aggregatePartsBand (peers)" wording with:

```
  // Parts: each endpoint part's averaged per-unit price (total_price avg ÷
  // quantity) is ALSO projected into part_prices as a fallback POINT
  // (source_domain="repairpal_endpoint", a price_type excluded from the pooled
  // SKU aggregate). resolvePartsCost (flag PARTS_SOURCE_REAL_PRIMARY) prefers
  // gathered SKU prices, falls back to this endpoint point, then to
  // Camry×multiplier. See docs/superpowers/plans/2026-06-23-parts-real-primary-endpoint-point.md.
```

- [ ] **Step 2: Read** `convex/directorRepairpal.ts` + `TabRepairPalLabor.tsx` and locate the per-config labor row (RP-vs-current). Add to the query handler, for each config+service, BOTH parts numbers by calling `resolvePartsCost` twice — once with the flag forced off (multiplier) and once forced on (real band). Since `resolvePartsCost` reads `process.env`, expose a variant that takes an explicit override, OR compute the real band inline by reusing the same role-gathering. Simplest: add an optional 4th arg to `resolvePartsCost`, `opts?: { forceRealPrimary?: boolean }`, and have `partsRealPrimaryEnabled` honor it:

```ts
// signature: resolvePartsCost(ctx, args, opts?: { forceRealPrimary?: boolean })
// gate check becomes:
const realOn = opts?.forceRealPrimary ?? partsRealPrimaryEnabled();
if (realOn && !isBrakeService && !isPerAxle) { ... }
// and the fallback tag:
if (realOn) flags.push("parts_fallback_multiplier");
```
(Update Task 6's call sites + tests accordingly if you add this; the env-based default is unchanged.)

- [ ] **Step 3:** In the director query, for each (config, service) produce `{ multiplier_low, multiplier_high, real_low, real_high, real_source }` = `resolvePartsCost(..., {forceRealPrimary:false})` vs `{forceRealPrimary:true}`. Return alongside the existing labor columns.

- [ ] **Step 4:** In `TabRepairPalLabor.tsx`, add "Parts (mult)" and "Parts (real)" columns mirroring the labor columns' markup; highlight rows where `real_source === "real_parts"` and the bands diverge > 15%.

- [ ] **Step 5: Typecheck** `npx convex dev --once`; lint the TSX (`npx tsc --noEmit` or the project's check).
- [ ] **Step 6: Commit**

```bash
git commit -m "feat(director): parts real-vs-multiplier shadow-diff column on RepairPal & Labor tab

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- convex/schema.ts convex/directorRepairpal.ts "app/(director-panel)/director/components/tabs/TabRepairPalLabor.tsx" convex/lib/quoteEngine.ts tests/resolvePartsCost.test.ts
```
Then verify with `git show --name-only --format="%h %s" HEAD`.

---

## Task 9: Integration verify, shadow-diff, document (PROD flag stays OFF)

**Files:**
- Create: `docs/superpowers/reviews/2026-06-23-parts-real-primary-shadow-diff.md`

- [ ] **Step 1: Backfill the per-unit points on dev** — `npx convex run devOnly/endpointPartPriceBackfill:backfill` — record `{rows, written, skipped}`. Spot-check `part_prices` has `repairpal_endpoint` rows for a few enriched configs (Convex dashboard or a `verifyParts`-style query).
- [ ] **Step 2: Confirm the write is inert** — pick one part that got an endpoint row and confirm `getAveragePrice` (summarizePartPrices) returns the SAME average as before (the endpoint row is excluded). Document the before/after.
- [ ] **Step 3: Shadow-diff via the director tab** — for the dev fleet, compare Parts (mult) vs Parts (real) per config+service. Confirm: consumables shift DOWN toward real (the proof's ~2× not 5–7× at high tiers); Subaru-style SKU-only configs still produce a real band; configs missing a core role fall back (source = multiplier, `parts_fallback_multiplier`). Spot-check spark_plugs / coolant_flush / filter_replacement / oil_change totals against the endpoint totals to validate the quantity round-trip (the open risk).
- [ ] **Step 4: Document** results + any anomalies in `docs/superpowers/reviews/2026-06-23-parts-real-primary-shadow-diff.md` (mirror the labor shadow-diff reviews). State the PROD flag remains OFF pending sign-off.
- [ ] **Step 5: Do NOT set `PARTS_SOURCE_REAL_PRIMARY` on prod.** Leave it on dev only for the diff. Flip on prod only after the user signs off the review.
- [ ] **Step 6: Commit** the review doc:

```bash
git commit -m "docs(review): parts real-primary endpoint shadow-diff (dev)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- docs/superpowers/reviews/2026-06-23-parts-real-primary-shadow-diff.md
```
Then verify with `git show --name-only --format="%h %s" HEAD`.

---

## Self-review notes (gaps to watch during execution)

- **`getCamryFwdConfig` anchor seeding** (Task 6 test 4): mirror exactly how it reads the Camry config — read it before writing the seed.
- **`resolveLaborRate` / `resolveLaborHours` seeding** (Task 7 buildQuote test): seed the minimum the labor path needs, or assert only `parts.low/high` after `q.ok`.
- **Quantity round-trip** (Tasks 5↔6): write divides by `endpoint.quantity`; read multiplies by `resolveRoleQuantity`. Validate in the shadow-diff; if a fluid role diverges badly, prefer storing the endpoint role-total directly and reading it without re-multiplying (a v1.1 adjustment).
- **`oil_change` engine_oil from endpoint:** `endpointPartCategory` does NOT map plain "engine oil" → so the endpoint contributes only the oil_filter point; engine_oil must resolve via SKU or the service falls back. Expected; note it in the shadow-diff.
- **`transmission_service`:** ATF fluid is unmapped by `endpointPartCategory`; `trans_filter` maps via Task 1. Likely partial → fallback. Acceptable v1.
- **Flag-off invariant:** with `PARTS_SOURCE_REAL_PRIMARY` unset, `resolvePartsCost` must return exactly today's value AND flags (no `parts_fallback_multiplier`). The Task 6 "flag OFF" test guards this — keep it.
- **minSkuSources:** default 1. Raise (e.g. `{ minSkuSources: 2 }` from `resolvePartsCost`) to require ≥N SKU sources before a role counts as reliable on SKU alone — the role is still reliable (and the band still includes the endpoint) whenever the endpoint point exists. Re-diff after changing.
