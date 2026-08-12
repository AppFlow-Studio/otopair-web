# Shop-Entered Vehicle Mods → Affected-Systems Tagging — Design

**Date:** 2026-06-29
**Status:** Approved (design + migration), pending spec review
**Supersedes:** `2026-06-28-vehicle-mods-categorized-design.md` (the per-entry `{location, description}` model is replaced).
**Source design:** `C:\Users\manso\Downloads\Otopair modification alerts design-handoff` (design brief + Surface-1 mockup + screenshots).

## Problem / change

The per-entry `{ location, description }[]` model we just built is being replaced. Per the
product brief, the shop logs a modification as **one free-text note + a boolean + a
multi-select of coarse "systems" the mod affects**. Each system maps (behind the scenes)
to a set of service slugs; that mapping is the "brain" that (a) powers a live preview at
entry time and (b) — in a later phase — fires a flag to future shops on the affected services.

> Free text = what the next mechanic *reads*. System tags = what the flag *fires on*. Kept separate.

## Scope

**Phase A (THIS spec):** the capture section + the systems "brain" + live preview + the
passport displays. Build the mapping module now so the preview works and Phase B consumes it.

**Phase B (next, NOT this spec):** Surface-2 mechanic job-card amber flag, the real
flag-firing when a booked service slug is in the union, and the `low_clearance` attribute
(set by `suspension_ride_height`, surfaced on under-car jobs).

## Decisions (locked with user)

- **Hard replace** the `entries` model. Existing 6 passport rows with `{ entries }`: **clear
  the `modifications` field entirely** (no conversion). Dev data — fine to drop.
- Yes/No is a **toggle** (green/gray, matching the existing section toggles + screenshots),
  not a dropdown.
- `cosmetic_only` is **mutually exclusive** (selecting it clears the other systems; fires no flags).

## Data model

`vehicle_passports.modifications` (optional at table level) becomes:

```ts
modifications: {
  has_mods: boolean;                  // "Any aftermarket parts?"
  notes?: string | null;              // one free-text description
  affected_systems: AffectedSystem[]; // [] when has_mods is false or none tagged
}
```

`AffectedSystem`:
```
"suspension_ride_height" | "wheels_tires" | "brakes" | "exhaust_emissions" |
"engine_drivetrain" | "electrical_lighting" | "cosmetic_only"
```

## The "brain" — `lib/vehicle-mod-systems.ts` (new, pure module)

- `AFFECTED_SYSTEMS`: ordered `{ value, label }` list (labels: "Suspension / ride height",
  "Wheels & tires", "Brakes", "Exhaust / emissions", "Engine / drivetrain",
  "Electrical / lighting", "Cosmetic only").
- `AffectedSystem` type, `affectedSystemLabel(value)`.
- `SYSTEM_SERVICE_MAP: Record<AffectedSystem, Array<{ slug: string; name: string }>>` from the
  brief's table (below).
- `servicesForSystems(systems: AffectedSystem[]) => { slug: string; name: string }[]` — distinct
  union across selected systems, **excluding** `cosmetic_only` (always empty). Stable order.

### Affected system → service mapping (the locked taxonomy)

| System | Service slugs (→ display name) |
|---|---|
| suspension_ride_height | wheel-alignment, tire-balance, tire-rotation, tire-replacement |
| wheels_tires | tire-balance, wheel-alignment, tire-rotation, tire-replacement, brake-pad-replacement, rotor-replacement |
| brakes | brake-pad-replacement, rotor-replacement, brake-fluid-flush |
| exhaust_emissions | emissions-test, state-inspection-nys, check-engine-light-diagnosis, diagnostic-scan |
| engine_drivetrain | oil-change, spark-plugs, fuel-system-induction-service, filter-replacement, check-engine-light-diagnosis, diagnostic-scan, emissions-test, transmission-service, differential-service |
| electrical_lighting | battery-test, battery-replacement, check-engine-light-diagnosis |
| cosmetic_only | (none) |

Display names: Wheel Alignment · Tire Balance · Tire Rotation · Tire Replacement ·
Brake Pad Replacement · Rotor Replacement · Brake Fluid Flush · Emissions Test ·
NYS Inspection · Check Engine Light Diagnosis · Diagnostic Scan · Oil Change ·
Spark Plugs · Fuel System / Induction Service · Filter Replacement · Transmission Service ·
Differential Service · Battery Test · Battery Replacement.

(The slugs are the locked product taxonomy; they need not all exist in this dev deployment's
`services` table for the **preview** — the preview is self-contained. Phase B will match
booked-service slugs against the union.)

## Capture UI — Pre-Job survey, Modifications section (`components/pre-job-survey-dialog.tsx`)

- **Yes/No toggle** "Any aftermarket parts?" → drives `has_mods`.
- When **No**: hide notes + chips; `affected_systems = []`, `notes = null`.
- When **Yes**:
  - **Notes** textarea → `notes`.
  - **"Which systems do these affect?"** label + helper "Tap every system these mods touch.
    Otopair flags them to future shops on the right services — automatically."
  - Chip multi-select (existing toggle style; selected = light-blue fill `#EFF6FF` + check).
    `cosmetic_only` selecting clears the rest; selecting any other clears `cosmetic_only`.
  - **Live preview** (light-blue info box):
    - ≥1 system with services → "Future shops will be alerted on **N** services" + the distinct
      service names joined by " · " + "**Hidden on everything else.**"
    - none selected → "No systems selected yet — tap the systems above and Otopair flags the
      right future services automatically."
    - only `cosmetic_only` → "Cosmetic only — recorded, but won't flag any future service."

## Displays

- **Vehicle Passport card** (`components/vehicle-passport-card.tsx`, `NotesSection`): when
  `has_mods`, show "MODIFICATIONS", the notes, and the affected-system labels (e.g.
  "Suspension / ride height, Wheels & tires"). `hasMods`/`hasNotes` driven by `has_mods`/notes/systems.
- **Vehicle Passport section** (`components/vehicle-passport-section.tsx`): the "Modifications"
  summary row → affected-system labels joined by ", " when `has_mods`, else "None recorded".

## Migration (clear, then re-shape)

1. **Clear** mutation in `convex/migrations.ts`: for every `vehicle_passports` row that has a
   `modifications` field, `ctx.db.patch(id, { modifications: undefined })`. Run it under the
   CURRENT (entries) validator — removing an optional field is valid, so no expand needed.
   After this, all 25 rows are mods-less.
2. **Re-shape** the validator + types to the new model and push. All rows are mods-less →
   the new optional validator validates cleanly.

## Files

- New: `lib/vehicle-mod-systems.ts` (brain) + `tests/vehicleModSystems.test.ts` (unit tests).
- `convex/lib/vehicle_passports.ts`: replace `modLocationValidator`/`vehicleModificationEntryValidator`/
  the modifications validator with `affectedSystemValidator` + new
  `vehiclePassportModificationsValidator = v.object({ has_mods: v.boolean(), notes: v.optional(nullableStringValidator), affected_systems: v.array(affectedSystemValidator) })`.
- `lib/vehicle-passport.ts`: `VehiclePassportModifications → { has_mods; notes?; affected_systems }`;
  remove `MOD_LOCATIONS`/`ModLocation`/`VehicleModificationEntry`/`modLocationLabel`/`legacyModificationsToEntries`.
- `convex/bookings.ts` passport-data builder: emit `{ has_mods, notes, affected_systems }`.
- `convex/seed.ts`: emit the new shape (a couple demo cars get `has_mods: true` + a system).
- `components/pre-job-survey-dialog.tsx`: the new capture UI.
- `components/vehicle-passport-card.tsx` + `components/vehicle-passport-section.tsx`: displays.
- `convex/migrations.ts`: the clear mutation.
- Remove `tests/vehicleModifications.test.ts` (tests the deleted `legacyModificationsToEntries`/`modLocationLabel`); coverage moves to `tests/vehicleModSystems.test.ts`.

## Testing

- Unit (`tests/vehicleModSystems.test.ts`): `servicesForSystems` — single system; union dedupe
  (suspension + wheels_tires → exactly the 6 from the screenshot); `cosmetic_only` → []; empty → [];
  `cosmetic_only` mixed is handled by the UI (module just returns [] for it); `affectedSystemLabel`.
- Manual (localhost): Pre-Job → Modifications → Yes → notes + tap Suspension + Wheels & tires →
  preview shows "6 services: Wheel Alignment · Tire Balance · Tire Rotation · Tire Replacement ·
  Brake Pad Replacement · Rotor Replacement. Hidden on everything else." → submit → card shows
  Yes + notes + the two systems; persists per-VIN.

## Out of scope (Phase B)

Surface-2 job card, real flag-firing on booked services, `low_clearance` attribute,
owner read-only view, pricing effects.
