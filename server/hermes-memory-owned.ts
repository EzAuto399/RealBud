/** RealBud-owned memory review: the review helper's commands (list, preview,
 * decide, propose, interrupted-list, interrupted-close) over RealBud's canonical
 * worker state instead of the worker profile, with no worker Python.
 *
 * Each command is one serialized state update, so a decision commits memory,
 * its signed receipt and the closed proposal together before success is
 * reported; the worker copy of MEMORY.md/USER.md is projected afterwards.
 * Receipts and journals keep the helper's signed formats, so imported helper
 * history verifies unchanged. Worker-staged proposals (pending/memory) are
 * adopted into the canonical store on every command. */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { linkSync, lstatSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PACK_DIR, policyDocument } from './hermes-pack.ts';
import { readProfileFiles } from './hermes-profile-storage.ts';
import { DATA_DIR } from './config.ts';
import { MEMORY_KEYS, artifactBytes, holdCopy, importLegacyProfileFacts, preserveCopy, projectProfileFacts, putArtifact, readWorkerState, recordWorkerMemoryEdit, strictWorkerFile, updateWorkerState,
  workerScope, type WorkerScope, type WorkerState } from './worker-state.ts';
import { ENTRY_DELIMITER, StoreRefusal, applyPending, normalizePayload, pinEntries, targetEnabled, targetLimit,
  type MemoryPayload, type MemorySettings, type MemoryTarget } from './hermes-memory-store.ts';
import { parseMemoryProposalInput, MEMORY_PROPOSAL_REVIEW_LOCATION } from '../shared/hermes-memory-proposal.ts';
import type { MemoryReviewErrorCode } from '../shared/hermes-memory-review.ts';

/** Runtime identity bound into owned receipts, journals and preview digests. */
export const OWNED_MEMORY_RUNTIME = 'realbud-owned-memory-v1';
const WORKER_PENDING_LIMIT = 500, PAGE = 20, MAX_DIR = 2000, MAX_BYTES = 128 * 1024, MAX_INPUT = 64 * 1024;
const HEX8 = /^[a-f0-9]{8}$/, HEX64 = /^[a-f0-9]{64}$/, RUNTIME_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RECEIPT_KEYS = ['version', 'id', 'workspaceId', 'profileId', 'runtimeId', 'decision', 'state', 'phase', 'pendingDigest', 'configDigest', 'beforeDigest',
  'afterDigest', 'reviewDigest', 'target', 'action', 'origin', 'createdAt', 'at', 'operationCount', 'charLimit', 'mac'];
const JOURNAL_KEYS = ['version', 'state', 'id', 'workspaceId', 'profileId', 'runtimeId', 'scopeId', 'requestKey', 'requestDigest', 'pendingDigest', 'createdAt', 'mac'];
const CLOSED_KEYS = [...JOURNAL_KEYS, 'closedAt', 'recoveryDigest'];
const PENDING_TOP = ['id', 'subsystem', 'action', 'summary', 'origin', 'created_at', 'payload'];

class ReviewError extends Error { readonly code: MemoryReviewErrorCode; constructor(code: MemoryReviewErrorCode) { super(code); this.code = code; } }
function fail(code: MemoryReviewErrorCode): never { throw new ReviewError(code); }
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer, data: string) => createHmac('sha256', key).update(data).digest('hex');
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const sameKeys = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
/** Python `json.dumps(sort_keys=True, separators=(",",":"))`. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const equalHex = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const decodeUtf8 = (bytes: Buffer) => { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return fail('unavailable'); } };

const paths = {
  memory: (target: MemoryTarget) => MEMORY_KEYS[target],
  pending: (id: string) => `pending/memory/${id}.json`,
  receipt: (id: string) => `.realbud-memory-reviews/${id}.json`,
  claim: (id: string) => `.realbud-memory-reviews/claims/${id}.json`,
  journal: (key: string) => `.realbud-memory-reviews/proposals/${key}.json`,
  stage: (key: string) => `.realbud-memory-reviews/proposals/${key}.stage`,
};

/** Memory settings from the worker's config; when that file is missing, unreadable or
 * malformed, RealBud's own pack policy (never permissive) applies and `fallback` names
 * the worker bytes so the caller records a hold. One bad file never stops reviews. */
export function readMemorySettings(profileDirectory: string): { settings: MemorySettings; digest: string; fallback: Buffer | null } {
  let worker: Buffer | null = null;
  let present = true; try { lstatSync(profileDirectory); } catch { present = false; }
  if (present) { try { [worker] = readProfileFiles([join(profileDirectory, 'config.yaml')]); } catch { worker = Buffer.from('realbud-unreadable-config'); } }
  let config: unknown = null;
  if (worker) { try { config = policyDocument(new TextDecoder('utf-8', { fatal: true }).decode(worker)).toJS({ maxAliasCount: 50 }); } catch { config = null; } }
  const fallback = worker && config === null ? worker : null;
  if (config === null) config = policyDocument(readFileSync(join(PACK_DIR, 'config.yaml'), 'utf8')).toJS({ maxAliasCount: 50 });
  const section = isObject(config) && isObject(config.memory) ? config.memory : {};
  for (const key of ['memory_enabled', 'user_profile_enabled', 'write_approval']) if (Object.hasOwn(section, key) && typeof section[key] !== 'boolean') fail('unsupported');
  const limit = (key: string, fallback: number) => {
    if (!Object.hasOwn(section, key)) return fallback;
    const value = section[key];
    if (typeof value !== 'number' || !Number.isInteger(value)) return fail('invalid');
    return value < 1 || value > 100_000 ? fail('capacity') : value;
  };
  const settings: MemorySettings = { writeApproval: section.write_approval === true, memoryEnabled: section.memory_enabled !== false, userEnabled: section.user_profile_enabled !== false,
    memoryLimit: limit('memory_char_limit', 2200), userLimit: limit('user_char_limit', 1375) };
  return { settings, digest: sha(canonical(settings)), fallback };
}

export type OwnedRequest = { command: string; key: string; workspaceId: string; profileId: string; runtimeId: string; profileDirectory: string;
  id?: string; expectedDigest?: string; decision?: 'approve' | 'reject'; cursor?: string; scopeId?: string; input?: unknown; proposalKey?: string; legacyScopeIds?: unknown };
interface Ctx {
  state: WorkerState; key: Buffer; workspaceId: string; profileId: string; runtimeId: string; at: number;
  settings?: MemorySettings; configDigest?: string; held: Map<MemoryTarget, MemoryReviewErrorCode>;
  /** Worker-staged proposal copies to remove from the profile after commit. */
  cleanup: Map<string, string>;
  /** A worker-side memory edit was captured: project the approved memory back. */
  project?: boolean;
}
const get = (ctx: Ctx, key: string) => artifactBytes(ctx.state, key);
/** RealBud's own writes either store exactly or refuse the command; never a silent hold. */
const put = (ctx: Ctx, key: string, bytes: Buffer | string) => {
  const refused = putArtifact(ctx.state, key, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8'), 'realbud', ctx.at);
  if (refused) fail(refused === 'credential' ? 'blocked-content' : 'capacity');
};
const remove = (ctx: Ctx, key: string) => { delete ctx.state.artifacts[key]; };

// ── signed records (helper formats; MAC over the stored canonical bytes) ───
function signedBody(raw: Buffer, mac: string) {
  const text = raw.toString('utf8'), marker = `"mac":"${mac}",`;
  return text.includes(marker) ? text.replace(marker, '') : null;
}
function readReceipt(ctx: Ctx, id: string): Record<string, unknown> | 'bad' | null {
  const raw = get(ctx, paths.receipt(id)); if (!raw) return null;
  let obj: unknown; try { obj = JSON.parse(raw.toString('utf8')); } catch { return 'bad'; }
  if (!isObject(obj) || !sameKeys(obj, RECEIPT_KEYS) || obj.version !== 1 || typeof obj.mac !== 'string' || !HEX64.test(obj.mac)) return 'bad';
  const body = signedBody(raw, obj.mac);
  if (!body || !equalHex(obj.mac, hmac(ctx.key, `realbud-memory-receipt-v1\0${body}`))) return 'bad';
  if (!['pendingDigest', 'configDigest', 'beforeDigest', 'afterDigest', 'reviewDigest'].every(k => HEX64.test(String(obj[k]))) ||
    !['approve', 'reject'].includes(String(obj.decision)) || !['applied', 'rejected'].includes(String(obj.state)) || !['intent', 'final'].includes(String(obj.phase)) ||
    obj.state !== (obj.decision === 'approve' ? 'applied' : 'rejected') || obj.phase === 'intent' && obj.decision !== 'approve' ||
    !HEX8.test(String(obj.id)) || obj.id !== id || obj.workspaceId !== ctx.workspaceId || obj.profileId !== ctx.profileId ||
    // Legacy helper receipts bind the worker runtime they were decided under; the MAC is the authority.
    typeof obj.runtimeId !== 'string' || !RUNTIME_ID.test(obj.runtimeId)) return 'bad';
  return obj;
}
function writeSigned(ctx: Ctx, key: string, record: Record<string, unknown>, domain: string) {
  const body = canonical(record), mac = hmac(ctx.key, `${domain}\0${body}`), text = canonical({ ...record, mac });
  if (Buffer.byteLength(text) > MAX_BYTES) fail('capacity');
  put(ctx, key, text);
  return { ...record, mac };
}
type Journal = Record<string, unknown> & { state: string; id: string; requestKey: string; requestDigest: string; pendingDigest: string; scopeId: string; createdAt: number };
function recoveryDigest(ctx: Ctx, rec: Record<string, unknown>) {
  const original: Record<string, unknown> = {}; for (const key of JOURNAL_KEYS) if (key !== 'mac') original[key] = rec[key];
  return hmac(ctx.key, `realbud-memory-propose-recovery-v1\0${canonical({ ...original, version: 1, state: 'prepared' })}`);
}
function readJournal(ctx: Ctx, recKey: string): Journal | 'bad' | null {
  const raw = get(ctx, paths.journal(recKey)); if (!raw) return null;
  let obj: unknown; try { obj = JSON.parse(raw.toString('utf8')); } catch { return 'bad'; }
  if (!isObject(obj) || (obj.version !== 1 && obj.version !== 2) || !sameKeys(obj, obj.version === 2 ? CLOSED_KEYS : JOURNAL_KEYS) || typeof obj.mac !== 'string' || !HEX64.test(obj.mac)) return 'bad';
  const body = signedBody(raw, obj.mac), domain = obj.version === 2 ? 'realbud-memory-propose-closed-v2' : 'realbud-memory-propose-v1';
  if (!body || !equalHex(obj.mac, hmac(ctx.key, `${domain}\0${body}`))) return 'bad';
  if (!(obj.version === 2 ? ['closed'] : ['prepared', 'published']).includes(String(obj.state)) || !HEX8.test(String(obj.id)) ||
    !['requestDigest', 'pendingDigest', 'scopeId', 'requestKey'].every(k => HEX64.test(String(obj[k]))) || obj.id !== String(obj.requestKey).slice(0, 8) || obj.requestKey !== recKey ||
    !Number.isSafeInteger(obj.createdAt) || obj.workspaceId !== ctx.workspaceId || obj.profileId !== ctx.profileId || typeof obj.runtimeId !== 'string' || !RUNTIME_ID.test(obj.runtimeId)) return 'bad';
  if (obj.version === 2 && (!Number.isSafeInteger(obj.closedAt) || !HEX64.test(String(obj.recoveryDigest)) || !equalHex(String(obj.recoveryDigest), recoveryDigest(ctx, obj)))) return 'bad';
  return obj as Journal;
}

// ── pending proposals ───────────────────────────────────────────────────────
type Pending = { id: string; origin: 'foreground' | 'background_review'; createdAt: number; payload: MemoryPayload; action: string; target: MemoryTarget; pendingDigest: string; operationCount: number };
function parsePending(bytes: Buffer, id: string): Pending {
  let obj: unknown; try { obj = JSON.parse(decodeUtf8(bytes)); } catch (error) { if (error instanceof ReviewError) throw error; return fail('unsupported'); }
  if (!isObject(obj) || !sameKeys(obj, PENDING_TOP)) return fail('unsupported');
  if (obj.id !== id || obj.subsystem !== 'memory') fail('conflict');
  if (obj.origin !== 'foreground' && obj.origin !== 'background_review' || typeof obj.summary !== 'string' || !isObject(obj.payload)) fail('unsupported');
  const payload = store(() => normalizePayload(obj.payload));
  if (obj.action !== payload.action) fail('unsupported');
  const created = obj.created_at;
  if (typeof created !== 'number' || !Number.isFinite(created) || created < 0 || created > 8.64e12) fail('unsupported');
  return { id, origin: obj.origin as Pending['origin'], createdAt: (created as number) * 1000, payload, action: payload.action, target: payload.target, pendingDigest: sha(bytes),
    operationCount: payload.action === 'batch' ? payload.operations.length : 1 };
}
function store<T>(work: () => T): T {
  try { return work(); } catch (error) { if (error instanceof StoreRefusal) return fail(error.code); throw error; }
}
const loadPending = (ctx: Ctx, id: string) => { const bytes = get(ctx, paths.pending(id)); return bytes ? parsePending(bytes, id) : null; };
const readMemory = (ctx: Ctx, target: MemoryTarget) => { const bytes = get(ctx, paths.memory(target)); return bytes ? decodeUtf8(bytes) : ''; };
function ready(ctx: Ctx, target: MemoryTarget): MemorySettings {
  const held = ctx.held.get(target); if (held) fail(held);
  const settings = ctx.settings!;
  if (!settings.writeApproval || !targetEnabled(settings, target)) fail('disabled');
  return settings;
}
/** Pin against `before`, then replay without writing: the preview and the decision share this exact path. */
function dryRun(ctx: Ctx, payload: MemoryPayload, before: string) {
  const settings = ready(ctx, payload.target);
  return store(() => { const pinned = pinEntries(payload, before, settings); return { pinned, ...applyPending(pinned, before, settings) }; });
}
function reviewDigest(ctx: Ctx, rec: Pending, before: string, after: string) {
  return hmac(ctx.key, `realbud-memory-preview-v1\0${canonical({ action: rec.action, afterDigest: sha(after), beforeDigest: sha(before), charLimit: targetLimit(ctx.settings!, rec.target),
    configDigest: ctx.configDigest, createdAt: rec.createdAt, id: rec.id, operationCount: rec.operationCount, origin: rec.origin, pendingDigest: rec.pendingDigest,
    profileId: ctx.profileId, runtimeId: ctx.runtimeId, target: rec.target, version: 1, workspaceId: ctx.workspaceId })}`);
}
function previewState(ctx: Ctx, rec: Pending, before: string) {
  const { after } = dryRun(ctx, rec.payload, before);
  return { version: 1, id: rec.id, target: rec.target, action: rec.action, origin: rec.origin, createdAt: rec.createdAt, reviewDigest: reviewDigest(ctx, rec, before, after),
    before, after, operationCount: rec.operationCount, charLimit: targetLimit(ctx.settings!, rec.target) };
}
const shell = (id: string, state: string) => ({ id, state, action: null, target: null, origin: null, createdAt: null, decision: null, reviewDigest: null });
function classify(ctx: Ctx, id: string) {
  const receipt = readReceipt(ctx, id), claim = !!get(ctx, paths.claim(id)), bytes = get(ctx, paths.pending(id));
  let pending: Pending | null = null, broken = false;
  if (bytes) { try { pending = parsePending(bytes, id); } catch (error) { if (['unsafe-storage', 'capacity'].includes((error as ReviewError).code)) throw error; broken = true; } }
  if (receipt === 'bad') return shell(id, 'recovery-required');
  if (receipt) {
    if (receipt.phase === 'final' && (pending && pending.pendingDigest !== receipt.pendingDigest || broken)) return shell(id, 'recovery-required');
    return { ...shell(id, receipt.phase === 'intent' || bytes || claim ? 'recovery-required' : String(receipt.state)), action: receipt.action, target: receipt.target, origin: receipt.origin,
      createdAt: receipt.createdAt, decision: receipt.decision, reviewDigest: receipt.reviewDigest };
  }
  if (pending) return { id, state: 'pending', action: pending.action, target: pending.target, origin: pending.origin, createdAt: pending.createdAt, decision: null, reviewDigest: null };
  return shell(id, 'unavailable');
}
function reviewIds(ctx: Ctx) {
  const ids = new Set<string>();
  for (const key of Object.keys(ctx.state.artifacts)) {
    const match = /^(?:pending\/memory|\.realbud-memory-reviews)\/([a-f0-9]{8})\.json$/.exec(key); if (match) ids.add(match[1]);
  }
  if (ids.size > MAX_DIR) fail('capacity');
  return [...ids].sort();
}

// ── commands ────────────────────────────────────────────────────────────────
function list(ctx: Ctx, cursor?: string) {
  const ids = reviewIds(ctx), source = ids.filter(id => !cursor || id > cursor), page = source.slice(0, PAGE);
  const classified = new Map(ids.map(id => { try { return [id, classify(ctx, id)]; } catch { return [id, shell(id, 'unavailable')]; } }));
  return { version: 1, items: page.map(id => classified.get(id)!), nextCursor: source.length > PAGE ? page.at(-1)! : null, total: ids.length,
    held: [...classified.values()].filter(item => item.state === 'recovery-required' || item.state === 'unavailable').length };
}
function preview(ctx: Ctx, id: string) {
  if (readReceipt(ctx, id) !== null) fail('recovery-required');
  const rec = loadPending(ctx, id) ?? fail('unavailable');
  return previewState(ctx, rec, readMemory(ctx, rec.target));
}
function decided(receipt: Record<string, unknown>) {
  return { version: 1, id: receipt.id, state: receipt.state, reviewDigest: receipt.reviewDigest, changed: receipt.state === 'applied' && receipt.beforeDigest !== receipt.afterDigest, at: receipt.at };
}
function closePending(ctx: Ctx, id: string, digest: string) {
  const row = ctx.state.artifacts[paths.pending(id)];
  if (!row || row.digest !== digest) return;
  if (row.source !== 'realbud') ctx.cleanup.set(id, digest);
  remove(ctx, paths.pending(id));
}
function decide(ctx: Ctx, id: string, expected: string, decision: 'approve' | 'reject') {
  const receipt = readReceipt(ctx, id);
  if (receipt === 'bad') fail('recovery-required');
  const pending = loadPending(ctx, id);
  if (receipt && receipt.phase === 'final') {
    if (receipt.reviewDigest !== expected) fail('stale-review');
    if (receipt.decision !== decision) fail('conflict');
    if (pending && pending.pendingDigest !== receipt.pendingDigest) fail('conflict');
    closePending(ctx, id, String(receipt.pendingDigest));
    return decided(receipt);
  }
  // A helper decision interrupted after its intent is never completed or re-decided here.
  if (receipt) fail('recovery-required');
  if (!pending) return fail('unavailable');
  const before = readMemory(ctx, pending.target), view = previewState(ctx, pending, before);
  if (view.reviewDigest !== expected) fail('stale-review');
  const signed = writeSigned(ctx, paths.receipt(id), { version: 1, id, workspaceId: ctx.workspaceId, profileId: ctx.profileId, runtimeId: ctx.runtimeId, decision,
    state: decision === 'approve' ? 'applied' : 'rejected', phase: 'final', pendingDigest: pending.pendingDigest, configDigest: ctx.configDigest,
    beforeDigest: sha(view.before), afterDigest: sha(view.after), reviewDigest: view.reviewDigest, target: pending.target,
    action: pending.action, origin: pending.origin, createdAt: pending.createdAt, at: ctx.at, operationCount: pending.operationCount, charLimit: view.charLimit }, 'realbud-memory-receipt-v1');
  if (decision === 'approve' && view.after !== before) put(ctx, paths.memory(pending.target), view.after);
  closePending(ctx, id, pending.pendingDigest);
  return decided(signed);
}

function journalKeys(ctx: Ctx) {
  const keys = Object.keys(ctx.state.artifacts).flatMap(key => { const m = /^\.realbud-memory-reviews\/proposals\/([a-f0-9]{64})\.json$/.exec(key); return m ? [m[1]] : []; }).sort();
  if (keys.length > MAX_DIR) fail('capacity');
  return keys;
}
function requireAbsent(ctx: Ctx, recKey: string) {
  const id = recKey.slice(0, 8);
  // Any receipt, claim or draft (including malformed data) prevents administrative closure.
  for (const key of [paths.stage(recKey), paths.pending(id), paths.claim(id), paths.receipt(id)]) if (get(ctx, key)) fail('conflict');
}
const requireUnique = (keys: string[], recKey: string) => { if (keys.some(key => key !== recKey && key.slice(0, 8) === recKey.slice(0, 8))) fail('conflict'); };
function interruptedList(ctx: Ctx, cursor?: string) {
  const keys = journalKeys(ctx), rows: Record<string, unknown>[] = [];
  for (const recKey of keys) {
    if (cursor && recKey <= cursor) continue;
    const row: Record<string, unknown> = { key: recKey, state: 'recovery-required', createdAt: null, closedAt: null, recoveryDigest: null };
    try {
      const rec = readJournal(ctx, recKey);
      if (!rec || rec === 'bad') fail('recovery-required');
      const journal = rec as Journal;
      if (journal.state === 'published') continue;
      row.createdAt = journal.createdAt; requireUnique(keys, recKey); requireAbsent(ctx, recKey);
      Object.assign(row, { state: journal.state === 'closed' ? 'closed' : 'interrupted', closedAt: journal.closedAt ?? null, recoveryDigest: recoveryDigest(ctx, journal) });
    } catch (error) { if (!(error instanceof ReviewError)) throw error; }
    rows.push(row);
    if (rows.length > PAGE) break;
  }
  const page = rows.slice(0, PAGE);
  return { version: 1, items: page, nextCursor: rows.length > PAGE ? page.at(-1)!.key : null };
}
function interruptedClose(ctx: Ctx, recKey: string, expected: string) {
  requireUnique(journalKeys(ctx), recKey);
  const rec = readJournal(ctx, recKey);
  if (!rec || rec === 'bad') return fail('recovery-required');
  if (rec.state !== 'prepared' && rec.state !== 'closed') fail('conflict');
  if (!equalHex(recoveryDigest(ctx, rec), expected)) fail('stale-review');
  requireAbsent(ctx, recKey);
  let saved: Record<string, unknown> = rec;
  if (rec.state === 'prepared') {
    const { mac: _mac, ...body } = rec;
    // A metadata transition, never a human reject/approve receipt.
    saved = writeSigned(ctx, paths.journal(recKey), { ...body, version: 2, state: 'closed', closedAt: ctx.at, recoveryDigest: expected }, 'realbud-memory-propose-closed-v2');
  }
  return { version: 1, key: recKey, state: 'closed', closedAt: saved.closedAt, recoveryDigest: expected };
}

const proposed = (id: string) => ({ version: 1, id, reviewLocation: MEMORY_PROPOSAL_REVIEW_LOCATION });
function propose(ctx: Ctx, scopeId: string, raw: unknown, legacyScopeIds: unknown = []) {
  if (!HEX64.test(scopeId) || !Array.isArray(legacyScopeIds) || legacyScopeIds.length > 4 || !legacyScopeIds.every(value => typeof value === 'string' && HEX64.test(value))) fail('invalid');
  const input = parseMemoryProposalInput(raw) ?? fail('invalid');
  const text = (value: string) => { if (!value.trim()) fail('invalid'); if (value.includes(ENTRY_DELIMITER)) fail('blocked-content'); };
  const p = input.payload;
  for (const op of p.action === 'batch' ? p.operations : [p]) { if ('content' in op) text(op.content); if ('old_text' in op) text(op.old_text); }
  const sorted = canonical(input);
  if (Buffer.byteLength(sorted) > MAX_INPUT) fail('capacity');
  const payload = store(() => normalizePayload(p));
  const requestDigest = hmac(ctx.key, `realbud-memory-propose-request-v1\0${sorted}`);
  const keyFor = (scope: string) => hmac(ctx.key, `realbud-memory-propose-key-v1\0${scope}\0${input.requestId}`);
  let recKey = keyFor(scopeId), journal = readJournal(ctx, recKey), boundScope = scopeId;
  // A retry from a conversation that began under the helper finds its signed journal through the legacy binding.
  for (const legacy of journal ? [] : legacyScopeIds as string[]) {
    const found = readJournal(ctx, keyFor(legacy));
    if (found) { recKey = keyFor(legacy); journal = found; boundScope = legacy; break; }
  }
  const id = recKey.slice(0, 8);
  if (journal === 'bad') fail('recovery-required');
  if (journal) {
    if (journal.requestDigest !== requestDigest || journal.scopeId !== boundScope) fail('conflict');
    if (journal.state === 'closed') fail('proposal-closed');
  }
  if (get(ctx, paths.claim(id))) fail('recovery-required');
  const receipt = readReceipt(ctx, id), live = get(ctx, paths.pending(id));
  if (journal) {
    if (receipt) {
      if (receipt === 'bad' || receipt.pendingDigest !== journal.pendingDigest || get(ctx, paths.stage(recKey))) fail('recovery-required');
      if (live && sha(live) !== journal.pendingDigest) fail('conflict');
      return proposed(id);
    }
    // A legacy helper intent that never published stays for staff recovery.
    if (journal.state !== 'published' || !live) fail('recovery-required');
    if (sha(live!) !== journal.pendingDigest) fail('conflict');
    return proposed(id);
  }
  if (receipt) fail('recovery-required');
  if (live) fail('conflict');
  if (reviewIds(ctx).length + 3 > MAX_DIR || journalKeys(ctx).length + 2 > MAX_DIR) fail('capacity');
  const { pinned } = dryRun(ctx, payload, readMemory(ctx, payload.target));
  const createdAt = Math.floor(ctx.at / 1000);
  const blob = Buffer.from(JSON.stringify({ id, subsystem: 'memory', action: pinned.action, summary: MEMORY_PROPOSAL_REVIEW_LOCATION, origin: 'foreground', created_at: createdAt, payload: pinned }), 'utf8');
  if (blob.length > MAX_BYTES) fail('capacity');
  writeSigned(ctx, paths.journal(recKey), { version: 1, state: 'published', id, workspaceId: ctx.workspaceId, profileId: ctx.profileId, runtimeId: ctx.runtimeId,
    scopeId, requestKey: recKey, requestDigest, pendingDigest: sha(blob), createdAt: createdAt * 1000 }, 'realbud-memory-propose-v1');
  put(ctx, paths.pending(id), blob);
  return proposed(id);
}

// ── worker adoption and cleanup ─────────────────────────────────────────────
type WorkerCopies = { memory: Map<MemoryTarget, Buffer | 'unsafe'>; pending: Map<string, Buffer | 'unsafe'>; unlisted: number };
function workerCopies(profile: string): WorkerCopies {
  const out: WorkerCopies = { memory: new Map(), pending: new Map(), unlisted: 0 };
  const read = (path: string, max: number): Buffer | 'unsafe' | null => {
    try { const stat = lstatSync(path); if (!stat.isFile() || stat.nlink !== 1 || stat.size > max) return 'unsafe'; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR' ? null : 'unsafe'; }
    // The helper's admission: owner-only file in folders no one else can write.
    if (!strictWorkerFile(profile, path)) return 'unsafe';
    try { return readProfileFiles([path])[0] ?? null; } catch { return 'unsafe'; }
  };
  for (const target of ['memory', 'user'] as const) { const bytes = read(join(profile, ...MEMORY_KEYS[target].split('/')), MAX_BYTES); if (bytes) out.memory.set(target, bytes); }
  let names: string[] = [];
  try { const folder = join(profile, 'pending', 'memory'); if (lstatSync(folder).isDirectory()) names = readdirSync(folder).filter(name => /^[a-f0-9]{8}\.json$/.test(name)).sort(); } catch { /* none staged */ }
  out.unlisted = Math.max(0, names.length - WORKER_PENDING_LIMIT);
  for (const name of names.slice(0, WORKER_PENDING_LIMIT)) { const bytes = read(join(profile, 'pending', 'memory', name), MAX_BYTES); if (bytes) out.pending.set(name.slice(0, 8), bytes); }
  return out;
}

/** Take in what the worker staged or changed since RealBud last projected. A direct
 * edit of a memory file never changes canonical memory: it becomes a proposal. */
function adopt(ctx: Ctx, copies: WorkerCopies) {
  const draft = ctx.state;
  for (const [target, bytes] of copies.memory) {
    const key = MEMORY_KEYS[target];
    if (bytes === 'unsafe') { holdCopy(draft, key, Buffer.from(`realbud-unsafe-v1\0${key}`), 'unsafe', ctx.at); ctx.held.set(target, 'unsafe-storage'); continue; }
    const digest = sha(bytes), current = draft.artifacts[key];
    if (current?.digest === digest) { draft.projected[key] = digest; continue; }
    if (digest === draft.projected[key]) continue; // the worker has not caught up with RealBud yet
    const recorded = recordWorkerMemoryEdit(draft, target, bytes, ctx.at);
    // Every refusal is recorded (a digest-only hold) and holds this target only.
    if (recorded === 'credential') ctx.held.set(target, 'blocked-content');
    else if (recorded === 'unsafe') ctx.held.set(target, 'unavailable');
    else if (recorded === 'capacity') ctx.held.set(target, 'capacity');
    else ctx.project = true; // kept for review: the worker copy returns to the approved memory
  }
  if (copies.unlisted) holdCopy(draft, 'pending/memory', Buffer.from(`realbud-unlisted-v1\0${copies.unlisted}`), 'capacity', ctx.at);
  for (const [id, read] of copies.pending) {
    const key = paths.pending(id);
    if (read === 'unsafe') { holdCopy(draft, key, Buffer.from(`realbud-unsafe-v1\0${key}`), 'unsafe', ctx.at); continue; }
    const bytes = read, digest = sha(bytes), receipt = readReceipt(ctx, id), current = draft.artifacts[key];
    if (receipt) {
      if (receipt !== 'bad' && receipt.phase === 'final' && receipt.pendingDigest === digest && !current) ctx.cleanup.set(id, digest);
      else if (receipt === 'bad' || receipt.pendingDigest !== digest) preserveCopy(draft, key, bytes, 'worker-changed', ctx.at);
      continue;
    }
    if (current?.digest === digest) continue;
    // Worker staging is bounded: past the cap a staged file is held as a digest only.
    if (!current && Object.entries(draft.artifacts).filter(([name, row]) => name.startsWith('pending/memory/') && row.source === 'worker').length >= WORKER_PENDING_LIMIT) { holdCopy(draft, key, bytes, 'capacity', ctx.at); continue; }
    // The worker re-staged its own undecided proposal; a RealBud-owned one is never replaced.
    if (!current || current.source !== 'realbud') putArtifact(draft, key, bytes, 'worker', ctx.at);
    else preserveCopy(draft, key, bytes, 'worker-changed', ctx.at);
  }
}
/** Remove a decided worker copy only when its bytes are still the decided ones: claim by rename, check, then delete. */
function removeWorkerCopy(profile: string, id: string, digest: string) {
  const original = join(profile, 'pending', 'memory', `${id}.json`), claim = join(profile, 'pending', 'memory', `.${id}.${randomUUID()}.claim`);
  try { renameSync(original, claim); } catch { return; }
  let bytes: Buffer | null = null; try { [bytes] = readProfileFiles([claim]); } catch { /* keep the claim for service */ }
  if (bytes && sha(bytes) === digest) { unlinkSync(claim); return; }
  // Not ours to delete: put it back without replacing a newer staged file.
  try { linkSync(claim, original); unlinkSync(claim); } catch { /* preserved under its claim name */ }
}

/** The review helper's request/response contract over RealBud's canonical state. */
export async function runOwnedMemoryReview(request: OwnedRequest, options: { signal?: AbortSignal; dataDir?: string; now?: () => number } = {}): Promise<{ ok: true; result: unknown } | { ok: false; code: MemoryReviewErrorCode }> {
  const dataDir = options.dataDir ?? DATA_DIR, now = options.now ?? Date.now;
  try {
    const key = Buffer.from(request.key, 'base64');
    if (key.length !== 32 || key.toString('base64') !== request.key) fail('invalid');
    const scope: WorkerScope = workerScope(request.workspaceId, request.profileId, request.profileDirectory);
    if (!(await readWorkerState(scope, dataDir)).migration.complete) await importLegacyProfileFacts([scope], { dataDir, now });
    // Listing and recovery never depend on the worker's config file.
    const config = ['preview', 'decide', 'propose'].includes(request.command) ? readMemorySettings(request.profileDirectory) : null;
    const copies = workerCopies(request.profileDirectory);
    if (options.signal?.aborted) fail('unavailable');
    const cleanup = new Map<string, string>();
    let project = false;
    const { result } = await updateWorkerState(scope, null, draft => {
      const ctx: Ctx = { state: draft, key, workspaceId: request.workspaceId, profileId: request.profileId, runtimeId: request.runtimeId, at: now(),
        settings: config?.settings, configDigest: config?.digest, held: new Map(), cleanup };
      adopt(ctx, copies); project = ctx.project === true;
      if (config?.fallback) holdCopy(draft, 'config.yaml', config.fallback, 'unsafe', ctx.at);
      const adopted = structuredClone(draft);
      try {
        const value = dispatch(ctx, request);
        if (options.signal?.aborted) fail('unavailable');
        return { ok: true as const, result: value };
      } catch (error) {
        // Refusals keep only the adoption; the command itself changed nothing.
        Object.assign(draft, adopted);
        cleanup.clear();
        if (error instanceof ReviewError) return { ok: false as const, code: error.code };
        throw error;
      }
    }, dataDir);
    // Committed; now bring the worker copy along. A failure here only delays it to the next projection.
    if (project || result.ok && (request.command === 'decide' || cleanup.size)) {
      try { await projectProfileFacts(scope, { dataDir, now, keys: [MEMORY_KEYS.memory, MEMORY_KEYS.user] }); } catch { /* retried before the next launch */ }
      for (const [id, digest] of cleanup) { try { removeWorkerCopy(request.profileDirectory, id, digest); } catch { /* left for the next pass */ } }
    }
    return result;
  } catch (error) {
    if (error instanceof ReviewError) return { ok: false, code: error.code };
    const code = (error as { code?: unknown })?.code;
    return { ok: false, code: code === 'unsafe-storage' || code === 'capacity' ? code : 'unavailable' };
  }
}
function dispatch(ctx: Ctx, request: OwnedRequest): unknown {
  switch (request.command) {
    case 'list': return list(ctx, request.cursor);
    case 'preview': return preview(ctx, request.id!);
    case 'decide': return decide(ctx, request.id!, request.expectedDigest!, request.decision!);
    case 'propose': return propose(ctx, request.scopeId!, request.input, request.legacyScopeIds);
    case 'interrupted-list': return interruptedList(ctx, request.cursor);
    case 'interrupted-close': return interruptedClose(ctx, request.proposalKey!, request.expectedDigest!);
    default: return fail('invalid');
  }
}
