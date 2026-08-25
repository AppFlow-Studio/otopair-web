export type JobStatusFilter =
  | "all"
  | "walkin"
  | "pending_shop_acceptance"
  | "pending_customer_acceptance"
  | "confirmed"
  | "vehicle_at_shop"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "no_show";

// "Walk-in" is a source, not a status — it lives in the tab strip anyway
// because that's where the shop expects to slice its list by cohort.
export const STATUS_TABS: { key: JobStatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "walkin", label: "Walk-in" },
  { key: "pending_shop_acceptance", label: "Pending Shop" },
  { key: "pending_customer_acceptance", label: "Pending Customer" },
  { key: "confirmed", label: "Confirmed" },
  { key: "vehicle_at_shop", label: "Vehicle Here" },
  { key: "in_progress", label: "In Progress" },
  { key: "completed", label: "Completed" },
  { key: "cancelled", label: "Cancelled" },
  { key: "no_show", label: "No-show" },
];

export function todayString() {
  return new Date().toLocaleDateString("en-CA");
}

export function formatTime(time: string): string {
  if (!time) return "";
  const [hours, minutes] = time.split(":").map(Number);
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export function formatJobDate(
  scheduledDate: string,
  scheduledTime: string,
): string {
  const today = todayString();
  const timeLabel = formatTime(scheduledTime);
  if (scheduledDate === today) return `Today, ${timeLabel}`;
  const date = new Date(`${scheduledDate}T00:00:00`);
  const dateLabel = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  return `${dateLabel}, ${timeLabel}`;
}

// Shops have 20 minutes to accept/decline an incoming booking before it shows
// as overdue. Returns null once the deadline has passed so callers can render
// an "overdue" state of their own.
export const PENDING_SHOP_RESPONSE_MS = 20 * 60 * 1000;

export function pendingCountdown(creationTime: number): string | null {
  if (!creationTime || Number.isNaN(creationTime)) return null;
  const deadline = creationTime + PENDING_SHOP_RESPONSE_MS;
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  // Round up so the last partial minute still shows as "1m left" rather than
  // flashing "0m" before flipping to overdue. Seconds-precision would mislead
  // users since these labels only refresh when the parent re-renders.
  const minutesLeft = Math.max(1, Math.ceil(remaining / 60_000));
  return `${minutesLeft}m left`;
}
