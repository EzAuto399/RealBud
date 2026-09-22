import { isDeepStrictEqual } from 'node:util';
import { validateAgencySettings } from './agency-setup.ts';
import { parseMailScanRequest, parseMailScanResult, type MailScanReceipt, type MailScanRequest, type MailScanResult, type MailWorkItem, type MailWorkspaceSnapshot } from '../shared/mail-ingestion.ts';
import { buildMailSourceInput, mailEvidenceHash as hash, validMailReceipt, validMailWorkItem, validMailWorkspace } from './mail-workspace-integrity.ts';
import type { AgencySetupSettings } from '../shared/agency-setup.ts';
export const MAIL_RECORD_KINDS = ['mail-register', 'mail-item', 'mail-receipt', 'mail-source', 'mail-prepared', 'mail-origin'] as const;
export type MailRecordKind = typeof MAIL_RECORD_KINDS[number];
export interface MailRecord {
    kind: string;
    id: string;
    revision: number;
    value: unknown;
}
export interface MailRegister {
    version: 2;
    workspaceId: string;
    revision: number;
    latestScanId: string | null;
    latestReview: MailWorkspaceSnapshot['latestReview'];
    activeScan: {
        receiptId: string;
        ownerPid: number;
        ownerToken: string;
    } | null;
}
export interface MailSourceBundle {
    version: 1;
    workspaceId: string;
    request: MailScanRequest;
    data: MailScanResult;
    settings: AgencySetupSettings;
}
export interface MailPrepared {
    receiptId: string;
    sourceReference: string;
    digest: string;
    input: ReturnType<typeof buildMailSourceInput> & {
        reviewBatch: {
            selectedThreadCount: number;
            collectedThreadCount: number;
            pendingThreadCount: number;
        };
    };
}
export interface MailOrigin {
    version: 1;
    workspaceId: string;
    legacyDigest: string | null;
    legacyFiles: {
        name: string;
        digest: string;
    }[];
    legacyPreparedInput?: unknown;
}
export const mailRecordId = (kind: MailRecordKind, identity = 'workspace') => `${kind}:${identity}`;
const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9-]{36}$/.test(v);
const time = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
export function mailRecovery(): never { throw Object.assign(new Error('The saved mail workspace needs recovery. Its original data has been preserved.'), { status: 503 }); }
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).sort().join(',') === keys.sort().join(',');
export function validateMailRecord(kind: string, id: string, revision: number, value: unknown, workspaceId: string): void {
    if (!MAIL_RECORD_KINDS.includes(kind as MailRecordKind) || !Number.isSafeInteger(revision) || revision < 1 || !obj(value))
        mailRecovery();
    const max = kind === 'mail-source' ? 1400000 : kind === 'mail-prepared' ? 1000000 : kind === 'mail-origin' ? 1200000 : kind === 'mail-item' ? 1400000 : kind === 'mail-receipt' ? 200000 : 64000;
    if (Buffer.byteLength(JSON.stringify(value)) > max)
        mailRecovery();
    if (kind === 'mail-item') {
        if (id !== mailRecordId('mail-item', value.id) || !validMailWorkItem(value, workspaceId))
            mailRecovery();
        return;
    }
    if (kind === 'mail-receipt') {
        if (id !== mailRecordId('mail-receipt', value.id) || !validMailReceipt(value))
            mailRecovery();
        return;
    }
    if (kind === 'mail-source') {
        if (!uuid(id.slice('mail-source:'.length)) || id !== mailRecordId('mail-source', id.slice('mail-source:'.length)) || value.version !== 1 || value.workspaceId !== workspaceId || !exact(value, ['version', 'workspaceId', 'request', 'data', 'settings']))
            mailRecovery();
        return;
    }
    if (id !== mailRecordId(kind as MailRecordKind))
        mailRecovery();
    if (kind === 'mail-register') {
        if (!exact(value, ['version', 'workspaceId', 'revision', 'latestScanId', 'latestReview', 'activeScan']) || value.version !== 2 || value.workspaceId !== workspaceId || !time(value.revision) || (value.latestScanId !== null && !uuid(value.latestScanId)) ||
            (value.latestReview !== null && (!obj(value.latestReview) || !exact(value.latestReview, ['runId', 'sourceReceiptId', 'at']) || typeof value.latestReview.runId !== 'string' || !value.latestReview.runId || value.latestReview.runId.length > 128 || !uuid(value.latestReview.sourceReceiptId) || !time(value.latestReview.at))) ||
            (value.activeScan !== null && (!obj(value.activeScan) || !exact(value.activeScan, ['receiptId', 'ownerPid', 'ownerToken']) || !uuid(value.activeScan.receiptId) || !Number.isSafeInteger(value.activeScan.ownerPid) || value.activeScan.ownerPid < 1 || !uuid(value.activeScan.ownerToken))))
            mailRecovery();
    }
    else if (kind === 'mail-origin') {
        if (value.version !== 1 || value.workspaceId !== workspaceId || !exact(value, ['version', 'workspaceId', 'legacyDigest', 'legacyFiles', ...(Object.hasOwn(value, 'legacyPreparedInput') ? ['legacyPreparedInput'] : [])]) ||
            (value.legacyDigest !== null && !hex(value.legacyDigest)) || !Array.isArray(value.legacyFiles) || value.legacyFiles.length > 1002 || value.legacyFiles.some((f: unknown) => !obj(f) || !exact(f, ['name', 'digest']) || typeof f.name !== 'string' || !/^(mail-workspace|mail-prepared-input|mail-scan-[a-f0-9-]{36})$/.test(f.name) || !hex(f.digest)) || new Set(value.legacyFiles.map((f: any) => f.name)).size !== value.legacyFiles.length || (value.legacyDigest === null) !== (value.legacyFiles.length === 0) || value.legacyDigest !== null && value.legacyDigest !== hash(value.legacyFiles))
            mailRecovery();
    }
    else if (kind === 'mail-prepared') {
        if (!exact(value, ['receiptId', 'sourceReference', 'digest', 'input']) || !uuid(value.receiptId) || !hex(value.digest) || typeof value.sourceReference !== 'string' || !new RegExp(`^realbud-mail:${value.receiptId}:[a-f0-9]{16}$`).test(value.sourceReference) || !obj(value.input) || hash(value.input) !== value.digest || value.input.sourceReference !== value.sourceReference || Buffer.byteLength(JSON.stringify(value.input)) > 950000)
            mailRecovery();
    }
}
export function validateMailSource(value: unknown, receipt: MailScanReceipt, workspaceId: string): MailSourceBundle {
    try {
        if (!obj(value) || value.version !== 1 || value.workspaceId !== workspaceId || Buffer.byteLength(JSON.stringify(value)) > 1400000)
            mailRecovery();
        const request = parseMailScanRequest(value.request, receipt.windowEndAt), data = parseMailScanResult(value.data, request, receipt.accountId);
        const settings = validateAgencySettings(obj(value.settings) && !Object.hasOwn(value.settings, 'workflowPackId') ? { ...value.settings, workflowPackId: null } : value.settings);
        if (settings.gmailAccountId !== receipt.accountId || request.windowStartAt !== receipt.windowStartAt || request.windowEndAt !== receipt.windowEndAt || request.maxMessages !== settings.mailScope.maxMessages || request.includeSent !== settings.mailScope.includeSent || request.windowEndAt - request.windowStartAt !== settings.mailScope.historyDays * 86400000)
            mailRecovery();
        if (['complete', 'partial'].includes(receipt.status) && (receipt.inputDigest !== hash(buildMailSourceInput(workspaceId, receipt, data, settings)) || receipt.threadCount !== data.threads.length || receipt.messageCount !== data.threads.reduce((n, t) => n + t.messages.length, 0) || receipt.pages !== data.pages || !isDeepStrictEqual(receipt.gaps, data.gaps) || (receipt.status === 'complete') !== (data.paginationComplete && !data.gaps.length)))
            mailRecovery();
        return { version: 1, workspaceId, request, data, settings };
    }
    catch {
        mailRecovery();
    }
}
export function validateMailItemSource(item: MailWorkItem, receipt: MailScanReceipt, source: MailSourceBundle): void {
    const thread = source.data.threads.find(t => t.id === item.threadId);
    if (receipt.accountId !== item.accountId || !thread || hash(thread) !== item.sourceDigest || !isDeepStrictEqual(item.sourceMessageIds, thread.messages.map(m => m.id)))
        mailRecovery();
}
export function validateMailPrepared(value: MailPrepared, receipt: MailScanReceipt, source: MailSourceBundle, workspaceId: string): void {
    const input = value.input, full = buildMailSourceInput(workspaceId, receipt, source.data, source.settings);
    if (!['complete', 'partial'].includes(receipt.status) || !obj(input.reviewBatch) || !Array.isArray(input.threads) || !input.threads.length || input.threads.length > 20 || new Set(input.threads.map(t => t.threadId)).size !== input.threads.length)
        mailRecovery();
    const selected = full.threads.filter(t => input.threads.some(s => s.threadId === t.threadId));
    const expected = { ...full, sourceReference: `realbud-mail:${receipt.id}:${hash(selected).slice(0, 16)}`, threadCount: selected.length, maxThreads: 20, threads: selected,
        reviewBatch: { selectedThreadCount: selected.length, collectedThreadCount: full.threadCount, pendingThreadCount: input.reviewBatch.pendingThreadCount },
        coverage: { ...full.coverage, accounts: full.coverage.accounts.map(a => ({ ...a, expectedThreadCount: selected.length, returnedThreadCount: selected.length })) } };
    if (!Number.isSafeInteger(input.reviewBatch.pendingThreadCount) || input.reviewBatch.pendingThreadCount < selected.length || !isDeepStrictEqual(input, expected) || hash(input) !== value.digest)
        mailRecovery();
}
export interface MailGraphReader {
    get(kind: MailRecordKind, id: string): MailRecord | undefined;
    iterate(kind: MailRecordKind): Iterable<MailRecord>;
}
/** Iterates encrypted heads one at a time; a task only resolves its own source bundle. */
export function validateMailGraph(reader: MailGraphReader, workspaceId: string, legacy?: Map<string, unknown>): void {
    const singleton = (kind: MailRecordKind) => reader.get(kind, mailRecordId(kind));
    let count = 0;
    for (const kind of MAIL_RECORD_KINDS)
        for (const row of reader.iterate(kind)) {
            validateMailRecord(kind, row.id, row.revision, row.value, workspaceId);
            count++;
        }
    if (!count) {
        if (legacy && [...legacy.keys()].some(name => name !== 'accounts-inbox-input'))
            validateLegacyMail(legacy, workspaceId);
        return;
    }
    const reg = singleton('mail-register')?.value as MailRegister | undefined, origin = singleton('mail-origin')?.value as MailOrigin | undefined;
    if (!reg || !origin)
        mailRecovery();
    for (const kind of ['mail-register', 'mail-origin', 'mail-prepared'] as const)
        if ([...reader.iterate(kind)].length > (kind === 'mail-prepared' ? 1 : 1))
            mailRecovery();
    const receipt = (id: string) => reader.get('mail-receipt', mailRecordId('mail-receipt', id))?.value as MailScanReceipt | undefined;
    // A task group commonly shares one bounded scan. Retain at most this one
    // decoded bundle, rather than reparse it for every task or cache all sources.
    let cachedSource: {id:string; value:MailSourceBundle|undefined}|undefined;
    const source = (id: string, r: MailScanReceipt) => {
        if(cachedSource?.id===id)return cachedSource.value;
        const row=reader.get('mail-source',mailRecordId('mail-source',id));
        const value=row?validateMailSource(row.value,r,workspaceId):undefined;
        cachedSource={id,value};return value;
    };
    if (reg.latestScanId && !receipt(reg.latestScanId) || reg.latestReview && !receipt(reg.latestReview.sourceReceiptId))
        mailRecovery();
    if (reg.activeScan && (receipt(reg.activeScan.receiptId)?.status !== 'running' || reg.latestScanId !== reg.activeScan.receiptId))
        mailRecovery();
    let running = 0;
    for (const row of reader.iterate('mail-receipt')) {
        const r = row.value as MailScanReceipt;
        if (r.status === 'running')
            running++;
        if (['complete', 'partial'].includes(r.status)) {
            const s = source(r.id, r);
            if (!s)
                mailRecovery();
            for (const t of s.data.threads)
                if (!reader.get('mail-item', mailRecordId('mail-item', hash([workspaceId, r.accountId, t.id]))))
                    mailRecovery();
        }
    }
    if (running > 1 || running && (!reg.latestScanId || receipt(reg.latestScanId)?.status !== 'running') || !running && reg.activeScan)
        mailRecovery();
    for (const row of reader.iterate('mail-source')) {
        const id = row.id.slice('mail-source:'.length), r = receipt(id);
        if (!r)
            mailRecovery();
        validateMailSource(row.value, r, workspaceId);
    }
    for (const row of reader.iterate('mail-item')) {
        const i = row.value as MailWorkItem, r = receipt(i.sourceReceiptId);
        if (!r)
            mailRecovery();
        const s = source(i.sourceReceiptId, r);
        if (!s)
            mailRecovery();
        validateMailItemSource(i, r, s);
    }
    const p = singleton('mail-prepared')?.value as MailPrepared | undefined;
    if (p) {
        const r = receipt(p.receiptId);
        if (!r)
            mailRecovery();
        const s = source(p.receiptId, r);
        if (!s)
            mailRecovery();
        validateMailPrepared(p, r, s, workspaceId);
        let retained = 0;
        for (const item of reader.iterate('mail-item'))
            if ((item.value as MailWorkItem).accountId === r.accountId)
                retained++;
        if (p.input.reviewBatch.pendingThreadCount > retained)
            mailRecovery();
    }
    if (legacy) {
        const files: MailOrigin['legacyFiles'] = [];
        for (const name of legacy.keys())
            if (name !== 'accounts-inbox-input')
                files.push({ name, digest: hash(legacy.get(name)) });
        files.sort((a, b) => a.name.localeCompare(b.name));
        if (!isDeepStrictEqual(files, origin.legacyFiles))
            mailRecovery();
        if (files.length) {
            const saved = new Map<string, unknown>();
            for (const name of legacy.keys())
                saved.set(name, undefined);
            if (origin.legacyPreparedInput !== undefined)
                saved.set('accounts-inbox-input', undefined);
            saved.get = (name: string) => name === 'accounts-inbox-input' && origin.legacyPreparedInput !== undefined ? origin.legacyPreparedInput : legacy.get(name);
            validateLegacyMail(saved, workspaceId);
            const old = saved.get('mail-workspace') as import('./mail-workspace-integrity.ts').StoredMailWorkspace;
            for (const item of old.items) {
                const current = reader.get('mail-item', mailRecordId('mail-item', item.id))?.value as MailWorkItem | undefined;
                if (!current || current.revision < item.revision || current.firstSeenAt !== item.firstSeenAt || current.accountId !== item.accountId || current.threadId !== item.threadId || (current.revision === item.revision && !isDeepStrictEqual(current, item)))
                    mailRecovery();
            }
            for (const prior of old.receipts) {
                const current = receipt(prior.id);
                if (!current)
                    mailRecovery();
                if (prior.status !== 'running' && !isDeepStrictEqual(current, prior))
                    mailRecovery();
                if (prior.status === 'running' && (current.accountId !== prior.accountId || current.bindingRevision !== prior.bindingRevision || current.startedAt !== prior.startedAt || current.windowStartAt !== prior.windowStartAt || current.windowEndAt !== prior.windowEndAt))
                    mailRecovery();
            }
            for (const name of saved.keys())
                if (name.startsWith('mail-scan-')) {
                    const current = reader.get('mail-source', mailRecordId('mail-source', name.slice(10)));
                    if (!current || !isDeepStrictEqual(current.value, saved.get(name)))
                        mailRecovery();
                }
        }
    }
}
export function validateLegacyMail(saved: Map<string, unknown>, workspaceId: string): void {
    const state = saved.get('mail-workspace');
    if (!validMailWorkspace(state, workspaceId))
        mailRecovery();
    const receipts = new Map(state.receipts.map(r => [r.id, r]));
    let cachedSource: {id:string; value:MailSourceBundle|undefined}|undefined;
    const source = (id: string) => {
        if(cachedSource?.id===id)return cachedSource.value;
        const raw=saved.get(`mail-scan-${id}`),r=receipts.get(id);
        const value=raw!==undefined&&r?validateMailSource(raw,r,workspaceId):undefined;
        cachedSource={id,value};return value;
    };
    for (const name of saved.keys())
        if (name.startsWith('mail-scan-')) {
            const id = name.slice(10);
            if (!receipts.has(id))
                mailRecovery();
            source(id);
        }
        else if (!['mail-workspace', 'mail-prepared-input', 'accounts-inbox-input'].includes(name))
            mailRecovery();
    for (const r of receipts.values())
        if (['complete', 'partial'].includes(r.status) && !source(r.id))
            mailRecovery();
    for (const i of state.items) {
        const r = receipts.get(i.sourceReceiptId), s = source(i.sourceReceiptId);
        if (!r || !s)
            mailRecovery();
        validateMailItemSource(i, r, s);
    }
    const raw = saved.get('mail-prepared-input');
    if (raw !== undefined) {
        if (!obj(raw) || !exact(raw, ['receiptId', 'sourceReference', 'digest']))
            mailRecovery();
        const p = { ...raw, input: saved.get('accounts-inbox-input') } as MailPrepared;
        validateMailRecord('mail-prepared', mailRecordId('mail-prepared'), 1, p, workspaceId);
        const r = receipts.get(p.receiptId), s = source(p.receiptId);
        if (!r || !s)
            mailRecovery();
        validateMailPrepared(p, r, s, workspaceId);
    }
}
export function validateMailRecords(records: MailRecord[], legacy: Map<string, unknown>, workspaceId: string): void {
    const rows = records.filter(r => MAIL_RECORD_KINDS.includes(r.kind as MailRecordKind));
    const ids = new Set<string>();
    for (const r of rows) {
        if (ids.has(r.id))
            mailRecovery();
        ids.add(r.id);
    }
    const index = new Map(rows.map(r => [`${r.kind}/${r.id}`, r]));
    const kinds = new Map(MAIL_RECORD_KINDS.map(kind => [kind, rows.filter(r => r.kind === kind)]));
    validateMailGraph({ get: (kind, id) => index.get(`${kind}/${id}`), iterate: kind => kinds.get(kind)! }, workspaceId, legacy);
}
export function interruptMailRecordsForRestore(records: MailRecord[], workspaceId: string, at: number): MailRecord[] {
    if (!time(at))
        mailRecovery();
    let changed = false;
    const rows = records.map(r => { if (r.kind !== 'mail-receipt' || (r.value as MailScanReceipt).status !== 'running')
        return r; changed = true; return { ...r, revision: r.revision + 1, value: { ...(r.value as MailScanReceipt), status: 'interrupted', completedAt: at, gaps: (r.value as MailScanReceipt).gaps.length < 200 ? [...(r.value as MailScanReceipt).gaps, 'Mail collection was interrupted by workspace restore. Run a fresh scan.'] : [...(r.value as MailScanReceipt).gaps] } }; });
    return rows.map(r => r.kind === 'mail-register' && (changed || (r.value as MailRegister).activeScan) ? { ...r, revision: r.revision + 1, value: { ...(r.value as MailRegister), workspaceId, revision: (r.value as MailRegister).revision + 1, activeScan: null } } : r);
}
