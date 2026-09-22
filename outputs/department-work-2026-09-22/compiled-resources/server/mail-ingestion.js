import { randomUUID } from 'node:crypto';
import { mailEvidenceHash as hash, validMailReceipt as validReceipt, validMailWorkItem, buildMailSourceInput } from "./mail-workspace-integrity.js";
import { join } from 'node:path';
import { MailStorage } from "./mail-storage.js";
import { mailRecordId, mailRecovery, validateMailSource, validateMailItemSource, validateMailPrepared } from "./mail-records.js";
import { mailWorkGroup } from "../shared/mail-ingestion.js";
import { privateDirectory, writePrivateJson } from "./private-json.js";
import { parseMailScanRequest, parseMailScanResult } from "../shared/mail-ingestion.js";
import { captureAccountsReview, validateAccountsReview } from "./accounts-review.js";
import { getRecipe } from "./recipes.js";
import { workflowRecipeId } from "../shared/agency-workflow-packs.js";
export const MORNING_MAIL_RECIPE = 'wf-austin-accounts-inbox-triage';
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
function fail(message, status = 409) { throw Object.assign(new Error(message), { status }); }
/** A fresh complete fetch must prove that the last message is still outgoing.
 * Count office calendar dates, not 24-hour durations (including across DST).
 * The key is stable after the due date, until the outgoing message or rule changes. */
function dueFollowUpKey(thread, receipt, settings) {
    if (!thread || receipt.status !== 'complete' || !settings.mailScope.includeSent || !thread.historyComplete ||
        thread.messages.some(message => message.direction === 'unknown' || message.bodyTruncated))
        return null;
    const latest = thread.messages.at(-1);
    if (latest.direction !== 'outgoing' || thread.messages.at(-2)?.at === latest.at)
        return null;
    const date = new Intl.DateTimeFormat('en-US', { timeZone: settings.timeZone, year: 'numeric', month: 'numeric', day: 'numeric' });
    const ordinal = (at) => {
        const parts = Object.fromEntries(date.formatToParts(at).map(part => [part.type, part.value]));
        return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / 86400000;
    };
    if (ordinal(receipt.windowEndAt) - ordinal(latest.at) < settings.morningReview.followUpAfterDays)
        return null;
    return hash(['mail-follow-up-v1', receipt.accountId, receipt.bindingRevision, thread.id, latest.id, latest.at,
        settings.timeZone, settings.morningReview.followUpAfterDays]);
}
/** Individual encrypted heads share the workflow transaction boundary. A durable
 * owner fences acquisition across services; a live PID is never timed out. */
export function createMailIngestionService(options) {
    const storage = new MailStorage(options), now = options.now ?? Date.now;
    let serial = Promise.resolve(), active = null, closed = false;
    let activeSettled = Promise.resolve();
    const locked = (fn) => {
        const run = serial.then(async () => {
            if (closed)
                fail('The mail service is closed.', 503);
            await storage.ready();
            return fn();
        });
        serial = run.catch(() => { });
        return run;
    };
    const itemId = (accountId, threadId) => hash([options.workspaceId, accountId, threadId]);
    const validItem = (i) => validMailWorkItem(i, options.workspaceId);
    const sourceInput = (r, data, settings) => buildMailSourceInput(options.workspaceId, r, data, settings);
    function ownerAlive(reg) {
        if (!reg.activeScan)
            return false;
        try {
            process.kill(reg.activeScan.ownerPid, 0);
            return true;
        }
        catch (error) {
            return error.code !== 'ESRCH';
        }
    }
    function recover() {
        const reg = storage.register(), time = now();
        let changed = false;
        // Cached metadata avoids rereading every head when no snooze is due.
        const nextSnoozeAt = storage.metadata().nextSnoozeAt;
        // The one-record iterator releases its SQL reader before each update.
        if (nextSnoozeAt !== null && nextSnoozeAt <= time)
            for (const row of storage.records('mail-item')) {
                const item = row.value;
                if (item.status === 'snoozed' && item.snoozedUntil <= time) {
                    storage.saveItem({ ...item, status: 'open', snoozedUntil: null, revision: item.revision + 1, updatedAt: time });
                    changed = true;
                }
            }
        if (reg.latestScanId) {
            const r = storage.receipt(reg.latestScanId);
            if (r.status === 'running' && !ownerAlive(reg)) {
                storage.saveReceipt({ ...r, status: 'interrupted', completedAt: time, gaps: r.gaps.length < 200 ? [...r.gaps, 'Mail collection was interrupted. Run a fresh scan; the prior work list is preserved.'] : [...r.gaps] });
                reg.activeScan = null;
                changed = true;
            }
        }
        if (changed)
            storage.saveRegister(reg);
    }
    const read = () => storage.run(() => { recover(); return storage.metadata(); });
    async function collect(purpose = 'morning-priorities') {
        if (closed)
            fail('The mail service is closed.', 503);
        if (active)
            fail('A mail scan is already running. Wait for its receipt.');
        const controller = new AbortController(), ownerToken = randomUUID();
        active = controller;
        let settled;
        activeSettled = new Promise(resolve => { settled = resolve; });
        let receipt;
        try {
            const authority = await options.authorize(purpose);
            controller.signal.throwIfAborted();
            const admission = await locked(() => storage.run(() => {
                recover();
                const reg = storage.register();
                if (reg.activeScan)
                    fail('A mail scan is already running. Wait for its receipt.');
                const carry = [];
                let carryCount = 0;
                for (const row of storage.records('mail-item')) {
                    const item = row.value;
                    if (item.accountId === authority.accountId && item.status !== 'done' && !['reference', 'noise'].includes(item.disposition)) {
                        carryCount++;
                        if (carry.length < 100)
                            carry.push(item.threadId);
                    }
                }
                const end = now(), request = { windowStartAt: end - authority.settings.mailScope.historyDays * 86400000, windowEndAt: end, maxMessages: authority.settings.mailScope.maxMessages, includeSent: authority.settings.mailScope.includeSent, carryThreadIds: carry };
                parseMailScanRequest(request, end);
                receipt = { id: randomUUID(), accountId: authority.accountId, bindingRevision: authority.bindingRevision, startedAt: end, completedAt: null, windowStartAt: request.windowStartAt, windowEndAt: end, status: 'running', messageCount: 0, threadCount: 0, pages: 0, gaps: [], inputDigest: null };
                storage.saveReceipt(receipt);
                reg.latestScanId = receipt.id;
                reg.activeScan = { receiptId: receipt.id, ownerPid: process.pid, ownerToken };
                storage.saveRegister(reg);
                return { request, carryCount };
            }));
            const data = parseMailScanResult(await options.scan(authority, admission.request, controller.signal), admission.request, authority.accountId);
            controller.signal.throwIfAborted();
            const currentAuthority = await options.authorize(purpose);
            controller.signal.throwIfAborted();
            if (currentAuthority.accountId !== authority.accountId || currentAuthority.bindingRevision !== authority.bindingRevision || currentAuthority.settingsRevision !== authority.settingsRevision)
                fail('Mail setup changed during collection. The previous work list is preserved.');
            if (admission.carryCount > 100)
                data.gaps = [...data.gaps.slice(0, 199), 'More unresolved conversations exist than this scan can carry; review or narrow the saved work list.'];
            const complete = { ...receipt, status: data.paginationComplete && !data.gaps.length ? 'complete' : 'partial', completedAt: now(), pages: data.pages, gaps: data.gaps, threadCount: data.threads.length, messageCount: data.threads.reduce((n, t) => n + t.messages.length, 0) };
            complete.inputDigest = hash(sourceInput(complete, data, authority.settings));
            const sourceBundle = { version: 1, workspaceId: options.workspaceId, request: admission.request, data, settings: authority.settings };
            if (Buffer.byteLength(JSON.stringify(sourceBundle)) > 1400000)
                fail('The collected source exceeds private storage limits. Narrow the scope and repeat the scan.', 413);
            // A failed final projection retains the acquired source as evidence of the attempt.
            await locked(() => storage.run(() => { assertOwner(); storage.put('mail-source', mailRecordId('mail-source', receipt.id), sourceBundle); storage.saveRegister(storage.register()); }));
            return await locked(() => storage.run(() => {
                controller.signal.throwIfAborted();
                assertOwner();
                for (const t of data.threads) {
                    const id = itemId(authority.accountId, t.id), previous = storage.item(id), digest = hash(t);
                    if (previous?.sourceDigest === digest)
                        continue;
                    let substantive = !previous;
                    if (previous) {
                        const priorReceipt = storage.receipt(previous.sourceReceiptId), old = storage.source(previous.sourceReceiptId);
                        if (!old || !priorReceipt)
                            mailRecovery();
                        const previousSource = validateMailSource(old, priorReceipt, options.workspaceId);
                        validateMailItemSource(previous, priorReceipt, previousSource);
                        const oldThread = previousSource.data.threads.find(row => row.id === t.id);
                        substantive = t.messages.some(m => {
                            const before = oldThread.messages.find(row => row.id === m.id);
                            if (!before)
                                return true;
                            if (m.bodyTruncated && before.body.startsWith(m.body))
                                return false;
                            return hash(m) !== hash(before);
                        });
                        if (!substantive && (!t.historyComplete || t.messages.length < oldThread.messages.length || t.messages.some(m => m.bodyTruncated)))
                            continue;
                    }
                    const latest = t.messages.at(-1);
                    const next = previous ? { ...previous, revision: previous.revision + 1, sourceMessageIds: t.messages.map(m => m.id), sourceDigest: digest, sourceReceiptId: complete.id, subject: latest.subject, newEvidence: previous.newEvidence || substantive, status: substantive ? 'open' : previous.status, snoozedUntil: substantive ? null : previous.snoozedUntil, updatedAt: now(), lastMessageAt: latest.at } : { id, revision: 1, accountId: authority.accountId, threadId: t.id, sourceMessageIds: t.messages.map(m => m.id), sourceDigest: digest, sourceReceiptId: complete.id, subject: latest.subject, disposition: 'hold', priority: 'normal', owner: 'unassigned', reason: 'New conversation collected; its meaning has not been reviewed.', nextAction: 'Review the source or ask Bud to prepare the morning list.', missingFacts: [], status: 'open', snoozedUntil: null, note: '', reviewed: false, newEvidence: true, firstSeenAt: now(), updatedAt: now(), lastMessageAt: latest.at };
                    storage.saveItem(next);
                }
                controller.signal.throwIfAborted();
                storage.saveReceipt(complete);
                const reg = storage.register();
                reg.activeScan = null;
                storage.saveRegister(reg);
                recover();
                return storage.metadata();
            }));
            function assertOwner() {
                const reg = storage.register();
                if (reg.activeScan?.receiptId !== receipt?.id || reg.activeScan?.ownerToken !== ownerToken || storage.receipt(receipt.id)?.status !== 'running')
                    fail('The mail collection owner changed. Its evidence was preserved.');
            }
        }
        catch (error) {
            if (receipt)
                await locked(() => storage.run(() => {
                    const reg = storage.register(), failed = storage.receipt(receipt.id);
                    if (failed?.status === 'running' && reg.activeScan?.ownerToken === ownerToken) {
                        storage.saveReceipt({ ...failed, status: controller.signal.aborted ? 'interrupted' : 'failed', completedAt: now(), gaps: failed.gaps.length < 200 ? [...failed.gaps, controller.signal.aborted ? 'Mail collection was stopped because its access or setup changed.' : 'Mail collection could not be confirmed. Check source access and try a fresh scan.'] : [...failed.gaps] });
                        reg.activeScan = null;
                        storage.saveRegister(reg);
                    }
                }));
            throw error;
        }
        finally {
            active = null;
            settled();
        }
    }
    async function prepareInput() {
        const authority = await options.authorize('morning-priorities');
        const prepared = await locked(() => storage.run(() => {
            recover();
            const state = storage.metadata(), receipt = state.latestScan;
            if (!receipt || !['complete', 'partial'].includes(receipt.status) || receipt.accountId !== authority.accountId || receipt.bindingRevision !== authority.bindingRevision || now() - receipt.startedAt > 12 * 60 * 60000)
                fail('Collect a fresh scan for the reviewed Gmail source before preparing this list.');
            const raw = storage.source(receipt.id);
            if (!raw)
                mailRecovery();
            const source = validateMailSource(raw, receipt, options.workspaceId), fullInput = sourceInput(receipt, source.data, source.settings);
            if (hash(source.settings) !== hash(authority.settings))
                fail('Mail settings changed. Collect a fresh scan before preparing this list.');
            let pendingCount = 0;
            const pending = new Set();
            for (const row of storage.records('mail-item')) {
                const item = row.value;
                const thread = source.data.threads.find(t => t.id === item.threadId);
                const followUp = item.status === 'open' && item.disposition === 'waiting' && thread && hash(thread) === item.sourceDigest
                    ? dueFollowUpKey(thread, receipt, source.settings) : null;
                if (item.accountId === authority.accountId && (item.newEvidence && !item.reviewed || followUp !== null && followUp !== item.followUpReviewedKey)) {
                    pendingCount++;
                    if (fullInput.threads.some(t => t.threadId === item.threadId))
                        pending.add(item.threadId);
                }
            }
            const threads = fullInput.threads.filter(t => pending.has(String(t.threadId))).slice(0, 20);
            if (!threads.length)
                return null;
            const reference = `realbud-mail:${receipt.id}:${hash(threads).slice(0, 16)}`, input = { ...fullInput, sourceReference: reference, threadCount: threads.length, maxThreads: 20, threads, reviewBatch: { selectedThreadCount: threads.length, collectedThreadCount: fullInput.threadCount, pendingThreadCount: pendingCount }, coverage: { ...fullInput.coverage, accounts: fullInput.coverage.accounts.map(a => ({ ...a, expectedThreadCount: threads.length, returnedThreadCount: threads.length })) } };
            if (Buffer.byteLength(JSON.stringify(input)) > 950000)
                fail('The collected evidence exceeds the preparation size. Narrow the source scope before review.', 413);
            return { receipt, revision: state.revision, binding: { receiptId: receipt.id, sourceReference: reference, digest: hash(input), input } };
        }));
        if (!prepared)
            return null;
        const directory = join(options.workroomDirectory, 'workflow-inputs');
        await privateDirectory(directory);
        await writePrivateJson(join(directory, 'accounts-inbox.json'), prepared.binding.input);
        // Authorization may observe this service. Never await it inside the serial lock.
        const current = await options.authorize('morning-priorities');
        if (current.accountId !== authority.accountId || current.bindingRevision !== authority.bindingRevision || current.settingsRevision !== authority.settingsRevision)
            fail('Mail setup changed during preparation. Prepare the current source again.');
        return locked(() => storage.run(() => {
            const reg = storage.register();
            if (reg.revision !== prepared.revision)
                fail('Mail work changed during preparation. Prepare the current source again.');
            storage.put('mail-prepared', mailRecordId('mail-prepared'), prepared.binding);
            storage.saveRegister(reg);
            return { ...prepared.receipt, batchThreadCount: prepared.binding.input.threads.length };
        }));
    }
    async function applyReview(run) {
        const authority = await options.authorize('morning-priorities'), recipeId = workflowRecipeId(authority.settings.workflowPackId, 'inbox-triage');
        if (!recipeId || run.jobId !== recipeId || !['completed', 'awaiting-approval'].includes(run.status))
            fail('Only a validated review from the selected morning workflow can update this list.');
        return locked(() => storage.run(() => {
            const reg = storage.register(), receipt = reg.latestScanId ? storage.receipt(reg.latestScanId) : undefined;
            if (reg.latestReview?.runId === run.id)
                return storage.metadata();
            if (!receipt || !['complete', 'partial'].includes(receipt.status) || receipt.accountId !== authority.accountId || receipt.bindingRevision !== authority.bindingRevision)
                fail('This review no longer matches the selected source.');
            const raw = run.evidence.filter(e => e.kind === 'output').flatMap(e => {
                try {
                    const r = JSON.parse(e.note);
                    return object(r) && r.kind === 'accounts-inbox-triage' ? [r] : [];
                }
                catch {
                    return [];
                }
            }), prepared = storage.prepared();
            if (!prepared || prepared.receiptId !== receipt.id || raw.length !== 1 || raw[0].sourceReference !== prepared.sourceReference)
                fail('The prepared list does not match the current mail evidence.');
            const source = storage.source(receipt.id);
            if (!source)
                mailRecovery();
            if (hash(source.settings) !== hash(authority.settings) || now() - receipt.startedAt > 12 * 60 * 60000)
                fail('Mail settings or source freshness changed. Collect and prepare the current source again.');
            validateMailPrepared(prepared, receipt, validateMailSource(source, receipt, options.workspaceId), options.workspaceId);
            const recipe = getRecipe(recipeId);
            if (!recipe)
                fail('The morning workflow plan is unavailable.');
            const binding = captureAccountsReview(recipe, options.workroomDirectory);
            if (!binding)
                fail('The morning source binding is unavailable.');
            if (hash(binding.input) !== prepared.digest)
                fail('The source projection changed after collection.');
            try {
                validateAccountsReview({ summary: 'Morning list', outputs: [JSON.stringify(raw[0])], evidence: [], needsApproval: [] }, binding);
            }
            catch {
                fail('The prepared review failed validation. Its source and prior task decisions were preserved.', 400);
            }
            const review = raw[0];
            for (const row of review.threads) {
                const item = storage.item(itemId(authority.accountId, row.threadId));
                if (!item)
                    fail('A reviewed conversation is missing from the saved list.');
                const thread = source.data.threads.find(t => t.id === item.threadId);
                const followUp = thread && hash(thread) === item.sourceDigest ? dueFollowUpKey(thread, receipt, source.settings) : null;
                // Staff fields remain authoritative. A due follow-up can produce a
                // source-bound review job without replacing their task decisions.
                if (item.reviewed) {
                    if (item.status === 'open' && item.disposition === 'waiting' && followUp !== null && followUp !== item.followUpReviewedKey)
                        storage.saveItem({ ...item, followUpReviewedKey: followUp, revision: item.revision + 1, updatedAt: now() });
                    continue;
                }
                storage.saveItem({ ...item, disposition: row.disposition, priority: row.priority, owner: row.owner, reason: row.reason, nextAction: row.nextAction, missingFacts: row.missingFacts, newEvidence: false,
                    ...(followUp !== null ? { followUpReviewedKey: followUp } : {}), revision: item.revision + 1, updatedAt: now() });
            }
            reg.latestReview = { runId: run.id, sourceReceiptId: receipt.id, at: now() };
            storage.saveRegister(reg);
            return storage.metadata();
        }));
    }
    async function update(id, body) {
        if (!object(body) || Object.keys(body).some(k => !['expectedRevision', 'status', 'snoozedUntil', 'priority', 'owner', 'note', 'disposition', 'nextAction'].includes(k)))
            fail('Choose the saved task revision and the fields to update.', 400);
        return locked(() => {
            storage.run(recover);
            return storage.run(() => {
                const item = storage.item(id);
                if (!item)
                    fail('That mail task is unavailable.', 404);
                if (body.expectedRevision !== item.revision)
                    fail('This task changed. Refresh it before saving.');
                const next = { ...item, ...Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'expectedRevision')), reviewed: true, newEvidence: false, updatedAt: now(), revision: item.revision + 1 };
                if (next.status !== 'snoozed')
                    next.snoozedUntil = null;
                if (!validItem(next) || next.status === 'snoozed' && (next.snoozedUntil <= now() || next.snoozedUntil > now() + 365 * 86400000))
                    fail('Check the task fields and choose a future snooze time.', 400);
                storage.saveItem(next);
                storage.saveRegister(storage.register());
                return { workspace: storage.metadata(), item: next };
            });
        });
    }
    const compare = (a, b) => ({ high: 0, normal: 1, low: 2 }[a.priority] - { high: 0, normal: 1, low: 2 }[b.priority]) || b.lastMessageAt - a.lastMessageAt || a.id.localeCompare(b.id);
    function cursor(value) {
        if (value === undefined)
            return undefined;
        try {
            if (!/^[A-Za-z0-9_-]{1,2000}$/.test(value))
                throw 0;
            const decoded = JSON.parse(Buffer.from(value, 'base64url').toString());
            if (Buffer.from(JSON.stringify(decoded)).toString('base64url') !== value)
                throw 0;
            return decoded;
        }
        catch {
            fail('This mail page is invalid. Refresh the work list.', 400);
        }
    }
    function limit(n) {
        if (n !== undefined && (!Number.isSafeInteger(n) || n < 1 || n > 100))
            fail('Choose between 1 and 100 mail records.', 400);
        return n ?? 20;
    }
    async function page(query = {}) {
        const size = limit(query.limit), group = query.group ?? 'open', q = typeof query.q === 'string' ? query.q.trim() : query.q === undefined ? '' : fail('Choose a valid mail search.', 400);
        if (!['all', 'open', 'waiting', 'reference', 'snoozed', 'done'].includes(group) || typeof q !== 'string' || q.length > 200 || /[\u0000-\u001f\u007f]/.test(q) || Object.keys(query).some(k => !['group', 'q', 'limit', 'cursor'].includes(k)))
            fail('Choose a valid mail view and search.', 400);
        const c = cursor(query.cursor);
        return locked(() => storage.run(() => {
            recover();
            const meta = storage.metadata();
            if (c && (c.version !== 1 || c.kind !== 'mail-items' || c.revision !== meta.revision || c.group !== group || c.q !== q || (!object(c.after) || Object.keys(c.after).sort().join(',') !== 'id,lastMessageAt,priority' || !['high', 'normal', 'low'].includes(c.after.priority) || typeof c.after.id !== 'string' || !/^[a-f0-9]{64}$/.test(c.after.id) || !Number.isSafeInteger(c.after.lastMessageAt) || c.after.lastMessageAt < 0) || Object.keys(c).sort().join(',') !== 'after,group,kind,q,revision,version'))
                fail('The mail list changed. Refresh it before loading more.');
            const selected = [];
            let total = 0;
            const needle = q.toLocaleLowerCase();
            for (const row of storage.records('mail-item')) {
                const i = row.value;
                if (group !== 'all' && mailWorkGroup(i) !== group || needle && ![i.subject, i.owner, i.note, i.reason, i.nextAction, i.threadId, ...i.missingFacts].join(' ').toLocaleLowerCase().includes(needle))
                    continue;
                total++;
                if (c && compare(i, c.after) <= 0)
                    continue;
                let at = selected.findIndex(other => compare(i, other) < 0);
                if (at < 0)
                    at = selected.length;
                if (at <= size) {
                    selected.splice(at, 0, i);
                    if (selected.length > size + 1)
                        selected.pop();
                }
            }
            const more = selected.length > size, items = selected.slice(0, size), last = items.at(-1);
            return { version: 2, revision: meta.revision, counts: meta.counts, group, q, items, total, nextCursor: more && last ? Buffer.from(JSON.stringify({ version: 1, kind: 'mail-items', revision: meta.revision, group, q, after: { id: last.id, priority: last.priority, lastMessageAt: last.lastMessageAt } })).toString('base64url') : null };
        }));
    }
    async function scanHistory(query = {}) {
        const size = limit(query.limit), c = cursor(query.cursor);
        if (Object.keys(query).some(k => !['limit', 'cursor'].includes(k)))
            fail('Choose a valid scan history page.', 400);
        return locked(() => storage.run(() => {
            recover();
            const reg = storage.register();
            if (c && (c.version !== 1 || c.kind !== 'mail-scans' || c.revision !== reg.revision || !Number.isSafeInteger(c.before) || c.before < 1 || Object.keys(c).sort().join(',') !== 'before,kind,revision,version'))
                fail('The mail list changed. Refresh it before loading more.');
            const p = storage.db.projectPage('mail-receipt', { limit: size, before: c?.before }, r => { validReceipt(r.value) || mailRecovery(); return r.value; });
            return { version: 2, revision: reg.revision, items: p.records, total: storage.db.count('mail-receipt'), nextCursor: p.next ? Buffer.from(JSON.stringify({ version: 1, kind: 'mail-scans', revision: reg.revision, before: p.next })).toString('base64url') : null };
        }));
    }
    return {
        get epoch() { return storage.run(() => storage.register().revision); },
        get busy() { return active !== null || storage.run(() => ownerAlive(storage.register())); },
        collect, prepareInput, applyReview, update, page, scanHistory,
        cancel: () => active?.abort(), get: () => locked(read),
        getItem: (id) => locked(() => storage.run(() => { recover(); return storage.item(id) ?? fail('That mail task is unavailable.', 404); })),
        getLegacySnapshot: () => locked(() => storage.run(() => { recover(); const meta = storage.metadata(); return { version: 1, revision: meta.revision, latestScan: meta.latestScan, latestReview: meta.latestReview, items: [...storage.records('mail-item')].map(r => r.value).sort(compare) }; })),
        source: (id) => locked(() => storage.run(() => {
            const item = storage.item(id);
            if (!item)
                fail('That source is unavailable.', 404);
            try {
                const receipt = storage.receipt(item.sourceReceiptId), saved = storage.source(item.sourceReceiptId);
                if (!receipt || !saved)
                    mailRecovery();
                const source = validateMailSource(saved, receipt, options.workspaceId);
                validateMailItemSource(item, receipt, source);
                return { accountId: item.accountId, receiptId: item.sourceReceiptId, thread: source.data.threads.find(t => t.id === item.threadId) };
            }
            catch {
                fail('The saved mail source needs recovery. Its original data has been preserved.', 503);
            }
        })),
        async close() { active?.abort(); await activeSettled; await serial; closed = true; storage.close(); },
    };
}
