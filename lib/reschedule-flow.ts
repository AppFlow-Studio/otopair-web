export const BOOKING_RESCHEDULE_CONFIRMATION_TITLE = "You're all set!";
export const BOOKING_RESCHEDULE_CONFIRMATION_BODY =
  "We'll let you know as soon as the shop confirms your reschedule.";
export const BOOKING_RESCHEDULE_TOAST_TITLE = "Reschedule requested.";
export const BOOKING_RESCHEDULE_TOAST_BODY =
  "We'll let you know as soon as the shop confirms your reschedule.";

export function isBookingRescheduleMode(mode: string | string[] | undefined): boolean {
  return Array.isArray(mode) ? mode[0] === "reschedule" : mode === "reschedule";
}

export function getBookingConfirmingCopy(isReschedule: boolean) {
  return isReschedule
    ? {
        title: "Confirming your reschedule",
        subtitle: "Sending your new time request to the shop",
        sheetTitle: "Confirming your reschedule...",
        primaryCta: "Reschedule Booking",
        showPaymentSummary: false,
      }
    : {
        title: "Confirming your appointment",
        subtitle: "Locking in your time slot with the shop",
        sheetTitle: "Confirming your appointment...",
        primaryCta: undefined,
        showPaymentSummary: true,
      };
}

export function getBookingCompletionCopy(isReschedule: boolean, appointmentWithLabel: string) {
  return isReschedule
    ? {
        subtitle: BOOKING_RESCHEDULE_CONFIRMATION_BODY,
        toastTitle: BOOKING_RESCHEDULE_TOAST_TITLE,
        toastBody: BOOKING_RESCHEDULE_TOAST_BODY,
      }
    : {
        subtitle: `Your appointment with ${appointmentWithLabel} is confirmed.`,
        toastTitle: "Booking submitted.",
        toastBody: "We'll let you know as soon as your shop confirms.",
      };
}
