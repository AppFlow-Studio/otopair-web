export interface ScheduleBlockedSlot {
  _id: string;
  date: string;
  startTime: string;
  endTime: string;
  mechanicId: string | null;
}

export interface ScheduleBooking {
  _id: string;
  scheduledDate: string;
  scheduledTime: string;
  estimatedMinutes?: number | null;
  status: string;
  mechanicId: string | null;
}

export interface AssignmentBookingWindow {
  _id: string;
  scheduledDate: string;
  scheduledTime: string;
  estimatedMinutes?: number | null;
}

export function shouldConfirmMechanicChange(
  currentMechanicId: string | null | undefined,
  nextMechanicId: string | null | undefined
): boolean {
  return !!nextMechanicId && currentMechanicId !== nextMechanicId;
}

function toMinutes(hhmm: string): number {
  const [hours, minutes] = hhmm.split(":").map(Number);
  return hours * 60 + minutes;
}

export function addMinutesToHHMM(hhmm: string, deltaMinutes: number): string {
  const total = Math.max(0, Math.min(1439, toMinutes(hhmm) + deltaMinutes));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function getBookingEndTime(
  scheduledTime: string,
  estimatedMinutes?: number | null
): string {
  return addMinutesToHHMM(scheduledTime, estimatedMinutes ?? 60);
}

export function overlapsBlockedSlot(
  mechanicId: string,
  date: string,
  startTime: string,
  endTime: string,
  blockedSlots: ScheduleBlockedSlot[],
  excludeSlotId?: string
): boolean {
  const newStart = toMinutes(startTime);
  const newEnd = toMinutes(endTime);
  return blockedSlots.some((slot) => {
    if (excludeSlotId && slot._id === excludeSlotId) return false;
    if (slot.date !== date) return false;
    if (slot.mechanicId !== mechanicId) return false;
    return toMinutes(slot.startTime) < newEnd && toMinutes(slot.endTime) > newStart;
  });
}

export function overlapsMechanicBooking(
  mechanicId: string,
  date: string,
  startTime: string,
  endTime: string,
  bookings: ScheduleBooking[],
  excludeBookingId?: string
): boolean {
  const windowStart = toMinutes(startTime);
  const windowEnd = toMinutes(endTime);
  return bookings.some((booking) => {
    if (excludeBookingId && booking._id === excludeBookingId) return false;
    if (booking.scheduledDate !== date) return false;
    if (booking.status === "cancelled" || booking.status === "declined") return false;
    if (booking.mechanicId !== mechanicId) return false;
    const bookingStart = toMinutes(booking.scheduledTime);
    const bookingEnd = toMinutes(
      getBookingEndTime(booking.scheduledTime, booking.estimatedMinutes)
    );
    return bookingStart < windowEnd && bookingEnd > windowStart;
  });
}

export function getMechanicAssignmentConflict(
  booking: AssignmentBookingWindow,
  mechanicId: string,
  bookings: ScheduleBooking[],
  blockedSlots: ScheduleBlockedSlot[]
): "booking" | "blocked" | null {
  const endTime = getBookingEndTime(
    booking.scheduledTime,
    booking.estimatedMinutes
  );

  if (
    overlapsMechanicBooking(
      mechanicId,
      booking.scheduledDate,
      booking.scheduledTime,
      endTime,
      bookings,
      booking._id
    )
  ) {
    return "booking";
  }

  if (
    overlapsBlockedSlot(
      mechanicId,
      booking.scheduledDate,
      booking.scheduledTime,
      endTime,
      blockedSlots
    )
  ) {
    return "blocked";
  }

  return null;
}
