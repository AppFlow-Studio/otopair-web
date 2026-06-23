# RepairPal vehicle matcher — trim-as-model token matching (Tier 1) + engine-sibling fallback (Tier 2, deferred)

**Date:** 2026-06-23 · **Branch:** `waleed-fix` · **Status:** design, pending review
**Scope of THIS spec:** Tier 1 only (token-set trim matching). Tier 2 (engine-sibling) is documented as a deferred follow-up with its blocker, not built here.

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

**Non-goals (this spec)**
- The engine-sibling fallback for RP-absent trims (M550i). Documented in §5 as deferred; needs a per-candidate engine source we don't currently have.
- Any change to `selectVariant`, the resolver's network flow, or the endpoint schema.
- Fuzzy/edit-distance matching (rejected — false-match risk).

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

## 5. Tier 2 — engine-sibling fallback (DEFERRED, documented)

For trims genuinely absent from RP (M550i): use a *different* RP base vehicle with the **same engine** (M550i 4.4 V8 → RP's 750i/M850i, both 4.4 V8), writing rows flagged `match_quality:"engine_sibling"` + `matched_via`.

**Why deferred — the blocker (probed this session):** picking the sibling requires knowing each RP *candidate's* engine, and we have no source for it:
- RP `/base-vehicles` exposes no engine; a BMW estimate returns `"all"` (no engine label) because RP's trim already pins the engine.
- NHTSA needs a VIN — we have VINs for *our* cars, not for RP's catalog cars (`750i`); NHTSA `GetModelsForMakeYear` returns model lines with no engine, and a partial VIN returns no displacement/cylinders (verified).
- VDB `ymm-specs/v3/{year}/{make}/{model}/{trim}` *has* the data but is **not provisioned on our key** — probe returned `400 "Record(s) were not found"` for every vehicle including VDB's own canonical spelling (`2024 VW Tiguan 2.0T SE R Line Black`), while VIN-decode works. So it's a plan gap, not a spelling gap.

**Resolution options when Tier 2 is taken up (pick later):**
- **VDB ymm-specs provisioning** (real/deterministic engine data — the preferred source; needs a billing/account action), or
- **LLM sibling-selector** (Haiku, already wired via `mapVDBActionsToSlugsWithHaiku`; flagged approximation, cached).
- Until then, RP-absent trims are **logged gaps** (reason recorded), not silently mismatched.

When built, Tier 2 adds `match_quality` + `matched_via` to `repairpal_endpoint_estimates`; Tier 1 needs no schema change.

## 6. Rollout (Tier 1)

1. Implement + unit-test the matcher upgrade (pure; TDD).
2. Re-run the dev backfill (`devOnly/endpointBackfill`) for the Mercedes config (and any other name-mismatch cars) to land the recovered rows; re-verify counts.
3. No flag, no schema change, no live-quote wiring (parts/labor consumption remains deferred per the 2026-06-22 direction — this only affects *which configs the resolver can reach*, and the resolver is still only invoked by the dev backfill / the default-off pipeline hook).

## 7. Open items

- Whether to later allow a *guarded* subset match in Tier 1 (e.g. `C63 AMG S` → `C63 AMG` when RP lacks the exact variant) — deferred; exact-set only for now.
- Tier 2 engine source decision (VDB provisioning vs LLM) — separate follow-up.
