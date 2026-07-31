# What changed this round

Every change below is on `feat/3-portals`, deployed to dev `third-bird-914`,
**uncommitted**. Tests: 1875 passing; the two failures (`customer_late`,
`timeSlotAvailability`) are pre-existing and documented — `timeSlotAvailability`
passes in isolation and is a load-dependent flake.

---

## 0. The keystone: a succeeded batch whose body we couldn't read reported success

`utils/batchClient.ts` hardcoded `error: null` on every request the API
succeeded on. When batch 2 returned a body that parsed to nothing, `data = {}`
flowed downstream with no error anywhere:

- `v3pipeline`'s `if (r2?.error)` branch never fired,
- the `batch2` step trace recorded `status: "ok"`,
- `services[]` was silently empty.

That single empty array starved three consumers at once — labor (27/27
`default_fallback`), quotability (`{pct: 1, services: []}`, a *vacuous pass*),
and role applicability (`applicable_services_unknown`) — while the config
finalized `complete` at fill 83.

The proof was not inference: `applicable_services_unknown` is pushed only when
the batch-2 applicable set is empty **and** there is no prior run to fall back
on. The Yaris carried that exact tag.

**Fixed:** `classifyParseOutcome` (pure, unit-tested in
`tests/batchClientParseOutcome.test.ts`) reports a parse throw, and reports an
empty parse as an error *only* when there was substantial text to parse — so a
genuinely empty response is still a non-error and doesn't raise false alarms.

**Deliberate consequence:** an unreadable **batch 1a** now aborts the run via
`failEnrichmentRun` and returns the config to `pending`, instead of finalizing
with nothing. That is the correct direction, but it converts silent bad data
into visible failures. Expect new failure reports rather than quiet degradation.

---

## 1. Labor — 100% `default_fallback`

Two couplings, both to batch-2 output, both failing closed and silently.

- **Hard gate.** The whole labor block lives inside `if (r2)`. A batch-2 timeout
  meant no labor source was ever contacted.
- **Soft gate.** `laborServices` was built by iterating the batch-2 `services`
  array. Empty in ⇒ `laborAllSources` receives `services: []` ⇒ its write loop
  drops **every** fetched row (`if (!serviceId) continue`). OLP and RepairPal
  were paid for over the network and their hours thrown away.

**Fixed:**
- `laborServices` falls back to `laborRelabor._laborConfigInputs`, which derives
  the list from the `services` table gated by the canonical
  `getApplicableServices` helper — the same gate the booking surface uses. Used
  as a *fallback only*, so the happy path is byte-identical.
- The orchestrator's return value is captured (it was discarded) and logged.
- A scheduled `laborRelaborConfig` retry fires when the inline pass produced
  nothing — so labor is no longer a child of batch-2 success. Ordering is safe
  against the fallback seeder: `recomputeLaborForConfigService` *patches* an
  existing row to `aggregated` when real hours land.
- The pre-flight log was missing `repairpalEndpoint` entirely; added.

---

## 2. Months intervals — 19%

Two independent causes.

- `ensureAllServiceIntervals` owns the only months table in the pipeline
  (`SERVICE_DEFAULTS`, 16 slugs) but was **insert-only** — `continue` on any
  service that already had a row. A row created by the VDB writer (which passes
  `interval_miles` and never `interval_months`) kept a permanently empty months.
  Nothing ever came back for it, and the fill metric counts a row as filled on
  `miles != null || months != null`, so nothing noticed.
- `manualLibrary` — the only OEM-backed months source — was reachable **only**
  from a nightly cron at 3 configs/night. A fresh config never touched it.

**Fixed:**
- A months top-up in the existing retro-cleanup loop. Fills only holes, never
  overwrites; excludes wear items (a months recurrence for brake pads is
  nonsense), `on_demand` rows, and `mechanic_verified` rows.
- New `service_intervals.interval_months_source`. A row can legitimately carry a
  well-sourced `interval_miles` and a defaulted months; one `data_quality` field
  cannot express two provenances. Stamping the row down would erase real miles
  provenance, stamping it up would launder an invented months as OEM-sourced —
  both are present-but-wrong. Writers that land a real months clear the stamp.
- The manual chain (`resolveManualForVehicle` → `extractIntervalsFromManual`) is
  now scheduled from the run. Scheduled, never inline: it is a multi-MB PDF
  download plus a Files API upload plus a large-context extraction, and finalize
  is hard-killed at 600s.

---

## 3. Rotor minimums — 0 on all five canaries

`resolveRotorMinimums` consulted exactly one source: cached `parts_catalog`
storefront markdown. Storefront listings publish `diameter x NOMINAL`. **The
discard minimum is not on those pages at all** — the resolver could not have
found it no matter how well it parsed.

**Fixed:** a new `sourced_catalog` tier fed by the Brembo adapter through the
claim ledger. Ranked *below* the markdown parse (an OEM page's own discard text
always wins) and *above* deriving from nominal.

Stamped `oem_spec_flagged`, never clean `oem_spec` — Brembo's minimum is the
discard spec for *Brembo's* disc and can differ from the OEM casting (Camry
XV70 front: Brembo 25mm vs Toyota 26mm). `classify()` warn-caps a flagged value
so it can never auto-sell a rotor job, but it *can* stop grading a rotor against
nothing, which is what a null minimum does today.

An incoherent claim (minimum ≥ its own nominal) is refused outright.

---

## 4. Corroboration — 0%, and the metric was measuring the wrong thing

Two separate problems.

**The ledger was orphaned.** `sourceAdapters/{registry,claimLedger}.ts` and all
six adapters were written, unit-tested, and imported by *nothing*. There was no
table to persist a `Claim` into.

**The metric was mismeasuring.** `auditRunFlow` computed corroboration as
`part_fitments.source_count >= 2`. The pipeline writes exactly one fitment per
part per run with `source_count: 1`, so it was **arithmetically pinned at 0% on
any single fresh run**, regardless of data quality.

**Fixed:**
- New `field_claims` table and `claimGathering.ts` — a fan-out that runs the
  fetchable adapters, persists claims, and reconciles them. It is *evidence
  only*: it never writes a vehicle field, which is what lets it run on a live
  fleet with no chance of a present-but-wrong write.
- The pipeline's own extracted values enter as the `web_search` family, so the
  adapters have something to agree *with*. Without this every field carries one
  family and the ledger can only ever report `single_source`.
- Renamed the old figure `fitment_multi_source`; added `field_corroboration`
  that counts **agreement** (reconciler winner backed by 2+ families), never
  mere participation — two families that contradict each other corroborate
  nothing.
- `purgeClaims`, because claims are durable and cumulative by design; a bad
  batch would otherwise leave permanent evidence the reconciler keeps counting.

Adapters marked `needs_headless` (`summit_centric`, `amsoil`) are **skipped, not
attempted** — there is no headless browser reachable from a Convex action
(verified repo-wide; Playwright here is the Next E2E harness). They were burning
a 20s timeout each to return nothing.

---

## 5. RockAuto — a new, structurally independent source

Every OEM part number in the pipeline came from dealer storefronts, and
`resolveOperator` collapses most of those to a couple of operators sharing one
OEM catalogue upstream. RockAuto is an aftermarket retailer with an independent
catalogue — a genuinely separate voice on exactly the fields with none.

Verified live: plain GET, no token needed, `_nck` is optional; the full
interchange set including the numbers behind the page's "Show All" toggle; and a
clean negative case (fabricated number → "No Parts", zero results).

**The law it enforces.** The "OEM / Interchange Numbers" list belongs to ONE
AFTERMARKET PART — it is Wagner's list of OEM numbers its EC1521 pad replaces,
spanning Honda CR-V, Odyssey, Pilot, Passport **and a Subaru** (`26296AL03A`).
Those OEM parts are not interchangeable with each other on a vehicle. So the
adapter emits a claim **only for the number it was asked about**; siblings are
metadata for supersession-aware price search and can never reach a role slot.
`tests/adapter_rockauto.test.ts` names this case explicitly.

RockAuto is part-number-keyed, not vehicle-keyed, so `AdapterVehicle` grew
`known_parts` and the registry grew `PART_KEYED_ADAPTERS` — such adapters are
skipped when there are no numbers to attest rather than paying for a lookup that
can only return empty.

---

## 6. Parts triangle — 7/10

- **Refute had no route back.** `refute_flagged` was set in three places
  (`flagRefutedFitments`, the pre-demoted re-insert in `upsertPartAndFitment`,
  and `roleIdentityAudit`) and cleared in **none**, so one soft flag broke that
  part's triangle permanently — even after a later pass confirmed the same
  number. New `resolveRefutedFitment` clears a soft flag on re-confirmation,
  deletes the durable `refuted_fitments` row (without which the next run
  re-applies the flag and the repair silently undoes itself), and **refuses to
  overturn an adjudicated `block`**.
- **The price self-heal only retried *deferred* work.** A part whose price
  discovery simply came up empty produced no deferred gap and was never retried
  — it sat unpriced on a config already stamped `complete`. Now every price gap
  triggers the bounded backfill.

---

## 7. Interval provenance floor

New staged gate (`ENRICHMENT_INTERVAL_PROVENANCE_GATE`, default log, with an
`ENRICHMENT_INTERVAL_PROVENANCE_MAX` tolerance), following the existing
`ENRICHMENT_AXLE_GATE` precedent. It counts intervals resting on nothing better
than the default table, plus rows whose months came only from the top-up.

**Deliberately never enforcing at finalize.** The only high-provenance interval
source is the manual extraction, which is a scheduled follow-up arriving minutes
later — enforcing here would fail essentially every fresh config by
construction, and `bookings.ts` books parts services only on status exactly
`complete`.

---

## Files

**New:** `vehicleEnrichment/claimGathering.ts`,
`vehicleEnrichment/sourceAdapters/rockauto.ts`, `devOnly/canaryRun.ts`,
`tests/batchClientParseOutcome.test.ts`, `tests/adapter_rockauto.test.ts`,
`tests/fixtures/sourceAdapters/rockauto/*`.

**Changed:** `schema.ts` (`field_claims`, `interval_months_source`),
`v3pipeline.ts`, `v3mutations.ts`, `v3queries.ts`, `completionGate.ts`,
`manualLibrary.ts`, `utils/batchClient.ts`, `utils/lateSanityFlags.ts`,
`utils/rotorSpecResource.ts`, `sourceAdapters/{registry,types}.ts`,
`devOnly/auditRunFlow.ts`, and three existing test files.

## Known defect, filed not fixed

`sourceAdapters/wixFilters.ts` emits **every** OE number a WIX filter replaces
as a separate rival claim on one field — 16 competing values on
`cabin_filter_oem`, 10 on `oil_filter_oem`, all from one domain. The ledger
contains it correctly as `conflict_tie` so no bad value is written, but WIX can
never corroborate anything. Same bug class RockAuto was built to avoid; the fix
is the same pattern, but its tests encode the current multi-emit contract, so it
is a deliberate contract change rather than a patch.
