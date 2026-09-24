import { currentWorkerProfile } from "./hermes-profile.js";
import { parseMailScanResult } from "../shared/mail-ingestion.js";
export const managedConnectorConfigured = (cfg) => cfg.composio?.managed !== undefined;
export function managedConnectorSettings(cfg) {
    const managed = cfg.composio?.managed;
    const fail = () => { throw Object.assign(new Error('Managed connections need service setup for this private workspace.'), { status: 403 }); };
    if (!managed || Object.keys(managed).sort().join(',') !== 'credential,endpoint,profile' ||
        typeof managed.credential !== 'string' || !/^rbc_[a-f0-9]{64}$/.test(managed.credential) ||
        managed.profile !== currentWorkerProfile().profile || typeof managed.endpoint !== 'string' || managed.endpoint.length > 2048)
        return fail();
    let url;
    try {
        url = new URL(managed.endpoint);
    }
    catch {
        return fail();
    }
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))))
        return fail();
    return { key: managed.credential, url: `${url.origin}/v1/connectors/mcp`, headers: { authorization: `Bearer ${managed.credential}`, 'x-realbud-profile': managed.profile } };
}
async function request(cfg, path, body, inputSignal) {
    const settings = managedConnectorSettings(cfg), signal = AbortSignal.any([AbortSignal.timeout(path === '/v1/connectors/mail-scan' ? 250_000 : 35_000), ...(inputSignal ? [inputSignal] : [])]);
    const response = await fetch(new URL(path, settings.url), { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal,
        headers: { ...settings.headers, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok || response.redirected) {
        await response.body?.cancel().catch(() => { });
        const message = response.status === 402 ? 'Your managed service is paused or expired. Contact service support.' :
            response.status === 403 ? 'Managed connection access was revoked or changed. Contact service support.' :
                response.status === 409 && path === '/v1/connectors/mail-scan' ? 'The Gmail connection changed. Review the connected account and approve the mail source again before scanning.' :
                    response.status === 400 && path === '/v1/connectors/mail-scan' ? 'This mail scan needs a reviewed Gmail account and a compatible managed service. Update RealBud and ask service support to check the connection.' :
                        response.status === 409 ? 'This connection needs recovery. Check its current result with service support before trying again.' : 'Managed connections could not be checked. Try again when the service is available.';
        throw Object.assign(new Error(message), { status: response.status >= 400 && response.status < 500 ? response.status : 502 });
    }
    if (!response.body)
        throw new Error('The managed connection response was incomplete.');
    const reader = response.body.getReader();
    let size = 0;
    const chunks = [];
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done)
                break;
            size += value.length;
            if (size > 1_000_000)
                throw new Error('The managed connection response was too large.');
            chunks.push(value);
        }
    }
    finally {
        await reader.cancel().catch(() => { });
        reader.releaseLock();
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        throw new Error('The managed connection response was incomplete.');
    }
}
export async function scanManagedMail(cfg, accountId, scope, signal) {
    if (typeof accountId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(accountId))
        throw Object.assign(new Error('Review and select the Gmail account before scanning mail.'), { status: 400 });
    // This is a precondition on the gateway-owned source, never an account override.
    return parseMailScanResult(await request(cfg, '/v1/connectors/mail-scan', { expectedAccountId: accountId, scope }, signal), scope, accountId);
}
export async function managedConnectorAccess(cfg) {
    const value = await request(cfg, '/v1/connectors/status');
    const record = (input) => !!input && typeof input === 'object' && !Array.isArray(input);
    const status = (input) => typeof input === 'string' && /^[A-Z_]{1,40}$/.test(input);
    const invalid = () => { throw new Error('The managed connection response needs review.'); };
    if (!record(value) || value.managed !== true || !Number.isSafeInteger(value.serviceExpiresAt) || Number(value.serviceExpiresAt) < 0 ||
        typeof value.checkedAt !== 'string' || value.checkedAt.length > 40 || !Number.isFinite(Date.parse(value.checkedAt)) ||
        !record(value.services) || Object.keys(value.services).some(key => key !== 'gmail') || !record(value.services.gmail) || !record(value.tools))
        return invalid();
    const gmail = value.services.gmail, tools = value.tools;
    if (typeof gmail.connected !== 'boolean' || !status(gmail.status) || gmail.accountSelectionRequired !== false ||
        !Array.isArray(gmail.accounts) || gmail.accounts.length > 1 || typeof tools.available !== 'boolean' || !Array.isArray(tools.names) ||
        tools.names.length > 3 || new Set(tools.names).size !== tools.names.length ||
        tools.names.some(name => !['GMAIL_GET_PROFILE', 'GMAIL_LIST_THREADS', 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID'].includes(name)))
        return invalid();
    const accounts = gmail.accounts.map((account) => {
        if (!record(account) || typeof account.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(account.id) || !status(account.status) ||
            (account.label !== undefined && (typeof account.label !== 'string' || account.label.length > 200 || /[\u0000-\u001f\u007f]/.test(account.label))))
            return invalid();
        return { id: account.id, status: account.status, ...(typeof account.label === 'string' ? { label: account.label } : {}) };
    });
    if (gmail.connected !== (accounts[0]?.status === 'ACTIVE') || tools.available !== gmail.connected ||
        (gmail.connected ? tools.names.length === 0 || gmail.status !== 'ACTIVE' : tools.names.length !== 0))
        return invalid();
    // Project every level. A new gateway diagnostic or credential field must not
    // silently become part of the desktop's cached status or renderer response.
    return {
        checkedAt: new Date(value.checkedAt).toISOString(), managed: true, serviceExpiresAt: Number(value.serviceExpiresAt),
        services: { gmail: { connected: gmail.connected, status: gmail.status, accounts, accountSelectionRequired: false } },
        tools: { available: tools.available, names: [...tools.names] },
    };
}
export async function authorizeManagedConnection(cfg, app) {
    if (app !== 'gmail')
        throw Object.assign(new Error('This managed connection currently supports Gmail read-only.'), { status: 403 });
    const value = await request(cfg, '/v1/connectors/authorize', { app });
    if (typeof value?.url !== 'string' || value.url.length > 4096)
        throw new Error('The managed sign-in response needs review.');
    const url = new URL(value.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !(url.hostname === 'composio.dev' || url.hostname.endsWith('.composio.dev')))
        throw new Error('The managed sign-in link needs review.');
    return { url: value.url };
}
