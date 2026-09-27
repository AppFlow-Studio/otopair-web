export function isFutureScheduleSlot(
  date: string,
  time: string,
  now: Date,
): boolean {
  const [year, month, day] = date.split("-").map(Number);
  const [hours, minutes] = time.split(":").map(Number);
  return new Date(year, month - 1, day, hours, minutes).getTime() > now.getTime();
}
