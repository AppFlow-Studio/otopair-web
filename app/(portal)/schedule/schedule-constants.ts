import {
  BOOKING_STATUS_VISUALS,
  type BookingStatus,
} from "@/lib/booking-status";

/* ------------------------------------------------------------------ */
/*  Shared types, constants, and helpers for the Schedule feature        */
/* ------------------------------------------------------------------ */

export interface CalendarEvent {
  id: string;
  slotId?: string;
  title: string;
  start: Date;
  end: Date;
  resourceId?: string;
  type: "booking" | "blocked";
  status?: string;
  customerName?: string;
  mechanicName?: string | null;
  serviceNames?: string[];
  totalCost?: number;
  blockTitle?: string | null;
  note?: string | null;
}

export const statusColors: Record<string, { bg: string; text: string; border: string }> = {
  ...Object.fromEntries(
    Object.entries(BOOKING_STATUS_VISUALS).map(([status, visuals]) => [
      status,
      visuals.calendarColors,
    ])
  ) as Record<BookingStatus, { bg: string; text: string; border: string }>,
  blocked: { bg: "rgb(254 242 242)", text: "rgb(239 68 68)", border: "rgb(252 165 165)" },
};

export function dateToString(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}
