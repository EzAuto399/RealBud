import { cn } from "@/lib/cn";
import { fmtTimeOfDay } from "@/lib/au";
import {
  buildScheduleWeek,
  DAY_NAMES,
  plannedLoopFootnote,
  sameCalendarDay,
  splitPlannedLoops,
  weekOutcomeTone,
  type WeekDay,
  type WeekFacts,
  type WeekOutcome,
  type WeekSlot,
} from "@/lib/schedule-week";
import type { Loop } from "@/lib/routines";
import { StatusLabel } from "../pm";

function slotTime(time: string): string {
  const [hour, minute] = time.split(":").map(Number);
  return fmtTimeOfDay(new Date(2000, 0, 1, hour, minute).getTime());
}

function weekRangeLabel(days: { dateMs: number }[]): string {
  if (!days[0] || !days[6]) return "This week";
  const start = new Date(days[0].dateMs).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
  const end = new Date(days[6].dateMs).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
  return `${start} – ${end}`;
}

function todayHint(days: WeekDay[]): string {
  const today = days.find((day) => day.isToday);
  const range = weekRangeLabel(days);
  if (!today) return range;
  const missed = today.slots.find((slot) => slot.outcome === "missed");
  if (missed) return `${range} · Recheck missed`;
  const onDesk = today.slots.find((slot) => slot.openDesk && slot.produced > 0);
  if (onDesk) return `${range} · ${onDesk.stamp}`;
  if (today.slots.length === 0) return `${range} · today is quiet`;
  const next = today.slots.find((slot) => slot.outcome === "next");
  if (next) return `${range} · next ${next.shortName.toLowerCase()} ${slotTime(next.time)}`;
  return range;
}

function slotSurface(outcome: WeekOutcome, selected: boolean): string {
  if (selected) return "border-agency bg-selected";
  if (outcome === "missed") return "border-danger/30 bg-sheet";
  return "border-line bg-sheet";
}

export function WeekCalendar({
  loops,
  nowMs,
  timeZone,
  facts,
  deskNote,
  selectedId,
  onSelect,
}: {
  loops: Loop[];
  nowMs: number;
  timeZone?: string;
  facts?: WeekFacts;
  deskNote?: string | null;
  selectedId: string | null;
  onSelect: (slot: WeekSlot) => void;
}) {
  const { scheduled, planned } = splitPlannedLoops(loops);
  const days = buildScheduleWeek(scheduled, nowMs, timeZone, facts);
  const missed = days.some((day) => day.slots.some((slot) => slot.outcome === "missed"));
  const lastRunOnWeek = Boolean(
    facts?.desk?.lastRunAt && days.some((day) => sameCalendarDay(day.dateMs, facts.desk!.lastRunAt!, timeZone)),
  );
  return (
    <section className="min-w-0 rounded-xl border border-line bg-sheet" aria-label="This week’s scheduled jobs">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-line px-4 py-3">
        <h2 className="text-[14px] font-medium text-ink">This week</h2>
        <p className="min-w-0 text-[12px] text-ink-muted">{todayHint(days)}</p>
      </div>
      {(missed || lastRunOnWeek) && deskNote ? (
        <p className={cn("border-b border-line px-4 py-2 text-[12.5px]", missed ? "text-hold" : "text-ink-muted")}>
          {deskNote}
        </p>
      ) : null}
      <ol className="divide-y divide-line">
        {days.map((day) => (
          <li
            key={day.weekday}
            className={cn("flex items-start gap-3 px-4 py-2.5", day.isToday && "bg-selected")}
          >
            <div className="w-14 shrink-0 pt-1.5">
              <div className={cn("text-[12px] font-medium", day.isToday ? "text-agency" : "text-ink-muted")}>
                {DAY_NAMES[day.weekday]}
              </div>
              <div className={cn("text-[12px] tabular-nums", day.isToday ? "text-agency" : "text-ink-muted")}>
                {new Date(day.dateMs).getDate()}
                {day.isToday ? " · today" : ""}
              </div>
            </div>
            <ul className="flex min-w-0 flex-1 flex-wrap gap-1.5">
              {day.slots.length === 0 ? (
                <li className="py-1.5 text-[12px] text-ink-muted">Quiet</li>
              ) : (
                day.slots.map((slot) => (
                  <li key={`${day.weekday}:${slot.loopId}`} className="min-w-0">
                    <SlotButton slot={slot} selected={selectedId === slot.loopId} onSelect={onSelect} />
                  </li>
                ))
              )}
            </ul>
          </li>
        ))}
      </ol>
      {planned.length > 0 ? (
        <details className="border-t border-line px-4 py-2.5"><summary className="cursor-pointer text-[12px] text-ink-muted">Planned features · not running</summary>
        <ul className="mt-2 space-y-1.5">
          {planned.map((loop) => (
            <li key={loop.id} className="text-[12px] leading-relaxed text-ink-muted">
              {plannedLoopFootnote(loop)}
            </li>
          ))}
        </ul></details>
      ) : null}
    </section>
  );
}

function SlotButton({
  slot,
  selected,
  onSelect,
}: {
  slot: WeekSlot;
  selected: boolean;
  onSelect: (slot: WeekSlot) => void;
}) {
  const tone = weekOutcomeTone(slot.outcome);
  return (
    <button
      type="button"
      onClick={() => onSelect(slot)}
      aria-pressed={selected}
      aria-label={`${slot.name} at ${slotTime(slot.time)}${slot.stamp ? `, ${slot.stamp}` : ""}`}
      title={slot.name}
      className={cn("min-h-10 rounded border px-2.5 py-1.5 text-left", slotSurface(slot.outcome, selected))}
    >
      <span className="text-[12px] font-medium text-ink">{slot.shortName}</span>
      <span className="ml-1.5 tabular-nums text-[12px] text-ink-muted">{slotTime(slot.time)}</span>
      {slot.stamp && tone ? (
        <span className="ml-1.5 inline-block align-middle">
          <StatusLabel tone={tone}>{slot.stamp}</StatusLabel>
        </span>
      ) : null}
    </button>
  );
}
