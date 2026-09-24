/** Host-side lifetime of backup writers and their journal-owned files.
 * Every writer/reader of an allocation runs inside run() and registers its
 * handles before awaiting more work. No browser input supplies a path. */
import { createPrivateBackupResources } from "./private-backup-resources.js";
function fail(message, status = 409) { throw Object.assign(new Error(message), { status }); }
const terminal = new Set(['cancelled', 'expired', 'completed']);
// A full/unwritable journal can prevent persisting a failed-close PID hold.
// Reconstructing a runtime in this same process must still preserve its files.
const failedClosesInThisProcess = new Set();
export function createBackupResourceRuntime(options) {
    const active = new Map(), cleanup = new Map(), undrained = new Set();
    let closing = false;
    const journal = options.journal;
    const resources = createPrivateBackupResources({ directory: options.directory, key: options.key, assertCurrent(binding, action) {
            const current = journal.resourceBinding(binding.operationId, binding.allocation.id, action);
            if (JSON.stringify(current) !== JSON.stringify(binding))
                fail('Backup resource ownership changed. Its files were preserved.');
            if (action === 'remove' && (active.has(binding.operationId) || undrained.has(binding.operationId) || failedClosesInThisProcess.has(binding.operationId)))
                fail('Backup work has not finished closing. Its storage remains reserved.');
        } });
    async function clean(id, roles) {
        const work = active.get(id);
        work?.controller.abort();
        await work?.done.catch(() => { });
        if (undrained.has(id) || failedClosesInThisProcess.has(id))
            fail('Backup work could not close. Restart to recover its retained storage.', 503);
        let record = roles ? journal.get(id) : journal.getCleanupRecord(id);
        if (!roles && !terminal.has(record.operation.phase))
            fail('Close the backup operation before releasing its storage.');
        for (const allocation of record.allocations ?? []) {
            if (allocation.state === 'removed' || roles && !roles.includes(allocation.role))
                continue;
            record = journal.beginResourceCleanup(id, record.revision, allocation.id);
            const binding = journal.resourceBinding(id, allocation.id, 'remove');
            await resources.remove(binding);
            // A failure or process exit before either journal update retains the
            // allocation and reservation. The next cleanup replays missing files.
            record = journal.finishResourceCleanup(id, record.revision, allocation.id);
        }
        if (!roles)
            journal.releaseCleanedReservation(id, record.revision);
    }
    function cleanOnce(id) {
        const existing = cleanup.get(id);
        if (existing)
            return existing;
        const promise = Promise.resolve().then(() => clean(id)).finally(() => { cleanup.delete(id); });
        cleanup.set(id, promise);
        return promise;
    }
    return {
        busy(id) { return active.has(id) || cleanup.has(id); },
        run(id, task) {
            if (closing || active.has(id) || cleanup.has(id) || undrained.has(id) || failedClosesInThisProcess.has(id))
                return Promise.reject(Object.assign(new Error('This backup operation is busy or needs recovery.'), { status: 409 }));
            const record = journal.get(id);
            if (terminal.has(record.operation.phase))
                return Promise.reject(Object.assign(new Error('This backup operation is closed.'), { status: 409 }));
            if (!record.allocations)
                return Promise.reject(Object.assign(new Error('This older backup operation has no tracked resource ownership.'), { status: 409 }));
            if (record.cleanupHold)
                return Promise.reject(Object.assign(new Error('This backup operation requires process-exit recovery.'), { status: 409 }));
            const controller = new AbortController(), handles = [], claims = new Set();
            let draining = false;
            const check = () => {
                controller.signal.throwIfAborted();
                if (draining)
                    fail('Backup handles are closing.');
                if (terminal.has(journal.get(id).operation.phase))
                    fail('This backup operation is closed.');
            };
            const context = {
                signal: controller.signal,
                own(close) { if (draining || typeof close !== 'function')
                    fail('Register backup handles before draining.'); handles.push(close); },
                claim(role, bytes) {
                    const claim = (async () => {
                        check();
                        let current = journal.get(id), allocation = current.allocations?.find(a => a.role === role && a.state !== 'removed');
                        if (!allocation) {
                            current = journal.allocate(id, current.revision, { role, bytes });
                            allocation = current.allocations.find(a => a.role === role && a.state !== 'removed');
                        }
                        if (allocation.bytes !== bytes)
                            fail('The backup allocation capacity changed.');
                        const binding = journal.resourceBinding(id, allocation.id, 'claim'), claimed = await resources.claim(binding);
                        check();
                        return { binding, ...claimed };
                    })();
                    claims.add(claim);
                    void claim.finally(() => { claims.delete(claim); }).catch(() => { });
                    return claim;
                },
                async access(role) {
                    check();
                    const allocation = journal.get(id).allocations?.find(a => a.role === role && a.state === 'allocated');
                    if (!allocation)
                        fail('This backup resource was not found.', 404);
                    const binding = journal.resourceBinding(id, allocation.id, 'read'), inspected = await resources.inspect(binding);
                    check();
                    if (!inspected.claimed || !inspected.dataPresent || inspected.exceedsAllocation)
                        fail('Backup resource ownership or capacity needs recovery.', 503);
                    return resources.path(binding);
                },
                path(role) {
                    check();
                    const allocation = journal.get(id).allocations?.find(a => a.role === role && a.state === 'allocated');
                    if (!allocation)
                        fail('This backup resource was not found.', 404);
                    return resources.path(journal.resourceBinding(id, allocation.id, 'read'));
                },
            };
            const done = Promise.resolve().then(async () => {
                check();
                const result = await task(context);
                while (claims.size)
                    await Promise.all([...claims]);
                controller.signal.throwIfAborted();
                return result;
            }).catch(error => { controller.abort(); throw error; }).finally(async () => {
                draining = true;
                await Promise.allSettled([...claims]);
                let closeFailed = false;
                for (const close of handles.reverse()) {
                    try {
                        await close();
                    }
                    catch {
                        closeFailed = true;
                    }
                }
                if (closeFailed) {
                    undrained.add(id);
                    failedClosesInThisProcess.add(id);
                    journal.holdResourceCleanup(id, journal.get(id).revision);
                    fail('Backup handles could not close. Its files and reservation were retained.', 503);
                }
            }).finally(() => { active.delete(id); });
            active.set(id, { controller, done });
            return done;
        },
        /** Discard selected provisional resources after all work has closed. The
         * reservation remains charged and every removed allocation stays recorded. */
        async discard(id, roles) {
            if (closing || active.has(id) || cleanup.has(id))
                fail('Finish current backup work before discarding scratch files.');
            const record = journal.get(id);
            const allowed = record.operation.phase === 'reviewed' ? ['prepared', 'build'] :
                ['failed', 'interrupted'].includes(record.operation.phase) ? (record.operation.kind === 'export' ? ['capture', 'archive'] : ['decoded', 'preview', 'prepared', 'build']) : [];
            if (record.restoreHeld || !roles.length || roles.some(role => !allowed.includes(role)))
                fail('These backup resources must be retained for recovery.');
            const promise = Promise.resolve().then(() => clean(id, roles)).finally(() => { cleanup.delete(id); });
            cleanup.set(id, promise);
            await promise;
        },
        /** Save cancellation before signalling writers; repeated requests join the
         * same drain/cleanup and never release a second reservation. */
        async cancel(id) {
            if (closing)
                fail('Backup storage is closing.');
            const record = journal.get(id);
            if (record.operation.phase !== 'cancelled') {
                if (!record.operation.canCancel || record.restoreHeld)
                    fail('This restore must retain its files for recovery.');
                journal.update(id, record.revision, next => {
                    next.operation.phase = 'cancelled';
                    next.operation.canCancel = false;
                    next.operation.requiresPassphrase = false;
                    delete next.operation.artifact;
                    delete next.operation.preview;
                    delete next.operation.error;
                });
            }
            active.get(id)?.controller.abort();
            await cleanup.get(id);
            await cleanOnce(id);
            return journal.get(id);
        },
        /** Internal startup cleanup only. Resumable current-workspace uploads and
         * uncertain restores are retained; foreign non-held work is retired first. */
        async recover() {
            if (closing || active.size || cleanup.size)
                fail('Finish current backup work before recovery.');
            journal.retireForeign();
            let after, cleaned = 0, held = 0;
            do {
                const page = journal.cleanupCandidates({ limit: 20, after });
                for (const record of page.items) {
                    if (!terminal.has(record.operation.phase))
                        continue;
                    if (!record.allocations) {
                        held++;
                        continue;
                    }
                    try {
                        await cleanOnce(record.operation.id);
                        cleaned++;
                    }
                    catch {
                        // A per-operation ownership/file/close hold must not stop unrelated
                        // cleanup. Recheck journal authority so structural/global failures
                        // are not silently downgraded to an individual hold.
                        journal.usage();
                        held++;
                    }
                }
                after = page.next ?? undefined;
            } while (after);
            return { cleaned, held };
        },
        async close() {
            closing = true;
            for (const work of active.values())
                work.controller.abort();
            await Promise.allSettled([...active.values()].map(work => work.done));
            await Promise.allSettled([...cleanup.values()]);
            await resources.close();
            if (undrained.size)
                fail('Backup handles need restart recovery. Their reservations were retained.', 503);
        },
    };
}
