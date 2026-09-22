/** The website selects an opaque, reviewed descriptor. Only these local adapters
 * resolve it to existing execution doors; remote parameters are never prompts. */
import { createHash } from 'node:crypto';
import { recipeClockRunnable } from "../shared/contracts.js";
import { agencyRecipeRole, workflowRecipeId } from "../shared/agency-workflow-packs.js";
import { canonicalWebsiteCommand } from "../shared/website-commands.js";
import { isRemoteDisclosureTemplate } from "./website-remote-disclosure.js";
import { REMOTE_DISCLOSURE_POLICY } from "../shared/website-remote-approvers.js";
import { manualRecipeRequestKey } from "./manual-job-request.js";
const digest = (value) => createHash('sha256').update(canonicalWebsiteCommand(value)).digest('hex');
const fail = (part = 'work or source') => { throw Object.assign(new Error(`The reviewed ${part} changed. Refresh the request and review it again.`), { status: 409 }); };
const supported = (recipe) => recipeClockRunnable(recipe) && !agencyRecipeRole(recipe.id) && !recipe.capabilities.some(c => c.startsWith('portal-'));
/** Source-status refresh is observational. It must not cancel a reviewed run;
 * the source collector still checks the observed account/authorization itself.
 * Other setup writes fence awaits conservatively, including rejected writes. */
export function websiteWorkSettingsMutation(path, method) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(method))
        return false;
    if (path === '/api/connected-apps/check' && method === 'POST')
        return false;
    return /^\/api\/(?:agency-setup|customer-packs|hermes|connected-apps|service-admin|config|recipes)(?:\/|$)/.test(path);
}
export function websiteRunReceipt(run) {
    const phase = run.status === 'queued' ? 'running' : run.status === 'awaiting-approval' ? 'needs-review' : run.status === 'missed' ? 'interrupted' : run.status;
    const outcome = phase === 'completed' ? 'prepared' : phase === 'needs-review' ? 'review-required' : phase === 'partial' ? 'partial-results' : phase === 'failed' ? 'execution-failed' : phase === 'interrupted' ? 'execution-interrupted' : phase === 'cancelled' ? 'cancelled' : null;
    return { id: run.id, phase, outcome };
}
export function createWebsiteWorkAdapters(options) {
    const checkedEpochs = new Map();
    const checkKey = (descriptor, binding) => digest([descriptor, binding]);
    function id(operation, recipeId = '') {
        const h = digest([options.workspaceId, 'website-work-v1', operation, recipeId]);
        // Opaque stable UUID-shaped identity. The unhashed recipe key stays local.
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
    }
    function recipeFor(descriptor, view) {
        const recipes = options.recipes();
        if (descriptor.operation === 'morning-review') {
            if (descriptor.id !== id('morning-review') || !view)
                return fail();
            const recipeId = workflowRecipeId(view.state.settings.workflowPackId, 'inbox-triage');
            const recipe = recipes.find(r => r.id === recipeId);
            if (!recipe || !recipeClockRunnable(recipe))
                return fail();
            return recipe;
        }
        const recipe = recipes.find(r => id('prepare-recipe', r.id) === descriptor.id);
        if (!recipe || !supported(recipe))
            return fail();
        return recipe;
    }
    async function capture(descriptor, includeBook) {
        const authority = options.authority(), epoch = options.revisionEpoch();
        const view = descriptor.operation === 'morning-review' ? await options.agency() : undefined;
        const recipe = recipeFor(descriptor, view), recipeDigest = digest(recipe);
        await options.assertRecipeReady(recipe.id);
        const instructions = await options.instructions(recipe.id);
        const morning = view?.workflows.find(w => w.id === 'morning-priorities');
        const loop = view ? options.morningLoop() : undefined;
        if (view && (!morning?.readyForRun || !loop?.available))
            return fail('source readiness');
        if (view) {
            const fresh = await options.agency(), checked = fresh.workflows.find(w => w.id === 'morning-priorities');
            if (!checked?.readyForRun || fresh.state.revision !== view.state.revision || checked.evidenceDigest !== morning?.evidenceDigest)
                return fail('agency settings');
        }
        if (epoch !== options.revisionEpoch())
            return fail('workspace settings');
        if (authority !== options.authority())
            return fail('worker configuration');
        if (recipeDigest !== digest(recipeFor(descriptor, view)))
            return fail('work plan');
        return { epoch, recipe, view, instructions, binding: { version: 1, recipeId: recipe.id, recipeRevision: recipe.revision, recipeDigest, instructionDigest: digest(instructions), authority,
                bookRevision: includeBook && recipe.capabilities.includes('read-book') ? options.bookRevision() : null,
                morning: view && morning && loop ? { revision: view.state.revision, evidenceDigest: morning.evidenceDigest, loopRevision: loop.revision } : null } };
    }
    function revision(binding) { return digest({ ...binding, bookRevision: null }); }
    async function getCatalog() {
        const candidates = [{ id: id('morning-review'), operation: 'morning-review' },
            ...options.recipes().filter(supported).map(r => ({ id: id('prepare-recipe', r.id), operation: 'prepare-recipe' }))];
        const catalog = [];
        for (const candidate of candidates.slice(0, 65)) {
            try {
                const captured = await capture(candidate, false);
                // A local person reviews these exact labels before publishing them.
                const label = candidate.operation === 'morning-review' ? 'Morning priorities' : captured.recipe.title.trim().replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 80);
                if (label)
                    catalog.push({ ...candidate, revision: revision(captured.binding), label });
            }
            catch { /* An unavailable/unreviewed plan must not be advertised. */ }
        }
        return catalog;
    }
    async function preview(descriptor) {
        const { binding, recipe, instructions, view } = await capture(descriptor, true);
        if (revision(binding) !== descriptor.revision)
            return fail();
        const details = [{ label: 'Work plan', value: `${recipe.title} · revision ${recipe.revision}` }, { label: 'Allowed abilities', value: recipe.capabilities.join(', ') },
            { label: 'Limits', value: `${recipe.limits.maxRuntimeMinutes} minutes; ${recipe.limits.maxTurns} worker turns` },
            { label: 'Result', value: 'Preparation only. Review the result on this computer. Any further approval stays separate.' }];
        for (const [label, text] of [['Description', recipe.description], ['Steps', recipe.steps.join('\n')], ['Allowed websites', recipe.allowedOrigins.join('\n') || 'None'], ['Required evidence', recipe.evidence], ['Reviewed site notes', recipe.siteNotes || 'None'], ['Reviewed workflow instructions', instructions || 'No additional pack instructions']]) {
            for (let offset = 0; offset < text.length; offset += 8000)
                details.push({ label: `${label}${text.length > 8000 ? ` (${Math.floor(offset / 8000) + 1})` : ''}`, value: text.slice(offset, offset + 8000) });
        }
        if (view) {
            const s = view.state.settings;
            details.unshift({ label: 'Agency', value: s.agencyName }, { label: 'Gmail account', value: s.gmailAccountId ?? 'Unavailable' }, { label: 'Mail scope', value: `Up to ${s.mailScope.maxMessages} messages from ${s.mailScope.historyDays} days; ${s.mailScope.includeSent ? 'includes' : 'excludes'} sent mail; attachment metadata only` }, { label: 'Office time zone', value: s.timeZone });
        }
        if (binding.bookRevision !== null)
            details.push({ label: 'Private book', value: `Saved revision ${binding.bookRevision}. This is not a live source refresh.` });
        const content = { title: descriptor.label, details, binding };
        if (details.length > 64 || Buffer.byteLength(JSON.stringify(content)) > 60_000)
            throw Object.assign(new Error('This plan is too large for one website request review. Review and run it from the local workflow, or shorten the plan before publishing it.'), { status: 409 });
        return content;
    }
    async function remoteDisclosure(descriptor, mailboxAlias) {
        const { binding, recipe, instructions, view } = await capture(descriptor, false);
        if (revision(binding) !== descriptor.revision)
            return fail();
        if (recipe.capabilities.includes('read-book'))
            throw Object.assign(new Error('This plan reads the private book and needs local review. Choose a preparation with explicitly described sources.'), { status: 409 });
        if (view && (!mailboxAlias || mailboxAlias === view.state.settings.gmailAccountId))
            throw Object.assign(new Error('Give this mailbox a clear name for the reviewer. Do not use its connection identifier.'), { status: 400 });
        const sections = [{ label: 'Allowed abilities', value: recipe.capabilities.join(', ') }, { label: 'Limits', value: `${recipe.limits.maxRuntimeMinutes} minutes; ${recipe.limits.maxTurns} worker turns` },
            { label: 'Effect', value: 'Preparation only. Results stay on this computer. Further actions and schedules require separate approval.' }];
        for (const [label, text] of [['Description', recipe.description], ['Steps', recipe.steps.join('\n')], ['Allowed websites', recipe.allowedOrigins.join('\n') || 'None'], ['Required evidence', recipe.evidence], ['Reviewed site notes', recipe.siteNotes || 'None'], ['Reviewed instructions', instructions || 'No additional instructions']]) {
            for (let offset = 0; offset < text.length; offset += 8000)
                sections.push({ label: `${label}${text.length > 8000 ? ` (${Math.floor(offset / 8000) + 1})` : ''}`, value: text.slice(offset, offset + 8000) });
        }
        if (view) {
            const s = view.state.settings;
            sections.unshift({ label: 'Mailbox', value: mailboxAlias }, { label: 'Office time zone', value: s.timeZone }, { label: 'Mail scope', value: `At dispatch: up to ${s.mailScope.maxMessages} messages from the preceding ${s.mailScope.historyDays} days; ${s.mailScope.includeSent ? 'includes' : 'excludes'} sent mail; attachment metadata only. The scan window is relative to dispatch time.` });
        }
        const template = { version: 1, policy: REMOTE_DISCLOSURE_POLICY, descriptor, mailboxAlias: view ? mailboxAlias : null, sections };
        if (!isRemoteDisclosureTemplate(template))
            throw Object.assign(new Error('The complete plan is too large for remote review. Keep this plan local or shorten it.'), { status: 409 });
        // Source identifiers in reviewed free text must not bypass the typed projection.
        if (view?.state.settings.gmailAccountId && canonicalWebsiteCommand(template).includes(view.state.settings.gmailAccountId))
            throw Object.assign(new Error('The plan contains its raw mailbox connection identifier. Remove that identifier before sharing a remote review.'), { status: 409 });
        return template;
    }
    function parseBinding(value) {
        if (value.version !== 1 || typeof value.recipeId !== 'string' || !Number.isSafeInteger(value.recipeRevision) || typeof value.recipeDigest !== 'string' || typeof value.instructionDigest !== 'string' || typeof value.authority !== 'string' || !(value.bookRevision === null || Number.isSafeInteger(value.bookRevision)) || !(value.morning === null || typeof value.morning === 'object'))
            return fail();
        return value;
    }
    function assertSynchronous(descriptor, binding) {
        options.assertAdmission();
        if (checkedEpochs.get(checkKey(descriptor, binding)) !== options.revisionEpoch())
            return fail();
        const recipe = options.recipes().find(r => r.id === binding.recipeId);
        if (!recipe || !recipeClockRunnable(recipe) || digest(recipe) !== binding.recipeDigest || options.authority() !== binding.authority || binding.bookRevision !== null && options.bookRevision() !== binding.bookRevision)
            return fail();
        if (descriptor.operation === 'prepare-recipe' && !supported(recipe))
            return fail();
        if (descriptor.operation === 'morning-review' && (!binding.morning || options.morningLoop()?.revision !== binding.morning.loopRevision))
            return fail();
        return recipe;
    }
    async function check(descriptor, value) {
        const binding = parseBinding(value);
        options.assertAdmission();
        const current = await capture(descriptor, binding.bookRevision !== null);
        if (current.epoch !== options.revisionEpoch())
            return fail('workspace settings');
        if (revision(current.binding) !== descriptor.revision || digest(current.binding) !== digest(binding)) {
            if (current.binding.authority !== binding.authority)
                return fail('worker configuration');
            if (current.binding.recipeDigest !== binding.recipeDigest)
                return fail('work plan');
            if (current.binding.instructionDigest !== binding.instructionDigest)
                return fail('workflow instructions');
            if (digest(current.binding.morning) !== digest(binding.morning))
                return fail('morning source or schedule');
            if (current.binding.bookRevision !== binding.bookRevision)
                return fail('private book');
            return fail();
        }
        // Domain credential/claim reads may still await after check returns. Keep a
        // process-local stamp through that gap, without changing published identity.
        const key = checkKey(descriptor, binding);
        checkedEpochs.delete(key);
        checkedEpochs.set(key, current.epoch);
        while (checkedEpochs.size > 128)
            checkedEpochs.delete(checkedEpochs.keys().next().value);
        assertSynchronous(descriptor, binding);
    }
    function lookupExisting(execution) {
        const b = parseBinding(execution.binding);
        if (execution.descriptor.operation === 'morning-review') {
            const found = options.findMorning(execution.requestId);
            if (found && (found.loopId !== 'inbound-triage' || found.loopRevision !== b.morning?.loopRevision))
                return fail();
            return found ? websiteRunReceipt(found) : null;
        }
        const key = manualRecipeRequestKey({ id: b.recipeId, revision: b.recipeRevision }, { requestId: execution.requestId, expectedRevision: b.recipeRevision }, 'prepare');
        const found = options.findJob(key);
        return found ? websiteRunReceipt(found) : null;
    }
    // Recovery keeps its asynchronous API, but admission must not yield after the
    // domain's final claim-deadline check and before the durable executor enqueue.
    async function lookup(execution) {
        return lookupExisting(execution);
    }
    async function dispatch(execution) {
        const b = parseBinding(execution.binding);
        const existing = lookupExisting(execution);
        if (existing)
            return existing;
        // The domain already awaited check after its online claim. No additional
        // asynchronous authority check belongs between this guard and enqueue.
        const recipe = assertSynchronous(execution.descriptor, b);
        if (execution.descriptor.operation === 'morning-review') {
            const run = options.runMorning(execution.requestId, b.morning.loopRevision);
            if (!run)
                return fail();
            return websiteRunReceipt(run);
        }
        const key = manualRecipeRequestKey(recipe, { requestId: execution.requestId, expectedRevision: b.recipeRevision }, 'prepare');
        const flight = options.execute(recipe, key, async () => {
            const instructions = await options.instructions(recipe.id);
            await check(execution.descriptor, b);
            if (digest(instructions) !== b.instructionDigest)
                return fail();
            return instructions;
        }, () => { assertSynchronous(execution.descriptor, b); });
        // Existing executor owns completion. Its durable enqueue precedes its first
        // await, so a lost response can always find that receipt by the same key.
        void flight.catch(() => { });
        const run = options.findJob(key);
        if (!run)
            return fail();
        return websiteRunReceipt(run);
    }
    return { getCatalog, preview, check, lookup, dispatch, remoteDisclosure };
}
