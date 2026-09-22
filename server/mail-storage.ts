import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { decryptJson, isEncryptedEnvelope } from './desk-crypto.ts';
import { privateDirectory, readPrivateJson } from './private-json.ts';
import { WorkflowDatabase, type WorkflowRecord } from './workflow-database.ts';
import { MAIL_RECORD_KINDS, mailRecordId, mailRecovery, validateMailGraph, validateMailRecord, validateLegacyMail, type MailRecordKind, type MailRecord, type MailRegister, type MailOrigin, type MailPrepared, type MailSourceBundle } from './mail-records.ts';
import { mailEvidenceHash as hash, type StoredMailWorkspace } from './mail-workspace-integrity.ts';
import { mailWorkGroup, type MailScanReceipt, type MailWorkItem, type MailWorkspaceMetadata, type MailWorkspaceCounts } from '../shared/mail-ingestion.ts';
type MailStorageOptions = {
    directory: string;
    workspaceId: string;
    key: Buffer;
    workroomDirectory: string;
    database?: WorkflowDatabase | (() => WorkflowDatabase);
};
export class MailStorage {
    private options: MailStorageOptions;
    private selectedDatabase?: WorkflowDatabase;
    get db(): WorkflowDatabase { return this.selectedDatabase ??= (typeof this.options.database === 'function' ? this.options.database() : this.options.database) ?? new WorkflowDatabase({ dir: this.options.directory, key: this.options.key }); }
    private checkedToken?: string;
    private cachedMetadata?: {token:string; value:MailWorkspaceMetadata};
    private pending?: Promise<void>;
    private initialized = false;
    private legacyInspected = false;
    private ownsDatabase: boolean;
    constructor(options: MailStorageOptions) {
        this.options = options;
        this.ownsDatabase = !options.database;
    }
    private legacyFiles = new Map<string, string>();
    private legacy(): Map<string, unknown> {
        const result = new Map<string, unknown>([...this.legacyFiles.keys()].map(name => [name, undefined]));
        const load = (name: string) => {
            const file = this.legacyFiles.get(name);
            if (!file)
                return undefined;
            const stat = lstatSync(file);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 2000000 || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())))
                mailRecovery();
            const data = JSON.parse(readFileSync(file, 'utf8'));
            if (name === 'accounts-inbox-input')
                return data;
            if (!isEncryptedEnvelope(data))
                mailRecovery();
            const decoded = decryptJson(this.options.key, data) as {
                name?: string;
                value?: unknown;
            };
            if (decoded.name !== name)
                mailRecovery();
            return decoded.value;
        };
        result.get = load;
        result[Symbol.iterator] = function* () { for (const name of result.keys())
            yield [name, load(name)] as [
                string,
                unknown
            ]; return undefined; };
        return result;
    }
    async ready() {
        if (this.initialized)
            return;
        return this.pending ??= (async () => {
            try {
                this.legacyFiles.clear();
                const directory = join(this.options.directory, 'company-installation', 'private');
                if (existsSync(directory)) {
                    await privateDirectory(directory);
                    for (const file of await readdir(directory))
                        if (/^mail-.*\.json$/.test(file)) {
                            if (!/^(mail-workspace|mail-prepared-input|mail-scan-[a-f0-9-]{36})\.json$/.test(file))
                                mailRecovery();
                            const path = join(directory, file);
                            await readPrivateJson(path, 2000000);
                            this.legacyFiles.set(file.slice(0, -5), path);
                        }
                }
                if (this.legacyFiles.has('mail-prepared-input')) {
                    const path = join(this.options.workroomDirectory, 'workflow-inputs', 'accounts-inbox.json');
                    if (existsSync(path)) {
                        await readPrivateJson(path, 950000);
                        this.legacyFiles.set('accounts-inbox-input', path);
                    }
                }
                this.legacyInspected = true;
                this.db.transaction(() => {
                    if (!this.db.get('mail-register', mailRecordId('mail-register'))) {
                        if (MAIL_RECORD_KINDS.some(kind => this.db.count(kind)))
                            mailRecovery();
                        if (this.legacyFiles.size) {
                            const legacy = this.legacy();
                            validateLegacyMail(legacy, this.options.workspaceId);
                            const state = legacy.get('mail-workspace') as StoredMailWorkspace;
                            const files: MailOrigin['legacyFiles'] = [];
                            for (const name of legacy.keys())
                                if (name !== 'accounts-inbox-input')
                                    files.push({ name, digest: hash(legacy.get(name)) });
                            files.sort((a, b) => a.name.localeCompare(b.name));
                            const origin: MailOrigin = { version: 1, workspaceId: this.options.workspaceId, legacyDigest: hash(files), legacyFiles: files, ...(legacy.has('mail-prepared-input') ? { legacyPreparedInput: legacy.get('accounts-inbox-input') } : {}) };
                            this.put('mail-origin', mailRecordId('mail-origin'), origin);
                            for (const r of state.receipts)
                                this.put('mail-receipt', mailRecordId('mail-receipt', r.id), r);
                            for (const i of state.items)
                                this.put('mail-item', mailRecordId('mail-item', i.id), i);
                            for (const name of legacy.keys())
                                if (name.startsWith('mail-scan-'))
                                    this.put('mail-source', mailRecordId('mail-source', name.slice(10)), legacy.get(name));
                            if (legacy.has('mail-prepared-input'))
                                this.put('mail-prepared', mailRecordId('mail-prepared'), { ...(legacy.get('mail-prepared-input') as object), input: legacy.get('accounts-inbox-input') });
                            this.put('mail-register', mailRecordId('mail-register'), { version: 2, workspaceId: this.options.workspaceId, revision: state.revision, latestScanId: state.latestScan?.id ?? null, latestReview: state.latestReview, activeScan: null } satisfies MailRegister);
                        }
                    }
                    this.checkedToken = undefined;
                    this.ensure();
                });
                this.initialized = true;
            }
            catch {
                this.pending = undefined;
                mailRecovery();
            }
        })();
    }
    private ensure() {
        const token = this.db.changeToken();
        if (token === this.checkedToken)
            return;
        validateMailGraph({ get: (kind, id) => { const r = this.db.get(kind, id); return r ? { kind, ...r } : undefined; }, iterate: kind => this.records(kind) }, this.options.workspaceId, this.legacyInspected ? this.legacy() : undefined);
        this.checkedToken = this.db.changeToken();
    }
    run<T>(fn: () => T): T { try {
        return this.db.transaction(() => { this.ensure(); const value = fn(); this.checkedToken = this.db.changeToken(); return value; });
    }
    catch (error) {
        this.checkedToken = undefined;
        throw error;
    } }
    *records(kind: MailRecordKind): Iterable<MailRecord> { let before: number | undefined; do {
        const page = this.db.projectPage(kind, { before, limit: 1 }, row => ({ kind, ...row }));
        yield* page.records;
        before = page.next ?? undefined;
    } while (before); }
    get<T>(kind: MailRecordKind, id: string): WorkflowRecord<T> | undefined { const row = this.db.get<T>(kind, id); if (row)
        validateMailRecord(kind, id, row.revision, row.value, this.options.workspaceId); return row; }
    put<T>(kind: MailRecordKind, id: string, value: T) { const old = this.get(kind, id); validateMailRecord(kind, id, (old?.revision ?? 0) + 1, value, this.options.workspaceId); return old ? this.db.update(kind, id, old.revision, () => value) : this.db.create(kind, id, value, null); }
    register(): MailRegister { return this.get<MailRegister>('mail-register', mailRecordId('mail-register'))?.value ?? { version: 2, workspaceId: this.options.workspaceId, revision: 0, latestScanId: null, latestReview: null, activeScan: null }; }
    saveRegister(reg: MailRegister) { if (!this.get('mail-origin', mailRecordId('mail-origin')))
        this.put('mail-origin', mailRecordId('mail-origin'), { version: 1, workspaceId: this.options.workspaceId, legacyDigest: null, legacyFiles: [] } satisfies MailOrigin); reg.revision++; this.put('mail-register', mailRecordId('mail-register'), reg); }
    item(id: string) { return this.get<MailWorkItem>('mail-item', mailRecordId('mail-item', id))?.value; }
    receipt(id: string) { return this.get<MailScanReceipt>('mail-receipt', mailRecordId('mail-receipt', id))?.value; }
    source(id: string) { return this.get<MailSourceBundle>('mail-source', mailRecordId('mail-source', id))?.value; }
    prepared() { return this.get<MailPrepared>('mail-prepared', mailRecordId('mail-prepared'))?.value; }
    saveItem(item: MailWorkItem) { this.put('mail-item', mailRecordId('mail-item', item.id), item); }
    saveReceipt(receipt: MailScanReceipt) { this.put('mail-receipt', mailRecordId('mail-receipt', receipt.id), receipt); }
    metadata(): MailWorkspaceMetadata {
        const token=this.db.changeToken();
        if(this.cachedMetadata?.token===token)return structuredClone(this.cachedMetadata.value);
        const reg = this.register();
        const counts: MailWorkspaceCounts = { total: 0, open: 0, waiting: 0, reference: 0, snoozed: 0, done: 0, highPriority: 0, needsReview: 0 };
        let nextSnoozeAt: number | null = null;
        for (const row of this.records('mail-item')) {
            const item = row.value as MailWorkItem;
            counts.total++;
            counts[mailWorkGroup(item)]++;
            if (item.status === 'open' && item.priority === 'high')
                counts.highPriority++;
            if (item.newEvidence && !item.reviewed)
                counts.needsReview++;
            if (item.status === 'snoozed' && (nextSnoozeAt === null || item.snoozedUntil! < nextSnoozeAt))
                nextSnoozeAt = item.snoozedUntil;
        }
        const value:MailWorkspaceMetadata={ version: 2, revision: reg.revision, latestScan: reg.latestScanId ? this.receipt(reg.latestScanId) ?? mailRecovery() : null, latestReview: reg.latestReview, counts, nextSnoozeAt };
        // Captured while run() owns the transaction, including reads after writes.
        // Rollback and commits from independent handles change this token.
        this.cachedMetadata={token:this.db.changeToken(),value};return structuredClone(value);
    }
    close() { if (this.ownsDatabase)
        this.selectedDatabase?.close(); }
}
