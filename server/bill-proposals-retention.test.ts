import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InvoiceReview } from '../shared/accounts-review.ts';
import type { JobRun, Recipe } from '../shared/contracts.ts';
import type { BillMailSource } from '../shared/source-bills.ts';
import { defaultAgencySettings } from './agency-setup.ts';
import { createBillProposals } from './bill-proposals.ts';
import { previewBillSource } from './source-bills.ts';
import { WorkflowDatabase } from './workflow-database.ts';

type Receipt = { payloadDigest: string; sourceDigest: string; recipeId: string; recipeRevision: number; sourceReference: string; authorityDigest: string; input: Record<string, unknown> };
const resources: { dir: string; handles: WorkflowDatabase[] }[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const { dir, handles } of resources.splice(0)) { for (const db of handles) db.close(); rmSync(dir, { recursive: true, force: true }); }
});
const source: BillMailSource = { accountId: 'fictional-mail', receiptId: 'fictional-scan', threadId: 'ab001', message: { id: 'abc1', at: 1_750_000_000_000, from: 'fictional@example.invalid', subject: 'Fictional invoice', body: 'Saved fictional invoice.', bodyTruncated: false, attachments: [] } };
const authority = { settings: { ...defaultAgencySettings(), agencyName: 'Fictional agency', workflowPackId: 'office-core' as const, gmailAccountId: source.accountId, timeZone: 'Australia/Brisbane', propertyReferences: [{ propertyId: 'fictional-property', reference: '00013', aliases: ['Fictional payer'] }] }, evidenceDigest: 'b'.repeat(64), packBinding: 'c'.repeat(64), recipe: { id: 'wf-office-core-invoice-review', revision: 2, approvedRevision: 2, planApprovedAt: 1, status: 'active' } as Recipe };
function queuedRun(recipe: Recipe, key: string): JobRun {
  return { id: `run-${key}`, jobId: recipe.id, jobTitle: 'Fictional invoice review', jobRevision: recipe.revision, idempotencyKey: key, status: 'queued', mode: 'prepare', trigger: 'manual', scheduledFor: 1, createdAt: 1, attempt: 1, detail: '', approvalRequests: [], evidence: [], spec: { title: 'Fictional invoice review', description: 'Prepare one saved message.', steps: [], allowedOrigins: [], evidence: 'Source-bound proposal', capabilities: ['analyse'], limits: { maxRuntimeMinutes: 5, maxTurns: 10 } } };
}
function fixture() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'rb-proposal-retention-'));
  const handles = [new WorkflowDatabase({ dir, key: Buffer.alloc(32, 14) }), new WorkflowDatabase({ dir, key: Buffer.alloc(32, 14) })];
  resources.push({ dir, handles });
  const workroom = join(dir, 'workroom'), inputPath = join(workroom, 'workflow-inputs', 'accounts-invoices.json');
  const calls: number[] = [0, 0];
  const runId = (key: string) => `fixture-run:${key.slice('bill-proposal:'.length)}`;
  const options = handles.map((database, index) => ({
    database: () => database, workroom, epoch: () => 'unchanged',
    authorize: async () => structuredClone(authority), source: async () => structuredClone(source),
    runs: () => database.list<JobRun>('fixture-run').map(row => row.value),
    findRunByKey: (key: string) => database.get<JobRun>('fixture-run', runId(key))?.value,
    execute: async (recipe: Recipe, key: string, prepareInput: () => Promise<void>) => {
      calls[index]++;
      await prepareInput();
      const input = JSON.parse(readFileSync(inputPath, 'utf8'));
      const document = input.documents[0];
      const output: InvoiceReview = { version: 1, kind: 'accounts-invoice-entry-review', sourceReference: input.sourceReference, status: 'partial', coverageComplete: false, holds: [{ itemId: document.documentId, reason: 'Review the saved source.' }], actionsPerformed: [], documents: [{ documentId: document.documentId, decision: 'hold', duplicateOf: null, conflictGroup: null, proposedEntry: { supplierId: null, invoiceId: null, propertyId: null, amount: null, currency: null, dueDate: null, costType: null }, sourceIds: [document.sourceId], reason: 'Review the saved source.' }] };
      const run: JobRun = { ...queuedRun(recipe, key), status: 'awaiting-approval', evidence: [{ kind: 'output', note: JSON.stringify(output), at: 1 }] };
      return { run: database.create('fixture-run', runId(key), run, null).value };
    },
  }));
  const request = (mail = source) => ({ requestId: randomUUID(), itemId: 'a'.repeat(64), messageId: mail.message.id, expectedSourceDigest: previewBillSource(mail).digest });
  return { dir, handles, options, inputPath, calls, request, runId };
}
function admissionGate(options: ReturnType<typeof fixture>['options'][number]) {
  let entered!: () => void, release!: () => void, calls = 0;
  const ready = new Promise<void>(resolve => { entered = resolve; }), waiting = new Promise<void>(resolve => { release = resolve; });
  const authorize = options.authorize;
  return { options: { ...options, authorize: async () => { const value = await authorize(); if (++calls === 2) { entered(); await waiting; } return value; } }, ready, release };
}

describe('permanent invoice proposal requests across independent database handles', () => {
  it('admits request 1001 and retains every old identity and historical replay', async () => {
    const f = fixture(), oldest = f.request(), original = await createBillProposals(f.options[0])(oldest);
    const originalReceipt = f.handles[0].get<Receipt>('bill-proposal', `bill-proposal:${oldest.requestId}`)!;
    const ids = [oldest.requestId];
    f.handles[0].transaction(() => { for (let index = 1; index < 1000; index++) { const id = randomUUID(); ids.push(id); f.handles[0].create('bill-proposal', `bill-proposal:${id}`, originalReceipt.value, null); } });
    const latest = f.request(), result = await createBillProposals(f.options[1])(latest);
    expect(result.proposal?.decision).toBe('hold');
    expect(f.handles[1].count('bill-proposal')).toBe(1001);
    for (const id of ids) expect(f.handles[1].get('bill-proposal', `bill-proposal:${id}`)).toBeDefined();
    expect(f.handles[1].get('bill-proposal', `bill-proposal:${oldest.requestId}`)).toEqual(originalReceipt);
    const input = readFileSync(f.inputPath);
    const restarted = createBillProposals({ ...f.options[1], runs: () => [] });
    expect(await restarted(oldest)).toEqual(original);
    await expect(restarted({ ...oldest, messageId: 'abc2' })).rejects.toMatchObject({ status: 409 });
    expect(f.calls).toEqual([1, 1]); expect(readFileSync(f.inputPath)).toEqual(input);
  });

  it('reuses a competing identical winner with its own later asOf and never enters the losing executor', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-21T08:00:00.000Z'));
    const f = fixture(), request = f.request(), gate = admissionGate(f.options[0]);
    const pending = createBillProposals(gate.options)(request); await gate.ready;
    vi.setSystemTime(new Date('2026-09-21T08:00:01.000Z'));
    const winner = await createBillProposals(f.options[1])(request), input = readFileSync(f.inputPath);
    const receipt = f.handles[1].get<Receipt>('bill-proposal', `bill-proposal:${request.requestId}`)!;
    expect(receipt.value.input.asOf).toBe('2026-09-21T08:00:01.000Z');
    gate.release(); expect(await pending).toEqual(winner);
    expect(f.calls).toEqual([0, 1]); expect(readFileSync(f.inputPath)).toEqual(input);
    expect(f.handles[0].get('bill-proposal', `bill-proposal:${request.requestId}`)).toEqual(receipt);
  });

  it.each(['payload', 'source', 'authority'] as const)('rejects a competing different %s before any losing executor or input write', async difference => {
    const f = fixture(), request = f.request(), gate = admissionGate(f.options[0]);
    const pending = createBillProposals(gate.options)(request); await gate.ready;
    const changedSource = { ...structuredClone(source), message: { ...source.message, body: 'A different saved invoice.' } };
    const winnerRequest = difference === 'payload' ? { ...request, itemId: 'd'.repeat(64) } : difference === 'source' ? { ...request, expectedSourceDigest: previewBillSource(changedSource).digest } : request;
    const winnerOptions = { ...f.options[1], ...(difference === 'source' ? { source: async () => structuredClone(changedSource) } : {}), ...(difference === 'authority' ? { authorize: async () => ({ ...structuredClone(authority), evidenceDigest: 'f'.repeat(64) }) } : {}) };
    await createBillProposals(winnerOptions)(winnerRequest);
    const input = readFileSync(f.inputPath), receipt = f.handles[1].get('bill-proposal', `bill-proposal:${request.requestId}`);
    const rejected = expect(pending).rejects.toMatchObject({ status: 409 }); gate.release(); await rejected;
    expect(f.calls).toEqual([0, 1]); expect(readFileSync(f.inputPath)).toEqual(input);
    expect(f.handles[0].get('bill-proposal', `bill-proposal:${request.requestId}`)).toEqual(receipt);
  });

  it('reconciles the competing winner while its real saved run is still queued', async () => {
    const f = fixture(), request = f.request(), gate = admissionGate(f.options[0]);
    const pending = createBillProposals(gate.options)(request); await gate.ready;
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; }), waiting = new Promise<void>(resolve => { release = resolve; });
    const winning = createBillProposals({ ...f.options[1], execute: async (recipe, key, prepareInput) => {
      f.calls[1]++;
      const run = f.handles[1].create('fixture-run', f.runId(key), queuedRun(recipe, key), null).value;
      entered(); await waiting; await prepareInput(); return { run };
    } })(request);
    await ready;
    try {
      gate.release(); const result = await pending;
      expect(result.run.status).toBe('queued'); expect(result.proposal).toBeNull();
      expect(f.calls).toEqual([0, 1]); expect(() => readFileSync(f.inputPath)).toThrow();
    } finally { release(); await winning; }
  });

  it('preserves a competing identical intent without a run and requires explicit recovery', async () => {
    const f = fixture(), request = f.request(), gate = admissionGate(f.options[0]);
    const pending = createBillProposals(gate.options)(request); await gate.ready;
    await expect(createBillProposals({ ...f.options[1], execute: async () => { throw new Error('Stopped before durable run'); } })(request)).rejects.toThrow('Stopped before durable run');
    const receipt = f.handles[1].get('bill-proposal', `bill-proposal:${request.requestId}`);
    const rejected = expect(pending).rejects.toMatchObject({ status: 409, message: expect.stringContaining('earlier preparation stopped') }); gate.release(); await rejected;
    expect(f.calls).toEqual([0, 0]); expect(f.handles[0].get('bill-proposal', `bill-proposal:${request.requestId}`)).toEqual(receipt);
    expect(() => readFileSync(f.inputPath)).toThrow();
  });

  it.each([false, true])('rejects a changed saved input and preserves its bytes (attachment metadata: %s)', async attachments => {
    const f = fixture(), mail = structuredClone(source);
    if (attachments) mail.message.attachments.push({ id: 'fictional-attachment', name: 'invoice.pdf', mimeType: 'application/pdf', size: 42 });
    const options = { ...f.options[0], source: async () => structuredClone(mail) }, request = f.request(mail);
    await createBillProposals(options)(request);
    const id = `bill-proposal:${request.requestId}`, receipt = f.handles[1].get<Receipt>('bill-proposal', id)!;
    const forged = structuredClone(receipt.value); (forged.input.documents as Record<string, unknown>[])[0].body = 'A forged invoice body.';
    const changed = f.handles[1].update('bill-proposal', id, receipt.revision, () => forged), input = readFileSync(f.inputPath);
    await expect(createBillProposals(options)(request)).rejects.toMatchObject({ status: 503 });
    expect(f.calls).toEqual([1, 0]); expect(readFileSync(f.inputPath)).toEqual(input);
    expect(f.handles[0].get('bill-proposal', id)).toEqual(changed);
  });

  it('rejects a historical lookup for a different request even when its plan revision matches', async () => {
    const f = fixture(), request = f.request(), original = await createBillProposals(f.options[0])(request), input = readFileSync(f.inputPath);
    const foreignRun = { ...original.run, idempotencyKey: `bill-proposal:${randomUUID()}` };
    await expect(createBillProposals({ ...f.options[1], findRunByKey: () => foreignRun })(request)).rejects.toMatchObject({ status: 503 });
    expect(f.calls).toEqual([1, 0]); expect(readFileSync(f.inputPath)).toEqual(input);
  });
});
