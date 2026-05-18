"use client";

import { useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { useQuery, useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "@/convex/_generated/api";

const CATEGORY_LABELS: Record<string, string> = {
  new_booking: "New Booking",
  new_quote_request: "New Quote Request",
  new_job_assigned: "New Job Assigned",
  booking_never_started: "Never Started",
};

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const unreadCount = useQuery(api.notifications.getShopStaffUnreadCount);
  const notifications = useQuery(
    api.notifications.getShopStaffNotifications,
  );
  const markRead = useMutation(api.notifications.markShopStaffNotificationRead);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const count = unreadCount ?? 0;

  async function handleNotificationClick(notification: {
    _id: any;
    category: string;
    booking_id: any;
  }) {
    try {
      await markRead({ notificationId: notification._id });
    } catch {
      // best-effort
    }
    setOpen(false);
    if (notification.category === "new_quote_request") {
      router.push("/bookings/tire-quote-requests");
    } else if (notification.booking_id) {
      router.push(`/bookings?booking=${notification.booking_id}`);
    } else {
      router.push("/bookings");
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative flex items-center justify-center w-8 h-8 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors"
        aria-label="Notifications"
      >
        <Bell className="w-5 h-5" />
        {count > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-semibold leading-none">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 bg-white rounded-xl shadow-lg border border-gray-200 z-50 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100">
            <span className="text-sm font-semibold text-gray-900">
              Notifications
            </span>
          </div>

          {!notifications || notifications.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-gray-400">
              No new notifications
            </div>
          ) : (
            <ul className="max-h-80 overflow-y-auto divide-y divide-gray-50">
              {notifications.map((n) => (
                <li key={String(n._id)}>
                  <button
                    onClick={() => handleNotificationClick(n)}
                    className="w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-xs font-medium text-blue-600">
                        {CATEGORY_LABELS[n.category] ?? n.category}
                      </span>
                      <span className="text-xs text-gray-400 shrink-0">
                        {relativeTime(n.created_at)}
                      </span>
                    </div>
                    {n.shortHandle && (
                      <p className="mt-0.5 text-sm font-medium text-gray-900">
                        {n.shortHandle}
                        {n.customerName ? ` · ${n.customerName}` : ""}
                      </p>
                    )}
                    {n.category === "booking_never_started" && n.scheduledTime && (
                      <p className="text-xs text-orange-600 mt-0.5 font-medium">
                        Scheduled {n.scheduledTime} · never started — please cancel
                      </p>
                    )}
                    {n.vehicleLabel && (
                      <p className="text-xs text-gray-500 mt-0.5">
                        {n.vehicleLabel}
                      </p>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
