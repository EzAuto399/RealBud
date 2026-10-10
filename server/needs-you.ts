// GET /api/needs-you: what needs a person across the office's workflows,
// projected on each read from each workflow's own store (shared/needs-you.ts).
// Read-only. Each source is read on its own: one that fails is listed as
// unavailable with a fixed sentence, never as empty, and its error text is never forwarded.
import { areaForLoop } from '../shared/desk-areas.ts';
import { mailWorkGroup, type MailScanReceipt, type MailScanStatus, type MailTaskPage, type MailTaskPageQuery } from '../shared/mail-ingestion.ts';
import { readBillFollowUpPage, type BillFollowUp } from '../shared/bill-followups.ts';
import { NEEDS_YOU_AREA_LIMIT, parseNeedsYouSnapshot, type NeedsYouArea, type NeedsYouItem, type NeedsYouLevel, type NeedsYouSnapshot } from '../shared/needs-you.ts';
import type { RoutineResult } from '../shared/routine-result.ts';
import type { LoopRun, LoopRunStatus } from '../shared/contracts.ts';
import type { W1Run } from './w1-state.ts';

export type NeedsYouDeps = {
  /** Agency setup's selected workflows: Bank references is read only for an office that runs it. */
  selectedWorkflows: () => Promise<readonly string[]>;
  /** The service behind /api/mail-workspace and /api/mail-workspace/items. */
  mail: { get(): Promise<{ latestScan: MailScanReceipt | null }>; page(query: MailTaskPageQuery): Promise<MailTaskPage> };
  /** The /api/bill-register/followups handler. */
  billFollowUps: (url: URL, method: string) => Promise<{ status: number; body: unknown }>;
  /** The latest weekly bills result, as /api/bill-register/routine reads it. */
  weeklyBills: () => RoutineResult | null;
  /** The W1 host's /api/w1/status. */
  w1Status: () => Promise<{ run: Pick<W1Run, 'id' | 'step' | 'attention' | 'updatedAt'> | null; working: boolean; ask: unknown; signIn: string | null }>;
  /** The schedule behind /api/loops. */
  loops: () => { listRuns(): readonly LoopRun[]; readonly recovery: { active: boolean } };
  now?: () => number;
};

type SourceArea = Exclude<NeedsYouArea, 'shared-work'>;
const UNAVAILABLE: Record<SourceArea, string> = {
  mail: "Mail priorities couldn't be checked.", bills: "Bills and calendar couldn't be checked.",
  bank: "Bank references couldn't be checked.", schedule: "Scheduled jobs couldn't be checked.",
};
const SCAN_PROBLEM: Partial<Record<MailScanStatus, string>> = {
  partial: 'The last mail check was incomplete', failed: 'The last mail check failed', interrupted: 'The last mail check was interrupted',
};
/** W1 attention reasons that are findings for a person to decide; any other reason holds the run (a problem). */
const BANK_REVIEW = new Set(['pending_rows', 'rejected_rows', 'preview_mismatch', 'nothing_found', 'nothing_to_import']);
/** The FAILURE_WORDS statuses of src/lib/schedule-rows.ts. */
const LOOP_PROBLEM: Partial<Record<LoopRunStatus, string>> = {
  failed: 'A run of this job failed.', missed: 'A run of this job was missed, so it checked nothing.',
  interrupted: 'A run of this job stopped before it finished.', partial: "A run of this job didn't check everything.",
};
/** Jobs whose approval wait is their area's own items read here, so it shows once. */
const OWN_LOOPS = new Set(['inbound-triage', 'weekly-bills', 'bank-references']);

const malformed = (): never => { throw new Error('Malformed source.'); };
const clip = (value: unknown, max: number, fallback: string) => {
  const line = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return !line ? fallback : line.length <= max ? line : `${line.slice(0, max - 1)}…`;
};
const iso = (value: unknown): string | null => {
  const ms = typeof value === 'string' ? Date.parse(value) : value;
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 && ms <= 8.64e15 ? new Date(ms).toISOString() : null;
};
const key = (source: string, id: unknown) => typeof id === 'string' && id ? `${source}:${id}` : malformed();

async function mailItems(mail: NeedsYouDeps['mail']): Promise<NeedsYouItem[]> {
  const { latestScan } = await mail.get();
  const open: MailTaskPage['items'] = [];
  for (let cursor: string | null = null; ;) {
    const page: MailTaskPage = await mail.page({ group: 'open', limit: 100, ...(cursor ? { cursor } : {}) });
    open.push(...page.items);
    if (!(cursor = page.nextCursor)) break;
  }
  // counts.needsReview is work waiting for Bud to prepare, not for a person: only the open group is a person's review.
  const items = open.filter(item => mailWorkGroup(item) === 'open').map((item): NeedsYouItem => ({ key: key('mail', item.id), area: 'mail', level: 'review',
    title: clip(item.subject, 300, 'A conversation with no subject'), reason: clip(item.reason, 600, 'Bud marked this conversation for your review.'),
    next: clip(item.nextAction, 200, 'Open it in Mail priorities'), foundAt: iso(item.firstSeenAt) }));
  const scan = latestScan ? SCAN_PROBLEM[latestScan.status] : undefined;
  if (latestScan && scan) items.push({ key: 'mail:scan', area: 'mail', level: 'problem', title: scan, reason: 'Not all mail was checked, so this list may be missing conversations.',
    next: 'Check mail again in Mail priorities', foundAt: iso(latestScan.completedAt ?? latestScan.startedAt) });
  return items;
}

async function followUpItems(read: NeedsYouDeps['billFollowUps']): Promise<NeedsYouItem[]> {
  const open: BillFollowUp[] = [];
  for (let cursor: string | null = null; ;) {
    const url = new URL('/api/bill-register/followups?filter=open&limit=100', 'http://localhost');
    if (cursor) url.searchParams.set('cursor', cursor);
    const { status, body } = await read(url, 'GET');
    const page = status === 200 ? readBillFollowUpPage(body) : malformed();
    open.push(...page.items);
    if (!(cursor = page.nextCursor)) break;
  }
  return open.filter(item => item.status === 'open').map((item): NeedsYouItem => ({ key: key('bill', item.id), area: 'bills', level: 'review',
    title: clip(`${item.propertyId} · ${item.label}`, 300, 'A bill arrival'),
    reason: clip(`${item.reason}${item.active ? '' : ' Not in the latest review.'}`, 600, 'This bill arrival needs a follow-up.'),
    next: 'Assign or resolve it in Bills and calendar', foundAt: iso(item.history.filter(entry => entry.action === 'recurred').at(-1)?.at ?? item.firstSeenAt) }));
}

function coverageItems(result: RoutineResult | null): NeedsYouItem[] {
  return result && result.gaps.length > 0 ? [{ key: 'bills:coverage', area: 'bills', level: 'problem', title: 'Weekly bills coverage needs review',
    reason: "Some mail wasn't covered, so bills may be missing from the last weekly check.", next: 'Review the gaps in Bills and calendar', foundAt: iso(result.finishedAt) }] : [];
}

async function bankItems(deps: NeedsYouDeps): Promise<NeedsYouItem[]> {
  if (!(await deps.selectedWorkflows()).includes('bank-references')) return [];
  const { run, working, ask, signIn } = await deps.w1Status();
  // As w1View (src/components/schedule/BankReferenceReview.tsx): an open ask, a REI sign-in wait or a held run waits for a person; work in flight does not.
  if (!run || !(ask || (working ? signIn : run.step !== 'done'))) return [];
  const level: NeedsYouLevel = ask ? 'review' : working ? 'problem' : !run.attention || BANK_REVIEW.has(run.attention.reason) ? 'review' : 'problem';
  const view = ask ? { title: 'A bank import step needs your approval', reason: 'Bud waits for your answer before this step in REI.', next: 'Allow or decline it in Bank references' }
    : working ? { title: 'REI Cloud needs you to sign in', reason: 'The bank import carries on by itself once you sign in.', next: 'Sign in to REI Cloud in the work browser' }
    : { title: level === 'problem' ? 'The bank import is held' : 'The bank import is waiting for you', reason: clip(run.attention?.message, 600, 'It goes no further until you continue.'),
      next: 'Open the import in Bank references' };
  return [{ key: key('bank', run.id), area: 'bank', level, ...view, foundAt: iso(run.updatedAt) }];
}

function loopItems(schedule: ReturnType<NeedsYouDeps['loops']>, ownAreas: ReadonlySet<NeedsYouArea>): NeedsYouItem[] {
  const startedAt = (run: LoopRun) => run.startedAt ?? run.createdAt;
  const picked = new Map<string, { run: LoopRun; level: NeedsYouLevel }>();
  for (const run of schedule.listRuns()) {
    // As loopIssue + buildRow (src/lib/schedule-rows.ts): per job, the most serious unseen receipt, then the newest.
    // A taught job's receipt is its job run, which Schedule judges instead; it is not read here.
    const level = run.seenAt || run.jobRunId ? null : LOOP_PROBLEM[run.status] ? 'problem' : run.status === 'awaiting-approval' ? 'review' : null;
    const prior = picked.get(run.loopId);
    if (level && (!prior || (level === prior.level ? startedAt(run) > startedAt(prior.run) : level === 'problem'))) picked.set(run.loopId, { run, level });
  }
  const items: NeedsYouItem[] = [];
  for (const { run, level } of picked.values()) {
    const area = areaForLoop(run.loopId) ?? 'schedule';
    if (level === 'review' && OWN_LOOPS.has(run.loopId) && ownAreas.has(area)) continue;
    items.push({ key: key('loop', run.id), area, level, title: clip(run.loopName, 300, 'A scheduled job'),
      reason: LOOP_PROBLEM[run.status] ?? 'A run of this job is waiting for your approval.',
      next: level === 'problem' ? 'Open the run in Schedule' : 'Review the run in Schedule', foundAt: iso(run.finishedAt ?? startedAt(run)) });
  }
  if (schedule.recovery.active) items.push({ key: 'schedule:recovery', area: 'schedule', level: 'problem', title: 'Scheduled work is paused for recovery',
    reason: 'Saved results are still available. No job runs until this is recovered.', next: 'Open Schedule for details', foundAt: null });
  return items;
}

/** One source's items, each checked against the contract; anything wrong makes the source unavailable. */
async function settle(area: SourceArea, read: () => NeedsYouItem[] | Promise<NeedsYouItem[]>): Promise<{ area: SourceArea; items: NeedsYouItem[] | null }> {
  try {
    const items = await read();
    parseNeedsYouSnapshot({ checkedAt: new Date(0).toISOString(), items, counts: {}, unavailable: [] });
    return { area, items };
  } catch { return { area, items: null }; }
}
const time = (item: NeedsYouItem) => item.foundAt === null ? -Infinity : Date.parse(item.foundAt);
const order = (a: NeedsYouItem, b: NeedsYouItem) => (a.level === b.level ? 0 : a.level === 'problem' ? -1 : 1) || time(b) - time(a) || a.key.localeCompare(b.key);

export async function readNeedsYou(deps: NeedsYouDeps): Promise<NeedsYouSnapshot> {
  const checkedAt = new Date((deps.now ?? Date.now)()).toISOString();
  const sources = await Promise.all([
    settle('mail', () => mailItems(deps.mail)),
    settle('bills', () => followUpItems(deps.billFollowUps)),
    settle('bills', () => coverageItems(deps.weeklyBills())),
    settle('bank', () => bankItems(deps)),
  ]);
  const ownAreas = new Set(sources.flatMap(source => source.items ?? []).map(item => item.area));
  sources.push(await settle('schedule', () => loopItems(deps.loops(), ownAreas)));
  const counts: NeedsYouSnapshot['counts'] = {}, shown = new Map<NeedsYouArea, number>();
  const items = sources.flatMap(source => source.items ?? []).sort(order).filter(item => {
    (counts[item.area] ??= { problem: 0, review: 0 })[item.level]++;
    shown.set(item.area, (shown.get(item.area) ?? 0) + 1);
    return shown.get(item.area)! <= NEEDS_YOU_AREA_LIMIT;
  });
  const unavailable = [...new Set(sources.filter(source => !source.items).map(source => source.area))].map(area => ({ area, reason: UNAVAILABLE[area] }));
  return { checkedAt, items, counts, unavailable };
}

/** GET /api/needs-you. The host applies the session gate and `no-store` first. */
export function createNeedsYouHandler(deps: NeedsYouDeps) {
  return {
    async handle(route: string, method: string): Promise<{ status: number; body: unknown } | null> {
      if (route !== '/api/needs-you') return null;
      if (method !== 'GET') return { status: 405, body: { error: 'Needs you is read-only.' } };
      return { status: 200, body: await readNeedsYou(deps) };
    },
  };
}
