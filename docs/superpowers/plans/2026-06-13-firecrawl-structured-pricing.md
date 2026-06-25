# Firecrawl Structured Price Extraction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract part prices via Firecrawl's `json` format with a gauge-and-guide validation loop, used by both the enrichment pipeline and the reprice button.

**Architecture:** A shared extractor (`extractPriceFirecrawl`) returns `{sale_price, msrp, discount, oem_seen, price_label, sells_this_part, …}`; a pure `gaugePrice` detects wrong extractions from self-evidencing signals; `resolveVerifiedPrice` runs extract → gauge → one guided retry → hard-wall backstop; `priceAllSources` drives it across a part's candidate URLs. Reprice and enrichment both write through it. `part_prices` gains `msrp`/`discount`.

**Tech Stack:** Convex, Firecrawl v2 `/scrape` json format, vitest.

**Spec:** `docs/superpowers/specs/2026-06-13-firecrawl-structured-pricing-design.md`

**Ground-truth anchors (verified 2026-06-13):**
- `upsertPartPrice` (`convex/vehicleEnrichment/v3mutations.ts:552`) args today: `{part_id, price, price_type, source_url?, source_domain}`; patch path patches `price/price_type/source_url/refreshed_at`; insert path sets all + `created_at`.
- `part_prices` schema (`convex/schema.ts:433`): `{part_id, price, price_type?, source_url?, source_domain?, refreshed_at?, created_at?}`, indexes `by_part`, `by_part_source`.
- `validateLlmPrice` (`convex/vehicleEnrichment/priceParser.ts:292`): `({price, msrp?, oemSeen?, oem, crossSourceMedian?}) → {ok, reason}` — price>0, price<msrp, oem match, [0.3×,3×] median. Exported. `normalizeOemNumber` also from priceParser.
- `priceReextract.ts` imports `fetchUrlWithHtml` from `./firecrawl`, `normalizeOemNumber`+`validateLlmPrice` from `./priceParser`, and `median` (used in the reprice loop). `ReextractOutcome` (lines 45-52): `{status:"sale",price,tier} | {status:"unverified",reason} | {status:"fetch_failed",reason}`. `UNVERIFIED_PRICE_TYPE` constant exists.
- Reprice loop `_repriceConfigPartsRun` (`convex/directorConfigBackfills.ts` ~336-432): per part → `getPricesForPart` → `rows = prices.filter(r => r.source_url && r.source_domain)` → Pass-1 fetch each + `structuredPriceFor` → `crossMedian = median(structured)` → Pass-2 `reextractPartPrice` per row → `upsertPartPrice` (sale) or unverified; audit counts `fixed/totalPrices/markedUnverified/fetchFailed`.
- Enrichment parts write (`convex/vehicleEnrichment/v3pipeline.ts` ~2420-2537): three `upsertPartPrice` paths — deterministic JSON-LD (`dp.source_url`), `parts_breakdown` entries (`entry.source_url`, gated `PARTS_REEXTRACT_BATCH2`), per-fitment fallback. `fitments` has `oem_part_number`/`part_id`; `svc.parts_breakdown[]` has `{oem_part_number, price_low, source_url, source_domain}`.
- Firecrawl v2: `POST https://api.firecrawl.dev/v2/scrape`, key `process.env.FIRECRAWL_API_KEY` (set on `flippant-mink-750`). `json` format returns `data.json` (proven by `devOnly/repriceJsonProbe.ts`).
- Deploy: `npx convex dev --once` → `flippant-mink-750`.

---

### Task 1: Schema + writer — add `msrp`/`discount` to part_prices

**Files:**
- Modify: `convex/schema.ts` (part_prices, ~433-443)
- Modify: `convex/vehicleEnrichment/v3mutations.ts` (`upsertPartPrice`, ~552-600)

No unit test (Convex schema/mutation); the deploy typecheck verifies.

- [ ] **Step 1: Add the two optional columns**

In `convex/schema.ts`, the `part_prices` table — add after `source_domain`:
```ts
  part_prices: defineTable({
    part_id: v.id("oem_parts"),
    price: v.number(),
    price_type: v.optional(v.string()),
    source_url: v.optional(v.string()),
    source_domain: v.optional(v.string()),
    msrp: v.optional(v.number()),
    discount: v.optional(v.number()),
    refreshed_at: v.optional(v.number()),
    created_at: v.optional(v.number()),
  })
    .index("by_part", ["part_id"])
    .index("by_part_source", ["part_id", "source_domain"]),
```

- [ ] **Step 2: Accept + persist msrp/discount in `upsertPartPrice`**

In `convex/vehicleEnrichment/v3mutations.ts`, the `upsertPartPrice` mutation. Add to `args`:
```ts
    source_domain: v.string(),
    msrp: v.optional(v.float64()),
    discount: v.optional(v.float64()),
```
In the patch path add `msrp: args.msrp, discount: args.discount,` to the patch object; in the insert path add `msrp: args.msrp, discount: args.discount,` to the inserted document.

- [ ] **Step 3: Deploy + typecheck**

Run: `npx convex dev --once`
Expected: clean deploy, no errors.

- [ ] **Step 4: Commit**

```bash
git add convex/schema.ts convex/vehicleEnrichment/v3mutations.ts
git commit -m "feat(pricing): part_prices.msrp/discount columns + upsertPartPrice persists them"
```

---

### Task 2: `extractPriceFirecrawl` — Firecrawl json extractor

**Files:**
- Modify: `convex/vehicleEnrichment/firecrawl.ts` (append a new exported function + type)

No unit test (network); live-verified in Step 3.

- [ ] **Step 1: Append the extractor + its result type**

At the end of `convex/vehicleEnrichment/firecrawl.ts`:
```ts
/** Structured price extraction via Firecrawl's `json` format. Returns the
 *  evidence fields the gauges read (price_label / product_title / sells_this_part)
 *  alongside the numbers. `correction` is appended to the prompt on a guided retry.
 *  Network-only; null on any failure. */
export type ExtractedPrice = {
  sale_price: number | null;
  msrp: number | null;
  discount: number | null;
  in_stock: boolean | null;
  oem_seen: string | null;
  price_label: string | null;
  product_title: string | null;
  sells_this_part: boolean | null;
  confidence: number | null;
};

const PRICE_JSON_SCHEMA = {
  type: "object",
  required: ["sale_price"],
  properties: {
    sale_price: { type: ["number", "null"], description: "the dollar amount the customer pays NOW for this exact part" },
    msrp: { type: ["number", "null"], description: "list/MSRP price before discount" },
    discount_amount: { type: ["number", "null"], description: "amount saved off MSRP" },
    in_stock: { type: ["boolean", "null"] },
    oem_part_number: { type: ["string", "null"], description: "the OEM/part number this price is for, as shown" },
    price_label: { type: ["string", "null"], description: "the EXACT label text the price was read from, e.g. 'Sale $37.19' or 'You Save $13'" },
    product_title: { type: ["string", "null"] },
    sells_this_part: { type: ["boolean", "null"], description: "true only if this page actually sells the target OEM part" },
    confidence: { type: ["number", "null"], description: "0..1 self-rating of the extraction" },
  },
};

export async function extractPriceFirecrawl(
  url: string,
  oem: string | null,
  partName?: string | null,
  correction?: string | null,
): Promise<ExtractedPrice | null> {
  const basePrompt =
    `Extract the price for the auto part${oem ? ` with OEM/part number "${oem}"` : ""}${partName ? ` (${partName})` : ""}. ` +
    `Return ONLY the dollar amount the customer pays right now for THIS exact part — the final current sale price after any automatic discount. ` +
    `IGNORE: SKUs, part numbers, phone numbers, quantities, shipping, tax, core charges, "You Save"/savings figures, struck-through/"was"/list/MSRP prices, and prices for a different part. ` +
    `Copy the exact text you read the price from into price_label. If the page does not sell this exact part, set sells_this_part false and sale_price null. Never guess.` +
    (correction ? ` IMPORTANT CORRECTION: ${correction}` : "");
  try {
    const resp = await fetch(`${FIRECRAWL_BASE}/scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${getApiKey()}` },
      body: JSON.stringify({
        url,
        formats: [{ type: "json", prompt: basePrompt, schema: PRICE_JSON_SCHEMA }],
        timeout: 45000,
      }),
      signal: AbortSignal.timeout(50000),
    });
    if (!resp.ok) {
      console.error(`Firecrawl json price failed for ${url}: ${resp.status}`);
      return null;
    }
    const data = await resp.json();
    const d = data.data ?? data;
    const j = d.json ?? d.extract ?? null;
    if (!j || typeof j !== "object") return null;
    const num = (x: any) => (typeof x === "number" && Number.isFinite(x) ? x : null);
    return {
      sale_price: num(j.sale_price),
      msrp: num(j.msrp),
      discount: num(j.discount_amount),
      in_stock: typeof j.in_stock === "boolean" ? j.in_stock : null,
      oem_seen: typeof j.oem_part_number === "string" ? j.oem_part_number : null,
      price_label: typeof j.price_label === "string" ? j.price_label : null,
      product_title: typeof j.product_title === "string" ? j.product_title : null,
      sells_this_part: typeof j.sells_this_part === "boolean" ? j.sells_this_part : null,
      confidence: num(j.confidence),
    };
  } catch (e) {
    console.error(`Firecrawl json price error for ${url}:`, e);
    return null;
  }
}
```
(`FIRECRAWL_BASE` and `getApiKey()` already exist at the top of this file — reuse them; do not redeclare.)

- [ ] **Step 2: Deploy**

Run: `npx convex dev --once`
Expected: clean deploy.

- [ ] **Step 3: Live-verify via a throwaway dev run** — reuse the existing probe to confirm the new function path works against a real URL by calling it from a one-off `npx convex run`. Since `extractPriceFirecrawl` is a plain function (not a Convex function), verify indirectly: confirm `devOnly/repriceJsonProbe:probe '{"perType":1}'` still returns structured `{sale_price, msrp}` (same Firecrawl json capability). Expected: rows with non-null `after.sale_price`.

- [ ] **Step 4: Commit**

```bash
git add convex/vehicleEnrichment/firecrawl.ts
git commit -m "feat(pricing): extractPriceFirecrawl — Firecrawl json extractor with evidence fields"
```

---

### Task 3: `gaugePrice` — pure self-evidencing validation

**Files:**
- Modify: `convex/vehicleEnrichment/priceReextract.ts` (add `gaugePrice` + helpers)
- Test: `tests/gaugePrice.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/gaugePrice.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { gaugePrice } from "../convex/vehicleEnrichment/priceReextract";
import type { ExtractedPrice } from "../convex/vehicleEnrichment/firecrawl";

const base: ExtractedPrice = {
  sale_price: 37.19, msrp: 50.94, discount: 13.75, in_stock: true,
  oem_seen: "13717852380", price_label: "Sale $37.19", product_title: "Air Filter",
  sells_this_part: true, confidence: 0.9,
};

describe("gaugePrice", () => {
  it("passes a clean, consistent sale extraction", () => {
    expect(gaugePrice(base, { oem: "13717852380", crossSourceMedian: 38 }).pass).toBe(true);
  });
  it("trips when price_label reads like a savings figure", () => {
    const r = gaugePrice({ ...base, price_label: "You Save $13.75" }, { oem: "13717852380", crossSourceMedian: null });
    expect(r.pass).toBe(false);
    expect(r.correction).toMatch(/sale price|dollar amount/i);
  });
  it("trips when oem_seen mismatches the target", () => {
    const r = gaugePrice({ ...base, oem_seen: "99999999999" }, { oem: "13717852380", crossSourceMedian: null });
    expect(r.pass).toBe(false);
    expect(r.reason).toContain("oem");
  });
  it("trips when sells_this_part is false", () => {
    expect(gaugePrice({ ...base, sells_this_part: false }, { oem: "13717852380", crossSourceMedian: null }).pass).toBe(false);
  });
  it("trips when sale >= msrp (grabbed the list price)", () => {
    expect(gaugePrice({ ...base, sale_price: 60, msrp: 50.94 }, { oem: "13717852380", crossSourceMedian: null }).pass).toBe(false);
  });
  it("trips on a wild median outlier (the $21,499 battery)", () => {
    const r = gaugePrice(
      { ...base, sale_price: 21499, msrp: null, discount: null, price_label: "21499", oem_seen: null },
      { oem: "61217604802", crossSourceMedian: 180 },
    );
    expect(r.pass).toBe(false);
  });
  it("trips when no sale_price at all", () => {
    expect(gaugePrice({ ...base, sale_price: null }, { oem: "x", crossSourceMedian: null }).pass).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/gaugePrice.test.ts`
Expected: FAIL — `gaugePrice` not exported.

- [ ] **Step 3: Implement `gaugePrice`**

Append to `convex/vehicleEnrichment/priceReextract.ts` (it already imports `normalizeOemNumber`, `validateLlmPrice`):
```ts
import type { ExtractedPrice } from "./firecrawl";

const BAD_LABEL_RE = /save|you\s*save|%\s*off|\bwas\b|\bmsrp\b|\blist\b|\bsku\b|part\s*#|part\s*number/i;

export type GaugeResult = { pass: boolean; reason: string; correction: string | null };

/** Self-evidencing validation of a Firecrawl extraction — no price thresholds
 *  except the median band. Returns a corrective sentence when a gauge trips so
 *  the caller can re-extract with guidance. Pure. */
export function gaugePrice(
  x: ExtractedPrice,
  ctx: { oem: string | null; crossSourceMedian: number | null },
): GaugeResult {
  const sp = x.sale_price;
  if (sp == null || !(sp > 0)) return { pass: false, reason: "no_price", correction: `Return the numeric dollar sale price for OEM ${ctx.oem ?? "this part"}, or null if not sold here.` };
  if (x.sells_this_part === false) return { pass: false, reason: "not_this_part", correction: `Confirm the page sells OEM ${ctx.oem ?? "the target part"}; if it does not, return sale_price null.` };
  if (x.price_label && BAD_LABEL_RE.test(x.price_label)) {
    return { pass: false, reason: "label_not_sale", correction: `Your price_label was "${x.price_label}", which is a discount/MSRP/SKU — not the sale price. Return the current dollar amount the customer pays for OEM ${ctx.oem ?? "this part"}.` };
  }
  if (ctx.oem && x.oem_seen && normalizeOemNumber(x.oem_seen) !== normalizeOemNumber(ctx.oem)) {
    return { pass: false, reason: "oem_mismatch", correction: `Your price was for OEM ${x.oem_seen}, but the target is ${ctx.oem}. Return the price for ${ctx.oem} specifically, or null.` };
  }
  if (x.msrp != null && x.msrp > 0 && sp >= x.msrp) {
    return { pass: false, reason: "ge_msrp", correction: `Your price ${sp} was >= the MSRP ${x.msrp} — that's the list price. Return the actual current price BELOW MSRP.` };
  }
  if (x.msrp != null && x.discount != null && Math.abs(x.msrp - sp - x.discount) > Math.max(2, x.msrp * 0.05)) {
    return { pass: false, reason: "discount_inconsistent", correction: `Your numbers don't reconcile (msrp ${x.msrp} − sale ${sp} ≠ discount ${x.discount}). Re-read the page and return the actual sale price + its MSRP for OEM ${ctx.oem ?? "this part"}.` };
  }
  if (ctx.crossSourceMedian != null && ctx.crossSourceMedian > 0) {
    if (sp > ctx.crossSourceMedian * 3 || sp < ctx.crossSourceMedian * 0.3) {
      return { pass: false, reason: "median_outlier", correction: `Your price ${sp} is far from other sources (~${ctx.crossSourceMedian}). Re-check you read the price for OEM ${ctx.oem ?? "this part"}, not a bundle/quantity/SKU.` };
    }
  }
  return { pass: true, reason: "ok", correction: null };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/gaugePrice.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add convex/vehicleEnrichment/priceReextract.ts tests/gaugePrice.test.ts
git commit -m "feat(pricing): gaugePrice — pure self-evidencing extraction validation"
```

---

### Task 4: `resolveVerifiedPrice` — gauge → guided retry → backstop

**Files:**
- Modify: `convex/vehicleEnrichment/priceReextract.ts`
- Test: `tests/resolveVerifiedPrice.test.ts`

- [ ] **Step 1: Write the failing tests (stubbed extractor — no network)**

`tests/resolveVerifiedPrice.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { resolveVerifiedPrice } from "../convex/vehicleEnrichment/priceReextract";
import type { ExtractedPrice } from "../convex/vehicleEnrichment/firecrawl";

const good: ExtractedPrice = {
  sale_price: 37.19, msrp: 50.94, discount: 13.75, in_stock: true,
  oem_seen: "13717852380", price_label: "Sale $37.19", product_title: "Air Filter",
  sells_this_part: true, confidence: 0.9,
};
// scripted extractor: returns results[callIndex], records the corrections it was called with
function scripted(results: (ExtractedPrice | null)[]) {
  const calls: (string | null | undefined)[] = [];
  const fn = async (_url: string, _oem: string | null, _name: string | null | undefined, correction?: string | null) => {
    calls.push(correction);
    return results[Math.min(calls.length - 1, results.length - 1)];
  };
  return { fn, calls };
}

describe("resolveVerifiedPrice", () => {
  it("returns sale on a clean first shot (no retry)", async () => {
    const s = scripted([good]);
    const r = await resolveVerifiedPrice({ url: "u", oem: "13717852380", partName: "Air Filter", crossSourceMedian: 38 }, s.fn);
    expect(r.status).toBe("sale");
    expect((r as any).price).toBe(37.19);
    expect((r as any).msrp).toBe(50.94);
    expect(s.calls.length).toBe(1); // no retry
  });

  it("retries once with a correction when the first result trips a gauge, then succeeds", async () => {
    const bad = { ...good, price_label: "You Save $13.75" };
    const s = scripted([bad, good]);
    const r = await resolveVerifiedPrice({ url: "u", oem: "13717852380", partName: "Air Filter", crossSourceMedian: 38 }, s.fn);
    expect(r.status).toBe("sale");
    expect(s.calls.length).toBe(2);
    expect(s.calls[1]).toBeTruthy(); // retry carried a correction
  });

  it("the $21,499 battery stays unverified even after the retry", async () => {
    const insane: ExtractedPrice = { ...good, sale_price: 21499, msrp: null, discount: null, price_label: "21499", oem_seen: null };
    const s = scripted([insane, insane]);
    const r = await resolveVerifiedPrice({ url: "u", oem: "61217604802", partName: "Battery", crossSourceMedian: 180 }, s.fn);
    expect(r.status).toBe("unverified");
    expect(s.calls.length).toBe(2);
  });

  it("null extraction (page failed) → fetch_failed, no retry", async () => {
    const s = scripted([null]);
    const r = await resolveVerifiedPrice({ url: "u", oem: "x", partName: null, crossSourceMedian: null }, s.fn);
    expect(r.status).toBe("fetch_failed");
    expect(s.calls.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/resolveVerifiedPrice.test.ts`
Expected: FAIL — `resolveVerifiedPrice` not exported.

- [ ] **Step 3: Extend `ReextractOutcome` and implement `resolveVerifiedPrice`**

In `convex/vehicleEnrichment/priceReextract.ts`, extend the `"sale"` variant of `ReextractOutcome`:
```ts
export type ReextractOutcome =
  | { status: "sale"; price: number; tier: "structured" | "llm" | "firecrawl"; msrp?: number | null; discount?: number | null }
  | { status: "unverified"; reason: string }
  | { status: "fetch_failed"; reason: string };
```
Then append:
```ts
export type PriceExtractor = (
  url: string, oem: string | null, partName?: string | null, correction?: string | null,
) => Promise<ExtractedPrice | null>;

/** Extract → gauge → ONE guided retry → hard-wall backstop. The extractor is
 *  injectable so tests can stub it; production passes extractPriceFirecrawl. */
export async function resolveVerifiedPrice(
  args: { url: string; oem: string | null; partName?: string | null; crossSourceMedian: number | null },
  extract: PriceExtractor,
): Promise<ReextractOutcome> {
  const { url, oem, partName, crossSourceMedian } = args;

  let x = await extract(url, oem, partName, null);
  if (!x) return { status: "fetch_failed", reason: "no_extract" };

  let g = gaugePrice(x, { oem, crossSourceMedian });
  let retried = false;
  if (!g.pass && g.correction) {
    retried = true;
    const x2 = await extract(url, oem, partName, g.correction);
    if (!x2) return { status: "fetch_failed", reason: "no_extract_retry" };
    x = x2;
    g = gaugePrice(x, { oem, crossSourceMedian });
  }

  if (g.pass) {
    return { status: "sale", price: x.sale_price as number, tier: "firecrawl", msrp: x.msrp, discount: x.discount };
  }

  // Hard-wall backstop: validateLlmPrice + the $5k single-source ceiling.
  const vp = validateLlmPrice({ price: x.sale_price, msrp: x.msrp, oemSeen: x.oem_seen, oem: oem ?? "", crossSourceMedian });
  const overCeiling = (x.sale_price ?? 0) > 5000 && crossSourceMedian == null;
  if (vp.ok && !overCeiling && oem) {
    return { status: "sale", price: x.sale_price as number, tier: "firecrawl", msrp: x.msrp, discount: x.discount };
  }
  return { status: "unverified", reason: `${g.reason}${retried ? "_after_retry" : ""}` };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/resolveVerifiedPrice.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add convex/vehicleEnrichment/priceReextract.ts tests/resolveVerifiedPrice.test.ts
git commit -m "feat(pricing): resolveVerifiedPrice — gauge + one guided retry + hard-wall backstop"
```

---

### Task 5: `priceAllSources` — per-part multi-source driver

**Files:**
- Modify: `convex/vehicleEnrichment/priceReextract.ts`
- Test: `tests/priceAllSources.test.ts`

- [ ] **Step 1: Write the failing test (stubbed extractor)**

`tests/priceAllSources.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { priceAllSources } from "../convex/vehicleEnrichment/priceReextract";
import type { ExtractedPrice } from "../convex/vehicleEnrichment/firecrawl";

const mk = (sale: number, label = `Sale $${sale}`): ExtractedPrice => ({
  sale_price: sale, msrp: sale + 10, discount: 10, in_stock: true,
  oem_seen: "OEM1", price_label: label, product_title: "Part", sells_this_part: true, confidence: 0.9,
});

describe("priceAllSources", () => {
  it("extracts all sources, builds a median, returns one outcome per url", async () => {
    const byUrl: Record<string, ExtractedPrice> = {
      "https://a.com/p": mk(40), "https://b.com/p": mk(42), "https://c.com/p": mk(41),
    };
    const extract = async (url: string) => byUrl[url] ?? null;
    const out = await priceAllSources(
      ["https://a.com/p", "https://b.com/p", "https://c.com/p"],
      { oem: "OEM1", partName: "Part" }, extract,
    );
    expect(out).toHaveLength(3);
    expect(out.every((o) => o.outcome.status === "sale")).toBe(true);
    expect(out[0].source_domain).toBe("a.com");
  });

  it("caps at 3 sources and dedupes", async () => {
    const extract = async () => mk(40);
    const out = await priceAllSources(
      ["https://a.com/p", "https://a.com/p", "https://b.com/p", "https://c.com/p", "https://d.com/p"],
      { oem: "OEM1" }, extract,
    );
    expect(out.length).toBe(3); // deduped a.com, capped at 3
  });

  it("an outlier source is demoted to unverified by the cross-source median", async () => {
    const byUrl: Record<string, ExtractedPrice> = {
      "https://a.com/p": mk(40), "https://b.com/p": mk(41),
      "https://c.com/p": { ...mk(21499), msrp: null, discount: null, price_label: "21499" },
    };
    const extract = async (url: string) => byUrl[url] ?? null;
    const out = await priceAllSources(
      ["https://a.com/p", "https://b.com/p", "https://c.com/p"], { oem: "OEM1" }, extract,
    );
    const outlier = out.find((o) => o.source_domain === "c.com")!;
    expect(outlier.outcome.status).toBe("unverified");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/priceAllSources.test.ts`
Expected: FAIL — `priceAllSources` not exported.

- [ ] **Step 3: Implement `priceAllSources`**

Append to `convex/vehicleEnrichment/priceReextract.ts` (`median` is already imported and used by this module; reuse it):
```ts
export type SourcePriceRow = {
  source_url: string;
  source_domain: string;
  outcome: ReextractOutcome;
};

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

/** Price a part across its candidate source URLs: extract all (for a cross-source
 *  median), then resolveVerifiedPrice each against that median. Deduped by URL,
 *  capped at 3. Pure orchestration — caller does the DB writes. */
export async function priceAllSources(
  urls: string[],
  args: { oem: string | null; partName?: string | null },
  extract: PriceExtractor,
): Promise<SourcePriceRow[]> {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const u of urls) {
    if (!u || seen.has(u)) continue;
    seen.add(u);
    list.push(u);
    if (list.length >= 3) break;
  }

  // Pass 1: raw extracts → cross-source median of the sale prices.
  const firstPass = new Map<string, ExtractedPrice | null>();
  const sales: number[] = [];
  for (const u of list) {
    const x = await extract(u, args.oem, args.partName, null);
    firstPass.set(u, x);
    if (x?.sale_price != null && x.sale_price > 0) sales.push(x.sale_price);
  }
  const crossSourceMedian = sales.length > 0 ? median(sales) : null;

  // Pass 2: gauge + guided retry each, against the median.
  const out: SourcePriceRow[] = [];
  for (const u of list) {
    const outcome = await resolveVerifiedPrice(
      { url: u, oem: args.oem, partName: args.partName, crossSourceMedian },
      extract,
    );
    out.push({ source_url: u, source_domain: domainOf(u), outcome });
  }
  return out;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/priceAllSources.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run all new pricing tests together**

Run: `npx vitest run tests/gaugePrice.test.ts tests/resolveVerifiedPrice.test.ts tests/priceAllSources.test.ts`
Expected: PASS (14 total).

- [ ] **Step 6: Commit**

```bash
git add convex/vehicleEnrichment/priceReextract.ts tests/priceAllSources.test.ts
git commit -m "feat(pricing): priceAllSources — per-part multi-source extract + cross-source median"
```

---

### Task 6: Reprice integration

**Files:**
- Modify: `convex/directorConfigBackfills.ts` (`_repriceConfigPartsRun`, ~336-432)

No unit test (DB/network glue); the helpers are unit-tested; dev-verified in Step 3.

- [ ] **Step 1: Replace the per-part two-pass loop with `priceAllSources`**

Read the current `_repriceConfigPartsRun` body. Add imports at the top of the file:
```ts
import { priceAllSources } from "./vehicleEnrichment/priceReextract";
import { extractPriceFirecrawl } from "./vehicleEnrichment/firecrawl";
```
Replace the per-part loop (the `for (const part of existingParts)` block that does Pass-1 fetch/structuredPriceFor + Pass-2 `reextractPartPrice`) with:
```ts
      let totalPrices = 0;
      let fixed = 0;
      let markedUnverified = 0;
      let fetchFailed = 0;
      for (const part of existingParts) {
        const prices = await ctx.runQuery(
          internal.vehicleEnrichment.v3queries.getPricesForPart,
          { partId: part.part_id },
        );
        const urls = (prices as any[])
          .filter((r) => r.source_url && r.source_domain)
          .map((r) => r.source_url as string);
        if (urls.length === 0) continue;

        const rows = await priceAllSources(
          urls,
          { oem: part.oem_part_number, partName: part.part_name },
          extractPriceFirecrawl,
        );
        for (const row of rows) {
          totalPrices++;
          const o = row.outcome;
          if (o.status === "fetch_failed") { fetchFailed++; continue; }
          if (o.status === "sale") {
            await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertPartPrice, {
              part_id: part.part_id,
              price: o.price,
              price_type: "sale",
              source_domain: row.source_domain,
              source_url: row.source_url,
              msrp: o.msrp ?? undefined,
              discount: o.discount ?? undefined,
            });
            fixed++;
          } else {
            const existingRow = (prices as any[]).find((r) => r.source_url === row.source_url);
            await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertPartPrice, {
              part_id: part.part_id,
              price: typeof existingRow?.price === "number" ? existingRow.price : 0,
              price_type: UNVERIFIED_PRICE_TYPE,
              source_domain: row.source_domain,
              source_url: row.source_url,
            });
            markedUnverified++;
          }
        }
      }
```
The audit line afterward (`Reprice parts complete: ${fixed}/${totalPrices} corrected ...`) is unchanged — `fixed`, `totalPrices`, `markedUnverified`, `fetchFailed` are all still set. Remove the now-unused `structuredPriceFor`/`median`/`reextractPartPrice`/`fetchUrlWithHtml` imports in this file **only if** they are no longer referenced after the replacement (check with grep; leave any still used).

- [ ] **Step 2: Deploy**

Run: `npx convex dev --once`
Expected: clean deploy.

- [ ] **Step 3: Dev-verify on one config**

```bash
ID=$(npx convex run devOnly/olpProbe:_listEnrichedConfigs | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=JSON.parse(s);console.log((a.find(c=>c.config_key.includes('m550i'))||a[0]).id)})")
npx convex run directorConfigBackfills:_repriceConfigPartsRun "{\"id\":\"$ID\",\"actorName\":\"test\",\"actorId\":\"test\"}" 2>&1 | tail -5
# then inspect a few rows:
npx convex data part_prices --limit 50 | grep -i sale | head -5
```
Expected: the run completes; repriced rows show `price_type sale` with `msrp`/`discount` populated; no absurd values written (the gauges + median reject them). Note: `_repriceConfigPartsRun` arg shape — confirm it takes `{id, actorName, actorId}` (per the action signature); adjust the call if the validator differs.

- [ ] **Step 4: Commit**

```bash
git add convex/directorConfigBackfills.ts
git commit -m "feat(pricing): reprice uses priceAllSources (Firecrawl json + gauge/guide)"
```

---

### Task 7: Enrichment integration

**Files:**
- Modify: `convex/vehicleEnrichment/v3pipeline.ts` (parts pricing section ~2420-2537)

No unit test (pipeline); shares the unit-tested helpers + the reprice write path.

- [ ] **Step 1: Add imports + the flag**

At the top of `convex/vehicleEnrichment/v3pipeline.ts` add (if not present):
```ts
import { priceAllSources } from "./priceReextract";
import { extractPriceFirecrawl } from "./firecrawl";
```

- [ ] **Step 2: Replace the three per-part price write-paths with one `priceAllSources` pass**

In the parts section (~2420-2537), the three current `upsertPartPrice` write-paths are: deterministic JSON-LD (`dp.source_url`), `parts_breakdown` entries, and the per-fitment fallback. Replace them with a single per-part pass that, for each fitment/part, collects its candidate source URLs and runs `priceAllSources`. Insert this in place of the three blocks (gated by the flag; the LLM-discovered `parts_breakdown` still provides the candidate URLs):
```ts
      if (process.env.PARTS_FIRECRAWL_PRICING !== "off") {
        // Union of discovered candidate URLs per part (OEM), from parts_breakdown
        // + the deterministic JSON-LD hits. Price each part across its sources.
        const urlsByPart = new Map<string, { urls: string[]; oem: string | null; name: string | null }>();
        const addUrl = (partId: any, url: string | undefined | null, oem: string | null, name: string | null) => {
          if (!url) return;
          const k = String(partId);
          const e = urlsByPart.get(k) ?? { urls: [], oem, name };
          if (!e.urls.includes(url)) e.urls.push(url);
          if (!e.oem && oem) e.oem = oem;
          if (!e.name && name) e.name = name;
          urlsByPart.set(k, e);
        };
        // deterministic JSON-LD candidates
        for (const f of fitments) {
          const num = (f as any).oem_part_number;
          const dp = num ? deterministicPrices.get(normalizeOemNumber(num)) : null;
          if (dp?.source_url) addUrl((f as any).part_id, dp.source_url, num ?? null, (f as any).part_name ?? null);
        }
        // parts_breakdown candidates
        if (svc.parts_breakdown && svc.parts_breakdown.length > 0) {
          const numToPartIds = new Map<string, any[]>();
          for (const f of fitments) {
            const num = (f as any).oem_part_number;
            if (!num) continue;
            const key = normalizeOemNumber(num);
            const arr = numToPartIds.get(key) ?? [];
            arr.push((f as any).part_id);
            numToPartIds.set(key, arr);
          }
          for (const entry of svc.parts_breakdown) {
            if (!entry.oem_part_number || !entry.source_url) continue;
            for (const pid of numToPartIds.get(normalizeOemNumber(entry.oem_part_number)) ?? []) {
              addUrl(pid, entry.source_url, entry.oem_part_number, null);
            }
          }
        }
        for (const [partIdStr, e] of urlsByPart) {
          const rows = await priceAllSources(e.urls, { oem: e.oem, partName: e.name }, extractPriceFirecrawl);
          for (const row of rows) {
            if (row.outcome.status !== "sale") continue;
            await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertPartPrice, {
              part_id: partIdStr as any,
              price: row.outcome.price,
              price_type: "sale",
              source_domain: row.source_domain,
              source_url: row.source_url,
              msrp: row.outcome.msrp ?? undefined,
              discount: row.outcome.discount ?? undefined,
            });
          }
        }
      }
```
Delete the three old write-path blocks they replace (the `deterministicPrices` upsert loop at ~2421-2431, the `parts_breakdown` upsert loop incl. its `PARTS_REEXTRACT_BATCH2` reextract at ~2433-2516, and the per-fitment fallback upsert at ~2528-2537). Keep `deterministicPrices`/`fitments`/`svc.parts_breakdown` (now used to source URLs). If `reextractPartPrice` import becomes unused here, remove it.

- [ ] **Step 3: Deploy + typecheck**

Run: `npx convex dev --once`
Expected: clean deploy. Confirm no dangling references: `grep -n "PARTS_REEXTRACT_BATCH2\|reextractPartPrice" convex/vehicleEnrichment/v3pipeline.ts` → none (or only inside removed code you deleted).

- [ ] **Step 4: Dev-verify by enriching one VIN (optional)** — if a spare VIN is available: `npx convex run vehicleEnrichment/runPublic:go '{"vin":"<vin>"}'`, then confirm its `part_prices` rows are `price_type sale` with `msrp`/`discount`. Otherwise the reprice verification (Task 6) covers the same write path.

- [ ] **Step 5: Commit**

```bash
git add convex/vehicleEnrichment/v3pipeline.ts
git commit -m "feat(pricing): enrichment prices via priceAllSources (Firecrawl json), single path behind PARTS_FIRECRAWL_PRICING"
```

---

### Task 8: Director UI — show sale/MSRP/discount in the part drawer

**Files:**
- Modify: `app/(director-panel)/director/components/tabs/TabVehicleConfigs.tsx` (`PartFitmentDrawerBody`)

- [ ] **Step 1: Locate where the part's price rows render**

Run: `grep -n "source_url\|price\|part_prices\|PartFitmentDrawerBody\|source_domain" "app/(director-panel)/director/components/tabs/TabVehicleConfigs.tsx" | head -20`
Identify the JSX that lists a part's price rows (each row shows price + source domain).

- [ ] **Step 2: Render msrp/discount when present**

For each price row, where the price is shown, append the MSRP/discount when the row carries them:
```tsx
{row.msrp != null && row.discount != null ? (
  <span style={{ color: 'var(--slate-500)', fontSize: 11, marginLeft: 6 }}>
    (was ${'{'}row.msrp.toFixed(2){'}'} · save ${'{'}row.discount.toFixed(2){'}'})
  </span>
) : null}
```
(Match the surrounding JSX style; the row object is whatever the existing query returns for part prices — if `msrp`/`discount` aren't in that query's projection, add them to the query select so the drawer receives them. Use the real field names from the existing row type.)

- [ ] **Step 3: Verify the build**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "TabVehicleConfigs" || echo "no TabVehicleConfigs type errors"`
Expected: no type errors in the file. (Visual check deferred — data may be sparse until a reprice runs.)

- [ ] **Step 4: Commit**

```bash
git add "app/(director-panel)/director/components/tabs/TabVehicleConfigs.tsx"
git commit -m "feat(pricing): part drawer shows sale (was/save) when msrp/discount present"
```

---

## Self-review notes (done at plan time)

- **Spec coverage:** comp1 extractor→Task2, comp2 resolveVerifiedPrice/gauge→Tasks 3-4, comp3 priceAllSources→Task5, comp4 reprice→Task6, comp5 enrichment→Task7, comp6 schema/writer→Task1, comp7 UI→Task8. Gauge-and-guide loop + $5k backstop in Task 4. msrp/discount persisted (Task 1) + written (6,7) + shown (8). The $21,499 reject is an explicit test in Tasks 3 & 4.
- **Build-green ordering:** schema/writer (1) before any writer uses msrp/discount; extractor (2) + pure helpers (3,4,5) before the integrations (6,7) that import them; UI (8) last. Each task deploys/tests independently.
- **Type consistency:** `ExtractedPrice` defined in Task 2 (firecrawl.ts) and imported by gaugePrice (3), resolveVerifiedPrice (4), priceAllSources (5). `PriceExtractor` signature `(url, oem, partName?, correction?) => Promise<ExtractedPrice|null>` matches `extractPriceFirecrawl` (Task 2) and the test stubs. `ReextractOutcome.sale` gains `msrp?/discount?` in Task 4, read by Tasks 6/7. `priceAllSources(urls, {oem,partName?}, extract)` signature consistent across Task 5 def + Tasks 6/7 calls.
- **Known risk (flagged for implementer):** Task 7's enrichment surgery is the largest edit in a complex section — the exact line ranges are approximate; the implementer must read the section and preserve everything non-pricing. Task 8's exact row-field names depend on the existing part-prices query projection — verify before editing.
