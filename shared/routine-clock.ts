/** Calendar cadence, independent of elapsed hours and daylight saving. One of: an
 * anchored interval of calendar days; `monthly: 'first-weekday'` (the first
 * Monday–Friday of each month); or a repeat every `everyMinutes` (1–1440) from the
 * schedule's `time` up to `until` (exclusive; end of day when absent) on its weekdays. */
export interface CalendarCadence { intervalDays?: number; anchorDate?: string; monthly?: 'first-weekday'; everyMinutes?: number; until?: string }
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Give the schedule's `time` too, so a repeat window must end after it starts. */
export function validCalendarCadence(value: CalendarCadence & { time?: unknown }): boolean {
  if (value.everyMinutes !== undefined || value.until !== undefined) {
    return Number.isSafeInteger(value.everyMinutes) && value.everyMinutes! >= 1 && value.everyMinutes! <= 1440 &&
      value.intervalDays === undefined && value.anchorDate === undefined && value.monthly === undefined &&
      (value.until === undefined || (typeof value.until === 'string' && CLOCK.test(value.until) && (typeof value.time !== 'string' || value.until > value.time)));
  }
  if (value.monthly !== undefined) return value.monthly === 'first-weekday' && value.intervalDays === undefined && value.anchorDate === undefined;
  if (value.intervalDays === undefined && value.anchorDate === undefined) return true;
  if (!Number.isSafeInteger(value.intervalDays) || value.intervalDays! < 1 || value.intervalDays! > 31 ||
      typeof value.anchorDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.anchorDate)) return false;
  const at = Date.parse(`${value.anchorDate}T00:00:00Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value.anchorDate;
}
export function cadenceIncludesDay(schedule: CalendarCadence, year: number, month: number, day: number): boolean {
  if (!validCalendarCadence(schedule)) return false;
  if (schedule.monthly) {
    // The 1st when it is a weekday, else the Monday after a weekend 1st (the 2nd or 3rd).
    const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    return dow >= 1 && dow <= 5 && (day === 1 || (dow === 1 && day <= 3));
  }
  if (schedule.intervalDays === undefined) return true;
  const distance = (Date.UTC(year, month - 1, day) - Date.parse(`${schedule.anchorDate}T00:00:00Z`)) / 86_400_000;
  return distance >= 0 && distance % schedule.intervalDays === 0;
}
