"use client";

import { useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { NotificationCard, type NotificationItem } from "./notification-card";
import { NotificationEmptyState } from "./notification-empty-state";

type Tab = "all" | "confirm" | "tire";

interface FeedShape {
  unreadCount: number;
  counts: { confirm: number; tireQuote: number };
  items: NotificationItem[];
}

interface NotificationPopoverProps {
  feed: FeedShape | null | undefined;
  onClose: () => void;
}

export function NotificationPopover({ feed, onClose }: NotificationPopoverProps) {
  const router = useRouter();
  const markAllRead = useMutation(api.mechanicNotifications.markAllRead);

  const [activeTab, setActiveTab] = useState<Tab>("all");
  const [skipped, setSkipped] = useState<Set<string>>(new Set());

  const items = feed?.items ?? [];

  const visibleItems = useMemo(() => {
    const filteredBySkip = items.filter(
      (item) => !skipped.has(String(item.bookingId))
    );
    if (activeTab === "confirm") {
      return filteredBySkip.filter((item) => item.kind === "booking");
    }
    if (activeTab === "tire") {
      return filteredBySkip.filter((item) => item.kind === "tire_quote");
    }
    return filteredBySkip;
  }, [items, skipped, activeTab]);

  const confirmCount = items.filter(
    (item) => item.kind === "booking" && !skipped.has(String(item.bookingId))
  ).length;
  const tireCount = items.filter(
    (item) =>
      item.kind === "tire_quote" && !skipped.has(String(item.bookingId))
  ).length;

  function handleSkip(bookingId: string) {
    setSkipped((prev) => {
      const next = new Set(prev);
      next.add(bookingId);
      return next;
    });
  }

  async function handleMarkAllRead() {
    try {
      await markAllRead({});
    } catch {
      // best-effort; bell badge update happens on next refresh
    }
  }

  function goToBookings() {
    onClose();
    router.push("/bookings");
  }

  function goToSettings() {
    onClose();
    router.push("/settings/notifications");
  }

  const summary: string[] = [];
  if (confirmCount > 0) {
    summary.push(`${confirmCount} to confirm`);
  }
  if (tireCount > 0) {
    summary.push(`${tireCount} tire quote${tireCount === 1 ? "" : "s"}`);
  }

  return (
    <div className="absolute right-0 mt-2 w-[380px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg z-50">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
        <span className="text-sm font-semibold text-gray-900">
          Notifications
        </span>
        <button
          type="button"
          onClick={handleMarkAllRead}
          className="text-xs font-medium text-gray-500 hover:text-gray-900"
        >
          Mark all read
        </button>
      </div>

      {/* Summary strip */}
      {summary.length > 0 && (
        <div className="border-b border-gray-100 px-4 py-2 text-xs text-gray-500">
          {summary.join(" · ")}
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-gray-100 px-2 py-2">
        {(
          [
            { id: "all" as const, label: "All" },
            { id: "confirm" as const, label: "To confirm" },
            { id: "tire" as const, label: "Tire quotes" },
          ]
        ).map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                isActive
                  ? "bg-gray-100 text-gray-900"
                  : "text-gray-500 hover:text-gray-900"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Body */}
      <div className="max-h-[70vh] overflow-y-auto">
        {visibleItems.length === 0 ? (
          <NotificationEmptyState onClose={onClose} />
        ) : (
          <ul className="divide-y divide-gray-100">
            {visibleItems.map((item) => (
              <NotificationCard
                key={String(item.bookingId)}
                item={item}
                onSkip={handleSkip}
                onAfterAction={onClose}
              />
            ))}
          </ul>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-gray-100 bg-gray-50 px-4 py-2">
        <button
          type="button"
          onClick={goToBookings}
          className="text-xs font-medium text-gray-700 hover:text-gray-900"
        >
          View all bookings
        </button>
        <button
          type="button"
          onClick={goToSettings}
          className="text-xs font-medium text-gray-500 hover:text-gray-900"
        >
          Notification settings
        </button>
      </div>
    </div>
  );
}
