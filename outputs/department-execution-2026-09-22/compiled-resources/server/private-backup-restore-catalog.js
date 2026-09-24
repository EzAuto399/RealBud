import { WEBSITE_REMOTE_WORK_KIND, restoreWebsiteRemoteWork } from "./website-remote-work.js";
import { decodeDeskPlain } from "./desk-v3-decode.js";
import { executionDigest, executionStream } from "./execution-history.js";
import { parseLoopsFile } from "./routine-persistence.js";
import { restoreWorkBatches } from "./batch-persistence.js";
import { REMOTE_EVIDENCE_KIND, restoreRemoteEvidence } from "./website-remote-evidence.js";
import { REMOTE_TEMPLATE_KIND, restoreRemoteTemplate } from "./website-remote-disclosure.js";
import { WEBSITE_REQUEST_KIND, restoreWebsiteRequest } from "./website-requests.js";
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_LOOPS = ['morning-arrears', 'owner-letter', 'inbound-triage'];
const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
function invalid(message = 'The backup could not be prepared safely. Its original catalog is unchanged.', status = 400) {
    throw Object.assign(new Error(message), { status });
}
function increment(value, minimum = 1) {
    if (!Number.isSafeInteger(value) || value < minimum || value >= Number.MAX_SAFE_INTEGER - 1)
        invalid('A saved revision cannot advance safely during restore.');
    return value + 1;
}
function jsonFile(path, value, encoding = 'bytes') {
    const data = Buffer.from(JSON.stringify(value));
    if (data.length > MAX_FILE_BYTES)
        invalid('A restored business file exceeds its existing entity limit.', 413);
    return { path, encoding, data };
}
function parsed(file) {
    const value = JSON.parse(file.data.toString('utf8'));
    if (!object(value))
        return invalid();
    return value;
}
function resetRun(run, at, normalized = false) {
    return ['queued', 'running'].includes(run.status) ? { ...run, status: 'interrupted', finishedAt: at,
        detail: normalized ? 'Interrupted during private workspace restore. Nothing was resumed; review current setup before starting new work.'
            : 'Interrupted by private workspace restore; review before starting new work.' } : run;
}
function sanitizedLoops(file, at) {
    const value = file ? parsed(file) : { version: 3, timezone: 'UTC', state: {}, runs: [] };
    if (!object(value.state) || !Array.isArray(value.runs))
        return invalid();
    const state = {};
    for (const [id, saved] of Object.entries(value.state)) {
        if (!object(saved))
            return invalid();
        state[id] = { ...saved, enabled: false };
    }
    for (const id of DEFAULT_LOOPS)
        state[id] = { ...(object(state[id]) ? state[id] : {}), enabled: false, handledThrough: at };
    return jsonFile('loops.json', { ...value, state, runs: value.runs.map(run => {
            if (!object(run) || typeof run.status !== 'string')
                return invalid();
            return resetRun(run, at);
        }) });
}
function transformFile(file, at) {
    if (file.path === 'work-batches.json') {
        let restored;
        try {
            restored = restoreWorkBatches(JSON.parse(file.data.toString('utf8')), at);
        }
        catch {
            return invalid('Saved portfolio batch history needs recovery; no partial restore was prepared.');
        }
        return jsonFile(file.path, restored, file.encoding);
    }
    if (file.path === 'desk.json') {
        const decoded = decodeDeskPlain(JSON.parse(file.data.toString('utf8')), { properties: [], ledger: [] }, 'UTC'), book = decoded.data;
        book.revision = increment(book.revision);
        book.hands = 'held';
        book.handsDetail = 'Private workspace restored. Reconnect sources and review work before running.';
        if (decoded.version === 3) {
            decoded.data.handoffs = decoded.data.handoffs.map(h => h.usedAt ? h : { ...h, invalidatedAt: at, verification: 'invalidated', authorization: { ...h.authorization, expiresAt: 0 } });
            decoded.data.portalRecipes = decoded.data.portalRecipes.map(recipe => ({ ...recipe, published: false }));
            decoded.data.cases = decoded.data.cases.map(c => ['approved', 'preparing', 'handoff-ready'].includes(c.state) ? { ...c, state: 'held', holdReason: 'workspace-restored', detail: 'Review this saved work again on the restored installation.', updatedAt: at } : c);
        }
        else {
            decoded.data.capabilities = decoded.data.capabilities.map(c => c.usedAt ? c : { ...c, invalidatedAt: at, expiresAt: 0 });
            decoded.data.recipes = decoded.data.recipes.map(recipe => ({ ...recipe, published: false }));
            decoded.data.workItems = decoded.data.workItems.map(w => ['approved', 'preparing', 'handoff-ready'].includes(w.state) ? { ...w, state: 'held', updatedAt: at } : w);
        }
        decodeDeskPlain(book, { properties: [], ledger: [] }, 'UTC');
        return jsonFile(file.path, book, 'json');
    }
    if (file.path === 'agency-setup.json') {
        const value = parsed(file);
        if (!object(value.settings) || typeof value.revision !== 'number')
            return invalid();
        return jsonFile(file.path, { ...value, revision: increment(value.revision), updatedAt: at, settings: { ...value.settings, gmailAccountId: null }, reviews: {} });
    }
    if (file.path === 'recipes.json') {
        const value = JSON.parse(file.data.toString('utf8'));
        const list = Array.isArray(value) ? value : object(value) && Array.isArray(value.recipes) ? value.recipes : invalid();
        return jsonFile(file.path, { recipes: list.map(recipe => {
                if (!object(recipe) || typeof recipe.revision !== 'number')
                    return invalid();
                return { ...recipe, revision: increment(recipe.revision), updatedAt: at, status: 'paused', schedule: null,
                    planApprovedAt: null, approvedRevision: null, attachment: null, submitAcknowledgedAt: null };
            }) });
    }
    if (file.path === 'job-runs.json') {
        const value = JSON.parse(file.data.toString('utf8'));
        const runs = Array.isArray(value) ? value : object(value) && Array.isArray(value.runs) ? value.runs : invalid();
        const transformed = runs.map(run => { if (!object(run) || typeof run.status !== 'string')
            return invalid(); return resetRun(run, at); });
        return jsonFile(file.path, Array.isArray(value) ? { version: 1, runs: transformed } : { ...value, runs: transformed });
    }
    // Includes exact bank/workroom bytes, retained legacy mail and its committed
    // origin-era input, bill metadata, views, instructions and workspace identity.
    return file;
}
function executionRow(row, at) {
    if (!['execution-job', 'execution-loop'].includes(row.kind))
        return row;
    const value = row.value, run = resetRun(value.run, at, true);
    return run === value.run ? row : { ...row, revision: increment(row.revision), value: { ...value, run } };
}
/** Builds only the existing bounded compatibility file, never an array of all
 * retained runs. Each referenced receipt is looked up and released separately. */
function executionProjection(source, row, safeLoops, at) {
    const value = row.value, type = value.stream.startsWith('job:') ? 'job' : 'loop';
    let context;
    if (type === 'loop') {
        const safe = parseLoopsFile(JSON.parse(safeLoops.data.toString('utf8')), 'UTC');
        context = { timezone: safe.timezone, state: safe.state };
        for (const id of DEFAULT_LOOPS)
            context.state[id] ??= { enabled: false, handledThrough: at, revision: 1 };
        for (const clock of Object.values(context.state))
            clock.enabled = false;
    }
    let text = '', size = 0;
    const append = (piece) => {
        size += Buffer.byteLength(piece);
        if (size > MAX_FILE_BYTES)
            invalid('A restored execution projection exceeds its existing file limit. No complete restore was prepared.', 413);
        text += piece;
    };
    const prefix = JSON.stringify(type === 'job' ? { version: 1, executionHistory: 1 } : { version: 3, executionHistory: 1, ...context }, null, 2);
    append(prefix.slice(0, -2));
    append(',\n  "runs": [');
    let count = 0;
    for (const id of value.recentIds) {
        const saved = source.getRecord(`execution-${type}`, `${value.stream}:${executionDigest(id)}`);
        if (!saved)
            return invalid();
        const run = executionRow(saved, at).value.run;
        // Keep formatting identical to the v1 projection whose exact bytes bind
        // the checkpoint. The serialization buffer is bounded by one entity.
        const encoded = JSON.stringify(run, null, 2).replace(/^/gm, '    ');
        append(count++ ? ',\n' : '\n');
        append(encoded);
    }
    if (count)
        append('\n  ');
    append(']\n}');
    if (type === 'job')
        append('\n');
    const file = { path: type === 'job' ? 'job-runs.json' : 'loops.json', encoding: 'bytes', data: Buffer.from(text) };
    return { file, row: { ...row, revision: increment(row.revision), value: { ...value,
                ...(type === 'loop' ? { context } : {}), currentHash: executionDigest(text), previousHash: null } } };
}
/** Run the same bounded transformations for measurement and materialization.
 * No guessed expansion ratio can silently truncate transformed history. */
function visitRestore(source, at, destination) {
    if (!Number.isSafeInteger(at) || at < 0 || at > 8_640_000_000_000_000)
        return invalid('Choose a valid restore timestamp.');
    const original = source.summary();
    if (!original.sealed)
        return invalid('Use a sealed source catalog.');
    source.validate();
    const measured = { entries: 0, files: 0, records: 0, plainBytes: 0, fileBytes: 0, recordBytes: 0, protectedFiles: 0 };
    const addFile = (file) => { destination.addFile(file); measured.files++; measured.fileBytes += file.data.length; if (file.encoding === 'json')
        measured.protectedFiles++; };
    const addRecord = (row) => { destination.addRecord(row); measured.records++; measured.recordBytes += Buffer.byteLength(JSON.stringify(row.value)); };
    const safeLoops = sanitizedLoops(source.getFile('loops.json'), at);
    // Exactly two possible streams, established by the existing source graph.
    const checkpoints = new Map(), projections = new Map([['loops.json', safeLoops]]);
    for (const type of ['job', 'loop']) {
        const stream = executionStream(type, type === 'job' ? 'job-runs.json' : 'loops.json');
        const saved = source.getRecord('execution-state', `execution-state:${stream}`);
        if (!saved)
            continue;
        const transformed = executionProjection(source, saved, safeLoops, at);
        checkpoints.set(saved.id, transformed.row);
        projections.set(transformed.file.path, transformed.file);
    }
    let interruptedMail = false;
    for (const row of source.iterateRecords('mail-receipt'))
        if (row.value.status === 'running')
            interruptedMail = true;
    const addedProjections = new Set();
    for (const file of source.iterateFiles()) {
        const projection = projections.get(file.path);
        addFile(projection ?? transformFile(file, at));
        if (projection)
            addedProjections.add(file.path);
    }
    for (const [path, file] of projections)
        if (!addedProjections.has(path))
            addFile(file);
    for (const sourceRow of source.iterateRecords()) {
        let row = checkpoints.get(sourceRow.id) ?? executionRow(sourceRow, at);
        if (row.kind === REMOTE_EVIDENCE_KIND) {
            row = { ...row, revision: increment(row.revision), value: restoreRemoteEvidence(row.id, row.value) };
        }
        else if (row.kind === REMOTE_TEMPLATE_KIND) {
            row = { ...row, revision: increment(row.revision), value: restoreRemoteTemplate(row.id, row.value) };
        }
        else if (row.kind === WEBSITE_REMOTE_WORK_KIND) {
            row = { ...row, revision: increment(row.revision), value: restoreWebsiteRemoteWork(row.id, row.value, new Date(at).toISOString()) };
        }
        else if (row.kind === WEBSITE_REQUEST_KIND) {
            row = { ...row, revision: increment(row.revision), value: restoreWebsiteRequest(row.id, row.value, new Date(at).toISOString()) };
        }
        else if (row.kind === 'mail-receipt' && row.value.status === 'running') {
            const value = row.value;
            row = { ...row, revision: increment(row.revision), value: { ...value, status: 'interrupted', completedAt: at,
                    gaps: value.gaps.length < 200 ? [...value.gaps, 'Mail collection was interrupted by workspace restore. Run a fresh scan.'] : [...value.gaps] } };
        }
        else if (row.kind === 'mail-register') {
            const value = row.value;
            if (interruptedMail || value.activeScan)
                row = { ...row, revision: increment(row.revision), value: { ...value,
                        workspaceId: source.workspaceId, revision: increment(value.revision, 0), activeScan: null } };
        }
        else if (row.kind === 'handoff') {
            // V1 preserves this row's storage revision while invalidating authority.
            const value = row.value;
            row = { ...row, value: { ...value, state: 'closed', binding: undefined, updatedAt: at,
                    detail: 'Closed during private workspace restore. Sign in again before any attended run.' } };
        }
        addRecord(row);
    }
    const final = source.validate();
    if (final.digest !== original.digest || final.entries !== original.entries || measured.records !== original.records || measured.files !== original.files + projections.size - addedProjections.size)
        return invalid('The restore catalog changed while it was being prepared.');
    measured.entries = measured.files + measured.records;
    measured.plainBytes = measured.fileBytes + measured.recordBytes;
    return measured;
}
/** Exact logical output sizes, with no destination files created. */
export function measurePrivateBackupRestore(options) {
    return visitRestore(options.source, options.at, { addFile() { }, addRecord() { } });
}
export function transformPrivateBackupCatalog(options) {
    const { source, destination, at } = options, target = destination.summary();
    if (target.sealed || target.entries !== 0 || source.catalogId === destination.catalogId || source.directory === destination.directory || source.workspaceId !== destination.workspaceId)
        return invalid('Use a sealed source and an empty separate catalog for the same archived workspace.');
    visitRestore(source, at, destination);
    return destination.seal();
}
