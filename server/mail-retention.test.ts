import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { WorkflowDatabase } from './workflow-database.ts';
import { createMailIngestionService, type MailAuthority } from './mail-ingestion.ts';
import { defaultAgencySettings } from './agency-setup.ts';
import { createPrivateVault } from './private-vault.ts';
import { legacyMailBackupFixture } from './testing/mail-backup-fixture.ts';
import { privateDirectory, writePrivateJson } from './private-json.ts';
import { mailRecordId } from './mail-records.ts';
import { MailStorage } from './mail-storage.ts';
import type { MailScanRequest, MailScanResult } from '../shared/mail-ingestion.ts';
const roots: string[] = [], services: ReturnType<typeof createMailIngestionService>[] = [], databases: WorkflowDatabase[] = [], children: ChildProcess[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await once(child, 'exit');
    } for (const service of services.splice(0))
    await service.close(); for (const db of databases.splice(0))
    db.close(); for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true }); });
const time = Date.parse('2026-09-21T00:00:00Z'), key = Buffer.alloc(32, 19), workspaceId = 'mail-retention-fixture';
async function fixture() {
    const directory = await mkdtemp(join(realpathSync(tmpdir()), 'rb-mail-retention-'));
    roots.push(directory);
    const settings = { ...defaultAgencySettings(), workflowPackId: 'office-core' as const, gmailAccountId: 'fictional-mail', agencyName: 'Fictional company', selectedWorkflows: ['morning-priorities' as const] };
    const authority: MailAuthority = { accountId: 'fictional-mail', bindingRevision: 'a'.repeat(64), settingsRevision: 1, settings };
    let at = time;
    const authorize = vi.fn(async () => structuredClone(authority)), scan = vi.fn(async (_a: MailAuthority, request: MailScanRequest, _signal?: AbortSignal): Promise<MailScanResult> => ({ accountId: 'fictional-mail', windowStartAt: request.windowStartAt, windowEndAt: request.windowEndAt, pages: 1, paginationComplete: true, gaps: [], threads: Array.from({ length: 30 }, (_, i) => ({ id: (i + 1).toString(16), historyComplete: true, messages: [{ id: (i + 100).toString(16), threadId: (i + 1).toString(16), at: time - i - 1, direction: 'incoming', from: 'sender@example.test', to: 'accounts@example.test', subject: `Fictional conversation ${i}`, body: 'Synthetic task evidence.', bodyTruncated: false, attachments: [] }] })) }));
    const options = { directory, workspaceId, key, workroomDirectory: join(directory, 'workroom'), authorize, scan, now: () => at };
    const make = () => { const db = new WorkflowDatabase({ dir: directory, key }); databases.push(db); const service = createMailIngestionService({ ...options, database: db }); services.push(service); return { service, db }; };
    return { directory, options, make, authority, scan, advance: (amount = 1000) => { at += amount; } };
}
function payloads(db: WorkflowDatabase) { return db.page('mail-register', { limit: 1 }).records.map(r => r.value); }
describe('normalized permanent mail retention and process fencing', () => {
    it('does not materialize records for fresh metadata, page, history, epoch or busy reads', async () => { const f = await fixture(), { service, db } = f.make(); expect(await service.get()).toMatchObject({ version: 2, revision: 0, counts: { total: 0 } }); expect((await service.page()).items).toEqual([]); expect((await service.scanHistory()).items).toEqual([]); expect(service.epoch).toBe(0); expect(service.busy).toBe(false); expect(db.hasRecords()).toBe(false); });
    it('keeps bounded newest-first pages, direct old lookup, global search, stale continuation and mail-specific epoch across unrelated writes', async () => {
        const f = await fixture(), a = f.make(), b = f.make();
        const meta = await a.service.collect();
        expect(meta.counts.total).toBe(30);
        expect(meta).not.toHaveProperty('items');
        const first = await a.service.page({ group: 'all', limit: 5 });
        expect(first.items.map(i => i.threadId)).toEqual(['1', '2', '3', '4', '5']);
        expect(first.total).toBe(30);
        const second = await a.service.page({ group: 'all', limit: 5, cursor: first.nextCursor! });
        expect(second.items.map(i => i.threadId)).toEqual(['6', '7', '8', '9', 'a']);
        const old = (await a.service.page({ group: 'all', q: 'conversation 29' })).items[0];
        expect(await b.service.getItem(old.id)).toEqual(old);
        const epoch = a.service.epoch;
        a.db.create('test-execution', 'test-unrelated-execution', { status: 'running' });
        expect(a.service.epoch).toBe(epoch);
        const updated = await b.service.update(old.id, { expectedRevision: old.revision, status: 'done', note: 'Retained human decision.' });
        expect(updated.item.status).toBe('done');
        expect(updated.workspace.counts.done).toBe(1);
        await expect(a.service.page({ group: 'all', limit: 5, cursor: first.nextCursor! })).rejects.toMatchObject({ status: 409 });
        await expect(a.service.update(old.id, { expectedRevision: old.revision, status: 'open' })).rejects.toMatchObject({ status: 409 });
        expect((await a.service.source(old.id)).thread.id).toBe(old.threadId);
    });
    it('rejects malformed cursor sort keys and direct query types without writes', async () => { const f = await fixture(), { service, db } = f.make(); await service.collect(); const first = await service.page({ group: 'all', limit: 1 }), decoded = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString()); const before = payloads(db); for (const after of [{ ...decoded.after, priority: 'unknown' }, { ...decoded.after, lastMessageAt: -1 }, { ...decoded.after, id: 'not-a-head' }, { ...decoded.after, extra: true }])
        await expect(service.page({ group: 'all', cursor: Buffer.from(JSON.stringify({ ...decoded, after })).toString('base64url') })).rejects.toMatchObject({ status: 409 }); await expect(service.page({ q: 3 as unknown as string })).rejects.toMatchObject({ status: 400 }); expect(payloads(db)).toEqual(before); });
    it('preserves one live acquisition between independent handles and commits a concurrent human decision', async () => { const f = await fixture(), a = f.make(), b = f.make(); await a.service.collect(); const item = (await a.service.page()).items[0]; let release!: () => void, entered!: () => void; const reached = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; }); const prior = f.scan.getMockImplementation()!; f.scan.mockImplementationOnce(async (authority, request) => { entered(); await gate; return prior(authority, request); }); const collecting = a.service.collect(); await reached; expect(b.service.busy).toBe(true); expect((await b.service.get()).latestScan?.status).toBe('running'); await expect(b.service.collect()).rejects.toMatchObject({ status: 409 }); await b.service.update(item.id, { expectedRevision: item.revision, status: 'done', note: 'Decision during provider read.' }); release(); await collecting; expect((await a.service.getItem(item.id)).status).toBe('done'); expect(f.scan).toHaveBeenCalledTimes(2); });
    it('waits for an abort-aware provider to settle before closing its database', async () => {
        const f = await fixture(), a = f.make();
        let entered!: () => void;
        const reached = new Promise<void>(resolve => { entered = resolve; });
        f.scan.mockImplementationOnce(async (_authority, _request, signal) => { entered(); await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('Synthetic stopped provider')), { once: true })); throw new Error('Unexpected continuation'); });
        const run = a.service.collect();
        const rejected = expect(run).rejects.toThrow('Synthetic stopped provider');
        await reached;
        await a.service.close();
        await rejected;
        services.splice(services.indexOf(a.service), 1);
        const b = f.make();
        expect((await b.service.get()).latestScan?.status).toBe('interrupted');
        expect(b.service.busy).toBe(false);
        await b.service.collect();
        expect((await b.service.scanHistory()).total).toBe(2);
    });
    it('allows authority to observe mail during both preparation checks without a serial deadlock',async()=>{
        const f=await fixture();let service!:ReturnType<typeof createMailIngestionService>;
        const authorize=vi.fn(async()=>{await service.get();return structuredClone(f.authority);});
        service=createMailIngestionService({...f.options,authorize});services.push(service);
        await service.collect();authorize.mockClear();expect(await service.prepareInput()).toMatchObject({batchThreadCount:20});
        expect(authorize).toHaveBeenCalledTimes(2);expect((await service.get()).latestScan?.status).toBe('complete');
    });
    it('withholds a prepared binding when staff edits occur during reauthorization',async()=>{
        const f=await fixture();let service!:ReturnType<typeof createMailIngestionService>;let checks=0;let editOnSecond=false;
        const authorize=async()=>{await service.get();if(editOnSecond&&++checks===2){const item=(await service.page()).items[0];await service.update(item.id,{expectedRevision:item.revision,priority:'high',note:'Staff decision during preparation.'});}return structuredClone(f.authority);};
        const db=new WorkflowDatabase({dir:f.directory,key});databases.push(db);service=createMailIngestionService({...f.options,database:db,authorize});services.push(service);
        await service.collect();editOnSecond=true;await expect(service.prepareInput()).rejects.toMatchObject({status:409});
        expect(db.get('mail-prepared',mailRecordId('mail-prepared'))).toBeUndefined();expect((await service.page()).items[0].note).toBe('Staff decision during preparation.');
    });
    it('invalidates metadata cached inside a rolled back outer transaction',async()=>{
        const f=await fixture(),a=f.make();await a.service.collect();const storage=new MailStorage({...f.options,database:a.db});await storage.ready();const item=(await a.service.page()).items[0];
        expect(()=>a.db.transaction(()=>{storage.run(()=>{storage.saveItem({...item,revision:item.revision+1,status:'done'});storage.saveRegister(storage.register());expect(storage.metadata().counts.done).toBe(1);});throw Object.assign(new Error('Synthetic outer rollback'),{status:409});})).toThrow('Synthetic outer rollback');
        expect(storage.run(()=>storage.metadata()).counts).toMatchObject({total:30,open:30,done:0});expect((await a.service.getItem(item.id)).status).toBe('open');
    });
    it('fences a real child-process owner and recovers only after verified process exit', async () => {
        const f = await fixture();
        const path = join(f.directory, 'owner.mjs');
        await writeFile(path, `import { createMailIngestionService } from ${JSON.stringify(resolve('server/mail-ingestion.ts'))};\nconst authority=${JSON.stringify(f.authority)};\nconst service=createMailIngestionService({directory:${JSON.stringify(f.directory)},workspaceId:${JSON.stringify(workspaceId)},key:Buffer.alloc(32,19),workroomDirectory:${JSON.stringify(f.options.workroomDirectory)},now:()=>${time},authorize:async()=>authority,scan:async()=>{console.log('ACQUIRED');await new Promise(()=>{});}});\nsetInterval(()=>{},1000);await service.collect();\n`);
        const child = spawn(process.execPath, ['--experimental-strip-types', path], { cwd: f.directory, env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
        children.push(child);
        await new Promise<void>((accept, reject) => { const timeout = setTimeout(() => reject(new Error('Child did not acquire mail intent')), 10000); let output = ''; child.stdout!.on('data', chunk => { output += chunk; if (output.includes('ACQUIRED')) {
            clearTimeout(timeout);
            accept();
        } }); child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Child ended before acquisition (${code})`)); }); });
        const { service } = f.make();
        expect((await service.get()).latestScan?.status).toBe('running');
        expect(service.busy).toBe(true);
        await expect(service.collect()).rejects.toMatchObject({ status: 409 });
        expect(f.scan).not.toHaveBeenCalled();
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
        expect((await service.get()).latestScan?.status).toBe('interrupted');
        expect(service.busy).toBe(false);
        await service.collect();
        expect((await service.scanHistory()).total).toBe(2);
        expect(f.scan).toHaveBeenCalledTimes(1);
    }, 20000);
    it('retains more than 2000 multilingual tasks and 1000 failed scan receipts without aggregate refusal', async () => {
        const f = await fixture(), a = f.make();
        f.scan.mockRejectedValue(new Error('Synthetic unavailable provider'));
        for (let scan = 0; scan < 1001; scan++) {
            await expect(a.service.collect()).rejects.toThrow('Synthetic unavailable provider');
            f.advance();
        }
        expect((await a.service.scanHistory()).total).toBe(1001);
        let oldestId = '';
        let oldestSource: unknown;
        let originalFirstSeen = 0;
        for (let batch = 0; batch < 21; batch++) {
            f.scan.mockImplementation(async (_authority, request) => ({ accountId: f.authority.accountId, windowStartAt: request.windowStartAt, windowEndAt: request.windowEndAt, pages: 1, paginationComplete: true, gaps: [], threads: Array.from({ length: 100 }, (_, i) => { const id = (10000 + batch * 100 + i).toString(16); return { id, historyComplete: true, messages: [{ id, threadId: id, at: time + batch * 100 + i, direction: 'incoming' as const, from: 'sender@example.test', to: 'accounts@example.test', subject: '保留歷史證據'.repeat(150), body: 'Synthetic retained conversation.', bodyTruncated: false, attachments: [] }] }; }) }));
            f.advance(1000);
            const meta = await a.service.collect();
            expect(meta.counts.total).toBe((batch + 1) * 100);
            if (batch === 0) {
                const item = (await a.service.page({ group: 'all' })).items[0];
                oldestId = item.id;
                originalFirstSeen = item.firstSeenAt;
                oldestSource = await a.service.source(item.id);
                await a.service.update(item.id, { expectedRevision: item.revision, status: 'done', priority: 'high', note: 'Retain the completed decision across all later scans.' });
            }
        }
        expect((await a.service.scanHistory()).total).toBe(1022);
        expect((await a.service.get()).counts).toMatchObject({ total: 2100, done: 1 });
        const start = performance.now(), b = f.make();
        const restored = await b.service.get(), coldMetadataMs = performance.now() - start;
        const warmStart = performance.now();
        await b.service.get();
        const warmMetadataMs = performance.now() - warmStart;
        const pageStart = performance.now();
        const page = await b.service.page({ group: 'all', limit: 20 });
        const pageMs = performance.now() - pageStart;
        expect(restored.counts.total).toBe(2100);
        expect(page.items).toHaveLength(20);
        expect(page.total).toBe(2100);
        expect(await b.service.source(oldestId)).toEqual(oldestSource);
        expect(await b.service.getItem(oldestId)).toMatchObject({ status: 'done', firstSeenAt: originalFirstSeen, note: 'Retain the completed decision across all later scans.' });
        console.info(JSON.stringify({ mailRetentionMeasurement: { tasks: 2100, receipts: 1022, coldMetadataMs, warmMetadataMs, pageMs, platform: process.platform, provider: 'fictional' } }));
        if(process.env.MAIL_RETENTION_MEASUREMENT_OUTPUT)await writeFile(process.env.MAIL_RETENTION_MEASUREMENT_OUTPUT,JSON.stringify({tasks:2100,receipts:1022,coldMetadataMs,warmMetadataMs,pageMs,platform:process.platform,node:process.version,provider:'fictional'},null,2)+'\n');
    }, 90000);
    it.skipIf(process.platform==='win32')('refuses a linked legacy private directory without following its saved sources',async()=>{
        const f=await fixture(),legacy=legacyMailBackupFixture(workspaceId,time),vault=createPrivateVault(f.directory,key);
        await vault.write('mail-workspace',legacy.state);await vault.write(`mail-scan-${legacy.receipt.id}`,legacy.source);
        const directory=join(f.directory,'company-installation','private'),retained=join(f.directory,'retained-private');await rename(directory,retained);await symlink(retained,directory);
        const original=await readFile(join(retained,'mail-workspace.json')),a=f.make();await expect(a.service.get()).rejects.toMatchObject({status:503});expect(a.db.hasRecords()).toBe(false);expect(await readFile(join(retained,'mail-workspace.json'))).toEqual(original);
    });
    it('rejects missing retained legacy origins on reopen without rewriting normalized evidence',async()=>{
        const f=await fixture(),legacy=legacyMailBackupFixture(workspaceId,time),vault=createPrivateVault(f.directory,key);
        await vault.write('mail-workspace',legacy.state);await vault.write(`mail-scan-${legacy.receipt.id}`,legacy.source);
        const a=f.make();expect((await a.service.get()).counts.total).toBe(1);
        const privateDir=join(f.directory,'company-installation','private');for(const name of await readdir(privateDir))await rm(join(privateDir,name));
        const b=f.make(),file=join(f.directory,'workflow-state.sqlite'),before=await readFile(file);
        await expect(b.service.get()).rejects.toMatchObject({status:503});expect(await readFile(file)).toEqual(before);
    });
    it('rolls back an interrupted legacy migration, retries on restart and retains every original private byte', async () => {
        const f = await fixture(), legacy = legacyMailBackupFixture(workspaceId, time), vault = createPrivateVault(f.directory, key);
        await vault.write('mail-workspace', legacy.state);
        await vault.write(`mail-scan-${legacy.receipt.id}`, legacy.source);
        await vault.write('mail-prepared-input', legacy.prepared);
        await privateDirectory(join(f.options.workroomDirectory, 'workflow-inputs'));
        await writePrivateJson(join(f.options.workroomDirectory, 'workflow-inputs', 'accounts-inbox.json'), legacy.input);
        const privateDir = join(f.directory, 'company-installation', 'private'), originals = new Map<string, Buffer>();
        for (const name of await readdir(privateDir))
            originals.set(name, await readFile(join(privateDir, name)));
        const a = f.make(), create = a.db.create.bind(a.db);
        const failure = vi.spyOn(a.db, 'create').mockImplementation((kind, id, value, limit) => { if (kind === 'mail-source')
            throw Object.assign(new Error('Synthetic interrupted migration'), { status: 503 }); return create(kind, id, value, limit); });
        await expect(a.service.get()).rejects.toMatchObject({ status: 503 });
        expect(a.db.hasRecords()).toBe(false);
        failure.mockRestore();
        const b = f.make();
        expect((await b.service.get()).counts.total).toBe(1);
        expect(await b.service.getItem(legacy.item.id)).toEqual(legacy.item);
        expect((await b.service.source(legacy.item.id)).thread).toEqual(legacy.data.threads[0]);
        for (const [name, bytes] of originals)
            expect(await readFile(join(privateDir, name))).toEqual(bytes);
        await vault.write('mail-workspace', { ...legacy.state, revision: legacy.state.revision + 1 });
        const c = f.make();
        await expect(c.service.get()).rejects.toMatchObject({ status: 503 });
        expect(b.db.get('mail-register', mailRecordId('mail-register'))).toBeDefined();
    });
});
