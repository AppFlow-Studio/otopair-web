# RepairPal Vehicle Matcher (Tier 1 token-set trim matching) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a conservative token-set trim matcher to `resolveBaseVehicleId` so cars whose data IS in RepairPal but under a reordered/space-different trim name (e.g. our `"AMG C 63 S"` ↔ RP `"C63 AMG S"`) resolve, without ever false-matching a car RP doesn't have (e.g. `M550i`).

**Architecture:** Pure helpers in `convex/vehicleEnrichment/repairpalEndpointMatch.ts` (no Convex imports, unit-tested in isolation). A new `trimTokenSet` normalizer feeds a new exact-set-equality rung inserted into the existing `resolveBaseVehicleId` ladder — after the exact-trim match, before the loose model prefix/substring fallback. No schema, flag, signature, or resolver-flow change. After it lands, re-run the dev backfill to write the recovered rows.

**Tech Stack:** TypeScript, vitest. Spec: `docs/superpowers/specs/2026-06-23-repairpal-vehicle-matcher-design.md`.

---

## Context the engineer needs

- `convex/vehicleEnrichment/repairpalEndpointMatch.ts` is a PURE module (no Convex imports) — it has `resolveMakeId`, `resolveBaseVehicleId`, `extractVariants`, `selectVariant`, `endpointPartCategory`, `SERVICE_REPAIRPAL_IDS`. It is unit-tested by `tests/repairpalEndpointMatch.test.ts` (15 existing tests, all green — must stay green).
- Current `norm` helper in that file: `const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();`
- Current `resolveBaseVehicleId` body (do not break the existing rungs):

```ts
export function resolveBaseVehicleId(
  baseVehicles: { id: number; modelName: string }[],
  cfg: { model: string; trim?: string | null },
): number | null {
  const model = norm(cfg.model);
  let m = baseVehicles.find((b) => norm(b.modelName) === model);
  if (m) return m.id;
  if (cfg.trim) {
    const trim = norm(cfg.trim);
    m = baseVehicles.find((b) => norm(b.modelName) === trim)
      || baseVehicles.find((b) => norm(b.modelName).startsWith(trim));
    if (m) return m.id;
  }
  m = baseVehicles.find((b) => norm(b.modelName).startsWith(model))
    || baseVehicles.find((b) => norm(b.modelName).includes(model));
  return m ? m.id : null;
}
```

- Test runner: `npx vitest run tests/repairpalEndpointMatch.test.ts` (Windows, PowerShell).
- Branch `waleed-fix` (intentionally not main; committing is fine).
- **Commit discipline (CRITICAL):** a user-owned file is pre-staged in the git index (`docs/superpowers/handoffs/2026-06-15-labor-sources-handoff.md`). NEVER `git commit -am` or bare `git commit -m`. Always commit with explicit pathspecs listing only your files, then verify with `git show --name-only --format="%h %s" HEAD`.

## File Structure

- Modify: `convex/vehicleEnrichment/repairpalEndpointMatch.ts` — add `trimTokenSet` (exported) + a private `setEq`, and the new rung in `resolveBaseVehicleId`.
- Modify (tests): `tests/repairpalEndpointMatch.test.ts` — add token-set unit tests + matcher integration tests.
- Run only (no edit): `convex/devOnly/endpointBackfill.ts` (already exists) to land recovered rows.

---

## Task 1: `trimTokenSet` tokenizer (pure)

**Files:**
- Modify: `convex/vehicleEnrichment/repairpalEndpointMatch.ts`
- Test: `tests/repairpalEndpointMatch.test.ts`

- [ ] **Step 1: Write the failing tests** — append to `tests/repairpalEndpointMatch.test.ts`:

```ts
import { trimTokenSet } from "../convex/vehicleEnrichment/repairpalEndpointMatch";

describe("trimTokenSet", () => {
  const eq = (a: Set<string>, b: string[]) =>
    a.size === b.length && b.every((x) => a.has(x));
  it("merges a 1-2 letter token followed by a number ('C 63' -> 'c63')", () => {
    expect(eq(trimTokenSet("AMG C 63 S"), ["amg", "c63", "s"])).toBe(true);
    expect(eq(trimTokenSet("E 350"), ["e350"])).toBe(true);
  });
  it("leaves already-merged trim tokens intact, lowercased", () => {
    expect(eq(trimTokenSet("C63 AMG S"), ["c63", "amg", "s"])).toBe(true);
    expect(eq(trimTokenSet("750i xDrive"), ["750i", "xdrive"])).toBe(true);
    expect(eq(trimTokenSet("M550i xDrive"), ["m550i", "xdrive"])).toBe(true);
  });
  it("strips punctuation and collapses whitespace", () => {
    expect(eq(trimTokenSet("T6 Momentum 7-Passenger"), ["t6", "momentum", "7", "passenger"])).toBe(true);
    expect(eq(trimTokenSet("  "), [])).toBe(true);
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

Run: `npx vitest run tests/repairpalEndpointMatch.test.ts`
Expected: FAIL — `trimTokenSet` is not exported.

- [ ] **Step 3: Implement** — add to `convex/vehicleEnrichment/repairpalEndpointMatch.ts` (near `norm`):

```ts
/**
 * Normalize a trim/model string to an order-independent token SET, collapsing
 * a 1-2 letter token immediately followed by a digit-leading token ("C 63" ->
 * "c63") so our "AMG C 63 S" aligns with RP's "C63 AMG S". Pure; used by the
 * token-set matching rung in resolveBaseVehicleId.
 */
export function trimTokenSet(s: string): Set<string> {
  const raw = s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const merged: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    const next = raw[i + 1];
    if (/^[a-z]{1,2}$/.test(t) && next && /^[0-9]/.test(next)) {
      merged.push(t + next);
      i++; // consume the number token we just merged
    } else {
      merged.push(t);
    }
  }
  return new Set(merged);
}

const setEq = (a: Set<string>, b: Set<string>): boolean =>
  a.size === b.size && [...a].every((x) => b.has(x));
```

- [ ] **Step 4: Run — verify PASS**

Run: `npx vitest run tests/repairpalEndpointMatch.test.ts`
Expected: PASS (the new `trimTokenSet` block + all 15 existing tests).

- [ ] **Step 5: Commit** (explicit pathspecs)

```bash
git commit -m "feat(repairpal): trimTokenSet — order-independent trim token set

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- convex/vehicleEnrichment/repairpalEndpointMatch.ts tests/repairpalEndpointMatch.test.ts
```
Then `git show --name-only --format="%h %s" HEAD` — confirm ONLY those 2 files.

---

## Task 2: token-set rung in `resolveBaseVehicleId`

**Files:**
- Modify: `convex/vehicleEnrichment/repairpalEndpointMatch.ts` (`resolveBaseVehicleId`)
- Test: `tests/repairpalEndpointMatch.test.ts`

- [ ] **Step 1: Write the failing tests** — append:

```ts
import { resolveBaseVehicleId } from "../convex/vehicleEnrichment/repairpalEndpointMatch";

describe("resolveBaseVehicleId — token-set rung", () => {
  const MB2018 = [
    { id: 76427, modelName: "C63 AMG S" },
    { id: 76426, modelName: "C63 AMG" },
    { id: 76423, modelName: "C300" },
  ];
  it("recovers a reordered/space-different trim (AMG C 63 S -> C63 AMG S)", () => {
    expect(resolveBaseVehicleId(MB2018, { model: "C-Class", trim: "AMG C 63 S" })).toBe(76427);
  });
  it("does not downgrade specificity (C63 AMG S must NOT match C63 AMG)", () => {
    const only = [{ id: 76426, modelName: "C63 AMG" }, { id: 76423, modelName: "C300" }];
    expect(resolveBaseVehicleId(only, { model: "C-Class", trim: "C63 AMG S" })).toBe(null);
  });
  it("never false-matches an RP-absent trim (M550i)", () => {
    const BMW2020 = [
      { id: 78124, modelName: "530i" },
      { id: 78121, modelName: "540i xDrive" },
      { id: 77823, modelName: "M850i xDrive" },
      { id: 77836, modelName: "750i xDrive" },
      { id: 77822, modelName: "M5" },
    ];
    expect(resolveBaseVehicleId(BMW2020, { model: "5 Series", trim: "M550i xDrive" })).toBe(null);
  });
  it("regression: exact model-line and exact trim still win", () => {
    expect(resolveBaseVehicleId([{ id: 78290, modelName: "Civic" }], { model: "Civic", trim: "LX" })).toBe(78290);
    expect(resolveBaseVehicleId(
      [{ id: 78121, modelName: "540i xDrive" }],
      { model: "5 Series", trim: "540i xDrive" },
    )).toBe(78121);
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

Run: `npx vitest run tests/repairpalEndpointMatch.test.ts`
Expected: FAIL on the "recovers a reordered..." case (returns `null` today).

- [ ] **Step 3: Implement** — insert the new rung in `resolveBaseVehicleId`, AFTER the existing `if (cfg.trim) { ... }` block and BEFORE the final loose-model block:

```ts
  // Token-set rung: our trim vs candidate modelName, order-independent, with
  // letter+digit merge. EXACT set equality only (conservative — no subset
  // match, so "C63 AMG S" never collapses to "C63 AMG"). Unique winner only.
  if (cfg.trim) {
    const qset = trimTokenSet(cfg.trim);
    if (qset.size) {
      const hits = baseVehicles.filter((b) => setEq(trimTokenSet(b.modelName), qset));
      if (hits.length === 1) return hits[0].id;
      // 0 or ambiguous (>1) -> fall through to the loose model rung below.
    }
  }
```

So the function reads: exact-model → (trim exact/prefix) → **token-set** → loose model → null.

- [ ] **Step 4: Run — verify PASS**

Run: `npx vitest run tests/repairpalEndpointMatch.test.ts`
Expected: PASS — all token-set rung tests + Task 1 tests + the 15 originals.

- [ ] **Step 5: Typecheck Convex**

Run: `npx convex dev --once`
Expected: `Convex functions ready!` (no type errors).

- [ ] **Step 6: Commit** (explicit pathspecs)

```bash
git commit -m "feat(repairpal): token-set rung in resolveBaseVehicleId

Recovers RP-present trims under reordered/space-different names (our
'AMG C 63 S' -> RP 'C63 AMG S') via exact token-set equality. Conservative:
no subset match, unique-winner only; RP-absent trims (M550i) stay unmatched.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- convex/vehicleEnrichment/repairpalEndpointMatch.ts tests/repairpalEndpointMatch.test.ts
```
Then `git show --name-only --format="%h %s" HEAD` — confirm ONLY those 2 files.

---

## Task 3: Re-run backfill — land the recovered rows

**Files:** none (run the existing `convex/devOnly/endpointBackfill.ts` against the recovered config).

The 2018 Mercedes C-Class config is `xd7733q4gtjfhwff835865e86x88f5kj` (from the prior survey). Its trim is `"AMG C 63 S"`; RP has `C63 AMG S` (bvid 76427).

- [ ] **Step 1: Ensure dev has the new matcher**

Run: `npx convex dev --once`
Expected: `Convex functions ready!`

- [ ] **Step 2: Backfill the Mercedes config**

Run: `npx convex run devOnly/endpointBackfill:backfill '{"configIds":["xd7733q4gtjfhwff835865e86x88f5kj"]}'`
Expected: `configsResolved: 1`, a non-empty `services` map for the Mercedes (oil_change, brakes, etc.).

- [ ] **Step 3: Verify the rows landed**

Run: `npx convex run devOnly/endpointResearch:verifyRows '{"configId":"xd7733q4gtjfhwff835865e86x88f5kj"}'`
Expected: `focusRowCount` > 0, rows with `labor_minutes` and parts ranges (engine-variant matched to the 4.0L V8 where the service splits by engine).

- [ ] **Step 4: (optional) Re-run the full backfill** to confirm no regressions and capture the new coverage number:

Run: `npx convex run devOnly/endpointBackfill:backfill '{"statuses":["complete"],"limit":50}'`
Expected: `configsResolved` increases by 1 (Mercedes now resolves); previously-resolved configs unchanged; M550i / Ford-2026 / EvalTest still unresolved (expected gaps).

- [ ] **Step 5:** No commit (dev data only). Report the before/after coverage (13 → 14 of 17 real configs) for the session notes.

---

## Self-review notes

- **Spec coverage:** §3 token-set design → Tasks 1–2; §4 tests → the test steps (Mercedes recover, no-downgrade, no-false-match, regression, tokenizer units); §6 rollout/re-backfill → Task 3. Tier 2 is explicitly out of scope (spec §5) — no task, by design.
- **No schema/flag/signature change** — `resolveBaseVehicleId` keeps its `number | null` return, so the resolver and all callers are untouched.
- **Conservative by construction:** exact set equality + unique-winner means a missing or ambiguous match falls through to today's behavior; it can only ADD resolutions that are exact token-set equal, never change an existing exact/model-line match (those rungs run first).
- **`devOnly/*` throwaways** (`endpointResearch.ts`, `endpointBackfill.ts`, `vdbProbe.ts`) remain uncommitted dev tooling unless the user asks to commit them.
