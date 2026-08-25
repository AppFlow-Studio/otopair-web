"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { NotificationCard, type NotificationItem } from "./notification-card";
import { NotificationEmptyState } from "./notification-empty-state";
import { LiveAlertCard } from "./live-alert-card";
import type { LiveAlert } from "./use-live-alerts";

type Tab = "all" | "live" | "confirm" | "tire" | "rotor";

interface FeedShape {
  unreadCount: number;
  counts: { confirm: number; tireQuote: number; rotorQuote: number };
  items: NotificationItem[];
}

interface NotificationPopoverProps {
  feed: FeedShape | null | undefined;
  liveAlerts: LiveAlert[];
  initialTab?: Tab;
  onClose: () => void;
}

export function NotificationPopover({
  feed,
  liveAlerts,
  initialTab,
  onClose,
}: NotificationPopoverProps) {
  const router = useRouter();
  const markAllRead = useMutation(api.mechanicNotifications.markAllRead);

  const [activeTab, setActiveTab] = useState<Tab>(initialTab ?? "all");
  const [skipped, setSkipped] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (initialTab) setActiveTab(initialTab);
  }, [initialTab]);

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
    if (activeTab === "rotor") {
      return filteredBySkip.filter((item) => item.kind === "rotor_quote");
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
  const rotorCount = items.filter(
    (item) =>
      item.kind === "rotor_quote" && !skipped.has(String(item.bookingId))
  ).length;
  const liveCount = liveAlerts.length;

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

  function goToQuoteRequests() {
    onClose();
    // Land on whichever tab actually has open work. Rotor wins if both are
    // populated to surface the heavier job; otherwise default to tire.
    const type = rotorCount > 0 ? "rotor" : "tire";
    router.push(`/bookings/quote-requests?type=${type}`);
  }

  function goToAllNotifications() {
    onClose();
    router.push("/notifications");
  }

  function goToSettings() {
    onClose();
    router.push("/notifications?tab=preferences");
  }

  const summary: string[] = [];
  if (liveCount > 0) {
    summary.push(`${liveCount} live`);
  }
  if (confirmCount > 0) {
    summary.push(`${confirmCount} to confirm`);
  }
  if (tireCount > 0) {
    summary.push(`${tireCount} tire quote${tireCount === 1 ? "" : "s"}`);
  }
  if (rotorCount > 0) {
    summary.push(`${rotorCount} rotor quote${rotorCount === 1 ? "" : "s"}`);
  }

  const showLivePinnedInAll = activeTab === "all" && liveAlerts.length > 0;

  return (
    <div className="fixed inset-x-2 top-16 z-50 flex max-h-[calc(100vh-5rem)] flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:block sm:max-h-none sm:w-[380px] sm:max-w-[calc(100vw-2rem)]">
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
      <div className="flex items-center gap-1 overflow-x-auto border-b border-gray-100 px-2 py-2">
        {(
          [
            { id: "all" as const, label: "All" },
            { id: "live" as const, label: "Live", count: liveCount },
            { id: "confirm" as const, label: "To confirm" },
            { id: "tire" as const, label: "Tire quotes" },
            { id: "rotor" as const, label: "Rotor quotes" },
          ]
        ).map((tab) => {
          const isActive = activeTab === tab.id;
          const count = "count" in tab ? tab.count : undefined;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                isActive
                  ? "bg-gray-100 text-gray-900"
                  : "text-gray-500 hover:text-gray-900"
              }`}
            >
              {tab.label}
              {count !== undefined && count > 0 && (
                <span className="rounded-full bg-red-500 px-1.5 text-[10px] font-semibold leading-4 text-white">
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto sm:max-h-[70vh] sm:flex-none">
        {activeTab === "live" ? (
          liveAlerts.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-gray-500">
              No live alerts right now.
            </div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {liveAlerts.map((alert) => (
                <LiveAlertCard
                  key={alert.id}
                  alert={alert}
                  onAfterAction={onClose}
                />
              ))}
            </ul>
          )
        ) : (
          <>
            {showLivePinnedInAll && (
              <div className="border-b border-gray-100 bg-amber-50/30">
                <div className="flex items-center justify-between px-4 py-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-700">
                    Live now
                  </span>
                  <button
                    type="button"
                    onClick={() => setActiveTab("live")}
                    className="text-[10px] font-medium text-amber-700 hover:text-amber-900"
                  >
                    View all ({liveCount})
                  </button>
                </div>
                <ul className="divide-y divide-gray-100">
                  {liveAlerts.slice(0, 2).map((alert) => (
                    <LiveAlertCard
                      key={alert.id}
                      alert={alert}
                      onAfterAction={onClose}
                    />
                  ))}
                </ul>
              </div>
            )}

            {visibleItems.length === 0 ? (
              showLivePinnedInAll ? null : (
                <NotificationEmptyState onClose={onClose} />
              )
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
          </>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-gray-100 bg-gray-50 px-4 py-2">
        <div className="flex items-center gap-3">
          {(tireCount > 0 || rotorCount > 0) && (
            <button
              type="button"
              onClick={goToQuoteRequests}
              className="text-xs font-medium text-gray-900 hover:text-gray-700"
            >
              Open quote requests ({tireCount + rotorCount})
            </button>
          )}
          <button
            type="button"
            onClick={goToAllNotifications}
            className="text-xs font-medium text-gray-700 hover:text-gray-900"
          >
            See all notifications
          </button>
        </div>
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
