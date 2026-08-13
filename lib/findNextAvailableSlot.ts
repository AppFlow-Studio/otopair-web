import {
  addMinutesToHHMM,
  overlapsMechanicBooking,
  type ScheduleBlockedSlot,
  type ScheduleBooking,
} from "./schedule-overlap";

export interface NextSlotShopHour {
  dayOfWeek: number;
  openTime: string;
  closeTime: string;
  isClosed: boolean;
}

export interface NextSlotMechanic {
  _id: string;
}

export interface NextAvailableSlot {
  date: string;
  time: string;
  mechanicId: string;
  durationMinutes: number;
}

const STEP_MINUTES = 15;
const DAYS_LOOKAHEAD = 14;

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function dateToISO(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function ceilToStep(minutes: number): number {
  const r = minutes % STEP_MINUTES;
  return r === 0 ? minutes : minutes + (STEP_MINUTES - r);
}

export function findNextAvailableSlot(input: {
  now: Date;
  shopHours: NextSlotShopHour[];
  mechanics: NextSlotMechanic[];
  bookings: ScheduleBooking[];
  blockedSlots?: ScheduleBlockedSlot[];
  durationMinutes?: number;
}): NextAvailableSlot | null {
  const duration = input.durationMinutes ?? 60;
  if (input.mechanics.length === 0) return null;

  const today = new Date(
    input.now.getFullYear(),
    input.now.getMonth(),
    input.now.getDate()
  );
  const nowMinutes = input.now.getHours() * 60 + input.now.getMinutes();

  for (let dayOffset = 0; dayOffset < DAYS_LOOKAHEAD; dayOffset++) {
    const day = new Date(today);
    day.setDate(today.getDate() + dayOffset);
    const dateStr = dateToISO(day);
    const hours = input.shopHours.find((h) => h.dayOfWeek === day.getDay());
    if (!hours || hours.isClosed) continue;

    const openMin = toMinutes(hours.openTime);
    const closeMin = toMinutes(hours.closeTime);
    const latestStart = closeMin - duration;
    if (latestStart < openMin) continue;

    let startCursor = openMin;
    if (dayOffset === 0) {
      startCursor = Math.max(startCursor, ceilToStep(nowMinutes));
    }

    for (let mins = startCursor; mins <= latestStart; mins += STEP_MINUTES) {
      const startTime = `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
      const endTime = addMinutesToHHMM(startTime, duration);

      for (const mech of input.mechanics) {
        const blockedConflict = (input.blockedSlots ?? []).some((slot) => {
          if (slot.date !== dateStr) return false;
          if (slot.mechanicId !== null && slot.mechanicId !== mech._id) return false;
          return toMinutes(slot.startTime) < toMinutes(endTime) && toMinutes(slot.endTime) > mins;
        });

        if (blockedConflict) continue;

        if (
          !overlapsMechanicBooking(
            mech._id,
            dateStr,
            startTime,
            endTime,
            input.bookings
          )
        ) {
          return {
            date: dateStr,
            time: startTime,
            mechanicId: mech._id,
            durationMinutes: duration,
          };
        }
      }
    }
  }

  return null;
}
