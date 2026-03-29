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
  pending_shop_acceptance:      { bg: "rgb(255 251 235)", text: "rgb(217 119 6)", border: "rgb(252 211 77)" },
  pending:                      { bg: "rgb(255 251 235)", text: "rgb(217 119 6)", border: "rgb(252 211 77)" },
  pending_customer_acceptance:  { bg: "rgb(243 232 255)", text: "rgb(147 51 234)", border: "rgb(192 132 252)" },
  confirmed:                    { bg: "rgb(224 231 255)", text: "rgb(99 102 241)", border: "rgb(165 180 252)" },
  in_progress:                  { bg: "rgb(236 253 245)", text: "rgb(5 150 105)", border: "rgb(110 231 183)" },
  completed:                    { bg: "rgb(243 244 246)", text: "rgb(107 114 128)", border: "rgb(209 213 219)" },
  blocked:                      { bg: "rgb(254 242 242)", text: "rgb(239 68 68)", border: "rgb(252 165 165)" },
};

export const statusLabel: Record<string, string> = {
  pending_shop_acceptance: "Pending Shop",
  pending: "Pending Shop",
  pending_customer_acceptance: "Pending Customer",
  confirmed: "Confirmed",
  in_progress: "In Progress",
  completed: "Completed",
};

export function dateToString(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}
