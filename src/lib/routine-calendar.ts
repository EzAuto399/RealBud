import type { Loop, LoopId } from "@/lib/routines";

export interface RoutineCalendarOccurrence {
  loopId: LoopId;
  name: string;
  at: number;
  enabled: boolean;
  timezonePaused: boolean;
}

export interface RoutineCalendarDay {
  key: string;
  at: number;
  day: number;
  inMonth: boolean;
  today: boolean;
  occurrences: RoutineCalendarOccurrence[];
}

export interface RoutineCalendarMonth {
  year: number;
  month: number;
  label: string;
  days: RoutineCalendarDay[];
}

function sameLocalDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

/** A stable Monday-first, six-week calendar preview of code-owned routines.
 * It is deliberately a projection: mutations still go through the typed
 * time/weekday PATCH boundary below the calendar. */
export function buildRoutineCalendarMonth(
  loops: readonly Loop[],
  year: number,
  month: number,
  now = Date.now(),
): RoutineCalendarMonth {
  const first = new Date(year, month, 1, 12, 0, 0, 0);
  const normalizedYear = first.getFullYear();
  const normalizedMonth = first.getMonth();
  const mondayOffset = (first.getDay() + 6) % 7;
  const gridStart = new Date(normalizedYear, normalizedMonth, 1 - mondayOffset, 12, 0, 0, 0);
  const today = new Date(now);
  const visibleLoops = loops.filter((loop) => loop.available);

  const days = Array.from({ length: 42 }, (_, index): RoutineCalendarDay => {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    const inMonth = date.getMonth() === normalizedMonth;
    const occurrences = inMonth
      ? visibleLoops
          .filter((loop) => loop.schedule.weekdays.includes(date.getDay()))
          .map((loop): RoutineCalendarOccurrence => {
            const [hour, minute] = loop.schedule.time.split(":").map(Number);
            const scheduled = new Date(date);
            scheduled.setHours(hour, minute, 0, 0);
            return {
              loopId: loop.id,
              name: loop.name,
              at: scheduled.getTime(),
              enabled: loop.enabled,
              timezonePaused: Boolean(loop.timezonePaused),
            };
          })
      : [];
    return {
      key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
      at: date.getTime(),
      day: date.getDate(),
      inMonth,
      today: sameLocalDay(date, today),
      occurrences,
    };
  });

  return {
    year: normalizedYear,
    month: normalizedMonth,
    label: first.toLocaleDateString("en-AU", { month: "long", year: "numeric" }),
    days,
  };
}

export function moveRoutineCalendarMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const moved = new Date(year, month + delta, 1, 12, 0, 0, 0);
  return { year: moved.getFullYear(), month: moved.getMonth() };
}
