"use client";

import { useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { NotificationPopover } from "./notifications/notification-popover";
import { useLiveAlerts } from "./notifications/use-live-alerts";
import DynamicAlertIsland from "./dynamic-alert-island";

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [requestedTab, setRequestedTab] = useState<"all" | "live" | undefined>(
    undefined,
  );
  const containerRef = useRef<HTMLDivElement>(null);

  const feed = useQuery(api.mechanicNotifications.getFeed);
  const { alerts: liveAlerts } = useLiveAlerts();

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

  function handleIslandClick() {
    setRequestedTab("live");
    setOpen(true);
  }

  function handleBellClick() {
    setRequestedTab("all");
    setOpen((v) => !v);
  }

  function handleClose() {
    setOpen(false);
    setRequestedTab(undefined);
  }

  const unread = feed?.unreadCount ?? 0;
  const count = unread + liveAlerts.length;

  return (
    <div ref={containerRef} className="relative flex items-center gap-2">
      <DynamicAlertIsland alerts={liveAlerts} onClick={handleIslandClick} />
      <button
        onClick={handleBellClick}
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
        <NotificationPopover
          feed={feed}
          liveAlerts={liveAlerts}
          initialTab={requestedTab}
          onClose={handleClose}
        />
      )}
    </div>
  );
}
