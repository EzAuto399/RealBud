import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { JobRun, JobRunStatus, Recipe } from '../shared/contracts.ts';
import type { InvoiceReview } from '../shared/accounts-review.ts';
import type { BillMailSource } from '../shared/source-bills.ts';
import { createBillProposals, readBillProposal } from './bill-proposals.ts';
import { defaultAgencySettings } from './agency-setup.ts';
import { JobRunStore } from './job-runs.ts';
import { previewBillSource } from './source-bills.ts';
import { WorkflowDatabase } from './workflow-database.ts';

const resources: { directory: string; database: WorkflowDatabase; stores: JobRunStore[] }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const { directory, database, stores } of resources.splice(0)) {
    for (const store of stores) store.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function fileDigests(directory: string, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true })) {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, fileDigests(directory, relative));
    else result[relative] = createHash('sha256').update(readFileSync(join(directory, relative))).digest('hex');
  }
  return result;
}

function fixture(status: JobRunStatus = 'awaiting-approval') {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'rb-proposal-history-'));
  const database = new WorkflowDatabase({ dir: directory, key: Buffer.alloc(32, 29) });
  const historyFile = join(directory, 'job-runs.json');
  const store = new JobRunStore({ file: historyFile, database });
  const resource = { directory, database, stores: [store] };
  resources.push(resource);
  const source: BillMailSource = {
    accountId: 'fictional-mail', receiptId: 'fictional-mail-receipt', threadId: 'abc1',
    message: { id: 'abc2', at: 1_750_000_000_000, from: 'sender@example.test', subject: 'Fictional utility invoice',
      body: 'Please review the fictional invoice.', bodyTruncated: false, attachments: [] },
  };
  const recipe: Recipe = {
    id: 'wf-office-core-invoice-review', title: 'Invoice source review', description: 'Review one saved message.',
    steps: ['Read the saved source', 'Prepare an invoice review'], allowedOrigins: [], evidence: 'Source-bound review',
    capabilities: ['analyse'], limits: { maxRuntimeMinutes: 2, maxTurns: 6 }, siteNotes: null, status: 'active',
    createdAt: 1, schedule: null, revision: 2, updatedAt: 2, approvedRevision: 2, planApprovedAt: 2,
    attachment: null, submitAcknowledgedAt: null,
  };
  const authority = {
    recipe, evidenceDigest: 'b'.repeat(64), packBinding: 'c'.repeat(64),
    settings: { ...defaultAgencySettings(), agencyName: 'Fictional agency', workflowPackId: 'office-core' as const,
      gmailAccountId: source.accountId, timeZone: 'Australia/Brisbane' },
  };
  const workroom = join(directory, 'workroom');
  const inputPath = join(workroom, 'workflow-inputs', 'accounts-invoices.json');
  const authorize = vi.fn(async () => structuredClone(authority));
  const readSource = vi.fn(async () => structuredClone(source));
  const provider = vi.fn((input: { sourceReference: string; documents: { documentId: string; sourceId: string }[] }): InvoiceReview => ({
    version: 1, kind: 'accounts-invoice-entry-review', sourceReference: input.sourceReference,
    status: 'partial', coverageComplete: false, actionsPerformed: [],
    holds: [{ itemId: input.documents[0].documentId, reason: 'Human review required.' }],
    documents: [{ documentId: input.documents[0].documentId, decision: 'hold', duplicateOf: null, conflictGroup: null,
      proposedEntry: { supplierId: null, invoiceId: null, propertyId: null, amount: null, currency: null, dueDate: null, costType: null },
      sourceIds: [input.documents[0].sourceId], reason: 'Human review required.' }],
  }));
  const execute = vi.fn(async (selectedRecipe: Recipe, key: string, prepareInput: () => Promise<void>) => {
    const { run } = store.enqueue(selectedRecipe, { idempotencyKey: key, mode: 'prepare', trigger: 'manual' });
    if (status === 'queued') return { run };
    const running = store.start(run.id);
    if (status === 'running') return { run: running };
    await prepareInput();
    const output = provider(JSON.parse(readFileSync(inputPath, 'utf8')));
    return { run: store.settle(run.id, { status, detail: 'Fictional preparation finished.',
      evidence: [{ kind: 'output', at: Date.now(), note: JSON.stringify(output) }] }) };
  });
  const runs = vi.fn(() => store.list());
  const findRunByKey = vi.fn((key: string) => store.getByIdempotencyKey(key));
  const options = { database: () => database, workroom, authorize, source: readSource, epoch: () => 'fixture-authority', runs, findRunByKey, execute };
  const request = { requestId: randomUUID(), itemId: 'a'.repeat(64), messageId: source.message.id, expectedSourceDigest: previewBillSource(source).digest };
  return { directory, database, store, resource, historyFile, source, authority, inputPath, authorize, readSource, provider, execute,
    options, request, prepare: createBillProposals(options) };
}

function assertNoWork(f: ReturnType<typeof fixture>, before: Record<string, string>) {
  expect(f.authorize).not.toHaveBeenCalled();
  expect(f.readSource).not.toHaveBeenCalled();
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.provider).not.toHaveBeenCalled();
  expect(fileDigests(f.directory)).toEqual(before);
}
function clearWorkSpies(f: ReturnType<typeof fixture>) {
  f.authorize.mockClear(); f.readSource.mockClear(); f.execute.mockClear(); f.provider.mockClear();
  f.options.runs.mockClear(); f.options.findRunByKey.mockClear();
}

describe('read-only historical invoice proposal resolution', () => {
  it('keeps an absent intent explicitly unresolved without creating data or looking up current source access', () => {
    const f = fixture(), before = fileDigests(f.directory);
    expect(readBillProposal(f.options, f.request.requestId)).toEqual({
      version: 1, requestId: f.request.requestId, state: 'not-recorded', sourceDigest: null,
      payloadDigest: null, run: null, proposal: null, historical: true,
    });
    expect(f.options.findRunByKey).not.toHaveBeenCalled();
    expect(f.options.runs).not.toHaveBeenCalled();
    assertNoWork(f, before);
  });

  it.each(['', '-'.repeat(36), '../private', ' bill-proposal:123', null, 123])('rejects invalid request ID %s before touching storage', requestId => {
    const database = vi.fn(() => { throw new Error('Storage must not be opened'); });
    const runs = vi.fn(() => []);
    expect(() => readBillProposal({ database, runs }, requestId)).toThrow(expect.objectContaining({ status: 400 }));
    expect(database).not.toHaveBeenCalled(); expect(runs).not.toHaveBeenCalled();
  });

  it('retains an intent with no worker receipt without executing or recreating worker input', async () => {
    const f = fixture();
    f.execute.mockRejectedValueOnce(new Error('Synthetic interruption before run reservation'));
    await expect(f.prepare(f.request)).rejects.toThrow('Synthetic interruption before run reservation');
    clearWorkSpies(f);
    const before = fileDigests(f.directory);
    const result = readBillProposal(f.options, f.request.requestId);
    expect(result).toMatchObject({ state: 'intent-recorded', historical: true, sourceDigest: f.request.expectedSourceDigest, run: null, proposal: null });
    expect(result.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
    assertNoWork(f, before);
  });

  it.each(['queued', 'running', 'awaiting-approval', 'completed', 'partial', 'failed', 'interrupted', 'cancelled', 'missed'] as const)(
    'reads the actual durable %s receipt without rerunning any work', async status => {
      const f = fixture(status), prepared = await f.prepare(f.request);
      clearWorkSpies(f);
      const before = fileDigests(f.directory);
      const result = readBillProposal(f.options, f.request.requestId.toUpperCase());
      expect(result).toMatchObject({ version: 1, state: 'run-recorded', historical: true, requestId: f.request.requestId,
        sourceDigest: prepared.sourceDigest, run: { id: prepared.run.id, status } });
      expect(result.proposal).toEqual(['completed', 'awaiting-approval'].includes(status) ? prepared.proposal : null);
      expect(f.options.findRunByKey).toHaveBeenCalledWith(`bill-proposal:${f.request.requestId}`);
      expect(f.options.runs).not.toHaveBeenCalled();
      assertNoWork(f, before);
    });

  it('reopens permanent run history after source, plan and authority changes without exposing a new preparation door', async () => {
    const f = fixture(), prepared = await f.prepare(f.request);
    const reopened = new JobRunStore({ file: f.historyFile, database: f.database });
    f.resource.stores.push(reopened);
    f.authority.packBinding = 'd'.repeat(64); f.authority.recipe.revision++;
    f.source.message.body = 'Changed current message content.';
    f.authorize.mockRejectedValue(new Error('Source access was revoked'));
    f.readSource.mockRejectedValue(new Error('Provider access must not be checked'));
    clearWorkSpies(f);
    const before = fileDigests(f.directory);
    const result = readBillProposal({ ...f.options, runs: () => [], findRunByKey: key => reopened.getByIdempotencyKey(key) }, f.request.requestId);
    expect(result.run).toEqual(prepared.run); expect(result.proposal).toEqual(prepared.proposal);
    assertNoWork(f, before);
    // POST still checks current authority and cannot use historical evidence to dispatch.
    await expect(f.prepare(f.request)).rejects.toThrow('Source access was revoked');
    expect(f.execute).not.toHaveBeenCalled(); expect(f.provider).not.toHaveBeenCalled();
  });

  it('supports the existing in-memory run projection when no permanent lookup is supplied', async () => {
    const f = fixture(), prepared = await f.prepare(f.request);
    clearWorkSpies(f); const before = fileDigests(f.directory);
    const result = readBillProposal({ database: () => f.database, runs: () => [prepared.run] }, f.request.requestId);
    expect(result.proposal).toEqual(prepared.proposal); assertNoWork(f, before);
  });

  it('rejects multiple compatibility receipts claiming one request instead of choosing an arbitrary result', async () => {
    const f = fixture(), prepared = await f.prepare(f.request);
    clearWorkSpies(f); const before = fileDigests(f.directory);
    expect(() => readBillProposal({ database: () => f.database,
      runs: () => [prepared.run, { ...prepared.run, id: randomUUID() }] }, f.request.requestId))
      .toThrow(expect.objectContaining({ status: 503 }));
    assertNoWork(f, before);
  });

  it('returns detached historical evidence that cannot mutate the authoritative receipt', async () => {
    const f = fixture(), prepared = await f.prepare(f.request);
    clearWorkSpies(f); const before = fileDigests(f.directory);
    const result = readBillProposal(f.options, f.request.requestId);
    result.run!.detail = 'Caller mutation'; result.proposal!.reason = 'Caller mutation';
    const repeated = readBillProposal(f.options, f.request.requestId);
    expect(repeated.run).toEqual(prepared.run); expect(repeated.proposal).toEqual(prepared.proposal);
    assertNoWork(f, before);
  });

  it.each(['request-key', 'plan-id', 'plan-revision', 'unknown-status', 'broken-evidence', 'empty-id', 'zero-attempt'] as const)(
    'rejects a malformed or mismatched historical run: %s', async defect => {
      const f = fixture(), prepared = await f.prepare(f.request), run = structuredClone(prepared.run);
      if (defect === 'request-key') run.idempotencyKey = `bill-proposal:${randomUUID()}`;
      else if (defect === 'plan-id') run.jobId = 'foreign-plan';
      else if (defect === 'plan-revision') run.jobRevision++;
      else if (defect === 'unknown-status') run.status = 'unrecognized' as JobRunStatus;
      else if (defect === 'empty-id') run.id = '';
      else if (defect === 'zero-attempt') run.attempt = 0;
      else run.evidence = [{ kind: 'unknown', note: 'Invalid evidence', at: 1 }] as unknown as JobRun['evidence'];
      clearWorkSpies(f); const before = fileDigests(f.directory);
      expect(() => readBillProposal({ ...f.options, findRunByKey: () => run }, f.request.requestId)).toThrow(expect.objectContaining({ status: 503 }));
      assertNoWork(f, before);
    });

  it.each(['malformed-json', 'foreign-document', 'foreign-source', 'extra-output', 'missing-output'] as const)(
    'rejects corrupt prepared output: %s', async defect => {
      const f = fixture(), prepared = await f.prepare(f.request), run = structuredClone(prepared.run);
      const output = JSON.parse(run.evidence[0].note) as InvoiceReview;
      if (defect === 'malformed-json') run.evidence[0].note = '{broken';
      else if (defect === 'missing-output') run.evidence = [];
      else if (defect === 'extra-output') run.evidence.push(structuredClone(run.evidence[0]));
      else {
        if (defect === 'foreign-document') output.documents[0].documentId = 'foreign-document';
        else output.sourceReference = 'realbud-bill:foreign-source';
        run.evidence[0].note = JSON.stringify(output);
      }
      clearWorkSpies(f); const before = fileDigests(f.directory);
      expect(() => readBillProposal({ ...f.options, findRunByKey: () => run }, f.request.requestId)).toThrow(expect.objectContaining({ status: 503 }));
      assertNoWork(f, before);
    });

  it('rejects a malformed saved intent before reading run history and preserves every saved byte', async () => {
    const f = fixture(); await f.prepare(f.request);
    const id = `bill-proposal:${f.request.requestId}`, row = f.database.get<Record<string, unknown>>('bill-proposal', id)!;
    f.database.update<Record<string, unknown>>('bill-proposal', id, row.revision, value => ({ ...value, input: { damaged: true } }));
    clearWorkSpies(f); f.options.findRunByKey.mockClear(); f.options.runs.mockClear();
    const before = fileDigests(f.directory);
    expect(() => readBillProposal(f.options, f.request.requestId)).toThrow(expect.objectContaining({ status: 503 }));
    expect(f.options.findRunByKey).not.toHaveBeenCalled(); expect(f.options.runs).not.toHaveBeenCalled();
    assertNoWork(f, before);
  });

  it('does not leak arbitrary history-reader diagnostics or mutate the prior record', async () => {
    const f = fixture(); await f.prepare(f.request); clearWorkSpies(f);
    const before = fileDigests(f.directory);
    expect(() => readBillProposal({ ...f.options, findRunByKey: () => { throw new Error('private diagnostic must not escape'); } }, f.request.requestId))
      .toThrow('The saved invoice preparation needs recovery. Its evidence has been preserved.');
    assertNoWork(f, before);
  });
});
