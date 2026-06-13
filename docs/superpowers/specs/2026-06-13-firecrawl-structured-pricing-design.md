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
4. **Absolute sanity ceiling: $5,000** — reject a single-source `sale_price` above
   it unless a second source corroborates (kills the $21,499 case).
5. Keep the existing `validateLlmPrice` guardrails — they are the proven gate.

## Architecture

### 1. `extractPriceFirecrawl(url, oem, partName)` — `convex/vehicleEnrichment/firecrawl.ts`
Calls `POST /v2/scrape` with the `json` format + this schema:
```jsonc
formats: [{ type: "json",
  prompt: "Extract pricing for the auto part with OEM <oem>: current sale/discounted
           price, MSRP/list price, discount amount, in-stock, and the part number shown.",
  schema: { type:"object", required:["sale_price"], properties:{
    sale_price:{type:["number","null"]}, msrp:{type:["number","null"]},
    discount_amount:{type:["number","null"]}, in_stock:{type:["boolean","null"]},
    oem_part_number:{type:["string","null"]} }}}]
```
Returns `{ sale_price, msrp, discount, in_stock, oem_seen } | null`. Network-only;
no DB. Reuses the existing `FIRECRAWL_API_KEY` + base URL.

### 2. `resolveVerifiedPrice({url, oem, partName, crossSourceMedian})` — `priceReextract.ts`
Replaces `reextractPartPrice`'s tier logic. Steps:
1. `extractPriceFirecrawl(url, oem, partName)`. Empty/null → `{status:"fetch_failed"}`
   (caller must NOT demote the existing row — same rule as today).
2. Validate the returned `sale_price`:
   - **existing `validateLlmPrice`**: `price>0`, `price < msrp`, `oem_seen` matches
     target OEM, and within `[0.3×, 3×]` of `crossSourceMedian` when present.
   - **+ discount consistency**: if `msrp` and `discount` both present, require
     `|（msrp − sale_price) − discount| ≤ max($2, 5% of msrp)`; else ignore.
   - **+ absolute ceiling**: if `sale_price > $5,000` AND no `crossSourceMedian`
     corroboration (no 2nd source within band) → reject.
3. Pass → `{status:"sale", price:sale_price, msrp, discount}`; fail →
   `{status:"unverified", reason}`.

`ReextractOutcome` gains optional `msrp?` / `discount?` on the `"sale"` variant.

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
  → extractPriceFirecrawl each → {sale_price, msrp, discount, oem_seen}
  → crossSourceMedian of the raw sale_prices
  → resolveVerifiedPrice each: validateLlmPrice + discount-consistency + $5k ceiling
  → upsertPartPrice(price=sale_price, price_type="sale", msrp, discount, source_url, source_domain)
     fail → "unverified" (kept, dropped from customer median) · empty → untouched
```

## price_type taxonomy after this
`sale` (validated) and `unverified` (read the page, couldn't trust it). `fetch_failed`
is transient (row untouched). `llm_estimate` / `online_discount` / `you_save` are
**no longer produced**; legacy rows keep their type until repriced/re-enriched.

## Error handling
- Firecrawl error / empty → `fetch_failed` → existing row untouched (no data loss).
- Single-source part (no median) → absolute ceiling + `price<msrp` + OEM-match carry
  the validation; flagged in the outcome reason.
- Per-part / per-source failures never abort the run (try/catch per source).

## Testing
- Unit (`tests/`): the Firecrawl-json response parser (maps `data.json` →
  `{sale_price,msrp,discount,oem_seen}`, tolerates nulls); `resolveVerifiedPrice`
  validation with fixtures captured from the probe — **incl. the $21,499 row, which
  MUST be rejected**, the `online_discount $74.38` row (→ sale $37.19), and an
  already-correct `sale` row (→ unchanged). `validateLlmPrice` is already tested.
- Dev verification: reprice one config; confirm corrections land, no outlier is
  written, and `msrp`/`discount` populate.

## Cost note
Firecrawl `json` extraction costs more credits than a plain scrape, and "all
candidate sources" multiplies that per part. Capped at 3 sources/part. Enrichment
credit spend rises materially (every priced part × ≤3 json calls); reprice is a
low-frequency director action so it's negligible there. Accepted trade-off for
correctness; the `PARTS_FIRECRAWL_PRICING` flag allows disabling.

## Out of scope
- The part↔source-URL mismatch (a rotor priced from a `brake_pads` page) — a
  source-link data bug, not extraction.
- Pricing-tab tier multipliers (separate subsystem).
- A dedicated per-part source *search* to widen candidates beyond what discovery
  already surfaced (would raise cost; revisit later).
