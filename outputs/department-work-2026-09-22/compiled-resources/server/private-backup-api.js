const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
function fields(body, allowed) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !allowed.includes(k)))
        return fail('Use the supported private-backup fields.');
    return body;
}
/** Session protection is supplied by the HTTP host. No password or unsealed
 * business data is included in the returned preview or written to logs. */
export function createPrivateBackupApi(host) {
    return async (path, method, body) => {
        if (!/^\/api\/private-backup(?:\/|$)/.test(path))
            return null;
        if (path === '/api/private-backup' && method === 'GET') {
            const status = await host.service().status();
            return { status: 200, body: { ...host.restoreReadiness(), staged: status.state !== 'none', receipt: status.receipt, completed: status.completed ?? null, ...(host.snapshotActive ? { snapshotActive: host.snapshotActive() } : {}), ...(status.completionWarning ? { completionWarning: status.completionWarning } : {}) } };
        }
        if (path === '/api/private-backup/export' && method === 'POST') {
            const b = fields(body, ['passphrase']);
            const result = await host.service().exportBackup(b.passphrase);
            return { status: 200, body: { ...result, filename: `RealBud-private-work-${new Date().toISOString().slice(0, 10)}.realbud-backup` } };
        }
        if (path === '/api/private-backup/preview' && method === 'POST') {
            const b = fields(body, ['backup', 'passphrase']);
            return { status: 200, body: await host.service().previewBackup(b.backup, b.passphrase) };
        }
        if (path === '/api/private-backup/restore' && method === 'POST') {
            const b = fields(body, ['backup', 'passphrase', 'expectedDigest', 'confirm']);
            if (b.confirm !== true)
                return fail('Confirm restoring this reviewed backup into the empty workspace.');
            const readiness = host.restoreReadiness();
            if (!readiness.canRestore || !readiness.bootstrap)
                return fail(readiness.reason || 'Use a fresh supported desktop to restore this backup.', 409);
            host.beginRestore();
            try {
                return { status: 200, body: await host.service().stageRestore({ backup: b.backup, passphrase: b.passphrase, expectedDigest: b.expectedDigest }) };
            }
            catch (error) {
                await host.restoreFailed();
                throw error;
            }
        }
        return { status: 404, body: { error: 'Unknown private-backup action.' } };
    };
}
