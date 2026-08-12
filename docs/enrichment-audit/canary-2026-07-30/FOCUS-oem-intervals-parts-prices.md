# Focus: OEM service intervals, OEM parts, prices

Measured across the 5-VIN canary set after the Jul 30 round. These are the three
things the data product actually sells; everything else is supporting work.

## Where we stand

| | coverage | detail |
|---|---|---|
| **OEM parts** | **88 / 88 = 100%** | every fitment carries a real OEM number; zero universal placeholders |
| **Prices** | **71 / 88 = 81%** | 17 parts have no trusted price |
| **OEM service intervals** | **12 / 139 = 9%** | only genuine `oem_manual` rows count |

Per vehicle:

| Vehicle | parts | with OEM # | priced | refuted | intervals | of which OEM |
|---|---|---|---|---|---|---|
| Jeep Wrangler | 20 | 20 | 19 | 0 | 29 | **0** |
| Grand Highlander | 8 | 8 | 5 | 0 | 28 | **6** |
| Camry | 23 | 23 | 22 | 2 | 27 | **6** |
| Subaru Forester | 27 | 27 | 17 | 1 | 28 | **0** |
| Yaris | 10 | 10 | 8 | 1 | 27 | **0** |

**The headline months number is not the OEM number.** Months fill reads ~50%
because this round's top-up stamps industry defaults into empty months slots —
honestly labelled (`interval_months_source: "default_fallback"`), but invented.
Genuine factory-published intervals are 9%.

---

## 1. OEM service intervals — 9%, the weakest of the three

### What works

`OEM domain` + `doc_kind: maintenance_schedule` → 6 intervals, every time. Both
Toyotas hit it:

- Camry — `assets.sia.toyota.com/…/T-MMS-19CamryHV.pdf`
- Grand Highlander — `toyota.com/…/T-MMS-24GrandHighlander.pdf`

### What fails, and why

| Vehicle | what happened |
|---|---|
| Subaru Forester | OEM host served `MSA5B1906A_STIS.pdf` — the **2019 BRZ Quick Guide** |
| Jeep Wrangler | non-OEM domain, `doc_kind: unknown` — a document with no schedule in it |
| Yaris | no manual row at all (its run predates the wiring) |

The Subaru case was the dangerous one. A successful *download* is not a
successful *manual*: the row carried a `file_id`, so `shouldSkipManualLookup`
read `fresh_manual` and **would have cached the wrong car's document as this
vehicle's manual for 180 days.**

### Fixed this round

1. **Rejection loop.** When the extractor reports `schedule_found: false`, the
   manual row is rejected: `file_id` cleared, URL recorded in `rejected_urls`,
   vehicle made eligible again.
2. **Immediate retry, not a 14-day wait.** A rejection means *untried candidates
   remain*, which is a different state from *dead host*. `shouldSkipManualLookup`
   now distinguishes them.
3. **Bounded at 3 rejections** — each costs a multi-MB download, a Files API
   upload and an extraction. Past that, an honest gap.
4. **Anonymity penalty in ranking.** A candidate naming neither the model nor the
   year is downranked; it cannot outweigh OEM provenance, so it only re-orders
   within a tier.

Verified live on the Forester — three cycles, each correctly identified and
refused, then it stopped paying:

```
1. MSA5B1906A_STIS.pdf → "the 2019 Subaru BRZ Quick Guide"        rejected
2. MSA5B1902A_STIS.pdf → "the 2019 Subaru Forester Quick Guide"   rejected
3. MSA5M1913A_STIS.pdf → "the EyeSight supplement"                rejected
4. skip (rejection_limit_reached)
```

### What's still needed

The loop converges on *different* documents but not on the *right* one, because
Subaru publishes opaque `MSA5*_STIS.pdf` filenames — neither the URL nor the
search title says which document it is, so ranking has nothing to sort on.

**Next: better discovery queries per make.** Toyota works because its slug
(`T-MMS-`) is self-identifying and `buildManualQueries` site-scopes to its host.
Subaru needs a query that surfaces the *Warranty & Maintenance Guide*
specifically, not whatever `techinfo.subaru.com` returns first. Same for
Jeep/Stellantis, which isn't reaching an OEM domain at all.

That is a per-make discovery problem, not a pipeline problem — and it is the
single highest-value remaining item for interval quality.

---

## 2. OEM parts — 100% carry a number, corroboration is the open question

Every fitment across all five vehicles carries a real OEM part number. The open
question is not *do we have a number* but *is it the right number*.

Three defences are now live:

- the **part-number existence oracle** (829,678 indexed Toyota numbers) catches
  confabulated numbers offline;
- the **adversarial fitment verifier** refutes wrong-vehicle parts — it removed
  3 on the Forester this round and soft-flagged the known-bad `26296SC011`;
- **RockAuto** is a structurally independent second opinion. Every prior part
  source was a dealer storefront, and `resolveOperator` collapses most of those
  to a couple of operators sharing one OEM catalogue upstream.

Corroboration reads 0–12%, and the cause is understood: only 2 of 5 runs got a
**second source family** into the ledger. The pipeline's own extraction enters as
`web_search` only during a full run finalize; configs healed via
`gatherClaimsForConfig` get `aftermarket_catalog` alone, and one family cannot
corroborate itself.

**Next: make `gatherClaimsForConfig` contribute the config's stored field values
as `web_search` claims**, so corroboration works on the cheap heal path too.
Small, well-scoped.

---

## 3. Prices — 81%, 17 gaps

| Vehicle | unpriced |
|---|---|
| Subaru Forester | 10 |
| Grand Highlander | 3 |
| Yaris | 2 |
| Camry | 1 |
| Jeep Wrangler | 1 |

The widened self-heal now retries **every** price gap, not just deferred ones —
but it did not close the Forester's, and a later re-check found them still open.

Two plausible causes, not yet separated:
- the parts genuinely have no listing on the scraped storefronts (Subaru
  dealer-only SKUs like `SOA821B900`, `SOA868V9270` look like this), or
- the backfill's per-action cap (`PARTS_PRICE_IMMEDIATE_BACKFILL_CAP`, default
  12) plus chain depth 2 is running out before it reaches them.

**Next: instrument the backfill** so an unpriced part records *why* — "no listing
found" and "budget exhausted" are currently indistinguishable, which is the same
silent-failure class this round has been hunting all day.

---

## Priority order

1. **Per-make manual discovery queries** — moves OEM intervals off 9%, the
   weakest metric of the three.
2. **Second family on the heal path** — makes corroboration real everywhere.
3. **Price-gap instrumentation** — turn 17 unknown gaps into a diagnosable list.

All three are bounded and none needs new infrastructure.
