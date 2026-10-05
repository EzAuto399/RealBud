import { createHash, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  MAX_CLOSED_REMINDERS, MAX_OPEN_REMINDERS, REMINDERS_API, REMINDER_CONFLICT, isOpenReminder, parseReminder, reminderDueAt, reminderNote,
  reminderStateAt, reminderTitle, sortReminders, validReminderId, validReminderRevision, validTimeZone, type Reminder, type RemindersResponse,
} from '../shared/reminders.ts';
import { privateDirectory, readPrivateJson, readPrivateJsonWithFallback, writePrivateJson } from './private-json.ts';
import { redactSecretsInText } from './redact.ts';

/** One-off reminders on RealBud's own schedule, kept per workspace and member
 * in private storage. The service's own interval only marks reminders due; it
 * never starts a turn, a job or a send. */

const MAX_BYTES = 1_500_000;
const DEFAULT_INTERVAL_MS = 30_000;
const queues = new Map<string, Promise<unknown>>();
type Failure = Error & { status: number; code: string; reminder?: Reminder };
const fail = (status: number, code: string, message: string, reminder?: Reminder): Failure => Object.assign(new Error(message), { status, code, ...(reminder ? { reminder } : {}) });
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function fields(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!record(value) || !required.every(key => Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw fail(400, 'invalid_reminder', 'Check the reminder details.');
  return value;
}
const valid = <T>(read: () => T): T => { try { return read(); } catch (cause) { throw fail(400, 'invalid_reminder', cause instanceof Error ? cause.message : 'Check the reminder details.'); } };
/** Stored text is redacted like everything else RealBud persists, then checked again. */
const title = (value: unknown) => valid(() => reminderTitle(redactSecretsInText(reminderTitle(value))));
const note = (value: unknown) => valid(() => reminderNote(redactSecretsInText(reminderNote(value))));

interface ReminderFile { version: 1; workspaceId: string; memberKey: string; reminders: Reminder[] }

export interface RemindersServiceOptions {
  directory: string;
  workspaceId: string;
  /** The seat this desk serves, read at each call; empty is a single-seat desk. */
  memberKey: () => string;
  /** The office time zone saved in Agency setup; null or empty when none is saved. */
  timeZone?: () => Promise<string | null> | string | null;
  now?: () => number;
  intervalMs?: number;
}

export function createRemindersService(options: RemindersServiceOptions) {
  if (!/^[a-f0-9-]{36}$/i.test(options.workspaceId)) throw new Error('A private workspace identity is required.');
  const now = options.now ?? Date.now;
  const directory = resolve(options.directory, 'reminders');
  let timer: ReturnType<typeof setInterval> | null = null;

  const memberKey = () => {
    const key = (options.memberKey() ?? '').trim();
    if (key.length > 200) throw fail(503, 'reminders_unavailable', 'Reminders are unavailable for this sign-in.');
    return key;
  };
  /** A file per workspace and member. The name is a digest, and the file also
   * carries both identities, which every read checks. */
  const pathFor = (member: string) => join(directory, `${createHash('sha256').update(`reminders-v1\n${options.workspaceId}\n${member}`).digest('hex').slice(0, 40)}.json`);

  function serial<T>(path: string, action: () => Promise<T>): Promise<T> {
    const previous = queues.get(path) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    queues.set(path, next);
    void next.finally(() => { if (queues.get(path) === next) queues.delete(path); }).catch(() => {});
    return next;
  }

  /** Damaged, foreign or unreadable storage holds every change; it is never cleared. */
  async function read(path: string, member: string): Promise<Reminder[]> {
    await privateDirectory(directory);
    let value: unknown;
    try { value = await readPrivateJsonWithFallback(path, MAX_BYTES, existing => { if (!parseFile(existing, member)) throw new Error('invalid'); }); }
    catch { throw fail(503, 'reminders_recovery_required', 'Saved reminders need recovery. Nothing was changed.'); }
    if (value === undefined) return [];
    const reminders = parseFile(value, member);
    if (!reminders) throw fail(503, 'reminders_recovery_required', 'Saved reminders need recovery. Nothing was changed.');
    return reminders;
  }
  function parseFile(value: unknown, member: string | null): Reminder[] | null {
    if (!record(value) || Object.keys(value).sort().join() !== 'memberKey,reminders,version,workspaceId' || value.version !== 1 ||
      value.workspaceId !== options.workspaceId || typeof value.memberKey !== 'string' || (member !== null && value.memberKey !== member) || !Array.isArray(value.reminders)) return null;
    const reminders: Reminder[] = [], seen = new Set<string>();
    for (const raw of value.reminders) {
      const reminder = parseReminder(raw);
      if (!reminder || seen.has(reminder.id)) return null;
      seen.add(reminder.id); reminders.push(reminder);
    }
    return reminders;
  }
  async function write(path: string, member: string, reminders: Reminder[]) {
    const open = reminders.filter(isOpenReminder);
    const closed = reminders.filter(reminder => !isOpenReminder(reminder)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CLOSED_REMINDERS);
    const file: ReminderFile = { version: 1, workspaceId: options.workspaceId, memberKey: member, reminders: sortReminders([...open, ...closed]) };
    await writePrivateJson(path, file, { maxBytes: MAX_BYTES, keepPrevious: true, validate: existing => { if (!parseFile(existing, member)) throw fail(503, 'reminders_recovery_required', 'Saved reminders need recovery. Nothing was changed.'); } });
    return file.reminders;
  }
  /** Marks passed reminders due; returns whether anything changed. */
  function promote(reminders: Reminder[], at: number): boolean {
    let changed = false;
    reminders.forEach((reminder, index) => {
      if (reminderStateAt(reminder, at) === reminder.state) return;
      reminders[index] = { ...reminder, state: 'due', updatedAt: at, revision: reminder.revision + 1 };
      changed = true;
    });
    return changed;
  }
  /** Read the member's reminders with passed ones marked due, then apply `change`. */
  function withMember<T>(change: (reminders: Reminder[], at: number, save: (next: Reminder[]) => Promise<Reminder[]>) => Promise<T>): Promise<T> {
    const member = memberKey(), path = pathFor(member);
    return serial(path, async () => {
      const at = now();
      const reminders = await read(path, member);
      // Persist the due transition first, so a refused change below still leaves it saved.
      if (promote(reminders, at)) await write(path, member, reminders);
      return change(reminders, at, next => write(path, member, next));
    });
  }
  async function timeZone(): Promise<string | null> {
    try { const zone = await options.timeZone?.(); return validTimeZone(zone) ? zone : null; } catch { return null; }
  }

  const find = (reminders: Reminder[], id: string) => {
    const index = reminders.findIndex(reminder => reminder.id === id);
    if (index < 0) throw fail(404, 'reminder_not_found', 'This reminder is no longer here. Refresh reminders.');
    return index;
  };
  /** Compare-and-swap: the caller's revision must match, and the reminder must still be open. */
  const expect = (reminder: Reminder, expected: unknown) => {
    if (!validReminderRevision(expected)) throw fail(400, 'invalid_reminder', 'Refresh reminders before changing this one.');
    if (expected !== reminder.revision) throw fail(409, 'reminder_changed', REMINDER_CONFLICT, reminder);
    if (!isOpenReminder(reminder)) throw fail(409, 'reminder_closed', 'This reminder is already closed.', reminder);
  };
  const stateFor = (dueAt: number, at: number) => dueAt <= at ? 'due' as const : 'scheduled' as const;

  async function create(input: { title: unknown; note?: unknown; dueAt: unknown; createdBy: Reminder['createdBy']; source?: Reminder['source'] }): Promise<Reminder> {
    return withMember(async (reminders, at, save) => {
      const text = { title: title(input.title), note: note(input.note) }, dueAt = valid(() => reminderDueAt(input.dueAt, at));
      if (reminders.filter(isOpenReminder).length >= MAX_OPEN_REMINDERS) throw fail(409, 'reminders_full', 'You have too many open reminders. Finish or dismiss some first.');
      const reminder: Reminder = { id: randomUUID(), ...text, dueAt, createdBy: input.createdBy, ...(input.source ? { source: input.source } : {}), state: stateFor(dueAt, at), createdAt: at, updatedAt: at, revision: 1 };
      await save([...reminders, reminder]);
      return reminder;
    });
  }
  async function change(id: string, body: unknown, allowed: string[], apply: (reminder: Reminder, input: Record<string, unknown>, at: number) => Reminder): Promise<Reminder> {
    return withMember(async (reminders, at, save) => {
      const input = fields(body, ['expectedRevision'], allowed);
      const index = find(reminders, id);
      expect(reminders[index]!, input.expectedRevision);
      const next = { ...apply(reminders[index]!, input, at), updatedAt: at, revision: reminders[index]!.revision + 1 };
      reminders[index] = next;
      await save(reminders);
      return next;
    });
  }

  const service = {
    /** Marks passed reminders due in every member file of this workspace. A
     * damaged or foreign file is left untouched for recovery. */
    async tick(): Promise<void> {
      await privateDirectory(directory);
      const names = (await readdir(directory)).filter(name => /^[a-f0-9]{40}\.json$/.test(name));
      for (const name of names) {
        const path = join(directory, name);
        await serial(path, async () => {
          let value: unknown;
          try { value = await readPrivateJson(path, MAX_BYTES); } catch { return; }
          const reminders = value === undefined ? null : parseFile(value, null);
          if (!reminders || !record(value) || pathFor(value.memberKey as string) !== path) return;
          if (promote(reminders, now())) await write(path, value.memberKey as string, reminders);
        }).catch(() => {});
      }
    },
    /** Marks anything missed while the app was closed, then keeps checking. */
    start(): void {
      if (timer) return;
      // One sweep at a time: on Windows each private read and write runs an
      // ACL check that can outlast the interval, and overlapping sweeps would
      // queue without bound behind it.
      let sweeping = false;
      const sweep = () => {
        if (sweeping) return;
        sweeping = true;
        void service.tick().catch(() => {}).finally(() => { sweeping = false; });
      };
      sweep();
      timer = setInterval(sweep, options.intervalMs ?? DEFAULT_INTERVAL_MS);
      timer.unref?.();
    },
    close(): void { if (timer) clearInterval(timer); timer = null; },
    async list(): Promise<RemindersResponse> {
      const reminders = await withMember(async items => sortReminders(items));
      return { version: 1, reminders, timeZone: await timeZone() };
    },
    /** For Bud's Ask tool (not wired yet): a reminder for the person in this
     * thread. It is a dated note only; nothing runs or sends when it falls due. */
    async createFromBud(input: { threadId: string; title: string; note?: string; dueAt: number }): Promise<Reminder> {
      if (typeof input?.threadId !== 'string' || !/^[A-Za-z0-9][\w:.-]{0,127}$/.test(input.threadId)) throw fail(400, 'invalid_reminder', 'This conversation cannot hold a reminder.');
      return create({ title: input.title, note: input.note, dueAt: input.dueAt, createdBy: 'bud', source: { threadId: input.threadId } });
    },
    async handle(route: string, method: string, body?: unknown): Promise<{ status: number; body: unknown } | null> {
      if (route !== REMINDERS_API && !route.startsWith(`${REMINDERS_API}/`)) return null;
      try {
        if (route === REMINDERS_API) {
          if (method === 'GET') return { status: 200, body: await service.list() };
          if (method !== 'POST') return { status: 405, body: { error: 'This reminder action is unavailable.' } };
          const input = fields(body, ['title', 'dueAt'], ['note']);
          return { status: 201, body: { reminder: await create({ title: input.title, note: input.note, dueAt: input.dueAt, createdBy: 'person' }) } };
        }
        const match = /^\/api\/reminders\/([^/]+)(?:\/(complete|dismiss|snooze))?$/.exec(route);
        if (!match) return { status: 404, body: { error: 'Unknown reminder action.' } };
        const [, id, action] = match;
        // The id selects within this member's own reminders only.
        if (!validReminderId(id)) return { status: 404, body: { error: 'This reminder is no longer here. Refresh reminders.', code: 'reminder_not_found' } };
        if ((action ? 'POST' : 'PUT') !== method) return { status: 405, body: { error: 'This reminder action is unavailable.' } };
        let reminder: Reminder;
        if (!action) reminder = await change(id, body, ['title', 'note', 'dueAt'], (current, input, at) => {
          const dueAt = input.dueAt === undefined ? current.dueAt : valid(() => reminderDueAt(input.dueAt, at));
          return { ...current, title: input.title === undefined ? current.title : title(input.title), note: input.note === undefined ? current.note : note(input.note), dueAt, state: stateFor(dueAt, at) };
        });
        else if (action === 'snooze') reminder = await change(id, body, ['dueAt'], (current, input, at) => {
          if (!Object.hasOwn(input, 'dueAt')) throw fail(400, 'invalid_reminder', 'Choose when to be reminded again.');
          const dueAt = valid(() => reminderDueAt(input.dueAt, at));
          if (dueAt <= at) throw fail(400, 'invalid_reminder', 'Choose a later time to be reminded again.');
          return { ...current, dueAt, state: 'scheduled' };
        });
        else reminder = await change(id, body, [], current => ({ ...current, state: action === 'complete' ? 'done' : 'dismissed' }));
        return { status: 200, body: { reminder } };
      } catch (cause) {
        const known = cause as Partial<Failure>;
        if (typeof known.status === 'number' && typeof known.code === 'string') return { status: known.status, body: { error: known.message, code: known.code, ...(known.reminder ? { reminder: known.reminder } : {}) } };
        return { status: 503, body: { error: 'Reminders could not be saved or checked. Refresh before retrying.', code: 'reminders_unavailable' } };
      }
    },
  };
  return service;
}

export type RemindersService = ReturnType<typeof createRemindersService>;
