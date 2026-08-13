# Firecrawl `/agent` — where it earns a place, and where it must not go

Written 2026-08-02, after rounds 15b–17. Paid plan confirmed available, so cost
is a budgeting question rather than a blocker.

Judged against the reinforcement plan's own tool filter: **a tool enters the
stack only when it produces data we cannot get today; cost optimisations that
add operational complexity are rejected.**

## Verified capabilities (docs, 2026-08-02)

| | |
|---|---|
| Models | `spark-1-mini` (default, "60% cheaper"), `spark-1-pro` (higher accuracy) |
| Structured output | `schema` param — "Optional JSON schema to structure the extracted data" |
| Domain constraint | `urls` + `strictConstrainToURLs` |
| Budget | `maxCredits`, **defaults to 2500 per task** |
| Async | returns `{success, id}`; poll for the result |
| Source URLs | **NOT documented as returned** — see constraint 2 below |

Note the blog's "Spark-1 Fast" naming does not appear in the API reference.

## Where it genuinely earns a place

### 1. Rotor discard minimums — the strongest case

`rotor_minimums: 0` on EVERY vehicle in rounds 15b, 16 and 17, with `rotor_min`
error tags on all of them. `summit_centric` and `amsoil` are dark (no headless
tier); `brembo` ran on 1 of 5 vehicles and still produced nothing. This is data
we demonstrably cannot get today — the tool filter's exact criterion.

Shape: `strictConstrainToURLs` to Brembo / Centric / manufacturer service PDFs,
schema `{axle, thickness_kind, value_mm, observed_label, source_url}`. The
`observed_label` requirement is what keeps the existing rotor law intact — a
minimum with no verbatim label is discarded downstream regardless of source.

### 2. The repair rung after a pass-2 refutation — highest coverage value

This is the #1 coverage blocker identified in round 17. Today the sequence is
`verify -> role-resource repair -> verify(pass 2)`, and a pass-2 refutation has
NO repair stage behind it, so the role stays empty until the next run. The Jeep
Grand Cherokee finished 0/3 quotable for exactly this reason.

An agent query is well-shaped for it — "the OEM front brake pad part number for
a 2019 Porsche 911 GT3 RS" — and the volume is naturally low, because it fires
only on a refutation.

### 3. Corroboration — PARTIAL, and only if constrained

`field_corroboration` is 0-12%. An agent could add a second family, but ONLY if
constrained to sources genuinely independent of the dealer-catalog operator
cluster. Pointed at the open web it will re-read the same storefronts and
inflate APPARENT corroboration without adding independence — precisely the trap
the operator-collapse work was built to close. Either constrain the URLs, or do
not count its claims as a separate family.

## Where it does NOT help — do not use it here

- **Replacing the deterministic catalog scrape.** Deterministic parses are
  cheaper, reproducible and auditable. Swapping them for agentic research is a
  regression in every dimension we care about.
- **The fetch-tier single point of failure.** `/agent` runs ON Firecrawl, so it
  DEEPENS that dependency rather than relieving it. It is not a substitute for
  the Scrapling browser tier (verified working on RevolutionParts: 200,
  278 KB, 8.5s, where plain curl and Scrapling HTTP both get Cloudflare 403s).
- **Batch-2's empty applicable-services set, and the zero-search runs.** Both
  are internal pipeline logic defects. No external tool fixes them, and
  reaching for one here would mask the bug rather than repair it.

## Non-negotiable integration constraints

1. **Claims, never direct writes.** Agent output enters `field_claims` as a new
   source family and goes through the same reconciler, the same fitment
   verifier, and the same interchange law as every other source. A powerful
   source that writes directly is exactly how present-but-wrong returns.
2. **`source_url` REQUIRED in the schema we pass.** The docs do not promise
   source URLs, and a claim without provenance cannot be audited, corroborated
   or refuted — it would be unusable to us regardless of accuracy.
3. **Explicit `maxCredits` per call, plus a per-run cap.** The 2500 default is
   far beyond what a single field is worth. Env-gated (`ENRICHMENT_AGENT=off`)
   so it can be killed without a deploy, like every other tool in this pipeline.
4. **Fires only AFTER the deterministic path misses.** Never first, never as
   the primary source.

## Suggested order

1. Rotor minimums (isolated field, zero current coverage, clean success metric:
   `rotor_minimums` goes above 0).
2. Repair rung on pass-2 refutation (directly attacks the 0/3 and 6/8 results).
3. Reassess corroboration only after 1 and 2 have run on a real batch.

Success is measured on the existing audit fields — `rotor_minimums`,
`parts_quotable`, `field_corroboration` — not on a new dashboard.
