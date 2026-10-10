import { describe, expect, it, vi } from 'vitest';
import { createNeedsYouHandler, readNeedsYou, type NeedsYouDeps } from './needs-you.ts';
import { needsSession } from './session-auth.ts';
import { NEEDS_YOU_AREA_LIMIT, parseNeedsYouSnapshot } from '../shared/needs-you.ts';
import type { MailScanReceipt, MailWorkItem } from '../shared/mail-ingestion.ts';
import type { BillFollowUp } from '../shared/bill-followups.ts';
import type { RoutineResult } from '../shared/routine-result.ts';
import type { LoopRun } from '../shared/contracts.ts';

const T = Date.parse('2026-10-09T08:00:00.000Z');
const at = (minutes: number) => new Date(T + minutes * 60_000).toISOString();
const hex = (n: number) => n.toString(16).padStart(64, '0');

const mailItem = (n: number, over: Partial<MailWorkItem> = {}): MailWorkItem => ({
  id: hex(n), revision: 1, accountId: 'fictional-account', threadId: 'a1', subject: `Fictional leak at ${n} Example St`,
  sourceMessageIds: [], sourceDigest: 'd', sourceReceiptId: 'r', disposition: 'action-review', priority: 'normal', owner: '',
  reason: 'A fictional tenant reports a leak.', nextAction: 'Call the fictional plumber', missingFacts: [], status: 'open', snoozedUntil: null,
  note: '', reviewed: false, newEvidence: false, firstSeenAt: T + n * 60_000, updatedAt: T, lastMessageAt: T, ...over,
});
const scan = (status: MailScanReceipt['status']): MailScanReceipt => ({ id: 's1', accountId: 'fictional-account', bindingRevision: '1',
  startedAt: T + 30 * 60_000, completedAt: T + 31 * 60_000, windowStartAt: T, windowEndAt: T, status, messageCount: 0, threadCount: 0, pages: 1, gaps: [], inputDigest: null });
/** Pages like the mail service, `size` items at a time; needsReview is deliberately large (the trap). */
const mail = (items: MailWorkItem[], latestScan: MailScanReceipt | null = null, size = 100): NeedsYouDeps['mail'] => ({
  get: async () => ({ latestScan }),
  page: async query => {
    const from = Number(query.cursor ?? 0), page = items.slice(from, from + size);
    return { version: 2, revision: 1, group: 'open', q: '', items: page, total: items.length, nextCursor: from + size < items.length ? String(from + size) : null,
      counts: { total: items.length, open: items.length, waiting: 0, reference: 0, snoozed: 0, done: 0, highPriority: 0, needsReview: 9 } };
  },
});

const followUp = (id: string, over: Partial<BillFollowUp> = {}): BillFollowUp => ({
  id, revision: 1, propertyId: 'FICT-1', label: 'Water · Fictional Water Co', state: 'missing-review', from: '2026-10-01', to: '2026-10-05',
  reason: 'No received bill is linked to this approved arrival.', evidenceKey: 'a'.repeat(64), active: true, firstSeenAt: T, status: 'open',
  owner: '', followUpOn: '', history: [], ...over,
});
const bills = (items: BillFollowUp[]): NeedsYouDeps['billFollowUps'] => async () => ({ status: 200,
  body: { version: 1, filter: 'open', items, total: items.length, counts: { open: items.length, resolved: 0 }, nextCursor: null } });
const weekly = (gaps: string[]) => ({ gaps, finishedAt: T + 5 * 60_000 }) as unknown as RoutineResult;

type W1 = Awaited<ReturnType<NeedsYouDeps['w1Status']>>;
type W1RunView = NonNullable<W1['run']>;
const w1Run = (over: Partial<W1RunView> = {}): W1RunView => ({ id: 'w1run_fictional', step: 'review', attention: null, updatedAt: at(40), ...over });
const w1 = (status: Partial<W1>): NeedsYouDeps['w1Status'] => async () => ({ run: null, working: false, ask: null, signIn: null, ...status });

const loopRun = (id: string, over: Partial<LoopRun> = {}): LoopRun => ({ id, loopId: 'morning-arrears', loopName: 'Morning arrears',
  scheduledFor: T, status: 'failed', manual: false, createdAt: T, startedAt: T, finishedAt: T + 60_000, ...over });

const deps = (over: Partial<NeedsYouDeps> = {}): NeedsYouDeps => ({
  selectedWorkflows: async () => ['bank-references', 'bills-calendar', 'morning-priorities'],
  mail: mail([]), billFollowUps: bills([]), weeklyBills: () => null, w1Status: w1({}),
  loops: () => ({ listRuns: () => [], recovery: { active: false } }), now: () => T + 3_600_000, ...over,
});
/** Every snapshot must pass the renderer's strict parser. */
const read = async (over: Partial<NeedsYouDeps> = {}) => {
  const snapshot = await readNeedsYou(deps(over));
  expect(parseNeedsYouSnapshot(snapshot)).toEqual(snapshot);
  return snapshot;
};

describe('Needs you: mail priorities', () => {
  it('lists only open-group items as review, and a broken scan as a problem', async () => {
    const snapshot = await read({ mail: mail([
      mailItem(1),
      mailItem(2, { disposition: 'waiting' }),
      mailItem(3, { disposition: 'reference' }),
      mailItem(4, { status: 'done' }),
      mailItem(5, { disposition: 'waiting', reviewed: true, newEvidence: true }), // a reply after review: back to open
      mailItem(6, { subject: '  ', reason: '', nextAction: '' }),
    ], scan('partial')) });
    expect(snapshot.items.map(item => item.key)).toEqual(['mail:scan', `mail:${hex(6)}`, `mail:${hex(5)}`, `mail:${hex(1)}`]);
    expect(snapshot.items[0]).toMatchObject({ level: 'problem', title: 'The last mail check was incomplete', foundAt: at(31) });
    expect(snapshot.items[3]).toEqual({ key: `mail:${hex(1)}`, area: 'mail', level: 'review', title: 'Fictional leak at 1 Example St',
      reason: 'A fictional tenant reports a leak.', next: 'Call the fictional plumber', foundAt: at(1) });
    expect(snapshot.items[1]).toMatchObject({ title: 'A conversation with no subject', next: 'Open it in Mail priorities' });
    // counts.needsReview (waiting for Bud to prepare) is never a person's review.
    expect(snapshot.counts).toEqual({ mail: { problem: 1, review: 3 } });
  });

  it('a complete scan is not a problem', async () => {
    expect((await read({ mail: mail([], scan('complete')) })).items).toEqual([]);
  });
});

describe('Needs you: bills and calendar', () => {
  it('lists open follow-ups with their latest recurrence time, and coverage gaps as a problem', async () => {
    const snapshot = await read({ weeklyBills: () => weekly(['fictional gap']), billFollowUps: bills([
      followUp('b1', { state: 'coverage-hold' }),
      followUp('b2', { state: 'review-hold', active: false, history: [
        { at: T + 10 * 60_000, action: 'recurred', note: 'Reopened.' }, { at: T + 20 * 60_000, action: 'recurred', note: 'Reopened.' }, { at: T + 30 * 60_000, action: 'planned', note: 'Planned.' },
      ] }),
      followUp('b3', { status: 'resolved' }),
    ]) });
    expect(snapshot.items.map(item => [item.key, item.level, item.foundAt])).toEqual([
      ['bills:coverage', 'problem', at(5)], ['bill:b2', 'review', at(20)], ['bill:b1', 'review', at(0)],
    ]);
    expect(snapshot.items[1]).toMatchObject({ title: 'FICT-1 · Water · Fictional Water Co', reason: 'No received bill is linked to this approved arrival. Not in the latest review.' });
    expect(snapshot.counts).toEqual({ bills: { problem: 1, review: 2 } });
  });

  it('a weekly result without gaps adds nothing', async () => {
    expect((await read({ weeklyBills: () => weekly([]) })).items).toEqual([]);
  });
});

describe('Needs you: bank references', () => {
  it('is not read when the office does not run the workflow', async () => {
    const w1Status = vi.fn(w1({ run: w1Run(), ask: { requestId: 'q' } }));
    const snapshot = await read({ selectedWorkflows: async () => ['bills-calendar'], w1Status });
    expect(w1Status).not.toHaveBeenCalled();
    expect(snapshot).toMatchObject({ items: [], counts: {}, unavailable: [] });
  });

  it.each([
    ['an open ask', { run: w1Run({ attention: { reason: 'sign_in', message: 'x' } }), working: true, ask: { requestId: 'q' } }, 'review', 'A bank import step needs your approval'],
    ['a REI sign-in wait', { run: w1Run({ step: 'sign_in' }), working: true, signIn: 'thread-1' }, 'problem', 'REI Cloud needs you to sign in'],
    ['a sign-in hold', { run: w1Run({ step: 'sign_in', attention: { reason: 'sign_in', message: 'Sign in to REI in the work browser, then continue.' } }) }, 'problem', 'The bank import is held'],
    ['an access hold', { run: w1Run({ step: 'fetch', attention: { reason: 'fetch_failed', message: 'The bank transactions could not be fetched. Try again.' } }) }, 'problem', 'The bank import is held'],
    ['rows to review', { run: w1Run({ step: 'readback', attention: { reason: 'pending_rows', message: 'Some payments are still pending in REI.' } }) }, 'review', 'The bank import is waiting for you'],
    ['a preview mismatch', { run: w1Run({ step: 'handoff', attention: { reason: 'preview_mismatch', message: "REI's preview does not match." } }) }, 'review', 'The bank import is waiting for you'],
    ['a pulled file to review', { run: w1Run() }, 'review', 'The bank import is waiting for you'],
  ] as const)('lists %s', async (_name, status, level, title) => {
    const snapshot = await read({ w1Status: w1(status as Partial<W1>) });
    expect(snapshot.items).toEqual([expect.objectContaining({ key: 'bank:w1run_fictional', area: 'bank', level, title, foundAt: at(40) })]);
    if ('attention' in status.run && status.run.attention && !('ask' in status)) expect(snapshot.items[0].reason).toBe(status.run.attention.message);
  });

  it.each([
    ['no run', {}], ['a finished run', { run: w1Run({ step: 'done' }) }], ['Bud working', { run: w1Run({ step: 'upload' }), working: true }],
  ] as const)('lists nothing for %s', async (_name, status) => {
    expect((await read({ w1Status: w1(status) })).items).toEqual([]);
  });
});

describe('Needs you: jobs', () => {
  const loops = (runs: LoopRun[], active = false): NeedsYouDeps['loops'] => () => ({ listRuns: () => runs, recovery: { active } });

  it('lists unseen problems in their area, else Schedule, and the schedule recovery hold', async () => {
    const snapshot = await read({ loops: loops([
      loopRun('r1', { status: 'missed' }),
      loopRun('r2', { loopId: 'weekly-bills', loopName: 'Weekly bills', status: 'interrupted', finishedAt: T + 2 * 60_000 }),
      loopRun('r3', { loopId: 'owner-letter', status: 'failed', seenAt: T }),
      loopRun('r4', { loopId: 'recipe-fictional', status: 'failed', jobRunId: 'job-1' }),
      loopRun('r5', { loopId: 'owner-letter', status: 'completed' }),
    ], true) });
    expect(snapshot.items.map(item => [item.key, item.area, item.level])).toEqual([
      ['loop:r2', 'bills', 'problem'], ['loop:r1', 'schedule', 'problem'], ['schedule:recovery', 'schedule', 'problem'],
    ]);
    expect(snapshot.items[1]).toMatchObject({ title: 'Morning arrears', reason: 'A run of this job was missed, so it checked nothing.', next: 'Open the run in Schedule', foundAt: at(1) });
  });

  it('picks the most serious unseen run per job, then the newest, as Schedule does', async () => {
    const snapshot = await read({ loops: loops([
      loopRun('new-wait', { status: 'awaiting-approval', startedAt: T + 50 * 60_000, finishedAt: undefined }),
      loopRun('old-fail', { status: 'failed' }),
      loopRun('newer-fail', { status: 'partial', startedAt: T + 10 * 60_000, finishedAt: undefined }),
    ]) });
    expect(snapshot.items).toEqual([expect.objectContaining({ key: 'loop:newer-fail', level: 'problem', foundAt: at(10) })]);
  });

  it('shows an approval wait once when its area already lists it', async () => {
    const waiting = [
      loopRun('bank-wait', { loopId: 'bank-references', loopName: 'Bank references', status: 'awaiting-approval' }),
      loopRun('maintenance-wait', { loopId: 'maintenance-review', loopName: 'Maintenance check', status: 'awaiting-approval' }),
      loopRun('arrears-wait', { status: 'awaiting-approval' }),
    ];
    const withBank = await read({ loops: loops(waiting), w1Status: w1({ run: w1Run(), ask: { requestId: 'q' } }), billFollowUps: bills([followUp('b1')]) });
    expect(withBank.items.map(item => item.key).sort()).toEqual(['bank:w1run_fictional', 'bill:b1', 'loop:arrears-wait', 'loop:maintenance-wait']);
    const withoutBank = await read({ loops: loops(waiting) });
    expect(withoutBank.items.map(item => item.key).sort()).toEqual(['loop:arrears-wait', 'loop:bank-wait', 'loop:maintenance-wait']);
    expect(withoutBank.items.find(item => item.key === 'loop:bank-wait')).toMatchObject({ area: 'bank', level: 'review', next: 'Review the run in Schedule' });
  });
});

describe('Needs you: order, limits and failures', () => {
  it('puts problems first, newest first with no time last, at most the limit per area, with full counts', async () => {
    const many = Array.from({ length: NEEDS_YOU_AREA_LIMIT + 5 }, (_, i) => mailItem(i + 1));
    const snapshot = await read({ mail: mail(many, scan('failed'), 10), billFollowUps: bills([followUp('b1', { firstSeenAt: T + 999 * 60_000 })]),
      loops: () => ({ listRuns: () => [loopRun('r1')], recovery: { active: true } }) });
    expect(snapshot.items.slice(0, 3).map(item => item.key)).toEqual(['mail:scan', 'loop:r1', 'schedule:recovery']);
    expect(snapshot.items[3].key).toBe('bill:b1');
    const mailShown = snapshot.items.filter(item => item.area === 'mail');
    expect(mailShown).toHaveLength(NEEDS_YOU_AREA_LIMIT);
    expect(mailShown.slice(1, 3).map(item => item.key)).toEqual([`mail:${hex(25)}`, `mail:${hex(24)}`]);
    expect(snapshot.counts).toEqual({ mail: { problem: 1, review: 25 }, bills: { review: 1, problem: 0 }, schedule: { problem: 2, review: 0 } });
  });

  it('lists a source that cannot be read as unavailable, without its error text, and keeps the others', async () => {
    const snapshot = await read({
      mail: { get: async () => { throw new Error('SQLITE_CORRUPT at /synthetic/realbud/mail.db'); }, page: async () => { throw new Error('unreachable'); } },
      w1Status: async () => { throw new Error('fictional internal failure'); },
      billFollowUps: bills([followUp('b1')]),
    });
    expect(snapshot.unavailable).toEqual([{ area: 'mail', reason: "Mail priorities couldn't be checked." }, { area: 'bank', reason: "Bank references couldn't be checked." }]);
    expect(snapshot.items.map(item => item.key)).toEqual(['bill:b1']);
    expect(JSON.stringify(snapshot)).not.toMatch(/SQLITE|synthetic|internal failure/);
  });

  it('turns a malformed source into unavailable, not a crash, listing each area once', async () => {
    const snapshot = await read({
      billFollowUps: async () => ({ status: 200, body: { version: 1, items: 'nope' } }),
      weeklyBills: () => { throw new Error('The saved routine result needs recovery.'); },
      w1Status: w1({ run: w1Run({ id: 42 as unknown as string }) }),
      loops: () => ({ listRuns: () => [loopRun('r1', { loopName: 7 as unknown as string })], recovery: { active: false } }),
    });
    expect(snapshot.unavailable.map(entry => entry.area)).toEqual(['bills', 'bank']);
    expect(snapshot.items).toEqual([expect.objectContaining({ key: 'loop:r1', title: 'A scheduled job' })]);
    const failedHandler = await read({ billFollowUps: async () => ({ status: 503, body: { error: 'The saved bill follow-ups need recovery.' } }), weeklyBills: () => weekly(['gap']) });
    expect(failedHandler.unavailable).toEqual([{ area: 'bills', reason: "Bills and calendar couldn't be checked." }]);
    expect(failedHandler.items.map(item => item.key)).toEqual(['bills:coverage']);
  });
});

describe('GET /api/needs-you', () => {
  it('answers GET only, behind the session gate', async () => {
    const handler = createNeedsYouHandler(deps());
    const result = await handler.handle('/api/needs-you', 'GET');
    expect(result?.status).toBe(200);
    expect(parseNeedsYouSnapshot(result?.body)).toEqual({ checkedAt: new Date(T + 3_600_000).toISOString(), items: [], counts: {}, unavailable: [] });
    expect(await handler.handle('/api/needs-you', 'POST')).toEqual({ status: 405, body: { error: 'Needs you is read-only.' } });
    expect(await handler.handle('/api/needs-you/other', 'GET')).toBeNull();
    expect(needsSession('/api/needs-you', 'GET')).toBe(true);
  });
});
