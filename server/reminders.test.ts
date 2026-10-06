import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRemindersService } from './reminders.ts';
import { needsSession } from './session-auth.ts';
import { parseRemindersResponse, type Reminder } from '../shared/reminders.ts';
import { removeFixture } from './testing/private-fixture.ts';
import * as privateJson from './private-json.ts';

const directories: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(directories.splice(0).map(path => removeFixture(path))); });

const START = Date.UTC(2026, 9, 2, 0, 0);
const HOUR = 60 * 60_000;
// Each private read and write runs a PowerShell ACL check on Windows.
const SWEEP_WAIT = { timeout: process.platform === 'win32' ? 60_000 : 1_000 };
async function fixture(options: { directory?: string; workspaceId?: string; member?: string; timeZone?: string | null } = {}) {
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), 'realbud-reminders-'));
  if (!options.directory) directories.push(directory);
  const workspaceId = options.workspaceId ?? randomUUID();
  const clock = { now: START, member: options.member ?? '' };
  const service = createRemindersService({ directory, workspaceId, memberKey: () => clock.member, now: () => clock.now, timeZone: () => options.timeZone ?? null, intervalMs: 10 });
  const call = async (method: string, path = '/api/reminders', body?: unknown) => (await service.handle(path, method, body))!;
  const list = async () => parseRemindersResponse((await call('GET')).body)!;
  const add = async (title: string, dueAt: number, note?: string) => {
    const result = await call('POST', '/api/reminders', { title, dueAt, ...(note === undefined ? {} : { note }) });
    expect(result.status).toBe(201);
    return (result.body as { reminder: Reminder }).reminder;
  };
  return { directory, workspaceId, clock, service, call, list, add };
}

describe('reminder store', () => {
  it('creates scheduled reminders, lists due and scheduled first, and keeps the office time zone honest', async () => {
    const f = await fixture();
    const later = await f.add('Call the owner about the lease', START + 2 * HOUR, 'Ask about the renewal');
    const past = await f.add('Chase the plumber invoice', START - HOUR);
    expect(later).toMatchObject({ state: 'scheduled', revision: 1, createdBy: 'person', note: 'Ask about the renewal' });
    expect(past.state).toBe('due');
    const listed = await f.list();
    expect(listed.reminders.map(r => r.id)).toEqual([past.id, later.id]);
    // No saved office zone stays null, never a guessed zone.
    expect(listed.timeZone).toBeNull();
    const zoned = await fixture({ timeZone: 'Australia/Brisbane' });
    expect((await zoned.list()).timeZone).toBe('Australia/Brisbane');
    expect((await (await fixture({ timeZone: 'Not/AZone' })).list()).timeZone).toBeNull();
  });

  it('compare-and-swaps every change and returns 409 with the current reminder on a stale revision', async () => {
    const f = await fixture();
    const reminder = await f.add('Inspect 12 Example St', START + HOUR);
    const edited = await f.call('PUT', `/api/reminders/${reminder.id}`, { expectedRevision: 1, title: 'Inspect 12 Example St again' });
    expect(edited.status).toBe(200);
    expect((edited.body as { reminder: Reminder }).reminder).toMatchObject({ title: 'Inspect 12 Example St again', revision: 2 });
    const stale = await f.call('PUT', `/api/reminders/${reminder.id}`, { expectedRevision: 1, title: 'A stale draft' });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'reminder_changed', reminder: { revision: 2, title: 'Inspect 12 Example St again' } });
    expect((await f.call('POST', `/api/reminders/${reminder.id}/complete`, { expectedRevision: 1 })).status).toBe(409);
    const done = await f.call('POST', `/api/reminders/${reminder.id}/complete`, { expectedRevision: 2 });
    expect((done.body as { reminder: Reminder }).reminder).toMatchObject({ state: 'done', revision: 3 });
    // A closed reminder is not reopened by a later change.
    expect((await f.call('POST', `/api/reminders/${reminder.id}/dismiss`, { expectedRevision: 3 })).body).toMatchObject({ code: 'reminder_closed' });
    expect((await f.list()).reminders[0]).toMatchObject({ state: 'done', title: 'Inspect 12 Example St again' });
  });

  it('serialises concurrent changes so only one wins a revision', async () => {
    const f = await fixture();
    const reminder = await f.add('Send keys to the locksmith', START + HOUR);
    const results = await Promise.all([1, 2, 3].map(n => f.call('PUT', `/api/reminders/${reminder.id}`, { expectedRevision: 1, note: `draft ${n}` })));
    expect(results.map(r => r.status).sort()).toEqual([200, 409, 409]);
  });

  it('snoozes to a later time and refuses a time already passed', async () => {
    const f = await fixture();
    const reminder = await f.add('Follow up with the tenant', START - HOUR);
    expect(reminder.state).toBe('due');
    const snoozed = await f.call('POST', `/api/reminders/${reminder.id}/snooze`, { expectedRevision: 1, dueAt: START + 3 * HOUR });
    expect((snoozed.body as { reminder: Reminder }).reminder).toMatchObject({ state: 'scheduled', dueAt: START + 3 * HOUR, revision: 2 });
    expect((await f.call('POST', `/api/reminders/${reminder.id}/snooze`, { expectedRevision: 2, dueAt: START - 1 })).status).toBe(400);
    expect((await f.call('POST', `/api/reminders/${reminder.id}/snooze`, { expectedRevision: 2 })).status).toBe(400);
    f.clock.now = START + 4 * HOUR;
    expect((await f.list()).reminders[0]).toMatchObject({ state: 'due', revision: 3 });
  });

  it('marks reminders missed while the app was closed as due on start, and the interval keeps marking them', async () => {
    const f = await fixture();
    const soon = await f.add('Lodge the bond', START + HOUR);
    const later = await f.add('Renew insurance', START + 5 * HOUR);
    f.service.close();
    // The app is closed past the first due time; a new process starts on the same storage.
    const restarted = await fixture({ directory: f.directory, workspaceId: f.workspaceId });
    restarted.clock.now = START + 2 * HOUR;
    restarted.service.start();
    await vi.waitFor(async () => {
      const stored = JSON.parse(await readFile(join(f.directory, 'reminders', (await readdir(join(f.directory, 'reminders'))).find(n => n.endsWith('.json'))!), 'utf8'));
      expect(stored.reminders.find((r: Reminder) => r.id === soon.id).state).toBe('due');
    }, SWEEP_WAIT);
    restarted.clock.now = START + 6 * HOUR;
    await vi.waitFor(async () => {
      const stored = JSON.parse(await readFile(join(f.directory, 'reminders', (await readdir(join(f.directory, 'reminders'))).find(n => n.endsWith('.json'))!), 'utf8'));
      expect(stored.reminders.find((r: Reminder) => r.id === later.id).state).toBe('due');
    }, SWEEP_WAIT);
    restarted.service.close();
    expect((await restarted.list()).reminders.map(r => r.state)).toEqual(['due', 'due']);
  });

  it('never runs a second sweep while a slow one is still going', async () => {
    const f = await fixture();
    await f.add('Lodge the bond', START + HOUR);
    let running = 0, most = 0;
    const real = privateJson.privateDirectory;
    const spy = vi.spyOn(privateJson, 'privateDirectory').mockImplementation(async (...args: Parameters<typeof real>) => {
      running += 1; most = Math.max(most, running);
      try { await new Promise(resolve => setTimeout(resolve, 60)); return await real(...args); } finally { running -= 1; }
    });
    try {
      f.service.start();
      await new Promise(resolve => setTimeout(resolve, 300));
      f.service.close();
      await vi.waitFor(() => expect(running).toBe(0));
    } finally { spy.mockRestore(); }
    expect(most).toBe(1);
  });

  it('keeps each member to their own reminders, and an id never crosses members', async () => {
    const f = await fixture({ member: 'member-a' });
    const mine = await f.add('Member A reminder', START + HOUR);
    f.clock.member = 'member-b';
    expect((await f.list()).reminders).toEqual([]);
    expect((await f.call('POST', `/api/reminders/${mine.id}/complete`, { expectedRevision: 1 })).status).toBe(404);
    expect((await f.call('PUT', `/api/reminders/${mine.id}`, { expectedRevision: 1, title: 'Taken' })).status).toBe(404);
    await f.add('Member B reminder', START + HOUR);
    f.clock.member = 'member-a';
    expect((await f.list()).reminders.map(r => r.title)).toEqual(['Member A reminder']);
    // Another workspace on the same storage sees none of them.
    const other = await fixture({ directory: f.directory, member: 'member-a' });
    expect((await other.list()).reminders).toEqual([]);
  });

  it('holds changes when storage is damaged, and never clears it', async () => {
    const f = await fixture();
    await f.add('Check smoke alarms', START + HOUR);
    const dir = join(f.directory, 'reminders');
    const name = (await readdir(dir)).find(n => n.endsWith('.json'))!;
    await writeFile(join(dir, name), '{"damaged":', { mode: 0o600 });
    const read = await f.call('GET');
    expect(read).toMatchObject({ status: 503, body: { code: 'reminders_recovery_required' } });
    expect((await f.call('POST', '/api/reminders', { title: 'New', dueAt: START + HOUR })).status).toBe(503);
    expect(await readFile(join(dir, name), 'utf8')).toBe('{"damaged":');
  });

  it('restores the last good copy when a saved file is damaged, keeping the damaged file', async () => {
    const f = await fixture();
    await f.add('Check smoke alarms', START + HOUR);
    await f.add('Chase the plumber invoice', START + 2 * HOUR);
    const dir = join(f.directory, 'reminders');
    const name = (await readdir(dir)).find(n => n.endsWith('.json'))!;
    await writeFile(join(dir, name), '{"damaged":', { mode: 0o600 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try { expect((await f.list()).reminders.map(r => r.title)).toEqual(['Check smoke alarms']); } finally { warn.mockRestore(); }
    expect((await readdir(dir)).some(n => n.startsWith(`${name}.damaged-`))).toBe(true);
  });

  it('creates a reminder for Bud with its thread as the source', async () => {
    const f = await fixture();
    const reminder = await f.service.createFromBud({ threadId: 'thread-fixture-1', title: 'Prepare the owner letter', note: 'From Ask', dueAt: START + HOUR });
    expect(reminder).toMatchObject({ createdBy: 'bud', source: { threadId: 'thread-fixture-1' }, state: 'scheduled', revision: 1 });
    expect((await f.list()).reminders[0]!.id).toBe(reminder.id);
    await expect(f.service.createFromBud({ threadId: '../escape', title: 'x', dueAt: START + HOUR })).rejects.toMatchObject({ status: 400 });
    await expect(f.service.createFromBud({ threadId: 'thread-fixture-1', title: ' ', dueAt: START + HOUR })).rejects.toMatchObject({ status: 400 });
  });
});

describe('reminders API validation and auth', () => {
  it('requires the session for every reminders route', () => {
    expect(needsSession('/api/reminders', 'GET')).toBe(true);
    expect(needsSession('/api/reminders', 'POST')).toBe(true);
    expect(needsSession(`/api/reminders/${randomUUID()}/complete`, 'POST')).toBe(true);
  });

  it.each([
    ['no title', { dueAt: START + HOUR }],
    ['a blank title', { title: '   ', dueAt: START + HOUR }],
    ['a long title', { title: 'x'.repeat(201), dueAt: START + HOUR }],
    ['a long note', { title: 'Ok', note: 'x'.repeat(2001), dueAt: START + HOUR }],
    ['a non-string note', { title: 'Ok', note: 5, dueAt: START + HOUR }],
    ['a string due time', { title: 'Ok', dueAt: '2026-10-02' }],
    ['a fractional due time', { title: 'Ok', dueAt: START + 0.5 }],
    ['a due time before 2020', { title: 'Ok', dueAt: Date.UTC(2019, 0, 1) }],
    ['a due time decades ahead', { title: 'Ok', dueAt: START + 20 * 366 * 24 * HOUR }],
    ['a body-supplied id', { id: randomUUID(), title: 'Ok', dueAt: START + HOUR }],
    ['a body-supplied state', { title: 'Ok', dueAt: START + HOUR, state: 'done' }],
    ['a body-supplied author', { title: 'Ok', dueAt: START + HOUR, createdBy: 'bud' }],
    ['no body', undefined],
  ])('rejects a create with %s', async (_label, body) => {
    const f = await fixture();
    const result = await f.call('POST', '/api/reminders', body);
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: 'invalid_reminder' });
    expect((await f.list()).reminders).toEqual([]);
  });

  it('rejects malformed ids, revisions, methods and unknown fields on changes', async () => {
    const f = await fixture();
    const reminder = await f.add('Water meter reading', START + HOUR);
    expect((await f.call('POST', '/api/reminders/not-an-id/complete', { expectedRevision: 1 })).status).toBe(404);
    expect((await f.call('POST', `/api/reminders/${randomUUID()}/complete`, { expectedRevision: 1 })).status).toBe(404);
    expect((await f.call('POST', `/api/reminders/${reminder.id}/complete`, { expectedRevision: '1' })).status).toBe(400);
    expect((await f.call('POST', `/api/reminders/${reminder.id}/complete`, {})).status).toBe(400);
    expect((await f.call('POST', `/api/reminders/${reminder.id}/complete`, { expectedRevision: 1, state: 'dismissed' })).status).toBe(400);
    expect((await f.call('PUT', `/api/reminders/${reminder.id}`, { expectedRevision: 1, createdBy: 'bud' })).status).toBe(400);
    expect((await f.call('GET', `/api/reminders/${reminder.id}/complete`)).status).toBe(405);
    expect((await f.call('POST', `/api/reminders/${reminder.id}`, { expectedRevision: 1 })).status).toBe(405);
    expect((await f.call('DELETE', '/api/reminders')).status).toBe(405);
    expect((await f.call('POST', `/api/reminders/${reminder.id}/run`, { expectedRevision: 1 })).status).toBe(404);
    expect(await f.service.handle('/api/remindersx', 'GET')).toBeNull();
    expect((await f.list()).reminders[0]).toMatchObject({ revision: 1, state: 'scheduled' });
  });
});
