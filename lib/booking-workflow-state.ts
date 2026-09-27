export type BookingWorkflowLifecycleEvent = {
  status: string;
  reason: string | null;
  actor: "customer" | "shop_member" | "unknown";
  actorName: string | null;
};

export type BookingWorkflowBooking = {
  status: string;
  latestLifecycleEvent?: BookingWorkflowLifecycleEvent | null;
};

export function classifyBookingLifecycleActor({
  bookingUserId,
  changedBy,
  changedByName,
}: {
  bookingUserId: string;
  changedBy?: string | null;
  changedByName?: string | null;
}): Pick<BookingWorkflowLifecycleEvent, "actor" | "actorName"> {
  if (changedBy && changedBy === bookingUserId) {
    return { actor: "customer", actorName: null };
  }
  if (changedBy && changedByName) {
    return { actor: "shop_member", actorName: changedByName };
  }
  return { actor: "unknown", actorName: null };
}

const RESCHEDULE_REASONS = new Set([
  "reschedule_proposed_by_shop",
  "customer_approved_reschedule",
  "forced_delay_proposed_by_shop",
  "forced_delay_proposed_by_system",
  "forced_delay_updated_by_shop",
  "forced_delay_updated_by_system",
]);

export function getBookingWorkflowUnavailableNotice(
  booking: BookingWorkflowBooking | null | undefined,
  allowedStatuses: readonly string[],
): string | null {
  if (booking === undefined) return null;
  if (booking === null) return "This booking is no longer available.";

  const event = booking.latestLifecycleEvent ?? null;
  if (event && RESCHEDULE_REASONS.has(event.reason ?? "")) {
    return "This booking is no longer available. It has been rescheduled.";
  }
  if (allowedStatuses.includes(booking.status)) return null;

  if (booking.status === "cancelled") {
    if (event?.actor === "customer") {
      return "This booking is no longer available. It was cancelled by the customer.";
    }
    if (event?.actor === "shop_member" && event.actorName) {
      return `This booking is no longer available. It was cancelled by ${event.actorName}.`;
    }
    return "This booking is no longer available.";
  }
  if (booking.status === "completed") {
    return "This booking is no longer available. It has already been completed.";
  }
  return "This booking is no longer available.";
}
