export type BookingStatus =
  | "pending_shop_acceptance"
  | "pending"
  | "pending_customer_acceptance"
  | "confirmed"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "declined";

export interface BookingStatusVisuals {
  label: string;
  pillClass: string;
  calendarColors: {
    bg: string;
    text: string;
    border: string;
  };
}

export const BOOKING_STATUS_VISUALS: Record<BookingStatus, BookingStatusVisuals> = {
  pending_shop_acceptance: {
    label: "Pending Shop",
    pillClass: "bg-amber-50 text-amber-600",
    calendarColors: {
      bg: "rgb(255 251 235)",
      text: "rgb(217 119 6)",
      border: "rgb(252 211 77)",
    },
  },
  pending: {
    label: "Pending Shop",
    pillClass: "bg-amber-50 text-amber-600",
    calendarColors: {
      bg: "rgb(255 251 235)",
      text: "rgb(217 119 6)",
      border: "rgb(252 211 77)",
    },
  },
  pending_customer_acceptance: {
    label: "Pending Customer",
    pillClass: "bg-purple-50 text-purple-600",
    calendarColors: {
      bg: "rgb(243 232 255)",
      text: "rgb(147 51 234)",
      border: "rgb(192 132 252)",
    },
  },
  confirmed: {
    label: "Confirmed",
    pillClass: "bg-primary/15 text-primary",
    calendarColors: {
      bg: "rgb(224 231 255)",
      text: "rgb(99 102 241)",
      border: "rgb(165 180 252)",
    },
  },
  in_progress: {
    label: "In Progress",
    pillClass: "bg-emerald-50 text-emerald-600",
    calendarColors: {
      bg: "rgb(236 253 245)",
      text: "rgb(5 150 105)",
      border: "rgb(110 231 183)",
    },
  },
  completed: {
    label: "Completed",
    pillClass: "bg-muted text-muted-foreground",
    calendarColors: {
      bg: "rgb(243 244 246)",
      text: "rgb(107 114 128)",
      border: "rgb(209 213 219)",
    },
  },
  cancelled: {
    label: "Cancelled",
    pillClass: "bg-red-50 text-destructive",
    calendarColors: {
      bg: "rgb(254 242 242)",
      text: "rgb(239 68 68)",
      border: "rgb(252 165 165)",
    },
  },
  declined: {
    label: "Declined",
    pillClass: "bg-red-50 text-destructive",
    calendarColors: {
      bg: "rgb(254 242 242)",
      text: "rgb(239 68 68)",
      border: "rgb(252 165 165)",
    },
  },
};

export const BOOKING_STATUS_LEGEND_KEYS: BookingStatus[] = [
  "pending_shop_acceptance",
  "pending_customer_acceptance",
  "confirmed",
  "in_progress",
  "completed",
];

export function getBookingStatusLabel(status: string): string {
  return BOOKING_STATUS_VISUALS[status as BookingStatus]?.label ?? status;
}

export function getBookingStatusPillClass(status: string): string {
  return (
    BOOKING_STATUS_VISUALS[status as BookingStatus]?.pillClass ??
    "bg-muted text-muted-foreground"
  );
}
