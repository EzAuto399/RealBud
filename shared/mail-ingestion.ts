/** Mail is untrusted evidence. These records never grant tool or send authority. */
export interface MailSourceScope {
  historyDays: number;
  includeSent: boolean;
  maxMessages: number;
  attachmentPolicy: 'metadata-only';
}
export interface MailScanRequest {
  windowStartAt: number;
  windowEndAt: number;
  maxMessages: number;
  includeSent: boolean;
  /** Previously observed unresolved threads, supplied by the host's saved queue. */
  carryThreadIds: string[];
}
export interface MailMessage {
  id: string; threadId: string; at: number;
  direction: 'incoming' | 'outgoing' | 'unknown';
  from: string; to: string; subject: string; body: string; bodyTruncated: boolean;
  attachments: { id: string; name: string; mimeType: string; size: number | null }[];
}
export interface MailThread {
  id: string; messages: MailMessage[]; historyComplete: boolean;
}
export interface MailScanResult {
  accountId: string; windowStartAt: number; windowEndAt: number;
  threads: MailThread[]; pages: number; paginationComplete: boolean;
  gaps: string[];
}
export type MailScanStatus = 'running' | 'complete' | 'partial' | 'failed' | 'interrupted';
export interface MailScanReceipt {
  id: string; accountId: string; bindingRevision: string;
  startedAt: number; completedAt: number | null;
  windowStartAt: number; windowEndAt: number;
  status: MailScanStatus; messageCount: number; threadCount: number;
  pages: number; gaps: string[]; inputDigest: string | null;
}
export interface MailWorkItem {
  id: string; revision: number; accountId: string; threadId: string; subject: string;
  sourceMessageIds: string[]; sourceDigest: string; sourceReceiptId: string;
  disposition: 'urgent-review' | 'reply-review' | 'action-review' | 'waiting' | 'reference' | 'noise' | 'hold';
  priority: 'high' | 'normal' | 'low'; owner: string;
  reason: string; nextAction: string; missingFacts: string[];
  status: 'open' | 'done' | 'snoozed'; snoozedUntil: number | null;
  note: string; reviewed: boolean; newEvidence: boolean;
  /** Last validated review of this unanswered outgoing message and calendar rule.
   * Absent on older records; elapsed time alone never creates send authority. */
  followUpReviewedKey?: string;
  firstSeenAt: number; updatedAt: number; lastMessageAt: number;
}
export interface MailWorkspaceSnapshot {
  version: 1; revision: number; latestScan: MailScanReceipt | null;
  latestReview: { runId: string; sourceReceiptId: string; at: number } | null;
  items: MailWorkItem[];
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const bounded = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
export const gmailThreadId = (v: unknown): v is string => typeof v === 'string' && /^[a-fA-F0-9]{1,64}$/.test(v);
const bad = (): never => { throw Object.assign(new Error('The mail source or its coverage needs review.'), { status: 400 }); };
export function parseMailScanRequest(value: unknown, now = Date.now()): MailScanRequest {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'carryThreadIds,includeSent,maxMessages,windowEndAt,windowStartAt' ||
    !Number.isSafeInteger(value.windowStartAt) || !Number.isSafeInteger(value.windowEndAt) || Number(value.windowStartAt) < 0 ||
    Number(value.windowEndAt) <= Number(value.windowStartAt) || Number(value.windowEndAt) > now + 60_000 ||
    Number(value.windowEndAt) - Number(value.windowStartAt) > 90 * 86_400_000 ||
    !Number.isInteger(value.maxMessages) || Number(value.maxMessages) < 1 || Number(value.maxMessages) > 500 ||
    typeof value.includeSent !== 'boolean' || !Array.isArray(value.carryThreadIds) || value.carryThreadIds.length > 100 ||
    value.carryThreadIds.some(v => !gmailThreadId(v)) || new Set(value.carryThreadIds).size !== value.carryThreadIds.length) return bad();
  return structuredClone(value) as unknown as MailScanRequest;
}
/** Validate at both the remote transport and durable-storage boundary. */
export function parseMailScanResult(value: unknown, request: MailScanRequest, accountId: string): MailScanResult {
  if (!record(value) || value.accountId !== accountId || value.windowStartAt !== request.windowStartAt || value.windowEndAt !== request.windowEndAt ||
    !Array.isArray(value.threads) || value.threads.length > 100 || !Number.isInteger(value.pages) || Number(value.pages) < 0 || Number(value.pages) > 20 ||
    typeof value.paginationComplete !== 'boolean' || !Array.isArray(value.gaps) || value.gaps.length > 200 || value.gaps.some(v => !bounded(v, 200))) return bad();
  const threadIds = new Set<string>(), messageIds = new Set<string>(); let count = 0;
  const threads = value.threads.map(row => {
    if (!record(row) || !gmailThreadId(row.id) || threadIds.has(row.id) || typeof row.historyComplete !== 'boolean' || !Array.isArray(row.messages) || !row.messages.length || row.messages.length > 100) return bad();
    threadIds.add(row.id);
    const messages: MailMessage[] = row.messages.map(m => {
      if (!record(m) || !gmailThreadId(m.id) || m.threadId !== row.id || messageIds.has(m.id) || !Number.isSafeInteger(m.at) || Number(m.at) < 0 || Number(m.at) >= request.windowEndAt ||
        !['incoming', 'outgoing', 'unknown'].includes(String(m.direction)) || !bounded(m.from, 2048) || !bounded(m.to, 2048) || !bounded(m.subject, 2048) || !bounded(m.body, 12_000) ||
        typeof m.bodyTruncated !== 'boolean' || !Array.isArray(m.attachments) || m.attachments.length > 100 || ++count > request.maxMessages) return bad();
      messageIds.add(m.id);
      const attachments = m.attachments.map(a => {
        if (!record(a) || !bounded(a.id, 512) || !a.id || !bounded(a.name, 255) || !bounded(a.mimeType, 120) ||
          (a.size !== null && (!Number.isSafeInteger(a.size) || Number(a.size) < 0))) return bad();
        return { id: a.id, name: a.name, mimeType: a.mimeType, size: a.size as number | null };
      });
      return { id: m.id, threadId: String(row.id), at: Number(m.at), direction: m.direction as MailMessage['direction'], from: m.from, to: m.to,
        subject: m.subject, body: m.body, bodyTruncated: m.bodyTruncated, attachments };
    });
    return { id: row.id, messages: messages.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)), historyComplete: row.historyComplete };
  });
  const result = { accountId, windowStartAt: request.windowStartAt, windowEndAt: request.windowEndAt, threads, pages: Number(value.pages), paginationComplete: value.paginationComplete, gaps: value.gaps as string[] };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 800_000 || (result.paginationComplete && result.pages === 0) || (!result.paginationComplete && !result.gaps.length) ||
    (threads.some(t => !t.historyComplete || t.messages.some(m => m.bodyTruncated || m.direction === 'unknown' || m.attachments.length)) && !result.gaps.length)) return bad();
  return result;
}

/* ---- Bounded historical acquisition ----------------------------------------
 * One approved interval, split into fixed windows that tile it with no overlap
 * and no gap. Boundaries are office calendar day starts, never 24-hour
 * durations, so a DST transition cannot silently move or drop a day. */
export const MAIL_HISTORY_MAX_WINDOWS = 16;
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const zoneParts = (at: number, timeZone: string) => {
  const parts: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at)) parts[part.type] = part.value;
  return parts;
};
/** Office calendar date as a day number. Counts dates, not elapsed hours. */
export function officeDayOrdinal(at: number, timeZone: string): number {
  const p = zoneParts(at, timeZone);
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / 86_400_000;
}
function zoneOffset(at: number, timeZone: string): number {
  const p = zoneParts(at, timeZone);
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - at + (((at % 1000) + 1000) % 1000);
}
/** First instant of the office day `dayOffset` days from the office date of `at`.
 * The offset is re-resolved at the candidate instant, so a window boundary that
 * crosses a DST change still lands on that day's own first minute. */
export function officeDayStart(at: number, timeZone: string, dayOffset = 0): number {
  const ordinal = officeDayOrdinal(at, timeZone) + dayOffset, midnight = ordinal * 86_400_000;
  let guess = midnight - zoneOffset(at, timeZone);
  for (let i = 0; i < 4; i++) { const next = midnight - zoneOffset(guess, timeZone); if (next === guess) break; guess = next; }
  const step = (direction: -1 | 1, test: () => boolean) => { for (let i = 0; test(); i++) { if (i > 240) bad(); guess += direction * 60_000; } };
  step(-1, () => officeDayOrdinal(guess, timeZone) > ordinal);
  step(1, () => officeDayOrdinal(guess, timeZone) < ordinal);
  step(-1, () => officeDayOrdinal(guess - 60_000, timeZone) === ordinal);
  return guess;
}
export interface MailHistoryWindow { index: number; startAt: number; endAt: number }
export interface MailHistoryPlan {
  version: 1; purpose: 'mail-history-plan';
  accountId: string; bindingRevision: string; timeZone: string;
  approvedStartAt: number; approvedEndAt: number;
  totalDays: number; windowDays: number; windowCount: number;
  includeSent: boolean; maxMessagesPerWindow: number; maxMessagesTotal: number; createdAt: number;
}
export interface MailHistoryPlanInput {
  accountId: string; bindingRevision: string; timeZone: string; endAt: number;
  totalDays: number; windowDays: number; includeSent: boolean; maxMessagesPerWindow: number;
}
const PLAN_KEYS = ['version', 'purpose', 'accountId', 'bindingRevision', 'timeZone', 'approvedStartAt', 'approvedEndAt',
  'totalDays', 'windowDays', 'windowCount', 'includeSent', 'maxMessagesPerWindow', 'maxMessagesTotal', 'createdAt'];
/** The approved interval comes from saved agency settings; nothing here widens it. */
export function planMailHistory(input: MailHistoryPlanInput): MailHistoryPlan {
  const { accountId, bindingRevision, timeZone, endAt, totalDays, windowDays, includeSent, maxMessagesPerWindow } = input;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(accountId)) || !/^[a-f0-9]{64}$/.test(String(bindingRevision)) || !bounded(timeZone, 64) || !timeZone ||
    !Number.isSafeInteger(endAt) || endAt <= 0 || !Number.isInteger(totalDays) || totalDays < 1 || totalDays > 90 ||
    !Number.isInteger(windowDays) || windowDays < 1 || windowDays > 30 || windowDays > totalDays ||
    typeof includeSent !== 'boolean' || !Number.isInteger(maxMessagesPerWindow) || maxMessagesPerWindow < 1 || maxMessagesPerWindow > 500) return bad();
  let approvedStartAt: number;
  try { approvedStartAt = officeDayStart(endAt, timeZone, -totalDays); } catch { return bad(); }
  const windowCount = Math.ceil(totalDays / windowDays);
  if (!Number.isSafeInteger(approvedStartAt) || approvedStartAt < 0 || approvedStartAt >= endAt || windowCount > MAIL_HISTORY_MAX_WINDOWS) return bad();
  const plan: MailHistoryPlan = { version: 1, purpose: 'mail-history-plan', accountId, bindingRevision, timeZone,
    approvedStartAt, approvedEndAt: endAt, totalDays, windowDays, windowCount, includeSent,
    maxMessagesPerWindow, maxMessagesTotal: windowCount * maxMessagesPerWindow, createdAt: endAt };
  mailHistoryWindows(plan);
  return plan;
}
export function validMailHistoryPlan(value: unknown): value is MailHistoryPlan {
  if (!record(value) || !exact(value, PLAN_KEYS) || value.version !== 1 || value.purpose !== 'mail-history-plan') return false;
  try {
    const rebuilt = planMailHistory({ accountId: String(value.accountId), bindingRevision: String(value.bindingRevision), timeZone: String(value.timeZone),
      endAt: Number(value.approvedEndAt), totalDays: Number(value.totalDays), windowDays: Number(value.windowDays),
      includeSent: value.includeSent as boolean, maxMessagesPerWindow: Number(value.maxMessagesPerWindow) });
    return PLAN_KEYS.every(key => (rebuilt as unknown as Record<string, unknown>)[key] === value[key]);
  } catch { return false; }
}
/** Boundaries are always recomputed from the plan, so the plan is the only
 * source of truth for what the interval was and how it was divided. */
export function mailHistoryWindows(plan: MailHistoryPlan): MailHistoryWindow[] {
  const windows: MailHistoryWindow[] = [];
  for (let index = 0; index < plan.windowCount; index++) {
    const endAt = index === 0 ? plan.approvedEndAt : officeDayStart(plan.approvedEndAt, plan.timeZone, -(index * plan.windowDays));
    const startAt = index === plan.windowCount - 1 ? plan.approvedStartAt : officeDayStart(plan.approvedEndAt, plan.timeZone, -((index + 1) * plan.windowDays));
    if (!Number.isSafeInteger(startAt) || !Number.isSafeInteger(endAt) || startAt < plan.approvedStartAt || endAt <= startAt ||
      endAt > plan.approvedEndAt || endAt - startAt > 90 * 86_400_000 || (index > 0 && windows[index - 1].startAt !== endAt)) return bad();
    windows.push({ index, startAt, endAt });
  }
  if (!windows.length || windows[0].endAt !== plan.approvedEndAt || windows[windows.length - 1].startAt !== plan.approvedStartAt) return bad();
  return windows;
}
export type MailHistoryWindowStatus = 'pending' | 'running' | 'complete' | 'partial' | 'failed';
export interface MailHistoryWindowCheckpoint {
  index: number; startAt: number; endAt: number; status: MailHistoryWindowStatus;
  pages: number; paginationComplete: boolean; threadsSeen: number; messagesSeen: number;
  gaps: string[]; attemptedAt: number; capturedAt: number | null;
}
/** Source identity only. Bodies, subjects and attachment contents are never
 * copied here, so a replay can be proved idempotent without a second copy. */
export interface MailHistoryMessageRecord {
  key: string; threadId: string; messageId: string; at: number;
  direction: MailMessage['direction']; digest: string; windowIndex: number;
}
export interface MailHistoryCheckpoint {
  version: 1; purpose: 'mail-history-checkpoint'; workspaceId: string;
  plan: MailHistoryPlan; planDigest: string;
  windows: MailHistoryWindowCheckpoint[]; messages: MailHistoryMessageRecord[];
  updatedAt: number; completedAt: number | null;
}
export interface MailHistoryCoverage {
  version: 1; accountId: string; planDigest: string; timeZone: string;
  approvedStartAt: number; approvedEndAt: number;
  checkedFromAt: number | null; checkedToAt: number | null;
  windowCount: number; windowsComplete: number; windowsPartial: number; windowsFailed: number;
  windowsNotChecked: number; windowsWithUnfetchedPages: number;
  threadsSeen: number; messagesSeen: number; complete: boolean;
  gaps: string[]; notChecked: string[]; updatedAt: number; completedAt: number | null;
}
const HEX64 = /^[a-f0-9]{64}$/;
const windowStatuses: MailHistoryWindowStatus[] = ['pending', 'running', 'complete', 'partial', 'failed'];
/** Validate at the durable-storage boundary; the digest function stays with the
 * caller so this module keeps no runtime dependency. */
export function parseMailHistoryCheckpoint(value: unknown, workspaceId: string, digest: (value: unknown) => string): MailHistoryCheckpoint {
  if (!record(value) || !exact(value, ['version', 'purpose', 'workspaceId', 'plan', 'planDigest', 'windows', 'messages', 'updatedAt', 'completedAt']) ||
    value.version !== 1 || value.purpose !== 'mail-history-checkpoint' || value.workspaceId !== workspaceId ||
    !validMailHistoryPlan(value.plan) || typeof value.planDigest !== 'string' || value.planDigest !== digest(value.plan) ||
    !Number.isSafeInteger(value.updatedAt) || Number(value.updatedAt) < 0 ||
    (value.completedAt !== null && (!Number.isSafeInteger(value.completedAt) || Number(value.completedAt) < 0)) ||
    !Array.isArray(value.windows) || !Array.isArray(value.messages)) return bad();
  const plan = value.plan as MailHistoryPlan, expected = mailHistoryWindows(plan);
  const rawWindows = value.windows as unknown[], rawMessages = value.messages as unknown[];
  if (rawWindows.length !== expected.length) return bad();
  const windows = rawWindows.map((row: unknown, at: number): MailHistoryWindowCheckpoint => {
    if (!record(row) || !exact(row, ['index', 'startAt', 'endAt', 'status', 'pages', 'paginationComplete', 'threadsSeen', 'messagesSeen', 'gaps', 'attemptedAt', 'capturedAt']) ||
      row.index !== at || row.startAt !== expected[at].startAt || row.endAt !== expected[at].endAt ||
      !windowStatuses.includes(row.status as MailHistoryWindowStatus) ||
      !Number.isInteger(row.pages) || Number(row.pages) < 0 || Number(row.pages) > 20 || typeof row.paginationComplete !== 'boolean' ||
      !Number.isInteger(row.threadsSeen) || Number(row.threadsSeen) < 0 || Number(row.threadsSeen) > 100 ||
      !Number.isInteger(row.messagesSeen) || Number(row.messagesSeen) < 0 || Number(row.messagesSeen) > plan.maxMessagesPerWindow ||
      !Array.isArray(row.gaps) || row.gaps.length > 200 || row.gaps.some((g: unknown) => !bounded(g, 200)) ||
      !Number.isSafeInteger(row.attemptedAt) || Number(row.attemptedAt) < 0 ||
      (row.capturedAt !== null && (!Number.isSafeInteger(row.capturedAt) || Number(row.capturedAt) < 0)) ||
      (row.status === 'pending' && (row.pages || row.messagesSeen || row.threadsSeen || row.gaps.length || row.capturedAt !== null || row.paginationComplete)) ||
      (row.status === 'complete' && (!row.paginationComplete || row.gaps.length || row.capturedAt === null)) ||
      (row.status === 'partial' && (row.capturedAt === null || (row.paginationComplete && !row.gaps.length)))) return bad();
    return structuredClone(row) as unknown as MailHistoryWindowCheckpoint;
  });
  if (rawMessages.length > plan.maxMessagesTotal) return bad();
  const keys = new Set<string>();
  const messages = rawMessages.map((row: unknown): MailHistoryMessageRecord => {
    if (!record(row) || !exact(row, ['key', 'threadId', 'messageId', 'at', 'direction', 'digest', 'windowIndex']) ||
      typeof row.key !== 'string' || !HEX64.test(row.key) || keys.has(row.key) || !gmailThreadId(row.threadId) || !gmailThreadId(row.messageId) ||
      !Number.isSafeInteger(row.at) || Number(row.at) < 0 || !['incoming', 'outgoing', 'unknown'].includes(String(row.direction)) ||
      typeof row.digest !== 'string' || !HEX64.test(row.digest) ||
      !Number.isInteger(row.windowIndex) || Number(row.windowIndex) < 0 || Number(row.windowIndex) >= windows.length) return bad();
    keys.add(row.key);
    return structuredClone(row) as unknown as MailHistoryMessageRecord;
  });
  for (const w of windows) if (messages.filter(m => m.windowIndex === w.index).length > w.messagesSeen) return bad();
  const done = windows.every(w => w.status === 'complete' || w.status === 'partial' || w.status === 'failed');
  if ((value.completedAt !== null) !== done || windows.filter(w => w.status === 'running').length > 1) return bad();
  return { version: 1, purpose: 'mail-history-checkpoint', workspaceId, plan: structuredClone(plan), planDigest: value.planDigest,
    windows, messages, updatedAt: Number(value.updatedAt), completedAt: value.completedAt as number | null };
}
/** Says what was checked and, plainly, what was not. */
export function mailHistoryCoverage(checkpoint: MailHistoryCheckpoint): MailHistoryCoverage {
  const { plan, windows } = checkpoint;
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: plan.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const checked = windows.filter(w => w.status === 'complete' || w.status === 'partial');
  const gaps: string[] = [], notChecked: string[] = [];
  for (const w of windows) {
    for (const gap of w.gaps) if (!gaps.includes(gap) && gaps.length < 200) gaps.push(gap);
    if (w.status === 'complete' || w.status === 'partial') continue;
    const sentence = `${date.format(w.startAt)} to ${date.format(w.endAt)} was not checked${w.status === 'failed' ? ' because its read could not be confirmed' : ''}.`;
    if (!notChecked.includes(sentence) && notChecked.length < MAIL_HISTORY_MAX_WINDOWS) notChecked.push(sentence);
  }
  if (checkpoint.messages.length >= plan.maxMessagesTotal && windows.some(w => w.status === 'pending' || w.status === 'running'))
    notChecked.push(`The approved total of ${plan.maxMessagesTotal} messages was reached, so the remaining windows were not read.`);
  return {
    version: 1, accountId: plan.accountId, planDigest: checkpoint.planDigest, timeZone: plan.timeZone,
    approvedStartAt: plan.approvedStartAt, approvedEndAt: plan.approvedEndAt,
    checkedFromAt: checked.length ? Math.min(...checked.map(w => w.startAt)) : null,
    checkedToAt: checked.length ? Math.max(...checked.map(w => w.endAt)) : null,
    windowCount: plan.windowCount,
    windowsComplete: windows.filter(w => w.status === 'complete').length,
    windowsPartial: windows.filter(w => w.status === 'partial').length,
    windowsFailed: windows.filter(w => w.status === 'failed').length,
    windowsNotChecked: windows.filter(w => w.status === 'pending' || w.status === 'running').length,
    windowsWithUnfetchedPages: windows.filter(w => w.status !== 'pending' && !w.paginationComplete).length,
    threadsSeen: windows.reduce((n, w) => n + w.threadsSeen, 0), messagesSeen: checkpoint.messages.length,
    complete: windows.every(w => w.status === 'complete'), gaps, notChecked,
    updatedAt: checkpoint.updatedAt, completedAt: checkpoint.completedAt,
  };
}

/** Acquisition progress, never an authority or completeness claim: 'complete'
 * means every approved window was checked, not that the mailbox was fully read. */
export type MailHistoryRunState = 'not-started' | 'checking' | 'complete' | 'held';
export interface MailHistoryStatus {
  version: 1; state: MailHistoryRunState;
  accountId: string | null; settingsRevision: number | null; historyDays: number | null;
  windowsChecked: number; windowCount: number;
  heldReason: string | null; startedAt: number | null; updatedAt: number | null;
  detail: string; coverage: MailHistoryCoverage | null;
}
const clause = (reason: string | null) => (reason ?? 'its reason was not recorded').trim().replace(/\.+$/, '');
/** One wording for the workspace read model. */
export function mailHistoryStatusDetail(status: Omit<MailHistoryStatus, 'detail' | 'version'>): string {
  if (status.state === 'checking') return `History: checking ${status.windowsChecked} of ${status.windowCount} windows.`;
  if (status.state === 'complete') return `History: complete (${status.windowCount} of ${status.windowCount} windows).`;
  if (status.state === 'held') return `History: held (${clause(status.heldReason)}).`;
  return 'History: not started.';
}
/** The same facts as a setup-check sentence. It never claims completeness. */
export function mailHistorySetupDetail(status: Omit<MailHistoryStatus, 'detail' | 'version'>): string {
  if (status.state === 'checking') return `History collection has started: ${status.windowsChecked} of ${status.windowCount} approved windows checked so far. This is progress, not complete coverage.`;
  if (status.state === 'complete') return `History collection checked all ${status.windowCount} approved windows. Its coverage receipt still lists any provider gaps.`;
  if (status.state === 'held') return `History collection is held (${clause(status.heldReason)}); ${status.windowsChecked} of ${status.windowCount} approved windows were checked. The checkpoint was kept.`;
  return 'History collection has not started for this account.';
}
export type MailWorkGroup = 'open' | 'waiting' | 'reference' | 'snoozed' | 'done' | 'all';
export interface MailWorkspaceCounts {
  total: number; open: number; waiting: number; reference: number; snoozed: number; done: number;
  highPriority: number; needsReview: number;
}
export interface MailWorkspaceMetadata {
  version: 2; revision: number; latestScan: MailScanReceipt | null;
  latestReview: MailWorkspaceSnapshot['latestReview']; counts: MailWorkspaceCounts; nextSnoozeAt: number | null;
  /** Added by the ingestion service, not by storage: history acquisition is a
   * separate checkpoint file and never part of the encrypted work graph. */
  history?: MailHistoryStatus;
}
export interface MailTaskPageQuery { group?: MailWorkGroup; q?: string; limit?: number; cursor?: string }
export interface MailTaskPage {
  version: 2; revision: number; counts: MailWorkspaceCounts; group: MailWorkGroup; q: string;
  items: MailWorkItem[]; total: number; nextCursor: string | null;
}
export interface MailScanPageQuery { limit?: number; cursor?: string }
export interface MailScanPage { version: 2; revision: number; items: MailScanReceipt[]; total: number; nextCursor: string | null }
export interface MailTaskUpdateResult { workspace: MailWorkspaceMetadata; item: MailWorkItem }
export function mailWorkGroup(item: MailWorkItem): Exclude<MailWorkGroup, 'all'> {
  if (item.status !== 'open') return item.status;
  if (item.disposition === 'waiting') return 'waiting';
  if (item.disposition === 'reference' || item.disposition === 'noise') return 'reference';
  return 'open';
}
