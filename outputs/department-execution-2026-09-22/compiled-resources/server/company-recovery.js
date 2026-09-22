import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CompanyError } from "./company/index.js";
import { companyMemberToken } from "./company-host.js";
import { readPrivateJson, writePrivateJson } from "./private-json.js";
import { createOfficeBackup, restoreOfficeBackup, officeRestoreReceipt, OfficeBackupError } from "./company/backup.js";
const AUTH_PATHS = new Set(['/api/company/status', '/api/company/me', '/api/company/sign-in', '/api/company/recover-member', '/api/company/logout']);
const PREFIX = '/api/company/host-recovery';
/** Local service administration plus actual office-owner proof. Never served on LAN. */
export function createCompanyRecovery(options) {
    const path = join(options.directory, 'host-lifecycle.json');
    let state = { version: 1, mode: 'active' };
    let savedStatePresent = false;
    let inflight = 0;
    let busy = false;
    let admissionHeld = false;
    let frozen = false;
    const drained = new Set();
    const save = async (next) => { if (next.mode !== 'active')
        state = next; await writePrivateJson(path, next); savedStatePresent = true; state = next; };
    const recoverReceipt = async () => {
        if (state.restoreHash && !state.restored && options.available()) {
            const receipt = await options.withAdminPool(pool => officeRestoreReceipt(pool, state.restoreHash));
            if (receipt)
                await save({ ...state, restored: receipt });
        }
    };
    const drain = () => inflight === 0 ? Promise.resolve() : new Promise((resolve, reject) => {
        const done = () => { clearTimeout(timer); drained.delete(done); resolve(); };
        const timer = setTimeout(() => { drained.delete(done); reject(new OfficeBackupError('Office requests are still finishing. Check host status, then retry after they finish.')); }, 15_000);
        drained.add(done);
    });
    return {
        async load() {
            const saved = await readPrivateJson(path);
            if (saved !== undefined) {
                const value = saved;
                if (!value || value.version !== 1 || !['active', 'standby', 'retired'].includes(value.mode) || (value.restoreHash !== undefined && !/^[a-f0-9]{64}$/.test(value.restoreHash))) {
                    frozen = true;
                    throw new Error('Host lifecycle state needs recovery.');
                }
                state = value;
                savedStatePresent = true;
            }
        },
        async checkExistingHost() {
            if (savedStatePresent)
                return;
            admissionHeld = true;
            const prior = await options.withAdminPool(pool => pool.query("SELECT kind FROM realbud_company.audit_events WHERE kind IN ('host.restored','host.retirement_confirmed','host.cutover_confirmed') ORDER BY created_at DESC LIMIT 1"));
            if (prior.rowCount)
                await save({ version: 1, mode: prior.rows[0].kind === 'host.retirement_confirmed' ? 'retired' : 'standby' });
            admissionHeld = false;
        },
        mode: () => state.mode,
        /** Covers all host traffic, including TLS clients and local shared-work forwarding. */
        async serve(path, action) {
            if (admissionHeld || frozen || (state.mode !== 'active' && !AUTH_PATHS.has(path)))
                return { status: 409, body: { code: 'host_held', error: 'This office host is held for recovery or retirement. Its owner must complete cutover before office work can continue.' } };
            inflight++;
            try {
                return await action();
            }
            finally {
                if (--inflight === 0)
                    for (const done of drained)
                        done();
            }
        },
        handles: (path) => path.startsWith(PREFIX),
        async handle(path, method, request, body) {
            const gate = options.authorizeAdmin(request);
            if (!gate.ok)
                return { status: gate.status, body: { code: 'service_admin_required', error: gate.error } };
            if (!options.available())
                return { status: 409, body: { error: 'Set up an owned host on this computer before using host recovery.' } };
            if (path === PREFIX && method === 'GET') {
                if (!busy)
                    await recoverReceipt();
                return { status: 200, body: { ...state, busy } };
            }
            if (method !== 'POST' || !['/backup', '/restore', '/activate', '/reset-empty'].some(suffix => path === PREFIX + suffix))
                return { status: 404, body: { error: 'Recovery action unavailable.' } };
            if (!body || typeof body !== 'object' || Array.isArray(body))
                return { status: 400, body: { error: 'Check the recovery fields.' } };
            if (busy)
                return { status: 409, body: { error: 'Host recovery is already running. Check recovery status before retrying.' } };
            busy = true;
            const value = body;
            try {
                await recoverReceipt();
                const allowed = path.endsWith('/reset-empty') ? [] : path.endsWith('/backup') ? ['passphrase', 'retireSource'] : path.endsWith('/restore') ? ['passphrase', 'backup'] : ['companyId', 'originalHostStopped'];
                if (Object.keys(value).some(key => !allowed.includes(key)))
                    throw new OfficeBackupError('Check the recovery fields.');
                if (path.endsWith('/reset-empty')) {
                    frozen = true;
                    await drain();
                    if ((await options.kernel().getBootstrapState()).companies.length)
                        return { status: 409, body: { error: 'An existing office cannot be reset. Complete its recovery with the owner.' } };
                    await save({ version: 1, mode: 'active' });
                    return { status: 200, body: { ok: true, mode: 'active' } };
                }
                if (path.endsWith('/restore')) {
                    const hash = createHash('sha256').update(JSON.stringify(value.backup) ?? '').digest('hex');
                    if (state.restored && state.restoreHash === hash)
                        return { status: 200, body: { receipt: state.restored, mode: state.mode } };
                    if (state.mode === 'retired' || (await options.kernel().getBootstrapState()).companies.length)
                        return { status: 409, body: { error: 'Restore requires a new, empty host. Existing office data will not be overwritten.' } };
                    frozen = true;
                    await drain();
                    await save({ version: 1, mode: 'standby', restoreHash: hash });
                    const receipt = await options.withAdminPool(pool => restoreOfficeBackup(pool, value.backup, value.passphrase));
                    await save({ ...state, restored: receipt });
                    return { status: 200, body: { receipt, mode: 'standby' } };
                }
                frozen = true;
                await drain();
                const actor = await options.kernel().authenticateSession(companyMemberToken(request));
                if (actor.role !== 'owner')
                    return { status: 403, body: { error: 'The current office owner must sign in on this host.' } };
                if (path.endsWith('/activate')) {
                    if (value.companyId !== actor.companyId || value.originalHostStopped !== true)
                        throw new OfficeBackupError('Verify this office identity and that every previous host is stopped before activation.');
                    if (state.mode === 'active')
                        return { status: 200, body: { ok: true, mode: 'active' } };
                    frozen = true;
                    await drain();
                    // No quorum exists on an isolated LAN. The explicit cutover confirmation
                    // is an operational requirement, never a claim of automatic fencing.
                    await options.withAdminPool(pool => pool.query("INSERT INTO realbud_company.audit_events(id,company_id,actor_member_id,kind,details) VALUES(gen_random_uuid(),$1,$2,'host.cutover_confirmed',$3)", [actor.companyId, actor.memberId, JSON.stringify({ originalHostStopped: true, previousMode: state.mode })]));
                    await save({ ...state, mode: 'active' });
                    return { status: 200, body: { ok: true, mode: 'active' } };
                }
                if (typeof value.passphrase !== 'string' || value.passphrase.length < 16 || value.passphrase.length > 256 || typeof value.retireSource !== 'boolean')
                    throw new OfficeBackupError('Choose a backup passphrase of 16–256 characters and select whether this host is moving.');
                if (value.retireSource) {
                    // Persist the hold before producing the final cutover snapshot.
                    await save({ ...state, mode: 'retired' });
                    await options.withAdminPool(pool => pool.query("INSERT INTO realbud_company.audit_events(id,company_id,actor_member_id,kind,details) VALUES(gen_random_uuid(),$1,$2,'host.retirement_confirmed','{}'::jsonb)", [actor.companyId, actor.memberId]));
                }
                const result = await options.withAdminPool(pool => createOfficeBackup(pool, value.passphrase, actor.companyId, state.mode === 'retired'));
                await save({ ...state, lastBackup: result.receipt });
                return { status: 200, body: result };
            }
            catch (error) {
                if (error instanceof OfficeBackupError)
                    return { status: 400, body: { error: error.message } };
                if (error instanceof CompanyError)
                    return { status: error.code === 'unauthenticated' ? 401 : 403, body: { error: 'The current office owner must sign in on this host.' } };
                return { status: 503, body: { error: 'Host recovery could not be confirmed. Check recovery status before retrying; existing data was preserved.' } };
            }
            finally {
                frozen = false;
                busy = false;
            }
        },
    };
}
