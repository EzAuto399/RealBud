/** Company/service credentials belong to the trusted host, never its tools. */
export function stripServiceSecrets(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    if (/^(?:REALBUD_(?:CARE|SERVICE|COMPANY|ENTITLEMENT|BILLING)(?:_|$)|PG(?:PASSWORD|PASSFILE|SERVICE|SERVICEFILE|USER|HOST|PORT|DATABASE|OPTIONS)$|DATABASE_URL$|COMPOSIO_(?:KEY|API_KEY)$)/i.test(key)) {
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
