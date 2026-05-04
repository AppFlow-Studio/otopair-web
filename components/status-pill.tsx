"use client";

import { cn } from "@/lib/utils";
import {
  getBookingStatusLabel,
  getBookingStatusPillClass,
} from "@/lib/booking-status";

interface StatusPillProps {
  status: string;
  className?: string;
}

export function StatusPill({ status, className }: StatusPillProps) {
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2.5 py-1 text-[11px] font-medium",
        getBookingStatusPillClass(status),
        className,
      )}
    >
      {getBookingStatusLabel(status)}
    </span>
  );
}
