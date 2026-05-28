"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

export type ApprovalCycle = "pre_job" | "mid_job" | "post_job_reapproval";

export type ApprovalStateSnapshot = {
  payment_approval_state: string;
  mechanic_set_price_cents: number | null;
  sla_expires_at_ms: number | null;
  last_cycle: string | null;
  last_decision: string | null;
  submitted_at_ms: number | null;
  has_open_approval: boolean;
};

export type UseApprovalWorkflowArgs = {
  bookingId: string | null | undefined;
  cycle?: ApprovalCycle;
};

const PENDING_STATES = new Set([
  "pre_job_pending",
  "mid_job_pending",
  "post_job_pending",
]);
const APPROVED_STATES = new Set([
  "pre_job_approved",
  "mid_job_approved",
  "post_job_approved",
]);
const DECLINED_STATES = new Set([
  "pre_job_declined",
  "mid_job_declined",
  "post_job_declined",
]);

// Refresh "Sent 2 min ago" + SLA countdown every 30s. Cheap — single
// timestamp re-render gates both.
const RELATIVE_TIME_REFRESH_MS = 30 * 1000;

function formatSlaCountdown(expiresAtMs: number | null, nowMs: number): string | null {
  if (expiresAtMs == null) return null;
  const ms = expiresAtMs - nowMs;
  if (ms <= 0) return "SLA expired";
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours >= 1) return `${hours}h ${minutes}m left`;
  return `${minutes}m left`;
}

function formatRelativeSent(ms: number | null, nowMs: number): string | null {
  if (ms == null) return null;
  const diff = Math.max(0, nowMs - ms);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "Sent just now";
  if (minutes < 60) return `Sent ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Sent ${hours}h ago`;
  return `Sent ${Math.floor(hours / 24)}d ago`;
}

export function useApprovalWorkflow({
  bookingId,
  cycle,
}: UseApprovalWorkflowArgs) {
  const approvalState = useQuery(
    api.booking_approvals.getBookingApprovalState,
    bookingId ? { bookingId: bookingId as Id<"bookings"> } : "skip",
  ) as ApprovalStateSnapshot | null | undefined;

  const updateStatus = useMutation(api.bookings.updateStatus);
  const cancel = useMutation(api.bookings.cancel);
  const withdraw = useMutation(api.booking_approvals.withdrawPendingApproval);

  const state = approvalState?.payment_approval_state ?? "none";
  const isInRange = state === "in_range";
  const isPending = PENDING_STATES.has(state);
  const isApproved = APPROVED_STATES.has(state);
  const isDeclined = DECLINED_STATES.has(state);
  const isSlaExpired = state === "sla_expired";
  // Surface Stripe-side hold failures: incrementAuthorization rejected without
  // a usable reauth fallback OR a reauth itself failed. Either way the
  // customer needs to reauthorize before work can continue.
  const isReauthRequired = state === "reauth_required";
  const isPostJobPending = state === "post_job_pending";
  const isCaptured = state === "captured";

  // Re-render every 30s so the "Sent N min ago" string + SLA countdown stay
  // fresh. Kicks in for any state with a live timer (pending or reauth).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isPending && !isReauthRequired) return;
    const id = setInterval(() => setNow(Date.now()), RELATIVE_TIME_REFRESH_MS);
    return () => clearInterval(id);
  }, [isPending, isReauthRequired]);

  const relativeSentLabel = useMemo(
    () => formatRelativeSent(approvalState?.submitted_at_ms ?? null, now),
    [approvalState?.submitted_at_ms, now],
  );

  const slaCountdownLabel = useMemo(
    () => formatSlaCountdown(approvalState?.sla_expires_at_ms ?? null, now),
    [approvalState?.sla_expires_at_ms, now],
  );

  const onStartWork = useCallback(async () => {
    if (!bookingId) return;
    await updateStatus({
      bookingId: bookingId as Id<"bookings">,
      newStatus: "in_progress",
      reason: "approval_confirmed",
    });
  }, [bookingId, updateStatus]);

  const onRelease = useCallback(async () => {
    if (!bookingId) return;
    await cancel({
      bookingId: bookingId as Id<"bookings">,
      reason: "released_after_decline",
    });
  }, [bookingId, cancel]);

  const onWithdraw = useCallback(async () => {
    if (!bookingId) return;
    await withdraw({ bookingId: bookingId as Id<"bookings"> });
  }, [bookingId, withdraw]);

  return {
    approvalState: approvalState ?? null,
    state,
    cycle,
    isInRange,
    isPending,
    isApproved,
    isDeclined,
    isSlaExpired,
    isReauthRequired,
    isPostJobPending,
    isCaptured,
    mechanicSetPriceCents: approvalState?.mechanic_set_price_cents ?? null,
    lastSubmittedAtMs: approvalState?.submitted_at_ms ?? null,
    slaExpiresAtMs: approvalState?.sla_expires_at_ms ?? null,
    relativeSentLabel,
    slaCountdownLabel,
    onStartWork,
    onRelease,
    onWithdraw,
  };
}

export type ApprovalWorkflow = ReturnType<typeof useApprovalWorkflow>;
