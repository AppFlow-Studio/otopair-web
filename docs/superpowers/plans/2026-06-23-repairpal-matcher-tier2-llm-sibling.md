# RepairPal Matcher Tier 2 — LLM engine-sibling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** When a config's trim is genuinely absent from RepairPal (e.g. BMW `M550i`), substitute the closest **engine-equivalent** RP base vehicle chosen by an LLM (Haiku), writing rows flagged `match_quality:"engine_sibling"` + `matched_via`.

**Architecture:** A pure hallucination-guard `pickValidSibling` + an impure `selectEngineSiblingLLM` (mirrors `mapVDBActionsToSlugsWithHaiku`). The resolver calls the LLM only when Tier 1 (`resolveBaseVehicleId`) returns `null`. Two provenance fields added to the table + upsert. Everything stays behind the existing default-off resolver (LLM never runs at quote time).

**Tech Stack:** TypeScript, Convex, `@anthropic-ai/sdk` (Haiku `claude-haiku-4-5-20251001`), vitest + convex-test. Spec: `docs/superpowers/specs/2026-06-23-repairpal-vehicle-matcher-design.md` §5.

**Commit discipline:** explicit pathspecs ONLY (a user-owned file is pre-staged); never `git commit -am`/bare `-m`. Verify each commit with `git show --name-only --format="%h %s" HEAD`.

---

## Task 1: schema + upsert — `match_quality` / `matched_via`

**Files:**
- Modify: `convex/schema.ts` (`repairpal_endpoint_estimates`)
- Modify: `convex/vehicleEnrichment/repairpalEndpointMutations.ts` (args)
- Test: `tests/repairpalEndpointUpsert.test.ts`

- [ ] **Step 1: Extend the test** — in `tests/repairpalEndpointUpsert.test.ts`, add `match_quality` + `matched_via` to the `row` object and assert they persist:

```ts
    const row = {
      vehicle_config_id: configId, service_id: serviceId, base_vehicle_id: 78290,
      labor_minutes: 30, labor_hours: 0.5,
      parts: [{ role: "oil_filter", name: "Engine Oil Filter Element", price_low: 10, price_high: 14 }],
      match_quality: "engine_sibling", matched_via: "750i xDrive",
      fetched_at: 1,
    };
    // ...after the two upserts + collect:
    expect(rows[0].match_quality).toBe("engine_sibling");
    expect(rows[0].matched_via).toBe("750i xDrive");
```

- [ ] **Step 2: Run — verify FAIL** (`npx vitest run tests/repairpalEndpointUpsert.test.ts`) — the mutation arg validator rejects the unknown `match_quality` arg.

- [ ] **Step 3: Add the schema fields** — in `convex/schema.ts`, inside `repairpal_endpoint_estimates`, after `zip` / before `fetched_at`:

```ts
    match_quality: v.optional(v.string()),   // "exact" | "engine_sibling"
    matched_via: v.optional(v.string()),     // RP modelName substituted when engine_sibling
```

- [ ] **Step 4: Add the mutation args** — in `convex/vehicleEnrichment/repairpalEndpointMutations.ts`, add to the `args` object (handler is unchanged — it inserts/patches `args` directly):

```ts
    match_quality: v.optional(v.string()),
    matched_via: v.optional(v.string()),
```

- [ ] **Step 5: Codegen + run — verify PASS**

Run: `npx convex dev --once` then `npx vitest run tests/repairpalEndpointUpsert.test.ts`
Expected: compiles; test PASS (fields persist).

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(repairpal): match_quality + matched_via on endpoint estimates

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- convex/schema.ts convex/vehicleEnrichment/repairpalEndpointMutations.ts convex/_generated/api.d.ts tests/repairpalEndpointUpsert.test.ts
```
(`api.d.ts` only if codegen changed it.) Verify with `git show --name-only ... HEAD`.

---

## Task 2: `pickValidSibling` (pure hallucination guard)

**Files:**
- Modify: `convex/vehicleEnrichment/repairpalEndpointMatch.ts`
- Test: `tests/repairpalEndpointMatch.test.ts`

- [ ] **Step 1: Write the failing tests** — append:

```ts
import { pickValidSibling } from "../convex/vehicleEnrichment/repairpalEndpointMatch";

describe("pickValidSibling", () => {
  const cands = [{ id: 77836, modelName: "750i xDrive" }, { id: 77823, modelName: "M850i xDrive" }];
  it("returns the candidate when the LLM names one in the list (case/space tolerant)", () => {
    expect(pickValidSibling("750i xDrive", cands)).toEqual({ id: 77836, modelName: "750i xDrive" });
    expect(pickValidSibling("750I  XDRIVE", cands)).toEqual({ id: 77836, modelName: "750i xDrive" });
  });
  it("returns null for a hallucinated name not in the list", () => {
    expect(pickValidSibling("M550i xDrive", cands)).toBe(null);
  });
  it("returns null for null/empty", () => {
    expect(pickValidSibling(null, cands)).toBe(null);
    expect(pickValidSibling("", cands)).toBe(null);
  });
});
```

- [ ] **Step 2: Run — verify FAIL** (`pickValidSibling` not exported).

- [ ] **Step 3: Implement** — add to `repairpalEndpointMatch.ts` (uses the existing `norm`):

```ts
/**
 * Validate an LLM-proposed engine-sibling: the answer must be an EXACT member
 * (whitespace/case-insensitive via norm) of the candidate list, else null —
 * the hallucination guard for Tier 2. Returns the matched candidate.
 */
export function pickValidSibling(
  answerName: string | null | undefined,
  candidates: { id: number; modelName: string }[],
): { id: number; modelName: string } | null {
  if (!answerName) return null;
  const a = norm(answerName);
  return candidates.find((c) => norm(c.modelName) === a) ?? null;
}
```

- [ ] **Step 4: Run — verify PASS** (`npx vitest run tests/repairpalEndpointMatch.test.ts`).

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(repairpal): pickValidSibling — hallucination guard for engine-sibling

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- convex/vehicleEnrichment/repairpalEndpointMatch.ts tests/repairpalEndpointMatch.test.ts
```

---

## Task 3: `selectEngineSiblingLLM` (impure Haiku call)

**Files:**
- Create: `convex/vehicleEnrichment/repairpalEndpointSibling.ts`

> Network/LLM call — not unit-tested (mirrors `mapVDBActionsToSlugsWithHaiku`). Verified by Task 5's live run. Composes the tested `pickValidSibling`.

- [ ] **Step 1: Implement** `convex/vehicleEnrichment/repairpalEndpointSibling.ts`:

```ts
/**
 * repairpalEndpointSibling.ts — Tier 2 engine-sibling selector. When RepairPal
 * has no entry for our exact trim (e.g. BMW M550i), ask Haiku to pick the
 * closest ENGINE-equivalent RP base vehicle from the make+year candidate list.
 * Output is validated against the list (pickValidSibling) — no hallucinated
 * vehicles. Graceful: returns null when ANTHROPIC_API_KEY is absent or on error.
 * Mirrors the Haiku pattern in lib/vehicleDatabases.ts. Not unit-tested (network).
 */
import Anthropic from "@anthropic-ai/sdk";
import { pickValidSibling } from "./repairpalEndpointMatch";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

function getHaikuClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  return apiKey ? new Anthropic({ apiKey }) : null;
}

const SYSTEM =
  "You are a vehicle powertrain expert mapping a vehicle a labor database does NOT list to the closest engine-equivalent vehicle it DOES list, for service-labor estimation. Match on engine displacement, cylinder count, and forced-induction class first; prefer the same drivetrain. Only ever answer with a model spelled EXACTLY as it appears in the provided list. If none truly shares the engine, answer null. Output JSON only.";

export async function selectEngineSiblingLLM(
  cfg: {
    year: number; make: string; model: string; trim?: string | null;
    displacementL?: number | null; cylinders?: number | null; drivetrain?: string | null;
  },
  candidates: { id: number; modelName: string }[],
): Promise<{ id: number; modelName: string } | null> {
  if (!candidates.length) return null;
  const client = getHaikuClient();
  if (!client) {
    console.log("[repairpal-sibling] No ANTHROPIC_API_KEY — no engine-sibling");
    return null;
  }
  const engine =
    [cfg.displacementL ? `${cfg.displacementL}L` : null, cfg.cylinders ? `${cfg.cylinders}-cyl` : null]
      .filter(Boolean).join(" / ") || "unknown engine";
  const label = `${cfg.year} ${cfg.make} ${cfg.model} ${cfg.trim ?? ""}`.trim();
  const drive = cfg.drivetrain ? ` (${cfg.drivetrain})` : "";
  const userPrompt = `Our vehicle: ${label}${drive}, engine ${engine}.
RepairPal has no listing for it. From this list of RepairPal ${cfg.make} ${cfg.year} models, pick the ONE that is the closest engine-equivalent for service labor, or null if none shares the engine:
${candidates.map((c) => `  - ${c.modelName}`).join("\n")}

Return JSON: { "sibling": "<exact modelName from the list>" | null, "reason": "<short>" }`;

  try {
    const res = await client.messages.create({
      model: HAIKU_MODEL, max_tokens: 512, temperature: 0,
      system: SYSTEM, messages: [{ role: "user", content: userPrompt }],
    });
    let raw = "";
    for (const block of res.content) if (block.type === "text") raw += block.text;
    raw = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    const parsed = JSON.parse(raw);
    const name = typeof parsed?.sibling === "string" ? parsed.sibling : null;
    const picked = pickValidSibling(name, candidates);
    console.log(`[repairpal-sibling] ${label}: LLM -> ${name ?? "null"} ${picked ? "(valid)" : "(no/invalid)"}`);
    return picked;
  } catch (e) {
    console.warn(`[repairpal-sibling] Haiku failed (${e}) — no engine-sibling`);
    return null;
  }
}
```

- [ ] **Step 2: Typecheck** — `npx convex dev --once`. Expected: compiles (confirm `@anthropic-ai/sdk` default import matches `lib/vehicleDatabases.ts`; if that file uses `import Anthropic from "@anthropic-ai/sdk"`, mirror it).

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(repairpal): selectEngineSiblingLLM — Haiku engine-equivalent picker

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- convex/vehicleEnrichment/repairpalEndpointSibling.ts convex/_generated/api.d.ts
```
(`api.d.ts` only if codegen registered the new module.)

---

## Task 4: resolver integration

**Files:**
- Modify: `convex/vehicleEnrichment/repairpalEndpoint.ts`

- [ ] **Step 1: Add the import** at the top:

```ts
import { selectEngineSiblingLLM } from "./repairpalEndpointSibling";
```

- [ ] **Step 2: Replace the baseVehicleId resolution + early-return** (currently `const baseVehicleId = Array.isArray(baseVehicles) ? resolveBaseVehicleId(...) : null; if (baseVehicleId == null) return {resolved:false, services:{}};`) with:

```ts
    let baseVehicleId: number | null = Array.isArray(baseVehicles)
      ? resolveBaseVehicleId(baseVehicles, { model: args.model, trim: args.trim ?? null })
      : null;
    let matchQuality = "exact";
    let matchedVia: string | undefined = undefined;

    // Tier 2: exact/token-set miss -> ask the LLM for the closest engine-equivalent
    // RP base vehicle (flagged engine_sibling). Inert if no ANTHROPIC_API_KEY.
    if (baseVehicleId == null && Array.isArray(baseVehicles)) {
      const sib = await selectEngineSiblingLLM(
        {
          year: args.year, make: args.make, model: args.model, trim: args.trim ?? null,
          displacementL: args.displacementL ?? null, cylinders: args.cylinders ?? null,
          drivetrain: args.drivetrain ?? null,
        },
        baseVehicles,
      );
      if (sib) { baseVehicleId = sib.id; matchQuality = "engine_sibling"; matchedVia = sib.modelName; }
    }
    if (baseVehicleId == null) return { resolved: false, services: {} };
```

- [ ] **Step 3: Thread the tags into BOTH upsert calls** — in the `filter_replacement` branch's `upsertRepairpalEndpointEstimate` args AND the single/fallback branch's args, add:

```ts
          match_quality: matchQuality, matched_via: matchedVia,
```
(next to `zip: ZIP, fetched_at: Date.now(),`).

- [ ] **Step 4: Typecheck** — `npx convex dev --once`. Expected: compiles.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(repairpal): resolver Tier 2 — LLM engine-sibling on Tier 1 miss

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- convex/vehicleEnrichment/repairpalEndpoint.ts
```

---

## Task 5: live integration — M550i

**Files:** none (run the existing dev backfill).

The 2020 BMW 5 Series M550i xDrive config is `xd77j84ts9rshq9n16qv2e4y9n85k1pc`; the 2021 is `xd7e8azy86hsh3kg12fhkwh34n87h0je`.

- [ ] **Step 1:** `npx convex dev --once` (deploy the resolver).

- [ ] **Step 2:** Confirm `ANTHROPIC_API_KEY` is set on the deployment: `npx convex env list` (look for `ANTHROPIC_API_KEY`). If absent, the sibling is skipped (graceful) — set it or note the gap.

- [ ] **Step 3:** Backfill the M550i:

Run: `npx convex run devOnly/endpointBackfill:backfill '{"configIds":["xd77j84ts9rshq9n16qv2e4y9n85k1pc"]}'`
Expected: `configsResolved: 1`, a non-empty `services` map.

- [ ] **Step 4:** Verify the rows are flagged `engine_sibling`:

Run: `npx convex run devOnly/endpointResearch:verifyRows '{"configId":"xd77j84ts9rshq9n16qv2e4y9n85k1pc"}'`
Expected: rows present with labor minutes/parts; (the verify query can be extended to surface `match_quality`/`matched_via` — confirm `matched_via` is a 4.4 V8 BMW such as `750i xDrive` / `M850i xDrive`).

- [ ] **Step 5:** No commit (dev data). Report which sibling the LLM chose + the new coverage (14 → 15+ of 17).

---

## Self-review notes

- **Spec coverage:** §5 architecture → Tasks 2–4; schema delta → Task 1; testing (pure `pickValidSibling` + live M550i) → Tasks 2 & 5. No cache (spec §2 non-goal).
- **Hallucination guard:** the LLM's answer is always re-validated against the candidate list (`pickValidSibling`) — a made-up vehicle yields `null`, not a wrong baseVehicleId.
- **Inert by default:** the resolver is only invoked by the dev backfill / default-off pipeline hook; the LLM call is additionally gated behind a Tier-1 miss AND `ANTHROPIC_API_KEY`. Zero prod/quote-time impact.
- **`verifyRows`** may need a one-line extension to echo `match_quality`/`matched_via` (dev-only; not committed unless asked).
