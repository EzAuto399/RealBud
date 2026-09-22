import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowDatabase } from './workflow-database.ts';
import { createBillProposals } from './bill-proposals.ts';
import { defaultAgencySettings } from './agency-setup.ts';
import { previewBillSource } from './source-bills.ts';
import type { BillMailSource } from '../shared/source-bills.ts';
import type { InvoiceReview } from '../shared/accounts-review.ts';
import type { JobRun, Recipe } from '../shared/contracts.ts';

const resources: { dir: string; db: WorkflowDatabase }[] = [];
afterEach(() => { for (const { dir, db } of resources.splice(0)) { db.close(); rmSync(dir, { recursive: true, force: true }); } });
const itemId = 'a'.repeat(64), messageId = 'ab12';
function jobRun(recipe: Recipe, key: string, id: string, status: JobRun['status'] = 'running'): JobRun {
  return { id, jobId: recipe.id, jobTitle: 'Fictional invoice review', jobRevision: recipe.revision, idempotencyKey: key, status,
    mode: 'prepare', trigger: 'manual', scheduledFor: 1, createdAt: 1, attempt: 1, detail: '', approvalRequests: [], evidence: [],
    spec: { title: 'Fictional invoice review', description: 'Prepare one saved message.', steps: [], allowedOrigins: [], evidence: 'Typed source-bound proposal', capabilities: ['analyse'], limits: { maxRuntimeMinutes: 5, maxTurns: 10 } } };
}
function fixture() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'rb-bill-proposal-')), db = new WorkflowDatabase({ dir, key: Buffer.alloc(32, 3) }); resources.push({ dir, db });
  const workroom = join(dir, 'workroom'), path = join(workroom, 'workflow-inputs/accounts-invoices.json');
  const source: BillMailSource = { accountId: 'private-mail', receiptId: 'saved-scan-a', threadId: 'abc123', message: { id: messageId, at: Date.now() - 10_000, from: 'fictional@example.invalid', subject: 'Fictional invoice', body: 'Fictional utility invoice for review.', bodyTruncated: false, attachments: [] } };
  const authority = { settings: { ...defaultAgencySettings(), agencyName: 'Fictional agency', workflowPackId: 'office-core' as const, gmailAccountId: 'private-mail', timeZone: 'Australia/Brisbane', propertyReferences: [{ propertyId: 'property-1', reference: 'REF1', aliases: ['Fictional payer'] }] }, evidenceDigest: 'b'.repeat(64), packBinding: 'c'.repeat(64), recipe: { id: 'wf-office-core-invoice-review', revision: 2, approvedRevision: 2, planApprovedAt: 1, status: 'active' } as Recipe };
  const runs: JobRun[] = [];
  let epoch = 0;
  const advanceEpoch = () => { epoch++; };
  const dispatch = vi.fn();
  const authorize = vi.fn(async () => structuredClone(authority)), readSource = vi.fn(async () => structuredClone(source));
  const execute = vi.fn(async (recipe: Recipe, key: string, prepareInput: () => Promise<void>) => {
    if (runs.some(run => run.jobId === recipe.id && ['running', 'queued'].includes(run.status))) throw Object.assign(new Error('Invoice plan is already claimed.'), { status: 409 });
    const run = jobRun(recipe, key, `run-${runs.length + 1}`);
    runs.push(run);
    await prepareInput();
    dispatch();
    const input = JSON.parse(readFileSync(path, 'utf8'));
    const output: InvoiceReview = { version: 1, kind: 'accounts-invoice-entry-review', sourceReference: input.sourceReference, status: 'partial', coverageComplete: false, holds: [{ itemId: input.documents[0].documentId, reason: 'Review incomplete source facts.' }], actionsPerformed: [], documents: [{ documentId: input.documents[0].documentId, decision: 'hold', duplicateOf: null, conflictGroup: null, proposedEntry: { supplierId: null, invoiceId: null, propertyId: null, amount: null, currency: null, dueDate: null, costType: null }, sourceIds: [messageId], reason: 'Review incomplete source facts.' }] };
    run.status = 'awaiting-approval'; run.evidence = [{ kind: 'output', note: JSON.stringify(output), at: Date.now() }]; return { run };
  });
  const options = { database: () => db, workroom, authorize, source: readSource, runs: () => runs, execute, epoch: () => String(epoch) };
  const request = () => ({ requestId: randomUUID(), itemId, messageId, expectedSourceDigest: previewBillSource(source).digest });
  return { dir, db, path, workroom, source, authority, runs, authorize, readSource, execute, dispatch, advanceEpoch, options, request, prepare: createBillProposals(options) };
}

describe('source-bound invoice preparation requests', () => {
  it('persists source intent, prepares bounded metadata-only input and never accepts a bill', async () => {
    const f = fixture(); f.source.message.attachments = [{ id: 'attachment-a', name: 'invoice.pdf', mimeType: 'application/pdf', size: 100 }];
    const request = f.request(), result = await f.prepare(request), input = JSON.parse(readFileSync(f.path, 'utf8'));
    expect(f.readSource).toHaveBeenCalledWith(itemId, messageId);
    expect(input).toMatchObject({ sourceReference: `realbud-bill:${request.expectedSourceDigest}`, coverage: { complete: false, missingAttachments: ['attachment-a'] }, allowedAttachmentPaths: [], agency: { name: 'Fictional agency' } });
    expect(input.documents).toHaveLength(1); expect(input.attachments).toEqual([{ attachmentId: 'attachment-a', fileName: 'invoice.pdf', status: 'not-read' }]);
    expect(result.proposal?.decision).toBe('hold'); expect(result.sourceDigest).toBe(request.expectedSourceDigest);
    expect(f.db.list('bill-proposal')).toHaveLength(1); expect(f.db.list('bill-register')).toHaveLength(0);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it('reconciles a restarted same request without repeating a worker call and rejects a changed payload', async () => {
    const f = fixture(), request = f.request(), result = await f.prepare(request), restarted = createBillProposals(f.options);
    expect(await restarted(request)).toEqual(result); expect(f.execute).toHaveBeenCalledTimes(1);
    await expect(restarted({ ...request, messageId: 'ab13' })).rejects.toMatchObject({ status: 409 });
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('resolves an evicted result through permanent history without repeating a worker call', async () => {
    const f = fixture(), request = f.request(), original = await f.prepare(request);
    const historical = structuredClone(original.run); f.runs.length = 0;
    const findRunByKey = vi.fn((key: string) => key === historical.idempotencyKey ? historical : undefined);
    const restarted = createBillProposals({ ...f.options, findRunByKey });
    expect(await restarted(request)).toEqual(original);
    expect(findRunByKey).toHaveBeenCalledWith(`bill-proposal:${request.requestId}`);
    expect(f.execute).toHaveBeenCalledOnce();
    f.authority.packBinding = 'e'.repeat(64);
    await expect(restarted(request)).rejects.toMatchObject({ status: 409 });
    expect(f.execute).toHaveBeenCalledOnce();
  });

  it('prepares the 101st request instead of inheriting the generic 100-record database limit', async () => {
    const f = fixture(), first = f.request(); await f.prepare(first);
    const receipt = f.db.get('bill-proposal', `bill-proposal:${first.requestId}`)!;
    for (let i = 1; i < 100; i++) f.db.create('bill-proposal', `bill-proposal:${randomUUID()}`, receipt.value, 1_000);
    const next = f.request(), result = await createBillProposals(f.options)(next);
    expect(result.proposal?.decision).toBe('hold'); expect(f.dispatch).toHaveBeenCalledTimes(2);
    expect(f.db.get('bill-proposal', `bill-proposal:${next.requestId}`)).toBeDefined();
    expect(f.db.list('bill-proposal')).toHaveLength(101);
    expect(f.db.get('bill-proposal', `bill-proposal:${first.requestId}`)).toEqual(receipt);
  });

  it('admits beyond 1000 requests and preserves retained retries without dispatching an intent that lost its run', async () => {
    const f = fixture(), first = f.request(), firstResult = await f.prepare(first);
    const receipt = f.db.get('bill-proposal', `bill-proposal:${first.requestId}`)!;
    const retainedIds = [first.requestId];
    for (let i = 1; i < 999; i++) {
      const id = randomUUID(); retainedIds.push(id);
      f.db.create('bill-proposal', `bill-proposal:${id}`, receipt.value, 1_000);
    }
    const last = f.request(), lastResult = await f.prepare(last); retainedIds.push(last.requestId);
    expect(lastResult.proposal?.decision).toBe('hold'); expect(f.dispatch).toHaveBeenCalledTimes(2);
    const next = f.request(); await f.prepare(next); retainedIds.push(next.requestId);
    const input = readFileSync(f.path);
    expect(f.db.count('bill-proposal')).toBe(1001); expect(f.execute).toHaveBeenCalledTimes(3);
    const restarted = createBillProposals(f.options);
    expect(await restarted(first)).toEqual(firstResult); expect(await restarted(last)).toEqual(lastResult);
    expect(f.execute).toHaveBeenCalledTimes(3); expect(readFileSync(f.path)).toEqual(input);
    // Do not use list() to establish capacity: its public projection is capped
    // at 500. Check every known durable identity rather than a truncated list.
    for (const id of retainedIds) expect(f.db.get('bill-proposal', `bill-proposal:${id}`)).toBeDefined();
    expect(f.db.get('bill-proposal', `bill-proposal:${first.requestId}`)).toEqual(receipt);
    f.runs.splice(0, 1);
    await expect(restarted(first)).rejects.toMatchObject({ status: 409 });
    expect(f.execute).toHaveBeenCalledTimes(3); expect(readFileSync(f.path)).toEqual(input);
  });
  it.each([{ source: {} }, { recipeId: 'wf-unreviewed' }, { accountId: 'other-account' }, { allowedAttachmentPaths: ['/private/customer.pdf'] }])('rejects caller-supplied authority or file scope before any read', async extra => {
    const f = fixture(); await expect(f.prepare({ ...f.request(), ...extra })).rejects.toMatchObject({ status: 400 });
    expect(f.authorize).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
  });
  it('holds wrong-account or changed source before creating an intent or input', async () => {
    const f = fixture(), request = f.request(); f.source.message.body = 'Changed source content';
    await expect(f.prepare(request)).rejects.toMatchObject({ status: 409 });
    f.authority.settings.gmailAccountId = 'another-account';
    await expect(f.prepare(f.request())).rejects.toMatchObject({ status: 409 });
    expect(f.db.list('bill-proposal')).toEqual([]); expect(f.execute).not.toHaveBeenCalled();
  });
  it('blocks a competing request while authorization is unresolved and releases the guard after failure', async () => {
    const f = fixture(); let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    f.authorize.mockImplementationOnce(async () => { entered(); await gate; throw Object.assign(new Error('Source unavailable'), { status: 409 }); });
    const first = f.prepare(f.request()); await started;
    await expect(f.prepare(f.request())).rejects.toThrow(/already running/); release(); await expect(first).rejects.toThrow(/Source unavailable/);
    await f.prepare(f.request()); expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it('preserves an interrupted intent and refuses to replay it into a second worker', async () => {
    const f = fixture(), request = f.request(); f.execute.mockRejectedValueOnce(new Error('Stopped before a job receipt'));
    await expect(f.prepare(request)).rejects.toThrow(/Stopped/);
    await expect(createBillProposals(f.options)(request)).rejects.toThrow(/earlier preparation stopped/);
    expect(f.execute).toHaveBeenCalledTimes(1); expect(f.db.list('bill-proposal')).toHaveLength(1);
  });
  it('does not re-expose a completed proposal after authority or the approved plan changes', async () => {
    const f = fixture(), request = f.request(); await f.prepare(request);
    f.authority.packBinding = 'd'.repeat(64);
    await expect(f.prepare(request)).rejects.toMatchObject({ status: 409 });
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it('cannot bypass a post-execution authority failure by replaying the durable request', async () => {
    const f = fixture(), request = f.request();
    f.execute.mockImplementationOnce(async (recipe, key) => {
      const run = jobRun(recipe, key, 'finished-before-revocation', 'awaiting-approval');
      f.runs.push(run); f.authority.evidenceDigest = 'd'.repeat(64); return { run };
    });
    await expect(f.prepare(request)).rejects.toMatchObject({ status: 409 });
    await expect(f.prepare(request)).rejects.toMatchObject({ status: 409 });
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it('checks the latest source after the final asynchronous authority refresh', async () => {
    const f = fixture(), request = f.request(), execute = f.execute.getMockImplementation()!;
    let completed = false;
    f.execute.mockImplementationOnce(async (...args) => { const result = await execute(...args); completed = true; return result; });
    f.authorize.mockImplementation(async () => { if (completed) f.source.message.body = 'Changed during the final authority refresh'; return structuredClone(f.authority); });
    await expect(f.prepare(request)).rejects.toMatchObject({ status: 409 });
    expect(f.runs).toHaveLength(1); expect(f.execute).toHaveBeenCalledTimes(1); expect(f.db.list('bill-register')).toEqual([]);
  });
  it.each([1, 2, 3, 4])('holds authority revoked during source read %s before dispatching a worker', async readToChange => {
    const f = fixture(), request = f.request(); let reads = 0;
    f.readSource.mockImplementation(async () => {
      const snapshot = structuredClone(f.source);
      await Promise.resolve();
      if (++reads === readToChange) { f.authority.evidenceDigest = 'd'.repeat(64); f.advanceEpoch(); }
      return snapshot;
    });
    await expect(f.prepare(request)).rejects.toMatchObject({ status: 409 });
    expect(f.dispatch).not.toHaveBeenCalled(); expect(f.db.list('bill-register')).toEqual([]);
  });
  it('holds an old source snapshot changed during the last input check before worker dispatch', async () => {
    const f = fixture(), request = f.request(); let reads = 0;
    f.readSource.mockImplementation(async () => {
      const snapshot = structuredClone(f.source);
      await Promise.resolve();
      if (++reads === 4) { f.source.message.body = 'Replaced while the last read was pending'; f.advanceEpoch(); }
      return snapshot;
    });
    await expect(f.prepare(request)).rejects.toMatchObject({ status: 409 });
    expect(f.dispatch).not.toHaveBeenCalled(); expect(f.db.list('bill-register')).toEqual([]);
  });
  it('holds a completed replay when authority changes while its source read is pending', async () => {
    const f = fixture(), request = f.request(); await f.prepare(request);
    f.readSource.mockImplementationOnce(async () => { const snapshot = structuredClone(f.source); await Promise.resolve(); f.advanceEpoch(); return snapshot; });
    await expect(f.prepare(request)).rejects.toMatchObject({ status: 409 });
    expect(f.dispatch).toHaveBeenCalledTimes(1); expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it('holds malformed or differently sourced saved output rather than exposing a proposal', async () => {
    const f = fixture(), request = f.request(); await f.prepare(request);
    const output = JSON.parse(f.runs[0].evidence[0].note); output.documents[0].documentId = 'foreign-document';
    f.runs[0].evidence[0].note = JSON.stringify(output);
    await expect(f.prepare(request)).rejects.toMatchObject({ status: 503 });
    f.runs[0].evidence[0].note = JSON.stringify({ kind: 'accounts-invoice-entry-review' });
    await expect(f.prepare(request)).rejects.toMatchObject({ status: 503 });
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it('rechecks the source after asynchronous authority admission before writing worker input', async () => {
    const f = fixture(), request = f.request(); let reads = 0;
    f.authorize.mockImplementation(async () => { if (++reads === 2) f.source.message.body = 'Source replaced during admission'; return structuredClone(f.authority); });
    await expect(f.prepare(request)).rejects.toMatchObject({ status: 409 });
    expect(f.execute).not.toHaveBeenCalled(); expect(f.db.list('bill-proposal')).toEqual([]);
  });
  it('preserves the active invoice input when another job starts during authority admission', async () => {
    const f = fixture(), request = f.request(); mkdirSync(join(f.workroom, 'workflow-inputs'), { recursive: true, mode: 0o700 }); writeFileSync(f.path, 'Existing active invoice input', { mode: 0o600 }); let reads = 0;
    f.authorize.mockImplementation(async () => { if (++reads === 2) f.runs.push(jobRun(f.authority.recipe, 'other-job', 'other-job')); return structuredClone(f.authority); });
    await expect(f.prepare(request)).rejects.toMatchObject({ status: 409 });
    expect(readFileSync(f.path, 'utf8')).toBe('Existing active invoice input'); expect(f.execute).not.toHaveBeenCalled();
  });
  it('normalizes UUID case and rejects malformed identifiers before dispatch', async () => {
    const f = fixture(), request = { ...f.request(), requestId: 'ABCDEFAB-1234-4567-ABCD-0123456789AB' };
    await f.prepare(request); await f.prepare({ ...request, requestId: request.requestId.toLowerCase() }); expect(f.execute).toHaveBeenCalledTimes(1);
    await expect(f.prepare({ ...f.request(), requestId: '-'.repeat(36) })).rejects.toMatchObject({ status: 400 });
  });
  it('does not expose a proposal from a receipt attached to another plan revision', async () => {
    const f = fixture(), request = f.request(); await f.prepare(request); f.runs[0].jobRevision++;
    await expect(f.prepare(request)).rejects.toMatchObject({ status: 503 });
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
});
