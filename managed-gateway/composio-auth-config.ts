/** Project-key auth-config surface. No default transport and no credential logging. */
import { GatewayError, requireThat } from './contracts.ts';
import { COMPOSIO_PLATFORM_API, type HttpTransport } from './composio-org.ts';
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
// Keep in parity with server/composio-gmail.ts; the gateway cannot import desktop code.
const ALLOWED_SCOPES = new Set([GMAIL_READONLY_SCOPE, 'openid', 'email', 'profile', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile']);
export const GMAIL_AUTH_CONFIG_NAME = 'realbud-gmail-readonly-v1';
/** Composio toolkit slugs are lower-case identifiers. Same shape as the registry's `apps`. */
export const TOOLKIT_SLUG = /^[a-z][a-z0-9_]{0,31}$/;
/** One Composio-managed auth config per office project and app, found by this name. */
export const managedAuthConfigName = (slug: string): string => slug === 'gmail' ? GMAIL_AUTH_CONFIG_NAME : `realbud-${slug}-managed-v1`;
/** RealBud's own OAuth client, when the operator configured one. A different
 * name from the managed config, so switching never finds or mutates an old
 * managed config and never rebinds a device that already holds one. */
export const ownAuthConfigName = (slug: string): string => `realbud-${slug}-own-v1`;
/** Composio's v3 OAuth callback: the one redirect URI the provider console allows. */
export const COMPOSIO_OAUTH_REDIRECT_URI = 'https://backend.composio.dev/api/v3/toolkits/auth/callback';
export type OAuthProvider = 'google' | 'microsoft';
/** Toolkits whose OAuth consent runs on one provider's client. Anything else stays Composio-managed. */
const TOOLKIT_PROVIDER: Readonly<Record<string, OAuthProvider>> = {
  gmail: 'google', googlecalendar: 'google', googledrive: 'google', googlesheets: 'google', googledocs: 'google',
  googlemeet: 'google', googleslides: 'google', googletasks: 'google',
  outlook: 'microsoft', one_drive: 'microsoft', microsoft_teams: 'microsoft', share_point: 'microsoft',
  onenote: 'microsoft', microsoft_todo: 'microsoft',
};
export const oauthProviderFor = (slug: string): OAuthProvider | undefined => Object.hasOwn(TOOLKIT_PROVIDER, slug) ? TOOLKIT_PROVIDER[slug] : undefined;
export interface OAuthApp { clientId: string; clientSecret: string }
/** Env names only; values are read per call and never captured, logged or returned. */
export const oauthAppEnv = (provider: OAuthProvider) => ({ clientId: `REALBUD_OAUTH_${provider.toUpperCase()}_CLIENT_ID`, clientSecret: `REALBUD_OAUTH_${provider.toUpperCase()}_CLIENT_SECRET` });
/** The operator's OAuth app for `provider`, or undefined when neither variable is
 * set. Half a configuration fails closed with the missing name, never a value. */
export function oauthAppsFromEnv(env: NodeJS.ProcessEnv): (provider: OAuthProvider) => OAuthApp | undefined {
  return provider => {
    const names = oauthAppEnv(provider);
    const clientId = (env[names.clientId] ?? '').trim(), clientSecret = (env[names.clientSecret] ?? '').trim();
    if (!clientId && !clientSecret) return undefined;
    requireThat(!!clientId, `connector_oauth_app_unconfigured:${names.clientId}`, 503);
    requireThat(!!clientSecret, `connector_oauth_app_unconfigured:${names.clientSecret}`, 503);
    requireThat(clientId.length <= 512 && !/\s/.test(clientId), `connector_oauth_app_unconfigured:${names.clientId}`, 503);
    requireThat(clientSecret.length <= 512 && !/\s/.test(clientSecret), `connector_oauth_app_unconfigured:${names.clientSecret}`, 503);
    return { clientId, clientSecret };
  };
}
export interface ResolveAuthConfigOptions { slug: string; projectKey: string; allowCreate: boolean; beforeCreate: () => void }
export interface ComposioAuthConfigClient {
  /** Gmail's reviewed read-only configuration, exactly as first shipped. */
  resolveGmail(options: { projectKey: string; allowCreate: boolean; beforeCreate: () => void }): Promise<string>;
  /** Find-or-create the office's Composio-managed configuration for any toolkit.
   * `slug: 'gmail'` is `resolveGmail`; nothing about Gmail changes here. Optional
   * so a Gmail-only fake stays a valid client; connectors refuse admission without it. */
  resolveAuthConfig?(options: ResolveAuthConfigOptions): Promise<string>;
  /** The toolkit exists in Composio and offers managed auth under this project key. */
  toolkitSupportsManagedAuth?(options: { slug: string; projectKey: string }): Promise<boolean>;
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function checked(value: unknown, slug: string, own: boolean): string {
  requireThat(record(value), 'connector_auth_config_unreadable', 502);
  const v = value as Record<string, unknown>;
  requireThat(typeof v.id === 'string' && /^ac[_-][A-Za-z0-9_-]{1,128}$/.test(v.id), 'connector_auth_config_unreadable', 502);
  if (own) {
    // RealBud's own OAuth client: never Composio's shared app, always OAuth2.
    requireThat(v.name === ownAuthConfigName(slug) && record(v.toolkit) && v.toolkit.slug === slug && v.auth_scheme === 'OAUTH2' && v.is_composio_managed === false && v.status === 'ENABLED', 'connector_auth_config_not_admitted', 409);
    if (slug !== 'gmail') return v.id as string;
  } else if (slug !== 'gmail') {
    // Any managed toolkit: Composio's own app registration, enabled, named by us.
    requireThat(v.name === managedAuthConfigName(slug) && record(v.toolkit) && v.toolkit.slug === slug && v.is_composio_managed === true && v.status === 'ENABLED', 'connector_auth_config_not_admitted', 409);
    return v.id as string;
  } else {
    requireThat(v.name === GMAIL_AUTH_CONFIG_NAME && record(v.toolkit) && v.toolkit.slug === 'gmail' && v.auth_scheme === 'OAUTH2' && v.is_composio_managed === true && v.status === 'ENABLED', 'connector_auth_config_not_admitted', 409);
  }
  // Gmail, managed or own: read-only scope and basic sign-in only.
  const raw = record(v.credentials) ? v.credentials.scopes : undefined;
  const scopes: unknown = typeof raw === 'string' && raw.length <= 4096 ? raw.trim().split(/[\s,]+/) : raw;
  requireThat(Array.isArray(scopes) && scopes.length > 0 && scopes.length <= 8 && scopes.includes(GMAIL_READONLY_SCOPE) && scopes.every(scope => typeof scope === 'string' && ALLOWED_SCOPES.has(scope)), 'connector_auth_config_scopes_not_admitted', 409);
  return v.id as string;
}
export function composioAuthConfigClient(options: { fetch: HttpTransport; base?: string; oauthApps?: (provider: OAuthProvider) => OAuthApp | undefined }): ComposioAuthConfigClient {
  const base = options.base ?? COMPOSIO_PLATFORM_API;
  let url: URL; try { url = new URL(base); } catch { throw new GatewayError('composio_base_invalid', 503); }
  requireThat(!url.username && !url.password && !url.search && !url.hash && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))), 'composio_base_invalid', 503);
  const call = async (projectKey: string, method: string, path: string, body?: unknown): Promise<unknown> => {
    let response: Response;
    try { response = await options.fetch(`${base.replace(/\/+$/, '')}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(60_000), headers: { 'x-api-key': projectKey, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
    catch { throw new GatewayError('connector_auth_config_unreachable', 502); }
    if (response.redirected || response.status !== (method === 'POST' ? 201 : 200)) {
      const status = response.status; await response.body?.cancel().catch(() => {});
      if (method === 'GET' && status === 404) throw new GatewayError('connector_toolkit_unknown', 404);
      // A definitive refusal of a create (not a timeout, not rate limiting): nothing
      // was created, so the caller may clear its journaled intent.
      if (method === 'POST' && !response.redirected && status >= 400 && status < 500 && status !== 408 && status !== 429) throw new GatewayError('connector_auth_config_rejected', 400);
      throw new GatewayError('connector_auth_config_unconfirmed', 502);
    }
    try { return await response.json(); } catch { throw new GatewayError('connector_auth_config_unreadable', 502); }
  };
  const projectKeyOk = (projectKey: string) => requireThat(/^ak_[A-Za-z0-9_-]{6,512}$/.test(projectKey), 'composio_project_key_unusable', 503);
  async function resolveAuthConfig({ slug, projectKey, allowCreate, beforeCreate }: ResolveAuthConfigOptions): Promise<string> {
    projectKeyOk(projectKey);
    requireThat(TOOLKIT_SLUG.test(slug), 'connector_app_not_admitted', 403);
    const provider = oauthProviderFor(slug);
    // Read per call so the secret is never captured into the client.
    const app = provider ? options.oauthApps?.(provider) : undefined;
    const own = !!app;
    const name = own ? ownAuthConfigName(slug) : managedAuthConfigName(slug);
    const find = async (): Promise<string | undefined> => {
      const items: unknown[] = []; const seen = new Set<string>(); let cursor: string | undefined;
      do {
        const query = new URLSearchParams({ toolkit_slug: slug, show_disabled: 'true', limit: '200', ...(cursor ? { cursor } : {}) });
        const body = await call(projectKey, 'GET', `/auth_configs?${query}`);
        requireThat(record(body) && Array.isArray(body.items), 'connector_auth_config_unreadable', 502);
        const page = body as Record<string, unknown>; items.push(...page.items as unknown[]);
        requireThat(page.next_cursor == null || typeof page.next_cursor === 'string', 'connector_auth_config_list_partial', 502);
        cursor = page.next_cursor as string | undefined;
        if (cursor) { requireThat(!seen.has(cursor) && seen.size < 100, 'connector_auth_config_list_partial', 502); seen.add(cursor); }
      } while (cursor);
      const matches = items.filter(v => record(v) && v.name === name);
      requireThat(matches.length <= 1, 'connector_auth_config_ambiguous', 409);
      return matches.length ? checked(matches[0], slug, own) : undefined;
    };
    const existing = await find(); if (existing) return existing;
    requireThat(allowCreate, 'connector_auth_config_create_unconfirmed', 409);
    // Persist intent before POST. A timeout or a crash must never cause a second POST.
    beforeCreate();
    let createdId: string | undefined;
    try {
      const scopes = slug === 'gmail' ? { scopes: GMAIL_READONLY_SCOPE } : {};
      const authConfig = app
        ? { type: 'use_custom_auth', authScheme: 'OAUTH2', name, credentials: { client_id: app.clientId, client_secret: app.clientSecret, oauth_redirect_uri: COMPOSIO_OAUTH_REDIRECT_URI, ...scopes } }
        : slug === 'gmail' ? { type: 'use_composio_managed_auth', name, credentials: scopes } : { type: 'use_composio_managed_auth', name };
      const created = await call(projectKey, 'POST', '/auth_configs', { toolkit: { slug }, auth_config: authConfig });
      requireThat(record(created) && record(created.auth_config) && typeof created.auth_config.id === 'string', 'connector_auth_config_unreadable', 502);
      createdId = ((created as Record<string, unknown>).auth_config as Record<string, unknown>).id as string;
    } catch (error) {
      if (error instanceof GatewayError && error.code === 'connector_auth_config_rejected') throw error;
      /* Uncertain: reconcile once using the project key; never retry the create. */
    }
    const reconciled = await find();
    requireThat(reconciled && (!createdId || createdId === reconciled), 'connector_auth_config_create_unconfirmed', 409);
    return reconciled!;
  }
  return {
    resolveGmail: ({ projectKey, allowCreate, beforeCreate }) => resolveAuthConfig({ slug: 'gmail', projectKey, allowCreate, beforeCreate }),
    resolveAuthConfig,
    async toolkitSupportsManagedAuth({ slug, projectKey }) {
      projectKeyOk(projectKey);
      requireThat(TOOLKIT_SLUG.test(slug), 'connector_app_not_admitted', 403);
      let body: unknown;
      try { body = await call(projectKey, 'GET', `/toolkits/${slug}`); }
      catch (error) { if (error instanceof GatewayError && error.code === 'connector_toolkit_unknown') return false; throw error; }
      requireThat(record(body) && typeof body.slug === 'string' && body.slug.toLowerCase() === slug, 'connector_auth_config_unreadable', 502);
      const schemes = (body as Record<string, unknown>).composio_managed_auth_schemes;
      return Array.isArray(schemes) && schemes.length > 0 && (body as Record<string, unknown>).no_auth !== true;
    },
  };
}
