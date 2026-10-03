/** Calendar cadence, independent of elapsed hours and daylight saving. */
export interface CalendarCadence { intervalDays?: number; anchorDate?: string }
export function validCalendarCadence(value: CalendarCadence): boolean {
  if (value.intervalDays === undefined && value.anchorDate === undefined) return true;
  if (!Number.isSafeInteger(value.intervalDays) || value.intervalDays! < 1 || value.intervalDays! > 31 ||
      typeof value.anchorDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.anchorDate)) return false;
  const at = Date.parse(`${value.anchorDate}T00:00:00Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value.anchorDate;
}
export function cadenceIncludesDay(schedule: CalendarCadence, year: number, month: number, day: number): boolean {
  if (!validCalendarCadence(schedule)) return false;
  if (schedule.intervalDays === undefined) return true;
  const distance = (Date.UTC(year, month - 1, day) - Date.parse(`${schedule.anchorDate}T00:00:00Z`)) / 86_400_000;
  return distance >= 0 && distance % schedule.intervalDays === 0;
}
