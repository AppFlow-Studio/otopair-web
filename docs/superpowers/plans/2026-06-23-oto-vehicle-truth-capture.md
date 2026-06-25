# Oto Vehicle-Truth Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Oto arguing its `inferred` projection against a user's direct statement about their own car, and capture user-stated vehicle truth (live mileage, "oil light is on", fault lights) back into the vehicle record via a one-tap-confirm render tool → guarded mutation → maintenance-pipeline re-run.

**Architecture:** Three pieces, reusing the existing `render_record_confirmation → mutation → runPipeline` plumbing. (1) A new render tool `render_vehicle_update` Oto fires when a user asserts vehicle truth. (2) A new mutation `vehicleTruth.applyVehicleTruth` the mobile confirm component calls — guarded mileage write + service-state flag + fault-light append + pipeline re-run. (3) Prompt rules so Oto treats an in-chat user assertion as outranking its own `inferred` projection, splits intent (book vs assert-truth vs ask), and never invents warning lights. Mileage guard is a pure unit-tested helper.

**Tech Stack:** Convex (TS mutations/queries), vitest + convex-test, the Oto prompt system (`convex/oto/prompt/stable.ts`), Haiku tool-calling (`convex/oto/chat.ts` / `tools.ts` / `dispatcher.ts`).

**Spec:** `docs/superpowers/specs/2026-06-18-oto-vehicle-truth-capture-design.md`. **Verified code anchors (2026-06-23):** trust-gating + provenance ladder `prompt/stable.ts:409-480`; `getMonthsUntilDue` `lib/intervals.ts:244-266`; mirror pattern `recordConfirmation.ts:54-79` (auth resolve) + `maintenance.ts:65-137` `upsertRecord` (pipeline trigger 107-114); tool wiring `chat.ts` `TOOL_NAMES_V1:91-136` + drift-guard `226-244`, `tools.ts:609` (`render_record_confirmation` schema), `dispatcher.ts:191-208` (packaging); schema `vehicle_owners.mileage:1098` / `knownIssues:1113`, `vehicle_service_states.quick_read_flag/urgency:1376-77` keyed `(vehicle_owner_id, service_id)`; `runPipeline` `maintenance_pipeline.ts:312` args `{vehicleOwnerId, triggeredBy}`; `quick_read_flag` set at `maintenance_pipeline.ts:280`.

**Design decisions locked (spec open-items):** mileage guard `maxDelta = max(annual_rate × years_elapsed, 25000)`; reject `proposed < current` (backward) and `proposed > current + maxDelta` (absurd-forward). `render_vehicle_update` and `render_record_confirmation` stay **separate** cards for v1. `runPipeline` `triggeredBy:"oto_chat"` is treated intervals-only (like `quick_read`).

**Commit discipline (CRITICAL):** a user-owned file is pre-staged in the git index (`docs/superpowers/handoffs/2026-06-15-labor-sources-handoff.md`). NEVER `git commit -am` / bare `git commit -m`. Always commit with explicit pathspecs and verify with `git show --name-only --format="%h %s" HEAD`.

## File Structure

- Create: `convex/oto/vehicleTruthGuard.ts` — pure mileage-guard helpers (`computeMaxDelta`, `validateMileageUpdate`). No Convex imports → unit-testable.
- Create: `convex/vehicleTruth.ts` — the `applyVehicleTruth` mutation (auth resolve + guarded writes + pipeline trigger).
- Modify: `convex/schema.ts` — add `mileage_source` + `mileage_updated_at` to `vehicle_owners`.
- Modify: `convex/oto/tools.ts` — `render_vehicle_update` tool schema + `RENDER_TOOLS` + `OTO_TOOL_CATEGORY`.
- Modify: `convex/oto/chat.ts` — `render_vehicle_update` in `TOOL_NAMES_V1`.
- Modify: `convex/oto/dispatcher.ts` — `render_vehicle_update` packaging branch.
- Modify: `convex/oto/prompt/stable.ts` — user-assertion-precedence rule, intent split, hallucination guard, tool doc.
- Modify: `convex/maintenance_pipeline.ts` — accept `triggeredBy:"oto_chat"`.
- Tests: `tests/vehicleTruthGuard.test.ts`, `tests/applyVehicleTruth.test.ts`.

---

## Task 1: Mileage guard (pure helpers)

**Files:**
- Create: `convex/oto/vehicleTruthGuard.ts`
- Test: `tests/vehicleTruthGuard.test.ts`

- [ ] **Step 1: Write the failing test** (`tests/vehicleTruthGuard.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { computeMaxDelta, validateMileageUpdate } from "../convex/oto/vehicleTruthGuard";

describe("computeMaxDelta", () => {
  it("uses annual_rate × years when above the 25k floor", () => {
    expect(computeMaxDelta(30000, 2)).toBe(60000);
  });
  it("falls back to the 25k floor for small/missing inputs", () => {
    expect(computeMaxDelta(12000, 1)).toBe(25000);
    expect(computeMaxDelta(null, null)).toBe(25000);
    expect(computeMaxDelta(0, 0)).toBe(25000);
  });
});

describe("validateMileageUpdate", () => {
  it("accepts a plausible forward jump", () => {
    expect(validateMileageUpdate(40000, 46796, 25000)).toEqual({ ok: true });
  });
  it("accepts the first reading when there is no current mileage", () => {
    expect(validateMileageUpdate(null, 46796, 25000)).toEqual({ ok: true });
  });
  it("rejects a backward odometer", () => {
    expect(validateMileageUpdate(46796, 40000, 25000)).toEqual({ ok: false, reason: "backward" });
  });
  it("rejects an absurd forward jump beyond maxDelta", () => {
    expect(validateMileageUpdate(40000, 200000, 25000)).toEqual({ ok: false, reason: "absurd_forward" });
  });
  it("rejects a non-positive / absurd absolute value", () => {
    expect(validateMileageUpdate(null, 0, 25000)).toEqual({ ok: false, reason: "implausible" });
    expect(validateMileageUpdate(null, 2_000_000, 25000)).toEqual({ ok: false, reason: "implausible" });
  });
});
```

- [ ] **Step 2: Run — verify FAIL** (`npx vitest run tests/vehicleTruthGuard.test.ts`) — module not found / not exported.

- [ ] **Step 3: Implement** (`convex/oto/vehicleTruthGuard.ts`):

```ts
/**
 * Pure mileage-guard helpers for vehicle-truth capture (no Convex imports →
 * unit-testable). An odometer never goes backward, and a single chat update
 * shouldn't leap an implausible amount.
 */
const MILEAGE_FLOOR_DELTA = 25_000;     // minimum allowed forward jump
const MILEAGE_ABS_MAX = 1_000_000;      // absolute sanity ceiling

/** maxDelta = max(annual_rate × years_elapsed, 25k). Missing inputs → 25k floor. */
export function computeMaxDelta(
  annualRate: number | null | undefined,
  yearsElapsed: number | null | undefined,
): number {
  const projected = (annualRate ?? 0) * (yearsElapsed ?? 0);
  return Math.max(projected, MILEAGE_FLOOR_DELTA);
}

export type MileageVerdict = { ok: true } | { ok: false; reason: "backward" | "absurd_forward" | "implausible" };

/** Validate a proposed odometer reading against the current value + allowed delta. */
export function validateMileageUpdate(
  current: number | null | undefined,
  proposed: number,
  maxDelta: number,
): MileageVerdict {
  if (!Number.isFinite(proposed) || proposed <= 0 || proposed > MILEAGE_ABS_MAX) {
    return { ok: false, reason: "implausible" };
  }
  if (current == null) return { ok: true }; // first reading — nothing to compare
  if (proposed < current) return { ok: false, reason: "backward" };
  if (proposed > current + maxDelta) return { ok: false, reason: "absurd_forward" };
  return { ok: true };
}
```

- [ ] **Step 4: Run — verify PASS** (`npx vitest run tests/vehicleTruthGuard.test.ts`).

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(oto): mileage guard helpers for vehicle-truth capture

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- convex/oto/vehicleTruthGuard.ts tests/vehicleTruthGuard.test.ts
```
Then `git show --name-only --format="%h %s" HEAD` — confirm ONLY those 2 files.

---

## Task 2: Schema — mileage provenance fields

**Files:**
- Modify: `convex/schema.ts` (`vehicle_owners`, near `mileage` at line ~1098)

- [ ] **Step 1:** In the `vehicle_owners` table, immediately after the `mileage: v.optional(v.number()),` line, add:

```ts
    mileage_source: v.optional(v.string()),      // e.g. "chat_self_reported" | "onboarding" | "verified"
    mileage_updated_at: v.optional(v.number()),  // ms epoch of the last mileage write
```

- [ ] **Step 2:** Run `npx convex dev --once` — Expected: `Convex functions ready!` (schema compiles; both fields optional so no migration).

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(oto): vehicle_owners mileage provenance fields

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- convex/schema.ts
```
(Verify name-only; api.d.ts is unchanged by a schema-field add.)

---

## Task 3: `applyVehicleTruth` mutation

**Files:**
- Create: `convex/vehicleTruth.ts`
- Test: `tests/applyVehicleTruth.test.ts`

> Reuses Task 1's pure guard. Auth/owner resolve mirrors `recordConfirmation.ts:54-79`; pipeline trigger mirrors `maintenance.ts:107-114`. **Before writing, read those two ranges + `maintenance_pipeline.ts:270-293` (the `upsertServiceState`/quick-read write) to copy the exact `quick_read_flag` / `quick_read_urgency` value convention + the `self_reported` provenance the quarterly check-in uses.**

- [ ] **Step 1: Write the failing test** (`tests/applyVehicleTruth.test.ts`) using the convex-test harness (`makeT()` from `tests/helpers.ts`):

```ts
import { describe, it, expect } from "vitest";
import { makeT } from "./helpers";
import { api } from "../convex/_generated/api";

describe("applyVehicleTruth", () => {
  async function seed(t: any) {
    return await t.run(async (ctx: any) => {
      const userId = await ctx.db.insert("users", { clerkUserId: "clerk_vt", email: "vt@test.local", role: "user", createdAt: 1 });
      const vehicleId = await ctx.db.insert("vehicles", { vin: "VTVIN0000000000001" } as any);
      const ownerId = await ctx.db.insert("vehicle_owners", {
        vin: "VTVIN0000000000001", user_id: userId, mileage: 40000, preOnboardingComplete: true,
      } as any);
      const serviceId = await ctx.db.insert("services", { name: "Oil Change", slug: "oil_change" } as any);
      return { userId, vehicleId, ownerId, serviceId };
    });
  }
  const ident = { subject: "clerk_vt", tokenIdentifier: "clerk_vt" };

  it("writes a plausible mileage + provenance", async () => {
    const t = makeT(); const s = await seed(t);
    const res = await t.withIdentity(ident).mutation(api.vehicleTruth.applyVehicleTruth, {
      vehicle_id: s.vehicleId, mileage: 46796,
    });
    expect(res.needsReconfirm).toBeFalsy();
    const owner = await t.run((ctx: any) => ctx.db.get(s.ownerId));
    expect(owner.mileage).toBe(46796);
    expect(owner.mileage_source).toBe("chat_self_reported");
    expect(typeof owner.mileage_updated_at).toBe("number");
  });

  it("refuses a backward odometer (needsReconfirm), no write", async () => {
    const t = makeT(); const s = await seed(t);
    const res = await t.withIdentity(ident).mutation(api.vehicleTruth.applyVehicleTruth, {
      vehicle_id: s.vehicleId, mileage: 30000,
    });
    expect(res.needsReconfirm).toBe(true);
    expect(res.reason).toBe("backward");
    const owner = await t.run((ctx: any) => ctx.db.get(s.ownerId));
    expect(owner.mileage).toBe(40000); // unchanged
  });

  it("flags a service due (quick_read) from a maintenance-reminder claim", async () => {
    const t = makeT(); const s = await seed(t);
    await t.withIdentity(ident).mutation(api.vehicleTruth.applyVehicleTruth, {
      vehicle_id: s.vehicleId,
      service_claims: [{ service_slug: "oil_change", kind: "light_on" }],
    });
    const state = await t.run((ctx: any) =>
      ctx.db.query("vehicle_service_states")
        .withIndex("by_vehicle_service", (q: any) => q.eq("vehicle_owner_id", s.ownerId).eq("service_id", s.serviceId))
        .unique());
    expect(state).not.toBeNull();
    expect(state.quick_read_flag).toBeTruthy();
  });

  it("appends a fault light to knownIssues", async () => {
    const t = makeT(); const s = await seed(t);
    await t.withIdentity(ident).mutation(api.vehicleTruth.applyVehicleTruth, {
      vehicle_id: s.vehicleId, fault_lights: ["check_engine"],
    });
    const owner = await t.run((ctx: any) => ctx.db.get(s.ownerId));
    expect((owner.knownIssues ?? []).includes("check_engine")).toBe(true);
  });
});
```

- [ ] **Step 2: Run — verify FAIL** (`npx vitest run tests/applyVehicleTruth.test.ts`) — `api.vehicleTruth` undefined.

- [ ] **Step 3: Implement** (`convex/vehicleTruth.ts`). Fill the `// MIRROR:` spots from the files named in the task header; everything else is verbatim:

```ts
/**
 * vehicleTruth.ts — one-tap-confirm write-back of user-stated vehicle truth from
 * Oto chat. Called by the render_vehicle_update mobile confirm component. Guards
 * mileage (monotonic + plausible), flags maintenance-reminder claims via the
 * existing quick_read override (self_reported), appends fault lights to
 * knownIssues, and re-runs the maintenance pipeline. Auth/owner resolve mirrors
 * recordConfirmation.ts; pipeline trigger mirrors maintenance.ts upsertRecord.
 */
import { mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { computeMaxDelta, validateMileageUpdate } from "./oto/vehicleTruthGuard";

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export const applyVehicleTruth = mutation({
  args: {
    vehicle_id: v.string(),
    mileage: v.optional(v.number()),
    service_claims: v.optional(v.array(v.object({
      service_slug: v.string(),
      kind: v.union(v.literal("due"), v.literal("light_on")),
    }))),
    fault_lights: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<any> => {
    const now = Date.now();

    // ── Auth + ownership resolve (mirror recordConfirmation.ts:55-79) ──
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("unauthenticated");
    const user: Doc<"users"> | null = await ctx.db
      .query("users").withIndex("by_clerkUserId", (q: any) => q.eq("clerkUserId", identity.subject)).unique();
    if (!user) throw new Error("user not found in Convex");
    const vehicle: Doc<"vehicles"> | null = await ctx.db.get(args.vehicle_id as Id<"vehicles">);
    if (!vehicle) throw new Error(`vehicle not found: ${args.vehicle_id}`);
    const owner: Doc<"vehicle_owners"> | null = await ctx.db
      .query("vehicle_owners").withIndex("by_vin_user", (q: any) => q.eq("vin", vehicle.vin).eq("user_id", user._id)).unique();
    if (!owner) throw new Error(`vehicle_owner not found for vehicle ${args.vehicle_id}`);

    // ── Mileage (guarded; a violation blocks the write and asks Oto to re-confirm) ──
    let mileageUpdated = false;
    if (args.mileage != null) {
      const yearsElapsed = owner.mileage_updated_at ? (now - owner.mileage_updated_at) / YEAR_MS : null;
      const annualRate = (owner as any).annual_mileage_rate ?? null; // MIRROR: confirm the owner field name for annual rate; null is a safe fallback (→ 25k floor)
      const maxDelta = computeMaxDelta(annualRate, yearsElapsed);
      const verdict = validateMileageUpdate(owner.mileage ?? null, args.mileage, maxDelta);
      if (!verdict.ok) {
        return { ok: false, needsReconfirm: true, reason: verdict.reason };
      }
      await ctx.db.patch(owner._id, {
        mileage: args.mileage, mileage_source: "chat_self_reported", mileage_updated_at: now,
      } as any);
      mileageUpdated = true;
    }

    // ── Maintenance-reminder claims → quick_read flag on the service state (self_reported) ──
    const servicesFlagged: string[] = [];
    for (const claim of args.service_claims ?? []) {
      const service: Doc<"services"> | null = await ctx.db
        .query("services").withIndex("by_slug", (q: any) => q.eq("slug", claim.service_slug)).unique()
        .catch(async () => (await ctx.db.query("services").collect()).find((s: any) => s.slug === claim.service_slug) ?? null);
      if (!service) continue;
      const existing = await ctx.db
        .query("vehicle_service_states")
        .withIndex("by_vehicle_service", (q: any) => q.eq("vehicle_owner_id", owner._id).eq("service_id", service._id))
        .unique();
      // MIRROR maintenance_pipeline.ts:270-293 for the exact quick_read_flag / quick_read_urgency
      // values + the self_reported provenance convention the quarterly check-in writes.
      const patch = { quick_read_flag: "due", quick_read_urgency: "self_reported" } as any;
      if (existing) await ctx.db.patch(existing._id, patch);
      else await ctx.db.insert("vehicle_service_states", { vehicle_owner_id: owner._id, service_id: service._id, ...patch } as any);
      servicesFlagged.push(claim.service_slug);
    }

    // ── Fault lights → knownIssues (dedup append) ──
    let faultLightsAdded: string[] = [];
    if (args.fault_lights?.length) {
      const current: string[] = Array.isArray(owner.knownIssues) ? owner.knownIssues : [];
      const merged = Array.from(new Set([...current, ...args.fault_lights]));
      faultLightsAdded = args.fault_lights.filter((f) => !current.includes(f));
      await ctx.db.patch(owner._id, { knownIssues: merged } as any);
    }

    // ── Re-run the maintenance pipeline (mirror maintenance.ts:107-114) ──
    if (owner.preOnboardingComplete) {
      await ctx.scheduler.runAfter(0, internal.maintenance_pipeline.runPipeline, {
        vehicleOwnerId: owner._id, triggeredBy: "oto_chat",
      });
    }

    return { ok: true, mileageUpdated, servicesFlagged, faultLightsAdded };
  },
});
```

> NOTE on the `services.by_slug` index: if `services` has no `by_slug` index the `.withIndex` throws — the `.catch` falls back to a full scan. If a `by_slug` index DOES exist, drop the `.catch` fallback and use it directly. Confirm during implementation.

- [ ] **Step 4: Run convex codegen + the test**

Run: `npx convex dev --once` then `npx vitest run tests/applyVehicleTruth.test.ts`
Expected: compiles; all 4 cases PASS. (If a seed insert fails convex-test schema validation, add the missing required fields per `convex/schema.ts`.)

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(oto): applyVehicleTruth — guarded vehicle-truth write-back + pipeline re-run

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- convex/vehicleTruth.ts convex/_generated/api.d.ts tests/applyVehicleTruth.test.ts
```
(Include `api.d.ts` — the new module registers there.) Verify name-only excludes the handoff doc.

---

## Task 4: `render_vehicle_update` tool wiring

**Files:**
- Modify: `convex/oto/tools.ts`, `convex/oto/chat.ts`, `convex/oto/dispatcher.ts`

> No unit test — tool registration is verified by the drift-guard (Task 5) + `convex dev` compile. **Read `tools.ts:609-628` (`render_record_confirmation` schema), the `RENDER_TOOLS` array + `OTO_TOOL_CATEGORY` dict, `chat.ts:91-136` (`TOOL_NAMES_V1`), and `dispatcher.ts:191-208` (the `showRecordConfirmation` packaging) and MIRROR each for `render_vehicle_update`.**

- [ ] **Step 1: `tools.ts`** — add a `render_vehicle_update` tool schema mirroring `render_record_confirmation`, with input:

```ts
{
  mileage: { type: "number", description: "user-stated current odometer reading" },        // optional
  service_claims: { /* array of { service_slug: string, kind: "due" | "light_on" } */ },   // optional
  fault_lights: { /* array of warning_light_id strings e.g. "check_engine" */ },           // optional
}
```
Add `"render_vehicle_update"` to the `RENDER_TOOLS` list and set `OTO_TOOL_CATEGORY["render_vehicle_update"] = "render"` — exactly as `render_record_confirmation` is registered.

- [ ] **Step 2: `chat.ts`** — add `"render_vehicle_update"` to the `TOOL_NAMES_V1` array (next to `"render_record_confirmation"`, ~line 118).

- [ ] **Step 3: `dispatcher.ts`** — add a `case "render_vehicle_update":` branch in the tool dispatcher mirroring the `render_record_confirmation`/`showRecordConfirmation` branch (~191-208): package the tool input into the mobile envelope (e.g. `{ kind: "showVehicleUpdate", ...input }`) so the app renders the confirm card that calls `vehicleTruth.applyVehicleTruth` on tap.

- [ ] **Step 4:** Run `npx convex dev --once` — Expected: compiles clean. (The drift-guard may `console.error` that the prompt doesn't yet reference the tool — that's fine until Task 5; it does NOT fail compilation.)

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(oto): register render_vehicle_update render tool

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- convex/oto/tools.ts convex/oto/chat.ts convex/oto/dispatcher.ts
```

---

## Task 5: Prompt rules — trust-precedence, intent split, hallucination guard, tool doc

**Files:**
- Modify: `convex/oto/prompt/stable.ts`

> Prompt edits aren't unit-tested; correctness = the drift-guard passes (`render_vehicle_update` now in `TOOL_NAMES_V1`) + the transcript eval (Task 7). Read `stable.ts:409-480` (provenance ladder + suggest-don't-mutate) first.

- [ ] **Step 1 — Trust-precedence (P1):** immediately AFTER the provenance-ladder definition (~line 412), add:

```
USER-STATED TRUTH OUTRANKS YOUR PROJECTION. A user's direct statement about
their own car THIS TURN — a live odometer reading, "my oil light is on", "it's
due" — is ground truth that outranks any `inferred` projection (including the
service-due/"weeks until due" math). NEVER argue an `inferred` value against
what the user just told you. Acknowledge it, ask AT MOST ONE confirming
question only if the claim is ambiguous or material, then act: offer the
`render_vehicle_update` card so they can one-tap-confirm the change.
```

- [ ] **Step 2 — Intent split (P3):** add the §6 matrix as guidance:

```
INTENT SPLIT — classify what the user wants before acting:
- "I want an oil change" / "book me in" → BOOKING. Show availability / book. Do
  NOT flag any service on the vehicle.
- "My oil light is on" / "oil's due" → TRUTH (maintenance reminder). One confirm
  → offer render_vehicle_update with a service_claim, then offer booking.
- "Check-engine light is on" → TRUTH (fault). One confirm → render_vehicle_update
  with a fault_light, recommend a diagnostic.
- "I'm at 46,796 miles" → TRUTH (mileage). render_vehicle_update with the mileage.
- "When's my oil due?" → ASK. Answer from data; if the data is thin, invite them
  to add it — never fabricate. A booking request must never write a vehicle flag.
```

- [ ] **Step 3 — Hallucination guard (P4):** add:

```
WARNING LIGHTS — only ever reference a warning light that is present in the
vehicle's `knownIssues` or that the user stated THIS TURN. Never enumerate,
infer, or invent additional lights.
```

- [ ] **Step 4 — Tool doc:** in the Tools section (where `render_record_confirmation` is documented), add a `render_vehicle_update` entry describing its three optional inputs (`mileage`, `service_claims:[{service_slug,kind}]`, `fault_lights:[id]`) and that it renders a one-tap-confirm card writing the stated truth back to the vehicle. (This `\`render_vehicle_update\`` mention is what the drift-guard at `chat.ts:226-244` looks for.)

- [ ] **Step 5:** Run `npx convex dev --once` — Expected: compiles, and NO `[oto/chat] CONFIG ERROR` about `render_vehicle_update` (the drift-guard now finds it in `TOOL_NAMES_V1`).

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(oto): prompt rules — user-truth precedence, intent split, hallucination guard

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- convex/oto/prompt/stable.ts
```

---

## Task 6: Pipeline accepts `triggeredBy: "oto_chat"`

**Files:**
- Modify: `convex/maintenance_pipeline.ts` (the `triggeredBy` branch at ~line 348)

- [ ] **Step 1:** Read `maintenance_pipeline.ts:340-360`. The pipeline branches `isFullPipeline = triggeredBy === "onboarding" || "checkin"`. `"oto_chat"` must behave like `"quick_read"` (intervals-only — NOT a full re-onboard). Confirm `"quick_read"` already falls into the non-full path; if the code only special-cases specific strings for the intervals-only path, add `"oto_chat"` alongside `"quick_read"` so it's handled, not dropped.

- [ ] **Step 2:** Run `npx convex dev --once` (compiles) + `npx vitest run` over any existing pipeline test (e.g. `grep -l maintenance_pipeline tests/*.ts`) — Expected: PASS (no behavior change for existing triggers).

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(oto): maintenance pipeline accepts oto_chat trigger (intervals-only)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- convex/maintenance_pipeline.ts
```

---

## Task 7: Integration — replay the transcript

**Files:** none (manual eval + documentation).

- [ ] **Step 1:** In the Oto Sim (director `#otoSim`) or a scripted Haiku eval, run the transcript scenario: user says *"The oil-change light is on, I'm at 46,796 miles"* for a vehicle whose `inferred` projection says "not due for 7 weeks."

- [ ] **Step 2: Assert the corrected behavior:**
  - Oto does NOT argue the 7-weeks projection.
  - Oto acknowledges + fires `render_vehicle_update` with `{ mileage: 46796, service_claims: [{ service_slug: "oil_change", kind: "light_on" }] }`.
  - On confirm → `applyVehicleTruth` sets `vehicle_owners.mileage = 46796` (+ `mileage_source`), flags the oil service `quick_read` (self_reported), and schedules `runPipeline(... triggeredBy:"oto_chat")`.
  - Oto does not reference any warning light absent from `knownIssues`/the user's turn.

- [ ] **Step 3:** Document the result in `docs/superpowers/reviews/2026-06-23-oto-vehicle-truth-capture-verify.md` (before/after behavior + the mutation effects). Commit the doc.

---

## Self-review notes

- **Spec coverage:** P1 trust-precedence → Task 5 Step 1; P2 write-back (tool + mutation + pipeline) → Tasks 2,3,4,6; P3 intent split → Task 5 Step 2; P4 hallucination guard → Task 5 Step 3. Safeguards: mileage monotonic+plausible → Task 1+3; `self_reported` provenance → Task 3; booking-never-writes → Task 5 prompt rule. Transcript replay → Task 7.
- **Mirror-points the implementer MUST read (not guess):** the exact `quick_read_flag`/`quick_read_urgency` values + `self_reported` convention (`maintenance_pipeline.ts:270-293`), the `services` slug-index name, the `vehicle_owners` annual-rate field name, and the render-tool schema/dispatcher boilerplate (`tools.ts`/`dispatcher.ts`). Each is flagged `MIRROR:` inline.
- **YAGNI:** no mileage-history table (spec §9 follow-up, out of scope); no card-merge (kept separate for v1); the optional post-check that strips ungrounded lights (spec §3.3) is deferred — the prompt rule (Task 5 Step 3) is the v1 guard.
