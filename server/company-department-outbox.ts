import type { IncomingMessage } from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { DEPARTMENT_OPERATION_PATHS, departmentOperationTitle, departmentRequestId, normalizeDepartmentOperation, type DepartmentOutboxOperation, type DepartmentOutboxState } from '../shared/company-department-outbox.ts';
import type { createPrivateVault } from './private-vault.ts';

type Reply = { status: number; body: unknown };
type Request = Pick<IncomingMessage, 'headers'>;
type Proof = { receiptId: string; entityId: string; replayed: boolean };
type Saved = DepartmentOutboxOperation & { version: 1; companyId: string; memberId: string; phase: 'pending' | 'confirmed'; receipt?: Proof };
type Archived = Saved & { archivedAt: string; outcome: 'saved' | 'unknown'; reason: 'user-acknowledged-unknown' };
const STATE = '/api/company/department-outbox', ACK = `${STATE}/ack`, KEY = 'department-outbox';
const operations: ReadonlySet<string> = new Set(DEPARTMENT_OPERATION_PATHS);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const recovery = () => Object.assign(new Error('Saved department changes need recovery. The original record has been preserved.'), { status: 503, code: 'department_outbox_pending' });
const unavailable = (): Reply => ({ status: 503, body: { code: 'department_outbox_pending', error: 'This department change could not be confirmed. Review its saved state before trying again or leaving.' } });
const held = (): Reply => ({ status: 409, body: { code: 'department_outbox_pending', error: 'An earlier department change needs review. Retry that exact change, acknowledge its saved receipt, or archive its local recovery record.' } });
const conflict = (): Reply => ({ status: 409, body: { code: 'department_outbox_conflict', error: 'This request identifies a different saved department change. Keep the original request and review its recovery record.' } });
const invalid = (): Reply => ({ status: 400, body: { code: 'invalid_input', error: 'Check the department change fields.' } });
function exact(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).sort().join(',') === keys.sort().join(','); }
function entityId(operation: DepartmentOutboxOperation): string {
  return operation.path === '/api/company/departments/lifecycle' ? operation.input.departmentId
    : operation.path === '/api/company/departments/cases/create' ? operation.input.requestId : operation.input.caseId;
}
function proof(value: unknown, operation: DepartmentOutboxOperation): Proof {
  if (!record(value) || !exact(value, ['receiptId', 'entityId', 'replayed']) || value.receiptId !== operation.input.requestId || value.entityId !== entityId(operation) || typeof value.replayed !== 'boolean') throw recovery();
  return { receiptId: String(value.receiptId), entityId: String(value.entityId), replayed: value.replayed };
}
function decode(value: unknown): Saved {
  try {
    if (!record(value) || value.version !== 1 || (value.phase !== 'pending' && value.phase !== 'confirmed') || typeof value.path !== 'string' ||
      !exact(value, ['version', 'companyId', 'memberId', 'phase', 'path', 'input', ...(value.phase === 'confirmed' ? ['receipt'] : [])])) throw recovery();
    const operation = normalizeDepartmentOperation(value.path, value.input);
    const companyId = departmentRequestId(value.companyId), memberId = departmentRequestId(value.memberId);
    if (companyId !== value.companyId || memberId !== value.memberId || !isDeepStrictEqual(operation.input, value.input)) throw recovery();
    return value.phase === 'confirmed'
      ? { ...operation, version: 1, companyId, memberId, phase: 'confirmed', receipt: proof(value.receipt, operation) }
      : { ...operation, version: 1, companyId, memberId, phase: 'pending' };
  } catch { throw recovery(); }
}
function decodeArchive(value: unknown, requestId: string): Archived {
  if (!record(value)) throw recovery();
  const { archivedAt, outcome, reason, ...pending } = value;
  const saved = decode(pending);
  const expectedOutcome = saved.phase === 'confirmed' ? 'saved' : 'unknown';
  if (saved.input.requestId !== requestId || typeof archivedAt !== 'string' || !Number.isFinite(Date.parse(archivedAt)) ||
    new Date(archivedAt).toISOString() !== archivedAt ||
    outcome !== expectedOutcome || reason !== 'user-acknowledged-unknown') throw recovery();
  return { ...saved, archivedAt, outcome: expectedOutcome, reason };
}

/** One encrypted, explicit-replay journal per private installation. It never
 * holds a session token and never treats archiving as remote cancellation. */
export function createCompanyDepartmentOutbox(options: {
  vault: ReturnType<typeof createPrivateVault>;
  forward: (path: string, method: string, request: Request, body?: unknown) => Promise<Reply>;
  departurePending: () => Promise<boolean>;
  matchesIdentity: (companyId: string, memberId: string) => Promise<boolean>;
}) {
  let queue: Promise<unknown> = Promise.resolve(), waiting = 0;
  function serial<T>(action: () => Promise<T>): Promise<T> {
    if (waiting >= 8) return Promise.reject(recovery());
    waiting++;
    const next = queue.then(action);
    queue = next.catch(() => {}).finally(() => { waiting--; });
    return next;
  }
  async function saved(): Promise<Saved | undefined> {
    try { const value = await options.vault.read(KEY); return value === undefined ? undefined : decode(value); }
    catch { throw recovery(); }
  }
  async function archived(requestId: string): Promise<Archived | undefined> {
    try { const value = await options.vault.read(`department-change-${requestId}`); return value === undefined ? undefined : decodeArchive(value, requestId); }
    catch { throw recovery(); }
  }
  async function handle(path: string, method: string, request: Request, body?: unknown): Promise<Reply> {
    if (!((path === STATE && method === 'GET') || (path === ACK && method === 'POST') || (operations.has(path) && method === 'POST'))) return { status: 405, body: { error: 'Method unavailable.' } };
    let operation: DepartmentOutboxOperation | undefined, ackId: string | undefined;
    try {
      if (operations.has(path)) operation = normalizeDepartmentOperation(path, body);
      if (path === ACK) {
        if (!record(body) || !exact(body, ['requestId'])) return invalid();
        ackId = departmentRequestId(body.requestId);
      }
    } catch { return invalid(); }
    if (path !== STATE && await options.departurePending()) return held();
    const identity = await options.forward('/api/company/me', 'GET', request);
    if (identity.status !== 200) return { status: identity.status, body: { code: 'department_outbox_pending', error: 'Sign in to the current office to review this department change. Its saved record is preserved.' } };
    if (!record(identity.body) || !record(identity.body.company) || !record(identity.body.member)) throw recovery();
    const companyId = departmentRequestId(identity.body.company.id), memberId = departmentRequestId(identity.body.member.id);
    if (!await options.matchesIdentity(companyId, memberId)) return { status: 403, body: { code: 'forbidden', error: 'The office session does not match this private workspace.' } };
    const pending = await saved(), sameMember = !pending || pending.companyId === companyId && pending.memberId === memberId;
    if (path === STATE) {
      const state: DepartmentOutboxState = { pending: pending && sameMember ? { path: pending.path, input: pending.input, phase: pending.phase } as DepartmentOutboxState['pending'] : null, otherOfficePending: !sameMember };
      return { status: 200, body: state };
    }
    if (!sameMember) return held();
    if (path === ACK) {
      if (!pending) return { status: 200, body: { ok: true } };
      if (pending.phase !== 'confirmed' || pending.input.requestId !== ackId) return held();
      await options.vault.remove(KEY);
      return { status: 200, body: { ok: true } };
    }
    if (!operation) return invalid();
    if (pending && (pending.path !== operation.path || !isDeepStrictEqual(pending.input, operation.input))) {
      return pending.input.requestId === operation.input.requestId ? conflict() : held();
    }
    if (!pending && await archived(operation.input.requestId)) return conflict();
    const next: Saved = pending ?? { ...operation, version: 1, companyId, memberId, phase: 'pending' };
    // Never dispatch before the exact normalized request is durable. An existing
    // confirmed receipt stays confirmed if its explicit replay loses a response.
    if (!pending) await options.vault.write(KEY, next);
    const result = await options.forward(operation.path, 'POST', request, operation.input);
    if (result.status >= 200 && result.status < 300) {
      const response = result.body;
      if (!record(response)) throw recovery();
      const entity = operation.path === '/api/company/departments/lifecycle' ? response.department : response.item;
      const receipt = proof({ receiptId: response.receiptId, entityId: record(entity) ? entity.id : undefined, replayed: response.replayed }, operation);
      await options.vault.write(KEY, { ...next, phase: 'confirmed', receipt });
    } else if (!pending && [400, 401, 403, 404, 405, 409, 422].includes(result.status)) {
      // Only a first, definitively rejected attempt can be cleared. Timeouts,
      // throttling and every failure after an uncertain attempt remain held.
      await options.vault.remove(KEY);
    }
    return result;
  }
  return {
    handles: (path: string, _method: string) => path === STATE || path === ACK || operations.has(path),
    handle: (path: string, method: string, request: Request, body?: unknown): Promise<Reply> => serial(() => handle(path, method, request, body)).catch(() => unavailable()),
    drain: () => queue,
    departureAllowed: () => serial(async () => (await saved())?.phase !== 'pending'),
    localState: () => serial(async () => {
      const pending = await saved();
      return pending ? { requestId: pending.input.requestId, departmentId: pending.input.departmentId, title: departmentOperationTitle(pending), phase: pending.phase } : null;
    }),
    archives: () => serial(async () => {
      try {
        const list = await options.vault.names('department-change-');
        const records = await Promise.all(list.names.map(async name => {
          const id = departmentRequestId(name.slice('department-change-'.length)), value = await archived(id);
          if (!value) throw recovery();
          return { requestId: id, departmentId: value.input.departmentId, title: departmentOperationTitle(value), archivedAt: value.archivedAt, outcome: value.outcome };
        }));
        return { records, hasMore: list.hasMore };
      } catch { throw recovery(); }
    }),
    exportArchive: (requestId: string): Promise<Reply> => serial(async () => {
      let id: string; try { id = departmentRequestId(requestId); } catch { return invalid(); }
      const value = await archived(id);
      return value ? { status: 200, body: { record: value } } : { status: 404, body: { error: 'Recovery record unavailable.' } };
    }).catch(() => unavailable()),
    archive: (requestId: string, acknowledgeUnknown: boolean): Promise<Reply> => serial(async () => {
      let id: string; try { id = departmentRequestId(requestId); } catch { return invalid(); }
      if (acknowledgeUnknown !== true) return held();
      const pending = await saved();
      if (!pending) return await archived(id) ? { status: 200, body: { ok: true } }
        : { status: 409, body: { code: 'department_outbox_conflict', error: 'No pending change or archived receipt matches this request. Refresh the recovery list.' } };
      if (pending.input.requestId !== id) return held();
      const previous = await archived(id);
      if (previous && (previous.companyId !== pending.companyId || previous.memberId !== pending.memberId || previous.path !== pending.path || !isDeepStrictEqual(previous.input, pending.input))) return conflict();
      const archive: Archived = { ...pending, archivedAt: previous?.archivedAt ?? new Date().toISOString(),
        outcome: pending.phase === 'confirmed' ? 'saved' : 'unknown', reason: 'user-acknowledged-unknown' };
      if (previous && !isDeepStrictEqual(previous, archive)) return conflict();
      if (!previous) await options.vault.write(`department-change-${id}`, archive);
      await options.vault.remove(KEY);
      return { status: 200, body: { ok: true } };
    }).catch(() => unavailable()),
  };
}
