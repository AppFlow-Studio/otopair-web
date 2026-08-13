# Scheduling Overhaul Plan

## Summary

Implement the `qs.txt` version of the scheduling overhaul, with `qs.txt` overriding the docx. This pass is **mechanic-only**, uses **notification outbox records only**, and defaults currently-existing bookings to **Any mechanic** behavior.

The overhaul separates two flows:

- **Customer-late flow:** customer has not arrived after scheduled start.
- **Job-overrun flow:** vehicle is already in progress and the job may run long.

## Key Changes

- Add `vehicle_at_shop` between `confirmed` and `in_progress`; portal gets a “Vehicle here” action, and starting work requires this state.
- Add shop settings: no-show threshold default `30`, range `15–60`; overrun default extension percent default `25`; extension floor default `15` minutes.
- Add notification outbox records for intended push/SMS/front-desk alerts, without real provider calls yet.
- Customer-late flow:
  - Start monitoring when a `confirmed` booking reaches start time without `vehicle_at_shop`.
  - Push reminder at `min(threshold / 3, 10m)`.
  - SMS reminder at `min(threshold * 2 / 3, 20m)`.
  - At threshold, show front desk decision: mark no-show or reschedule.
  - No automatic no-show cancellation.
- Dynamic downstream movement:
  - `assignment_preference: "any"` can lateral-move to a free mechanic in the same slot with courtesy notification.
  - `assignment_preference: "specific_mechanic"` preserves the mechanic and pushes time forward.
  - Existing bookings at migration time default to `"any"`.
- Job-overrun flow:
  - Prompt mechanic at 75% of estimated job duration.
  - If “No,” ask for `15 / 30 / 45 / 60`.
  - If incomplete after 3 minutes, escalate to front desk.
  - If neither answers after 6 minutes total, apply `max(25% of duration, 15m)`.
  - Log whether mechanic, front desk, or system supplied the answer.
- Update schedule/detail/settings UI for `vehicle_at_shop`, no-show alerts, overrun prompts, and scheduling settings.

## Public Interfaces

- Booking statuses become:
  `pending -> confirmed -> vehicle_at_shop -> in_progress -> completed`
  plus `confirmed -> no_show` only through the post-threshold front-desk action.
- Add booking fields:
  - `vehicle_arrived_at_ms`
  - `vehicle_arrived_by_user_id`
  - `assignment_preference: "any" | "specific_mechanic"`
- Add mutations:
  - `markVehicleAtShop`
  - `markPostThresholdNoShow`
  - `rescheduleFromNoShowAlert`
  - `answerOverrunCheckIn`
  - `answerOverrunExtension`

## Test Plan

- Threshold timing tests for 15, 30, 45, and 60 minute settings.
- Status transition tests: cannot start before vehicle arrival; cannot mark no-show before threshold.
- Planner tests for Any lateral moves, specific-mechanic time pushes, blocked slots, and shop hours.
- Job-overrun tests for mechanic answer, front-desk escalation, system default, and answer-source logging.
- Update the portal manual/Playwright scheduling test for vehicle arrival, no-show decision, and overrun prompt flows.
- Run `npm run lint` and targeted scheduling tests.

## Assumptions

- Mechanic-only scheduling for this implementation; no bay logic.
- Existing DB bookings at implementation time default to `assignment_preference: "any"`.
- Notification delivery is outbox-only for now.
- No-show is manual after threshold, never automatic.
