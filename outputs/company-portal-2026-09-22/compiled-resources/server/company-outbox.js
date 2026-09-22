import { normalizeShare } from "./company/work-items.js";
const held = () => ({ status: 409, body: { code: 'outbox_pending', error: 'An earlier share needs confirmation. Resume it from Shared work before starting another share or leaving.' } });
export function createCompanyOutbox(options) {
    let queue = Promise.resolve();
    let waiting = 0;
    function serial(action) {
        if (waiting >= 8)
            return Promise.reject(new Error('Local sharing queue is full.'));
        waiting++;
        const next = queue.then(action);
        queue = next.catch(() => { }).finally(() => { waiting--; });
        return next;
    }
    async function saved() {
        const value = await options.vault.read('outbox');
        if (value !== undefined && (!value || value.version !== 1 || !['pending', 'confirmed'].includes(value.phase) || typeof value.companyId !== 'string' || typeof value.memberId !== 'string' || !value.input))
            throw new Error('Pending shared work needs recovery.');
        if (value)
            normalizeShare(value.input, value.memberId);
        return value;
    }
    return {
        serial,
        drain: () => queue,
        async departureAllowed() { return (await saved())?.phase !== 'pending'; },
        async localState() {
            const pending = await saved();
            return pending ? { requestId: pending.input.requestId, title: pending.input.title, phase: pending.phase } : null;
        },
        async archives() {
            const list = await options.vault.names('share-');
            const records = await Promise.all(list.names.map(async (name) => {
                const value = await options.vault.read(name);
                if (!value?.input?.requestId || !['saved', 'unknown'].includes(value.outcome))
                    throw new Error('Archived recovery state needs service attention.');
                return { requestId: value.input.requestId, title: value.input.title, archivedAt: value.archivedAt, outcome: value.outcome };
            }));
            return { records, hasMore: list.hasMore };
        },
        async exportArchive(requestId) {
            if (!/^[a-f0-9-]{36}$/.test(requestId))
                return { status: 400, body: { error: 'Use the saved recovery request ID.' } };
            const record = await options.vault.read(`share-${requestId}`);
            return record ? { status: 200, body: { record } } : { status: 404, body: { error: 'Recovery record unavailable.' } };
        },
        archive(requestId, acknowledgeUnknown) {
            return serial(async () => {
                const pending = await saved();
                if (!pending)
                    return { status: 200, body: { ok: true } };
                if (pending.input.requestId !== requestId || !acknowledgeUnknown)
                    return held();
                // This is a local record of an explicit human decision, never a remote
                // cancellation or a claim that the host did not save the work.
                await options.vault.write(`share-${requestId}`, { ...pending, archivedAt: new Date().toISOString(), outcome: pending.phase === 'confirmed' ? 'saved' : 'unknown', reason: 'user-acknowledged-unknown' });
                await options.vault.remove('outbox');
                return { status: 200, body: { ok: true } };
            });
        },
        handles: (path, method) => path === '/api/company/outbox' || (path === '/api/company/outbox/ack' && method === 'POST') || (path === '/api/company/work' && method === 'POST'),
        handle(path, method, request, body) {
            return serial(async () => {
                if (await options.departurePending())
                    return held();
                const identity = await options.forward('/api/company/me', 'GET', request);
                if (identity.status !== 200)
                    return identity;
                const actor = identity.body;
                if (!actor.company?.id || !actor.member?.id)
                    throw new Error('Company identity needs recovery.');
                if (!await options.matchesIdentity(actor.company.id, actor.member.id))
                    return { status: 403, body: { error: 'The office session does not match this workspace.' } };
                const pending = await saved();
                const sameMember = !pending || (pending.companyId === actor.company.id && pending.memberId === actor.member.id);
                if (path === '/api/company/outbox' && method === 'GET')
                    return { status: 200, body: { pending: sameMember && pending ? { phase: pending.phase, input: pending.input } : null, otherOfficePending: !sameMember } };
                if (!sameMember && pending?.phase === 'pending')
                    return held();
                if (path === '/api/company/outbox/ack') {
                    if (!sameMember)
                        return held();
                    if (!pending)
                        return { status: 200, body: { ok: true } };
                    if (pending.phase !== 'confirmed' || body?.requestId !== pending.input.requestId)
                        return held();
                    await options.vault.remove('outbox');
                    return { status: 200, body: { ok: true } };
                }
                if (path !== '/api/company/work' || method !== 'POST')
                    return { status: 405, body: { error: 'Method unavailable.' } };
                let normalized;
                try {
                    if (!body || Object.keys(body).some(key => !['requestId', 'title', 'summary', 'purpose', 'recipientMemberIds', 'assigneeMemberId', 'evidence'].includes(key)))
                        throw new Error();
                    normalized = normalizeShare(body, actor.member.id);
                }
                catch {
                    return { status: 400, body: { error: 'Check the reviewed share fields.' } };
                }
                const input = { requestId: normalized.requestId, title: normalized.title, summary: normalized.summary, purpose: normalized.purpose,
                    recipientMemberIds: normalized.recipients, assigneeMemberId: normalized.assigneeMemberId, evidence: normalized.evidence };
                const retryPending = pending?.phase === 'pending';
                if (retryPending && JSON.stringify(pending.input) !== JSON.stringify(input))
                    return held();
                if (pending?.phase === 'confirmed' && pending.input.requestId === input.requestId && JSON.stringify(pending.input) !== JSON.stringify(input))
                    return { status: 409, body: { code: 'conflict', error: 'This request was saved with different reviewed content.' } };
                const record = { version: 1, companyId: actor.company.id, memberId: actor.member.id, phase: 'pending', input };
                await options.vault.write('outbox', record);
                const result = await options.forward(path, method, request, input);
                if (result.status >= 200 && result.status < 300) {
                    const item = result.body?.item;
                    if (item?.id !== input.requestId || item.owner?.id !== actor.member.id || item.title !== input.title || item.summary !== input.summary)
                        throw new Error('Shared work result needs confirmation.');
                    await options.vault.write('outbox', { ...record, phase: 'confirmed', result: result.body });
                }
                else if (result.status >= 400 && result.status < 500 && !retryPending) {
                    await options.vault.remove('outbox');
                }
                return result;
            });
        },
    };
}
