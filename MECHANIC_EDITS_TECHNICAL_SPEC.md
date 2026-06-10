# Mechanic Edits — Technical Spec & Handoff

**Audience:** Temur (wiring this in) · **Author intent:** maximum detail, zero ambiguity, so it can be built without round-trips.
**Branch context:** `waleed-flagship` · **Director route:** `app/(director-panel)/director` → Shell tab **"Mechanic Edits"** → `TabMechanicEdits.tsx`
**Backend:** Convex (serverless, document DB). No Prisma/Drizzle. All reads/writes go through Convex `query`/`mutation` functions in `convex/`.

> **TL;DR of the gap:** The **suggest → review → accept (full) → confirm → undo** loop is fully built and working today. The piece that is **specced but NOT implemented** is **partial / per-field correction** at accept time. The schema field (`review_decisions`) exists, and the **undo logic already reads it**, but the **accept mutation ignores it and applies everything all-or-nothing**. Building partial accept is the main net-new work, and it must write `review_decisions` in exactly the shape `undoMechanicVerification` already expects. This doc specifies that shape precisely.

---

## 1. The flow, end to end

```
                          MECHANIC APP (out of scope here)
  ┌──────────────────────────────────────────────────────────────────────┐
  │ Mechanic finishes a job → reviews the vehicle config we showed them →  │
  │ for each field marks: confirmed / corrected / unknown.                 │
  │ Submits → convex/services/verification.ts :: processMechanicVerification│
  │ inserts ONE row into `mechanic_verifications` with status:"pending".   │
  └──────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
                          DIRECTOR PANEL (this spec)
  ┌──────────────────────────────────────────────────────────────────────┐
  │ TabMechanicEdits lists rows, filterable by status:                     │
  │   pending · accepted · rejected · undone · all                         │
  │ Director opens a row → VerificationModal → field-by-field table.       │
  └──────────────────────────────────────────────────────────────────────┘
        │                         │                         │
   REJECT │                  ACCEPT │ (full today,      PARTIAL │ (TO BUILD:
        │                  partial to build)         per-field accept/skip/override)
        ▼                         ▼                         ▼
  status:"rejected"      For every corrected/confirmed   Only the fields the director
  no data written        field: write enrichment_evidence approved get written; the rest
  audit entry            + restore value to data table   are recorded as "skip".
                         increment verification_count     review_decisions[] persisted.
                         maybe flip config → "verified"
                         audit entry per field + summary
                                   │
                                   ▼
                          status:"accepted"
                                   │
                              UNDO │ (only valid from "accepted")
                                   ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │ undoMechanicVerification.undoById                                       │
  │  • restores each applied field's PRIOR value to its data table         │
  │  • retires the mechanic enrichment_evidence, re-promotes the prior     │
  │    non-mechanic evidence to is_latest:true                             │
  │  • decrements verification_count (downgrades "verified"→"enriched" if <3)│
  │  • status → "undone" (terminal, distinct from rejected/pending)        │
  │  • audit entry per field + summary                                     │
  └──────────────────────────────────────────────────────────────────────┘
```

**State machine for `mechanic_verifications.status`:**

| From | Action | To | Reversible? |
|---|---|---|---|
| `pending` | Accept (full or partial) | `accepted` | yes → Undo |
| `pending` | Reject | `rejected` | terminal |
| `accepted` | Undo | `undone` | terminal |
| `rejected` | — | — | terminal |
| `undone` | — | — | terminal |

Notes:
- All mutations **guard on the current status** and silently no-op if it doesn't match (e.g. `acceptVerification` returns early unless `status === "pending"`; `undoById` returns `{ok:false, reason}` unless `status === "accepted"`). Re-clicking is safe.
- `undone` is intentionally a **separate terminal state** from `rejected`. It means "we accepted this, applied data, then rolled it back." The data is restored to the pre-mechanic state, but the historical fact that it happened is preserved in the row and the audit log.
- There is currently **no path from `undone` or `rejected` back to `pending`** in the UI. (The undo file's docstring mentions re-review, but the code sets `undone`, not `pending`. If re-review is desired, that's a new requirement — see §10.)

---

## 2. File map — everything that touches this feature

| Path | Role |
|---|---|
| `app/(director-panel)/director/components/tabs/TabMechanicEdits.tsx` | The entire UI: filter tabs, master table, detail modal, quick-action buttons. ~559 lines. |
| `app/(director-panel)/director/components/Shell.tsx` | Sidebar nav; the "Mechanic Edits" entry + pending count badge. |
| `app/(director-panel)/director/components/Primitives.tsx` | `Badge`, `Button`, `Avatar`, `Modal`, `AuditButton`, `tableStyles`. The modal's audit drawer lives here. |
| `app/(director-panel)/director/components/DirectorSessionCtx.ts` | React context providing `{ name, userId }` of the logged-in director — used as `actorName` / `actorId` on every mutation. |
| `convex/director_mechanic_verifications.ts` | **Read + write backend.** `listPending`, `listAll`, `acceptVerification`, `rejectVerification`, plus `mapRow` (the row-shaping helper). |
| `convex/undoMechanicVerification.ts` | `undoById` (UI-facing), `undoLatest` + `_undoInternal` (dashboard convenience). Field-routing sets live here. |
| `convex/services/verification.ts` | `processMechanicVerification` — the **mechanic-side writer** that creates the pending row. Defines the submission contract. |
| `convex/audit_log.ts` | `listByEntity` (drives the modal's audit drawer), `listRecent`. |
| `convex/director.ts` | `sidebarCounts` — returns `mechanicEdits` = pending count for the nav badge. |
| `convex/schema.ts` | Table definitions: `mechanic_verifications`, `vehicle_configs`, `enrichment_evidence`, `audit_log`, `director_users`, `mechanics`, `chassis_specs`, `trim_specs`, `engines`, `transmissions`. |

**UI conventions to match:** tables are **plain HTML `<table>` with inline styles + `tableStyles`** (NOT TanStack/shadcn). Colors come from CSS variables (`var(--slate-700)`, `var(--green-600)`, etc.). Icons: `lucide-react`. Modal/Badge/Button are local primitives. Don't introduce a table library — follow the existing inline-style pattern.

---

## 3. Data model — `mechanic_verifications` (the master table)

Defined in `convex/schema.ts` (lines ~683–704). This is the single row per submission. **Every field below must be considered when wiring the review side.**

```ts
mechanic_verifications: defineTable({
  mechanic_id:        v.id("mechanics"),        // REQUIRED — FK → mechanics
  vehicle_config_id:  v.id("vehicle_configs"),  // REQUIRED — FK → vehicle_configs (the thing being verified)
  job_id:             v.optional(v.string()),   // optional job linkage  ⚠ see §7 type mismatch
  service_id:         v.optional(v.id("services")),
  verifications:      v.optional(v.any()),      // REQUIRED in practice — array of VerificationField (see below)
  actual_labor_hours: v.optional(v.number()),
  parts_used_correct: v.optional(v.boolean()),
  overall_accuracy:   v.optional(v.number()),   // ⚠ written as a STRING enum by the mechanic side — see §7
  status:             v.optional(v.string()),   // "pending" | "accepted" | "rejected" | "undone"
  verified_at:        v.optional(v.number()),   // epoch ms; set on accept/reject/undo (NOT submit-time, see §7)
  created_at:         v.optional(v.number()),   // epoch ms submit time
  review_decisions:   v.optional(v.any()),      // ← PARTIAL-ACCEPT payload. Written at accept; read by undo. See §9.
  reviewer_id:        v.optional(v.id("director_users")), // who reviewed/reverted
})
  .index("by_vehicle_config", ["vehicle_config_id"])
  .index("by_mechanic",       ["mechanic_id"])
  .index("by_job",            ["job_id"])
  .index("by_service",        ["service_id"])
  .index("by_status",         ["status"])   // ← the workhorse index; all list queries use it
```

### 3.1 `verifications[]` — the per-field payload (the heart of the table)

Each element is a **VerificationField**. This is the canonical shape the director UI expects (`TabMechanicEdits.tsx` lines 12–17, mirrored in `director_mechanic_verifications.ts` lines 4–9):

```ts
type VerificationField = {
  field_name:       string                                  // snake_case key, e.g. "oil_viscosity"
  our_value:        unknown                                 // what WE showed the mechanic (system value)
  corrected_value:  unknown                                 // what the mechanic says it should be
  status:           "confirmed" | "corrected" | "unknown"
  notes?:           string                                  // optional free text from mechanic (stored, not yet shown)
}
```

Semantics of `status`:
- **`confirmed`** — mechanic agrees our value is right. On accept → we log evidence at **0.98 confidence** using `our_value`. No data table change (value already correct).
- **`corrected`** — mechanic says our value is wrong; `corrected_value` is the truth. On accept → retire prior evidence, write new evidence at **0.99 confidence**, and (in undo) the data table holds `corrected_value`.
- **`unknown`** — mechanic couldn't verify. **Ignored on accept**, **skipped on undo**. Shown in the modal for completeness only.

**`field_name` must be one of the known routing keys** (§8) for the value to actually reach a data table on accept/undo. A field with an unrecognized `field_name` will still create `enrichment_evidence` on accept, but **will not be written to or restored from engines/transmissions/chassis_specs/trim_specs/vehicle_configs** — it falls through the routing `if/else` chain. Keep the mechanic-app field vocabulary in sync with the routing sets.

---

## 4. Related tables (what accept/undo touch)

### 4.1 `vehicle_configs` (the entity being verified)
Relevant fields (`schema.ts` ~198–251):
```ts
engine_id:          v.optional(v.id("engines"))         // accept/undo route ENGINE_FIELDS here
transmission_id:    v.optional(v.id("transmissions"))   // → TRANSMISSION_FIELDS
chassis_code:       v.optional(v.string())              // → chassis_specs lookup by_chassis_code → CHASSIS_FIELDS
verification_count: v.optional(v.number())              // incremented on accept, decremented on undo
enrichment_status:  v.optional(v.string())              // "enriched" | "verified"; flips at count >= 3
last_verified_at:   v.optional(v.number())
// plus CONFIG_FIELDS live directly on this row: brake_fluid_type, ps_fluid_type, drivetrain,
// chassis_code, brake_fluid_capacity_oz, ps_fluid_capacity_oz
```
- **TRIM_FIELDS** are written to a `trim_specs` row found by index `by_vehicle_config` (one per config).
- **CHASSIS_FIELDS** require `config.chassis_code` to be set; the chassis row is found via `chassis_specs.by_chassis_code`. If `chassis_code` is null, chassis corrections won't reach a data table.

### 4.2 `enrichment_evidence` (append-only evidence ledger)
```ts
enrichment_evidence: defineTable({
  entity_type:   v.string(),          // always "vehicle_config" for this feature
  entity_id:     v.string(),          // String(vehicle_config_id)
  field_name:    v.string(),
  observed_value:v.optional(v.any()),
  source_type:   v.optional(v.string()),  // "mechanic" for our writes
  confidence:    v.optional(v.number()),  // 0.99 corrected, 0.98 confirmed
  is_latest:     v.optional(v.boolean()),
  observed_at:   v.optional(v.number()),
  created_at:    v.optional(v.number()),
  // (also: observed_type, source_url, source_domain, enrichment_run_id)
})
  .index("by_entity",       ["entity_type", "entity_id"])
  .index("by_entity_field", ["entity_type", "entity_id", "field_name"])  // ← used by accept + undo
```
**The pattern is append-only with a `is_latest` flag.** Accept retires the old latest (`is_latest:false`) and inserts a new latest. Undo retires the mechanic latest and re-promotes the most recent **non-mechanic** retired row. Never hard-delete evidence.

### 4.3 `audit_log` (immutable trail)
```ts
audit_log: defineTable({
  entity_type: v.string(),   // "vehicle_config"
  entity_id:   v.string(),   // String(vehicle_config_id)
  action:      v.string(),   // "field_edit" for all of these
  actor:       v.string(),   // director name (or "System (undo)")
  actor_id:    v.optional(v.id("director_users")),
  detail:      v.string(),   // human-readable, e.g. "Corrected oil_viscosity: 5W-20 → 0W-20"
  created_at:  v.number(),
})
  .index("by_entity", ["entity_type", "entity_id"])  // ← drives modal audit drawer (listByEntity)
  .index("by_created_at", ["created_at"])
  .index("by_actor_id", ["actor_id"])
```
The modal's audit drawer queries `audit_log.listByEntity({ entity_type:"vehicle_config", entity_id })` — so audit is **keyed to the vehicle config, not the verification row.** Every accept/reject/undo writes one entry per field plus a summary entry, all under that config's entity_id.

### 4.4 `director_users`, `mechanics`
- `director_users`: `{ name, role: "superadmin"|"admin"|"viewer", email?, ... }`. The session provides `userId` → `reviewer_id` / `actor_id`.
- `mechanics`: `{ shop_id, first_name, last_name, photo?, ... }`. `mapRow` joins this to build `mechanicName`.

---

## 5. How the director UI reads + renders

### 5.1 Queries
- `listAll({ status })` — `undefined`/`"all"` → all rows ordered desc; otherwise filtered via `by_status`. **This is what the tab uses.** It maps every row through `mapRow`.
- `listPending()` — pending only (used by the sidebar count path / legacy).
- `mapRow(ctx,row)` is the **shaping layer**. It joins `vehicle_configs` → `makes`/`models`, joins `mechanics`, and derives:
  - `vehicle` = `[year, make, model, trim].filter(Boolean).join(" ")`
  - `configKey` = `config.config_key`
  - `confirmedCount` / `correctedCount` / `unknownCount` = counts over `verifications[]` by status
  - `verificationCount`, `enrichmentStatus` = pulled from the **config**, not the verification row
  - falls back gracefully (`"—"`, `"Unknown mechanic"`) on missing joins

> ⚠ **Render dependency:** if `verifications` is missing/not an array, `mapRow` coerces it to `[]` and all counts show 0 — the row renders but looks empty. If `vehicle_config_id` points to a deleted config, `vehicle` shows `""` (renders as "—") and `verificationCount`/`enrichmentStatus` are 0/null. **For a row to render meaningfully, it needs: a live `vehicle_config_id`, a live `mechanic_id`, and a non-empty `verifications[]` array of well-formed VerificationFields.**

### 5.2 Master table columns (`TabMechanicEdits.tsx`)
`Status · Vehicle · Mechanic · Submitted · Accuracy · Fields · Parts OK · Labor · [actions]`
- **Accuracy bar:** `overallAccuracy` is normalized as `Math.round(acc * (acc <= 1 ? 100 : 1))` — i.e. it assumes a 0–1 float OR an already-percent number. **A string enum breaks this** (see §7). Green ≥90, yellow ≥70, red below.
- **Fields cell:** `Nx✗` corrected (orange), `Nx✓` confirmed (green), `N?` unknown (slate).
- **Actions:** pending → `Reject` + `Accept`; accepted → `Undo` (with `window.confirm`); others → "—".
- Clicking a row opens the modal; the actions cell `stopPropagation`s so quick-buttons don't open it.

### 5.3 Detail modal (`VerificationModal`)
- **Left:** summary strip (accuracy, parts-used, labor, field counts) + a field table sorted **corrected → confirmed → unknown**. Corrected rows are highlighted; `our_value` is struck through when it differs from `corrected_value`.
- **Right:** mechanic card (avatar/name/submitted-ago), job id, config verification count + "N more to auto-verify", enrichment badge, and an **"On accept:"** preview that predicts the writes (N corrections @0.99, N confirmations @0.98, count increment, "flips to verified" if next count ≥3).
- **Footer:** a two-step confirm — first click sets `confirming` to `accept`/`reject`/`undo` and shows an explanatory sentence + Confirm/Cancel.
- **Audit drawer:** toggled by `AuditButton`; lists `listByEntity` results for the config.

---

## 6. The three operations in exact detail

### 6.1 `acceptVerification({ id, actorName, actorId })` — `director_mechanic_verifications.ts`
Guard: row exists **and** `status === "pending"`, config exists; else no-op.
For each field in `verifications`:
- **`corrected`** → query `enrichment_evidence` by `by_entity_field`; set every existing `is_latest` row to `false`; **insert** new evidence `{ source_type:"mechanic", confidence:0.99, observed_value: corrected_value, is_latest:true, observed_at:now, created_at:now }`. Push to `corrections[]`.
- **`confirmed`** → **insert** evidence `{ confidence:0.98, observed_value: our_value, is_latest:true, ... }`. (Does NOT retire prior evidence — confirmation is additive.) Push to `confirmations[]`.
- **`unknown`** → ignored.
Then:
- `verification_count = (old ?? 0) + 1`; patch config with new count + `last_verified_at:now`; **if `newCount >= 3` set `enrichment_status:"verified"`**.
- Patch the verification row `{ status:"accepted", verified_at:now }`.
- Write audit: one `field_edit` per correction (`"Corrected X: a → b"`), one per confirmation (`"Confirmed X = v"`), one summary (`"Mechanic verification accepted — N corrections, M confirmed"`).

> ⚠ **Important current limitation:** accept writes evidence but **does NOT write the corrected value into the actual data tables** (engines/transmissions/etc.). The **undo path restores `our_value` to those tables** — implying the data tables are expected to already hold the mechanic's value after accept. **This is an asymmetry to resolve** (see §10, item A). Confirm with Waleed whether accept is supposed to write through to the data tables (the evidence ledger is updated, but the canonical spec rows may not be). Today, accept = evidence + counters only.

### 6.2 `rejectVerification({ id, actorName, actorId })`
Guard `status === "pending"`. Patch `{ status:"rejected", verified_at:now }`. One audit entry `"Mechanic verification rejected"`. **No data writes.**

### 6.3 `undoById({ id, actorName, actorId })` — `undoMechanicVerification.ts`
Guard `status === "accepted"` (returns `{ok:false, reason}` otherwise). Then it builds the list of **decisions**:
```ts
const decisions = review_decisions.length > 0
  ? review_decisions                                   // NEW partial-accept format
  : verifications.filter(f => f.status !== "unknown")  // LEGACY: treat every non-unknown as accepted
                 .map(f => ({ field_name: f.field_name, action: "accept" }))
```
For each decision (skipping `action:"skip"`):
- find the matching field; compute `appliedValue` (`override_value` if `action:"override"`, else confirmed→`our_value` / corrected→`corrected_value`).
- `restoredValue = our_value === null ? undefined : our_value` — **undefined deletes the key** (Convex rejects `null` for optional fields).
- retire mechanic `is_latest` evidence; re-promote the newest non-mechanic retired evidence to `is_latest:true`.
- route `restoredValue` into one of `configPatch / enginePatch / transmissionPatch / chassisPatch / trimPatch` by field set.
- apply via `applyRevertPatch` (uses `db.replace` so deleting keys works).
- decrement `verification_count` (min 0); if `< 3` and was `"verified"` → back to `"enriched"`.
- patch row `{ status:"undone", verified_at:now, reviewer_id:actorId }`.
- audit: one entry per field (`"Undo: X  applied → restored"`) + summary.

`undoLatest` (Convex action) + `_undoInternal` (internalMutation) are dashboard convenience twins that do the same with actor `"System (undo)"`.

---

## 7. ⚠ Data-shape mismatches to fix BEFORE/while wiring

These are real inconsistencies in the current code. Temur should resolve them or the table will mis-render / undo will mis-type data.

| # | Field | Schema says | Mechanic writer (`verification.ts`) writes | Director UI expects | Impact |
|---|---|---|---|---|---|
| 1 | `overall_accuracy` | `number` | **string enum** `"accurate" \| "mostly_accurate" \| "needs_correction"` (cast `as any`) | a 0–1 float or percent (`AccuracyBar` does `acc * (acc<=1?100:1)`) | Accuracy bar shows `NaN%`/garbage for real submissions. **Decide one representation.** Recommend: store a number 0–1, and map the enum → {1.0, 0.85, 0.5} at submit time; or change the UI to render the enum as a labeled pill. |
| 2 | `job_id` | `v.optional(v.string())` | `v.optional(v.id("job_actuals"))` | `string \| null` | Type drift. An `Id` serializes to string so it mostly works, but the schema/types disagree. Pick one and align. |
| 3 | `our_value` / `corrected_value` | (in `verifications`, `v.any()`) | **`v.string()`** (always strings) | `unknown`, rendered via `fmtValue` | Undo writes `restoredValue` (a **string**) back into typed data columns (e.g. `oil_capacity_qts: number`, `is_run_flat: boolean`). **Restoring a string into a numeric/boolean column will violate the schema validator.** Numbers/booleans must be coerced back to their real types before patching, or stored typed in `verifications` to begin with. **This is the highest-risk bug for undo.** |
| 4 | `verified_at` | submit-time set to `now` in `verification.ts` | also overwritten on review | UI shows "reviewed/accepted/reverted {timeAgo}" from `verified_at` | On a pending row, `verified_at` is already populated (submit time), so "reviewed X ago" can show before any review. Only render the review-time line when `status !== "pending"` (UI already mostly guards this, but the field's dual meaning is a trap). |
| 5 | `notes` on a field | not in schema's typed shape (it's `v.any()`) | written by mechanic | **not displayed** | Mechanic notes are captured but invisible to the director. If AB wants them, surface `field.notes` in the modal field table. |

**Recommendation:** tighten `verifications` from `v.any()` to a typed `v.array(v.object({...}))` in the schema, storing `our_value`/`corrected_value` as a discriminated/typed value (or keep strings but **coerce on undo**). Whatever you choose, items **#1 and #3 must be resolved** for accuracy display and undo to be correct.

---

## 8. Field routing tables (authoritative — copy exactly)

These `Set`s in `undoMechanicVerification.ts` (lines 27–50) decide which data table a `field_name` is written to / restored from. The partial-accept mutation you build **must use the identical sets** (extract them to a shared module so accept and undo can't drift).

```ts
ENGINE_FIELDS = {
  oil_viscosity, oil_capacity_qts, coolant_type, coolant_capacity_qts,
  spark_plug_quantity, spark_plug_gap_mm, timing_system, aspiration,
  fuel_type, fuel_injection, water_pump_timing_driven, cylinders,
  displacement_l, engine_code, configuration, engine_family
}            → patches the `engines` row at config.engine_id

TRANSMISSION_FIELDS = {
  transmission_type, fluid_type, fluid_capacity_drain_fill_qts,
  is_lifetime_fill, has_serviceable_filter, service_method, code, speeds
}            → patches the `transmissions` row at config.transmission_id

CHASSIS_FIELDS = {
  lug_nut_torque_ft_lbs, wiper_blade_driver_size_in, wiper_blade_passenger_size_in,
  wiper_blade_rear_size_in, battery_group, battery_type, battery_location,
  steering_type, parking_brake_type, has_rear_wiper, has_brake_pad_sensor
}            → patches `chassis_specs` (found by config.chassis_code)

TRIM_FIELDS = {
  tire_size_front, tire_size_rear, recommended_tire_pressure_front_psi,
  recommended_tire_pressure_rear_psi, is_staggered, tire_directional,
  is_run_flat, alignment_type
}            → patches `trim_specs` (found by_vehicle_config)

CONFIG_FIELDS = {
  brake_fluid_type, ps_fluid_type, drivetrain, chassis_code,
  brake_fluid_capacity_oz, ps_fluid_capacity_oz
}            → patches the `vehicle_configs` row directly
```
A `field_name` not in any set → gets evidence written but **never reaches a data table**. Keep this vocabulary synced with the mechanic app's field list.

---

## 9. ★ Partial / per-field correction — the net-new build

This is the explicitly-requested feature. Today accept is all-or-nothing. The goal: the director can, per field, **accept** the mechanic's value, **skip** it (don't apply), or **override** it with the director's own value — then confirm, and have it all be undoable.

### 9.1 The `review_decisions` contract (MUST match what undo reads)
`undoById` already reads this shape (lines 116–132). Build accept to write **exactly** this so undo is automatically correct:

```ts
type ReviewDecision = {
  field_name:     string                              // must match a verifications[].field_name
  action:         "accept" | "skip" | "override"
  override_value?: unknown                            // REQUIRED iff action === "override"
}
review_decisions: ReviewDecision[]
```
Behavior the undo code assumes:
- `action:"accept"` → apply confirmed→`our_value` / corrected→`corrected_value`.
- `action:"skip"` → **do not apply**; undo also skips it.
- `action:"override"` → apply `override_value` (director's own correction, neither our nor mechanic value).
- Any field **absent** from `review_decisions` is treated (by legacy fallback) as not-decided. **Best practice: write a decision for every non-unknown field**, marking the ones the director didn't approve as `"skip"`, so there's no ambiguity and undo's "legacy fallback" branch never fires for new rows.

### 9.2 New mutation to add — `acceptVerificationPartial`
Add to `convex/director_mechanic_verifications.ts` (or replace `acceptVerification`'s internals so the full-accept button just passes "all accept"):

```ts
export const acceptVerificationPartial = mutation({
  args: {
    id: v.id("mechanic_verifications"),
    decisions: v.array(v.object({
      field_name: v.string(),
      action: v.union(v.literal("accept"), v.literal("skip"), v.literal("override")),
      override_value: v.optional(v.any()),
    })),
    actorName: v.string(),
    actorId: v.optional(v.id("director_users")),
  },
  handler: async (ctx, { id, decisions, actorName, actorId }) => {
    // 1. guard: row exists && status === "pending"; config exists
    // 2. for each decision where action !== "skip":
    //      resolve appliedValue (override_value | corrected_value | our_value)
    //      a) enrichment_evidence: retire prior is_latest, insert {source_type:"mechanic",
    //         confidence: action==="override" ? 0.99 : (field.status==="corrected"?0.99:0.98),
    //         observed_value: appliedValue, is_latest:true}
    //      b) WRITE-THROUGH to the data table via the SAME field-routing sets (§8)
    //         — coerce appliedValue to the column's real type (see §7 #3)
    // 3. verification_count += 1; flip enrichment_status→"verified" if >=3
    // 4. patch row: { status:"accepted", verified_at:now, reviewer_id:actorId,
    //                 review_decisions: decisions }   ← PERSIST so undo can read it
    // 5. audit_log: one entry per applied/skipped field + a summary
    //      (skips should be logged too: "Skipped X (mechanic suggested: v)")
  },
});
```
Critical requirements:
1. **Persist `review_decisions: decisions` on the row.** Undo depends on it. Without it, undo falls back to "every non-unknown field was accepted" and will try to revert fields the director actually skipped → data corruption.
2. **Write-through to data tables** using the §8 routing (resolving the asymmetry from §6.1) so accept and undo are symmetric: accept applies value to the data table, undo restores `our_value`. Extract the routing sets + `applyRevertPatch`/`applyForwardPatch` helpers into a shared file imported by both.
3. **Type-coerce** `appliedValue` and `our_value` to the destination column type (string vs number vs boolean) before patching — see §7 #3.
4. The existing **full-accept** button should call this with `decisions = verifications.filter(f=>f.status!=="unknown").map(f=>({field_name:f.field_name, action:"accept"}))`. That keeps one code path.

### 9.3 UI changes in `VerificationModal`
- Add a per-row control in the left field table for `pending` rows: a 3-way toggle / select per field → `accept` (default for corrected & confirmed) · `skip` · `override`.
- `override` reveals an inline input seeded with `corrected_value`; its value becomes `override_value`.
- `unknown` fields are display-only (no decision; never sent).
- Maintain a `decisions` state map keyed by `field_name`; on Confirm, build the `decisions[]` array and call `acceptVerificationPartial`.
- Update the **"On accept:"** preview to reflect the *selected* decisions (e.g. "3 accepted, 1 overridden, 2 skipped") instead of the static corrected/confirmed counts.
- Keep the existing two-step confirm footer.

### 9.4 Undo after partial accept
No new undo code needed **if** §9.2 is built to the contract — `undoById` already: reads `review_decisions`, skips `"skip"`, honors `"override"` via `override_value`, restores `our_value`. Just verify with a test that a partial accept → undo round-trips cleanly (only the applied fields revert; skipped ones were never touched).

---

## 10. Open decisions / asymmetries to confirm with Waleed/AB

- **(A) Does accept write through to data tables?** Today `acceptVerification` writes **evidence only**; undo restores data **tables**. Either accept must write the data tables (recommended, §9.2) or undo must only touch evidence. Pick one — they must be symmetric.
- **(B) Accuracy representation** (§7 #1): numeric vs enum pill. Affects the master-table accuracy column and modal summary.
- **(C) Re-review path:** should `undone`/`rejected` ever return to `pending`? Currently terminal. The undo docstring hints at re-review but the code doesn't do it.
- **(D) Confidence for director override:** what confidence should an `override` write carry? Spec above assumes 0.99 (director is authoritative). Confirm.
- **(E) Mechanic notes** (§7 #5): surface in the modal or not.
- **(F) Permissions:** should `role:"viewer"` directors be read-only (no accept/reject/undo)? Not enforced today.

---

## 11. Acceptance checklist for Temur

- [ ] Resolve `overall_accuracy` representation; accuracy bar renders correctly for real submissions.
- [ ] Resolve `verifications` value typing; undo restores numbers/booleans without schema validation errors (§7 #3).
- [ ] Extract field-routing sets + patch helpers into a shared module imported by accept **and** undo.
- [ ] Build `acceptVerificationPartial` that (a) write-throughs to data tables with the routing sets, (b) persists `review_decisions`, (c) writes audit per field + summary.
- [ ] Re-point the existing full-accept button at the new mutation with an all-`accept` decisions array.
- [ ] Add per-field accept/skip/override controls + override input to the modal; build `decisions[]` on confirm.
- [ ] Update the "On accept:" preview to reflect selected decisions.
- [ ] Verify the state machine guards (no double-apply, undo only from accepted).
- [ ] Round-trip test: submit (pending) → partial accept (some skip/override) → confirm data tables + evidence + counters + audit → undo → confirm only-applied fields reverted, count decremented, `verified→enriched` downgrade if it dropped below 3.
- [ ] Confirm the sidebar pending badge (`director.sidebarCounts`) still reflects pending count after the changes.

---

## 12. Glossary of guarantees the UI relies on (so a row "shows up properly")

For a `mechanic_verifications` row to render and operate correctly in the director tab, it must have:
1. `status` ∈ {`pending`,`accepted`,`rejected`,`undone`} — drives the filter tab + badge + which actions appear.
2. A **live** `vehicle_config_id` → so `mapRow` can resolve vehicle label, config_key, verification_count, enrichment_status.
3. A **live** `mechanic_id` → so the avatar + name resolve (else "Unknown mechanic").
4. `verifications` = a **non-empty array** of well-formed `VerificationField`s, each with a `field_name` from the §8 vocabulary, an `our_value`, a `status`, and (when corrected) a `corrected_value`.
5. `created_at` (submit time, ms) → "Submitted X ago".
6. `overall_accuracy` in the agreed numeric form (§7 #1) → accuracy bar.
7. For **partial accept** to be undoable: `review_decisions` persisted at accept time in the §9.1 shape.
8. For **undo** to restore typed columns: stored values coercible to their destination column types (§7 #3).
