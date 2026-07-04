# Labor times section — director Vehicle Configs — Design

**Date:** 2026-06-13
**Status:** Approved
**Branch:** waleed-fix

## Goal

Surface per-service labor times in the director Vehicle Configs config modal, next
to the existing "OEM service intervals" section, so a director can audit which
services have real (OLP-backed) labor data vs. the tier-estimate fallback.

## Decisions (locked in brainstorm)

- Each row shows: **service name · hours · source · confidence**.
- **Hours only** (the stored, rate-independent number) — no estimated dollar cost.

## Architecture

### Backend — `convex/directorCars.ts`, `vehicleConfigDetail` query (~720)
Add a `laborTimes` array to the return, built where the existing
`// Service intervals + labor times` comment already anticipates it:
- Query `labor_times` `by_vehicle_config` for the config id.
- For each row, resolve the service name (`ctx.db.get(row.service_id)`), and return
  `{ serviceName, hours, source, confidence }` where:
  - `hours = row.book_hours ?? row.empirical_hours ?? null`,
  - `source = row.source ?? null` (e.g. `"aggregated"` = OLP-backed, `"tier_estimate"` = fallback, `"vdb_camry_baseline"`),
  - `confidence = row.confidence ?? null`.
- Skip rows whose service can't be resolved. Sort by `serviceName`.
- Returned alongside the existing `serviceIntervals` field.

### Frontend — `app/(director-panel)/director/components/tabs/TabVehicleConfigs.tsx`
- Add a `LaborTimeRow` type: `{ serviceName: string; hours: number | null; source: string | null; confidence: number | null }`.
- Render a **"Labor times (N)"** section immediately after the "OEM service
  intervals (N)" section in the config modal, mirroring that section's chrome
  (`SectionTitle` + the same row container/border styling). Guard with
  `detail.laborTimes && detail.laborTimes.length > 0` (hidden when empty).
- Each row: service name on the left; on the right — `${hours.toFixed(1)} h`
  (or `—` when null), a small source label, and a confidence chip colored by the
  0.75 quote gate: `>= 0.75` green ("quote-grade"), below amber ("fallback"),
  null slate.

## Data flow
```
vehicleConfigDetail(id) → laborTimes[] (labor_times joined to services)
  → ConfigModal renders "Labor times (N)" section (read-only)
```

## Error handling
- No labor rows → section hidden.
- Null hours/source/confidence → rendered as `—` / omitted / slate chip.

## Testing
- Backend: a dev run of `directorCars:vehicleConfigDetail` on a known config returns
  a non-empty `laborTimes` with hours/source/confidence (the fleet was OLP-backfilled,
  so most configs have `source: "aggregated"`).
- Frontend: `npx tsc --noEmit` clean on the touched file; the section renders the
  rows (visual check deferred).

## Out of scope
- Editing labor times from this section (read-only display).
- Estimated labor cost / shop-rate math.
- Any change to the labor pipeline or schema.
