import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoopRun } from '@shared/contracts';
import { coreOfficeDesk, type DeskAreaId, type NoticeLevel } from '@shared/desk-areas';
import type { NeedsYouItem, NeedsYouSnapshot } from '@shared/needs-you';
import { officeDefaultSections, type WorkspaceTabsResponse } from '@shared/workspace-tabs';
import { SHOW_DESK_EVENT, shownArea } from './notify-desktop';
import { notifyRoutineRun } from './notify-routine';

// The layout this window last read, and a Needs you store whose next read answers `next`.
const fake = vi.hoisted(() => ({
  tabs: null as unknown,
  state: { snapshot: null as unknown, error: null as string | null, checking: false },
  next: null as unknown,
  listeners: new Set<() => void>(),
  reads: 0,
  /** The read joined one already in flight: it lands first, and the one queued behind it after a tick. */
  queued: null as unknown,
}));
vi.mock('./workspace-tabs', () => ({ lastWorkspaceTabs: () => fake.tabs }));
vi.mock('./needs-you', () => ({
  getNeedsYou: () => fake.state,
  subscribeNeedsYou: (listener: () => void) => { fake.listeners.add(listener); return () => { fake.listeners.delete(listener); }; },
  refreshNeedsYou: async () => {
    fake.reads++;
    if (fake.queued) {
      fake.state = { snapshot: fake.queued, error: null, checking: true };
      fake.queued = null;
      setTimeout(() => { fake.state = { snapshot: fake.next, error: null, checking: false }; fake.listeners.forEach(listener => listener()); }, 0);
      return;
    }
    fake.state = fake.next ? { snapshot: fake.next, error: null, checking: false } : { ...fake.state, error: 'Needs you could not be checked. Refresh to try again.', checking: false };
    fake.listeners.forEach(listener => listener());
  },
}));
afterEach(() => { vi.unstubAllGlobals(); fake.tabs = null; fake.next = null; fake.queued = null; fake.state = { snapshot: null, error: null, checking: false }; fake.reads = 0; });
it('notifies only settled changed routine results and deduplicates a repeated event', () => {
  const notices: unknown[] = [];
  class FakeNotification { static permission = 'granted'; constructor(title: unknown, options: unknown) { notices.push({ title, options }); } }
  vi.stubGlobal('Notification', FakeNotification);
  const run = { id: 'fictional-run-notify', loopId: 'weekly-bills', loopName: 'Weekly bills review', status: 'running', detail: '2 bill candidates prepared.' } as LoopRun;
  notifyRoutineRun(run); expect(notices).toHaveLength(0);
  run.status = 'awaiting-approval'; notifyRoutineRun(run); notifyRoutineRun(run); expect(notices).toHaveLength(1);
  notifyRoutineRun({ ...run, id: 'fictional-unchanged', seenAt: 1 }); expect(notices).toHaveLength(1);
  notifyRoutineRun({ ...run, id: 'fictional-default', status: 'failed', detail: 'Gmail needs sign-in.' });
  notifyRoutineRun({ ...run, id: 'fictional-repeat-hold', status: 'failed', detail: 'Gmail needs sign-in.' }); expect(notices).toHaveLength(2);
  FakeNotification.permission = 'default'; notifyRoutineRun({ ...run, id: 'fictional-no-permission' }); expect(notices).toHaveLength(2);
});
it('notifies Sherry once for new maintenance findings and stays quiet on an unchanged rescan', () => {
  const notices: unknown[] = [];
  class FakeNotification { static permission = 'granted'; constructor(title: unknown, options: unknown) { notices.push({ title, options }); } }
  vi.stubGlobal('Notification', FakeNotification);
  const run = { id: 'fictional-maintenance', loopId: 'maintenance-review', loopName: 'Maintenance checks', status: 'completed', detail: '1 new finding.' } as LoopRun;
  notifyRoutineRun(run); notifyRoutineRun(run); expect(notices).toHaveLength(1);
  notifyRoutineRun({ ...run, id: 'fictional-maintenance-rescan', seenAt: 1 }); expect(notices).toHaveLength(1);
});
it('notifies once when the scheduled supplier check finds a change, and stays quiet when REI is unchanged', () => {
  const notices: unknown[] = [];
  class FakeNotification { static permission = 'granted'; constructor(title: unknown, options: unknown) { notices.push({ title, options }); } }
  vi.stubGlobal('Notification', FakeNotification);
  const run = { id: 'fictional-supplier-check', loopId: 'rei-supplier-check', loopName: 'Supplier list check', status: 'awaiting-approval', detail: 'Supplier list changed in REI: 1 added — review.' } as LoopRun;
  notifyRoutineRun(run); notifyRoutineRun({ ...run, id: 'fictional-supplier-unchanged', status: 'completed', seenAt: 1 });
  expect(notices).toEqual([{ title: 'Supplier list check', options: expect.objectContaining({ body: 'Supplier list changed in REI: 1 added — review.' }) }]);
});
it('tells the property manager once when the monthly inspection draft is ready', () => {
  const notices: unknown[] = [];
  class FakeNotification { static permission = 'granted'; constructor(title: unknown, options: unknown) { notices.push({ title, options }); } }
  vi.stubGlobal('Notification', FakeNotification);
  const run = { id: 'fictional-inspection-draft', loopId: 'inspection-draft', loopName: 'Inspection draft', status: 'awaiting-approval', detail: 'New inspection draft ready to review: 4 to accept, 1 held. Nothing is booked.' } as LoopRun;
  notifyRoutineRun(run); notifyRoutineRun(run);
  expect(notices).toEqual([{ title: 'Inspection draft', options: expect.objectContaining({ body: expect.stringMatching(/^New inspection draft ready to review/) }) }]);
});
it('notifies once while a run waits at REI sign-in, once more for the midday reminder, never for a restart\'s same line, and for the miss', () => {
  const notices: Array<{ options: { body: string } }> = [];
  class FakeNotification { static permission = 'granted'; onclick: unknown = null; constructor(_title: unknown, options: { body: string }) { notices.push({ options }); } }
  vi.stubGlobal('Notification', FakeNotification);
  const line = 'Sign in to REI Cloud so Bud can finish the bank import. (waiting until 6:00 pm on Tue, 6 Oct).';
  const run = { id: 'fictional-bank-wait', loopId: 'bank-references', loopName: 'Bank reference review', status: 'running', detail: line } as LoopRun;
  notifyRoutineRun(run); notifyRoutineRun(run);
  notifyRoutineRun({ ...run, detail: 'Reminder: sign in to REI Cloud so Bud can finish the bank import.' });
  notifyRoutineRun({ ...run, id: 'fictional-bank-resumed', detail: 'Reminder: sign in to REI Cloud so Bud can finish the bank import.' });
  notifyRoutineRun({ ...run, status: 'missed', detail: "Missed: REI Cloud wasn't signed in today." });
  notifyRoutineRun({ ...run, id: 'fictional-bank-done', status: 'completed', detail: 'Bank import confirmed.' });
  expect(notices.map(n => n.options.body)).toEqual([line, 'Reminder: sign in to REI Cloud so Bud can finish the bank import.', "Missed: REI Cloud wasn't signed in today."]);
});

type Notice = { title: string; body: string; tag: string; click(): void };
function capture() {
  const notices: Notice[] = [];
  class FakeNotification {
    static permission = 'granted'; onclick: (() => void) | null = null;
    constructor(title: string, options: { body: string; tag: string }) { notices.push({ title, ...options, click: () => this.onclick?.() }); }
    close() {}
  }
  vi.stubGlobal('Notification', FakeNotification);
  const win = Object.assign(new EventTarget(), { focus: () => {} });
  vi.stubGlobal('window', win);
  const opened: unknown[] = [];
  win.addEventListener(SHOW_DESK_EVENT, event => opened.push(shownArea(event)));
  return { notices, opened };
}
const office = coreOfficeDesk(['bank-references']);
const layout = (levels: Partial<Record<DeskAreaId, NoticeLevel>>) => ({ office, recovery: null,
  state: { desk: { sections: officeDefaultSections(office).map(section => levels[section.id as DeskAreaId] ? { ...section, notify: levels[section.id as DeskAreaId] } : section) } } }) as unknown as WorkspaceTabsResponse;
const mailRun = (id: string, status = 'awaiting-approval') => ({ id, loopId: 'inbound-triage', loopName: 'Morning priorities', status, detail: '2 conversations need you.' }) as LoopRun;
const item = (key: string, title = `Fictional subject ${key}`, area: NeedsYouItem['area'] = 'mail', level: NeedsYouItem['level'] = 'review'): NeedsYouItem =>
  ({ key, area, level, title, reason: 'Bud marked this conversation for your review.', next: 'Open it in Mail priorities', foundAt: null });
const snapshot = (items: NeedsYouItem[], unavailable: NeedsYouSnapshot['unavailable'] = []): NeedsYouSnapshot => ({ checkedAt: new Date(0).toISOString(), items, counts: {}, unavailable });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('per-area notice levels', () => {
  it('One summary per run: one notice per settled run that opens its work area', () => {
    const { notices, opened } = capture();
    fake.tabs = layout({});
    notifyRoutineRun(mailRun('fictional-summary', 'running')); notifyRoutineRun(mailRun('fictional-summary')); notifyRoutineRun(mailRun('fictional-summary'));
    expect(notices.map(n => [n.title, n.body])).toEqual([['Morning priorities', '2 conversations need you.']]);
    notices[0]!.click();
    expect(opened).toEqual(['mail']);
    expect(fake.reads).toBe(0);
  });

  it('Problems only: findings stay quiet, but a held or partial run always notifies, once per change', () => {
    const { notices, opened } = capture();
    fake.tabs = layout({ mail: 'off', bills: 'off' });
    notifyRoutineRun(mailRun('fictional-off-found'));
    notifyRoutineRun({ ...mailRun('fictional-off-done'), status: 'completed' });
    expect(notices).toHaveLength(0);
    notifyRoutineRun({ ...mailRun('fictional-off-fail'), status: 'failed', detail: 'Gmail needs sign-in.' });
    notifyRoutineRun({ ...mailRun('fictional-off-fail-again'), status: 'failed', detail: 'Gmail needs sign-in.' });
    notifyRoutineRun({ id: 'fictional-off-partial', loopId: 'weekly-bills', loopName: 'Weekly bills review', status: 'partial', detail: 'Some mail could not be read.' } as LoopRun);
    expect(notices.map(n => n.body)).toEqual(['Gmail needs sign-in.', 'Some mail could not be read.']);
    notices.forEach(n => n.click());
    expect(opened).toEqual(['mail', 'bills']);
  });

  it('Bank references follows its area: Problems only by default, its level once set, and Schedule when the office does not show it', () => {
    const { notices, opened } = capture();
    const bank = (id: string, status = 'completed') => ({ id, loopId: 'bank-references', loopName: 'Bank reference review', status, detail: 'Bank import confirmed.' }) as LoopRun;
    fake.tabs = layout({});
    notifyRoutineRun(bank('fictional-bank-default'));
    expect(notices).toHaveLength(0);
    fake.tabs = layout({ bank: 'summary' });
    notifyRoutineRun(bank('fictional-bank-summary'));
    fake.tabs = null; // Before the layout is read: the core preset, where Bank references is not shown.
    notifyRoutineRun(bank('fictional-bank-quiet'));
    notifyRoutineRun({ ...bank('fictional-bank-held', 'failed'), detail: 'The bank transactions could not be fetched.' });
    expect(notices.map(n => n.body)).toEqual(['Bank import confirmed.', 'The bank transactions could not be fetched.']);
    notices.forEach(n => n.click());
    expect(opened).toEqual(['bank', 'schedule']);
  });

  it('a job in no area keeps its catalog flag and still opens Tasks', () => {
    const { notices, opened } = capture();
    fake.tabs = layout({ mail: 'off', bills: 'off', bank: 'off' });
    notifyRoutineRun({ id: 'fictional-taught', loopId: 'recipe-fictional', loopName: 'Fictional taught job', status: 'completed', detail: 'Done.' } as unknown as LoopRun);
    notifyRoutineRun({ id: 'fictional-rent', loopId: 'morning-arrears', loopName: 'Morning rent check', status: 'completed', detail: 'Checked.' } as LoopRun);
    expect(notices.map(n => n.title)).toEqual(['Fictional taught job']);
    notices[0]!.click();
    expect(opened).toEqual([null]);
  });
});

describe('Each new item', () => {
  it('the first read after app start is a baseline; later runs tell each new item, three at most, then how many more, never a mail subject', async () => {
    vi.resetModules();
    const { notifyRoutineRun: notify } = await import('./notify-routine');
    const { notices, opened } = capture();
    fake.tabs = layout({ mail: 'each' });
    // Desk's first read after start: what it already holds is never announced.
    fake.state = { snapshot: snapshot([item('mail:old')]), error: null, checking: false };
    fake.listeners.forEach(listener => listener());
    fake.next = snapshot([item('mail:a', 'Lease renewal for 4 Fictional St, invoice $1,250.00, BSB 062-000 12345678'), item('mail:b'), item('mail:c'), item('mail:d'), item('mail:e'), item('mail:old'),
      item('mail:scan', 'The last mail check was incomplete', 'mail', 'problem'), item('bill:x', 'Fictional bill', 'bills')]);
    notify(mailRun('fictional-each-1'));
    notify(mailRun('fictional-each-1'));
    await settle();
    expect(fake.reads).toBe(1);
    // A mail item's subject never reaches the OS notification: each notice says what it is, and opens Mail priorities.
    expect(notices.map(n => [n.title, n.body, n.tag])).toEqual([
      ['Mail priorities', 'New conversation to review', 'realbud-mail:a'], ['Mail priorities', 'New conversation to review', 'realbud-mail:b'],
      ['Mail priorities', 'New conversation to review', 'realbud-mail:c'], ['Mail priorities', 'And 2 more', 'realbud-mail-more'],
    ]);
    expect(new Set(notices.map(n => n.tag)).size).toBe(4);
    notices.forEach(n => n.click());
    expect(opened).toEqual(['mail', 'mail', 'mail', 'mail']);
    // The next run tells only what is new since.
    fake.next = snapshot([item('mail:f'), item('mail:a'), item('mail:b')]);
    notify(mailRun('fictional-each-2'));
    await settle();
    expect(notices.slice(4).map(n => [n.body, n.tag])).toEqual([['New conversation to review', 'realbud-mail:f']]);
  });

  it('switching an area to Each new item announces only what arrives after the switch', async () => {
    vi.resetModules();
    const { notifyRoutineRun: notify } = await import('./notify-routine');
    const { notices } = capture();
    fake.tabs = layout({ mail: 'summary' });
    const read = (items: NeedsYouItem[]) => { fake.state = { snapshot: snapshot(items), error: null, checking: false }; fake.listeners.forEach(listener => listener()); };
    read([item('mail:a')]);
    read([item('mail:b'), item('mail:a')]);
    notify(mailRun('fictional-before-switch'));
    expect(notices.map(n => n.body)).toEqual(['2 conversations need you.']);
    fake.tabs = layout({ mail: 'each' });
    fake.next = snapshot([item('mail:c'), item('mail:b'), item('mail:a')]);
    notify(mailRun('fictional-after-switch'));
    await settle();
    expect(notices.slice(1).map(n => n.tag)).toEqual(['realbud-mail:c']);
  });

  it('masks every amount and account number in a bill title but keeps house numbers and dates', async () => {
    vi.resetModules();
    const { notifyRoutineRun: notify } = await import('./notify-routine');
    const { notices } = capture();
    fake.tabs = layout({ bills: 'each' });
    fake.state = { snapshot: snapshot([]), error: null, checking: false };
    fake.listeners.forEach(listener => listener());
    const bill = (key: string, title: string) => item(key, title, 'bills');
    const run = (id: string) => ({ id, loopId: 'weekly-bills', loopName: 'Weekly bills review', status: 'awaiting-approval', detail: 'Bills prepared.' }) as LoopRun;
    fake.next = snapshot([bill('bill:a', 'Arrears 2400 for 12 Oak St'), bill('bill:b', 'Rent 1,250 overdue'), bill('bill:c', 'AUD 980 bond')]);
    notify(run('fictional-amounts'));
    await settle();
    fake.next = snapshot([bill('bill:d', 'Rent review 2026-10-10 and 9/10/2026, due 10/10/2026, ref 12345678, $480 a week'),
      bill('bill:e', 'Invoice $1,250.00 for 4 Fictional St, BSB 062-000 12345678, unit 7')]);
    notify(run('fictional-dates'));
    await settle();
    expect(notices.map(n => [n.title, n.body])).toEqual([
      ['Bills and calendar', 'Arrears … for 12 Oak St'], ['Bills and calendar', 'Rent … overdue'], ['Bills and calendar', 'AUD … bond'],
      ['Bills and calendar', 'Rent review 2026-10-10 and 9/10/2026, due 10/10/2026, ref …, … a week'], ['Bills and calendar', 'Invoice … for 4 Fictional St, BSB …, unit 7'],
    ]);
  });

  it('after a restart with no earlier read, the first run sends its one run notice and becomes the baseline', async () => {
    vi.resetModules();
    const { notifyRoutineRun: notify } = await import('./notify-routine');
    const { notices } = capture();
    fake.tabs = layout({ mail: 'each' });
    fake.next = snapshot([item('mail:a'), item('mail:b')]);
    notify(mailRun('fictional-restart-1'));
    await settle();
    expect(notices.map(n => [n.body, n.tag])).toEqual([['2 conversations need you.', 'realbud-inbound-triage']]);
    fake.next = snapshot([item('mail:c'), item('mail:a'), item('mail:b')]);
    notify(mailRun('fictional-restart-2'));
    await settle();
    expect(notices.slice(1).map(n => [n.body, n.tag])).toEqual([['New conversation to review', 'realbud-mail:c']]);
  });

  it('waits for the read queued behind one already in flight, which may predate the run', async () => {
    vi.resetModules();
    const { notifyRoutineRun: notify } = await import('./notify-routine');
    const { notices } = capture();
    fake.tabs = layout({ mail: 'each' });
    fake.state = { snapshot: snapshot([item('mail:a')]), error: null, checking: false };
    fake.listeners.forEach(listener => listener());
    fake.queued = snapshot([item('mail:a')]);
    fake.next = snapshot([item('mail:b'), item('mail:a')]);
    notify(mailRun('fictional-queued'));
    await vi.waitFor(() => expect(notices.map(n => n.tag)).toEqual(['realbud-mail:b']));
  });

  it('when Needs you cannot be read, or cannot check the area, one notice says the run settled', async () => {
    vi.resetModules();
    const { notifyRoutineRun: notify } = await import('./notify-routine');
    const { notices } = capture();
    fake.tabs = layout({ mail: 'each' });
    fake.next = snapshot([], [{ area: 'mail', reason: 'Mail could not be read.' }]);
    notify(mailRun('fictional-unreadable'));
    await settle();
    fake.next = null;
    notify(mailRun('fictional-read-failed'));
    await settle();
    expect(notices.map(n => n.body)).toEqual(['2 conversations need you.', '2 conversations need you.']);
  });

  it('a problem still notifies once for the run, not per item', async () => {
    vi.resetModules();
    const { notifyRoutineRun: notify } = await import('./notify-routine');
    const { notices } = capture();
    fake.tabs = layout({ mail: 'each' });
    notify({ ...mailRun('fictional-each-fail'), status: 'missed', detail: 'Missed: the computer was off.' });
    await settle();
    expect(fake.reads).toBe(0);
    expect(notices.map(n => n.body)).toEqual(['Missed: the computer was off.']);
  });
});
