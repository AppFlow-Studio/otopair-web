"use client";

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

export type LiveAlertKind =
  | "on_my_way"
  | "no_show_decision"
  | "late_notification_sent"
  | "overrun"
  | "manual_scheduling"
  | "late_start";

const PRIORITY: Record<LiveAlertKind, number> = {
  no_show_decision: 1,
  on_my_way: 2,
  manual_scheduling: 3,
  late_notification_sent: 4,
  overrun: 5,
  late_start: 6,
};

export type LiveAlert = {
  id: string;
  kind: LiveAlertKind;
  priority: number;
  bookingId?: Id<"bookings">;
  reviewId?: Id<"late_start_reviews">;
  customerName: string | null;
  vehicleLabel: string | null;
  scheduledDate: string | null;
  scheduledTime: string | null;
  mechanicId?: Id<"mechanics"> | null;
  mechanicName: string | null;
  serviceSummary?: string | null;
  minutesLate?: number;
  acknowledgedAtMs?: number;
  notifiedVia?: string;
  defaultExtensionMinutes?: number;
  shortHandle?: string | null;
  reason?: string;
  timestamp: number;
  summary: string;
  headerLabel: string;
  accent: "emerald" | "yellow" | "orange" | "cyan" | "red" | "amber";
};

function formatTime12h(time: string | null | undefined): string {
  if (!time) return "";
  const [hStr, mStr] = time.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return time;
  const ampm = h >= 12 ? "PM" : "AM";
  const hr = h % 12 || 12;
  return `${hr}:${String(m).padStart(2, "0")} ${ampm}`;
}

export function useLiveAlerts(): {
  alerts: LiveAlert[];
  isLoading: boolean;
} {
  const onMyWay = useQuery(api.bookings.getCustomerOnMyWayMonitors);
  const noShowDecisions = useQuery(api.bookings.getOpenCustomerLateAlerts);
  const notificationSent = useQuery(
    api.bookings.getCustomerLateNotificationSentMonitors,
  );
  const overruns = useQuery(api.bookings.getOpenFrontDeskOverrunAlerts);
  const manualScheduling = useQuery(api.bookings.getOpenManualSchedulingAlerts);
  const lateStartReviews = useQuery(api.bookings.getOpenLateStartReviews);

  const alerts = useMemo<LiveAlert[]>(() => {
    const out: LiveAlert[] = [];

    for (const row of (onMyWay ?? []) as any[]) {
      if (!row) continue;
      const time = formatTime12h(row.scheduledTime);
      out.push({
        id: String(row._id),
        kind: "on_my_way",
        priority: PRIORITY.on_my_way,
        bookingId: row.bookingId,
        customerName: row.customerName ?? null,
        vehicleLabel: row.vehicle ?? null,
        scheduledDate: row.scheduledDate ?? null,
        scheduledTime: row.scheduledTime ?? null,
        mechanicId: row.mechanicId ?? null,
        mechanicName: row.mechanicName ?? null,
        serviceSummary: row.serviceSummary ?? null,
        minutesLate: row.minutesLate,
        acknowledgedAtMs: row.acknowledgedAtMs,
        timestamp: row.acknowledgedAtMs ?? Date.now(),
        summary: `${row.customerName ?? "Customer"} is on the way${time ? ` · ${time}` : ""}`,
        headerLabel: "Customer en route",
        accent: "emerald",
      });
    }

    for (const row of (noShowDecisions ?? []) as any[]) {
      if (!row) continue;
      const time = formatTime12h(row.scheduledTime);
      out.push({
        id: String(row._id),
        kind: "no_show_decision",
        priority: PRIORITY.no_show_decision,
        bookingId: row.bookingId,
        customerName: row.customerName ?? null,
        vehicleLabel: row.vehicle ?? null,
        scheduledDate: row.scheduledDate ?? null,
        scheduledTime: row.scheduledTime ?? null,
        mechanicId: row.mechanicId ?? null,
        mechanicName: row.mechanicName ?? null,
        serviceSummary: row.serviceSummary ?? null,
        minutesLate: row.minutesLate,
        timestamp: row.thresholdDueAtMs ?? Date.now(),
        summary: `No-show decision · ${row.customerName ?? "Customer"}${time ? ` · ${time}` : ""}`,
        headerLabel: "No-show decision",
        accent: "orange",
      });
    }

    for (const row of (notificationSent ?? []) as any[]) {
      if (!row) continue;
      const time = formatTime12h(row.scheduledTime);
      out.push({
        id: String(row._id),
        kind: "late_notification_sent",
        priority: PRIORITY.late_notification_sent,
        bookingId: row.bookingId,
        customerName: row.customerName ?? null,
        vehicleLabel: row.vehicle ?? null,
        scheduledDate: row.scheduledDate ?? null,
        scheduledTime: row.scheduledTime ?? null,
        mechanicId: row.mechanicId ?? null,
        mechanicName: row.mechanicName ?? null,
        serviceSummary: row.serviceSummary ?? null,
        minutesLate: row.minutesLate,
        notifiedVia: row.notifiedVia,
        timestamp: Date.now(),
        summary: `Late reminder sent · ${row.customerName ?? "Customer"}${time ? ` · ${time}` : ""}`,
        headerLabel: "Late notification sent",
        accent: "yellow",
      });
    }

    for (const row of (overruns ?? []) as any[]) {
      if (!row) continue;
      out.push({
        id: String(row._id),
        kind: "overrun",
        priority: PRIORITY.overrun,
        bookingId: row.bookingId,
        customerName: row.customerName ?? null,
        vehicleLabel: null,
        scheduledDate: null,
        scheduledTime: null,
        mechanicId: null,
        mechanicName: row.mechanicName ?? null,
        serviceSummary: row.serviceSummary ?? null,
        defaultExtensionMinutes: row.defaultExtensionMinutes,
        timestamp: row.escalatedAtMs ?? Date.now(),
        summary: `Overrun · ${row.customerName ?? "Customer"} needs an extension`,
        headerLabel: "Overrun escalation",
        accent: "cyan",
      });
    }

    for (const row of (manualScheduling ?? []) as any[]) {
      if (!row) continue;
      const time = formatTime12h(row.scheduledTime);
      out.push({
        id: String(row._id),
        kind: "manual_scheduling",
        priority: PRIORITY.manual_scheduling,
        bookingId: row.bookingId ?? undefined,
        customerName: row.customerName ?? null,
        vehicleLabel: row.vehicleLabel ?? null,
        scheduledDate: row.scheduledDate ?? null,
        scheduledTime: row.scheduledTime ?? null,
        mechanicName: null,
        shortHandle: row.shortHandle,
        reason: row.reason,
        timestamp: row.createdAt ?? Date.now(),
        summary: `Manual reschedule needed${row.customerName ? ` · ${row.customerName}` : ""}${time ? ` · ${time}` : ""}`,
        headerLabel: "Manual scheduling review",
        accent: "red",
      });
    }

    for (const row of (lateStartReviews ?? []) as any[]) {
      if (!row) continue;
      const time = formatTime12h(row.upstreamScheduledTime);
      out.push({
        id: String(row._id),
        kind: "late_start",
        priority: PRIORITY.late_start,
        reviewId: row._id,
        bookingId: row.upstreamBookingId ?? row.upstream_booking_id,
        customerName: row.upstreamCustomerName ?? null,
        vehicleLabel: null,
        scheduledDate: row.upstreamScheduledDate ?? null,
        scheduledTime: row.upstreamScheduledTime ?? null,
        mechanicName: null,
        timestamp: row.decisionDueAtMs ?? Date.now(),
        summary: `Late-start decision · ${row.upstreamCustomerName ?? "Booking"}${time ? ` · ${time}` : ""}`,
        headerLabel: "Late start decision",
        accent: "amber",
      });
    }

    out.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.timestamp - b.timestamp;
    });

    return out;
  }, [
    onMyWay,
    noShowDecisions,
    notificationSent,
    overruns,
    manualScheduling,
    lateStartReviews,
  ]);

  const isLoading =
    onMyWay === undefined ||
    noShowDecisions === undefined ||
    notificationSent === undefined ||
    overruns === undefined ||
    manualScheduling === undefined ||
    lateStartReviews === undefined;

  return { alerts, isLoading };
}
