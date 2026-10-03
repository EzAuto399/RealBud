import { describe, expect, it } from 'vitest';
import {
  dueAtFromWallInput, parseReminder, parseRemindersResponse, reminderDueAt, reminderNote, reminderStateAt, reminderTitle, snoozeDueAt, sortReminders,
  wallInputFromDueAt, type Reminder,
} from './reminders.ts';

const NOW = Date.UTC(2026, 9, 2, 1, 0); // Fri 2 Oct 2026, 11:00 in Brisbane
const base: Reminder = { id: '00000000-0000-4000-8000-000000000001', title: 'Call the owner', note: '', dueAt: NOW + 60_000, createdBy: 'person', state: 'scheduled', createdAt: NOW, updatedAt: NOW, revision: 1 };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('reminder validation', () => {
  it('normalises title and note and throws user-facing sentences', () => {
    expect(reminderTitle('  Call   the\nowner ')).toBe('Call the owner');
    expect(() => reminderTitle('')).toThrow('Give the reminder a title.');
    expect(() => reminderTitle('x'.repeat(201))).toThrow(/200 characters/);
    expect(reminderNote(undefined)).toBe('');
    expect(reminderNote(' a\r\nb ')).toBe('a\nb');
    expect(() => reminderNote('x'.repeat(2001))).toThrow(/2000 characters/);
    expect(() => reminderDueAt('2026-10-02', NOW)).toThrow('Choose a valid date and time for the reminder.');
    expect(reminderDueAt(NOW, NOW)).toBe(NOW);
  });

  it('parses strictly: unknown keys, bad states, bad sources and duplicate ids reject', () => {
    expect(parseReminder(base)).toEqual(base);
    expect(parseReminder({ ...base, source: { threadId: 'thread-1' } })).toMatchObject({ source: { threadId: 'thread-1' } });
    expect(parseReminder({ ...base, extra: true })).toBeNull();
    expect(parseReminder({ ...base, state: 'sent' })).toBeNull();
    expect(parseReminder({ ...base, revision: 0 })).toBeNull();
    expect(parseReminder({ ...base, title: ' padded ' })).toBeNull();
    expect(parseReminder({ ...base, source: {} })).toBeNull();
    expect(parseReminder({ ...base, source: { threadId: '../x' } })).toBeNull();
    expect(parseRemindersResponse({ version: 1, reminders: [base], timeZone: null })).not.toBeNull();
    expect(parseRemindersResponse({ version: 1, reminders: [base, base], timeZone: null })).toBeNull();
    expect(parseRemindersResponse({ version: 1, reminders: [], timeZone: 'Mars/Base' })).toBeNull();
    expect(parseRemindersResponse({ version: 1, reminders: [] })).toBeNull();
  });

  it('sorts due before scheduled, soonest first, closed last', () => {
    const due = { ...base, id: id(2), state: 'due' as const, dueAt: NOW + 5 };
    const done = { ...base, id: id(3), state: 'done' as const };
    const soon = { ...base, id: id(4), dueAt: NOW + 1 };
    expect(sortReminders([done, base, soon, due]).map(r => r.id)).toEqual([id(2), id(4), base.id, id(3)]);
    expect(reminderStateAt(base, base.dueAt)).toBe('due');
    expect(reminderStateAt({ ...base, state: 'dismissed' }, base.dueAt + 1)).toBe('dismissed');
  });
});

describe('office wall time and snooze presets', () => {
  it('reads a picker value in the office zone, round-tripping', () => {
    const at = dueAtFromWallInput('2026-10-05T09:00', 'Australia/Brisbane')!;
    expect(at).toBe(Date.UTC(2026, 9, 4, 23, 0));
    expect(wallInputFromDueAt(at, 'Australia/Brisbane')).toBe('2026-10-05T09:00');
    expect(dueAtFromWallInput('2026-02-30T09:00', 'Australia/Brisbane')).toBeNull();
    expect(dueAtFromWallInput('tomorrow', 'Australia/Brisbane')).toBeNull();
    // Across a daylight-saving change (Sydney moves forward on 4 Oct 2026).
    expect(wallInputFromDueAt(dueAtFromWallInput('2026-10-05T09:00', 'Australia/Sydney')!, 'Australia/Sydney')).toBe('2026-10-05T09:00');
  });

  it('computes later today, tomorrow 9am and next Monday 9am in the office zone', () => {
    expect(snoozeDueAt('later-today', NOW, 'Australia/Brisbane')).toBe(NOW + 3 * 60 * 60_000);
    expect(snoozeDueAt('later-today', NOW + 60_000, 'Australia/Brisbane')).toBe(NOW + 3 * 60 * 60_000 + 15 * 60_000);
    expect(wallInputFromDueAt(snoozeDueAt('tomorrow', NOW, 'Australia/Brisbane'), 'Australia/Brisbane')).toBe('2026-10-03T09:00');
    expect(wallInputFromDueAt(snoozeDueAt('next-week', NOW, 'Australia/Brisbane'), 'Australia/Brisbane')).toBe('2026-10-05T09:00');
    // On a Monday, next week is the following Monday.
    const monday = Date.UTC(2026, 9, 5, 1, 0);
    expect(wallInputFromDueAt(snoozeDueAt('next-week', monday, 'UTC'), 'UTC')).toBe('2026-10-12T09:00');
  });
});
