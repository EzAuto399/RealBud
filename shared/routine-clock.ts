/** Calendar cadence, independent of elapsed hours and daylight saving. Either an
 * anchored interval of calendar days, or `monthly: 'first-weekday'` (the first
 * Monday–Friday of each month), never both. */
export interface CalendarCadence { intervalDays?: number; anchorDate?: string; monthly?: 'first-weekday' }
export function validCalendarCadence(value: CalendarCadence): boolean {
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
