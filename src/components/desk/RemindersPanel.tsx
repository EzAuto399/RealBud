import { useState, type FormEvent, type ReactNode } from "react";
import { Bell, ChevronDown } from "lucide-react";
import {
  REMINDER_CONFLICT,
  REMINDER_TITLE_MAX,
  SNOOZE_LABELS,
  dueAtFromWallInput,
  isOpenReminder,
  snoozeDueAt,
  type Reminder,
  type SnoozePresetId,
} from "@shared/reminders";
import { reminderAskContext, useReminders, type RemindersViewState } from "@/lib/reminders-api";
import { useUnsavedGuard } from "@/lib/unsaved-work";
import { useStore } from "@/state/store";
import { cn } from "@/lib/cn";

const control = "pm-control inline-flex min-h-11 items-center justify-center rounded border border-line bg-sheet px-3 text-[13px] font-medium leading-5 text-ink hover:bg-selected disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-agency";
const field = "min-h-11 rounded border border-line bg-sheet px-3 text-[15px] leading-6 text-ink focus-visible:outline-2 focus-visible:outline-agency";
const SNOOZES: SnoozePresetId[] = ["later-today", "tomorrow", "next-week"];

function when(at: number, timeZone: string | null): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", ...(timeZone ? { timeZone } : {}) }).format(at);
  } catch {
    return "Time unavailable";
  }
}

export interface ReminderDraft { title: string; when: string }

export interface RemindersViewProps {
  headerAction?: ReactNode;
  view: RemindersViewState;
  draft: ReminderDraft;
  now: number;
  onDraftChange(draft: ReminderDraft): void;
  onAdd(): void;
  onDone(reminder: Reminder): void;
  onDismiss(reminder: Reminder): void;
  onSnooze(reminder: Reminder, preset: SnoozePresetId): void;
  onAskBud(reminder: Reminder): void;
  onReopen(): void;
  onRetry(): void;
}

/** Presentational: due items first and highlighted, scheduled after, then a
 *  compact add form. No reminder sends or runs anything by itself. */
export function RemindersView({ headerAction, view, draft, now, onDraftChange, onAdd, onDone, onDismiss, onSnooze, onAskBud, onReopen, onRetry }: RemindersViewProps) {
  const timeZone = view.data?.timeZone ?? null;
  const open = (view.data?.reminders ?? []).filter(isOpenReminder);
  const due = open.filter(reminder => reminder.state === "due" || reminder.dueAt <= now);
  const busy = view.busyId !== null;
  const dueAt = dueAtFromWallInput(draft.when, timeZone);
  const canAdd = !busy && !!view.data && draft.title.trim().length > 0 && draft.title.trim().length <= REMINDER_TITLE_MAX && dueAt !== null;
  const submit = (event: FormEvent) => { event.preventDefault(); if (canAdd) onAdd(); };
  return (
    <section aria-labelledby="desk-reminders-title" className="desk-reminders mt-3 rounded-lg border border-line bg-sheet p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="desk-reminders-title" className="flex shrink-0 items-center gap-2 whitespace-nowrap text-[16px] font-semibold leading-6 text-ink">
          <Bell size={17} aria-hidden />
          Reminders{due.length ? <span className="desk-reminder-due-count shrink-0 whitespace-nowrap rounded border border-hold/25 bg-hold/10 px-2 py-0.5 text-[13px] font-medium leading-5 text-hold">{due.length} due</span> : null}
        </h2>
        {headerAction}
        <p className={cn("desk-reminder-meta text-[13px] leading-5 text-ink-muted", headerAction && "basis-full")}>
          {timeZone ? `Times in ${timeZone}` : "Times use this computer's time zone. Set the office time zone in Agency setup."}
        </p>
      </div>
      {view.conflict ? (
        <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 rounded border border-hold/40 bg-hold/10 px-3 py-2 text-[13px] text-hold">
          <span className="min-w-0 flex-1">{REMINDER_CONFLICT}. Your new reminder text is kept.</span>
          <button type="button" className={control} onClick={onReopen}>Open again</button>
        </div>
      ) : null}
      {view.readError ? (
        <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-danger">
          <span className="min-w-0 flex-1">{view.readError}</span>
          <button type="button" className={control} onClick={onRetry}>Try again</button>
        </div>
      ) : null}
      {view.notice ? <p role={view.notice.problem ? "alert" : "status"} className={cn("mt-2 text-[13px]", view.notice.problem ? "text-danger" : "text-ink-secondary")}>{view.notice.text}</p> : null}
      {view.loading && !view.data ? (
        <p role="status" className="mt-2 text-[15px] leading-6 text-ink-muted">Loading reminders…</p>
      ) : view.data && !open.length ? (
        <p className="mt-2 text-[15px] leading-6 text-ink-secondary">No reminders. Add one below and it shows here when it's due.</p>
      ) : (
        <ul className="mt-2 divide-y divide-line" aria-label="Your reminders">
          {open.map(reminder => {
            const isDue = reminder.state === "due" || reminder.dueAt <= now;
            const working = view.busyId === reminder.id;
            return (
              <li key={reminder.id} className={cn("desk-reminder-item py-3", isDue && "-mx-1 rounded border-l-4 border-hold bg-hold/10 px-2")} data-due={isDue ? "true" : undefined} aria-label={`${reminder.title}, ${isDue ? "due" : "scheduled"} ${when(reminder.dueAt, timeZone)}`}>
                <div className="flex flex-col gap-1">
                  <p className="desk-reminder-title min-w-0 break-words text-[15px] font-medium leading-6 text-ink">{reminder.title}</p>
                  <span className={cn("desk-reminder-meta text-[13px] leading-5", isDue ? "font-medium text-hold" : "text-ink-muted")}>{isDue ? "Due" : "Scheduled"} · {when(reminder.dueAt, timeZone)}</span>
                </div>
                {reminder.note ? <p className="mt-1 line-clamp-2 break-words text-[15px] leading-6 text-ink-secondary">{reminder.note}</p> : null}
                {reminder.createdBy === "bud" ? <p className="desk-reminder-meta mt-1 text-[13px] leading-5 text-ink-muted">Set by Bud from a conversation</p> : null}
                {isDue ? (
                  <div className="desk-reminder-actions mt-3 flex flex-wrap gap-2">
                    <button type="button" className={cn(control, "desk-reminder-done border-agency bg-agency text-white hover:bg-agency-hover")} disabled={busy} aria-label={`Done: ${reminder.title}`} onClick={() => onDone(reminder)}>Done</button>
                    <button type="button" className={cn(control, "desk-reminder-ask")} disabled={busy} aria-label={`Ask Bud to prepare: ${reminder.title}`} onClick={() => onAskBud(reminder)}>Ask Bud to prepare</button>
                  </div>
                ) : null}
                <div className="desk-reminder-secondary-actions mt-1 flex flex-wrap items-start gap-x-2">
                  {isDue ? <details className="desk-reminder-snooze min-w-0 flex-1">
                    <summary className="desk-reminder-snooze-toggle min-h-11 cursor-pointer content-center rounded text-[14px] font-medium leading-5 text-ink-secondary focus-visible:outline-2 focus-visible:outline-agency" aria-label={`Remind me later: ${reminder.title}`}>Remind me later <ChevronDown size={16} aria-hidden /></summary>
                    <div role="group" aria-label={`Snooze ${reminder.title}`} className="desk-reminder-snooze-options flex flex-wrap gap-2 pb-2">
                      {SNOOZES.map(preset => (
                        <button key={preset} type="button" className={control} disabled={busy} aria-label={`Snooze ${reminder.title} until ${SNOOZE_LABELS[preset].toLowerCase()}`} onClick={() => onSnooze(reminder, preset)}>
                          {SNOOZE_LABELS[preset]}
                        </button>
                      ))}
                    </div>
                  </details> : null}
                  <button type="button" className="desk-reminder-dismiss inline-flex min-h-11 items-center justify-center rounded px-2 text-[13px] leading-5 text-ink-muted hover:bg-selected hover:text-ink disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-agency" disabled={busy} aria-label={`Dismiss: ${reminder.title}`} onClick={() => onDismiss(reminder)}>Dismiss</button>
                  {working ? <span role="status" className="desk-reminder-meta self-center text-[13px] leading-5 text-ink-muted">Saving…</span> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <form className="desk-reminder-form mt-3 flex flex-wrap items-end gap-3" onSubmit={submit} aria-label="Add a reminder">
        <label className="flex min-w-0 flex-[2_1_12rem] flex-col gap-1 text-[13px] leading-5 text-ink-secondary">
          What to remember
          <input className={field} type="text" value={draft.title} maxLength={REMINDER_TITLE_MAX} aria-label="Reminder title" placeholder="Call the owner back" onChange={event => onDraftChange({ ...draft, title: event.target.value })} />
        </label>
        <label className="flex min-w-0 flex-[1_1_11rem] flex-col gap-1 text-[13px] leading-5 text-ink-secondary">
          When
          <input className={field} type="datetime-local" value={draft.when} aria-label="Remind me at" onChange={event => onDraftChange({ ...draft, when: event.target.value })} />
        </label>
        <button type="submit" className={cn(control, "border-agency bg-agency text-sheet hover:bg-agency-hover")} disabled={!canAdd}>
          {view.busyId === "new" ? "Adding…" : "Add reminder"}
        </button>
      </form>
    </section>
  );
}

/** The Desk panel: the person's reminders and an add form. "Ask Bud to
 *  prepare" opens Ask with the reminder attached; nothing is sent. */
export function RemindersPanel({ headerAction }: { headerAction?: ReactNode }) {
  const { dispatch } = useStore();
  const reminders = useReminders();
  const [draft, setDraft] = useState<ReminderDraft>({ title: "", when: "" });
  // A typed reminder holds beforeunload and the update restart until it is added.
  useUnsavedGuard(draft.title.trim().length > 0);
  const timeZone = reminders.view.data?.timeZone ?? null;
  const now = Date.now();
  return (
    <RemindersView
      headerAction={headerAction}
      view={reminders.view}
      draft={draft}
      now={now}
      onDraftChange={setDraft}
      onAdd={() => {
        const dueAt = dueAtFromWallInput(draft.when, timeZone);
        if (dueAt === null) return;
        void reminders.create({ title: draft.title.trim(), dueAt }).then(saved => { if (saved) setDraft({ title: "", when: "" }); });
      }}
      onDone={reminder => void reminders.complete(reminder)}
      onDismiss={reminder => void reminders.dismiss(reminder)}
      onSnooze={(reminder, preset) => void reminders.snooze(reminder, snoozeDueAt(preset, Date.now(), timeZone))}
      onAskBud={reminder => dispatch({ type: "stageAskContext", context: reminderAskContext(reminder, crypto.randomUUID(), timeZone) })}
      onReopen={() => void reminders.reopen()}
      onRetry={() => void reminders.refresh()}
    />
  );
}
