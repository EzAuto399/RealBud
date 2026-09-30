/** Company/service credentials belong to the trusted host, never its tools.
 * This blocks inheritance, not same-user filesystem access. Provider custody
 * still requires an independently protected service outside a worker's reach.
 */
export function stripServiceSecrets(env: NodeJS.ProcessEnv): void {
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
export function serviceSafeChildEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...overrides };
  stripServiceSecrets(env);
  return env;
}

/** GitHub/Copilot login variables upstream Hermes' credential pool would adopt. */
export const AMBIENT_GITHUB_ENV = /^(?:COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|COPILOT_GH_HOST|GH_HOST)$/i;
/** RFC 2606 reserved: `gh auth token --hostname` finds no login for it. */
export const NO_GITHUB_LOGIN_HOST = "realbud.invalid";

/**
 * For any Hermes process: upstream's credential pool seeds GitHub Copilot from
 * these variables, or else from `gh auth token` (the person's own GitHub login,
 * found through Homebrew's `gh` whatever PATH says). The variables are removed
 * and upstream's own COPILOT_GH_HOST switch points the `gh` lookup at a host
 * nobody is signed in to, so a Bud profile never adopts an ambient login.
 */
export function isolateGithubLogin(env: Record<string, string | undefined>): void {
  for (const key of Object.keys(env)) if (AMBIENT_GITHUB_ENV.test(key)) delete env[key];
  env.COPILOT_GH_HOST = NO_GITHUB_LOGIN_HOST;
}
