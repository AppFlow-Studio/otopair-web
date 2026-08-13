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

export const EARLY_PUSH_THRESHOLD_MS = 10 * 60_000;

export function roundDownToFiveMinutes(hhmm: string): string {
  const total = toMinutes(hhmm);
  const rounded = Math.floor(total / 5) * 5;
  const hours = Math.floor(rounded / 60);
  const minutes = rounded % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function hhmmFromDate(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function getBookingEndTime(
  scheduledTime: string,
  estimatedMinutes?: number | null
): string {
  return addMinutesToHHMM(scheduledTime, estimatedMinutes ?? 60);
}

export const SLOT_GRID_MINUTES = 15;
export const DEFAULT_BUFFER_MINUTES = 10;
export const ALLOWED_BUFFERS = [10, 15, 20, 30] as const;
export type AllowedBuffer = (typeof ALLOWED_BUFFERS)[number];

function fromMinutes(total: number): string {
  const clamped = Math.max(0, Math.min(1440, total));
  const hours = Math.floor(clamped / 60);
  const minutes = clamped % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function ceilToQuarterHour(hhmm: string): string {
  const total = toMinutes(hhmm);
  return fromMinutes(Math.ceil(total / SLOT_GRID_MINUTES) * SLOT_GRID_MINUTES);
}

export function floorToQuarterHour(hhmm: string): string {
  const total = toMinutes(hhmm);
  return fromMinutes(Math.floor(total / SLOT_GRID_MINUTES) * SLOT_GRID_MINUTES);
}

export function nextBookableStartAfter(
  bookingEnd: string,
  bufferMinutes: number
): string {
  return ceilToQuarterHour(addMinutesToHHMM(bookingEnd, bufferMinutes));
}

export function normalizeBufferMinutes(value: number | null | undefined): number {
  if (value == null) return DEFAULT_BUFFER_MINUTES;
  const allowed = ALLOWED_BUFFERS as readonly number[];
  return allowed.includes(value) ? value : DEFAULT_BUFFER_MINUTES;
}

export function getBufferedWindowEndMinutes(
  endTime: string,
  bufferMinutes: number | null | undefined = 0
): number {
  return toMinutes(endTime) + (bufferMinutes ?? 0);
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
  excludeBookingId?: string,
  bufferMinutes: number = 0
): boolean {
  const windowStart = toMinutes(startTime);
  const windowEnd = getBufferedWindowEndMinutes(endTime, bufferMinutes);
  return bookings.some((booking) => {
    if (excludeBookingId && booking._id === excludeBookingId) return false;
    if (booking.scheduledDate !== date) return false;
    if (
      booking.status === "cancelled" ||
      booking.status === "declined" ||
      booking.status === "no_show"
    ) {
      return false;
    }
    if (booking.mechanicId !== mechanicId) return false;
    const bookingStart = toMinutes(booking.scheduledTime);
    const bookingEnd = getBufferedWindowEndMinutes(
      getBookingEndTime(booking.scheduledTime, booking.estimatedMinutes),
      bufferMinutes
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
