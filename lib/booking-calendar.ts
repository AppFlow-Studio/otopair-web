export interface BookingCalendarInput {
  shopName: string;
  date: string;
  time: string;
  serviceNames?: string[] | null;
  location?: string | null;
  mechanicName?: string | null;
  bookingReference?: string | null;
  vehicleDisplay?: string | null;
  durationMinutes?: number | null;
}

export interface BookingCalendarEvent {
  title: string;
  startDate: Date;
  endDate: Date;
  location?: string;
  notes?: string;
}

function compact(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function firstName(value: string | null | undefined): string | null {
  return compact(value)?.split(/\s+/)[0] ?? null;
}

export function formatBookingReference(id: string | null | undefined): string | null {
  const value = compact(id);
  return value ? value.slice(-6).toUpperCase() : null;
}

function summarizeServices(serviceNames: string[] | null | undefined): string {
  const names = (serviceNames ?? [])
    .map((name) => compact(name))
    .filter((name): name is string => name !== null);

  if (names.length === 0) return "Service";
  if (names.length === 1) return names[0];
  return `${names[0]} + ${names.length - 1} more`;
}

function parseBookingDateTime(date: string, time: string): Date | null {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return null;

  const match = time.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!match) return null;

  let hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  const meridiem = (match[3] ?? "").toUpperCase();

  if (meridiem === "PM" && hour < 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

export function buildBookingCalendarEvent(input: BookingCalendarInput): BookingCalendarEvent | null {
  const startDate = parseBookingDateTime(input.date, input.time);
  if (!startDate) return null;

  const durationMinutes = input.durationMinutes && input.durationMinutes > 0
    ? input.durationMinutes
    : 60;
  const endDate = new Date(startDate.getTime() + durationMinutes * 60 * 1000);
  const shopName = compact(input.shopName) ?? "Shop";
  const serviceSummary = summarizeServices(input.serviceNames);
  const mechanicName = firstName(input.mechanicName);
  const vehicleDisplay = compact(input.vehicleDisplay);
  const bookingReference = compact(input.bookingReference);
  const notes = [
    `Service: ${serviceSummary}`,
    mechanicName ? `Appointment with ${mechanicName}` : null,
    vehicleDisplay ? `Vehicle: ${vehicleDisplay}` : null,
    bookingReference ? `Booking reference: ${bookingReference}` : null,
  ].filter((line): line is string => line !== null);

  return {
    title: `${serviceSummary} at ${shopName}`,
    startDate,
    endDate,
    location: compact(input.location) ?? undefined,
    notes: notes.join("\n"),
  };
}
