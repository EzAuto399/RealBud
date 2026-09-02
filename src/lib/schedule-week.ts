import type { Loop, LoopId, LoopRun } from "@shared/contracts";

import { fmtTimeOfDay } from "./au";
import { isDemoWorkerMiss } from "./morning-brief";

/** Monday first — Australian office week. JS getDay() is Sunday = 0. */
export const WEEKDAYS_MON_FIRST = [1, 2, 3, 4, 5, 6, 0] as const;

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export type WeekOutcome = "planned" | "review" | "paused" | "scheduled" | "next" | "running" | "done" | "partial" | "missed";

export interface WeekSlot {
  loopId: Loop["id"];
  name: string;
  shortName: string;
  time: string;
  available: boolean;
  enabled: boolean;
  next: boolean;
  outcome: WeekOutcome;
  stamp: string | null;
  produced: number;
  runId: string | null;
  openDesk: boolean;
}

export type WeekRun = Pick<LoopRun, "id" | "loopId" | "scheduledFor" | "status" | "finishedAt">;

export interface WeekDeskFacts {
  lastRunAt: number | null;
  hands?: string;
  handsDetail?: string | null;
  needsYou: number;
  checkedCount: number;
  producedByRunId: Record<string, number>;
}

export interface WeekFacts {
  runs?: ReadonlyArray<WeekRun>;
  desk?: WeekDeskFacts;
  worker?: { lastTest?: { at: number; ok: boolean; kind: "ping" | "recheck" } | null };
}

export interface WeekDay {
  weekday: number;
  dateMs: number;
  isToday: boolean;
  slots: WeekSlot[];
}

export interface CalendarLoop {
  id: Loop["id"];
  name: string;
  available: boolean;
  enabled: boolean;
  schedule: Pick<Loop["schedule"], "weekdays" | "time">;
  nextRunAt?: number | null;
  waitingForPlan?: boolean;
}

export type WeekChipTone = "agency" | "hold" | "danger" | "muted";

/** Planned loops (not yet built) belong under the grid once, not on every day. */
export function splitPlannedLoops<T extends { available: boolean }>(
  loops: ReadonlyArray<T>,
): { scheduled: T[]; planned: T[] } {
  const scheduled: T[] = [];
  const planned: T[] = [];
  for (const loop of loops) {
    (loop.available ? scheduled : planned).push(loop);
  }
  return { scheduled, planned };
}

export function plannedLoopFootnote(loop: { name: string }): string {
  return `${loop.name} · Planned — set the clock now; RealBud runs it after it is built.`;
}

/** Card-face / disclosure clock, e.g. "Weekdays 7:30 am". */
export function scheduleSummary(schedule: { time: string; weekdays: number[] }): string {
  const [hour, minute] = schedule.time.split(":").map(Number);
  const time = fmtTimeOfDay(new Date(2000, 0, 1, hour || 0, minute || 0).getTime());
  const days = [...schedule.weekdays].sort((a, b) => a - b);
  const dayLabel =
    days.length === 7
      ? "Every day"
      : days.join(",") === "1,2,3,4,5"
        ? "Weekdays"
        : days.map((day) => DAY_NAMES[day]).join(", ");
  return `${dayLabel} ${time}`;
}

export function weekOutcomeTone(outcome: WeekOutcome): WeekChipTone | null {
  switch (outcome) {
    case "running":
    case "next":
      return "agency";
    case "partial":
    case "review":
      return "hold";
    case "missed":
      return "danger";
    case "planned":
    case "paused":
    case "done":
      return "muted";
    case "scheduled":
      return null;
  }
}

export function zonedYmd(
  nowMs: number,
  timeZone?: string,
): { year: number; month: number; day: number; weekday: number; hour: number; minute: number } {
  const date = new Date(nowMs);
  const local = {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    weekday: date.getDay(),
    hour: date.getHours(),
    minute: date.getMinutes(),
  };
  if (!timeZone) return local;
  try {
    const parts = new Intl.DateTimeFormat("en-AU", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
    const weekday = get("weekday");
    const dow =
      weekday === "Sun" ? 0 : weekday === "Mon" ? 1 : weekday === "Tue" ? 2 : weekday === "Wed" ? 3 : weekday === "Thu" ? 4 : weekday === "Fri" ? 5 : 6;
    return {
      year: Number(get("year")),
      month: Number(get("month")),
      day: Number(get("day")),
      weekday: dow,
      hour: Number(get("hour") === "24" ? "0" : get("hour")),
      minute: Number(get("minute")),
    };
  } catch {
    return local;
  }
}

export function calendarShortName(id: Loop["id"]): string {
  switch (id) {
    case "morning-arrears":
      return "Morning";
    case "owner-letter":
      return "Letter";
    case "inbound-triage":
      return "Inbound";
    default:
      return "Job";
  }
}

const DAY_FULL = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"] as const;

/** Teach-bar clock line: "Runs Fridays at 4:00 pm · Australia/Brisbane". */
export function recipeScheduleLine(schedule: { time: string; weekdays: number[] }, timeZone?: string): string {
  const [hour, minute] = schedule.time.split(":").map(Number);
  const time = fmtTimeOfDay(new Date(2000, 0, 1, hour || 0, minute || 0).getTime());
  const days = [...schedule.weekdays].sort((a, b) => a - b);
  const when =
    days.length === 7
      ? `Runs every day at ${time}`
      : days.join(",") === "1,2,3,4,5"
        ? `Runs weekdays at ${time}`
        : days.length === 1
          ? `Runs ${DAY_FULL[days[0]!] ?? DAY_NAMES[days[0]!]} at ${time}`
          : `Runs ${days.map((day) => DAY_NAMES[day]).join(", ")} at ${time}`;
  return timeZone ? `${when} · ${timeZone}` : when;
}

export function mondayOfWeek(nowMs: number, timeZone?: string): number {
  const today = zonedYmd(nowMs, timeZone);
  const offset = today.weekday === 0 ? -6 : 1 - today.weekday;
  return new Date(today.year, today.month - 1, today.day + offset).getTime();
}

export function sameCalendarDay(aMs: number, bMs: number, timeZone?: string): boolean {
  const a = zonedYmd(aMs, timeZone);
  const b = zonedYmd(bMs, timeZone);
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

export function producedByRunId(items: ReadonlyArray<{ origin?: { runId?: string } | null }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const id = item.origin?.runId;
    if (!id) continue;
    counts[id] = (counts[id] ?? 0) + 1;
  }
  return counts;
}

function latestRunOnDay(
  runs: ReadonlyArray<WeekRun> | undefined,
  loopId: LoopId,
  dateMs: number,
  timeZone?: string,
): WeekRun | undefined {
  return runs
    ?.filter((run) => run.loopId === loopId && sameCalendarDay(run.scheduledFor, dateMs, timeZone))
    .sort((a, b) => (b.finishedAt ?? b.scheduledFor) - (a.finishedAt ?? a.scheduledFor))[0];
}

function morningDeskMiss(desk?: WeekDeskFacts): boolean {
  return Boolean(desk && isDemoWorkerMiss(desk.hands, desk.handsDetail));
}

function workerRecheckMissOnDay(facts: WeekFacts | undefined, dateMs: number, timeZone?: string): boolean {
  const test = facts?.worker?.lastTest;
  return Boolean(test && test.kind === "recheck" && !test.ok && sameCalendarDay(test.at, dateMs, timeZone));
}

function stampSlot(
  loop: CalendarLoop,
  dateMs: number,
  next: boolean,
  facts: WeekFacts | undefined,
  timeZone?: string,
): Pick<WeekSlot, "outcome" | "stamp" | "produced" | "runId" | "openDesk"> {
  if (!loop.available) {
    return { outcome: "planned", stamp: "Planned", produced: 0, runId: null, openDesk: false };
  }
  if (loop.waitingForPlan) {
    return { outcome: "review", stamp: "Review plan", produced: 0, runId: null, openDesk: false };
  }
  if (!loop.enabled) {
    return { outcome: "paused", stamp: "Paused", produced: 0, runId: null, openDesk: false };
  }

  const run = latestRunOnDay(facts?.runs, loop.id, dateMs, timeZone);
  const produced = run ? (facts?.desk?.producedByRunId[run.id] ?? 0) : 0;
  const deskToday = loop.id === "morning-arrears" && Boolean(facts?.desk?.lastRunAt && sameCalendarDay(facts.desk.lastRunAt, dateMs, timeZone));
  const miss = (deskToday && morningDeskMiss(facts?.desk)) || workerRecheckMissOnDay(facts, dateMs, timeZone);

  if (run && (run.status === "queued" || run.status === "running")) {
    return { outcome: "running", stamp: "Running", produced, runId: run.id, openDesk: false };
  }
  if (run && (run.status === "failed" || run.status === "missed" || run.status === "interrupted" || miss)) {
    return { outcome: "missed", stamp: "Missed", produced, runId: run.id, openDesk: true };
  }
  if (run?.status === "partial") {
    const stamp = produced > 0 ? `${produced} on Desk` : "Partial";
    return { outcome: "partial", stamp, produced, runId: run.id, openDesk: true };
  }
  if (run?.status === "completed") {
    if (miss) return { outcome: "missed", stamp: "Missed", produced, runId: run.id, openDesk: true };
    const stamp = produced > 0 ? `${produced} on Desk` : deskToday && facts?.desk?.needsYou ? `${facts.desk.needsYou} on Desk` : "Finished";
    return { outcome: "done", stamp, produced: produced || facts?.desk?.needsYou || 0, runId: run.id, openDesk: produced > 0 || (facts?.desk?.needsYou ?? 0) > 0 };
  }
  if (deskToday) {
    if (miss) return { outcome: "missed", stamp: "Missed", produced: 0, runId: null, openDesk: true };
    const needsYou = facts?.desk?.needsYou ?? 0;
    const checked = facts?.desk?.checkedCount ?? 0;
    if (needsYou > 0) return { outcome: "done", stamp: `${needsYou} on Desk`, produced: needsYou, runId: null, openDesk: true };
    return { outcome: "done", stamp: checked ? `${checked} checked` : "Finished", produced: 0, runId: null, openDesk: false };
  }
  if (next) return { outcome: "next", stamp: "Next", produced: 0, runId: null, openDesk: false };
  return { outcome: "scheduled", stamp: null, produced: 0, runId: null, openDesk: false };
}

export function buildScheduleWeek(
  loops: ReadonlyArray<CalendarLoop>,
  nowMs: number,
  timeZone?: string,
  facts?: WeekFacts,
): WeekDay[] {
  const { scheduled } = splitPlannedLoops(loops);
  const today = zonedYmd(nowMs, timeZone);
  const todayIndex = today.weekday === 0 ? 6 : today.weekday - 1;
  const mondayDay = today.day + (today.weekday === 0 ? -6 : 1 - today.weekday);
  const days = WEEKDAYS_MON_FIRST.map((weekday, index) => {
    const dateMs = new Date(today.year, today.month - 1, mondayDay + index).getTime();
    const slots = scheduled
      .filter((loop) => loop.schedule.weekdays.includes(weekday))
      .map((loop) => {
        const next = Boolean(
          loop.available && loop.enabled && loop.nextRunAt && sameCalendarDay(loop.nextRunAt, dateMs, timeZone),
        );
        return {
          loopId: loop.id,
          name: loop.name,
          shortName: calendarShortName(loop.id),
          time: loop.schedule.time,
          available: loop.available,
          enabled: loop.enabled,
          next,
          ...stampSlot(loop, dateMs, next, facts, timeZone),
        };
      })
      .sort((a, b) => a.time.localeCompare(b.time));
    return { weekday, dateMs, isToday: index === todayIndex, slots };
  });
  return injectDeskRecheck(days, scheduled, facts, timeZone);
}

function padClock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** A Desk Recheck can land on a quiet day. Show that press on the map. */
function injectDeskRecheck(days: WeekDay[], loops: ReadonlyArray<CalendarLoop>, facts: WeekFacts | undefined, timeZone?: string): WeekDay[] {
  const at = facts?.desk?.lastRunAt;
  const morning = loops.find((loop) => loop.id === "morning-arrears");
  if (!at || !morning) return days;
  return days.map((day) => {
    if (!sameCalendarDay(day.dateMs, at, timeZone)) return day;
    if (day.slots.some((slot) => slot.loopId === "morning-arrears")) return day;
    const wall = zonedYmd(at, timeZone);
    const stamped = stampSlot(morning, day.dateMs, false, facts, timeZone);
    return {
      ...day,
      slots: [
        {
          loopId: morning.id,
          name: morning.name,
          shortName: "Recheck",
          time: padClock(wall.hour, wall.minute),
          available: true,
          enabled: true,
          next: false,
          ...stamped,
        },
        ...day.slots,
      ],
    };
  });
}
