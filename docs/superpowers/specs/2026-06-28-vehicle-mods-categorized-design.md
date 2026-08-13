# Categorized Vehicle Modifications (capture) — Design

**Date:** 2026-06-28
**Status:** Approved (design), pending spec review
**Scope:** Capture only. The auto-flag-on-related-booking half of the ticket is a deferred follow-up.

## Problem

The shop records vehicle modifications during the Pre-Job vehicle check, but today the
data is just a boolean-ish status + one free-text note:

```ts
modifications: { status: "none_observed" | "aftermarket_observed" | null; notes: string | null }
```

There are no **mod types/locations**, so nothing downstream can reason about a mod
(e.g. later flag a suspension mod when a brakes/tires job is booked). Per the product
thread (Yassin/Waleed), the shop should be **prompted to choose where each mod falls**
(broad location categories) instead of typing everything free-form.

## Goal (this change)

Replace the flat status/notes structure with a **list of structured mod entries**, each
with a **location** (from a fixed enum) and a free-text **description**. Capture it in the
Pre-Job Modifications tab and display it in the Vehicle Passport card. **No flagging yet.**

## Decisions (locked with user)

- **Capture only.** Flagging + mod→service-category mapping is a separate follow-up.
- **Hard replace.** Drop the legacy `status`/`notes` fields entirely — do **not** keep them
  for back-compat. **Overwriting existing records is approved** (one-time migration).
- **Multiple mods per vehicle** (array).
- Field shape per the user: `{ location, description }` (their `modLocation`/`modDescription`).

## Data model

`vehicle_passports.modifications` becomes:

```ts
modifications: {
  entries: Array<{
    location: ModLocation;   // required, from the enum below
    description?: string | null;  // optional free text
  }>;
}
```

`ModLocation` enum — **broad physical areas of the car where a mod resides** (the
specific component goes in `description`, not the enum):

```
"engine" | "exhaust" | "drivetrain" | "suspension" | "brakes" |
"wheels_tires" | "exterior_body" | "interior" | "electrical" | "other"
```

Labels (UI): Engine · Exhaust · Drivetrain · Suspension · Brakes · Wheels & Tires ·
Exterior / Body · Interior · Electrical · Other.

Rationale: locations, not components. Intake / forced induction / cams / ECU tune roll
up under **Engine** (they live in the engine bay). Exhaust is kept separate (runs
underbody, common distinct mod). The component detail (e.g. "twin-turbo kit",
"3in cat-back") is captured in the description.

Semantics:
- `entries: []` ⇒ no modifications recorded (replaces `none_observed`).
- `entries.length > 0` ⇒ vehicle has recorded mods (replaces `aftermarket_observed`).
- The enum is intentionally broad so the deferred flag step can map locations onto the
  shop's **service categories** (Maintenance, Fluids, Battery, Brakes, Tires, Routine
  Maintenance, Compliance, Diagnostics).

## Migration (one-time, overwrite approved)

Existing `vehicle_passports` docs carry `modifications: { status, notes }`. A strict
new validator would reject them on schema push, so migrate in three phases:

1. **Permissive validator** — temporarily allow both old (`status`/`notes`) and new
   (`entries`) fields. Push.
2. **Backfill mutation** — for every passport, rewrite `modifications` to the new shape:
   - If legacy `status === "aftermarket_observed"` or `notes` present →
     `entries: [{ location: "other", description: <notes ?? null> }]`.
   - Else → `entries: []`.
   - Remove `status` and `notes`.
3. **Strict validator** — entries-only. Push (existing data now conforms).

## Components & files to change

1. **`convex/lib/vehicle_passports.ts`** — replace `modificationStatusValidator` +
   `vehiclePassportModificationsValidator` with a `modLocationValidator` and an
   `entries`-array validator. (Used by both the passport update validator and
   `prejobReportValidator`, so both inherit the new shape.)
2. **`lib/vehicle-passport.ts`** — remove `MODIFICATION_STATUSES`/`ModificationStatus`/
   `modificationStatusLabel`; add `MOD_LOCATIONS` (value+label list), `ModLocation` type,
   `VehicleModificationEntry` type, `modLocationLabel(value)`. Update
   `VehiclePassportModifications` to `{ entries }`.
3. **`components/pre-job-survey-dialog.tsx`** — replace `modificationsStatus`/
   `modificationNotes` state and the single status `Select` + notes textarea with:
   - a **"No modifications observed"** affordance (empty entries),
   - a repeatable row list: **Location** `Select` (enum) + **Description** text input,
   - **"+ Add modification"** and per-row remove.
   Update prefill (read `entries` from passport/prefill) and `buildPayload`
   (`modifications: { entries }`).
4. **`components/vehicle-passport-card.tsx`** — `NotesSection`: `hasMods` becomes
   `entries.length > 0`; render each entry as `Location — description`. Update the
   `hasNotes` indicator logic (line ~736).
5. **`components/vehicle-passport-section.tsx`** — the "Modifications" summary row
   (uses `modificationStatusLabel`) becomes a count/summary of `entries`
   (e.g. "2 recorded: Suspension, Intake" or "None recorded").
6. **`convex/bookings.ts`** (~line 4383) — the passport-data builder that currently emits
   `modifications: { status, notes }` must emit `modifications: { entries }`.
7. **`convex/seed.ts`** (~4174–4223) — update the modification seeding to produce
   `entries` (e.g. randomly assign 0–2 entries with a location + sample description)
   instead of `status`.
8. **`lib/vehicle-passport.test.ts`** (~line 57) — update the fixture to the new shape;
   add coverage for `modLocationLabel` and entries round-trip.

## Out of scope (deferred follow-up)

- Auto-flagging a recorded mod on a future booking whose service relates to it.
- The mod-location → service-category mapping table and any flag UI/surfaces.

## Testing

- Unit: `modLocationLabel` returns correct labels; passport read/write round-trips
  `entries`; backfill converts legacy `{status,notes}` → entries correctly (notes →
  one `other` entry; none → `[]`).
- Manual (localhost): Pre-Job → Modifications tab → add two mods (e.g. Suspension
  "lowered 2in coilovers" + Engine "cold air intake") with descriptions → submit →
  confirm they render in the Vehicle Passport
  card Notes section and persist per-VIN on the next booking for the same car.
