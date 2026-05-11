export type BookingStatus =
  | "pending_shop_acceptance"
  | "pending"
  | "pending_customer_acceptance"
  | "confirmed"
  | "vehicle_at_shop"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "no_show"
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
      bg: "rgb(219 234 255)",
      text: "rgb(82 153 254)",
      border: "rgb(147 197 254)",
    },
  },
  vehicle_at_shop: {
    label: "Vehicle Here",
    pillClass: "bg-cyan-50 text-cyan-700",
    calendarColors: {
      bg: "rgb(236 254 255)",
      text: "rgb(14 116 144)",
      border: "rgb(103 232 249)",
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
    pillClass:
      "bg-[color-mix(in_srgb,var(--success)_12%,transparent)] text-[var(--success)]",
    calendarColors: {
      bg: "rgb(220 252 231)",
      text: "rgb(22 163 74)",
      border: "rgb(134 239 172)",
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
  no_show: {
    label: "No-show",
    pillClass: "bg-orange-50 text-orange-700",
    calendarColors: {
      bg: "rgb(255 247 237)",
      text: "rgb(194 65 12)",
      border: "rgb(253 186 116)",
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
  "vehicle_at_shop",
  "in_progress",
  "completed",
  "no_show",
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
