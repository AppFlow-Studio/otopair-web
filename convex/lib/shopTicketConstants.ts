// =============================================================================
// shopTicketConstants — shared vocabulary for the Message Shop feature.
//
// Kept in ONE place (convex/lib, so it syncs to the mobile mirror) so the app,
// the mobile client, and the otopair-web shop console agree on the category /
// status / action strings. Everything here is loose strings — the DB columns
// are v.string() — so this vocabulary can grow without a schema migration.
// =============================================================================

export type ShopTicketStatus =
  | "open" // awaiting shop
  | "shop_responded" // shop replied, awaiting customer / resolution
  | "resolved" // handled; can be re-opened by a new customer message
  | "closed"; // ended by the customer (or shop)

export const SHOP_TICKET_STATUSES: readonly ShopTicketStatus[] = [
  "open",
  "shop_responded",
  "resolved",
  "closed",
];

// Categories grouped by the booking phase where their quick-action button
// shows. `open_chat` is the always-available free-text fallback.
export const SHOP_TICKET_CATEGORIES = {
  confirmed: ["running_late", "reschedule_request", "cancel_or_pickup"],
  vehicle_at_shop: ["whats_status", "add_service"],
  in_progress: ["when_ready", "approve_extra_work", "question_about_work"],
  completed: ["pickup_arrangement", "invoice_question", "post_service_issue"],
  any: ["open_chat"],
} as const;

export const ALL_SHOP_TICKET_CATEGORIES: readonly string[] = Object.values(
  SHOP_TICKET_CATEGORIES,
).flat();

export function isValidTicketCategory(category: string): boolean {
  return ALL_SHOP_TICKET_CATEGORIES.includes(category);
}

// Human-readable subject seeded onto the ticket — used as the inbox label and
// the mobile ticket-list title. Display copy; safe to tweak.
export const SHOP_TICKET_SUBJECTS: Record<string, string> = {
  running_late: "Running late",
  reschedule_request: "Reschedule request",
  cancel_or_pickup: "Cancel / pick up",
  whats_status: "Status check",
  add_service: "Add a service",
  when_ready: "When will it be ready?",
  approve_extra_work: "Approve extra work",
  question_about_work: "Question about the work",
  pickup_arrangement: "Pickup arrangement",
  invoice_question: "Invoice question",
  post_service_issue: "Issue after service",
  open_chat: "Message shop",
};

export function ticketSubject(category: string): string {
  return SHOP_TICKET_SUBJECTS[category] ?? "Message shop";
}

// Default first-message body when a quick action is tapped with no extra text.
// Keeps the shop inbox unambiguous even when the customer types nothing.
// `open_chat` has no seed — it requires the customer to write something.
export const SHOP_TICKET_SEED_TEXT: Record<string, string> = {
  running_late: "I'm running a little late for my appointment.",
  reschedule_request: "I'd like to reschedule my appointment.",
  cancel_or_pickup: "I have a question about cancelling or picking up my car.",
  whats_status: "Has my car been looked at yet?",
  add_service: "While my car is there, could you also take a look at something?",
  when_ready: "When do you think my car will be ready?",
  approve_extra_work: "I have a question about the additional work.",
  question_about_work: "I have a question about the work being done.",
  pickup_arrangement: "I'd like to arrange picking up my car.",
  invoice_question: "I have a question about my invoice.",
  post_service_issue: "Something doesn't feel right after the service.",
  open_chat: "",
};

export function ticketSeedText(category: string): string {
  return SHOP_TICKET_SEED_TEXT[category] ?? "";
}

// Structured action kinds a shop reply can carry — the "trigger existing flow"
// rider on shop_ticket_messages.action. Each maps to an existing app rail
// (see convex/shop_tickets_web.ts replyToTicket).
export type ShopTicketActionKind =
  | "propose_reschedule" // → bookings.proposeReschedule
  | "request_approval" // → booking_approvals.submitMidJobChange / submitPreJobEstimate
  | "send_eta" // → thread-only in v1 (no booking field yet)
  | "pickup_response"; // → bookings.respondToPickupRequest

export const SHOP_TICKET_ACTION_KINDS: readonly ShopTicketActionKind[] = [
  "propose_reschedule",
  "request_approval",
  "send_eta",
  "pickup_response",
];

// notification_outbox.category strings for both directions of a ticket.
export const SHOP_TICKET_NOTIF = {
  newTicketToShop: "shop_ticket_new",
  customerReplyToShop: "shop_ticket_customer_reply",
  shopReplyToCustomer: "shop_ticket_shop_reply",
} as const;
