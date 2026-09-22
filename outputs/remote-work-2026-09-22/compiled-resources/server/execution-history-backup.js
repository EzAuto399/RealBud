import { executionDigest, executionStream, executionRecovery, validateExecutionRecord } from "./execution-history.js";
import { parseJobRun } from "./job-run-validation.js";
import { parseLoopsFile } from "./routine-persistence.js";
const streams = new Map(['job', 'loop'].map(type => [executionStream(type, type === 'job' ? 'job-runs.json' : 'loops.json'), type]));
export const jobHistoryBinding = (run) => executionDigest(JSON.stringify([run.jobId, run.jobRevision, run.mode, run.trigger, run.scheduledFor, run.loopRunId ?? null, [run.spec.title, run.spec.description, run.spec.steps, run.spec.allowedOrigins, run.spec.evidence, run.spec.capabilities, run.spec.limits.maxRuntimeMinutes, run.spec.limits.maxTurns]]));
export const loopHistoryBinding = (run) => executionDigest(JSON.stringify([run.loopId, run.loopRevision ?? null, run.manual, run.scheduledFor]));
const runBinding = (type, run) => type === 'job' ? jobHistoryBinding(run) : loopHistoryBinding(run);
const requestKey = (type, run) => type === 'job' ? run.idempotencyKey : run.requestId;
export function parseHistoryLoopRun(value) {
    try {
        return parseLoopsFile({ version: 3, timezone: 'UTC', state: {}, runs: [value] }, 'UTC').runs[0] ?? null;
    }
    catch {
        return null;
    }
}
function parsedRun(type, value) {
    const run = type === 'job' ? parseJobRun(value) : parseHistoryLoopRun(value);
    if (!run)
        throw executionRecovery();
    return run;
}
const rowId = (stream, id) => `${stream}:${executionDigest(id)}`;
const keyId = (stream, key) => `request:${stream}:${executionDigest(key)}`;
export function validateExecutionGraph(reader, files) {
    const states = new Map();
    for (const kind of ['execution-state', 'execution-request', 'execution-job', 'execution-loop']) {
        for (const row of reader.iterate(kind)) {
            if (row.kind !== kind || !Number.isSafeInteger(row.revision) || row.revision < 1)
                throw executionRecovery();
            validateExecutionRecord(row.kind, row.value);
            const value = row.value;
            const type = streams.get(value.stream);
            if (!type)
                throw executionRecovery();
            if (row.kind === 'execution-state') {
                if (row.id !== `execution-state:${value.stream}` || states.has(value.stream))
                    throw executionRecovery();
                if (type === 'job' && value.context !== null)
                    throw executionRecovery();
                if (type === 'loop')
                    parseLoopsFile({ version: 3, ...value.context, runs: [] }, 'UTC');
                const content = files[type === 'job' ? 'job-runs.json' : 'loops.json'];
                if (![value.currentHash, value.previousHash].includes(executionDigest(content ?? 'absent')))
                    throw executionRecovery();
                if (content !== undefined) {
                    if (type === 'loop')
                        parseLoopsFile(JSON.parse(content), 'UTC');
                    else {
                        const parsed = JSON.parse(content), runs = Array.isArray(parsed) ? parsed : parsed.runs;
                        if (!Array.isArray(runs) || runs.some(run => !parseJobRun(run)))
                            throw executionRecovery();
                    }
                }
                states.set(value.stream, value);
            }
            else if (row.kind === 'execution-request') {
                if (row.id !== keyId(value.stream, value.key))
                    throw executionRecovery();
            }
            else {
                const run = parsedRun(type, value.run);
                if (row.kind !== `execution-${type}` || row.id !== rowId(value.stream, run.id) || value.binding !== runBinding(type, run))
                    throw executionRecovery();
            }
        }
    }
    const receipt = (stream, id) => {
        const type = streams.get(stream);
        if (!type)
            throw executionRecovery();
        return reader.get(`execution-${type}`, rowId(stream, id))?.value;
    };
    for (const [stream, type] of streams) {
        const content = files[type === 'job' ? 'job-runs.json' : 'loops.json'];
        if (content !== undefined) {
            const parsed = JSON.parse(content);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'executionHistory' in parsed && (parsed.executionHistory !== 1 || !states.has(stream)))
                throw executionRecovery();
        }
    }
    for (const [stream, state] of states)
        for (const id of state.recentIds)
            if (!receipt(stream, id))
                throw executionRecovery();
    for (const kind of ['execution-job', 'execution-loop'])
        for (const row of reader.iterate(kind)) {
            const value = row.value;
            const state = states.get(value.stream), type = streams.get(value.stream);
            if (!state || ['queued', 'running'].includes(value.run.status) && !state.recentIds.includes(value.run.id))
                throw executionRecovery();
            const key = requestKey(type, value.run);
            const request = key ? reader.get('execution-request', keyId(value.stream, key))?.value : undefined;
            if (key && (!request || request.binding !== value.binding || request.runId !== value.run.id))
                throw executionRecovery();
        }
    for (const row of reader.iterate('execution-request')) {
        const value = row.value;
        const saved = receipt(value.stream, value.runId);
        if (!saved || saved.binding !== value.binding || requestKey(streams.get(value.stream), saved.run) !== value.key)
            throw executionRecovery();
    }
}
/** The unchanged v1 array entry point delegates to the same graph rules. */
export function validateExecutionRecords(rows, files) {
    const index = new Map();
    for (const row of rows) {
        if (!row.kind.startsWith('execution-'))
            continue;
        if (index.has(row.id))
            throw executionRecovery();
        // Validate unknown execution kinds too, before the bounded iterator filters.
        validateExecutionRecord(row.kind, row.value);
        index.set(row.id, row);
    }
    validateExecutionGraph({
        get: (kind, id) => { const row = index.get(id); return row?.kind === kind ? row : undefined; },
        iterate: function* (kind) { for (const row of index.values())
            if (row.kind === kind)
                yield row; },
    }, files);
}
/** Returns transformed logical rows and compatibility files together. Preserve
 * original request bindings; unfinished work is interrupted and clocks are off. */
export function restoreExecutionRecords(rows, originalFiles, sanitizedFiles, at) {
    validateExecutionRecords(rows, originalFiles);
    const records = structuredClone(rows), files = { ...sanitizedFiles };
    const byId = new Map(records.map(row => [row.id, row]));
    for (const row of records)
        if (row.kind === 'execution-job' || row.kind === 'execution-loop') {
            const value = row.value;
            if (['queued', 'running'].includes(value.run.status)) {
                value.run.status = 'interrupted';
                value.run.finishedAt = at;
                value.run.detail = 'Interrupted during private workspace restore. Nothing was resumed; review current setup before starting new work.';
                row.revision++;
            }
        }
    for (const row of records)
        if (row.kind === 'execution-state') {
            const value = row.value;
            const type = streams.get(value.stream);
            const runs = value.recentIds.map(id => byId.get(rowId(value.stream, id)).value.run);
            const filename = type === 'job' ? 'job-runs.json' : 'loops.json';
            if (type === 'job')
                files[filename] = `${JSON.stringify({ version: 1, executionHistory: 1, runs }, null, 2)}\n`;
            else {
                const safeFile = sanitizedFiles[filename];
                const parsed = safeFile ? parseLoopsFile(JSON.parse(safeFile), 'UTC') : parseLoopsFile({ version: 3, ...value.context, runs: [] }, 'UTC');
                const context = { timezone: parsed.timezone, state: parsed.state };
                for (const id of ['morning-arrears', 'owner-letter', 'inbound-triage'])
                    context.state[id] ??= { enabled: false, handledThrough: at, revision: 1 };
                for (const clock of Object.values(context.state))
                    clock.enabled = false;
                value.context = context;
                files[filename] = JSON.stringify({ version: 3, executionHistory: 1, ...context, runs }, null, 2);
            }
            value.currentHash = executionDigest(files[filename]);
            value.previousHash = null;
            row.revision++;
        }
    validateExecutionRecords(records, files);
    return { records, files };
}
