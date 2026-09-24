import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { WorkflowDatabase, workflowConflict } from "./workflow-database.js";
export const executionDigest = (value) => createHash('sha256').update(value).digest('hex');
export const executionStream = (type, filename) => `${type}:${executionDigest(basename(filename))}`;
export const executionRecovery = () => Object.assign(new Error('Execution history needs recovery. Saved receipts are preserved and work is paused.'), { status: 503 });
const record = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const executionFileHash = (file) => {
    try {
        return executionDigest(readFileSync(file, 'utf8'));
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return executionDigest('absent');
        throw executionRecovery();
    }
};
export function validateExecutionRecord(kind, value) {
    if (!record(value) || value.version !== 1 || typeof value.stream !== 'string' || !/^(job|loop):[a-f0-9]{64}$/.test(value.stream))
        throw executionRecovery();
    if (kind === 'execution-state') {
        if (!digest(value.currentHash) || value.previousHash !== null && !digest(value.previousHash) || !Array.isArray(value.recentIds) || value.recentIds.some(id => typeof id !== 'string' || !id || id.length > 300) || new Set(value.recentIds).size !== value.recentIds.length || !('context' in value))
            throw executionRecovery();
    }
    else if (kind === 'execution-request') {
        if (typeof value.key !== 'string' || !value.key || value.key.length > 300 || typeof value.runId !== 'string' || !value.runId || !digest(value.binding))
            throw executionRecovery();
    }
    else if (kind === `execution-${value.stream.split(':')[0]}`) {
        if (!record(value.run) || typeof value.run.id !== 'string' || !value.run.id || !digest(value.binding))
            throw executionRecovery();
    }
    else
        throw executionRecovery();
}
/** SQLite is authoritative. JSON is a bounded compatibility projection. A
 * committed intent precedes the projection and any dispatch. Only the known
 * before/after projection hashes may reconcile after an interrupted write. */
export class ExecutionHistory {
    database;
    ownDatabase;
    stream;
    kind;
    stateId;
    checkpoint;
    fileHash;
    known = new Map();
    closed = false;
    options;
    constructor(options) {
        this.options = options;
        this.stream = executionStream(options.type, options.file);
        this.kind = `execution-${options.type}`;
        this.stateId = `execution-state:${this.stream}`;
        this.ownDatabase = !options.database;
        this.fileHash = executionFileHash(options.file);
        if (options.expectedFileHash !== undefined && options.expectedFileHash !== this.fileHash)
            throw executionRecovery();
        this.database = options.database ?? new WorkflowDatabase({ dir: dirname(options.file) });
    }
    runId(id) { return `${this.stream}:${executionDigest(id)}`; }
    requestId(key) { return `request:${this.stream}:${executionDigest(key)}`; }
    decode(row) {
        validateExecutionRecord(this.kind, row.value);
        const run = this.options.parse(row.value.run);
        if (!run || row.value.stream !== this.stream || row.id !== this.runId(run.id) || row.value.binding !== this.options.binding(run))
            throw executionRecovery();
        return structuredClone(run);
    }
    load(legacy, context) {
        this.checkpoint = this.database.transaction(() => {
            const saved = this.database.get('execution-state', this.stateId);
            if (saved) {
                validateExecutionRecord('execution-state', saved.value);
                if (saved.value.stream !== this.stream || ![saved.value.currentHash, saved.value.previousHash].includes(this.fileHash))
                    throw executionRecovery();
                return saved;
            }
            if (this.options.requireExisting)
                throw executionRecovery();
            if (this.database.page(this.kind, { prefix: `${this.stream}:`, limit: 1 }).records.length)
                throw executionRecovery();
            if (!legacy.length)
                return { id: this.stateId, revision: 0, value: { version: 1, stream: this.stream, currentHash: this.fileHash, previousHash: null, recentIds: [], context } };
            for (const run of legacy)
                this.saveRun(run);
            if (executionFileHash(this.options.file) !== this.fileHash)
                throw executionRecovery();
            return this.database.create('execution-state', this.stateId, { version: 1, stream: this.stream, currentHash: this.fileHash, previousHash: null, recentIds: legacy.map(r => r.id), context }, null);
        });
        const runs = this.checkpoint.value.recentIds.map(id => { const run = this.get(id); if (!run)
            throw executionRecovery(); return run; });
        for (const run of runs)
            this.known.set(run.id, JSON.stringify(run));
        return { runs, context: structuredClone(this.checkpoint.value.context) };
    }
    saveRun(run) {
        if (!this.options.parse(run))
            throw executionRecovery();
        const id = this.runId(run.id), binding = this.options.binding(run);
        const old = this.database.get(this.kind, id);
        if (old && (this.decode(old).id !== run.id || old.value.binding !== binding))
            throw executionRecovery();
        const key = this.options.requestKey(run);
        if (key) {
            const request = this.database.create('execution-request', this.requestId(key), { version: 1, stream: this.stream, key, runId: run.id, binding }, null);
            validateExecutionRecord('execution-request', request.value);
            if (request.value.stream !== this.stream || request.value.key !== key || request.value.runId !== run.id || request.value.binding !== binding)
                throw workflowConflict();
        }
        const value = { version: 1, stream: this.stream, run, binding };
        if (old) {
            if (JSON.stringify(old.value) !== JSON.stringify(value))
                this.database.update(this.kind, id, old.revision, () => value);
        }
        else
            this.database.create(this.kind, id, value, null);
    }
    save(runs, context, contents, writeProjection) {
        if (executionFileHash(this.options.file) !== this.fileHash)
            throw executionRecovery();
        this.checkpoint = this.database.transaction(() => {
            const current = this.database.get('execution-state', this.stateId);
            if ((current?.revision ?? 0) !== this.checkpoint.revision)
                throw workflowConflict();
            for (const run of runs)
                if (this.known.get(run.id) !== JSON.stringify(run))
                    this.saveRun(run);
            const value = { version: 1, stream: this.stream, currentHash: executionDigest(contents), previousHash: this.fileHash, recentIds: runs.map(r => r.id), context };
            return current ? this.database.update('execution-state', this.stateId, current.revision, () => value) : this.database.create('execution-state', this.stateId, value, null);
        });
        writeProjection();
        this.known = new Map(runs.map(run => [run.id, JSON.stringify(run)]));
        this.fileHash = executionDigest(contents);
    }
    get(id) {
        const row = this.database.get(this.kind, this.runId(id));
        return row ? this.decode(row) : undefined;
    }
    byRequest(key) {
        const row = this.database.get('execution-request', this.requestId(key));
        if (!row)
            return undefined;
        validateExecutionRecord('execution-request', row.value);
        const run = this.get(row.value.runId);
        if (!run || row.value.key !== key || row.value.stream !== this.stream || row.value.binding !== this.options.binding(run) || this.options.requestKey(run) !== key)
            throw executionRecovery();
        return run;
    }
    page(query = {}) {
        const limit = query.limit ?? 50;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || query.subjectId !== undefined && (typeof query.subjectId !== 'string' || !query.subjectId || query.subjectId.length > 300))
            throw Object.assign(new Error('Choose a valid history page.'), { status: 400 });
        let before;
        if (query.cursor) {
            try {
                if (query.cursor.length > 1000)
                    throw new Error();
                const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
                if (cursor.stream !== this.stream || cursor.subject !== (query.subjectId ?? null) || !Number.isSafeInteger(cursor.before) || cursor.before < 1)
                    throw new Error();
                before = cursor.before;
            }
            catch {
                throw Object.assign(new Error('This history page is invalid. Start from the latest activity.'), { status: 400 });
            }
        }
        // Bounded scan per page, even for a sparse subject. Empty pages may have a
        // continuation; callers must use nextCursor rather than infer end from size.
        const page = this.database.page(this.kind, { before, limit, prefix: `${this.stream}:` });
        return { runs: page.records.map(row => this.decode(row)).filter(run => !query.subjectId || this.options.subject(run) === query.subjectId), nextCursor: page.next === null ? null : Buffer.from(JSON.stringify({ stream: this.stream, subject: query.subjectId ?? null, before: page.next })).toString('base64url') };
    }
    close() { if (!this.closed && this.ownDatabase)
        this.database.close(); this.closed = true; }
}
