/** RealBud owns review authority; the selected native store owns memory rules. */
import { createHash, createHmac } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentWorkerProfile, withWorkerProfile } from "./hermes-profile.js";
import { hermesHome, runtimeCli } from "./hermes-paths.js";
import { propertyProfileDir } from "./hermes-pack.js";
import { readRuntimeSelection, releaseHome, runtimeCommit, selectedHermesCli } from "./hermes-runtime-selection.js";
import { spawnCli, killCliTree } from "./procs.js";
import { containsCredential } from "./redact.js";
import { MEMORY_REVIEW_API, MEMORY_REVIEW_ERRORS, memoryReviewId, memoryReviewDigest, parseMemoryReviewPage, parseMemoryReviewPreview, parseMemoryReviewDecision } from "../shared/hermes-memory-review.js";
import { MEMORY_RECOVERY_API, parseMemoryRecoveryPage, parseMemoryRecoveryClosure } from "../shared/hermes-memory-recovery.js";
import { parseMemoryProposalInput, parseMemoryProposalResult } from "../shared/hermes-memory-proposal.js";
export const MEMORY_REVIEW_RUNTIME = '345cd2b057a452236de401d3534b8502a7465e8d';
export const MEMORY_REVIEW_NATIVE_FILES = {
    'tools/memory_tool.py': 'ed9c5db6b3144b88425f7039280239b29a047143aa8ffdfd3b7f47bf7e707143',
    'tools/memory_tool_store.py': '811ef2eb98a8b3f0448294b2c23d422ff7ebd4dc45835475b12df0557d7e5366',
    'tools/write_approval.py': '9404792bc8c6637e5bd78a87f5a6dfabda6cd6a1a61083b450647ddb2951c470',
    'tools/threat_patterns.py': '6ad8947a5a62db44f66b1cd33086e2b51c4a66019ef5301856e5efae59797341',
    'tools/__init__.py': '7bca460f476ac9ace706c8cfd07e98f8aae34d839862f0f68abafc3a8397cf35',
    'tools/registry.py': '310a57a5dc5d41c935eacbe707e8a258dc21fd72fd44fccbc33d1a78b7143922',
    'utils.py': '1414f177e14940750ad80d6dd5020685219ca26b0b7d500299ab2f170118ed07',
    'hermes_constants.py': 'e5f72a309b3689f5fa2e85065e8051f8e6f7686d1ec1741e7543cc5e56bea162',
};
const mutating = (command) => command.command === 'decide' || command.command === 'propose' || command.command === 'interrupted-close';
const helper = fileURLToPath(new URL('./helpers/hermes-memory-review.py', import.meta.url));
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
function fail(code, status = code === 'unavailable' ? 503 : 409) { throw Object.assign(new Error(MEMORY_REVIEW_ERRORS[code]), { code, status }); }
const samePath = (a, b) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
export function memoryReviewContext(workspaceId) {
    const home = hermesHome(), selection = readRuntimeSelection(home).selected;
    if (!selection || runtimeCommit(selection) !== MEMORY_REVIEW_RUNTIME)
        fail('unsupported');
    const runtimeDirectory = join(releaseHome(home, selection), 'hermes-agent');
    // An update affects the next process. Do not review under a different runtime
    // than the current worker, or follow an arbitrary CLI override from a request.
    if (!samePath(selectedHermesCli(home), runtimeCli(releaseHome(home, selection))))
        fail('unsupported');
    return { profileDirectory: propertyProfileDir(), runtimeDirectory, workspaceId, profileId: currentWorkerProfile().profile, runtimeId: selection,
        python: join(runtimeDirectory, 'venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python') };
}
async function ancestors(path) {
    const absolute = resolve(path), root = parse(absolute).root;
    let current = root;
    for (const part of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
        current = join(current, part);
        const stat = await lstat(current);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            fail('unsafe-storage');
    }
}
async function digestFile(path) {
    await ancestors(dirname(path));
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 2 * 1024 ** 2)
        fail('unsupported');
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const opened = await file.stat();
        if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
            fail('unsupported');
        const bytes = await file.readFile(), after = await file.stat();
        if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
            fail('unsupported');
        return createHash('sha256').update(bytes).digest('hex');
    }
    finally {
        await file.close();
    }
}
async function validateRuntime(context) {
    // The native Python helper has not admitted Windows per-file ACL and durable
    // rename behavior yet. A private profile ACL alone cannot vouch for explicit
    // grants on existing child files. Preserve pending data until that gate passes.
    if (process.platform === 'win32')
        fail('platform-unverified');
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(context.workspaceId) || !/^property(?:-[a-z0-9-]+)?$/.test(context.profileId) || context.profileId.length > 64 || runtimeCommit(context.runtimeId) !== MEMORY_REVIEW_RUNTIME)
        fail('unsupported');
    await ancestors(context.profileDirectory);
    for (const [name, expected] of Object.entries(MEMORY_REVIEW_NATIVE_FILES))
        if (await digestFile(join(context.runtimeDirectory, name)) !== expected)
            fail('unsupported');
}
export function memoryReviewChildEnvironment(context, source = process.env) {
    const env = {};
    for (const name of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP'])
        if (source[name])
            env[name] = source[name];
    env.HERMES_HOME = context.profileDirectory;
    env.HERMES_SKIP_DOTENV = '1';
    env.PYTHONDONTWRITEBYTECODE = '1';
    return env;
}
/** Resolve only after the owned helper exits; a deadline never means applied. */
export function runMemoryReviewHelper(context, request, options = {}) {
    return new Promise((accept, reject) => {
        if (options.signal?.aborted) {
            reject(Object.assign(new Error(MEMORY_REVIEW_ERRORS.unavailable), { code: 'unavailable', status: 503 }));
            return;
        }
        const child = spawnCli(context.python, ['-I', '-B', helper], { cwd: context.runtimeDirectory, env: memoryReviewChildEnvironment(context), stdio: ['pipe', 'pipe', 'pipe'], privateFiles: true });
        let size = 0, killed = false, spawnFailed = false, force;
        const chunks = [];
        const stop = () => { if (killed)
            return; killed = true; killCliTree(child); force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null)
            child.kill('SIGKILL'); }, 2000); force.unref(); };
        const timer = setTimeout(stop, options.timeoutMs ?? 20_000);
        timer.unref();
        options.signal?.addEventListener('abort', stop, { once: true });
        child.stdout.on('data', (chunk) => { size += chunk.length; if (size > 1024 * 1024) {
            stop();
            return;
        } chunks.push(Buffer.from(chunk)); });
        // Native diagnostics can contain private text. Consume without logging.
        child.stderr.on('data', () => { });
        child.on('error', () => { spawnFailed = true; });
        child.stdin.on('error', stop);
        child.once('close', code => {
            clearTimeout(timer);
            if (force)
                clearTimeout(force);
            options.signal?.removeEventListener('abort', stop);
            const buffer = Buffer.concat(chunks);
            for (const chunk of chunks)
                chunk.fill(0);
            try {
                if (killed || spawnFailed || code !== 0)
                    fail(mutating(request) ? 'recovery-required' : 'unavailable', 503);
                accept(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)));
            }
            catch (error) {
                reject(mutating(request) ? Object.assign(new Error(MEMORY_REVIEW_ERRORS['recovery-required']), { code: 'recovery-required', status: 503 }) : error);
            }
            finally {
                buffer.fill(0);
            }
        });
        child.stdin.end(JSON.stringify(request));
    });
}
export function createHermesMemoryReviewService(options) {
    const active = new Set(), controllers = new Set(), drains = new Set();
    let closed = false;
    async function run(input, owner) {
        if (closed)
            fail('unavailable', 503);
        const context = options.context(), identity = JSON.stringify(context);
        const checkOwner = () => {
            if (owner && (owner.signal.aborted || !owner.isCurrent() || identity !== owner.context))
                fail('stale-review');
        };
        checkOwner();
        const lockId = process.platform === 'win32' ? resolve(context.profileDirectory).toLowerCase() : resolve(context.profileDirectory);
        if (active.has(lockId))
            fail('busy');
        const controller = new AbortController();
        controllers.add(controller);
        const abort = () => controller.abort();
        owner?.signal.addEventListener('abort', abort, { once: true });
        let finish;
        const drained = new Promise(done => { finish = done; });
        drains.add(drained);
        active.add(lockId);
        let dispatched = false, classifiedRefusal = false;
        try {
            await (options.validateRuntime ?? validateRuntime)(context);
            if (controller.signal.aborted)
                fail('unavailable', 503);
            checkOwner();
            if (JSON.stringify(options.context()) !== identity)
                fail('stale-review');
            const sourceKey = options.key();
            if (!Buffer.isBuffer(sourceKey) || sourceKey.length !== 32)
                fail('unavailable');
            const signingKey = createHmac('sha256', sourceKey).update(`realbud-memory-review-v1\0${context.workspaceId}\0${context.profileId}`).digest();
            const { python: _python, ...binding } = context;
            let raw;
            try {
                dispatched = true;
                raw = await (options.invoke ?? runMemoryReviewHelper)(context, { ...binding, ...input, version: 1, key: signingKey.toString('base64') }, { signal: controller.signal });
            }
            finally {
                signingKey.fill(0);
            }
            if (controller.signal.aborted)
                fail('unavailable', 503);
            checkOwner();
            if (JSON.stringify(options.context()) !== identity)
                fail('stale-review');
            if (!object(raw) || typeof raw.ok !== 'boolean')
                fail('unavailable');
            if (!raw.ok) {
                if (exact(raw, ['ok', 'code']) && typeof raw.code === 'string' && Object.hasOwn(MEMORY_REVIEW_ERRORS, raw.code)) {
                    // Explicit native policy refusals are useful. An unreadable response
                    // or generic helper/storage failure cannot prove a decision failed.
                    classifiedRefusal = !['unavailable', 'unsafe-storage', 'capacity'].includes(raw.code);
                    fail(raw.code);
                }
                fail('unavailable');
            }
            if (!exact(raw, ['ok', 'result']))
                fail('unavailable');
            if (input.command === 'interrupted-list') {
                const page = parseMemoryRecoveryPage(raw.result);
                if (!page || page.items.some(row => row.key <= (input.cursor ?? '')))
                    fail('unavailable');
                return page;
            }
            if (input.command === 'interrupted-close') {
                const closed = parseMemoryRecoveryClosure(raw.result);
                if (!closed || closed.key !== input.proposalKey || closed.recoveryDigest !== input.expectedDigest)
                    fail('recovery-required');
                return closed;
            }
            if (input.command === 'propose') {
                const proposal = parseMemoryProposalResult(raw.result);
                if (!proposal)
                    fail('recovery-required');
                return proposal;
            }
            if (input.command === 'list') {
                const page = parseMemoryReviewPage(raw.result);
                if (!page)
                    fail('unavailable');
                return page;
            }
            if (input.command === 'preview') {
                const preview = parseMemoryReviewPreview(raw.result);
                if (!preview || preview.id !== input.id)
                    fail('unavailable');
                if ([preview.before, preview.after].some(text => containsCredential(text) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(text)))
                    fail('blocked-content');
                return preview;
            }
            const decision = parseMemoryReviewDecision(raw.result);
            if (!decision || decision.id !== input.id || decision.reviewDigest !== input.expectedDigest || decision.state !== (input.decision === 'approve' ? 'applied' : 'rejected'))
                fail('recovery-required');
            return decision;
        }
        catch (error) {
            if (mutating(input) && dispatched && !classifiedRefusal)
                fail('recovery-required', 503);
            throw error;
        }
        finally {
            owner?.signal.removeEventListener('abort', abort);
            active.delete(lockId);
            controllers.delete(controller);
            drains.delete(drained);
            finish();
        }
    }
    return {
        async close() { closed = true; for (const controller of controllers)
            controller.abort(); await Promise.allSettled([...drains]); },
        /** Host-only capability: no HTTP route or model-supplied identity can create it. */
        proposalIntegration(threadId, isCurrent) {
            if (closed || process.platform === 'win32' || !threadId || threadId.length > 200 || /[\x00-\x1f\x7f]/.test(threadId))
                return null;
            let captured;
            try {
                captured = { ...options.context() };
            }
            catch {
                return null;
            }
            const identity = JSON.stringify(captured), memberKey = currentWorkerProfile().memberKey;
            const scope = createHash('sha256').update(JSON.stringify(['realbud-memory-proposal-scope-v1', identity, threadId])).digest('hex');
            return { scope, propose: async (raw, signal) => withWorkerProfile(memberKey, async () => {
                    const input = parseMemoryProposalInput(raw);
                    if (!input)
                        fail('invalid', 400);
                    if (containsCredential(JSON.stringify(input)))
                        fail('blocked-content');
                    const work = () => run({ command: 'propose', scopeId: scope, input }, { signal, context: identity, isCurrent });
                    const result = options.withActivity ? await options.withActivity(work) : await work();
                    const proposal = parseMemoryProposalResult(result);
                    if (!proposal)
                        fail('recovery-required');
                    return proposal;
                }) };
        },
        async handle(path, method, body, query = new URLSearchParams()) {
            if (path !== MEMORY_REVIEW_API && !path.startsWith(`${MEMORY_REVIEW_API}/`))
                return null;
            try {
                let command;
                if (path === MEMORY_RECOVERY_API && method === 'GET') {
                    if ([...query.keys()].some(key => key !== 'cursor') || query.getAll('cursor').length > 1)
                        fail('invalid', 400);
                    const cursor = query.get('cursor');
                    if (cursor !== null && !memoryReviewDigest(cursor))
                        fail('invalid', 400);
                    command = { command: 'interrupted-list', ...(cursor ? { cursor } : {}) };
                }
                else if (path.startsWith(`${MEMORY_RECOVERY_API}/`)) {
                    const rest = path.slice(MEMORY_RECOVERY_API.length + 1).split('/');
                    if (query.size || rest.length !== 2 || !memoryReviewDigest(rest[0]) || rest[1] !== 'close' || method !== 'POST')
                        fail('invalid', 404);
                    if (!object(body) || !exact(body, ['expectedDigest']) || !memoryReviewDigest(body.expectedDigest))
                        fail('invalid', 400);
                    command = { command: 'interrupted-close', proposalKey: rest[0], expectedDigest: body.expectedDigest };
                }
                else if (path === MEMORY_REVIEW_API && method === 'GET') {
                    if ([...query.keys()].some(key => key !== 'cursor') || query.getAll('cursor').length > 1)
                        fail('invalid', 400);
                    const cursor = query.get('cursor');
                    if (cursor !== null && !memoryReviewId(cursor))
                        fail('invalid', 400);
                    command = { command: 'list', ...(cursor ? { cursor } : {}) };
                }
                else {
                    if (query.size)
                        fail('invalid', 400);
                    const rest = path.slice(MEMORY_REVIEW_API.length + 1).split('/');
                    if (!memoryReviewId(rest[0]))
                        fail('invalid', 404);
                    if (rest.length === 1 && method === 'GET')
                        command = { command: 'preview', id: rest[0] };
                    else if (rest.length === 2 && rest[1] === 'decision' && method === 'POST') {
                        if (!object(body) || !exact(body, ['expectedDigest', 'decision']) || !memoryReviewDigest(body.expectedDigest) || body.decision !== 'approve' && body.decision !== 'reject')
                            fail('invalid', 400);
                        command = { command: 'decide', id: rest[0], expectedDigest: body.expectedDigest, decision: body.decision };
                    }
                    else
                        fail('invalid', 404);
                }
                if (method === 'GET' && body !== undefined)
                    fail('invalid', 400);
                const result = options.withActivity ? await options.withActivity(() => run(command)) : await run(command);
                return { status: 200, body: result };
            }
            catch (error) {
                const code = error?.code;
                const known = typeof code === 'string' && Object.hasOwn(MEMORY_REVIEW_ERRORS, code) ? code : 'unavailable';
                const rawStatus = error?.status, status = [400, 404, 409, 503].includes(rawStatus ?? 0) ? rawStatus : 503;
                return { status, body: { error: MEMORY_REVIEW_ERRORS[known], code: known } };
            }
        },
    };
}
