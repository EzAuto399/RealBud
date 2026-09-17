import { ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/cn";
import {
  buildScheduleMonth,
  DAY_NAMES,
  sameCalendarDay,
  sameCalendarMonth,
  shiftMonth,
  WEEKDAYS_MON_FIRST,
  type MonthDay,
  type WeekFacts,
  type WeekOutcome,
} from "@/lib/schedule-week";
import type { Loop } from "@/lib/routines";

function monthLabel(anchorMs: number): string {
  return new Date(anchorMs).toLocaleDateString("en-AU", { month: "long", year: "numeric" });
}

function dayTone(day: MonthDay, selected: boolean): string {
  if (selected) return "border-agency bg-selected text-agency";
  if (day.isToday) return "border-agency/40 bg-sheet text-agency";
  if (!day.inMonth) return "border-transparent text-ink-muted/50";
  return "border-transparent text-ink hover:bg-paper";
}

function outcomeDot(outcome: WeekOutcome): string {
  if (outcome === "missed") return "bg-danger";
  if (outcome === "review" || outcome === "partial") return "bg-hold";
  if (outcome === "next" || outcome === "running") return "bg-agency";
  if (outcome === "done") return "bg-ink-muted";
  return "bg-line";
}

export function MonthCalendar({
  loops,
  nowMs,
  timeZone,
  facts,
  anchorMs,
  selectedDayMs,
  onAnchorChange,
  onSelectDay,
}: {
  loops: Loop[];
  nowMs: number;
  timeZone?: string;
  facts?: WeekFacts;
  anchorMs: number;
  selectedDayMs: number;
  onAnchorChange: (ms: number) => void;
  onSelectDay: (dayMs: number) => void;
}) {
  const days = buildScheduleMonth(loops, nowMs, timeZone, facts, anchorMs);
  const viewingThisMonth = sameCalendarMonth(anchorMs, nowMs, timeZone);

  return (
    <section className="flex h-full min-w-0 flex-col rounded-lg border border-line bg-sheet" aria-label="Month calendar">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2.5">
        <h2 className="min-w-0 truncate text-[14px] font-medium text-ink">{monthLabel(anchorMs)}</h2>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            className="pm-control inline-flex h-8 w-8 items-center justify-center rounded-lg"
            aria-label="Previous month"
            onClick={() => onAnchorChange(shiftMonth(anchorMs, -1, timeZone))}
          >
            <ChevronLeft size={16} aria-hidden />
          </button>
          <button
            type="button"
            className="pm-control h-8 rounded-lg px-2 text-[12px] disabled:opacity-40"
            disabled={viewingThisMonth}
            onClick={() => onAnchorChange(nowMs)}
          >
            Today
          </button>
          <button
            type="button"
            className="pm-control inline-flex h-8 w-8 items-center justify-center rounded-lg"
            aria-label="Next month"
            onClick={() => onAnchorChange(shiftMonth(anchorMs, 1, timeZone))}
          >
            <ChevronRight size={16} aria-hidden />
          </button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-px px-2 pb-1 pt-2" role="row">
        {WEEKDAYS_MON_FIRST.map((weekday) => (
          <div key={weekday} className="pb-1 text-center text-[10px] font-medium uppercase tracking-wide text-ink-muted" role="columnheader">
            {DAY_NAMES[weekday]}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-0.5 px-2 pb-2" role="grid" aria-label={monthLabel(anchorMs)}>
        {days.map((day) => {
          const selected = sameCalendarDay(day.dateMs, selectedDayMs, timeZone);
          const labelDate = new Date(day.dateMs).toLocaleDateString("en-AU", {
            weekday: "long",
            day: "numeric",
            month: "long",
          });
          const jobCount = day.slots.length;
          return (
            <button
              key={day.dateMs}
              type="button"
              role="gridcell"
              aria-selected={selected}
              aria-current={day.isToday ? "date" : undefined}
              aria-label={
                jobCount
                  ? `${labelDate}, ${jobCount} scheduled job${jobCount === 1 ? "" : "s"}`
                  : `${labelDate}, quiet`
              }
              onClick={() => onSelectDay(day.dateMs)}
              className={cn(
                "flex min-h-11 flex-col items-center justify-start rounded-md border px-0.5 py-1 text-[12px] tabular-nums",
                dayTone(day, selected),
              )}
            >
              <span className={cn("leading-none", day.isToday && "font-semibold")}>
                {new Date(day.dateMs).getDate()}
              </span>
              {jobCount > 0 ? (
                <span className="mt-1 flex max-w-full flex-wrap justify-center gap-0.5" aria-hidden>
                  {day.slots.slice(0, 3).map((slot) => (
                    <span
                      key={`${day.dateMs}:${slot.loopId}`}
                      className={cn("h-1.5 w-1.5 rounded-full", outcomeDot(slot.outcome))}
                    />
                  ))}
                </span>
              ) : (
                <span className="mt-1 h-1.5" aria-hidden />
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}
