# Booking workflow state guard

## Purpose

Booking-bound forms must not remain actionable after a concurrent lifecycle
change makes their pending action invalid. This prevents an apparently inert
submit button and gives the mechanic a clear explanation of what happened.

## Scope

The guard applies to the shop-side booking workflows that act on a single
booking: multi-point inspection (pre and MPI), post-job reporting, pre-/mid-job
approval forms, diagnostic completion, and job-actuals forms. It does not apply
to generic confirmation dialogs or unrelated drawers.

A customer pickup request is informational only. It leaves the booking
actionable; front desk decides whether to cancel it.

## Design

`BookingWorkflowGuard` is a shared client component. It receives the reactive
booking detail already owned by its parent, the lifecycle states accepted by the
wrapped workflow, and an acknowledgement callback.

While a workflow is open, the guard replaces its child with a blocking
acknowledgement dialog when the booking is missing or its current state is no
longer accepted. It never starts a second subscription, so the parent remains
the single source of live booking data. `undefined` booking detail is treated
as loading, not as an unavailable booking.

Each workflow declares only its valid states:

- pre-inspection and pre-job estimate: their server-supported pre-start states;
- MPI, mid-job scope, post-job completion, and diagnostic completion:
  `in_progress`;
- job actuals: the states accepted by its specific save/finalize mutation.

The backend enriches `getJobDetail` with a display-safe latest lifecycle event.
For a cancellation it returns `the customer` when the customer performed it,
or the shop staff member's display name for a shop-side action. It does not
expose raw actor IDs to the dialog. If the actor cannot be classified with
confidence, the notice uses only `This booking is no longer available.` A
reschedule that makes the workflow ineligible renders exactly: `This booking
is no longer available. It has been rescheduled.` Completed and missing
bookings use their own clear status copy.

The acknowledgement dialog is non-dismissable except for **Acknowledge**. That
action closes the corresponding workflow state in the parent.

## Error handling

The guard handles stale lifecycle state before submit. Existing dialog-local
validation and mutation error handling remain responsible for ordinary input,
upload, and service failures. The normal post-job submit path will also surface
its mutation error in the dialog rather than behind the booking panel.

## Verification

- Unit-test the status-to-notice helper for cancellation attribution,
  reschedule, completion, missing booking, allowed state, and loading state.
- Exercise representative pre, MPI, post-job, and diagnostic entry points with
  a reactive status change and verify the acknowledgement dialog replaces the
  form.
- Run the focused test suite and type-check/lint the touched files.
