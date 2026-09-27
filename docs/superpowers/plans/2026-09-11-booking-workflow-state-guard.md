# Booking Workflow State Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace any open shop-side booking workflow with a clear acknowledgement notice when a concurrent lifecycle change makes its action invalid.

**Architecture:** `getJobDetail` supplies a safe summary of its latest lifecycle event. A pure helper converts the live booking status and that summary into notice copy; `BookingWorkflowGuard` renders either its child workflow or an acknowledgement-only dialog. Existing parents pass their already-reactive booking detail and a narrow status contract to the guard.

**Tech Stack:** Next.js/React, Convex reactive queries, TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-11-booking-workflow-state-guard-design.md`

## Global Constraints

- Reuse each parent’s existing `getJobDetail` subscription; do not add a second booking query.
- Customer pickup requests remain informational and never trigger this guard.
- Use customer/shop attribution only when the latest cancellation event classifies it safely; otherwise use `This booking is no longer available.`
- A reschedule notice must read exactly: `This booking is no longer available. It has been rescheduled.`
- The unavailable notice can be dismissed only through **Acknowledge**.

---

### Task 1: Derive a display-safe lifecycle event in booking detail

**Files:**
- Modify: `convex/bookings.ts:10813-11206`
- Modify: `components/booking-detail-panel.tsx:684-702`

**Interfaces:**
- Produces `latestLifecycleEvent?: { status: string; reason: string | null; actor: "customer" | "shop_member" | "unknown"; actorName: string | null } | null` in `getJobDetail`.
- Consumes the existing newest-first `booking_status_history` rows.

- [ ] **Step 1: Add a failing Convex test for event classification**

Create `tests/bookingWorkflowLifecycleEvent.test.ts` with customer, shop-staff, and system cancellation fixtures. Assert that customer returns `actor: "customer"`, a known staff user returns `actor: "shop_member"` with its display name, and an event without an actor returns `actor: "unknown"` with no name.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx vitest run tests/bookingWorkflowLifecycleEvent.test.ts`

Expected: FAIL because `latestLifecycleEvent` is absent from `getJobDetail`.

- [ ] **Step 3: Add the minimal query projection**

After sorting history newest-first, derive only the newest row. Classify it as customer only when `changed_by` equals `booking.user_id`; otherwise resolve a `users` row and expose a name only for a known staff actor. Return the safe summary alongside `history`.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npx vitest run tests/bookingWorkflowLifecycleEvent.test.ts`

Expected: PASS.

### Task 2: Build and test the shared lifecycle-to-notice helper

**Files:**
- Create: `lib/booking-workflow-state.ts`
- Create: `lib/booking-workflow-state.test.ts`

**Interfaces:**
- Produces `getBookingWorkflowUnavailableNotice(booking, allowedStatuses): string | null`.
- Consumes the `latestLifecycleEvent` shape from Task 1 and `undefined | null | { status: string }` booking detail.

- [ ] **Step 1: Write failing copy/eligibility tests**

Cover loading (`undefined`), allowed status, missing booking, customer cancellation, named shop cancellation, unknown cancellation, completed booking, and a `reschedule_proposed_by_shop` event. Assert the exact reschedule copy and generic fallback copy.

- [ ] **Step 2: Run the helper test to verify it fails**

Run: `npx vitest run lib/booking-workflow-state.test.ts`

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement the pure helper**

Prioritize an invalidating reschedule reason over allowed status, return `null` for loading and valid state, then map cancellation attribution, completed state, missing booking, and other invalid states to concise copy.

- [ ] **Step 4: Run the helper test to verify it passes**

Run: `npx vitest run lib/booking-workflow-state.test.ts`

Expected: PASS.

### Task 3: Add the reusable acknowledgement-only guard

**Files:**
- Create: `components/booking/booking-workflow-guard.tsx`
- Test: `lib/booking-workflow-state.test.ts`

**Interfaces:**
- Consumes `open`, the booking detail from Task 1, `allowedStatuses`, `onAcknowledge`, and `children`.
- Produces the original child while eligible, otherwise a `ConfirmationDialog` above all survey dialogs.

- [ ] **Step 1: Implement the minimal wrapper**

Render children while closed, loading, or eligible. When the helper returns copy while open, render only `ConfirmationDialog` with `enableShortcuts={false}`, a no-op `onClose`, `zIndexClassName="z-[80]"`, and a primary **Acknowledge** action that calls `onAcknowledge`.

- [ ] **Step 2: Run the helper tests**

Run: `npx vitest run lib/booking-workflow-state.test.ts`

Expected: PASS; the wrapper delegates state policy to the tested helper.

### Task 4: Guard every active booking workflow entry point

**Files:**
- Modify: `components/booking-detail-panel.tsx:2734-2930`
- Modify: `app/(portal)/dashboard/mechanic-dashboard.tsx:722-900`
- Modify: `app/(portal)/dashboard/page.tsx:850-930`
- Modify: `components/booking/mid-job-scope-dialog.tsx:146-230`

**Interfaces:**
- Consumes `BookingWorkflowGuard` and `latestLifecycleEvent` from Task 1.
- Produces live replacement behavior for pre/MPI inspection, post-job completion, pre-job estimate, diagnostic completion, mid-job scope, and legacy job-actuals forms.

- [ ] **Step 1: Wrap pre/MPI and post-job flows**

Use `vehicle_at_shop` for pre-inspection, `in_progress` for MPI and normal post-job completion, and acknowledge by clearing the parent’s corresponding open-state flag.

- [ ] **Step 2: Wrap approval, diagnostic, and mid-job flows**

Use the server-supported pre-job-estimate states, `in_progress` for diagnostic and mid-job scope, and route acknowledgement through their existing close callbacks. `MidJobScopeDialog` uses its existing reactive `job` query.

- [ ] **Step 3: Wrap job-actuals forms according to mode**

Pass `in_progress` for completion mode and `completed` for edit mode; acknowledgement closes the actuals dialog.

- [ ] **Step 4: Run focused static verification**

Run: `git grep -n "BookingWorkflowGuard" -- components app` and `npx eslint components/booking/booking-workflow-guard.tsx lib/booking-workflow-state.ts components/booking-detail-panel.tsx app/(portal)/dashboard/mechanic-dashboard.tsx app/(portal)/dashboard/page.tsx components/booking/mid-job-scope-dialog.tsx`

Expected: every listed workflow entry point imports the guard and lint reports no errors in the touched files.

### Task 5: Make normal post-job mutation errors visible in the dialog

**Files:**
- Modify: `components/post-job-survey-dialog.tsx:2146-2430`
- Modify: `components/booking-detail-panel.tsx:1555-1587`
- Modify: `app/(portal)/dashboard/mechanic-dashboard.tsx:338-368`

**Interfaces:**
- Preserves `PostJobSurveyDialog.onSubmit(): Promise<void>`.
- Produces an inline `error` message for rejected normal post-job submissions.

- [ ] **Step 1: Write a focused source-level regression test**

Create `components/post-job-survey-dialog.source.test.ts` that reads the component source and asserts that the normal `await onSubmit` is enclosed in a `try/catch` that calls `setError`.

- [ ] **Step 2: Run the regression test to verify it fails**

Run: `npx vitest run components/post-job-survey-dialog.source.test.ts`

Expected: FAIL because the normal post-job branch currently lets rejection escape to its parent.

- [ ] **Step 3: Catch the normal submit rejection locally**

Wrap the legacy `onSubmit` call in the dialog’s existing error-state pathway, preserving parent error reporting for other callers but preventing an error from being hidden behind the modal.

- [ ] **Step 4: Run focused tests and inspect the diff**

Run: `npx vitest run lib/booking-workflow-state.test.ts components/post-job-survey-dialog.source.test.ts` and `git diff --check`.

Expected: both focused tests PASS and no whitespace errors.
