/** Company/service credentials belong to the trusted host, never its tools.
 * This blocks inheritance, not same-user filesystem access. Provider custody
 * still requires an independently protected service outside a worker's reach.
 */
export function stripServiceSecrets(env) {
    for (const key of Object.keys(env)) {
        // Keep generic model-provider variables out of this shared rule: individual
        // adapters own their attached-model policy. These namespaces and exact names
        // are operator-only connection, gateway, billing or administration authority.
        if (/^(?:REALBUD_(?:CARE|SERVICE|COMPANY|ENTITLEMENT|BILLING|COMPOSIO|GATEWAY|PAYMENT)(?:_|$)|REALBUD_FINGERPRINT_KEY$|SQUARE_(?:ACCESS_TOKEN|WEBHOOK_SIGNATURE_KEY)$|OPENAI_ADMIN_KEY$|PG(?:PASSWORD|PASSFILE|SERVICE|SERVICEFILE|USER|HOST|PORT|DATABASE|OPTIONS)$|DATABASE_URL$|COMPOSIO_(?:KEY|API_KEY|ORG_KEY|ORG_API_KEY)$)/i.test(key)) {
            delete env[key];
        }
    }
}
/** Use for probes, installers and sign-in helpers as well as agent workers. */
export function serviceSafeChildEnv(overrides = {}) {
    const env = { ...process.env, ...overrides };
    stripServiceSecrets(env);
    return env;
}
