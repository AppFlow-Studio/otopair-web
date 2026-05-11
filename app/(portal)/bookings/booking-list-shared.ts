export type JobStatusFilter =
  | "all"
  | "pending_shop_acceptance"
  | "pending_customer_acceptance"
  | "confirmed"
  | "vehicle_at_shop"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "no_show";

export const STATUS_TABS: { key: JobStatusFilter; label: string }[] = [
  { key: "all", label: "All" },
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
  return new Date().toISOString().slice(0, 10);
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

export function pendingCountdown(creationTime: number): string | null {
  if (!creationTime || Number.isNaN(creationTime)) return null;
  const deadline = creationTime + 24 * 60 * 60 * 1000;
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  const hours = Math.floor(remaining / (1000 * 60 * 60));
  const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 0) return `${hours}h ${minutes}m left`;
  return `${minutes}m left`;
}
