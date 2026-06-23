# RepairPal vehicle matcher — trim-as-model token matching (Tier 1) + engine-sibling fallback (Tier 2, deferred)

**Date:** 2026-06-23 · **Branch:** `waleed-fix` · **Status:** design, pending review
**Scope:** Tier 1 (token-set trim matching) — implemented + green. Tier 2 (LLM engine-sibling) — design approved 2026-06-23 (§5), building next.

## 1. Context / problem

The RepairPal endpoint resolver (`convex/vehicleEnrichment/repairpalEndpoint.ts`) resolves `(year, make, model, trim)` → RP `baseVehicleId` via the pure matcher `resolveBaseVehicleId` in `repairpalEndpointMatch.ts`, then pulls per-service estimates. A backfill across the 18 enriched dev configs resolved **13/17 real cars (148 rows)**. The 4 misses split into two *different* problems:

| Miss | Cause | In RP? | This spec |
|---|---|---|---|
| Mercedes `AMG C 63 S` | name spelled differently — RP has `C63 AMG S` (bvid 76427) | **yes** | **Tier 1 fixes it** |
| BMW `M550i xDrive` (×2) | RP catalog has **no** M550i (verified: 47 BMW-2020 entries, none) | **no** | Tier 2 (deferred) |
| Ford `Expedition` 2026 | RP base vehicle exists but no 2026 MOTOR estimate data yet | n/a | not fixable our side |

Today the matcher's ladder is: (1) exact model-line, (2) exact trim / trim-prefix, (3) loose model prefix/substring. It cannot align `"AMG C 63 S"` to `"C63 AMG S"` (token order + `C 63`↔`C63` spacing differ), so a car whose data **is** in RP fails to resolve.

**Normal flow is sound and already works** (NHTSA/VDB decode our car's engine → query RP → `selectVariant` picks the engine variant). The only Tier-1 gap is name alignment for trim-as-model makes (BMW/Mercedes), where the trim *is* RP's model name.

## 2. Goals / non-goals

**Goals**
1. Recover cars whose data is in RP but under a reordered/space-different trim name (Mercedes/AMG and similar), via a deterministic token-set match.
2. Stay conservative — never resolve to the *wrong* RP vehicle (e.g. `M550i` must match nothing, not a near-name).
3. Pure + unit-tested (no Convex), composing into the existing resolver unchanged.

**Goals (Tier 2, added 2026-06-23)**
4. For trims genuinely absent from RP (M550i), substitute the closest **engine-equivalent** RP base vehicle, chosen by an LLM, flagged `engine_sibling` so it's never mistaken for an exact match.

**Non-goals (this spec)**
- Fuzzy/edit-distance *name* matching (rejected — false-match risk; Tier 2 uses engine equivalence, not name fuzzing).
- A resolution cache (v1 — LLM fires only on rare absent trims during enrichment, never at quote time; cache is a noted follow-up).
- Any change to `selectVariant` or the resolver's per-service fetch/parse flow (Tier 2 only changes which `baseVehicleId` is chosen + adds two provenance fields).

## 3. Tier 1 design — token-set trim matching

Add one new rung to `resolveBaseVehicleId`, between the existing exact-trim match and the loose prefix/substring fallback. All current rungs and behavior are unchanged.

**Normalization → token set** (pure helper, e.g. `trimTokenSet(s)`):
1. lowercase; replace any non-alphanumeric run (hyphen, slash, space) with a single space; trim.
2. split on spaces → raw tokens.
3. **merge a 1–2 letter token immediately followed by a digit-leading token** into one (`["c","63"] → "c63"`, `["e","350"] → "e350"`). This collapses `"C 63"` to `"c63"` so it aligns with RP's `"C63"`.
4. return the **set** of resulting tokens.

Examples:
- our `"AMG C 63 S"` → `{amg, c63, s}`
- RP `"C63 AMG S"` → `{c63, amg, s}` → **equal set ⇒ match**
- our `"M550i xDrive"` → `{m550i, xdrive}`; no RP-2020-BMW candidate has that set ⇒ **no match** (correct)

**Match rule (conservative):** a candidate qualifies only on **exact set equality** between the query token-set (built from `trim`; fall back to `model` when `trim` is absent) and the candidate `modelName`'s token-set. No subset/superset matching in Tier 1 (a subset match like `C63 AMG S` → `C63 AMG` could pick a different car; excluded to stay safe). If zero or >1 candidates tie on exact-set equality, fall through to the existing loose rung (and ultimately to "no match").

**Placement in the ladder:**
1. exact model-line match (unchanged)
2. exact trim == modelName / trim-prefix (unchanged)
3. **NEW: token-set equality (trim → candidate modelName)**
4. loose model prefix/substring (unchanged)
5. none → `null` (unchanged)

Returns the same `number | null` it does today (baseVehicleId) — no signature change, so the resolver is untouched.

## 4. Testing (Tier 1)

Pure unit tests in `tests/repairpalEndpointMatch.test.ts` (extends the existing 15):
- **Recover:** `resolveBaseVehicleId([{id:76427,modelName:"C63 AMG S"}, {id:76426,modelName:"C63 AMG"}, {id:76423,modelName:"C300"}], {model:"C-Class", trim:"AMG C 63 S"})` → `76427` (exact-set; not 76426).
- **No false match:** the 2020-BMW list (`530i`, `540i xDrive`, `M850i xDrive`, `750i xDrive`, `M5`, …) with `{model:"5 Series", trim:"M550i xDrive"}` → `null`.
- **Don't downgrade specificity:** `trim:"C63 AMG S"` must not match `"C63 AMG"` (set inequality).
- **Existing exact/model-line matches still pass** (regression): Civic, exact `540i xDrive`.
- **Token merge unit tests:** `trimTokenSet("AMG C 63 S")` → `{amg,c63,s}`; `trimTokenSet("E 350")` → `{e350}`; `trimTokenSet("750i xDrive")` → `{750i,xdrive}`.

## 5. Tier 2 — LLM engine-sibling fallback (design — approved 2026-06-23)

For trims genuinely absent from RP (M550i): use a *different* RP base vehicle with the **same engine** (M550i 4.4 V8 → RP's 750i/M850i, both 4.4 V8), writing rows flagged `match_quality:"engine_sibling"` + `matched_via`.

**Why deferred — the blocker (probed this session):** picking the sibling requires knowing each RP *candidate's* engine, and we have no source for it:
- RP `/base-vehicles` exposes no engine; a BMW estimate returns `"all"` (no engine label) because RP's trim already pins the engine.
- NHTSA needs a VIN — we have VINs for *our* cars, not for RP's catalog cars (`750i`); NHTSA `GetModelsForMakeYear` returns model lines with no engine, and a partial VIN returns no displacement/cylinders (verified).
- VDB `ymm-specs/v3/{year}/{make}/{model}/{trim}` *has* the data but is **not provisioned on our key** — probe returned `400 "Record(s) were not found"` for every vehicle including VDB's own canonical spelling (`2024 VW Tiguan 2.0T SE R Line Black`), while VIN-decode works. So it's a plan gap, not a spelling gap.

**Chosen approach (2026-06-23): LLM sibling-selector.** VDB ymm-specs is the deterministic ideal but isn't provisioned; the LLM does the same job (identify the engine of an RP catalog car we have no VIN for) with **zero new dependencies**, reusing the Haiku client already wired in `vehicleDatabases.ts`. Rows are flagged `engine_sibling`, so a model-sourced match is honest by construction.

**Architecture** — plugs into the resolver `repairpalEndpoint.ts` ONLY when Tier 1 (`resolveBaseVehicleId`) returns `null`; everything stays behind the existing default-off resolver (no new flag, inert in prod; the LLM never runs at quote time).

Two new units, split for testability:
1. **Pure `pickValidSibling(answerName: string | null, candidates: {id,modelName}[]): {id,modelName} | null`** (in `repairpalEndpointMatch.ts`) — the LLM's chosen name must be an **exact member** of the candidate list, else `null` (hallucination guard). Unit-tested.
2. **Impure `selectEngineSiblingLLM(config, candidates)`** (new `repairpalEndpointSibling.ts`, mirrors `mapVDBActionsToSlugsWithHaiku`) — builds the prompt, calls Haiku (`HAIKU_MODEL`, `temperature:0`, JSON out), parses, runs `pickValidSibling`. **Graceful fallback → `null`** when `ANTHROPIC_API_KEY` is absent, the call errors, or the name fails validation. Not unit-tested (network), per the existing Haiku-mapper convention.

**LLM contract:**
> Our vehicle: `{year} {make} {model} {trim}`, engine `{displacementL}L / {cylinders}-cyl`. RepairPal has no listing for it. From this list of RP's `{make}` `{year}` models `[…]`, pick the ONE that is the closest **engine equivalent** (same displacement + cylinders + forced-induction class; prefer same drivetrain) for service-labor purposes, or `null` if none truly shares the engine.
> → `{ "sibling": "<exact modelName from the list>" | null, "reason": "…" }`

**Resolver flow:** Tier-1 `null` → `selectEngineSiblingLLM` → if a candidate is returned, fetch/write its estimates tagged `match_quality:"engine_sibling"`, `matched_via:"<modelName>"`; else `{ resolved:false }` (logged gap). Tier-1 hits tag `match_quality:"exact"`, `matched_via:null`.

**Schema delta:** add `match_quality: v.optional(v.string())` + `matched_via: v.optional(v.string())` to `repairpal_endpoint_estimates` and to `upsertRepairpalEndpointEstimate`'s args. Tier 1 needs no schema change (it already resolves; these fields just annotate provenance).

**No cache in v1** — the LLM fires only on RP-absent trims, only during enrichment/backfill (never at quote time), so repeat cost is negligible. A per-`(year,make,model,trim)` resolution cache is a documented follow-up if call volume grows.

**Testing:** pure `pickValidSibling` unit tests (in-list → returns it; not-in-list → null; null → null; case/space tolerance optional). Live integration: run the M550i config through the resolver → expect `match_quality:"engine_sibling"`, `matched_via` a 4.4 V8 BMW (750i/M850i), rows written with labor minutes + parts.

## 6. Rollout (Tier 1)

1. Implement + unit-test the matcher upgrade (pure; TDD).
2. Re-run the dev backfill (`devOnly/endpointBackfill`) for the Mercedes config (and any other name-mismatch cars) to land the recovered rows; re-verify counts.
3. No flag, no schema change, no live-quote wiring (parts/labor consumption remains deferred per the 2026-06-22 direction — this only affects *which configs the resolver can reach*, and the resolver is still only invoked by the dev backfill / the default-off pipeline hook).

## 7. Open items

- Whether to later allow a *guarded* subset match in Tier 1 (e.g. `C63 AMG S` → `C63 AMG` when RP lacks the exact variant) — deferred; exact-set only for now.
- Tier 2 engine source decision (VDB provisioning vs LLM) — separate follow-up.
