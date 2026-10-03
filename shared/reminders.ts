/** One-off reminders a person (or Bud, for that person) keeps on RealBud's own
 * schedule. A reminder is a dated note: it never sends, books or runs anything
 * by itself. Dependency-free; the server and renderer validate with the same
 * rules. */

export const REMINDERS_API = '/api/reminders';
export const REMINDER_TITLE_MAX = 200;
export const REMINDER_NOTE_MAX = 2000;
/** Open (scheduled or due) reminders one member may keep. */
export const MAX_OPEN_REMINDERS = 200;
/** Closed (done or dismissed) reminders kept for reference, newest first. */
export const MAX_CLOSED_REMINDERS = 100;
/** Earliest and latest accepted due time: 1 Jan 2020 to ten years ahead. */
export const MIN_REMINDER_DUE_AT = Date.UTC(2020, 0, 1);
export const MAX_REMINDER_AHEAD_MS = 10 * 366 * 24 * 60 * 60_000;
export const REMINDER_CONFLICT = 'This reminder changed — open it again';

export const REMINDER_STATES = ['scheduled', 'due', 'done', 'dismissed'] as const;
export type ReminderState = typeof REMINDER_STATES[number];
export type ReminderCreatedBy = 'person' | 'bud';
export interface ReminderSource { threadId?: string; caseId?: string }
export interface Reminder {
  id: string;
  title: string;
  note: string;
  dueAt: number;
  createdBy: ReminderCreatedBy;
  source?: ReminderSource;
  state: ReminderState;
  createdAt: number;
  updatedAt: number;
  revision: number;
}
export interface RemindersResponse {
  version: 1;
  reminders: Reminder[];
  /** The office time zone saved in Agency setup, or null when none is saved.
   * Null is never replaced by a guessed zone. */
  timeZone: string | null;
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));

export const validReminderId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export const validReminderRevision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 1;
const validSourceId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][\w:.-]{0,127}$/.test(value);
const validTime = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export function validTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 100 || (value !== 'UTC' && !value.includes('/'))) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0); return true; } catch { return false; }
}

/** Trimmed single-line title. Throws a user-facing sentence. */
export function reminderTitle(value: unknown): string {
  const title = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!title) throw new Error('Give the reminder a title.');
  if (title.length > REMINDER_TITLE_MAX) throw new Error(`Keep the reminder title to ${REMINDER_TITLE_MAX} characters.`);
  return title;
}
export function reminderNote(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new Error('Check the reminder note.');
  const note = value.replace(/\r\n?/g, '\n').trim();
  if (note.length > REMINDER_NOTE_MAX) throw new Error(`Keep the reminder note to ${REMINDER_NOTE_MAX} characters.`);
  return note;
}
export function reminderDueAt(value: unknown, now: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < MIN_REMINDER_DUE_AT || Number(value) > now + MAX_REMINDER_AHEAD_MS) throw new Error('Choose a valid date and time for the reminder.');
  return Number(value);
}

function parseSource(value: unknown): ReminderSource | null {
  if (!object(value) || !exact(value, [], ['threadId', 'caseId']) || !Object.keys(value).length) return null;
  if (value.threadId !== undefined && !validSourceId(value.threadId)) return null;
  if (value.caseId !== undefined && !validSourceId(value.caseId)) return null;
  return { ...(value.threadId !== undefined ? { threadId: value.threadId as string } : {}), ...(value.caseId !== undefined ? { caseId: value.caseId as string } : {}) };
}

/** Strict: unknown keys, an out-of-range field or an unknown state reject. */
export function parseReminder(value: unknown): Reminder | null {
  if (!object(value) || !exact(value, ['id', 'title', 'note', 'dueAt', 'createdBy', 'state', 'createdAt', 'updatedAt', 'revision'], ['source'])) return null;
  if (!validReminderId(value.id) || !validReminderRevision(value.revision) || !validTime(value.createdAt) || !validTime(value.updatedAt) || !validTime(value.dueAt)) return null;
  if (value.createdBy !== 'person' && value.createdBy !== 'bud') return null;
  if (!(REMINDER_STATES as readonly unknown[]).includes(value.state)) return null;
  if (typeof value.title !== 'string' || typeof value.note !== 'string') return null;
  let title: string, note: string;
  try { title = reminderTitle(value.title); note = reminderNote(value.note); } catch { return null; }
  if (title !== value.title || note !== value.note) return null;
  const source = value.source === undefined ? undefined : parseSource(value.source);
  if (source === null) return null;
  return { id: value.id, title, note, dueAt: value.dueAt, createdBy: value.createdBy, ...(source ? { source } : {}), state: value.state as ReminderState, createdAt: value.createdAt, updatedAt: value.updatedAt, revision: value.revision };
}

export function parseRemindersResponse(value: unknown): RemindersResponse | null {
  if (!object(value) || !exact(value, ['version', 'reminders', 'timeZone']) || value.version !== 1 || !Array.isArray(value.reminders)) return null;
  if (value.timeZone !== null && !validTimeZone(value.timeZone)) return null;
  const reminders: Reminder[] = [], seen = new Set<string>();
  for (const raw of value.reminders) {
    const reminder = parseReminder(raw);
    if (!reminder || seen.has(reminder.id)) return null;
    seen.add(reminder.id); reminders.push(reminder);
  }
  return { version: 1, reminders, timeZone: value.timeZone };
}

export const isOpenReminder = (reminder: Pick<Reminder, 'state'>) => reminder.state === 'scheduled' || reminder.state === 'due';

/** Due first, then scheduled, each soonest first; closed last, newest first. */
export function sortReminders(reminders: readonly Reminder[]): Reminder[] {
  const rank = (state: ReminderState) => state === 'due' ? 0 : state === 'scheduled' ? 1 : 2;
  return [...reminders].sort((a, b) => rank(a.state) - rank(b.state) ||
    (isOpenReminder(a) ? a.dueAt - b.dueAt : b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id));
}

/** A scheduled reminder whose time has passed is due. Closed ones never reopen. */
export const reminderStateAt = (reminder: Pick<Reminder, 'state' | 'dueAt'>, now: number): ReminderState =>
  reminder.state === 'scheduled' && reminder.dueAt <= now ? 'due' : reminder.state;

// ── wall-clock helpers ─────────────────────────────────────────────────────
// `timeZone` null means no office zone is saved; the caller must label times
// as this computer's own, never as the office's.

export interface WallTime { year: number; month: number; day: number; hour: number; minute: number; dow: number }
export function wallInZone(ms: number, timeZone: string | null): WallTime {
  const parts = new Intl.DateTimeFormat('en-US', {
    ...(timeZone ? { timeZone } : {}), hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '0';
  return {
    year: Number(get('year')), month: Number(get('month')), day: Number(get('day')),
    hour: Number(get('hour')) % 24, minute: Number(get('minute')),
    dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')),
  };
}
/** The instant a wall time names in `timeZone`. A skipped DST hour resolves forward. */
export function instantFromWall(timeZone: string | null, year: number, month: number, day: number, hour: number, minute: number): number {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  for (let i = 0; i < 6; i++) {
    const wall = wallInZone(guess, timeZone);
    const delta = target - Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
    if (delta === 0) return guess;
    guess += delta;
  }
  return guess;
}
/** `YYYY-MM-DDTHH:mm` from an `<input type="datetime-local">`, read in `timeZone`. */
export function dueAtFromWallInput(value: string, timeZone: string | null): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1) return null;
  return instantFromWall(timeZone, year, month, day, hour, minute);
}
export function wallInputFromDueAt(ms: number, timeZone: string | null): string {
  const wall = wallInZone(ms, timeZone), pad = (n: number) => String(n).padStart(2, '0');
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}`;
}

export type SnoozePresetId = 'later-today' | 'tomorrow' | 'next-week';
export const SNOOZE_LABELS: Record<SnoozePresetId, string> = { 'later-today': 'Later today', tomorrow: 'Tomorrow 9am', 'next-week': 'Next week' };
/** Later today is three hours on, rounded up to the quarter hour; tomorrow is
 * 9am the next day; next week is 9am on the coming Monday. */
export function snoozeDueAt(preset: SnoozePresetId, now: number, timeZone: string | null): number {
  if (preset === 'later-today') { const quarter = 15 * 60_000; return Math.ceil((now + 3 * 60 * 60_000) / quarter) * quarter; }
  const today = wallInZone(now, timeZone);
  const ahead = preset === 'tomorrow' ? 1 : ((8 - today.dow) % 7) || 7;
  const target = new Date(Date.UTC(today.year, today.month - 1, today.day + ahead));
  return instantFromWall(timeZone, target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate(), 9, 0);
}
