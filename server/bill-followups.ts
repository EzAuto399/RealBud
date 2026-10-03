import { createHash } from 'node:crypto';
import { readPrivateJson, writePrivateJson } from './private-json.ts';
import { redactSecretsInText } from './redact.ts';
import type { RoutineFinding, RoutineResult } from '../shared/routine-result.ts';
import { BILL_FOLLOWUP_HISTORY_MAX, readBillFollowUp, validFollowUpDate, validFollowUpNote, validFollowUpOwner,
  type BillFollowUp, type BillFollowUpDecision, type BillFollowUpFilter, type BillFollowUpPage } from '../shared/bill-followups.ts';

/** Kevin's decisions on weekly arrival findings. Private JSON (0600, temp →
 * fsync → rename); a damaged file holds every change and is never replaced. */
interface FollowUpFile { version: 1; revision: number; syncedRunId: string; items: BillFollowUp[] }
const MAX_BYTES = 8_000_000, MAX_ITEMS = 5000;
const fail = (message: string, status: number): never => { throw Object.assign(new Error(message), { status }); };
const recovery = (): never => fail('The saved bill follow-ups need recovery. Their original data has been kept.', 503);
const conflict = (): never => fail('This follow-up changed. Refresh the list and try again.', 409);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const STATE_LABEL: Record<RoutineFinding['state'], string> = { 'coverage-hold': 'coverage hold', 'review-hold': 'source review needed', 'missing-review': 'missing-arrival review' };

export function validate(value: unknown): FollowUpFile {
  try {
    if (!object(value) || Object.keys(value).sort().join(',') !== 'items,revision,syncedRunId,version' || value.version !== 1 ||
        !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || typeof value.syncedRunId !== 'string' || value.syncedRunId.length > 100 ||
        !Array.isArray(value.items) || value.items.length > MAX_ITEMS) return recovery();
    const items = value.items.map(readBillFollowUp);
    if (new Set(items.map(i => i.id)).size !== items.length) return recovery();
    return { version: 1, revision: Number(value.revision), syncedRunId: value.syncedRunId, items };
  } catch { return recovery(); }
}
const evidenceKey = (f: RoutineFinding) => hash([f.propertyId, f.label, f.state, f.from, f.to]);
const decide = (item: BillFollowUp, decision: BillFollowUpDecision) => { item.history = [...item.history, decision].slice(-BILL_FOLLOWUP_HISTORY_MAX); item.revision++; };

/** Folds one weekly result into saved follow-ups. Decisions are kept; a resolved
 * finding that comes back with new evidence (or after it had cleared) reopens. */
function sync(file: FollowUpFile, result: RoutineResult, at: number): boolean {
  if (result.workflow !== 'weekly-bills' || file.syncedRunId === result.runId) return false;
  const byId = new Map(file.items.map(i => [i.id, i])), seen = new Set<string>();
  for (const f of result.findings) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    const key = evidenceKey(f), evidence = { propertyId: f.propertyId, label: f.label, state: f.state, from: f.from, to: f.to, reason: f.reason };
    const item = byId.get(f.id);
    if (!item) {
      const created: BillFollowUp = { id: f.id, revision: 1, ...evidence, evidenceKey: key, active: true, firstSeenAt: at, status: 'open', owner: '', followUpOn: '', history: [] };
      file.items.push(created); byId.set(f.id, created); continue;
    }
    if (item.evidenceKey === key && item.active && item.reason === f.reason) continue;
    const recurred = item.status === 'resolved';
    Object.assign(item, evidence, { evidenceKey: key, active: true });
    if (recurred) { item.status = 'open'; decide(item, { at, action: 'recurred', note: `Reopened: this arrival came back in the weekly review with new evidence (${STATE_LABEL[f.state]}, ${f.from} to ${f.to}).` }); }
    else item.revision++;
  }
  for (const item of file.items) if (item.active && !seen.has(item.id)) { item.active = false; item.revision++; }
  // ponytail: oldest resolved, cleared follow-ups drop past 5000; export them first if that history matters.
  if (file.items.length > MAX_ITEMS) {
    const drop = new Set(file.items.filter(i => i.status === 'resolved' && !i.active).sort((a, b) => a.firstSeenAt - b.firstSeenAt)
      .slice(0, file.items.length - MAX_ITEMS).map(i => i.id));
    file.items = file.items.filter(i => !drop.has(i.id));
  }
  file.syncedRunId = result.runId; file.revision++;
  return true;
}
const order = (a: BillFollowUp, b: BillFollowUp) => (a.status === b.status ? 0 : a.status === 'open' ? -1 : 1) ||
  (a.followUpOn || '9999').localeCompare(b.followUpOn || '9999') || a.from.localeCompare(b.from) || a.id.localeCompare(b.id);

export function createBillFollowUps(options: { file: string; latest: () => RoutineResult | null; recovery: () => boolean; now?: () => number }) {
  const now = options.now ?? Date.now;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => { const next = queue.then(work, work); queue = next.catch(() => {}); return next; };
  const load = async (): Promise<FollowUpFile> => {
    let raw: unknown;
    try { raw = await readPrivateJson(options.file, MAX_BYTES); } catch { return recovery(); }
    return raw === undefined ? { version: 1, revision: 0, syncedRunId: '', items: [] } : validate(raw);
  };
  const save = (file: FollowUpFile) => writePrivateJson(options.file, file, { maxBytes: MAX_BYTES, validate });
  /** Reads with the latest weekly result folded in; recovery mode reads without writing. */
  const current = async () => {
    const file = await load(), latest = options.latest();
    if (latest && !options.recovery() && sync(file, latest, now())) await save(file);
    return file;
  };
  return {
    page: (query: { filter?: BillFollowUpFilter; limit?: number; cursor?: string } = {}): Promise<BillFollowUpPage> => serial(async () => {
      const filter = query.filter ?? 'open', limit = query.limit ?? 20;
      if (!['open', 'resolved', 'all'].includes(filter) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('Choose a valid follow-up page.', 400);
      const file = await current();
      let offset = 0;
      if (query.cursor !== undefined) {
        let c: unknown;
        try { c = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')); } catch { fail('This follow-up page is invalid. Refresh the list.', 400); }
        if (!object(c) || Object.keys(c).sort().join(',') !== 'filter,offset,revision,version' || c.version !== 1 || c.filter !== filter ||
            !Number.isSafeInteger(c.offset) || Number(c.offset) < 1) fail('This follow-up page is invalid. Refresh the list.', 400);
        if ((c as { revision: unknown }).revision !== file.revision) fail('The follow-up list changed. Refresh it before loading more.', 409);
        offset = Number((c as { offset: number }).offset);
      }
      const matching = file.items.filter(i => filter === 'all' || i.status === filter).sort(order);
      const items = matching.slice(offset, offset + limit), next = offset + items.length;
      return { version: 1, filter, items, total: matching.length,
        counts: { open: file.items.filter(i => i.status === 'open').length, resolved: file.items.filter(i => i.status === 'resolved').length },
        nextCursor: next < matching.length ? Buffer.from(JSON.stringify({ version: 1, revision: file.revision, filter, offset: next })).toString('base64url') : null };
    }),
    change: (body: unknown): Promise<{ item: BillFollowUp }> => serial(async () => {
      if (!object(body) || typeof body.id !== 'string' || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) fail('Choose the follow-up and its current revision.', 400);
      const b = body as Record<string, unknown>, keys = Object.keys(b).sort().join(',');
      const plan = b.action === 'plan' && keys === 'action,expectedRevision,followUpOn,id,owner' && validFollowUpOwner(b.owner) && validFollowUpDate(b.followUpOn);
      const close = (b.action === 'resolve' || b.action === 'reopen') && keys === 'action,expectedRevision,id,note' && validFollowUpNote(b.note);
      if (!plan && !close) fail('Check the owner (up to 100 characters), follow-up date or note.', 400);
      if (options.recovery()) fail('Recover the private book before changing follow-ups. Saved follow-ups are kept.', 503);
      const file = await current(), item = file.items.find(i => i.id === b.id);
      if (!item) return fail('That follow-up is unavailable. Refresh the list.', 404);
      if (item.revision !== b.expectedRevision) conflict();
      const at = Math.max(0, now());
      if (b.action === 'plan') {
        if (item.status !== 'open') fail('Reopen this follow-up before assigning or dating it.', 409);
        item.owner = redactSecretsInText(String(b.owner)).slice(0, 100).trim(); item.followUpOn = String(b.followUpOn);
        decide(item, { at, action: 'planned', note: `${item.owner ? `Assigned to ${item.owner}` : 'No one assigned'}; ${item.followUpOn ? `follow up on ${item.followUpOn}` : 'no follow-up date'}.` });
      } else if (b.action === 'resolve') {
        if (item.status !== 'open') conflict();
        item.status = 'resolved'; decide(item, { at, action: 'resolved', note: redactSecretsInText(String(b.note)).slice(0, 500) });
      } else {
        if (item.status !== 'resolved') conflict();
        item.status = 'open'; decide(item, { at, action: 'reopened', note: redactSecretsInText(String(b.note)).slice(0, 500) });
      }
      file.revision++;
      await save(file);
      return { item: structuredClone(item) };
    }),
  };
}

/** GET/PATCH /api/bill-register/followups. The host applies session, JSON body
 * and restore barriers first; errors return the same `{ error }` shape. */
export function createBillFollowUpsApi(options: Parameters<typeof createBillFollowUps>[0]) {
  const store = createBillFollowUps(options);
  return async (url: URL, method: string, body?: unknown): Promise<{ status: number; body: unknown }> => {
    try {
      if (url.pathname !== '/api/bill-register/followups') return { status: 404, body: { error: 'That follow-up action is unavailable.' } };
      if (method === 'GET') {
        const params = url.searchParams, seen = new Set<string>();
        for (const [key] of params) { if (!['filter', 'limit', 'cursor'].includes(key) || seen.has(key)) fail('This follow-up query is invalid. Refresh the list.', 400); seen.add(key); }
        const rawLimit = params.get('limit'), cursor = params.get('cursor');
        if (rawLimit !== null && !/^[1-9]\d{0,2}$/.test(rawLimit)) fail('Choose between 1 and 100 follow-ups.', 400);
        if (cursor !== null && !/^[A-Za-z0-9_-]{1,4096}$/.test(cursor)) fail('This follow-up page is invalid. Refresh the list.', 400);
        return { status: 200, body: await store.page({ filter: (params.get('filter') ?? 'open') as BillFollowUpFilter,
          ...(rawLimit === null ? {} : { limit: Number(rawLimit) }), ...(cursor === null ? {} : { cursor }) }) };
      }
      if (method === 'PATCH') return { status: 200, body: await store.change(body) };
      return { status: 405, body: { error: 'Choose a supported follow-up action.' } };
    } catch (error) {
      const status = (error as { status?: number }).status;
      return status ? { status, body: { error: (error as Error).message } } : { status: 503, body: { error: 'The saved bill follow-ups need recovery. Their original data has been kept.' } };
    }
  };
}
