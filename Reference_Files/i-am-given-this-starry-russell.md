# Pre-Check / MPI Phase Split — build plan (from Spec v2, Sept 4)

## Context

The MPI runs today as one gate at `vehicle_at_shop`, before the clock starts.
Much of it — pad thickness, rotor thickness, caliper/hose, suspension play,
the whole underbody zone — physically needs the car on a lift with a wheel
off. That is the job. The mechanic does billable work off the clock, and the
system records `status = vehicle_at_shop` while the car is already in the air,
so labor-time data and job status are both wrong.

Spec v2 (Yassin, Sept 4) locks the split and adds the state machine, timer
semantics, and per-item phase assignment. This plan implements Spec v2 with
three deviations, each justified below. Superseded: the "intensive /
not-intensive" model from the earlier session in this repo — Spec v2's
classifier (ground+hands+pocket-gauge vs lift/wheel-off/tool) is objective
where "intensive" was subjective, and it is the better rule.

**Deviations from Spec v2 — all three decided with Daniel, and all three
need a note back to Yassin as spec amendments:**

1. **Keep "Is the vehicle on a lift?"** (spec §4.1 says DELETE). Move it to
   the MPI phase, where it isn't a foregone conclusion.
2. **`inspecting` is a shop-side field, not a `bookings.status` value**
   (spec §9). See "Why not a status value" below.
3. **Phase lives in the code template, not in new DB tables** (spec §9's
   `inspection_items.phase` + `service_required_items`). See "Why not a join
   table" below.

A fourth, smaller amendment: spec §4's item list omits 22 shipped fields.
Building with the assignments below rather than blocking on sign-off.

## Two structural decisions

### Why not a `bookings.status` value for `inspecting`

`bookings.status` is `v.string()` on the **shared** Convex table
(`convex/schema.ts:2739`) — the driver-facing mobile app in the `otopair`
repo reads the same field. Spec §8 promises "customer-facing: nothing
changes" and "Inspecting is a shop-portal state only", but writing
`status: "inspecting"` breaks that promise: the mobile app would need a
matching mapping shipped in the other repo, and `getJobStep`
(`lib/booking-status.ts:167-188`) has `default: return 1`, so any surface
that hasn't been updated silently renders an inspecting job as **"Incoming"**.
`BOOKING_STATUS_VISUALS` (`:24-125`) would have no entry either.

Spec §2.2's three arguments for a real state — data-layer enforceable, clean
timestamp pair, honest front-desk view — are all satisfied by a separate
field. The only thing a status *value* buys is that existing status-based UI
picks it up for free, which is precisely the part that breaks.

Verified against the mobile repo at `G:\GitHub\otopair`. Adding the value
costs **6 must-fix edits across both repos**, three of them serious:

- **`convex/booking_status_history.ts:17-57` blocks it outright.**
  `VALID_TRANSITIONS` has no `vehicle_at_shop → inspecting` edge, so the
  write throws; and `VALID_TRANSITIONS["inspecting"]` would be `undefined`,
  so `!allowed` makes every transition *out* throw too — the booking bricks.
- **It would break the feature it's for.** `convex/bookings.ts:11124`,
  `:11197`, `:11318`, `:11418` all gate on
  `["vehicle_at_shop", "in_progress"]`. Those are the inspection and
  job-actuals mutations — with `status = "inspecting"`, saving MPI findings
  throws.
- **`getCustomerBookingActions`'s permissive `else` branch** returns
  `canCancel: true, canReschedule: true` for an unrecognised status, so the
  customer gets a live, free-looking **Cancel** button on a car that is on a
  lift with a wheel off. Reschedule then throws from the `allowed` array at
  `:13901`.

Plus: `hooks/useMyBookingsWithDetails.ts:45-79` puts it in no bucket
(an inspection past midnight makes the booking vanish from every tab);
`getTodaysBookingsByShop` (`:9860`) filters `confirmed | vehicle_at_shop` and
drops it from the shop's today list; and `BookingDetailsSheet.tsx:612` falls
back to `?? STATUS_CONFIG.pending`, showing an orange "Pending" pill while
the card shows grey "Inspecting".

Deploy ordering makes it worse: mobile builds sit on phones for weeks, so
web shipping first exposes the Cancel button and the vanishing tab to anyone
on an older build.

Counted honestly, the status approach does buy two things the field doesn't —
`BOOKING_STATUS_VISUALS` and `BookingCard`'s `STATUS_CONFIG` are exhaustive
`Record<BookingStatus, …>` types, so the compiler would force every call site
to be handled, and `booking_status_history` rows would give a free audit
trail. Neither outweighs the above, and the audit trail is superseded by
`mpi_started_at` / `mpi_completed_at`, which are more queryable than joined
history rows. There is also direct precedent for the two sides not sharing a
status vocabulary: `delayed` and `quote_expired` are client-only display
statuses the backend never writes (`utils/bookingAdapter.ts:235-238`).

**Therefore: `bookings.status` never takes the value `"inspecting"`.**

| Moment | `status` | shop sub-state | labor timer | mobile shows |
|---|---|---|---|---|
| Checked in, pre-check | `vehicle_at_shop` | — | stopped | Checked in |
| Start Job tapped | `in_progress` | `mpi_in_progress` | stopped | **In progress** |
| MPI required hits 0 | `in_progress` (unchanged) | cleared | **starts** | **In progress** |
| Complete | `completed` | — | stopped | Completed |

The customer sees one uninterrupted "In progress" from the Start Job tap
onward, with no transition in between — exactly §8 — and **the mobile repo
needs no change at all**.

Shop-side sub-state goes in the existing `live_stage` field
(`convex/schema.ts:2740`, already the customer-facing sub-stage with
`LIVE_STAGE_TITLES` at `convex/bookings.ts:312-324`) as `mpi_in_progress`,
or in a new `inspection_phase` field if `live_stage` proves overloaded. The
labor timer is gated on that field, not on status.

### Why not `inspection_items.phase` + `service_required_items`

Required-ness is **not expressible as a `service × item → boolean` join
table**. `isFieldRequiredForZone` (`lib/inspection-template.ts:1012-1091`)
depends on live inspection state and booking scope:

- `rotor` / `desc` required only if `rotor_applicable === "yes"` (`:1006`)
- `pad_method` / `rotor_tool` only once a reading exists (`:993-1010`)
- `tire_size` / `run_flat` only on first visit, or if tread went *up* vs.
  last visit (`:938-948`)
- corner scope is *which corners*, not whether — from `brakeScope.front/rear`
  and `tireReplacementPositions` (`:883-922`)

A flat join table loses all of it. Seeding it would either leave the existing
code as a second source of truth (the exact `known_issue_events` drift class
CLAUDE.md warns about) or regress behavior.

The spec's stated motive — "UI filters on it; nothing is hidden by hardcoded
list" — is satisfied by adding `phase` to the existing `InspectionField` type.
The item list is already a hardcoded list in code, imported by **both** the
client and Convex (`convex/bookings.ts:170-176`), so one edit is enforced on
both sides with no migration and no sync risk.

## Changes

### 1. `lib/inspection-template.ts` — phase as a field property

Add to `InspectionField` (`:51-106`): `phase: "pre" | "mpi"`. Set it on every
field in `cornerFields()` (`:300-463`) and the ENG / UND / FRT zone lists
(`:565-637`). Assignments in the table below.

Extend `ZoneCompletionContext` (`:815-824`) with `phase: "pre" | "mpi"`.

One guard at the top of **`isFieldRequiredForZone`** (`:1012`) and
**`isFieldApplicableToZone`** (`:1093`):

```ts
if (field.phase !== context.phase) return false;
```

Both feed validation, the server, and the UI rail, so this is the single
root-cause edit — no per-caller guards.

`requiredZonesForBooking(serviceNames, phase)` (`:1374`): return zones that
have at least one required field *in that phase*. `UND` is all-MPI, so it
drops out of pre entirely; corners and ENG appear in both; FRT is pre-only.

Zone completion becomes per-phase (spec §9): replace `ZoneState.done`
(`:657-673`) with `donePre` / `doneMpi`. Migrate existing rows by reading the
old `done` into `donePre`.

`cornerCopyPatch` (`:860`) takes a phase and copies only that phase's
allowlist (spec §5):

| Phase | Copies | Targets | Never copies |
|---|---|---|---|
| pre | `tire_brand`, `tire_model`, `tire_size`, `tire_type`, `run_flat` | all four (per axle if staggered) | `psi`, `tread`, `wear` |
| mpi | `brake_visual`, `pad_brand` | same axle only | `pad_inner`, `pad_outer`, `rotor`, `desc` |

This fixes a live bug: today `cornerCopyPatch` copies **everything**,
including tire pressure, which is wrong on staggered setups (Aug 20: 40/43).
`OPPOSITE_CORNER` (`:847`) is same-axle only — pre needs a new all-four target
set.

### 2. `components/multi-point-inspection-dialog.tsx` — modify, do not fork

Confirmed: **one component with a `phase` prop**, not a second component.
Spec §7.2 says so itself ("Same component, different item list, different
gate"). Corner zones are visited in both phases against shared zone state; a
fork would duplicate ~5,500 lines of autosave, hydration, zone state, copy,
photos, the four field renderers, the rail, spec-prefill review and the
add-to-job flow — and give required-ness two implementations to drift.

- Replace `jobInProgress?: boolean` (`:409-433`) with
  `phase: "pre" | "mpi"`; derive the existing `jobInProgress` behaviour as
  `phase === "mpi"` at `:1698`, `:1759`, `:2007`, `:5145`, `:5274`.
- **The render filter at `:3019-3025` is the critical site.** It currently
  bypasses applicability for every wheel-off key via `ALWAYS_VISIBLE_FIELDS`
  (`:285-300`) and `SCOPE_INDEPENDENT_BRAKE_DETAIL_FIELDS` (`:306-312`) —
  which is *why pad and rotor rows are on screen at Vehicle Check today*. The
  phase check must run **before** both overrides:

```ts
const applicableFields = zone.fields.filter((field) => {
  if (field.phase !== phase) return false;      // ← new, must be first
  if (ALWAYS_VISIBLE_FIELDS.has(field.key)) return true;
  ...
});
```

- At MPI, corner zones render the pre rows collapsed and read-only above the
  brake rows (spec §5).
- Pass `phase` into both `ZoneCompletionContext` builders (`:750-779`).
- Move the lift question (`:2081-2085`, state at `:681`) into the MPI phase
  and drop it from the pre-check submit gate at `:1487`.
- Auto-advance after copy goes to the next incomplete zone **in the current
  phase**, never across the boundary (spec §5).
- Header counter runs twice — same component, per-phase item list (spec §7.2).

### 3. Job state machine and timer

Three windows, per spec §3. None of them read `status` — they are timestamp
pairs written at transition moments, so the MPI duration dataset survives
intact under the shop-side-field model:

| Window | Source | Recorded as |
|---|---|---|
| Check-in → Start Job (pre-check) | nothing written | untimed admin, target <5 min |
| Start Job → In Progress (inspecting) | `mpi_started_at` → `mpi_completed_at` | MPI duration dataset |
| In Progress → Complete | `job_actuals.started_at` | labor timer |

- Start Job: `status → in_progress`, set `mpi_started_at`, set the shop-side
  MPI sub-state. **Do not set `job_actuals.started_at`.**
- MPI required hits zero → clear the sub-state, set `mpi_completed_at`, set
  `started_at = now`. Labor timer begins here.

MPI duration is `mpi_completed_at - mpi_started_at`; labor is measured from
`started_at`. Two non-overlapping windows.

The trap: `startWithPrejob` (`convex/bookings.ts:11242-11260`) today writes
`startedAtMs: now` *and* flips status in one shot, and `persistPrejobSurvey`
(`:6599-6600`) is **first-write-wins** on `started_at`. Left alone, the labor
timer would swallow the whole inspecting window and defeat the point.

Second trap: the customer progress bar reads `started_at`
(`convex/bookings.ts:556-565`). Moving `started_at` later means the tracker
says "In progress" (from status) while progress reads 0% for the inspection
window. Acceptable, but confirm with Yassin — it is a customer-visible
consequence of §3 that §8 does not mention.

Spec §3's "auto-pause when the inspection tab is open" is now only relevant
for step 4 (reopening the MPI mid-job for optional items); during
`inspecting` the labor timer isn't running at all. Existing pause/resume is
unchanged.

### 4. `components/booking-detail-panel.tsx` — the doors

There is **no way to open the MPI once the job is running today**: `:1805`
gates on `vehicle_at_shop` and `setShowPrejobDialog(true)` has exactly one
call site (`:1358`) behind an early return on that status. `jobInProgress` at
`:2669` is therefore permanently `false`. This is the bulk of the UI work.

- Pre-check opens automatically at check-in; the existing "Open vehicle
  check" button (`:1889`) becomes **Start Job**, disabled until pre-check
  required = 0, with the label saying why (spec §2 step 1).
- MPI popup opens automatically on entering the MPI sub-state, and stays one
  tap away (pinned) afterwards.
- Save & close never gates; the *state* is what gates (spec §2.1).
- `canComplete` (`:1803`) additionally requires MPI required = 0.
- Mirror both at `app/(portal)/dashboard/mechanic-dashboard.tsx:704-736`.

### 5. Server derives phase — never trusts the client

`convex/bookings.ts:6243-6257` rebuilds the same context for re-validation.
Derive `phase` from the booking's sub-state there, not from the payload;
otherwise a client can submit a pre-phase inspection that permanently skips
required MPI fields. `validateTieredInspectionInput` (`:6258-6274`) and its
`requireFinal` path then enforce the right set per phase automatically.

### 6. Ship-with fix (spec §10, still open)

`UnavailableToggle` (`multi-point-inspection-dialog.tsx:3496-3501`) sets
`statuses[field.key]` but never clears `measures[field.key]`, so a typed
number and "not visible" both persist. Confirmed still broken; acceptance
test 9 depends on it. Clear the measure in the same patch.

## Phase assignment

Spec §4 was written from the Aug 5 field set and **omits 22 fields that exist
in the shipped template**. Assignments below applied the spec's own
classifier; the omitted ones are marked ★ and need a nod from Yassin/Abdul.

**Corner zones (FL/FR/RL/RR)** — PRE: `tread`, `psi`, `wear`, `tire_brand`,
`tire_model`, `tire_size`, `tire_type`, ★`run_flat`, ★`brake_visual`.
MPI: `pad_inner`, `pad_outer`, ★`pad_method`, ★`rotor_applicable`, `rotor`,
★`rotor_tool`, `desc`, ★`caliper`, ★`brake_hose`, `pad_brand`,
`steering_play`, `ball_joint_play`, ★`wheel_bearing_play`.

`brake_visual` **must** be PRE: it is required on all four corners for every
booking (`:1025`), so putting it in MPI would force MPI corner zones onto an
oil change and contradict spec §6.

**ENG** — PRE: ★`warning_lights`, `oil_condition`, `oil_level`,
`cool_condition`, `cool_level`, ★`washer`, `bf_level`, ★`bf_leak`,
★`bf_condition`, `trans`, `ps`, `af`, `cf`, `belt`, `hose`, `term`, and the
six ★fluid-spec text fields (`oil_viscosity`, `oil_type`, `coolant_type`,
`brake_fluid_type`, `transmission_fluid_type`, `power_steering_fluid_type` —
read off a cap or prefilled from the passport). MPI: `batt` only.

**UND** — all MPI: `cv`, `strut`, `exh`, ★`leaks`, ★`damage`.
Note the spec's underbody list has four items and names "front-end linkage
(tie rods, ball joints)", but in code `steering_play` / `ball_joint_play`
live **per corner** (section "Lift · wheel off"), not in UND. Keep the code's
placement — per-corner is the more precise data — and drop the spec's
underbody wording.

**FRT** — all PRE: `lamp`, `glass`, `wipe`, `horn`.

**Not a template field:** "Inspection sticker" is a hardcoded row at
`multi-point-inspection-dialog.tsx:4488`, outside the phase system. Render it
in the pre block.

## Rejected outright — not deferred, not to be built

- **Folding `run_flat` into `tire_type`** (spec §4.4 lists type as
  "run-flat / all-season / …"). Decided with Daniel: `run_flat` stays its own
  field exactly as it is now. The code separates them deliberately — see the
  comment at `:286-288`: run-flat is a construction attribute orthogonal to
  season (a run-flat all-season is a normal product), and `run_flat` feeds
  `vehicle_passports.tires.run_flat` as a boolean. Merging would regress the
  passport. Both fields are PRE; nothing about them changes in this build.

- **Spec §6's oil-change required set.** §6 requires oil level and condition
  for an oil change. Confirmed with Daniel: keep shipped behavior — booking
  an oil change makes `oil_condition` / `oil_level` **not** required
  (`:1067`), because you're changing it anyway. `oil_viscosity` and
  `oil_type` **stay required** when an oil change is booked (`:1074-1076`,
  verified) — you record what goes in. Both are already correct in code;
  this build changes neither. Note the phase interaction: both spec fields
  are PRE, so they gate Start Job — the mechanic confirms which oil before
  the clock starts, which is the right order.

## Deferred — do not ship in this build

- **Merging tread + wear into one row** (spec §4.4). `tread` is
  auto-classified with detailed sub-fields (`tread_inner/center/outer`,
  `tread_mode`, `:675-693`) and `wear` is an independent `tri`; merging
  changes grading, not just layout. Spec itself says "needs a UI row design".
- **Spec §6's underbody expansion.** §6 requires underbody for every lifted
  service; today UND is required only for wheel alignment (`:1087-1089`).
  Real workload increase — needs Abdul's walkthrough before hardening, as
  §6 itself says.

## Pre-existing bugs this build should not inherit silently

- `Battery Replacement` doesn't match `BATTERY_TEST_SERVICES`
  (`lib/vehicle-service-relevance.ts:4`) — booking one requires no battery
  check at all, so spec §6's "Battery replacement → MPI: battery load test"
  cannot fire.
- `hasEngineAirFilterReplacement` / `hasCabinAirFilterReplacement` (`:142-143`)
  are never read by `isFieldRequiredForZone`, and the live catalog name is
  `Filter Replacement`, matching neither set — so `af` / `cf` are never
  required for anyone. Spec §6 requires both for oil changes.
- The Aug 24 brake pad + rotor consolidation will need its new service name
  added to `BRAKE_PAD_REPLACEMENT_SERVICES` / `ROTOR_REPLACEMENT_SERVICES` or
  every brake requirement silently evaluates to false.
- `field.required` (`lib/inspection-template.ts:58`, set once on `tread` at
  `:311`) is dead metadata — nothing reads it. Don't extend it; `phase` is a
  new property, not a reuse of that one.

**Already fixed, spec is stale:** §7.1 calls "Add to this job mid-inspection
submits the entire inspection" a blocking P0. `commitAddToJob`
(`multi-point-inspection-dialog.tsx:1677-1726`) now stages only, with no
auto-send — see the comment at `:1715-1718`. The split is not blocked on it.

## Verification

1. `npx vitest run tests/inspection-template.test.ts` — add a case per axis:
   `isFieldRequiredForZone("FL", "pad_inner", { phase: "pre", … })` is
   `false` on a booked-axle corner and `true` with `phase: "mpi"`. Baseline:
   13 vitest failures pre-exist on a clean tree.
2. `npx tsc --noEmit` — baseline 188 pre-existing failures; confirm none new
   from the `InspectionField` / `ZoneCompletionContext` / prop changes.
3. Spec §12 acceptance tests 1-11 against a dev Convex deployment. The ones
   that exercise this plan's deviations specifically:
   - **Test 5** (customer app reads "In progress" throughout tests 2-4) —
     passes for free under the status decision above; it is the test that
     would have failed had `inspecting` been a status value.
   - **Test 3** (close MPI with 2 required left, reopen) — job holds in the
     MPI sub-state, popup returns, labor timer not running,
     `mpi_started_at` set.
   - **Test 4** (fill last required MPI item) — auto-transition with no
     button, `mpi_completed_at` set, labor timer starts.
   - **Test 8** (copy FL→FR at pre) — brand/model/size/type copy; tread,
     pressure, wear do not; focus lands on the next incomplete **pre** zone.
   - **Test 9** — typed 5 then "not visible" clears the number (§6 fix).
4. Regress the null case: a booking with only `Diagnostic Scan` (moves no
   service flags) must behave identically to today in both phases.
5. Test 11 is Abdul's, on a real car: full pre-check under 5 minutes. If it
   runs over, cut pre items — do not move the clock.
