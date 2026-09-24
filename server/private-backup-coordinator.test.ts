import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { open, readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyV3 } from '../shared/desk-v3.ts';
import { encryptJson, decryptJson } from './desk-crypto.ts';
import { createPrivateWorkspaceBackup } from './private-workspace-backup.ts';
import { createPrivateBackupCoordinator, privateBackupFailureReason, privateBackupStackLocations, type PrivateBackupCoordinatorHost, type PrivateBackupFailureDiagnostic } from './private-backup-coordinator.ts';
import { WorkspaceActivityGate } from './workspace-activity.ts';
import { withDurablePrivateBackupRestore } from './private-backup-legacy-api.ts';
import { createPrivateBackupV2Api } from './private-backup-v2-api.ts';
import { handlePrivateBackupV2Http } from './private-backup-http.ts';
import { applyStagedPrivateRestoreV2 } from './private-backup-cold-restore.ts';
import { WorkflowDatabase } from './workflow-database.ts';
import { BankReferenceStore } from './bank-reference-store.ts';
import { PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES as CHUNK } from '../shared/private-backup-transfers.ts';
import { plantPrivateFile, privateTempRoot, removeFixture, windowsAdmissionTimeout } from './testing/private-fixture.ts';

const roots: string[] = [], services: Awaited<ReturnType<typeof createPrivateBackupCoordinator>>[] = [];
const phrase = 'Fictional coordinator backup phrase', sha = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
async function write(dir: string, path: string, bytes: Buffer | string) { plantPrivateFile(join(dir, path), bytes); }
async function fixture() {
  const directory = privateTempRoot(join(realpathSync(tmpdir()), 'RealBud coordinator Ω ')); roots.push(directory);
  const key = randomBytes(32), workspaceId = randomUUID(); let held = false;
  await write(directory, 'company-installation/workspace.json', JSON.stringify({ version: 1, id: workspaceId, workerMemberKey: null }));
  await write(directory, 'desk.json', JSON.stringify(encryptJson(key, emptyV3({ name: 'Fictional coordinator agency', timezone: 'UTC', jurisdictions: [] }))));
  const host: PrivateBackupCoordinatorHost = { directory, key, workspaceId, now: Date.now, freeBytes: async () => 100 * 1024 ** 3,
    captureLimits: { maxEntries: 1000, maxBytes: 16 * 1024 ** 2 },
    snapshotLease: async () => { let released = false; return { assertCurrent() { if (released) throw new Error('Fixture lease released'); }, release() { released = true; } }; },
    assertFresh() {}, assertIdle() {}, epoch: () => 'fixture', beginRestore() { held = true; } };
  const service = await createPrivateBackupCoordinator(host); services.push(service); return { directory, key, workspaceId, host, service, held: () => held };
}
async function upload(service: Awaited<ReturnType<typeof createPrivateBackupCoordinator>>, bytes: Buffer, id = randomUUID()) {
  await service.startUpload(id, bytes.length); const tuples: [number, number, string][] = [];
  for (let offset = 0; offset < bytes.length; offset += CHUNK) { const chunk = bytes.subarray(offset, offset + CHUNK), digest = sha(chunk); tuples.push([offset, chunk.length, digest]); await service.appendUpload(id, offset, chunk, digest); }
  await service.sealUpload(id, bytes.length, sha(JSON.stringify(tuples))); return id;
}
async function exported(f: Awaited<ReturnType<typeof fixture>>) {
  const id = randomUUID(); await f.service.startExport(id, phrase); const ready = await f.service.settled(id); expect(ready.phase).toBe('ready');
  const ticket = await f.service.downloadTicket(id, ready.artifact!.archiveDigest), chunks: Buffer[] = [];
  await f.service.download(ticket.url.split('/').at(-1)!, async (_, stream) => { for await (const chunk of stream) chunks.push(Buffer.from(chunk)); });
  return { id, ticket, bytes: Buffer.concat(chunks), ready };
}
afterEach(async () => { vi.restoreAllMocks(); for (const service of services.splice(0)) await service.close(); for (const root of roots.splice(0)) await removeFixture(root); });

describe('durable private backup coordinator', () => {
  it('retains independent streamed chunks until the consumer finishes and verifies the delivered digest', async () => {
    const f = await fixture(); await write(f.directory, 'vault/workflow-inputs/large.txt', randomBytes(3 * CHUNK + 17));
    const id = randomUUID(); await f.service.startExport(id, phrase); const op = await f.service.settled(id); expect(op.phase).toBe('ready');
    const ticket = await f.service.downloadTicket(id, op.artifact!.archiveDigest); const retained: Buffer[] = [];
    await f.service.download(ticket.url.split('/').at(-1)!, async (_, stream) => { for await (const chunk of stream) retained.push(chunk); });
    expect(retained.length).toBeGreaterThan(3); expect(sha(Buffer.concat(retained))).toBe(ticket.archiveDigest);
  });
  it.each([0, 3 * CHUNK + 17])('never completes the HTTP Content-Length body when an archive changes during download (%i source bytes)', async sourceBytes => {
    const f = await fixture(); if (sourceBytes) await write(f.directory, 'vault/workflow-inputs/large.txt', randomBytes(sourceBytes));
    const id = randomUUID(); await f.service.startExport(id, phrase); const ready = await f.service.settled(id);
    const ticket = await f.service.downloadTicket(id, ready.artifact!.archiveDigest), parent = join(f.directory, 'private-backup-v2/exports');
    const path = join(parent, (await readdir(parent))[0]!, 'archive.realbud-backup'); let sent = 0;
    const altered = { ...f.service, async download(token: string, sink: Parameters<typeof f.service.download>[1]) {
      return f.service.download(token, async (checked, chunks, signal) => {
        const mutate = async () => { const file = await open(path, 'r+'); try { const byte = Buffer.alloc(1); await file.read(byte, 0, 1, checked.archiveBytes - 1); byte[0] ^= 1; await file.write(byte, 0, 1, checked.archiveBytes - 1); await file.sync(); } finally { await file.close(); } };
        async function* stream() {
          if (!sourceBytes) await mutate();
          for await (const chunk of chunks) { sent += chunk.length; yield chunk; if (sourceBytes && sent === chunk.length) await mutate(); }
        }
        await sink(checked, stream(), signal);
      });
    } };
    const server = createServer(async (req, res) => { await handlePrivateBackupV2Http(req, res, new URL(req.url!, 'http://localhost'), altered); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const response = fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}${ticket.url}`).then(r => r.arrayBuffer());
      await expect(response).rejects.toThrow(); expect(sent).toBeLessThan(ticket.archiveBytes);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('admits only one restore even with an unusually permissive host and retains both reviewed uploads', windowsAdmissionTimeout(216), async () => {
    const source = await fixture(), target = await fixture(), archive = await exported(source), digest = sha(archive.bytes), ids: string[] = [];
    for (let i = 0; i < 2; i++) { const id = await upload(target.service, archive.bytes); ids.push(id); await target.service.preview(id, phrase, digest); expect((await target.service.settled(id)).phase).toBe('reviewed'); }
    let release!: () => void, entered!: () => void; const waiting = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { entered = r; }), lease = target.host.snapshotLease;
    target.host.snapshotLease = async () => { entered(); await waiting; return lease(); };
    const first = target.service.stage(ids[0]!, digest); await ready;
    await expect(target.service.stage(ids[0]!, digest)).rejects.toMatchObject({ status: 409 }); await expect(target.service.stage(ids[1]!, digest)).rejects.toMatchObject({ status: 409 });
    expect((await target.service.get(ids[1]!)).phase).toBe('reviewed'); release(); expect((await first).phase).toBe('staged');
    await expect(target.service.stage(ids[1]!, digest)).rejects.toMatchObject({ status: 409 });
  });
  it('releases a host lease exactly once after export', async () => {
    const f = await fixture(); let releases = 0;
    f.host.snapshotLease = async () => ({ assertCurrent() {}, release() { if (++releases > 1) throw new Error('Fixture double release'); } });
    const result = await exported(f); expect(result.ready.phase).toBe('ready'); expect(releases).toBe(1);
  });

  it('recovers a crash boundary between the durable stage hold and publishing the restart descriptor', windowsAdmissionTimeout(157), async () => {
    const source = await fixture(), target = await fixture(), archive = await exported(source), id = await upload(target.service, archive.bytes), digest = sha(archive.bytes);
    await target.service.preview(id, phrase, digest); expect((await target.service.settled(id)).phase).toBe('reviewed');
    const begin = target.host.beginRestore; target.host.beginRestore = () => { target.host.beginRestore = begin; throw new Error('Fictional stage publication interruption'); };
    await expect(target.service.stage(id, digest)).rejects.toThrow('publication interruption'); expect(target.service.heldOperation()).toMatchObject({ phase: 'staging', canCancel: false });
    await target.service.close(); const resumed = await createPrivateBackupCoordinator(target.host); services.push(resumed);
    expect(await resumed.get(id)).toMatchObject({ phase: 'staged', artifact: { archiveDigest: digest } });
    await expect(resumed.startUpload(randomUUID(), 4)).rejects.toMatchObject({ status: 409 });
  });
  it('clears a persisted recovery warning only after held staging successfully resumes', windowsAdmissionTimeout(164), async () => {
    const source = await fixture(), target = await fixture(), archive = await exported(source), id = await upload(target.service, archive.bytes), digest = sha(archive.bytes);
    await target.service.preview(id, phrase, digest); await target.service.settled(id);
    const begin = target.host.beginRestore, fresh = target.host.assertFresh;
    target.host.beginRestore = () => { target.host.beginRestore = begin; throw new Error('Fixture publication interrupted'); };
    await expect(target.service.stage(id, digest)).rejects.toThrow('publication interrupted'); await target.service.close();
    target.host.assertFresh = () => { throw new Error('Fixture recovery temporarily unavailable'); };
    const resumed = await createPrivateBackupCoordinator(target.host); services.push(resumed);
    expect(await resumed.get(id)).toMatchObject({ phase: 'staging', error: { code: 'recovery-required' } });
    target.host.assertFresh = fresh;
    expect(await resumed.stage(id, digest)).toMatchObject({ phase: 'staged' }); expect((await resumed.get(id)).error).toBeUndefined();
  });
  it('keeps the legacy API restore bound to the same operation journal', windowsAdmissionTimeout(189), async () => {
    const source = await fixture(), target = await fixture();
    const legacy = (f: typeof source) => createPrivateWorkspaceBackup({ directory: f.directory, key: () => f.key, workspaceId: f.workspaceId, epoch: () => 'fixture', assertIdle() {}, assertFresh() {} });
    const exported = await legacy(source).exportBackup(phrase), bridge = withDurablePrivateBackupRestore(legacy(target), target.service);
    expect(await bridge.stageRestore({ backup: exported.backup, passphrase: phrase, expectedDigest: exported.receipt.digest })).toMatchObject({ needsRestart: true, receipt: { digest: exported.receipt.digest } });
    expect(await bridge.status()).toMatchObject({ state: 'staged' }); await target.service.close();
    expect(await applyStagedPrivateRestoreV2({ directory: target.directory, key: target.key })).toMatchObject({ restored: true });
    const reopened = await createPrivateBackupCoordinator({ ...target.host, workspaceId: source.workspaceId }); services.push(reopened); expect(await reopened.list({ limit: 20 })).toMatchObject({ total: 0 });
  });

  it('exports actual bank bytes, previews through the strict API and restores with bound cold completion', windowsAdmissionTimeout(260), async () => {
    const source = await fixture(), target = await fixture(), csv = Buffer.from('\uFEFFDate,Amount,Description,Reference\r\n21/09/2026,12.00,"Fictional café 🏡",old\r\n');
    await write(source.directory, 'vault/workflow-inputs/bank.csv', csv);
    const db = new WorkflowDatabase({ dir: source.directory, key: source.key }); let bank;
    try { bank = new BankReferenceStore(db).create({ source: { filename: 'fictional.csv', bytesBase64: csv.toString('base64') }, columns: { date: 'Date', amount: 'Amount', narrative: 'Description', reference: 'Reference' }, dateFormat: 'DD/MM/YYYY', rules: [{ propertyId: 'fictional', reference: '00012', aliases: ['Fictional'] }] }); } finally { db.close(); }
    const archive = await exported(source); expect(sha(archive.bytes)).toBe(archive.ticket.archiveDigest);
    await expect(source.service.download(archive.ticket.url.split('/').at(-1)!, async () => {})).rejects.toMatchObject({ status: 404 });
    const id = await upload(target.service, archive.bytes), api = createPrivateBackupV2Api({ service: () => target.service });
    const reply = await api({ path: `/api/private-backup/v2/uploads/${id}/preview`, method: 'POST', body: { passphrase: phrase, expectedArchiveDigest: sha(archive.bytes) } });
    expect(reply).toMatchObject({ status: 202, body: { operation: { phase: 'checking' } } });
    expect((await target.service.settled(id)).phase).toBe('reviewed');
    const staged = await target.service.stage(id, sha(archive.bytes)); expect(staged.phase).toBe('staged'); expect(target.held()).toBe(true);
    await expect(target.service.cancel(id)).rejects.toMatchObject({ status: 409 });
    await target.service.close(); expect(await applyStagedPrivateRestoreV2({ directory: target.directory, key: target.key })).toMatchObject({ restored: true });
    expect(await readFile(join(target.directory, 'vault/workflow-inputs/bank.csv'))).toEqual(csv);
    const restored = new WorkflowDatabase({ dir: target.directory, key: target.key }); try { expect(new BankReferenceStore(restored).get(bank!.id)).toEqual(bank); } finally { restored.close(); }
    expect((decryptJson(target.key, JSON.parse(await readFile(join(target.directory, 'desk.json'), 'utf8'))) as { hands: string }).hands).toBe('held');
    const reopened = await createPrivateBackupCoordinator({ ...target.host, workspaceId: source.workspaceId }); services.push(reopened);
    expect(await reopened.list({ limit: 20 })).toMatchObject({ total: 0, items: [] }); await expect(reopened.get(id)).rejects.toMatchObject({ status: 404 });
  });
  it('imports formatted v1 archives, preserves the upload after a wrong phrase, and retries with fresh provisional resources', windowsAdmissionTimeout(152), async () => {
    const source = await fixture(), target = await fixture();
    const legacy = createPrivateWorkspaceBackup({ directory: source.directory, key: () => source.key, workspaceId: source.workspaceId, epoch: () => 'fixture', assertIdle() {}, assertFresh() {} });
    const archive = await legacy.exportBackup(phrase), bytes = Buffer.from(JSON.stringify(archive.backup, null, 2) + '\n'), digest = sha(bytes), id = await upload(target.service, bytes);
    await target.service.preview(id, 'Fictional incorrect phrase', digest); expect((await target.service.settled(id)).phase).toBe('failed');
    expect(await target.service.get(id)).toMatchObject({ artifact: { archiveDigest: digest }, receivedBytes: bytes.length });
    await target.service.preview(id, phrase, digest); const reviewed = await target.service.settled(id); expect(reviewed).toMatchObject({ phase: 'reviewed', preview: { digest, workspaceId: source.workspaceId } });
    expect((await target.service.stage(id, digest)).phase).toBe('staged');
  });
  it('resumes accepted chunks after restart and refuses stale, mismatched, or cancelled requests', windowsAdmissionTimeout(67), async () => {
    const f = await fixture(), bytes = Buffer.alloc(CHUNK + 17, 7), id = randomUUID();
    await f.service.startUpload(id, bytes.length); await f.service.appendUpload(id, 0, bytes.subarray(0, CHUNK), sha(bytes.subarray(0, CHUNK))); await f.service.close();
    const reopened = await createPrivateBackupCoordinator(f.host); services.push(reopened);
    expect(await reopened.get(id)).toMatchObject({ receivedBytes: CHUNK, phase: 'uploading' });
    await expect(reopened.startUpload(id, bytes.length + 1)).rejects.toMatchObject({ status: 409 });
    await expect(reopened.appendUpload(id, CHUNK, bytes.subarray(CHUNK), '0'.repeat(64))).rejects.toMatchObject({ status: 400 });
    await reopened.appendUpload(id, CHUNK, bytes.subarray(CHUNK), sha(bytes.subarray(CHUNK)));
    expect((await reopened.cancel(id)).phase).toBe('cancelled'); await expect(reopened.appendUpload(id, CHUNK, bytes.subarray(CHUNK), sha(bytes.subarray(CHUNK)))).rejects.toMatchObject({ status: 409 });
    expect((await reopened.get(id)).phase).toBe('cancelled');
  });
  it('refuses new allocation without enough disk while retaining an existing upload for cancellation', async () => {
    const f = await fixture(), id = await upload(f.service, Buffer.from('Fictional invalid archive'));
    f.host.freeBytes = async () => 0;
    await expect(f.service.startUpload(randomUUID(), 4)).rejects.toMatchObject({ status: 507 });
    expect((await f.service.cancel(id)).phase).toBe('cancelled');
  });
});

describe('private backup failure diagnostics', () => {
  it('keeps only server/shared basenames and lines from source, compiled Windows and file URL stacks', () => {
    // The message repeats in the stack header, including a line shaped like a frame.
    const message = 'fictional first line C:\\Users\\fictional\\.realbud\\server\\message.ts:1:1\n    at C:\\Users\\Fictional\\shared\\Fictional-Tenancy-2026.js:12:3';
    const stack = [
      `Error: ${message}`,
      '    at CaptureReader.check (/synthetic/app/server/private-backup-capture.ts:107:13)',
      '    at file:///C:/Program%20Files/RealBud/resources/dist-server/server/private-backup-coordinator.js:250:11',
      '    at async CaptureReader.file (C:\\Program Files\\RealBud\\resources\\server\\private-backup-capture.js:171:5)',
      '    at parse (C:\\synthetic\\dist-server\\shared\\private-backup-transfers.js:9:2)',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
      '    at Object.<anonymous> (/synthetic/node_modules/fictional/lib/index.js:1:1)',
    ].join('\n');
    expect(privateBackupStackLocations({ message, stack })).toEqual(['private-backup-capture.ts:107', 'private-backup-coordinator.js:250', 'private-backup-capture.js:171', 'private-backup-transfers.js:9']);
    const real = new Error('fictional\n    at x (/synthetic/shared/Fictional-Owner.js:4:4)');
    expect(privateBackupStackLocations(real).join()).not.toContain('Fictional-Owner');
    expect(privateBackupStackLocations(real)[0]).toMatch(/^private-backup-coordinator\.test\.ts:\d+$/);
    expect(privateBackupStackLocations({ message: '', stack: ['Error', ...Array.from({ length: 12 }, (_, i) => `    at f (C:\\app\\server\\x.js:${i + 1}:1)`)].join('\n') })).toHaveLength(8);
    expect(privateBackupStackLocations(undefined)).toEqual([]);
  });
  it('maps each fixed throw-site code to one reason and leaves everything else unclassified', () => {
    const coded = (code: string, extra: object = {}) => Object.assign(new Error('Fictional message'), { status: 409, code, ...extra });
    expect(privateBackupFailureReason(coded('bud-replying'))).toBe('bud-replying');
    expect(privateBackupFailureReason(coded('changed-during-copy'))).toBe('changed-during-copy');
    expect(privateBackupFailureReason(coded('private_snapshot_interrupted', { interruption: 'timeout' }))).toBe('pause-timeout');
    expect(privateBackupFailureReason(coded('private_snapshot_interrupted', { interruption: 'queue-full' }))).toBe('pause-queue-full');
    expect(privateBackupFailureReason(coded('private_snapshot_interrupted'))).toBe('pause-stopped');
    for (const other of [coded('EACCES'), new Error('Bud was still replying'), 'bud-replying', null]) expect(privateBackupFailureReason(other)).toBe('unclassified');
  });
  it('reports a named busy reason live and in one fixed diagnostic without persisting it', async () => {
    const f = await fixture(), events: PrivateBackupFailureDiagnostic[] = [];
    f.host.diagnostic = event => { events.push(event); };
    f.host.snapshotLease = async () => { throw Object.assign(new Error('Wait for current work and setup to finish (Bud to finish its current reply).'), { status: 409, code: 'bud-replying' }); };
    const id = randomUUID(); await f.service.startExport(id, phrase);
    expect(await f.service.settled(id)).toMatchObject({ phase: 'failed', error: { code: 'workspace-busy', reason: 'bud-replying' } });
    expect((await f.service.get(id)).error).toEqual({ code: 'workspace-busy', reason: 'bud-replying' });
    expect((await f.service.list({ limit: 20 })).items.find(item => item.id === id)?.error).toEqual({ code: 'workspace-busy', reason: 'bud-replying' });
    expect(events).toEqual([{ kind: 'export', phase: 'capturing', status: 409, code: 'workspace-busy', reason: 'bud-replying', locations: expect.any(Array) }]);
    expect(events[0]!.locations.length).toBeGreaterThan(0);
    for (const location of events[0]!.locations) expect(location).toMatch(/^[\w.-]+\.(?:ts|js):\d+$/);
    expect(JSON.stringify(events)).not.toMatch(/Bud to finish|Fictional|realbud|RealBud coordinator/);
    // A restarted service reads the same saved record (not damaged) with the generic code only.
    await f.service.close(); const restarted = await createPrivateBackupCoordinator(f.host); services.push(restarted);
    expect((await restarted.get(id)).error).toEqual({ code: 'workspace-busy' });
  });
  it('names an expired capture pause from the real workspace gate', async () => {
    const f = await fixture(), gate = new WorkspaceActivityGate(), events: PrivateBackupFailureDiagnostic[] = [];
    f.host.diagnostic = event => { events.push(event); };
    f.host.snapshotLease = async () => { const lease = await gate.pause({ timeoutMs: 1 }); await new Promise(resolve => setTimeout(resolve, 10)); return lease; };
    const id = randomUUID(); await f.service.startExport(id, phrase);
    expect((await f.service.settled(id)).error).toEqual({ code: 'workspace-busy', reason: 'pause-timeout' });
    expect(events.map(event => [event.reason, event.code])).toEqual([['pause-timeout', 'workspace-busy']]);
    // The stack names the capture step that found the expired pause, not the timer.
    expect(events[0]!.locations.some(location => location.startsWith('private-backup-capture.ts:'))).toBe(true);
    expect(gate.paused).toBe(false);
  });
});
