# Scheduling Overhaul Implementation Plan

## Summary
Implement the mechanic-only scheduling overhaul from `Reference_Files/scheduling_overhaul_plan.md`: add `vehicle_at_shop`, customer-late alerts, preference-aware downstream movement, job-overrun prompts, outbox-only notifications, and scheduling settings. Existing bookings with no preference behave as `Any mechanic`.

## Public Interfaces And Data
- Update booking lifecycle to allow `confirmed -> vehicle_at_shop -> in_progress -> completed`, and `confirmed -> no_show` only through `markPostThresholdNoShow`.
- Add booking fields: `vehicle_arrived_at_ms`, `vehicle_arrived_by_user_id`, `assignment_preference: "any" | "specific_mechanic"`.
- Add shop scheduling settings: no-show threshold default `30` and range `15-60`, overrun default extension percent default `25`, extension floor default `15`.
- Add outbox-only notification records for push, SMS, front-desk alerts, and courtesy schedule-change notices. No provider calls.
- Add customer-late and overrun tracking tables separate from the existing legacy `late_start_*` tables.

## Backend Changes
- On `confirmed`, create/update customer-late monitoring from scheduled start:
  - push reminder at `min(threshold / 3, 10m)`
  - SMS reminder at `min(threshold * 2 / 3, 20m)`
  - front-desk alert at threshold
- Add `markVehicleAtShop`, stamping arrival metadata and resolving late alerts.
- Require `vehicle_at_shop` before `startWithPrejob`, legacy `start`, or `job_actuals.startJob` can move a booking to `in_progress`.
- Add `markPostThresholdNoShow`, validating threshold has passed before manual `confirmed -> no_show`.
- Add `rescheduleFromNoShowAlert`, directly moving the booking to a new confirmed slot.
- Add preference-aware downstream movement:
  - `any`: lateral move to a free mechanic in the same slot first, with courtesy outbox notice.
  - `specific_mechanic`: keep mechanic and push forward.
  - blocked/manual cases create a front-desk alert instead of unsafe partial movement.
- Add overrun flow:
  - mechanic prompt at 75% of estimated duration
  - if not complete, mechanic/front desk selects `15 / 30 / 45 / 60`
  - escalate to front desk after 3 minutes incomplete
  - after 6 minutes total, apply `max(25% duration, 15m)` by default
  - log source as mechanic, front desk, or system

## UI Changes
- Update status labels/legend/cards/filters for `vehicle_at_shop` and `no_show`.
- Booking detail gets `Vehicle here`, post-threshold no-show/reschedule actions, and start-gating copy.
- Mechanic dashboard shows confirmed jobs as awaiting vehicle and allows start only from `vehicle_at_shop`.
- Schedule page replaces late-start review cards with customer-late front-desk alerts and overrun escalation cards.
- Settings page adds scheduling settings controls.
- Create/edit booking defaults to Any mechanic; explicitly choosing a mechanic marks Specific mechanic.

## Test Plan
- Add timing tests for thresholds `15/30/45/60`, notification due times, and overrun default extension.
- Add status transition tests for vehicle arrival, start gating, and no-show threshold validation.
- Add planner tests for Any lateral moves, Specific mechanic pushes, blocked slots, and shop hours.
- Add overrun tests for mechanic answer, front-desk escalation, system default, and source logging.
- Update portal manual Playwright scheduling flow.
- Run `npm run lint` and targeted scheduling/backend checks.

## Assumptions
- `scheduling_overhaul_plan.md` is the available source of truth; no `qs.txt` exists in the repo.
- Post-threshold front-desk reschedules are direct confirmed moves.
- Notifications remain outbox-only.
- No-show is manual after threshold, never automatic.
