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

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function buildDesiredWindows(openTime: string, closeTime: string) {
  const start = ceilToQuarterHour(openTime);
  const end = floorToQuarterHour(closeTime);
  const windows: Array<{ start: string; end: string }> = [];

  let cursor = start;
  while (cursor < end) {
    const next = addMinutesToHHMM(cursor, SLOT_GRID_MINUTES);
    if (next > end) break;
    windows.push({ start: cursor, end: next });
    cursor = next;
  }

  return windows;
}

async function getShopHoursForDate(ctx: any, shopId: any, date: string) {
  const dayOfWeek = new Date(`${date}T00:00:00`).getDay();
  const rows = await ctx.db
    .query("shops_hours")
    .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shopId))
    .collect();
  return rows.find((row: any) => row.day_of_week === dayOfWeek) ?? null;
}

async function getMechanic(ctx: any, mechanicId: any) {
  return await ctx.db.get(mechanicId);
}

async function getSlotsForMechanicDay(ctx: any, shopId: any, mechanicId: any, date: string) {
  const rows = await ctx.db
    .query("time_slots")
    .withIndex("by_shop_and_date", (q: any) => q.eq("shop_id", shopId).eq("date", date))
    .collect();
  return rows.filter((row: any) => String(row.mechanic_id) === String(mechanicId));
}

function isBlockingBookingStatus(status: string) {
  return !TERMINAL_BOOKING_STATUSES.has(status);
}

async function getBookingsForMechanicDay(ctx: any, shopId: any, mechanicId: any, date: string) {
  const rows = await ctx.db
    .query("bookings")
    .withIndex("by_shop_and_date", (q: any) => q.eq("shop_id", shopId).eq("scheduled_date", date))
    .collect();

  return rows
    .filter(
      (row: any) =>
        row.mechanic_id &&
        String(row.mechanic_id) === String(mechanicId) &&
        isBlockingBookingStatus(row.status)
    )
    .map(
      (row: any) =>
        ({
          _id: String(row._id),
          scheduledDate: row.scheduled_date,
          scheduledTime: row.scheduled_time,
          estimatedMinutes: row.estimated_labor_minutes ?? 60,
          status: row.status,
          mechanicId: String(row.mechanic_id),
        }) satisfies ScheduleBooking
    );
}

function toBlockedIntervals(rows: any[]): ScheduleBlockedSlot[] {
  return rows
    .filter((row) => !row.is_available)
    .map((row) => ({
      _id: String(row._id),
      date: row.date,
      startTime: row.start_time,
      endTime: row.end_time,
      mechanicId: row.mechanic_id ? String(row.mechanic_id) : null,
    }));
}

export async function getActiveMechanicsForShop(ctx: any, shopId: any) {
  return await ctx.db
    .query("mechanics")
    .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shopId))
    .filter((q: any) => q.eq(q.field("is_active"), true))
    .collect();
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
  }
) {
  const mechanic = await getMechanic(ctx, mechanicId);
  const existingSlots = await getSlotsForMechanicDay(ctx, shopId, mechanicId, date);
  const existingAvailable = existingSlots.filter((row: any) => row.is_available);

  if (
    !mechanic ||
    !mechanic.is_active ||
    String(mechanic.shop_id) !== String(shopId)
  ) {
    for (const slot of existingAvailable) {
      await ctx.db.delete(slot._id);
    }
    return { created: 0, deleted: existingAvailable.length };
  }

  const hours = await getShopHoursForDate(ctx, shopId, date);
  if (!hours || hours.is_closed || !hours.open_time || !hours.close_time) {
    for (const slot of existingAvailable) {
      await ctx.db.delete(slot._id);
    }
    return { created: 0, deleted: existingAvailable.length };
  }

  const shop = await ctx.db.get(shopId);
  const bufferMinutes = normalizeBufferMinutes(shop?.buffer_minutes);

  const blockedSlots = toBlockedIntervals(existingSlots);
  const bookings = await getBookingsForMechanicDay(ctx, shopId, mechanicId, date);
  const desiredWindows = buildDesiredWindows(hours.open_time, hours.close_time).filter(
    ({ start, end }) => {
      const mechanicKey = String(mechanicId);
      if (overlapsBlockedSlot(mechanicKey, date, start, end, blockedSlots)) {
        return false;
      }
      if (
        overlapsMechanicBooking(
          mechanicKey,
          date,
          start,
          end,
          bookings,
          undefined,
          bufferMinutes
        )
      ) {
        return false;
      }
      return true;
    }
  );

  const desiredKeys = new Set(desiredWindows.map(({ start, end }) => `${start}-${end}`));
  const existingByKey = new Map(
    existingAvailable.map((row: any) => [`${row.start_time}-${row.end_time}`, row])
  );

  let created = 0;
  let deleted = 0;

  for (const row of existingAvailable) {
    const key = `${row.start_time}-${row.end_time}`;
    if (!desiredKeys.has(key)) {
      await ctx.db.delete(row._id);
      deleted += 1;
    }
  }

  for (const { start, end } of desiredWindows) {
    const key = `${start}-${end}`;
    if (existingByKey.has(key)) continue;
    await ctx.db.insert("time_slots", {
      shop_id: shopId,
      mechanic_id: mechanicId,
      date,
      start_time: start,
      end_time: end,
      is_available: true,
    });
    created += 1;
  }

  return { created, deleted };
}

export async function syncShopDateAvailability(
  ctx: any,
  {
    shopId,
    date,
  }: {
    shopId: any;
    date: string;
  }
) {
  const activeMechanics = await getActiveMechanicsForShop(ctx, shopId);
  const slots = await ctx.db
    .query("time_slots")
    .withIndex("by_shop_and_date", (q: any) => q.eq("shop_id", shopId).eq("date", date))
    .collect();

  const mechanicIds = new Set<string>();
  for (const mechanic of activeMechanics) {
    mechanicIds.add(String(mechanic._id));
  }
  for (const slot of slots) {
    if (slot.mechanic_id) {
      mechanicIds.add(String(slot.mechanic_id));
    }
  }

  let created = 0;
  let deleted = 0;
  for (const mechanicId of mechanicIds) {
    const result = await syncMechanicDayAvailability(ctx, {
      shopId,
      mechanicId,
      date,
    });
    created += result.created;
    deleted += result.deleted;
  }

  return { created, deleted };
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
  }
) {
  const first = startDate ? new Date(`${startDate}T00:00:00`) : new Date();
  let created = 0;
  let deleted = 0;

  for (let offset = 0; offset < days; offset += 1) {
    const date = toDateString(addDays(first, offset));
    const result = await syncMechanicDayAvailability(ctx, {
      shopId,
      mechanicId,
      date,
    });
    created += result.created;
    deleted += result.deleted;
  }

  return { created, deleted };
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
  }
) {
  const first = startDate ? new Date(`${startDate}T00:00:00`) : new Date();
  let created = 0;
  let deleted = 0;

  for (let offset = 0; offset < days; offset += 1) {
    const date = toDateString(addDays(first, offset));
    const result = await syncShopDateAvailability(ctx, {
      shopId,
      date,
    });
    created += result.created;
    deleted += result.deleted;
  }

  return { created, deleted };
}

export async function rebuildAllAvailability(
  ctx: any,
  {
    startDate,
    days = DEFAULT_AVAILABILITY_DAYS,
  }: {
    startDate?: string;
    days?: number;
  } = {}
) {
  const shops = await ctx.db.query("shops").collect();
  let created = 0;
  let deleted = 0;

  const availableRows = await ctx.db
    .query("time_slots")
    .withIndex("by_availability", (q: any) => q.eq("is_available", true))
    .collect();
  for (const row of availableRows) {
    await ctx.db.delete(row._id);
    deleted += 1;
  }

  for (const shop of shops) {
    const result = await syncShopAvailabilityWindow(ctx, {
      shopId: shop._id,
      startDate,
      days,
    });
    created += result.created;
    deleted += result.deleted;
  }

  return { created, deleted };
}

export function getSyncDateRange(days = DEFAULT_AVAILABILITY_DAYS) {
  const today = new Date();
  return Array.from({ length: days }, (_, offset) => toDateString(addDays(today, offset)));
}

export function getBlockingEndTime(scheduledTime: string, estimatedMinutes?: number | null) {
  return getBookingEndTime(scheduledTime, estimatedMinutes);
}
