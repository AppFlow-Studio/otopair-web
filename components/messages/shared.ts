/**
 * Shared vocabulary + tiny helpers for the shop-side Message Shop UI.
 *
 * The reactive queries (convex/shop_tickets_web.ts) return the raw ticket /
 * message docs; everything presentational lives here so the in-booking drawer
 * and the standalone /messages inbox render identically. Display copy only —
 * the canonical strings (categories, subjects, statuses) come from
 * convex/lib/shopTicketConstants.ts.
 */

import type { Doc } from "@/convex/_generated/dataModel";

/** Compact booking context attached to inbox list rows by the shop queries. */
export type TicketRowContext = {
  customerName: string | null;
  vehicleLabel: string | null;
  serviceLabel: string | null;
};

export type Ticket = Doc<"shop_tickets"> & {
  context?: TicketRowContext | null;
};
export type TicketMessage = Doc<"shop_ticket_messages">;
export type TicketAction = NonNullable<TicketMessage["action"]>;

/** "just now" / "5m ago" / "2h ago" / "3d ago" — matches the notifications page. */
export function relativeTime(ts: number | null | undefined): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** A shop reply comes from our own side (right-aligned, primary). */
export function senderIsShop(role: string): boolean {
  return role === "shop" || role === "mechanic";
}

/* ---- Ticket status → label + chip class ---------------------------------- */

export type StatusMeta = { label: string; chip: string };

export function ticketStatusMeta(status: string): StatusMeta {
  switch (status) {
    case "open":
      return {
        label: "Needs reply",
        chip: "border-amber-200 bg-amber-50 text-amber-700",
      };
    case "shop_responded":
      return {
        label: "Replied",
        chip: "border-primary/20 bg-primary/10 text-primary",
      };
    case "resolved":
      return {
        label: "Resolved",
        chip: "border-success/20 bg-success/10 text-success",
      };
    case "closed":
      return {
        label: "Closed",
        chip: "border-border bg-muted text-muted-foreground",
      };
    default:
      return {
        label: status,
        chip: "border-border bg-muted text-muted-foreground",
      };
  }
}

/** Inbox filter chips for the standalone page. `undefined` value = All. */
export const STATUS_FILTERS: Array<{ id: string; label: string; value?: string }> =
  [
    { id: "all", label: "All", value: undefined },
    { id: "open", label: "Needs reply", value: "open" },
    { id: "shop_responded", label: "Replied", value: "shop_responded" },
    { id: "resolved", label: "Resolved", value: "resolved" },
  ];

/* ---- Structured action rider summary (mirrors the mobile actionSummary) --- */

export function actionSummary(action: TicketAction): string {
  const status = action.status ? ` · ${action.status}` : "";
  switch (action.kind) {
    case "propose_reschedule": {
      const p = (action.params ?? {}) as {
        newScheduledDate?: string;
        newScheduledTime?: string;
      };
      const when = [p.newScheduledDate, p.newScheduledTime]
        .filter(Boolean)
        .join(" ");
      return `🗓 New time proposed${when ? `: ${when}` : ""}${status}`;
    }
    case "request_approval":
      return `🧾 Approval requested${status}`;
    case "pickup_response": {
      const r = (action.params as { response?: string })?.response;
      return `🚗 Pickup: ${pickupResponseLabel(r) ?? "answered"}`;
    }
    case "send_eta":
      return `⏱ ${(action.params as { etaLabel?: string })?.etaLabel ?? "Ready-by time shared"}`;
    default:
      return `Update${status}`;
  }
}

/* ---- Composer quick-action vocabulary ------------------------------------ */

/** Phase/category-aware canned replies. Display copy — prefills the box. */
const CANNED_BY_CATEGORY: Record<string, string[]> = {
  running_late: [
    "No problem — we'll hold your slot. See you soon.",
    "Thanks for the heads up. Drive safe!",
  ],
  reschedule_request: [
    "Happy to reschedule — what day works best for you?",
    "Sure thing. I'll send over a new time shortly.",
  ],
  cancel_or_pickup: [
    "Of course — let us know what works and we'll take care of it.",
  ],
  whats_status: [
    "Your car is in the queue — I'll update you shortly.",
    "We're taking a look now and I'll report back soon.",
  ],
  add_service: [
    "We can take a look while it's here — I'll send an estimate before any work.",
  ],
  when_ready: [
    "We're targeting later today — I'll confirm a time shortly.",
    "Almost there. I'll send an ETA in a bit.",
  ],
  approve_extra_work: [
    "Happy to walk you through the added work — what questions do you have?",
  ],
  question_about_work: ["Great question — here's what we found:"],
  pickup_arrangement: [
    "Your car is ready whenever you are.",
    "Sounds good — we'll have it ready for pickup.",
  ],
  invoice_question: [
    "Happy to explain any line on your invoice — which item can I clarify?",
  ],
  post_service_issue: [
    "Sorry to hear that — let's make it right. Can you tell me a bit more?",
  ],
  open_chat: ["Thanks for reaching out — how can we help?"],
};

const CANNED_FALLBACK = [
  "Thanks for reaching out — how can we help?",
  "We'll get back to you shortly.",
  "Got it — thank you!",
];

export function templatesForCategory(category: string): string[] {
  return CANNED_BY_CATEGORY[category] ?? CANNED_FALLBACK;
}

/** Thread-only ETA presets (send_eta has no booking field in v1). */
export const ETA_PRESETS: string[] = [
  "in ~30 minutes",
  "in ~1 hour",
  "in ~2 hours",
  "by end of day",
  "tomorrow",
];

/** Pickup responses — the exact enum bookings.respondToPickupRequest accepts. */
export const PICKUP_RESPONSES: Array<{
  value: "acknowledged" | "bringing_out" | "declined";
  label: string;
  tone: "muted" | "success" | "danger";
}> = [
  { value: "acknowledged", label: "Acknowledge", tone: "muted" },
  { value: "bringing_out", label: "Bringing it out", tone: "success" },
  { value: "declined", label: "Can't release yet", tone: "danger" },
];

export function pickupResponseLabel(value: string | undefined): string | null {
  return PICKUP_RESPONSES.find((r) => r.value === value)?.label ?? null;
}
