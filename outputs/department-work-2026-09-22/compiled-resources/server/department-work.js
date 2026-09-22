/** Durable one-time preparation of an assigned case through the existing job
 * ledger. Company authority, worker authority and factual results stay distinct. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { companyExecutionUuid, isCompanyExecutionGrant, isCompanyExecutionGrantPage, isConfirmCompanyExecution, isRevokeCompanyExecution } from "../shared/company-execution.js";
import { isDepartmentWorkPrepare } from "../shared/department-work.js";
import { createDepartmentExecutionContext } from "./department-execution-context.js";
import { assertDepartmentWorkRecipe, departmentWorkRecipe } from "./department-work-plan.js";
import { manualRecipeRequestKey } from "./manual-job-request.js";
export const DEPARTMENT_WORK_KIND = 'department-work';
const key = (id) => `${DEPARTMENT_WORK_KIND}:${id}`;
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
function fail(message = 'Department preparation changed. Refresh the case and review its saved request.', status = 409) { throw Object.assign(new Error(message), { status, code: 'department_work_held' }); }
const operationId = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const text = (v, max) => typeof v === 'string' && v.length <= max && !v.includes('\0');
export function validateSavedDepartmentWork(id, value) {
    if (!object(value) || Object.keys(value).sort().join(',') !== 'companyId,delivery,detail,executionId,grant,jobKey,memberId,phase,recipe,request,restored,runId,updatedAt,version' || value.version !== 1 || !companyExecutionUuid(value.companyId) || !companyExecutionUuid(value.memberId) || !isDepartmentWorkPrepare(value.request) || id !== key(value.request.requestId) || !operationId(value.executionId) || !object(value.recipe) || !['requesting', 'waiting-owner', 'admitting', 'running', 'review-required', 'held'].includes(String(value.phase)) || typeof value.phase !== 'string' || !text(value.detail, 4000) || (value.runId !== null && !text(value.runId, 128)) || !Number.isSafeInteger(value.updatedAt) || Number(value.updatedAt) < 0 || typeof value.restored !== 'boolean')
        fail('The saved department request needs storage recovery.', 503);
    const s = value;
    assertDepartmentWorkRecipe(s.recipe);
    if (Object.keys(s.recipe).sort().join(',') !== 'digest,id,instructionDigest,review,revision' || s.recipe.id !== s.request.recipeId || s.recipe.revision !== s.request.expectedRecipeRevision || s.jobKey !== manualRecipeRequestKey({ id: s.recipe.id, revision: s.recipe.revision }, { requestId: s.executionId, expectedRevision: s.recipe.revision }, 'prepare'))
        fail('The saved department plan identity needs recovery.', 503);
    if (s.grant !== null && (!isCompanyExecutionGrant(s.grant) || s.grant.id !== s.request.requestId || s.grant.spec.companyId !== s.companyId || s.grant.spec.memberId !== s.memberId || s.grant.spec.departmentId !== s.request.departmentId || s.grant.spec.caseId !== s.request.caseId || s.grant.spec.caseFence !== s.request.expectedCaseFence || s.grant.spec.departmentRevision !== s.request.expectedDepartmentRevision || !isDeepStrictEqual(s.grant.spec.recipe, s.recipe)))
        fail('The saved department grant needs recovery.', 503);
    if (s.delivery !== null && (!object(s.delivery) || Object.keys(s.delivery).sort().join(',') !== 'note,outcome,requestId,runId' || !operationId(s.delivery.requestId) || !text(s.delivery.runId, 128) || !s.delivery.runId || !['prepared', 'interrupted', 'failed'].includes(s.delivery.outcome) || !text(s.delivery.note, 2048)))
        fail('The saved department result needs recovery.', 503);
}
export function restoreDepartmentWork(id, value) {
    validateSavedDepartmentWork(id, value);
    return { ...structuredClone(value), restored: true, phase: 'held', detail: 'Restored department history. Rejoin the office and request a fresh owner review before starting new work.' };
}
export function createDepartmentWork(options) {
    const now = options.now ?? Date.now;
    let stopped = false, timer, ticking = null;
    let scanCursor = 0;
    const queued = [];
    const flights = new Map();
    const active = new Map();
    const context = createDepartmentExecutionContext({ current: binding => {
            const live = active.get(binding.grantId);
            return !!live && live.executionId === binding.executionId && !live.abort.signal.aborted && !stopped;
        }, check: async (binding) => { await checked(binding.grantId); } });
    function read(id) {
        if (!operationId(id))
            fail('Invalid department request identity.', 400);
        const r = options.db.get(DEPARTMENT_WORK_KIND, key(id));
        if (r)
            validateSavedDepartmentWork(r.id, r.value);
        return r;
    }
    function requireSaved(id) { return read(id) ?? fail('The saved preparation is unavailable on this instance.', 404); }
    function update(id, patch) {
        const row = requireSaved(id);
        return options.db.update(DEPARTMENT_WORK_KIND, row.id, row.revision, v => {
            const next = { ...v, ...patch, updatedAt: now() };
            validateSavedDepartmentWork(row.id, next);
            return next;
        }).value;
    }
    function rows() {
        const result = [];
        let before;
        do {
            const p = options.db.page(DEPARTMENT_WORK_KIND, { before, limit: 100 });
            for (const row of p.records) {
                validateSavedDepartmentWork(row.id, row.value);
                result.push(row);
            }
            if (result.length > 1000)
                fail('Department preparation history needs recovery.', 503);
            before = p.next ?? undefined;
        } while (before);
        return result;
    }
    function state(s) {
        const run = s.runId ? options.findJob(s.jobKey) : undefined;
        return { grantId: s.request.requestId, executionId: s.executionId, caseId: s.request.caseId, request: structuredClone(s.request), phase: s.phase, detail: s.detail, runId: s.runId, updatedAt: s.updatedAt,
            result: run && run.id === s.runId ? { status: run.status, detail: run.detail.slice(0, 4000), outputs: run.evidence.filter(e => e.kind === 'output').map(e => e.note) } : null };
    }
    async function rpc(session, path, body) {
        const reply = await options.forward(session, path, body);
        if (reply.status !== 200)
            fail('The office could not confirm this action. Keep the saved request and check the connection.', [400, 401, 403, 404, 409, 422].includes(reply.status) ? reply.status : 503);
        return reply.body;
    }
    async function member(session) {
        const me = await rpc(session, '/api/company/me');
        if (!object(me) || !object(me.company) || !object(me.member) || !companyExecutionUuid(me.company.id) || !companyExecutionUuid(me.member.id) || !['owner', 'member'].includes(String(me.member.role)))
            fail('Sign in to this office before preparing department work.', 401);
        return { companyId: me.company.id, memberId: me.member.id, role: me.member.role };
    }
    async function departmentAccess(session, departmentId) {
        const page = await rpc(session, '/api/company/departments/cases', { departmentId, offset: 0, filter: 'all' });
        if (!object(page) || !object(page.department) || page.department.id !== departmentId || !['read', 'write'].includes(String(page.department.access)))
            fail('Current department access is required to view preparation plans and history.', 403);
    }
    async function resolved(s, id) {
        const epoch = options.epoch();
        options.assertAdmission();
        const recipe = options.recipes().find(r => r.id === (s?.recipe.id ?? id));
        if (!recipe)
            fail('The reviewed workflow is no longer installed.');
        await options.assertRecipeReady(recipe.id);
        const instructions = await options.instructions(recipe.id);
        options.assertAdmission();
        if (options.epoch() !== epoch)
            fail('Workflow settings changed during the permission check.');
        const current = options.recipes().find(r => r.id === recipe.id);
        if (!current)
            fail();
        const plan = departmentWorkRecipe(current, instructions);
        if (s && !isDeepStrictEqual(plan, s.recipe))
            fail('The approved plan or its instructions changed. Request a fresh owner review.');
        return { recipe: structuredClone(current), plan, instructions };
    }
    async function checked(id) {
        const epoch = options.epoch();
        const s = requireSaved(id).value;
        if (s.restored || s.delivery)
            fail();
        await resolved(s);
        const result = await options.client.check(id);
        options.assertAdmission();
        if (options.epoch() !== epoch)
            fail('Workflow settings changed while the office checked permission.');
        const latest = requireSaved(id).value;
        if (latest.restored || latest.delivery || active.get(id)?.abort.signal.aborted || stopped)
            fail();
        return result;
    }
    async function deliver(id) {
        const saved = requireSaved(id).value;
        if (!saved.delivery || saved.restored)
            fail();
        try {
            await options.client.settle(id, saved.delivery);
            update(id, { phase: 'review-required', detail: 'Preparation recorded. The office owner must review the case before closing it or releasing it for more work.' });
        }
        catch {
            update(id, { phase: 'held', detail: 'The factual result is saved on this instance. The office could not accept it under the original permission. Review the case before reconciling; retrying will not repeat the work.' });
        }
    }
    async function finish(id, run, detail) {
        const s = requireSaved(id).value;
        if (!s.delivery)
            update(id, { runId: run?.id ?? null, delivery: { requestId: randomUUID(), runId: run?.id ?? `not-started:${s.executionId}`, outcome: run ? run.status === 'interrupted' ? 'interrupted' : ['completed', 'awaiting-approval', 'partial'].includes(run.status) ? 'prepared' : 'failed' : 'interrupted', note: (detail ?? 'This is a factual preparation receipt. Human case review is still required.').slice(0, 2048) } });
        await deliver(id);
    }
    async function perform(id) {
        let heartbeat, checking = false;
        try {
            let s = requireSaved(id).value;
            if (s.restored)
                return;
            if (s.delivery) {
                await deliver(id);
                return;
            }
            const old = options.findJob(s.jobKey);
            if (old) {
                if (old.status === 'running' || old.status === 'queued') {
                    update(id, { phase: 'held', runId: old.id, detail: 'An existing execution is still in progress. No duplicate was started. Review after the current service finishes.' });
                    return;
                }
                await finish(id, old);
                return;
            }
            if (s.phase === 'running') {
                await finish(id, undefined, 'The service stopped at dispatch before a durable job could be found. No automatic repeat was attempted.');
                return;
            }
            const grant = await options.client.status(id);
            s = update(id, { grant });
            if (!grant.current || grant.phase === 'revoked') {
                update(id, { phase: 'held', detail: 'The original case permission is no longer current. Review the case and request fresh approval if more work is needed.' });
                return;
            }
            if (grant.phase === 'pending') {
                update(id, { phase: 'waiting-owner', detail: 'Waiting for the office owner to review and confirm this one-time preparation.' });
                return;
            }
            const plan = await resolved(s);
            update(id, { phase: 'admitting', detail: 'Confirming the assigned case before starting preparation.' });
            await options.client.admit(id, s.executionId);
            const abort = new AbortController();
            active.set(id, { executionId: s.executionId, abort });
            const binding = { grantId: id, executionId: s.executionId };
            const check = () => context.run(binding, () => context.check());
            heartbeat = setInterval(() => {
                if (checking || abort.signal.aborted)
                    return;
                checking = true;
                void (async () => {
                    const proof = await checked(id);
                    if (Date.parse(proof.receipt.leaseExpiresAt) - now() < 60_000)
                        await options.client.renew(id, randomUUID());
                })().catch(() => abort.abort()).finally(() => { checking = false; });
            }, 5000);
            heartbeat.unref();
            const result = await context.run(binding, async () => {
                const epoch = options.epoch();
                await check();
                await options.client.beforeDispatch(id);
                options.assertAdmission();
                if (options.epoch() !== epoch)
                    fail();
                update(id, { phase: 'running', detail: 'Preparing the assigned case on this instance.' });
                return options.execute(plan.recipe, s.jobKey, {
                    instructionContext: async () => { await check(); return plan.instructions; },
                    worker: { signal: abort.signal },
                    department: { source: async () => { await check(); return (await checked(id)).source; }, check, ask: async (prompt, opts) => options.ask(prompt, { ...opts, signal: abort.signal }, check) },
                });
            });
            await finish(id, result.run);
        }
        catch (error) {
            const s = read(id)?.value;
            if (!s)
                return;
            const run = options.findJob(s.jobKey);
            const local = await options.client.local(id).catch(() => null);
            if (run && run.status !== 'running' && run.status !== 'queued')
                await finish(id, run).catch(() => { });
            else if (run)
                update(id, { phase: 'held', runId: run.id, detail: 'An execution receipt exists but its final outcome is not yet known. No automatic repeat or not-started result was recorded. Review after the worker stops.' });
            else if (local?.admission?.receipt)
                await finish(id, undefined, 'Preparation could not continue under its original case permission. Review the saved case before any new attempt.').catch(() => { });
            else
                update(id, { phase: !s.grant ? 'requesting' : s.phase === 'waiting-owner' && (!object(error) || error.status !== 409) ? 'waiting-owner' : 'held', detail: 'The office or reviewed workflow could not be checked. The saved request is preserved; no new worker was started.' });
        }
        finally {
            if (heartbeat)
                clearInterval(heartbeat);
            active.get(id)?.abort.abort();
            active.delete(id);
        }
    }
    function launch(id) {
        if (stopped || flights.has(id) || flights.size >= 4)
            return;
        const work = Promise.resolve().then(() => options.runContext(() => perform(id))).catch(() => { }).finally(() => { flights.delete(id); pump(); });
        flights.set(id, work);
    }
    function pump() {
        while (!stopped && queued.length && flights.size < 4)
            launch(queued.shift());
    }
    async function tick() {
        if (stopped)
            return;
        if (ticking)
            return ticking;
        const work = options.runContext(async () => {
            options.assertAdmission();
            const eligible = rows().reverse().map(r => r.value).filter(s => !s.restored && ['requesting', 'waiting-owner', 'admitting', 'running'].includes(s.phase));
            // A finite fair page per tick. Pending owner reviews release their slot
            // immediately and pump the next candidate; they cannot starve approvals.
            const start = eligible.length ? scanCursor % eligible.length : 0;
            for (let n = 0; n < eligible.length && queued.length < 32; n++) {
                const index = (start + n) % eligible.length, id = eligible[index].request.requestId;
                if (!flights.has(id) && !queued.includes(id))
                    queued.push(id);
                scanCursor = (index + 1) % eligible.length;
            }
            pump();
        }).catch(() => { });
        ticking = work;
        try {
            await work;
        }
        finally {
            ticking = null;
        }
    }
    return {
        async catalog(session, departmentId) {
            if (!companyExecutionUuid(departmentId))
                fail('Invalid department.', 400);
            await member(session);
            // Current host access is required even though the catalog is local.
            await departmentAccess(session, departmentId);
            const recipes = [];
            for (const recipe of options.recipes().slice(0, 1000)) {
                try {
                    const r = await resolved(undefined, recipe.id);
                    recipes.push({ id: r.recipe.id, revision: r.recipe.revision, title: r.recipe.title, review: r.plan.review });
                }
                catch { /* Unsupported private-source plans remain in their own workspace. */ }
                if (recipes.length >= 100)
                    break;
            }
            await departmentAccess(session, departmentId);
            return { recipes };
        },
        async prepare(session, input) {
            if (!isDepartmentWorkPrepare(input))
                fail('Check the case, plan and expiry fields.', 400);
            const actor = await member(session);
            let row = read(input.requestId);
            if (row && (!isDeepStrictEqual(row.value.request, input) || row.value.companyId !== actor.companyId || row.value.memberId !== actor.memberId || row.value.restored))
                fail();
            if (!row) {
                const plan = await resolved(undefined, input.recipeId);
                if (plan.recipe.revision !== input.expectedRecipeRevision)
                    fail();
                const executionId = randomUUID();
                row = options.db.create(DEPARTMENT_WORK_KIND, key(input.requestId), { version: 1, companyId: actor.companyId, memberId: actor.memberId, request: structuredClone(input), recipe: plan.plan, executionId, jobKey: manualRecipeRequestKey(plan.recipe, { requestId: executionId, expectedRevision: plan.recipe.revision }, 'prepare'), phase: 'requesting', detail: 'Saving this one-time request for owner review.', runId: null, updatedAt: now(), grant: null, delivery: null, restored: false }, 1000);
            }
            let grant;
            if (row.value.phase !== 'requesting')
                grant = await options.client.status(input.requestId);
            else
                grant = await options.client.begin(session, { version: 1, requestId: input.requestId, departmentId: input.departmentId, expectedDepartmentRevision: input.expectedDepartmentRevision, caseId: input.caseId, expectedCaseFence: input.expectedCaseFence, recipe: row.value.recipe, durationMs: input.durationMs });
            const saved = update(input.requestId, { grant, ...(row.value.phase === 'requesting' ? { phase: 'waiting-owner', detail: 'Waiting for the office owner to review and confirm this one-time preparation.' } : {}) });
            return { grant, local: state(saved) };
        },
        async list(session, input) {
            if (!input || Object.keys(input).sort().join(',') !== 'departmentId,limit,offset' || !companyExecutionUuid(input.departmentId) || input.limit !== 10 || !Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset > 1000)
                fail('Invalid department history page.', 400);
            const actor = await member(session);
            await departmentAccess(session, input.departmentId);
            const page = await rpc(session, '/api/company/execution-grants/list', input);
            if (!isCompanyExecutionGrantPage(page))
                fail('The department history response was incomplete.', 503);
            const ids = new Set(page.grants.map(g => g.id));
            const own = rows().map(r => r.value).filter(s => s.companyId === actor.companyId && s.memberId === actor.memberId && s.request.departmentId === input.departmentId);
            const selected = own.filter(s => ids.has(s.request.requestId));
            const orphan = own.filter(s => !s.grant && !ids.has(s.request.requestId));
            selected.push(...orphan.slice(input.offset, input.offset + 10));
            await departmentAccess(session, input.departmentId);
            return { ...page, hasMore: page.hasMore || orphan.length > input.offset + 10, local: selected.map(state) };
        },
        async confirm(session, input) {
            if (!isConfirmCompanyExecution(input))
                fail('Invalid owner review.', 400);
            const grant = await rpc(session, '/api/company/execution-grants/confirm', input);
            if (!isCompanyExecutionGrant(grant))
                fail('The owner confirmation response was incomplete.', 503);
            assertDepartmentWorkRecipe(grant.spec.recipe);
            void tick();
            return grant;
        },
        async revoke(session, input) {
            if (!isRevokeCompanyExecution(input))
                fail('Invalid revocation.', 400);
            const grant = await rpc(session, '/api/company/execution-grants/revoke', input);
            if (!isCompanyExecutionGrant(grant))
                fail('The revocation response was incomplete.', 503);
            active.get(input.grantId)?.abort.abort();
            return grant;
        },
        async reconcile(session, grantId) {
            const actor = await member(session), s = requireSaved(grantId).value;
            if (s.companyId !== actor.companyId || s.memberId !== actor.memberId || s.restored || flights.has(grantId))
                fail();
            if (s.delivery)
                await deliver(grantId);
            else {
                const run = options.findJob(s.jobKey);
                if (!run || run.status === 'running' || run.status === 'queued')
                    fail();
                await finish(grantId, run);
            }
            return state(requireSaved(grantId).value);
        },
        beforeRequest: () => context.check(),
        tick,
        start() { if (timer)
            return; stopped = false; timer = setInterval(() => void tick(), options.intervalMs ?? 10_000); timer.unref(); void tick(); },
        stop() { stopped = true; queued.length = 0; if (timer)
            clearInterval(timer); timer = undefined; for (const run of active.values())
            run.abort.abort(); },
        async drain() { await ticking; while (flights.size || queued.length) {
            pump();
            await Promise.allSettled([...flights.values()]);
        } },
        get busy() { return !!ticking || flights.size > 0 || queued.length > 0; },
    };
}
