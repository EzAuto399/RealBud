import { cn } from "@/lib/cn";
import { fmtTimeOfDay } from "@/lib/au";
import {
  buildScheduleWeek,
  DAY_NAMES,
  sameCalendarDay,
  type WeekDay,
  type WeekFacts,
  type WeekOutcome,
  type WeekSlot,
} from "@/lib/schedule-week";
import type { Loop } from "@/lib/routines";

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

function outcomeClass(outcome: WeekOutcome, selected: boolean): string {
  if (outcome === "planned") return "border-dashed border-line bg-inset text-ink-muted";
  if (outcome === "missed") return "border-danger/30 bg-danger/10 text-ink";
  if (outcome === "partial") return "border-hold/25 bg-hold/10 text-ink";
  if (outcome === "running") return "border-agency/25 bg-agency/10 text-ink";
  if (outcome === "done") return "border-agency/25 bg-agency/10 text-ink";
  if (outcome === "paused") return "border-line bg-inset text-ink-secondary";
  return selected ? "border-agency/25 bg-selected text-ink" : "border-agency/25 bg-agency/10 text-ink";
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
  const days = buildScheduleWeek(loops, nowMs, timeZone, facts);
  const missed = days.some((day) => day.slots.some((slot) => slot.outcome === "missed"));
  const lastRunOnWeek = Boolean(
    facts?.desk?.lastRunAt && days.some((day) => sameCalendarDay(day.dateMs, facts.desk!.lastRunAt!, timeZone)),
  );
  return (
    <section className="rounded-xl border border-line bg-sheet" aria-label="This week on the clock">
      <div className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-3">
        <h2 className="text-[14px] font-medium text-ink">This week</h2>
        <p className="text-[12px] text-ink-muted">{todayHint(days)}</p>
      </div>
      {(missed || lastRunOnWeek) && deskNote ? (
        <p className={cn("border-b border-line px-4 py-2 text-[12.5px]", missed ? "text-hold" : "text-ink-secondary")}>
          {deskNote}
        </p>
      ) : null}
      <ol className="divide-y divide-line">
        {days.map((day) => (
          <li
            key={day.weekday}
            className={cn("flex items-start gap-3 px-4 py-2.5", day.isToday && "bg-selected")}
          >
            <div className="w-16 shrink-0 pt-1.5">
              <div className={cn("text-[12px] font-medium", day.isToday ? "text-agency" : "text-ink-muted")}>
                {DAY_NAMES[day.weekday]}
              </div>
              <div className={cn("text-[12px] tabular-nums", day.isToday ? "text-agency" : "text-ink-secondary")}>
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
  return (
    <button
      type="button"
      onClick={() => onSelect(slot)}
      aria-pressed={selected}
      aria-label={`${slot.name} at ${slotTime(slot.time)}${slot.stamp ? `, ${slot.stamp}` : ""}`}
      title={slot.name}
      className={cn("min-h-10 rounded border px-2.5 py-1.5 text-left", outcomeClass(slot.outcome, selected), selected && "bg-selected")}
    >
      <span className="text-[12px] font-medium">{slot.shortName}</span>
      <span className="ml-1.5 tabular-nums text-[12px] text-ink-secondary">{slotTime(slot.time)}</span>
      {slot.stamp ? (
        <span className={cn("ml-1.5 text-[11px]", slot.outcome === "missed" ? "text-danger" : slot.outcome === "partial" ? "text-hold" : "text-ink-muted")}>
          {slot.stamp}
        </span>
      ) : null}
    </button>
  );
}
