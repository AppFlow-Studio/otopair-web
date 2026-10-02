// Maps 2-letter US state/territory codes to their primary IANA timezone.
// For states that span multiple zones, the most populous zone is used as the
// auto-detected default — the shop owner can override in Settings.
export const DEFAULT_SHOP_TIMEZONE = "America/New_York";

function timezoneParts(timezone: string, date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
}

function timezoneOffsetMs(timezone: string, date: Date) {
  const parts = timezoneParts(timezone, date);
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  ) - date.getTime();
}

/** The ISO business date at a shop, independent of the viewer's device clock. */
export function shopTodayISO(timezone = DEFAULT_SHOP_TIMEZONE, now = new Date()): string {
  const parts = timezoneParts(timezone, now);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** A local calendar Date representing the shop's current business day. */
export function shopTodayCalendarDate(
  timezone = DEFAULT_SHOP_TIMEZONE,
  now = new Date(),
): Date {
  const [year, month, day] = shopTodayISO(timezone, now).split("-").map(Number);
  return new Date(year, month - 1, day);
}

function shopLocalDateTime(date: string, time: string, timezone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute);
  const initialOffset = timezoneOffsetMs(timezone, new Date(utcGuess));
  const adjusted = utcGuess - initialOffset;
  return new Date(adjusted - timezoneOffsetMs(timezone, new Date(adjusted)) + initialOffset);
}

/** Start and end instants for the shop's current business day. */
export function shopTodayBounds(
  timezone = DEFAULT_SHOP_TIMEZONE,
  now = new Date(),
): { start: number; end: number } {
  const today = shopTodayISO(timezone, now);
  const [year, month, day] = today.split("-").map(Number);
  const tomorrow = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
  return {
    start: shopLocalDateTime(today, "00:00", timezone).getTime(),
    end: shopLocalDateTime(tomorrow, "00:00", timezone).getTime(),
  };
}

/** Short, DST-aware label such as "EDT" or "PST" for a shop-local appointment. */
export function shopTimezoneAbbreviation(
  date: string,
  time: string,
  timezone = DEFAULT_SHOP_TIMEZONE,
): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "short",
  }).formatToParts(shopLocalDateTime(date, time, timezone));
  return parts.find((part) => part.type === "timeZoneName")?.value ?? "";
}

/** Formats a stored shop-local HH:MM appointment time with its timezone label. */
export function formatShopTime(
  time: string,
  date: string | undefined,
  timezone = DEFAULT_SHOP_TIMEZONE,
): string {
  const [hours, minutes] = time.split(":").map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return time;
  const hour = hours % 12 || 12;
  const suffix = hours >= 12 ? "PM" : "AM";
  const abbreviation = shopTimezoneAbbreviation(date ?? shopTodayISO(timezone), time, timezone);
  return `${hour}:${String(minutes).padStart(2, "0")} ${suffix}${abbreviation ? ` ${abbreviation}` : ""}`;
}

/** Formats a shop-local range and appends its DST-aware timezone once. */
export function formatShopTimeRange(
  startTime: string,
  endTime: string,
  date: string | undefined,
  timezone = DEFAULT_SHOP_TIMEZONE,
): string {
  const start = formatShopTime(startTime, date, timezone).replace(/\s+\S+$/, "");
  return `${start} – ${formatShopTime(endTime, date, timezone)}`;
}

/** Short timezone label for a device-local clock, used before a shop is chosen. */
export function localTimezoneAbbreviation(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(date);
  return parts.find((part) => part.type === "timeZoneName")?.value ?? "";
}

export const US_STATE_TIMEZONE: Record<string, string> = {
  AL: "America/Chicago",
  AK: "America/Anchorage",
  AZ: "America/Phoenix",
  AR: "America/Chicago",
  CA: "America/Los_Angeles",
  CO: "America/Denver",
  CT: "America/New_York",
  DE: "America/New_York",
  FL: "America/New_York",
  GA: "America/New_York",
  HI: "Pacific/Honolulu",
  ID: "America/Denver",
  IL: "America/Chicago",
  IN: "America/Indiana/Indianapolis",
  IA: "America/Chicago",
  KS: "America/Chicago",
  KY: "America/New_York",
  LA: "America/Chicago",
  ME: "America/New_York",
  MD: "America/New_York",
  MA: "America/New_York",
  MI: "America/Detroit",
  MN: "America/Chicago",
  MS: "America/Chicago",
  MO: "America/Chicago",
  MT: "America/Denver",
  NE: "America/Chicago",
  NV: "America/Los_Angeles",
  NH: "America/New_York",
  NJ: "America/New_York",
  NM: "America/Denver",
  NY: "America/New_York",
  NC: "America/New_York",
  ND: "America/Chicago",
  OH: "America/New_York",
  OK: "America/Chicago",
  OR: "America/Los_Angeles",
  PA: "America/New_York",
  RI: "America/New_York",
  SC: "America/New_York",
  SD: "America/Chicago",
  TN: "America/Chicago",
  TX: "America/Chicago",
  UT: "America/Denver",
  VT: "America/New_York",
  VA: "America/New_York",
  WA: "America/Los_Angeles",
  WV: "America/New_York",
  WI: "America/Chicago",
  WY: "America/Denver",
  DC: "America/New_York",
  PR: "America/Puerto_Rico",
  VI: "America/St_Thomas",
  GU: "Pacific/Guam",
  AS: "Pacific/Pago_Pago",
  MP: "Pacific/Saipan",
};

export const US_TIMEZONES: Array<{ value: string; label: string }> = [
  { value: "America/New_York",            label: "Eastern (ET) — New York, Miami, Atlanta" },
  { value: "America/Chicago",             label: "Central (CT) — Chicago, Dallas, Houston" },
  { value: "America/Denver",              label: "Mountain (MT) — Denver, Salt Lake City" },
  { value: "America/Phoenix",             label: "Mountain no DST — Phoenix, Tucson" },
  { value: "America/Los_Angeles",         label: "Pacific (PT) — Los Angeles, Seattle" },
  { value: "America/Anchorage",           label: "Alaska (AKT) — Anchorage" },
  { value: "Pacific/Honolulu",            label: "Hawaii (HT) — Honolulu" },
  { value: "America/Puerto_Rico",         label: "Atlantic (AT) — Puerto Rico, Virgin Islands" },
  { value: "America/Indiana/Indianapolis", label: "Indiana (ET, no DST) — Indianapolis" },
  { value: "America/Detroit",             label: "Michigan (ET) — Detroit" },
];

/** Returns the IANA timezone for a 2-letter US state code, or null if unknown. */
export function detectTimezoneFromState(state: string | null | undefined): string | null {
  if (!state) return null;
  return US_STATE_TIMEZONE[state.trim().toUpperCase()] ?? null;
}
