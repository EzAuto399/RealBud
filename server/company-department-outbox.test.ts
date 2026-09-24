import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPrivateVault } from './private-vault.ts';
import { createCompanyDepartmentOutbox } from './company-department-outbox.ts';
import { normalizeDepartmentOperation, type DepartmentOutboxOperation } from '../shared/company-department-outbox.ts';

type Reply = { status: number; body: unknown };
type Options = Parameters<typeof createCompanyDepartmentOutbox>[0];
const roots: string[] = [];
const request = { headers: { authorization: 'Bearer fictional-session-never-persisted' } };
const STATE = '/api/company/department-outbox', ACK = `${STATE}/ack`, KEY = 'department-outbox';
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function operation(action: 'create' | 'assign' | 'close' | 'recover' | 'lifecycle' = 'create'): DepartmentOutboxOperation {
  const common = { departmentId: randomUUID(), requestId: randomUUID() };
  if (action === 'create') return normalizeDepartmentOperation('/api/company/departments/cases/create', { ...common,
    title: 'Fictional private department task', description: 'Private task instructions', assigneeMemberId: null });
  if (action === 'lifecycle') return normalizeDepartmentOperation('/api/company/departments/lifecycle', { ...common, expectedRevision: '2', retired: true, note: 'Retain completed office records' });
  const input = { ...common, caseId: randomUUID(), expectedFence: '4' };
  return normalizeDepartmentOperation(`/api/company/departments/cases/${action}`, action === 'assign'
    ? { ...input, assigneeMemberId: randomUUID() } : { ...input, resolution: 'done', note: 'Human reviewed this result' });
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rb-department-outbox-')); roots.push(root);
  const vault = createPrivateVault(root, Buffer.alloc(32, 47));
  const actor = { company: { id: randomUUID() }, member: { id: randomUUID() } };
  const state = { actor, seat: actor, departure: false, authStatus: 200 };
  const committed = new Map<string, DepartmentOutboxOperation>();
  let behavior = async (_operation: DepartmentOutboxOperation, commit: () => Reply): Promise<Reply> => commit();
  const forward = vi.fn(async (path: string, _method: string, _request: unknown, body?: unknown): Promise<Reply> => {
    if (path === '/api/company/me') return { status: state.authStatus, body: state.actor };
    const op = normalizeDepartmentOperation(path, body);
    return behavior(op, () => {
      const replayed = committed.has(op.input.requestId);
      if (!replayed) committed.set(op.input.requestId, structuredClone(op));
      const id = op.path === '/api/company/departments/cases/create' ? op.input.requestId
        : op.path === '/api/company/departments/lifecycle' ? op.input.departmentId : op.input.caseId;
      return { status: 200, body: { [op.path.endsWith('/lifecycle') ? 'department' : 'item']: { id }, receiptId: op.input.requestId, replayed } };
    });
  });
  const open = (overrides: Partial<Options> = {}) => createCompanyDepartmentOutbox({ vault, forward,
    departurePending: async () => state.departure,
    matchesIdentity: async (company, member) => company === state.seat.company.id && member === state.seat.member.id,
    ...overrides });
  return { root, vault, forward, state, committed, open, setBehavior: (next: typeof behavior) => { behavior = next; },
    file: join(root, 'company-installation/private/department-outbox.json'),
    mutations: () => forward.mock.calls.filter(call => call[0] !== '/api/company/me') };
}

describe('durable department mutation journal', () => {
  it('persists before dispatch, recovers an encrypted uncertain request after restart, and replays once', async () => {
    const f = await fixture(), op = operation(); let lose = true;
    f.setBehavior(async (sent, commit) => {
      expect(await f.vault.read(KEY)).toMatchObject({ phase: 'pending', path: sent.path, input: sent.input });
      const result = commit(); if (lose) { lose = false; throw new Error('private remote diagnostic'); } return result;
    });
    expect(await f.open().handle(op.path, 'POST', request, op.input)).toMatchObject({ status: 503, body: { code: 'department_outbox_pending' } });
    expect(f.committed.size).toBe(1);
    const raw = await readFile(f.file, 'utf8');
    for (const secret of ['Fictional private', 'Private task', 'fictional-session', f.state.actor.company.id, f.state.actor.member.id]) expect(raw).not.toContain(secret);
    const restarted = f.open();
    expect(await restarted.departureAllowed()).toBe(false);
    expect(await restarted.handle(STATE, 'GET', request)).toMatchObject({ status: 200, body: { pending: { ...op, phase: 'pending' }, otherOfficePending: false } });
    expect(f.mutations()).toHaveLength(1); // Reading never retries a write.
    expect(await restarted.handle(op.path, 'POST', request, op.input)).toMatchObject({ status: 200, body: { replayed: true } });
    expect(f.committed.size).toBe(1);
    expect(await restarted.localState()).toMatchObject({ requestId: op.input.requestId, departmentId: op.input.departmentId, phase: 'confirmed' });
    expect(await restarted.departureAllowed()).toBe(true);
    expect((await restarted.handle(ACK, 'POST', request, { requestId: op.input.requestId })).status).toBe(200);
    expect(await f.open().localState()).toBeNull();
  });

  it.each(['create', 'assign', 'close', 'recover', 'lifecycle'] as const)('normalizes and validates the %s operation and its receipt identity', async action => {
    const f = await fixture(), op = operation(action), outbox = f.open();
    const input = { ...op.input, departmentId: op.input.departmentId.toUpperCase(), requestId: op.input.requestId.toUpperCase() };
    if ('title' in input) { input.title = ` ${input.title} `; input.description = ` ${input.description} `; }
    if ('note' in input) input.note = ` ${input.note} `;
    expect((await outbox.handle(op.path, 'POST', request, input)).status).toBe(200);
    expect(f.committed.get(op.input.requestId)).toEqual(op);
    expect(await f.vault.read(KEY)).toMatchObject({ phase: 'confirmed', path: op.path, input: op.input, receipt: { receiptId: op.input.requestId, replayed: false } });
  });

  it('holds edited, replacement and changed-path attempts without overwriting the original', async () => {
    const f = await fixture(), op = operation('close'), outbox = f.open();
    f.setBehavior(async (_op, commit) => { commit(); throw new Error('response lost'); });
    await outbox.handle(op.path, 'POST', request, op.input);
    const raw = await readFile(f.file, 'utf8');
    expect(await outbox.handle(op.path, 'POST', request, { ...op.input, note: 'Changed review' })).toMatchObject({ status: 409, body: { code: 'department_outbox_conflict' } });
    expect(await outbox.handle('/api/company/departments/cases/recover', 'POST', request, op.input)).toMatchObject({ status: 409, body: { code: 'department_outbox_conflict' } });
    expect(await outbox.handle(op.path, 'POST', request, { ...op.input, requestId: randomUUID() })).toMatchObject({ status: 409, body: { code: 'department_outbox_pending' } });
    expect(await outbox.handle(ACK, 'POST', request, { requestId: op.input.requestId })).toMatchObject({ status: 409 });
    expect(await readFile(f.file, 'utf8')).toBe(raw);
    expect(f.mutations()).toHaveLength(1);
  });

  it('requires acknowledgement before another request and retains confirmation after a failed explicit replay', async () => {
    const f = await fixture(), op = operation(), next = operation(), outbox = f.open();
    await outbox.handle(op.path, 'POST', request, op.input);
    expect((await outbox.handle(next.path, 'POST', request, next.input)).status).toBe(409);
    f.setBehavior(async () => ({ status: 403, body: { code: 'forbidden' } }));
    expect((await outbox.handle(op.path, 'POST', request, op.input)).status).toBe(403);
    expect(await outbox.localState()).toMatchObject({ phase: 'confirmed' });
    expect((await outbox.handle(ACK, 'POST', request, { requestId: op.input.requestId, forged: true })).status).toBe(400);
    expect((await outbox.handle(ACK, 'POST', request, { requestId: randomUUID() })).status).toBe(409);
    expect((await outbox.handle(ACK, 'POST', request, { requestId: op.input.requestId })).status).toBe(200);
    expect(await outbox.localState()).toBeNull();
  });

  it('refuses mismatched seats and conceals a pending payload from a different authenticated identity', async () => {
    const f = await fixture(), op = operation(), outbox = f.open();
    await outbox.handle(op.path, 'POST', request, op.input);
    f.state.actor = { company: { id: randomUUID() }, member: { id: randomUUID() } };
    expect((await outbox.handle(STATE, 'GET', request)).status).toBe(403);
    f.state.seat = f.state.actor;
    expect(await outbox.handle(STATE, 'GET', request)).toEqual({ status: 200, body: { pending: null, otherOfficePending: true } });
    expect((await outbox.handle(op.path, 'POST', request, op.input)).status).toBe(409);
    expect((await outbox.handle(ACK, 'POST', request, { requestId: op.input.requestId })).status).toBe(409);
    expect(f.mutations()).toHaveLength(1);
    f.state.authStatus = 401;
    expect(JSON.stringify(await outbox.handle(STATE, 'GET', request))).not.toContain('Fictional private');
  });

  it('does not dispatch when departure is pending or durable admission cannot be written', async () => {
    const f = await fixture(), op = operation(); f.state.departure = true;
    expect((await f.open().handle(op.path, 'POST', request, op.input)).status).toBe(409);
    expect(f.forward).not.toHaveBeenCalled(); f.state.departure = false;
    const write = vi.fn(async () => { throw new Error('private disk path'); });
    expect(await f.open({ vault: { ...f.vault, write } }).handle(op.path, 'POST', request, op.input)).toMatchObject({ status: 503 });
    expect(f.mutations()).toHaveLength(0); expect(f.committed.size).toBe(0);
  });

  it('clears a first definitive rejection but retains any rejection after uncertainty and any timeout', async () => {
    const f = await fixture(), op = operation(), outbox = f.open();
    f.setBehavior(async () => ({ status: 409, body: { code: 'conflict' } }));
    expect((await outbox.handle(op.path, 'POST', request, op.input)).status).toBe(409);
    expect(await outbox.localState()).toBeNull();
    f.setBehavior(async () => ({ status: 408, body: { error: 'timeout' } }));
    await outbox.handle(op.path, 'POST', request, op.input);
    expect(await outbox.localState()).toMatchObject({ phase: 'pending' });
    f.setBehavior(async () => ({ status: 403, body: { code: 'forbidden' } }));
    await f.open().handle(op.path, 'POST', request, op.input);
    expect(await outbox.localState()).toMatchObject({ phase: 'pending' });
  });

  it.each(['receipt', 'entity', 'replayed'] as const)('keeps an uncertain journal when success has a bad %s field', async field => {
    const f = await fixture(), op = operation();
    f.setBehavior(async (_op, commit) => {
      const result = commit(); const body = result.body as { receiptId: string; item: { id: string }; replayed: unknown };
      if (field === 'receipt') body.receiptId = randomUUID();
      else if (field === 'entity') body.item.id = randomUUID(); else body.replayed = 'true';
      return result;
    });
    expect((await f.open().handle(op.path, 'POST', request, op.input)).status).toBe(503);
    expect(await f.open().localState()).toMatchObject({ phase: 'pending' });
    expect(await f.open().departureAllowed()).toBe(false);
  });

  it('stores only the minimal confirmed receipt, without upstream diagnostics or credentials', async () => {
    const f = await fixture(), op = operation();
    f.setBehavior(async (_op, commit) => { const result = commit(); Object.assign(result.body as object, { credential: 'fictional-provider-key', debug: { session: request.headers.authorization } }); return result; });
    await f.open().handle(op.path, 'POST', request, op.input);
    const saved = JSON.stringify(await f.vault.read(KEY));
    expect(saved).not.toContain('fictional-provider-key'); expect(saved).not.toContain('fictional-session');
    expect(JSON.parse(saved).receipt).toEqual({ receiptId: op.input.requestId, entityId: op.input.requestId, replayed: false });
  });

  it('retains the pending command when a committed result cannot be persisted, then confirms its replay', async () => {
    const f = await fixture(), op = operation();
    const write: typeof f.vault.write = async (name, value) => {
      if ((value as { phase?: string }).phase === 'confirmed') throw new Error('private disk diagnostic');
      await f.vault.write(name, value);
    };
    expect((await f.open({ vault: { ...f.vault, write } }).handle(op.path, 'POST', request, op.input)).status).toBe(503);
    expect(f.committed.size).toBe(1);
    expect(await f.open().localState()).toMatchObject({ phase: 'pending' });
    expect(await f.open().handle(op.path, 'POST', request, op.input)).toMatchObject({ status: 200, body: { replayed: true } });
    expect(f.committed.size).toBe(1);
  });

  it('holds malformed persisted records without rewriting or deleting their bytes', async () => {
    const f = await fixture(), op = operation();
    const base = { ...op, version: 1, companyId: f.state.actor.company.id, memberId: f.state.actor.member.id, phase: 'pending' };
    for (const bad of [null, { ...base, path: '/api/company/leave' }, { ...base, phase: 'confirmed' },
      { ...base, phase: ['pending'] }, { ...base, path: [op.path] },
      { ...base, input: { ...op.input, unexpected: true } }, { ...base, token: 'fictional-secret' }]) {
      await f.vault.write(KEY, bad); const raw = await readFile(f.file, 'utf8');
      const outbox = f.open();
      expect((await outbox.handle(STATE, 'GET', request)).status).toBe(503);
      await expect(outbox.departureAllowed()).rejects.toMatchObject({ status: 503, code: 'department_outbox_pending' });
      expect((await outbox.handle(op.path, 'POST', request, op.input)).status).toBe(503);
      expect((await outbox.archive(op.input.requestId, true)).status).toBe(503);
      expect(await readFile(f.file, 'utf8')).toBe(raw);
    }
    expect(f.mutations()).toHaveLength(0);
  });

  it('archives offline only after explicit acknowledgement and exports a validated encrypted outcome', async () => {
    const f = await fixture(), op = operation(), outbox = f.open();
    f.setBehavior(async (_op, commit) => { commit(); throw new Error('lost'); });
    await outbox.handle(op.path, 'POST', request, op.input); f.state.authStatus = 401;
    expect((await outbox.archive(op.input.requestId, false)).status).toBe(409);
    expect((await outbox.archive(randomUUID(), true)).status).toBe(409);
    expect((await outbox.archive(op.input.requestId, true)).status).toBe(200);
    expect((await f.open().archive(op.input.requestId, true)).status).toBe(200);
    expect(await outbox.departureAllowed()).toBe(true);
    expect(f.committed.size).toBe(1);
    expect(await f.open().archives()).toMatchObject({ records: [{ requestId: op.input.requestId, departmentId: op.input.departmentId, outcome: 'unknown' }], hasMore: false });
    expect(await f.open().exportArchive(op.input.requestId)).toMatchObject({ status: 200, body: { record: { ...op, outcome: 'unknown', phase: 'pending' } } });
    const raw = await readFile(join(f.root, `company-installation/private/department-change-${op.input.requestId}.json`), 'utf8');
    expect(raw).not.toContain('Private task');
    expect((await outbox.exportArchive('../development-key')).status).toBe(400);
    f.state.authStatus = 200;
    expect((await outbox.handle(op.path, 'POST', request, op.input)).status).toBe(409);
    expect(f.mutations()).toHaveLength(1);
  });

  it('does not claim an archive exists when another tab acknowledged the confirmed change first', async () => {
    const f = await fixture(), op = operation(), firstTab = f.open(), secondTab = f.open();
    await firstTab.handle(op.path, 'POST', request, op.input);
    expect(await firstTab.localState()).toMatchObject({ phase: 'confirmed' });
    expect((await secondTab.handle(ACK, 'POST', request, { requestId: op.input.requestId })).status).toBe(200);
    expect(await firstTab.archive(op.input.requestId, true)).toMatchObject({ status: 409, body: { code: 'department_outbox_conflict' } });
    expect((await firstTab.exportArchive(op.input.requestId)).status).toBe(404);
    expect((await firstTab.archives()).records).toEqual([]);
  });

  it('preserves the original archive receipt when removal failed and holds conflicting archive evidence', async () => {
    const f = await fixture(), op = operation();
    await f.open().handle(op.path, 'POST', request, op.input);
    const remove = vi.fn(async () => { throw new Error('disk unavailable'); });
    const interrupted = f.open({ vault: { ...f.vault, remove } });
    expect((await interrupted.archive(op.input.requestId, true)).status).toBe(503);
    const name = `department-change-${op.input.requestId}`, archiveFile = join(f.root, `company-installation/private/${name}.json`);
    const raw = await readFile(archiveFile, 'utf8');
    expect((await f.open().archive(op.input.requestId, true)).status).toBe(200);
    expect(await readFile(archiveFile, 'utf8')).toBe(raw);
    expect(await f.open().localState()).toBeNull();
    const archived = await f.vault.read(name) as Record<string, unknown>;
    const { archivedAt: _at, outcome: _outcome, reason: _reason, ...saved } = archived;
    await f.vault.write(KEY, { ...saved, input: { ...op.input, title: 'Different local command' } });
    expect((await f.open().archive(op.input.requestId, true)).status).toBe(409);
    expect(await readFile(archiveFile, 'utf8')).toBe(raw);
    expect(await f.vault.read(KEY)).toBeDefined();
  });

  it('does not clear pending work when archive creation fails or export a malformed archive', async () => {
    const f = await fixture(), op = operation();
    await f.open().handle(op.path, 'POST', request, op.input);
    const raw = await readFile(f.file, 'utf8');
    const write = vi.fn(async () => { throw new Error('private archive storage path'); });
    expect((await f.open({ vault: { ...f.vault, write } }).archive(op.input.requestId, true)).status).toBe(503);
    expect(await readFile(f.file, 'utf8')).toBe(raw);
    await f.vault.write(`department-change-${op.input.requestId}`, { ...(await f.vault.read(KEY) as object),
      archivedAt: new Date().toISOString(), outcome: 'unknown', reason: 'user-acknowledged-unknown', credential: 'never-export-this' });
    const response = await f.open().exportArchive(op.input.requestId);
    expect(response.status).toBe(503); expect(JSON.stringify(response)).not.toContain('never-export-this');
    await expect(f.open().archives()).rejects.toMatchObject({ code: 'department_outbox_pending' });
    expect(await readFile(f.file, 'utf8')).toBe(raw);
  });

  it('serializes simultaneous requests and drain waits for the outstanding mutation', async () => {
    const f = await fixture(), op = operation(), next = operation();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    f.setBehavior(async (_op, commit) => { entered(); await gate; return commit(); });
    const outbox = f.open(), first = outbox.handle(op.path, 'POST', request, op.input);
    await started;
    const second = outbox.handle(next.path, 'POST', request, next.input);
    let drained = false; const drain = outbox.drain().then(() => { drained = true; });
    expect(drained).toBe(false); release();
    expect((await first).status).toBe(200); expect((await second).status).toBe(409); await drain;
    expect(drained).toBe(true); expect(f.committed.size).toBe(1);
  });

  it('rejects extra, oversized, malformed identity/revision and invalid route fields before journaling', async () => {
    const f = await fixture(), op = operation('close'), outbox = f.open();
    for (const input of [{ ...op.input, extra: 'credential' }, { ...op.input, note: 'x'.repeat(2049) },
      { ...op.input, departmentId: '../private' }, { ...op.input, requestId: 'not-a-uuid' },
      { ...op.input, expectedFence: '01' }, { ...op.input, expectedFence: '9223372036854775808' },
      { ...op.input, resolution: 'released' }, { ...op.input, note: '\0secret' }]) {
      expect((await outbox.handle(op.path, 'POST', request, input)).status).toBe(400);
    }
    const create = operation();
    expect((await outbox.handle(create.path, 'POST', request, { ...create.input, title: 'x'.repeat(241) })).status).toBe(400);
    expect((await outbox.handle(create.path, 'POST', request, { ...create.input, description: 'x'.repeat(4001) })).status).toBe(400);
    const lifecycle = operation('lifecycle');
    expect((await outbox.handle(lifecycle.path, 'POST', request, { ...lifecycle.input, retired: 'true' })).status).toBe(400);
    expect((await outbox.handle(op.path, 'GET', request, op.input)).status).toBe(405);
    expect(outbox.handles('/api/company/departments/cases/create-more', 'POST')).toBe(false);
    expect(outbox.handles('/api/company/departments', 'POST')).toBe(false);
    expect(await f.vault.read(KEY)).toBeUndefined(); expect(f.forward).not.toHaveBeenCalled();
  });
});
