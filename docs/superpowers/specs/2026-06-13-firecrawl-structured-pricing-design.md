# Firecrawl structured price extraction — Design

**Date:** 2026-06-13
**Status:** Approved (brainstorm complete; pending spec review → plan)
**Branch:** waleed-fix

## Motivation

Part prices are extracted today by fetching page markdown/rawHtml and running our
own logic (`structuredPriceFor` on JSON-LD, then a Claude call on the text). This
produces a large class of wrong rows: `online_discount` / `you_save` (a savings or
MSRP figure stored as the price) and `llm_estimate` (an unverified guess). A live
probe (`devOnly/repriceJsonProbe`, 2026-06-13) showed Firecrawl's **`json` format**
— hand it a JSON Schema, it returns structured fields from any page — extracts a
clean `{sale_price, msrp, discount}` on **32/32** sampled pages, including the
no-JSON-LD direct product links where the current extractor falls through. It
corrected real bugs (e.g. a brake rotor stored at **$411.66**, real price **$119.99**;
an air filter **$74.38 → $37.19**) with **zero regressions** on already-correct rows.

The probe also proved structured extraction is **not blindly trustworthy** — one
battery came back **$21,499** (Firecrawl grabbed an unrelated figure). So the design
keeps the existing validation guardrails and adds a sanity ceiling.

**Decision:** make Firecrawl `json` extraction the primary price source for **both**
the enrichment pipeline and the reprice button, gated by the existing
`validateLlmPrice` guardrails plus a discount-consistency check and an absolute
ceiling.

## Decisions locked in brainstorm

1. **Firecrawl `json` is the primary extractor for everything** — it returns
   `sale_price`, `msrp`, `discount` as explicit fields, designing out the
   `online_discount` / `you_save` / `llm_estimate` figure-guessing entirely.
2. **Extract across all candidate sources per part** — for a part with N source
   URLs, extract each, compute a cross-source median, validate each against it.
   Capped at **3 sources/part** to bound Firecrawl credits.
3. **Persist `msrp` + `discount`** — add optional columns to `part_prices`.
4. **Gauge-and-guide validation** — detect a wrong extraction from *self-evidencing*
   signals (the returned `price_label`/`product_title` and cross-source agreement),
   and when one trips, **re-extract once with a corrective prompt** that names the
   problem, rather than rejecting outright.
5. **Hard-wall backstop AFTER the guided retry** — if it still fails the gauges,
   apply the existing `validateLlmPrice` + the absolute **$5,000** ceiling and mark
   `unverified`. The ceiling is a last-resort absurdity catch, not the primary gate.

## Architecture

### 1. `extractPriceFirecrawl(url, oem, partName, correction?)` — `convex/vehicleEnrichment/firecrawl.ts`
Calls `POST /v2/scrape` with the `json` format + an **evidence-rich** schema (the
extra fields are what the gauges read):
```jsonc
formats: [{ type: "json",
  prompt: "<base prompt> <correction?>",   // see below; correction is appended on retry
  schema: { type:"object", required:["sale_price"], properties:{
    sale_price:{type:["number","null"]}, msrp:{type:["number","null"]},
    discount_amount:{type:["number","null"]}, in_stock:{type:["boolean","null"]},
    oem_part_number:{type:["string","null"]},   // OEM the page shows for this price
    price_label:{type:["string","null"]},        // EXACT text read, e.g. "Sale $37.19" / "You Save $13"
    product_title:{type:["string","null"]},
    sells_this_part:{type:["boolean","null"]},   // does this page actually sell the target OEM?
    confidence:{type:["number","null"]} }}}]     // 0..1 self-rating
```
Base prompt is **strongly negative-instructed**: return only the dollar amount the
customer pays now for OEM `<oem>`; IGNORE SKUs/part numbers, phone numbers,
quantities, shipping, core charges, and unrelated products; copy the exact
`price_label` text; if the page doesn't sell this exact part, return `sale_price:null`.
On a guided retry the caller passes `correction` (a sentence naming the detected
problem) which is appended to the prompt. Returns
`{ sale_price, msrp, discount, in_stock, oem_seen, price_label, product_title, sells_this_part, confidence } | null`.
Network-only; no DB. Reuses the existing `FIRECRAWL_API_KEY` + base URL.

### 2. `resolveVerifiedPrice({url, oem, partName, crossSourceMedian})` — `priceReextract.ts`
Replaces `reextractPartPrice`'s tier logic. **Gauge → guide → backstop:**
1. `extractPriceFirecrawl(url, oem, partName)`. Empty/null → `{status:"fetch_failed"}`
   (caller must NOT demote the existing row — same rule as today).
2. **Gauge** the result (self-evidencing — no price thresholds):
   - `price_label` looks like a *sale price*, not a savings/MSRP/SKU figure
     (reject if it matches `/save|you save|% off|\bwas\b|msrp|list|sku|part\s*#/i`),
   - `sells_this_part` is not `false`, and `oem_seen` (when present) matches the target,
   - `sale ≤ msrp` and `msrp − sale ≈ discount` (±`max($2, 5% of msrp)`),
   - `sale_price` agrees with `crossSourceMedian` when present (within `[0.3×, 3×]`).
3. If any gauge trips → **guided retry**: call `extractPriceFirecrawl` ONCE more with
   a `correction` naming the failure (e.g. *"your $21,499 looks like a SKU; ignore
   part numbers and return the dollar price for OEM <oem>"*). Re-gauge the retry result.
4. **Backstop:** if the (retried) result still fails the gauges, apply
   `validateLlmPrice` + the **$5,000** absolute ceiling (single-source, no median
   corroboration) → `{status:"unverified", reason}`.
5. Pass (first shot or after retry) → `{status:"sale", price:sale_price, msrp, discount}`.

`ReextractOutcome` gains optional `msrp?` / `discount?` on the `"sale"` variant, and
the `"unverified"` reason records whether a guided retry was attempted.

### 3. `priceAllSources(part, candidateUrls[], opts)` — shared driver in `priceReextract.ts`
- Dedupe + cap `candidateUrls` at 3.
- Pass 1: `extractPriceFirecrawl` each → collect raw `sale_price`s → `crossSourceMedian`.
- Pass 2: `resolveVerifiedPrice` each (with the median) → list of
  `{source_url, source_domain, outcome}`.
- Returns the rows to write. Pure orchestration over the two functions above;
  callers do the DB writes.

### 4. Reprice — `convex/directorConfigBackfills.ts` `_repriceConfigPartsRun`
Swap the current Pass-1/Pass-2 loop to call `priceAllSources` over each part's
existing `part_prices` source rows. Write `sale` outcomes via `upsertPartPrice`
(now carrying `msrp`/`discount`); `unverified` keeps the row but drops it from the
customer median; `fetch_failed` leaves the row untouched. Audit string unchanged
in shape (corrected / unverified / skipped counts).

### 5. Enrichment — `convex/vehicleEnrichment/v3pipeline.ts` parts section (~2420–2537)
Keep source **discovery** (the Batch-2 LLM `parts_breakdown` + the deterministic
JSON-LD search still surface candidate URLs per part). Replace the price
**decision** with a **single pricing path**: for each part, gather the **union of
its discovered `source_url`s** (deterministic-path sources + `parts_breakdown`
entries for that OEM), dedupe, cap at 3, and run `priceAllSources`; write `sale`
rows with `msrp`/`discount`. This supersedes all three current write-paths
(deterministic, `parts_breakdown` `llm_estimate`/`entry.price_low`, and the
per-fitment fallback) so every price flows through Firecrawl-json + validation —
removing the `online_discount`/`you_save`/`llm_estimate` figures entirely. The
existing `PARTS_REEXTRACT_BATCH2` env hook (which calls the old
`reextractPartPrice`) is replaced by this path; gate the new path behind
`PARTS_FIRECRAWL_PRICING` (default **on**) so it can be disabled without a redeploy.

### 6. Schema + writer
- `part_prices`: add `msrp: v.optional(v.number())`, `discount: v.optional(v.number())`.
- `upsertPartPrice` (`v3mutations.ts`): accept + persist `msrp`/`discount`
  (patch on update, set on insert).

### 7. Director UI (minor)
In the part drawer (`PartFitmentDrawerBody`, `TabVehicleConfigs.tsx`) show the
stored price as `sale $X (was $Y · save $Z)` when `msrp`/`discount` are present.
Read-only display; no new query.

## Data flow (both paths)
```
part → candidate source URLs (≤3, deduped)
  → extractPriceFirecrawl each → {sale_price, msrp, discount, oem_seen, price_label, sells_this_part, ...}
  → crossSourceMedian of the raw sale_prices
  → resolveVerifiedPrice each:
       gauge (price_label looks like a sale price · sells_this_part · oem match
              · sale≤msrp · discount reconciles · agrees with median)
         └─ trips? → guided retry (corrective prompt) → re-gauge
       still bad → backstop (validateLlmPrice + $5k ceiling) → unverified
  → upsertPartPrice(price=sale_price, price_type="sale", msrp, discount, source_url, source_domain)
     fail → "unverified" (kept, dropped from customer median) · empty → untouched
```

## price_type taxonomy after this
`sale` (validated) and `unverified` (read the page, couldn't trust it). `fetch_failed`
is transient (row untouched). `llm_estimate` / `online_discount` / `you_save` are
**no longer produced**; legacy rows keep their type until repriced/re-enriched.

## Error handling
- Firecrawl error / empty → `fetch_failed` → existing row untouched (no data loss).
- Guided retry is bounded to **one** extra call per source, fired only when a gauge
  trips; a retry that also errors → `fetch_failed` (row untouched).
- Single-source part (no median) → the gauges (`price_label`/`sells_this_part`/
  `price<msrp`/OEM-match) carry the validation; the $5k ceiling is the final catch.
- Per-part / per-source failures never abort the run (try/catch per source).

## Testing
- Unit (`tests/`): the Firecrawl-json response parser (maps `data.json` →
  `{sale_price,msrp,discount,oem_seen,price_label,...}`, tolerates nulls); the
  **gauge** predicates (a `"You Save $13"` `price_label` trips; an `oem_seen`
  mismatch trips; `sells_this_part:false` trips; a value outside the median band
  trips) using fixtures captured from the probe. The gauge+retry logic is unit
  tested with a **stubbed extractor** (no network): a first-call result that trips a
  gauge must trigger exactly one retry, and a good retry result must resolve to
  `sale`. Cases that MUST resolve to `unverified`: the **$21,499** row even after
  retry; cases that MUST resolve to `sale`: the `online_discount $74.38` → `$37.19`
  row and an already-correct `sale` row (unchanged). `validateLlmPrice` already tested.
- Dev verification: reprice one config; confirm corrections land, no outlier is
  written, `msrp`/`discount` populate, and the retry fires on a seeded-bad source.

## Cost note
Firecrawl `json` extraction costs more credits than a plain scrape, and "all
candidate sources" multiplies that per part, plus the **guided retry adds at most
one extra call per source — only when a gauge trips** (most extractions pass first
shot). Capped at 3 sources/part. Enrichment credit spend rises materially (every
priced part × ≤3 json calls, + occasional retries); reprice is a low-frequency
director action so it's negligible there. Accepted trade-off for correctness; the
`PARTS_FIRECRAWL_PRICING` flag allows disabling.

## Out of scope
- The part↔source-URL mismatch (a rotor priced from a `brake_pads` page) — a
  source-link data bug, not extraction.
- Pricing-tab tier multipliers (separate subsystem).
- A dedicated per-part source *search* to widen candidates beyond what discovery
  already surfaced (would raise cost; revisit later).
