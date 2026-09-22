import { randomUUID } from "node:crypto";
import { checkConnectionAccess, platformProjectKey, platformUserId } from "./composio.js";
import { getGmailReadOnlyAccess } from "./composio-gmail.js";
import { managedConnectorConfigured } from "./managed-connectors.js";
export const gmailReadOnlyMode = (cfg) => !managedConnectorConfigured(cfg) && cfg.composio?.mode === "gmail-readonly";
export function gmailReadOnlyBinding(cfg) {
    const saved = cfg.composio?.gmailReadOnly;
    return cfg.composio?.apiKey && saved?.authConfigId && saved.userId
        ? { apiKey: cfg.composio.apiKey, authConfigId: saved.authConfigId, userId: saved.userId, ...(saved.accountId ? { accountId: saved.accountId } : {}) }
        : null;
}
export function connectedAppsConfigured(cfg) {
    if (managedConnectorConfigured(cfg))
        return true;
    return gmailReadOnlyMode(cfg) ? Boolean(gmailReadOnlyBinding(cfg)) : Boolean(cfg.composio?.key);
}
export async function checkSelectedConnectionAccess(cfg) {
    if (!gmailReadOnlyMode(cfg))
        return checkConnectionAccess(cfg);
    const binding = gmailReadOnlyBinding(cfg);
    if (!binding)
        throw new Error("Finish Gmail read-only setup in Add.");
    return getGmailReadOnlyAccess(binding);
}
/** In-memory observations expire; a saved key is never a claim of mailbox access. */
export class ConnectedAppAccessCache {
    generation = 0;
    value = null;
    pending = null;
    check;
    now;
    constructor(check = checkSelectedConnectionAccess, now = Date.now) { this.check = check; this.now = now; }
    invalidate() { this.generation++; this.value = null; this.pending = null; }
    status(configured) {
        const empty = { configured, checkedAt: "", services: {}, tools: { available: false, names: [] } };
        if (!configured || !this.value)
            return empty;
        if (this.now() - Date.parse(this.value.checkedAt) > 5 * 60_000) {
            return { ...empty, error: "Check app access again before starting another email task." };
        }
        return structuredClone(this.value);
    }
    async refresh(cfg) {
        if (!connectedAppsConfigured(cfg)) {
            this.invalidate();
            return this.status(false);
        }
        if (this.pending)
            return this.pending;
        const generation = this.generation;
        // Keep this request tied to the exact credential/endpoint it started with.
        const snapshot = { composio: { ...cfg.composio }, profile: { ...cfg.profile } };
        const pending = (async () => {
            let result;
            try {
                result = { configured: true, ...await this.check(snapshot), excludedApps: [...(snapshot.composio.excludedApps ?? [])] };
            }
            catch (cause) {
                const detail = cause instanceof Error ? cause.message.trim() : "";
                result = {
                    configured: true,
                    excludedApps: [...(snapshot.composio.excludedApps ?? [])],
                    checkedAt: new Date(this.now()).toISOString(),
                    services: {},
                    tools: { available: false, names: [] },
                    error: managedConnectorConfigured(cfg)
                        ? cause?.status === 402
                            ? 'Your managed service is paused or expired. Contact service support.'
                            : cause?.status === 403
                                ? 'Managed connection access was revoked or changed. Contact service support.'
                                : 'Managed connections could not be verified. Contact service support to check the service and account connection. No email task was started.'
                        : detail && /ak_|Platform project|Connected apps key|For You|consumer key/i.test(detail)
                            ? detail
                            : "Could not verify app access. Check the saved key and provider connection, then try again. No sign-in or email task was started.",
                };
            }
            if (generation !== this.generation)
                throw Object.assign(new Error("App settings changed during the check. Check access again."), { status: 409 });
            for (const [slug, service] of Object.entries(result.services)) {
                const selectedAccountId = snapshot.composio.selectedAccounts?.[slug];
                if (selectedAccountId && service.accounts.some(account => account.id === selectedAccountId && /^active$/i.test(account.status))) {
                    Object.assign(service, { selectedAccountId, accountSelectionRequired: false });
                }
            }
            this.value = result;
            return structuredClone(result);
        })();
        this.pending = pending;
        try {
            return await pending;
        }
        finally {
            if (this.pending === pending)
                this.pending = null;
        }
    }
}
/** Only an explicit, secure endpoint and supported write-only fields may be saved. */
export function connectedAppConfigPatch(value, current) {
    const bad = () => Object.assign(new Error("Invalid Connected apps settings. Use the private key field in Add."), { status: 400 });
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw bad();
    const raw = value;
    if (Object.keys(raw).some(key => !["key", "apiKey", "url"].includes(key)))
        throw bad();
    const result = {};
    for (const key of ["key", "apiKey", "url"]) {
        if (!Object.hasOwn(raw, key))
            continue;
        if (typeof raw[key] !== "string" || raw[key].length > 4096 || /[\r\n\u0000]/.test(raw[key]))
            throw bad();
        result[key] = raw[key].trim();
    }
    if (result.key?.startsWith("ck_")) {
        throw Object.assign(new Error("Use the Platform project API key (ak_…). For You / Connect consumer keys are not used."), { status: 400 });
    }
    if (result.url) {
        let target;
        try {
            target = new URL(result.url);
        }
        catch {
            throw bad();
        }
        if (target.username || target.password || target.hash || target.search ||
            (target.protocol !== "https:" && !(target.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(target.hostname))))
            throw bad();
    }
    if (Object.hasOwn(result, "key") && (result.key || current?.composio?.key)) {
        // Pin the existing connection owner before rotating a credential. A key is
        // access to a project, not the identity of a person within that project.
        // This value is derived by the server, never accepted from the settings UI.
        try {
            // A freely editable profile email is not proof of an existing provider
            // identity. Only preserve explicit bindings or a valid legacy setup.
            if (!current?.composio?.userId)
                platformProjectKey(current ?? {});
            result.userId = platformUserId(current ?? {});
        }
        catch {
            // A new profile must not inherit another profile's accounts just because
            // service administration provisions the same project key. Persist this
            // independent identity; existing legacy owners above remain unchanged.
            if (result.key)
                result.userId = `realbud-${randomUUID()}`;
        }
    }
    return result;
}
