import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PrivateBackupCatalog, type CatalogRecord, type CatalogFile } from './private-backup-catalog.ts';
import { measurePrivateBackupRestore, transformPrivateBackupCatalog } from './private-backup-restore-catalog.ts';
import { createPrivateWorkspaceBackup, applyStagedPrivateRestore } from './private-workspace-backup.ts';
import { encryptJson, decryptJson } from './desk-crypto.ts';
import { emptyV3 } from '../shared/desk-v3.ts';
import { decodeDeskPlain } from './desk-v3-decode.ts';
import { migrateV2ToV3 } from './desk-v3-migrate.ts';
import { fixtureBook } from './desk-evaluate.ts';
import { defaultAgencySettings } from './agency-setup.ts';
import { executionDigest, executionStream } from './execution-history.ts';
import { restoreExecutionRecords, jobHistoryBinding, loopHistoryBinding } from './execution-history-backup.ts';
import { interruptMailRecordsForRestore } from './mail-records.ts';
import { legacyMailBackupFixture } from './testing/mail-backup-fixture.ts';
import { mailEvidenceHash } from './mail-workspace-integrity.ts';
import type { JobRun, LoopRun } from '../shared/contracts.ts';
import { WorkflowDatabase } from './workflow-database.ts';
import { BillReviewDraftStore } from './bill-review-drafts.ts';
import { proposalBackupFixture } from './testing/proposal-backup-fixture.ts';
import { WORKFLOW_MAX_ENCRYPTED_RECORD_LENGTH } from './workflow-database.ts';
import { batchBackupFixture } from './testing/batch-backup-fixture.ts';

const AT = Date.parse('2026-09-21T03:00:00Z'), roots: string[] = [], catalogs: PrivateBackupCatalog[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const c of catalogs.splice(0)) c.close(); await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture(workspaceId = randomUUID(), base = true, maxEntries = 20_000) {
  const directory = await mkdtemp(join(realpathSync(tmpdir()), 'RealBud logical restore ')); roots.push(directory);
  const key = randomBytes(32), catalog = await PrivateBackupCatalog.create({ directory: join(directory, 'catalog'), key, workspaceId, maxEntries, maxBytes: 512 * 1024 * 1024 }); catalogs.push(catalog);
  if (base) {
    catalog.addFile({ path: 'company-installation/workspace.json', encoding: 'bytes', data: Buffer.from(JSON.stringify({ version: 1, id: workspaceId, workerMemberKey: null })) });
    catalog.addFile({ path: 'desk.json', encoding: 'json', data: Buffer.from(JSON.stringify(emptyV3({ name: 'Fictional restore', timezone: 'UTC', jurisdictions: [] }))) });
  }
  return { directory, key, catalog, workspaceId };
}
const file = (path: string, value: unknown, encoding: CatalogFile['encoding'] = 'bytes'): CatalogFile => ({ path, encoding, data: Buffer.from(JSON.stringify(value)) });
const handoff = (id = 'handoff:one', revision = 17): CatalogRecord => ({ id, kind: 'handoff', revision,
  value: { version: 1, runId: 'run', threadId: 'thread', botId: 'bot', detail: 'Retained fictional sign-in checkpoint', jobRevision: 1, reason: 'login', state: 'verified', binding: { accountMarker: 'Fictional account' } } });
const write = async (directory: string, path: string, data: Buffer) => { await mkdir(dirname(join(directory, path)), { recursive: true, mode: 0o700 }); await writeFile(join(directory, path), data, { mode: 0o600 }); };
async function compareV1(source: PrivateBackupCatalog, prepared: PrivateBackupCatalog) {
  const from = await fixture(), to = await fixture(), phrase = 'Fictional restore comparison phrase';
  for (const f of source.iterateFiles()) await write(from.directory, f.path, f.encoding === 'json' ? Buffer.from(JSON.stringify(encryptJson(from.key, JSON.parse(f.data.toString('utf8'))))) : f.data);
  const db = new DatabaseSync(join(from.directory, 'workflow-state.sqlite'));
  await chmod(join(from.directory, 'workflow-state.sqlite'), 0o600);
  try {
    db.exec('CREATE TABLE workflow_records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL); PRAGMA user_version=1;');
    const insert = db.prepare('INSERT INTO workflow_records VALUES(?,?,?,?)');
    for (const row of source.iterateRecords()) insert.run(row.id, row.kind, row.revision, JSON.stringify(encryptJson(from.key, row.value)));
  } finally { db.close(); }
  await write(to.directory, 'desk.json', Buffer.from(JSON.stringify(encryptJson(to.key, emptyV3({ name: 'Fictional target', timezone: 'UTC', jurisdictions: [] })))));
  await write(to.directory, 'company-installation/workspace.json', Buffer.from(JSON.stringify({ version: 1, id: to.workspaceId, workerMemberKey: null })));
  const service = (directory: string, key: Buffer, workspaceId: string) => createPrivateWorkspaceBackup({ directory, key: () => key, workspaceId, epoch: () => 'fixture', assertIdle: () => {}, assertFresh: () => {}, now: () => AT });
  const exported = await service(from.directory, from.key, source.workspaceId).exportBackup(phrase);
  await service(to.directory, to.key, to.workspaceId).stageRestore({ backup: exported.backup, passphrase: phrase, expectedDigest: exported.receipt.digest });
  await applyStagedPrivateRestore({ directory: to.directory, key: to.key });
  for (const f of prepared.iterateFiles()) {
    const bytes = await readFile(join(to.directory, f.path));
    expect(f.encoding === 'json' ? decryptJson(to.key, JSON.parse(bytes.toString())) : JSON.parse(bytes.toString())).toEqual(JSON.parse(f.data.toString()));
  }
  const restored = new DatabaseSync(join(to.directory, 'workflow-state.sqlite'), { readOnly: true });
  try {
    const actual = restored.prepare('SELECT id,kind,revision,payload FROM workflow_records ORDER BY rowid').iterate();
    for (const expected of prepared.iterateRecords()) {
      const row = actual.next().value!;
      expect({ id: row.id, kind: row.kind, revision: row.revision, value: decryptJson(to.key, JSON.parse(String(row.payload))) }).toEqual(expected);
    }
    expect(actual.next().done).toBe(true);
  } finally { restored.close(); }
}
function executionFixture() {
  const files: Record<string, string> = {}, rows: CatalogRecord[] = [];
  for (const type of ['job', 'loop'] as const) {
    const filename = type === 'job' ? 'job-runs.json' : 'loops.json', stream = executionStream(type, filename);
    const runs = ['completed', 'running', 'queued'].map((status, index) => type === 'job' ? {
      id: `job-${index}`, jobId: 'fictional-job', jobTitle: 'Fictional work', jobRevision: 2, mode: 'prepare', trigger: 'manual', status,
      scheduledFor: 1, createdAt: 1, attempt: 1, detail: 'Preserved evidence', evidence: [], approvalRequests: [], idempotencyKey: `request-${index}`,
      spec: { title: 'Fictional work', description: 'Review fictional evidence', steps: ['Review'], evidence: 'Receipt', allowedOrigins: [], capabilities: ['analyse'], limits: { maxRuntimeMinutes: 2, maxTurns: 6 } },
    } as JobRun : { id: `loop-${index}`, loopId: 'inbound-triage', loopName: 'Fictional morning', status, scheduledFor: 1, createdAt: 1, manual: true, requestId: randomUUID(), loopRevision: 2 } as LoopRun);
    const context = type === 'job' ? null : { timezone: 'Australia/Brisbane', state: { 'inbound-triage': { enabled: true, handledThrough: 1, revision: 2 } } };
    files[filename] = JSON.stringify(type === 'job' ? { version: 1, executionHistory: 1, runs: runs.slice(1) } : { version: 3, executionHistory: 1, ...context, runs: runs.slice(1) });
    // Checkpoints precede referenced receipts to catch accidental order-dependent transforms.
    rows.push({ id: `execution-state:${stream}`, kind: 'execution-state', revision: 11,
      value: { version: 1, stream, currentHash: executionDigest(files[filename]), previousHash: null, recentIds: runs.slice(1).map(run => run.id), context } });
    for (const run of runs) {
      const binding = type === 'job' ? jobHistoryBinding(run as JobRun) : loopHistoryBinding(run as LoopRun), key = type === 'job' ? (run as JobRun).idempotencyKey : (run as LoopRun).requestId!;
      rows.push({ id: `request:${stream}:${executionDigest(key)}`, kind: 'execution-request', revision: 7, value: { version: 1, stream, key, runId: run.id, binding } });
      rows.push({ id: `${stream}:${executionDigest(run.id)}`, kind: `execution-${type}`, revision: 4, value: { version: 1, stream, run, binding } });
    }
  }
  return { rows, files };
}
function normalizedMail(workspaceId: string, legacyFiles = false, gaps = 0) {
  const f = legacyMailBackupFixture(workspaceId, AT - 1000), pending = { ...f.receipt, id: randomUUID(), status: 'running', completedAt: null, inputDigest: null, threadCount: 0, messageCount: 0, pages: 0, gaps: Array.from({ length: gaps }, (_, i) => `Preserved gap ${i}`) };
  const files: CatalogFile[] = legacyFiles ? [file('company-installation/private/mail-workspace.json', { name: 'mail-workspace', value: f.state }, 'json'),
    file(`company-installation/private/mail-scan-${f.receipt.id}.json`, { name: `mail-scan-${f.receipt.id}`, value: f.source }, 'json'),
    file('company-installation/private/mail-prepared-input.json', { name: 'mail-prepared-input', value: f.prepared }, 'json'), file('vault/workflow-inputs/accounts-inbox.json', f.input)] : [];
  const origins = files.filter(f => f.encoding === 'json').map(f => { const v = JSON.parse(f.data.toString()); return { name: v.name as string, digest: mailEvidenceHash(v.value) }; }).sort((a, b) => a.name.localeCompare(b.name));
  const rows: CatalogRecord[] = [
    { id: 'mail-register:workspace', kind: 'mail-register', revision: 5, value: { version: 2, workspaceId, revision: 0, latestScanId: pending.id, latestReview: null, activeScan: { receiptId: pending.id, ownerPid: process.pid, ownerToken: randomUUID() } } },
    { id: 'mail-origin:workspace', kind: 'mail-origin', revision: 1, value: { version: 1, workspaceId, legacyDigest: origins.length ? mailEvidenceHash(origins) : null, legacyFiles: origins, ...(legacyFiles ? { legacyPreparedInput: f.input } : {}) } },
    { id: `mail-receipt:${f.receipt.id}`, kind: 'mail-receipt', revision: 3, value: f.receipt },
    { id: `mail-source:${f.receipt.id}`, kind: 'mail-source', revision: 2, value: f.source },
    { id: `mail-item:${f.item.id}`, kind: 'mail-item', revision: 6, value: f.item },
    { id: 'mail-prepared:workspace', kind: 'mail-prepared', revision: 2, value: { ...f.prepared, input: f.input } },
    { id: `mail-receipt:${pending.id}`, kind: 'mail-receipt', revision: 2, value: pending },
  ];
  return { rows, files, pending, f };
}

describe('bounded logical private restore', () => {
  it('measures the exact transformed output before allocating a destination', async () => {
    const from = await fixture(), batches = batchBackupFixture(); from.catalog.addFile(file('work-batches.json', batches)); from.catalog.addRecord(handoff()); const original = from.catalog.seal();
    const measured = measurePrivateBackupRestore({ source: from.catalog, at: AT });
    const destination = await PrivateBackupCatalog.create({ directory: join(from.directory, 'measured'), key: from.key, workspaceId: from.workspaceId, maxEntries: measured.entries, maxBytes: measured.plainBytes }); catalogs.push(destination);
    const final = transformPrivateBackupCatalog({ source: from.catalog, destination, at: AT });
    expect(final).toMatchObject({ entries: measured.entries, files: measured.files, records: measured.records, plainBytes: measured.plainBytes, sealed: true });
    expect(measured.fileBytes + measured.recordBytes).toBe(measured.plainBytes); expect(measured.files).toBe(original.files + 1);
    expect(from.catalog.summary()).toEqual(original);
  });

  it.each(['revision', 'timestamp', 'expanded-size'])('rejects unrestorable batch %s as a typed preparation failure without sealing output', async field => {
    const from = await fixture(), to = await fixture(from.workspaceId, false), batches = batchBackupFixture();
    if (field === 'revision') batches[0].revision = Number.MAX_SAFE_INTEGER;
    if (field === 'timestamp') batches[0].updatedAt = Number.MAX_VALUE;
    if (field === 'expanded-size') {
      Object.assign(batches[0], { legacyNote: '' });
      Object.assign(batches[0], { legacyNote: 'x'.repeat(8 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(batches))) });
    }
    const source = file('work-batches.json', batches); from.catalog.addFile(source); from.catalog.seal();
    expect(() => transformPrivateBackupCatalog({ source: from.catalog, destination: to.catalog, at: AT })).toThrow(expect.objectContaining({ status: field === 'expanded-size' ? 413 : 400 }));
    expect(to.catalog.summary().sealed).toBe(false); expect(from.catalog.getFile('work-batches.json')?.data).toEqual(source.data);
  });
  it.each([2, 3])('matches v1 authority resets for Desk v%s, agency, plans, schedules and handoffs', async version => {
    const from = await fixture(undefined, false), to = await fixture(from.workspaceId, false);
    const legacy = decodeDeskPlain({ version: 1, ...fixtureBook(), drafts: [{ id: 'draft-1', propertyId: 'prop-oak', kind: 'courtesy-rent', status: 'allowed', channel: 'sms', to: 'Sam', body: 'Fictional draft', periodDueAt: 1, createdAt: 2, decidedAt: 3 }], escalations: [], lastRunAt: 4, results: [], hands: 'fixture', handsDetail: 'old' }, fixtureBook(), 'UTC');
    if (legacy.version !== 2) throw new Error('Expected legacy fixture');
    const capability = { id: 'cap-unused', workItemId: legacy.data.workItems[0].id, revision: 1, proposalHash: 'h', propertyId: 'prop-oak', recipeId: 'fake-portal', recipeVersion: 1, operation: 'prefill-courtesy' as const, approver: 'pm', expiresAt: AT + 60_000 };
    legacy.data.capabilities.push(capability, { ...capability, id: 'cap-used', usedAt: 1000 });
    legacy.data.recipes.push({ id: 'fake-portal', version: 1, published: true, origin: 'https://fictional.example.invalid', steps: [], finalControlFingerprint: 'fixture' });
    const book = version === 2 ? legacy.data : migrateV2ToV3(legacy.data, 1);
    from.catalog.addFile(file('desk.json', book, 'json')); from.catalog.addFile(file('company-installation/workspace.json', { version: 1, id: from.workspaceId, workerMemberKey: null }));
    from.catalog.addFile(file('agency-setup.json', { version: 1, workspaceId: from.workspaceId, revision: 2, updatedAt: 1, settings: { ...defaultAgencySettings(), gmailAccountId: 'fictional-mail' }, reviews: {} }));
    from.catalog.addFile(file('recipes.json', { recipes: [{ id: 'wf-example', title: 'Fictional plan', description: 'Prepare evidence', steps: ['Review'], evidence: 'Receipt', allowedOrigins: [], capabilities: ['analyse'], limits: { maxRuntimeMinutes: 2, maxTurns: 6 }, revision: 3, createdAt: 1, updatedAt: 1, status: 'active', schedule: { time: '08:00', weekdays: [1] }, planApprovedAt: 1, approvedRevision: 3, attachment: { attachedAt: 1 }, submitAcknowledgedAt: 1 }] }));
    from.catalog.addFile(file('loops.json', { version: 3, timezone: 'UTC', state: { custom: { enabled: true, handledThrough: 1 } }, runs: [{ id: 'old-loop', loopId: 'custom', loopName: 'Fictional', status: 'running', createdAt: 1, scheduledFor: 1, manual: false }] }));
    from.catalog.addRecord(handoff()); from.catalog.seal();
    const before = from.catalog.summary();
    expect(transformPrivateBackupCatalog({ source: from.catalog, destination: to.catalog, at: AT })).toMatchObject({ sealed: true, records: 1 });
    expect(from.catalog.summary()).toEqual(before);
    await compareV1(from.catalog, to.catalog);
    const desk = JSON.parse(to.catalog.getFile('desk.json')!.data.toString());
    expect(desk.hands).toBe('held');
    expect((version === 3 ? desk.portalRecipes : desk.recipes).every((r: { published: boolean }) => !r.published)).toBe(true);
    expect((version === 3 ? desk.cases : desk.workItems)[0].state).toBe('held');
    const capabilities = version === 3 ? desk.handoffs : desk.capabilities;
    expect(capabilities.find((c: { id: string }) => c.id === 'cap-unused').invalidatedAt).toBe(AT);
    expect(capabilities.find((c: { id: string }) => c.id === 'cap-used').usedAt).toBe(1000);
  });
  it('retains exact ordinary bytes and 5,101 rows in original order without collecting their bodies', async () => {
    const from = await fixture(), to = await fixture(from.workspaceId, false);
    const exact = Buffer.from('\uFEFFDate,Reference\r\n2026-09-21,"0012, 保留"\r\n'), json = Buffer.from('{\n "keep": "spaces and order", "b":2, "a":1\n}\n');
    from.catalog.addFile({ path: 'vault/workflow-inputs/original.csv', encoding: 'bytes', data: exact });
    from.catalog.addFile({ path: 'vault/workflow-inputs/arbitrary.json', encoding: 'bytes', data: json });
    for (let i = 0; i < 5101; i++) from.catalog.addRecord(handoff(`handoff:${String(i).padStart(5, '0')}`, i + 2));
    from.catalog.seal();
    const sourceIterator = from.catalog.iterateRecords.bind(from.catalog);
    let delivered = 0, inserted = 0;
    vi.spyOn(from.catalog, 'iterateRecords').mockImplementation(function* (kind?: string) {
      for (const row of sourceIterator(kind)) {
        if (kind === undefined) { expect(delivered - inserted).toBeLessThanOrEqual(1); delivered++; }
        yield row;
      }
    });
    const add = to.catalog.addRecord.bind(to.catalog);
    vi.spyOn(to.catalog, 'addRecord').mockImplementation(row => { add(row); inserted++; });
    const summary = transformPrivateBackupCatalog({ source: from.catalog, destination: to.catalog, at: AT });
    expect(summary.records).toBe(5101); expect(delivered).toBe(5101);
    let n = 0;
    for (const row of to.catalog.iterateRecords()) { expect(row.id).toBe(`handoff:${String(n).padStart(5, '0')}`); expect(row.revision).toBe(n + 2); n++; }
    expect(to.catalog.getFile('vault/workflow-inputs/original.csv')!.data).toEqual(exact);
    expect(to.catalog.getFile('vault/workflow-inputs/arbitrary.json')!.data).toEqual(json);
    expect(JSON.parse(to.catalog.getFile('loops.json')!.data.toString()).state).toEqual(Object.fromEntries(['morning-arrears', 'owner-letter', 'inbound-triage'].map(id => [id, { enabled: false, handledThrough: AT }])));
  }, 30_000);
  it('matches v1 execution rows, exact projection bytes and checkpoint hashes while retaining old request identities', async () => {
    const from = await fixture(), to = await fixture(from.workspaceId, false), history = executionFixture();
    for (const [path, data] of Object.entries(history.files)) from.catalog.addFile({ path, encoding: 'bytes', data: Buffer.from(data) });
    for (const row of history.rows) from.catalog.addRecord(row);
    from.catalog.seal(); transformPrivateBackupCatalog({ source: from.catalog, destination: to.catalog, at: AT });
    const sanitized = Object.fromEntries(['job-runs.json', 'loops.json'].map(path => [path, to.catalog.getFile(path)!.data.toString()]));
    const expected = restoreExecutionRecords(history.rows, history.files, sanitized, AT);
    expect([...to.catalog.iterateRecords()]).toEqual(expected.records); expect(sanitized).toEqual(expected.files);
    expect([...to.catalog.iterateRecords('execution-request')]).toEqual(history.rows.filter(row => row.kind === 'execution-request'));
    for (const type of ['job', 'loop']) {
      const run = to.catalog.getRecord(`execution-${type}`, `${executionStream(type as 'job' | 'loop', type === 'job' ? 'job-runs.json' : 'loops.json')}:${executionDigest(`${type}-1`)}`)!;
      expect(run).toMatchObject({ revision: 5, value: { run: { status: 'interrupted', finishedAt: AT } } });
    }
    await compareV1(from.catalog, to.catalog);
  });
  it('normalizes legacy run arrays and timezone-less schedules using the same v1 reset semantics', async () => {
    const from = await fixture(), to = await fixture(from.workspaceId, false), history = executionFixture();
    const jobs = history.rows.filter(row => row.kind === 'execution-job').map(row => (row.value as { run: JobRun }).run);
    from.catalog.addFile(file('job-runs.json', jobs));
    from.catalog.addFile(file('loops.json', { version: 1, state: { custom: { enabled: true, handledThrough: 1 } }, runs: [] }));
    from.catalog.seal(); transformPrivateBackupCatalog({ source: from.catalog, destination: to.catalog, at: AT });
    expect(JSON.parse(to.catalog.getFile('job-runs.json')!.data.toString())).toMatchObject({ version: 1, runs: [{ status: 'completed' }, { status: 'interrupted' }, { status: 'interrupted' }] });
    expect(to.catalog.countRecords()).toBe(0);
    await compareV1(from.catalog, to.catalog);
  });
  it.each([false, true])('interrupts normalized mail while preserving sources, manual decisions and legacy origin evidence (legacy=%s)', async legacy => {
    const from = await fixture(), to = await fixture(from.workspaceId, false), mail = normalizedMail(from.workspaceId, legacy);
    for (const f of mail.files) from.catalog.addFile(f);
    for (const row of mail.rows) from.catalog.addRecord(row);
    from.catalog.seal(); transformPrivateBackupCatalog({ source: from.catalog, destination: to.catalog, at: AT });
    expect([...to.catalog.iterateRecords()]).toEqual(interruptMailRecordsForRestore(mail.rows, from.workspaceId, AT));
    expect(to.catalog.getRecord('mail-register', 'mail-register:workspace')).toMatchObject({ revision: 6, value: { revision: 1, activeScan: null } });
    expect(to.catalog.getRecord('mail-receipt', `mail-receipt:${mail.pending.id}`)).toMatchObject({ revision: 3, value: { status: 'interrupted', completedAt: AT } });
    for (const f of mail.files) expect(to.catalog.getFile(f.path)!.data).toEqual(f.data);
    expect(to.catalog.getRecord('mail-prepared', 'mail-prepared:workspace')!.value).toEqual({ ...mail.f.prepared, input: mail.f.input });
  });
  it('retains all 200 existing mail gaps without exceeding the receipt limit', async () => {
    const from = await fixture(), to = await fixture(from.workspaceId, false), mail = normalizedMail(from.workspaceId, false, 200);
    for (const row of mail.rows) from.catalog.addRecord(row);
    from.catalog.seal(); transformPrivateBackupCatalog({ source: from.catalog, destination: to.catalog, at: AT });
    expect((to.catalog.getRecord('mail-receipt', `mail-receipt:${mail.pending.id}`)!.value as { gaps: string[] }).gaps).toEqual(mail.pending.gaps);
  });
  it('preserves closed/raw review drafts and immutable proposal requests exactly', async () => {
    const from = await fixture(), to = await fixture(from.workspaceId, false), directory = join(from.directory, 'domain'), db = new WorkflowDatabase({ dir: directory, key: from.key });
    try {
      const seed = await proposalBackupFixture(db, directory), drafts = new BillReviewDraftStore(db, { workspaceId: from.workspaceId });
      const common = { workspaceId: from.workspaceId, state: 'saved' as const, billId: null, billRevision: null, itemId: seed.request.itemId, messageId: seed.request.messageId, sourceDigest: seed.request.expectedSourceDigest,
        fields: { propertyId: '', kind: 'Water', vendor: '', amount: '12.', invoiceDate: '2026-', dueDate: '', note: ' Unfinished notes 私人\n  ' }, billState: 'hold' as const, reason: 'Keep this reason', seriesId: '', arrivalDate: '', proposalRequest: seed.request };
      for (const state of ['editing', 'saved', 'accepted', 'discarded'] as const) drafts.create(randomUUID(), null, { ...common, state });
    } finally { db.close(); }
    const rows = new DatabaseSync(join(directory, 'workflow-state.sqlite'), { readOnly: true });
    try { for (const row of rows.prepare('SELECT id,kind,revision,payload FROM workflow_records ORDER BY rowid').iterate()) from.catalog.addRecord({ id: String(row.id), kind: String(row.kind), revision: Number(row.revision), value: decryptJson(from.key, JSON.parse(String(row.payload))) }); }
    finally { rows.close(); }
    from.catalog.seal(); transformPrivateBackupCatalog({ source: from.catalog, destination: to.catalog, at: AT });
    expect([...to.catalog.iterateRecords()]).toEqual([...from.catalog.iterateRecords()]);
  });
  it('rejects unsealed/mismatched/nonempty inputs before preparation and never seals a partial capacity failure', async () => {
    const from = await fixture(), to = await fixture(from.workspaceId, false), other = await fixture(undefined, false);
    expect(() => transformPrivateBackupCatalog({ source: from.catalog, destination: to.catalog, at: AT })).toThrow('sealed source');
    expect(to.catalog.summary().entries).toBe(0); from.catalog.seal();
    expect(() => transformPrivateBackupCatalog({ source: from.catalog, destination: other.catalog, at: AT })).toThrow('same archived workspace');
    to.catalog.addRecord(handoff());
    expect(() => transformPrivateBackupCatalog({ source: from.catalog, destination: to.catalog, at: AT })).toThrow('empty separate');
    const small = await fixture(from.workspaceId, false, 2);
    expect(() => transformPrivateBackupCatalog({ source: from.catalog, destination: small.catalog, at: AT })).toThrow(/capacity/);
    expect(small.catalog.summary().sealed).toBe(false); expect(from.catalog.summary().sealed).toBe(true);
  });
  it('rejects a regenerated execution projection above 8 MiB before preparing any destination rows', async () => {
    const from = await fixture(), to = await fixture(from.workspaceId, false), history = executionFixture();
    const stream = executionStream('job', 'job-runs.json'), contents = JSON.stringify({ version: 1, executionHistory: 1, runs: [] });
    // A retained checkpoint may be ahead of its bounded compatibility file.
    // Restore must enforce the final file size while resolving those receipts.
    from.catalog.addFile({ path: 'job-runs.json', encoding: 'bytes', data: Buffer.from(contents) });
    const selected = history.rows.filter(row => row.kind.startsWith('execution-') && (row.value as { stream: string }).stream === stream);
    for (const row of selected) {
      if (row.kind === 'execution-job') {
        const value = row.value as { run: JobRun; binding: string };
        value.run.spec.description = 'x'.repeat(4_200_000); value.binding = jobHistoryBinding(value.run);
      }
    }
    for (const row of selected) {
      if (row.kind === 'execution-request') {
        const value = row.value as { binding: string; runId: string };
        value.binding = (selected.find(r => r.kind === 'execution-job' && (r.value as { run: JobRun }).run.id === value.runId)!.value as { binding: string }).binding;
      }
      if (row.kind === 'execution-state') (row.value as { currentHash: string }).currentHash = executionDigest(contents);
      from.catalog.addRecord(row);
    }
    from.catalog.seal();
    expect(() => transformPrivateBackupCatalog({ source: from.catalog, destination: to.catalog, at: AT })).toThrow(/projection exceeds/);
    expect(to.catalog.summary()).toMatchObject({ entries: 0, sealed: false });
    expect(from.catalog.summary().sealed).toBe(true);
  }, 30_000);
  it('rechecks the encrypted record limit after adding recovery metadata', async () => {
    const from = await fixture(), to = await fixture(from.workspaceId, false), row = handoff();
    const value = { ...(row.value as object), detail: '', binding: undefined, padding: '' };
    const initial = JSON.stringify(encryptJson(from.key, value)).length;
    value.padding = 'x'.repeat(Math.floor((WORKFLOW_MAX_ENCRYPTED_RECORD_LENGTH - initial) * 3 / 4) - 32);
    from.catalog.addRecord({ ...row, value }); from.catalog.seal();
    expect(() => transformPrivateBackupCatalog({ source: from.catalog, destination: to.catalog, at: AT })).toThrow(/encrypted entity limit/);
    expect(to.catalog.summary().sealed).toBe(false); expect(to.catalog.countRecords()).toBe(0);
    expect(from.catalog.getRecord(row.kind, row.id)!.revision).toBe(row.revision);
  }, 30_000);
});
