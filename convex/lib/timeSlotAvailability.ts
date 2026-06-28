/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  addMinutesToHHMM,
  ceilToQuarterHour,
  floorToQuarterHour,
  getBookingEndTime,
  normalizeBufferMinutes,
  overlapsBlockedSlot,
  overlapsMechanicBooking,
  SLOT_GRID_MINUTES,
  type ScheduleBlockedSlot,
  type ScheduleBooking,
} from "./schedule_overlap";

export const DEFAULT_AVAILABILITY_DAYS = 35;

const TERMINAL_BOOKING_STATUSES = new Set([
  "cancelled",
  "completed",
  "no_show",
  "declined",
]);

const QUOTE_HOLD_BOOKING_STATUSES = new Set(["pending_quote", "quotes_ready"]);

type AvailabilityContext = {
  shop: any;
  hours: any | null;
  activeMechanics: any[];
  bookings: any[];
  blockedSlots: any[];
  tireQuoteHolds: TireQuoteHold[];
  bufferMinutes: number;
};

type TireQuoteHold = {
  _id: string;
  mechanic_id: any;
  date: string;
  time: string;
  durationMinutes: number;
};

type SlotLike = {
  _id: string;
  shop_id: any;
  mechanic_id: any;
  date: string;
  start_time: string;
  end_time: string;
  is_available: true;
};

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function hhmmToMinutes(hhmm: string) {
  const [hours, minutes] = hhmm.split(":").map(Number);
  return hours * 60 + minutes;
}

function toScheduleBookings(bookings: any[]): ScheduleBooking[] {
  return bookings
    .filter((booking: any) => booking.scheduled_date && booking.scheduled_time)
    .map((booking: any) => ({
      _id: String(booking._id),
      scheduledDate: booking.scheduled_date,
      scheduledTime: booking.scheduled_time,
      estimatedMinutes: booking.estimated_labor_minutes ?? 60,
      status: booking.status,
      mechanicId: booking.mechanic_id ? String(booking.mechanic_id) : null,
    }));
}

function tireHoldsToScheduleBookings(holds: TireQuoteHold[]): ScheduleBooking[] {
  return holds.map((hold) => ({
    _id: String(hold._id),
    scheduledDate: hold.date,
    scheduledTime: hold.time,
    estimatedMinutes: hold.durationMinutes,
    status: "tentative_quote",
    mechanicId: hold.mechanic_id ? String(hold.mechanic_id) : null,
  }));
}

function toBlockedIntervals(rows: any[]): ScheduleBlockedSlot[] {
  return rows
    .filter((row) => !row.is_available && row.block_kind !== undefined)
    .map((row) => ({
      _id: String(row._id),
      date: row.date,
      startTime: row.start_time,
      endTime: row.end_time,
      mechanicId: row.mechanic_id ? String(row.mechanic_id) : null,
    }));
}

async function getShopHoursForDate(ctx: any, shopId: any, date: string) {
  const dayOfWeek = new Date(`${date}T00:00:00`).getDay();
  const rows = await ctx.db
    .query("shops_hours")
    .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shopId))
    .collect();
  return rows.find((row: any) => row.day_of_week === dayOfWeek) ?? null;
}

async function getBlockingBookingsForShopDate(
  ctx: any,
  shopId: any,
  date: string,
) {
  const rows = await ctx.db
    .query("bookings")
    .withIndex("by_shop_and_date", (q: any) =>
      q.eq("shop_id", shopId).eq("scheduled_date", date),
    )
    .collect();

  return rows.filter((booking: any) => !TERMINAL_BOOKING_STATUSES.has(booking.status));
}

export async function getManualBlockedSlotsForShopDate(
  ctx: any,
  shopId: any,
  date?: string,
) {
  const slots = date
    ? await ctx.db
        .query("time_slots")
        .withIndex("by_shop_and_date", (q: any) =>
          q.eq("shop_id", shopId).eq("date", date),
        )
        .collect()
    : await ctx.db
        .query("time_slots")
        .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shopId))
        .collect();

  return slots.filter(
    (slot: any) =>
      !slot.is_available &&
      slot.block_kind !== undefined &&
      (date ? slot.date === date : true),
  );
}

async function getLiveTireQuoteHoldsForShopDate(
  ctx: any,
  shopId: any,
  date: string,
  excludeTireQuoteResponseId?: string,
): Promise<TireQuoteHold[]> {
  const now = Date.now();
  const responses = await ctx.db
    .query("tire_quote_responses")
    .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shopId))
    .collect();

  const holds: TireQuoteHold[] = [];
  for (const response of responses) {
    if (excludeTireQuoteResponseId && String(response._id) === excludeTireQuoteResponseId) {
      continue;
    }
    if (response.superseded_at != null) continue;
    if (typeof response.expires_at === "number" && response.expires_at <= now) continue;
    if (!response.mechanic_id) continue;
    if (response.availability?.date !== date) continue;

    const booking = await ctx.db.get(response.booking_id);
    if (!booking || !QUOTE_HOLD_BOOKING_STATUSES.has(booking.status)) continue;

    holds.push({
      _id: String(response._id),
      mechanic_id: response.mechanic_id,
      date: response.availability.date,
      time: response.availability.time,
      durationMinutes: response.estimated_duration_minutes ?? 30,
    });
  }

  return holds;
}

async function getAvailabilityContext(
  ctx: any,
  {
    shopId,
    date,
    excludeTireQuoteResponseId,
  }: {
    shopId: any;
    date: string;
    excludeTireQuoteResponseId?: string;
  },
): Promise<AvailabilityContext> {
  const shop = await ctx.db.get(shopId);
  const [hours, activeMechanics, bookings, blockedSlots, tireQuoteHolds] =
    await Promise.all([
      getShopHoursForDate(ctx, shopId, date),
      getActiveMechanicsForShop(ctx, shopId),
      getBlockingBookingsForShopDate(ctx, shopId, date),
      getManualBlockedSlotsForShopDate(ctx, shopId, date),
      getLiveTireQuoteHoldsForShopDate(ctx, shopId, date, excludeTireQuoteResponseId),
    ]);

  return {
    shop,
    hours,
    activeMechanics,
    bookings,
    blockedSlots,
    tireQuoteHolds,
    bufferMinutes: normalizeBufferMinutes(shop?.buffer_minutes),
  };
}

function assertWindowInsideShopHours(
  context: AvailabilityContext,
  startTime: string,
  durationMinutes: number,
  allowAfterClose?: boolean,
  allowOutsideShopHours?: boolean,
) {
  if (allowOutsideShopHours) {
    return getBookingEndTime(startTime, durationMinutes);
  }

  const hours = context.hours;
  if (!hours || hours.is_closed || !hours.open_time || !hours.close_time) {
    throw new Error("The shop is closed on the requested day.");
  }

  const startMinutes = hhmmToMinutes(startTime);
  const endTime = getBookingEndTime(startTime, durationMinutes);
  const endMinutes = hhmmToMinutes(endTime);
  const openMinutes = hhmmToMinutes(hours.open_time);
  const closeMinutes = hhmmToMinutes(hours.close_time);

  if (startMinutes < openMinutes || startMinutes >= closeMinutes) {
    throw new Error("The requested start time is outside the shop's operating hours.");
  }
  if (endMinutes > closeMinutes && !allowAfterClose) {
    throw new Error("This booking would end after the shop closes.");
  }

  return endTime;
}

function getMechanicFromContext(context: AvailabilityContext, mechanicId: any) {
  return (
    context.activeMechanics.find(
      (mechanic: any) => String(mechanic._id) === String(mechanicId),
    ) ?? null
  );
}

function assertMechanicActiveInContext(
  context: AvailabilityContext,
  shopId: any,
  mechanicId: any,
) {
  const mechanic = getMechanicFromContext(context, mechanicId);
  if (!mechanic || String(mechanic.shop_id) !== String(shopId)) {
    throw new Error("Requested mechanic is unavailable.");
  }
  return mechanic;
}

function assertMechanicWindowFreeInContext(
  context: AvailabilityContext,
  {
    mechanicId,
    date,
    startTime,
    endTime,
    excludeBookingId,
  }: {
    mechanicId: any;
    date: string;
    startTime: string;
    endTime: string;
    excludeBookingId?: string;
  },
) {
  const bookingConflict = overlapsMechanicBooking(
    String(mechanicId),
    date,
    startTime,
    endTime,
    toScheduleBookings(context.bookings),
    excludeBookingId,
    context.bufferMinutes,
  );
  if (bookingConflict) {
    throw new Error("Cannot assign this mechanic because that time is already booked.");
  }

  const blockedConflict = overlapsBlockedSlot(
    String(mechanicId),
    date,
    startTime,
    endTime,
    toBlockedIntervals(context.blockedSlots),
  );
  if (blockedConflict) {
    throw new Error("Cannot assign this mechanic because that time is blocked.");
  }

  const quoteHoldConflict = overlapsMechanicBooking(
    String(mechanicId),
    date,
    startTime,
    endTime,
    tireHoldsToScheduleBookings(context.tireQuoteHolds),
    undefined,
    context.bufferMinutes,
  );
  if (quoteHoldConflict) {
    throw new Error("Cannot assign this mechanic because that time is held by a tire quote.");
  }
}

function mechanicWorkloadFromContext(
  context: AvailabilityContext,
  mechanicId: any,
  excludeBookingId?: string,
) {
  let count = 0;
  let minutes = 0;

  for (const booking of context.bookings) {
    if (!booking.mechanic_id || String(booking.mechanic_id) !== String(mechanicId)) {
      continue;
    }
    if (excludeBookingId && String(booking._id) === excludeBookingId) continue;
    count += 1;
    minutes += booking.estimated_labor_minutes ?? 60;
  }

  for (const hold of context.tireQuoteHolds) {
    if (!hold.mechanic_id || String(hold.mechanic_id) !== String(mechanicId)) {
      continue;
    }
    count += 1;
    minutes += hold.durationMinutes;
  }

  return { count, minutes };
}

export async function getActiveMechanicsForShop(ctx: any, shopId: any) {
  return await ctx.db
    .query("mechanics")
    .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shopId))
    .filter((q: any) => q.eq(q.field("is_active"), true))
    .collect();
}

export async function assertMechanicAvailableForWindow(
  ctx: any,
  {
    shopId,
    mechanicId,
    date,
    startTime,
    durationMinutes,
    excludeBookingId,
    excludeTireQuoteResponseId,
    allowAfterClose,
    allowOutsideShopHours,
  }: {
    shopId: any;
    mechanicId: any;
    date: string;
    startTime: string;
    durationMinutes: number;
    excludeBookingId?: string;
    excludeTireQuoteResponseId?: string;
    allowAfterClose?: boolean;
    allowOutsideShopHours?: boolean;
  },
) {
  const context = await getAvailabilityContext(ctx, {
    shopId,
    date,
    excludeTireQuoteResponseId,
  });
  assertMechanicActiveInContext(context, shopId, mechanicId);
  const endTime = assertWindowInsideShopHours(
    context,
    startTime,
    durationMinutes,
    allowAfterClose,
    allowOutsideShopHours,
  );
  assertMechanicWindowFreeInContext(context, {
    mechanicId,
    date,
    startTime,
    endTime,
    excludeBookingId,
  });
}

export async function isMechanicAvailableForWindow(
  ctx: any,
  args: {
    shopId: any;
    mechanicId: any;
    date: string;
    startTime: string;
    durationMinutes: number;
    excludeBookingId?: string;
    excludeTireQuoteResponseId?: string;
    allowAfterClose?: boolean;
    allowOutsideShopHours?: boolean;
  },
) {
  try {
    await assertMechanicAvailableForWindow(ctx, args);
    return true;
  } catch {
    return false;
  }
}

export async function resolveAvailableMechanicForWindow(
  ctx: any,
  {
    shopId,
    date,
    startTime,
    durationMinutes,
    preferredMechanicId,
    excludeBookingId,
    excludeTireQuoteResponseId,
    allowAfterClose,
    allowOutsideShopHours,
  }: {
    shopId: any;
    date: string;
    startTime: string;
    durationMinutes: number;
    preferredMechanicId?: any;
    excludeBookingId?: string;
    excludeTireQuoteResponseId?: string;
    allowAfterClose?: boolean;
    allowOutsideShopHours?: boolean;
  },
) {
  const context = await getAvailabilityContext(ctx, {
    shopId,
    date,
    excludeTireQuoteResponseId,
  });
  const endTime = assertWindowInsideShopHours(
    context,
    startTime,
    durationMinutes,
    allowAfterClose,
    allowOutsideShopHours,
  );

  if (preferredMechanicId) {
    assertMechanicActiveInContext(context, shopId, preferredMechanicId);
    assertMechanicWindowFreeInContext(context, {
      mechanicId: preferredMechanicId,
      date,
      startTime,
      endTime,
      excludeBookingId,
    });
    return preferredMechanicId;
  }

  const candidates: Array<{ mechanicId: any; count: number; minutes: number }> = [];
  for (const mechanic of context.activeMechanics) {
    try {
      assertMechanicWindowFreeInContext(context, {
        mechanicId: mechanic._id,
        date,
        startTime,
        endTime,
        excludeBookingId,
      });
    } catch {
      continue;
    }

    const workload = mechanicWorkloadFromContext(
      context,
      mechanic._id,
      excludeBookingId,
    );
    candidates.push({
      mechanicId: mechanic._id,
      count: workload.count,
      minutes: workload.minutes,
    });
  }

  if (!candidates[0]) {
    throw new Error("No mechanic is available for the requested time.");
  }

  const lowestCount = Math.min(...candidates.map((candidate) => candidate.count));
  const fewestBookings = candidates.filter((candidate) => candidate.count === lowestCount);
  const lowestMinutes = Math.min(...fewestBookings.map((candidate) => candidate.minutes));
  const tiedCandidates = fewestBookings.filter((candidate) => candidate.minutes === lowestMinutes);
  const randomIndex = Math.floor(Math.random() * tiedCandidates.length);

  return tiedCandidates[randomIndex].mechanicId;
}

export async function getMechanicDayWorkload(
  ctx: any,
  {
    shopId,
    mechanicId,
    date,
    excludeBookingId,
    excludeTireQuoteResponseId,
  }: {
    shopId: any;
    mechanicId: any;
    date: string;
    excludeBookingId?: string;
    excludeTireQuoteResponseId?: string;
  },
) {
  const context = await getAvailabilityContext(ctx, {
    shopId,
    date,
    excludeTireQuoteResponseId,
  });
  return mechanicWorkloadFromContext(context, mechanicId, excludeBookingId);
}

export async function listAvailableWindowsForShopDate(
  ctx: any,
  {
    shopId,
    date,
    mechanicId,
    cutoffTime,
    durationMinutes = SLOT_GRID_MINUTES,
    limit,
  }: {
    shopId: any;
    date: string;
    mechanicId?: any;
    cutoffTime?: string;
    durationMinutes?: number;
    limit?: number;
  },
): Promise<SlotLike[]> {
  const context = await getAvailabilityContext(ctx, { shopId, date });
  const hours = context.hours;
  if (!hours || hours.is_closed || !hours.open_time || !hours.close_time) return [];

  const mechanics = mechanicId
    ? context.activeMechanics.filter((mechanic: any) => String(mechanic._id) === String(mechanicId))
    : context.activeMechanics;
  if (mechanics.length === 0) return [];

  let cursor = ceilToQuarterHour(hours.open_time);
  const close = floorToQuarterHour(hours.close_time);
  const out: SlotLike[] = [];

  while (cursor < close) {
    if (cutoffTime && cursor < cutoffTime) {
      cursor = addMinutesToHHMM(cursor, SLOT_GRID_MINUTES);
      continue;
    }

    const endTime = addMinutesToHHMM(cursor, durationMinutes);
    if (hhmmToMinutes(endTime) > hhmmToMinutes(hours.close_time)) break;

    for (const mechanic of mechanics) {
      try {
        assertMechanicWindowFreeInContext(context, {
          mechanicId: mechanic._id,
          date,
          startTime: cursor,
          endTime,
        });
      } catch {
        continue;
      }

      out.push({
        _id: `computed:${String(shopId)}:${String(mechanic._id)}:${date}:${cursor}:${endTime}`,
        shop_id: shopId,
        mechanic_id: mechanic._id,
        date,
        start_time: cursor,
        end_time: endTime,
        is_available: true,
      });
      if (limit && out.length >= limit) return out;
    }

    cursor = addMinutesToHHMM(cursor, SLOT_GRID_MINUTES);
  }

  return out;
}

export async function listNextAvailableWindowsForShop(
  ctx: any,
  {
    shopId,
    startDate,
    days = DEFAULT_AVAILABILITY_DAYS,
    mechanicId,
    cutoffDate,
    cutoffTime,
    durationMinutes = SLOT_GRID_MINUTES,
    limit = 12,
    distinctTimes = false,
  }: {
    shopId: any;
    startDate?: string;
    days?: number;
    mechanicId?: any;
    cutoffDate?: string;
    cutoffTime?: string;
    durationMinutes?: number;
    limit?: number;
    distinctTimes?: boolean;
  },
) {
  const first = startDate ? new Date(`${startDate}T00:00:00`) : new Date();
  const seen = new Set<string>();
  const out: SlotLike[] = [];

  for (let offset = 0; offset < days && out.length < limit; offset += 1) {
    const date = toDateString(addDays(first, offset));
    if (cutoffDate && date < cutoffDate) continue;
    const dateCutoffTime = cutoffDate && date === cutoffDate ? cutoffTime : undefined;
    const slots = await listAvailableWindowsForShopDate(ctx, {
      shopId,
      date,
      mechanicId,
      cutoffTime: dateCutoffTime,
      durationMinutes,
    });

    for (const slot of slots) {
      if (distinctTimes) {
        const key = `${slot.date}:${slot.start_time}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      out.push(slot);
      if (out.length >= limit) break;
    }
  }

  return out;
}

async function deleteAvailableRowsForMechanicDay(
  ctx: any,
  shopId: any,
  mechanicId: any,
  date: string,
) {
  const slots = await ctx.db
    .query("time_slots")
    .withIndex("by_shop_and_date", (q: any) => q.eq("shop_id", shopId).eq("date", date))
    .collect();

  let deleted = 0;
  for (const slot of slots) {
    if (!slot.is_available) continue;
    if (String(slot.mechanic_id) !== String(mechanicId)) continue;
    await ctx.db.delete(slot._id);
    deleted += 1;
  }

  return deleted;
}

export async function syncMechanicDayAvailability(
  ctx: any,
  {
    shopId,
    mechanicId,
    date,
  }: {
    shopId: any;
    mechanicId: any;
    date: string;
  },
) {
  const deleted = await deleteAvailableRowsForMechanicDay(ctx, shopId, mechanicId, date);
  return { created: 0, deleted };
}

export async function syncShopDateAvailability(
  ctx: any,
  {
    shopId,
    date,
  }: {
    shopId: any;
    date: string;
  },
) {
  const slots = await ctx.db
    .query("time_slots")
    .withIndex("by_shop_and_date", (q: any) => q.eq("shop_id", shopId).eq("date", date))
    .collect();

  let deleted = 0;
  for (const slot of slots) {
    if (!slot.is_available) continue;
    await ctx.db.delete(slot._id);
    deleted += 1;
  }

  return { created: 0, deleted };
}

export async function syncMechanicAvailabilityWindow(
  ctx: any,
  {
    shopId,
    mechanicId,
    startDate,
    days = DEFAULT_AVAILABILITY_DAYS,
  }: {
    shopId: any;
    mechanicId: any;
    startDate?: string;
    days?: number;
  },
) {
  const first = startDate ? new Date(`${startDate}T00:00:00`) : new Date();
  let deleted = 0;

  for (let offset = 0; offset < days; offset += 1) {
    const date = toDateString(addDays(first, offset));
    deleted += await deleteAvailableRowsForMechanicDay(ctx, shopId, mechanicId, date);
  }

  return { created: 0, deleted };
}

export async function syncShopAvailabilityWindow(
  ctx: any,
  {
    shopId,
    startDate,
    days = DEFAULT_AVAILABILITY_DAYS,
  }: {
    shopId: any;
    startDate?: string;
    days?: number;
  },
) {
  const first = startDate ? new Date(`${startDate}T00:00:00`) : new Date();
  let deleted = 0;

  for (let offset = 0; offset < days; offset += 1) {
    const date = toDateString(addDays(first, offset));
    const result = await syncShopDateAvailability(ctx, { shopId, date });
    deleted += result.deleted;
  }

  return { created: 0, deleted };
}

export async function rebuildAllAvailability(
  ctx: any,
  _args: {
    startDate?: string;
    days?: number;
  } = {},
) {
  const availableRows = await ctx.db
    .query("time_slots")
    .withIndex("by_availability", (q: any) => q.eq("is_available", true))
    .collect();

  for (const row of availableRows) {
    await ctx.db.delete(row._id);
  }

  return { created: 0, deleted: availableRows.length };
}

export function getSyncDateRange(days = DEFAULT_AVAILABILITY_DAYS) {
  const today = new Date();
  return Array.from({ length: days }, (_, offset) => toDateString(addDays(today, offset)));
}

export function getBlockingEndTime(scheduledTime: string, estimatedMinutes?: number | null) {
  return getBookingEndTime(scheduledTime, estimatedMinutes);
}
